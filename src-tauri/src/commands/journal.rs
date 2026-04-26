//! Journal command handlers — daily page navigation.

use chrono::NaiveDate;
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::WritePool;
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::pagination::BlockRow;

use super::sanitize_internal_error;
use super::*;

/// Open today's journal page, creating it if it does not exist.
///
/// Returns the [`BlockRow`] for a `page` block whose content is today's date
/// in `YYYY-MM-DD` format.  The lookup is idempotent: calling this multiple
/// times on the same day always returns the same page.
pub async fn today_journal_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BlockRow, AppError> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    navigate_journal_inner(pool, device_id, materializer, today).await
}

/// Open the journal page for a specific date, creating it if it does not exist.
///
/// `date` must be in `YYYY-MM-DD` format.  If a `page` block with that exact
/// content already exists (and is not deleted), its [`BlockRow`] is returned.
/// Otherwise a new page block is created.
///
/// Thin delegator to [`resolve_or_create_journal_page`] — kept as a named
/// public symbol so existing call sites (Tauri command wrapper,
/// [`today_journal_inner`], the command-integration tests) continue to
/// compile unchanged. New code (MCP `journal_for_date` tool, FEAT-4c) should
/// prefer [`journal_for_date_inner`].
///
/// # Errors
///
/// - [`AppError::Validation`] — `date` is not a valid `YYYY-MM-DD` string
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn navigate_journal_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: String,
) -> Result<BlockRow, AppError> {
    resolve_or_create_journal_page(pool, device_id, materializer, &date).await
}

/// Typed-date variant of the journal-for-date lookup used by the FEAT-4c
/// MCP `journal_for_date` tool.
///
/// Takes a parsed [`NaiveDate`] rather than a string so MCP callers can
/// surface the parse error with a tool-specific message. Delegates to the
/// same [`resolve_or_create_journal_page`] helper as
/// [`navigate_journal_inner`] and [`today_journal_inner`] — all three call
/// sites share one implementation so behaviour cannot drift between the
/// frontend and the MCP surface.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn journal_for_date_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: NaiveDate,
) -> Result<BlockRow, AppError> {
    let formatted = date.format("%Y-%m-%d").to_string();
    resolve_or_create_journal_page(pool, device_id, materializer, &formatted).await
}

/// Shared date → journal-page lookup used by every `*_journal_inner`
/// variant. Centralises the existing-page probe + missing-page create
/// so future bug fixes / behaviour changes apply uniformly.
///
/// Validates the date format, then queries `blocks` for an existing
/// non-deleted `page` whose `content` exactly matches `date`. Creates a
/// new page block on miss via [`create_block_inner`] so op-log + cache
/// invariants are preserved.
///
/// # Errors
///
/// - [`AppError::Validation`] — `date` is not `YYYY-MM-DD`.
async fn resolve_or_create_journal_page(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: &str,
) -> Result<BlockRow, AppError> {
    validate_date_format(date)?;

    // Look for an existing page whose content matches the date exactly.
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type,
                  todo_state, priority, due_date, scheduled_date, page_id
           FROM blocks
           WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL
           LIMIT 1"#,
        date
    )
    .fetch_optional(pool)
    .await?;

    if let Some(row) = existing {
        return Ok(row);
    }

    // No existing page — create one.
    create_block_inner(
        pool,
        device_id,
        materializer,
        "page".into(),
        date.to_string(),
        None,
        None,
    )
    .await
}

/// FEAT-12 — Quick-capture a single content block onto today's journal page.
///
/// Resolves today's journal page (creating it if it doesn't exist via
/// [`today_journal_inner`]) and then appends a new `content` block as a
/// child of that page. Used by the global-shortcut quick-capture flow:
/// the user fires the OS hotkey from anywhere, types into a small modal,
/// and the captured line lands at the bottom of today's journal — no
/// navigation, no clicks.
///
/// Calling this twice on the same day appends two distinct blocks (matches
/// the existing `create_block` semantic). The function is idempotent at
/// the journal-page level — only the first call on a given day creates
/// the page; subsequent calls reuse it.
///
/// # Errors
///
/// - [`AppError::Validation`] — `content` exceeds the per-block size cap
///   enforced by [`create_block_inner`].
/// - Other [`AppError`] variants propagated from
///   [`today_journal_inner`] / [`create_block_inner`] (e.g. DB I/O).
#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn quick_capture_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    content: String,
) -> Result<BlockRow, AppError> {
    let page = today_journal_inner(pool, device_id, materializer).await?;
    create_block_inner(
        pool,
        device_id,
        materializer,
        "content".into(),
        content,
        Some(page.id),
        None,
    )
    .await
}

/// Tauri command: quick-capture a single content block onto today's
/// journal page. Delegates to [`quick_capture_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn quick_capture_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    content: String,
) -> Result<BlockRow, AppError> {
    quick_capture_block_inner(&pool.0, device_id.as_str(), &materializer, content)
        .await
        .map_err(sanitize_internal_error)
}
