use super::snapshot_transfer::*;
use crate::snapshot::apply_snapshot;
use crate::snapshot::{
    BlockSnapshot, SCHEMA_VERSION, SnapshotData, SnapshotTables, create_snapshot, encode_snapshot,
    get_latest_snapshot,
};
use crate::sync_constants::BINARY_FRAME_CHUNK_SIZE;
use crate::sync_events::RecordingEventSink;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_protocol::{DeviceHead, SyncMessage};
use crate::transport::bulk::{recv_bulk, send_bulk};
use crate::transport::session::{recv_sync_message, send_sync_message};
use crate::transport::test_support::quic_pair;
use agaric_core::error::AppError;
use agaric_engine::materializer::Materializer;
use agaric_store::op::OpPayload;
use agaric_store::op_log::append_local_op;
use agaric_store::peer_refs;
use agaric_store::test_support::init_pool;
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

const LOCAL_DEV: &str = "01HZ00000000000000000LOCAL0";
const REMOTE_DEV: &str = "01HZ0000000000000000REMOTE0";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Seed a pool with one create_block op AND materialize it so that
/// `create_snapshot` produces a non-empty `blocks` table snapshot.
/// `append_local_op` only writes to `op_log`; without running the
/// materializer the derived `blocks` table stays empty and the
/// serialized snapshot contains zero rows (BUG caught during TDD:
/// snapshot apply succeeded but left an empty database).
async fn seed_one_block(pool: &SqlitePool, materializer: &Materializer, device_id: &str) {
    let payload = OpPayload::CreateBlock(agaric_store::op::CreateBlockPayload {
        block_id: agaric_core::ulid::BlockId::test_id("01HZ00000000000000000BLOCK1"),
        block_type: "content".into(),
        content: "hello".into(),
        parent_id: None,
        position: Some(1),
        index: None,
    });
    let record = append_local_op(pool, device_id, payload).await.unwrap();
    materializer.dispatch_op(&record).await.unwrap();
    materializer.flush_foreground().await.unwrap();
}

/// Legacy helper: seed the op log without materializing. Used by
/// tests that only need `create_snapshot` to succeed (which requires
/// a non-empty op_log) and don't assert on restored block contents.
async fn seed_one_op(pool: &SqlitePool, device_id: &str) {
    let payload = OpPayload::CreateBlock(agaric_store::op::CreateBlockPayload {
        block_id: agaric_core::ulid::BlockId::test_id("01HZ00000000000000000BLOCK1"),
        block_type: "content".into(),
        content: "hello".into(),
        parent_id: None,
        position: Some(1),
        index: None,
    });
    append_local_op(pool, device_id, payload).await.unwrap();
}

// -----------------------------------------------------------------
// Responder side: no snapshot → NoSnapshot
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_offer_snapshot_catchup_returns_no_snapshot_when_log_snapshots_empty() {
    let (pool, _dir) = test_pool().await;
    let mut pair = quic_pair().await;
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let outcome = try_offer_snapshot_catchup(
        &mut pair.server.send,
        &mut pair.server.recv,
        &pool,
        &event_sink,
        REMOTE_DEV,
        &[],
    )
    .await
    .expect("try_offer_snapshot_catchup must succeed on empty snapshots table");
    assert_eq!(
        outcome,
        OfferOutcome::NoSnapshot,
        "empty log_snapshots must produce OfferOutcome::NoSnapshot"
    );
}

// -----------------------------------------------------------------
// #793: a device that just went through a RESET must not offer its
// pre-reset snapshot to an old-lineage requester
// -----------------------------------------------------------------

/// #793 regression, end-to-end at the offer layer: the responder
/// took a local snapshot, then itself moved to a NEW lineage via a
/// snapshot RESET (`apply_snapshot`). A third device still on the
/// OLD lineage now asks for catch-up, advertising heads that the
/// Pre-reset snapshot covers — so the covering check alone
/// would let the offer through and re-ship the pre-reset vault.
/// Post-fix, `apply_snapshot` wipes `log_snapshots` in the RESET tx,
/// so the responder has nothing to offer (`NoSnapshot`) until it
/// snapshots its new state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_offer_snapshot_catchup_declines_pre_reset_snapshot_793() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // Pre-reset lineage: one local op, snapshotted. The snapshot's
    // frontier is {LOCAL_DEV: 1}.
    seed_one_op(&pool, LOCAL_DEV).await;
    create_snapshot(&pool, LOCAL_DEV)
        .await
        .expect("create_snapshot on the pre-reset lineage");
    assert!(
        get_latest_snapshot(&pool).await.unwrap().is_some(),
        "pre-condition: the pre-reset snapshot is offerable"
    );

    // The responder RESETs onto a peer's (empty) snapshot — a new
    // lineage. Mirrors `try_receive_snapshot_catchup`'s apply.
    let reset = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: REMOTE_DEV.to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: "reset-793".to_string(),
        tables: SnapshotTables {
            blocks: vec![],
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };
    let encoded = encode_snapshot(&reset).unwrap();
    apply_snapshot(&pool, &materializer, &encoded[..])
        .await
        .expect("RESET must succeed");

    // Old-lineage requester: its heads ({LOCAL_DEV: 1}) are covered
    // By the pre-reset snapshot, so alone would NOT block the
    // offer — pre-fix this call sent `SnapshotOffer` with the
    // pre-reset vault.
    let old_lineage_heads = vec![DeviceHead {
        device_id: LOCAL_DEV.to_string(),
        seq: 1,
        hash: "old-lineage".into(),
    }];
    let mut pair = quic_pair().await;
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let outcome = try_offer_snapshot_catchup(
        &mut pair.server.send,
        &mut pair.server.recv,
        &pool,
        &event_sink,
        REMOTE_DEV,
        &old_lineage_heads,
    )
    .await
    .expect("offer attempt must not error");
    assert_eq!(
        outcome,
        OfferOutcome::NoSnapshot,
        "#793: after a RESET the responder must have NOTHING to offer — \
             serving the pre-reset snapshot would re-ship the retired vault \
             to an old-lineage device"
    );

    materializer.shutdown();
}

// -----------------------------------------------------------------
// Responder side: offer → accepted → bytes streamed
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_offer_snapshot_catchup_streams_bytes_on_accept() {
    let (pool, _dir) = test_pool().await;
    seed_one_op(&pool, LOCAL_DEV).await;
    create_snapshot(&pool, LOCAL_DEV)
        .await
        .expect("create_snapshot must succeed for a non-empty op log");
    let (latest_id, latest_bytes) = get_latest_snapshot(&pool)
        .await
        .expect("get_latest_snapshot must succeed")
        .expect("snapshot must be present after create_snapshot");
    assert!(!latest_id.is_empty(), "snapshot ID must not be empty");
    let expected_size = latest_bytes.len() as u64;

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Both halves run on this task: the borrows into `pair` are disjoint
    // (`client.*` vs `server.*`), so `join!` avoids the `'static` bound a
    // `tokio::spawn` would impose on a live QUIC stream pair.
    let (outcome, received) = tokio::join!(
        try_offer_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &pool,
            &event_sink,
            REMOTE_DEV,
            &[],
        ),
        async {
            // Client side: expect SnapshotOffer, reply Accept, drain bytes.
            let offer = recv_sync_message(&mut client.recv).await.unwrap();
            match offer {
                SyncMessage::SnapshotOffer {
                    size_bytes,
                    blob_blake3,
                } => {
                    assert_eq!(
                        size_bytes, expected_size,
                        "offered size_bytes must match on-disk snapshot blob length"
                    );
                    // #706 item 2: the offer must carry the blake3 of the
                    // compressed blob the responder is about to stream.
                    assert_eq!(
                        blob_blake3,
                        blake3::hash(&latest_bytes).to_hex().to_string(),
                        "offered blob_blake3 must hash the snapshot blob"
                    );
                }
                other => panic!("expected SnapshotOffer, got {other:?}"),
            }
            send_sync_message(&mut client.send, &SyncMessage::SnapshotAccept)
                .await
                .unwrap();

            // The bytes now arrive as one uninterrupted run on the stream —
            // there are no binary frames to count any more, so the receiver
            // is told exactly how many bytes to pull and `recv_bulk` errors
            // if the peer stops short.
            let mut received: Vec<u8> = Vec::new();
            recv_bulk(
                &mut client.recv,
                &mut received,
                expected_size,
                MAX_SNAPSHOT_SIZE,
                |_| {},
            )
            .await
            .unwrap();
            received
        },
    );

    assert_eq!(
        received.len() as u64,
        expected_size,
        "initiator must receive exactly size_bytes from responder"
    );
    assert_eq!(
        received, latest_bytes,
        "bytes received must match the snapshot blob stored locally"
    );

    let outcome = outcome.unwrap();
    assert_eq!(
        outcome,
        OfferOutcome::Sent {
            bytes_sent: expected_size,
        },
        "responder must report Sent with full byte count"
    );
}

// -----------------------------------------------------------------
// Responder side: offer → rejected → no bytes streamed
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_offer_snapshot_catchup_handles_rejection() {
    let (pool, _dir) = test_pool().await;
    seed_one_op(&pool, LOCAL_DEV).await;
    create_snapshot(&pool, LOCAL_DEV).await.unwrap();

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let (outcome, ()) = tokio::join!(
        try_offer_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &pool,
            &event_sink,
            REMOTE_DEV,
            &[],
        ),
        async {
            // Read the offer, reply with Reject.
            let _offer = recv_sync_message(&mut client.recv).await.unwrap();
            send_sync_message(&mut client.send, &SyncMessage::SnapshotReject)
                .await
                .unwrap();
        },
    );

    let outcome = outcome.unwrap();
    assert_eq!(
        outcome,
        OfferOutcome::Rejected,
        "responder must report Rejected when initiator declines the offer"
    );
}

// -----------------------------------------------------------------
// Snapshot covering check
// -----------------------------------------------------------------

/// Truth-table for the private covering helper.
///
/// - empty heads → trivially Ok.
/// - head present, snapshot covers → Ok.
/// - head present, snapshot equal → Ok (covering is `>=`, not `>`).
/// - head present, snapshot behind → Err naming the device.
/// - head present, device absent from snapshot (treated as 0) and
///   remote claims seq > 0 → Err.
#[test]
fn snapshot_covers_remote_heads_truth_table() {
    let mut snap_seqs = BTreeMap::new();
    snap_seqs.insert("dev-A".to_string(), 10);
    snap_seqs.insert("dev-B".to_string(), 5);

    // Empty heads — trivially covered.
    assert!(snapshot_covers_remote_heads(&snap_seqs, &[]).is_ok());

    // Snapshot strictly ahead.
    let heads_ahead = vec![DeviceHead {
        device_id: "dev-A".into(),
        seq: 7,
        hash: "x".into(),
    }];
    assert!(snapshot_covers_remote_heads(&snap_seqs, &heads_ahead).is_ok());

    // Snapshot exactly at remote frontier.
    let heads_eq = vec![DeviceHead {
        device_id: "dev-A".into(),
        seq: 10,
        hash: "x".into(),
    }];
    assert!(snapshot_covers_remote_heads(&snap_seqs, &heads_eq).is_ok());

    // Snapshot behind for one device — fail.
    let heads_behind = vec![DeviceHead {
        device_id: "dev-B".into(),
        seq: 99,
        hash: "x".into(),
    }];
    let err = snapshot_covers_remote_heads(&snap_seqs, &heads_behind)
        .expect_err("seq=99 must not be covered by snapshot at seq=5");
    assert!(
        err.contains("dev-B") && err.contains("99") && err.contains('5'),
        "error message must name the offending device and seqs, got {err:?}"
    );

    // Device entirely absent from snapshot — fail (snap_seq treated as 0).
    let heads_unknown = vec![DeviceHead {
        device_id: "dev-NEW".into(),
        seq: 1,
        hash: "x".into(),
    }];
    let err = snapshot_covers_remote_heads(&snap_seqs, &heads_unknown)
        .expect_err("missing device entry must not silently cover seq>0");
    assert!(
        err.contains("dev-NEW"),
        "error must name the absent device, got {err:?}"
    );
}

/// Wire-level regression: when the latest local snapshot's
/// `up_to_seqs` is BEHIND the remote's advertised frontier,
/// `try_offer_snapshot_catchup` must send `SyncMessage::Error`
/// (NOT `SnapshotOffer`) so the initiator fails loudly instead of
/// Silently re-applying an older snapshot. Reported in.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_offer_snapshot_catchup_sends_error_when_snapshot_behind_remote() {
    let (pool, _dir) = test_pool().await;
    // Seed + snapshot a local op; snapshot's frontier will be
    // {LOCAL_DEV: 1}.
    seed_one_op(&pool, LOCAL_DEV).await;
    create_snapshot(&pool, LOCAL_DEV)
        .await
        .expect("create_snapshot must succeed with one local op");

    // Synthesize a remote-heads claim that is FAR ahead of the
    // snapshot for LOCAL_DEV. The covering check must reject.
    let remote_heads = vec![DeviceHead {
        device_id: LOCAL_DEV.to_string(),
        seq: 999,
        hash: "stale-frontier".into(),
    }];

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let (outcome, ()) = tokio::join!(
        try_offer_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &pool,
            &event_sink,
            REMOTE_DEV,
            &remote_heads,
        ),
        async {
            // The responder must NOT send a SnapshotOffer; it must send an
            // Error explaining the covering failure.
            let wire = recv_sync_message(&mut client.recv)
                .await
                .expect("responder must send a wire message even when snapshot is stale");
            match wire {
                SyncMessage::Error { message } => {
                    assert!(
                        message.contains(LOCAL_DEV),
                        " Error message must name the offending device, got {message:?}"
                    );
                    assert!(
                        message.contains("999"),
                        " Error message must include the remote's claimed seq, got {message:?}"
                    );
                }
                other => panic!("expected SyncMessage::Error for stale snapshot, got {other:?}"),
            }
        },
    );

    let outcome =
        outcome.expect("try_offer_snapshot_catchup must return Ok even when sending Error");
    match outcome {
        OfferOutcome::SnapshotStale { reason } => {
            assert!(
                reason.contains(LOCAL_DEV) && reason.contains("999"),
                "SnapshotStale reason must name the offending device and seq, got {reason:?}"
            );
        }
        other => panic!(
            "expected OfferOutcome::SnapshotStale when snapshot is behind remote, got {other:?}"
        ),
    }
}

// -----------------------------------------------------------------
// Initiator side: accepts and applies snapshot end-to-end
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_applies_snapshot_end_to_end() {
    // Build a "responder" DB with a snapshot to offer.
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_materializer = Materializer::new(resp_pool.clone());
    seed_one_block(&resp_pool, &resp_materializer, REMOTE_DEV).await;
    create_snapshot(&resp_pool, REMOTE_DEV).await.unwrap();
    let (_snap_id, snap_bytes) = get_latest_snapshot(&resp_pool).await.unwrap().unwrap();
    let expected_size = snap_bytes.len() as u64;

    // Build an "initiator" DB that is empty — simulates a peer that
    // has been reset and is catching up via snapshot.
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let recording = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = recording.clone();

    let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();

    let (outcome, ()) = tokio::join!(
        // Client side (initiator): receive + apply.
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
            None,
        ),
        // Server side (responder): send offer + bytes.
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: snap_hash,
                },
            )
            .await
            .unwrap();
            let accept = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            // Stream the blob as one uninterrupted run of bytes: there is
            // no per-frame chunking layer under the bi-stream any more.
            send_bulk(&mut server.send, &snap_bytes[..], expected_size, |_| {})
                .await
                .unwrap();
        },
    );

    let outcome = outcome.expect("initiator catch-up must succeed with a valid snapshot");

    materializer.flush_background().await.unwrap();

    match outcome {
        CatchupOutcome::Applied {
            bytes_received,
            up_to_hash,
        } => {
            assert_eq!(
                bytes_received, expected_size,
                "bytes_received must match the snapshot's on-wire size"
            );
            assert!(
                !up_to_hash.is_empty(),
                "up_to_hash must be populated from decoded snapshot"
            );
        }
        other => panic!("expected Applied, got {other:?}"),
    }

    // Verify the snapshot applied: the seeded block from the
    // responder DB should now exist in the initiator DB.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "initiator must have exactly the one block from the snapshot"
    );

    // Verify peer_refs bookkeeping was updated.
    let peer = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap()
        .expect("peer_refs row must exist after snapshot catch-up");
    assert!(
        peer.synced_at.is_some(),
        "synced_at must be populated after catch-up"
    );
    assert!(
        peer.last_hash.is_some(),
        "last_hash must be populated after catch-up"
    );

    // #2133 — the receive path must surface streaming progress. Filter
    // the recording sink for SnapshotProgress events: there must be at
    // least one "receiving" tick and exactly one terminal "complete"
    // tick whose bytes_done == bytes_total == expected_size.
    let snapshot_events: Vec<(String, u64, u64)> = snapshot_progress_events(&recording);
    assert!(
        snapshot_events
            .iter()
            .any(|(phase, _, _)| phase == "receiving"),
        "receive path must emit at least one 'receiving' SnapshotProgress tick"
    );
    let complete: Vec<&(String, u64, u64)> = snapshot_events
        .iter()
        .filter(|(phase, _, _)| phase == "complete")
        .collect();
    assert_eq!(
        complete.len(),
        1,
        "receive path must emit exactly one terminal 'complete' tick"
    );
    assert_eq!(
        complete[0].1, expected_size,
        "complete tick bytes_done must equal the full snapshot size"
    );
    assert_eq!(
        complete[0].2, expected_size,
        "complete tick bytes_total must equal the full snapshot size"
    );

    materializer.shutdown();
    resp_materializer.shutdown();
}

// -----------------------------------------------------------------
// #2133 — snapshot-transfer streaming progress
// -----------------------------------------------------------------

/// Pull the SnapshotProgress events out of a recording sink as
/// `(phase, bytes_done, bytes_total)` tuples for assertion.
fn snapshot_progress_events(sink: &RecordingEventSink) -> Vec<(String, u64, u64)> {
    sink.events()
        .into_iter()
        .filter_map(|e| match e {
            SyncEvent::SnapshotProgress {
                phase,
                bytes_done,
                bytes_total,
                ..
            } => Some((phase, bytes_done, bytes_total)),
            _ => None,
        })
        .collect()
}

/// #2133 happy path (send side): an accepted snapshot transfer must emit a
/// `"sending"` tick whose running `bytes_done` reaches the full size, then
/// exactly one terminal `"complete"` tick.
///
/// The tick cadence is now one per `BULK_COPY_BYTES` copy buffer rather than
/// one per binary frame; the assertions below are deliberately written against
/// "at least one 'sending' tick, exactly one 'complete' tick" so they hold at
/// either cadence and pin the contract the UI actually consumes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_offer_snapshot_catchup_emits_streaming_progress() {
    let (pool, _dir) = test_pool().await;
    seed_one_op(&pool, LOCAL_DEV).await;
    create_snapshot(&pool, LOCAL_DEV).await.unwrap();
    let (_id, latest_bytes) = get_latest_snapshot(&pool).await.unwrap().unwrap();
    let expected_size = latest_bytes.len() as u64;

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let recording = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = recording.clone();

    let (responded, ()) = tokio::join!(
        try_offer_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &pool,
            &event_sink,
            REMOTE_DEV,
            &[],
        ),
        async {
            // Accept the offer and drain the whole blob.
            let _offer = recv_sync_message(&mut client.recv).await.unwrap();
            send_sync_message(&mut client.send, &SyncMessage::SnapshotAccept)
                .await
                .unwrap();
            let mut sink = tokio::io::sink();
            recv_bulk(
                &mut client.recv,
                &mut sink,
                expected_size,
                MAX_SNAPSHOT_SIZE,
                |_| {},
            )
            .await
            .unwrap();
        },
    );
    responded.unwrap();

    let snapshot_events = snapshot_progress_events(&recording);
    assert!(
        snapshot_events
            .iter()
            .any(|(phase, _, _)| phase == "sending"),
        "send path must emit at least one 'sending' SnapshotProgress tick"
    );
    // Every tick advertises the same bytes_total (the full size).
    assert!(
        snapshot_events
            .iter()
            .all(|(_, _, total)| *total == expected_size),
        "every SnapshotProgress tick must carry bytes_total == size"
    );
    let complete: Vec<&(String, u64, u64)> = snapshot_events
        .iter()
        .filter(|(phase, _, _)| phase == "complete")
        .collect();
    assert_eq!(
        complete.len(),
        1,
        "send path must emit exactly one terminal 'complete' tick"
    );
    assert_eq!(
        complete[0].1, expected_size,
        "complete tick bytes_done must equal the full snapshot size"
    );
}

/// #2133 edge, rewritten for the bi-stream (#3464): a zero-size snapshot blob
/// puts **nothing** on the wire, and still emits a single `"complete"` terminal
/// tick with bytes_done == bytes_total == 0.
///
/// The old WebSocket transport sent one empty binary frame for `size_bytes == 0`
/// purely so the receiver's per-frame accounting had something to terminate on,
/// and the previous version of this test asserted that sentinel. QUIC has no
/// frames: an empty payload writes zero bytes. The sentinel is therefore not
/// merely unnecessary but *wrong* — anything written here would be consumed by
/// the receiver as the length prefix of the next framed message.
///
/// So the property under test is now the absence: after the zero-byte send, the
/// very next thing on the stream must be the next protocol message, byte-for-byte
/// aligned. Forced red by making `send_snapshot_bytes` write a single zero byte
/// before returning: `recv_sync_message` then fails on a garbage length prefix.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_snapshot_bytes_zero_size_writes_nothing_and_leaves_the_stream_aligned() {
    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let recording = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = recording.clone();

    let progress = SnapshotTransferProgress {
        event_sink: &event_sink,
        remote_device_id: REMOTE_DEV,
        bytes_total: 0,
    };
    send_snapshot_bytes(&mut server.send, &mut server.recv, &[], &progress)
        .await
        .unwrap();

    // The receiver's side of the same contract: asking for zero bytes must
    // consume zero bytes rather than block waiting for a sentinel.
    let mut drained: Vec<u8> = Vec::new();
    recv_bulk(&mut client.recv, &mut drained, 0, MAX_SNAPSHOT_SIZE, |_| {})
        .await
        .expect("a zero-byte bulk receive completes without reading anything");
    assert!(
        drained.is_empty(),
        "a zero-length snapshot must put no bytes at all on the wire"
    );

    // Alignment: the next framed message must read back exactly. If the send
    // path had emitted a sentinel, this length prefix would start one frame
    // late and deserialization would fail.
    send_sync_message(
        &mut server.send,
        &SyncMessage::SyncComplete {
            last_hash: "after-the-empty-snapshot".to_owned(),
        },
    )
    .await
    .unwrap();
    let next = recv_sync_message(&mut client.recv)
        .await
        .expect("the stream is still aligned after a zero-length snapshot");
    assert_eq!(
        next,
        SyncMessage::SyncComplete {
            last_hash: "after-the-empty-snapshot".to_owned(),
        },
        "the message after a zero-length snapshot must arrive unshifted"
    );

    let snapshot_events = snapshot_progress_events(&recording);
    let complete: Vec<&(String, u64, u64)> = snapshot_events
        .iter()
        .filter(|(phase, _, _)| phase == "complete")
        .collect();
    assert_eq!(
        complete.len(),
        1,
        "zero-size send must emit exactly one terminal 'complete' tick"
    );
    assert_eq!(
        (complete[0].1, complete[0].2),
        (0, 0),
        "zero-size complete tick must report 0/0 bytes"
    );
}

// -----------------------------------------------------------------
// #2046: a snapshot catch-up IS a protocol reset → reset_count bumps
// -----------------------------------------------------------------

/// #2046: a successful snapshot catch-up must increment the peer's
/// `reset_count` and stamp `last_reset_at`, atomically with the
/// `synced_at`/`last_hash` advance. This is the single production
/// caller of the increment — without it the counter (and the
/// `PeerListItem.tsx` "{reset_count} resets" badge) never moves.
///
/// Drives two back-to-back catch-ups against the same initiator and
/// asserts the 0 → 1 → 2 progression so a future double-count
/// regression (an extra increment per reset) would fail here.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_increments_reset_count_2046() {
    // Initiator DB (the peer being reset + caught up). It starts with
    // no peer_refs row, so reset_count effectively starts at 0.
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    // Run one catch-up from a freshly-built responder snapshot.
    // Returns after the bookkeeping tx (incl. the reset bump) commits.
    async fn drive_one_catchup(init_pool: &SqlitePool, materializer: &Materializer) {
        let (resp_pool, _resp_dir) = test_pool().await;
        let resp_materializer = Materializer::new(resp_pool.clone());
        seed_one_block(&resp_pool, &resp_materializer, REMOTE_DEV).await;
        create_snapshot(&resp_pool, REMOTE_DEV).await.unwrap();
        let (_snap_id, snap_bytes) = get_latest_snapshot(&resp_pool).await.unwrap().unwrap();
        let expected_size = snap_bytes.len() as u64;

        let mut pair = quic_pair().await;
        let (client, server) = (&mut pair.client, &mut pair.server);
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();

        let (outcome, ()) = tokio::join!(
            try_receive_snapshot_catchup(
                &mut client.send,
                &mut client.recv,
                init_pool,
                materializer,
                &event_sink,
                REMOTE_DEV,
                None,
                None,
            ),
            async {
                send_sync_message(
                    &mut server.send,
                    &SyncMessage::SnapshotOffer {
                        size_bytes: expected_size,
                        blob_blake3: snap_hash,
                    },
                )
                .await
                .unwrap();
                let accept = recv_sync_message(&mut server.recv).await.unwrap();
                assert_eq!(accept, SyncMessage::SnapshotAccept);
                send_bulk(&mut server.send, &snap_bytes[..], expected_size, |_| {})
                    .await
                    .unwrap();
            },
        );

        let outcome = outcome.expect("catch-up must succeed");
        assert!(
            matches!(outcome, CatchupOutcome::Applied { .. }),
            "expected Applied, got {outcome:?}"
        );

        materializer.flush_background().await.unwrap();
        resp_materializer.shutdown();
    }

    // First reset: 0 → 1.
    drive_one_catchup(&init_pool, &materializer).await;
    let peer = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap()
        .expect("peer_refs row must exist after the first catch-up");
    assert_eq!(
        peer.reset_count, 1,
        "#2046: reset_count must be 1 after the first snapshot catch-up"
    );
    assert!(
        peer.last_reset_at.is_some(),
        "#2046: last_reset_at must be stamped on a protocol reset"
    );
    // The reset is recorded in the SAME tx as the frontier advance.
    assert!(
        peer.synced_at.is_some() && peer.last_hash.is_some(),
        "synced_at/last_hash must also be set (atomic with the reset bump)"
    );

    // Second reset against the same initiator: 1 → 2 (exactly once
    // per reset — no double-count).
    drive_one_catchup(&init_pool, &materializer).await;
    let peer = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap()
        .expect("peer_refs row must still exist after the second catch-up");
    assert_eq!(
        peer.reset_count, 2,
        "#2046: reset_count must be 2 after a second catch-up (one bump per reset)"
    );

    materializer.shutdown();
}

// -----------------------------------------------------------------
// Initiator side: size cap → SnapshotReject
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_rejects_oversized_offer() {
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let oversized = MAX_SNAPSHOT_SIZE + 1;

    // The cap that fires here is still the PRE-OFFER one in
    // `try_receive_snapshot_catchup` — `recv_bulk`'s `max_size` is only a
    // backstop for a caller that skips the offer check, and this test asserts
    // the offer-time refusal by pinning the `SnapshotReject` on the wire and
    // the fact that no bytes are ever requested.
    let (outcome, ()) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
            None,
        ),
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes: oversized,
                    // Rejected on size before any receive/checksum.
                    blob_blake3: String::new(),
                },
            )
            .await
            .unwrap();
            // Expect a reject — no bytes will follow.
            let reply = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(reply, SyncMessage::SnapshotReject);
        },
    );

    let outcome = outcome.expect("catch-up must return Ok(Rejected) for oversized offer");
    assert_eq!(
        outcome,
        CatchupOutcome::Rejected {
            size_bytes: oversized,
        },
        "initiator must reject offers above MAX_SNAPSHOT_SIZE without touching DB"
    );

    // DB must be untouched: still zero blocks, no peer_refs row.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "rejected offer must NOT mutate the initiator's blocks table"
    );
    let peer = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap();
    assert!(
        peer.is_none(),
        "rejected offer must NOT create a peer_refs row"
    );
    materializer.shutdown();
}

// -----------------------------------------------------------------
// Initiator side: corrupted bytes → apply fails → DB untouched
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_rolls_back_on_corrupted_bytes() {
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Send a small under-the-cap size with garbage bytes. Decode
    // will fail inside apply_snapshot, which uses BEGIN IMMEDIATE
    // so the DB stays untouched.
    let garbage: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05];
    let size_bytes = garbage.len() as u64;

    // #706 item 2: advertise the CORRECT blake3 of the garbage so the
    // integrity check passes and the failure is the *decode* failure
    // this test pins (not an early checksum rejection).
    let garbage_hash = blake3::hash(&garbage).to_hex().to_string();

    let (result, ()) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
            None,
        ),
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes,
                    blob_blake3: garbage_hash,
                },
            )
            .await
            .unwrap();
            let accept = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            send_bulk(&mut server.send, &garbage[..], size_bytes, |_| {})
                .await
                .unwrap();
        },
    );
    assert!(
        result.is_err(),
        "corrupted snapshot bytes must return Err (decode failure)"
    );

    // DB must be untouched by the failed apply.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "failed apply_snapshot must roll back; blocks table must stay empty"
    );
    let peer = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap();
    assert!(
        peer.is_none(),
        "failed apply must NOT populate peer_refs (no successful catch-up)"
    );
    materializer.shutdown();
}

// -----------------------------------------------------------------
// #706 item 2: transfer checksum mismatch → reject before apply
// -----------------------------------------------------------------

/// A VALID, fully-decodable snapshot blob is streamed, but the offer
/// advertises the WRONG blake3 (simulating responder-side disk
/// corruption of the bytes between hashing and send, OR a transport
/// defect). The initiator must detect the mismatch and refuse to
/// apply — leaving the DB untouched and peer_refs unset — even though
/// the bytes would otherwise decode and apply cleanly.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_rejects_on_checksum_mismatch() {
    // Responder DB with a real, valid snapshot.
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_materializer = Materializer::new(resp_pool.clone());
    seed_one_block(&resp_pool, &resp_materializer, REMOTE_DEV).await;
    create_snapshot(&resp_pool, REMOTE_DEV).await.unwrap();
    let (_snap_id, snap_bytes) = get_latest_snapshot(&resp_pool).await.unwrap().unwrap();
    let expected_size = snap_bytes.len() as u64;

    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Deliberately WRONG hash (all zeros) — does not match the bytes.
    let wrong_hash = "0".repeat(64);

    let (result, ()) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
            None,
        ),
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: wrong_hash,
                },
            )
            .await
            .unwrap();
            let accept = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            send_bulk(&mut server.send, &snap_bytes[..], expected_size, |_| {})
                .await
                .unwrap();
        },
    );

    // The mismatch must surface as an Err naming the integrity check.
    let err = result.expect_err("checksum mismatch must return Err");
    let msg = err.to_string();
    assert!(
        msg.contains("integrity check failed"),
        "error must name the integrity check, got: {msg}"
    );

    // DB untouched — the valid bytes were NEVER applied because the
    // checksum gate fired first.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "checksum-rejected snapshot must not be applied; blocks stay empty"
    );
    let peer = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap();
    assert!(
        peer.is_none(),
        "checksum-rejected catch-up must NOT populate peer_refs"
    );

    materializer.shutdown();
    resp_materializer.shutdown();
}

// -----------------------------------------------------------------
// Snapshot transfer cancellation / interruption
// -----------------------------------------------------------------

/// The responder advertises a snapshot, the initiator accepts,
/// then the responder half-closes the stream after delivering only part of
/// the promised payload. The initiator must:
///
/// (a) return `Err` from `try_receive_snapshot_catchup`,
/// (b) leave the local DB untouched (no half-applied rows),
/// (c) NOT advance peer_refs (the catch-up did not complete).
///
/// This pins the `apply_snapshot` `BEGIN IMMEDIATE` whole-tx
/// rollback contract under the most realistic interruption path —
/// peer drop mid-stream. A future refactor that buffers bytes in a
/// way that admits partial application would be caught here.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_rolls_back_on_mid_stream_disconnect_l74() {
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    // Pre-condition: DB starts empty.
    let blocks_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(blocks_before, 0, "pre-condition: blocks must start empty");
    let peer_before = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap();
    assert!(
        peer_before.is_none(),
        "pre-condition: peer_refs must be empty"
    );

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Promise more bytes than we'll deliver. The receiver pulls the partial
    // 4 KB off the stream and then sees EOF with 60 KB still owed. Under the
    // old transport that showed up as a failed `recv_binary` on the next
    // frame; under QUIC there are no frames, so the party that notices is
    // `recv_bulk` — the only one that knows how many bytes were promised.
    let promised_size: u64 = 64 * 1024;
    let partial_chunk: Vec<u8> = vec![0u8; 4 * 1024];

    let (result, ()) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
            None,
        ),
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes: promised_size,
                    // Hash is irrelevant: the receive errors on EOF before
                    // the integrity check runs.
                    blob_blake3: String::new(),
                },
            )
            .await
            .unwrap();
            let accept = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            // Send only the partial chunk, then half-close the send half so
            // the initiator observes a clean EOF mid-payload.
            send_bulk(
                &mut server.send,
                &partial_chunk[..],
                partial_chunk.len() as u64,
                |_| {},
            )
            .await
            .unwrap();
            server
                .send
                .finish()
                .expect("half-closing the responder's send half");
        },
    );

    // (a) The interruption surfaces as Err — and specifically as the
    // truncation, not as some incidental downstream failure. Under the old
    // transport "the frame loop hit EOF" and "the blob would not decode" were
    // both just `Err`; the bulk receiver is the only party that knows how many
    // bytes were promised, so it can and does name the shortfall. Pinning both
    // counts is what stops this test from passing on the wrong error.
    let err = result.expect_err("mid-stream disconnect must surface as Err");
    let err_text = err.to_string();
    assert!(
        err_text.contains("4096") && err_text.contains("65536"),
        "the truncation must be reported with the bytes delivered and the bytes \
         promised, so the failure is unambiguous; got {err_text:?}"
    );

    // (b) The DB is untouched — `apply_snapshot` was never called
    // because the byte stream never reached the cap, AND if any
    // partial decode had been attempted, BEGIN IMMEDIATE would
    // have rolled it back.
    let blocks_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        blocks_after, 0,
        "interrupted snapshot must not leave any blocks"
    );

    // (c) No peer_refs row — the catch-up did not complete.
    let peer_after = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap();
    assert!(
        peer_after.is_none(),
        "interrupted snapshot must NOT advance peer_refs"
    );

    materializer.shutdown();
}

// -----------------------------------------------------------------
// Initiator side: non-offer first message → InvalidOperation
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_errors_on_unexpected_message() {
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Responder protocol-violates: sends SyncComplete instead of
    // SnapshotOffer after ResetRequired. One framed message, sent before the
    // receive starts — the initiator's read is bounded by `RECV_TIMEOUT`
    // now, so it has to actually find something on the stream.
    send_sync_message(
        &mut server.send,
        &SyncMessage::SyncComplete {
            last_hash: "deadbeef".into(),
        },
    )
    .await
    .unwrap();

    let result = try_receive_snapshot_catchup(
        &mut client.send,
        &mut client.recv,
        &init_pool,
        &materializer,
        &event_sink,
        REMOTE_DEV,
        None,
        None,
    )
    .await;
    assert!(result.is_err(), "unexpected message must surface as Err");
    match result.unwrap_err() {
        AppError::InvalidOperation(msg) => {
            assert!(
                msg.contains("expected SnapshotOffer"),
                "error message must mention the expected message type, got {msg:?}"
            );
        }
        other => panic!("expected InvalidOperation, got {other:?}"),
    }

    materializer.shutdown();
}

// -----------------------------------------------------------------
// Initiator side: peer surfaces Error instead of offer
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_surfaces_peer_error() {
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    send_sync_message(
        &mut server.send,
        &SyncMessage::Error {
            message: "responder internal error".into(),
        },
    )
    .await
    .unwrap();

    let result = try_receive_snapshot_catchup(
        &mut client.send,
        &mut client.recv,
        &init_pool,
        &materializer,
        &event_sink,
        REMOTE_DEV,
        None,
        None,
    )
    .await;
    assert!(result.is_err(), "peer Error must surface as Err");
    match result.unwrap_err() {
        AppError::InvalidOperation(msg) => {
            assert!(
                msg.contains("responder internal error"),
                "error message must include the peer's error text, got {msg:?}"
            );
        }
        other => panic!("expected InvalidOperation, got {other:?}"),
    }

    materializer.shutdown();
}

// -----------------------------------------------------------------
// Constants sanity
// -----------------------------------------------------------------

/// `BINARY_FRAME_CHUNK_SIZE` is no longer a *frame* size — under the bi-stream
/// it is `transport::bulk::BULK_COPY_BYTES`, the fixed copy buffer that bounds
/// peak heap during a transfer. The relationship that still matters is that the
/// receive cap admits at least one full buffer, or a max-size snapshot could not
/// be streamed at all.
#[test]
fn max_snapshot_size_is_at_least_one_copy_buffer() {
    // On any target where usize fits in u64, try_from succeeds. On
    // 32-bit targets where usize::MAX < MAX_SNAPSHOT_SIZE the cap
    // is effectively tighter — still valid.
    let cap_as_usize = usize::try_from(MAX_SNAPSHOT_SIZE).unwrap_or(usize::MAX);
    assert!(
        cap_as_usize >= BINARY_FRAME_CHUNK_SIZE,
        "MAX_SNAPSHOT_SIZE must admit at least one full bulk copy buffer"
    );
}

// -----------------------------------------------------------------
// Peer_refs fallback (empty remote_device_id)
// -----------------------------------------------------------------

/// Helper for the fallback / failure tests: drive a successful
/// snapshot transfer end-to-end with the given `remote_device_id` /
/// `expected_remote_id` pair and return the receive-side result so
/// the caller can assert on the resolved peer_refs row (or the
/// returned error).
///
/// The recording sink is returned as well (#4097): which peer id the emitted
/// events are attributed to is part of this path's contract, not incidental.
async fn run_catchup_with_ids(
    remote_device_id: &str,
    expected_remote_id: Option<&str>,
) -> (
    SqlitePool,
    TempDir,
    Result<CatchupOutcome, AppError>,
    Arc<RecordingEventSink>,
) {
    // Build a "responder" DB with a snapshot to offer.
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_materializer = Materializer::new(resp_pool.clone());
    seed_one_block(&resp_pool, &resp_materializer, REMOTE_DEV).await;
    create_snapshot(&resp_pool, REMOTE_DEV).await.unwrap();
    let (_snap_id, snap_bytes) = get_latest_snapshot(&resp_pool).await.unwrap().unwrap();
    let expected_size = snap_bytes.len() as u64;

    // Initiator (empty DB).
    let (init_pool, init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let recording = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = recording.clone();

    let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();

    let (result, ()) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            remote_device_id,
            expected_remote_id,
            None,
        ),
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: snap_hash,
                },
            )
            .await
            .unwrap();
            let accept = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            send_bulk(&mut server.send, &snap_bytes[..], expected_size, |_| {})
                .await
                .unwrap();
        },
    );

    materializer.flush_background().await.unwrap();
    materializer.shutdown();
    resp_materializer.shutdown();

    (init_pool, init_dir, result, recording)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_falls_back_to_expected_remote_id_when_session_id_empty() {
    // HeadExchange sometimes carries only our own heads, so
    // the initiator's `session.remote_device_id` ends up empty.
    // The daemon's `expected_remote_id` (from mTLS / mDNS) must
    // fill in so the peer_refs row uses the real peer identity.
    let (init_pool, _dir, result, _sink) = run_catchup_with_ids("", Some(REMOTE_DEV)).await;
    result.expect("catch-up must succeed when expected_remote_id provides the fallback");

    // Empty `remote_device_id` must NOT have produced an empty-keyed
    // peer_refs row.
    assert!(
        peer_refs::get_peer_ref(&init_pool, "")
            .await
            .unwrap()
            .is_none(),
        "fallback path must not write a peer_refs row keyed by empty string",
    );

    // The fallback peer_id (from expected_remote_id) must own the row.
    let fallback = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap()
        .expect("expected_remote_id must own the peer_refs row");
    assert!(
        fallback.synced_at.is_some(),
        "synced_at must be populated on the fallback row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_errors_when_both_remote_ids_empty() {
    // With neither `remote_device_id` nor `expected_remote_id`
    // available, the function must fail loudly so the scheduler
    // records a failed session — silently completing would write a
    // peer_refs row keyed by the empty string and corrupt the
    // bookkeeping.
    let (_init_pool, _dir, result, _sink) = run_catchup_with_ids("", None).await;
    let err = result.expect_err("catch-up must fail when both remote ids are empty");
    match err {
        AppError::InvalidOperation(msg) => {
            assert!(
                msg.contains("refusing to record peer_refs"),
                "error message should reference the empty-id failure; got {msg:?}",
            );
        }
        other => panic!("expected InvalidOperation, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_prefers_session_id_over_expected() {
    // When both ids are present and disagree, the
    // session-level `remote_device_id` (from HeadExchange) wins
    // because that's the value the protocol actually exchanged.
    let (init_pool, _dir, result, _sink) =
        run_catchup_with_ids(REMOTE_DEV, Some("OTHER_PEER_FROM_MTLS")).await;
    result.expect("catch-up must succeed when remote_device_id is non-empty");

    let session_owned = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap();
    let expected_owned = peer_refs::get_peer_ref(&init_pool, "OTHER_PEER_FROM_MTLS")
        .await
        .unwrap();
    assert!(
        session_owned.is_some() && expected_owned.is_none(),
        "session-level remote_device_id must own the peer_refs row when both ids are present",
    );
}

// -----------------------------------------------------------------
// #4097 — the fallback's log level, and who the events name
// -----------------------------------------------------------------

/// Thread-safe buffered writer for in-process log capture.
///
/// Mirrors the helper in `sync_protocol/tests.rs`. Kept module-local so each
/// test module stays self-contained (see AGENTS.md § "Test helper duplication
/// is intentional").
#[derive(Clone, Default)]
struct CatchupLogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CatchupLogBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CatchupLogBuf {
    type Writer = CatchupLogBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl CatchupLogBuf {
    fn contents(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

/// Install a scoped subscriber capturing every `agaric_sync` event down to
/// DEBUG, with the level rendered so a test can assert on it.
///
/// The catch-up runs inline on the test task (`tokio::join!` polls, it does not
/// spawn), and `block_on` drives that task on the thread `set_default` was
/// called from — so the thread-local subscriber is visible for the whole
/// transfer. Anything the runtime moves to a worker thread simply is not
/// captured, and none of the lines under test live there.
fn capture_catchup_logs() -> (CatchupLogBuf, tracing::subscriber::DefaultGuard) {
    use tracing_subscriber::layer::SubscriberExt;
    let writer = CatchupLogBuf::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("agaric_sync=debug"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_level(true)
                .with_target(true),
        );
    let guard = tracing::subscriber::set_default(subscriber);
    (writer, guard)
}

/// Return the captured lines that mention the identity fallback.
fn fallback_lines(logged: &str) -> Vec<&str> {
    logged
        .lines()
        .filter(|l| l.contains("remote_device_id was empty at snapshot catch-up"))
        .collect()
}

/// #4097 — falling back to the daemon-supplied peer identity is the DESIGNED
/// path on this code path, so it logs at DEBUG.
///
/// `HeadExchange` is initiator-*sent*, and the initiator is the only role that
/// ever reaches a catch-up, so a session id sourced from the authenticated peer
/// identity rather than from the wire is routine, not an anomaly. This site
/// logged it at `warn!` — a per-session warning on a healthy path, which is
/// precisely the shape of alert that trains people to ignore the level. #4085
/// demoted the structurally identical fallback in the session state machine;
/// leaving this one shouting made the pair inconsistent as well as wrong.
///
/// Both halves matter and the test pins both: the line must still be THERE
/// (demoting is not deleting — an operator diagnosing a mis-keyed `peer_refs`
/// row needs to know which source supplied the id), and it must be DEBUG.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_catchup_identity_fallback_logs_at_debug_not_warn_4097() {
    let (writer, guard) = capture_catchup_logs();
    let (_init_pool, _dir, result, _sink) = run_catchup_with_ids("", Some(REMOTE_DEV)).await;
    drop(guard);
    result.expect("precondition: the fallback path must still complete the catch-up");

    let logged = writer.contents();
    let lines = fallback_lines(&logged);
    assert_eq!(
        lines.len(),
        1,
        "the fallback must still say which source supplied the peer id — \
         demoting a level is not deleting the line. Captured:\n{logged}"
    );
    assert!(
        !lines[0].contains("WARN"),
        "#4097: the expected fallback must not WARN — it fires on the healthy \
         path, and a per-session warning on a healthy path is what teaches \
         readers to ignore warnings. Line: {}",
        lines[0]
    );
    assert!(
        lines[0].contains("DEBUG"),
        "#4097: and it must be DEBUG specifically, matching #4085's treatment of \
         the identical fallback in the session state machine. Line: {}",
        lines[0]
    );
}

/// #4097 — the WARN moves to the case that is actually surprising: a catch-up
/// that completed with no peer identity from *either* source.
///
/// This is the half that makes the demotion above safe to make. The level is
/// not being lowered because nothing here is worth warning about; it is being
/// lowered because the warning was attached to the wrong branch. Completing a
/// catch-up we cannot key a `peer_refs` row on is a real anomaly — the snapshot
/// is durable but unattributable, and the next sync treats the peer as unknown
/// again — and it logged *nothing* at `warn!` before.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_catchup_with_no_identity_at_all_still_warns_4097() {
    let (writer, guard) = capture_catchup_logs();
    let (_init_pool, _dir, result, _sink) = run_catchup_with_ids("", None).await;
    drop(guard);
    result.expect_err("precondition: no identity from either source must fail the catch-up");

    let logged = writer.contents();
    let warned = logged.lines().any(|l| {
        l.contains("WARN")
            && l.contains("refusing to key peer_refs bookkeeping on an empty peer_id")
    });
    assert!(
        warned,
        "#4097: the genuinely-no-identity case must WARN. That is the branch \
         worth a warning, and the one that had none. Captured:\n{logged}"
    );
    assert!(
        fallback_lines(&logged).is_empty(),
        "and it must not also claim a fallback happened — there was nothing to \
         fall back to. Captured:\n{logged}"
    );
}

/// #4097, the non-cosmetic half (the same one #4085 had): when the identity
/// comes from the fallback, every event the catch-up emits must still name the
/// peer.
///
/// The id was resolved only at the completion write, so a fallback session
/// emitted `Progress`, `SnapshotProgress` and its terminal `Complete` with
/// `remote_device_id: ""` — a UI keyed on that field drops or mis-attributes
/// the whole transfer, including the progress bar for a multi-hundred-MB
/// snapshot. Resolving up front fixes the events, not just the log line.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_catchup_events_carry_the_resolved_peer_id_4097() {
    let (_init_pool, _dir, result, sink) = run_catchup_with_ids("", Some(REMOTE_DEV)).await;
    result.expect("the fallback path must complete the catch-up");

    let events = sink.events();
    // The four peer-keyed variants a catch-up emits. The daemon-level
    // variants (MdnsDisabled, InternetFacingBind, …) are not peer-scoped and
    // this path never emits them.
    let peer_ids: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            SyncEvent::Progress {
                remote_device_id, ..
            }
            | SyncEvent::SnapshotProgress {
                remote_device_id, ..
            }
            | SyncEvent::Complete {
                remote_device_id, ..
            }
            | SyncEvent::Error {
                remote_device_id, ..
            } => Some(remote_device_id.clone()),
            _ => None,
        })
        .collect();

    assert!(
        !peer_ids.is_empty(),
        "precondition: the catch-up must emit events at all"
    );
    assert!(
        peer_ids.iter().all(|id| id == REMOTE_DEV),
        "#4097: every event of a fallback-identity catch-up must name the peer \
         the daemon authenticated. An event carrying \"\" is dropped or \
         mis-attributed by any peer-keyed UI. Got: {peer_ids:?}"
    );
}

// -----------------------------------------------------------------
// Streaming snapshot transfer regression suite
// -----------------------------------------------------------------
//
// + paired sync streaming items. The wire-side primitive is now
// `transport::bulk::{send,recv}_bulk` (it was
// `send/receive_binary_streaming`); this layer puts a temp file on
// top so the receiver lands the compressed snapshot on disk one
// `BULK_COPY_BYTES` buffer at a time instead of accumulating it in a
// `Vec<u8>`. `apply_snapshot` then reads through that temp file via
// the streaming `decode_snapshot(impl Read)` path so neither the
// compressed bytes nor the decompressed CBOR is ever fully
// materialised in memory.

/// Confirm `try_receive_snapshot_catchup` writes the
/// incoming bytes to a temp file under the app data dir before
/// applying, and that the temp file is unlinked once the call returns.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_receive_streams_to_temp_file_m51_l67() {
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_materializer = Materializer::new(resp_pool.clone());
    seed_one_block(&resp_pool, &resp_materializer, REMOTE_DEV).await;
    create_snapshot(&resp_pool, REMOTE_DEV).await.unwrap();
    let (_snap_id, snap_bytes) = get_latest_snapshot(&resp_pool).await.unwrap().unwrap();
    let expected_size = snap_bytes.len() as u64;

    let (init_pool, init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());
    // Snapshot temp lands under `app_data_dir_from_pool(init_pool)`,
    // which is the temp dir's root (the DB lives in
    // `<init_dir>/test.db`).
    let app_data_dir = init_dir.path().to_path_buf();

    // Pre-condition: no `snapshot-recv-*.tmp` files yet.
    let tmp_count_before = count_snapshot_tmp_files(&app_data_dir);
    assert_eq!(
        tmp_count_before, 0,
        "no snapshot temp files must exist before catch-up"
    );

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();

    let (outcome, ()) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
            None,
        ),
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: snap_hash,
                },
            )
            .await
            .unwrap();
            let accept = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            send_bulk(&mut server.send, &snap_bytes[..], expected_size, |_| {})
                .await
                .unwrap();
        },
    );

    let outcome = outcome.expect(" catch-up must succeed end-to-end");

    materializer.flush_background().await.unwrap();

    // Post-condition: catch-up applied, temp file unlinked
    // (drop of `SnapshotTempFile` on the success path).
    match outcome {
        CatchupOutcome::Applied { bytes_received, .. } => {
            assert_eq!(bytes_received, expected_size);
        }
        other => panic!("expected Applied, got {other:?}"),
    }
    let tmp_count_after = count_snapshot_tmp_files(&app_data_dir);
    assert_eq!(
        tmp_count_after, 0,
        "snapshot temp file must be unlinked once catch-up returns; \
             dir = {app_data_dir:?}"
    );

    // The applied snapshot's content is visible.
    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(blocks, 1, "applied snapshot must restore the seeded block");

    materializer.shutdown();
    resp_materializer.shutdown();
}

/// `apply_snapshot` now takes `impl std::io::Read`. Passing
/// a `std::io::Cursor` (the simplest in-memory `Read`) must work
/// identically to the old `&[u8]` shape.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_snapshot_accepts_impl_read_m51_l67() {
    // Build a snapshot blob from a non-empty source DB so apply
    // has something to restore.
    let (src_pool, _src_dir) = test_pool().await;
    let src_mat = Materializer::new(src_pool.clone());
    seed_one_block(&src_pool, &src_mat, REMOTE_DEV).await;
    create_snapshot(&src_pool, REMOTE_DEV).await.unwrap();
    let (_id, encoded) = get_latest_snapshot(&src_pool).await.unwrap().unwrap();

    // Apply via Cursor (impl Read).
    let (dst_pool, _dst_dir) = test_pool().await;
    let dst_mat = Materializer::new(dst_pool.clone());
    let cursor = std::io::Cursor::new(encoded.clone());
    let restored = crate::snapshot::apply_snapshot(&dst_pool, &dst_mat, cursor)
        .await
        .expect("apply_snapshot must accept a Cursor reader");

    // The restored frontier matches the original encoded blob's
    // frontier (sanity check — the decoded data is the same).
    let decoded = crate::snapshot::decode_snapshot(&encoded[..]).unwrap();
    assert_eq!(restored.up_to_hash, decoded.up_to_hash);
    assert_eq!(restored.up_to_seqs, decoded.up_to_seqs);

    // The restored DB has the seeded block.
    dst_mat.flush_background().await.unwrap();
    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&dst_pool)
        .await
        .unwrap();
    assert_eq!(blocks, 1);

    src_mat.shutdown();
    dst_mat.shutdown();
}

/// When the receive fails post-stream (corrupted bytes →
/// `apply_snapshot` returns an error), the snapshot temp file
/// must be unlinked so abandoned transfers do not leak.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_receive_drops_temp_on_failure_m51_l67() {
    let (init_pool, init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());
    let app_data_dir = init_dir.path().to_path_buf();

    // Pre-condition.
    assert_eq!(count_snapshot_tmp_files(&app_data_dir), 0);

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Send garbage that fits under the cap but won't decode.
    let garbage: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07];
    let size_bytes = garbage.len() as u64;
    // #706 item 2: correct hash so the failure is the decode failure
    // this test pins (the temp must still be unlinked on that path).
    let garbage_hash = blake3::hash(&garbage).to_hex().to_string();

    let (result, ()) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
            None,
        ),
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes,
                    blob_blake3: garbage_hash,
                },
            )
            .await
            .unwrap();
            let accept = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            send_bulk(&mut server.send, &garbage[..], size_bytes, |_| {})
                .await
                .unwrap();
        },
    );
    assert!(
        result.is_err(),
        "garbage snapshot bytes must surface as Err; got {result:?}"
    );

    // Post-condition: failed apply propagates AppError; the
    // `SnapshotTempFile` guard must have unlinked the temp on
    // its way out of scope.
    let tmp_count_after = count_snapshot_tmp_files(&app_data_dir);
    assert_eq!(
        tmp_count_after, 0,
        "temp must be unlinked on apply failure; dir = {app_data_dir:?}"
    );

    materializer.shutdown();
}

/// `decode_snapshot` must use `zstd::stream::Decoder` (not
/// `zstd::decode_all`) so a snapshot that decompresses to a much
/// larger CBOR blob than the compressed payload does NOT
/// materialise the full decompressed stream on the heap. This is
/// a structural / API-level check: we round-trip through the new
/// `impl Read` signature with a payload whose decompressed size
/// is meaningfully larger than the compressed size, and confirm
/// the API works without relying on the buffered shape.
#[test]
fn decode_snapshot_with_zstd_streaming_decoder_does_not_buffer_full_decompressed_m51_l67() {
    // Build a large-ish `SnapshotData` so the encoded payload has
    // a non-trivial compressed-vs-decompressed ratio. Repeated
    // similar block content compresses extremely well — the
    // decompressed CBOR is several × the compressed bytes.
    let mut blocks = Vec::with_capacity(1000);
    for i in 0..1000 {
        blocks.push(BlockSnapshot {
            id: format!("01HZ{i:026X}")
                .chars()
                .take(26)
                .collect::<String>()
                .into(),
            block_type: "content".into(),
            content: Some(format!(
                "Highly compressible block content #{i} \
                     with a lot of repeated boilerplate to give zstd \
                     something to gnaw on. Lorem ipsum dolor sit amet, \
                     consectetur adipiscing elit, sed do eiusmod tempor."
            )),
            parent_id: None,
            position: Some(i64::from(i) + 1),
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            space_id: None,
        });
    }
    let mut up_to_seqs = BTreeMap::new();
    up_to_seqs.insert("dev-A".to_string(), 1000);
    let data = SnapshotData {
        schema_version: SCHEMA_VERSION,
        snapshot_device_id: "dev-A".to_string(),
        up_to_seqs,
        up_to_hash: "deadbeef".to_string(),
        tables: SnapshotTables {
            blocks,
            block_tags: vec![],
            block_properties: vec![],
            block_links: vec![],
            attachments: vec![],
            property_definitions: vec![],
            page_aliases: vec![],
        },
    };

    let encoded = crate::snapshot::encode_snapshot(&data).unwrap();

    // Sanity-check the test fixture: the decompressed CBOR is at
    // least 3× the compressed size, so the streaming-vs-buffered
    // distinction is observable.
    // #1586: `encode_snapshot` now frames the zstd payload behind a
    // magic + blake3 checksum header, so feed the raw zstd decoder the
    // payload region (from the zstd frame magic onward), not the header.
    let zstd_start = encoded
        .windows(4)
        .position(|w| w == [0x28, 0xB5, 0x2F, 0xFD])
        .expect("zstd frame magic present");
    let payload = &encoded[zstd_start..];
    let mut decoder = zstd::stream::Decoder::new(payload).unwrap();
    let mut decompressed = Vec::new();
    std::io::Read::read_to_end(&mut decoder, &mut decompressed).unwrap();
    assert!(
        decompressed.len() >= payload.len() * 3,
        "test fixture must decompress to ≥3× the compressed size \
             (compressed={} bytes, decompressed={} bytes) so the streaming \
             decoder's value is observable",
        encoded.len(),
        decompressed.len(),
    );

    // The streaming decoder accepts a `Cursor` (impl Read) and
    // reproduces the same `SnapshotData`. The fact that the
    // decoded value matches end-to-end is the API contract;
    // the implementation is `zstd::stream::Decoder::new(reader)`
    // followed by `ciborium::from_reader(decoder)` which never
    // materialises the full decompressed Vec.
    let cursor = std::io::Cursor::new(encoded);
    let decoded = crate::snapshot::decode_snapshot(cursor).unwrap();
    assert_eq!(decoded.tables.blocks.len(), 1000);
    assert_eq!(decoded.up_to_hash, data.up_to_hash);
    assert_eq!(decoded.up_to_seqs, data.up_to_seqs);
}

/// Helper used by the temp-file tests above: count
/// `snapshot-recv-*.tmp` entries directly under `dir`. We use a
/// shallow read_dir scan rather than walking — the temp file is
/// always created as a direct child of `app_data_dir` per
/// `receive_snapshot_to_temp`'s contract.
fn count_snapshot_tmp_files(dir: &std::path::Path) -> usize {
    match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("snapshot-recv-")
            })
            .count(),
        Err(_) => 0,
    }
}

/// #2696 — the boot-time sweep must remove stale
/// `snapshot-recv-*.tmp` orphans (left by a process that died before
/// `SnapshotTempFile::Drop` ran) while leaving every non-matching
/// entry untouched: unrelated files, a `snapshot-recv-*` name without
/// the `.tmp` suffix, and a directory that happens to match the
/// pattern.
#[test]
fn sweep_removes_only_orphaned_snapshot_temps_2696() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    // Two stale orphans matching the real `receive_snapshot_to_temp`
    // naming scheme.
    let orphan_a = root.join("snapshot-recv-0123456789abcdef0123456789abcdef.tmp");
    let orphan_b = root.join("snapshot-recv-fedcba9876543210fedcba9876543210.tmp");
    std::fs::write(&orphan_a, b"stale partial snapshot A").unwrap();
    std::fs::write(&orphan_b, b"stale partial snapshot B").unwrap();

    // Must-survive entries:
    //  * the real database and an unrelated temp,
    //  * a `snapshot-recv-*` file WITHOUT the `.tmp` suffix,
    //  * a directory whose name matches the pattern.
    let db = root.join("notes.db");
    let unrelated = root.join("something-else.tmp");
    let no_suffix = root.join("snapshot-recv-partialname");
    std::fs::write(&db, b"db").unwrap();
    std::fs::write(&unrelated, b"unrelated").unwrap();
    std::fs::write(&no_suffix, b"no suffix").unwrap();
    let matching_dir = root.join("snapshot-recv-lookslikeatemp.tmp");
    std::fs::create_dir(&matching_dir).unwrap();

    let removed = super::sweep_orphaned_snapshot_temps(root);

    assert_eq!(removed, 2, "exactly the two orphaned temps must be removed");
    assert!(!orphan_a.exists(), "orphan A must be swept");
    assert!(!orphan_b.exists(), "orphan B must be swept");
    assert!(db.exists(), "the database must never be swept");
    assert!(unrelated.exists(), "unrelated .tmp must survive");
    assert!(
        no_suffix.exists(),
        "a snapshot-recv name without .tmp must survive"
    );
    assert!(
        matching_dir.is_dir(),
        "a directory matching the pattern must not be removed"
    );
}

/// #2696 — a sweep over a directory that does not exist must not
/// panic and must report zero removals (defensive: boot can race
/// `create_dir_all`).
#[test]
fn sweep_missing_dir_is_noop_2696() {
    let dir = TempDir::new().unwrap();
    let missing = dir.path().join("does-not-exist");
    assert_eq!(super::sweep_orphaned_snapshot_temps(&missing), 0);
}

// -----------------------------------------------------------------
// #607 / #779 — same-process engine + sidecar reset on catch-up
// -----------------------------------------------------------------

/// #607 — the catch-up must leave the SAME process coherent: the
/// SQL RESET wipes `loro_doc_state` / `loro_sync_inbox` and zeroes
/// the apply cursor, and the in-memory engine registry is dropped +
/// reloaded so no pre-reset CRDT state survives. A "second session"
/// in the same process (a local edit + a fresh op through the
/// materializer) must land on the post-snapshot state: the engine
/// export carries the new edit and NONE of the pre-reset vault, and
/// the zeroed cursor tracks the fresh op_log from seq 1 (pre-fix it
/// stayed wedged at the stale pre-reset value via the MAX() gate).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_resets_engines_for_same_process_session_607() {
    use agaric_engine::loro::registry::LoroEngineRegistry;
    use agaric_store::space::SpaceId;

    const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    // ── Responder DB: one materialized block + snapshot ──────────
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_materializer = Materializer::new(resp_pool.clone());
    seed_one_block(&resp_pool, &resp_materializer, REMOTE_DEV).await;
    create_snapshot(&resp_pool, REMOTE_DEV).await.unwrap();
    let (_snap_id, snap_bytes) = get_latest_snapshot(&resp_pool).await.unwrap().unwrap();
    let expected_size = snap_bytes.len() as u64;

    // ── Initiator: pre-reset engine + sidecar state ──────────────
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());
    let registry = LoroEngineRegistry::new();
    let space = SpaceId::from_trusted(SPACE);
    {
        let mut g = registry.for_space(&space, LOCAL_DEV).unwrap();
        g.engine_mut()
            .apply_create_block("BLOCK_PRE_RESET", "content", "old vault", None, 0)
            .unwrap();
    }
    {
        let mut g = registry.for_space(&space, LOCAL_DEV).unwrap();
        agaric_engine::loro::snapshot::save_snapshot(&init_pool, &space, g.engine_mut())
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
        .bind(SPACE)
        .bind(vec![1u8, 2, 3])
        .bind(1_736_942_400_000_i64)
        .execute(&init_pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE materializer_apply_cursor SET materialized_through_seq = 42, \
             updated_at = 1 WHERE id = 1",
    )
    .execute(&init_pool)
    .await
    .unwrap();

    // ── Wire transfer ─────────────────────────────────────────────
    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();

    let (outcome, ()) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
            Some(EngineReloadCtx {
                registry: &registry,
                device_id: LOCAL_DEV,
            }),
        ),
        async {
            send_sync_message(
                &mut server.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: snap_hash,
                },
            )
            .await
            .unwrap();
            let accept = recv_sync_message(&mut server.recv).await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            send_bulk(&mut server.send, &snap_bytes[..], expected_size, |_| {})
                .await
                .unwrap();
        },
    );

    let outcome = outcome.expect("catch-up must succeed");
    assert!(matches!(outcome, CatchupOutcome::Applied { .. }));

    // ── Sidecar SQL reset ────────────────────────────────────────
    let doc_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_state")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(doc_rows, 0, "#607: loro_doc_state must be wiped");
    let inbox_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(inbox_rows, 0, "#607: loro_sync_inbox must be emptied");
    let cursor: i64 = sqlx::query_scalar(
        "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
    )
    .fetch_one(&init_pool)
    .await
    .unwrap();
    assert_eq!(cursor, 0, "#607: apply cursor must be zeroed");

    // ── In-memory engine reset ───────────────────────────────────
    assert_eq!(
        registry.len(),
        0,
        "#607: pre-reset engines must be dropped from the live registry"
    );

    // ── Same-process "second session": local edit on the engine ──
    // The next engine access lazy-creates a fresh post-reset engine;
    // its export (what prepare_outgoing would ship) must contain the
    // new edit and no pre-reset content.
    {
        let mut g = registry.for_space(&space, LOCAL_DEV).unwrap();
        let engine = g.engine_mut();
        engine
            .apply_create_block("BLOCK_POST_RESET", "content", "new edit", None, 0)
            .unwrap();
        assert!(
            engine.read_block("BLOCK_PRE_RESET").unwrap().is_none(),
            "#607: pre-reset vault must not survive into the post-reset engine"
        );
        let export = engine.export_snapshot().unwrap();
        let mut probe = agaric_engine::loro::engine::LoroEngine::with_peer_id(LOCAL_DEV).unwrap();
        probe.import(&export).unwrap();
        assert!(
            probe.read_block("BLOCK_POST_RESET").unwrap().is_some(),
            "the post-reset edit must be in the engine export"
        );
        assert!(
            probe.read_block("BLOCK_PRE_RESET").unwrap().is_none(),
            "#607: the engine export must not re-ship pre-reset content"
        );
    }

    // ── Fresh op through the materializer tracks the zeroed cursor ─
    // Post-reset op_log is empty, so the first local op mints seq 1;
    // the MAX()-gated cursor advance must land exactly there (pre-fix
    // the stale cursor [42] swallowed it and stayed at 42).
    let payload = OpPayload::CreateBlock(agaric_store::op::CreateBlockPayload {
        block_id: agaric_core::ulid::BlockId::test_id("01HZ0000000000000000BLOCK2"),
        block_type: "content".into(),
        content: "post-snapshot op".into(),
        parent_id: None,
        position: Some(2),
        index: None,
    });
    let record = append_local_op(&init_pool, LOCAL_DEV, payload)
        .await
        .unwrap();
    assert_eq!(record.seq, 1, "post-RESET op_log must restart at seq 1");
    materializer.dispatch_op(&record).await.unwrap();
    materializer.flush_foreground().await.unwrap();
    let cursor: i64 = sqlx::query_scalar(
        "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
    )
    .fetch_one(&init_pool)
    .await
    .unwrap();
    assert_eq!(
        cursor, 1,
        "#607: the zeroed cursor must track the fresh op_log (a stale \
             pre-reset cursor would stay at 42 via the MAX() gate)"
    );

    // ── SQL state: snapshot block + the new local block ──────────
    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        blocks, 2,
        "SQL must hold the snapshot block plus the post-reset local block"
    );

    materializer.shutdown();
    resp_materializer.shutdown();
}

// -----------------------------------------------------------------
// #2503 — Loro-snapshot catch-up (merge, not wipe)
// -----------------------------------------------------------------

/// #2503 end-to-end at the sub-flow layer: a responder far ahead in a
/// space, an initiator holding an UNSYNCED local edit in the same space.
/// The Loro-snapshot catch-up (`try_offer_loro_snapshot_catchup` ↔
/// `try_receive_snapshot_catchup`) MERGES the responder's snapshot into
/// the initiator's engine and reprojects SQL. Post-session the initiator
/// holds the UNION of both blocks — the local edit SURVIVES (inverting the
/// #2474 wipe contract) — and no `reset_count` bump occurs (a merge is a
/// pull, not a reset).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn loro_snapshot_catchup_merges_and_preserves_unsynced_local_2503() {
    use agaric_engine::loro::registry::LoroEngineRegistry;
    use agaric_store::space::SpaceId;

    const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let space = SpaceId::from_trusted(SPACE);

    // Responder: engine holds the far-ahead block (no SQL row needed —
    // the offer exports from the engine registry, not from SQL tables).
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_registry = LoroEngineRegistry::new();
    {
        let mut g = resp_registry.for_space(&space, REMOTE_DEV).unwrap();
        g.engine_mut()
            .apply_create_block("RESPBLOCK001", "content", "responder ahead", None, 0)
            .unwrap();
    }

    // Initiator: engine + SQL hold an UNSYNCED local block under a
    // DISTINCT device id (so its Loro PeerID differs — no #792 self-fork
    // when it imports the responder's snapshot).
    let (init_pool, _init_dir) = test_pool().await;
    let init_mat = Materializer::new(init_pool.clone());
    let init_registry = LoroEngineRegistry::new();
    {
        let mut g = init_registry.for_space(&space, LOCAL_DEV).unwrap();
        g.engine_mut()
            .apply_create_block("INITLOCAL001", "content", "unsynced local", None, 0)
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'content', 'unsynced local', 1)",
    )
    .bind("INITLOCAL001")
    .execute(&init_pool)
    .await
    .unwrap();

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Drive both sides concurrently on one task (borrows, no 'static).
    let (offer_res, recv_res) = tokio::join!(
        try_offer_loro_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &resp_pool,
            &resp_registry,
            &resp_sink,
            REMOTE_DEV, // responder's own device id
            LOCAL_DEV,  // the initiator, as the responder sees it
        ),
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &init_mat,
            &init_sink,
            REMOTE_DEV, // the peer (responder)
            None,
            Some(EngineReloadCtx {
                registry: &init_registry,
                device_id: LOCAL_DEV,
            }),
        ),
    );

    let sent = offer_res.expect("responder offer must succeed");
    assert_eq!(
        sent.spaces_sent, 1,
        "responder must stream exactly one space snapshot"
    );
    let outcome = recv_res.expect("initiator merge catch-up must succeed");
    assert!(
        matches!(outcome, CatchupOutcome::Applied { .. }),
        "expected Applied, got {outcome:?}"
    );

    init_mat.flush_background().await.unwrap();

    // ── SQL union: both blocks present ───────────────────────────────
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        count, 2,
        "initiator SQL must hold the UNION: its unsynced local block + the \
             merged responder block"
    );
    for (id, content) in [
        ("INITLOCAL001", "unsynced local"),
        ("RESPBLOCK001", "responder ahead"),
    ] {
        let got: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&init_pool)
            .await
            .unwrap_or_else(|_| panic!("block {id} must exist in initiator SQL after merge"));
        assert_eq!(got, content, "block {id} content must survive the merge");
    }

    // ── Engine union: both blocks live in the merged engine ──────────
    {
        let mut g = init_registry.for_space(&space, LOCAL_DEV).unwrap();
        let engine = g.engine_mut();
        assert!(
            engine.read_block("INITLOCAL001").unwrap().is_some(),
            "#2503: the initiator's unsynced local edit must survive in the engine"
        );
        assert!(
            engine.read_block("RESPBLOCK001").unwrap().is_some(),
            "#2503: the responder's block must be merged into the engine"
        );
    }

    // ── Merge is a pull, not a reset ─────────────────────────────────
    let peer = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap()
        .expect("peer_refs row must exist after the merge catch-up");
    assert!(
        peer.synced_at.is_some(),
        "synced_at must be populated after the merge (it is a pull)"
    );
    assert_eq!(
        peer.reset_count, 0,
        "#2503: a Loro-snapshot MERGE must NOT bump reset_count (no reset occurred)"
    );

    // ── loro_doc_state was NOT wiped — the merged engine persists ─────
    // (The legacy CBOR path would have zeroed these; the merge leaves the
    // sidecar intact, only writing the write-ahead inbox for the import.)
    init_mat.shutdown();
}

/// #2503: a responder whose engine registry is empty has nothing to
/// export — it sends a terminal `SyncComplete` and reports `spaces_sent: 0`
/// rather than streaming a zero-space payload.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn loro_snapshot_catchup_empty_registry_offers_nothing_2503() {
    use agaric_engine::loro::registry::LoroEngineRegistry;

    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_registry = LoroEngineRegistry::new();
    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let (offer_res, first) = tokio::join!(
        try_offer_loro_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &resp_pool,
            &resp_registry,
            &sink,
            REMOTE_DEV,
            LOCAL_DEV,
        ),
        async { recv_sync_message(&mut client.recv).await },
    );

    let sent = offer_res.expect("offer must succeed even with nothing to send");
    assert_eq!(
        sent,
        LoroCatchupSent {
            spaces_sent: 0,
            bytes_sent: 0
        },
        "empty registry must report nothing sent"
    );
    assert!(
        matches!(first.expect("recv"), SyncMessage::SyncComplete { .. }),
        "empty offer must terminate with SyncComplete so the initiator stops waiting"
    );
}
