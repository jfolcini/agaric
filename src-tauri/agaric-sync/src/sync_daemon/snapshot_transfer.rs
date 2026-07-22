//! Snapshot-driven catch-up for the sync orchestrator.
//!
//! ## #2503 — Loro-snapshot catch-up (merge, not wipe)
//!
//! When a catch-up needs a full-state transfer (the initiator's Loro
//! version vector is unreachable from the responder's — own-lineage loss
//! per #2502, or an unbridgeable delta caught by the receiver-side
//! `apply_remote` reachability gate), the **production** path now ships the
//! responder's per-space **Loro snapshots** (the engine's truth) and the
//! initiator *merges* them into its own engine via
//! [`crate::sync_protocol::loro_sync::apply_remote`], then reprojects SQL
//! from the merged engine state. The initiator's unsynced local content
//! **survives** and syncs back out — inverting the #2474 data-loss
//! contract of the old CBOR RESET.
//!
//! * Responder: [`try_offer_loro_snapshot_catchup`] streams
//!   `SyncMessage::LoroSync { LoroSyncMessage::Snapshot, .. }` per space.
//! * Initiator: [`try_receive_snapshot_catchup`] dispatches on the first
//!   post-`ResetRequired` message — a `LoroSync` routes to
//!   [`receive_loro_snapshot_catchup`] (merge); a legacy `SnapshotOffer`
//!   routes to the CBOR wipe-and-replace path below (accept-old back-compat).
//!
//! The legacy CBOR `SnapshotOffer`/`SnapshotAccept` **offer** path
//! (`apply_snapshot` wipe RESET) is retained only to (a) simulate a
//! pre-#2503 peer in tests and (b) accept an offer from a not-yet-upgraded
//! peer on the receive side. Production never *sends* a `SnapshotOffer`.
//! Wire-compat: **send-new / accept-old** — see
//! `docs/architecture/sync-protocol-spec.md`.
//!
//! ## Legacy CBOR flow (still used for accept-old / the compaction artifact)
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
//!    ([`agaric_engine::loro::snapshot::reload_registry_from_db`]) so the live
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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::io::AsyncWriteExt;

use crate::apply_host::ApplyHost;
use crate::snapshot::apply_snapshot;
use crate::sync_constants::BINARY_FRAME_CHUNK_SIZE;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_files::app_data_dir_from_pool;
use crate::sync_net::SyncConnection;
use crate::sync_protocol::SyncMessage;
use crate::sync_protocol::loro_sync::{self, ApplyOutcome};
use crate::sync_protocol::loro_sync_types::LoroSyncMessage;
use agaric_core::error::AppError;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_store::peer_refs;

// #2503: the legacy CBOR `SnapshotOffer` catch-up path is retained ONLY to
// simulate a pre-#2503 peer in tests (production never sends it — the offer
// side now streams Loro snapshots). These imports back the `#[cfg(any(test, feature = "test-util"))]`
// offer + covering-check helpers below.
#[cfg(any(test, feature = "test-util"))]
use crate::snapshot::get_latest_snapshot_with_frontier;
#[cfg(any(test, feature = "test-util"))]
use crate::sync_protocol::DeviceHead;
#[cfg(any(test, feature = "test-util"))]
use std::collections::BTreeMap;

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
pub const MAX_SNAPSHOT_SIZE: u64 = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Responder side — offer + send
// ---------------------------------------------------------------------------

/// Result of a responder-side snapshot offer attempt.
///
/// #2503: legacy CBOR offer path, test-only (production streams Loro
/// snapshots — see [`try_offer_loro_snapshot_catchup`]).
#[cfg(any(test, feature = "test-util"))]
#[derive(Debug, PartialEq)]
pub enum OfferOutcome {
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
///
/// # #2481 phase 1 — `snapshot_seqs` provenance caveat (known future risk)
///
/// `snapshot_seqs` is `collect_frontier`'s `up_to_seqs`, which is
/// deliberately unfiltered on `op_log.is_replicated` (see that function's
/// doc comment in `snapshot::create`) so the compaction purge also ages out
/// replicated foreign-device audit rows. That means once a production
/// caller of `dag::insert_replicated_op` exists (none does yet — #2481
/// phase 1 is ingest-only), a per-device seq in this map is NOT reliably
/// "this snapshot's materialized state reflects that device's edits up to
/// this seq" for a *replicated* device — audit-log replication is
/// explicitly decoupled from Loro state merge by design. Wiring the
/// send/receive sub-flow that would let replicated rows exist in production
/// must resolve this before `snapshot_seqs` can be trusted here for a
/// foreign device (see the TODO in `collect_frontier`).
///
/// #2503: test-only (backs the legacy CBOR offer path).
#[cfg(any(test, feature = "test-util"))]
pub fn snapshot_covers_remote_heads(
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
/// (matching pre-existing behavior).
///
/// #2503: the legacy CBOR offer, retained test-only to simulate a
/// pre-#2503 responder (production streams Loro snapshots — see
/// [`try_offer_loro_snapshot_catchup`]).
#[cfg(any(test, feature = "test-util"))]
#[tracing::instrument(skip_all, err)]
pub async fn try_offer_snapshot_catchup(
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
            let progress = SnapshotTransferProgress {
                event_sink,
                remote_device_id,
                bytes_total: size_bytes,
            };
            send_snapshot_bytes(conn, &compressed, &progress).await?;
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

/// Per-frame snapshot-transfer progress reporting hook.
///
/// Mirrors [`FileTransferProgress`](crate::sync_files::FileTransferProgress)
/// for the snapshot catch-up blob: when threaded into the send/receive
/// paths, the streaming chunk loops emit
/// [`SyncEvent::SnapshotProgress`] after each 5 MB binary frame so the
/// active sync's `Channel<SyncProgressUpdate>` carries a real bytes-done
/// signal to the UI. No throttling — the attachment path emits one event
/// per frame and we match its cadence (a 256 MB blob is at most ~52
/// frames at 5 MB each, well within event-bus budget). A terminal
/// `"complete"` tick is emitted once the blob finishes.
pub struct SnapshotTransferProgress<'a> {
    pub event_sink: &'a Arc<dyn SyncEventSink>,
    pub remote_device_id: &'a str,
    pub bytes_total: u64,
}

impl SnapshotTransferProgress<'_> {
    fn emit(&self, phase: &str, bytes_done: u64) {
        self.event_sink.on_sync_event(SyncEvent::SnapshotProgress {
            phase: phase.to_string(),
            remote_device_id: self.remote_device_id.to_string(),
            bytes_done,
            bytes_total: self.bytes_total,
        });
    }
}

/// Send the compressed snapshot bytes over the WebSocket in
/// [`BINARY_FRAME_CHUNK_SIZE`]-sized binary frames.
///
/// Streams via
/// [`SyncConnection::send_binary_streaming_with_progress`](crate::sync_net::SyncConnection::send_binary_streaming_with_progress)
/// so each 5 MB frame ticks a [`SyncEvent::SnapshotProgress`] with the
/// `"sending"` phase, mirroring the attachment-transfer path in
/// [`sync_files`](crate::sync_files). A zero-length snapshot is delivered
/// as a single empty frame so the receiver's frame accounting terminates
/// cleanly. A terminal `"complete"` tick is emitted once all bytes ship.
///
/// #2503: test-only (backs the legacy CBOR offer path).
#[cfg(any(test, feature = "test-util"))]
pub async fn send_snapshot_bytes(
    conn: &mut SyncConnection,
    compressed: &[u8],
    progress: &SnapshotTransferProgress<'_>,
) -> Result<(), AppError> {
    let total = compressed.len() as u64;
    // `&[u8]` implements `tokio::io::AsyncRead` (+ Unpin), so the
    // in-memory compressed blob can be streamed straight through the
    // shared progress-aware sender without an intermediate file or a
    // sync `std::io::Cursor` (which is NOT `AsyncRead`).
    conn.send_binary_streaming_with_progress(
        compressed,
        total,
        BINARY_FRAME_CHUNK_SIZE,
        |bytes_sent| progress.emit("sending", bytes_sent),
    )
    .await?;
    progress.emit("complete", total);
    Ok(())
}

// ---------------------------------------------------------------------------
// Responder side — Loro-snapshot catch-up (#2503, production path)
// ---------------------------------------------------------------------------

/// Byte length of a [`LoroSyncMessage`]'s inline CRDT payload (for progress
/// / accounting). Both variants carry the raw Loro bytes.
fn loro_msg_payload_len(msg: &LoroSyncMessage) -> u64 {
    match msg {
        LoroSyncMessage::Snapshot { bytes, .. } | LoroSyncMessage::Update { bytes, .. } => {
            bytes.len() as u64
        }
    }
}

/// Result of the responder-side Loro-snapshot catch-up (#2503).
#[derive(Debug, PartialEq, Eq)]
pub struct LoroCatchupSent {
    /// Number of per-space Loro snapshots streamed to the initiator.
    pub spaces_sent: usize,
    /// Total CRDT payload bytes streamed (sum of per-space snapshot sizes).
    pub bytes_sent: u64,
}

/// Stream full per-space **Loro snapshots** to the initiator after the
/// responder's main loop reached [`SyncState`](crate::sync_protocol::SyncState)`::ResetRequired`
/// (#2503).
///
/// This replaces the legacy CBOR `SnapshotOffer`/`SnapshotAccept` RESET
/// sub-flow. Rather than ship a zstd-CBOR blob of SQL tables that the
/// initiator applied by **wiping + replacing** its core tables — destroying
/// any unsynced local edits (the #2474 data-loss contract) — the responder
/// now exports each registered space's `LoroDoc` snapshot
/// (`ExportMode::Snapshot`, the engine's truth) and streams it over the same
/// chunked-binary transport the normal streaming phase uses
/// ([`crate::sync_daemon::wire::send_sync_message`]).
///
/// The initiator imports each snapshot into its own engine with Loro's
/// **merge** semantics ([`crate::sync_protocol::loro_sync::apply_remote`]) and
/// reprojects SQL from the merged engine state — so the initiator's own
/// unsynced local content survives and syncs back out on the next session.
///
/// Full snapshots (not incremental updates) are always sent: `ResetRequired`
/// means the initiator's version vector is unreachable, so an
/// `ExportMode::updates(from_vv)` delta could not be applied. A full snapshot
/// merges cleanly against any receiver state.
///
/// Wire-compat (#2503): a NEW responder always SENDS Loro snapshots. An OLD
/// (pre-#2503) initiator expecting a `SnapshotOffer` will fail this catch-up
/// and retry — see the deprecation note in
/// `docs/architecture/sync-protocol-spec.md`.
#[tracing::instrument(skip_all, err)]
pub async fn try_offer_loro_snapshot_catchup(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    event_sink: &Arc<dyn SyncEventSink>,
    device_id: &str,
    remote_device_id: &str,
) -> Result<LoroCatchupSent, AppError> {
    let space_ids = registry.space_ids();

    // Build one full snapshot per registered space. `None` peer-vv forces
    // `ExportMode::Snapshot` (engine truth) rather than an incremental delta.
    // The #1257 freshness gate may refuse a space whose engine is stale vs
    // SQL (returns `None`); that space is skipped and reconciled by a later
    // rebuild — never shipped as a half-truth.
    let sql_deleted = loro_sync::read_sql_soft_deleted_ids(pool).await?;
    let mut messages: Vec<LoroSyncMessage> = Vec::new();
    for sid in &space_ids {
        match loro_sync::prepare_outgoing(registry, sid, device_id, None, &sql_deleted).await? {
            Some(msg) => messages.push(msg),
            None => {
                tracing::warn!(
                    space_id = %sid.as_str(),
                    peer_id = %remote_device_id,
                    "loro-snapshot catch-up: freshness gate refused space export; skipping"
                );
            }
        }
    }

    if messages.is_empty() {
        // Nothing to catch the initiator up with. Send a terminal
        // `SyncComplete` so it stops waiting on the wire; it records this
        // as a non-progress event and retries on the next scheduled sync.
        tracing::info!(
            peer_id = %remote_device_id,
            "loro-snapshot catch-up: responder has no exportable space state to offer"
        );
        conn.send_json(&SyncMessage::SyncComplete {
            last_hash: String::new(),
        })
        .await?;
        return Ok(LoroCatchupSent {
            spaces_sent: 0,
            bytes_sent: 0,
        });
    }

    tracing::info!(
        peer_id = %remote_device_id,
        spaces = messages.len(),
        "loro-snapshot catch-up: streaming full per-space snapshots"
    );
    event_sink.on_sync_event(SyncEvent::Progress {
        state: "loro_snapshot_offered".into(),
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
    });

    let total = messages.len();
    let mut bytes_sent = 0u64;
    for (idx, msg) in messages.into_iter().enumerate() {
        let is_last = idx + 1 == total;
        bytes_sent += loro_msg_payload_len(&msg);
        // `send_sync_message` picks the inline or chunked-binary transport
        // per payload size (#611), so an arbitrarily large space snapshot
        // never blows the JSON text-frame cap.
        super::wire::send_sync_message(conn, &SyncMessage::LoroSync { msg, is_last }).await?;
    }

    Ok(LoroCatchupSent {
        spaces_sent: total,
        bytes_sent,
    })
}

// ---------------------------------------------------------------------------
// Initiator side — accept + receive + apply
// ---------------------------------------------------------------------------

/// #607: engine-reload context for the initiator-side catch-up.
///
/// Bundles the live engine registry with this device's id so
/// [`try_receive_snapshot_catchup`] can drop + reload the in-memory
/// engines right after `apply_snapshot` wipes the Loro sidecar tables
/// (via [`agaric_engine::loro::snapshot::reload_registry_from_db`]). Callers
/// without engine state (some unit tests) pass `None` — the snapshot
/// still applies, with a `warn!` that any live engines keep pre-reset
/// state until restart.
pub struct EngineReloadCtx<'a> {
    /// The live registry the session syncs against (override-aware in
    /// tests, process-global in production).
    pub registry: &'a agaric_engine::loro::registry::LoroEngineRegistry,
    /// This device's stable id, threaded into the rehydrate path.
    pub device_id: &'a str,
}

/// Result of an initiator-side snapshot catch-up attempt.
#[derive(Debug, PartialEq)]
pub enum CatchupOutcome {
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
/// Called by [`run_sync_session`](super::session_supervisor::run_sync_session)
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
///   [`peer_refs`](agaric_store::peer_refs) with the new `up_to_hash`.
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
/// [`agaric_engine::loro::snapshot::reload_registry_from_db`] on
/// `engine_reload.registry` so the live engines match the post-reset
/// SQL: stale engines are dropped (they can no longer be exported to
/// peers or persisted back into `loro_doc_state` by the periodic /
/// exit-time `save_all_engines`) and the registry rehydrates from the
/// now-empty table. A `None` `engine_reload` (engine state not
/// initialised) is logged at `warn!` — the snapshot is still applied,
/// but any live engines keep pre-reset state until restart.
#[tracing::instrument(skip_all, err)]
pub async fn try_receive_snapshot_catchup(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    materializer: &dyn ApplyHost,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
    expected_remote_id: Option<&str>,
    engine_reload: Option<EngineReloadCtx<'_>>,
) -> Result<CatchupOutcome, AppError> {
    // #2503: read the responder's first post-ResetRequired message through
    // the wire layer so a chunked LoroSync (a large Loro snapshot) is
    // reassembled. Dispatch on its kind:
    //   * `LoroSync`      → NEW peer streaming full per-space Loro snapshots;
    //                       import + MERGE them (unsynced local edits survive)
    //                       and reproject SQL — the #2503 catch-up.
    //   * `SnapshotOffer` → legacy (pre-#2503) peer offering a zstd-CBOR SQL
    //                       snapshot RESET; accepted for back-compat via the
    //                       wipe-and-replace path below (accept-old).
    let (size_bytes, expected_blob_blake3) = match super::wire::recv_sync_message(conn).await? {
        SyncMessage::LoroSync { msg, is_last } => {
            return receive_loro_snapshot_catchup(
                conn,
                pool,
                materializer,
                event_sink,
                remote_device_id,
                expected_remote_id,
                engine_reload,
                msg,
                is_last,
            )
            .await;
        }
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
    let recv_progress = SnapshotTransferProgress {
        event_sink,
        remote_device_id,
        bytes_total: size_bytes,
    };
    let temp =
        receive_snapshot_to_temp(conn, &app_data_dir, size_bytes, Some(&recv_progress)).await?;
    // #2133 — terminal tick: the full blob is now on disk. Emit a
    // `"complete"` SnapshotProgress so the UI can clear the transfer
    // affordance before the (potentially slow) decode/apply begins.
    recv_progress.emit("complete", size_bytes);

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
        let flushed = agaric_engine::loro::snapshot::save_all_engines(pool, registry).await;
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
                // #2023: on the failed-apply path the RESET tx rolled
                // back, so the persisted epoch is UNCHANGED — a reload
                // failure here can't fork (it would reload onto the same
                // original epoch). Log it and still return the original
                // apply error; we do not want to mask `e` with a reload
                // error or leave the function without restoring.
                match agaric_engine::loro::snapshot::reload_registry_from_db(
                    pool, registry, device_id,
                )
                .await
                {
                    Ok(rehydrated) => tracing::warn!(
                        rehydrated,
                        "apply_snapshot failed after the pre-apply engine clear (#607); \
                         registry restored from the flushed loro_doc_state rows"
                    ),
                    Err(reload_err) => tracing::error!(
                        error = %reload_err,
                        "apply_snapshot failed AND the engine restore could not read the \
                         peer epoch (#2023/#607); registry left cleared — engines will \
                         lazy-recreate under the (unchanged, rolled-back) epoch"
                    ),
                }
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
            // #2023: the RESET committed, so the persisted epoch was
            // bumped to >= 1. If the epoch read fails here we must fail
            // the session CLOSED: proceeding (or letting engines
            // lazy-recreate) under the wrong epoch would mint ops under
            // the retired pre-reset PeerID and re-fork the
            // (peer, counter) space (#792). `reload_registry_from_db`
            // leaves the registry untouched on this error.
            let rehydrated =
                agaric_engine::loro::snapshot::reload_registry_from_db(pool, registry, device_id)
                    .await?;
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
        // #2046: a snapshot catch-up IS a protocol reset — the initiator's
        // op_log/Loro state was wiped and re-seeded from the responder's
        // snapshot. Bump `reset_count` (and stamp `last_reset_at`) in the
        // SAME transaction that advances `synced_at`/`last_hash`, so the
        // counter and the new frontier commit atomically: a crash between
        // them can't record the re-sync without the reset (or vice versa).
        // This is the single production caller of the increment, so the
        // counter advances exactly once per applied snapshot — driving the
        // "{reset_count} resets" badge in `PeerListItem.tsx`.
        peer_refs::increment_reset_count_in_tx(&mut tx, resolved_peer_id).await?;
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

/// #2503 — receive + MERGE full per-space Loro snapshots from a peer after
/// the initiator's main loop reached
/// [`SyncState`](crate::sync_protocol::SyncState)`::ResetRequired`.
///
/// This is the "merge, not wipe" catch-up. Each inbound
/// [`LoroSyncMessage::Snapshot`] is imported into THIS device's per-space
/// engine via [`crate::sync_protocol::loro_sync::apply_remote`], which merges
/// (Loro CRDT semantics — the initiator's unsynced local content is preserved,
/// not destroyed) and reprojects the changed blocks into SQL. In contrast to
/// the legacy CBOR path in [`try_receive_snapshot_catchup`] there is:
///   * NO core-table wipe (SQL is reprojected from the merged engine),
///   * NO engine registry reload / drop (the live engines are merged in place),
///   * NO `reset_count` / peer-epoch bump (no reset occurred — #2046 is a
///     legacy-CBOR-only concern now).
///
/// `engine_reload` supplies the live registry + local device id the merge
/// applies against; it is REQUIRED here (the legacy CBOR path can run without
/// it, but a merge cannot). A `None` is a programmer error → `InvalidOperation`.
///
/// Residual (#2503 open q1): if an inbound snapshot forks our own
/// `(peer, counter)` space (a corrupt / pre-epoch-reset local doc — #792),
/// `apply_remote` returns `SnapshotFallbackRequested`. A pure merge cannot heal
/// that without an engine-only reset (not yet implemented); it surfaces as an
/// error so the session records a failure and retries, rather than silently
/// corrupting state.
#[tracing::instrument(skip_all, err)]
#[allow(clippy::too_many_arguments)]
async fn receive_loro_snapshot_catchup(
    conn: &mut SyncConnection,
    pool: &SqlitePool,
    materializer: &dyn ApplyHost,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
    expected_remote_id: Option<&str>,
    engine_reload: Option<EngineReloadCtx<'_>>,
    first_msg: LoroSyncMessage,
    first_is_last: bool,
) -> Result<CatchupOutcome, AppError> {
    let EngineReloadCtx {
        registry,
        device_id,
    } = engine_reload.ok_or_else(|| {
        AppError::InvalidOperation(
            "loro-snapshot catch-up requires a live engine registry to merge into; \
             none was provided"
                .into(),
        )
    })?;

    event_sink.on_sync_event(SyncEvent::Progress {
        state: "loro_snapshot_merging".into(),
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
    });

    let mut bytes_received = 0u64;
    let mut changed_page_ids: Vec<String> = Vec::new();
    let mut loro_msg = first_msg;
    let mut is_last = first_is_last;
    loop {
        bytes_received += loro_msg_payload_len(&loro_msg);
        // Merge semantics: `apply_remote` imports the snapshot into our
        // engine (preserving unsynced local content) and reprojects the
        // changed blocks into SQL inside its own transaction.
        match loro_sync::apply_remote(pool, registry, device_id, loro_msg).await? {
            ApplyOutcome::Imported {
                changed_blocks,
                purged_blocks,
                changed_page_ids: pids,
                ..
            } => {
                for pid in pids {
                    if !changed_page_ids.contains(&pid) {
                        changed_page_ids.push(pid);
                    }
                }
                // Non-fatal: the projection already committed inside
                // apply_remote; a queue-closed error must not unwind the
                // catch-up (mirrors the orchestrator's LoroSync arm).
                if let Err(e) = materializer
                    .enqueue_inbound_sync_rebuilds(&changed_blocks, &purged_blocks)
                    .await
                {
                    tracing::warn!(
                        peer_id = %remote_device_id,
                        error = %e,
                        "loro-snapshot catch-up: failed to enqueue inbound-sync cache rebuilds"
                    );
                }
            }
            ApplyOutcome::SnapshotFallbackRequested { space_id, reason } => {
                return Err(AppError::InvalidOperation(format!(
                    "loro-snapshot catch-up: peer snapshot for space {space} could not be merged \
                     ({reason}); local engine likely forked its own (peer,counter) space (#792) — \
                     engine-only reset is not yet implemented (#2503 open q1)",
                    space = space_id.as_str(),
                )));
            }
        }
        if is_last {
            break;
        }
        match super::wire::recv_sync_message(conn).await? {
            SyncMessage::LoroSync { msg, is_last: il } => {
                loro_msg = msg;
                is_last = il;
            }
            other => {
                return Err(AppError::InvalidOperation(format!(
                    "loro-snapshot catch-up: expected another LoroSync frame, got {:?}",
                    std::mem::discriminant(&other)
                )));
            }
        }
    }

    // Resolve the peer identity for bookkeeping (mirrors the CBOR path /
    // SyncComplete fallback): prefer the session-level id, else the daemon's
    // mTLS/mDNS `expected_remote_id`; refuse an empty-keyed row.
    let resolved_peer_id: &str = if !remote_device_id.is_empty() {
        remote_device_id
    } else if let Some(expected) = expected_remote_id.filter(|s| !s.is_empty()) {
        expected
    } else {
        return Err(AppError::InvalidOperation(
            "loro-snapshot catch-up completed with empty remote_device_id and no \
             expected_remote_id; refusing to record peer_refs row keyed by empty string"
                .into(),
        ));
    };

    // `last_hash` is our own post-merge local frontier hash — this catch-up
    // is a PULL (we received, did not send), so it advances the pull
    // bookkeeping exactly like a normal LoroSync completion. There is no
    // reset: `reset_count` is NOT bumped.
    let last_hash = crate::sync_protocol::get_local_heads(pool)
        .await?
        .into_iter()
        .find(|h| h.device_id == device_id)
        .map(|h| h.hash)
        .unwrap_or_default();

    let bookkeeping = async {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        peer_refs::upsert_peer_ref_in_tx(&mut tx, resolved_peer_id).await?;
        peer_refs::update_on_sync_in_tx(&mut tx, resolved_peer_id, &last_hash, "").await?;
        tx.commit().await?;
        Ok::<(), AppError>(())
    };
    if let Err(e) = bookkeeping.await {
        tracing::warn!(
            peer_id = %resolved_peer_id,
            error = %e,
            "loro-snapshot catch-up: failed to record merge in peer_refs (non-fatal)"
        );
    }

    tracing::info!(
        peer_id = %resolved_peer_id,
        bytes_received,
        "loro-snapshot catch-up complete: merged peer state, SQL reprojected"
    );
    event_sink.on_sync_event(SyncEvent::Complete {
        remote_device_id: remote_device_id.to_string(),
        ops_received: 0,
        ops_sent: 0,
        changed_page_ids,
    });

    Ok(CatchupOutcome::Applied {
        bytes_received,
        up_to_hash: last_hash,
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

/// #2696 — boot-time sweep of orphaned snapshot-receive temp files.
///
/// [`receive_snapshot_to_temp`] streams each in-flight catch-up blob into
/// a `<app_data_dir>/snapshot-recv-<ulid>.tmp` file guarded by
/// [`SnapshotTempFile`], whose `Drop` unlinks it on every normal exit
/// path (apply success, decode error, peer drop, cancel). But `Drop`
/// never runs on `SIGKILL` / OOM-kill / power-loss, so a process death
/// mid-receive strands the temp — potentially up to `MAX_SNAPSHOT_SIZE`
/// (256 MB) — directly in `app_data_dir` with no other GC path
/// reclaiming it.
///
/// This sweep removes every `snapshot-recv-*.tmp` file directly under
/// `app_data_dir`. It is deliberately called **once at startup, before
/// the sync daemon begins accepting inbound connections**, which is what
/// makes an unconditional delete (no age gate) safe: at boot no receive
/// can be in flight yet, so every matching file is by construction an
/// orphan left by a previous process — there is no live temp to race.
///
/// Best-effort: an unreadable `app_data_dir` or an individual unlink
/// failure is logged and skipped so boot never fails on cleanup. Returns
/// the number of files removed (used by tests and boot logging).
pub fn sweep_orphaned_snapshot_temps(app_data_dir: &Path) -> usize {
    let rd = match std::fs::read_dir(app_data_dir) {
        Ok(rd) => rd,
        Err(e) => {
            tracing::warn!(
                dir = %app_data_dir.display(),
                error = %e,
                "snapshot-temp sweep: could not read app_data_dir; skipping",
            );
            return 0;
        }
    };

    let mut removed = 0usize;
    for entry in rd.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Match the exact prefix + suffix `receive_snapshot_to_temp`
        // produces so we never touch an unrelated file.
        if !(name.starts_with("snapshot-recv-") && name.ends_with(".tmp")) {
            continue;
        }
        // Only unlink regular files — never recurse into or remove a
        // directory that happens to match the name pattern.
        match entry.file_type() {
            Ok(ft) if ft.is_file() => {}
            _ => continue,
        }
        let path = entry.path();
        match std::fs::remove_file(&path) {
            Ok(()) => {
                removed += 1;
                tracing::debug!(path = %path.display(), "swept orphaned snapshot temp");
            }
            Err(e) => tracing::warn!(
                path = %path.display(),
                error = %e,
                "snapshot-temp sweep: failed to remove orphan",
            ),
        }
    }

    if removed > 0 {
        tracing::info!(removed, "swept orphaned snapshot-recv temp files at boot");
    }
    removed
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
#[tracing::instrument(skip(conn, app_data_dir, progress), err)]
async fn receive_snapshot_to_temp(
    conn: &mut SyncConnection,
    app_data_dir: &Path,
    size_bytes: u64,
    progress: Option<&SnapshotTransferProgress<'_>>,
) -> Result<SnapshotTempFile, AppError> {
    // ULID gives us 128 bits of entropy + a monotonic timestamp
    // prefix — collisions across overlapping snapshot transfers
    // are not practically possible. Render in lower-case hex so
    // the suffix is portable across case-folding filesystems.
    let suffix: u128 = u128::from(ulid::Ulid::r#gen());
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
    // grows beyond a single frame. When a progress hook is present
    // (#2133), each frame ticks a `"receiving"` SnapshotProgress event
    // so the UI sees a real bytes-done bar for the catch-up blob.
    match progress {
        Some(p) => {
            conn.receive_binary_streaming_with_progress(&mut file, size_bytes, |bytes_received| {
                p.emit("receiving", bytes_received);
            })
            .await?;
        }
        None => {
            conn.receive_binary_streaming(&mut file, size_bytes).await?;
        }
    }

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

// #2621 Sync-D: `snapshot_transfer_tests.rs` is hosted app-side by the
// `sync_daemon` shim (`src/sync_daemon/mod.rs`) — it references app-only
// `Materializer` / `recovery`, so the declaration lives in the app crate.
