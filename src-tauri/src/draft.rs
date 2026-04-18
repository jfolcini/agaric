//! Block draft writer — autosave buffer for in-progress edits.
//!
//! Every ~2 seconds during active typing the frontend calls [`save_draft`] to
//! persist the current editor content into the `block_drafts` table. On
//! blur / window-focus-loss the frontend calls [`flush_draft`] which writes a
//! proper `edit_block` op and removes the draft row.
//!
//! Drafts never participate in sync, undo, or compaction.
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::now_rfc3339;
use crate::op::{EditBlockPayload, OpPayload};
use crate::op_log::{append_local_op_in_tx, OpRecord};
use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single draft row from `block_drafts`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, specta::Type)]
pub struct Draft {
    pub block_id: String,
    pub content: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Insert or replace a draft for the given block.
///
/// Called by the frontend every ~2 s during active typing.
pub async fn save_draft(pool: &SqlitePool, block_id: &str, content: &str) -> Result<(), AppError> {
    let updated_at = crate::now_rfc3339();
    sqlx::query(
        "INSERT OR REPLACE INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)",
    )
    .bind(block_id)
    .bind(content)
    .bind(&updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Save a draft only if the content differs from the currently stored draft.
///
/// Returns `Ok(true)` if a write was performed, `Ok(false)` if skipped.
/// This avoids unnecessary writes when the user hasn't changed anything
/// since the last autosave tick.
pub async fn save_draft_if_changed(
    pool: &SqlitePool,
    block_id: &str,
    content: &str,
) -> Result<bool, AppError> {
    if let Some(existing) = get_draft(pool, block_id).await? {
        if existing.content == content {
            return Ok(false);
        }
    }
    save_draft(pool, block_id, content).await?;
    Ok(true)
}

/// Delete a draft row for the given block (if it exists).
pub async fn delete_draft(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    sqlx::query!("DELETE FROM block_drafts WHERE block_id = ?", block_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete a draft row within an existing transaction.
///
/// The caller is responsible for committing the transaction.
/// Used by [`flush_draft`] to atomically delete the draft in the same
/// transaction that appends the op.
pub async fn delete_draft_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    block_id: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM block_drafts WHERE block_id = ?")
        .bind(block_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Return a single draft by block ID, or `None` if no draft exists.
pub async fn get_draft(pool: &SqlitePool, block_id: &str) -> Result<Option<Draft>, AppError> {
    let draft = sqlx::query_as!(
        Draft,
        "SELECT block_id, content, updated_at FROM block_drafts WHERE block_id = ?",
        block_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(draft)
}

/// Return all draft rows ordered by `updated_at` ascending.
pub async fn get_all_drafts(pool: &SqlitePool) -> Result<Vec<Draft>, AppError> {
    let drafts = sqlx::query_as!(
        Draft,
        "SELECT block_id, content, updated_at FROM block_drafts ORDER BY updated_at ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(drafts)
}

/// Return the number of drafts currently stored.
pub async fn draft_count(pool: &SqlitePool) -> Result<i64, AppError> {
    let rec = sqlx::query!(r#"SELECT COUNT(*) as "count: i64" FROM block_drafts"#)
        .fetch_one(pool)
        .await?;
    Ok(rec.count)
}

/// Flush a draft: write an `edit_block` op and then delete the draft row.
///
/// This is the blur / window-focus-loss path.
///
/// Both the op append and the draft deletion are wrapped in a single
/// IMMEDIATE transaction. If any step fails the entire transaction is
/// rolled back, preventing orphaned drafts or duplicate ops on retry.
pub async fn flush_draft(
    pool: &SqlitePool,
    device_id: &str,
    block_id: &str,
    content: &str,
    prev_edit: Option<(String, i64)>,
) -> Result<OpRecord, AppError> {
    let op = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        to_text: content.to_owned(),
        prev_edit,
    });

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let record = append_local_op_in_tx(&mut tx, device_id, op, now_rfc3339()).await?;
    delete_draft_in_tx(&mut tx, block_id).await?;
    tx.commit().await?;

    Ok(record)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Tests live in `draft/tests.rs` — pattern established for `dag.rs` +
// `dag/tests.rs`. Keeping the impl file focused on the ~200-line public
// API while rust-analyzer and cargo test pick up the sibling file via
// the declaration below.

#[cfg(test)]
mod tests;
