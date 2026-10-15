//! `record_page_open` — the Pages view's "Last opened" key (#5371).
//!
//! `page_opens` is device-local, like `block_drafts`: no op is appended and
//! the engine never sees it, so nothing syncs or exports it.

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::WritePool;
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;

use super::super::sanitize_internal_error;

/// Stamp `page_id` as opened on this device now. Refuses a block that is not
/// a live page with `NotFound`.
#[instrument(skip(pool), err)]
pub async fn record_page_open_inner(pool: &SqlitePool, page_id: BlockId) -> Result<(), AppError> {
    let now = crate::db::now_ms();
    let page = page_id.as_str();
    // `WHERE` on the SELECT: an UPSERT's SELECT needs one, or SQLite parses
    // `ON CONFLICT` as a join constraint.
    let written = sqlx::query!(
        "INSERT INTO page_opens (page_id, opened_ms) \
         SELECT id, ? FROM blocks \
          WHERE id = ? AND block_type = 'page' AND deleted_at IS NULL \
         ON CONFLICT(page_id) DO UPDATE SET opened_ms = excluded.opened_ms",
        now,
        page,
    )
    .execute(pool)
    .await?
    .rows_affected();
    if written == 0 {
        return Err(AppError::NotFound(format!("page {page}")));
    }
    Ok(())
}

/// Tauri command: stamp a page as opened on this device, for the Pages
/// view's "Last opened" sort. Delegates to [`record_page_open_inner`].
#[tauri::command]
#[specta::specta]
pub async fn record_page_open(
    pool: State<'_, WritePool>,
    page_id: BlockId,
) -> Result<(), AppError> {
    record_page_open_inner(&pool.0, page_id)
        .await
        .map_err(sanitize_internal_error)
}
