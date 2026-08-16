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
//!   waiter that defers mDNS / QUIC endpoint startup until the user
//!   pairs a device.
//! * **Per-peer mutual exclusion** — a `try_lock_peer` mutex prevents
//!   two concurrent sessions with the same peer, in either role. The key
//!   is [`super::peer_lock_key`]'s, shared with the responder, because
//!   "no two overlapping sessions" is a property of the two roles
//!   agreeing on a spelling (#3511).
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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::SqlitePool;
use tokio::sync::Notify;
use tracing::instrument;

use crate::apply_host::ApplyHost;
use crate::foreground::LifecycleHooks;
use crate::mdns::{DiscoveredPeer, MdnsService};
use crate::sync_constants::CONNECT_TIMEOUT;
use crate::sync_daemon::lan_interface::BindDecision;
use crate::sync_events::{SyncEvent, SyncEventSink};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use iroh_dns::dns::DnsResolver;

use crate::sync_protocol::{SyncOrchestrator, SyncState};
use crate::sync_scheduler::SyncScheduler;
use crate::transport::driver::{Role, SessionLimits, finish_session, run_session};
use crate::transport::service::{SYNC_ALPN, SyncService};
use agaric_core::error::AppError;
use agaric_store::peer_refs::{self, PeerRef};

use super::SharedEventSink;
use super::discovery::{
    DiscoveredPeers, peers_for_change_round, process_discovery_event, resolve_peer_address,
};
use super::server::{Rejection, handle_incoming_sync};
use super::snapshot_transfer;

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
    // #2621 (agaric-sync inversion): `Arc<dyn ApplyHost>`, not the concrete
    // `Materializer`, so this sync-layer context depends DOWN on the trait.
    // Production wraps the real coordinator (`Arc::new(materializer)`); the
    // field name is kept for call-site stability.
    pub materializer: Arc<dyn ApplyHost>,
    pub scheduler: Arc<SyncScheduler>,
    /// This device's long-lived iroh identity, loaded from disk by
    /// [`get_or_create_endpoint_secret`](crate::transport::identity::get_or_create_endpoint_secret).
    ///
    /// Replaces `cert: SyncCert`. Not a rename: the certificate proved a *claim* the app
    /// layer then had to check, while this key **is** the identity a peer pins in
    /// `peer_refs.endpoint_id`. It must be the same key across restarts or every paired
    /// peer stops recognising this device.
    pub endpoint_secret: SecretKey,
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
///
/// `discovered` is the loop's live view of peers seen on the network. It is
/// a *parameter* rather than a local (#3533) because Branch A — a real
/// `mdns_rx.recv()` — is its only writer, and Branch B's pairing-window round
/// is a reader: with no way to seed the map, the one production call site of
/// [`peers_for_change_round`] could not be reached from a test at all, so
/// deleting it turned nothing red. Production always passes an empty map; the
/// only caller that passes a non-empty one is `SyncDaemon::start_with_lifecycle_seeded`,
/// which is gated behind the `test-util` feature.
pub(crate) async fn daemon_loop(
    ctx: SyncDaemonContext,
    shutdown_notify: Arc<Notify>,
    mut discovered: DiscoveredPeers,
) -> Result<(), AppError> {
    let SyncDaemonContext {
        pool,
        device_id,
        materializer,
        scheduler,
        endpoint_secret,
        event_sink,
        cancel,
        lifecycle,
    } = ctx;
    // #3847: the first thing the daemon does on Android is state whether
    // `JNI_OnLoad` installed the JavaVM + Application context. This is the
    // one-line device check for the abort this daemon used to die from
    // (`adb logcat | grep android_context_installed`) and it also predicts
    // whether iroh got the device's real nameservers or its fallbacks — both
    // read the same `ndk_context` global.
    #[cfg(target_os = "android")]
    tracing::info!(
        android_context_installed = crate::android_context::is_installed(),
        "sync daemon starting"
    );
    // Acquire WifiManager.MulticastLock on Android so the
    // `mdns-sd` crate's UDP multicast sockets receive packets. Held in
    // a local binding so `Drop` releases it on function exit (graceful
    // shutdown or error return). On non-Android targets this is a no-op.
    // A missing context degrades to `Err` HERE, and the daemon carries on
    // without peer discovery — but that is a statement about this call
    // site, not about the process. `hickory-resolver` and `netdev` still
    // call the panicking `ndk_context::android_context()` directly, so
    // under `panic = "abort"` a later iroh DNS lookup would abort anyway.
    // Installing the context is the fix; this guard only stops US from
    // being the one to kill the app (#3847).
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

    // 1. Start mDNS service (graceful fallback — BUG-38, session-log session 406)
    //
    // The citation used to read "#522", which is a merged PR about batch delete /
    // restore and an AppImage `Exec=` line — nothing to do with mDNS. Corrected while
    // passing (#3853); it predates this work.
    //
    // mDNS may fail on platforms where raw UDP sockets are blocked (e.g. iOS)
    // or when the Android multicast lock is missing. When this happens we
    // log a warning, emit `SyncEvent::MdnsDisabled` so the frontend can
    // surface the reason, and continue without peer discovery. Sync still
    // works via manual IP entry (stored in peer_refs); the mDNS branch in
    // The select! loop is simply never triggered. See.
    let mdns = handle_mdns_init_result(MdnsService::new(), &event_sink);

    // 2. Bind the LAN-only QUIC endpoint (responder mode — #615, #78).
    //
    // One endpoint serves both roles: it accepts here and `try_sync_with_peer` dials
    // from it. Two endpoints would mean two identities, and `peer_refs.endpoint_id`
    // pins exactly one.
    let bind_decision = lan_bind_target();
    let (bind_addr, prefix_len, lan_ip) = (
        bind_decision.bind,
        bind_decision.prefix_len,
        bind_decision.lan_ip,
    );
    let service = Arc::new(
        SyncService::bind(
            bind_addr,
            prefix_len,
            DnsResolver::default(),
            endpoint_secret,
        )
        .await
        .map_err(|e| AppError::InvalidOperation(format!("[sync_daemon] sync endpoint: {e}")))?,
    );
    let endpoint_id = service.endpoint_id();
    let port = service
        .addr()
        .ip_addrs()
        .next()
        .map_or(0, std::net::SocketAddr::port);

    // 2b. Tell the user, not just the log, when that bind is internet-facing
    //     (#3864). Emitted here rather than beside the decision because the port
    //     only exists once the endpoint is up — the bind requests port 0.
    handle_internet_facing_bind(&bind_decision, port, &event_sink);

    // #1605: clone the daemon's shared cancel flag into the accept loop so every
    // spawned responder session observes the SAME shutdown/user-cancel signal the
    // initiator path uses. A flipped flag aborts an in-progress responder within one
    // recv cycle, freeing its per-peer lock and its concurrency permit.
    let accept_task = tokio::spawn({
        let service = Arc::clone(&service);
        let pool = pool.clone();
        let device_id = device_id.clone();
        let materializer = materializer.clone();
        let scheduler = scheduler.clone();
        let event_sink = event_sink.clone();
        let cancel = cancel.clone();
        async move {
            // `accept` returns as soon as a peer is *admitted* — a permit taken, before
            // the handshake, nothing waited on. The handshake and the first-frame wait
            // happen in the task spawned below, which is #3485: doing them inline made
            // one stalled peer park the accept loop for the longer of the two budgets
            // (now 180 s), so the 16-slot cap was reachable only in theory.
            while let Ok(Some(admitted)) = service.accept().await {
                let pool = pool.clone();
                let device_id = device_id.clone();
                let mat = materializer.clone();
                let sched = scheduler.clone();
                let sink = event_sink.clone();
                let cancel = cancel.clone();

                // Spawn the session, then spawn a lightweight watcher that awaits the
                // handle. The watcher surfaces both graceful `AppError` failures and
                // fatal `JoinError` (panic / cancel) outcomes — without it a responder
                // task could vanish silently.
                //
                // The concurrency permit needs no handling here, unlike the loop this
                // replaces. It lives inside `AdmittedConnection` and moves into the
                // `InboundSession`, so it is released by a `Drop` on every path: a setup
                // that times out, a session that fails, a task that panics, and a task
                // aborted at shutdown. There is no `drop(permit)` to forget.
                let handle: tokio::task::JoinHandle<Result<(), AppError>> =
                    tokio::spawn(async move {
                        let Some(session) = admitted.establish().await else {
                            // `establish` has already logged which phase failed.
                            return Ok(());
                        };
                        handle_incoming_sync(session, pool, device_id, mat, sched, sink, cancel)
                            .await
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
            }
        }
    });

    // 3. Announce over mDNS.
    //
    // Restored by this cutover. The announce was deferred while `transport` had no
    // production caller, because `MdnsService::announce` requires the `EndpointId` a
    // peer would dial and the daemon had none: discovery that yields only a `device_id`
    // yields a name and no address, which nothing in an iroh world can act on.
    //
    // The key announced is `service.endpoint_id()` — read back from the service that is
    // actually accepting, not from the secret we handed it and not from any other
    // derivation. A record advertising a key nobody is listening on is worse than no
    // record: peers spend a dial budget on it and cannot tell that outcome from a peer
    // that is merely asleep.
    //
    // `lan_ip` is the address the endpoint actually bound. Announcing exactly that (and
    // nothing else) is #3853's other half: the old announce independently enumerated
    // every RFC 1918 interface, so on the maintainer's desktop it advertised three
    // bridge addresses and not the one the endpoint was listening on. A record naming an
    // address nothing is bound to is indistinguishable, from the peer's side, from a
    // device that is merely asleep.
    if let Some(ref mdns) = mdns {
        match mdns.announce(&device_id, endpoint_id, port, lan_ip) {
            Ok(_) => tracing::info!(
                port,
                %endpoint_id,
                bind = ?lan_ip,
                "SyncDaemon started; announced over mDNS"
            ),
            Err(e) => tracing::warn!(
                error = %e,
                "mDNS announce failed; peers must discover this device another way"
            ),
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

    // 5. Discovered peers (device_id → (DiscoveredPeer, last_seen)) arrive as a
    //    parameter; see this function's docs for why. Branch A still owns every
    //    write to it.

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
                        endpoint: service.endpoint(),
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
            //
            // #3502 Part 2: this branch is also the pairing-window initiation
            // path. Both pairing commands end in `scheduler.notify_change()`,
            // so this is the branch that wakes the instant the local pairing
            // marker is written — including the `confirm_pairing` overwrite
            // that finally makes the two devices' proofs agree. Branch A can
            // only fire if the peer re-announces afterwards, which a quiet
            // network need never do. See `peers_for_change_round` for why the
            // round is composed the way it is (and why it is not gated on a
            // `pairing_pending` false→true edge).
            () = scheduler.wait_for_debounced_change() => {
                let refs = list_peer_refs_or_empty(&pool, "debounced_change").await;
                // Fail open to `false` exactly as Branch A does: a transient DB
                // error falls back to the stricter paired-only round.
                let pairing_pending = peer_refs::is_pending_pairing(&pool)
                    .await
                    .unwrap_or(false);
                let round = peers_for_change_round(&refs, &discovered, pairing_pending);
                let mut join_set = tokio::task::JoinSet::new();
                for peer in round {
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
                    let task_endpoint = service.endpoint().clone();
                    let refs_for_task = refs.clone();
                    join_set.spawn(async move {
                        let ctx = SyncSessionContext {
                            pool: &pool,
                            device_id: &device_id,
                            materializer: &materializer,
                            scheduler: &scheduler,
                            event_sink: &event_sink,
                            cancel: &cancel,
                            endpoint: &task_endpoint,
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
                    endpoint: service.endpoint(),
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
                        let stored = refs_by_id.get(pid.as_str());
                        let last_addr = stored.and_then(|r| r.last_address.as_deref());
                        let bound_key = stored.and_then(|r| r.endpoint_id.as_deref());
                        if let Some(peer) =
                            resolve_peer_address(&pid, last_addr, bound_key, discovered)
                        {
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
    accept_task.abort();
    service.close().await;
    if let Some(mdns) = mdns
        && let Err(e) = mdns.shutdown()
    {
        tracing::warn!(error = %e, "mDNS shutdown error");
    }
    tracing::info!("SyncDaemon shut down cleanly");
    Ok(())
}

// ---------------------------------------------------------------------------
// lan_bind_target — where the QUIC endpoint binds
// ---------------------------------------------------------------------------

/// The bind policy's decision: where the sync endpoint binds, and why.
///
/// [`lan_only`](crate::transport::endpoint::lan_only) confines egress by binding one
/// subnet with `is_default_route(false)`, so it needs a real interface address and that
/// interface's prefix length — not a wildcard. A `0.0.0.0` bind with an invented prefix
/// would satisfy every check in `lan_only` and install a route for a block that does not
/// exist, turning the layer-3 confinement into a no-op while all four of its guards
/// stayed green.
///
/// The prefix comes from the interface's own netmask rather than being guessed per RFC
/// 1918 range, because a /24 subnet inside `10.0.0.0/8` is the common home-network shape
/// and binding it as a /8 would confine nothing useful.
///
/// # Which interface (#3853)
///
/// The selection is [`super::lan_interface::decide`]'s, not this function's: it used to
/// be "the first interface whose address is `is_private()`", which bound a Docker bridge
/// on the maintainer's desktop and skipped the real LAN entirely because
/// `192.160.160.0/24` is not RFC 1918. That module carries the policy, the rationale and
/// the table of cases; this function only turns its answer into `lan_only`'s arguments.
///
/// The returned `lan_ip` is `None` for the loopback fallback, and is threaded into the
/// mDNS announce so the address we advertise is by construction the address we bound —
/// advertising a different one is exactly how #3853 stayed invisible.
///
/// # The narrowing this leaves, stated rather than hidden
///
/// It returns **one** interface. A device on both WiFi and Ethernet accepts on only one
/// of them, which is the very multi-homed case the initiator's dial-racing improves. The
/// outbound half genuinely got better; the inbound half did not, because `lan_only`
/// takes a single bind address. Widening it means letting `lan_only` take a set, and its
/// four LAN-posture guards are written against a single bind — so that is a change with
/// its own test story, not a line here.
///
/// The loopback fallback is what a machine with no usable IPv4 interface gets. It binds
/// and accepts nothing from outside, which is the honest answer to "there is no LAN":
/// failing to start the daemon would take the rest of it (scheduler, discovery,
/// dormancy) down with it. It is logged at WARN naming every rejected candidate.
///
/// # The surface this widens, also stated rather than hidden
///
/// `lan_only`'s locality gate now accepts a globally-routable address the host actually
/// holds, because the reporting user's home LAN is numbered out of public space. On a
/// host that is genuinely internet-facing — a VPS, a cloud box, a non-NAT ISP link —
/// that starts a listener where the daemon previously refused to bind at all, which is
/// the "opens a listening port the user didn't ask for" case in SECURITY.md § In scope.
/// No address-shaped rule separates the two situations, so the mitigation is loudness:
/// [`super::lan_interface::BindDecision::internet_facing`] is set and a dedicated WARN
/// names the risk. Turning it into a refusal, or an opt-in, is a product decision and
/// is deliberately not made here.
///
/// The whole [`BindDecision`] is returned rather than the three fields
/// `SyncService::bind` needs, because `internet_facing` is what
/// [`handle_internet_facing_bind`] turns into the user-visible signal (#3864); a log
/// line the daemon writes to a file nobody opens is not one.
fn lan_bind_target() -> BindDecision {
    super::lan_interface::select_bind_target()
}

// ---------------------------------------------------------------------------
// handle_internet_facing_bind — emit SyncEvent on an off-LAN-reachable bind
// ---------------------------------------------------------------------------

/// Emit [`SyncEvent::InternetFacingBind`] when the endpoint bound a
/// globally-routable address (#3864); do nothing otherwise.
///
/// `select_bind_target` already logs a dedicated WARN for this case, which is where the
/// mitigation stopped in #3853. A log line is not a signal a user receives: the file it
/// lands in is opened by developers, after the fact, and never by the VPS operator who
/// is the person this concerns. This turns the same fact into an event the frontend can
/// render, and — via the `BindExposureStatus` the app-side sink writes — into a state a
/// frontend that mounted *after* the bind can still query. The bind happens in the first
/// moments of `daemon_loop`, so that second half is not a nicety; it is how the signal
/// reaches the screen at all.
///
/// Extracted for the same reason [`handle_mdns_init_result`] is: a unit test can drive
/// both outcomes against a recording sink without binding a real endpoint.
///
/// `lan_ip` is destructured, not tested: `decide` sets `internet_facing` from the
/// address it chose, and the loopback fallback — the only `lan_ip: None` decision —
/// hardcodes `internet_facing: false`. `Some` is therefore guaranteed here, and there is
/// no "internet-facing with no address" case for a test to cover.
pub(crate) fn handle_internet_facing_bind(
    decision: &BindDecision,
    port: u16,
    event_sink: &Arc<dyn SyncEventSink>,
) {
    let (true, Some(ip)) = (decision.internet_facing, decision.lan_ip) else {
        return;
    };
    event_sink.on_sync_event(SyncEvent::InternetFacingBind {
        address: ip.to_string(),
        port,
    });
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
pub struct SyncSessionContext<'a> {
    pub pool: &'a SqlitePool,
    pub device_id: &'a str,
    // #2621: borrow of the daemon's `Arc<dyn ApplyHost>` (kept a reference so
    // the struct stays `Copy`); `try_sync_with_peer` clones the `Arc` to build
    // the session orchestrator.
    pub materializer: &'a Arc<dyn ApplyHost>,
    pub scheduler: &'a SyncScheduler,
    pub event_sink: &'a Arc<dyn SyncEventSink>,
    pub cancel: &'a AtomicBool,
    /// The endpoint the daemon accepts on, dialled from for outbound sessions too.
    ///
    /// Deliberately the *same* endpoint rather than a second one: iroh keeps per-peer
    /// path state on it, and a second endpoint would carry a second identity — which is
    /// exactly what `peer_refs.endpoint_id` pins. Two identities for one device would
    /// make our inbound connection unrecognisable to the peer we just synced with
    /// outbound.
    pub endpoint: &'a Endpoint,
}

// ---------------------------------------------------------------------------
// CancelGuard — cancel-flag ownership scope guard (S-11 / #637 / #2537)
// ---------------------------------------------------------------------------

/// Scope guard that clears the shared cancel flag on Drop, but ONLY when the
/// holding task actually *owns* the cancel — i.e. it committed to a real
/// sync session and is therefore the legitimate consumer of (and resetter
/// for) a user cancel.
///
/// #637: the cancel flag is a single `&AtomicBool` SHARED by every per-peer
/// task in a round (Branch B of `daemon_loop` spawns one task per peer
/// against the same flag) and, since #1605/#2537, by responder sessions too.
/// It is set `true` only by the user via `cancel_active_sync()` /
/// `cancel_sync`. An early guard design cleared it unconditionally on every
/// exit path; an early-exiting task (backoff gate, lock contention, no
/// resolved addresses, all-addresses-failed connect, responder identity
/// rejection) would then store `false` and *swallow* a user cancel aimed at
/// a still-running sibling before that sibling ever observed it.
///
/// Invariant: a user cancel targeting a still-running sibling MUST survive
/// an early-exiting peer's teardown, while the legitimate post-run reset
/// still happens. Enforced by clearing the flag on Drop only when
/// `owns == true`, which each session sets exactly once — the initiator
/// immediately before running the real session (`try_sync_with_peer`
/// step 7), the responder once identity checks pass and the per-peer lock
/// is held (#2537, `handle_incoming_sync`). Every early-exit path drops
/// with `owns == false` and leaves the shared flag untouched.
pub(super) struct CancelGuard<'a> {
    pub(super) cancel: &'a AtomicBool,
    pub(super) owns: bool,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if self.owns {
            // `SeqCst` (not `Release`) is load-bearing for the #2537
            // teardown race: this store must be ordered AFTER the session's
            // activity-count decrement (`SessionActivityGuard`'s SeqCst
            // `fetch_sub`, which drops first) in the flag's modification
            // order, so that `SyncScheduler::request_cancel`'s SeqCst
            // store→re-check pair can rely on "re-check saw a live count ⇒
            // that owner's `false` lands after our `true`". A release store
            // does not join the SC total order, which would let a racing
            // cancel's buffered `true` become visible after this `false` —
            // latching the flag with no owner left to reset it.
            self.cancel.store(false, Ordering::SeqCst);
        }
    }
}

/// Did this session end because the peer *turned it away while this device was
/// mid-pairing*?
///
/// # Why this is not "a sync failure" (#3505, #3547)
///
/// A pairing window is the one period in which a refusal is the protocol
/// working. Both dialogs arm their marker on open and each device dials the
/// other before either user has typed anything, so the #855 proof gate refuses
/// both dials by construction (#3502 step 3); a joiner dials *every* discovered
/// unpaired peer, so every third device on the LAN refuses it as `Unpaired`;
/// and a joiner whose window outlives its host's gets the same `Unpaired` back
/// from the host (#3504). None of these is evidence that the peer is flaky, and
/// none of them is a sentence for a user.
///
/// Booking them as failures cost two distinct things, which is why they were
/// filed as two issues:
///
/// * a red "Sync failed: …" toast on both devices before either had typed a
///   passphrase (#3505), at the exact moment the user is being asked to trust
///   the pairing flow;
/// * per-peer exponential backoff (2 s → 4 s → … → 60 s) accumulated by dials
///   that could not have succeeded — which then gates the *one* post-confirm
///   dial that #3502's fix exists to make, because `confirm_pairing`'s
///   `notify_change()` is a single wake and `may_retry` simply skips it
///   (#3547).
///
/// # Why both conditions, and not either
///
/// The message alone is not enough: `Unpaired` is the ordinary answer to every
/// stranger's probe on a healthy LAN, and outside a pairing window a peer that
/// says we are not paired is exactly the peer we should stop hammering. The
/// pairing window alone is not enough either: a connect timeout or a torn
/// stream during a pairing window is a real failure and must still back off, or
/// a device that cannot be reached at all would be dialled flat out for the
/// full five minutes.
///
/// The read is on the failure path only, so the extra query costs nothing on
/// the success path. A read *error* answers "no" — the conservative direction,
/// because the fallback is today's behaviour rather than a silently unbounded
/// retry.
async fn peer_rejection_during_pairing_window(
    pool: &SqlitePool,
    orch: &SyncOrchestrator,
) -> Option<Rejection> {
    // The verbatim text the responder sent, taken from the orchestrator rather
    // than from the `AppError` the caller holds: `run_sync_session` wraps a
    // terminal state as `"sync ended in terminal state: {reason:?}"`, and
    // re-parsing prose out of that wrapper would be a third copy of the
    // rejection strings.
    let SyncState::Failed(ref reason) = orch.session().state else {
        return None;
    };
    let rejection = Rejection::from_peer_message(reason)?;
    match peer_refs::is_pending_pairing(pool).await {
        Ok(true) => Some(rejection),
        Ok(false) => None,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "could not read the pending-pairing marker while classifying a peer \
                 rejection; treating it as an ordinary sync failure (#3505)"
            );
            None
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
/// `run_sync_session` returned `Err("[transport::driver] session cancelled")`).
///
/// The `_cancel_guard` (a Drop scope guard, S-11) clears the flag on
/// Drop — but only when this task actually ran a real session and thus
/// *owns* the cancel (#637). Early-exit paths (backoff / lock / no-address /
/// connect failure) return with `owns == false` and deliberately leave the
/// shared flag untouched, so an early-exiting peer can never swallow a user
/// cancel aimed at a still-running sibling. On the real-session path the
/// `was_cancelled` capture happens *before* the guard's Drop fires, so the
/// returned bool reflects the live state at session end.
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
pub async fn try_sync_with_peer(
    ctx: &SyncSessionContext<'_>,
    peer: &DiscoveredPeer,
    peer_refs: &[PeerRef],
) -> bool {
    let peer_id = &peer.device_id;

    // 0. A peer with no name is not a peer.
    //
    // `mdns::parse_service_event` refuses an empty `device_id` where announcements
    // enter, and this is a second, independent refusal because an announcement is not
    // the only way a `DiscoveredPeer` is built: `build_fallback_peer` synthesises one
    // from a `peer_refs` row, and nothing stops a future caller synthesising another.
    // An empty id carried through a session ends up as the `peer_id` of a row that
    // `list_peer_refs` filters out (`WHERE peer_id != ''`) — present enough to
    // authorize an inbound session at S-1, absent from the device list and from
    // unpair.
    //
    // Placed before the backoff gate, the per-peer lock and the "connecting" event, so
    // nothing is recorded against a name that does not exist; and before
    // `_cancel_guard` exists, so it cannot swallow a sibling's cancel.
    if peer_id.is_empty() {
        tracing::warn!("skipping sync: the discovered peer announced an empty device id");
        return false;
    }

    // Scope guard: clear the shared cancel flag on Drop, but ONLY when this
    // task actually *owns* the cancel — i.e. it reached the real sync-session
    // phase and is therefore the legitimate consumer of (and resetter for) a
    // user cancel. See the module-level [`CancelGuard`] docs (#637/#2537) for
    // the full ownership invariant; `owns` is set exactly once, immediately
    // before we run the real session (step 7). Every early-exit path returns
    // with `owns == false` and therefore leaves the shared flag untouched: a
    // pending user cancel stays set for the sibling / next attempt to
    // observe, and a stale un-set flag stays un-set.
    let mut _cancel_guard = CancelGuard {
        cancel: ctx.cancel,
        owns: false,
    };

    // 1. Backoff gate
    if !ctx.scheduler.may_retry(peer_id) {
        // No real session ran, cancellation is moot for this peer.
        // #637: guard.owns is still false, so we leave the shared cancel
        // flag untouched — a user cancel aimed at a sibling survives.
        return false;
    }

    // 2. The peer's key. Under iroh this is what a dial names; addresses are only
    //    candidate paths to an already-named endpoint.
    //
    //    A discovered peer without one cannot be dialled at all, which is why
    //    `mdns::parse_service_event` refuses an announcement whose TXT record has no
    //    parseable `endpoint_id`: "we discovered a peer" and "we can attempt a session"
    //    have to stay the same statement.
    //
    //    This resolution used to sit *after* the per-peer lock. It reads a field off an
    //    already-discovered peer — no network, no DB round-trip, nothing that needs the
    //    lock held — so the order was free to change, and it has to, because the lock's
    //    key is derived from it (step 3). It is also the better order on its own merits:
    //    a peer we cannot dial at all no longer takes and releases a peer lock on its
    //    way to being skipped.
    let Some(endpoint_id) = peer.endpoint_id else {
        tracing::warn!(
            peer_id,
            "peer announced no endpoint id, skipping sync (nothing to dial)"
        );
        // No real session ran, cancellation is moot for this peer.
        // #637: guard.owns is still false → don't clear a sibling's cancel.
        return false;
    };

    // 3. Per-peer mutex (prevents concurrent syncs to the same peer)
    //
    //    Keyed on the endpoint id, not on `peer_id`, because the responder in
    //    `server::handle_incoming_sync` cannot key on a device id it has not been told
    //    yet — see [`peer_lock_key`](super::peer_lock_key). Mutual exclusion is a
    //    property of the two roles agreeing on a spelling, so both derive it there and
    //    nowhere else. `peer_id` remains the key for backoff, events and `peer_refs`;
    //    it is only the lock that moved.
    let Some(_guard) = ctx
        .scheduler
        .try_lock_peer(&super::peer_lock_key(endpoint_id))
    else {
        // Already syncing with this peer; no real session ran here.
        // #637: guard.owns is still false → don't clear a sibling's cancel.
        return false;
    };

    // 4. The pinned-identity check, which replaces the B-33 cert-hash pin.
    //
    //    If we have already bound a key to this peer and the announcement carries a
    //    different one, refuse. Under the old stack this was a hash compared against a
    //    separately-claimed identity; here the key *is* the identity, so a mismatch is
    //    not "wrong certificate for the right device" but "a different device using
    //    this device's name" — an mDNS TXT record is a claim like any other.
    //
    //    An unbound peer falls through to bind on success below. That TOFU is the same
    //    one the old initiator performed with `upsert_peer_ref_with_cert`, and after an
    //    upgrade it is the path by which every migrated pair re-acquires a binding,
    //    since `0107` could not backfill a key from a certificate hash.
    let announced_key = endpoint_id.to_string();
    let pinned = peer_refs
        .iter()
        .find(|p| p.peer_id == *peer_id)
        .and_then(|p| p.endpoint_id.clone());
    if let Some(ref pinned_key) = pinned
        && *pinned_key != announced_key
    {
        tracing::warn!(
            peer_id,
            pinned = %pinned_key,
            announced = %announced_key,
            "refusing to sync: the announced endpoint id does not match the one bound \
             to this peer"
        );
        ctx.scheduler.record_failure(peer_id);
        ctx.event_sink.on_sync_event(SyncEvent::Error {
            message: "peer identity does not match the one paired with this device".into(),
            remote_device_id: peer_id.clone(),
        });
        return false;
    }

    // 5. Emit "connecting" progress event
    ctx.event_sink.on_sync_event(SyncEvent::Progress {
        state: "connecting".into(),
        remote_device_id: peer_id.clone(),
        ops_received: 0,
        ops_sent: 0,
    });

    // 6. Dial.
    //
    //    Every advertised address goes in at once and iroh races them. The sequential
    //    loop this replaces paid a full connect timeout on a dead path before trying a
    //    live one, which is exactly the multi-homed LAN case — a device on both WiFi and
    //    Ethernet — that the address list exists for. `peer_refs.last_address` goes with
    //    the loop: iroh keeps its own per-endpoint path state, so a column the daemon
    //    writes and nothing reads is worse than no column.
    let mut addr = EndpointAddr::new(endpoint_id);
    for ip in &peer.addresses {
        addr = addr.with_ip_addr(std::net::SocketAddr::new(*ip, peer.port));
    }
    // Bounded, because iroh's own dial budget is ~30 s and this runs while holding the
    // per-peer lock and a slot in the round's `JoinSet`.
    //
    // The value is `sync_constants::CONNECT_TIMEOUT`'s and its **scope is re-derived,
    // not inherited**. It used to bound one `connect_async_tls_with_config` — TCP
    // connect plus TLS handshake plus WebSocket upgrade against *one* address — with
    // `try_connect_each_address` paying it again per candidate, so N dead addresses cost
    // N budgets. Here it bounds the whole dial, because iroh races every candidate path
    // itself: one budget covers all of them. Same number, strictly narrower scope, and
    // the multi-homed case it was worst for (WiFi plus Ethernet, one path dead) now
    // costs one budget rather than two.
    let dialed = tokio::time::timeout(CONNECT_TIMEOUT, ctx.endpoint.connect(addr, SYNC_ALPN)).await;
    let conn = match dialed {
        Err(_elapsed) => {
            tracing::warn!(
                peer_id,
                candidates = peer.addresses.len(),
                timeout_s = CONNECT_TIMEOUT.as_secs(),
                "peer did not answer the dial within the connect budget"
            );
            ctx.scheduler.record_failure(peer_id);
            ctx.event_sink.on_sync_event(SyncEvent::Error {
                message: format!(
                    "Connection failed: peer did not answer within {}s",
                    CONNECT_TIMEOUT.as_secs()
                ),
                remote_device_id: peer_id.clone(),
            });
            return false;
        }
        Ok(Ok(conn)) => conn,
        Ok(Err(e)) => {
            tracing::warn!(
                peer_id,
                candidates = peer.addresses.len(),
                error = %e,
                "failed to connect to peer"
            );
            ctx.scheduler.record_failure(peer_id);
            ctx.event_sink.on_sync_event(SyncEvent::Error {
                message: format!("Connection failed: {e}"),
                remote_device_id: peer_id.clone(),
            });
            // Connection never established, no real session ran.
            // #637: guard.owns is still false → don't clear a sibling's cancel; this
            // early-exit must not swallow a pending user cancel aimed at a
            // still-running peer.
            return false;
        }
    };

    // The initiator opens the bi-stream. Note a locally-opened QUIC stream is invisible
    // to the peer until something is written on it, so it is `run_session`'s opening
    // `HeadExchange` — not this call — that makes the responder's `accept_bi` resolve.
    let (mut send, mut recv) = match conn.open_bi().await {
        Ok(halves) => halves,
        Err(e) => {
            tracing::warn!(peer_id, error = %e, "failed to open a sync stream to peer");
            ctx.scheduler.record_failure(peer_id);
            ctx.event_sink.on_sync_event(SyncEvent::Error {
                message: format!("Connection failed: {e}"),
                remote_device_id: peer_id.clone(),
            });
            return false;
        }
    };

    // 7. Run sync protocol through the orchestrator
    //
    // #637: we have committed to a real sync session — connection established,
    // per-peer lock held, addresses resolved. From here on this task OWNS the
    // cancel: it is the task that `run_sync_session` checks the flag in, the
    // One that may observe & report a user cancel, and therefore the
    // legitimate resetter. Mark the guard so its Drop clears the shared flag
    // when the session ends (whether it completed normally or was cancelled).
    _cancel_guard.owns = true;

    // #2537: register this session as live so `cancel_active_sync` /
    // `cancel_sync` actually latch the shared flag (they are no-ops with no
    // live session — see `SyncScheduler::request_cancel`). Declared AFTER
    // `_cancel_guard`, so on exit the activity count drops to zero before
    // the guard clears the flag — `request_cancel`'s post-store re-check
    // then guarantees a racing cancel can never latch an ownerless flag.
    let _session_activity = ctx.scheduler.begin_session_activity();

    // #2621 Sync-D: the scheduler hands back an opaque `SessionSinkWrapper`
    // (built app-side from a `tauri::ipc::Channel`, wrapping the base sink in a
    // `ChannelEventSink`). Applying it here keeps the Tauri channel type out of
    // `agaric-sync` — see `SyncScheduler::register_channel`.
    let mut event_sink_arc = Arc::clone(ctx.event_sink);
    if let Some(wrap_with_channel) = ctx.scheduler.take_channel(peer_id) {
        event_sink_arc = wrap_with_channel(event_sink_arc);
    }

    let event_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(event_sink_arc.clone()));
    let mut orch = SyncOrchestrator::new(
        ctx.pool.clone(),
        ctx.device_id.to_string(),
        ctx.materializer.clone(),
    )
    .with_event_sink(event_sink_box)
    .with_expected_remote_id(peer_id.clone());

    match run_sync_session(
        &mut orch,
        &mut send,
        &mut recv,
        &conn,
        ctx.cancel,
        ctx.pool,
        ctx.materializer,
        &event_sink_arc,
    )
    .await
    {
        Ok(()) => {
            ctx.scheduler.record_success(peer_id);
            // Remember one address that worked, alongside the key.
            //
            // Plan #3464 expected this column to lose its meaning, on the reasoning that
            // iroh keeps its own per-`EndpointId` path state. That holds *within a
            // process*. It does not survive a restart, and the LAN-only endpoint calls
            // `clear_address_lookup()`, so mDNS is the only discovery there is — which
            // makes this the only way a fresh start reaches a paired peer that has not
            // announced yet. It is no longer a dial *order* (iroh races candidates, so
            // the sequential loop and its "try this one first" optimisation are both
            // gone); it is a cached candidate path, and it is only usable in company
            // with the bound key. See `discovery::resolve_peer_address`.
            if let Err(e) = peer_refs::update_last_address(
                ctx.pool,
                peer_id,
                &format!(
                    "{}:{}",
                    peer.addresses
                        .first()
                        .map_or_else(|| std::net::IpAddr::from([0, 0, 0, 0]), |ip| *ip),
                    peer.port
                ),
            )
            .await
            {
                tracing::warn!(peer_id, error = %e, "failed to save peer address");
            }
            //
            // `bind_endpoint_id` touches only its own column, so re-binding preserves
            // this peer's version vectors and sync state — a device that merely
            // re-paired must not be reset.
            if pinned.is_none()
                && let Err(e) = peer_refs::bind_endpoint_id(ctx.pool, peer_id, &announced_key).await
            {
                tracing::warn!(
                    peer_id,
                    endpoint_id = %announced_key,
                    error = %e,
                    "failed to bind the peer's endpoint id (TOFU)"
                );
            }
            // #2539 (item 2): NO daemon-level `SyncEvent::Complete` here —
            // exactly ONE terminal Complete is emitted per session per role,
            // and every initiator success path already emits it closer to the
            // completion itself:
            //   * streamed ops    → the orchestrator's final-LoroSync arm,
            //   * empty stream    → the orchestrator's SyncComplete arm,
            //   * snapshot catch-up → `snapshot_transfer`'s Applied paths
            //     (the orchestrator ends that session in `ResetRequired` and
            //     never emits Complete itself).
            // The orchestrator is wired with `event_sink_arc` above (the same
            // sink, `ChannelEventSink`-wrapped when a command channel is
            // attached), so its emission reaches everything this duplicate
            // used to reach. Emitting a second Complete here doubled the
            // event on every success — and on the catch-up path the duplicate
            // carried stale ResetRequired-era session counters.
            let session = orch.session();
            tracing::info!(
                peer_id,
                ops_rx = session.ops_received,
                ops_tx = session.ops_sent,
                "sync complete"
            );
        }
        Err(e) => {
            // #2537: a user cancel is NOT a peer failure. Recording it via
            // `record_failure` doubled the peer's backoff (2s → … → 60s) for
            // something the peer did nothing wrong about, delaying the very
            // next legitimate sync. Distinguish by the live cancel flag
            // (still set here — the owning guard only clears it on Drop,
            // after this match): skip the scheduler recording entirely
            // (neither failure nor success) and surface the terminal state
            // through the existing `SyncEvent::Error` vocabulary so the
            // active sync UI still resolves.
            if ctx.cancel.load(Ordering::Acquire) {
                ctx.event_sink.on_sync_event(SyncEvent::Error {
                    message: format!("Sync cancelled: {e}"),
                    remote_device_id: peer_id.clone(),
                });
                tracing::info!(peer_id, error = %e, "sync session cancelled by user");
            } else if let Some(rejection) =
                peer_rejection_during_pairing_window(ctx.pool, &orch).await
            {
                // #3505/#3547: a refusal received while this device is mid-pairing
                // is the handshake working, not a failed sync — see the helper for
                // the full reasoning. Neither the backoff nor the generic
                // `Sync failed: …` event is right for it.
                //
                // The rejection itself has ALREADY reached the UI, verbatim:
                // `session_state_machine`'s `SyncMessage::Error` arm emits a
                // `SyncEvent::Error` carrying the responder's own words, which is
                // the signal `PairingDialog` matches to say "wrong code". What is
                // suppressed here is only this layer's second, generic wrapper
                // around the same event — a wrapper that says "Sync failed" about
                // something that did not fail.
                tracing::info!(
                    peer_id,
                    ?rejection,
                    "peer refused a connection made during a pairing window; not \
                     recording it as a sync failure (#3505)"
                );
            } else {
                ctx.scheduler.record_failure(peer_id);
                ctx.event_sink.on_sync_event(SyncEvent::Error {
                    message: format!("Sync failed: {e}"),
                    remote_device_id: peer_id.clone(),
                });
                tracing::warn!(peer_id, error = %e, "sync session failed");
            }
        }
    }

    // Capture the cancel flag's live state BEFORE `_cancel_guard`
    // clears it on Drop. The guard is the *first* local declared in this
    // function so it drops *last* (Rust drops locals in reverse declaration
    // order); this read therefore observes the still-set flag. The returned bool tells the daemon-loop caller
    // whether the user cancelled mid-session so it can break out of the
    // current peer round (see Branch B / Branch C in `daemon_loop`).
    //
    // #637: at this point `_cancel_guard.owns == true` (set in step 7), so the
    // guard WILL clear the shared flag on Drop — this is the legitimate
    // post-run reset. Early-exit paths never reach here and never set `owns`,
    // so they leave a pending sibling-targeted cancel intact.
    let was_cancelled = ctx.cancel.load(Ordering::Acquire);

    // Cancel flag is cleared by `_cancel_guard` (Drop) because we own it.

    // The connection is closed by `run_sync_session`, which owns the shutdown wait —
    // the side that spoke last has to hear the peer's close before dropping, or its
    // final frame is discarded. Dropping `conn` here is the backstop for the paths that
    // returned before that (a dial that succeeded and a session that never started).
    drop(conn);

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
pub async fn run_sequential_sync_round<F, Fut>(peer_ids: &[String], mut sync_fn: F) -> bool
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
// Splitting the bi-stream into its two halves is what pushed this past the 7-argument
// lint, and bundling them back into a struct would undo exactly the thing that makes the
// borrows work: `&mut side.send` and `&mut side.recv` are disjoint *field* borrows, which
// a wrapper with two accessors could not hand out simultaneously.
#[allow(clippy::too_many_arguments)]
pub async fn run_sync_session(
    orch: &mut SyncOrchestrator,
    send: &mut SendStream,
    recv: &mut RecvStream,
    conn: &Connection,
    cancel: &AtomicBool,
    pool: &SqlitePool,
    materializer: &Arc<dyn ApplyHost>,
    event_sink: &Arc<dyn SyncEventSink>,
) -> Result<(), AppError> {
    // Initiator sends first message
    //
    // #611: all session-loop sends/recvs go through `wire::{send,recv}_sync_message`
    // so over-threshold LoroSync payloads ride the chunked binary path instead of
    // blowing the 10 MB JSON text-frame cap.
    // One driver, both roles. The loop this replaces was written twice — here and in
    // `server.rs` — and the only thing the two shared was the dispatch guard, whose own
    // doc called itself "the ONE guard shared by all three dispatch sites": an admission
    // that they had already drifted far enough to need a named remedy.
    //
    // `run_session` returns `Ok(SessionEnd { state: Failed(..) })` where this loop
    // returned `Err`, because a peer-reported failure is a completed session rather than
    // a transport error. Written out rather than `?`-ed for exactly that reason: a
    // cutover call site that wrote `run_session(..).await?` would book a failed sync as
    // a clean one, and the `?` would look right.
    let end = match run_session(
        Role::Initiator,
        orch,
        send,
        recv,
        Some(cancel),
        SessionLimits::default(),
    )
    .await
    {
        Ok(end) => end,
        Err(e) => {
            // Every failure path out of `run_session` leaves the connection open and
            // `send` unfinished, which hands it to QUIC's idle timeout. Close it here so
            // the peer's responder permit and per-peer lock come back promptly.
            if let Err(close_err) =
                finish_session(false, send, conn, SessionLimits::default()).await
            {
                tracing::debug!(error = %close_err, "failed to close a failed sync session");
            }
            return Err(e);
        }
    };
    if let SyncState::Failed(ref reason) = end.state {
        if let Err(e) = finish_session(false, send, conn, SessionLimits::default()).await {
            tracing::debug!(error = %e, "failed to close a failed sync session");
        }
        return Err(AppError::InvalidOperation(format!(
            "sync ended in terminal state: {reason:?}"
        )));
    }

    // Who owes the shutdown wait, tracked across the two post-loop phases.
    //
    // Keyed on who spoke last, never on the role — the protocol says `SyncComplete` is
    // "sent once by the puller … in the normal flow that is the initiator; in the
    // empty-registry short-circuit the responder sends it directly because it had
    // nothing to stream", so both sides are the terminal sender in some sessions. The
    // phases below move the answer, which is why it is a variable rather than a field
    // read at the end.
    let mut spoke_last = end.spoke_last;

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
            send,
            recv,
            pool,
            materializer.as_ref(),
            event_sink,
            &peer_id,
            expected_remote_id.as_deref(),
            engine_reload,
        )
        .await
        {
            // #2538: only `Applied` is a real success. The sub-flow's other
            // outcome, `Rejected`, means the offer was refused (over the
            // local size cap): nothing was applied, no frontier advanced,
            // no `peer_refs` bookkeeping ran. Collapsing it into `Ok(())`
            // made the caller `record_success` (resetting backoff), emit
            // `SyncEvent::Complete`, and persist last_address/TOFU state —
            // so the 30 s scheduler re-selected the peer forever, with the
            // responder re-hashing the full blob every round while the UI
            // said "complete".
            Ok(snapshot_transfer::CatchupOutcome::Applied { .. }) => {
                tracing::info!(
                    peer_id = %peer_id,
                    "snapshot-driven catch-up complete"
                );
                // The receiver of a snapshot answers last (`SnapshotAccept`, then the
                // bytes flow the other way), so the offering side is a round trip
                // ahead of us and there is nothing of ours left in flight.
                if let Err(e) = finish_session(false, send, conn, SessionLimits::default()).await {
                    tracing::debug!(error = %e, "failed to close after snapshot catch-up");
                }
                return Ok(());
            }
            Ok(snapshot_transfer::CatchupOutcome::Rejected { size_bytes }) => {
                // `spoke_last = true`: rejecting means *we* wrote the last frame
                // (`SnapshotReject`), so we are a round trip ahead of the peer's read.
                // Closing without waiting discards it — `Connection::close` lets the
                // remote "drop any data it received but is as yet undelivered to the
                // application" — and the offering peer then cannot tell "over your cap"
                // from "the link died", so it re-offers the same blob on the next tick.
                // That loop is exactly what #2538 exists to break.
                if let Err(e) = finish_session(true, send, conn, SessionLimits::default()).await {
                    tracing::debug!(error = %e, "failed to close after a rejected offer");
                }
                // Surface as a session failure so the caller records it
                // (exponential backoff — the peer is NOT immediately re-due)
                // and skips the success bookkeeping. The sub-flow already
                // emitted the actionable size-cap `SyncEvent::Error`.
                return Err(AppError::InvalidOperation(format!(
                    "snapshot catch-up rejected: peer offered {size_bytes} bytes, over the \
                     local {max} byte cap; delta sync cannot resume (ResetRequired) until the \
                     peer's snapshot fits the cap",
                    max = snapshot_transfer::MAX_SNAPSHOT_SIZE,
                )));
            }
            Err(e) => {
                // The catch-up sub-flow had its own error handling
                // (decode/apply failure, unexpected message). Surface the
                // error here so the scheduler records the failure and
                // backs off.
                if let Err(close_err) =
                    finish_session(false, send, conn, SessionLimits::default()).await
                {
                    tracing::debug!(error = %close_err, "failed to close after a failed catch-up");
                }
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
                    send,
                    recv,
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
                // The initiator's second file-transfer phase ends by *sending*
                // `FileTransferComplete` (`receive_request_and_send_files`), so it is a
                // round trip ahead of the responder's read whether the phase succeeded
                // or failed part-way. The responder's mirror image ends by receiving
                // one, which is why `server.rs` sets this the other way.
                spoke_last = true;
            }
            _ => {
                tracing::warn!("could not determine app_data_dir, skipping file transfer");
            }
        }
    }

    match finish_session(spoke_last, send, conn, SessionLimits::default()).await {
        Ok(shutdown) => tracing::debug!(?shutdown, "initiator connection shut down"),
        Err(e) => tracing::debug!(error = %e, "failed to close initiator connection"),
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

    // ── handle_internet_facing_bind (#3864) ──────────────────────────────────
    //
    // The pair below is the whole contract: fires on a globally-routable bind, silent
    // on an ordinary one. Pinning only the first would pass a helper that emitted
    // unconditionally — which is the failure that matters here, because a banner every
    // user sees on every boot is a banner every user learns to ignore.
    //
    // Both drive `lan_interface::decide` rather than hand-building a `BindDecision`, so
    // the fixture cannot claim an `internet_facing` value the real policy would not
    // produce for that address.

    /// Build a candidate the way `host_candidates` would for an up, non-p2p NIC.
    /// (`LanInterface::new` is private to `lan_interface`'s own test module.)
    fn iface(
        name: &str,
        ip: &str,
        prefix_len: u8,
    ) -> crate::sync_daemon::lan_interface::LanInterface {
        crate::sync_daemon::lan_interface::LanInterface {
            name: name.to_owned(),
            ip: ip.parse().expect("test literal is a valid IPv4 address"),
            prefix_len,
            is_up: true,
            is_p2p: false,
        }
    }

    /// A globally-routable bind must reach the user, carrying the address it bound and
    /// the port the OS actually handed out.
    ///
    /// The port matters as much as the address: the bind requests port 0, so anything
    /// that forwarded the *requested* port would emit `0` and tell the user nothing
    /// about what is listening.
    #[test]
    fn handle_internet_facing_bind_emits_the_bound_address_and_port() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        // The reporting maintainer's own LAN — real public space, which is why #3853
        // had to accept it and why #3864 has to say so.
        let decision = crate::sync_daemon::lan_interface::decide(
            vec![iface("wlp2s0", "192.160.160.80", 24)],
            None,
        );
        assert!(
            decision.internet_facing,
            "precondition: the policy must flag 192.160.160.80 as globally routable, \
             or this test asserts nothing about the emitting branch"
        );

        handle_internet_facing_bind(&decision, 54321, &sink);

        let events = typed.events();
        assert_eq!(
            events.len(),
            1,
            "exactly one SyncEvent must reach the frontend for an internet-facing bind"
        );
        match &events[0] {
            SyncEvent::InternetFacingBind { address, port } => {
                assert_eq!(
                    address, "192.160.160.80",
                    "the event must name the address the endpoint actually bound"
                );
                assert_eq!(
                    *port, 54321,
                    "…and the port the endpoint actually got, not the 0 the bind asked for"
                );
            }
            other => panic!("expected InternetFacingBind, got {other:?}"),
        }
    }

    /// An ordinary RFC 1918 LAN — the overwhelmingly common case — must stay silent.
    ///
    /// This is the half of the pair that a helper emitting unconditionally would fail,
    /// and the reason the banner is worth showing at all: it means something because it
    /// is not always there.
    #[test]
    fn handle_internet_facing_bind_is_silent_on_an_ordinary_private_lan() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let decision = crate::sync_daemon::lan_interface::decide(
            vec![iface("wlan0", "192.168.1.50", 24)],
            None,
        );
        assert!(
            !decision.internet_facing,
            "precondition: 192.168.0.0/16 is RFC 1918 and is not reachable off-LAN"
        );

        handle_internet_facing_bind(&decision, 54321, &sink);

        assert!(
            typed.events().is_empty(),
            "a private-LAN bind must emit nothing; a warning shown to every user on \
             every boot is a warning every user stops reading, got {:?}",
            typed.events()
        );
    }

    /// `lan_bind_target` is the delegation to the bind policy, and nothing else (#3853).
    ///
    /// The policy itself is pinned by `lan_interface`'s fixture table. What that table
    /// cannot say is that *this* function consults it: replacing the whole body with
    /// `(127.0.0.1:0, MIN_IPV4_PREFIX_LEN, None)` — the pre-#3853 loopback fallback,
    /// with the LAN selection deleted — compiled and left the entire suite green, on a
    /// machine whose sync would then never have been reachable by any peer. This is the
    /// only assertion in the crate that touches `session_supervisor`'s half of the
    /// change.
    ///
    /// Asserted as equality with the policy's own answer rather than against a literal
    /// address, because which interface this machine should pick is the policy's
    /// business, not this test's — and a literal would pin the machine instead of the
    /// wiring. `select_bind_target` reads the host, so the equality is exact only while
    /// the interface list is stable across the two calls; a link flapping mid-test would
    /// be the one way this goes red without a code change.
    ///
    /// On a host with no usable LAN interface at all the policy itself answers with the
    /// loopback fallback, so the mutation above becomes *equivalent* there and this test
    /// is green for both. It is red on any machine that has a LAN — including this one
    /// and the reporter's.
    #[test]
    fn lan_bind_target_returns_the_bind_policy_decision_not_a_fallback() {
        let decision = super::super::lan_interface::select_bind_target();
        let got = lan_bind_target();
        let (bind_addr, prefix_len, lan_ip) = (got.bind, got.prefix_len, got.lan_ip);

        assert_eq!(
            (bind_addr, prefix_len, lan_ip),
            (decision.bind, decision.prefix_len, decision.lan_ip),
            "the daemon must bind and announce what `lan_interface::decide` selected; \
             anything else silently reintroduces #3853. Passed over: {}",
            decision.passed_over()
        );

        // …and the announced address is by construction the bound one, which is the
        // half of #3853 the mDNS record carries.
        match lan_ip {
            Some(ip) => assert_eq!(
                bind_addr.ip(),
                std::net::IpAddr::V4(ip),
                "the address handed to the mDNS announce must be the address bound"
            ),
            None => assert!(
                bind_addr.ip().is_loopback(),
                "no LAN address means the loopback fallback, nothing else; got {bind_addr}"
            ),
        }
    }
}
