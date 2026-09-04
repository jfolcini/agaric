//! Snapshot-driven catch-up for the sync orchestrator.
//!
//! ## #2503 — Loro-snapshot catch-up (merge, not wipe)
//!
//! When a catch-up needs a full-state transfer (the initiator's Loro
//! version vector is unreachable from the responder's — own-lineage loss
//! per #2502, or an unbridgeable delta caught by the receiver-side
//! `apply_remote` reachability gate), the responder ships its per-space
//! **Loro snapshots** (the engine's truth) and the initiator *merges*
//! them into its own engine via
//! [`crate::sync_protocol::loro_sync::apply_remote`], then reprojects SQL
//! from the merged engine state. The initiator's unsynced local content
//! **survives** and syncs back out — inverting the #2474 data-loss
//! contract of the old CBOR RESET.
//!
//! * Responder: [`try_offer_loro_snapshot_catchup`] streams
//!   `SyncMessage::LoroSync { LoroSyncMessage::Snapshot, .. }` per space.
//! * Initiator: [`try_receive_snapshot_catchup`] merges each inbound
//!   `LoroSync` into the local engine and reprojects SQL.
//!
//! ## Protocol
//!
//! After the main [`SyncOrchestrator`](crate::sync_protocol::SyncOrchestrator)
//! message loop exits with `state == ResetRequired`:
//!
//! 1. The responder exports one full snapshot per registered space and
//!    writes each as a framed `LoroSync` message on the same QUIC
//!    bi-stream the session is already running on.
//! 2. The initiator reads them under an explicit [`RECV_TIMEOUT`] — QUIC
//!    supplies no receive bound of its own (see
//!    [`crate::transport::session::RECV_TIMEOUT`]) — merges each into its
//!    engine, and records the merged frontier in `peer_refs` so the next
//!    scheduled sync begins a normal delta exchange.
//!
//! #3487: the pre-#2503 CBOR `SnapshotOffer` / `SnapshotAccept` RESET
//! sub-flow this replaced is **gone**. The iroh port made it unreachable —
//! `SYNC_ALPN` is negotiated before any application byte moves, so a build
//! predating it cannot open a session at all, never mind offer a CBOR
//! snapshot.

use std::path::Path;
use std::sync::Arc;

use iroh::endpoint::{RecvStream, SendStream};
use sqlx::SqlitePool;

use crate::apply_host::ApplyHost;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_protocol::SyncMessage;
use crate::sync_protocol::loro_sync::{self, ApplyOutcome};
use crate::sync_protocol::loro_sync_types::LoroSyncMessage;
use crate::transport::session::{RECV_TIMEOUT, recv_sync_message_within, send_sync_message};
use agaric_core::error::AppError;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_store::peer_refs;

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
/// This replaced the legacy CBOR RESET sub-flow (deleted in #3487). Rather
/// than ship a zstd-CBOR blob of SQL tables that the initiator applied by
/// **wiping + replacing** its core tables — destroying any unsynced local
/// edits (the #2474 data-loss contract) — the responder
/// exports each registered space's `LoroDoc` snapshot
/// (`ExportMode::Snapshot`, the engine's truth) and streams it over the same
/// framed transport the normal streaming phase uses
/// ([`crate::transport::session::send_sync_message`]).
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
/// `_recv` is unused — this phase only writes; the responder streams every
/// space snapshot and never waits for a reply. It is taken so every catch-up
/// entry point in this module has the same `(send, recv)` prefix.
#[tracing::instrument(skip_all, err)]
pub async fn try_offer_loro_snapshot_catchup(
    send: &mut SendStream,
    _recv: &mut RecvStream,
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
        send_sync_message(
            send,
            &SyncMessage::SyncComplete {
                last_hash: String::new(),
            },
        )
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
        // One length-prefixed frame per space snapshot, however large: a
        // QUIC stream has no message boundary and no 10 MB text-frame cap,
        // so the #611 inline-vs-chunked split that `sync_daemon::wire`
        // existed to make has nothing left to decide. The one bound that
        // remains is `transport::session::MAX_FRAME_SIZE` (256 MB), and it
        // still bites earlier than the payload size suggests: `bytes` is a
        // `Vec<u8>` inside a serde-JSON enum, so a space snapshot costs ~4
        // bytes on the wire per byte of CRDT state. That inflation is a
        // property of `SyncMessage`'s shape, not of the transport — see the
        // `transport::session` module docs.
        send_sync_message(send, &SyncMessage::LoroSync { msg, is_last }).await?;
    }

    Ok(LoroCatchupSent {
        spaces_sent: total,
        bytes_sent,
    })
}

// ---------------------------------------------------------------------------
// Initiator side — receive + merge
// ---------------------------------------------------------------------------

/// Engine context for the initiator-side catch-up.
///
/// Bundles the live engine registry with this device's id so
/// [`receive_loro_snapshot_catchup`] can merge the responder's per-space
/// snapshots into the local engines. `None` is a programmer error on this
/// path — a merge has nothing to merge into without a registry — and fails
/// the catch-up.
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

/// Resolve the peer identity a catch-up should be attributed to, preferring
/// the session-level id and falling back to the daemon-supplied one.
///
/// The pure half of what
/// [`SyncOrchestrator::resolve_remote_peer_id`](crate::sync_protocol::SyncOrchestrator)
/// does inside the state machine, extracted (#4097) because the two catch-up
/// entry points below had grown two hand-rolled copies of the same three-way
/// choice — one of which logged the *expected* fallback at `warn!` while the
/// other logged it not at all.
///
/// `None` means neither source carried an identity; the caller turns that into
/// a hard error rather than key a `peer_refs` row on the empty string.
///
/// Deliberately silent, and called exactly once per catch-up — at the entry
/// point, before any event is emitted — so both catch-up flavours inherit one
/// resolution and one log line instead of re-deciding at their completion
/// writes. The logging lives at the call sites because only they know whether
/// taking the fallback is routine (on this path it is) or whether having no
/// identity at all is about to fail the session.
fn catchup_peer_identity<'a>(
    remote_device_id: &'a str,
    expected_remote_id: Option<&'a str>,
) -> Option<&'a str> {
    if !remote_device_id.is_empty() {
        return Some(remote_device_id);
    }
    expected_remote_id.filter(|id| !id.is_empty())
}

/// Attempt to receive + merge a peer's Loro snapshots after the
/// initiator's main loop reached
/// [`SyncState::ResetRequired`](crate::sync_protocol::SyncState::ResetRequired).
///
/// Called by [`run_sync_session`](super::session_supervisor::run_sync_session)
/// once the main message loop exits with `state == ResetRequired`.
///
/// Reads the responder's first post-`ResetRequired` message under an explicit
/// [`RECV_TIMEOUT`] — QUIC gives a receive no clock of its own — and hands a
/// [`SyncMessage::LoroSync`] to [`receive_loro_snapshot_catchup`], which merges
/// each per-space snapshot into the local engine and reprojects SQL. Any other
/// variant returns [`AppError::InvalidOperation`] so the caller records a sync
/// failure (same treatment as a malformed delta exchange).
///
/// # peer_refs bookkeeping
///
/// `expected_remote_id` mirrors the `SyncComplete` fallback in
/// [`SyncOrchestrator`](crate::sync_protocol::SyncOrchestrator):
/// when `remote_device_id` is empty (a `HeadExchange` that only
/// carried our own heads), the function falls back to
/// `expected_remote_id` for the [`peer_refs`] upsert. If both are
/// empty the catch-up returns
/// [`AppError::InvalidOperation`] so the caller records a failed
/// session instead of silently merging peer state whose origin
/// peer cannot be remembered (the next sync would treat this peer
/// as fully unknown again).
///
/// #4097 resolves that choice **once, up front** rather than at the
/// completion write, so the resolved id is what every `Progress` /
/// `Error` event carries and what every log line names — the same
/// "make the identity available from frame 0" move #4085 made in the
/// state machine, where the fix was not cosmetic: a UI keyed on
/// `remote_device_id` drops an event carrying `""`.
///
/// Taking the fallback logs at `debug!`, not `warn!`. `HeadExchange`
/// is initiator-*sent*, so on the initiator — the only role that
/// reaches a catch-up — a session id that had to come from the
/// authenticated peer identity is the *designed* path, not an
/// anomaly, and a per-session WARN on a healthy path is what teaches
/// readers to ignore the level. The `warn!` moves to the case that is
/// genuinely surprising: no identity from *either* source, which
/// fails the session.
#[tracing::instrument(skip_all, err)]
// One argument over the lint, and the extra one is the receive half of a bi-stream that
// used to be a single `&mut SyncConnection`. Re-bundling them would cost the disjoint
// field borrows the call sites depend on.
#[allow(clippy::too_many_arguments)]
pub async fn try_receive_snapshot_catchup(
    send: &mut SendStream,
    recv: &mut RecvStream,
    pool: &SqlitePool,
    materializer: &dyn ApplyHost,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
    expected_remote_id: Option<&str>,
    engine_reload: Option<EngineReloadCtx<'_>>,
) -> Result<CatchupOutcome, AppError> {
    // #4097: settle the peer identity before anything is emitted, and shadow
    // the parameter with it so every event, log field and bookkeeping write
    // below is attributed to the peer we actually resolved instead of to `""`.
    // Resolution itself is unchanged (session id wins, daemon identity fills
    // in); only its *timing* moves, and the empty-string value survives for the
    // no-identity case so the failure below reads exactly as it did.
    let resolved_identity = catchup_peer_identity(remote_device_id, expected_remote_id);
    if resolved_identity.is_some() && remote_device_id.is_empty() {
        tracing::debug!(
            expected_remote_id = expected_remote_id.unwrap_or_default(),
            "remote_device_id was empty at snapshot catch-up; falling back to \
             the daemon-supplied peer identity"
        );
    }
    let remote_device_id: &str = resolved_identity.unwrap_or_default();

    // #2503: read the responder's first post-ResetRequired message. Under
    // QUIC this is one length-prefixed frame however large — there is no
    // chunked reassembly step, because there is no message-size cap to
    // chunk around. Bounded by `RECV_TIMEOUT` because this runs AFTER the
    // driver loop, on the same stream, and QUIC gives a receive no clock of
    // its own.
    match recv_sync_message_within(recv, RECV_TIMEOUT).await? {
        SyncMessage::LoroSync { msg, is_last } => {
            receive_loro_snapshot_catchup(
                send,
                recv,
                pool,
                materializer,
                event_sink,
                remote_device_id,
                engine_reload,
                msg,
                is_last,
            )
            .await
        }
        SyncMessage::Error { message } => Err(AppError::InvalidOperation(format!(
            "peer reported error instead of a snapshot catch-up: {message}"
        ))),
        other => Err(AppError::InvalidOperation(format!(
            "expected LoroSync after ResetRequired, got {:?}",
            std::mem::discriminant(&other)
        ))),
    }
}

/// #2503 — receive + MERGE full per-space Loro snapshots from a peer after
/// the initiator's main loop reached
/// [`SyncState`](crate::sync_protocol::SyncState)`::ResetRequired`.
///
/// This is the "merge, not wipe" catch-up. Each inbound
/// [`LoroSyncMessage::Snapshot`] is imported into THIS device's per-space
/// engine via [`crate::sync_protocol::loro_sync::apply_remote`], which merges
/// (Loro CRDT semantics — the initiator's unsynced local content is preserved,
/// not destroyed) and reprojects the changed blocks into SQL. Unlike the CBOR
/// RESET this replaced (deleted in #3487) there is:
///   * NO core-table wipe (SQL is reprojected from the merged engine),
///   * NO engine registry reload / drop (the live engines are merged in place),
///   * NO `reset_count` / peer-epoch bump (no reset occurred).
///
/// `engine_reload` supplies the live registry + local device id the merge
/// applies against; it is REQUIRED — a merge has nothing to merge into
/// without it. A `None` is a programmer error → `InvalidOperation`.
///
/// Residual (#2503 open q1): if an inbound snapshot forks our own
/// `(peer, counter)` space (a corrupt / pre-epoch-reset local doc — #792),
/// `apply_remote` returns `SnapshotFallbackRequested`. A pure merge cannot heal
/// that without an engine-only reset (not yet implemented); it surfaces as an
/// error so the session records a failure and retries, rather than silently
/// corrupting state.
///
/// `_send` is unused — this phase only reads; every message it consumes is
/// pushed by the responder and none is acknowledged. It is taken so every
/// catch-up entry point in this module has the same `(send, recv)` prefix.
///
/// `remote_device_id` arrives **already resolved** (#4097): its sole caller,
/// [`try_receive_snapshot_catchup`], runs [`catchup_peer_identity`] before it
/// dispatches here, so this function no longer takes `expected_remote_id` and
/// no longer carries a third hand-rolled copy of the same fallback. Empty here
/// therefore means "neither source had an identity", which is fatal at the
/// bookkeeping write below — not a cue to look somewhere else for one.
#[tracing::instrument(skip_all, err)]
#[allow(clippy::too_many_arguments)]
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
async fn receive_loro_snapshot_catchup(
    _send: &mut SendStream,
    recv: &mut RecvStream,
    pool: &SqlitePool,
    materializer: &dyn ApplyHost,
    event_sink: &Arc<dyn SyncEventSink>,
    remote_device_id: &str,
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
        // Bounded per message, not per catch-up: the responder exports and
        // sends one space snapshot at a time, so a peer with many large
        // spaces legitimately takes longer than `RECV_TIMEOUT` in total
        // while never being silent for that long. QUIC contributes no clock
        // here, so without this an export that dies between spaces leaves
        // this loop awaiting a frame that will never come, forever.
        match recv_sync_message_within(recv, RECV_TIMEOUT).await? {
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

    // #4097: the caller already resolved the identity (session id, else the
    // daemon's authenticated peer identity, logged there). Empty at this point
    // means neither source had one — the genuinely surprising case, and the one
    // that keeps a `warn!`: refuse an empty-keyed row.
    if remote_device_id.is_empty() {
        tracing::warn!(
            "loro-snapshot catch-up merged peer state but carried no remote device_id from \
             either the session or the daemon-supplied peer identity; refusing to key \
             peer_refs bookkeeping on an empty peer_id"
        );
        return Err(AppError::InvalidOperation(
            "loro-snapshot catch-up completed with empty remote_device_id and no \
             expected_remote_id; refusing to record peer_refs row keyed by empty string"
                .into(),
        ));
    }
    let resolved_peer_id: &str = remote_device_id;

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
        // #4305: as above — the loro-snapshot catch-up merges a whole peer
        // state. It resolved page ids, but not a block count, and `None` is
        // the value that means "changed, count unknown".
        changed_blocks: None,
    });

    Ok(CatchupOutcome::Applied {
        bytes_received,
        up_to_hash: last_hash,
    })
}

/// #2696 — boot-time sweep of orphaned snapshot-receive temp files.
///
/// The CBOR catch-up deleted in #3487 streamed each in-flight blob into
/// a `<app_data_dir>/snapshot-recv-<ulid>.tmp` file whose guard unlinked it
/// on every normal exit path (apply success, decode error, peer drop,
/// cancel). `Drop` never runs on `SIGKILL` / OOM-kill / power-loss, so a
/// process death mid-receive stranded the temp — up to 256 MB — directly in
/// `app_data_dir` with no other GC path reclaiming it. No build produces one
/// any more; this sweep still runs so a vault carried over from a build that
/// did is not left holding the orphan forever.
///
/// It removes every `snapshot-recv-*.tmp` file directly under
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
        // Match the exact prefix + suffix the receive path produced so we
        // never touch an unrelated file.
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

// ===========================================================================
// Tests
// ===========================================================================

// #2621 Sync-D: `snapshot_transfer_tests.rs` is hosted app-side by the
// `sync_daemon` shim (`src/sync_daemon/mod.rs`) — it references app-only
// `Materializer` / `recovery`, so the declaration lives in the app crate.
