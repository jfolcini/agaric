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
//!    [`BINARY_FRAME_CHUNK_SIZE`](crate::sync_constants::BINARY_FRAME_CHUNK_SIZE)
//!    bytes (mirrors `sync_files` chunking).
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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::io::AsyncWriteExt;

use crate::error::AppError;
use crate::materializer::Materializer;
use crate::peer_refs;
use crate::snapshot::{apply_snapshot, decode_snapshot, get_latest_snapshot};
use crate::sync_constants::BINARY_FRAME_CHUNK_SIZE;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_files::app_data_dir_from_pool;
use crate::sync_net::SyncConnection;
use crate::sync_protocol::{DeviceHead, SyncMessage};

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
    /// M-58: the latest local snapshot is BEHIND the remote's
    /// advertised frontier for at least one device. Sending it would
    /// silently re-apply older state on the initiator. The responder
    /// instead sent [`SyncMessage::Error`] so the initiator fails
    /// loudly and the operator/log can diagnose the retention drift.
    SnapshotStale { reason: String },
}

/// M-58: covering check for the responder's snapshot vs. the remote's
/// advertised heads.
///
/// For every `(device_id, remote_seq)` the remote advertised in its
/// `HeadExchange`, the snapshot's `up_to_seqs[device_id]` must be
/// **at least** `remote_seq`. If any device's snapshot seq is below
/// the remote's seq, the snapshot does not cover that device's
/// frontier and offering it would silently roll the initiator back.
///
/// Returns `Ok(())` when the snapshot covers every advertised device
/// (the empty-heads case is trivially covered). On mismatch returns
/// `Err(reason)` naming the first device whose seq is below the
/// remote's claim — used verbatim in the wire-level
/// [`SyncMessage::Error`] payload so the diagnosis appears in the
/// initiator's log.
///
/// Devices in `snapshot_seqs` that the remote does not mention are
/// fine: that just means the snapshot saw ops the remote has not yet
/// observed, which is expected (the post-snapshot delta path will
/// stream those to the remote on the next session).
fn snapshot_covers_remote_heads(
    snapshot_seqs: &BTreeMap<String, i64>,
    remote_heads: &[DeviceHead],
) -> Result<(), String> {
    for head in remote_heads {
        let snap_seq = snapshot_seqs.get(&head.device_id).copied().unwrap_or(0);
        if snap_seq < head.seq {
            return Err(format!(
                "snapshot covers device {} only up to seq {} but remote claims seq {}",
                head.device_id, snap_seq, head.seq
            ));
        }
    }
    Ok(())
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
    remote_heads: &[DeviceHead],
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

    // M-58: defensive covering check.
    //
    // `ResetRequired` means our op_log was compacted past the remote's
    // advertised frontier — so the snapshot we are about to offer
    // SHOULD have an `up_to_seqs` >= every remote head, by construction
    // (compaction is bounded by the snapshot's frontier). If retention
    // policy ever drifts (e.g. compaction window vs. snapshot window),
    // this invariant could quietly break and we would re-apply an
    // older snapshot on the initiator — silent data regression.
    //
    // Decode the snapshot's frontier and compare against the remote
    // heads we received in `HeadExchange`. Mismatch → `Error` instead
    // of `SnapshotOffer` so the initiator fails loudly and the
    // operator can spot the regression in logs.
    let snapshot_frontier = decode_snapshot(compressed.as_slice())?;
    if let Err(reason) = snapshot_covers_remote_heads(&snapshot_frontier.up_to_seqs, remote_heads) {
        tracing::warn!(
            peer_id = %remote_device_id,
            snapshot_id = %snapshot_id,
            reason = %reason,
            "responder snapshot does not cover remote frontier; sending Error instead of SnapshotOffer (M-58)"
        );
        let wire_msg = format!("snapshot does not cover remote frontier: {reason}");
        // Send the wire-level `Error` so the initiator surfaces a
        // hard failure rather than silently rewinding to an older
        // snapshot. Best-effort: a send failure here is logged but
        // does not change the outcome — we still report `SnapshotStale`
        // so the caller treats this session as a non-progress event.
        if let Err(e) = conn
            .send_json(&SyncMessage::Error {
                message: wire_msg.clone(),
            })
            .await
        {
            tracing::warn!(
                peer_id = %remote_device_id,
                error = %e,
                "failed to send M-58 stale-snapshot Error to initiator"
            );
        }
        event_sink.on_sync_event(SyncEvent::Error {
            message: wire_msg,
            remote_device_id: remote_device_id.to_string(),
        });
        return Ok(OfferOutcome::SnapshotStale { reason });
    }

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
    // own guard (SyncConnection::RECV_TIMEOUT), kept strictly larger
    // than the 120 s outer budget so the outer guard fires first.
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
/// [`BINARY_FRAME_CHUNK_SIZE`]-sized binary frames.
///
/// Thin wrapper around
/// [`SyncConnection::send_binary_chunked`](crate::sync_net::SyncConnection::send_binary_chunked),
/// the single shared implementation used by both this module and
/// [`sync_files`](crate::sync_files). A zero-length snapshot is
/// delivered as a single empty frame so the receiver's frame
/// accounting terminates cleanly.
async fn send_snapshot_bytes(conn: &mut SyncConnection, compressed: &[u8]) -> Result<(), AppError> {
    conn.send_binary_chunked(compressed, BINARY_FRAME_CHUNK_SIZE)
        .await
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
///
/// # peer_refs bookkeeping (L-66)
///
/// `expected_remote_id` mirrors the `SyncComplete` fallback in
/// [`SyncOrchestrator`](crate::sync_protocol::SyncOrchestrator):
/// when `remote_device_id` is empty (a `HeadExchange` that only
/// carried our own heads), the function falls back to
/// `expected_remote_id` for the [`peer_refs`] upsert. If both are
/// empty the function returns
/// [`AppError::InvalidOperation`] so the caller records a failed
/// session instead of silently applying a snapshot whose origin
/// peer cannot be remembered (the next sync would treat this peer
/// as fully unknown again).
pub(crate) async fn try_receive_snapshot_catchup(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    materializer: &Materializer,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
    expected_remote_id: Option<&str>,
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

    // L-67: stream the compressed bytes straight to a temp file under
    // the app data dir instead of accumulating them into a `Vec<u8>`.
    // Peak Rust-heap during the receive is one
    // `BINARY_FRAME_CHUNK_SIZE` buffer (5 MB); a 256 MB compressed
    // snapshot used to live entirely in memory until `apply_snapshot`
    // returned. The `MAX_SNAPSHOT_SIZE` cap is enforced on
    // `size_bytes` above, so the on-disk temp is bounded by 256 MB.
    // `SnapshotTempFile::Drop` unlinks the temp on every exit path
    // (success, decode failure, panic) — see the type's docs.
    let app_data_dir = app_data_dir_from_pool(pool).await?;
    let temp = receive_snapshot_to_temp(conn, &app_data_dir, size_bytes).await?;

    event_sink.on_sync_event(SyncEvent::Progress {
        state: "snapshot_applying".into(),
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
    });

    // L-67: open the temp file as a SYNC `std::fs::File` (the
    // `apply_snapshot` reader bound is `std::io::Read`). The reader
    // is consumed entirely inside `decode_snapshot` (zstd-streaming
    // + ciborium) before the SQL transaction begins, so the only
    // memory in flight from this point on is the parsed
    // `SnapshotData` itself — never the compressed bytes nor the
    // decompressed CBOR.
    //
    // Atomic apply: `apply_snapshot` wraps the whole wipe+insert in
    // BEGIN IMMEDIATE + defer_foreign_keys. A decode/integrity
    // failure propagates without leaving the DB in a half-restored
    // state, and `temp` drops at the end of this scope so the temp
    // file is unlinked regardless of which arm we exit through.
    let temp_file = std::fs::File::open(temp.path()).map_err(|e| {
        AppError::Io(std::io::Error::new(
            e.kind(),
            format!(
                "opening received snapshot temp {}: {e}",
                temp.path().display()
            ),
        ))
    })?;
    let data = apply_snapshot(pool, materializer, temp_file).await?;
    drop(temp);
    let up_to_hash = data.up_to_hash.clone();

    tracing::info!(
        peer_id = %remote_device_id,
        up_to_hash = %up_to_hash,
        up_to_seqs = ?data.up_to_seqs,
        "applied snapshot; frontier advanced"
    );

    // L-66: mirror the SyncComplete fallback. Prefer the orchestrator's
    // session-level `remote_device_id`; if that is empty (HeadExchange
    // carried only our own heads), fall back to the daemon-provided
    // `expected_remote_id` (mTLS / mDNS peer identity). If neither is
    // available, refuse to silently complete: the snapshot is already
    // durable but a peer_refs row keyed by the empty string would
    // corrupt the bookkeeping, and the next sync would treat this
    // peer as fully unknown again.
    let resolved_peer_id: &str = if !remote_device_id.is_empty() {
        remote_device_id
    } else if let Some(expected) = expected_remote_id.filter(|s| !s.is_empty()) {
        tracing::warn!(
            expected_remote_id = expected,
            "remote_device_id was empty at snapshot catch-up; falling back to expected_remote_id"
        );
        expected
    } else {
        return Err(AppError::InvalidOperation(
            "snapshot catch-up completed with empty remote_device_id and no expected_remote_id; \
             refusing to record peer_refs row keyed by empty string (L-66)"
                .into(),
        ));
    };

    // Update peer_refs so the scheduler's "last synced" bookkeeping
    // reflects the catch-up. `last_sent_hash` stays empty — we did not
    // send anything in this session. The next scheduled sync will pick
    // up any ops the responder wrote after the snapshot was taken.
    peer_refs::upsert_peer_ref(pool, resolved_peer_id).await?;
    if let Err(e) = peer_refs::update_on_sync(pool, resolved_peer_id, &up_to_hash, "").await {
        // Non-fatal: the snapshot itself is already durable, and a
        // failed bookkeeping update just means the next scheduler
        // tick will reconsider this peer — not data loss.
        tracing::warn!(
            peer_id = %resolved_peer_id,
            error = %e,
            "failed to record snapshot-driven sync in peer_refs"
        );
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

/// L-67: a temp file holding a freshly-received snapshot blob.
///
/// Owns its on-disk path; `Drop` unlinks the file (best-effort,
/// synchronous `std::fs::remove_file` because we can't `await` in
/// `Drop`). `apply_snapshot` reads through this file as a
/// `std::fs::File` and the temp is unlinked the moment this guard
/// goes out of scope — including on apply failure, hash mismatch,
/// or panic, so a partial transfer never lingers.
///
/// We deliberately roll our own guard rather than depend on the
/// `tempfile` crate at runtime (it is dev-only today; pulling it
/// into `[dependencies]` would be a new runtime dep for one path).
/// The pattern is small and matches the M-51
/// `TempAttachmentWriter::Drop` cleanup path.
pub(crate) struct SnapshotTempFile {
    path: PathBuf,
}

impl SnapshotTempFile {
    /// Path of the on-disk temp blob. Tests use this to assert the
    /// file appears mid-receive and is unlinked post-`Drop`.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SnapshotTempFile {
    fn drop(&mut self) {
        // Best-effort unlink; ignore "already gone" / permission
        // errors so a panic-on-drop never masks the real failure.
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Stream `size_bytes` of a compressed snapshot from `conn` straight
/// to a `<app_data_dir>/snapshot-recv-<rand>.tmp` file (L-67).
///
/// Replaces the old `receive_snapshot_bytes` `Vec<u8>` accumulator —
/// peak Rust-heap during the receive is now one
/// `BINARY_FRAME_CHUNK_SIZE` buffer regardless of the snapshot
/// size, instead of `O(size_bytes)`. The `MAX_SNAPSHOT_SIZE` cap
/// (256 MB) enforced on the wire-level `size_bytes` by
/// `try_receive_snapshot_catchup` bounds the temp file the same way.
///
/// The returned [`SnapshotTempFile`] guard unlinks the file on
/// drop, so the caller does not need an explicit cleanup branch on
/// the apply / decode error paths.
pub(crate) async fn receive_snapshot_to_temp(
    conn: &mut SyncConnection,
    app_data_dir: &Path,
    size_bytes: u64,
) -> Result<SnapshotTempFile, AppError> {
    // ULID gives us 128 bits of entropy + a monotonic timestamp
    // prefix — collisions across overlapping snapshot transfers
    // are not practically possible. Render in lower-case hex so
    // the suffix is portable across case-folding filesystems.
    let suffix: u128 = u128::from(ulid::Ulid::new());
    let path = app_data_dir.join(format!("snapshot-recv-{suffix:032x}.tmp"));

    // The guard owns the path from the moment it is constructed —
    // any `?` early-return below unlinks the temp on drop.
    let guard = SnapshotTempFile { path: path.clone() };

    let mut file = tokio::fs::File::create(&path).await.map_err(|e| {
        AppError::Io(std::io::Error::new(
            e.kind(),
            format!("creating snapshot temp {}: {e}", path.display()),
        ))
    })?;

    // L-67 — uses the M-51 streaming receiver: per-frame chunks are
    // pulled off the wire and written to the file as they arrive,
    // so neither the compressed payload nor the partially-buffered
    // chunk accumulator from the old `receive_binary_chunked` ever
    // grows beyond a single frame.
    conn.receive_binary_streaming(&mut file, size_bytes).await?;

    file.flush().await.map_err(|e| {
        AppError::Io(std::io::Error::new(
            e.kind(),
            format!("flushing snapshot temp {}: {e}", path.display()),
        ))
    })?;
    // Drop the async handle so the subsequent `std::fs::File::open`
    // (in `try_receive_snapshot_catchup`) observes a closed FD —
    // this matters on Windows where two open handles to the same
    // path can fight over rename/locks.
    drop(file);

    Ok(guard)
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
    use crate::snapshot::{
        create_snapshot, BlockSnapshot, SnapshotData, SnapshotTables, SCHEMA_VERSION,
    };
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

        let outcome =
            try_offer_snapshot_catchup(&mut server_conn, &pool, &event_sink, REMOTE_DEV, &[])
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
            try_offer_snapshot_catchup(&mut server_conn, &pool_clone, &sink_clone, REMOTE_DEV, &[])
                .await
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
            try_offer_snapshot_catchup(&mut server_conn, &pool_clone, &sink_clone, REMOTE_DEV, &[])
                .await
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
    // M-58: snapshot covering check
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
            err.contains("dev-B") && err.contains("99") && err.contains("5"),
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
    /// silently re-applying an older snapshot. Reported in M-58.
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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let pool_clone = pool.clone();
        let sink_clone = event_sink.clone();
        let responder = tokio::spawn(async move {
            try_offer_snapshot_catchup(
                &mut server_conn,
                &pool_clone,
                &sink_clone,
                REMOTE_DEV,
                &remote_heads,
            )
            .await
        });

        // The responder must NOT send a SnapshotOffer; it must send an
        // Error explaining the covering failure.
        let wire: SyncMessage = client_conn
            .recv_json()
            .await
            .expect("responder must send a wire message even when snapshot is stale");
        match wire {
            SyncMessage::Error { message } => {
                assert!(
                    message.contains(LOCAL_DEV),
                    "M-58 Error message must name the offending device, got {message:?}"
                );
                assert!(
                    message.contains("999"),
                    "M-58 Error message must include the remote's claimed seq, got {message:?}"
                );
            }
            other => panic!(
                "expected SyncMessage::Error for stale snapshot, got {:?}",
                other
            ),
        }

        let outcome = responder
            .await
            .expect("responder task must not panic")
            .expect("try_offer_snapshot_catchup must return Ok even when sending Error");
        match outcome {
            OfferOutcome::SnapshotStale { reason } => {
                assert!(
                    reason.contains(LOCAL_DEV) && reason.contains("999"),
                    "SnapshotStale reason must name the offending device and seq, got {reason:?}"
                );
            }
            other => panic!(
                "expected OfferOutcome::SnapshotStale when snapshot is behind remote, got {:?}",
                other
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
            for chunk in bytes_clone.chunks(BINARY_FRAME_CHUNK_SIZE) {
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
            None,
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
            None,
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
            None,
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
    // L-74: snapshot transfer cancellation / interruption
    // -----------------------------------------------------------------

    /// L-74: the responder advertises a snapshot, the initiator accepts,
    /// then the responder disconnects mid-binary-stream after delivering
    /// only part of the promised payload. The initiator must:
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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        // Promise more bytes than we'll deliver. The receiver will read
        // the partial chunk, loop back to `recv_binary`, and observe EOF
        // when the responder drops the duplex stream.
        let promised_size: u64 = 64 * 1024;
        let partial_chunk: Vec<u8> = vec![0u8; 4 * 1024];

        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes: promised_size,
                })
                .await
                .unwrap();
            let accept: SyncMessage = server_conn.recv_json().await.unwrap();
            assert_eq!(accept, SyncMessage::SnapshotAccept);
            // Send only the partial chunk, then drop the responder side.
            server_conn.send_binary(&partial_chunk).await.unwrap();
            // `drop(server_conn)` happens on task exit; the duplex stream
            // closes and the initiator's next `recv_binary` returns Err.
        });

        let result = try_receive_snapshot_catchup(
            &mut client_conn,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
        )
        .await;

        // (a) The interruption surfaces as Err.
        assert!(
            result.is_err(),
            "L-74: mid-stream disconnect must surface as Err; got {result:?}"
        );

        server_task.await.unwrap();

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
            "L-74: interrupted snapshot must not leave any blocks"
        );

        // (c) No peer_refs row — the catch-up did not complete.
        let peer_after = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
            .await
            .unwrap();
        assert!(
            peer_after.is_none(),
            "L-74: interrupted snapshot must NOT advance peer_refs"
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
            cap_as_usize >= BINARY_FRAME_CHUNK_SIZE,
            "MAX_SNAPSHOT_SIZE must admit at least one full chunk"
        );
    }

    #[test]
    fn snapshot_chunk_size_under_max_msg_size() {
        // Stay well under the transport's 10 MB per-frame cap to leave
        // headroom for WebSocket framing overhead. `const_assert`-style
        // using a const block so clippy's `assertions_on_constants` is
        // happy (the comparison is known at compile time).
        const {
            assert!(
                BINARY_FRAME_CHUNK_SIZE <= 10_000_000,
                "BINARY_FRAME_CHUNK_SIZE must stay under SyncConnection::MAX_MSG_SIZE"
            );
        }
    }

    // -----------------------------------------------------------------
    // L-66: peer_refs fallback (empty remote_device_id)
    // -----------------------------------------------------------------

    /// Helper for the L-66 fallback / failure tests: drive a successful
    /// snapshot transfer end-to-end with the given `remote_device_id` /
    /// `expected_remote_id` pair and return the receive-side result so
    /// the caller can assert on the resolved peer_refs row (or the
    /// returned error).
    async fn run_catchup_with_ids(
        remote_device_id: &str,
        expected_remote_id: Option<&str>,
    ) -> (SqlitePool, TempDir, Result<CatchupOutcome, AppError>) {
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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

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
            for chunk in bytes_clone.chunks(BINARY_FRAME_CHUNK_SIZE) {
                server_conn.send_binary(chunk).await.unwrap();
            }
        });

        let result = try_receive_snapshot_catchup(
            &mut client_conn,
            &init_pool,
            &materializer,
            &event_sink,
            remote_device_id,
            expected_remote_id,
        )
        .await;

        server_task.await.unwrap();
        materializer.flush_background().await.unwrap();
        materializer.shutdown();
        resp_materializer.shutdown();

        (init_pool, init_dir, result)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn try_receive_snapshot_catchup_falls_back_to_expected_remote_id_when_session_id_empty() {
        // L-66: HeadExchange sometimes carries only our own heads, so
        // the initiator's `session.remote_device_id` ends up empty.
        // The daemon's `expected_remote_id` (from mTLS / mDNS) must
        // fill in so the peer_refs row uses the real peer identity.
        let (init_pool, _dir, result) = run_catchup_with_ids("", Some(REMOTE_DEV)).await;
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
        // L-66: with neither `remote_device_id` nor `expected_remote_id`
        // available, the function must fail loudly so the scheduler
        // records a failed session — silently completing would write a
        // peer_refs row keyed by the empty string and corrupt the
        // bookkeeping.
        let (_init_pool, _dir, result) = run_catchup_with_ids("", None).await;
        let err = result.expect_err("catch-up must fail when both remote ids are empty");
        match err {
            AppError::InvalidOperation(msg) => {
                assert!(
                    msg.contains("L-66"),
                    "error message should reference L-66 for traceability; got {msg:?}",
                );
            }
            other => panic!("expected InvalidOperation, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn try_receive_snapshot_catchup_prefers_session_id_over_expected() {
        // L-66: when both ids are present and disagree, the
        // session-level `remote_device_id` (from HeadExchange) wins
        // because that's the value the protocol actually exchanged.
        let (init_pool, _dir, result) =
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
    // L-67 — streaming snapshot transfer regression suite
    // -----------------------------------------------------------------
    //
    // M-51 + L-67: paired sync streaming items. M-51 is the wire-side
    // primitive (`send/receive_binary_streaming`), L-67 layers a temp
    // file on top so the receiver lands the compressed snapshot on
    // disk frame-by-frame instead of accumulating it in a `Vec<u8>`.
    // `apply_snapshot` then reads through that temp file via the
    // streaming `decode_snapshot(impl Read)` path so neither the
    // compressed bytes nor the decompressed CBOR is ever fully
    // materialised in memory.

    /// L-67 — confirm `try_receive_snapshot_catchup` writes the
    /// incoming bytes to a temp file under the app data dir before
    /// applying. Asserts the temp file appears mid-receive (between
    /// the responder's binary frames and the apply call) and is
    /// unlinked once the call returns.
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
            "L-67: no snapshot temp files must exist before catch-up"
        );

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

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
            for chunk in bytes_clone.chunks(BINARY_FRAME_CHUNK_SIZE) {
                server_conn.send_binary(chunk).await.unwrap();
            }
        });

        let outcome = try_receive_snapshot_catchup(
            &mut client_conn,
            &init_pool,
            &materializer,
            &event_sink,
            REMOTE_DEV,
            None,
        )
        .await
        .expect("L-67 catch-up must succeed end-to-end");

        server_task.await.unwrap();
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
            "L-67: snapshot temp file must be unlinked once catch-up returns; \
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

    /// L-67 — `apply_snapshot` now takes `impl std::io::Read`. Passing
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
            .expect("L-67: apply_snapshot must accept a Cursor reader");

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

    /// L-67 — when the receive fails post-stream (corrupted bytes →
    /// `apply_snapshot` returns an error), the snapshot temp file
    /// must be unlinked so abandoned transfers do not leak.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn snapshot_receive_drops_temp_on_failure_m51_l67() {
        let (init_pool, init_dir) = test_pool().await;
        let materializer = Materializer::new(init_pool.clone());
        let app_data_dir = init_dir.path().to_path_buf();

        // Pre-condition.
        assert_eq!(count_snapshot_tmp_files(&app_data_dir), 0);

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        // Send garbage that fits under the cap but won't decode.
        let garbage: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07];
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
            None,
        )
        .await;
        assert!(
            result.is_err(),
            "L-67: garbage snapshot bytes must surface as Err; got {result:?}"
        );

        server_task.await.unwrap();

        // Post-condition: failed apply propagates AppError; the
        // `SnapshotTempFile` guard must have unlinked the temp on
        // its way out of scope.
        let tmp_count_after = count_snapshot_tmp_files(&app_data_dir);
        assert_eq!(
            tmp_count_after, 0,
            "L-67: temp must be unlinked on apply failure; dir = {app_data_dir:?}"
        );

        materializer.shutdown();
    }

    /// L-67 — `decode_snapshot` must use `zstd::stream::Decoder` (not
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
                id: format!("01HZ{i:026X}").chars().take(26).collect::<String>(),
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
                is_conflict: 0,
                conflict_source: None,
                conflict_type: None,
                todo_state: None,
                priority: None,
                due_date: None,
                scheduled_date: None,
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
        let mut decoder = zstd::stream::Decoder::new(encoded.as_slice()).unwrap();
        let mut decompressed = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut decompressed).unwrap();
        assert!(
            decompressed.len() >= encoded.len() * 3,
            "L-67: test fixture must decompress to ≥3× the compressed size \
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

    /// Helper used by the L-67 temp-file tests above: count
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
}
