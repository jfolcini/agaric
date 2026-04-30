use super::*;
use crate::db::init_pool;
use crate::draft::save_draft;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op::{CreateBlockPayload, EditBlockPayload, OpPayload};
use crate::op_log::{append_local_op, append_local_op_at};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

/// L-103 test wrapper. The production `recover_at_boot` enforces a
/// once-per-process contract via a static `AtomicBool`; tests need to
/// reset that guard before each invocation so multiple `tokio::test`
/// fixtures can each run their own recovery against a fresh pool. Use
/// this wrapper everywhere a test would call `recover_at_boot` directly
/// — the explicit "second-call returns Err" test calls the production
/// function directly to exercise the unguarded path.
///
/// C-2b: the wrapper builds a per-call `Materializer` against the same
/// pool so the replay step inside `recover_at_boot` has a real
/// foreground queue to drain. Tests that don't need to inspect the
/// replay path get the same observable behaviour as before — a fresh
/// pool's op log is empty, so replay is a no-op.
async fn recover_at_boot_test(
    pool: &SqlitePool,
    device_id: &str,
) -> Result<RecoveryReport, AppError> {
    super::boot::reset_recovery_guard();
    let materializer = Materializer::new(pool.clone());
    let result = recover_at_boot(pool, device_id, &materializer).await;
    materializer.shutdown();
    result
}

// -- Test fixture constants --
//
// All timestamps use `Z` (not `+00:00`) to match `now_rfc3339()` output.
// Mixing suffixes would break the lexicographic `>` comparison in
// `recover_single_draft`'s SQL query (see REVIEW-LATER #48).

/// Far-past timestamp: any op created by `append_local_op` (which calls
/// `now_rfc3339()`) will have `created_at > FAR_PAST`, so the draft is
/// classified as "already flushed".
const FAR_PAST: &str = "2000-01-01T00:00:00Z";

/// Far-future timestamp: no op created by `append_local_op` will have
/// `created_at > FAR_FUTURE`, so the draft is classified as "unflushed"
/// and gets recovered.
const FAR_FUTURE: &str = "2099-01-01T00:00:00Z";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Helper: insert a block row into the `blocks` table for testing.
async fn insert_test_block(pool: &SqlitePool, block_id: &str, content: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'content', ?, 0)",
    )
    .bind(block_id)
    .bind(content)
    .execute(pool)
    .await
    .unwrap();
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

    let report = recover_at_boot_test(&pool, "dev-1").await.unwrap();

    assert_eq!(report.pending_snapshots_deleted, 1);

    // Verify: pending row gone, complete row remains
    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1);

    let complete: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(complete, 1);
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

    let report = recover_at_boot_test(&pool, "dev-1").await.unwrap();

    // Only the 2 pending rows should be counted as deleted
    assert_eq!(report.pending_snapshots_deleted, 2);

    // All 3 complete rows should remain
    let remaining: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, 3);
}

// === 2. Single draft recovery ===

#[tokio::test]
async fn unflushed_draft_gets_recovered_as_synthetic_edit_block() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-A";

    // Create a block row so recovery doesn't skip it (F07)
    insert_test_block(&pool, block_id, "old content").await;

    // Create a draft with no corresponding op in op_log
    save_draft(&pool, block_id, "unflushed content")
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    // The draft should have been recovered
    assert_eq!(report.drafts_recovered, vec!["block-A"]);
    assert_eq!(report.drafts_already_flushed, 0);

    // A synthetic edit_block op should exist in op_log
    let bid_upper = block_id.to_ascii_uppercase();
    let row: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ? \
         AND op_type = 'edit_block'",
        bid_upper
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, 1);

    // The draft row should be deleted
    let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
    assert!(drafts.is_empty());
}

#[tokio::test]
async fn already_flushed_draft_just_gets_deleted() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-B";

    // Create a block row so recovery doesn't skip it (F07)
    insert_test_block(&pool, block_id, "some content").await;

    // Insert a draft with a known-old timestamp so that the edit_block op's
    // created_at (Utc::now()) is *guaranteed* to be >.  This avoids a
    // flaky-test window where both calls land on the same clock tick.
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind("some content")
        .bind(FAR_PAST)
        .execute(&pool)
        .await
        .unwrap();

    // Simulate that the flush already happened: write an edit_block op
    // whose created_at (Utc::now()) is well after the draft's updated_at.
    let op = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id(block_id),
        to_text: "some content".to_owned(),
        prev_edit: None,
    });
    append_local_op(&pool, device_id, op).await.unwrap();

    // Count ops before recovery
    let before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert!(report.drafts_recovered.is_empty());
    assert_eq!(report.drafts_already_flushed, 1);

    // No new op should have been created
    let after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before, after);

    // Draft row should be deleted
    let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
    assert!(drafts.is_empty());
}

// === 3. Empty / no-op cases ===

#[tokio::test]
async fn recovery_with_no_drafts_returns_empty_report() {
    let (pool, _dir) = test_pool().await;

    let report = recover_at_boot_test(&pool, "dev-1").await.unwrap();

    assert_eq!(report.pending_snapshots_deleted, 0);
    assert!(report.drafts_recovered.is_empty());
    assert_eq!(report.drafts_already_flushed, 0);
    assert!(report.draft_errors.is_empty());
    assert!(report.duration_ms < 5000); // sanity: < 5 s
}

// `recovery_when_op_log_is_empty_draft_for_never_created_block` was deleted
// in M-93 / migration 0038: `block_drafts.block_id` now has a FK to
// `blocks(id) ON DELETE CASCADE`, so the "draft exists for a block id with
// no `blocks` row" precondition is schema-impossible. The recovery F07
// orphan-skip code path remains load-bearing for the *soft-deleted* branch
// — covered by `draft_for_soft_deleted_block_is_skipped_and_cleaned_up`
// below — and the FK invariant itself is asserted by
// `commands::drafts::tests_h12::cannot_save_draft_for_nonexistent_block_m93`.

// === 4. prev_edit linkage ===

#[tokio::test]
async fn recovered_draft_uses_prev_edit_from_existing_op() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-C";

    // Create a block row so recovery doesn't skip it (F07)
    insert_test_block(&pool, block_id, "initial").await;

    // Create a block first (this will be the prev_edit reference)
    let create_op = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".to_owned(),
        parent_id: None,
        position: Some(0),
        content: "initial".to_owned(),
    });
    let create_record = append_local_op(&pool, device_id, create_op).await.unwrap();

    // Now save a draft (simulating that the user edited but the app crashed
    // before flushing). We need the draft's updated_at to be strictly AFTER
    // the create op's created_at, otherwise the recovery check
    // `created_at > updated_at` would match the create_block and
    // mis-classify the draft as "already flushed".
    //
    // Use a far-future timestamp to eliminate any clock-resolution flakiness.
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind("edited content")
        .bind(FAR_FUTURE)
        .execute(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert_eq!(report.drafts_recovered, vec![block_id]);

    // The synthetic edit_block should reference the create op as prev_edit
    let bid_upper = block_id.to_ascii_uppercase();
    let row: String = sqlx::query_scalar!(
        "SELECT payload FROM op_log \
         WHERE op_type = 'edit_block' \
         AND json_extract(payload, '$.block_id') = ?",
        bid_upper
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let payload: serde_json::Value = serde_json::from_str(&row).unwrap();
    let prev_edit = payload["prev_edit"].as_array().unwrap();
    assert_eq!(prev_edit[0].as_str().unwrap(), device_id);
    assert_eq!(prev_edit[1].as_i64().unwrap(), create_record.seq);
}

#[tokio::test]
async fn prev_edit_uses_latest_op_when_both_create_and_edit_exist() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-D";

    // Create a block row so recovery doesn't skip it (F07)
    insert_test_block(&pool, block_id, "initial").await;

    // 1. create_block (seq 1)
    let create_op = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".to_owned(),
        parent_id: None,
        position: Some(0),
        content: "initial".to_owned(),
    });
    append_local_op(&pool, device_id, create_op).await.unwrap();

    // Sleep guard: ensure distinct created_at timestamps (ms precision)
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;

    // 2. edit_block (seq 2) — this should be the prev_edit
    let edit_op = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id(block_id),
        to_text: "v2".to_owned(),
        prev_edit: Some((device_id.to_owned(), 1)),
    });
    let edit_record = append_local_op(&pool, device_id, edit_op).await.unwrap();

    // 3. Draft with far-future timestamp (unflushed)
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind("v3 unflushed")
        .bind(FAR_FUTURE)
        .execute(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert_eq!(report.drafts_recovered, vec![block_id]);

    // The synthetic op should reference the edit_block (seq 2), not create_block (seq 1)
    let bid_upper = block_id.to_ascii_uppercase();
    let row: String = sqlx::query_scalar!(
        "SELECT payload FROM op_log \
         WHERE op_type = 'edit_block' \
         AND json_extract(payload, '$.block_id') = ? \
         ORDER BY created_at DESC LIMIT 1",
        bid_upper
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let payload: serde_json::Value = serde_json::from_str(&row).unwrap();
    let prev_edit = payload["prev_edit"].as_array().unwrap();
    assert_eq!(prev_edit[0].as_str().unwrap(), device_id);
    assert_eq!(prev_edit[1].as_i64().unwrap(), edit_record.seq);
}

// === 5. Multiple drafts ===

#[tokio::test]
async fn recovery_with_multiple_unflushed_drafts() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Create 3 unflushed drafts for different blocks (with block rows)
    for i in 1..=3 {
        let bid = format!("block-{i}");
        insert_test_block(&pool, &bid, &format!("old-{i}")).await;
        save_draft(&pool, &bid, &format!("content-{i}"))
            .await
            .unwrap();
    }

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert_eq!(report.drafts_recovered.len(), 3);
    assert_eq!(report.drafts_already_flushed, 0);
    assert!(report.draft_errors.is_empty());

    // All 3 synthetic ops should be in the op_log
    let count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 3);

    // All drafts should be deleted
    let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
    assert!(drafts.is_empty());
}

#[tokio::test]
async fn recovery_with_mixed_flushed_and_unflushed_drafts() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Block rows for both drafts (F07)
    insert_test_block(&pool, "block-unflushed", "old unflushed").await;
    insert_test_block(&pool, "block-flushed", "flushed content").await;

    // Draft 1: unflushed (current timestamp — will be after any ops)
    save_draft(&pool, "block-unflushed", "unflushed content")
        .await
        .unwrap();

    // Draft 2: already flushed (old timestamp + existing op)
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("block-flushed")
        .bind("flushed content")
        .bind(FAR_PAST)
        .execute(&pool)
        .await
        .unwrap();
    let op = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id("block-flushed"),
        to_text: "flushed content".to_owned(),
        prev_edit: None,
    });
    append_local_op(&pool, device_id, op).await.unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

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

    // Set up: 1 pending snapshot + 1 unflushed draft (with block row)
    sqlx::query(
        "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
         VALUES (?, 'pending', 'abc', '[]', X'00')",
    )
    .bind("snap-1")
    .execute(&pool)
    .await
    .unwrap();

    insert_test_block(&pool, "block-X", "old X").await;
    save_draft(&pool, "block-X", "unflushed").await.unwrap();

    // First recovery
    let r1 = recover_at_boot_test(&pool, device_id).await.unwrap();
    assert_eq!(r1.pending_snapshots_deleted, 1);
    assert_eq!(r1.drafts_recovered.len(), 1);

    // Second recovery — everything was already cleaned up
    let r2 = recover_at_boot_test(&pool, device_id).await.unwrap();
    assert_eq!(r2.pending_snapshots_deleted, 0);
    assert!(r2.drafts_recovered.is_empty());
    assert_eq!(r2.drafts_already_flushed, 0);
    assert!(r2.draft_errors.is_empty());
}

/// L-103: the production `recover_at_boot` enforces a once-per-process
/// contract via a static `AtomicBool`. Calling it twice without
/// resetting the guard must return `AppError::InvalidOperation` BEFORE
/// touching the pool, NOT silently complete with an empty-batch report.
///
/// Note: this test calls the production `recover_at_boot` directly
/// (not the `recover_at_boot_test` wrapper) to exercise the unguarded
/// path, then resets the guard at the end so neighbouring tests are
/// not perturbed.
#[tokio::test]
async fn recover_at_boot_returns_err_on_second_call_without_reset() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Reset BEFORE — neighbour tests may have left the guard tripped.
    super::boot::reset_recovery_guard();

    let materializer = Materializer::new(pool.clone());

    // First call: succeeds.
    let r1 = recover_at_boot(&pool, device_id, &materializer).await;
    assert!(r1.is_ok(), "first call must succeed; got {r1:?}");

    // Second call without reset: must return InvalidOperation.
    let r2 = recover_at_boot(&pool, device_id, &materializer).await;
    match r2 {
        Err(AppError::InvalidOperation(msg)) => {
            assert!(
                msg.contains("L-103") && msg.contains("more than once"),
                "error must reference L-103 and the once-per-process contract; got {msg:?}",
            );
        }
        other => panic!("expected InvalidOperation, got {other:?}"),
    }

    materializer.shutdown();

    // Reset AFTER so this test does not perturb the global state for
    // any test that runs in the same process (under cargo test, not
    // nextest).
    super::boot::reset_recovery_guard();
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

    // 3 unflushed drafts (with block rows)
    for i in 0..3 {
        let bid = format!("unfl-{i}");
        insert_test_block(&pool, &bid, &format!("old-{i}")).await;
        save_draft(&pool, &bid, &format!("c-{i}")).await.unwrap();
    }

    // 2 already-flushed drafts (with block rows)
    for i in 0..2 {
        let bid = format!("fl-{i}");
        insert_test_block(&pool, &bid, "x").await;
        sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
            .bind(&bid)
            .bind("x")
            .bind(FAR_PAST)
            .execute(&pool)
            .await
            .unwrap();
        let op = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(&bid),
            to_text: "x".to_owned(),
            prev_edit: None,
        });
        append_local_op(&pool, device_id, op).await.unwrap();
    }

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

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

    let result = find_prev_edit(&pool, "nonexistent-block", "dev-1")
        .await
        .unwrap();
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
            block_id: BlockId::test_id(block_id),
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
            block_id: BlockId::test_id(block_id),
            to_text: "v2".to_owned(),
            prev_edit: Some((device_id.to_owned(), 1)),
        }),
    )
    .await
    .unwrap();

    let result = find_prev_edit(&pool, block_id, device_id).await.unwrap();

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

    // Insert a block + draft so the recovery loop has something to iterate.
    insert_test_block(&pool, "BLOCK000000000000000000001", "content").await;
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

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

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

// === 9. blocks.content consistency after recovery (F06) ===

#[tokio::test]
async fn recovery_updates_blocks_content_for_unflushed_draft() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-content-1";

    // Create a block with initial content
    insert_test_block(&pool, block_id, "old content").await;

    // Create an unflushed draft with new content (far-future timestamp
    // so it won't be classified as already-flushed).
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind("recovered content")
        .bind(FAR_FUTURE)
        .execute(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert_eq!(report.drafts_recovered, vec![block_id]);

    // F06: Verify blocks.content was updated to the draft's content
    let row: String = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = ?", block_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .unwrap_or_default();
    assert_eq!(
        row, "recovered content",
        "blocks.content must equal the recovered draft content, not the old value"
    );
}

#[tokio::test]
async fn recovery_updates_blocks_content_for_multiple_drafts() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    for i in 1..=3 {
        let bid = format!("block-multi-{i}");
        insert_test_block(&pool, &bid, &format!("old-{i}")).await;
        sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
            .bind(&bid)
            .bind(format!("new-{i}"))
            .bind(FAR_FUTURE)
            .execute(&pool)
            .await
            .unwrap();
    }

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();
    assert_eq!(report.drafts_recovered.len(), 3);

    for i in 1..=3 {
        let bid = format!("block-multi-{i}");
        let row: String = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = ?", bid)
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(
            row,
            format!("new-{i}"),
            "blocks.content for {bid} must be updated"
        );
    }
}

#[tokio::test]
async fn recovery_leaves_blocks_content_unchanged_for_already_flushed_draft() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-flushed-content";

    insert_test_block(&pool, block_id, "current content").await;

    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind("stale draft")
        .bind(FAR_PAST)
        .execute(&pool)
        .await
        .unwrap();

    let op = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id(block_id),
        to_text: "current content".to_owned(),
        prev_edit: None,
    });
    append_local_op(&pool, device_id, op).await.unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();
    assert_eq!(report.drafts_already_flushed, 1);

    let row: String = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = ?", block_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .unwrap_or_default();
    assert_eq!(
        row, "current content",
        "already-flushed drafts must not overwrite blocks.content"
    );
}

// === 10. Edge cases: soft-deleted and orphaned blocks (F07, F08, F12) ===

#[tokio::test]
async fn draft_for_soft_deleted_block_is_skipped_and_cleaned_up() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-soft-deleted";

    insert_test_block(&pool, block_id, "original").await;
    sqlx::query("UPDATE blocks SET deleted_at = '2024-01-01T00:00:00Z' WHERE id = ?")
        .bind(block_id)
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind("orphaned draft content")
        .bind(FAR_FUTURE)
        .execute(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert!(
        report.drafts_recovered.is_empty(),
        "draft for soft-deleted block must not be recovered"
    );
    let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
    assert!(
        drafts.is_empty(),
        "draft row must be deleted even for soft-deleted blocks"
    );

    let op_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(op_count, 0, "no synthetic op for soft-deleted block");
}

// `draft_for_nonexistent_block_is_skipped_and_cleaned_up` was deleted in
// M-93 / migration 0038 — the FK `block_drafts.block_id REFERENCES blocks(id)
// ON DELETE CASCADE` prevents any orphan-draft state from being staged.
// See note above `recovery_when_op_log_is_empty_draft_for_never_created_block`
// (deleted at the same time) for the full rationale.

// === 10b. Edge cases: parent chain validation (F08) ===

#[tokio::test]
async fn draft_with_deleted_parent_is_skipped() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Create parent block, then a child block parented to it
    insert_test_block(&pool, "PARENT01", "parent content").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', ?, ?, 0)",
    )
    .bind("CHILD01")
    .bind("child content")
    .bind("PARENT01")
    .execute(&pool)
    .await
    .unwrap();

    // Soft-delete the parent
    sqlx::query("UPDATE blocks SET deleted_at = '2024-01-01T00:00:00Z' WHERE id = ?")
        .bind("PARENT01")
        .execute(&pool)
        .await
        .unwrap();

    // Create an unflushed draft for the child
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("CHILD01")
        .bind("orphaned child draft")
        .bind(FAR_FUTURE)
        .execute(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert!(
        report.drafts_recovered.is_empty(),
        "draft for block with deleted parent must not be recovered"
    );
    let drafts = crate::draft::get_all_drafts(&pool).await.unwrap();
    assert!(
        drafts.is_empty(),
        "draft row must be deleted even when parent is deleted"
    );
}

#[tokio::test]
async fn draft_with_null_parent_is_recovered() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // insert_test_block creates a block with NULL parent_id
    insert_test_block(&pool, "ROOT01", "root content").await;

    // Create an unflushed draft (FAR_FUTURE ensures no matching op)
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("ROOT01")
        .bind("updated root content")
        .bind(FAR_FUTURE)
        .execute(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert_eq!(
        report.drafts_recovered.len(),
        1,
        "draft with NULL parent must be recovered"
    );
    assert!(
        report.drafts_recovered.contains(&"ROOT01".to_string()),
        "recovered draft must be for ROOT01"
    );
}

#[tokio::test]
async fn draft_with_valid_parent_is_recovered() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Create parent and child, parent is NOT deleted
    insert_test_block(&pool, "PARENT02", "parent content").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', ?, ?, 0)",
    )
    .bind("CHILD02")
    .bind("child content")
    .bind("PARENT02")
    .execute(&pool)
    .await
    .unwrap();

    // Create an unflushed draft for the child
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("CHILD02")
        .bind("updated child content")
        .bind(FAR_FUTURE)
        .execute(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert_eq!(
        report.drafts_recovered.len(),
        1,
        "draft with valid (non-deleted) parent must be recovered"
    );
    assert!(
        report.drafts_recovered.contains(&"CHILD02".to_string()),
        "recovered draft must be for CHILD02"
    );
}

// === 10c. #29: debug_assert on ULID format ===

#[tokio::test]
#[should_panic(expected = "block_id must be alphanumeric")]
async fn find_prev_edit_panics_on_like_wildcard_block_id() {
    let (pool, _dir) = test_pool().await;
    // Calling find_prev_edit with a LIKE wildcard should trigger the
    // debug_assert (active in test/debug builds).
    let _ = find_prev_edit(&pool, "block%id", "dev-1").await;
}

#[tokio::test]
async fn find_prev_edit_accepts_normal_ulid_block_id() {
    let (pool, _dir) = test_pool().await;
    // A normal alphanumeric ULID-like ID should not panic
    let result = find_prev_edit(&pool, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "dev-1").await;
    assert!(result.is_ok(), "normal ULID block_id should be accepted");
}

// === 11. find_prev_edit: DAG-based head resolution ===

/// When `get_block_edit_heads` returns empty but a `create_block` exists,
/// `find_prev_edit` falls back to the `create_block` as the edit chain root.
#[tokio::test]
async fn find_prev_edit_falls_back_to_create_block_when_no_edit_heads() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-create-only";

    // Only a create_block, no edit_block — get_block_edit_heads returns [].
    let create_record = append_local_op(
        &pool,
        device_id,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".to_owned(),
            parent_id: None,
            position: Some(0),
            content: "initial".to_owned(),
        }),
    )
    .await
    .unwrap();

    let result = find_prev_edit(&pool, block_id, device_id).await.unwrap();
    let (dev, seq) = result.expect("should fall back to create_block");
    assert_eq!(dev, device_id);
    assert_eq!(seq, create_record.seq);
}

/// Single `edit_block` head from one device — the DAG returns exactly one
/// head and `find_prev_edit` uses it directly.
#[tokio::test]
async fn find_prev_edit_returns_single_dag_head() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";
    let block_id = "block-single-head";

    // create_block (seq 1) + edit_block (seq 2) from same device.
    // get_block_edit_heads returns [(dev-1, 2)].
    append_local_op(
        &pool,
        device_id,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".to_owned(),
            parent_id: None,
            position: Some(0),
            content: "v1".to_owned(),
        }),
    )
    .await
    .unwrap();

    let edit_record = append_local_op(
        &pool,
        device_id,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(block_id),
            to_text: "v2".to_owned(),
            prev_edit: Some((device_id.to_owned(), 1)),
        }),
    )
    .await
    .unwrap();

    let result = find_prev_edit(&pool, block_id, device_id).await.unwrap();
    let (dev, seq) = result.expect("should return the single DAG head");
    assert_eq!(dev, device_id);
    assert_eq!(seq, edit_record.seq);
}

/// ## Multi-head DAG resolution
///
/// When multiple devices have divergent `edit_block` heads,
/// `find_prev_edit` prefers the **local** device's head for crash
/// recovery. This avoids clock-skew issues where the old
/// `ORDER BY created_at DESC` approach would pick whichever device
/// had the furthest-ahead clock.
///
/// The sync orchestrator (when built later in Phase 4) will handle
/// merging divergent heads across devices.
#[tokio::test]
async fn find_prev_edit_prefers_local_device_head_when_multiple_heads_exist() {
    let (pool, _dir) = test_pool().await;
    let dev_a = "device-A";
    let dev_b = "device-B";
    let block_id = "block-multi-dev";

    // Create the block row (needed so the block_id exists)
    insert_test_block(&pool, block_id, "initial").await;

    // Device A: create_block at T=12:00 (earliest)
    append_local_op_at(
        &pool,
        dev_a,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".to_owned(),
            parent_id: None,
            position: Some(0),
            content: "initial".to_owned(),
        }),
        "2025-01-15T12:00:00Z".to_owned(),
    )
    .await
    .unwrap();

    // Device A: edit_block at T=12:01
    let a_edit = append_local_op_at(
        &pool,
        dev_a,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(block_id),
            to_text: "edit from A".to_owned(),
            prev_edit: Some((dev_a.to_owned(), 1)),
        }),
        "2025-01-15T12:01:00Z".to_owned(),
    )
    .await
    .unwrap();

    // Device B: edit_block at T=12:02 (later timestamp, but DAG resolution
    // should prefer local device, not latest timestamp)
    let b_edit = append_local_op_at(
        &pool,
        dev_b,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(block_id),
            to_text: "edit from B".to_owned(),
            prev_edit: Some((dev_a.to_owned(), 1)),
        }),
        "2025-01-15T12:02:00Z".to_owned(),
    )
    .await
    .unwrap();

    // When local device is device-A, should prefer A's head
    let result = find_prev_edit(&pool, block_id, dev_a).await.unwrap();
    let (dev, seq) = result.expect("should find a prev_edit");
    assert_eq!(
        dev, dev_a,
        "should prefer local device A's head, not B's (despite B having later timestamp)"
    );
    assert_eq!(seq, a_edit.seq, "should return device A's edit seq");

    // When local device is device-B, should prefer B's head
    let result = find_prev_edit(&pool, block_id, dev_b).await.unwrap();
    let (dev, seq) = result.expect("should find a prev_edit");
    assert_eq!(
        dev, dev_b,
        "should prefer local device B's head when B is the local device"
    );
    assert_eq!(seq, b_edit.seq, "should return device B's edit seq");
}

// === BUG-23: cache refresh after draft recovery ===

/// Regression test for BUG-23: after `recover_at_boot` rewrites a block's
/// `content` via a synthetic edit_block op, the FTS index still holds the
/// pre-recovery text (because the materializer isn't created yet when
/// recovery runs). `refresh_caches_for_recovered_drafts` must update the
/// FTS entries for every recovered block and block until the background
/// queue drains, so callers never observe the stale text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_caches_for_recovered_drafts_updates_fts_for_recovered_blocks() {
    use super::refresh_caches_for_recovered_drafts;
    use crate::materializer::Materializer;
    use crate::pagination::PageRequest;

    let (pool, _dir) = test_pool().await;
    let device_id = "test-device";
    let block_id = "BLOCK000000000000000000023";

    // Seed: block exists with the original content already indexed by FTS
    // (simulating a real device where recent ops were indexed before the
    // crash).
    insert_test_block(&pool, block_id, "original pre-crash text").await;
    crate::fts::update_fts_for_block(&pool, block_id)
        .await
        .unwrap();

    // User typed a draft that never flushed (distinctive marker word the
    // post-recovery FTS must contain and the pre-recovery index must not).
    save_draft(&pool, block_id, "draft pineapple content")
        .await
        .unwrap();

    // Sanity: pre-recovery the new marker is not in the index.
    let page = PageRequest::new(None, Some(10)).unwrap();
    let stale_hits = crate::fts::search_fts(&pool, "pineapple", &page, None, None, None)
        .await
        .unwrap();
    assert_eq!(
        stale_hits.items.len(),
        0,
        "pre-recovery FTS must not contain the draft marker yet",
    );

    // Run recovery — appends synthetic edit_block, updates blocks.content,
    // but (by design, see F04 note in draft_recovery.rs) does NOT update
    // FTS. So at this point the FTS index is stale.
    let report = recover_at_boot_test(&pool, device_id).await.unwrap();
    assert_eq!(
        report.drafts_recovered,
        vec![block_id.to_owned()],
        "draft should have been recovered",
    );

    // Confirm the stale window exists before the fix kicks in.
    let stale_after_recovery = crate::fts::search_fts(&pool, "pineapple", &page, None, None, None)
        .await
        .unwrap();
    assert_eq!(
        stale_after_recovery.items.len(),
        0,
        "without cache refresh, FTS still reflects pre-recovery content",
    );

    // The fix: create the materializer and refresh caches for the
    // recovered blocks. When this returns, the FTS index must be current.
    let materializer = Materializer::new(pool.clone());
    refresh_caches_for_recovered_drafts(&pool, &materializer, &report.drafts_recovered)
        .await
        .unwrap();

    let fresh_hits = crate::fts::search_fts(&pool, "pineapple", &page, None, None, None)
        .await
        .unwrap();
    assert_eq!(
        fresh_hits.items.len(),
        1,
        "after refresh_caches_for_recovered_drafts, FTS must contain the recovered draft content \
         (no stale-cache window)",
    );
    assert_eq!(
        fresh_hits.items[0].id, block_id,
        "FTS hit should point at the recovered block",
    );
}

/// `refresh_caches_for_recovered_drafts` on an empty list must be a
/// cheap no-op — it must not block waiting on a barrier the materializer
/// never processes (which would deadlock boot when no drafts were
/// recovered, the common case).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_caches_for_recovered_drafts_is_noop_when_list_empty() {
    use super::refresh_caches_for_recovered_drafts;
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    refresh_caches_for_recovered_drafts(&pool, &materializer, &[])
        .await
        .expect("no-op must not error");
}

// === I-Lifecycle-5: gate tag/page rebuilds on actual block_type ===
//
// `refresh_caches_for_recovered_drafts` previously enqueued
// `RebuildTagsCache + RebuildPagesCache` on every non-empty recovery batch,
// even when no recovered draft touched a `tag` or `page` block. That wastes
// boot-time cycles on a full O(N) scan of `blocks` for the common case
// where the user was editing content blocks. The fix gates the rebuilds on
// a single `json_each` SQL query that checks whether any recovered ID is
// actually a tag/page block.
//
// These tests pin the per-batch background-task counts via `bg_processed`
// (each `flush_background()` adds exactly one barrier task to the count).

/// Helper: insert a block of the given type for use in I-Lifecycle-5
/// tests. Mirrors `insert_test_block` but takes a `block_type`.
async fn insert_typed_test_block(
    pool: &SqlitePool,
    block_id: &str,
    block_type: &str,
    content: &str,
) {
    sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, 0)")
        .bind(block_id)
        .bind(block_type)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_refresh_skips_rebuilds_for_content_only_recovery_i_lifecycle_5() {
    use super::refresh_caches_for_recovered_drafts;
    use crate::materializer::Materializer;
    use std::sync::atomic::Ordering as AtomicOrdering;

    let (pool, _dir) = test_pool().await;
    let block_id = "BLOCK000000000000000000IL5C";

    // A content-only block with an unflushed draft.
    insert_typed_test_block(&pool, block_id, "content", "old content").await;
    save_draft(&pool, block_id, "draft content").await.unwrap();

    let report = recover_at_boot_test(&pool, "dev-1").await.unwrap();
    assert_eq!(report.drafts_recovered, vec![block_id.to_owned()]);

    let materializer = Materializer::new(pool.clone());
    refresh_caches_for_recovered_drafts(&pool, &materializer, &report.drafts_recovered)
        .await
        .unwrap();

    // Per-draft we always enqueue UpdateFtsBlock + ReindexBlockLinks (= 2
    // tasks). The flush barrier adds 1 more. With the I-Lifecycle-5 gate
    // tripping, RebuildTagsCache + RebuildPagesCache must NOT have been
    // enqueued, so the total processed is exactly 3 — not 5.
    let processed = materializer
        .metrics()
        .bg_processed
        .load(AtomicOrdering::Relaxed);
    assert_eq!(
        processed, 3,
        "content-only recovery must not enqueue RebuildTagsCache or RebuildPagesCache; \
         expected 2 per-block tasks + 1 barrier = 3, got {processed}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_refresh_enqueues_rebuilds_when_tag_block_recovered_i_lifecycle_5() {
    use super::refresh_caches_for_recovered_drafts;
    use crate::materializer::Materializer;
    use std::sync::atomic::Ordering as AtomicOrdering;

    let (pool, _dir) = test_pool().await;
    let tag_block_id = "BLOCK000000000000000000IL5T";

    // A tag block with an unflushed draft (e.g. user renamed the tag and
    // the app crashed before the edit_block flushed).
    insert_typed_test_block(&pool, tag_block_id, "tag", "old-tag-name").await;
    save_draft(&pool, tag_block_id, "renamed-tag")
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, "dev-1").await.unwrap();
    assert_eq!(report.drafts_recovered, vec![tag_block_id.to_owned()]);

    let materializer = Materializer::new(pool.clone());
    refresh_caches_for_recovered_drafts(&pool, &materializer, &report.drafts_recovered)
        .await
        .unwrap();

    // Expected: UpdateFtsBlock + ReindexBlockLinks + RebuildTagsCache +
    // RebuildPagesCache + 1 barrier = 5.
    let processed = materializer
        .metrics()
        .bg_processed
        .load(AtomicOrdering::Relaxed);
    assert_eq!(
        processed, 5,
        "tag-block recovery must enqueue both RebuildTagsCache and RebuildPagesCache; \
         expected 2 per-block tasks + 2 rebuilds + 1 barrier = 5, got {processed}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_refresh_enqueues_rebuilds_when_page_block_recovered_i_lifecycle_5() {
    use super::refresh_caches_for_recovered_drafts;
    use crate::materializer::Materializer;
    use std::sync::atomic::Ordering as AtomicOrdering;

    let (pool, _dir) = test_pool().await;
    let page_block_id = "BLOCK000000000000000000IL5P";

    // A page block with an unflushed draft (e.g. user renamed the page
    // and the app crashed before the edit_block flushed).
    insert_typed_test_block(&pool, page_block_id, "page", "Old Page Title").await;
    save_draft(&pool, page_block_id, "Renamed Page Title")
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, "dev-1").await.unwrap();
    assert_eq!(report.drafts_recovered, vec![page_block_id.to_owned()]);

    let materializer = Materializer::new(pool.clone());
    refresh_caches_for_recovered_drafts(&pool, &materializer, &report.drafts_recovered)
        .await
        .unwrap();

    // Expected: UpdateFtsBlock + ReindexBlockLinks + RebuildTagsCache +
    // RebuildPagesCache + 1 barrier = 5.
    let processed = materializer
        .metrics()
        .bg_processed
        .load(AtomicOrdering::Relaxed);
    assert_eq!(
        processed, 5,
        "page-block recovery must enqueue both RebuildTagsCache and RebuildPagesCache; \
         expected 2 per-block tasks + 2 rebuilds + 1 barrier = 5, got {processed}",
    );
}

// ============================================================================
// PERF-26: op_log.block_id indexed column regression tests
// ============================================================================

/// After migration 0030, every local op appended via `append_local_op` must
/// populate the `block_id` column (except for `delete_attachment`, which
/// has no block_id). The draft-recovery query paths depend on this.
#[tokio::test]
async fn perf26_local_append_populates_block_id_column() {
    let (pool, _dir) = test_pool().await;

    let bid = BlockId::test_id("BLKPERF26A");
    let op = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: bid.clone(),
        block_type: "content".into(),
        parent_id: None,
        position: Some(1),
        content: "hello".into(),
    });
    append_local_op(&pool, "dev-perf26", op).await.unwrap();

    // Read the indexed column directly.
    let row: Option<String> = sqlx::query_scalar(
        "SELECT block_id FROM op_log WHERE device_id = 'dev-perf26' AND seq = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        row.as_deref(),
        Some(bid.as_str()),
        "block_id column must match the typed payload's block_id"
    );
}

/// The `delete_attachment` op targets an attachment_id only; its payload has
/// no `block_id` field. The indexed column must be NULL for that variant so
/// block-scoped queries don't accidentally match it.
#[tokio::test]
async fn perf26_delete_attachment_stores_null_block_id() {
    use crate::op::{AddAttachmentPayload, DeleteAttachmentPayload};

    let (pool, _dir) = test_pool().await;
    let bid = BlockId::test_id("BLKPERF26B");

    // Need a block for the AddAttachment to reference.
    insert_test_block(&pool, bid.as_str(), "x").await;

    // Append AddAttachment (has block_id) then DeleteAttachment (no block_id).
    append_local_op(
        &pool,
        "dev-perf26b",
        OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: BlockId::test_id("ATT-1"),
            block_id: bid.clone(),
            mime_type: "text/plain".into(),
            filename: "x.txt".into(),
            size_bytes: 1,
            fs_path: "/tmp/x.txt".into(),
        }),
    )
    .await
    .unwrap();
    append_local_op(
        &pool,
        "dev-perf26b",
        OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: BlockId::test_id("ATT-1"),
            fs_path: "/tmp/x.txt".into(),
        }),
    )
    .await
    .unwrap();

    let add_bid: Option<String> = sqlx::query_scalar(
        "SELECT block_id FROM op_log WHERE device_id = 'dev-perf26b' AND op_type = 'add_attachment'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let del_bid: Option<String> = sqlx::query_scalar(
        "SELECT block_id FROM op_log WHERE device_id = 'dev-perf26b' AND op_type = 'delete_attachment'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        add_bid.as_deref(),
        Some(bid.as_str()),
        "AddAttachment stores block_id"
    );
    assert!(
        del_bid.is_none(),
        "DeleteAttachment must store NULL block_id"
    );
}

/// Draft recovery must correctly filter by block_id using the indexed
/// column and only find ops for the target block — not ops for other
/// blocks that happen to have overlapping prefixes in their JSON payload.
#[tokio::test]
async fn perf26_draft_recovery_filters_to_target_block_only() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-perf26c";

    // Three blocks; only one has a draft.
    let target = BlockId::test_id("BLKTARGET26");
    let other_a = BlockId::test_id("BLKOTHER26A");
    let other_b = BlockId::test_id("BLKOTHER26B");

    for bid in [&target, &other_a, &other_b] {
        insert_test_block(&pool, bid.as_str(), "seed").await;
    }

    // Append several ops across different block_ids, all with created_at in
    // the far past so they would NOT satisfy `created_at > draft.updated_at`.
    for bid in [&other_a, &other_b, &target] {
        let op = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: bid.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "initial".into(),
        });
        append_local_op_at(&pool, device_id, op, FAR_PAST.into())
            .await
            .unwrap();
    }

    // Append a recent edit_block for `other_a` (NOT the target). If the
    // block_id filter is wrong, draft recovery would see this and classify
    // the target's draft as "already flushed".
    let recent_op = OpPayload::EditBlock(EditBlockPayload {
        block_id: other_a.clone(),
        to_text: "new".into(),
        prev_edit: None,
    });
    append_local_op_at(&pool, device_id, recent_op, FAR_FUTURE.into())
        .await
        .unwrap();

    // Create a draft for the TARGET block with updated_at between FAR_PAST
    // and FAR_FUTURE — so if filtering were broken we'd see other_a's
    // FAR_FUTURE edit and wrongly consider target's draft already flushed.
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(target.as_str())
        .bind("recovered text")
        .bind("2024-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    // Correct behavior: target draft is NOT flushed (no recent op for
    // target) → it gets recovered. If block_id filter were missing or
    // wrong, the FAR_FUTURE edit on other_a would leak into target's
    // flush check and the draft would be classified as already flushed.
    assert_eq!(
        report.drafts_recovered,
        vec![target.as_str().to_owned()],
        "target draft must be recovered; block_id filter must not leak \
         FAR_FUTURE edit from other_a"
    );
    assert_eq!(report.drafts_already_flushed, 0);
}

/// Scale test: 10K ops spread across 10 block_ids plus one target block.
/// Draft recovery for the target must complete quickly and return the
/// correct result — verifying the idx_op_log_block_id index is used.
///
/// No wall-clock assertion (flaky on loaded CI); instead we rely on the
/// test timing out at the harness default (~60s) if the scan degrades
/// to a full-table JSON parse.
#[tokio::test]
async fn perf26_draft_recovery_at_10k_ops_is_fast() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-perf26scale";

    // Seed the target block + one draft.
    let target = BlockId::test_id("BLKSCALE26");
    insert_test_block(&pool, target.as_str(), "seed").await;
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(target.as_str())
        .bind("scale recovery text")
        .bind("2024-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();

    // Generate 10 distinct block_ids (none equal to target) and 1000 ops
    // per block = 10K ops total. All ops land in the far past so none
    // satisfy `created_at > draft.updated_at`.
    let mut noise_bids = Vec::with_capacity(10);
    for i in 0..10 {
        let bid = BlockId::test_id(&format!("BLKNOISE26{i:02}"));
        insert_test_block(&pool, bid.as_str(), "n").await;
        noise_bids.push(bid);
    }

    let start = std::time::Instant::now();
    // Wrap the 10K inserts in a single BEGIN IMMEDIATE transaction. The
    // per-op `append_local_op_at` variant commits each insert separately,
    // forcing 10K fsyncs and dominating the test wall-clock (~30s). Using
    // the `_in_tx` variant inside one transaction reduces setup to ~1s
    // while still exercising the same `append_local_op_in_tx` code path
    // that production uses for atomic multi-op sequences.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    for bid in &noise_bids {
        crate::op_log::append_local_op_in_tx(
            &mut tx,
            device_id,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: bid.clone(),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                content: "n".into(),
            }),
            FAR_PAST.into(),
        )
        .await
        .unwrap();
        for _ in 0..999 {
            crate::op_log::append_local_op_in_tx(
                &mut tx,
                device_id,
                OpPayload::EditBlock(EditBlockPayload {
                    block_id: bid.clone(),
                    to_text: "n".into(),
                    prev_edit: None,
                }),
                FAR_PAST.into(),
            )
            .await
            .unwrap();
        }
    }
    tx.commit().await.unwrap();
    let insert_elapsed = start.elapsed();

    // Sanity: op_log has ~10K rows.
    let total_ops: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        total_ops, 10_000,
        "expected exactly 10K seeded ops, got {total_ops}"
    );

    // Run draft recovery. Without the indexed block_id column this would
    // json_extract across 10K rows per draft lookup.
    let recover_start = std::time::Instant::now();
    let report = recover_at_boot_test(&pool, device_id).await.unwrap();
    let recover_elapsed = recover_start.elapsed();

    assert_eq!(
        report.drafts_recovered,
        vec![target.as_str().to_owned()],
        "target draft must be recovered correctly at 10K scale"
    );
    eprintln!(
        "perf26_draft_recovery_at_10k_ops_is_fast: \
         inserted 10K ops in {insert_elapsed:?}, recovered in {recover_elapsed:?}"
    );
}

/// Confirms that the `idx_op_log_block_id` index is present after migrations
/// — guards against accidental migration-ordering regressions.
#[tokio::test]
async fn perf26_block_id_index_exists() {
    let (pool, _dir) = test_pool().await;

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master \
         WHERE type = 'index' AND name = 'idx_op_log_block_id'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        count, 1,
        "migration 0030 must create idx_op_log_block_id exactly once"
    );
}

/// L-104: SQLite caps bind parameters at `MAX_SQL_PARAMS` (999). A multi-
/// thousand-block paste crash can leave > 999 rows in `block_drafts`; the
/// boot-recovery batch query must chunk the IN clause or it fails with
/// "too many SQL variables". This test seeds ~1100 drafts and asserts
/// `recover_at_boot` returns Ok and processes every draft.
///
/// M-93 / migration 0038 added a FK from `block_drafts.block_id` to
/// `blocks(id) ON DELETE CASCADE`, so each draft now needs a real
/// parent block — the historical "no `blocks` rows so everything lands
/// in the F07 already-flushed bucket" shape can't be staged anymore.
/// The drafts are unflushed (FAR_FUTURE timestamps would over-complicate
/// per-draft recovery), so they end up in the recovered bucket; the
/// chunking guarantee under test is unchanged.
#[tokio::test]
async fn recover_at_boot_handles_more_than_999_drafts() {
    let (pool, _dir) = test_pool().await;

    const N: usize = 1100;
    for i in 0..N {
        // Use a wide block_id namespace so chunk boundaries (999, 998 per
        // chunk depending on MAX_SQL_PARAMS - 1) don't collide.
        let bid = format!("blk-{i:05}");
        insert_test_block(&pool, &bid, "x").await;
        save_draft(&pool, &bid, "x").await.unwrap();
    }

    // Sanity: all rows landed.
    let seeded: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(seeded, N as i64);

    let report = recover_at_boot_test(&pool, "dev-1").await.unwrap();

    // What matters is that the batch IN-clause query did not blow up
    // with SQLITE_TOOBIG. Whether each draft lands in the "recovered"
    // or "already_flushed" bucket depends on op_log content; the sum
    // of the two must equal N.
    assert!(
        report.draft_errors.is_empty(),
        "no per-draft errors expected, got: {:?}",
        report.draft_errors,
    );
    assert_eq!(
        report.drafts_recovered.len() as u64 + report.drafts_already_flushed,
        N as u64,
        "every seeded draft must be accounted for",
    );

    // Drafts are deleted regardless of bucket — confirm cleanup.
    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "all drafts must be cleaned up");
}

// =====================================================================
// C-2b — boot-time op-log replay path for unmaterialized ops
// =====================================================================
//
// These tests cover three layers:
//
//  1. The cursor advance happens atomically with the apply
//     (`advance_apply_cursor` is called inside the same tx as
//     `apply_op_tx`).
//  2. The `replay_unmaterialized_ops` walk re-enqueues every op past
//     the cursor and the cursor moves to the highest applied seq.
//  3. The full `recover_at_boot` path includes replay + draft recovery
//     in the right order.

use crate::materializer::MaterializeTask;
use crate::op_log::OpRecord;
use crate::recovery::replay::replay_unmaterialized_ops;
use std::sync::Arc as StdArc;

/// Read the cursor's `materialized_through_seq` for assertions.
async fn read_cursor(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar!(
        r#"SELECT materialized_through_seq as "seq!: i64" FROM materializer_apply_cursor WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Force-set the cursor to a specific value (test-only helper).
async fn set_cursor(pool: &SqlitePool, seq: i64) {
    let now = crate::now_rfc3339();
    sqlx::query!(
        "UPDATE materializer_apply_cursor SET materialized_through_seq = ?, updated_at = ? WHERE id = 1",
        seq,
        now,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// C-2b — single-op apply: cursor goes from 0 to record.seq.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_advances_cursor_atomic_c2b() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Append the op WITHOUT materialising — the materializer foreground
    // queue is the only path that should advance the cursor.
    let record = append_local_op(
        &pool,
        "dev-c2b",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("CURSOR_BLK_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "cursor-test".into(),
        }),
    )
    .await
    .unwrap();

    assert_eq!(read_cursor(&pool).await, 0, "cursor starts at 0");

    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(record.clone())))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();

    assert_eq!(
        read_cursor(&pool).await,
        record.seq,
        "single apply must advance cursor to record.seq",
    );
    mat.shutdown();
}

/// C-2b — batch apply: cursor advances to the highest seq in the batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_advances_cursor_to_max_c2b() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let mut records = Vec::new();
    for i in 1..=5 {
        let r = append_local_op(
            &pool,
            "dev-c2b-batch",
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id(&format!("BATCH_BLK_{i}")),
                block_type: "content".into(),
                parent_id: None,
                position: Some(i),
                content: format!("batch-{i}"),
            }),
        )
        .await
        .unwrap();
        records.push(r);
    }
    let max_seq = records.iter().map(|r| r.seq).max().unwrap();
    assert_eq!(max_seq, 5, "5 sequential appends produce seqs 1..=5");
    assert_eq!(read_cursor(&pool).await, 0, "cursor starts at 0");

    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(records)))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();

    assert_eq!(
        read_cursor(&pool).await,
        max_seq,
        "batch apply must advance cursor to max(seq) in the batch",
    );
    mat.shutdown();
}

/// C-2b — a batch where one op fails rolls back the cursor advance.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_with_failure_does_not_advance_cursor_c2b() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Pre-set the cursor to a known sentinel so we can detect any
    // accidental advance even on a partial-rollback path.
    set_cursor(&pool, 7).await;

    // Two real ops, then a malformed third op: the third's `apply_op_tx`
    // returns `Err` because `serde_json::from_str::<CreateBlockPayload>`
    // fails on `{}` (missing required fields). The whole batch is rolled
    // back, including the cursor advance for the prior two ops.
    let ok1 = append_local_op(
        &pool,
        "dev-c2b-fail",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("FAIL_BLK_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "ok1".into(),
        }),
    )
    .await
    .unwrap();
    let ok2 = append_local_op(
        &pool,
        "dev-c2b-fail",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("FAIL_BLK_2"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(2),
            content: "ok2".into(),
        }),
    )
    .await
    .unwrap();
    let bad = OpRecord {
        device_id: "dev-c2b-fail".into(),
        seq: 100,
        parent_seqs: None,
        hash: "0000000000000000000000000000000000000000000000000000000000000000".into(),
        op_type: "create_block".into(),
        payload: "{}".into(),
        created_at: "2026-04-30T00:00:00Z".into(),
        block_id: None,
    };

    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(vec![
        ok1, ok2, bad,
    ])))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();

    assert_eq!(
        read_cursor(&pool).await,
        7,
        "failed batch must NOT advance the cursor (tx rolled back)",
    );
    mat.shutdown();
}

/// C-2b — replay walks every op past the cursor and applies each one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_walks_unmaterialized_ops_c2b() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let device_id = "dev-c2b-replay";

    // Seed 10 CreateBlock ops in op_log with no primary-state apply.
    for i in 1..=10 {
        append_local_op(
            &pool,
            device_id,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id(&format!("REPLAY_BLK_{i:02}")),
                block_type: "content".into(),
                parent_id: None,
                position: Some(i),
                content: format!("replay-{i}"),
            }),
        )
        .await
        .unwrap();
    }
    set_cursor(&pool, 5).await;

    let report = replay_unmaterialized_ops(&pool, &mat).await.unwrap();

    assert_eq!(
        report.ops_replayed, 5,
        "exactly seqs 6..=10 should have been re-enqueued",
    );
    assert!(
        report.replay_errors.is_empty(),
        "replay should have no errors: {:?}",
        report.replay_errors,
    );
    assert_eq!(
        read_cursor(&pool).await,
        10,
        "cursor must advance to the highest applied seq",
    );
    // State sanity: blocks 6..=10 must exist (5 ops were applied).
    // Blocks 1..=5 weren't enqueued for replay so they are absent.
    let visible: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(visible, 5, "blocks 6..=10 should be materialised");
    mat.shutdown();
}

/// C-2b — running replay twice in succession is idempotent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_is_idempotent_c2b() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let device_id = "dev-c2b-idem";

    // Seed 3 ops, then run replay twice; the second run is a no-op.
    for i in 1..=3 {
        append_local_op(
            &pool,
            device_id,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id(&format!("IDEM_BLK_{i}")),
                block_type: "content".into(),
                parent_id: None,
                position: Some(i),
                content: format!("idem-{i}"),
            }),
        )
        .await
        .unwrap();
    }

    let r1 = replay_unmaterialized_ops(&pool, &mat).await.unwrap();
    assert_eq!(r1.ops_replayed, 3, "first replay applies 3 ops");
    assert_eq!(read_cursor(&pool).await, 3);

    let r2 = replay_unmaterialized_ops(&pool, &mat).await.unwrap();
    assert_eq!(
        r2.ops_replayed, 0,
        "second replay should re-enqueue nothing — cursor already at max",
    );
    assert_eq!(
        read_cursor(&pool).await,
        3,
        "cursor must be unchanged across a second idempotent replay",
    );
    mat.shutdown();
}

/// C-2b — replay against a fresh DB (no ops past the cursor) is a no-op.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_empty_op_log_is_noop_c2b() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let report = replay_unmaterialized_ops(&pool, &mat).await.unwrap();

    assert_eq!(report.ops_replayed, 0, "empty op_log → no replay");
    assert!(report.replay_errors.is_empty());
    assert_eq!(read_cursor(&pool).await, 0, "cursor stays at initial 0");
    mat.shutdown();
}

/// C-2b — `recover_at_boot` runs replay (step 1.5) before draft
/// recovery (step 2). After the call, replayed ops are applied AND the
/// draft recovery has run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recover_at_boot_includes_replay_step_c2b() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-c2b-boot";

    // Seed 5 unmaterialized create_block ops.
    let mut block_ids: Vec<String> = Vec::new();
    for i in 1..=5 {
        let bid = format!("BOOT_BLK_{i}");
        append_local_op(
            &pool,
            device_id,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id(&bid),
                block_type: "content".into(),
                parent_id: None,
                position: Some(i),
                content: format!("boot-{i}"),
            }),
        )
        .await
        .unwrap();
        block_ids.push(bid);
    }

    // Add a draft for a block that exists in `blocks` (we must insert
    // it manually because replay applies via the materializer queue,
    // and the draft path requires the row to exist before flushing).
    // The id must be alphanumeric per the draft-recovery debug_assert.
    let draft_block_id = "BOOTDRAFTBLK";
    insert_test_block(&pool, draft_block_id, "old draft target").await;
    save_draft(&pool, draft_block_id, "draft content")
        .await
        .unwrap();

    let report = recover_at_boot_test(&pool, device_id).await.unwrap();

    assert_eq!(
        report.ops_replayed, 5,
        "all 5 seeded ops should be replayed",
    );
    assert!(
        report.replay_errors.is_empty(),
        "replay must not error: {:?}",
        report.replay_errors,
    );
    assert_eq!(
        report.drafts_recovered,
        vec![draft_block_id.to_string()],
        "draft recovery still runs after replay",
    );

    // Blocks created by the replayed ops must be visible.
    for bid in &block_ids {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM blocks WHERE id = ?")
            .bind(bid)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(exists.is_some(), "replayed block {bid} must exist");
    }
    assert_eq!(
        read_cursor(&pool).await,
        5,
        "cursor must advance to highest replayed seq",
    );
}

/// C-2b — a "second crash" mid-replay must not double-apply ops on the
/// next boot. Simulated by running replay, dropping the materializer,
/// then running replay again on the same DB.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_progress_marker_survives_second_crash_c2b() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-c2b-crash";

    for i in 1..=10 {
        append_local_op(
            &pool,
            device_id,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id(&format!("CRASH_BLK_{i:02}")),
                block_type: "content".into(),
                parent_id: None,
                position: Some(i),
                content: format!("crash-{i}"),
            }),
        )
        .await
        .unwrap();
    }

    // First "boot": run replay, then simulate a crash by shutting
    // down + dropping the materializer.
    {
        let mat = Materializer::new(pool.clone());
        let r = replay_unmaterialized_ops(&pool, &mat).await.unwrap();
        assert_eq!(r.ops_replayed, 10);
        assert_eq!(read_cursor(&pool).await, 10);
        mat.shutdown();
    }

    let blocks_first: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(blocks_first, 10);

    // Second "boot": fresh materializer, fresh replay invocation. The
    // cursor was persisted to disk so this run sees zero work.
    {
        let mat = Materializer::new(pool.clone());
        let r = replay_unmaterialized_ops(&pool, &mat).await.unwrap();
        assert_eq!(
            r.ops_replayed, 0,
            "cursor at 10 means second-boot replay is a no-op",
        );
        assert_eq!(
            read_cursor(&pool).await,
            10,
            "cursor preserved across boots"
        );
        mat.shutdown();
    }

    let blocks_second: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blocks_second, blocks_first,
        "no double-apply: block count must be unchanged across the second replay",
    );
}
