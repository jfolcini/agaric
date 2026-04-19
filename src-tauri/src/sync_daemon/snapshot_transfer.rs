//! Snapshot-driven catch-up for the sync orchestrator (FEAT-6).
//!
//! When a peer's head-exchange check finds that its local op log cannot
//! satisfy the remote's advertised heads (typically because the local
//! log has been compacted past the remote's frontier), the responder
//! signals [`SyncMessage::ResetRequired`]. Prior to FEAT-6 this was a
//! terminal failure: the initiator would disconnect and retry, and the
//! session could never make progress once compaction had removed the
//! ops needed for a delta replay.
//!
//! This module wires the existing snapshot machinery — the
//! [`apply_snapshot`](crate::snapshot::apply_snapshot) function, the
//! `log_snapshots` table, and the pre-existing
//! [`SyncMessage::SnapshotOffer`] / `SnapshotAccept` / `SnapshotReject`
//! wire variants — into a post-`ResetRequired` sub-flow that transfers
//! a compressed snapshot blob over the same TLS WebSocket connection
//! (using the binary-frame path already used for attachments in
//! [`sync_files`](crate::sync_files)).
//!
//! ## Protocol
//!
//! After the main [`SyncOrchestrator`](crate::sync_protocol::SyncOrchestrator)
//! message loop exits with `state == ResetRequired`:
//!
//! ### Responder (the peer that issued `ResetRequired`)
//!
//! 1. Look up the most recent complete snapshot in `log_snapshots`.
//! 2. If present: send [`SyncMessage::SnapshotOffer { size_bytes }`]
//!    with the compressed blob length.
//! 3. Await [`SyncMessage::SnapshotAccept`] or
//!    [`SyncMessage::SnapshotReject`] from the initiator.
//! 4. On accept: send the blob in binary frames of
//!    [`SNAPSHOT_CHUNK_SIZE`] bytes (mirrors `sync_files` chunking).
//! 5. On reject or no snapshot available: close the session; the
//!    initiator falls back to the prior failure mode.
//!
//! ### Initiator (the peer that received `ResetRequired`)
//!
//! 1. Await [`SyncMessage::SnapshotOffer`].
//! 2. Enforce the [`MAX_SNAPSHOT_SIZE`] size cap (256 MB). Over cap
//!    → send `SnapshotReject` and terminate.
//! 3. Under cap: send `SnapshotAccept`, then receive binary frames
//!    until `size_bytes` have arrived.
//! 4. Call [`apply_snapshot`](crate::snapshot::apply_snapshot) to
//!    wipe + restore core tables from the compressed blob.
//!    `apply_snapshot` uses `BEGIN IMMEDIATE` + `defer_foreign_keys`
//!    so the restore is atomic; a decode or integrity failure leaves
//!    the DB untouched (rolled back by transaction).
//! 5. Record the snapshot's `up_to_hash` as the last-received hash in
//!    `peer_refs` so the next scheduled sync begins a normal delta
//!    exchange from the new frontier.
//!
//! Post-snapshot delta catch-up is intentionally deferred to the next
//! scheduled sync tick: the initiator's `op_log` is wiped by
//! `apply_snapshot`, so its next [`SyncMessage::HeadExchange`] will
//! advertise empty heads and the responder will stream every post-
//! snapshot op via the normal [`SyncMessage::OpBatch`] path. This
//! keeps the sub-protocol simple (no recursive session restart) and
//! matches the way normal delta catch-up works when a peer reappears
//! after a long offline period.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::materializer::Materializer;
use crate::peer_refs;
use crate::snapshot::{apply_snapshot, get_latest_snapshot};
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_net::SyncConnection;
use crate::sync_protocol::SyncMessage;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum snapshot size the initiator will accept (256 MB).
///
/// The cap is defensive: a compromised or misconfigured responder
/// could otherwise advertise a huge `size_bytes` and tie up the
/// connection streaming a blob the initiator cannot apply. A typical
/// 100K-block database compresses to well under this cap, so rejecting
/// anything larger is safe in practice.
pub(crate) const MAX_SNAPSHOT_SIZE: u64 = 256 * 1024 * 1024;

/// Size of a single binary frame when streaming snapshot bytes.
///
/// Stays under [`SyncConnection::MAX_MSG_SIZE`] (10 MB) with margin,
/// matching the 5 MB `FILE_CHUNK_SIZE` used by the attachment-transfer
/// path in [`sync_files`](crate::sync_files).
pub(crate) const SNAPSHOT_CHUNK_SIZE: usize = 5_000_000;

// ---------------------------------------------------------------------------
// Responder side — offer + send
// ---------------------------------------------------------------------------

/// Result of a responder-side snapshot offer attempt.
#[derive(Debug, PartialEq)]
pub(crate) enum OfferOutcome {
    /// No complete snapshot was available locally; the responder
    /// declined to offer and the session terminated without catch-up.
    NoSnapshot,
    /// The initiator declined the offer (size cap, user preference,
    /// etc.). No bytes were transferred.
    Rejected,
    /// The snapshot was offered, accepted, and streamed in full.
    Sent { bytes_sent: u64 },
}

/// Attempt to offer and send a snapshot to the initiator after the
/// responder's main loop reached [`SyncState::ResetRequired`].
///
/// Called by [`handle_incoming_sync`](super::server::handle_incoming_sync)
/// once the main message loop exits with `state == ResetRequired`.
/// Returns [`OfferOutcome::NoSnapshot`] when `log_snapshots` has no
/// complete row — in that case the caller should close the session
/// (matching pre-FEAT-6 behavior).
pub(crate) async fn try_offer_snapshot_catchup(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
) -> Result<OfferOutcome, AppError> {
    let Some((snapshot_id, compressed)) = get_latest_snapshot(pool).await? else {
        tracing::info!(
            peer_id = %remote_device_id,
            "responder has no snapshot available; cannot offer catch-up"
        );
        return Ok(OfferOutcome::NoSnapshot);
    };

    // u64 cast is safe: compressed snapshot lengths are bounded by disk
    // and the on-wire size cap; usize→u64 is infallible on every tier-1
    // target.
    let size_bytes: u64 = compressed.len() as u64;

    tracing::info!(
        peer_id = %remote_device_id,
        snapshot_id = %snapshot_id,
        size_bytes,
        "responder offering snapshot for catch-up"
    );

    event_sink.on_sync_event(SyncEvent::Progress {
        state: "snapshot_offered".into(),
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
    });

    conn.send_json(&SyncMessage::SnapshotOffer { size_bytes })
        .await?;

    // Await the initiator's decision. Reuse the orchestrator's 120 s
    // timeout-by-receive-cycle semantics: the underlying recv has its
    // own 30 s guard (SyncConnection::RECV_TIMEOUT), which is enough
    // for a peer to surface an accept/reject decision.
    let reply: SyncMessage = conn.recv_json().await?;
    match reply {
        SyncMessage::SnapshotAccept => {
            tracing::info!(
                peer_id = %remote_device_id,
                snapshot_id = %snapshot_id,
                "initiator accepted snapshot; streaming bytes"
            );
            send_snapshot_bytes(conn, &compressed).await?;
            Ok(OfferOutcome::Sent {
                bytes_sent: size_bytes,
            })
        }
        SyncMessage::SnapshotReject => {
            tracing::info!(
                peer_id = %remote_device_id,
                snapshot_id = %snapshot_id,
                "initiator rejected snapshot offer"
            );
            Ok(OfferOutcome::Rejected)
        }
        SyncMessage::Error { message } => {
            // Initiator surfaced a protocol-level error (e.g. malformed
            // offer). Treat as rejection so the caller closes cleanly.
            tracing::warn!(
                peer_id = %remote_device_id,
                error = %message,
                "initiator returned Error in response to snapshot offer"
            );
            Ok(OfferOutcome::Rejected)
        }
        other => Err(AppError::InvalidOperation(format!(
            "unexpected message after SnapshotOffer: {:?}",
            std::mem::discriminant(&other)
        ))),
    }
}

/// Send the compressed snapshot bytes over the WebSocket in
/// [`SNAPSHOT_CHUNK_SIZE`]-sized binary frames.
///
/// Mirrors the chunking strategy in
/// [`sync_files::receive_request_and_send_files`](crate::sync_files).
/// A zero-length snapshot is still delivered as a single empty frame
/// so the receiver's frame accounting terminates cleanly.
async fn send_snapshot_bytes(conn: &mut SyncConnection, compressed: &[u8]) -> Result<(), AppError> {
    if compressed.is_empty() {
        conn.send_binary(&[]).await?;
        return Ok(());
    }
    for chunk in compressed.chunks(SNAPSHOT_CHUNK_SIZE) {
        conn.send_binary(chunk).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Initiator side — accept + receive + apply
// ---------------------------------------------------------------------------

/// Result of an initiator-side snapshot catch-up attempt.
#[derive(Debug, PartialEq)]
pub(crate) enum CatchupOutcome {
    /// The initiator declined the offer (over size cap) and sent
    /// [`SyncMessage::SnapshotReject`]. No DB changes occurred.
    Rejected { size_bytes: u64 },
    /// Snapshot was received, decoded, applied, and the initiator's
    /// frontier advanced to the snapshot's `up_to_hash`.
    Applied {
        bytes_received: u64,
        up_to_hash: String,
    },
}

/// Attempt to receive + apply a snapshot from the responder after the
/// initiator's main loop reached [`SyncState::ResetRequired`].
///
/// Called by [`run_sync_session`](super::orchestrator::run_sync_session)
/// once the main message loop exits with `state == ResetRequired`.
///
/// Behaviour:
///
/// - Reads the next message, expecting [`SyncMessage::SnapshotOffer`].
///   Any other variant returns [`AppError::InvalidOperation`] so the
///   caller records a sync failure (same treatment as a malformed
///   delta exchange).
/// - Enforces [`MAX_SNAPSHOT_SIZE`] on the advertised `size_bytes`.
///   Over cap → send `SnapshotReject` and return
///   [`CatchupOutcome::Rejected`].
/// - Under cap → send `SnapshotAccept`, receive `size_bytes` in binary
///   frames, call [`apply_snapshot`], and update
///   [`peer_refs`](crate::peer_refs) with the new `up_to_hash`.
///
/// `apply_snapshot` wraps the restore in a single `BEGIN IMMEDIATE`
/// transaction with `PRAGMA defer_foreign_keys = ON`, so a decode or
/// integrity failure rolls the DB back; the initiator is never left
/// in a half-restored state.
pub(crate) async fn try_receive_snapshot_catchup(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    materializer: &Materializer,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
) -> Result<CatchupOutcome, AppError> {
    let offer: SyncMessage = conn.recv_json().await?;
    let size_bytes = match offer {
        SyncMessage::SnapshotOffer { size_bytes } => size_bytes,
        SyncMessage::Error { message } => {
            return Err(AppError::InvalidOperation(format!(
                "peer reported error instead of snapshot offer: {message}"
            )));
        }
        other => {
            return Err(AppError::InvalidOperation(format!(
                "expected SnapshotOffer after ResetRequired, got {:?}",
                std::mem::discriminant(&other)
            )));
        }
    };

    tracing::info!(
        peer_id = %remote_device_id,
        size_bytes,
        "initiator received snapshot offer"
    );

    if size_bytes > MAX_SNAPSHOT_SIZE {
        tracing::warn!(
            peer_id = %remote_device_id,
            size_bytes,
            cap = MAX_SNAPSHOT_SIZE,
            "snapshot offer exceeds size cap; rejecting"
        );
        conn.send_json(&SyncMessage::SnapshotReject).await?;
        event_sink.on_sync_event(SyncEvent::Error {
            message: format!(
                "snapshot offer ({size_bytes} bytes) exceeds local cap ({MAX_SNAPSHOT_SIZE} bytes)"
            ),
            remote_device_id: remote_device_id.to_string(),
        });
        return Ok(CatchupOutcome::Rejected { size_bytes });
    }

    event_sink.on_sync_event(SyncEvent::Progress {
        state: "snapshot_accepting".into(),
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
    });

    conn.send_json(&SyncMessage::SnapshotAccept).await?;

    // Stream the bytes in. `SyncConnection::recv_binary` enforces the
    // 10 MB MAX_MSG_SIZE per frame; `receive_snapshot_bytes` validates
    // the total cannot exceed `size_bytes`.
    let compressed = receive_snapshot_bytes(conn, size_bytes).await?;

    event_sink.on_sync_event(SyncEvent::Progress {
        state: "snapshot_applying".into(),
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
    });

    // Atomic apply: wraps the whole wipe+insert in BEGIN IMMEDIATE +
    // defer_foreign_keys. A decode/integrity failure propagates without
    // leaving the DB in a half-restored state.
    let data = apply_snapshot(pool, materializer, &compressed).await?;
    let up_to_hash = data.up_to_hash.clone();

    tracing::info!(
        peer_id = %remote_device_id,
        up_to_hash = %up_to_hash,
        up_to_seqs = ?data.up_to_seqs,
        "applied snapshot; frontier advanced"
    );

    // Update peer_refs so the scheduler's "last synced" bookkeeping
    // reflects the catch-up. `last_sent_hash` stays empty — we did not
    // send anything in this session. The next scheduled sync will pick
    // up any ops the responder wrote after the snapshot was taken.
    if !remote_device_id.is_empty() {
        peer_refs::upsert_peer_ref(pool, remote_device_id).await?;
        if let Err(e) = peer_refs::update_on_sync(pool, remote_device_id, &up_to_hash, "").await {
            // Non-fatal: the snapshot itself is already durable, and a
            // failed bookkeeping update just means the next scheduler
            // tick will reconsider this peer — not data loss.
            tracing::warn!(
                peer_id = %remote_device_id,
                error = %e,
                "failed to record snapshot-driven sync in peer_refs"
            );
        }
    }

    event_sink.on_sync_event(SyncEvent::Complete {
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
    });

    Ok(CatchupOutcome::Applied {
        bytes_received: size_bytes,
        up_to_hash,
    })
}

/// Receive snapshot bytes in binary frames, accumulating until
/// exactly `size_bytes` have arrived.
///
/// Rejects any over-run (more bytes than advertised) to avoid runaway
/// allocation, mirroring the guard in
/// [`sync_files::receive_binary_data`](crate::sync_files).
async fn receive_snapshot_bytes(
    conn: &mut SyncConnection,
    size_bytes: u64,
) -> Result<Vec<u8>, AppError> {
    // On 32-bit targets large sizes saturate at usize::MAX rather than
    // aborting; `Vec::with_capacity` is a hint so this is safe.
    let capacity = usize::try_from(size_bytes).unwrap_or(usize::MAX);
    let mut data: Vec<u8> = Vec::with_capacity(capacity);

    // Zero-size snapshot: expect one empty binary frame (matches the
    // sender's zero-path in `send_snapshot_bytes`).
    if size_bytes == 0 {
        let chunk = conn.recv_binary().await?;
        if !chunk.is_empty() {
            return Err(AppError::InvalidOperation(format!(
                "expected empty snapshot frame, got {} bytes",
                chunk.len()
            )));
        }
        return Ok(data);
    }

    while (data.len() as u64) < size_bytes {
        let chunk = conn.recv_binary().await?;
        data.extend_from_slice(&chunk);
        if (data.len() as u64) > size_bytes {
            return Err(AppError::InvalidOperation(format!(
                "received {} snapshot bytes, expected {}",
                data.len(),
                size_bytes
            )));
        }
    }
    Ok(data)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use crate::op::OpPayload;
    use crate::op_log::append_local_op;
    use crate::snapshot::create_snapshot;
    use crate::sync_events::RecordingEventSink;
    use crate::sync_net::test_connection_pair;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
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
        let payload = OpPayload::CreateBlock(crate::op::CreateBlockPayload {
            block_id: crate::ulid::BlockId::test_id("01HZ00000000000000000BLOCK1"),
            block_type: "content".into(),
            content: "hello".into(),
            parent_id: None,
            position: Some(1),
        });
        let record = append_local_op(pool, device_id, payload).await.unwrap();
        materializer.dispatch_op(&record).await.unwrap();
        materializer.flush_foreground().await.unwrap();
    }

    /// Legacy helper: seed the op log without materializing. Used by
    /// tests that only need `create_snapshot` to succeed (which requires
    /// a non-empty op_log) and don't assert on restored block contents.
    async fn seed_one_op(pool: &SqlitePool, device_id: &str) {
        let payload = OpPayload::CreateBlock(crate::op::CreateBlockPayload {
            block_id: crate::ulid::BlockId::test_id("01HZ00000000000000000BLOCK1"),
            block_type: "content".into(),
            content: "hello".into(),
            parent_id: None,
            position: Some(1),
        });
        append_local_op(pool, device_id, payload).await.unwrap();
    }

    // -----------------------------------------------------------------
    // Responder side: no snapshot → NoSnapshot
    // -----------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn try_offer_snapshot_catchup_returns_no_snapshot_when_log_snapshots_empty() {
        let (pool, _dir) = test_pool().await;
        let (mut server_conn, _client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let outcome = try_offer_snapshot_catchup(&mut server_conn, &pool, &event_sink, REMOTE_DEV)
            .await
            .expect("try_offer_snapshot_catchup must succeed on empty snapshots table");
        assert_eq!(
            outcome,
            OfferOutcome::NoSnapshot,
            "empty log_snapshots must produce OfferOutcome::NoSnapshot"
        );
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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        // Drive the responder in a task.
        let pool_clone = pool.clone();
        let sink_clone = event_sink.clone();
        let responder = tokio::spawn(async move {
            try_offer_snapshot_catchup(&mut server_conn, &pool_clone, &sink_clone, REMOTE_DEV).await
        });

        // Client side: expect SnapshotOffer, reply Accept, drain bytes.
        let offer: SyncMessage = client_conn.recv_json().await.unwrap();
        match offer {
            SyncMessage::SnapshotOffer { size_bytes } => {
                assert_eq!(
                    size_bytes, expected_size,
                    "offered size_bytes must match on-disk snapshot blob length"
                );
            }
            other => panic!("expected SnapshotOffer, got {:?}", other),
        }
        client_conn
            .send_json(&SyncMessage::SnapshotAccept)
            .await
            .unwrap();

        // Receive all binary frames totalling expected_size.
        let capacity = usize::try_from(expected_size).unwrap_or(usize::MAX);
        let mut received: Vec<u8> = Vec::with_capacity(capacity);
        while (received.len() as u64) < expected_size {
            let chunk = client_conn.recv_binary().await.unwrap();
            received.extend_from_slice(&chunk);
        }
        assert_eq!(
            received.len() as u64,
            expected_size,
            "initiator must receive exactly size_bytes from responder"
        );
        assert_eq!(
            received, latest_bytes,
            "bytes received must match the snapshot blob stored locally"
        );

        let outcome = responder.await.unwrap().unwrap();
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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let pool_clone = pool.clone();
        let sink_clone = event_sink.clone();
        let responder = tokio::spawn(async move {
            try_offer_snapshot_catchup(&mut server_conn, &pool_clone, &sink_clone, REMOTE_DEV).await
        });

        // Read the offer, reply with Reject.
        let _offer: SyncMessage = client_conn.recv_json().await.unwrap();
        client_conn
            .send_json(&SyncMessage::SnapshotReject)
            .await
            .unwrap();

        let outcome = responder.await.unwrap().unwrap();
        assert_eq!(
            outcome,
            OfferOutcome::Rejected,
            "responder must report Rejected when initiator declines the offer"
        );
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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        // Server side (responder): send offer + bytes.
        let bytes_clone = snap_bytes.clone();
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                })
                .await
                .unwrap();
            let accept: SyncMessage = server_conn.recv_json().await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            // Stream bytes.
            for chunk in bytes_clone.chunks(SNAPSHOT_CHUNK_SIZE) {
                server_conn.send_binary(chunk).await.unwrap();
            }
        });

        // Client side (initiator): receive + apply.
        let outcome = try_receive_snapshot_catchup(
            &mut client_conn,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
        )
        .await
        .expect("initiator catch-up must succeed with a valid snapshot");

        server_task.await.unwrap();
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
            other => panic!("expected Applied, got {:?}", other),
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

        materializer.shutdown();
        resp_materializer.shutdown();
    }

    // -----------------------------------------------------------------
    // Initiator side: size cap → SnapshotReject
    // -----------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn try_receive_snapshot_catchup_rejects_oversized_offer() {
        let (init_pool, _init_dir) = test_pool().await;
        let materializer = Materializer::new(init_pool.clone());

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let oversized = MAX_SNAPSHOT_SIZE + 1;

        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes: oversized,
                })
                .await
                .unwrap();
            // Expect a reject — no bytes will follow.
            let reply: SyncMessage = server_conn.recv_json().await.unwrap();
            assert_eq!(reply, SyncMessage::SnapshotReject);
        });

        let outcome = try_receive_snapshot_catchup(
            &mut client_conn,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
        )
        .await
        .expect("catch-up must return Ok(Rejected) for oversized offer");
        assert_eq!(
            outcome,
            CatchupOutcome::Rejected {
                size_bytes: oversized,
            },
            "initiator must reject offers above MAX_SNAPSHOT_SIZE without touching DB"
        );

        server_task.await.unwrap();

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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        // Send a small under-the-cap size with garbage bytes. Decode
        // will fail inside apply_snapshot, which uses BEGIN IMMEDIATE
        // so the DB stays untouched.
        let garbage: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05];
        let size_bytes = garbage.len() as u64;

        let garbage_clone = garbage.clone();
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer { size_bytes })
                .await
                .unwrap();
            let accept: SyncMessage = server_conn.recv_json().await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            server_conn.send_binary(&garbage_clone).await.unwrap();
        });

        let result = try_receive_snapshot_catchup(
            &mut client_conn,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
        )
        .await;
        assert!(
            result.is_err(),
            "corrupted snapshot bytes must return Err (decode failure)"
        );

        server_task.await.unwrap();

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
    // Initiator side: non-offer first message → InvalidOperation
    // -----------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn try_receive_snapshot_catchup_errors_on_unexpected_message() {
        let (init_pool, _init_dir) = test_pool().await;
        let materializer = Materializer::new(init_pool.clone());

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let server_task = tokio::spawn(async move {
            // Responder protocol-violates: sends SyncComplete instead
            // of SnapshotOffer after ResetRequired.
            server_conn
                .send_json(&SyncMessage::SyncComplete {
                    last_hash: "deadbeef".into(),
                })
                .await
                .unwrap();
        });

        let result = try_receive_snapshot_catchup(
            &mut client_conn,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
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
            other => panic!("expected InvalidOperation, got {:?}", other),
        }

        server_task.await.unwrap();
        materializer.shutdown();
    }

    // -----------------------------------------------------------------
    // Initiator side: peer surfaces Error instead of offer
    // -----------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn try_receive_snapshot_catchup_surfaces_peer_error() {
        let (init_pool, _init_dir) = test_pool().await;
        let materializer = Materializer::new(init_pool.clone());

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::Error {
                    message: "responder internal error".into(),
                })
                .await
                .unwrap();
        });

        let result = try_receive_snapshot_catchup(
            &mut client_conn,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
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
            other => panic!("expected InvalidOperation, got {:?}", other),
        }

        server_task.await.unwrap();
        materializer.shutdown();
    }

    // -----------------------------------------------------------------
    // Constants sanity
    // -----------------------------------------------------------------

    #[test]
    fn max_snapshot_size_is_at_least_one_chunk() {
        // On any target where usize fits in u64, try_from succeeds. On
        // 32-bit targets where usize::MAX < MAX_SNAPSHOT_SIZE the cap
        // is effectively tighter — still valid.
        let cap_as_usize = usize::try_from(MAX_SNAPSHOT_SIZE).unwrap_or(usize::MAX);
        assert!(
            cap_as_usize >= SNAPSHOT_CHUNK_SIZE,
            "MAX_SNAPSHOT_SIZE must admit at least one full chunk"
        );
    }

    #[test]
    fn snapshot_chunk_size_under_max_msg_size() {
        // Mirror sync_files::FILE_CHUNK_SIZE: stay well under the
        // transport's 10 MB per-frame cap to leave headroom for
        // WebSocket framing overhead. `const_assert`-style using a
        // const block so clippy's `assertions_on_constants` is happy
        // (the comparison is known at compile time).
        const {
            assert!(
                SNAPSHOT_CHUNK_SIZE <= 10_000_000,
                "SNAPSHOT_CHUNK_SIZE must stay under SyncConnection::MAX_MSG_SIZE"
            );
        }
    }
}
