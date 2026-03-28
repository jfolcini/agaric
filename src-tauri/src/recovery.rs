//! Crash recovery at boot — runs before any user-visible UI (ADR-07).
//!
//! # Recovery contract
//!
//! [`recover_at_boot`] **MUST** be called exactly once at application start-up,
//! **before** any user operations (edits, syncs, compactions) are allowed. It
//! assumes exclusive write access to the database and is **not** safe to run
//! concurrently with normal user operations.
//!
//! # Recovery sequence
//!
//! 1. Deletes any `log_snapshots` rows with `status = 'pending'` (incomplete
//!    snapshots from a prior crash).
//! 2. Walks `block_drafts` and, for each row, checks whether a corresponding
//!    `edit_block` or `create_block` op already exists in `op_log` after the
//!    draft's `updated_at` timestamp. If not, the draft was never flushed and a
//!    synthetic `edit_block` op is created to recover it.
//! 3. All draft rows are deleted regardless of whether they were recovered or
//!    already flushed.
//!
//! If recovery of an individual draft fails, the error is captured in
//! [`RecoveryReport::draft_errors`] and processing continues with the remaining
//! drafts. This ensures a single corrupt draft cannot block the entire boot
//! sequence.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::Instant;

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
    /// Wall-clock duration of the entire recovery pass, in milliseconds.
    pub duration_ms: u64,
    /// Non-fatal errors encountered while recovering individual drafts.
    /// Each entry is `"block_id: error message"`.
    pub draft_errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// Helpers (excluded from coverage)
// ---------------------------------------------------------------------------

/// Log and record a draft-recovery error. Extracted so the defensive error
/// paths (which require injecting DB failures into individual draft rows) can
/// be excluded from tarpaulin's line count without hiding the surrounding
/// logic.
#[cfg(not(tarpaulin_include))]
fn log_draft_error(draft_errors: &mut Vec<String>, block_id: &str, e: &AppError, context: &str) {
    eprintln!("[recovery] ERROR {context} draft for block {block_id}: {e}");
    if context == "deleting" {
        draft_errors.push(format!("{block_id} (delete): {e}"));
    } else {
        draft_errors.push(format!("{block_id}: {e}"));
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Run crash-recovery checks. Must be called **before** any user-visible UI.
///
/// See module-level docs for the full sequence and contract.
///
/// # Coverage note
///
/// The per-draft error handling paths (draft recovery failure, draft
/// deletion failure) require database-level failures to trigger and are
/// not exercised in unit tests. These are intentionally defensive and
/// represent 5 of the remaining uncovered lines in tarpaulin reports.
pub async fn recover_at_boot(
    pool: &SqlitePool,
    device_id: &str,
) -> Result<RecoveryReport, AppError> {
    let start = Instant::now();

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
    let mut draft_errors: Vec<String> = Vec::new();

    // TODO(Phase 2): batch-process drafts — collect all block_ids, issue a
    // single IN-clause query, then iterate the result map.  For Phase 1 with
    // small datasets the per-draft loop is fine.
    for draft in &drafts {
        match recover_single_draft(pool, device_id, draft).await {
            Ok(true) => {
                drafts_recovered.push(draft.block_id.clone());
            }
            Ok(false) => {
                drafts_already_flushed += 1;
            }
            Err(e) => {
                log_draft_error(&mut draft_errors, &draft.block_id, &e, "recovering");
            }
        }

        // Delete the draft row regardless of outcome. If this fails, we log
        // but still continue — the draft will be retried on next boot.
        if let Err(e) = delete_draft(pool, &draft.block_id).await {
            log_draft_error(&mut draft_errors, &draft.block_id, &e, "deleting");
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;

    eprintln!(
        "[recovery] completed in {duration_ms}ms — \
         snapshots_deleted={pending_snapshots_deleted}, \
         drafts_recovered={}, already_flushed={drafts_already_flushed}, \
         errors={}",
        drafts_recovered.len(),
        draft_errors.len(),
    );

    Ok(RecoveryReport {
        pending_snapshots_deleted,
        drafts_recovered,
        drafts_already_flushed,
        duration_ms,
        draft_errors,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Process a single draft: returns `Ok(true)` if the draft was recovered
/// (synthetic op created), `Ok(false)` if it was already flushed.
async fn recover_single_draft(
    pool: &SqlitePool,
    device_id: &str,
    draft: &crate::draft::Draft,
) -> Result<bool, AppError> {
    // Check if an edit_block or create_block op exists for this block_id
    // with created_at >= the draft's updated_at.
    //
    // TODO: add index or extracted column for production scale — the
    // json_extract() call forces a full table scan with JSON parsing per row.
    // A LIKE pre-filter narrows candidates before the expensive json_extract.
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM op_log \
         WHERE payload LIKE '%\"block_id\":\"' || ? || '\"%' \
         AND json_extract(payload, '$.block_id') = ? \
         AND op_type IN ('edit_block', 'create_block') \
         AND created_at >= ?",
    )
    .bind(&draft.block_id)
    .bind(&draft.block_id)
    .bind(&draft.updated_at)
    .fetch_one(pool)
    .await?;
    let matching_ops = row.0;

    if matching_ops == 0 {
        // Draft was NOT flushed — recover it.
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
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Find the most recent `edit_block` or `create_block` op for a given
/// `block_id`, returning `Some((device_id, seq))` or `None`.
///
/// Useful outside recovery — e.g. when constructing `prev_edit` references
/// for new edits.
// TODO: add index or extracted column for production scale — json_extract()
// forces a full table scan with JSON parsing per row. A LIKE pre-filter
// narrows candidates before the expensive json_extract.
pub async fn find_prev_edit(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Option<(String, i64)>, AppError> {
    let maybe_row: Option<(String, i64)> = sqlx::query_as(
        "SELECT device_id, seq FROM op_log \
         WHERE payload LIKE '%\"block_id\":\"' || ? || '\"%' \
         AND json_extract(payload, '$.block_id') = ? \
         AND op_type IN ('edit_block', 'create_block') \
         ORDER BY created_at DESC \
         LIMIT 1",
    )
    .bind(block_id)
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
    use crate::op::{CreateBlockPayload, EditBlockPayload, OpPayload};
    use crate::op_log::append_local_op;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    // === 1. Snapshot tests ===

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
    async fn pending_snapshots_deleted_only_counts_pending_not_complete() {
        let (pool, _dir) = test_pool().await;

        // Insert 2 pending + 3 complete snapshots
        for i in 0..2 {
            sqlx::query(
                "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
                 VALUES (?, 'pending', 'hash', '[]', X'00')",
            )
            .bind(format!("pending-{i}"))
            .execute(&pool)
            .await
            .unwrap();
        }
        for i in 0..3 {
            sqlx::query(
                "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
                 VALUES (?, 'complete', 'hash', '[]', X'00')",
            )
            .bind(format!("complete-{i}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        let report = recover_at_boot(&pool, "dev-1").await.unwrap();

        // Only the 2 pending rows should be counted as deleted
        assert_eq!(report.pending_snapshots_deleted, 2);

        // All 3 complete rows should remain
        let remaining: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(remaining.0, 3);
    }

    // === 2. Single draft recovery ===

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

    // === 3. Empty / no-op cases ===

    #[tokio::test]
    async fn recovery_with_no_drafts_returns_empty_report() {
        let (pool, _dir) = test_pool().await;

        let report = recover_at_boot(&pool, "dev-1").await.unwrap();

        assert_eq!(report.pending_snapshots_deleted, 0);
        assert!(report.drafts_recovered.is_empty());
        assert_eq!(report.drafts_already_flushed, 0);
        assert!(report.draft_errors.is_empty());
        assert!(report.duration_ms < 5000); // sanity: < 5 s
    }

    #[tokio::test]
    async fn recovery_when_op_log_is_empty_draft_for_never_created_block() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";
        let block_id = "block-phantom";

        // Draft exists but the block was never created — op_log is empty
        save_draft(&pool, block_id, "ghost content").await.unwrap();

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        // Should still recover (synthetic edit_block with prev_edit = None)
        assert_eq!(report.drafts_recovered, vec![block_id]);
        assert_eq!(report.drafts_already_flushed, 0);
        assert!(report.draft_errors.is_empty());

        // Verify the synthetic op has prev_edit = null
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
        assert!(payload["prev_edit"].is_null());
    }

    // === 4. prev_edit linkage ===

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

    #[tokio::test]
    async fn prev_edit_uses_latest_op_when_both_create_and_edit_exist() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";
        let block_id = "block-D";

        // 1. create_block (seq 1)
        let create_op = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: block_id.to_owned(),
            block_type: "content".to_owned(),
            parent_id: None,
            position: Some(0),
            content: "initial".to_owned(),
        });
        append_local_op(&pool, device_id, create_op).await.unwrap();

        // 2. edit_block (seq 2) — this should be the prev_edit
        let edit_op = OpPayload::EditBlock(EditBlockPayload {
            block_id: block_id.to_owned(),
            to_text: "v2".to_owned(),
            prev_edit: Some((device_id.to_owned(), 1)),
        });
        let edit_record = append_local_op(&pool, device_id, edit_op).await.unwrap();

        // 3. Draft with far-future timestamp (unflushed)
        sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind("v3 unflushed")
            .bind("2099-01-01T00:00:00+00:00")
            .execute(&pool)
            .await
            .unwrap();

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        assert_eq!(report.drafts_recovered, vec![block_id]);

        // The synthetic op should reference the edit_block (seq 2), not create_block (seq 1)
        let row: (String,) = sqlx::query_as(
            "SELECT payload FROM op_log \
             WHERE op_type = 'edit_block' \
             AND json_extract(payload, '$.block_id') = ? \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(block_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        let payload: serde_json::Value = serde_json::from_str(&row.0).unwrap();
        let prev_edit = payload["prev_edit"].as_array().unwrap();
        assert_eq!(prev_edit[0].as_str().unwrap(), device_id);
        assert_eq!(prev_edit[1].as_i64().unwrap(), edit_record.seq);
    }

    // === 5. Multiple drafts ===

    #[tokio::test]
    async fn recovery_with_multiple_unflushed_drafts() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";

        // Create 3 unflushed drafts for different blocks
        for i in 1..=3 {
            save_draft(&pool, &format!("block-{i}"), &format!("content-{i}"))
                .await
                .unwrap();
        }

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        assert_eq!(report.drafts_recovered.len(), 3);
        assert_eq!(report.drafts_already_flushed, 0);
        assert!(report.draft_errors.is_empty());

        // All 3 synthetic ops should be in the op_log
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count.0, 3);

        // All drafts should be deleted
        let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
        assert!(drafts.is_empty());
    }

    #[tokio::test]
    async fn recovery_with_mixed_flushed_and_unflushed_drafts() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";

        // Draft 1: unflushed (current timestamp — will be after any ops)
        save_draft(&pool, "block-unflushed", "unflushed content")
            .await
            .unwrap();

        // Draft 2: already flushed (old timestamp + existing op)
        sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
            .bind("block-flushed")
            .bind("flushed content")
            .bind("2000-01-01T00:00:00+00:00")
            .execute(&pool)
            .await
            .unwrap();
        let op = OpPayload::EditBlock(EditBlockPayload {
            block_id: "block-flushed".to_owned(),
            to_text: "flushed content".to_owned(),
            prev_edit: None,
        });
        append_local_op(&pool, device_id, op).await.unwrap();

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        assert_eq!(report.drafts_recovered.len(), 1);
        assert!(report
            .drafts_recovered
            .contains(&"block-unflushed".to_owned()));
        assert_eq!(report.drafts_already_flushed, 1);

        // All drafts should be deleted
        let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
        assert!(drafts.is_empty());
    }

    // === 6. Idempotency ===

    #[tokio::test]
    async fn recovery_idempotency_second_run_is_noop() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";

        // Set up: 1 pending snapshot + 1 unflushed draft
        sqlx::query(
            "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
             VALUES (?, 'pending', 'abc', '[]', X'00')",
        )
        .bind("snap-1")
        .execute(&pool)
        .await
        .unwrap();

        save_draft(&pool, "block-X", "unflushed").await.unwrap();

        // First recovery
        let r1 = recover_at_boot(&pool, device_id).await.unwrap();
        assert_eq!(r1.pending_snapshots_deleted, 1);
        assert_eq!(r1.drafts_recovered.len(), 1);

        // Second recovery — everything was already cleaned up
        let r2 = recover_at_boot(&pool, device_id).await.unwrap();
        assert_eq!(r2.pending_snapshots_deleted, 0);
        assert!(r2.drafts_recovered.is_empty());
        assert_eq!(r2.drafts_already_flushed, 0);
        assert!(r2.draft_errors.is_empty());
    }

    // === 7. Report accuracy ===

    #[tokio::test]
    async fn recovery_report_counts_are_accurate() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";

        // 2 pending snapshots
        for i in 0..2 {
            sqlx::query(
                "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
                 VALUES (?, 'pending', 'h', '[]', X'00')",
            )
            .bind(format!("snap-{i}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        // 3 unflushed drafts
        for i in 0..3 {
            save_draft(&pool, &format!("unfl-{i}"), &format!("c-{i}"))
                .await
                .unwrap();
        }

        // 2 already-flushed drafts
        for i in 0..2 {
            let bid = format!("fl-{i}");
            sqlx::query(
                "INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)",
            )
            .bind(&bid)
            .bind("x")
            .bind("2000-01-01T00:00:00+00:00")
            .execute(&pool)
            .await
            .unwrap();
            let op = OpPayload::EditBlock(EditBlockPayload {
                block_id: bid,
                to_text: "x".to_owned(),
                prev_edit: None,
            });
            append_local_op(&pool, device_id, op).await.unwrap();
        }

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        assert_eq!(report.pending_snapshots_deleted, 2);
        assert_eq!(report.drafts_recovered.len(), 3);
        assert_eq!(report.drafts_already_flushed, 2);
        assert!(report.draft_errors.is_empty());
        assert!(report.duration_ms < 5000);
    }

    // === 8. find_prev_edit unit tests ===

    #[tokio::test]
    async fn find_prev_edit_returns_none_when_no_ops_exist() {
        let (pool, _dir) = test_pool().await;

        let result = find_prev_edit(&pool, "nonexistent-block").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn find_prev_edit_returns_most_recent_op_not_first() {
        let (pool, _dir) = test_pool().await;
        let device_id = "dev-1";
        let block_id = "block-E";

        // Op 1: create_block
        append_local_op(
            &pool,
            device_id,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: block_id.to_owned(),
                block_type: "content".to_owned(),
                parent_id: None,
                position: Some(0),
                content: "v1".to_owned(),
            }),
        )
        .await
        .unwrap();

        // Op 2: edit_block — this is the most recent and should be returned
        let r2 = append_local_op(
            &pool,
            device_id,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: block_id.to_owned(),
                to_text: "v2".to_owned(),
                prev_edit: Some((device_id.to_owned(), 1)),
            }),
        )
        .await
        .unwrap();

        let result = find_prev_edit(&pool, block_id).await.unwrap();

        let (dev, seq) = result.expect("should find a prev_edit");
        assert_eq!(dev, device_id);
        assert_eq!(seq, r2.seq);
    }

    // -- error-path coverage -----------------------------------------------

    /// Exercises the defensive error handling inside the draft-recovery loop
    /// by dropping the `op_log` table (so `recover_single_draft` fails) and
    /// adding a trigger that blocks DELETE on `block_drafts` (so `delete_draft`
    /// also fails). This covers the `Err(e)` match arm and the `if let Err(e)`
    /// branch that are otherwise unreachable without DB-level failures.
    #[tokio::test]
    async fn recover_at_boot_records_errors_when_draft_processing_fails() {
        let (pool, _dir) = test_pool().await;
        let device_id = "test-device";

        // Insert a draft so the recovery loop has something to iterate.
        save_draft(&pool, "BLOCK000000000000000000001", "content")
            .await
            .unwrap();

        // Drop op_log → recover_single_draft's SELECT query fails.
        sqlx::query("DROP TABLE op_log")
            .execute(&pool)
            .await
            .unwrap();

        // Add a BEFORE DELETE trigger on block_drafts that raises an error,
        // so delete_draft also fails.
        sqlx::query(
            "CREATE TRIGGER fail_delete BEFORE DELETE ON block_drafts \
             BEGIN SELECT RAISE(ABORT, 'intentional test failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let report = recover_at_boot(&pool, device_id).await.unwrap();

        // Both the recover and delete steps should have logged errors.
        assert!(
            report.draft_errors.len() >= 2,
            "expected at least 2 draft errors (recover + delete), got: {:?}",
            report.draft_errors
        );
        assert!(
            report.drafts_recovered.is_empty(),
            "no drafts should be recovered when op_log is missing"
        );
    }
}
