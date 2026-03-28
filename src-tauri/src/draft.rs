//! Block draft writer — autosave buffer for in-progress edits (ADR-07).
//!
//! Every ~2 seconds during active typing the frontend calls [`save_draft`] to
//! persist the current editor content into the `block_drafts` table. On
//! blur / window-focus-loss the frontend calls [`flush_draft`] which writes a
//! proper `edit_block` op and removes the draft row.
//!
//! Drafts never participate in sync, undo, or compaction.

#![allow(dead_code)]

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::op::{EditBlockPayload, OpPayload};
use crate::op_log::{append_local_op, OpRecord};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single draft row from `block_drafts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    let updated_at = Utc::now().to_rfc3339();
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

/// Delete a draft row for the given block (if it exists).
pub async fn delete_draft(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM block_drafts WHERE block_id = ?")
        .bind(block_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Return all draft rows.
pub async fn get_all_drafts(pool: &SqlitePool) -> Result<Vec<Draft>, AppError> {
    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT block_id, content, updated_at FROM block_drafts",
    )
    .fetch_all(pool)
    .await?;

    let drafts = rows
        .into_iter()
        .map(|(block_id, content, updated_at)| Draft {
            block_id,
            content,
            updated_at,
        })
        .collect();
    Ok(drafts)
}

/// Flush a draft: write an `edit_block` op and then delete the draft row.
///
/// This is the blur / window-focus-loss path. The op append and draft deletion
/// happen sequentially — `append_local_op` uses its own transaction internally,
/// then the draft row is deleted after.
pub async fn flush_draft(
    pool: &SqlitePool,
    device_id: &str,
    block_id: &str,
    content: &str,
    prev_edit: Option<(String, i64)>,
) -> Result<OpRecord, AppError> {
    let op = OpPayload::EditBlock(EditBlockPayload {
        block_id: block_id.to_owned(),
        to_text: content.to_owned(),
        prev_edit,
    });

    let record = append_local_op(pool, device_id, op).await?;

    delete_draft(pool, block_id).await?;

    Ok(record)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    #[tokio::test]
    async fn save_draft_creates_and_updates_row() {
        let (pool, _dir) = test_pool().await;
        let block_id = "block-1";

        // First save creates the row
        save_draft(&pool, block_id, "draft v1").await.unwrap();
        let drafts = get_all_drafts(&pool).await.unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].block_id, block_id);
        assert_eq!(drafts[0].content, "draft v1");

        // Second save updates the same row (INSERT OR REPLACE)
        save_draft(&pool, block_id, "draft v2").await.unwrap();
        let drafts = get_all_drafts(&pool).await.unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].content, "draft v2");
    }

    #[tokio::test]
    async fn delete_draft_removes_row() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, "block-1", "content").await.unwrap();
        assert_eq!(get_all_drafts(&pool).await.unwrap().len(), 1);

        delete_draft(&pool, "block-1").await.unwrap();
        assert_eq!(get_all_drafts(&pool).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn delete_draft_noop_when_missing() {
        let (pool, _dir) = test_pool().await;

        // Should not error when the row doesn't exist
        delete_draft(&pool, "nonexistent").await.unwrap();
    }

    #[tokio::test]
    async fn flush_draft_writes_op_and_deletes_draft() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";
        let block_id = "block-1";

        // Pre-create a draft
        save_draft(&pool, block_id, "final content").await.unwrap();
        assert_eq!(get_all_drafts(&pool).await.unwrap().len(), 1);

        // Flush it
        let record = flush_draft(&pool, device_id, block_id, "final content", None)
            .await
            .unwrap();

        // Op was written
        assert_eq!(record.op_type, "edit_block");
        assert_eq!(record.device_id, device_id);

        // Draft was deleted
        assert_eq!(get_all_drafts(&pool).await.unwrap().len(), 0);

        // Verify the payload contains the block_id
        assert!(record.payload.contains(block_id));
    }

    #[tokio::test]
    async fn flush_draft_with_prev_edit() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";
        let block_id = "block-1";

        save_draft(&pool, block_id, "updated content")
            .await
            .unwrap();

        let prev = Some(("dev-1".to_owned(), 3));
        let record = flush_draft(&pool, device_id, block_id, "updated content", prev)
            .await
            .unwrap();

        assert_eq!(record.op_type, "edit_block");
        // Payload should contain the prev_edit reference
        assert!(record.payload.contains("dev-1"));
    }
}
