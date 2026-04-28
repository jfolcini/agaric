use super::*;
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::op::{
    CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    SetPropertyPayload,
};
use crate::op_log::{self, append_local_op_at, OpRecord};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

// ── Fixture constants ───────────────────────────────────────────────

const FIXED_TS: &str = "2025-01-15T12:00:00+00:00";

// ── Helpers ─────────────────────────────────────────────────────────

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

fn test_create_payload(block_id: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".into(),
        parent_id: None,
        position: Some(0),
        content: "test".into(),
    })
}

// ── get_local_heads ─────────────────────────────────────────────────

#[tokio::test]
async fn get_local_heads_empty_db() {
    let (pool, _dir) = test_pool().await;
    let heads = get_local_heads(&pool).await.unwrap();
    assert!(heads.is_empty(), "empty DB should have no heads");
}

#[tokio::test]
async fn get_local_heads_single_device() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=3 {
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let heads = get_local_heads(&pool).await.unwrap();
    assert_eq!(heads.len(), 1, "should have exactly one device head");
    assert_eq!(
        heads[0].device_id, "device-A",
        "single device head should be device-A"
    );
    assert_eq!(heads[0].seq, 3, "head seq should be 3");
    assert!(!heads[0].hash.is_empty(), "hash must not be empty");
}

#[tokio::test]
async fn get_local_heads_multiple_devices() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(
        &pool,
        "device-A",
        test_create_payload("BLK-A1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        "device-B",
        test_create_payload("BLK-B1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        "device-A",
        test_create_payload("BLK-A2"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let heads = get_local_heads(&pool).await.unwrap();
    assert_eq!(heads.len(), 2, "should have two device heads");

    let head_a = heads.iter().find(|h| h.device_id == "device-A").unwrap();
    let head_b = heads.iter().find(|h| h.device_id == "device-B").unwrap();
    assert_eq!(head_a.seq, 2, "device-A should be at seq 2");
    assert_eq!(head_b.seq, 1, "device-B should be at seq 1");
}

// ── compute_ops_to_send ─────────────────────────────────────────────

#[tokio::test]
async fn compute_ops_to_send_new_peer() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=3 {
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Remote has no heads at all
    let ops = compute_ops_to_send(&pool, &[]).await.unwrap();
    assert_eq!(ops.len(), 3, "should send all 3 ops to a new peer");
}

#[tokio::test]
async fn compute_ops_to_send_partial() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=3 {
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    // Remote has seq 2 for device-A
    let head2 = DeviceHead {
        device_id: "device-A".into(),
        seq: 2,
        hash: "ignored-for-this-test".into(),
    };
    let ops = compute_ops_to_send(&pool, &[head2]).await.unwrap();
    assert_eq!(ops.len(), 1, "should send only seq 3");
    assert_eq!(ops[0].seq, 3, "only op sent should be seq 3");
}

#[tokio::test]
async fn compute_ops_to_send_up_to_date() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=2 {
        append_local_op_at(
            &pool,
            "device-A",
            test_create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let local_heads = get_local_heads(&pool).await.unwrap();
    let ops = compute_ops_to_send(&pool, &local_heads).await.unwrap();
    assert!(ops.is_empty(), "no ops to send when remote matches local");
}

// ── apply_remote_ops ────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_inserts_and_counts() {
    // Create ops on a "remote" database
    let (remote_pool, _remote_dir) = test_pool().await;
    let op1 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op2 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK2"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let t1: OpTransfer = op1.into();
    let t2: OpTransfer = op2.into();

    // Apply on a fresh "local" database
    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    let result = apply_remote_ops(&local_pool, &materializer, vec![t1, t2])
        .await
        .unwrap();

    assert_eq!(result.inserted, 2, "should insert 2 new ops");
    assert_eq!(result.duplicates, 0, "no duplicates on first apply");
    assert_eq!(result.hash_mismatches, 0, "no hash mismatches");

    materializer.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_idempotent() {
    // Create ops on a "remote" database
    let (remote_pool, _remote_dir) = test_pool().await;
    let op1 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op2 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK2"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let t1: OpTransfer = op1.into();
    let t2: OpTransfer = op2.into();
    let t1_again = t1.clone();
    let t2_again = t2.clone();

    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    // First apply
    let r1 = apply_remote_ops(&local_pool, &materializer, vec![t1, t2])
        .await
        .unwrap();
    assert_eq!(r1.inserted, 2, "first apply should insert 2");

    // Second apply — same ops
    let r2 = apply_remote_ops(&local_pool, &materializer, vec![t1_again, t2_again])
        .await
        .unwrap();
    assert_eq!(r2.duplicates, 2, "second apply should detect 2 duplicates");
    assert_eq!(r2.inserted, 0, "no new inserts on re-apply");

    materializer.shutdown();
}

// ── complete_sync ───────────────────────────────────────────────────

#[tokio::test]
async fn complete_sync_updates_peer_refs() {
    let (pool, _dir) = test_pool().await;

    // Create peer first (update_on_sync requires existing peer)
    crate::peer_refs::upsert_peer_ref(&pool, "peer-A")
        .await
        .unwrap();

    let before = crate::peer_refs::get_peer_ref(&pool, "peer-A")
        .await
        .unwrap()
        .unwrap();
    assert!(
        before.synced_at.is_none(),
        "synced_at should be None initially"
    );

    complete_sync(&pool, "peer-A", "hash-received", "hash-sent")
        .await
        .unwrap();

    let after = crate::peer_refs::get_peer_ref(&pool, "peer-A")
        .await
        .unwrap()
        .unwrap();
    assert!(
        after.synced_at.is_some(),
        "synced_at should be set after complete_sync"
    );
    assert_eq!(
        after.last_hash.as_deref(),
        Some("hash-received"),
        "last_hash should store received hash"
    );
    assert_eq!(
        after.last_sent_hash.as_deref(),
        Some("hash-sent"),
        "last_sent_hash should store sent hash"
    );
}

// ── OpTransfer roundtrip ────────────────────────────────────────────

#[tokio::test]
async fn op_transfer_from_op_record_roundtrip() {
    let (pool, _dir) = test_pool().await;

    let record = append_local_op_at(
        &pool,
        "test-device",
        test_create_payload("BLK-RT"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    // OpRecord → OpTransfer
    let transfer: OpTransfer = record.clone().into();
    assert_eq!(
        transfer.device_id, record.device_id,
        "transfer device_id should match record"
    );
    assert_eq!(transfer.seq, record.seq, "transfer seq should match record");
    assert_eq!(
        transfer.hash, record.hash,
        "transfer hash should match record"
    );

    // OpTransfer → OpRecord
    let roundtripped: OpRecord = transfer.into();
    assert_eq!(
        roundtripped.device_id, record.device_id,
        "roundtripped device_id should match original"
    );
    assert_eq!(
        roundtripped.seq, record.seq,
        "roundtripped seq should match original"
    );
    assert_eq!(
        roundtripped.parent_seqs, record.parent_seqs,
        "roundtripped parent_seqs should match original"
    );
    assert_eq!(
        roundtripped.hash, record.hash,
        "roundtripped hash should match original"
    );
    assert_eq!(
        roundtripped.op_type, record.op_type,
        "roundtripped op_type should match original"
    );
    assert_eq!(
        roundtripped.payload, record.payload,
        "roundtripped payload should match original"
    );
    assert_eq!(
        roundtripped.created_at, record.created_at,
        "roundtripped created_at should match original"
    );
}

// ── SyncOrchestrator ────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_start_returns_head_exchange() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let mut orchestrator = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());
    let msg = orchestrator.start().await.unwrap();

    match msg {
        SyncMessage::HeadExchange { heads } => {
            assert!(heads.is_empty(), "empty DB should produce empty heads");
        }
        other => panic!("expected HeadExchange, got {:?}", other),
    }

    materializer.shutdown();
}

// ── SyncMessage serde roundtrip ─────────────────────────────────────

#[test]
fn sync_message_serde_roundtrip() {
    let messages = vec![
        SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "dev-A".into(),
                seq: 5,
                hash: "abc123".into(),
            }],
        },
        SyncMessage::OpBatch {
            ops: vec![OpTransfer {
                device_id: "dev-A".into(),
                seq: 1,
                parent_seqs: None,
                hash: "h1".into(),
                op_type: "create_block".into(),
                payload: "{}".into(),
                created_at: "2025-01-01T00:00:00Z".into(),
            }],
            is_last: true,
        },
        SyncMessage::ResetRequired {
            reason: "compacted".into(),
        },
        SyncMessage::SnapshotOffer { size_bytes: 1024 },
        SyncMessage::SnapshotAccept,
        SyncMessage::SnapshotReject,
        SyncMessage::SyncComplete {
            last_hash: "xyz789".into(),
        },
        SyncMessage::Error {
            message: "something went wrong".into(),
        },
        SyncMessage::FileRequest {
            attachment_ids: vec!["ATT1".into(), "ATT2".into()],
        },
        SyncMessage::FileOffer {
            attachment_id: "ATT1".into(),
            size_bytes: 4096,
            blake3_hash: "a".repeat(64),
        },
        SyncMessage::FileReceived {
            attachment_id: "ATT1".into(),
        },
        SyncMessage::FileTransferComplete,
    ];

    for msg in &messages {
        let json = serde_json::to_string(msg).unwrap_or_else(|e| panic!("serialize failed: {e}"));
        let deser: SyncMessage = serde_json::from_str(&json)
            .unwrap_or_else(|e| panic!("deserialize failed for {json}: {e}"));
        let json2 = serde_json::to_string(&deser).unwrap();
        assert_eq!(json, json2, "serde roundtrip mismatch for: {json}");
    }
}

// ── Additional coverage: edge cases & state machine ─────────────────

/// Both sides have empty op logs: no ops to send, no heads.
#[tokio::test]
async fn compute_ops_to_send_both_empty() {
    let (pool, _dir) = test_pool().await;
    let ops = compute_ops_to_send(&pool, &[]).await.unwrap();
    assert!(ops.is_empty(), "both sides empty → nothing to send");
}

/// SyncOrchestrator full flow with two empty databases.
///
/// Simulates: start() → remote HeadExchange → local OpBatch →
/// remote SyncComplete.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_full_flow_empty_databases() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // 1. Start → produces HeadExchange
    let msg1 = orch.start().await.unwrap();
    assert!(
        matches!(msg1, SyncMessage::HeadExchange { ref heads } if heads.is_empty()),
        "empty DB should produce HeadExchange with no heads"
    );
    assert_eq!(
        orch.session().state,
        SyncState::ExchangingHeads,
        "state should be ExchangingHeads after start"
    );

    // 2. Receive remote HeadExchange (also empty) → produces OpBatch
    let msg2 = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();
    match msg2 {
        Some(SyncMessage::OpBatch { ops, is_last }) => {
            assert!(ops.is_empty(), "no ops to send when both sides are empty");
            assert!(is_last, "single batch should be last");
        }
        other => panic!("expected OpBatch, got {other:?}"),
    }
    assert_eq!(
        orch.session().state,
        SyncState::StreamingOps,
        "state should be StreamingOps after head exchange"
    );

    // 3. Receive remote OpBatch (empty) → applies + merges → SyncComplete
    let msg3 = orch
        .handle_message(SyncMessage::OpBatch {
            ops: vec![],
            is_last: true,
        })
        .await
        .unwrap();
    match msg3 {
        Some(SyncMessage::SyncComplete { .. }) => {}
        other => panic!("expected SyncComplete, got {other:?}"),
    }
    assert_eq!(
        orch.session().state,
        SyncState::Complete,
        "state should be Complete after sync"
    );
    assert!(
        orch.is_complete(),
        "orchestrator should report complete after full flow"
    );

    materializer.shutdown();
}

/// Receiving an Error message transitions to Failed state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_handles_error_message() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    let _start = orch.start().await.unwrap();
    let response = orch
        .handle_message(SyncMessage::Error {
            message: "something broke".into(),
        })
        .await
        .unwrap();
    assert!(response.is_none(), "Error should not produce a response");
    assert_eq!(
        orch.session().state,
        SyncState::Failed("something broke".into()),
        "state should be Failed with the error message"
    );
    assert!(
        !orch.is_complete(),
        "failed orchestrator should not report complete"
    );

    materializer.shutdown();
}

/// Receiving a ResetRequired message transitions to ResetRequired state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_handles_reset_required() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    let _start = orch.start().await.unwrap();
    let response = orch
        .handle_message(SyncMessage::ResetRequired {
            reason: "compacted".into(),
        })
        .await
        .unwrap();
    assert!(
        response.is_none(),
        "ResetRequired should not produce a response"
    );
    assert_eq!(
        orch.session().state,
        SyncState::ResetRequired,
        "state should be ResetRequired after receiving reset message"
    );

    materializer.shutdown();
}

// ── State validation tests ──────────────────────────────────────────

/// Sending OpBatch from Idle (before start()) should fail because
/// Idle is not in the OpBatch-accepted set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_op_batch_before_head_exchange() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // Don't call start() — state is Idle
    let result = orch
        .handle_message(SyncMessage::OpBatch {
            ops: vec![],
            is_last: true,
        })
        .await;

    assert!(result.is_err(), "OpBatch from Idle should be rejected");
    assert_eq!(
        orch.session().state,
        SyncState::Failed("OpBatch received before HeadExchange".into()),
        "state should be Failed with descriptive rejection reason"
    );

    materializer.shutdown();
}

/// Regression test for MAINT-86: `handle_message` must not silently
/// reject stray `SnapshotOffer` messages. The snapshot catch-up
/// sub-flow runs at the daemon layer (`sync_daemon::snapshot_transfer`)
/// after the main loop exits with `ResetRequired`. If `SnapshotOffer`
/// ever reaches `handle_message`, the daemon-layer interception has
/// regressed — surface that as `AppError::InvalidOperation` so the
/// caller cannot paper over the bug.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_snapshot_offer_as_unreachable_protocol_state() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // Drive to ExchangingHeads so state-validation passes SnapshotOffer
    // through and we hit the handler body (not the terminal-state reject).
    let _start = orch.start().await.unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::ExchangingHeads,
        "start() must transition to ExchangingHeads"
    );

    let result = orch
        .handle_message(SyncMessage::SnapshotOffer { size_bytes: 1024 })
        .await;

    let err = match result {
        Err(crate::error::AppError::InvalidOperation(msg)) => msg,
        other => panic!(
            "SnapshotOffer routed through handle_message must return \
             AppError::InvalidOperation — the daemon layer's \
             snapshot_transfer sub-flow is the only reachable path. got: {other:?}"
        ),
    };
    assert!(
        err.contains("SnapshotOffer"),
        "error message must name the offending variant, got: {err}"
    );
    assert!(
        err.contains("snapshot_transfer"),
        "error message must point callers at the daemon sub-flow, got: {err}"
    );

    materializer.shutdown();
}

/// After a full sync completes, sending another HeadExchange should
/// fail because Complete is a terminal state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_messages_in_terminal_state() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // Drive to Complete
    let _start = orch.start().await.unwrap();
    orch.handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();
    orch.handle_message(SyncMessage::OpBatch {
        ops: vec![],
        is_last: true,
    })
    .await
    .unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::Complete,
        "should reach Complete state before terminal test"
    );

    // Now try sending another HeadExchange — should fail
    let result = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await;
    assert!(
        result.is_err(),
        "messages in terminal state should be rejected"
    );

    materializer.shutdown();
}

/// Error messages should be accepted in any non-terminal state,
/// including Idle.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_accepts_error_in_any_state() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // State is Idle — Error should still be accepted
    let result = orch
        .handle_message(SyncMessage::Error {
            message: "test error".into(),
        })
        .await;
    assert!(result.is_ok(), "Error should be accepted in Idle state");
    assert_eq!(
        orch.session().state,
        SyncState::Failed("test error".into()),
        "error in Idle should transition to Failed state"
    );

    materializer.shutdown();
}

// ── Merge coverage tests ────────────────────────────────────────────

/// Device A and B both set_property on same block+key.
/// merge_diverged_blocks should detect and resolve via LWW.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_resolves_property_conflict_lww() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00Z";
    let ts_b = "2025-01-15T12:01:00Z";

    // Create the block first (needed for materializer)
    append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
        .await
        .unwrap();

    // Device A sets property "priority" = "high"
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    // Device B sets property "priority" = "low" (later timestamp)
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("low".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    assert!(
        results.property_lww > 0,
        "should resolve at least one property conflict"
    );

    materializer.shutdown();
}

/// Device A and B both move_block same block.
/// merge_diverged_blocks should detect and resolve via LWW.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_resolves_move_conflict_lww() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00+00:00";
    let ts_b = "2025-01-15T12:01:00+00:00";

    // Create the block and parent blocks
    append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        "device-A",
        test_create_payload("PARENT-A"),
        ts_a.into(),
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        "device-A",
        test_create_payload("PARENT-B"),
        ts_a.into(),
    )
    .await
    .unwrap();

    // Device A moves BLK1 to PARENT-A
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            new_parent_id: Some(BlockId::test_id("PARENT-A")),
            new_position: 0,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    // Device B moves BLK1 to PARENT-B (later timestamp)
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            new_parent_id: Some(BlockId::test_id("PARENT-B")),
            new_position: 1,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    assert!(
        results.move_lww > 0,
        "should resolve at least one move conflict"
    );

    materializer.shutdown();
}

/// Device A deletes a block, Device B edits it.
/// merge_diverged_blocks should resurrect the block (edit wins).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_resurrects_deleted_edited_block() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00+00:00";
    let ts_b = "2025-01-15T12:01:00+00:00";

    // Create the block
    append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
        .await
        .unwrap();

    // Insert the block into the blocks table (needed for deleted_at lookup)
    sqlx::query("INSERT INTO blocks (id, block_type, content, deleted_at) VALUES (?, ?, ?, ?)")
        .bind("BLK1")
        .bind("content")
        .bind("test")
        .bind(ts_a)
        .execute(&pool)
        .await
        .unwrap();

    // Device A deletes the block
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("BLK1"),
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    // Device B edits the block
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            to_text: "updated content".into(),
            prev_edit: None,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    assert!(
        results.delete_edit_resurrect > 0,
        "should resurrect at least one deleted+edited block"
    );

    materializer.shutdown();
}

// ── Idempotent guard tests ──────────────────────────────────────────

/// Calling merge_diverged_blocks twice with no new changes should not
/// create duplicate resolution ops.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_property_idempotent_on_repeated_sync() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00Z";
    let ts_b = "2025-01-15T12:01:00Z"; // B wins

    append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
        .await
        .unwrap();

    // M-43: idempotency guard reads materialized blocks.priority, so the
    // block row must exist. Pre-seed it (the test bypasses the
    // materializer's CreateBlock handler by calling append_local_op_at
    // directly).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', '', NULL, 0)",
    )
    .bind(BlockId::test_id("BLK1").as_str())
    .execute(&pool)
    .await
    .unwrap();

    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("low".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    // First merge — should create one resolution op
    let r1 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();
    assert_eq!(
        r1.property_lww, 1,
        "first merge should resolve 1 property conflict"
    );

    // M-43/M-44: idempotency guard now reads materialized state, so we
    // must let the materializer apply the resolution op before the next
    // merge; otherwise the materialized property/block state lags behind
    // the op_log and the early-exit test would race.
    materializer.flush().await.expect("flush after first merge");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Second merge — idempotent guard should skip
    let r2 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();
    assert_eq!(
        r2.property_lww, 0,
        "second merge should not re-resolve already-resolved property conflict"
    );

    materializer.shutdown();
}

/// Calling merge_diverged_blocks twice for move conflicts should be
/// idempotent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_move_idempotent_on_repeated_sync() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00+00:00";
    let ts_b = "2025-01-15T12:01:00+00:00";

    append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        "device-A",
        test_create_payload("PARENT-A"),
        ts_a.into(),
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        "device-A",
        test_create_payload("PARENT-B"),
        ts_a.into(),
    )
    .await
    .unwrap();

    // M-44: idempotency guard reads materialized blocks.parent_id /
    // blocks.position, so the row must exist (the test bypasses the
    // materializer's CreateBlock handler).
    for id in ["BLK1", "PARENT-A", "PARENT-B"] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BlockId::test_id(id).as_str())
        .execute(&pool)
        .await
        .unwrap();
    }

    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            new_parent_id: Some(BlockId::test_id("PARENT-A")),
            new_position: 0,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            new_parent_id: Some(BlockId::test_id("PARENT-B")),
            new_position: 1,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    let r1 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();
    assert_eq!(r1.move_lww, 1, "first merge should resolve 1 move conflict");

    // M-44: materialized blocks.parent_id/position is what the idempotency
    // guard now reads — flush so the resolution op is applied before re-checking.
    materializer.flush().await.expect("flush after first merge");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let r2 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();
    assert_eq!(
        r2.move_lww, 0,
        "second merge should not re-resolve already-resolved move conflict"
    );

    materializer.shutdown();
}

// ── Batch conflict resolution test ──────────────────────────────────

/// Multiple property conflicts AND a move conflict resolved in one pass
/// via the batch ROW_NUMBER() queries.  Verifies that the batched query
/// approach produces the same results as the former per-conflict N+1
/// queries.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_conflict_resolution_multiple_properties_and_move() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00Z";
    let ts_b = "2025-01-15T12:01:00Z"; // B wins on LWW

    // Create blocks (op_log + materialized rows so M-43/M-44's idempotency
    // guard can read materialized state).
    for blk in &["BLK1", "BLK2", "BLK3", "PARENT-A", "PARENT-B"] {
        append_local_op_at(&pool, "device-A", test_create_payload(blk), ts_a.into())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BlockId::test_id(blk).as_str())
        .execute(&pool)
        .await
        .unwrap();
    }

    // ── 3 property conflicts on 2 different blocks ──────────────────
    // BLK1.priority: A="high" vs B="low"
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("low".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    // BLK1.status: A="todo" vs B="done"
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "status".into(),
            value_text: Some("todo".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "status".into(),
            value_text: Some("done".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    // BLK2.tag: A="work" vs B="personal"
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK2"),
            key: "tag".into(),
            value_text: Some("work".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK2"),
            key: "tag".into(),
            value_text: Some("personal".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    // ── 1 move conflict ─────────────────────────────────────────────
    // BLK3: A moves to PARENT-A, B moves to PARENT-B
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            new_parent_id: Some(BlockId::test_id("PARENT-A")),
            new_position: 0,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            new_parent_id: Some(BlockId::test_id("PARENT-B")),
            new_position: 1,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    // ── Resolve all conflicts in one merge pass ─────────────────────
    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    assert_eq!(
        results.property_lww, 3,
        "should resolve 3 property conflicts in one batch pass"
    );
    assert_eq!(
        results.move_lww, 1,
        "should resolve 1 move conflict in one batch pass"
    );

    // M-43/M-44: flush both foreground (ApplyOp) and background tasks,
    // then settle, so all resolution ops are visibly materialized into
    // block_properties / blocks before the idempotency check re-reads
    // them.  Without the settle, the consumer can still hold an
    // in-flight transaction not yet committed when flush() returns its
    // barrier (the barrier only guarantees the queue drained).
    materializer.flush().await.expect("flush after first merge");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Second merge should be fully idempotent
    let r2 = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();
    assert_eq!(
        r2.property_lww, 0,
        "second merge should skip already-resolved property conflicts"
    );
    assert_eq!(
        r2.move_lww, 0,
        "second merge should skip already-resolved move conflict"
    );

    materializer.shutdown();
}

/// No conflicting ops → all counters zero.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_no_conflicts_returns_zeros() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Only device-A has ops — no conflicts possible
    append_local_op_at(
        &pool,
        "device-A",
        test_create_payload("BLK1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    assert_eq!(
        results.clean_merges, 0,
        "no clean merges expected with single device"
    );
    assert_eq!(
        results.conflicts, 0,
        "no conflicts expected with single device"
    );
    assert_eq!(
        results.already_up_to_date, 0,
        "no already-up-to-date expected with single device"
    );
    assert_eq!(
        results.property_lww, 0,
        "no property LWW expected with single device"
    );
    assert_eq!(
        results.move_lww, 0,
        "no move LWW expected with single device"
    );
    assert_eq!(
        results.delete_edit_resurrect, 0,
        "no resurrections expected with single device"
    );

    materializer.shutdown();
}

/// delete+edit resurrection should not re-fire if block is not deleted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_delete_edit_skips_when_not_deleted() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00+00:00";
    let ts_b = "2025-01-15T12:01:00+00:00";

    append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
        .await
        .unwrap();

    // Block exists in blocks table but is NOT deleted (deleted_at = NULL)
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
        .bind("BLK1")
        .bind("content")
        .bind("test")
        .execute(&pool)
        .await
        .unwrap();

    // Device A has a delete_block op and device B has an edit_block op
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("BLK1"),
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            to_text: "updated content".into(),
            prev_edit: None,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    // Block is not actually deleted in materialized table → should skip
    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    assert_eq!(
        results.delete_edit_resurrect, 0,
        "should NOT resurrect a block that is not deleted in materialized table"
    );

    materializer.shutdown();
}

/// OpBatch received in ExchangingHeads state should be accepted
/// (receiver gets ops right after sending its head exchange).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_accepts_op_batch_in_exchanging_heads() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // start() → ExchangingHeads
    let _start = orch.start().await.unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::ExchangingHeads,
        "state should be ExchangingHeads after start"
    );

    // OpBatch should be accepted in ExchangingHeads
    let result = orch
        .handle_message(SyncMessage::OpBatch {
            ops: vec![],
            is_last: true,
        })
        .await;
    assert!(
        result.is_ok(),
        "OpBatch should be accepted in ExchangingHeads state"
    );

    materializer.shutdown();
}

// ======================================================================
// #454 — apply_remote_ops mixed batch (valid + invalid + duplicate)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_mixed_batch_counts_correctly() {
    // Create ops on a "remote" database so they get valid hashes
    let (remote_pool, _remote_dir) = test_pool().await;
    let op1 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op2 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK2"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let t1: OpTransfer = op1.into();
    let t2: OpTransfer = op2.into();

    // Set up a fresh "local" database
    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    // Pre-insert op1 so it becomes a duplicate when we apply the batch
    apply_remote_ops(&local_pool, &materializer, vec![t1.clone()])
        .await
        .unwrap();

    // Build a bad-hash op: clone a valid transfer and corrupt its hash
    let mut bad_op = t2.clone();
    bad_op.hash = "BADHASH0000000000000000000000000000000000000000000000000000000000".to_string();
    bad_op.seq = 99; // different seq so it's not just a duplicate of t2

    // Batch containing a bad hash should be rejected entirely
    let err = apply_remote_ops(
        &local_pool,
        &materializer,
        vec![t1.clone(), t2.clone(), bad_op],
    )
    .await
    .expect_err("batch with bad hash must be rejected");
    assert!(
        err.to_string().contains("integrity check failed"),
        "error must mention integrity check, got: {err}"
    );

    // A clean batch (no bad hashes) should still work: duplicate + new
    let result = apply_remote_ops(&local_pool, &materializer, vec![t1, t2])
        .await
        .unwrap();
    assert_eq!(
        result.duplicates, 1,
        "op1 already in DB should be duplicate"
    );
    assert_eq!(result.inserted, 1, "op2 should be newly inserted");

    materializer.shutdown();
}

// ======================================================================
// #453 — merge property conflict with equal timestamps (device_id tiebreaker)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_property_conflict_equal_timestamps_uses_device_id_tiebreaker() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Both devices use the exact same timestamp — forces the device_id
    // tiebreaker path in resolve_property_conflict.
    let same_ts = "2025-01-15T12:00:00Z";

    // Create the block (needed for materializer)
    append_local_op_at(&pool, "AAAA", test_create_payload("BLK1"), same_ts.into())
        .await
        .unwrap();
    // M-43: idempotency guard reads materialized blocks.priority.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', '', NULL, 0)",
    )
    .bind(BlockId::test_id("BLK1").as_str())
    .execute(&pool)
    .await
    .unwrap();

    // Device "AAAA" sets property "priority" = "high"
    append_local_op_at(
        &pool,
        "AAAA",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        same_ts.into(),
    )
    .await
    .unwrap();

    // Device "ZZZZ" sets property "priority" = "low" at the SAME timestamp.
    // "ZZZZ" > "AAAA" lexicographically, so ZZZZ's value should win.
    append_local_op_at(
        &pool,
        "ZZZZ",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("low".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        same_ts.into(),
    )
    .await
    .unwrap();

    let results = merge_diverged_blocks(&pool, "AAAA", &materializer, "ZZZZ")
        .await
        .unwrap();

    assert!(
        results.property_lww > 0,
        "should resolve property conflict via device_id tiebreaker when timestamps are equal"
    );

    // M-43: flush so the materializer applies the resolution op before
    // the idempotency check re-reads block_properties.
    materializer.flush().await.expect("flush after first merge");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // A second merge should be idempotent — the resolution already applied
    let r2 = merge_diverged_blocks(&pool, "AAAA", &materializer, "ZZZZ")
        .await
        .unwrap();
    assert_eq!(
        r2.property_lww, 0,
        "second merge should not re-resolve the already-resolved conflict"
    );

    materializer.shutdown();
}

// ======================================================================
// #452 — SyncOrchestrator rejects HeadExchange after already exchanged
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_head_exchange_in_streaming_state() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // start() → ExchangingHeads
    let _start = orch.start().await.unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::ExchangingHeads,
        "state should be ExchangingHeads after start"
    );

    // Receive remote HeadExchange → StreamingOps
    orch.handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::StreamingOps,
        "state should be StreamingOps after head exchange"
    );

    // Send a SECOND HeadExchange in StreamingOps → should fail
    let result = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await;
    assert!(
        result.is_err(),
        "HeadExchange should be rejected in StreamingOps state"
    );
    assert_eq!(
        orch.session().state,
        SyncState::Failed("HeadExchange received in wrong state".into()),
        "state should transition to Failed with descriptive message"
    );

    materializer.shutdown();
}

// ======================================================================
// #618 — is_terminal includes all terminal states
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn is_terminal_includes_all_terminal_states() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Complete → terminal
    let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
    orch.state = SyncState::Complete;
    assert!(orch.is_terminal(), "Complete should be terminal");
    assert!(orch.is_complete(), "Complete should also pass is_complete");

    // Failed → terminal
    let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
    orch.state = SyncState::Failed("err".into());
    assert!(orch.is_terminal(), "Failed should be terminal");
    assert!(!orch.is_complete(), "Failed should not pass is_complete");

    // ResetRequired → terminal
    let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
    orch.state = SyncState::ResetRequired;
    assert!(orch.is_terminal(), "ResetRequired should be terminal");
    assert!(
        !orch.is_complete(),
        "ResetRequired should not pass is_complete"
    );

    // Non-terminal states
    for state in [
        SyncState::Idle,
        SyncState::ExchangingHeads,
        SyncState::StreamingOps,
        SyncState::ApplyingOps,
        SyncState::Merging,
    ] {
        let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
        orch.state = state.clone();
        assert!(!orch.is_terminal(), "{state:?} should NOT be terminal");
    }

    materializer.shutdown();
}

// ======================================================================
// #616 — apply_remote_ops rejects ops with invalid JSON payload
// (M-42 — all-or-nothing batch validation)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_rejects_batch_on_invalid_payload() {
    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    // Build an op with a valid hash but invalid JSON payload.
    // The hash matches the payload (so hash verification passes), but the
    // payload itself is not valid JSON. The whole batch must be rejected.
    let bad_payload_op = OpTransfer {
        device_id: "remote-dev".into(),
        seq: 1,
        parent_seqs: None,
        hash: crate::hash::compute_op_hash(
            "remote-dev",
            1,
            None,
            "create_block",
            "NOT VALID JSON {{{",
        ),
        op_type: "create_block".into(),
        payload: "NOT VALID JSON {{{".into(),
        created_at: FIXED_TS.into(),
    };

    let result = apply_remote_ops(&local_pool, &materializer, vec![bad_payload_op]).await;

    let err = result.expect_err("invalid-JSON-payload batch must be rejected");
    assert!(
        err.to_string().contains("invalid JSON payload"),
        "error must mention invalid JSON payload, got: {err}"
    );

    // Ensure nothing was inserted.
    let ops_in_local = crate::op_log::get_ops_since(&local_pool, "remote-dev", 0)
        .await
        .unwrap();
    assert!(
        ops_in_local.is_empty(),
        "no ops should be inserted from a rejected batch — found {} ops",
        ops_in_local.len()
    );

    materializer.shutdown();
}

// ======================================================================
// M-42 — apply_remote_ops rejects entire batch when middle op has
// malformed payload; none of the surrounding valid ops land in op_log.
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_rejects_batch_when_middle_op_payload_malformed() {
    // Create three ops on a "remote" database so they have valid hashes.
    let (remote_pool, _remote_dir) = test_pool().await;
    let op1 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op2 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK2"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op3 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK3"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let t1: OpTransfer = op1.into();
    let t3: OpTransfer = op3.into();

    // Replace op2 (the MIDDLE op) with one that has a malformed JSON payload
    // but a hash that matches the malformed payload (so it passes hash
    // verification yet still must be rejected as malformed JSON).
    let malformed_payload = "{\"this\": \"is not closed";
    let middle_bad = OpTransfer {
        device_id: op2.device_id.clone(),
        seq: op2.seq,
        parent_seqs: op2.parent_seqs.clone(),
        hash: crate::hash::compute_op_hash(
            &op2.device_id,
            op2.seq,
            op2.parent_seqs.as_deref(),
            &op2.op_type,
            malformed_payload,
        ),
        op_type: op2.op_type.clone(),
        payload: malformed_payload.into(),
        created_at: op2.created_at.clone(),
    };

    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    let result = apply_remote_ops(&local_pool, &materializer, vec![t1, middle_bad, t3]).await;

    let err = result.expect_err("batch with middle malformed op must be rejected");
    assert!(
        err.to_string().contains("invalid JSON payload"),
        "error must mention invalid JSON payload, got: {err}"
    );

    // None of the three ops should have landed in op_log.
    let ops_in_local = crate::op_log::get_ops_since(&local_pool, "remote-dev", 0)
        .await
        .unwrap();
    assert!(
        ops_in_local.is_empty(),
        "no ops from a rejected batch should be in op_log — found {} ops",
        ops_in_local.len()
    );

    materializer.shutdown();
}

// ======================================================================
// M-42 (R1 follow-up) — apply_remote_ops rejects entire batch when the
// FIRST op has a malformed payload; none of the trailing valid ops land.
// Pins the position-independent rejection invariant at the head of the
// batch (companion to the middle- and last-position tests).
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_rejects_batch_when_first_op_payload_malformed() {
    // Create three ops on a "remote" database so they have valid hashes.
    let (remote_pool, _remote_dir) = test_pool().await;
    let op1 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op2 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK2"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op3 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK3"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let t2: OpTransfer = op2.into();
    let t3: OpTransfer = op3.into();

    // Replace op1 (the FIRST op) with one that has a malformed JSON payload
    // but a hash that matches the malformed payload (so it passes hash
    // verification yet still must be rejected as malformed JSON).
    let malformed_payload = "{\"this\": \"is not closed";
    let first_bad = OpTransfer {
        device_id: op1.device_id.clone(),
        seq: op1.seq,
        parent_seqs: op1.parent_seqs.clone(),
        hash: crate::hash::compute_op_hash(
            &op1.device_id,
            op1.seq,
            op1.parent_seqs.as_deref(),
            &op1.op_type,
            malformed_payload,
        ),
        op_type: op1.op_type.clone(),
        payload: malformed_payload.into(),
        created_at: op1.created_at.clone(),
    };

    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    let result = apply_remote_ops(&local_pool, &materializer, vec![first_bad, t2, t3]).await;

    let err = result.expect_err("batch with first malformed op must be rejected");
    assert!(
        err.to_string().contains("invalid JSON payload"),
        "error must mention invalid JSON payload, got: {err}"
    );

    // None of the three ops should have landed in op_log.
    let ops_in_local = crate::op_log::get_ops_since(&local_pool, "remote-dev", 0)
        .await
        .unwrap();
    assert!(
        ops_in_local.is_empty(),
        "no ops from a rejected batch should be in op_log — found {} ops",
        ops_in_local.len()
    );

    materializer.shutdown();
}

// ======================================================================
// M-42 (R1 follow-up) — apply_remote_ops rejects entire batch when the
// LAST op has a malformed payload; none of the leading valid ops land.
// Pins the position-independent rejection invariant at the tail of the
// batch (companion to the first- and middle-position tests).
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_rejects_batch_when_last_op_payload_malformed() {
    // Create three ops on a "remote" database so they have valid hashes.
    let (remote_pool, _remote_dir) = test_pool().await;
    let op1 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op2 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK2"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op3 = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK3"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let t1: OpTransfer = op1.into();
    let t2: OpTransfer = op2.into();

    // Replace op3 (the LAST op) with one that has a malformed JSON payload
    // but a hash that matches the malformed payload (so it passes hash
    // verification yet still must be rejected as malformed JSON).
    let malformed_payload = "{\"this\": \"is not closed";
    let last_bad = OpTransfer {
        device_id: op3.device_id.clone(),
        seq: op3.seq,
        parent_seqs: op3.parent_seqs.clone(),
        hash: crate::hash::compute_op_hash(
            &op3.device_id,
            op3.seq,
            op3.parent_seqs.as_deref(),
            &op3.op_type,
            malformed_payload,
        ),
        op_type: op3.op_type.clone(),
        payload: malformed_payload.into(),
        created_at: op3.created_at.clone(),
    };

    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    let result = apply_remote_ops(&local_pool, &materializer, vec![t1, t2, last_bad]).await;

    let err = result.expect_err("batch with last malformed op must be rejected");
    assert!(
        err.to_string().contains("invalid JSON payload"),
        "error must mention invalid JSON payload, got: {err}"
    );

    // None of the three ops should have landed in op_log.
    let ops_in_local = crate::op_log::get_ops_since(&local_pool, "remote-dev", 0)
        .await
        .unwrap();
    assert!(
        ops_in_local.is_empty(),
        "no ops from a rejected batch should be in op_log — found {} ops",
        ops_in_local.len()
    );

    materializer.shutdown();
}

// ======================================================================
// #614 — orchestrator rejects HeadExchange with unexpected peer device_id
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_unexpected_peer_device_id() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone())
        .with_expected_remote_id("expected-peer".into());

    let _start = orch.start().await.unwrap();

    // Send HeadExchange with a different device_id than expected
    let result = orch
        .handle_message(SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "wrong-peer".into(),
                seq: 1,
                hash: "abc".into(),
            }],
        })
        .await;

    assert!(
        result.is_err(),
        "mismatched peer device_id should be rejected"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("peer device_id mismatch"),
        "error should mention mismatch, got: {err_msg}"
    );
    assert_eq!(
        orch.session().state,
        SyncState::Failed("peer device_id mismatch: expected expected-peer, got wrong-peer".into()),
        "state should be Failed with peer mismatch details"
    );

    materializer.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_accepts_matching_peer_device_id() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone())
        .with_expected_remote_id("expected-peer".into());

    let _start = orch.start().await.unwrap();

    // Send HeadExchange with the correct device_id
    let result = orch
        .handle_message(SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "expected-peer".into(),
                seq: 1,
                hash: "abc".into(),
            }],
        })
        .await;

    assert!(result.is_ok(), "matching peer device_id should be accepted");

    materializer.shutdown();
}

// ======================================================================
// BUG-27 — orchestrator refuses to record sync with empty peer_id
// ======================================================================

/// If a HeadExchange only contains the local device_id (peer never
/// originated ops of its own) or is empty, `remote_device_id` ends up
/// empty. Previously the `SyncComplete` handler silently fell through
/// with `peer_id = ""`, which created a bogus empty-string row in
/// `peer_refs` and `peer_sync_state`, permanently corrupting the
/// per-peer sync bookkeeping.
///
/// The orchestrator must now transition to `Failed` at `SyncComplete`
/// when `remote_device_id` was never identified — both reset-required
/// and streaming-ops earlier paths remain unchanged because they do not
/// touch peer bookkeeping.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_sync_complete_with_empty_peer_id() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Seed one local op so the remote's claim `(local-dev, seq=1)` passes
    // `check_reset_required` — we want to drive forward into `StreamingOps`,
    // not divert into `ResetRequired`.
    append_local_op_at(
        &pool,
        "local-dev",
        test_create_payload("SEED_BLK"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let mut orch = SyncOrchestrator::new(pool.clone(), "local-dev".into(), materializer.clone());
    let _start = orch.start().await.unwrap();

    // Peer advertises ONLY our own device_id — no non-local head, so
    // `remote_device_id` never gets populated with a real peer identity.
    // Drive forward through the (non-reset) head-exchange path.
    let after_head = orch
        .handle_message(SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "local-dev".into(),
                seq: 1,
                hash: "abc".into(),
            }],
        })
        .await
        .unwrap();
    assert!(
        matches!(after_head, Some(SyncMessage::OpBatch { .. })),
        "HeadExchange with only local device_id still proceeds (it only becomes \
         fatal once we'd record the sync), got: {after_head:?}"
    );
    assert_eq!(
        orch.session().state,
        SyncState::StreamingOps,
        "must be in StreamingOps before SyncComplete arrives"
    );
    assert_eq!(
        orch.session().remote_device_id,
        "",
        "remote_device_id stays empty because no non-local head was advertised"
    );

    // Now simulate the peer echoing SyncComplete back — at this point
    // we'd call `peer_refs::upsert_peer_ref("")`, corrupting bookkeeping.
    let result = orch
        .handle_message(SyncMessage::SyncComplete {
            last_hash: "some-hash".into(),
        })
        .await;

    assert!(
        result.is_err(),
        "SyncComplete with empty remote_device_id must be rejected, got: {result:?}"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("empty peer_id") || err_msg.contains("device_id was never identified"),
        "error should mention the empty peer_id, got: {err_msg}"
    );
    assert!(
        matches!(orch.session().state, SyncState::Failed(ref m) if m.contains("empty peer_id")),
        "state must transition to Failed with a descriptive message, got: {:?}",
        orch.session().state
    );

    // Crucially: no peer_refs row was created with an empty key.
    let empty_peer_rows: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM peer_refs WHERE peer_id = ''")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        empty_peer_rows, 0,
        "BUG-27: no peer_refs row must be created with an empty peer_id"
    );

    materializer.shutdown();
}

// ======================================================================
// #615 — Responder-mode: orchestrator handles HeadExchange in Idle state
// ======================================================================

/// Responder mode: receiving HeadExchange in Idle state (without calling
/// `start()`) should work — the orchestrator computes ops to send and
/// returns an OpBatch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_responder_handles_head_exchange_in_idle() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Add some local ops so the responder has data to offer
    for i in 1..=2 {
        append_local_op_at(
            &pool,
            "responder-dev",
            test_create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let mut orch = SyncOrchestrator::new(pool, "responder-dev".into(), materializer.clone());

    // Do NOT call start() — this is responder mode.
    // Initiator has no ops → sends empty heads.
    let response = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();

    // Should respond with OpBatch containing our local ops
    assert!(response.is_some(), "responder should send OpBatch");
    match response.unwrap() {
        SyncMessage::OpBatch { ops, is_last } => {
            assert!(is_last, "single batch should be marked last");
            assert_eq!(ops.len(), 2, "should send 2 local ops to initiator");
        }
        other => panic!("expected OpBatch, got {other:?}"),
    }

    // State should be StreamingOps (waiting for initiator's SyncComplete)
    assert_eq!(
        orch.session().state,
        SyncState::StreamingOps,
        "responder should be in StreamingOps after sending OpBatch"
    );
    assert!(
        !orch.is_terminal(),
        "responder should not be terminal while waiting for initiator"
    );

    materializer.shutdown();
}

/// Responder mode full flow: receive HeadExchange → send OpBatch →
/// receive SyncComplete → done, without ever calling `start()`.
///
/// The protocol is one-directional per session: the responder sends
/// its ops to the initiator (via OpBatch), and the initiator replies
/// with SyncComplete.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_responder_full_flow() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // BUG-27: Responder needs the initiator's device_id to record the sync
    // without silently writing an empty peer_id. In production this comes
    // from the mTLS/mDNS peer identity; here we supply it explicitly.
    let mut orch = SyncOrchestrator::new(pool, "responder-dev".into(), materializer.clone())
        .with_expected_remote_id("initiator-dev".into());

    // 1. Receive HeadExchange from initiator (empty) → respond with OpBatch
    let resp1 = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();
    assert!(
        matches!(resp1, Some(SyncMessage::OpBatch { .. })),
        "first response should be OpBatch"
    );
    assert_eq!(
        orch.session().state,
        SyncState::StreamingOps,
        "responder should be in StreamingOps after OpBatch reply"
    );

    // 2. Receive SyncComplete from initiator → record sync → done
    let resp2 = orch
        .handle_message(SyncMessage::SyncComplete {
            last_hash: String::new(),
        })
        .await
        .unwrap();
    assert!(
        resp2.is_none(),
        "SyncComplete should not produce a response"
    );

    assert!(
        orch.is_complete(),
        "responder should be complete after receiving SyncComplete"
    );
    assert!(
        orch.is_terminal(),
        "responder should be terminal after full flow"
    );

    materializer.shutdown();
}

// ======================================================================
// L-70 — SyncComplete records the LAST sent op's hash, not the first
// ======================================================================

/// Drive the orchestrator through a multi-op send and assert that
/// `peer_refs.last_sent_hash` ends up equal to the *last* op's hash —
/// not the first or any middle op. Locks the L-70 invariant: the
/// orchestrator no longer buffers every outgoing `OpRecord`, only the
/// hash of the last one. A future maintainer who reverts the read site
/// to `pending_ops_to_send.first()` (or any non-last index) gets a
/// targeted failure here naming the invariant.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_complete_records_last_sent_op_hash() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Three local ops so first/middle/last are all distinguishable.
    let op1 = append_local_op_at(
        &pool,
        "responder-dev",
        test_create_payload("BLK1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    // Middle op exists in the chain but its hash is not asserted on;
    // the only point of writing it is to make sure op3 isn't also op1's
    // immediate successor (so a buggy `first()` read can't accidentally
    // match the last hash).
    let _op2 = append_local_op_at(
        &pool,
        "responder-dev",
        test_create_payload("BLK2"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let op3 = append_local_op_at(
        &pool,
        "responder-dev",
        test_create_payload("BLK3"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    assert_ne!(op1.hash, op3.hash, "test setup: hashes must differ");

    let mut orch =
        SyncOrchestrator::new(pool.clone(), "responder-dev".into(), materializer.clone())
            .with_expected_remote_id("initiator-dev".into());

    // Responder mode: receive an empty HeadExchange so the orchestrator
    // computes all 3 ops as outgoing and captures the last-sent hash.
    orch.handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();
    assert_eq!(
        orch.session().ops_sent,
        3,
        "all 3 local ops should be queued as outgoing"
    );

    // Receive SyncComplete from the (simulated) initiator → orchestrator
    // writes `last_sent_hash` to peer_refs.
    orch.handle_message(SyncMessage::SyncComplete {
        last_hash: String::new(),
    })
    .await
    .unwrap();
    assert!(orch.is_complete(), "session should be Complete");

    let peer = crate::peer_refs::get_peer_ref(&pool, "initiator-dev")
        .await
        .unwrap()
        .expect("peer_refs row must exist after SyncComplete");
    assert_eq!(
        peer.last_sent_hash.as_deref(),
        Some(op3.hash.as_str()),
        "L-70: last_sent_hash must be the LAST sent op's hash, not the first or middle"
    );
    assert_ne!(
        peer.last_sent_hash.as_deref(),
        Some(op1.hash.as_str()),
        "L-70: last_sent_hash must NOT be the first op's hash"
    );

    materializer.shutdown();
}

// ======================================================================
// #620 — OpBatch streaming for large op logs
// ======================================================================

/// 2500 ops → 3 batches (1000, 1000, 500) with correct is_last flags.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opbatch_streaming_sends_in_chunks() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Insert 2500 ops on "sender-dev"
    for i in 1..=2500 {
        append_local_op_at(
            &pool,
            "sender-dev",
            test_create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let mut orch = SyncOrchestrator::new(pool, "sender-dev".into(), materializer.clone());

    // Remote peer has no heads → should send all 2500 ops
    let first_msg = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();

    // First batch: 1000 ops, is_last = false
    let (batch1_ops, batch1_last) = match first_msg {
        Some(SyncMessage::OpBatch { ops, is_last }) => (ops, is_last),
        other => panic!("expected OpBatch, got {other:?}"),
    };
    assert_eq!(batch1_ops.len(), 1000, "first batch should have 1000 ops");
    assert!(!batch1_last, "first batch should NOT be last");

    // Second batch: 1000 ops, is_last = false
    let second_msg = orch.next_message();
    let (batch2_ops, batch2_last) = match second_msg {
        Some(SyncMessage::OpBatch { ops, is_last }) => (ops, is_last),
        other => panic!("expected OpBatch, got {other:?}"),
    };
    assert_eq!(batch2_ops.len(), 1000, "second batch should have 1000 ops");
    assert!(!batch2_last, "second batch should NOT be last");

    // Third batch: 500 ops, is_last = true
    let third_msg = orch.next_message();
    let (batch3_ops, batch3_last) = match third_msg {
        Some(SyncMessage::OpBatch { ops, is_last }) => (ops, is_last),
        other => panic!("expected OpBatch, got {other:?}"),
    };
    assert_eq!(batch3_ops.len(), 500, "third batch should have 500 ops");
    assert!(batch3_last, "third batch SHOULD be last");

    // No more batches
    assert!(
        orch.next_message().is_none(),
        "no more batches after final chunk"
    );

    // Total ops sent should be 2500
    assert_eq!(
        orch.session().ops_sent,
        2500,
        "total ops sent should be 2500"
    );

    materializer.shutdown();
}

/// 500 ops → 1 batch with is_last = true (no chunking needed).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opbatch_streaming_single_batch_for_small_logs() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Insert 500 ops
    for i in 1..=500 {
        append_local_op_at(
            &pool,
            "sender-dev",
            test_create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
    }

    let mut orch = SyncOrchestrator::new(pool, "sender-dev".into(), materializer.clone());

    let first_msg = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();

    match first_msg {
        Some(SyncMessage::OpBatch { ops, is_last }) => {
            assert_eq!(ops.len(), 500, "single batch should have all 500 ops");
            assert!(is_last, "single batch should be marked last");
        }
        other => panic!("expected OpBatch, got {other:?}"),
    }

    // No pending batches
    assert!(
        orch.next_message().is_none(),
        "no more batches for small log"
    );

    assert_eq!(orch.session().ops_sent, 500, "total ops sent should be 500");

    materializer.shutdown();
}

/// Receiver accumulates ops from multiple batches then applies all at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn receiver_accumulates_multi_batch_ops() {
    // Create ops on a "remote" database so they have valid hashes
    let (remote_pool, _remote_dir) = test_pool().await;
    let mut all_transfers = Vec::new();
    for i in 1..=5 {
        let record = append_local_op_at(
            &remote_pool,
            "remote-dev",
            test_create_payload(&format!("BLK{i}")),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        all_transfers.push(OpTransfer::from(record));
    }

    // Set up a receiver orchestrator
    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());
    let mut orch =
        SyncOrchestrator::new(local_pool.clone(), "local-dev".into(), materializer.clone());

    // Drive to ExchangingHeads state
    let _start = orch.start().await.unwrap();

    // Send first batch (3 ops) with is_last = false
    let batch1: Vec<OpTransfer> = all_transfers[..3].to_vec();
    let resp1 = orch
        .handle_message(SyncMessage::OpBatch {
            ops: batch1,
            is_last: false,
        })
        .await
        .unwrap();
    assert!(
        resp1.is_none(),
        "intermediate batch should not produce a response"
    );

    // Send second batch (2 ops) with is_last = true
    let batch2: Vec<OpTransfer> = all_transfers[3..].to_vec();
    let resp2 = orch
        .handle_message(SyncMessage::OpBatch {
            ops: batch2,
            is_last: true,
        })
        .await
        .unwrap();

    // Should produce SyncComplete after applying all 5 ops
    assert!(
        matches!(resp2, Some(SyncMessage::SyncComplete { .. })),
        "final batch should trigger apply + merge + SyncComplete"
    );
    assert_eq!(
        orch.session().ops_received,
        5,
        "all 5 ops should be counted as received"
    );
    assert!(
        orch.is_complete(),
        "orchestrator should be complete after receiving all batches"
    );

    // Verify ops were actually inserted into the local database
    let local_ops = op_log::get_ops_since(&local_pool, "remote-dev", 0)
        .await
        .unwrap();
    assert_eq!(
        local_ops.len(),
        5,
        "all 5 remote ops should be in local op log"
    );

    materializer.shutdown();
}

// ======================================================================
// F-21 — LWW auto-resolve property/move conflicts
// ======================================================================

/// Device A sets a property at t=1, device B sets the same property at
/// t=2. After merge, B's value wins via LWW and no conflict copy is
/// created in the blocks table.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lww_resolves_property_conflict_by_timestamp() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00Z"; // earlier
    let ts_b = "2025-01-15T12:01:00Z"; // later — B wins

    // Create the block
    append_local_op_at(&pool, "device-A", test_create_payload("BLK1"), ts_a.into())
        .await
        .unwrap();

    // Device A sets property "priority" = "high" at t=1
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    // Device B sets property "priority" = "low" at t=2 (later)
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK1"),
            key: "priority".into(),
            value_text: Some("low".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    // Property conflict resolved via LWW
    assert_eq!(
        results.property_lww, 1,
        "should resolve 1 property conflict via LWW"
    );

    // B's value should win — verify the resolution op has B's value
    let resolution_ops: Vec<crate::op_log::OpRecord> =
        crate::op_log::get_ops_since(&pool, "device-A", 0)
            .await
            .unwrap();
    let last_set_prop = resolution_ops
        .iter()
        .rev()
        .find(|op| op.op_type == "set_property")
        .expect("should have a resolution set_property op");
    let winner_payload: SetPropertyPayload = serde_json::from_str(&last_set_prop.payload).unwrap();
    assert_eq!(
        winner_payload.value_text.as_deref(),
        Some("low"),
        "device B's value (later timestamp) should win"
    );

    // No conflict copy blocks should exist
    let conflict_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM blocks WHERE is_conflict = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        conflict_count.0, 0,
        "LWW property resolution must not create conflict copies"
    );

    materializer.shutdown();
}

/// Device A moves a block at t=1, device B moves the same block at t=2.
/// After merge, B's move wins via LWW.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lww_resolves_move_conflict_by_timestamp() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00Z"; // earlier
    let ts_b = "2025-01-15T12:01:00Z"; // later — B wins

    // Create blocks
    for blk in &["BLK1", "PARENT-A", "PARENT-B"] {
        append_local_op_at(&pool, "device-A", test_create_payload(blk), ts_a.into())
            .await
            .unwrap();
    }

    // Device A moves BLK1 to PARENT-A at t=1
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            new_parent_id: Some(BlockId::test_id("PARENT-A")),
            new_position: 0,
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    // Device B moves BLK1 to PARENT-B at t=2 (later)
    append_local_op_at(
        &pool,
        "device-B",
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            new_parent_id: Some(BlockId::test_id("PARENT-B")),
            new_position: 1,
        }),
        ts_b.into(),
    )
    .await
    .unwrap();

    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    // Move conflict resolved via LWW
    assert_eq!(
        results.move_lww, 1,
        "should resolve 1 move conflict via LWW"
    );

    // B's move should win — verify the resolution op has B's parent+position
    let resolution_ops: Vec<crate::op_log::OpRecord> =
        crate::op_log::get_ops_since(&pool, "device-A", 0)
            .await
            .unwrap();
    let last_move = resolution_ops
        .iter()
        .rev()
        .find(|op| op.op_type == "move_block")
        .expect("should have a resolution move_block op");
    let winner_payload: MoveBlockPayload = serde_json::from_str(&last_move.payload).unwrap();
    assert_eq!(
        winner_payload
            .new_parent_id
            .as_ref()
            .map(super::super::ulid::BlockId::as_str),
        Some("PARENT-B"),
        "device B's move (later timestamp) should win"
    );
    assert_eq!(
        winner_payload.new_position, 1,
        "device B's position should win"
    );

    materializer.shutdown();
}

/// Text edit conflicts (`edit_block`) should still produce conflict copy
/// blocks — LWW auto-resolution only applies to property and move ops.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn text_edit_conflict_still_creates_copy() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let ts_a = "2025-01-15T12:00:00Z";
    let ts_b = "2025-01-15T12:01:00Z";

    // Create the block with initial content (single line → concurrent
    // edits to the same line will conflict in diffy).
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "original content".into(),
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    // Insert the block into the blocks table (needed for create_conflict_copy)
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
         VALUES (?, ?, ?, ?)",
    )
    .bind("BLK1")
    .bind("content")
    .bind("original content")
    .bind(0)
    .execute(&pool)
    .await
    .unwrap();

    // Device A edits the block — single-line edit
    append_local_op_at(
        &pool,
        "device-A",
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            to_text: "device A changed this".into(),
            prev_edit: Some(("device-A".into(), 1)),
        }),
        ts_a.into(),
    )
    .await
    .unwrap();

    // Device B edits the block — different single-line edit, prev_edit
    // points to the same create op → diverges from device A's edit.
    let b_payload = serde_json::json!({
        "block_id": "BLK1",
        "to_text": "device B changed this",
        "prev_edit": ["device-A", 1]
    })
    .to_string();
    let b_record = crate::op_log::OpRecord {
        device_id: "device-B".into(),
        seq: 1,
        parent_seqs: None,
        hash: crate::hash::compute_op_hash("device-B", 1, None, "edit_block", &b_payload),
        op_type: "edit_block".into(),
        payload: b_payload,
        created_at: ts_b.into(),
    };
    crate::dag::insert_remote_op(&pool, &b_record)
        .await
        .unwrap();

    let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
        .await
        .unwrap();

    // Text conflict should produce a conflict copy (NOT LWW)
    assert_eq!(
        results.conflicts, 1,
        "text edit conflict should still create a conflict copy"
    );
    assert_eq!(
        results.property_lww, 0,
        "no property LWW should occur for text conflicts"
    );
    assert_eq!(
        results.move_lww, 0,
        "no move LWW should occur for text conflicts"
    );

    // Verify a conflict copy block was created in the blocks table
    let conflict_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM blocks WHERE is_conflict = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        conflict_count.0 > 0,
        "text edit conflict must create a conflict copy block"
    );

    materializer.shutdown();
}

// ======================================================================
// Message serialization round-trip tests
// ======================================================================

// ── DeviceHead serde roundtrip ──────────────────────────────────────

#[test]
fn serde_roundtrip_device_head() {
    let head = DeviceHead {
        device_id: "device-A".into(),
        seq: 42,
        hash: "abc123def456".into(),
    };
    let json = serde_json::to_string(&head).expect("DeviceHead serialization must succeed");
    let deser: DeviceHead =
        serde_json::from_str(&json).expect("DeviceHead deserialization must succeed");
    assert_eq!(deser, head, "DeviceHead must survive serde roundtrip");
}

// ── OpTransfer serde roundtrip ──────────────────────────────────────

#[test]
fn serde_roundtrip_op_transfer() {
    let transfer = OpTransfer {
        device_id: "dev-X".into(),
        seq: 7,
        parent_seqs: Some("5,6".into()),
        hash: "fedcba987654".into(),
        op_type: "edit_block".into(),
        payload: r#"{"block_id":"BLK1","to_text":"hello"}"#.into(),
        created_at: "2025-01-15T12:00:00+00:00".into(),
    };
    let json = serde_json::to_string(&transfer).expect("OpTransfer serialization must succeed");
    let deser: OpTransfer =
        serde_json::from_str(&json).expect("OpTransfer deserialization must succeed");
    assert_eq!(deser, transfer, "OpTransfer must survive serde roundtrip");
}

#[test]
fn serde_roundtrip_op_transfer_null_parent_seqs() {
    let transfer = OpTransfer {
        device_id: "dev-Y".into(),
        seq: 1,
        parent_seqs: None,
        hash: "0000000000".into(),
        op_type: "create_block".into(),
        payload: "{}".into(),
        created_at: "2025-01-01T00:00:00Z".into(),
    };
    let json = serde_json::to_string(&transfer)
        .expect("OpTransfer with null parent_seqs serialization must succeed");
    let deser: OpTransfer = serde_json::from_str(&json)
        .expect("OpTransfer with null parent_seqs deserialization must succeed");
    assert_eq!(
        deser, transfer,
        "OpTransfer with null parent_seqs must survive serde roundtrip"
    );
}

// ── SyncMessage individual variant roundtrips ────────────────────────

#[test]
fn serde_roundtrip_sync_message_head_exchange() {
    let msg = SyncMessage::HeadExchange {
        heads: vec![
            DeviceHead {
                device_id: "A".into(),
                seq: 1,
                hash: "h1".into(),
            },
            DeviceHead {
                device_id: "B".into(),
                seq: 5,
                hash: "h5".into(),
            },
        ],
    };
    let json = serde_json::to_string(&msg).expect("serialize HeadExchange");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize HeadExchange");
    assert_eq!(deser, msg, "HeadExchange must survive serde roundtrip");
}

#[test]
fn serde_roundtrip_sync_message_op_batch() {
    let msg = SyncMessage::OpBatch {
        ops: vec![OpTransfer {
            device_id: "A".into(),
            seq: 1,
            parent_seqs: None,
            hash: "h1".into(),
            op_type: "create_block".into(),
            payload: r#"{"block_id":"BLK1"}"#.into(),
            created_at: "2025-01-01T00:00:00Z".into(),
        }],
        is_last: false,
    };
    let json = serde_json::to_string(&msg).expect("serialize OpBatch");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize OpBatch");
    assert_eq!(deser, msg, "OpBatch must survive serde roundtrip");
}

#[test]
fn serde_roundtrip_sync_message_reset_required() {
    let msg = SyncMessage::ResetRequired {
        reason: "op log compacted".into(),
    };
    let json = serde_json::to_string(&msg).expect("serialize ResetRequired");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize ResetRequired");
    assert_eq!(deser, msg, "ResetRequired must survive serde roundtrip");
}

#[test]
fn serde_roundtrip_sync_message_snapshot_offer() {
    let msg = SyncMessage::SnapshotOffer {
        size_bytes: 1_048_576,
    };
    let json = serde_json::to_string(&msg).expect("serialize SnapshotOffer");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize SnapshotOffer");
    assert_eq!(deser, msg, "SnapshotOffer must survive serde roundtrip");
}

#[test]
fn serde_roundtrip_sync_message_snapshot_accept() {
    let msg = SyncMessage::SnapshotAccept;
    let json = serde_json::to_string(&msg).expect("serialize SnapshotAccept");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize SnapshotAccept");
    assert_eq!(deser, msg, "SnapshotAccept must survive serde roundtrip");
}

#[test]
fn serde_roundtrip_sync_message_snapshot_reject() {
    let msg = SyncMessage::SnapshotReject;
    let json = serde_json::to_string(&msg).expect("serialize SnapshotReject");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize SnapshotReject");
    assert_eq!(deser, msg, "SnapshotReject must survive serde roundtrip");
}

#[test]
fn serde_roundtrip_sync_message_sync_complete() {
    let msg = SyncMessage::SyncComplete {
        last_hash: "deadbeef".into(),
    };
    let json = serde_json::to_string(&msg).expect("serialize SyncComplete");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize SyncComplete");
    assert_eq!(deser, msg, "SyncComplete must survive serde roundtrip");
}

#[test]
fn serde_roundtrip_sync_message_error() {
    let msg = SyncMessage::Error {
        message: "peer disconnected unexpectedly".into(),
    };
    let json = serde_json::to_string(&msg).expect("serialize Error");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize Error");
    assert_eq!(deser, msg, "Error must survive serde roundtrip");
}

// ── Known JSON shape — wire format stability ────────────────────────

#[test]
fn json_shape_head_exchange_matches_wire_format() {
    let msg = SyncMessage::HeadExchange {
        heads: vec![DeviceHead {
            device_id: "dev-A".into(),
            seq: 3,
            hash: "abc".into(),
        }],
    };
    let json: serde_json::Value =
        serde_json::to_value(&msg).expect("SyncMessage must serialize to Value");

    assert_eq!(
        json["type"], "HeadExchange",
        "HeadExchange must use internally-tagged 'type' field"
    );
    assert!(
        json["heads"].is_array(),
        "HeadExchange must have 'heads' array"
    );
    let head = &json["heads"][0];
    assert_eq!(head["device_id"], "dev-A", "head device_id must match");
    assert_eq!(head["seq"], 3, "head seq must match");
    assert_eq!(head["hash"], "abc", "head hash must match");
}

#[test]
fn json_shape_op_batch_matches_wire_format() {
    let msg = SyncMessage::OpBatch {
        ops: vec![OpTransfer {
            device_id: "dev-B".into(),
            seq: 1,
            parent_seqs: Some("0".into()),
            hash: "h1".into(),
            op_type: "create_block".into(),
            payload: r#"{"block_id":"BLK1"}"#.into(),
            created_at: "2025-06-01T00:00:00Z".into(),
        }],
        is_last: true,
    };
    let json: serde_json::Value =
        serde_json::to_value(&msg).expect("SyncMessage must serialize to Value");

    assert_eq!(
        json["type"], "OpBatch",
        "OpBatch must use internally-tagged 'type' field"
    );
    assert!(json["ops"].is_array(), "OpBatch must have 'ops' array");
    assert_eq!(json["is_last"], true, "is_last must be a boolean true");
    let op = &json["ops"][0];
    assert_eq!(op["device_id"], "dev-B", "op device_id must match");
    assert_eq!(op["seq"], 1, "op seq must match");
    assert_eq!(op["parent_seqs"], "0", "op parent_seqs must match");
    assert_eq!(op["hash"], "h1", "op hash must match");
    assert_eq!(op["op_type"], "create_block", "op op_type must match");
    assert_eq!(
        op["created_at"], "2025-06-01T00:00:00Z",
        "op created_at must match"
    );
}

#[test]
fn json_shape_all_variants_have_type_tag() {
    let variants: Vec<(&str, SyncMessage)> = vec![
        ("HeadExchange", SyncMessage::HeadExchange { heads: vec![] }),
        (
            "OpBatch",
            SyncMessage::OpBatch {
                ops: vec![],
                is_last: true,
            },
        ),
        (
            "ResetRequired",
            SyncMessage::ResetRequired { reason: "r".into() },
        ),
        (
            "SnapshotOffer",
            SyncMessage::SnapshotOffer { size_bytes: 0 },
        ),
        ("SnapshotAccept", SyncMessage::SnapshotAccept),
        ("SnapshotReject", SyncMessage::SnapshotReject),
        (
            "SyncComplete",
            SyncMessage::SyncComplete {
                last_hash: "h".into(),
            },
        ),
        (
            "Error",
            SyncMessage::Error {
                message: "e".into(),
            },
        ),
    ];

    for (expected_tag, msg) in &variants {
        let json: serde_json::Value = serde_json::to_value(msg)
            .unwrap_or_else(|e| panic!("serialize {expected_tag} failed: {e}"));
        assert_eq!(
            json["type"].as_str().unwrap_or("MISSING"),
            *expected_tag,
            "variant {expected_tag} must have correct 'type' tag in JSON"
        );
    }
}

#[test]
fn json_shape_snapshot_offer_has_size_bytes() {
    let msg = SyncMessage::SnapshotOffer {
        size_bytes: 999_999,
    };
    let json: serde_json::Value = serde_json::to_value(&msg).expect("serialize SnapshotOffer");
    assert_eq!(
        json["type"], "SnapshotOffer",
        "SnapshotOffer must have correct type tag"
    );
    assert_eq!(
        json["size_bytes"], 999_999,
        "SnapshotOffer must contain size_bytes field"
    );
}

#[test]
fn json_shape_sync_complete_has_last_hash() {
    let msg = SyncMessage::SyncComplete {
        last_hash: "xyz789".into(),
    };
    let json: serde_json::Value = serde_json::to_value(&msg).expect("serialize SyncComplete");
    assert_eq!(
        json["type"], "SyncComplete",
        "SyncComplete must have correct type tag"
    );
    assert_eq!(
        json["last_hash"], "xyz789",
        "SyncComplete must contain last_hash field"
    );
}

#[test]
fn json_shape_error_has_message() {
    let msg = SyncMessage::Error {
        message: "something broke".into(),
    };
    let json: serde_json::Value = serde_json::to_value(&msg).expect("serialize Error");
    assert_eq!(json["type"], "Error", "Error must have correct type tag");
    assert_eq!(
        json["message"], "something broke",
        "Error must contain message field"
    );
}

#[test]
fn json_shape_reset_required_has_reason() {
    let msg = SyncMessage::ResetRequired {
        reason: "compacted".into(),
    };
    let json: serde_json::Value = serde_json::to_value(&msg).expect("serialize ResetRequired");
    assert_eq!(
        json["type"], "ResetRequired",
        "ResetRequired must have correct type tag"
    );
    assert_eq!(
        json["reason"], "compacted",
        "ResetRequired must contain reason field"
    );
}

// ── Edge cases ──────────────────────────────────────────────────────

#[test]
fn serde_roundtrip_empty_heads() {
    let msg = SyncMessage::HeadExchange { heads: vec![] };
    let json = serde_json::to_string(&msg).expect("serialize empty HeadExchange");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize empty HeadExchange");
    assert_eq!(
        deser, msg,
        "HeadExchange with empty heads must survive roundtrip"
    );
    let val: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
        val["heads"].as_array().unwrap().len(),
        0,
        "empty heads must serialize to empty array"
    );
}

#[test]
fn serde_roundtrip_empty_op_batch() {
    let msg = SyncMessage::OpBatch {
        ops: vec![],
        is_last: true,
    };
    let json = serde_json::to_string(&msg).expect("serialize empty OpBatch");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize empty OpBatch");
    assert_eq!(deser, msg, "OpBatch with empty ops must survive roundtrip");
}

#[test]
fn serde_roundtrip_unicode_content() {
    let msg = SyncMessage::OpBatch {
        ops: vec![OpTransfer {
            device_id: "デバイスA".into(),
            seq: 1,
            parent_seqs: None,
            hash: "hash_unicode".into(),
            op_type: "edit_block".into(),
            payload: r#"{"block_id":"BLK1","to_text":"Hello 🌍 世界 مرحبا"}"#.into(),
            created_at: "2025-01-15T12:00:00Z".into(),
        }],
        is_last: true,
    };
    let json = serde_json::to_string(&msg).expect("serialize unicode OpBatch");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize unicode OpBatch");
    assert_eq!(
        deser, msg,
        "OpBatch with unicode content must survive roundtrip"
    );

    // Verify the unicode is preserved in the JSON string
    assert!(
        json.contains("🌍"),
        "emoji must be preserved in serialized JSON"
    );
    assert!(
        json.contains("世界"),
        "CJK characters must be preserved in serialized JSON"
    );
    assert!(
        json.contains("デバイスA"),
        "Japanese device_id must be preserved in serialized JSON"
    );
}

#[test]
fn serde_roundtrip_unicode_error_message() {
    let msg = SyncMessage::Error {
        message: "连接失败: タイムアウト 🔥".into(),
    };
    let json = serde_json::to_string(&msg).expect("serialize unicode Error");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize unicode Error");
    assert_eq!(
        deser, msg,
        "Error with unicode message must survive roundtrip"
    );
}

#[test]
fn serde_roundtrip_large_op_batch() {
    let ops: Vec<OpTransfer> = (0..500)
        .map(|i| OpTransfer {
            device_id: "bulk-device".into(),
            seq: i,
            parent_seqs: if i > 0 {
                Some(format!("{}", i - 1))
            } else {
                None
            },
            hash: format!("hash_{i:04}"),
            op_type: "create_block".into(),
            payload: format!(r#"{{"block_id":"BLK{i}","content":"content for block {i}"}}"#),
            created_at: "2025-01-15T12:00:00Z".into(),
        })
        .collect();

    let msg = SyncMessage::OpBatch {
        ops: ops.clone(),
        is_last: true,
    };
    let json = serde_json::to_string(&msg).expect("serialize large OpBatch");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize large OpBatch");
    assert_eq!(
        deser, msg,
        "OpBatch with 500 ops must survive serde roundtrip"
    );

    // Verify the count is preserved
    if let SyncMessage::OpBatch {
        ops: deser_ops,
        is_last,
    } = &deser
    {
        assert_eq!(
            deser_ops.len(),
            500,
            "deserialized batch must contain all 500 ops"
        );
        assert!(is_last, "is_last flag must be preserved");
    } else {
        panic!("deserialized message must be OpBatch");
    }
}

#[test]
fn serde_roundtrip_large_payload_content() {
    // Simulate a block with a very large text content (100KB)
    let large_text = "A".repeat(100_000);
    let payload = format!(r#"{{"block_id":"BLK1","to_text":"{large_text}"}}"#);
    let msg = SyncMessage::OpBatch {
        ops: vec![OpTransfer {
            device_id: "dev-A".into(),
            seq: 1,
            parent_seqs: None,
            hash: "large_hash".into(),
            op_type: "edit_block".into(),
            payload,
            created_at: "2025-01-15T12:00:00Z".into(),
        }],
        is_last: true,
    };
    let json = serde_json::to_string(&msg).expect("serialize large payload");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize large payload");
    assert_eq!(
        deser, msg,
        "OpBatch with 100KB payload must survive serde roundtrip"
    );
}

#[test]
fn serde_roundtrip_many_heads() {
    let heads: Vec<DeviceHead> = (0..100)
        .map(|i| DeviceHead {
            device_id: format!("device-{i:03}"),
            seq: i as i64 * 10,
            hash: format!("hash_{i:03}"),
        })
        .collect();

    let msg = SyncMessage::HeadExchange {
        heads: heads.clone(),
    };
    let json = serde_json::to_string(&msg).expect("serialize many-heads HeadExchange");
    let deser: SyncMessage =
        serde_json::from_str(&json).expect("deserialize many-heads HeadExchange");
    assert_eq!(
        deser, msg,
        "HeadExchange with 100 heads must survive serde roundtrip"
    );
}

#[test]
fn serde_roundtrip_empty_string_fields() {
    let msg = SyncMessage::SyncComplete {
        last_hash: String::new(),
    };
    let json = serde_json::to_string(&msg).expect("serialize empty last_hash");
    let deser: SyncMessage = serde_json::from_str(&json).expect("deserialize empty last_hash");
    assert_eq!(
        deser, msg,
        "SyncComplete with empty last_hash must survive roundtrip"
    );

    let val: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
        val["last_hash"], "",
        "empty string must serialize to empty string, not null"
    );
}

#[test]
fn serde_roundtrip_zero_size_snapshot_offer() {
    let msg = SyncMessage::SnapshotOffer { size_bytes: 0 };
    let json = serde_json::to_string(&msg).expect("serialize zero-size SnapshotOffer");
    let deser: SyncMessage =
        serde_json::from_str(&json).expect("deserialize zero-size SnapshotOffer");
    assert_eq!(
        deser, msg,
        "SnapshotOffer with size_bytes=0 must survive roundtrip"
    );
}

#[test]
fn serde_roundtrip_max_u64_snapshot_offer() {
    let msg = SyncMessage::SnapshotOffer {
        size_bytes: u64::MAX,
    };
    let json = serde_json::to_string(&msg).expect("serialize max-u64 SnapshotOffer");
    let deser: SyncMessage =
        serde_json::from_str(&json).expect("deserialize max-u64 SnapshotOffer");
    assert_eq!(
        deser, msg,
        "SnapshotOffer with u64::MAX must survive roundtrip"
    );
}

// ======================================================================
// TEST-20 — Sync error handling tests
// ======================================================================

/// A batch containing [valid_op, bad_hash_op] must be rejected atomically:
/// the function returns an error and the valid op's effects are rolled back
/// (i.e. never committed to the op log).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_rollback_on_integrity_error() {
    // Create a valid op on a "remote" database so it gets a correct hash
    let (remote_pool, _remote_dir) = test_pool().await;
    let valid_op = append_local_op_at(
        &remote_pool,
        "remote-dev",
        test_create_payload("BLK-VALID"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    let valid_transfer: OpTransfer = valid_op.into();

    // Build a second op with a corrupted hash (will fail integrity check)
    let bad_transfer = OpTransfer {
        device_id: "remote-dev".into(),
        seq: 99,
        parent_seqs: None,
        hash: "BADHASH0000000000000000000000000000000000000000000000000000000000".to_string(),
        op_type: "edit_block".into(),
        payload: r#"{"block_id":"BLK-NONEXISTENT","to_text":"bad"}"#.into(),
        created_at: FIXED_TS.into(),
    };

    // Apply a batch of [valid_op, bad_op] on a fresh "local" database
    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    let result = apply_remote_ops(
        &local_pool,
        &materializer,
        vec![valid_transfer.clone(), bad_transfer],
    )
    .await;

    // The entire batch must be rejected
    assert!(
        result.is_err(),
        "batch containing a bad-hash op must be rejected"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("integrity check failed"),
        "error must mention integrity check, got: {err_msg}"
    );

    // The valid op must NOT be present in the local database (rollback)
    let ops_in_local = crate::op_log::get_ops_since(&local_pool, "remote-dev", 0)
        .await
        .unwrap();
    assert!(
        ops_in_local.is_empty(),
        "valid op must not be inserted when batch is rejected — \
         expected 0 ops, found {}",
        ops_in_local.len()
    );

    materializer.shutdown();
}

/// Sending a HeadExchange while the orchestrator is in StreamingOps state
/// must be rejected as a state-machine violation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_errors_on_head_exchange_during_streaming_ops() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // start() → ExchangingHeads
    let _start = orch.start().await.unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::ExchangingHeads,
        "state should be ExchangingHeads after start"
    );

    // Receive remote HeadExchange (empty — both sides have no data) →
    // transitions to StreamingOps
    orch.handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::StreamingOps,
        "should be in StreamingOps after first HeadExchange"
    );

    // Send another HeadExchange — must be rejected
    let duplicate_result = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await;
    assert!(
        duplicate_result.is_err(),
        "HeadExchange in StreamingOps must be rejected"
    );

    // State should transition to Failed with a descriptive message
    assert_eq!(
        orch.session().state,
        SyncState::Failed("HeadExchange received in wrong state".into()),
        "state must be Failed after invalid HeadExchange"
    );

    materializer.shutdown();
}

/// Sending an OpBatch after an earlier OpBatch with `is_last: true` must be
/// rejected because the orchestrator has already transitioned to a terminal
/// state (Complete).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_errors_on_op_batch_after_is_last() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // 1. start() → ExchangingHeads
    let _start = orch.start().await.unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::ExchangingHeads,
        "state should be ExchangingHeads after start"
    );

    // 2. Receive HeadExchange → StreamingOps (returns our OpBatch)
    orch.handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::StreamingOps,
        "state should be StreamingOps after head exchange"
    );

    // 3. Receive OpBatch with is_last=true → applies, merges, → Complete
    let response = orch
        .handle_message(SyncMessage::OpBatch {
            ops: vec![],
            is_last: true,
        })
        .await
        .unwrap();
    assert!(
        matches!(response, Some(SyncMessage::SyncComplete { .. })),
        "final OpBatch should produce SyncComplete"
    );
    assert_eq!(
        orch.session().state,
        SyncState::Complete,
        "state must be Complete after is_last=true batch"
    );

    // 4. Send another OpBatch — must be rejected (terminal state)
    let late_batch_result = orch
        .handle_message(SyncMessage::OpBatch {
            ops: vec![],
            is_last: true,
        })
        .await;
    assert!(
        late_batch_result.is_err(),
        "OpBatch after is_last=true must be rejected"
    );
    let err_msg = late_batch_result.unwrap_err().to_string();
    assert!(
        err_msg.contains("terminal state"),
        "error must mention terminal state, got: {err_msg}"
    );

    materializer.shutdown();
}

// ── MAINT-21: tracing span emission ─────────────────────────────────

/// Thread-safe buffered writer for in-process log capture.
///
/// Mirrors the helper in `db.rs` tests. Kept module-local so each test
/// module stays self-contained (see AGENTS.md § "Test helper duplication
/// is intentional").
#[derive(Clone, Default)]
struct SpanBufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for SpanBufWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SpanBufWriter {
    type Writer = SpanBufWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl SpanBufWriter {
    fn contents(&self) -> String {
        let bytes = self.0.lock().unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// MAINT-21: `SyncOrchestrator::handle_message` must execute inside a
/// `sync_msg` span so every log line emitted during message dispatch
/// (error events, state transitions, protocol warnings) carries the
/// span prefix — enabling operators to correlate log lines back to the
/// message that triggered them.
///
/// We verify this by installing a scoped fmt subscriber configured to
/// render span-enter events, dispatching a call to `handle_message`, and
/// asserting the captured buffer shows the `sync_msg` span marker.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_message_emits_within_sync_msg_span() {
    use tracing_subscriber::layer::SubscriberExt;

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let writer = SpanBufWriter::default();
    // Install a subscriber that renders span-enter events so the captured
    // output contains a marker even if the dispatched message doesn't
    // itself emit a tracing event.
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("agaric=trace"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_span_events(tracing_subscriber::fmt::format::FmtSpan::ENTER),
        );
    let _guard = tracing::subscriber::set_default(subscriber);

    // Freshly-constructed orchestrator is in SyncState::Idle. A HeadExchange
    // message is valid in Idle, and handle_message will dispatch normally.
    // The instrumented span entry is what we assert on: with
    // `FmtSpan::ENTER` the subscriber emits a `new` event carrying the
    // span name the moment the function body begins executing.
    let mut orch = SyncOrchestrator::new(pool.clone(), "dev-local".into(), materializer.clone());

    let _ = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await;

    let contents = writer.contents();
    assert!(
        contents.contains("sync_msg"),
        "handle_message must execute inside a `sync_msg` span so log lines \
         carry the span prefix for correlation, got log output: {contents:?}"
    );

    materializer.shutdown();
}

// ======================================================================
// H-14 — fork detection: same (device_id, seq) with different hash
// ======================================================================

/// A peer can produce two different ops for the same `(device_id, seq)`
/// slot if a misbehaving peer build, a restored backup, or a clock-bug
/// generates divergent histories.  The legacy `INSERT OR IGNORE` swallowed
/// the second insert and counted it as a "duplicate" — silent data loss
/// and no observability.  Verify `apply_remote_ops` now:
///   1. Detects the collision via SELECT before INSERT OR IGNORE.
///   2. Increments `result.forks` (NOT `result.duplicates`).
///   3. Leaves the local op_log row unchanged (keeps the local copy).
///   4. Does not enqueue the incoming op for materialization.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_detects_fork_with_same_seq_different_hash() {
    const DEV_A: &str = "fork-dev";

    // Pool 1: the local DB we're applying ops to.  Seed it with a real
    // op for (DEV_A, seq=1) — this is what the peer's fork will collide
    // with.  Using `append_local_op_at` ensures the local row carries a
    // genuine, well-formed hash chain (no need to fake the hash).
    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    let local_record = append_local_op_at(
        &local_pool,
        DEV_A,
        test_create_payload("FORK-LOCAL"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let hash_a = local_record.hash.clone();

    // Pool 2: an independent "peer" DB that *also* produces an op for
    // `(DEV_A, seq=1)` — but with different content, hence a different
    // hash.  This is a legitimate, integrity-passing op from the peer's
    // perspective; the fork is detected at apply time on the local side.
    let (remote_pool, _remote_dir) = test_pool().await;
    let remote_record = append_local_op_at(
        &remote_pool,
        DEV_A,
        test_create_payload("FORK-REMOTE"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    assert_eq!(
        remote_record.seq, 1,
        "fresh remote pool should assign seq=1 for DEV_A"
    );
    assert_ne!(
        remote_record.hash, hash_a,
        "remote op must have a different hash for the test to be meaningful"
    );

    let fork_transfer: OpTransfer = remote_record.into();

    // Apply the forking transfer to the local pool.
    let result = apply_remote_ops(&local_pool, &materializer, vec![fork_transfer])
        .await
        .unwrap();

    assert_eq!(result.forks, 1, "fork must be counted");
    assert_eq!(result.inserted, 0, "no rows inserted on a fork");
    assert_eq!(
        result.duplicates, 0,
        "fork must NOT be counted as a duplicate (different hash)"
    );
    assert_eq!(result.hash_mismatches, 0, "no integrity failures");

    // The local op_log row must be unchanged — the keep-local policy.
    let stored_hash: Option<String> =
        sqlx::query_scalar("SELECT hash FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(DEV_A)
            .bind(1_i64)
            .fetch_optional(&local_pool)
            .await
            .unwrap();
    assert_eq!(
        stored_hash.as_deref(),
        Some(hash_a.as_str()),
        "local row must still carry hash_a after a fork attempt"
    );

    materializer.shutdown();
}

/// Symmetric sanity check: a *true* duplicate (same `(device_id, seq)`
/// AND same hash — i.e., the peer re-sends the same op) must continue to
/// be counted as a duplicate, not a fork.  Guards against an over-eager
/// `is_fork` predicate that fires on every collision.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_remote_ops_does_not_count_real_duplicates_as_forks() {
    const DEV_A: &str = "dup-dev";

    // Pool that produces the canonical op for (DEV_A, seq=1).
    let (remote_pool, _remote_dir) = test_pool().await;
    let record = append_local_op_at(
        &remote_pool,
        DEV_A,
        test_create_payload("DUP-1"),
        FIXED_TS.into(),
    )
    .await
    .unwrap();
    let transfer: OpTransfer = record.into();

    // Apply the same op to a fresh local pool twice.  The second apply
    // should be a true duplicate: same (device_id, seq) AND same hash.
    let (local_pool, _local_dir) = test_pool().await;
    let materializer = Materializer::new(local_pool.clone());

    let first = apply_remote_ops(&local_pool, &materializer, vec![transfer.clone()])
        .await
        .unwrap();
    assert_eq!(first.inserted, 1, "first apply inserts the op");
    assert_eq!(first.forks, 0, "no fork on a fresh insert");
    assert_eq!(first.duplicates, 0, "no duplicate on a fresh insert");

    let second = apply_remote_ops(&local_pool, &materializer, vec![transfer])
        .await
        .unwrap();
    assert_eq!(
        second.duplicates, 1,
        "re-applying an identical op must count as a duplicate"
    );
    assert_eq!(
        second.forks, 0,
        "identical op (same hash) is NOT a fork — guard against over-firing"
    );
    assert_eq!(
        second.inserted, 0,
        "INSERT OR IGNORE is a no-op for the duplicate"
    );

    materializer.shutdown();
}
