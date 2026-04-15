//! Journal command handlers — daily page navigation.

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
    validate_date_format(&date)?;

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
        date,
        None,
        None,
    )
    .await
}
