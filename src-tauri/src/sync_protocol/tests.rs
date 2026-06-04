use super::*;
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::op::{CreateBlockPayload, OpPayload};
use crate::op_log::{append_local_op_at, OpRecord};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

// ── Fixture constants ───────────────────────────────────────────────

const FIXED_TS: i64 = 1_736_942_400_000;

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
        index: None,
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
            FIXED_TS,
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

    append_local_op_at(&pool, "device-A", test_create_payload("BLK-A1"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(&pool, "device-B", test_create_payload("BLK-B1"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(&pool, "device-A", test_create_payload("BLK-A2"), FIXED_TS)
        .await
        .unwrap();

    let heads = get_local_heads(&pool).await.unwrap();
    assert_eq!(heads.len(), 2, "should have two device heads");

    let head_a = heads.iter().find(|h| h.device_id == "device-A").unwrap();
    let head_b = heads.iter().find(|h| h.device_id == "device-B").unwrap();
    assert_eq!(head_a.seq, 2, "device-A should be at seq 2");
    assert_eq!(head_b.seq, 1, "device-B should be at seq 1");
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

// ── PEND-24 M2: bookkeeping pair atomicity ──────────────────────────

/// PEND-24 M2: the post-session bookkeeping pair —
/// `peer_refs::upsert_peer_ref_in_tx` followed by `complete_sync_in_tx`
/// — must commit atomically. Both writes share a single
/// `BEGIN IMMEDIATE` transaction so a crash or error between them
/// cannot leave a peer row whose `last_hash` is stale relative to the
/// ops actually applied.
///
/// This test verifies the success path: when the transaction commits,
/// both writes are visible together — the peer row exists AND its
/// `last_hash` / `last_sent_hash` / `synced_at` reflect the recorded
/// sync.
#[tokio::test]
async fn upsert_peer_ref_and_complete_sync_share_tx_commits_both_atomically() {
    let (pool, _dir) = test_pool().await;

    // Pre-condition: peer does not exist.
    assert!(
        crate::peer_refs::get_peer_ref(&pool, "peer-tx-success")
            .await
            .unwrap()
            .is_none(),
        "peer must not exist before the bookkeeping pair runs"
    );

    // Run the bookkeeping pair inside a single BEGIN IMMEDIATE tx —
    // exactly mirroring the orchestrator's `SyncComplete` arm.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    crate::peer_refs::upsert_peer_ref_in_tx(&mut tx, "peer-tx-success")
        .await
        .unwrap();
    complete_sync_in_tx(&mut tx, "peer-tx-success", "hash-rx", "hash-tx")
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // Post-condition: both writes visible together.
    let peer = crate::peer_refs::get_peer_ref(&pool, "peer-tx-success")
        .await
        .unwrap()
        .expect("peer row must exist after committed bookkeeping pair");
    assert_eq!(
        peer.last_hash.as_deref(),
        Some("hash-rx"),
        "last_hash must be populated by complete_sync_in_tx"
    );
    assert_eq!(
        peer.last_sent_hash.as_deref(),
        Some("hash-tx"),
        "last_sent_hash must be populated by complete_sync_in_tx"
    );
    assert!(
        peer.synced_at.is_some(),
        "synced_at must be populated by complete_sync_in_tx"
    );
}

/// PEND-24 M2: when the inner write fails, the whole transaction must
/// roll back — including the preceding `upsert_peer_ref_in_tx`. The
/// peer row must NOT exist after the failure so the next session
/// retries from a clean state instead of seeing a stranded row whose
/// `last_hash` is `NULL` while the ops were already applied.
///
/// The failure is forced with a SQLite trigger that calls
/// `RAISE(ABORT)` on `UPDATE peer_refs` — the same pattern used by
/// `set_page_aliases_in_transaction` (M-21) elsewhere in the suite.
#[tokio::test]
async fn upsert_peer_ref_and_complete_sync_share_tx_rolls_back_on_inner_failure() {
    let (pool, _dir) = test_pool().await;

    // Install a trigger that aborts any UPDATE to peer_refs. This
    // simulates the second-write-of-the-pair failing for any reason
    // (disk error, concurrent constraint violation, etc.).
    sqlx::query(
        "CREATE TRIGGER test_pend24_m2_fail_update \
         BEFORE UPDATE ON peer_refs \
         BEGIN \
            SELECT RAISE(ABORT, 'simulated mid-bookkeeping failure'); \
         END",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Run the bookkeeping pair. The upsert succeeds (INSERT OR IGNORE
    // for a fresh peer), but the UPDATE inside complete_sync_in_tx
    // hits the trigger and aborts.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    crate::peer_refs::upsert_peer_ref_in_tx(&mut tx, "peer-tx-rollback")
        .await
        .unwrap();
    let inner = complete_sync_in_tx(&mut tx, "peer-tx-rollback", "hash-rx", "hash-tx").await;
    assert!(
        inner.is_err(),
        "complete_sync_in_tx must propagate the trigger abort, got: {:?}",
        inner.as_ref().ok()
    );

    // Drop tx without committing — sqlx's Transaction Drop rolls back.
    drop(tx);

    // Drop the trigger so the post-condition query is unaffected.
    sqlx::query("DROP TRIGGER test_pend24_m2_fail_update")
        .execute(&pool)
        .await
        .unwrap();

    // Post-condition: the peer row must NOT exist. If the upsert had
    // committed independently, this `get` would return `Some(_)` with
    // a NULL `last_hash`, leaving the next session with a stranded
    // peer-ref row — exactly the regression PEND-24 M2 prevents.
    let peer = crate::peer_refs::get_peer_ref(&pool, "peer-tx-rollback")
        .await
        .unwrap();
    assert!(
        peer.is_none(),
        "rollback of the bookkeeping tx must un-do the upsert too; \
         got stranded peer row: {peer:?}"
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
        FIXED_TS,
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

/// I-Sync-4: `OpTransfer` and `OpRecord` are intentionally kept as
/// separate types (a deliberate wire-vs-DB boundary, not duplication
/// — see the doc-block on `OpTransfer`). This test pins the
/// "structurally identical" contract: an `OpRecord` with non-trivial
/// values for every field MUST round-trip through
/// `OpRecord -> OpTransfer -> OpRecord` losslessly at the serde-JSON
/// level. If a future field is added to one type but not the other
/// (or a `From` impl regresses to drop a field), this test fails and
/// forces the contract to be re-asserted explicitly.
///
/// `block_id` is `#[serde(skip, default)]` on `OpRecord` (L-13 sidecar
/// not part of the wire identity), so JSON serialization elides it on
/// both sides — this is intentional.
#[test]
fn op_transfer_and_op_record_remain_structurally_identical_i_sync_4() {
    // Fully-populated record: non-trivial parent_seqs, non-empty
    // payload, non-default created_at, populated block_id sidecar.
    let original = OpRecord {
        device_id: "device-A".into(),
        seq: 42,
        parent_seqs: Some("[7,8,9]".into()),
        hash: "f".repeat(64),
        op_type: "create_block".into(),
        payload: r#"{"block_id":"BLK_I_SYNC_4","block_type":"content","content":"hello","parent_id":null,"position":3}"#.into(),
        created_at: 1_741_944_413_589,
        block_id: Some("BLK_I_SYNC_4".into()),
    };

    let transfer: OpTransfer = OpTransfer::from(original.clone());
    let roundtripped: OpRecord = OpRecord::from(transfer);

    let original_json =
        serde_json::to_string(&original).expect("OpRecord serialization must succeed");
    let roundtripped_json = serde_json::to_string(&roundtripped)
        .expect("round-tripped OpRecord serialization must succeed");

    assert_eq!(
        original_json, roundtripped_json,
        "I-Sync-4: OpRecord -> OpTransfer -> OpRecord must be a lossless \
         identity at the serde-JSON level. If this fails, a field was \
         added to one struct but not the other, or a `From` impl dropped \
         a field — re-assert the parity contract explicitly before \
         landing the divergence."
    );
}

/// L-13: the wire-side `From<OpTransfer>` conversion must NOT parse
/// the payload — `apply_remote_ops` already does a validation parse
/// and populates the sidecar from that single parse. Doing it here
/// would double the JSON parse cost on the sync hot path (catch-up
/// after Android resume, multi-thousand-op batches), regressing
/// exactly the workload L-13 was filed against. Leaving the sidecar
/// `None` on the wire conversion is correct as long as
/// `apply_remote_ops` (the validation-parse piggyback) runs before
/// any code path that observes `record.block_id` for a sync'd op.
#[test]
fn op_transfer_from_leaves_block_id_unpopulated_l13() {
    let payload = r#"{"block_id":"BLK_L13_RX","block_type":"content","content":"hi","parent_id":null,"position":0}"#;
    let transfer = OpTransfer {
        device_id: "remote-dev".into(),
        seq: 7,
        parent_seqs: None,
        hash: "0".repeat(64),
        op_type: "create_block".into(),
        payload: payload.into(),
        created_at: FIXED_TS,
    };

    let record: OpRecord = transfer.into();
    assert_eq!(
        record.block_id, None,
        "L-13: From<OpTransfer> must NOT parse — block_id sidecar is \
         populated by `apply_remote_ops` from its existing validation \
         parse so sync stays at one parse per op (not two)"
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
        SyncMessage::LoroSync {
            msg: crate::sync_protocol::loro_sync_types::LoroSyncMessage::Snapshot {
                protocol_version: crate::sync_protocol::loro_sync_types::LORO_SYNC_PROTOCOL_VERSION,
                space_id: crate::space::SpaceId::from_trusted("00000000000000000000000000"),
                bytes: vec![1, 2, 3],
            },
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
        !orch.is_succeeded(),
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

/// I-Sync-1: `SnapshotAccept` and `SnapshotReject` belong to the
/// `snapshot_transfer` sub-flow at the sync-daemon layer, not the
/// orchestrator state machine. If either ever reaches `handle_message`,
/// it is the same kind of routing regression as a stray `SnapshotOffer`
/// — surface it as `AppError::InvalidOperation` instead of silently
/// returning `Ok(None)`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_snapshot_accept_and_reject_i_sync_1() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // Drive to ExchangingHeads so state-validation passes the snapshot
    // control messages through to the dispatch arm.
    let _start = orch.start().await.unwrap();
    assert_eq!(
        orch.session().state,
        SyncState::ExchangingHeads,
        "start() must transition to ExchangingHeads"
    );

    for variant in [SyncMessage::SnapshotAccept, SyncMessage::SnapshotReject] {
        let label = match variant {
            SyncMessage::SnapshotAccept => "SnapshotAccept",
            SyncMessage::SnapshotReject => "SnapshotReject",
            _ => unreachable!(),
        };
        let result = orch.handle_message(variant).await;
        let err = match result {
            Err(crate::error::AppError::InvalidOperation(msg)) => msg,
            other => panic!(
                "{label} routed through handle_message must return \
                 AppError::InvalidOperation — the snapshot_transfer sub-flow \
                 is the only reachable path. got: {other:?}"
            ),
        };
        assert!(
            err.contains("snapshot_transfer"),
            "{label} error must point callers at the daemon sub-flow, got: {err}"
        );
    }

    materializer.shutdown();
}

/// After a full sync completes, sending another HeadExchange should
/// fail because Complete is a terminal state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orchestrator_rejects_messages_in_terminal_state() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // Manually set `state = Complete` to set up the terminal-state
    // precondition. The state validation match in `handle_message`
    // reads `self.state` (the source of truth), so setting it directly
    // is sufficient to exercise the terminal-state reject branch. (The
    // empty-registry path short-circuits to `SyncComplete` rather than
    // emitting a sentinel-empty `LoroSync`, so we cannot drive to
    // Complete through `handle_message` alone without scaffolding a
    // real Loro registry — the dedicated coverage for that path lives
    // in `loro_sync_orchestrator_handles_empty_registry_without_panic`.)
    let _start = orch.start().await.unwrap();
    orch.state = SyncState::Complete;
    assert_eq!(
        orch.state,
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

    // Directly set `state = StreamingOps` to set up the precondition.
    // Driving via HeadExchange is brittle: the empty-registry short-
    // circuit transitions to `Complete` instead, and a sibling test in
    // this binary may have populated the process-global `OnceLock`
    // registry which would route us through the per-space LoroSync
    // path. The state-validation match in `handle_message` reads
    // `self.state` (the source of truth), so setting it directly
    // exercises the same rejection branch deterministically.
    orch.state = SyncState::StreamingOps;

    // Send a HeadExchange in StreamingOps → should fail with the
    // wrong-state rejection (not the terminal-state reject).
    let result = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await;
    assert!(
        result.is_err(),
        "HeadExchange should be rejected in StreamingOps state"
    );
    assert_eq!(
        orch.state,
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
    assert!(
        orch.is_succeeded(),
        "Complete should also pass is_succeeded"
    );

    // Failed → terminal
    let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
    orch.state = SyncState::Failed("err".into());
    assert!(orch.is_terminal(), "Failed should be terminal");
    assert!(!orch.is_succeeded(), "Failed should not pass is_succeeded");

    // ResetRequired → terminal
    let mut orch = SyncOrchestrator::new(pool.clone(), "dev".into(), materializer.clone());
    orch.state = SyncState::ResetRequired;
    assert!(orch.is_terminal(), "ResetRequired should be terminal");
    assert!(
        !orch.is_succeeded(),
        "ResetRequired should not pass is_succeeded"
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
// I-Sync-3 — `is_succeeded` (formerly `is_complete`) is the file-transfer
// gate: a session ending in `Failed(_)` must NOT trigger file transfer,
// even though it IS terminal. This pins the contract that the rename
// clarifies — `is_terminal` and `is_succeeded` are DISTINCT predicates,
// and the `run_sync_session` file-transfer gate uses the strict subset
// (`is_succeeded`) so failures and reset-required hand off to retry /
// snapshot-transfer instead of running file transfer over a broken
// session.
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_state_skips_file_transfer_i_sync_3() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Drive the orchestrator into Failed via a peer-reported Error,
    // mirroring `orchestrator_handles_error_message` but asserting the
    // file-transfer-gate contract specifically.
    let mut orch = SyncOrchestrator::new(pool.clone(), "local-dev".into(), materializer.clone());
    let _start = orch.start().await.unwrap();
    let _ = orch
        .handle_message(SyncMessage::Error {
            message: "peer reported failure".into(),
        })
        .await
        .unwrap();
    assert!(
        matches!(orch.session().state, SyncState::Failed(_)),
        "precondition: session state should be Failed"
    );

    // The contract the rename pins down:
    //   * Failed IS terminal (the message loop must exit).
    //   * Failed is NOT succeeded (the file-transfer gate must skip).
    assert!(
        orch.is_terminal(),
        "Failed must be terminal so the run_sync_session loop exits"
    );
    assert!(
        !orch.is_succeeded(),
        "Failed must NOT pass is_succeeded — the file-transfer gate \
         (`if orch.is_succeeded()`) must skip file transfer when the \
         op-batch exchange ended in failure"
    );

    // ResetRequired: same contract — terminal, not succeeded.
    let mut orch = SyncOrchestrator::new(pool.clone(), "local-dev".into(), materializer.clone());
    orch.state = SyncState::ResetRequired;
    assert!(orch.is_terminal(), "ResetRequired must be terminal");
    assert!(
        !orch.is_succeeded(),
        "ResetRequired must NOT pass is_succeeded — file transfer must \
         defer to snapshot catch-up instead"
    );

    // Complete: the only state that gates file transfer ON.
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());
    orch.state = SyncState::Complete;
    assert!(orch.is_terminal(), "Complete is terminal");
    assert!(
        orch.is_succeeded(),
        "Complete is the strict subset of terminal that gates file transfer ON"
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
        FIXED_TS,
    )
    .await
    .unwrap();

    // Install Loro state and register a real space so
    // `head_exchange_outgoing_loro` takes the per-space LoroSync path
    // (transitioning to `StreamingOps`) instead of the empty-registry
    // short-circuit (which would transition straight to `Complete` and
    // bypass the BUG-27 SyncComplete handler we are exercising here).
    // The block payload itself is irrelevant — we just need at least
    // one registered space.
    let state = crate::loro::shared::install_for_test();
    let space = crate::space::SpaceId::from_trusted("01HZBUG27EMPTYPEERIDXXXXXXX");
    {
        let mut g = state
            .registry
            .for_space(&space, "local-dev")
            .expect("for_space");
        g.engine_mut()
            .apply_create_block("01HZBUG27EMPTYPEERIDBLK000", "content", "seed", None, 0)
            .expect("apply_create_block");
    }

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
    // HeadExchange emits a `LoroSync`. The empty-registry case
    // short-circuits to `SyncComplete`, but this test installs a real
    // space (above) to keep the per-space LoroSync path active.
    assert!(
        matches!(after_head, Some(SyncMessage::LoroSync { .. })),
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
        created_at: 1_736_942_400_000,
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
        created_at: 1_735_689_600_000,
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
fn json_shape_all_variants_have_type_tag() {
    use crate::sync_protocol::loro_sync_types::{LoroSyncMessage, LORO_SYNC_PROTOCOL_VERSION};

    let variants: Vec<(&str, SyncMessage)> = vec![
        ("HeadExchange", SyncMessage::HeadExchange { heads: vec![] }),
        (
            "LoroSync",
            SyncMessage::LoroSync {
                msg: LoroSyncMessage::Snapshot {
                    protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                    space_id: crate::space::SpaceId::from_trusted("00000000000000000000000000"),
                    bytes: Vec::new(),
                },
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

    // Directly set `state = StreamingOps`. Driving via an empty-heads
    // HeadExchange would short-circuit to `Complete`, and a sibling
    // test in this binary may have populated the process-global
    // `OnceLock` registry which would route us through the per-space
    // LoroSync path. State validation reads `self.state` directly, so
    // this scaffolding exercises the same rejection branch
    // deterministically.
    orch.state = SyncState::StreamingOps;

    // Send a HeadExchange — must be rejected
    let duplicate_result = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await;
    assert!(
        duplicate_result.is_err(),
        "HeadExchange in StreamingOps must be rejected"
    );

    // State should transition to Failed with a descriptive message
    assert_eq!(
        orch.state,
        SyncState::Failed("HeadExchange received in wrong state".into()),
        "state must be Failed after invalid HeadExchange"
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
// LoroSync wire integration tests
// ======================================================================

/// Smoke test — the orchestrator's outgoing HeadExchange path does
/// NOT panic when Loro state is initialised. When the registry has
/// zero registered spaces, HeadExchange short-circuits straight to
/// `SyncComplete` so the responder can advance cleanly. When sibling
/// tests in the same binary have already populated the shared
/// `OnceLock` registry with spaces, the response is a real `LoroSync`
/// and the orchestrator transitions to `StreamingOps` as in the
/// production path.
///
/// Locks the no-op happy-path invariant: an orchestrator that boots
/// into a process whose `LoroEngineRegistry` has not yet been touched
/// still finishes a sync session cleanly.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loro_sync_orchestrator_handles_empty_registry_without_panic() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Ensure Loro state is installed (first call wins; subsequent
    // calls are no-ops since OnceLock).
    let _state = crate::loro::shared::install_for_test();

    let mut orch = SyncOrchestrator::new(pool.clone(), "local-dev".into(), materializer.clone())
        .with_expected_remote_id("remote-dev".into());

    // Simulate a peer that has never originated its own ops — only
    // advertises (local-dev, 0). HeadExchange path proceeds without
    // touching local op_log (no ops to compute).
    let resp = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .expect("HeadExchange must not error under the engine path");

    // Accept either response shape:
    //
    // * Empty-registry short-circuit → `SyncComplete` (state ==
    //   `Complete`).
    // * Sibling-populated registry → real `LoroSync` (state ==
    //   `StreamingOps`).
    //
    // Either way: never a panic.
    match resp {
        Some(SyncMessage::SyncComplete { .. }) => {
            assert_eq!(
                orch.session().state,
                SyncState::Complete,
                "empty-registry short-circuit must leave the orchestrator in Complete"
            );
            // No further messages are expected after the
            // short-circuit; `next_message` must return None.
            assert!(
                orch.next_message().is_none(),
                "next_message must be empty after the short-circuit"
            );
        }
        Some(SyncMessage::LoroSync { is_last, .. }) => {
            assert_eq!(
                orch.session().state,
                SyncState::StreamingOps,
                "non-empty-registry path must transition to StreamingOps"
            );
            // Drain any remaining queued LoroSync messages — exercises
            // the `next_message` loro path. The final drained message
            // (or the first if it was solo) MUST carry `is_last: true`.
            let mut last_is_last = is_last;
            while let Some(msg) = orch.next_message() {
                match msg {
                    SyncMessage::LoroSync { is_last, .. } => {
                        last_is_last = is_last;
                    }
                    other => panic!("next_message produced non-LoroSync: {other:?}"),
                }
            }
            assert!(
                last_is_last,
                "final drained LoroSync message must carry is_last=true"
            );
        }
        other => panic!("expected SyncMessage::LoroSync or SyncComplete, got {other:?}"),
    }

    materializer.shutdown();
}

/// End-to-end — orchestrator A prepares an outgoing `LoroSync` for a
/// space whose engine has one block, the message is serde-round-tripped
/// through JSON (the wire format), then applied via
/// `loro_sync::apply_remote` to a fresh registry B. Engine B's SQL
/// projection of the block matches A's.
///
/// This test bypasses `crate::loro::shared` (process-global) and calls
/// the lower-level helpers directly so test isolation across this
/// binary's other Loro-state tests is preserved. The orchestrator path
/// is covered by
/// [`loro_sync_orchestrator_handles_empty_registry_without_panic`]
/// above.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loro_sync_e2e_round_trip_block_visible_on_b() {
    use crate::loro::registry::LoroEngineRegistry;
    use crate::space::SpaceId;
    use crate::sync_protocol::loro_sync;
    use crate::sync_protocol::loro_sync_types::LoroSyncMessage;

    let (pool_b, _dir_b) = test_pool().await;
    let materializer_b = Materializer::new(pool_b.clone());

    // Use a unique space + block id pair to avoid collisions with
    // other tests in this binary that may share installed Loro
    // state.
    let space = SpaceId::from_trusted("01HZPHASE3D5SYNCEEEEEEEEEE");
    let block_id_a = "01HZPHASE3D5SYNCBLKAAAAAAAA";

    // Engine A — register one block.
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
        g.engine_mut()
            .apply_create_block(block_id_a, "content", "from-A", None, 7)
            .expect("create");
    }

    // Build outgoing LoroSync via the prepare helper. Wrap into the
    // SyncMessage envelope (the wire shape).
    let inner = loro_sync::prepare_outgoing(&registry_a, &space, "device-A", None)
        .await
        .expect("prepare_outgoing");
    let outgoing = SyncMessage::LoroSync {
        msg: inner,
        is_last: true,
    };

    // Serde round-trip — this is what conn.send_json/conn.recv_json
    // do on the actual transport.
    let json = serde_json::to_string(&outgoing).expect("serialise SyncMessage::LoroSync");
    let received: SyncMessage =
        serde_json::from_str(&json).expect("deserialise SyncMessage::LoroSync");

    let received_inner: LoroSyncMessage = match received {
        SyncMessage::LoroSync { msg, is_last } => {
            assert!(is_last, "wire must preserve is_last");
            msg
        }
        other => panic!("expected SyncMessage::LoroSync after round-trip, got {other:?}"),
    };

    // Apply on B (fresh registry, fresh DB).
    let registry_b = LoroEngineRegistry::new();
    let returned_space =
        match loro_sync::apply_remote(&pool_b, &registry_b, "device-B", received_inner)
            .await
            .expect("apply_remote")
        {
            loro_sync::ApplyOutcome::Imported(s) => s,
            loro_sync::ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
                panic!("expected Imported, got SnapshotFallbackRequested: {reason}")
            }
        };
    assert_eq!(returned_space, space);

    // Engine B sees the block.
    {
        let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
        let snap = g
            .engine_mut()
            .read_block(block_id_a)
            .expect("read")
            .expect("block must be visible after apply_remote");
        assert_eq!(snap.content, "from-A");
    }

    // SQL projection on B has the block.
    let row: (String, String, String, Option<String>, i64) = sqlx::query_as(
        "SELECT id, block_type, content, parent_id, position FROM blocks WHERE id = ?",
    )
    .bind(block_id_a)
    .fetch_one(&pool_b)
    .await
    .expect("fetch row from B's DB");
    assert_eq!(row.0, block_id_a);
    assert_eq!(row.1, "content");
    assert_eq!(row.2, "from-A");
    assert_eq!(row.3, None);
    // #400: the legacy sparse position 7 is mapped to a sibling slot by the
    // engine and reprojected to the DENSE 1-based rank. Sole root child ⇒ 1.
    assert_eq!(row.4, 1);

    materializer_b.shutdown();
}

/// State-validation invariant — `SyncMessage::LoroSync` is rejected in
/// `Idle` (before any HeadExchange).  Mirrors the OpBatch pre-
/// HeadExchange rejection in
/// [`orchestrator_rejects_op_batch_before_head_exchange`].

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loro_sync_orchestrator_rejects_loro_sync_before_head_exchange() {
    use crate::space::SpaceId;
    use crate::sync_protocol::loro_sync_types::{LoroSyncMessage, LORO_SYNC_PROTOCOL_VERSION};

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let mut orch = SyncOrchestrator::new(pool, "local-dev".into(), materializer.clone());

    // Send LoroSync from Idle state — must fail.
    let result = orch
        .handle_message(SyncMessage::LoroSync {
            msg: LoroSyncMessage::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: SpaceId::from_trusted("01HZPHASE3D5IDLEEEEEEEEEEE"),
                bytes: vec![],
            },
            is_last: true,
        })
        .await;

    assert!(result.is_err(), "LoroSync from Idle state must be rejected");
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("LoroSync") && err_msg.contains("HeadExchange"),
        "rejection error should name both LoroSync and HeadExchange, got: {err_msg}"
    );
    assert!(
        matches!(
            orch.session().state,
            SyncState::Failed(ref m) if m.contains("LoroSync")
        ),
        "state must transition to Failed naming LoroSync, got: {:?}",
        orch.session().state
    );

    materializer.shutdown();
}

// ======================================================================
// End-to-end Loro-sync integration tests
// ======================================================================
//
// These tests exercise the full `prepare_outgoing` → wire round-trip →
// `apply_remote` cycle through several scenarios. Each test drives the
// public sync helpers directly (no real sockets) and asserts
// engine-state convergence + the SQL projection on the receiving side.
//
// Coverage:
//
// * Scenario 1 — multi-block, multi-space initial snapshot.
// * Scenario 2 — incremental Update against an already-seeded peer.
// * Scenario 3 — concurrent disjoint creates → CRDT mutual import
//   convergence (commutativity of `import`).
//
// Skipped intentionally:
// * Scenario 4 (same-block concurrent edit RGA convergence) — the
//   character-merge path is already covered by the engine-level
//   parity corpus + spike tests; the day-12 seam test focuses on the
//   sync wire instead of duplicating the RGA contract.
// * Scenario 5 (SQL projection happy-path) — the day-5 E2E
//   `loro_sync_e2e_round_trip_block_visible_on_b` already pins this.

/// Scenario 1 — multi-block, multi-space initial snapshot.
///
/// Engine A creates 5 blocks across 2 spaces (3 in `space-X`, 2 in
/// `space-Y`).  For each space, build a `LoroSyncMessage::Snapshot`
/// via `prepare_outgoing(None)`, wrap it in `SyncMessage::LoroSync`,
/// JSON-round-trip the envelope, then apply on B's empty registry +
/// fresh DB.  Assert engine B reads back every block with the right
/// content + parent + position, AND that the SQL `blocks` table on
/// B mirrors the same shape per space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loro_sync_e2e_multi_space_snapshot_initial_sync() {
    use crate::loro::registry::LoroEngineRegistry;
    use crate::space::SpaceId;
    use crate::sync_protocol::loro_sync;
    use crate::sync_protocol::loro_sync_types::LoroSyncMessage;

    let (pool_b, _dir_b) = test_pool().await;
    let materializer_b = Materializer::new(pool_b.clone());

    let space_x = SpaceId::from_trusted("01HZPHASE3D12MULTISPACEXXXX");
    let space_y = SpaceId::from_trusted("01HZPHASE3D12MULTISPACEYYYY");

    // Distinct ULID-shaped block_ids so SQL inserts don't collide.
    let blk_x1 = "01HZPHASE3D12BLKXSPACEXAAA1";
    let blk_x2 = "01HZPHASE3D12BLKXSPACEXBBB2";
    let blk_x3 = "01HZPHASE3D12BLKXSPACEXCCC3";
    let blk_y1 = "01HZPHASE3D12BLKYSPACEYDDD4";
    let blk_y2 = "01HZPHASE3D12BLKYSPACEYEEE5";

    // Engine A — seed 3 blocks in space_x, 2 in space_y.
    let registry_a = LoroEngineRegistry::new();
    {
        let mut g = registry_a
            .for_space(&space_x, "device-A")
            .expect("for_space space_x");
        let e = g.engine_mut();
        e.apply_create_block(blk_x1, "content", "x-one", None, 0)
            .expect("create x1");
        e.apply_create_block(blk_x2, "content", "x-two", Some(blk_x1), 1)
            .expect("create x2");
        e.apply_create_block(blk_x3, "page", "x-three", None, 2)
            .expect("create x3");
    }
    {
        let mut g = registry_a
            .for_space(&space_y, "device-A")
            .expect("for_space space_y");
        let e = g.engine_mut();
        e.apply_create_block(blk_y1, "content", "y-one", None, 0)
            .expect("create y1");
        e.apply_create_block(blk_y2, "content", "y-two", None, 1)
            .expect("create y2");
    }

    // Build + wire-roundtrip + apply one snapshot per space.
    let registry_b = LoroEngineRegistry::new();

    for space in [&space_x, &space_y] {
        let inner = loro_sync::prepare_outgoing(&registry_a, space, "device-A", None)
            .await
            .expect("prepare_outgoing");

        // Wrap in the day-5 wire envelope and JSON-roundtrip — this
        // mirrors what `conn.send_json` / `conn.recv_json` do on the
        // real transport.
        let outgoing = SyncMessage::LoroSync {
            msg: inner,
            is_last: true,
        };
        let json = serde_json::to_string(&outgoing).expect("serialise SyncMessage::LoroSync");
        let received: SyncMessage =
            serde_json::from_str(&json).expect("deserialise SyncMessage::LoroSync");
        let received_inner: LoroSyncMessage = match received {
            SyncMessage::LoroSync { msg, is_last } => {
                assert!(is_last, "wire must preserve is_last");
                msg
            }
            other => panic!("expected SyncMessage::LoroSync, got {other:?}"),
        };

        let returned_space =
            match loro_sync::apply_remote(&pool_b, &registry_b, "device-B", received_inner)
                .await
                .expect("apply_remote")
            {
                loro_sync::ApplyOutcome::Imported(s) => s,
                loro_sync::ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
                    panic!("expected Imported, got SnapshotFallbackRequested: {reason}")
                }
            };
        assert_eq!(&returned_space, space, "apply_remote must echo space");
    }

    // ── Engine convergence — every seeded block readable on B with
    // the original (block_type, content, parent_id, position).
    // #400: positions are DENSE 1-based ranks among siblings. blk_x1 and blk_x3
    // are root children (ranks 1, 2); blk_x2 is blk_x1's sole child (rank 1).
    let expected_x: &[(&str, &str, &str, Option<&str>, i64)] = &[
        (blk_x1, "content", "x-one", None, 1),
        (blk_x2, "content", "x-two", Some(blk_x1), 1),
        (blk_x3, "page", "x-three", None, 2),
    ];
    {
        let mut g = registry_b
            .for_space(&space_x, "device-B")
            .expect("for_space space_x B");
        let e = g.engine_mut();
        assert_eq!(
            e.count_alive_blocks().expect("count"),
            3,
            "space_x: 3 alive"
        );
        for (id, ty, content, parent, pos) in expected_x {
            let snap = e
                .read_block(id)
                .expect("read")
                .unwrap_or_else(|| panic!("block {id} must be visible on B"));
            assert_eq!(snap.block_type, *ty, "block_type for {id}");
            assert_eq!(snap.content, *content, "content for {id}");
            assert_eq!(snap.parent_id.as_deref(), *parent, "parent_id for {id}");
            assert_eq!(snap.position, *pos, "position for {id}");
        }
    }

    // #400: DENSE 1-based ranks — blk_y1, blk_y2 are root children ⇒ 1, 2.
    let expected_y: &[(&str, &str, &str, Option<&str>, i64)] = &[
        (blk_y1, "content", "y-one", None, 1),
        (blk_y2, "content", "y-two", None, 2),
    ];
    {
        let mut g = registry_b
            .for_space(&space_y, "device-B")
            .expect("for_space space_y B");
        let e = g.engine_mut();
        assert_eq!(
            e.count_alive_blocks().expect("count"),
            2,
            "space_y: 2 alive"
        );
        for (id, ty, content, parent, pos) in expected_y {
            let snap = e
                .read_block(id)
                .expect("read")
                .unwrap_or_else(|| panic!("block {id} must be visible on B"));
            assert_eq!(snap.block_type, *ty, "block_type for {id}");
            assert_eq!(snap.content, *content, "content for {id}");
            assert_eq!(snap.parent_id.as_deref(), *parent, "parent_id for {id}");
            assert_eq!(snap.position, *pos, "position for {id}");
        }
    }

    // ── SQL projection — every block also lands in the `blocks`
    // table with matching shape.  Single query joining all 5 ids.
    let row_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id IN (?, ?, ?, ?, ?)")
            .bind(blk_x1)
            .bind(blk_x2)
            .bind(blk_x3)
            .bind(blk_y1)
            .bind(blk_y2)
            .fetch_one(&pool_b)
            .await
            .expect("count rows");
    assert_eq!(row_count, 5, "all 5 blocks must be projected to SQL");

    // Spot-check the parented block — parent_id is the most failure-
    // prone projection field.
    let x2_row: (String, String, String, Option<String>, i64) = sqlx::query_as(
        "SELECT id, block_type, content, parent_id, position FROM blocks WHERE id = ?",
    )
    .bind(blk_x2)
    .fetch_one(&pool_b)
    .await
    .expect("fetch x2");
    assert_eq!(x2_row.0, blk_x2);
    assert_eq!(x2_row.1, "content");
    assert_eq!(x2_row.2, "x-two");
    assert_eq!(x2_row.3.as_deref(), Some(blk_x1));
    assert_eq!(x2_row.4, 1);

    materializer_b.shutdown();
}

/// Scenario 2 — incremental Update against an already-seeded peer.
///
/// 1. A creates BLOCK_X, exports a Snapshot, B applies it (B's vv now
///    matches A's pre-X vv).
/// 2. A creates BLOCK_Y.  A captures B's current `version_vector()` as
///    `peer_vv`, then `prepare_outgoing(Some(peer_vv))` builds a
///    `LoroSyncMessage::Update` carrying ONLY the post-vv ops.
/// 3. B applies the Update.  Engine + SQL both show {X, Y}.
///
/// This pins the day-4/day-5 incremental-sync wire path that the
/// day-5 E2E doesn't cover (it only does Snapshot).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loro_sync_e2e_update_against_seeded_peer() {
    use crate::loro::registry::LoroEngineRegistry;
    use crate::space::SpaceId;
    use crate::sync_protocol::loro_sync;
    use crate::sync_protocol::loro_sync_types::LoroSyncMessage;

    let (pool_b, _dir_b) = test_pool().await;
    let materializer_b = Materializer::new(pool_b.clone());

    let space = SpaceId::from_trusted("01HZPHASE3D12UPDATESCENARIO");
    let block_x = "01HZPHASE3D12BLOCKXEEEEEEE1";
    let block_y = "01HZPHASE3D12BLOCKYFFFFFFF2";

    // ── Step 1 — A creates X, snapshot to B.
    let registry_a = LoroEngineRegistry::new();
    let registry_b = LoroEngineRegistry::new();
    {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A");
        g.engine_mut()
            .apply_create_block(block_x, "content", "x-content", None, 0)
            .expect("create X");
    }
    {
        let inner = loro_sync::prepare_outgoing(&registry_a, &space, "device-A", None)
            .await
            .expect("prepare_outgoing snapshot");
        // Round-trip via the SyncMessage envelope to mirror the wire.
        let outgoing = SyncMessage::LoroSync {
            msg: inner,
            is_last: true,
        };
        let json = serde_json::to_string(&outgoing).expect("serialise");
        let received: SyncMessage = serde_json::from_str(&json).expect("deserialise");
        let received_inner = match received {
            SyncMessage::LoroSync { msg, .. } => msg,
            other => panic!("expected LoroSync, got {other:?}"),
        };
        let outcome = loro_sync::apply_remote(&pool_b, &registry_b, "device-B", received_inner)
            .await
            .expect("apply snapshot");
        assert!(
            matches!(outcome, loro_sync::ApplyOutcome::Imported(_)),
            "snapshot apply must report Imported, got {outcome:?}",
        );
    }

    // Sanity — B has X but not Y.
    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B-1");
        let e = g.engine_mut();
        assert!(
            e.read_block(block_x).expect("read X").is_some(),
            "X visible"
        );
        assert!(e.read_block(block_y).expect("read Y").is_none(), "Y absent");
    }

    // ── Step 2 — Capture B's vv, A creates Y, A builds an Update
    // against B's vv.
    let b_vv: Vec<u8> = {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B-vv");
        g.engine_mut().version_vector()
    };
    assert!(
        !b_vv.is_empty(),
        "B's vv after one import must be non-empty"
    );

    {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A-2");
        g.engine_mut()
            .apply_create_block(block_y, "content", "y-content", None, 1)
            .expect("create Y");
    }

    let update_msg = loro_sync::prepare_outgoing(&registry_a, &space, "device-A", Some(&b_vv))
        .await
        .expect("prepare_outgoing update");
    let (echoed_from_vv, update_bytes_len) = match &update_msg {
        LoroSyncMessage::Update { from_vv, bytes, .. } => (from_vv.clone(), bytes.len()),
        other => panic!("expected Update variant, got {other:?}"),
    };
    assert_eq!(
        echoed_from_vv, b_vv,
        "Update.from_vv must echo the peer-vv passed in"
    );
    assert!(update_bytes_len > 0, "Update bytes must be non-empty");

    // ── Step 3 — Wire-roundtrip + apply on B.
    let outgoing = SyncMessage::LoroSync {
        msg: update_msg,
        is_last: true,
    };
    let json = serde_json::to_string(&outgoing).expect("serialise update envelope");
    let received: SyncMessage = serde_json::from_str(&json).expect("deserialise update envelope");
    let received_inner = match received {
        SyncMessage::LoroSync { msg, .. } => msg,
        other => panic!("expected LoroSync, got {other:?}"),
    };
    let outcome = loro_sync::apply_remote(&pool_b, &registry_b, "device-B", received_inner)
        .await
        .expect("apply update");
    assert!(
        matches!(outcome, loro_sync::ApplyOutcome::Imported(_)),
        "update apply must report Imported, got {outcome:?}",
    );

    // ── Engine on B sees both X and Y.
    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B-final");
        let e = g.engine_mut();
        let snap_x = e
            .read_block(block_x)
            .expect("read X")
            .expect("X visible after update");
        let snap_y = e
            .read_block(block_y)
            .expect("read Y")
            .expect("Y visible after update");
        assert_eq!(snap_x.content, "x-content");
        assert_eq!(snap_y.content, "y-content");
        // #400: DENSE 1-based rank — Y is the second root child ⇒ 2.
        assert_eq!(snap_y.position, 2);
    }

    // ── SQL on B has both rows.
    let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id IN (?, ?)")
        .bind(block_x)
        .bind(block_y)
        .fetch_one(&pool_b)
        .await
        .expect("count rows");
    assert_eq!(row_count, 2, "both X and Y must land in SQL after update");

    materializer_b.shutdown();
}

/// Scenario 3 — concurrent disjoint creates converge via mutual
/// import.  Verifies `apply_remote` is commutative for non-conflicting
/// ops: A creates X, B creates Y, the two exchange snapshots, and
/// after both imports both engines + both SQL projections show
/// {X, Y}.  This locks the CRDT-merge invariant at the sync seam.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loro_sync_e2e_concurrent_disjoint_creates_converge() {
    use crate::loro::registry::LoroEngineRegistry;
    use crate::space::SpaceId;
    use crate::sync_protocol::loro_sync;

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let materializer_a = Materializer::new(pool_a.clone());
    let materializer_b = Materializer::new(pool_b.clone());

    let space = SpaceId::from_trusted("01HZPHASE3D12CONVERGENCESPC");
    let block_x = "01HZPHASE3D12CONVBLOCKXAAA1";
    let block_y = "01HZPHASE3D12CONVBLOCKYBBB2";

    // Both peers start fresh.  A creates X locally; B creates Y
    // locally — disjoint ops, no causal relationship.  Distinct
    // device-ids ensure distinct Loro PeerIDs, so the ops are truly
    // concurrent at the CRDT layer.
    let registry_a = LoroEngineRegistry::new();
    let registry_b = LoroEngineRegistry::new();
    {
        let mut g = registry_a
            .for_space(&space, "device-A")
            .expect("for_space A");
        g.engine_mut()
            .apply_create_block(block_x, "content", "from-A", None, 0)
            .expect("create X on A");
    }
    {
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        g.engine_mut()
            .apply_create_block(block_y, "content", "from-B", None, 1)
            .expect("create Y on B");
    }

    // Each side exports a snapshot.  Because the sender is the only
    // writer of its own ops, a Snapshot is what `prepare_outgoing(None)`
    // would produce — and is the safe choice when neither peer has
    // observed the other yet.
    let msg_from_a = loro_sync::prepare_outgoing(&registry_a, &space, "device-A", None)
        .await
        .expect("A prepare_outgoing");
    let msg_from_b = loro_sync::prepare_outgoing(&registry_b, &space, "device-B", None)
        .await
        .expect("B prepare_outgoing");

    // Wire-roundtrip both snapshots.
    let wire_a: SyncMessage = {
        let env = SyncMessage::LoroSync {
            msg: msg_from_a,
            is_last: true,
        };
        let json = serde_json::to_string(&env).expect("serialise A→B");
        serde_json::from_str(&json).expect("deserialise A→B")
    };
    let wire_b: SyncMessage = {
        let env = SyncMessage::LoroSync {
            msg: msg_from_b,
            is_last: true,
        };
        let json = serde_json::to_string(&env).expect("serialise B→A");
        serde_json::from_str(&json).expect("deserialise B→A")
    };
    let inner_a_to_b = match wire_a {
        SyncMessage::LoroSync { msg, .. } => msg,
        other => panic!("expected LoroSync A→B, got {other:?}"),
    };
    let inner_b_to_a = match wire_b {
        SyncMessage::LoroSync { msg, .. } => msg,
        other => panic!("expected LoroSync B→A, got {other:?}"),
    };

    // Mutual import: A applies B's snapshot, B applies A's snapshot.
    let outcome_ab = loro_sync::apply_remote(&pool_b, &registry_b, "device-B", inner_a_to_b)
        .await
        .expect("apply A→B");
    assert!(
        matches!(outcome_ab, loro_sync::ApplyOutcome::Imported(_)),
        "A→B apply must report Imported, got {outcome_ab:?}",
    );
    let outcome_ba = loro_sync::apply_remote(&pool_a, &registry_a, "device-A", inner_b_to_a)
        .await
        .expect("apply B→A");
    assert!(
        matches!(outcome_ba, loro_sync::ApplyOutcome::Imported(_)),
        "B→A apply must report Imported, got {outcome_ba:?}",
    );

    // ── Engine convergence — both engines see both blocks with the
    // original content + position.
    for (label, registry, pool, dev) in [
        ("A", &registry_a, &pool_a, "device-A"),
        ("B", &registry_b, &pool_b, "device-B"),
    ] {
        let mut g = registry
            .for_space(&space, dev)
            .unwrap_or_else(|e| panic!("for_space {label}: {e}"));
        let e = g.engine_mut();
        assert_eq!(
            e.count_alive_blocks().expect("count"),
            2,
            "{label}: must see both blocks after mutual import"
        );
        let snap_x = e
            .read_block(block_x)
            .expect("read X")
            .unwrap_or_else(|| panic!("{label}: X visible"));
        let snap_y = e
            .read_block(block_y)
            .expect("read Y")
            .unwrap_or_else(|| panic!("{label}: Y visible"));
        assert_eq!(snap_x.content, "from-A", "{label}: X content");
        assert_eq!(snap_y.content, "from-B", "{label}: Y content");
        // #400: positions are DENSE 1-based ranks. X (created at slot 0 on A)
        // and Y (slot 1 on B) are concurrent disjoint root creates; the CRDT
        // merge converges to a deterministic sibling order with Y before X on
        // both peers, so Y is rank 1 and X is rank 2.
        assert_eq!(snap_y.position, 1, "{label}: Y position");
        assert_eq!(snap_x.position, 2, "{label}: X position");

        // SQL projection on each side mirrors the engine state.
        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id IN (?, ?)")
            .bind(block_x)
            .bind(block_y)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|err| panic!("{label}: count rows: {err}"));
        assert_eq!(row_count, 2, "{label}: SQL must show both rows");
    }

    materializer_a.shutdown();
    materializer_b.shutdown();
}
