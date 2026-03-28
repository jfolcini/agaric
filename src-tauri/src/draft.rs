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
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
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
    sqlx::query("DELETE FROM block_drafts WHERE block_id = ?")
        .bind(block_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Return a single draft by block ID, or `None` if no draft exists.
pub async fn get_draft(pool: &SqlitePool, block_id: &str) -> Result<Option<Draft>, AppError> {
    let draft = sqlx::query_as::<_, Draft>(
        "SELECT block_id, content, updated_at FROM block_drafts WHERE block_id = ?",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;
    Ok(draft)
}

/// Return all draft rows ordered by `updated_at` ascending.
pub async fn get_all_drafts(pool: &SqlitePool) -> Result<Vec<Draft>, AppError> {
    let drafts = sqlx::query_as::<_, Draft>(
        "SELECT block_id, content, updated_at FROM block_drafts ORDER BY updated_at ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(drafts)
}

/// Return the number of drafts currently stored.
pub async fn draft_count(pool: &SqlitePool) -> Result<i64, AppError> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(pool)
        .await?;
    Ok(count)
}

/// Flush a draft: write an `edit_block` op and then delete the draft row.
///
/// This is the blur / window-focus-loss path.
///
/// **Atomicity note:** the op append and draft deletion are *not* wrapped in a
/// single transaction because [`append_local_op`] manages its own internal
/// transaction.  If the process crashes after the op is committed but before
/// the draft is deleted, an orphaned draft row will remain.  This is benign:
/// the op has already been recorded, and the stale draft will be visible via
/// [`get_all_drafts`] on next startup for the frontend to discard or re-flush.
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

    // -- Original tests (1-5) -----------------------------------------------

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

    // -- New tests (6-15) ---------------------------------------------------

    #[tokio::test]
    async fn save_draft_unicode_content() {
        let (pool, _dir) = test_pool().await;

        // Emoji
        save_draft(&pool, "b-emoji", "Hello 🌍🚀✨").await.unwrap();
        let d = get_draft(&pool, "b-emoji").await.unwrap().unwrap();
        assert_eq!(d.content, "Hello 🌍🚀✨");

        // CJK characters
        save_draft(&pool, "b-cjk", "你好世界 こんにちは 안녕하세요")
            .await
            .unwrap();
        let d = get_draft(&pool, "b-cjk").await.unwrap().unwrap();
        assert_eq!(d.content, "你好世界 こんにちは 안녕하세요");

        // RTL text (Arabic)
        save_draft(&pool, "b-rtl", "مرحبا بالعالم").await.unwrap();
        let d = get_draft(&pool, "b-rtl").await.unwrap().unwrap();
        assert_eq!(d.content, "مرحبا بالعالم");
    }

    #[tokio::test]
    async fn save_draft_large_content() {
        let (pool, _dir) = test_pool().await;

        // ~100 KB of text
        let large = "A".repeat(100 * 1024);
        save_draft(&pool, "b-large", &large).await.unwrap();

        let d = get_draft(&pool, "b-large").await.unwrap().unwrap();
        assert_eq!(d.content.len(), 100 * 1024);
        assert_eq!(d.content, large);
    }

    #[tokio::test]
    async fn save_draft_empty_content() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, "b-empty", "").await.unwrap();
        let d = get_draft(&pool, "b-empty").await.unwrap().unwrap();
        assert_eq!(d.content, "");
    }

    #[tokio::test]
    async fn get_all_drafts_ordering() {
        let (pool, _dir) = test_pool().await;

        // Insert drafts sequentially — timestamps have nanosecond precision so
        // they will differ across awaits.
        save_draft(&pool, "b-1", "first").await.unwrap();
        save_draft(&pool, "b-2", "second").await.unwrap();
        save_draft(&pool, "b-3", "third").await.unwrap();

        let drafts = get_all_drafts(&pool).await.unwrap();
        assert_eq!(drafts.len(), 3);

        // ORDER BY updated_at ASC — timestamps must be non-decreasing
        assert!(
            drafts[0].updated_at <= drafts[1].updated_at,
            "drafts[0].updated_at ({}) should <= drafts[1].updated_at ({})",
            drafts[0].updated_at,
            drafts[1].updated_at,
        );
        assert!(
            drafts[1].updated_at <= drafts[2].updated_at,
            "drafts[1].updated_at ({}) should <= drafts[2].updated_at ({})",
            drafts[1].updated_at,
            drafts[2].updated_at,
        );
    }

    #[tokio::test]
    async fn flush_draft_without_existing_draft() {
        let (pool, _dir) = test_pool().await;

        // No draft row exists, but flush should still write the op
        let record = flush_draft(&pool, "dev-1", "block-x", "content", None)
            .await
            .unwrap();

        assert_eq!(record.op_type, "edit_block");
        assert!(record.payload.contains("block-x"));
        // No drafts should exist
        assert_eq!(draft_count(&pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn get_draft_existing_and_missing() {
        let (pool, _dir) = test_pool().await;

        // Missing → None
        assert!(get_draft(&pool, "nope").await.unwrap().is_none());

        // Existing → Some
        save_draft(&pool, "b-1", "hello").await.unwrap();
        let d = get_draft(&pool, "b-1").await.unwrap().unwrap();
        assert_eq!(d.block_id, "b-1");
        assert_eq!(d.content, "hello");
    }

    #[tokio::test]
    async fn draft_count_accuracy() {
        let (pool, _dir) = test_pool().await;

        assert_eq!(draft_count(&pool).await.unwrap(), 0);

        save_draft(&pool, "b-1", "a").await.unwrap();
        assert_eq!(draft_count(&pool).await.unwrap(), 1);

        save_draft(&pool, "b-2", "b").await.unwrap();
        assert_eq!(draft_count(&pool).await.unwrap(), 2);

        // Overwrite b-1 — count should stay at 2
        save_draft(&pool, "b-1", "a2").await.unwrap();
        assert_eq!(draft_count(&pool).await.unwrap(), 2);

        delete_draft(&pool, "b-1").await.unwrap();
        assert_eq!(draft_count(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn save_draft_updated_at_changes_on_resave() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, "b-1", "version 1").await.unwrap();
        let ts1 = get_draft(&pool, "b-1").await.unwrap().unwrap().updated_at;

        // Re-save with different content
        save_draft(&pool, "b-1", "version 2").await.unwrap();
        let ts2 = get_draft(&pool, "b-1").await.unwrap().unwrap().updated_at;

        // Timestamp should not regress
        assert!(ts2 >= ts1, "updated_at should not regress: {ts2} < {ts1}");
    }

    #[tokio::test]
    async fn save_draft_if_changed_skips_identical() {
        let (pool, _dir) = test_pool().await;

        // First write — no existing draft → always writes
        let wrote = save_draft_if_changed(&pool, "b-1", "hello").await.unwrap();
        assert!(wrote);

        let ts1 = get_draft(&pool, "b-1").await.unwrap().unwrap().updated_at;

        // Same content → should skip
        let wrote = save_draft_if_changed(&pool, "b-1", "hello").await.unwrap();
        assert!(!wrote);
        let ts_after = get_draft(&pool, "b-1").await.unwrap().unwrap().updated_at;
        assert_eq!(ts1, ts_after, "timestamp must not change on skip");

        // Different content → should write
        let wrote = save_draft_if_changed(&pool, "b-1", "world").await.unwrap();
        assert!(wrote);
        let d = get_draft(&pool, "b-1").await.unwrap().unwrap();
        assert_eq!(d.content, "world");
    }

    #[tokio::test]
    async fn flush_draft_only_deletes_target_block() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, "b-1", "content A").await.unwrap();
        save_draft(&pool, "b-2", "content B").await.unwrap();
        assert_eq!(draft_count(&pool).await.unwrap(), 2);

        // Flush only b-1
        let record = flush_draft(&pool, "dev-1", "b-1", "content A", None)
            .await
            .unwrap();
        assert_eq!(record.op_type, "edit_block");

        // b-1 draft gone, b-2 untouched
        assert!(get_draft(&pool, "b-1").await.unwrap().is_none());
        assert!(get_draft(&pool, "b-2").await.unwrap().is_some());
        assert_eq!(draft_count(&pool).await.unwrap(), 1);
    }
}
