//! Snapshot-driven catch-up for the sync orchestrator.
//!
//! When a peer's head-exchange check finds that its local op log cannot
//! satisfy the remote's advertised heads (typically because the local
//! log has been compacted past the remote's frontier), the responder
//! signals [`SyncMessage::ResetRequired`]. Prior to this was a
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
//! 2. If present: send [`SyncMessage::SnapshotOffer { size_bytes,
//!    blob_blake3 }`] with the compressed blob length and its blake3
//!    integrity hash (#706 item 2).
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
//!    the DB untouched (rolled back by transaction). The same tx wipes
//!    the Loro sidecar state (`loro_doc_state`, `loro_sync_inbox`,
//!    apply cursor — #607/#779).
//! 5. Drop + reload the in-memory Loro engines
//!    ([`crate::loro::snapshot::reload_registry_from_db`]) so the live
//!    registry matches the post-reset SQL — there is no process
//!    restart after a catch-up, and stale engines would otherwise be
//!    re-exported to peers and re-persisted over the wiped
//!    `loro_doc_state` (#607).
//! 6. Record the snapshot's `up_to_hash` as the last-received hash in
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
use crate::snapshot::{apply_snapshot, get_latest_snapshot_with_frontier};
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
    /// The latest local snapshot is BEHIND the remote's
    /// advertised frontier for at least one device. Sending it would
    /// silently re-apply older state on the initiator. The responder
    /// instead sent [`SyncMessage::Error`] so the initiator fails
    /// loudly and the operator/log can diagnose the retention drift.
    SnapshotStale { reason: String },
}

/// Covering check for the responder's snapshot vs. the remote's
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
/// (matching pre- behavior).
pub(crate) async fn try_offer_snapshot_catchup(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
    remote_heads: &[DeviceHead],
) -> Result<OfferOutcome, AppError> {
    let Some((snapshot_id, compressed, snapshot_up_to_seqs)) =
        get_latest_snapshot_with_frontier(pool).await?
    else {
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

    // #706 item 2 — transfer integrity hash. blake3 of the *compressed*
    // blob, advertised in the offer so the initiator can verify the bytes
    // it receives match what we read off disk. Catches responder-side disk
    // corruption between read and send (the one gap left by mTLS +
    // atomic-apply). Mirrors `FileOffer::blake3_hash`.
    let blob_blake3 = blake3::hash(&compressed).to_hex().to_string();

    // Defensive covering check.
    //
    // `ResetRequired` means our op_log was compacted past the remote's
    // advertised frontier — so the snapshot we are about to offer
    // SHOULD have an `up_to_seqs` >= every remote head, by construction
    // (compaction is bounded by the snapshot's frontier). If retention
    // policy ever drifts (e.g. compaction window vs. snapshot window),
    // this invariant could quietly break and we would re-apply an
    // older snapshot on the initiator — silent data regression.
    //
    // Compare the snapshot's frontier against the remote heads we
    // received in `HeadExchange`. Mismatch → `Error` instead of
    // `SnapshotOffer` so the initiator fails loudly and the operator
    // can spot the regression in logs.
    //
    // #705: read `up_to_seqs` straight from the `log_snapshots` column
    // (persisted by `create_snapshot`) instead of zstd+CBOR-decoding the
    // whole snapshot blob — every table — just to reach the frontier.
    if let Err(reason) = snapshot_covers_remote_heads(&snapshot_up_to_seqs, remote_heads) {
        tracing::warn!(
            peer_id = %remote_device_id,
            snapshot_id = %snapshot_id,
            reason = %reason,
            "responder snapshot does not cover remote frontier; sending Error instead of SnapshotOffer"
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
                "failed to send  stale-snapshot Error to initiator"
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

    conn.send_json(&SyncMessage::SnapshotOffer {
        size_bytes,
        blob_blake3,
    })
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

/// #607: engine-reload context for the initiator-side catch-up.
///
/// Bundles the live engine registry with this device's id so
/// [`try_receive_snapshot_catchup`] can drop + reload the in-memory
/// engines right after `apply_snapshot` wipes the Loro sidecar tables
/// (via [`crate::loro::snapshot::reload_registry_from_db`]). Callers
/// without engine state (some unit tests) pass `None` — the snapshot
/// still applies, with a `warn!` that any live engines keep pre-reset
/// state until restart.
pub(crate) struct EngineReloadCtx<'a> {
    /// The live registry the session syncs against (override-aware in
    /// tests, process-global in production).
    pub(crate) registry: &'a crate::loro::registry::LoroEngineRegistry,
    /// This device's stable id, threaded into the rehydrate path.
    pub(crate) device_id: &'a str,
}

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
/// # peer_refs bookkeeping
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
///
/// # In-process engine reload (#607 / #779)
///
/// `apply_snapshot` wipes the Loro sidecar tables (`loro_doc_state`,
/// `loro_sync_inbox`, the apply cursor) atomically with the core-table
/// swap, but the in-memory engines still hold the pre-reset CRDT
/// lineage when it returns — and NO process restart follows this
/// function (it applies and returns to the daemon loop). Immediately
/// after the apply succeeds, this function calls
/// [`crate::loro::snapshot::reload_registry_from_db`] on
/// `engine_reload.registry` so the live engines match the post-reset
/// SQL: stale engines are dropped (they can no longer be exported to
/// peers or persisted back into `loro_doc_state` by the periodic /
/// exit-time `save_all_engines`) and the registry rehydrates from the
/// now-empty table. A `None` `engine_reload` (engine state not
/// initialised) is logged at `warn!` — the snapshot is still applied,
/// but any live engines keep pre-reset state until restart.
pub(crate) async fn try_receive_snapshot_catchup(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    materializer: &Materializer,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
    expected_remote_id: Option<&str>,
    engine_reload: Option<EngineReloadCtx<'_>>,
) -> Result<CatchupOutcome, AppError> {
    let offer: SyncMessage = conn.recv_json().await?;
    let (size_bytes, expected_blob_blake3) = match offer {
        SyncMessage::SnapshotOffer {
            size_bytes,
            blob_blake3,
        } => (size_bytes, blob_blake3),
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

    // Stream the compressed bytes straight to a temp file under
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

    // #706 item 2 — verify the transfer integrity hash BEFORE the
    // expensive decode/apply. Re-hash the received compressed bytes and
    // compare against the blake3 the responder advertised in its offer.
    // A mismatch means the blob was corrupted (responder-side disk error
    // before send, or a transport defect mTLS didn't catch) — fail fast
    // and loud here rather than letting it surface as an opaque
    // CBOR/zstd decode error inside `apply_snapshot`. `temp` drops (and
    // unlinks) on the early return.
    let actual_blob_blake3 = blake3_of_file(temp.path()).await?;
    if actual_blob_blake3 != expected_blob_blake3 {
        tracing::warn!(
            peer_id = %remote_device_id,
            expected = %expected_blob_blake3,
            actual = %actual_blob_blake3,
            "received snapshot blob failed blake3 integrity check; rejecting (#706)"
        );
        let msg = format!(
            "snapshot blob integrity check failed: expected blake3 {expected_blob_blake3}, \
             got {actual_blob_blake3}"
        );
        event_sink.on_sync_event(SyncEvent::Error {
            message: msg.clone(),
            remote_device_id: remote_device_id.to_string(),
        });
        return Err(AppError::Snapshot(msg));
    }

    event_sink.on_sync_event(SyncEvent::Progress {
        state: "snapshot_applying".into(),
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
    });

    // Open the temp file as a SYNC `std::fs::File` (the
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
    // #607 / #779 ordering: flush + drop the in-memory engines BEFORE the
    // apply commits, not after. If the registry were cleared only after
    // `apply_snapshot` returns, a `RunEvent::Exit` (or periodic)
    // `save_all_engines` firing in the commit→clear window would still
    // see the pre-reset engines and persist them straight into the just-
    // wiped `loro_doc_state` — resurrecting the old vault at next boot
    // (the #779 race, merely narrowed). Clearing first makes that save a
    // no-op by construction:
    //
    //  - exit/periodic save before the clear → writes pre-reset blobs
    //    into the still-pre-reset table (harmless; the apply wipes it);
    //  - after the clear → empty registry, nothing to write (and
    //    `save_all_engines`' generation check catches the handles-
    //    collected-before-clear interleave).
    //
    // The `save_all_engines` flush ahead of the clear makes the failure
    // path lossless: a failed `apply_snapshot` rolls the whole SQL tx
    // back (loro_doc_state intact), so the reload below restores the
    // engines exactly as just persisted.
    if let Some(EngineReloadCtx { registry, .. }) = &engine_reload {
        let flushed = crate::loro::snapshot::save_all_engines(pool, registry).await;
        registry.clear();
        tracing::info!(
            flushed,
            "pre-apply engine flush + clear (#607): registry emptied before \
             the snapshot RESET commits"
        );
    }

    let data = match apply_snapshot(pool, materializer, temp_file).await {
        Ok(data) => data,
        Err(e) => {
            // Apply failed → the SQL tx rolled back and `loro_doc_state`
            // still holds the rows flushed above. Restore the engines so
            // the session failure leaves the process exactly as it was.
            if let Some(EngineReloadCtx {
                registry,
                device_id,
            }) = &engine_reload
            {
                let rehydrated =
                    crate::loro::snapshot::reload_registry_from_db(pool, registry, device_id).await;
                tracing::warn!(
                    rehydrated,
                    "apply_snapshot failed after the pre-apply engine clear (#607); \
                     registry restored from the flushed loro_doc_state rows"
                );
            }
            return Err(e);
        }
    };
    drop(temp);
    let up_to_hash = data.up_to_hash.clone();

    // #607 / #779: the SQL RESET above also wiped `loro_doc_state` /
    // `loro_sync_inbox` and zeroed the apply cursor — now reload the
    // in-memory engines so the live registry matches the new SQL.
    // Without this, stale engines would (a) export pre-reset content
    // to peers on the next `prepare_outgoing` and (b) be persisted back
    // over the wiped `loro_doc_state` by the periodic / exit-time
    // `save_all_engines`, resurrecting the old vault at next boot.
    // (`reload_registry_from_db` re-clears — dropping any engine a local
    // edit lazy-created during the apply — then rehydrates from the
    // now-empty table, so the registry ends up EMPTY by design; see the
    // function docs for why empty is correct.)
    match engine_reload {
        Some(EngineReloadCtx {
            registry,
            device_id,
        }) => {
            let rehydrated =
                crate::loro::snapshot::reload_registry_from_db(pool, registry, device_id).await;
            tracing::info!(
                rehydrated,
                "post-snapshot engine reload complete (#607): dropped pre-reset \
                 engines; registry rehydrated from loro_doc_state"
            );
        }
        None => {
            tracing::warn!(
                "no Loro engine registry available at snapshot catch-up (#607); \
                 any live engines keep pre-reset state until the process restarts"
            );
        }
    }

    tracing::info!(
        peer_id = %remote_device_id,
        up_to_hash = %up_to_hash,
        up_to_seqs = ?data.up_to_seqs,
        "applied snapshot; frontier advanced"
    );

    // Mirror the SyncComplete fallback. Prefer the orchestrator's
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
             refusing to record peer_refs row keyed by empty string"
                .into(),
        ));
    };

    // Update peer_refs so the scheduler's "last synced" bookkeeping
    // reflects the catch-up. `last_sent_hash` stays empty — we did not
    // send anything in this session. The next scheduled sync will pick
    // up any ops the responder wrote after the snapshot was taken.
    //
    // Wrap the ensure-row + record-sync pair in a single
    // `BEGIN IMMEDIATE` transaction so a crash between the two writes
    // cannot leave a peer row whose `last_hash` is stale relative to
    // the snapshot frontier just applied. The bookkeeping write is
    // still treated as non-fatal — the snapshot itself is already
    // durable, and a failed bookkeeping commit just means the next
    // scheduler tick will reconsider this peer — but the rollback
    // ensures we don't leave a half-written peer row behind.
    let bookkeeping = async {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        peer_refs::upsert_peer_ref_in_tx(&mut tx, resolved_peer_id).await?;
        peer_refs::update_on_sync_in_tx(&mut tx, resolved_peer_id, &up_to_hash, "").await?;
        tx.commit().await?;
        Ok::<(), AppError>(())
    };
    if let Err(e) = bookkeeping.await {
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
        // #1071: snapshot catch-up reimports an ENTIRE space snapshot, so a
        // per-page targeted reload would be both incorrect (every page may
        // have changed) and impossible to enumerate cheaply here. Send an
        // empty set — the frontend falls back to a full reload + preload,
        // which is exactly the right response to a whole-space catch-up.
        changed_page_ids: Vec::new(),
    });

    Ok(CatchupOutcome::Applied {
        bytes_received: size_bytes,
        up_to_hash,
    })
}

/// A temp file holding a freshly-received snapshot blob.
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
/// The pattern is small and matches the
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

/// #706 item 2 — stream a file through a blake3 hasher and return the
/// lowercase hex digest. Reads in `BINARY_FRAME_CHUNK_SIZE` chunks so the
/// integrity check inherits the same bounded-memory profile as the
/// Receive path (never buffers the whole compressed blob). The hash
/// is computed on a blocking thread so the receive loop's executor is not
/// stalled on a multi-hundred-MB read.
async fn blake3_of_file(path: &Path) -> Result<String, AppError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String, AppError> {
        use std::io::Read;
        let mut file = std::fs::File::open(&path).map_err(|e| {
            AppError::Io(std::io::Error::new(
                e.kind(),
                format!("opening snapshot temp for hashing {}: {e}", path.display()),
            ))
        })?;
        let mut hasher = blake3::Hasher::new();
        let mut buf = vec![0u8; BINARY_FRAME_CHUNK_SIZE];
        loop {
            let n = file.read(&mut buf).map_err(|e| {
                AppError::Io(std::io::Error::new(
                    e.kind(),
                    format!("reading snapshot temp for hashing {}: {e}", path.display()),
                ))
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize().to_hex().to_string())
    })
    .await
    .map_err(|e| AppError::Snapshot(format!("blake3 hashing task panicked: {e}")))?
}

/// Stream `size_bytes` of a compressed snapshot from `conn` straight
/// To a `<app_data_dir>/snapshot-recv-<rand>.tmp` file.
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

    // Uses the streaming receiver: per-frame chunks are
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
        BlockSnapshot, SCHEMA_VERSION, SnapshotData, SnapshotTables, create_snapshot,
        encode_snapshot, get_latest_snapshot,
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
        let payload = OpPayload::CreateBlock(crate::op::CreateBlockPayload {
            block_id: crate::ulid::BlockId::test_id("01HZ00000000000000000BLOCK1"),
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
        let (mut server_conn, _client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
        let outcome = try_offer_snapshot_catchup(
            &mut server_conn,
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
                    " Error message must name the offending device, got {message:?}"
                );
                assert!(
                    message.contains("999"),
                    " Error message must include the remote's claimed seq, got {message:?}"
                );
            }
            other => panic!("expected SyncMessage::Error for stale snapshot, got {other:?}"),
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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        // Server side (responder): send offer + bytes.
        let bytes_clone = snap_bytes.clone();
        let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: snap_hash,
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
                    // Rejected on size before any receive/checksum.
                    blob_blake3: String::new(),
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
        // #706 item 2: advertise the CORRECT blake3 of the garbage so the
        // integrity check passes and the failure is the *decode* failure
        // this test pins (not an early checksum rejection).
        let garbage_hash = blake3::hash(&garbage).to_hex().to_string();
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes,
                    blob_blake3: garbage_hash,
                })
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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let bytes_clone = snap_bytes.clone();
        // Deliberately WRONG hash (all zeros) — does not match the bytes.
        let wrong_hash = "0".repeat(64);
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: wrong_hash,
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
            REMOTE_DEV,
            None,
            None,
        )
        .await;

        server_task.await.unwrap();

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
                    // Hash is irrelevant: the receive errors on EOF before
                    // the integrity check runs.
                    blob_blake3: String::new(),
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
            None,
        )
        .await;

        // (a) The interruption surfaces as Err.
        assert!(
            result.is_err(),
            "mid-stream disconnect must surface as Err; got {result:?}"
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
    // Peer_refs fallback (empty remote_device_id)
    // -----------------------------------------------------------------

    /// Helper for the fallback / failure tests: drive a successful
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
        let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: snap_hash,
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
            None,
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
        // HeadExchange sometimes carries only our own heads, so
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
        // With neither `remote_device_id` nor `expected_remote_id`
        // available, the function must fail loudly so the scheduler
        // records a failed session — silently completing would write a
        // peer_refs row keyed by the empty string and corrupt the
        // bookkeeping.
        let (_init_pool, _dir, result) = run_catchup_with_ids("", None).await;
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
    // Streaming snapshot transfer regression suite
    // -----------------------------------------------------------------
    //
    // + paired sync streaming items. is the wire-side
    // Primitive (`send/receive_binary_streaming`), layers a temp
    // file on top so the receiver lands the compressed snapshot on
    // disk frame-by-frame instead of accumulating it in a `Vec<u8>`.
    // `apply_snapshot` then reads through that temp file via the
    // streaming `decode_snapshot(impl Read)` path so neither the
    // compressed bytes nor the decompressed CBOR is ever fully
    // materialised in memory.

    /// Confirm `try_receive_snapshot_catchup` writes the
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
            "no snapshot temp files must exist before catch-up"
        );

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        let bytes_clone = snap_bytes.clone();
        let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: snap_hash,
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
            None,
        )
        .await
        .expect(" catch-up must succeed end-to-end");

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

        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

        // Send garbage that fits under the cap but won't decode.
        let garbage: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07];
        let size_bytes = garbage.len() as u64;
        let garbage_clone = garbage.clone();
        // #706 item 2: correct hash so the failure is the decode failure
        // this test pins (the temp must still be unlinked on that path).
        let garbage_hash = blake3::hash(&garbage).to_hex().to_string();
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes,
                    blob_blake3: garbage_hash,
                })
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
            None,
        )
        .await;
        assert!(
            result.is_err(),
            "garbage snapshot bytes must surface as Err; got {result:?}"
        );

        server_task.await.unwrap();

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
        use crate::loro::registry::LoroEngineRegistry;
        use crate::space::SpaceId;

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
            crate::loro::snapshot::save_snapshot(&init_pool, &space, g.engine_mut())
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
        let (mut server_conn, mut client_conn) = test_connection_pair().await;
        let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
        let bytes_clone = snap_bytes.clone();
        let snap_hash = blake3::hash(&snap_bytes).to_hex().to_string();
        let server_task = tokio::spawn(async move {
            server_conn
                .send_json(&SyncMessage::SnapshotOffer {
                    size_bytes: expected_size,
                    blob_blake3: snap_hash,
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
            Some(EngineReloadCtx {
                registry: &registry,
                device_id: LOCAL_DEV,
            }),
        )
        .await
        .expect("catch-up must succeed");
        server_task.await.unwrap();
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
            let mut probe = crate::loro::engine::LoroEngine::with_peer_id(LOCAL_DEV).unwrap();
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
        let payload = OpPayload::CreateBlock(crate::op::CreateBlockPayload {
            block_id: crate::ulid::BlockId::test_id("01HZ0000000000000000BLOCK2"),
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
}
