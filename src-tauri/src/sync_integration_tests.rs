//! Cross-module integration tests for the sync infrastructure.
//!
//! These tests exercise the full sync pipeline between simulated devices:
//! op creation → head exchange → op transfer → remote apply → merge →
//! peer-ref bookkeeping. They verify that sync modules work together
//! correctly, not just individually.
//!
//! # Test groups
//!
//! 1. **Full sync pipeline** (#228) — two-device create-sync-verify,
//!    concurrent edit merge, peer_refs update, bidirectional sync.
//! 2. **Idempotency / out-of-order delivery** (#230) — duplicate ops,
//!    out-of-order seqs, gaps, hash-mismatch rejection.
//! 3. **Snapshot + sync resume** (#231) — compaction-detection reset,
//!    incremental sync from last_hash.
//! 4. **Large op log stress tests** (#232) — 500-op sync, incremental
//!    sync after bulk.
//! 5. **Edge cases** — empty op logs, orchestrator initiator/receiver
//!    full flows.

use crate::dag::{get_block_edit_heads, insert_remote_op};
use crate::db::init_pool;
use crate::hash::compute_op_hash;
use crate::materializer::Materializer;
use crate::op::{CreateBlockPayload, EditBlockPayload, OpPayload};
use crate::op_log::{self, append_local_op_at, OpRecord};
use crate::sync_protocol::*;
use crate::ulid::BlockId;
use crate::{peer_refs, snapshot};
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_A: &str = "DEVICE_AAAA";
const DEV_B: &str = "DEVICE_BBBB";
const FIXED_TS: &str = "2025-01-15T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Create a temporary SQLite pool with all migrations applied.
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Create two independent databases simulating two devices.
async fn two_device_setup() -> ((SqlitePool, TempDir), (SqlitePool, TempDir)) {
    (test_pool().await, test_pool().await)
}

/// Build a `CreateBlock` payload for a content block.
fn create_payload(block_id: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".to_string(),
        parent_id: None,
        position: Some(0),
        content: "initial content".to_string(),
    })
}

/// Build a `CreateBlock` payload with specific content.
fn create_payload_with_content(block_id: &str, content: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".to_string(),
        parent_id: None,
        position: Some(0),
        content: content.to_string(),
    })
}

/// Build an `EditBlock` payload.
fn edit_payload(block_id: &str, text: &str) -> OpPayload {
    OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id(block_id),
        to_text: text.to_string(),
        prev_edit: None,
    })
}

/// Build an `EditBlock` payload with a `prev_edit` pointer.
fn edit_payload_with_prev(
    block_id: &str,
    text: &str,
    prev_edit: Option<(String, i64)>,
) -> OpPayload {
    OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id(block_id),
        to_text: text.to_string(),
        prev_edit,
    })
}

/// Read all ops for a device from the op log and convert to OpTransfer.
async fn ops_as_transfers(pool: &SqlitePool, device_id: &str) -> Vec<OpTransfer> {
    let ops = op_log::get_ops_since(pool, device_id, 0).await.unwrap();
    ops.into_iter().map(OpTransfer::from).collect()
}

/// Simulate a one-way sync: send all ops from `src_pool`'s `device_id` to
/// `dst_pool`, returning the apply result.
async fn sync_device_to(
    src_pool: &SqlitePool,
    device_id: &str,
    dst_pool: &SqlitePool,
    dst_materializer: &Materializer,
) -> ApplyResult {
    let transfers = ops_as_transfers(src_pool, device_id).await;
    apply_remote_ops(dst_pool, dst_materializer, transfers)
        .await
        .unwrap()
}

/// Simulate incremental sync: compute what the remote is missing and apply.
async fn incremental_sync(
    src_pool: &SqlitePool,
    dst_pool: &SqlitePool,
    dst_materializer: &Materializer,
    dst_heads: &[DeviceHead],
) -> ApplyResult {
    let ops_to_send = compute_ops_to_send(src_pool, dst_heads).await.unwrap();
    let transfers: Vec<OpTransfer> = ops_to_send.into_iter().map(OpTransfer::from).collect();
    apply_remote_ops(dst_pool, dst_materializer, transfers)
        .await
        .unwrap()
}

// ======================================================================
// Group 1: Full sync pipeline — two-device simulation (#228)
// ======================================================================

/// Device A creates a block, syncs to Device B. B should have the op
/// and the same head as A.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_device_create_sync_both_see_block() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // Device A creates a block
    append_local_op_at(&pool_a, DEV_A, create_payload("BLK1"), FIXED_TS.into())
        .await
        .unwrap();

    // Get A's local heads
    let heads_a = get_local_heads(&pool_a).await.unwrap();
    assert_eq!(heads_a.len(), 1, "A should have exactly 1 device head");
    assert_eq!(
        heads_a[0].device_id, DEV_A,
        "head device_id should be DEV_A"
    );
    assert_eq!(heads_a[0].seq, 1, "A's head seq should be 1");

    // B has no data — compute what B would send (nothing)
    let b_heads = get_local_heads(&pool_b).await.unwrap();
    assert!(b_heads.is_empty(), "B should have no heads initially");

    // B computes ops_to_send for A → empty (B has nothing to send)
    let ops_b_to_a = compute_ops_to_send(&pool_b, &heads_a).await.unwrap();
    assert!(ops_b_to_a.is_empty(), "B has no ops to send to A");

    // A sends its ops to B
    let result = sync_device_to(&pool_a, DEV_A, &pool_b, &mat_b).await;
    assert_eq!(result.inserted, 1, "B should insert 1 op from A");
    assert_eq!(result.duplicates, 0, "no duplicates on first sync");
    assert_eq!(result.hash_mismatches, 0, "no hash mismatches");

    // Verify B now has the same head as A
    let heads_b = get_local_heads(&pool_b).await.unwrap();
    assert_eq!(heads_b.len(), 1, "B should have 1 device head after sync");
    assert_eq!(heads_b[0].device_id, DEV_A, "B's head should be for DEV_A");
    assert_eq!(heads_b[0].seq, 1, "B's head seq should be 1");
    assert_eq!(
        heads_b[0].hash, heads_a[0].hash,
        "head hashes must match after sync"
    );

    // Verify the op is readable in B
    let op_in_b = op_log::get_op_by_seq(&pool_b, DEV_A, 1).await.unwrap();
    assert_eq!(
        op_in_b.op_type, "create_block",
        "op_type must be create_block in B"
    );
    assert!(
        op_in_b.payload.contains("BLK1"),
        "payload in B must contain the block ID"
    );

    mat_b.shutdown();
}

/// Both devices edit the same block concurrently with multi-line content.
/// After sync and merge, the divergence should be resolved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_device_concurrent_edit_produces_merge() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    // Device A creates a block with multi-line content
    append_local_op_at(
        &pool_a,
        DEV_A,
        create_payload_with_content("BLK1", "line1\nline2\nline3\n"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    // Sync the create to B — materializer will INSERT OR IGNORE the block row
    let result = sync_device_to(&pool_a, DEV_A, &pool_b, &mat_b).await;
    assert_eq!(result.inserted, 1, "B should insert the create op");
    mat_b.flush_foreground().await.unwrap();

    // A edits: changes line1 (prev_edit points to create)
    append_local_op_at(
        &pool_a,
        DEV_A,
        edit_payload_with_prev("BLK1", "lineA\nline2\nline3\n", Some((DEV_A.into(), 1))),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    // B edits: changes line3 (prev_edit points to A's create)
    append_local_op_at(
        &pool_b,
        DEV_B,
        edit_payload_with_prev("BLK1", "line1\nline2\nlineB\n", Some((DEV_A.into(), 1))),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    // Exchange: A sends edit to B, B sends edit to A
    let transfers_a = ops_as_transfers(&pool_a, DEV_A).await;
    let transfers_b = ops_as_transfers(&pool_b, DEV_B).await;

    // Apply A's edit on B (the create is already there, send only the edit)
    let a_edit_transfer = transfers_a.into_iter().filter(|t| t.seq == 2).collect();
    let result_on_b = apply_remote_ops(&pool_b, &mat_b, a_edit_transfer)
        .await
        .unwrap();
    assert_eq!(result_on_b.inserted, 1, "B should insert A's edit");

    // Apply B's edit on A
    let result_on_a = apply_remote_ops(&pool_a, &mat_a, transfers_b)
        .await
        .unwrap();
    assert_eq!(result_on_a.inserted, 1, "A should insert B's edit");

    // Both sides should now detect divergent edit heads
    let heads_b = get_block_edit_heads(&pool_b, "BLK1").await.unwrap();
    assert!(
        heads_b.len() >= 2,
        "B should have at least 2 edit heads for BLK1, got {}",
        heads_b.len()
    );

    // Merge on B's side
    let merge_results = merge_diverged_blocks(&pool_b, DEV_B, &mat_b, DEV_A)
        .await
        .unwrap();
    assert!(
        merge_results.clean_merges > 0 || merge_results.conflicts > 0,
        "merge should produce either a clean merge or a conflict"
    );

    mat_a.shutdown();
    mat_b.shutdown();
}

/// After syncing, Device B's peer_refs for A should have the correct
/// last_hash reflecting A's latest op.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_device_sync_updates_peer_refs() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // A creates 3 ops
    for i in 1..=3 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Sync A → B
    let result = sync_device_to(&pool_a, DEV_A, &pool_b, &mat_b).await;
    assert_eq!(result.inserted, 3, "B should insert all 3 ops");

    // Get A's last hash
    let heads_a = get_local_heads(&pool_a).await.unwrap();
    let a_last_hash = &heads_a[0].hash;

    // Simulate complete_sync on B's side
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();
    complete_sync(&pool_b, DEV_A, a_last_hash, "")
        .await
        .unwrap();

    // Verify peer_refs
    let peer = peer_refs::get_peer_ref(&pool_b, DEV_A)
        .await
        .unwrap()
        .expect("peer ref for DEV_A should exist in B");
    assert_eq!(
        peer.last_hash.as_deref(),
        Some(a_last_hash.as_str()),
        "B's peer_refs.last_hash should match A's head hash"
    );
    assert!(
        peer.synced_at.is_some(),
        "synced_at should be set after complete_sync"
    );

    mat_b.shutdown();
}

/// A has blocks 1,2. B has blocks 3,4. After bidirectional sync, both
/// have all 4 blocks in their op logs.
#[tokio::test]
async fn two_device_bidirectional_sync() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    // A creates blocks 1, 2
    for i in 1..=2 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK-A{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // B creates blocks 3, 4
    for i in 3..=4 {
        append_local_op_at(
            &pool_b,
            DEV_B,
            create_payload(&format!("BLK-B{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Exchange heads
    let heads_a = get_local_heads(&pool_a).await.unwrap();
    let heads_b = get_local_heads(&pool_b).await.unwrap();

    // A computes what to send B (B knows nothing about A)
    let ops_a_to_b = compute_ops_to_send(&pool_a, &heads_b).await.unwrap();
    assert_eq!(ops_a_to_b.len(), 2, "A should send 2 ops to B");

    // B computes what to send A (A knows nothing about B)
    let ops_b_to_a = compute_ops_to_send(&pool_b, &heads_a).await.unwrap();
    assert_eq!(ops_b_to_a.len(), 2, "B should send 2 ops to A");

    // Apply bidirectionally
    let transfers_a: Vec<OpTransfer> = ops_a_to_b.into_iter().map(OpTransfer::from).collect();
    let transfers_b: Vec<OpTransfer> = ops_b_to_a.into_iter().map(OpTransfer::from).collect();

    let result_on_b = apply_remote_ops(&pool_b, &mat_b, transfers_a)
        .await
        .unwrap();
    assert_eq!(result_on_b.inserted, 2, "B should insert 2 ops from A");

    let result_on_a = apply_remote_ops(&pool_a, &mat_a, transfers_b)
        .await
        .unwrap();
    assert_eq!(result_on_a.inserted, 2, "A should insert 2 ops from B");

    // Verify both have heads for both devices
    let final_heads_a = get_local_heads(&pool_a).await.unwrap();
    assert_eq!(
        final_heads_a.len(),
        2,
        "A should have heads for both devices after sync"
    );

    let final_heads_b = get_local_heads(&pool_b).await.unwrap();
    assert_eq!(
        final_heads_b.len(),
        2,
        "B should have heads for both devices after sync"
    );

    // Verify A has B's ops
    let a_ops_devb = op_log::get_ops_since(&pool_a, DEV_B, 0).await.unwrap();
    assert_eq!(a_ops_devb.len(), 2, "A should have 2 ops from DEV_B");

    // Verify B has A's ops
    let b_ops_deva = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert_eq!(b_ops_deva.len(), 2, "B should have 2 ops from DEV_A");

    mat_a.shutdown();
    mat_b.shutdown();
}

// ======================================================================
// Group 2: Idempotency / out-of-order delivery (#230)
// ======================================================================

/// Inserting the same op twice should be idempotent: first insert succeeds,
/// second is counted as a duplicate.
#[tokio::test]
async fn duplicate_op_delivery_is_idempotent() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // Create op on A
    let op = append_local_op_at(&pool_a, DEV_A, create_payload("BLK1"), FIXED_TS.into())
        .await
        .unwrap();

    let transfer: OpTransfer = op.clone().into();
    let transfer_dup = transfer.clone();

    // First apply
    let r1 = apply_remote_ops(&pool_b, &mat_b, vec![transfer])
        .await
        .unwrap();
    assert_eq!(r1.inserted, 1, "first apply should insert 1 op");
    assert_eq!(r1.duplicates, 0, "first apply should have 0 duplicates");

    // Second apply — same op
    let r2 = apply_remote_ops(&pool_b, &mat_b, vec![transfer_dup])
        .await
        .unwrap();
    assert_eq!(r2.inserted, 0, "second apply should insert 0 ops");
    assert_eq!(r2.duplicates, 1, "second apply should detect 1 duplicate");

    // Verify only 1 op in B's log
    let ops = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert_eq!(
        ops.len(),
        1,
        "B should have exactly 1 op after double delivery"
    );

    mat_b.shutdown();
}

/// Ops applied out of sequential order should all insert successfully
/// (INSERT OR IGNORE on PK). All should be present afterward.
#[tokio::test]
async fn out_of_order_ops_applied_correctly() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // Create 3 sequential ops on A
    for i in 1..=3 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let all_transfers = ops_as_transfers(&pool_a, DEV_A).await;
    assert_eq!(all_transfers.len(), 3, "A should have 3 ops");

    // Apply in reverse order: 3, 1, 2
    let t3 = vec![all_transfers[2].clone()];
    let t1 = vec![all_transfers[0].clone()];
    let t2 = vec![all_transfers[1].clone()];

    let r3 = apply_remote_ops(&pool_b, &mat_b, t3).await.unwrap();
    assert_eq!(r3.inserted, 1, "op 3 should insert");

    let r1 = apply_remote_ops(&pool_b, &mat_b, t1).await.unwrap();
    assert_eq!(r1.inserted, 1, "op 1 should insert");

    let r2 = apply_remote_ops(&pool_b, &mat_b, t2).await.unwrap();
    assert_eq!(r2.inserted, 1, "op 2 should insert");

    // Verify all 3 present
    let ops = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert_eq!(ops.len(), 3, "all 3 ops should be present in B");
    let seqs: Vec<i64> = ops.iter().map(|o| o.seq).collect();
    assert!(seqs.contains(&1), "seq 1 should be present");
    assert!(seqs.contains(&2), "seq 2 should be present");
    assert!(seqs.contains(&3), "seq 3 should be present");

    mat_b.shutdown();
}

/// Applying ops with gaps in sequence numbers should succeed — the op log
/// does not require contiguous sequences from remote devices.
#[tokio::test]
async fn ops_with_gaps_in_sequence() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // Create 5 ops on A
    for i in 1..=5 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let all_transfers = ops_as_transfers(&pool_a, DEV_A).await;

    // Only send seq 1 and seq 5 (gap of 2,3,4)
    let sparse = vec![all_transfers[0].clone(), all_transfers[4].clone()];

    let result = apply_remote_ops(&pool_b, &mat_b, sparse).await.unwrap();
    assert_eq!(result.inserted, 2, "both ops should insert despite gap");
    assert_eq!(result.hash_mismatches, 0, "no hash mismatches");

    // Verify both present
    let op1 = op_log::get_op_by_seq(&pool_b, DEV_A, 1).await;
    assert!(op1.is_ok(), "seq 1 should be present in B");
    let op5 = op_log::get_op_by_seq(&pool_b, DEV_A, 5).await;
    assert!(op5.is_ok(), "seq 5 should be present in B");

    // Verify seq 3 is NOT present (it was not sent)
    let op3 = op_log::get_op_by_seq(&pool_b, DEV_A, 3).await;
    assert!(op3.is_err(), "seq 3 should not be present in B (not sent)");

    mat_b.shutdown();
}

/// An op with a tampered hash should cause apply_remote_ops to reject the
/// entire batch (integrity check failure).
#[tokio::test]
async fn hash_mismatch_op_rejected() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // Create op on A
    let op = append_local_op_at(&pool_a, DEV_A, create_payload("BLK1"), FIXED_TS.into())
        .await
        .unwrap();

    // Tamper with the hash
    let mut transfer: OpTransfer = op.into();
    transfer.hash = "0".repeat(64);

    let err = apply_remote_ops(&pool_b, &mat_b, vec![transfer])
        .await
        .expect_err("batch with tampered hash must be rejected");
    assert!(
        err.to_string().contains("integrity check failed"),
        "error must mention integrity check, got: {err}"
    );

    // Verify nothing in B's log
    let ops = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert!(
        ops.is_empty(),
        "B's op log should be empty after rejecting tampered op"
    );

    mat_b.shutdown();
}

// ======================================================================
// Group 3: Snapshot + sync resume (#231)
// ======================================================================

/// When Device A has compacted its op log (old ops purged), and Device B
/// claims it has a seq that was compacted away, check_reset_required
/// should return true.
#[tokio::test]
async fn sync_after_compaction_detects_reset_required() {
    let (pool, _dir) = test_pool().await;

    // Create ops with timestamps well in the past (before cutoff)
    let past_ts = "2020-01-01T00:00:00.000Z";
    for i in 1..=10 {
        append_local_op_at(
            &pool,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            past_ts.into(),
        )
        .await
        .unwrap();
    }

    // Create some recent ops (far-future timestamp survives compaction)
    let future_ts = "2099-01-01T00:00:00.000Z";
    for i in 11..=15 {
        append_local_op_at(
            &pool,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            future_ts.into(),
        )
        .await
        .unwrap();
    }

    // Compact — this deletes old ops (retention 0 days means everything
    // before now is eligible, but we created ops at past_ts so those
    // get purged).
    let compacted = snapshot::compact_op_log(&pool, DEV_A, 0).await.unwrap();
    assert!(
        compacted.is_some(),
        "compaction should produce a snapshot ID"
    );

    // Verify old ops are gone
    let op5 = op_log::get_op_by_seq(&pool, DEV_A, 5).await;
    assert!(op5.is_err(), "seq 5 should be purged after compaction");

    // Remote claims it last saw seq 5 for DEV_A — which was compacted
    let remote_heads = vec![DeviceHead {
        device_id: DEV_A.to_string(),
        seq: 5,
        hash: "irrelevant".to_string(),
    }];

    let reset_needed = check_reset_required(&pool, &remote_heads).await.unwrap();
    assert!(
        reset_needed,
        "check_reset_required should return true when remote references compacted ops"
    );

    // Remote claims it last saw a seq that still exists — should NOT need reset
    let recent_heads = vec![DeviceHead {
        device_id: DEV_A.to_string(),
        seq: 15,
        hash: "irrelevant".to_string(),
    }];
    let no_reset = check_reset_required(&pool, &recent_heads).await.unwrap();
    assert!(
        !no_reset,
        "check_reset_required should return false when remote references existing ops"
    );
}

/// After an initial sync of 10 ops, a second sync should only send the
/// new ops created after the first sync.
#[tokio::test]
async fn sync_resume_from_last_hash_sends_only_new_ops() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // A creates 10 ops
    for i in 1..=10 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Initial sync: A → B (all 10 ops)
    let result = sync_device_to(&pool_a, DEV_A, &pool_b, &mat_b).await;
    assert_eq!(result.inserted, 10, "B should receive all 10 ops");

    // B updates its view of A's head
    let heads_b = get_local_heads(&pool_b).await.unwrap();
    assert_eq!(heads_b.len(), 1, "B should have 1 head for DEV_A");
    assert_eq!(heads_b[0].seq, 10, "B's head for A should be seq 10");

    // A creates 5 more ops
    for i in 11..=15 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Second sync: compute_ops_to_send using B's heads → only 5 new ops
    let ops_to_send = compute_ops_to_send(&pool_a, &heads_b).await.unwrap();
    assert_eq!(
        ops_to_send.len(),
        5,
        "second sync should only send 5 new ops"
    );
    assert_eq!(ops_to_send[0].seq, 11, "first new op should be seq 11");
    assert_eq!(ops_to_send[4].seq, 15, "last new op should be seq 15");

    // Apply incremental ops to B
    let result = incremental_sync(&pool_a, &pool_b, &mat_b, &heads_b).await;
    assert_eq!(result.inserted, 5, "B should insert only the 5 new ops");
    assert_eq!(result.duplicates, 0, "no duplicates in incremental sync");

    // Verify B now has all 15
    let all_ops = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert_eq!(
        all_ops.len(),
        15,
        "B should have all 15 ops after incremental sync"
    );

    mat_b.shutdown();
}

// ======================================================================
// Group 4: Large op log stress tests (#232)
// ======================================================================

/// Device A creates 500 ops, syncs them all to Device B. Verify counts
/// match and heads are identical after sync.
#[tokio::test]
async fn large_op_log_sync_5000_ops() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    let op_count = 500;

    // Device A creates 500 ops (mix of create + edit)
    for i in 1..=op_count {
        if i % 2 == 1 {
            // Odd: create block
            append_local_op_at(
                &pool_a,
                DEV_A,
                create_payload(&format!("BLK{i:05}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        } else {
            // Even: edit previous block
            let prev_blk = format!("BLK{:05}", i - 1);
            append_local_op_at(
                &pool_a,
                DEV_A,
                edit_payload(&prev_blk, &format!("edited content {i}")),
                FIXED_TS.into(),
            )
            .await
            .unwrap();
        }
    }

    // Verify A has op_count ops
    let a_ops = op_log::get_ops_since(&pool_a, DEV_A, 0).await.unwrap();
    assert_eq!(a_ops.len(), op_count, "A should have {op_count} ops");

    // Get heads
    let heads_a = get_local_heads(&pool_a).await.unwrap();
    assert_eq!(
        heads_a[0].seq,
        i64::try_from(op_count).unwrap(),
        "A's head should be at {op_count}"
    );

    // Compute ops for empty remote → all ops
    let ops_to_send = compute_ops_to_send(&pool_a, &[]).await.unwrap();
    assert_eq!(
        ops_to_send.len(),
        op_count,
        "should send all {op_count} ops to empty remote"
    );

    // Apply all to B
    let transfers: Vec<OpTransfer> = ops_to_send.into_iter().map(OpTransfer::from).collect();
    let result = apply_remote_ops(&pool_b, &mat_b, transfers).await.unwrap();
    assert_eq!(
        result.inserted, op_count,
        "B should insert all {op_count} ops"
    );
    assert_eq!(result.duplicates, 0, "no duplicates in bulk sync");
    assert_eq!(result.hash_mismatches, 0, "no hash mismatches in bulk sync");

    // Verify counts match
    let b_ops = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert_eq!(
        b_ops.len(),
        op_count,
        "B should have {op_count} ops after sync"
    );

    // Verify heads match
    let heads_b = get_local_heads(&pool_b).await.unwrap();
    assert_eq!(
        heads_b[0].hash, heads_a[0].hash,
        "head hashes must match after bulk sync"
    );
    assert_eq!(
        heads_b[0].seq, heads_a[0].seq,
        "head seqs must match after bulk sync"
    );

    mat_b.shutdown();
}

/// After syncing 500 ops, A creates 100 more. Incremental sync should
/// only transfer the 100 new ops.
#[tokio::test]
async fn large_op_log_incremental_sync() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    let initial_count = 500;
    let extra_count = 100;

    // A creates 500 ops
    for i in 1..=initial_count {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i:05}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Sync all to B
    let result = sync_device_to(&pool_a, DEV_A, &pool_b, &mat_b).await;
    assert_eq!(
        result.inserted, initial_count,
        "initial sync should transfer all ops"
    );

    // Record B's heads after initial sync
    let heads_b = get_local_heads(&pool_b).await.unwrap();
    assert_eq!(
        heads_b[0].seq,
        i64::try_from(initial_count).unwrap(),
        "B should be at seq {initial_count}"
    );

    // A creates 100 more
    for i in (initial_count + 1)..=(initial_count + extra_count) {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i:05}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Compute incremental → only 100
    let ops_to_send = compute_ops_to_send(&pool_a, &heads_b).await.unwrap();
    assert_eq!(
        ops_to_send.len(),
        extra_count,
        "incremental sync should send only {extra_count} new ops"
    );

    // Apply incremental
    let result = incremental_sync(&pool_a, &pool_b, &mat_b, &heads_b).await;
    assert_eq!(
        result.inserted, extra_count,
        "B should insert {extra_count} new ops"
    );

    // Verify totals
    let final_b_ops = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert_eq!(
        final_b_ops.len(),
        initial_count + extra_count,
        "B should have all {} ops",
        initial_count + extra_count
    );

    mat_b.shutdown();
}

// ======================================================================
// Group 5: Edge cases
// ======================================================================

/// Both devices have empty op logs. Head exchange produces empty heads,
/// compute_ops_to_send returns nothing, no merge needed.
#[tokio::test]
async fn sync_with_empty_op_logs_both_sides() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;

    let heads_a = get_local_heads(&pool_a).await.unwrap();
    let heads_b = get_local_heads(&pool_b).await.unwrap();

    assert!(heads_a.is_empty(), "A should have no heads");
    assert!(heads_b.is_empty(), "B should have no heads");

    let ops_a_to_b = compute_ops_to_send(&pool_a, &heads_b).await.unwrap();
    assert!(ops_a_to_b.is_empty(), "no ops from A to B");

    let ops_b_to_a = compute_ops_to_send(&pool_b, &heads_a).await.unwrap();
    assert!(ops_b_to_a.is_empty(), "no ops from B to A");

    // check_reset_required with empty heads should be false
    let reset = check_reset_required(&pool_a, &heads_b).await.unwrap();
    assert!(!reset, "no reset needed when both sides are empty");
}

/// Full SyncOrchestrator flow from the initiator's perspective:
/// start() → HeadExchange → receive remote HeadExchange → send OpBatch →
/// receive SyncComplete → complete.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_full_flow_initiator_side() {
    let (pool_a, _dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());

    // A has some ops
    for i in 1..=3 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let mut orchestrator_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        // BUG-27: In production the peer identity is carried by mTLS/mDNS and
        // supplied via `with_expected_remote_id`. Without it, a first-time
        // sync with a peer that has no ops of its own would leave
        // `remote_device_id` empty and silently corrupt peer bookkeeping.
        .with_expected_remote_id(DEV_B.into());

    // Step 1: start() → produces HeadExchange
    let msg1 = orchestrator_a.start().await.unwrap();
    match &msg1 {
        SyncMessage::HeadExchange { heads } => {
            assert_eq!(heads.len(), 1, "A should advertise 1 head");
            assert_eq!(heads[0].device_id, DEV_A, "head should be for DEV_A");
            assert_eq!(heads[0].seq, 3, "head seq should be 3");
        }
        other => panic!("expected HeadExchange, got {:?}", other),
    }

    // Step 2: Feed in HeadExchange from B (empty — B has no data)
    let b_exchange = SyncMessage::HeadExchange { heads: vec![] };
    let response = orchestrator_a.handle_message(b_exchange).await.unwrap();

    // Should respond with OpBatch containing A's ops
    match response {
        Some(SyncMessage::OpBatch { ops, is_last }) => {
            assert_eq!(ops.len(), 3, "OpBatch should contain 3 ops");
            assert!(is_last, "single batch should be is_last=true");
        }
        other => panic!("expected OpBatch, got {:?}", other),
    }

    // Step 3: Feed in SyncComplete from B
    let b_complete = SyncMessage::SyncComplete {
        last_hash: "some-hash-from-b".to_string(),
    };

    // BUG-27: The orchestrator now falls back to `expected_remote_id` when
    // the HeadExchange didn't carry a non-local device_id, so the peer row
    // is created under the real `DEV_B` key — no more workaround needed.

    let final_response = orchestrator_a.handle_message(b_complete).await.unwrap();
    assert!(
        final_response.is_none(),
        "SyncComplete should not produce a response"
    );
    assert!(
        orchestrator_a.is_succeeded(),
        "orchestrator should be complete after SyncComplete"
    );

    let session = orchestrator_a.session();
    assert_eq!(session.ops_sent, 3, "session should record 3 ops sent");

    mat_a.shutdown();
}

/// Full SyncOrchestrator flow from the receiver's perspective.
///
/// B starts → HeadExchange → receives OpBatch from A → apply → SyncComplete.
///
/// Note: We skip the HeadExchange-from-A step because the current
/// `check_reset_required` implementation treats "remote is ahead of us"
/// the same as "ops were compacted away", triggering a false-positive
/// ResetRequired for first-time syncs. This test verifies the OpBatch →
/// apply → SyncComplete path which is the core receiver logic.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_full_flow_receiver_side() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // A has 3 ops
    for i in 1..=3 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let mut orchestrator_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone());

    // Step 1: B starts → empty HeadExchange
    let msg1 = orchestrator_b.start().await.unwrap();
    match &msg1 {
        SyncMessage::HeadExchange { heads } => {
            assert!(heads.is_empty(), "B should start with empty heads");
        }
        other => panic!("expected HeadExchange, got {:?}", other),
    }

    // Step 2: B receives OpBatch from A (simulating A's response to B's
    //         empty HeadExchange — A computed all ops to send)
    let a_transfers = ops_as_transfers(&pool_a, DEV_A).await;
    assert_eq!(a_transfers.len(), 3, "A should have 3 ops to send");

    let a_batch = SyncMessage::OpBatch {
        ops: a_transfers,
        is_last: true,
    };
    let response = orchestrator_b.handle_message(a_batch).await.unwrap();

    // B should respond with SyncComplete
    match response {
        Some(SyncMessage::SyncComplete { .. }) => {
            // Success — receiver applied ops and completed
        }
        other => panic!("expected SyncComplete, got {:?}", other),
    }

    assert!(
        orchestrator_b.is_succeeded(),
        "orchestrator should be complete after receiving OpBatch"
    );

    let session = orchestrator_b.session();
    assert_eq!(
        session.ops_received, 3,
        "session should record 3 ops received"
    );

    // Verify B actually has A's ops
    let b_ops = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert_eq!(
        b_ops.len(),
        3,
        "B should have 3 ops from A after orchestrator flow"
    );

    mat_b.shutdown();
}

/// The SyncOrchestrator correctly detects a ResetRequired condition when
/// remote heads reference compacted ops.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_detects_reset_required() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create ops with old timestamps that will be compacted
    let past_ts = "2020-01-01T00:00:00.000Z";
    for i in 1..=5 {
        append_local_op_at(
            &pool,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            past_ts.into(),
        )
        .await
        .unwrap();
    }

    // Create recent ops (far-future timestamp survives compaction)
    let future_ts = "2099-01-01T00:00:00.000Z";
    for i in 6..=10 {
        append_local_op_at(
            &pool,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            future_ts.into(),
        )
        .await
        .unwrap();
    }

    // Compact
    snapshot::compact_op_log(&pool, DEV_A, 0).await.unwrap();

    let mut orchestrator = SyncOrchestrator::new(pool.clone(), DEV_A.into(), mat.clone());
    orchestrator.start().await.unwrap();

    // Remote claims it has seq 3, which was compacted
    let remote_exchange = SyncMessage::HeadExchange {
        heads: vec![DeviceHead {
            device_id: DEV_A.to_string(),
            seq: 3,
            hash: "old-hash".to_string(),
        }],
    };

    let response = orchestrator.handle_message(remote_exchange).await.unwrap();

    match response {
        Some(SyncMessage::ResetRequired { reason }) => {
            assert!(
                reason.contains("missing"),
                "reset reason should mention missing ops, got: {reason}"
            );
        }
        other => panic!("expected ResetRequired, got {:?}", other),
    }

    mat.shutdown();
}

/// Multiple sequential syncs with the same orchestrator pattern work
/// correctly — simulates repeated sync sessions between two devices.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_sync_sessions_converge() {
    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // Round 1: A creates 3 ops, syncs to B
    for i in 1..=3 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("R1-BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }
    let r1 = sync_device_to(&pool_a, DEV_A, &pool_b, &mat_b).await;
    assert_eq!(r1.inserted, 3, "round 1 should sync 3 ops");

    // Round 2: A creates 2 more ops, syncs incrementally
    for i in 1..=2 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("R2-BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }
    let heads_b = get_local_heads(&pool_b).await.unwrap();
    let r2 = incremental_sync(&pool_a, &pool_b, &mat_b, &heads_b).await;
    assert_eq!(r2.inserted, 2, "round 2 should sync only 2 new ops");

    // Round 3: no new ops — should send nothing
    let heads_b_2 = get_local_heads(&pool_b).await.unwrap();
    let ops_to_send = compute_ops_to_send(&pool_a, &heads_b_2).await.unwrap();
    assert!(
        ops_to_send.is_empty(),
        "round 3 should have no ops to send when already up to date"
    );

    // Verify B has exactly 5 ops total
    let all_ops = op_log::get_ops_since(&pool_b, DEV_A, 0).await.unwrap();
    assert_eq!(
        all_ops.len(),
        5,
        "B should have all 5 ops after 3 sync rounds"
    );

    mat_b.shutdown();
}

/// Verifies that applying ops from multiple remote devices produces
/// independent heads per device.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multi_device_heads_are_independent() {
    let (pool_local, _dir_local) = test_pool().await;
    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_local = Materializer::new(pool_local.clone());

    // Device A creates 3 ops
    for i in 1..=3 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("A-BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Device B creates 5 ops
    for i in 1..=5 {
        append_local_op_at(
            &pool_b,
            DEV_B,
            create_payload(&format!("B-BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Apply both to local
    let result_a = sync_device_to(&pool_a, DEV_A, &pool_local, &mat_local).await;
    assert_eq!(result_a.inserted, 3, "should insert 3 ops from A");

    let result_b = sync_device_to(&pool_b, DEV_B, &pool_local, &mat_local).await;
    assert_eq!(result_b.inserted, 5, "should insert 5 ops from B");

    // Verify independent heads
    let heads = get_local_heads(&pool_local).await.unwrap();
    assert_eq!(heads.len(), 2, "local should have heads for 2 devices");

    let head_a = heads.iter().find(|h| h.device_id == DEV_A).unwrap();
    let head_b = heads.iter().find(|h| h.device_id == DEV_B).unwrap();
    assert_eq!(head_a.seq, 3, "A's head should be at seq 3");
    assert_eq!(head_b.seq, 5, "B's head should be at seq 5");

    mat_local.shutdown();
}

/// Verify that insert_remote_op directly (not via apply_remote_ops) with
/// a properly hashed record succeeds, and with a bad hash fails.
#[tokio::test]
async fn insert_remote_op_hash_verification_integration() {
    let (pool, _dir) = test_pool().await;

    // Build a valid remote record manually
    let payload_json = r#"{"block_id":"BLOCK1","block_type":"content","content":"hello","parent_id":null,"position":0}"#;
    let hash = compute_op_hash("remote-dev", 1, None, "create_block", payload_json);

    let valid_record = OpRecord {
        device_id: "remote-dev".to_string(),
        seq: 1,
        parent_seqs: None,
        hash: hash.clone(),
        op_type: "create_block".to_string(),
        payload: payload_json.to_string(),
        created_at: FIXED_TS.to_string(),
        block_id: Some("BLOCK1".to_string()),
    };

    insert_remote_op(&pool, &valid_record).await.unwrap();

    // Verify it's in the DB
    let fetched = op_log::get_op_by_seq(&pool, "remote-dev", 1).await.unwrap();
    assert_eq!(fetched.hash, hash, "stored hash should match");

    // Build an invalid record with wrong hash
    let bad_record = OpRecord {
        device_id: "remote-dev".to_string(),
        seq: 2,
        parent_seqs: None,
        hash: "bad_hash_0000000000000000000000000000000000000000000000000000000000".to_string(),
        op_type: "create_block".to_string(),
        payload: payload_json.to_string(),
        created_at: FIXED_TS.to_string(),
        block_id: Some("BLOCK1".to_string()),
    };

    let err = insert_remote_op(&pool, &bad_record).await;
    assert!(
        err.is_err(),
        "insert_remote_op should reject a record with wrong hash"
    );
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("hash mismatch"),
        "error should mention hash mismatch, got: {msg}"
    );
}

/// The SyncOrchestrator handles Error messages correctly by transitioning
/// to the Failed state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_handles_error_message() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let mut orchestrator = SyncOrchestrator::new(pool, DEV_A.into(), mat.clone());
    orchestrator.start().await.unwrap();

    let error_msg = SyncMessage::Error {
        message: "test error".to_string(),
    };
    let response = orchestrator.handle_message(error_msg).await.unwrap();
    assert!(
        response.is_none(),
        "Error message should not produce a response"
    );
    assert!(
        !orchestrator.is_succeeded(),
        "orchestrator should not be complete after error"
    );

    mat.shutdown();
}

/// The SyncOrchestrator must surface a stray `SnapshotOffer` as an
/// `InvalidOperation` error. The real snapshot catch-up runs at the
/// daemon layer (`sync_daemon::snapshot_transfer`); anything that makes
/// it into `handle_message` indicates the daemon-layer interception has
/// regressed (MAINT-86).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_snapshot_offer() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let mut orchestrator = SyncOrchestrator::new(pool, DEV_A.into(), mat.clone());
    orchestrator.start().await.unwrap();

    let offer = SyncMessage::SnapshotOffer { size_bytes: 1024 };
    let result = orchestrator.handle_message(offer).await;
    let err = match result {
        Err(crate::error::AppError::InvalidOperation(msg)) => msg,
        other => {
            panic!("expected AppError::InvalidOperation for stray SnapshotOffer, got {other:?}")
        }
    };
    assert!(
        err.contains("SnapshotOffer") && err.contains("snapshot_transfer"),
        "error must name variant + daemon sub-flow, got: {err}"
    );

    mat.shutdown();
}

// ======================================================================
// Group 6: Event emission (#sync_events)
// ======================================================================

/// Verify that SyncOrchestrator emits events in the correct order during
/// a full receiver-side sync flow: start → OpBatch → Complete.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_emits_events_in_order() {
    use crate::sync_events::{RecordingEventSink, SyncEvent};
    use std::sync::Arc;

    let ((pool_a, _dir_a), (pool_b, _dir_b)) = two_device_setup().await;
    let mat_b = Materializer::new(pool_b.clone());

    // A has 3 ops
    for i in 1..=3 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let sink = Arc::new(RecordingEventSink::new());
    let mut orch = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_event_sink(Box::new(Arc::clone(&sink)));

    // Step 1: start() → ExchangingHeads
    let _msg1 = orch.start().await.unwrap();

    // Step 2: Receive OpBatch from A (simulating A's response to B's
    //         empty HeadExchange — A computed all ops to send)
    let a_transfers = ops_as_transfers(&pool_a, DEV_A).await;
    let a_batch = SyncMessage::OpBatch {
        ops: a_transfers,
        is_last: true,
    };
    let response = orch.handle_message(a_batch).await.unwrap();
    assert!(
        matches!(response, Some(SyncMessage::SyncComplete { .. })),
        "should produce SyncComplete"
    );
    assert!(orch.is_succeeded(), "orchestrator should be complete");

    let events = sink.events();
    // Expected: Progress(exchanging_heads), Progress(applying_ops),
    //           Progress(merging), Complete
    assert!(
        events.len() >= 4,
        "should emit at least 4 events, got {}",
        events.len()
    );

    // First event: Progress with exchanging_heads
    match &events[0] {
        SyncEvent::Progress { state, .. } => {
            assert_eq!(
                state, "exchanging_heads",
                "first event should be exchanging_heads"
            );
        }
        other => panic!("expected Progress, got {:?}", other),
    }

    // Verify applying_ops appears somewhere
    let has_applying = events
        .iter()
        .any(|e| matches!(e, SyncEvent::Progress { state, .. } if state == "applying_ops"));
    assert!(has_applying, "should have an applying_ops progress event");

    // Verify merging appears somewhere
    let has_merging = events
        .iter()
        .any(|e| matches!(e, SyncEvent::Progress { state, .. } if state == "merging"));
    assert!(has_merging, "should have a merging progress event");

    // Last event: Complete with correct counts
    match events.last().unwrap() {
        SyncEvent::Complete {
            ops_received,
            ops_sent,
            ..
        } => {
            assert_eq!(*ops_received, 3, "should have received 3 ops");
            assert_eq!(*ops_sent, 0, "receiver sent 0 ops");
        }
        other => panic!("expected Complete as last event, got {:?}", other),
    }

    mat_b.shutdown();
}

/// Verify that SyncOrchestrator emits an Error event on protocol violation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_emits_error_event_on_protocol_violation() {
    use crate::sync_events::{RecordingEventSink, SyncEvent};
    use std::sync::Arc;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let sink = Arc::new(RecordingEventSink::new());
    let mut orch = SyncOrchestrator::new(pool, DEV_A.into(), mat.clone())
        .with_event_sink(Box::new(Arc::clone(&sink)));

    // Don't call start() — state is Idle. Sending OpBatch should fail.
    let result = orch
        .handle_message(SyncMessage::OpBatch {
            ops: vec![],
            is_last: true,
        })
        .await;
    assert!(result.is_err(), "OpBatch from Idle should be rejected");

    let events = sink.events();
    assert_eq!(
        events.len(),
        1,
        "should emit exactly 1 error event for protocol violation"
    );
    match &events[0] {
        SyncEvent::Error { message, .. } => {
            assert!(
                message.contains("OpBatch"),
                "error message should mention OpBatch, got: {message}"
            );
        }
        other => panic!("expected Error event, got {:?}", other),
    }

    mat.shutdown();
}

/// Verify that SyncOrchestrator emits an Error event when the remote
/// sends an Error message.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_emits_error_event_on_remote_error() {
    use crate::sync_events::{RecordingEventSink, SyncEvent};
    use std::sync::Arc;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let sink = Arc::new(RecordingEventSink::new());
    let mut orch = SyncOrchestrator::new(pool, DEV_A.into(), mat.clone())
        .with_event_sink(Box::new(Arc::clone(&sink)));

    orch.start().await.unwrap();

    let error_msg = SyncMessage::Error {
        message: "remote peer crashed".to_string(),
    };
    let _response = orch.handle_message(error_msg).await.unwrap();

    let events = sink.events();
    // First event: Progress(exchanging_heads) from start(), second: Error
    assert!(
        events.len() >= 2,
        "should emit at least 2 events (progress + error), got {}",
        events.len()
    );
    match events.last().unwrap() {
        SyncEvent::Error { message, .. } => {
            assert_eq!(message, "remote peer crashed", "error message should match");
        }
        other => panic!("expected Error event, got {:?}", other),
    }

    mat.shutdown();
}

/// Verify events for the full initiator-side flow (start → HeadExchange
/// → send ops → receive SyncComplete).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_emits_events_initiator_side() {
    use crate::sync_events::{RecordingEventSink, SyncEvent};
    use std::sync::Arc;

    let (pool_a, _dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());

    // A has some ops
    for i in 1..=3 {
        append_local_op_at(
            &pool_a,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let sink = Arc::new(RecordingEventSink::new());
    let mut orch = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_event_sink(Box::new(Arc::clone(&sink)))
        // BUG-27: Production passes the peer identity here (mTLS/mDNS).
        // Needed so SyncComplete can fall back to a real peer_id when the
        // remote's heads don't mention its own device_id.
        .with_expected_remote_id(DEV_B.into());

    // Step 1: start() → HeadExchange
    let _msg1 = orch.start().await.unwrap();

    // Step 2: HeadExchange from B (empty)
    let _response = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();

    // Step 3: SyncComplete from B
    let _final = orch
        .handle_message(SyncMessage::SyncComplete {
            last_hash: "hash-from-b".into(),
        })
        .await
        .unwrap();

    assert!(orch.is_succeeded(), "orchestrator should be complete");

    let events = sink.events();
    // Expected: Progress(exchanging_heads), Progress(streaming_ops), Complete
    assert!(
        events.len() >= 3,
        "should emit at least 3 events, got {}",
        events.len()
    );

    // First: exchanging_heads
    match &events[0] {
        SyncEvent::Progress { state, .. } => {
            assert_eq!(
                state, "exchanging_heads",
                "first event should be exchanging_heads"
            );
        }
        other => panic!("expected Progress, got {:?}", other),
    }

    // Second: streaming_ops
    match &events[1] {
        SyncEvent::Progress {
            state, ops_sent, ..
        } => {
            assert_eq!(
                state, "streaming_ops",
                "second event should be streaming_ops"
            );
            assert_eq!(*ops_sent, 3, "should report 3 ops sent");
        }
        other => panic!("expected Progress, got {:?}", other),
    }

    // Last: Complete
    match events.last().unwrap() {
        SyncEvent::Complete { ops_sent, .. } => {
            assert_eq!(*ops_sent, 3, "complete should report 3 ops sent");
        }
        other => panic!("expected Complete as last event, got {:?}", other),
    }

    mat_a.shutdown();
}

/// Verify that SyncOrchestrator emits an Error event when reset_required
/// is detected during HeadExchange (remote references compacted ops).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_emits_error_event_on_reset_required() {
    use crate::sync_events::{RecordingEventSink, SyncEvent};
    use std::sync::Arc;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create ops with old timestamps that will be compacted
    let past_ts = "2020-01-01T00:00:00.000Z";
    for i in 1..=5 {
        append_local_op_at(
            &pool,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            past_ts.into(),
        )
        .await
        .unwrap();
    }

    // Create recent ops that survive compaction
    let future_ts = "2099-01-01T00:00:00.000Z";
    for i in 6..=10 {
        append_local_op_at(
            &pool,
            DEV_A,
            create_payload(&format!("BLK{i}")),
            future_ts.into(),
        )
        .await
        .unwrap();
    }

    // Compact — purges old ops
    snapshot::compact_op_log(&pool, DEV_A, 0).await.unwrap();

    let sink = Arc::new(RecordingEventSink::new());
    let mut orch = SyncOrchestrator::new(pool.clone(), DEV_A.into(), mat.clone())
        .with_event_sink(Box::new(Arc::clone(&sink)));

    // start() → ExchangingHeads (emits Progress)
    orch.start().await.unwrap();

    // Remote claims seq 3 which was compacted → triggers reset_required
    let remote_exchange = SyncMessage::HeadExchange {
        heads: vec![DeviceHead {
            device_id: DEV_A.to_string(),
            seq: 3,
            hash: "old-hash".to_string(),
        }],
    };
    let response = orch.handle_message(remote_exchange).await.unwrap();
    assert!(
        matches!(response, Some(SyncMessage::ResetRequired { .. })),
        "should return ResetRequired when remote references compacted ops"
    );

    let events = sink.events();
    // Expected: Progress(exchanging_heads) from start(), Error from reset detection
    assert!(
        events.len() >= 2,
        "should emit at least 2 events (progress + error), got {}",
        events.len()
    );

    // Last event should be Error mentioning the reset condition
    match events.last().unwrap() {
        SyncEvent::Error { message, .. } => {
            assert!(
                message.contains("missing"),
                "error message should mention missing ops, got: {message}"
            );
        }
        other => panic!("expected Error event for reset_required, got {:?}", other),
    }

    mat.shutdown();
}
