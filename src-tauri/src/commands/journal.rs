//! Journal command handlers — daily page navigation.

use chrono::NaiveDate;
use sqlx::SqlitePool;
use tracing::instrument;

use crate::error::AppError;
use crate::materializer::Materializer;
use crate::pagination::BlockRow;

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
