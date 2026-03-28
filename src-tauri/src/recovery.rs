//! Crash recovery at boot — runs before any user-visible UI (ADR-07).
//!
//! 1. Deletes any `log_snapshots` rows with `status = 'pending'` (incomplete
//!    snapshots from a prior crash).
//! 2. Walks `block_drafts` and, for each row, checks whether a corresponding
//!    `edit_block` or `create_block` op already exists in `op_log` after the
//!    draft's `updated_at` timestamp. If not, the draft was never flushed and a
//!    synthetic `edit_block` op is created to recover it.
//! 3. All draft rows are deleted regardless of whether they were recovered or
//!    already flushed.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::draft::{delete_draft, get_all_drafts};
use crate::error::AppError;
use crate::op::{EditBlockPayload, OpPayload};
use crate::op_log::append_local_op;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Summary returned by [`recover_at_boot`] for observability / logging.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryReport {
    /// Number of `log_snapshots` rows with `status = 'pending'` that were deleted.
    pub pending_snapshots_deleted: u64,
    /// Block IDs whose drafts were recovered as synthetic `edit_block` ops.
    pub drafts_recovered: Vec<String>,
    /// Number of draft rows that already had a matching op and just needed deletion.
    pub drafts_already_flushed: u64,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Run crash-recovery checks. Must be called **before** any user-visible UI.
///
/// See module-level docs for the full sequence.
pub async fn recover_at_boot(
    pool: &SqlitePool,
    device_id: &str,
) -> Result<RecoveryReport, AppError> {
    // -----------------------------------------------------------------
    // Step 1: Delete pending snapshots
    // -----------------------------------------------------------------
    let delete_result = sqlx::query("DELETE FROM log_snapshots WHERE status = 'pending'")
        .execute(pool)
        .await?;
    let pending_snapshots_deleted = delete_result.rows_affected();

    // -----------------------------------------------------------------
    // Step 2: Walk block_drafts and recover unflushed drafts
    // -----------------------------------------------------------------
    let drafts = get_all_drafts(pool).await?;

    let mut drafts_recovered: Vec<String> = Vec::new();
    let mut drafts_already_flushed: u64 = 0;

    for draft in &drafts {
        // Check if an edit_block or create_block op exists for this block_id
        // with created_at >= the draft's updated_at.
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM op_log \
             WHERE json_extract(payload, '$.block_id') = ? \
             AND op_type IN ('edit_block', 'create_block') \
             AND created_at >= ?",
        )
        .bind(&draft.block_id)
        .bind(&draft.updated_at)
        .fetch_one(pool)
        .await?;
        let matching_ops = row.0;

        if matching_ops == 0 {
            // Draft was NOT flushed — recover it.

            // Find the latest edit_block or create_block op for this block_id
            // to use as prev_edit.
            let prev_edit = find_prev_edit(pool, &draft.block_id).await?;

            let op = OpPayload::EditBlock(EditBlockPayload {
                block_id: draft.block_id.clone(),
                to_text: draft.content.clone(),
                prev_edit,
            });
            append_local_op(pool, device_id, op).await?;

            eprintln!(
                "[recovery] Recovered unflushed draft for block {}",
                draft.block_id
            );
            drafts_recovered.push(draft.block_id.clone());
        } else {
            drafts_already_flushed += 1;
        }

        // Delete the draft row regardless of outcome.
        delete_draft(pool, &draft.block_id).await?;
    }

    Ok(RecoveryReport {
        pending_snapshots_deleted,
        drafts_recovered,
        drafts_already_flushed,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Find the most recent `edit_block` or `create_block` op for a given
/// `block_id`, returning `Some((device_id, seq))` or `None`.
async fn find_prev_edit(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Option<(String, i64)>, AppError> {
    let maybe_row: Option<(String, i64)> = sqlx::query_as(
        "SELECT device_id, seq FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ? \
         AND op_type IN ('edit_block', 'create_block') \
         ORDER BY created_at DESC \
         LIMIT 1",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    Ok(maybe_row)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::draft::save_draft;
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    #[tokio::test]
    async fn pending_snapshot_gets_deleted() {
        let (pool, _dir) = test_pool().await;

        // Insert a pending snapshot row
        sqlx::query(
            "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
             VALUES (?, 'pending', 'abc', '[]', X'00')",
        )
        .bind("snap-1")
        .execute(&pool)
        .await
        .unwrap();

        // Also insert a complete snapshot that should NOT be deleted
        sqlx::query(
            "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
             VALUES (?, 'complete', 'def', '[]', X'01')",
        )
        .bind("snap-2")
        .execute(&pool)
        .await
        .unwrap();

        let report = recover_at_boot(&pool, "dev-1").await.unwrap();

        assert_eq!(report.pending_snapshots_deleted, 1);

        // Verify: pending row gone, complete row remains
        let remaining: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM log_snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining.0, 1);

        let complete: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(complete.0, 1);
    }

    #[tokio::test]
    async fn unflushed_draft_gets_recovered_as_synthetic_edit_block() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";
        let block_id = "block-A";

        // Create a draft with no corresponding op in op_log
        save_draft(&pool, block_id, "unflushed content")
            .await
            .unwrap();

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        // The draft should have been recovered
        assert_eq!(report.drafts_recovered, vec!["block-A"]);
        assert_eq!(report.drafts_already_flushed, 0);

        // A synthetic edit_block op should exist in op_log
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM op_log \
             WHERE json_extract(payload, '$.block_id') = ? \
             AND op_type = 'edit_block'",
        )
        .bind(block_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, 1);

        // The draft row should be deleted
        let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
        assert!(drafts.is_empty());
    }

    #[tokio::test]
    async fn already_flushed_draft_just_gets_deleted() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";
        let block_id = "block-B";

        // Insert a draft with a known-old timestamp so that the edit_block op's
        // created_at (Utc::now()) is *guaranteed* to be >=.  This avoids a
        // flaky-test window where both calls land on the same clock tick.
        sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind("some content")
            .bind("2000-01-01T00:00:00+00:00")
            .execute(&pool)
            .await
            .unwrap();

        // Simulate that the flush already happened: write an edit_block op
        // whose created_at (Utc::now()) is well after the draft's updated_at.
        let op = OpPayload::EditBlock(EditBlockPayload {
            block_id: block_id.to_owned(),
            to_text: "some content".to_owned(),
            prev_edit: None,
        });
        append_local_op(&pool, device_id, op).await.unwrap();

        // Count ops before recovery
        let before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        assert!(report.drafts_recovered.is_empty());
        assert_eq!(report.drafts_already_flushed, 1);

        // No new op should have been created
        let after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(before.0, after.0);

        // Draft row should be deleted
        let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
        assert!(drafts.is_empty());
    }

    #[tokio::test]
    async fn recovery_with_no_drafts_returns_empty_report() {
        let (pool, _dir) = test_pool().await;

        let report = recover_at_boot(&pool, "dev-1").await.unwrap();

        assert_eq!(report.pending_snapshots_deleted, 0);
        assert!(report.drafts_recovered.is_empty());
        assert_eq!(report.drafts_already_flushed, 0);
    }

    #[tokio::test]
    async fn recovered_draft_uses_prev_edit_from_existing_op() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";
        let block_id = "block-C";

        // Create a block first (this will be the prev_edit reference)
        let create_op = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: block_id.to_owned(),
            block_type: "content".to_owned(),
            parent_id: None,
            position: Some(0),
            content: "initial".to_owned(),
        });
        let create_record = append_local_op(&pool, device_id, create_op).await.unwrap();

        // Now save a draft (simulating that the user edited but the app crashed
        // before flushing). We need the draft's updated_at to be strictly AFTER
        // the create op's created_at, otherwise the recovery check
        // `created_at >= updated_at` would match the create_block and
        // mis-classify the draft as "already flushed".
        //
        // Use a far-future timestamp to eliminate any clock-resolution flakiness.
        sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind("edited content")
            .bind("2099-01-01T00:00:00+00:00")
            .execute(&pool)
            .await
            .unwrap();

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        assert_eq!(report.drafts_recovered, vec![block_id]);

        // The synthetic edit_block should reference the create op as prev_edit
        let row: (String,) = sqlx::query_as(
            "SELECT payload FROM op_log \
             WHERE op_type = 'edit_block' \
             AND json_extract(payload, '$.block_id') = ?",
        )
        .bind(block_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        let payload: serde_json::Value = serde_json::from_str(&row.0).unwrap();
        let prev_edit = payload["prev_edit"].as_array().unwrap();
        assert_eq!(prev_edit[0].as_str().unwrap(), device_id);
        assert_eq!(prev_edit[1].as_i64().unwrap(), create_record.seq);
    }
}
