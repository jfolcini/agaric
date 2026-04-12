//! Draft autosave command handlers (F-17).

use sqlx::SqlitePool;
use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::draft;
use crate::error::AppError;

use super::*;

/// Flush a draft: look up the stored draft content, compute `prev_edit`,
/// write an `edit_block` op, and delete the draft row — all atomically.
///
/// If no draft exists for `block_id`, this is a no-op (returns `Ok(())`).
pub async fn flush_draft_inner(
    pool: &SqlitePool,
    device_id: &str,
    block_id: String,
) -> Result<(), AppError> {
    // 1. Look up the draft; if none exists, no-op.
    let stored = match draft::get_draft(pool, &block_id).await? {
        Some(d) => d,
        None => return Ok(()),
    };

    // 2. Compute prev_edit from op_log (same logic as edit_block_inner).
    let prev_edit_row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ? \
         AND op_type IN ('edit_block', 'create_block') \
         ORDER BY created_at DESC \
         LIMIT 1",
        block_id
    )
    .fetch_optional(pool)
    .await?;
    let prev_edit = prev_edit_row.map(|r| (r.device_id, r.seq));

    // 3. Delegate to draft::flush_draft (atomic tx inside).
    draft::flush_draft(pool, device_id, &block_id, &stored.content, prev_edit).await?;
    Ok(())
}

/// Tauri command: save a draft for a block. Delegates to [`draft::save_draft`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn save_draft(
    pool: State<'_, WritePool>,
    block_id: String,
    content: String,
) -> Result<(), AppError> {
    draft::save_draft(&pool.0, &block_id, &content)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: flush a draft (write edit_block op + delete draft row).
/// Delegates to [`flush_draft_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn flush_draft(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    block_id: String,
) -> Result<(), AppError> {
    flush_draft_inner(&pool.0, device_id.as_str(), block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: delete a draft for a block. Delegates to [`draft::delete_draft`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_draft(pool: State<'_, WritePool>, block_id: String) -> Result<(), AppError> {
    draft::delete_draft(&pool.0, &block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list all drafts. Delegates to [`draft::get_all_drafts`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_drafts(pool: State<'_, ReadPool>) -> Result<Vec<draft::Draft>, AppError> {
    draft::get_all_drafts(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Inner implementation for `list_drafts`, usable from tests without Tauri state.
pub async fn list_drafts_inner(pool: &sqlx::SqlitePool) -> Result<Vec<draft::Draft>, AppError> {
    draft::get_all_drafts(pool).await
}
