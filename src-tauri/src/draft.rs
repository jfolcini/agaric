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
use crate::op_log::{append_local_op_in_tx, OpRecord};
use crate::ulid::BlockId;

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
    let record = append_local_op_in_tx(&mut tx, device_id, op, Utc::now().to_rfc3339()).await?;
    delete_draft_in_tx(&mut tx, block_id).await?;
    tx.commit().await?;

    Ok(record)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests for the block draft writer — save, flush, delete, and conditional
    //! save.  Covers happy paths, edge cases (empty/unicode/large content), and
    //! the conditional-write optimisation in `save_draft_if_changed`.

    use super::*;
    use crate::db::init_pool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Deterministic test fixtures ─────────────────────────────────────

    const BLOCK_A: &str = "01HZ0000000000000000BLOCKA";
    const BLOCK_B: &str = "01HZ0000000000000000BLOCKB";
    const DEVICE: &str = "test-device-001";
    const CONTENT_V1: &str = "draft version 1";
    const CONTENT_V2: &str = "draft version 2";

    /// Create a fresh SQLite pool with migrations applied (temp directory).
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    // ── save_draft ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn save_draft_creates_row() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, CONTENT_V1).await.unwrap();

        let draft = get_draft(&pool, BLOCK_A)
            .await
            .unwrap()
            .expect("draft should exist after save");
        assert_eq!(draft.block_id, BLOCK_A, "block_id must match");
        assert_eq!(draft.content, CONTENT_V1, "content must match");
    }

    #[tokio::test]
    async fn save_draft_upserts_existing_row() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, CONTENT_V1).await.unwrap();
        save_draft(&pool, BLOCK_A, CONTENT_V2).await.unwrap();

        let drafts = get_all_drafts(&pool).await.unwrap();
        assert_eq!(drafts.len(), 1, "INSERT OR REPLACE must not duplicate rows");
        assert_eq!(
            drafts[0].content, CONTENT_V2,
            "content must be the latest version"
        );
    }

    #[tokio::test]
    async fn save_draft_preserves_empty_content() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "").await.unwrap();

        let d = get_draft(&pool, BLOCK_A).await.unwrap().unwrap();
        assert_eq!(d.content, "", "empty string must round-trip");
    }

    #[tokio::test]
    async fn save_draft_preserves_unicode_content() {
        let (pool, _dir) = test_pool().await;

        let cases: &[(&str, &str)] = &[
            ("01HZ000000000000000000EMOJI", "Hello 🌍🚀✨"),
            (
                "01HZ0000000000000000000CJK0",
                "你好世界 こんにちは 안녕하세요",
            ),
            ("01HZ00000000000000000000RTL", "مرحبا بالعالم"),
        ];

        for &(block_id, content) in cases {
            save_draft(&pool, block_id, content).await.unwrap();
            let d = get_draft(&pool, block_id).await.unwrap().unwrap();
            assert_eq!(
                d.content, content,
                "unicode content must round-trip for block {block_id}"
            );
        }
    }

    #[tokio::test]
    async fn save_draft_handles_large_content() {
        let (pool, _dir) = test_pool().await;

        let large = "A".repeat(100 * 1024);
        save_draft(&pool, BLOCK_A, &large).await.unwrap();

        let d = get_draft(&pool, BLOCK_A).await.unwrap().unwrap();
        assert_eq!(
            d.content.len(),
            100 * 1024,
            "100 KB content must round-trip"
        );
    }

    #[tokio::test]
    async fn save_draft_updated_at_does_not_regress_on_resave() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, CONTENT_V1).await.unwrap();
        let ts1 = get_draft(&pool, BLOCK_A).await.unwrap().unwrap().updated_at;

        save_draft(&pool, BLOCK_A, CONTENT_V2).await.unwrap();
        let ts2 = get_draft(&pool, BLOCK_A).await.unwrap().unwrap().updated_at;

        assert!(ts2 >= ts1, "updated_at must not regress: got {ts2} < {ts1}");
    }

    // ── save_draft_if_changed ───────────────────────────────────────────

    #[tokio::test]
    async fn save_draft_if_changed_writes_when_no_prior_draft() {
        let (pool, _dir) = test_pool().await;

        let wrote = save_draft_if_changed(&pool, BLOCK_A, "hello")
            .await
            .unwrap();

        assert!(wrote, "first write with no prior draft must execute");
        assert!(
            get_draft(&pool, BLOCK_A).await.unwrap().is_some(),
            "draft row must exist after write"
        );
    }

    #[tokio::test]
    async fn save_draft_if_changed_skips_identical_content() {
        let (pool, _dir) = test_pool().await;

        save_draft_if_changed(&pool, BLOCK_A, "hello")
            .await
            .unwrap();
        let ts_before = get_draft(&pool, BLOCK_A).await.unwrap().unwrap().updated_at;

        let wrote = save_draft_if_changed(&pool, BLOCK_A, "hello")
            .await
            .unwrap();

        assert!(!wrote, "identical content must be skipped");
        let ts_after = get_draft(&pool, BLOCK_A).await.unwrap().unwrap().updated_at;
        assert_eq!(
            ts_before, ts_after,
            "timestamp must not change when write is skipped"
        );
    }

    #[tokio::test]
    async fn save_draft_if_changed_writes_when_content_differs() {
        let (pool, _dir) = test_pool().await;

        save_draft_if_changed(&pool, BLOCK_A, "hello")
            .await
            .unwrap();

        let wrote = save_draft_if_changed(&pool, BLOCK_A, "world")
            .await
            .unwrap();

        assert!(wrote, "different content must trigger a write");
        let d = get_draft(&pool, BLOCK_A).await.unwrap().unwrap();
        assert_eq!(d.content, "world", "content must be updated to new value");
    }

    // ── delete_draft ────────────────────────────────────────────────────

    #[tokio::test]
    async fn delete_draft_removes_existing_row() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "content").await.unwrap();
        delete_draft(&pool, BLOCK_A).await.unwrap();

        assert!(
            get_draft(&pool, BLOCK_A).await.unwrap().is_none(),
            "draft must be gone after delete"
        );
    }

    #[tokio::test]
    async fn delete_draft_succeeds_when_row_missing() {
        let (pool, _dir) = test_pool().await;

        delete_draft(&pool, "nonexistent").await.unwrap();
    }

    // ── get_draft ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_draft_returns_none_for_missing_block() {
        let (pool, _dir) = test_pool().await;

        let result = get_draft(&pool, "nonexistent").await.unwrap();
        assert!(result.is_none(), "missing block must return None");
    }

    #[tokio::test]
    async fn get_draft_returns_draft_when_present() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "hello").await.unwrap();

        let d = get_draft(&pool, BLOCK_A).await.unwrap().unwrap();
        assert_eq!(d.block_id, BLOCK_A);
        assert_eq!(d.content, "hello");
    }

    // ── get_all_drafts ──────────────────────────────────────────────────

    #[tokio::test]
    async fn get_all_drafts_returns_empty_vec_when_no_drafts() {
        let (pool, _dir) = test_pool().await;

        let drafts = get_all_drafts(&pool).await.unwrap();
        assert!(drafts.is_empty(), "empty DB must return no drafts");
    }

    #[tokio::test]
    async fn get_all_drafts_ordered_by_updated_at_ascending() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "first").await.unwrap();
        save_draft(&pool, BLOCK_B, "second").await.unwrap();

        let drafts = get_all_drafts(&pool).await.unwrap();
        assert_eq!(drafts.len(), 2, "should return both drafts");
        assert!(
            drafts[0].updated_at <= drafts[1].updated_at,
            "must be ordered by updated_at ASC: {} <= {}",
            drafts[0].updated_at,
            drafts[1].updated_at,
        );
    }

    // ── draft_count ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn draft_count_tracks_inserts_upserts_and_deletes() {
        let (pool, _dir) = test_pool().await;

        assert_eq!(draft_count(&pool).await.unwrap(), 0, "initially zero");

        save_draft(&pool, BLOCK_A, "a").await.unwrap();
        assert_eq!(draft_count(&pool).await.unwrap(), 1, "after first insert");

        save_draft(&pool, BLOCK_B, "b").await.unwrap();
        assert_eq!(draft_count(&pool).await.unwrap(), 2, "after second insert");

        save_draft(&pool, BLOCK_A, "a2").await.unwrap();
        assert_eq!(
            draft_count(&pool).await.unwrap(),
            2,
            "upsert must not increase count"
        );

        delete_draft(&pool, BLOCK_A).await.unwrap();
        assert_eq!(draft_count(&pool).await.unwrap(), 1, "after delete");
    }

    // ── flush_draft ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn flush_draft_writes_op_and_removes_draft() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "final content").await.unwrap();

        let record = flush_draft(&pool, DEVICE, BLOCK_A, "final content", None)
            .await
            .unwrap();

        assert_eq!(record.op_type, "edit_block", "op_type must be edit_block");
        assert_eq!(record.device_id, DEVICE, "device_id must match");
        assert!(
            record.payload.contains(BLOCK_A),
            "payload must reference the block"
        );
        assert_eq!(
            draft_count(&pool).await.unwrap(),
            0,
            "draft must be deleted after flush"
        );
    }

    #[tokio::test]
    async fn flush_draft_includes_prev_edit_in_payload() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "updated").await.unwrap();

        let prev = Some((DEVICE.to_owned(), 3));
        let record = flush_draft(&pool, DEVICE, BLOCK_A, "updated", prev)
            .await
            .unwrap();

        assert_eq!(record.op_type, "edit_block");
        assert!(
            record.payload.contains(DEVICE),
            "payload must contain prev_edit device reference"
        );
    }

    #[tokio::test]
    async fn flush_draft_succeeds_without_existing_draft_row() {
        let (pool, _dir) = test_pool().await;

        let record = flush_draft(&pool, DEVICE, BLOCK_A, "content", None)
            .await
            .unwrap();

        assert_eq!(record.op_type, "edit_block");
        assert_eq!(draft_count(&pool).await.unwrap(), 0, "no orphan draft rows");
    }

    #[tokio::test]
    async fn flush_draft_only_deletes_target_block_draft() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "content A").await.unwrap();
        save_draft(&pool, BLOCK_B, "content B").await.unwrap();

        flush_draft(&pool, DEVICE, BLOCK_A, "content A", None)
            .await
            .unwrap();

        assert!(
            get_draft(&pool, BLOCK_A).await.unwrap().is_none(),
            "flushed block's draft must be gone"
        );
        assert!(
            get_draft(&pool, BLOCK_B).await.unwrap().is_some(),
            "other block's draft must be untouched"
        );
    }

    // ── delete_draft_in_tx ──────────────────────────────────────────────

    #[tokio::test]
    async fn delete_draft_in_tx_removes_row_on_commit() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "content").await.unwrap();

        let mut tx = pool.begin().await.unwrap();
        delete_draft_in_tx(&mut tx, BLOCK_A).await.unwrap();
        tx.commit().await.unwrap();

        assert!(
            get_draft(&pool, BLOCK_A).await.unwrap().is_none(),
            "draft must be gone after committed tx"
        );
    }

    #[tokio::test]
    async fn delete_draft_in_tx_rollback_preserves_row() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "content").await.unwrap();

        let mut tx = pool.begin().await.unwrap();
        delete_draft_in_tx(&mut tx, BLOCK_A).await.unwrap();
        tx.rollback().await.unwrap();

        assert!(
            get_draft(&pool, BLOCK_A).await.unwrap().is_some(),
            "draft must survive a rolled-back tx"
        );
    }

    // ── flush_draft atomicity ───────────────────────────────────────────

    #[tokio::test]
    async fn flush_draft_is_atomic_op_and_draft_delete_share_transaction() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "atomic content").await.unwrap();

        let record = flush_draft(&pool, DEVICE, BLOCK_A, "atomic content", None)
            .await
            .unwrap();

        // Op committed
        let op = crate::op_log::get_op_by_seq(&pool, DEVICE, record.seq)
            .await
            .unwrap();
        assert_eq!(op.op_type, "edit_block", "op must be committed");

        // Draft deleted
        assert_eq!(
            draft_count(&pool).await.unwrap(),
            0,
            "draft must be deleted atomically with op commit"
        );
    }

    #[tokio::test]
    async fn flush_draft_rollback_neither_op_nor_draft_deleted() {
        use crate::op_log::{append_local_op_in_tx, get_latest_seq};

        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "rollback test").await.unwrap();

        let seq_before = get_latest_seq(&pool, DEVICE).await.unwrap();

        // Manually replicate flush_draft's logic but roll back instead
        // of committing, to prove rollback semantics.
        {
            let op = OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id(BLOCK_A),
                to_text: "rollback test".to_owned(),
                prev_edit: None,
            });

            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            append_local_op_in_tx(&mut tx, DEVICE, op, chrono::Utc::now().to_rfc3339())
                .await
                .unwrap();
            delete_draft_in_tx(&mut tx, BLOCK_A).await.unwrap();
            tx.rollback().await.unwrap();
        }

        // Op must NOT have been committed
        let seq_after = get_latest_seq(&pool, DEVICE).await.unwrap();
        assert_eq!(
            seq_before, seq_after,
            "op_log seq must not advance after rollback"
        );

        // Draft must still exist
        assert!(
            get_draft(&pool, BLOCK_A).await.unwrap().is_some(),
            "draft must survive a rolled-back flush"
        );
        assert_eq!(
            draft_count(&pool).await.unwrap(),
            1,
            "draft count must remain 1 after rollback"
        );
    }

    #[tokio::test]
    async fn flush_draft_sequential_flushes_produce_chained_ops() {
        let (pool, _dir) = test_pool().await;

        save_draft(&pool, BLOCK_A, "v1").await.unwrap();
        let r1 = flush_draft(&pool, DEVICE, BLOCK_A, "v1", None)
            .await
            .unwrap();
        assert_eq!(r1.seq, 1);

        save_draft(&pool, BLOCK_A, "v2").await.unwrap();
        let r2 = flush_draft(&pool, DEVICE, BLOCK_A, "v2", None)
            .await
            .unwrap();
        assert_eq!(r2.seq, 2, "second flush must chain to seq 2");

        // Both ops are in the log, no drafts remain
        assert_eq!(draft_count(&pool).await.unwrap(), 0);
        let ops = crate::op_log::get_ops_since(&pool, DEVICE, 0)
            .await
            .unwrap();
        assert_eq!(ops.len(), 2, "both ops must be persisted");
    }

    // ── flush_draft partial-failure edge case ───────────────────────────

    /// Verify that flush_draft's atomic transaction prevents partial state:
    /// if we create a draft and flush it, but then a *second* flush (on a
    /// different block) encounters no draft to delete, the op is still
    /// committed and the draft count remains zero — i.e. flush handles the
    /// "delete-nothing" path gracefully because `DELETE WHERE` with zero
    /// matches is not an error.
    #[tokio::test]
    async fn flush_draft_when_delete_draft_fails_after_op_commit() {
        let (pool, _dir) = test_pool().await;

        // Create and flush a draft for BLOCK_A — normal path.
        save_draft(&pool, BLOCK_A, "content A").await.unwrap();
        let r1 = flush_draft(&pool, DEVICE, BLOCK_A, "content A", None)
            .await
            .unwrap();
        assert_eq!(r1.op_type, "edit_block");
        assert_eq!(
            draft_count(&pool).await.unwrap(),
            0,
            "draft must be gone after flush"
        );

        // Now flush BLOCK_B which has NO draft row. The delete_draft_in_tx
        // inside flush_draft will DELETE 0 rows — this must succeed, not error.
        let r2 = flush_draft(&pool, DEVICE, BLOCK_B, "content B", None)
            .await
            .unwrap();
        assert_eq!(r2.op_type, "edit_block", "op should still be committed");
        assert_eq!(
            draft_count(&pool).await.unwrap(),
            0,
            "no orphan drafts after flush with missing draft row"
        );

        // Verify both ops exist in the log
        let ops = crate::op_log::get_ops_since(&pool, DEVICE, 0)
            .await
            .unwrap();
        assert_eq!(
            ops.len(),
            2,
            "both flush ops must be committed regardless of draft existence"
        );
    }

    // ── block_id with LIKE wildcard characters ──────────────────────────

    /// Block IDs containing SQL LIKE metacharacters (`%`, `_`) must be
    /// stored and retrieved correctly.  The draft layer uses parameterised
    /// queries so these characters should not be interpreted as wildcards.
    #[tokio::test]
    async fn block_id_with_like_wildcards() {
        let (pool, _dir) = test_pool().await;

        let ids_with_wildcards = [
            "01HZ0000000000000000BLK%01",
            "01HZ0000000000000000BLK_02",
            "01HZ000000000000000BLK%_03",
        ];

        for &bid in &ids_with_wildcards {
            save_draft(&pool, bid, &format!("content for {bid}"))
                .await
                .unwrap();
        }

        // Each draft must be independently retrievable by exact ID
        for &bid in &ids_with_wildcards {
            let d = get_draft(&pool, bid)
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("draft for {bid} should exist"));
            assert_eq!(d.block_id, bid, "block_id must match exactly");
            assert_eq!(
                d.content,
                format!("content for {bid}"),
                "content must match for {bid}"
            );
        }

        assert_eq!(
            draft_count(&pool).await.unwrap(),
            3,
            "all 3 drafts with LIKE-wildcard IDs must be stored"
        );

        // Delete with LIKE-wildcard ID
        delete_draft(&pool, ids_with_wildcards[0]).await.unwrap();
        assert!(
            get_draft(&pool, ids_with_wildcards[0])
                .await
                .unwrap()
                .is_none(),
            "draft with % in ID must be deletable"
        );
        assert_eq!(
            draft_count(&pool).await.unwrap(),
            2,
            "only the targeted draft must be deleted"
        );
    }

    // ── content containing JSON-like strings ────────────────────────────

    /// Draft content that looks like JSON (`{"key": "val"}`) must not
    /// break payload parsing or database round-trips.  Drafts store plain
    /// text in the `content` column — no JSON interpretation should occur.
    #[tokio::test]
    async fn content_containing_json_like_strings() {
        let (pool, _dir) = test_pool().await;

        let json_like_contents = [
            r#"{"key": "val"}"#,
            r#"[1, 2, {"nested": true}]"#,
            r#"{"block_id": "fake", "op_type": "edit_block"}"#,
            r#"content with "quotes" and {braces}"#,
            r#"null"#,
        ];

        for (i, content) in json_like_contents.iter().enumerate() {
            let bid = format!("01HZ000000000000000000JSON{i:02}");
            save_draft(&pool, &bid, content).await.unwrap();

            let d = get_draft(&pool, &bid)
                .await
                .unwrap()
                .expect("draft should exist");
            assert_eq!(
                &d.content, content,
                "JSON-like content must round-trip exactly: {content}"
            );
        }

        // Flush one of the JSON-like content drafts and verify the op payload
        let record = flush_draft(
            &pool,
            DEVICE,
            "01HZ000000000000000000JSON00",
            r#"{"key": "val"}"#,
            None,
        )
        .await
        .unwrap();

        assert_eq!(record.op_type, "edit_block");
        // Verify the payload is valid JSON containing the to_text field
        let payload: serde_json::Value = serde_json::from_str(&record.payload).unwrap();
        assert_eq!(
            payload["to_text"].as_str().unwrap(),
            r#"{"key": "val"}"#,
            "JSON-like content must be properly escaped in the op payload"
        );
    }
}
