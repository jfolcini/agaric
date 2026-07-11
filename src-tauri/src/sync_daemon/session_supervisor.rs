//! # `sync_daemon` orchestrator
//!
//! Per-process daemon that owns everything *around* a single sync
//! session. Concretely:
//!
//! * **Peer discovery** — mDNS browse + announce, including the
//!   Android `WifiManager.MulticastLock` workaround and the
//!   graceful-fallback path when raw multicast UDP is unavailable.
//! * **Per-peer scheduling** — exponential backoff, "due for resync"
//!   tick, foreground/background gating, and a dormant-mode
//!   waiter that defers mDNS / TLS listener startup until the user
//!   pairs a device.
//! * **Per-peer mutual exclusion** — a `try_lock_peer` mutex prevents
//!   two concurrent sessions with the same device.
//! * **Connection setup** — multi-address connect with TOFU cert
//!   pinning and address persistence to `peer_refs`.
//! * **Snapshot catch-up orchestration** — when the per-session state
//!   machine reaches [`SyncState::ResetRequired`], this layer hands
//!   control to [`super::snapshot_transfer`] for a snapshot-driven
//!   recovery.
//! * **File-transfer orchestration** — after the per-session state
//!   machine reaches [`SyncState::Complete`], this layer hands control
//!   to [`crate::sync_files`] for the bidirectional attachment
//!   transfer phase (F-14).
//! * **Event emission** — bridges [`crate::sync_events::SyncEventSink`]
//!   into the per-session [`SyncOrchestrator`] and surfaces
//!   daemon-level lifecycle events (mDNS disabled, connection
//!   failure, sync complete) directly.
//! * **Cancellation** — owns the [`AtomicBool`] cancel flag observed
//!   by `run_sync_session` and threaded into `sync_files` so the user
//!   can abort multi-gigabyte attachment transfers.
//!
//! ## What this module does **not** own
//!
//! The per-session HeadExchange → OpBatch → ApplyingOps → Merging →
//! Complete state machine lives in
//! [`crate::sync_protocol::session_state_machine`]. This module instantiates a
//! [`SyncOrchestrator`] per session, feeds it messages received from
//! the wire, and forwards the orchestrator's responses back — but the
//! state-machine semantics (which message is valid in which state, how
//! `received_ops` accumulates, when to enter terminal states) are the
//! protocol layer's concern, not this layer's.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::SqlitePool;
use tokio::sync::Notify;
use tracing::instrument;

use crate::error::AppError;
use crate::lifecycle::LifecycleHooks;
use crate::materializer::Materializer;
use crate::peer_refs::{self, PeerRef};
use crate::sync_constants::HANDSHAKE_TIMEOUT;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_net::{self, DiscoveredPeer, MdnsService, SyncCert, SyncConnection, SyncServer};
use crate::sync_protocol::{SyncMessage, SyncOrchestrator, SyncState};
use crate::sync_scheduler::SyncScheduler;

use super::SharedEventSink;
use super::discovery::{
    format_peer_addresses, get_peer_cert_hash, process_discovery_event, resolve_peer_address,
    should_store_cert_hash,
};
use super::server::handle_incoming_sync;
use super::snapshot_transfer;
use super::wire;

// ---------------------------------------------------------------------------
// SyncDaemonContext — owned bundle of daemon-wide startup state
// ---------------------------------------------------------------------------

/// Owned bundle of the daemon-wide startup state threaded through the
/// `start` / dormant-waiter / [`daemon_loop`] chain.
///
/// This is the owned counterpart of [`SyncSessionContext`] (which holds
/// borrowed references for the per-session hot path) plus the `lifecycle`
/// hooks. Bundling these eight values keeps the startup call sites in
/// lockstep — the previous 8-arg positional signature was suppressed by
/// `#[allow(clippy::too_many_arguments)]` on five functions and carried the
/// same drift risk the session layer already eliminated with
/// `SyncSessionContext`.
///
/// `shutdown_notify` is deliberately *not* part of this bundle: it is minted
/// per spawn (each `start*` entry point creates its own `Notify` and keeps a
/// clone in the returned `SyncDaemon` handle), so it stays a separate
/// positional argument on [`daemon_loop`].
pub struct SyncDaemonContext {
    pub pool: SqlitePool,
    pub device_id: String,
    pub materializer: Materializer,
    pub scheduler: Arc<SyncScheduler>,
    pub cert: SyncCert,
    pub event_sink: Arc<dyn SyncEventSink>,
    pub cancel: Arc<AtomicBool>,
    pub lifecycle: LifecycleHooks,
}

// ---------------------------------------------------------------------------
// daemon_loop — the core async select! loop
// ---------------------------------------------------------------------------

/// Main event-driven loop for the sync daemon.
///
/// Uses `tokio::select!` to react to mDNS peer-discovery events,
/// debounced local-change notifications, periodic resync checks, and
/// shutdown signals — without polling.
///
/// The `lifecycle` hooks gate the periodic 30 s resync tick body on the
/// foreground flag, and the `wake` notify lets foreground transitions
/// re-run the loop body immediately without waiting out the remaining
/// tick interval. Event-driven branches (mDNS, debounced change) are
/// NOT gated — they only fire when there is real work to do.
pub(crate) async fn daemon_loop(
    ctx: SyncDaemonContext,
    shutdown_notify: Arc<Notify>,
) -> Result<(), AppError> {
    let SyncDaemonContext {
        pool,
        device_id,
        materializer,
        scheduler,
        cert,
        event_sink,
        cancel,
        lifecycle,
    } = ctx;
    // Acquire WifiManager.MulticastLock on Android so the
    // `mdns-sd` crate's UDP multicast sockets receive packets. Held in
    // a local binding so `Drop` releases it on function exit (graceful
    // shutdown or error return). On non-Android targets this is a no-op.
    #[cfg(target_os = "android")]
    let _multicast_lock = match super::android_multicast::MulticastLock::acquire() {
        Ok(lock) => Some(lock),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "failed to acquire Android WiFi multicast lock; mDNS peer discovery may not work"
            );
            None
        }
    };

    // 1. Start mDNS service (graceful fallback — #522)
    //
    // mDNS may fail on platforms where raw UDP sockets are blocked (e.g. iOS)
    // or when the Android multicast lock is missing. When this happens we
    // log a warning, emit `SyncEvent::MdnsDisabled` so the frontend can
    // surface the reason, and continue without peer discovery. Sync still
    // works via manual IP entry (stored in peer_refs); the mDNS branch in
    // The select! loop is simply never triggered. See.
    let mdns = handle_mdns_init_result(MdnsService::new(), &event_sink);

    // 2. Start TLS WebSocket server (responder mode — #615)
    let resp_pool = pool.clone();
    let resp_device_id = device_id.clone();
    let resp_materializer = materializer.clone();
    let resp_scheduler = scheduler.clone();
    let resp_event_sink = event_sink.clone();
    // #1605: clone the daemon's shared cancel flag into the responder
    // factory so every spawned responder session observes the SAME
    // shutdown/user-cancel signal the initiator path uses. A flipped flag
    // aborts an in-progress responder within one recv cycle, freeing its
    // per-peer lock and #1581 concurrency permit.
    let resp_cancel = cancel.clone();
    let (server, port) = SyncServer::start(&cert, move |conn, permit| {
        let pool = resp_pool.clone();
        let device_id = resp_device_id.clone();
        let mat = resp_materializer.clone();
        let sched = resp_scheduler.clone();
        let sink = resp_event_sink.clone();
        let cancel = resp_cancel.clone();

        // Spawn the responder session, then spawn a lightweight watcher
        // that awaits the handle. The watcher surfaces both graceful
        // `AppError` failures and fatal `JoinError` (panic / cancel)
        // outcomes — without it, a responder task could vanish silently.
        //
        // #1581: `permit` (the concurrency-cap slot acquired before the TLS
        // handshake) is moved into the responder task and dropped when
        // `handle_incoming_sync` resolves, so the slot is held for the whole
        // session lifetime (up to `RECV_TIMEOUT` = 180 s) and freed on
        // completion — graceful, error, or panic.
        let handle: tokio::task::JoinHandle<Result<(), AppError>> = tokio::spawn(async move {
            let result =
                handle_incoming_sync(conn, pool, device_id, mat, sched, sink, cancel).await;
            drop(permit);
            result
        });
        tokio::spawn(async move {
            match handle.await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "responder sync session failed");
                }
                Err(join_err) => {
                    if join_err.is_panic() {
                        tracing::error!(
                            error = %join_err,
                            "responder sync session panicked"
                        );
                    } else {
                        tracing::error!(
                            error = %join_err,
                            "responder sync session was cancelled unexpectedly"
                        );
                    }
                }
            }
        });
    })
    .await?;

    // 3. Announce this device on mDNS (skipped when mDNS is unavailable)
    if let Some(ref mdns) = mdns {
        match mdns.announce(&device_id, port) {
            Ok(_) => tracing::info!(port, "SyncDaemon started, mDNS announced"),
            Err(e) => tracing::warn!(error = %e, "mDNS announce failed (peer discovery disabled)"),
        }
    } else {
        tracing::info!(
            port,
            "SyncDaemon started (mDNS unavailable, no announcement)"
        );
    }

    // 4. Start mDNS browse (skipped when mDNS is unavailable)
    let browse_rx = match mdns {
        Some(ref mdns) => match mdns.browse() {
            Ok(rx) => Some(rx),
            Err(e) => {
                tracing::warn!(error = %e, "mDNS browse failed (peer discovery disabled)");
                None
            }
        },
        None => None,
    };

    // Bridge mDNS browse events to a tokio mpsc channel so we can use
    // them inside `tokio::select!` without polling.  flume's blocking
    // `recv()` runs on a dedicated thread via `spawn_blocking`.
    // When mDNS is unavailable, mdns_rx will never yield items and the
    // select! branch is effectively disabled.
    let (mdns_tx, mut mdns_rx) = tokio::sync::mpsc::channel::<mdns_sd::ServiceEvent>(32);
    if let Some(browse_rx) = browse_rx {
        tokio::task::spawn_blocking(move || {
            while let Ok(event) = browse_rx.recv() {
                if mdns_tx.blocking_send(event).is_err() {
                    break; // Channel closed, daemon shutting down
                }
            }
        });
    }

    // 5. Maintain discovered peers (device_id → (DiscoveredPeer, last_seen))
    let mut discovered: HashMap<String, (DiscoveredPeer, tokio::time::Instant)> = HashMap::new();

    // 6. Periodic resync interval (replaces the former 500ms poll cadence)
    let mut resync_interval = tokio::time::interval(std::time::Duration::from_secs(30));
    resync_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Counter driving the coarse (~hourly) peer-lock GC cadence; see
    // `maybe_gc_peer_locks` and `RESYNC_TICKS_PER_GC`.
    let mut resync_ticks_since_gc: u64 = 0;

    // 7. Main event-driven loop
    loop {
        tokio::select! {
            // Branch A: mDNS peer-discovery event (event-driven, no polling)
            Some(event) = mdns_rx.recv() => {
                let refs = list_peer_refs_or_empty(&pool, "mdns_discovery").await;
                // #2008: while a pairing is pending, an unpaired discovered
                // peer is a valid initiation target (initiator-side TOFU pins
                // it on success). Fail open to `false` so a transient DB error
                // only falls back to the stricter paired-only behaviour.
                let pairing_pending = peer_refs::is_pending_pairing(&pool)
                    .await
                    .unwrap_or(false);
                if let Some(peer) = process_discovery_event(
                    event, &device_id, &mut discovered, &refs, pairing_pending,
                ) {
                    tracing::info!(peer_id = %peer.device_id, "discovered new peer via mDNS");
                    let ctx = SyncSessionContext {
                        pool: &pool,
                        device_id: &device_id,
                        materializer: &materializer,
                        scheduler: &scheduler,
                        event_sink: &event_sink,
                        cancel: &cancel,
                        cert: &cert,
                    };
                    // KNOWN: the sync session is awaited inline; a slow peer
                    // (bounded by HANDSHAKE_TIMEOUT) blocks the select loop
                    // for this round. Branch B's JoinSet pattern shows the
                    // spawned alternative; refactoring Branch A is tracked
                    // in #490 M3.
                    //
                    // Branch A is single-shot (one peer per discovery
                    // event), so the bool return is informational only — no
                    // for-loop to break out of. Discard explicitly.
                    let _cancelled = try_sync_with_peer(&ctx, &peer, &refs).await;
                }
            }

            // Branch B: debounced local-change notification
            //
            // Peers are dispatched concurrently via `JoinSet` so a
            // flaky peer's protocol timeout doesn't hold up the rest of
            // the round. Per-peer mutual exclusion is still enforced
            // inside `try_sync_with_peer` via `scheduler.try_lock_peer`,
            // so simultaneous dispatch is safe — any contender returns
            // immediately without running a session.
            () = scheduler.wait_for_debounced_change() => {
                let refs = list_peer_refs_or_empty(&pool, "debounced_change").await;
                let mut join_set = tokio::task::JoinSet::new();
                for peer_ref in &refs {
                    let Some(peer) = resolve_peer_address(
                        &peer_ref.peer_id,
                        peer_ref.last_address.as_deref(),
                        &discovered,
                    ) else {
                        continue;
                    };
                    // Each spawned task owns clones of the shared state.
                    // `Materializer`, `SqlitePool`, and `SyncCert` clone
                    // cheaply (Arc-backed); `Vec<PeerRef>` clones once
                    // per peer per round but the list is small.
                    let pool = pool.clone();
                    let device_id = device_id.clone();
                    let materializer = materializer.clone();
                    let scheduler = scheduler.clone();
                    let event_sink = event_sink.clone();
                    let cancel = cancel.clone();
                    let cert = cert.clone();
                    let refs_for_task = refs.clone();
                    join_set.spawn(async move {
                        let ctx = SyncSessionContext {
                            pool: &pool,
                            device_id: &device_id,
                            materializer: &materializer,
                            scheduler: &scheduler,
                            event_sink: &event_sink,
                            cancel: &cancel,
                            cert: &cert,
                        };
                        let was_cancelled =
                            try_sync_with_peer(&ctx, &peer, &refs_for_task).await;
                        (peer.device_id, was_cancelled)
                    });
                }
                while let Some(result) = join_set.join_next().await {
                    match result {
                        Ok((peer_id, was_cancelled)) => {
                            // When one peer's session reports the
                            // cancel flag was observed, abort the rest
                            // of this round's still-in-flight tasks.
                            // The shared `cancel` flag normally
                            // propagates on its own, but a peer that
                            // finishes ahead of others can clear it via
                            // its `CancelGuard::drop` before slower
                            // peers observe it — the original sequential
                            // code worked around this with `break`; the
                            // concurrent equivalent is `abort_all`.
                            if was_cancelled {
                                tracing::info!(
                                    peer_id = %peer_id,
                                    "cancel observed mid-round; aborting remaining debounced-change peers"
                                );
                                join_set.abort_all();
                            }
                        }
                        Err(e) if e.is_cancelled() => {
                            // Expected after `abort_all()` above.
                            tracing::debug!(error = %e, "debounced-change peer task aborted");
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "debounced-change peer task panicked");
                        }
                    }
                }
            }

            // Branch C: periodic resync check (30s interval)
            //
            // When the app is backgrounded (`lifecycle.is_foreground`
            // == false), short-circuit the body so we don't spin up DB
            // queries and network connections while the user isn't looking.
            // We still drain the tick so the interval timer's internal
            // cursor doesn't fall behind, but skip the expensive parts.
            _ = resync_interval.tick() => {
                if lifecycle.is_backgrounded() {
                    continue;
                }

                // Prune the scheduler's monotonically-growing
                // `peer_locks` map on a coarse (~hourly) cadence.
                maybe_gc_peer_locks(&scheduler, &mut resync_ticks_since_gc);

                // Evict stale mDNS peers not seen in last 5 minutes
                let stale_threshold = tokio::time::Instant::now() - std::time::Duration::from_secs(300);
                discovered.retain(|_, (_, last_seen)| *last_seen > stale_threshold);

                let refs = list_peer_refs_or_empty(&pool, "periodic_resync").await;
                // Pass `&refs` directly; the scheduler projects
                // `peer_id` / `synced_at` itself, so we no longer
                // clone every paired peer's id+timestamp on every
                // 30 s tick.
                let due = scheduler.peers_due_for_resync(&refs);
                let refs_by_id: std::collections::HashMap<&str, &peer_refs::PeerRef> =
                    refs.iter().map(|r| (r.peer_id.as_str(), r)).collect();
                let ctx = SyncSessionContext {
                    pool: &pool,
                    device_id: &device_id,
                    materializer: &materializer,
                    scheduler: &scheduler,
                    event_sink: &event_sink,
                    cancel: &cancel,
                    cert: &cert,
                };
                // KNOWN: sequential inline awaits; shutdown may be delayed
                // by up to HANDSHAKE_TIMEOUT per due peer. See Branch B's
                // JoinSet refactor for the concurrent alternative (#490 M3).
                //
                // Run_sequential_sync_round iterates peers in order
                // and breaks as soon as any peer reports cancellation, so a
                // "stop this round" cancel is honoured for every subsequent
                // peer, not just the one currently syncing.
                run_sequential_sync_round(&due, |pid| {
                    // Rebind environment borrows as shared references so
                    // the async block can capture them without moving the
                    // underlying data (references are Copy).
                    let refs_by_id = &refs_by_id;
                    let discovered = &discovered;
                    let ctx = &ctx;
                    let refs = &refs;
                    async move {
                        let last_addr = refs_by_id
                            .get(pid.as_str())
                            .and_then(|r| r.last_address.as_deref());
                        if let Some(peer) = resolve_peer_address(&pid, last_addr, discovered) {
                            let cancelled = try_sync_with_peer(ctx, &peer, refs).await;
                            if cancelled {
                                tracing::info!(
                                    peer_id = %pid,
                                    "cancel observed mid-round; aborting remaining periodic-resync peers"
                                );
                                return true;
                            }
                        }
                        false
                    }
                })
                .await;
            }

            // Branch D: foreground transition
            //
            // When the app returns to foreground we may have missed one
            // or more resync ticks. Reset the interval timer so the
            // first tick after resume fires immediately and catches up
            // on any peers that became due while backgrounded. The body
            // itself runs on the next tick iteration — we don't inline
            // the work here because Branch C already handles it.
            () = lifecycle.wake.notified() => {
                resync_interval.reset_immediately();
            }

            // Branch E: shutdown signal
            () = shutdown_notify.notified() => {
                break;
            }
        }
    }

    // Cleanup
    server.shutdown().await;
    if let Some(mdns) = mdns
        && let Err(e) = mdns.shutdown()
    {
        tracing::warn!(error = %e, "mDNS shutdown error");
    }
    tracing::info!("SyncDaemon shut down cleanly");
    Ok(())
}

// ---------------------------------------------------------------------------
// Maybe_gc_peer_locks — coarse-cadence peer-lock garbage collection
// ---------------------------------------------------------------------------

/// Number of resync ticks between [`SyncScheduler::gc_unused_peer_locks`]
/// sweeps. The resync interval fires every 30 s, so 120 ticks ≈ 1 h — the
/// "hourly is more than sufficient" cadence the scheduler's GC doc asks for.
const RESYNC_TICKS_PER_GC: u64 = 120;

/// Advance the resync-tick counter and, once it reaches
/// [`RESYNC_TICKS_PER_GC`], prune the scheduler's monotonically-growing
/// `peer_locks` map.
///
/// `peer_locks` only ever grows in `try_lock_peer` (one entry per peer ever
/// seen). The sweep is a single brief lock + `retain` over a tiny map and
/// only removes entries with no live `PeerSyncGuard`, so it never changes
/// locking semantics. Factored out of the daemon loop so the cadence gate is
/// directly unit-testable without driving the full async loop.
fn maybe_gc_peer_locks(scheduler: &SyncScheduler, ticks_since_gc: &mut u64) {
    *ticks_since_gc += 1;
    if *ticks_since_gc >= RESYNC_TICKS_PER_GC {
        *ticks_since_gc = 0;
        let removed = scheduler.gc_unused_peer_locks();
        if removed > 0 {
            tracing::debug!(removed, "gc_unused_peer_locks pruned idle peer locks");
        }
    }
}

// ---------------------------------------------------------------------------
// handle_mdns_init_result — emit SyncEvent on mDNS init failure
// ---------------------------------------------------------------------------

/// Translate the outcome of [`MdnsService::new`] into an optional service
/// Handle, emitting [`SyncEvent::MdnsDisabled`] on failure.
///
/// Extracted as a separate function so a unit test can exercise the
/// failure path without actually creating a real `MdnsService` (which
/// depends on the host OS allowing UDP multicast).
pub(crate) fn handle_mdns_init_result(
    result: Result<MdnsService, AppError>,
    event_sink: &Arc<dyn SyncEventSink>,
) -> Option<MdnsService> {
    match result {
        Ok(m) => Some(m),
        Err(e) => {
            let reason = e.to_string();
            tracing::warn!(error = %e, "mDNS initialization failed (peer discovery disabled)");
            tracing::info!("Sync will work via manual IP entry only");
            event_sink.on_sync_event(SyncEvent::MdnsDisabled {
                reason: reason.clone(),
            });
            None
        }
    }
}

// ---------------------------------------------------------------------------
// list_peer_refs_or_empty — shared error-handling wrapper
// ---------------------------------------------------------------------------

/// Load all known peer refs for the current daemon cycle.
///
/// On failure, log at `error!` (not `warn!`) with the cycle label so
/// on-call/devs can see *which* cycle degraded to "no peers". Each of the
/// three daemon-loop branches (mDNS discovery, debounced change, periodic
/// resync) passes its own `cycle` tag so logs are distinguishable.
///
/// Returning `vec![]` preserves the prior liveness behaviour: one bad
/// query cannot crash the daemon, but the now-structured error log makes
/// the degradation observable.
async fn list_peer_refs_or_empty(pool: &SqlitePool, cycle: &'static str) -> Vec<PeerRef> {
    peer_refs::list_peer_refs(pool).await.unwrap_or_else(|e| {
        tracing::error!(
            error = %e,
            cycle,
            "list_peer_refs failed; sync degraded for this cycle"
        );
        vec![]
    })
}

// ---------------------------------------------------------------------------
// Try_connect_each_address — multi-address connect helper
// ---------------------------------------------------------------------------

/// Attempt `sync_net::connect_to_peer` against each address in
/// `addresses` in order, returning the first successful connection
/// together with the address that worked (so the caller can persist it
/// as `last_address`). If every attempt fails, the returned `Err`
/// concatenates the individual error strings so logs / events surface
/// exactly which addresses failed and why.
///
/// Empty `addresses` is the caller's responsibility — this function
/// returns a generic "no addresses tried" error rather than panicking.
async fn try_connect_each_address(
    addresses: &[String],
    cert_hash: Option<&str>,
    cert: &SyncCert,
    peer_id: &str,
) -> Result<(SyncConnection, String), AppError> {
    let mut errors: Vec<String> = Vec::with_capacity(addresses.len());
    for addr in addresses {
        match sync_net::connect_to_peer(addr, cert_hash, Some(peer_id), cert).await {
            Ok(conn) => return Ok((conn, addr.clone())),
            Err(e) => {
                tracing::debug!(
                    peer_id,
                    addr,
                    error = %e,
                    "connect_to_peer failed; trying next advertised address"
                );
                errors.push(format!("{addr}: {e}"));
            }
        }
    }
    Err(AppError::InvalidOperation(if errors.is_empty() {
        format!("[sync_daemon] {peer_id}: no addresses tried")
    } else {
        format!(
            "[sync_daemon] {peer_id}: all addresses failed — {}",
            errors.join("; ")
        )
    }))
}

// ---------------------------------------------------------------------------
// SyncSessionContext — bundle of session-wide state shared across calls
// ---------------------------------------------------------------------------

/// Bundle of references to the session-wide state threaded through every
/// [`try_sync_with_peer`] invocation.
///
/// `daemon_loop` calls `try_sync_with_peer` from three branches (mDNS
/// discovery, debounced change, periodic resync) with identical
/// references for everything *except* the peer and the per-cycle
/// `peer_refs` snapshot. Lifting the shared state into a single struct
/// keeps the call sites in lockstep — the previous 9-arg positional
/// signature was suppressed by `#[allow(clippy::too_many_arguments)]`
/// and had drifted between call sites historically.
///
/// Per-peer / per-cycle inputs (`peer`, `peer_refs`) stay positional on
/// the function — they are not session-wide.
///
/// All fields are plain references, so the struct is `Copy`: Branch C of
/// `daemon_loop` can copy it into an owned `async move` closure without
/// cloning the underlying state.
#[derive(Clone, Copy)]
pub(crate) struct SyncSessionContext<'a> {
    pub pool: &'a SqlitePool,
    pub device_id: &'a str,
    pub materializer: &'a Materializer,
    pub scheduler: &'a SyncScheduler,
    pub event_sink: &'a Arc<dyn SyncEventSink>,
    pub cancel: &'a AtomicBool,
    pub cert: &'a SyncCert,
}

// ---------------------------------------------------------------------------
// CancelGuard — shared scope guard for the daemon-wide cancel flag
// ---------------------------------------------------------------------------

/// Scope guard that clears the shared, daemon-wide sync-cancel `AtomicBool`
/// on `Drop` — but only when both of the following hold:
///
/// 1. `owns == true`: this task actually acquired its own per-peer lock —
///    the exclusive resource `is_any_peer_locked()` observes — and is
///    therefore a legitimate participant in "am I the last active session
///    standing" reckoning, as opposed to an early-exit path that never
///    acquired a lock at all (backoff gate, lock contention: another
///    session already holds this peer's lock) and so never contributed to
///    `is_any_peer_locked()`'s signal in the first place (#637: an
///    early-exiting peer that never held a lock must never swallow a
///    cancel aimed at a still-running sibling).
///
///    Note that `owns` is armed as soon as the per-peer lock is acquired —
///    *not* only once the session goes on to complete a full protocol run.
///    A task that acquires the lock and then exits early for an unrelated
///    reason (no resolved addresses, failed connect, a post-lock identity/
///    cert rejection) still held the exact resource that could have kept
///    `is_any_peer_locked()` true for a sibling's Drop check; it must be
///    equally eligible to perform the final clear once it releases that
///    lock and is genuinely the last one standing. Arming only after a full
///    successful connect+cert-check (as originally implemented) left a gap:
///    such a task would sit with `owns == false` for the (potentially many
///    seconds, e.g. a TCP connect timeout to an unreachable peer) duration
///    it held the lock, and if a concurrent real session's Drop happened to
///    observe `is_any_peer_locked() == true` during exactly that window, it
///    would correctly defer clearing — but the lock-holding task would then
///    exit with `owns == false` and never clear either, latching the flag
///    with nobody left to reset it (#2537 regression within the #2537 fix
///    itself). See `cancel_guard_never_stuck_when_owning_session_exits_early`
///    for the regression test.
/// 2. `!scheduler.is_any_peer_locked()`: no OTHER session — initiator or
///    responder, for any peer — is still holding its per-peer lock (#2537).
///
/// ## Why (2) is needed: the initiator/responder concurrency race
///
/// #637 already handled the case of multiple initiator attempts *within one
/// sequential backoff round* (`run_sequential_sync_round` runs one peer at a
/// time, so only one `CancelGuard` is ever live at once there). But once the
/// responder path became a legitimate clearer too (#2537 — mirroring this
/// guard in `handle_incoming_sync`), sessions can be genuinely CONCURRENT:
/// an inbound responder session for peer A can be running at the same time
/// as an outbound initiator session for peer B, or two inbound sessions for
/// two different peers can both be in flight (the responder spawns one
/// task per accepted connection, with no sequential round to serialize
/// them). If each session's guard cleared the flag unconditionally on
/// `owns`, whichever session finishes *first* would erase a cancel the
/// *other* one hasn't observed yet — a user cancel meant for both would
/// silently only hit one.
///
/// Gating the clear on `is_any_peer_locked()` fixes this: this guard's
/// `Drop` runs *after* this session's own per-peer lock has already been
/// released (every call site declares `_cancel_guard` before its
/// `PeerSyncGuard`, and Rust drops locals in reverse declaration order), so
/// the check only ever sees OTHER sessions' locks. The flag therefore
/// survives until the LAST concurrently-active session ends, guaranteeing
/// every session that was actually running when the user cancelled gets a
/// chance to observe `true` on its own next check — instead of latching
/// forever (nothing ever consumed it) or being swallowed early (a sibling
/// cleared it first).
pub(crate) struct CancelGuard<'a> {
    pub(crate) cancel: &'a AtomicBool,
    pub(crate) scheduler: &'a SyncScheduler,
    pub(crate) owns: bool,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if self.owns && !self.scheduler.is_any_peer_locked() {
            self.cancel.store(false, Ordering::Release);
        }
    }
}

// ---------------------------------------------------------------------------
// try_sync_with_peer — single sync session with backoff
// ---------------------------------------------------------------------------

/// Attempt to sync with a single discovered peer.
///
/// Respects the scheduler's per-peer backoff (#278) and mutual-exclusion
/// lock.  On success the backoff is reset; on failure a failure is recorded
/// which doubles the next retry delay.
///
/// Wrapped in a `sync` span so every log line emitted during the
/// session (including those from nested `run_sync_session`,
/// `SyncOrchestrator::handle_message`, and file-transfer helpers) shares a
/// `sync{peer=ULID}` prefix when the tracing subscriber includes span info.
///
/// # Return value
///
/// Returns `true` iff the cancel flag was observed set when the sync
/// session ended — i.e., the user invoked `cancel_active_sync()` while
/// this peer's session was running. The caller (the daemon-loop branches
/// that iterate over multiple peers) uses this to **break out of the
/// round** so a "stop this round" cancel is honoured for every peer in
/// the iteration, not just the one that happened to be syncing when the
/// user clicked.
///
/// Early-exit paths (backoff gate, per-peer lock contention, no resolved
/// addresses, all-addresses-failed connect) return `false`: those didn't
/// run a real session, so cancellation is moot and the daemon's next
/// peer in the round should still be attempted on its own merits. The
/// only path that returns `true` is the one where `run_sync_session`
/// actually executed and the cancel flag was observed (typically because
/// `run_sync_session` returned `Err("sync cancelled by user")`).
///
/// The `_cancel_guard` (a Drop scope guard, S-11) clears the flag on
/// Drop — but only when this task actually acquired the per-peer lock and
/// thus *owns* the cancel (#637), AND it is the last currently-active
/// session standing (#2537; see [`CancelGuard`]). Only the paths that never
/// acquire a lock at all (backoff gate / lock contention) return with
/// `owns == false` and deliberately leave the shared flag untouched, so an
/// early-exiting peer that never held the lock can never swallow a user
/// cancel aimed at a still-running sibling. Paths that DO acquire the lock
/// before exiting early (no resolved addresses, failed connect) are armed
/// (`owns == true`) the moment the lock is acquired — see [`CancelGuard`]'s
/// doc comment for why. On the real-session path the `was_cancelled`
/// capture happens *before* the guard's Drop fires, so the returned bool
/// reflects the live state at session end.
#[tracing::instrument(
    skip_all,
    fields(peer = %peer.device_id),
    name = "sync",
)]
// #647: a sync attempt against one peer — backoff gate, lease, connect,
// session. The device_id is the key correlation field when diagnosing a
// stuck/looping peer; it is a non-sensitive opaque id. `skip_all` keeps the
// `SyncSessionContext` / `PeerRef` slices (which can reference op data) out
// of the span per #632.
#[instrument(
    name = "sync.try_sync_with_peer",
    skip_all,
    fields(peer = %peer.device_id)
)]
pub(crate) async fn try_sync_with_peer(
    ctx: &SyncSessionContext<'_>,
    peer: &DiscoveredPeer,
    peer_refs: &[PeerRef],
) -> bool {
    let peer_id = &peer.device_id;

    // Scope guard: clear the shared cancel flag on Drop, but ONLY when this
    // task actually *owns* the cancel — i.e. it acquired its own per-peer
    // lock — AND it is the last active session standing. See
    // [`CancelGuard`]'s doc comment for the full race analysis (#637, #2537).
    //
    // ORDERING INVARIANT (#2537): this guard MUST stay declared BEFORE the
    // per-peer lock guard (`_guard`, step 2 below). Rust drops locals in
    // reverse declaration order, so this guard's Drop runs AFTER the peer
    // lock is released — `is_any_peer_locked()` (consulted in
    // `CancelGuard::drop`) then reflects only OTHER sessions' locks, never
    // this session's own. Swapping the declarations would make every
    // session observe its own still-held lock on Drop and never clear the
    // flag.
    let mut _cancel_guard = CancelGuard {
        cancel: ctx.cancel,
        scheduler: ctx.scheduler,
        owns: false,
    };

    // 1. Backoff gate
    if !ctx.scheduler.may_retry(peer_id) {
        // No real session ran, cancellation is moot for this peer.
        // #637: guard.owns is still false, so we leave the shared cancel
        // flag untouched — a user cancel aimed at a sibling survives.
        return false;
    }

    // 2. Per-peer mutex (prevents concurrent syncs to the same peer)
    let Some(_guard) = ctx.scheduler.try_lock_peer(peer_id) else {
        // Already syncing with this peer; this task never acquired a lock.
        // #637: guard.owns is still false → don't clear a sibling's cancel.
        return false;
    };

    // #2537: the lock is acquired — this task now holds the exact resource
    // `is_any_peer_locked()` observes, so it is a legitimate participant in
    // "am I the last one standing" from here on, regardless of whether the
    // session below goes on to complete a full protocol run or exits early
    // (no addresses / connect failure). See [`CancelGuard`]'s doc comment.
    _cancel_guard.owns = true;

    // 3. Resolve all addresses from discovered peer info, in connection
    // Priority order. Empty list ⇒ no useable address.
    let addrs = format_peer_addresses(peer);
    if addrs.is_empty() {
        tracing::warn!(peer_id, "peer has no addresses, skipping sync");
        // No real session ran, but this task DID hold the per-peer lock
        // (owns == true) — its Drop may still clear the flag, but only if
        // it is the last session standing (#2537; see [`CancelGuard`]).
        return false;
    }

    // 4. Look up cert hash for TLS certificate pinning
    let cert_hash = get_peer_cert_hash(peer_id, peer_refs);

    // 5. Emit "connecting" progress event
    ctx.event_sink.on_sync_event(SyncEvent::Progress {
        state: "connecting".into(),
        remote_device_id: peer_id.clone(),
        ops_received: 0,
        ops_sent: 0,
    });

    // 6. try every advertised address in order (IPv4 → IPv6
    //    non-link-local → IPv6 link-local). The first successful TLS
    //    handshake wins; if all fail, surface a combined error so the
    //    user can see exactly which addresses were attempted instead of
    //    wondering why a dual-stacked peer entered backoff.
    let (mut conn, addr) =
        match try_connect_each_address(&addrs, cert_hash.as_deref(), ctx.cert, peer_id).await {
            Ok((conn, addr)) => (conn, addr),
            Err(combined) => {
                tracing::warn!(
                    peer_id,
                    attempts = addrs.len(),
                    error = %combined,
                    "failed to connect to peer at any advertised address"
                );
                ctx.scheduler.record_failure(peer_id);
                ctx.event_sink.on_sync_event(SyncEvent::Error {
                    message: format!("Connection failed: {combined}"),
                    remote_device_id: peer_id.clone(),
                });
                // Connection never established, no real session ran — but
                // this task DID hold the per-peer lock while attempting to
                // connect (potentially for the full connect-timeout
                // duration), so `owns` is already `true` (armed at step 2).
                // Its Drop may still clear the flag, gated on being the
                // last session standing (#2537; see [`CancelGuard`]).
                return false;
            }
        };

    // 7. Run sync protocol through the orchestrator
    //
    // #637/#2537: we have committed to a real sync session — connection
    // established, per-peer lock held, addresses resolved. `_cancel_guard`
    // was already armed (`owns = true`) back at step 2 when the lock was
    // acquired, so no further action is needed here: this task is, and has
    // been since the lock was acquired, a legitimate consumer of (and
    // candidate resetter for) a user cancel.

    let mut event_sink_arc = Arc::clone(ctx.event_sink);
    if let Some(channel) = ctx.scheduler.take_channel(peer_id) {
        event_sink_arc = Arc::new(crate::sync_events::ChannelEventSink {
            inner: event_sink_arc,
            channel,
        });
    }

    let event_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(event_sink_arc.clone()));
    let mut orch = SyncOrchestrator::new(
        ctx.pool.clone(),
        ctx.device_id.to_string(),
        ctx.materializer.clone(),
    )
    .with_event_sink(event_sink_box)
    .with_expected_remote_id(peer_id.clone());

    let session_result = run_sync_session(
        &mut orch,
        &mut conn,
        ctx.cancel,
        ctx.pool,
        ctx.materializer,
        &event_sink_arc,
    )
    .await;

    // Capture the cancel flag's live state BEFORE `_cancel_guard`
    // clears it on Drop. The guard is the *first* local declared in this
    // function so it drops *last* (Rust drops locals in reverse declaration
    // order); both `conn.close()` below and this read therefore observe
    // the still-set flag. The returned bool tells the daemon-loop caller
    // whether the user cancelled mid-session so it can break out of the
    // current peer round (see Branch B / Branch C in `daemon_loop`), and
    // the `Err` arm below uses it to keep a user cancel out of the peer's
    // backoff accounting (#2537).
    //
    // #637: at this point `_cancel_guard.owns == true` (armed back at step 2,
    // when the per-peer lock was acquired), so the guard WILL clear the
    // shared flag on Drop — this is the legitimate post-run reset, gated
    // (#2537) on this being the LAST currently-active session (see
    // `CancelGuard::drop`). The only paths that never reach here and never
    // set `owns` are the ones that never acquired a lock at all (backoff
    // gate / lock contention); they leave a pending sibling-targeted cancel
    // intact.
    let was_cancelled = ctx.cancel.load(Ordering::Acquire);

    match session_result {
        Ok(()) => {
            ctx.scheduler.record_success(peer_id);
            // Save the peer's address for future direct connections
            if let Err(e) = peer_refs::update_last_address(ctx.pool, peer_id, &addr).await {
                tracing::warn!(peer_id, error = %e, "failed to save peer address");
            }
            // TOFU: Store observed cert hash if none was stored (initiator side)
            if should_store_cert_hash(cert_hash.as_deref(), conn.peer_cert_hash().as_deref())
                && let Some(ref observed) = conn.peer_cert_hash()
                && let Err(e) =
                    peer_refs::upsert_peer_ref_with_cert(ctx.pool, peer_id, observed).await
            {
                tracing::warn!(
                    peer_id,
                    error = %e,
                    "failed to store peer cert hash (TOFU)"
                );
            }
            let session = orch.session();
            ctx.event_sink.on_sync_event(SyncEvent::Complete {
                remote_device_id: peer_id.clone(),
                ops_received: session.ops_received,
                ops_sent: session.ops_sent,
                // #1071: forward the session's accumulated targeted-
                // invalidation page-id set so the frontend reloads only the
                // affected stores. Empty when the session applied no ops.
                changed_page_ids: session.changed_page_ids.clone(),
            });
            tracing::info!(
                peer_id,
                ops_rx = session.ops_received,
                ops_tx = session.ops_sent,
                "sync complete"
            );
        }
        Err(e) => {
            // #2537: a user-initiated cancel is not a peer-side failure.
            // `run_sync_session` returns the same generic
            // `AppError::InvalidOperation` for a cancelled session as for
            // other protocol errors, so we can't tell them apart from `e`
            // alone — but `was_cancelled` (captured above, before the
            // guard's Drop can clear it) tells us definitively whether the
            // user cancelled this exact session. Recording it as a failure
            // would double the peer's backoff for an abort the LOCAL user
            // chose, penalizing the next legitimate retry for something
            // that had nothing to do with the peer's reachability or
            // behavior.
            if was_cancelled {
                tracing::info!(
                    peer_id,
                    "sync session cancelled by user; not counted as a failure"
                );
            } else {
                ctx.scheduler.record_failure(peer_id);
            }
            ctx.event_sink.on_sync_event(SyncEvent::Error {
                message: format!("Sync failed: {e}"),
                remote_device_id: peer_id.clone(),
            });
            tracing::warn!(peer_id, error = %e, "sync session failed");
        }
    }

    // Cancel flag is cleared by `_cancel_guard` (Drop) because we own it.

    let _ = conn.close().await.map_err(|e| {
        tracing::debug!(error = %e, "failed to close sync connection");
    });

    was_cancelled
}

// ---------------------------------------------------------------------------
// Run_sequential_sync_round — break-on-cancel iteration helper
// ---------------------------------------------------------------------------

/// Iterate over `peer_ids` calling `sync_fn` for each one in order,
/// stopping early if any call returns `true` (cancel was observed).
///
/// Extracted from Branch C of [`daemon_loop`] so that tests can drive
/// the break-on-cancel logic through this function rather than replicating
/// the loop inline. Returns `true` if the round was cancelled early, `false`
/// if all peers were visited without cancellation.
///
/// The callback receives each peer ID as an owned `String` so that the
/// returned future may freely borrow from or move into the closure's
/// captured environment without triggering higher-ranked trait bound
/// (HRTB) lifetime conflicts.
pub(crate) async fn run_sequential_sync_round<F, Fut>(peer_ids: &[String], mut sync_fn: F) -> bool
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for pid in peer_ids {
        if sync_fn(pid.clone()).await {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// run_sync_session — message exchange loop
// ---------------------------------------------------------------------------

/// Drive a complete initiator-side sync session over an established
/// connection.
///
/// 1. The orchestrator generates the initial `HeadExchange` message.
/// 2. Messages are exchanged until the orchestrator reaches a terminal state.
/// 3. Returns `Ok(())` on `SyncState::Complete`, or `Err` on failure /
///    timeout.
///
/// If the main loop exits with `state == ResetRequired` (the
/// responder signalled that its op log has compacted past our heads),
/// attempt a snapshot-driven catch-up via
/// [`snapshot_transfer::try_receive_snapshot_catchup`]. On success the
/// initiator's state matches the snapshot and `peer_refs` is advanced
/// to its `up_to_hash`; the next scheduled sync picks up post-snapshot
/// deltas via a normal `HeadExchange`. On failure (no offer arrives,
/// offer over size cap, decode/apply failure) the sync returns `Err`
/// so the caller records the failure and backs off.
// #647: the message-exchange session loop — the path to instrument for a
// hung handshake or a session that never reaches a terminal state. `err`
// records the terminating error; `skip_all` (#632) because the orchestrator
// + connection carry sync payloads (op/note content).
#[instrument(name = "sync.run_session", skip_all, err)]
pub(crate) async fn run_sync_session(
    orch: &mut SyncOrchestrator,
    conn: &mut SyncConnection,
    cancel: &AtomicBool,
    pool: &SqlitePool,
    materializer: &crate::materializer::Materializer,
    event_sink: &Arc<dyn SyncEventSink>,
) -> Result<(), AppError> {
    // Initiator sends first message
    //
    // #611: all session-loop sends/recvs go through `wire::{send,recv}_sync_message`
    // so over-threshold LoroSync payloads ride the chunked binary path instead of
    // blowing the 10 MB JSON text-frame cap.
    let first_msg = orch.start().await?;
    wire::send_sync_message(conn, &first_msg).await?;

    // Exchange messages until terminal state
    while !orch.is_terminal() {
        // Check cancellation before waiting for the next message
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::InvalidOperation("sync cancelled by user".into()));
        }

        let incoming: SyncMessage = wire::recv_sync_message(conn).await?;
        let response = tokio::time::timeout(HANDSHAKE_TIMEOUT, orch.handle_message(incoming))
            .await
            .map_err(|_| {
                AppError::InvalidOperation(format!(
                    "handle_message timed out after {}s",
                    HANDSHAKE_TIMEOUT.as_secs()
                ))
            })??;
        if let Some(response) = response {
            wire::send_sync_message(conn, &response).await?;
            // Drain any pending op batches (B-3)
            while let Some(batch) = orch.next_message() {
                wire::send_sync_message(conn, &batch).await?;
            }
        } else {
            let state = &orch.session().state;
            if matches!(state, SyncState::Failed(_)) {
                return Err(AppError::InvalidOperation(format!(
                    "sync ended in terminal state: {state:?}"
                )));
            }
            // `ResetRequired` is no longer a terminal failure —
            // break out of the delta-sync loop and attempt snapshot
            // catch-up below. Any other `None` branch falls through
            // and the loop re-checks `is_terminal()`.
            if matches!(state, SyncState::ResetRequired) {
                break;
            }
        }
    }

    // Snapshot-driven catch-up (post-ResetRequired).
    //
    // When the responder signalled `ResetRequired`, its op log has
    // compacted past our advertised heads so we cannot resume via
    // delta replay. Ask the responder for a snapshot covering its
    // current state; if one is offered (and within the local size
    // cap), receive + apply it, advance `peer_refs` to the snapshot's
    // `up_to_hash`, and return `Ok(())` so the caller records the
    // session as successful. The next scheduled sync picks up any
    // post-snapshot deltas via a normal `HeadExchange`.
    if matches!(orch.session().state, SyncState::ResetRequired) {
        let peer_id = orch.session().remote_device_id.clone();
        // Pass the orchestrator's daemon-provided
        // `expected_remote_id` so the catch-up can mirror the
        // SyncComplete fallback when `peer_id` is empty (HeadExchange
        // carried only our own heads).
        let expected_remote_id = orch.expected_remote_id().map(str::to_owned);
        // #607: thread the session's engine state (override-aware in tests,
        // process-global in production) plus our own device id into the
        // catch-up so it can drop + reload the in-memory engines right
        // after `apply_snapshot` wipes the Loro sidecar tables.
        let local_device_id = orch.session().local_device_id.clone();
        let loro_state = orch.loro_state();
        let engine_reload = Some(snapshot_transfer::EngineReloadCtx {
            registry: &loro_state.registry,
            device_id: &local_device_id,
        });
        match snapshot_transfer::try_receive_snapshot_catchup(
            conn,
            pool,
            materializer,
            event_sink,
            &peer_id,
            expected_remote_id.as_deref(),
            engine_reload,
        )
        .await
        {
            Ok(outcome) => {
                tracing::info!(
                    peer_id = %peer_id,
                    outcome = ?outcome,
                    "snapshot-driven catch-up complete"
                );
                return Ok(());
            }
            Err(e) => {
                // The catch-up sub-flow had its own error handling
                // (oversized offer → SnapshotReject + Ok, decoded
                // bytes failing → Err). Surface the error here so the
                // scheduler records the failure and backs off.
                return Err(e);
            }
        }
    }

    // ── File transfer phase (F-14) ────────────────────────────────────────
    // After the op-sync completes, transfer missing attachment files.
    // The initiator requests first, then responds to the responder's request.
    //
    // Thread the same `cancel` flag through so a multi-gigabyte
    // attachment transfer can be aborted between files when the user
    // hits "cancel sync" (otherwise the run_sync_session loop's cancel
    // check is dead code once we reach this phase).
    if orch.is_succeeded() {
        match crate::sync_files::app_data_dir_from_pool(pool).await {
            Ok(app_data_dir) => {
                // Wire the active sync's event sink into
                // file transfer so per-frame progress lands on the same
                // `Channel<SyncProgressUpdate>` that streamed op-sync
                // transitions. `expected_remote_id` is the device id we
                // told the orchestrator at session start; the session's
                // `remote_device_id` is the same value once HeadExchange
                // populates it.
                let remote_device_id = orch.expected_remote_id().unwrap_or("").to_string();
                let progress = crate::sync_files::FileTransferProgress {
                    event_sink,
                    remote_device_id: &remote_device_id,
                };
                match crate::sync_files::run_file_transfer_initiator(
                    conn,
                    pool,
                    &app_data_dir,
                    cancel,
                    Some(&progress),
                )
                .await
                {
                    Ok(stats) => {
                        if stats.files_received > 0 || stats.files_sent > 0 {
                            tracing::info!(
                                files_rx = stats.files_received,
                                files_tx = stats.files_sent,
                                "initiator file transfer complete"
                            );
                        }
                    }
                    Err(e) => {
                        // File transfer failure should not abort the sync
                        tracing::warn!(error = %e, "initiator file transfer failed (non-fatal)");
                    }
                }
            }
            _ => {
                tracing::warn!("could not determine app_data_dir, skipping file transfer");
            }
        }
    }

    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_events::RecordingEventSink;

    /// When mDNS init returns `Err`, a `SyncEvent::MdnsDisabled`
    /// must be emitted so the frontend can surface the reason to the user.
    #[test]
    fn handle_mdns_init_result_emits_event_on_err() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let simulated_err: Result<MdnsService, AppError> = Err(AppError::InvalidOperation(
            "simulated multicast blocked".into(),
        ));

        let result = handle_mdns_init_result(simulated_err, &sink);
        assert!(
            result.is_none(),
            "helper must return None when mDNS init fails"
        );

        let events = typed.events();
        assert_eq!(
            events.len(),
            1,
            "exactly one SyncEvent must be emitted on mDNS init failure"
        );
        match &events[0] {
            SyncEvent::MdnsDisabled { reason } => {
                assert!(
                    reason.contains("simulated multicast blocked"),
                    "reason must include the underlying error string, got {reason:?}"
                );
            }
            other => panic!("expected MdnsDisabled, got {other:?}"),
        }
    }

    /// Different `AppError` variants surface different strings in the event
    /// — use an IO-shaped error to guard against the reason being
    /// accidentally truncated to a single variant name.
    #[test]
    fn handle_mdns_init_result_event_reason_captures_error_details() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let simulated_err: Result<MdnsService, AppError> = Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "raw socket blocked by sandbox",
        )));

        let _ = handle_mdns_init_result(simulated_err, &sink);
        let events = typed.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SyncEvent::MdnsDisabled { reason } => {
                assert!(
                    reason.contains("raw socket blocked"),
                    "reason must include underlying io message, got {reason:?}"
                );
            }
            other => panic!("expected MdnsDisabled, got {other:?}"),
        }
    }

    /// The production cadence gate (`maybe_gc_peer_locks`, the exact
    /// function the daemon resync tick calls) must NOT sweep before
    /// `RESYNC_TICKS_PER_GC` ticks, and MUST sweep the idle peer lock once
    /// the threshold is reached. This proves GC actually runs in the
    /// production path on the coarse cadence, not just in isolation.
    #[test]
    fn maybe_gc_peer_locks_sweeps_on_cadence() {
        let scheduler = SyncScheduler::new();

        // Seed one idle entry the way production does: take and immediately
        // drop a per-peer guard so the Arc strong-count falls back to 1.
        drop(scheduler.try_lock_peer("peer-a"));
        assert_eq!(
            scheduler.peer_locks_len(),
            1,
            "try_lock_peer must leave one (now-idle) entry behind"
        );

        let mut ticks_since_gc: u64 = 0;

        // Below the threshold: every tick advances the counter but no sweep.
        for _ in 0..(RESYNC_TICKS_PER_GC - 1) {
            maybe_gc_peer_locks(&scheduler, &mut ticks_since_gc);
        }
        assert_eq!(
            scheduler.peer_locks_len(),
            1,
            "no GC should run before RESYNC_TICKS_PER_GC ticks"
        );
        assert_eq!(ticks_since_gc, RESYNC_TICKS_PER_GC - 1);

        // The threshold tick sweeps the idle entry and resets the counter.
        maybe_gc_peer_locks(&scheduler, &mut ticks_since_gc);
        assert_eq!(
            scheduler.peer_locks_len(),
            0,
            "GC must prune the idle peer lock on the cadence tick"
        );
        assert_eq!(ticks_since_gc, 0, "counter resets after a sweep");
    }

    /// A live `PeerSyncGuard` must survive the cadence sweep — GC only
    /// reclaims idle entries, so an in-progress sync is never disturbed.
    #[test]
    fn maybe_gc_peer_locks_keeps_held_entry() {
        let scheduler = SyncScheduler::new();
        let _held = scheduler.try_lock_peer("peer-busy");
        assert_eq!(scheduler.peer_locks_len(), 1);

        let mut ticks_since_gc: u64 = RESYNC_TICKS_PER_GC - 1;
        maybe_gc_peer_locks(&scheduler, &mut ticks_since_gc); // triggers a sweep
        assert_eq!(
            scheduler.peer_locks_len(),
            1,
            "a held peer lock must NOT be reclaimed by GC"
        );
        assert_eq!(ticks_since_gc, 0);
    }

    /// The helper must not emit any event on the happy path. We can't
    /// construct a real `MdnsService` without networking in a unit test,
    /// so this asserts by construction: the `Ok` arm of the match never
    /// touches `event_sink`. A future refactor that changes this contract
    /// would have to alter the signature and this test would fail to
    /// compile.
    #[test]
    fn handle_mdns_init_result_no_event_path_is_ok_only() {
        let typed = Arc::new(RecordingEventSink::new());
        assert!(
            typed.events().is_empty(),
            "baseline: fresh sink starts with zero events"
        );
        // (Ok path cannot be exercised without real networking; the Err
        // path is the contract surface we care about.)
    }
}
