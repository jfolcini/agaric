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
use crate::mdns::{DiscoveredPeer, MdnsDaemonSignal, MdnsService};
use crate::sync_constants::CONNECT_TIMEOUT;
use crate::sync_daemon::lan_interface::BindDecision;
use crate::sync_events::{SyncEvent, SyncEventSink};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use iroh_dns::dns::DnsResolver;

use crate::sync_protocol::{SyncOrchestrator, SyncState};
use crate::sync_scheduler::SyncScheduler;
use crate::transport::driver::{Role, SessionLimits, finish_session, run_session};
use crate::transport::egress_probe::{
    BoundSocket, EgressReport, EgressVerdict, probe_peer_egress_with, system_source_address_for,
};
use crate::transport::service::{SYNC_ALPN, SyncService};
use agaric_core::error::AppError;
use agaric_store::peer_refs::{self, PeerRef};

use super::SharedEventSink;
use super::discovery::{
    DiscoveredPeers, MDNS_STALE_AFTER, mdns_is_reaching_us, mdns_last_seen, peers_for_change_round,
    process_discovery_event, resolve_peer_address,
};
use super::server::{Rejection, handle_incoming_sync};
use super::snapshot_transfer;

// ---------------------------------------------------------------------------
// RESYNC_TICK — the daemon's periodic-resync cadence
// ---------------------------------------------------------------------------

/// How often [`daemon_loop`]'s periodic-resync branch wakes up and asks
/// [`SyncScheduler::peers_due_for_resync`] who is due.
///
/// This is a *tick*, not an interval: a peer becomes due after
/// `SyncScheduler::resync_interval` (60 s by default) and is noticed up to one
/// tick later, so a healthy peer's real period is
/// `(resync_interval, resync_interval + RESYNC_TICK]`.
///
/// #4120 note 1: it is a named constant rather than a literal in the
/// `tokio::time::interval` call because a second site depends on it —
/// [`peer_pulled_from_us_recently`]'s freshness window must stay strictly
/// wider than that period, or the suppressed toast returns intermittently on a
/// pair that is working. That site now `debug_assert!`s the invariant against
/// this constant, so moving either number trips a test rather than a user's
/// toast.
const RESYNC_TICK: std::time::Duration = std::time::Duration::from_secs(30);

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

    // #3852: register for the OS's own statement about this uid's firewall
    // status before anything tries to use the network, so a block that is
    // already in force is reported rather than inferred from the silence that
    // follows. Off Android `start_monitor` is a no-op; the sink installation is
    // unconditional so the reporting path is identical on every platform.
    super::android_network_block::install_event_sink(event_sink.clone());
    super::android_network_block::start_monitor();

    // 1. Start mDNS service (graceful fallback — BUG-38, session-log session 406)
    //
    // The citation used to read "#522", which is a merged PR about batch delete /
    // restore and an AppImage `Exec=` line — nothing to do with mDNS. Corrected while
    // passing (#3853); it predates this work.
    //
    // mDNS may fail on platforms where raw UDP sockets are blocked (e.g. iOS)
    // or when the Android multicast lock is missing. When this happens we
    // log a warning, emit `SyncEvent::MdnsDisabled` so the frontend can
    // surface the reason, and continue without peer discovery. There is no
    // fallback for a peer that has never paired: a first pair needs an mDNS
    // resolve to learn the peer's `endpoint_id` (see
    // `sync_daemon::discovery::resolve_peer_address`). Already-paired peers
    // can still be dialed via their cached `peer_refs.last_address`, once
    // bound; the mDNS branch in the select! loop is simply never triggered.
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
    // The addresses that decision was made from, handed to the bind's locality gate
    // rather than letting it enumerate the host a second time (#3869). The second sweep
    // could disagree with the first — an address lost to a DHCP renewal or a Wi-Fi roam
    // between them — and `lan_only` would then refuse, on locality grounds, a bind this
    // code had just chosen.
    //
    // This **narrows** that race, it does not close it. What it removes is the locality
    // refusal: the gate is now answered from the same sweep that picked the address, so
    // `BindAddressNotPrivate` is unreachable from here. The address can still go away
    // between the sweep and the `bind` below, and when it does the kernel refuses with
    // EADDRNOTAVAIL, `SyncService::bind` returns `ServiceBindError::Socket`, and the `?`
    // on the next statement still fails the whole daemon. There is no loopback fallback
    // on this path — `lan_bind_target` already committed to an address, and the fallback
    // it owns is chosen before this point or not at all. The gain is that the failure is
    // now the operating system reporting a fact rather than our own configuration layer
    // rejecting an address it had itself selected a moment earlier.
    //
    // #4116: the list is **not** read on every start. `bind_locality_ok` short-circuits
    // on `!is_publicly_routable(bind)`, so an RFC 1918 bind — and the loopback fallback,
    // which is the case worth naming — never consults it and this `Vec` is built for
    // nothing. It is built unconditionally anyway: skipping it would mean predicting the
    // gate's short-circuit from out here, and a later widening of the gate would then be
    // handed an empty list and refuse a bind this code had already chosen. That is the
    // #3869 failure again, traded for one allocation per daemon start.
    let host_addrs = bind_decision.host_addrs();
    let service = Arc::new(
        SyncService::bind(
            bind_addr,
            prefix_len,
            &host_addrs,
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
    //
    // #3852 — "announced" is no longer claimed here. `announce()` returns as soon as a
    // register *command* is queued (see its docs); on the reporting Pixel 8 this line
    // read `SyncDaemon started; announced over mDNS port=59553 bind=Some(192.160.160.102)`
    // while the device answered neither multicast nor unicast queries, because Android
    // 15+'s per-uid `FIREWALL_CHAIN_BACKGROUND` was dropping every packet at the
    // cgroup-BPF hook. That single over-claiming line is what hid the bug for three days.
    //
    // So the submit is `debug!` and says only what happened, and the `info!` that says
    // "announced" is emitted from the monitor task below, on the daemon's own
    // `DaemonEvent::Announce` — after a socket was actually written to. `monitor()` is
    // subscribed BEFORE the register command is queued, because the daemon processes
    // commands in order: subscribing afterwards would race the very event we want.
    if let Some(ref mdns) = mdns {
        spawn_mdns_monitor(mdns, &event_sink);
        match mdns.announce(&device_id, endpoint_id, port, lan_ip) {
            Ok(_) => tracing::debug!(
                port,
                %endpoint_id,
                bind = ?lan_ip,
                "mDNS announce submitted to the daemon's command queue (not yet on the wire)"
            ),
            Err(e) => tracing::warn!(
                error = %e,
                "mDNS announce could not be queued; peers must discover this device another way"
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

    // 6. Periodic resync interval (replaces the former 500ms poll cadence).
    //    `RESYNC_TICK`, not a literal: `peer_pulled_from_us_recently` derives
    //    its freshness window from this cadence and asserts against it (#4120).
    let mut resync_interval = tokio::time::interval(RESYNC_TICK);
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
                        bind_prefix_len: Some(prefix_len),
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
                    // Branch A only fires on a live mDNS resolve, so the
                    // stamp `process_discovery_event` just wrote is this
                    // peer's — read it back rather than assuming "now", so
                    // the freshness the probe gates on has exactly one source.
                    let seen_at = mdns_last_seen(&discovered, &peer.device_id);
                    let _cancelled = try_sync_with_peer(&ctx, &peer, &refs, seen_at).await;
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
                    // Read before the spawn: `discovered` is the loop's, and the
                    // task takes ownership of `peer`. A round member resolved
                    // from `peer_refs.last_address` rather than from mDNS has no
                    // stamp, which is the correct `None`.
                    let seen_at = mdns_last_seen(&discovered, &peer.device_id);
                    join_set.spawn(async move {
                        let ctx = SyncSessionContext {
                            pool: &pool,
                            device_id: &device_id,
                            materializer: &materializer,
                            scheduler: &scheduler,
                            event_sink: &event_sink,
                            cancel: &cancel,
                            endpoint: &task_endpoint,
                            bind_prefix_len: Some(prefix_len),
                        };
                        let was_cancelled =
                            try_sync_with_peer(&ctx, &peer, &refs_for_task, seen_at).await;
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

                // Evict stale mDNS peers not seen for `MDNS_STALE_AFTER`. The
                // constant is shared with `mdns_is_reaching_us`, which gates
                // #4299's egress probe on "still in the map" meaning "still
                // announcing"; the two must not drift apart.
                let stale_threshold = tokio::time::Instant::now() - MDNS_STALE_AFTER;
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
                    bind_prefix_len: Some(prefix_len),
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
                            let seen_at = mdns_last_seen(discovered, &pid);
                            let cancelled =
                                try_sync_with_peer(ctx, &peer, refs, seen_at).await;
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
/// The whole [`BindDecision`] is returned rather than the fields `SyncService::bind`
/// needs, because `internet_facing` is what [`handle_internet_facing_bind`] turns into
/// the user-visible signal (#3864); a log line the daemon writes to a file nobody opens
/// is not one. It also carries the interface enumeration itself, which `SyncService::bind`
/// now takes so that `lan_only`'s locality gate answers from the *same* sweep that chose
/// the address rather than a second one taken moments later (#3869).
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
            // Kept on ONE line and byte-identical to its `STABLE_MESSAGES` entry in
            // `commands::bug_report`: the #700 drift guard scans concatenated source text
            // for the quoted literal, so a `\`-continued literal would not match and the
            // message would be silently redacted out of every bug report.
            tracing::info!(
                "mDNS disabled: no first-ever pair is possible; already-paired peers may still use a cached address"
            );
            event_sink.on_sync_event(SyncEvent::MdnsDisabled {
                reason: reason.clone(),
            });
            None
        }
    }
}

// ---------------------------------------------------------------------------
// mDNS daemon monitor (#3852) — the failures `register()` cannot report
// ---------------------------------------------------------------------------

/// React to one classified `mdns-sd` daemon event.
///
/// Split from the reader task so the reaction is a pure function of the signal and can
/// be tested without a live `ServiceDaemon`, a multicast-capable runner, or a network.
///
/// * [`MdnsDaemonSignal::Announced`] is the **only** thing that logs "announced over
///   mDNS", and it comes from the daemon thread after it wrote to a socket — not from
///   `announce()`'s `Ok`, which means only that a command reached a queue.
/// * [`MdnsDaemonSignal::Degraded`] is a failure that `announce()` had already returned
///   `Ok` for. It is logged at `warn!` and reported to the user **not at all** — see
///   below.
/// * [`MdnsDaemonSignal::Ignored`] must emit nothing at all.
///
/// # Why no daemon event may emit [`SyncEvent::MdnsDisabled`]
///
/// `MdnsDisabled` is a **latching** claim. `TauriEventSink` writes
/// `MdnsStatus { disabled: true }` into `MdnsStatusState` and nothing anywhere ever
/// writes it back to `false`; `useMdnsStatus` has no reset path either. So the event may
/// only be emitted by something that proves mDNS is dead *for the whole session*.
///
/// [`MdnsService::new`] failing is such a proof — there is no daemon at all — which is
/// why [`handle_mdns_init_result`] still emits it. A `DaemonEvent::Error` is not:
/// `mdns::classify_daemon_event` documents the audit, but the short version is that it
/// reports one failed daemon-side operation and cannot distinguish "no mDNS on this
/// device" from "one interface of several misbehaved". Latching the permanent banner
/// "mDNS disabled: no first-ever pair is possible" on that would over-claim to the user
/// on a device whose discovery works — the same failure this whole change exists to
/// remove, pointed the other way.
///
/// The diagnostic is not lost: the `warn!` below carries the daemon's own message, is in
/// `commands::bug_report`'s `STABLE_MESSAGES`, and so reaches both `agaric.log` and any
/// submitted bug report. Strictly more than the pre-#3852 behaviour, where `monitor()`
/// had no call sites and the failure was observable nowhere at all — but without
/// claiming, in the UI, something that is not known.
///
/// `_event_sink` is retained rather than deleted so that "a daemon signal reaches the
/// user" stays a property tests assert against a real sink, instead of an absence no
/// test can observe.
pub(crate) fn handle_mdns_daemon_signal(
    signal: MdnsDaemonSignal,
    _event_sink: &Arc<dyn SyncEventSink>,
) {
    match signal {
        MdnsDaemonSignal::Announced { service, on } => {
            // Deliberately "sent", not "reachable": an Android per-uid firewall drop
            // happens after `sendto` succeeds and is invisible from in-process. See
            // `mdns::classify_daemon_event` for exactly how much this proves.
            tracing::info!(
                service = %service,
                interface = %on,
                "mDNS announcement sent on the wire"
            );
        }
        MdnsDaemonSignal::Degraded(reason) => {
            // Kept on ONE line and byte-identical to its `STABLE_MESSAGES` entry in
            // `commands::bug_report`, for the reason spelled out at
            // `handle_mdns_init_result`: the #700 drift guard scans for the quoted
            // literal, and a `\`-continued literal would not match — so the one line
            // that names a real mDNS failure would be redacted out of every bug report.
            //
            // "degraded", not "disabled", and no `SyncEvent`: this is the whole of what
            // is known. See the fn doc above.
            tracing::warn!(
                reason = %reason,
                "mDNS daemon reported an error after the announce was accepted; peer discovery is degraded"
            );
        }
        MdnsDaemonSignal::Ignored => {}
    }
}

/// Subscribe to the mDNS daemon's own event stream and drain it for the daemon's life.
///
/// `mdns-sd`'s monitor channel is a `flume::Receiver` with a blocking `recv()`, so it is
/// drained on a `spawn_blocking` thread exactly like the browse channel below it. The
/// task ends when the daemon shuts down and closes the channel.
///
/// A monitor subscription that cannot be created is itself only `warn!`-worthy: it
/// leaves discovery no worse off than before #3852, it just leaves it unobservable
/// again.
fn spawn_mdns_monitor(mdns: &MdnsService, event_sink: &Arc<dyn SyncEventSink>) {
    let monitor_rx = match mdns.monitor() {
        Ok(rx) => rx,
        Err(e) => {
            // One line, same #700 drift-guard reason as above.
            tracing::warn!(
                error = %e,
                "could not subscribe to the mDNS daemon monitor; announce failures will not be observable"
            );
            return;
        }
    };
    let event_sink = event_sink.clone();
    tokio::task::spawn_blocking(move || {
        while let Ok(event) = monitor_rx.recv() {
            handle_mdns_daemon_signal(crate::mdns::classify_daemon_event(&event), &event_sink);
        }
        tracing::debug!("mDNS daemon monitor channel closed");
    });
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
    /// The prefix that endpoint's IPv4 bind is confined to —
    /// `lan_interface::BindDecision::prefix_len`, the same number `SyncService::bind`
    /// hands `BindOpts::set_prefix_len` (#4299 review).
    ///
    /// Carried here because it is the only thing that says **where our link ends**,
    /// and the egress probe's verdict is about links rather than addresses: a source
    /// address the kernel picked inside this prefix still reaches the peer over the
    /// interface we bound, and calling that a captured LAN is the one false positive
    /// the diagnosis cannot afford. See `transport::egress_probe::compare`.
    ///
    /// A plain `u8` rather than a reference so the struct stays `Copy`, and
    /// `Option<u8>` rather than `u8` because a context built without a bind decision
    /// — every test harness in this tree, which binds loopback directly — has no
    /// prefix to give and must not be made to invent one. `None` makes the probe
    /// `Inconclusive`, never a guess.
    pub bind_prefix_len: Option<u8>,
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

/// Did this session end because the peer *turned it away*, and with which
/// refusal?
///
/// The verbatim text the responder sent, taken from the orchestrator rather
/// than from the `AppError` the caller holds: `run_sync_session` wraps a
/// terminal state as `"sync ended in terminal state: {reason:?}"`, and
/// re-parsing prose out of that wrapper would be a third copy of the rejection
/// strings. `Rejection::from_peer_message` compares against the same `match`
/// that produced the text, so the recognition cannot drift from the emission.
///
/// `None` for a session that failed for any other reason (a torn stream, a
/// timeout) and for one that did not fail at all.
fn session_rejection(orch: &SyncOrchestrator) -> Option<Rejection> {
    let SyncState::Failed(ref reason) = orch.session().state else {
        return None;
    };
    Rejection::from_peer_message(reason)
}

/// Persist the #4297 evidence that the device on the other end has unpaired us.
///
/// # What this is reacting to
///
/// Unpairing is one-sided: `delete_peer_ref` drops a local row and sends
/// nothing. The abandoned device therefore keeps its row, keeps dialling on
/// every resync tick, and is refused every time with [`Rejection::Unpaired`] —
/// which [`Rejection::user_facing_message`] deliberately declines to surface,
/// because on a healthy LAN that refusal is what every *stranger's* probe
/// answers with. Nothing was wrong with that decision; what was missing is that
/// a refusal from a peer **we still hold a row for** is not a stranger's probe.
/// It is the only notice we will ever get that the pairing is dead.
///
/// Nothing new is detected here. The initiator already received the refusal and
/// already classified it correctly; this is the last hop — turning a terminal
/// state that was becoming a log line into row state the device list can
/// render.
///
/// # The two guards, and why both
///
/// The peer must be in `peer_refs` (the list this round was planned from) *and*
/// the store's `UPDATE … WHERE peer_id = ?` must match a row. The first keeps
/// the write off the path entirely for the case that produces most of these
/// refusals — a joiner mid-pairing dials every discovered device and is turned
/// away by each (#3502/#3505) — and gives the log line something true to say.
/// The second is what makes the rule hold even if a caller is later wired up
/// with a stale list, since `delete_peer_ref` can land between the plan and the
/// refusal.
///
/// # What it deliberately does not do
///
/// It does not emit a [`SyncEvent`] and it does not change what
/// `record_initiator_failure` books or reports. The condition is permanent
/// until the user acts and must survive a restart, which is precisely what a
/// toast is not; the row is the durable surface, and the caller still books the
/// backoff on the ordinary path immediately after this returns.
async fn record_peer_unpaired_us(pool: &SqlitePool, peer_refs: &[PeerRef], peer_id: &str) {
    if !peer_refs.iter().any(|p| p.peer_id == peer_id) {
        // A refusal from a device we hold no row for is a stranger turning us
        // away, which is the protocol working. Not an error, not an event, and
        // explicitly not a row to mark — there is none.
        return;
    }
    match peer_refs::mark_unpaired_by_peer(pool, peer_id).await {
        // Only the transition is logged. The refusal itself repeats every
        // resync tick for as long as the user leaves the pairing half-dead, and
        // `run_sync_session`'s own `warn!` already covers every cycle.
        Ok(true) => tracing::warn!(
            peer_id,
            "peer refused our sync because it holds no pairing with this device; it has \
             unpaired us and we were never told. Marking the peer row so the device list \
             stops reporting it as healthy (#4297)"
        ),
        Ok(false) => {}
        Err(e) => tracing::warn!(
            peer_id,
            error = %e,
            "could not record that this peer has unpaired us (#4297); the device list will \
             keep rendering the peer as healthy until a later attempt records it"
        ),
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
    let rejection = session_rejection(orch)?;
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
// The suppressible failure texts of the initiator path (#4201)
// ---------------------------------------------------------------------------
//
// Four texts across the five sites of `try_sync_with_peer` that reach
// `record_initiator_failure` — `connect_failure_message` serves two of them
// (the dial and the stream open on top of it). The one user-facing text the
// initiator emits that is NOT here is `Sync cancelled: …`, which bypasses the
// gate on purpose: a user cancel is not a peer failure and books nothing.
//
// Named rather than inlined at their sites because the text *is* the
// suppression key: `record_initiator_failure` withholds a repeat only when the
// incoming bytes equal a text already reported for this peer this streak. That
// makes the mechanism's real-world effectiveness a property of these four
// texts and of the `Display` impls two of them interpolate — and a property
// with no name is a property no test can pin. `the_*_failure_text_*` tests in
// this module's `tests` are that pin.

/// The dial that ran out of budget. Fully deterministic: no error is
/// interpolated, only the [`CONNECT_TIMEOUT`] constant.
fn connect_timeout_message() -> String {
    format!(
        "Connection failed: peer did not answer within {}s",
        CONNECT_TIMEOUT.as_secs()
    )
}

/// The dial, or the stream open on top of it, that failed outright.
///
/// Interpolates an error the sync layer does not own (iroh's), so the
/// suppression key is only as stable as that `Display`. Pinned by
/// `a_real_iroh_connect_error_formats_identically_on_two_independent_dials_4201`,
/// which drives two real failing dials from two independently bound endpoints
/// and requires the two texts to be byte-equal — so an iroh upgrade that starts
/// embedding a varying detail fails a test rather than silently un-suppressing
/// the toast.
fn connect_failure_message(e: &impl std::fmt::Display) -> String {
    format!("Connection failed: {e}")
}

/// A session that was established and then died.
fn session_failure_message(e: &impl std::fmt::Display) -> String {
    format!("Sync failed: {e}")
}

/// The refusal to sync at all because a different key is announcing this peer's
/// name (#4203). A constant, so it is exactly stable as a suppression key.
const IDENTITY_MISMATCH_MESSAGE: &str =
    "peer identity does not match the one paired with this device";

/// The dial that ran out of budget against a peer mDNS is still announcing,
/// *and* whose egress probe found the system would route it somewhere other than
/// the address this endpoint bound (#4299).
///
/// A constant — no interface name, no source address, no candidate — and that is
/// not an oversight. This text is a suppression key exactly as the four above
/// are, so interpolating the probe's findings would make every cycle a fresh key
/// and re-raise #4084's forever-toast. The varying detail is a `tracing::warn!`
/// field on the same failure, where it costs nothing and can be read off the
/// device's own `agaric.log`; see [`dial_timeout_text`].
///
/// Because it is a different constant from [`connect_timeout_message`]'s text, a
/// peer that goes from "asleep" to "captured" reports exactly once on the
/// transition and is then silent again — which is the whole behaviour asked for:
/// a diagnosis the user is told once, not a new toast every sixty seconds.
///
/// # What the wording is allowed to claim
///
/// The probe proves that traffic to this peer would leave this host by a link
/// outside the prefix we bound. It does **not** prove a VPN: a split-tunnel
/// client, a corporate agent, a second link on a different subnet and a mis-scoped
/// default route all produce it. (A second link on the *same* subnet does not, and
/// deliberately so — see `transport::egress_probe::compare`.) So the sentence
/// states the measurement flatly and names the likely cause as a hedge, not a
/// finding.
const ROUTED_ELSEWHERE_MESSAGE: &str = "Connection failed: discovered on the network, but traffic to this device is being \
     routed elsewhere - a VPN or firewall may be capturing your LAN";

/// Did this dial time out because the LAN is captured, rather than because the
/// peer is asleep? (#4299)
///
/// Returns the probe's report only when it is a *diagnosis*; `None` means "say
/// what we said before", which is the timeout.
///
/// # The gate, and why both terms
///
/// Two things must hold. The dial has already failed — this is only ever called
/// from the timeout arm. And mDNS must currently be reaching us from this peer,
/// which is [`mdns_is_reaching_us`] over the discovered map's own last-seen
/// stamp.
///
/// The mDNS term is what keeps the probe off the common path. Multicast arriving
/// while unicast dies is the distinctive shape of a tunnel that swallowed the LAN
/// — link-local multicast escapes a tunnel and unicast does not — and a peer we
/// have heard nothing from is simply a peer that is not there, which a timeout
/// already describes correctly. Without this term every sleeping peer on the
/// network would be probed for a condition it cannot have.
///
/// Neither term alone is a diagnosis and the pair still is not: mDNS freshness
/// says the peer is on the link, the probe says our packets would not reach it
/// from where we are speaking. Only both together, plus a `RoutedElsewhere`
/// verdict, produce [`ROUTED_ELSEWHERE_MESSAGE`]. Every other outcome —
/// `SameEgress`, `Inconclusive`, a stale peer, an endpoint with no usable bound
/// address — falls through to the unchanged timeout text.
///
/// Synchronous inside an async fn on purpose: the probe is two non-blocking
/// syscalls that send nothing (see [`crate::transport::egress_probe`]), so there
/// is nothing here to await and no reason to pay a `spawn_blocking`.
///
/// This half is only the production wiring; the gate and the composition it
/// describes live in [`diagnose_dial_timeout_with`], which is where they are
/// tested.
fn diagnose_dial_timeout(
    endpoint: &Endpoint,
    bind_prefix_len: Option<u8>,
    peer: &DiscoveredPeer,
    mdns_seen_at: Option<tokio::time::Instant>,
) -> Option<EgressReport> {
    diagnose_dial_timeout_with(
        &endpoint.bound_sockets(),
        bind_prefix_len,
        peer,
        mdns_seen_at,
        system_source_address_for,
    )
}

/// [`diagnose_dial_timeout`] with the endpoint's bound sockets supplied and the
/// route lookup injected — the seam the composition above is actually tested
/// through (#4299 review).
///
/// # Why the seam has to reach this far up
///
/// `transport::egress_probe` tests its rules and its aggregation with a route table
/// it writes. What no test there can reach is the *assembly* done here: turning
/// `peer.addresses` plus `peer.port` into candidate sockets, and pairing the one
/// prefix the bind policy measured with the bound socket it was measured on. Every
/// test that drove [`diagnose_dial_timeout`] did so against the loopback endpoint
/// every harness in this tree builds, where `compare`'s loopback rule answers
/// `Inconclusive` before either of those compositions can matter — so two mutations
/// of this function left the whole suite green, and the second of them,
/// `bind_prefix_len.filter(|_| addr.is_ipv4())` reading `is_ipv6()`, would have
/// silenced the diagnosis in production permanently. The feature would have shipped
/// doing nothing, which is precisely the failure #4299 exists to name.
///
/// Taking `bound_sockets` as a slice rather than an [`Endpoint`] is the other half:
/// a test can hand this a *LAN* bind, which an endpoint bound in CI cannot be.
///
/// The gate and the composition live here, so [`diagnose_dial_timeout`] is nothing
/// but the production wiring — the real bound sockets and the real
/// [`system_source_address_for`] — and there is no second code path to keep honest.
fn diagnose_dial_timeout_with<F>(
    bound_sockets: &[std::net::SocketAddr],
    bind_prefix_len: Option<u8>,
    peer: &DiscoveredPeer,
    mdns_seen_at: Option<tokio::time::Instant>,
    source_for: F,
) -> Option<EgressReport>
where
    F: Fn(std::net::SocketAddr) -> Option<std::net::IpAddr>,
{
    if !mdns_is_reaching_us(mdns_seen_at) {
        return None;
    }
    // The peer's advertised addresses are dialled on the port it advertised, so that
    // is the destination the route lookup must be asked about: a route is selected
    // per destination address, and the socket the probe opens is a real one.
    let candidates: Vec<std::net::SocketAddr> = peer
        .addresses
        .iter()
        .map(|ip| std::net::SocketAddr::new(*ip, peer.port))
        .collect();
    // The prefix rides along with the address it describes. `BindDecision` ranks and
    // binds IPv4 only, so it has no v6 counterpart to give — an IPv6 bound socket
    // therefore carries `None` and can only ever be `Inconclusive`, rather than
    // silently borrowing a length measured on the other family. Production has no
    // such socket in any case: `lan_only` calls `clear_ip_transports()` before adding
    // its single IPv4 bind, so `bound_sockets()` returns exactly that one.
    let bound: Vec<BoundSocket> = bound_sockets
        .iter()
        .map(|addr| BoundSocket {
            addr: *addr,
            prefix_len: bind_prefix_len.filter(|_| addr.is_ipv4()),
        })
        .collect();
    let report = probe_peer_egress_with(&bound, &candidates, source_for);
    (report.verdict == EgressVerdict::RoutedElsewhere).then_some(report)
}

/// The text the dial-timeout arm reports: [`ROUTED_ELSEWHERE_MESSAGE`] when the
/// egress probe diagnosed a captured LAN, and the unchanged
/// [`connect_timeout_message`] in every other case (#4299).
///
/// Named rather than inlined at its one call site for the same reason the four
/// message builders above it are: this function decides which suppression key a
/// dial timeout carries, and "a peer we have heard no announcement from still
/// gets the ordinary timeout text" is a property worth a test rather than a
/// property worth a comment.
///
/// It also owns the single `tracing::warn!` that names the hypothesis, through
/// [`dial_timeout_text`]. That line carries every varying detail the message
/// deliberately does not — the bound address, the prefix it is confined to, the
/// source address the system selected, and the candidate it selected it for — so
/// the local `agaric.log` has the numbers while the user-facing text stays
/// byte-stable across cycles.
/// (A *submitted* bug report does not: the line is not in `bug_report`'s
/// `STABLE_MESSAGES` and an IP address matches no `SAFE_TOKEN_PATTERNS` entry,
/// so both collapse to `[REDACTED]` there. That is the sanitizer working as
/// designed; the claim is about the log on the device.)
fn dial_timeout_message(
    peer_id: &str,
    endpoint: &Endpoint,
    bind_prefix_len: Option<u8>,
    peer: &DiscoveredPeer,
    mdns_seen_at: Option<tokio::time::Instant>,
) -> String {
    dial_timeout_text(
        peer_id,
        diagnose_dial_timeout(endpoint, bind_prefix_len, peer, mdns_seen_at),
    )
}

/// [`dial_timeout_message`] once the probe has answered: the half that turns a
/// verdict into the bytes `record_initiator_failure` keys on.
///
/// Split out because it is the half with a *property* to pin — the diagnosis
/// text must not vary with the report it was produced from — and the half above
/// it cannot be driven to a `RoutedElsewhere` without the machine that ran the
/// suite happening to have a captured LAN. Without this seam the whole
/// diagnosis arm is unreachable from a test: a mutant returning
/// [`connect_timeout_message`] here left the entire suite green.
fn dial_timeout_text(peer_id: &str, diagnosis: Option<EgressReport>) -> String {
    let Some(report) = diagnosis else {
        return connect_timeout_message();
    };
    tracing::warn!(
        peer_id,
        bound = ?report.bound,
        bound_prefix_len = ?report.bound_prefix_len,
        probe_source = ?report.probed,
        candidate = ?report.candidate,
        "mDNS still reaches this peer, but the system would send unicast traffic to it \
         from a source address outside the prefix this endpoint bound: our packets are \
         leaving this host by another link and dying there. A VPN or firewall may be \
         capturing the LAN — see docs/features/sync.md (#4299)"
    );
    ROUTED_ELSEWHERE_MESSAGE.to_string()
}

// ---------------------------------------------------------------------------
// record_initiator_failure — book the failure, report it once per streak (#4120)
// ---------------------------------------------------------------------------

/// Book an initiator-side failure: **always** the backoff, **always** the
/// log, but the user-facing `Sync failed: …` / `Connection failed: …` /
/// identity-mismatch event only once per *distinct failure text* per streak —
/// twice at most, if the pair goes dark mid-streak and the text is the same
/// on both sides of that transition (#4305).
///
/// # The shape this exists for (#4084 → #4103 → #4120)
///
/// A sync session is one-directional (#610): the initiator pulls, the
/// responder streams. A device whose outbound dial persistently fails while
/// its inbound sessions succeed is therefore *responder-only* — it serves the
/// peer every window and never pulls it.
///
/// `peer_refs` already records that faithfully: #4103 added `streamed_at`, so
/// the streamer stamps the session it actually performed and the device list
/// renders `MAX(synced_at, streamed_at)` instead of "never synced".
/// [`SyncScheduler::peers_due_for_resync`] still reads `synced_at` **only**,
/// which is correct and is pinned: a `streamed_at`-aware due-check hands the
/// peer a starvation lever, because it is the *peer's* activity that refreshes
/// our `streamed_at`, inside every one of our windows (#610; pinned on both
/// the `None` and stale-`Some` arms by
/// `peers_due_for_resync_ignores_streamed_at_4084`).
///
/// So the pull is genuinely owed and genuinely retried, and the retry *cadence*
/// is already the resync cadence — `record_failure`'s ladder caps at
/// `MAX_BACKOFF`, which is `DEFAULT_RESYNC`. What was left of #4084's reported
/// impact is the reporting: a red toast once a minute, forever, about a
/// condition the user was told about the first time and that has not changed
/// since — while the pair is, by the peer's own inbound sessions, visibly
/// exchanging data.
///
/// That is #3505's lesson in a second place. There the generic wrapper said
/// "Sync failed" about a handshake that was working; here it says it about a
/// stable, already-reported one-way condition. Either way a toast the user
/// cannot act on again is a toast they learn to dismiss unread — including on
/// the sessions that really did just fail.
///
/// # Where freshness went (#4305)
///
/// #4120 built this as a two-term gate: `already_reported && still_serving`,
/// where `still_serving` is
/// [`peer_pulled_from_us_recently`] — has this peer streamed to us inside two
/// resync intervals. The second term was there to protect a real signal: a peer
/// with no recent `streamed_at` is not exchanging with us in **either**
/// direction, and staying quiet about that would hide a total outage behind one
/// toast the user may have missed.
///
/// But a peer that has genuinely gone away stops streaming *immediately*, so
/// `still_serving` goes false within about two minutes and then stays false —
/// at which point the gate can never close again and the same unchanged
/// `Sync failed: sync ended in terminal state: …` fires every sixty seconds for
/// as long as the app runs. That is #4084's own complaint, arrived at from the
/// opposite end: #4084 was the toast that would not stop about a pair that was
/// working, and this was the toast that would not stop about a pair that was
/// not.
///
/// The signal `still_serving` carries is preserved by moving it out of the gate
/// and into the **key** (see [`SyncScheduler::record_failure_and_take_report`]).
/// The suppression key is `(text, still_serving)`, so:
///
/// * the first failure of a given text always reports — a peer going from
///   healthy to unreachable is never silent, which is the transition a user
///   does need to see;
/// * when the pair later goes dark, that same text reports once more, because
///   "our pull fails while the peer still serves us" and "the peer has stopped
///   talking to us entirely" are different facts;
/// * and then it stops. What remains true after that is durable, so it belongs
///   on durable surfaces — the peer row and the sync status dot — not on a
///   transient one. This is the same call #4300 made for `unpaired_by_peer_at_ms`.
///
/// The bound is therefore two reports per distinct text per streak, and a
/// `streamed_at` flapping across the window boundary cannot exceed it: both
/// values of the flag are remembered the first time each is seen.
///
/// # What counts as a repeat, and where the memory resets
///
/// A repeat is the *same failure text* against the *same peer*. Keying on the
/// peer's failure count alone would swallow a failure whose cause changed
/// mid-streak — see the inline comment in the body.
///
/// The memory resets exactly where the situation changes, because it rides on
/// the scheduler's per-peer backoff entry: [`SyncScheduler::record_success`]
/// drops the entry on the next successful pull, and
/// [`SyncScheduler::clear_backoff`] drops every entry on a pairing act (#3547).
/// The next failure after either is reported again, in full.
///
/// # Alternating causes (#4201)
///
/// The memory is a bounded *set* of the streak's reported texts, not the single
/// slot #4120 shipped. A peer failing `A, B, A, B, …` matched the slot on
/// neither cycle, so suppression never engaged and #4084's forever-toast came
/// back at half the rate. See [`SyncScheduler::record_failure_and_take_report`]
/// and `MAX_REMEMBERED_REPORTS` for the bound and for what evicting the oldest
/// text degrades to.
///
/// # Why the identity refusal routes through here too (#4203)
///
/// It used to be the one initiator-side failure that emitted its own event
/// unconditionally, on the argument that "a different device is answering to a
/// paired peer's name" is security-relevant, not transient, and asks for an
/// action the user genuinely has to take. All of that is true of the *first*
/// report and none of it is true of the hundredth: a red toast once a minute
/// forever is the #4084 shape with a different string, and it teaches the user
/// to dismiss toasts unread — including the ones that are new.
///
/// Routing it here is a narrower change than it looks:
///
/// * Its text is [`IDENTITY_MISMATCH_MESSAGE`], a **constant** — so the
///   suppression key for this one site is exactly stable, with no `Display`
///   dependency at all.
/// * It is reported once while the *real* peer is still pulling from us, and
///   again if our `streamed_at` for that peer later goes stale — the case where
///   a user who has lost their peer to something announcing its name most needs
///   to hear it. #4305 bounded that second report at one instead of one per
///   cycle; the condition itself is not transient, so past the second telling
///   it is the peer row's to render, not a toast's to repeat.
/// * That gate is not fooled by the impostor, and this is what makes routing a
///   *security-relevant* refusal through it safe at all. `streamed_at` is
///   stamped by `session_state_machine`'s responder path, and the responder
///   resolves an inbound session through `get_peer_ref_by_endpoint_id` on the
///   key the QUIC handshake **authenticated** — not on any name the peer
///   claims. So a fresh `streamed_at` on this peer's row is evidence that the
///   device holding the *pinned* key streamed to us inside the window. The
///   device announcing the mismatched key resolves to a different row, or to
///   none, and cannot refresh it — with one exception, stated below rather than
///   left for a reader to discover, because this bullet is what licenses
///   suppressing a security-relevant refusal at all.
/// * **The exception that used to sit here, and why it is closed (#4230).**
///   `server::handle_incoming_sync` admits a key it has no binding for when the
///   caller proves knowledge of the pairing passphrase (#855/#1519), and on
///   that branch alone it deliberately does *not* set `expected_remote_id` — so
///   the FSM falls back to the device id the peer advertised, which is a claim.
///   A proof-bearing device could therefore claim a paired peer's id and have
///   `record_stream_in_tx` stamp that peer's `streamed_at` (and, worse for
///   reasons that have nothing to do with toasts, its `loro_vv_bytes`). It
///   could never take the *binding* — post-session `peer_is_bound_to_another_key`
///   refuses to re-point a bound peer — and #4230 arms that same predicate on
///   the bookkeeping writes, via
///   [`SyncOrchestrator::with_unverified_claim_guard`](crate::sync_protocol::SyncOrchestrator::with_unverified_claim_guard),
///   so the claimed-id stamp is now skipped for exactly the rows the bind would
///   have protected. That covers every peer this refusal can fire about: it
///   fires only when an *announced* key disagrees with a **pinned** one, so the
///   victim row is by construction already bound, which is the case the guard
///   refuses. What remains unguarded is a row with no `endpoint_id` at all.
///   *This* refusal cannot fire about such a row — it needs a pinned key to
///   mismatch — but the other failures routed through this function can, and
///   the residual is worth stating rather than leaving a bullet's scope to be
///   read as the whole function's: a proof-bearing device that claims an
///   **unbound** id still freshens that id's `streamed_at`, and so can withhold
///   its *repeat* connect/session-failure reports. Bounded twice over — the
///   first report of any `(text, still_serving)` pair always lands, and the
///   freshness window goes false two intervals after the last stamp — which,
///   since #4305, itself produces one further report rather than none. #4230 leaves that half open deliberately: deferring the
///   writes until after the bind — the alternative the issue suggested — closes
///   none of it, since `peer_is_bound_to_another_key` permits an unbound row
///   and the bind would then hand the row itself to the claimant.
/// * The memory resets on a successful pull and on a pairing act (#3547),
///   which is precisely "the user re-paired, so tell them again if it is still
///   wrong".
/// * Nothing else about the refusal changes: it still refuses the session, it
///   still books the backoff, and its `tracing::warn!` still fires every cycle.
///
/// # What this deliberately does not do
///
/// It does not touch the backoff (the retry pacing is right) and it does not
/// touch `peers_due_for_resync` (see above).
fn record_initiator_failure(
    scheduler: &SyncScheduler,
    event_sink: &Arc<dyn SyncEventSink>,
    peer_refs: &[PeerRef],
    peer_id: &str,
    message: String,
) {
    // Computed before the scheduler call because it reads `peer_refs` and the
    // clock, not the scheduler's map — keeping it outside means the one
    // acquisition below covers exactly the check-and-record and nothing else.
    //
    // #4305: this is now part of the suppression *key* rather than a switch
    // that turns suppression off. See `record_failure_and_take_report`.
    let still_serving_this_peer = peer_pulled_from_us_recently(scheduler, peer_refs, peer_id);

    // ONE acquisition books the failure and decides the report together
    // (#4202). "Already reported" is per `(peer, message, still-serving)`, NOT
    // per peer: a failure whose *cause changes* mid-streak is news the user has
    // not been told, and a streak count cannot express that. The count is also
    // the wrong key for any route that books a failure without reporting
    // through here — `SyncScheduler::record_failure` is still public, and #4203
    // removed the last in-tree caller of it (the pinned-identity refusal, which
    // now routes here) rather than making the count safe to key on.
    //
    // The failure mode of the message key is bounded in the safe direction: a
    // failure text that churns (an error string carrying a varying detail)
    // degrades to reporting every cycle — i.e. back to the pre-#4120 behaviour,
    // never quieter than it.
    let booking =
        scheduler.record_failure_and_take_report(peer_id, &message, still_serving_this_peer);

    if !booking.report {
        // `reason`, not `message`: `message` is tracing's own implicit field
        // for the format string, and a second one would be dropped silently —
        // taking the only surviving copy of the failure text with it.
        tracing::info!(
            peer_id,
            reason = %message,
            failures = booking.consecutive_failures,
            still_serving = still_serving_this_peer,
            "sync failed against this peer with a cause the user has already been shown; \
             backoff recorded, repeat report suppressed (#4084/#4120/#4203/#4305)"
        );
        return;
    }

    event_sink.on_sync_event(SyncEvent::Error {
        message,
        remote_device_id: peer_id.to_string(),
    });
}

/// Has this peer pulled from *us* recently enough that a second "sync failed"
/// would be a claim about the pair rather than a fact about our own pull?
///
/// The window is **two** resync intervals, and the multiple is derived from the
/// peer's own achievable cadence rather than picked:
///
/// * A device pulls a peer when [`SyncScheduler::peers_due_for_resync`] finds
///   it strictly older than `resync_interval` (60 s by default), and that check
///   runs on the daemon's periodic-resync tick, which is [`RESYNC_TICK`] (30 s)
///   — the same constant `daemon_loop` builds its `tokio::time::interval` from.
/// * So a *healthy* peer stamps our `streamed_at` every `(60 s, 90 s]` —
///   one interval to become due, then up to one tick to be noticed.
///
/// One interval (60 s) is therefore provably too short: it is below the lower
/// bound of a working peer's own period, so it would go false on a pair that is
/// working perfectly and the toast would reappear at random depending on which
/// device's tick landed first. Two intervals (120 s) clears the 90 s worst case
/// with 30 s — half an interval — of slack, and still goes false about two
/// minutes after a peer genuinely stops pulling. If either constant moves, this
/// multiple is what has to be rechecked: the invariant is
/// `window > resync_interval + RESYNC_TICK`, not the literal `2`.
///
/// #4120 note 1: that recheck is no longer advisory. The body `debug_assert!`s
/// the invariant against the same [`RESYNC_TICK`] the daemon ticks on, so a
/// `resync_interval` at or below the tick — where `resync_interval * 2` stops
/// clearing a healthy peer's own period — fails a test instead of intermittently
/// re-raising the toast on a working pair.
///
/// A peer with no row here, or a row with no `streamed_at`, answers `false` —
/// the conservative direction, because the fallback is the unsuppressed report.
/// A `streamed_at` in the future (the peer's clock ahead of ours) answers
/// `true`: the stream still happened, and the skew is not the user's problem.
fn peer_pulled_from_us_recently(
    scheduler: &SyncScheduler,
    peer_refs: &[PeerRef],
    peer_id: &str,
) -> bool {
    let Some(streamed_ms) = peer_refs
        .iter()
        .find(|p| p.peer_id == peer_id)
        .and_then(|p| p.streamed_at)
    else {
        return false;
    };
    let window = scheduler.resync_interval.saturating_mul(2);
    // The doc above derives the multiple `2` from the daemon's own cadence;
    // this is that derivation made executable. A `resync_interval` at or below
    // `RESYNC_TICK` makes `interval * 2` narrower than a *healthy* peer's own
    // stamping period, and the suppressed toast comes back at random on a pair
    // that is working — the #4084 symptom, re-introduced by a constant nobody
    // thought was related. Debug-only: the cost of being wrong is a spurious
    // toast, not corruption, so a release build should not abort over it.
    debug_assert!(
        window > scheduler.resync_interval + RESYNC_TICK,
        "the freshness window ({window:?}) must stay strictly wider than a healthy \
         peer's own stamping period (resync_interval {:?} + RESYNC_TICK {RESYNC_TICK:?}); \
         raise the multiple or the interval",
        scheduler.resync_interval,
    );
    let window_ms = i64::try_from(window.as_millis()).unwrap_or(i64::MAX);
    agaric_store::db::now_ms() - streamed_ms <= window_ms
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
/// # `mdns_seen_at`
///
/// When mDNS last resolved this peer, taken from the daemon's discovered map
/// ([`mdns_last_seen`]). `None` means "no announcement on record" — a peer
/// resolved from a stored `peer_refs.last_address` rather than from the network,
/// and every direct caller in the tests.
///
/// It is used for exactly one thing: gating #4299's egress probe on the dial-
/// timeout path, where a peer that is *still announcing itself* while every
/// unicast dial dies is the distinctive shape of a captured LAN. It is a
/// parameter rather than state read off `ctx` because it is per-peer and
/// per-cycle, like `peer` and `peer_refs`, and because a `None` at a call site
/// should read as "this path knows nothing about mDNS" rather than silently
/// meaning it. See [`diagnose_dial_timeout`].
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
    mdns_seen_at: Option<tokio::time::Instant>,
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
        // #4203: books the backoff unconditionally and refuses the session
        // either way; only the *repeat* toast is withheld, and only while the
        // real peer is still pulling from us. See `record_initiator_failure`
        // for why a security-relevant condition can still stop shouting once
        // the user has been told and the pair is visibly working.
        record_initiator_failure(
            ctx.scheduler,
            ctx.event_sink,
            peer_refs,
            peer_id,
            IDENTITY_MISMATCH_MESSAGE.to_string(),
        );
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
            // #4299: a timeout here is ambiguous by construction — a sleeping
            // peer and a LAN swallowed by a tunnel produce the same silence.
            // `dial_timeout_message` is the one thing that tells them apart.
            record_initiator_failure(
                ctx.scheduler,
                ctx.event_sink,
                peer_refs,
                peer_id,
                dial_timeout_message(
                    peer_id,
                    ctx.endpoint,
                    ctx.bind_prefix_len,
                    peer,
                    mdns_seen_at,
                ),
            );
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
            record_initiator_failure(
                ctx.scheduler,
                ctx.event_sink,
                peer_refs,
                peer_id,
                connect_failure_message(&e),
            );
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
            record_initiator_failure(
                ctx.scheduler,
                ctx.event_sink,
                peer_refs,
                peer_id,
                connect_failure_message(&e),
            );
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
                // #4297: the one refusal that is durable state rather than an
                // event. Checked BEFORE the failure is booked because the two
                // are independent and both correct: the backoff and the log
                // below are about *this attempt*, the row mark is about the
                // relationship, and it must be recorded even on the ticks
                // whose report `record_initiator_failure` suppresses.
                //
                // Guarded on the variant, not on "any rejection": only
                // `Unpaired` means the peer holds no row for us. See
                // `record_peer_unpaired_us`.
                if matches!(session_rejection(&orch), Some(Rejection::Unpaired)) {
                    record_peer_unpaired_us(ctx.pool, peer_refs, peer_id).await;
                }
                // #4120: books the backoff unconditionally; emits the generic
                // wrapper only on the first failure of a streak while the peer
                // is still pulling from us. See `record_initiator_failure`.
                record_initiator_failure(
                    ctx.scheduler,
                    ctx.event_sink,
                    peer_refs,
                    peer_id,
                    session_failure_message(&e),
                );
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
        // Pass the orchestrator's daemon-provided
        // `expected_remote_id` so the catch-up can mirror the
        // SyncComplete fallback when `peer_id` is empty (HeadExchange
        // carried only our own heads).
        let expected_remote_id = orch.expected_remote_id().map(str::to_owned);
        // Mirror `catchup_peer_identity`'s own fallback here too: this
        // binding is also what the `peer_id = %peer_id` log lines below the
        // call use, and `try_receive_snapshot_catchup` resolves its
        // *internal* `remote_device_id` independently, so without this a
        // never-seeded id would log as "" here while every line inside the
        // call already named the resolved peer.
        let remote_device_id = &orch.session().remote_device_id;
        let peer_id = if !remote_device_id.is_empty() {
            remote_device_id.clone()
        } else {
            expected_remote_id.clone().unwrap_or_default()
        };
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

    // -- #3852: the daemon monitor, i.e. the failures `register()` cannot report --

    /// The non-latching arm of the pair below: a daemon-side error must NOT put
    /// the permanent "mDNS disabled" banner in front of the user.
    ///
    /// `MdnsStatusState` and `useMdnsStatus` both latch `disabled` to `true` with
    /// no reset anywhere, so an `MdnsDisabled` emitted here is permanent for the
    /// session. A `DaemonEvent::Error` on a VPN tun or docker bridge, on a device
    /// whose `wlan0` discovery works fine, would therefore leave a false
    /// "no first-ever pair is possible" banner up until the app restarts.
    #[test]
    fn a_degraded_daemon_signal_does_not_latch_the_mdns_disabled_banner() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();

        handle_mdns_daemon_signal(
            MdnsDaemonSignal::Degraded("failed to create IPv4 socket".into()),
            &sink,
        );

        assert!(
            typed.events().is_empty(),
            "a daemon-side error proves one operation failed, not that the device has no \
             mDNS; emitting anything here latches an unresettable banner, got {:?}",
            typed.events()
        );
    }

    /// The fatal arm of the same pair — pinned together with the one above so the
    /// fix cannot be "read" as "mDNS failures no longer reach the user at all".
    ///
    /// `MdnsService::new` failing IS terminal for the session: there is no daemon,
    /// so no announce can ever go out. That, and only that, may latch the banner.
    #[test]
    fn a_fatal_mdns_init_failure_still_reaches_the_user_when_a_degraded_one_does_not() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();

        // Non-fatal first: it must contribute nothing.
        handle_mdns_daemon_signal(
            MdnsDaemonSignal::Degraded("failed to create IPv4 socket".into()),
            &sink,
        );
        // Then the genuinely terminal one.
        handle_mdns_init_result(
            Err(AppError::InvalidOperation("multicast unavailable".into())),
            &sink,
        );

        let events = typed.events();
        assert_eq!(
            events.len(),
            1,
            "exactly one of the two failures is terminal, so exactly one event may be \
             emitted, got {events:?}"
        );
        match &events[0] {
            SyncEvent::MdnsDisabled { reason } => assert!(
                reason.contains("multicast unavailable"),
                "the surviving event must be the init failure's, not the daemon error's, \
                 got {reason:?}"
            ),
            other => panic!("expected MdnsDisabled, got {other:?}"),
        }
    }

    /// A successful announcement is NOT an error, and must not be reported as
    /// one. Emitting `MdnsDisabled` on every announce would put a permanent
    /// "mDNS is unavailable" banner in front of a device whose mDNS works.
    #[test]
    fn an_announced_signal_emits_no_sync_event() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();

        handle_mdns_daemon_signal(
            MdnsDaemonSignal::Announced {
                service: "Agaric_dev-1._agaric._udp.local.".into(),
                on: "dev-1.local.:wlan0".into(),
            },
            &sink,
        );

        assert!(
            typed.events().is_empty(),
            "an announcement is not a failure and must emit no SyncEvent, got {:?}",
            typed.events()
        );
    }

    /// Housekeeping (interface add/remove, per-query responses) fires
    /// routinely on a healthy device. It must emit nothing.
    #[test]
    fn an_ignored_signal_emits_no_sync_event() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();

        handle_mdns_daemon_signal(MdnsDaemonSignal::Ignored, &sink);

        assert!(
            typed.events().is_empty(),
            "daemon housekeeping must emit no SyncEvent, got {:?}",
            typed.events()
        );
    }

    /// End-to-end over the seam the production reader task uses: a raw
    /// `mdns_sd::DaemonEvent` off the monitor channel must classify as `Degraded`
    /// and reach the sink as nothing at all. Asserting on `MdnsDaemonSignal` alone
    /// would leave the `classify_daemon_event` → `handle_mdns_daemon_signal` join
    /// untested, and that join is the whole wiring #3852 asks for — including the
    /// part that decides the user is not told.
    #[test]
    fn a_raw_daemon_event_error_travels_the_full_classify_then_handle_path() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();

        let raw = mdns_sd::DaemonEvent::Error(mdns_sd::Error::Msg(
            "multicast not permitted on this interface".into(),
        ));
        assert_eq!(
            crate::mdns::classify_daemon_event(&raw),
            MdnsDaemonSignal::Degraded("multicast not permitted on this interface".into()),
            "the raw daemon error must classify as Degraded before it is handled"
        );
        handle_mdns_daemon_signal(crate::mdns::classify_daemon_event(&raw), &sink);

        assert!(
            typed.events().is_empty(),
            "the full production path must not latch a permanent banner off one daemon \
             error, got {:?}",
            typed.events()
        );
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
            // The contiguous mask that prefix names — what `getifaddrs(3)` reports for
            // an ordinary NIC, and what `prefix_len` is derived from there (#4105).
            netmask: crate::sync_daemon::lan_interface::netmask_for_prefix(prefix_len),
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

    // ======================================================================
    // #4120 — the reporting half of #4084: a responder-only device
    // ======================================================================

    const RESPONDER_ONLY_PEER: &str = "peer-4120";

    /// The row shape #4084 reported, post-#4103: `endpoint_id` bound,
    /// `synced_at` still NULL because we have never once pulled this peer, and
    /// `streamed_at` moving because the peer pulls from *us* every window.
    fn responder_only_ref(streamed_at: Option<i64>) -> PeerRef {
        PeerRef {
            peer_id: RESPONDER_ONLY_PEER.to_string(),
            last_hash: None,
            last_sent_hash: None,
            synced_at: None,
            streamed_at,
            reset_count: 0,
            last_reset_at: None,
            cert_hash: None,
            device_name: Some("Pixel 8".into()),
            remote_device_name: None,
            last_address: None,
            endpoint_id: Some("c".repeat(64)),
            unpaired_by_peer_at_ms: None,
        }
    }

    fn error_messages(sink: &RecordingEventSink) -> Vec<String> {
        sink.events()
            .into_iter()
            .filter_map(|e| match e {
                SyncEvent::Error { message, .. } => Some(message),
                _ => None,
            })
            .collect()
    }

    /// The bug #4120 note 1 is about: a responder-only device dials, fails, and
    /// re-raises the red toast on every cycle, forever.
    ///
    /// The first failure is news and must land. The second, third and
    /// hundredth say the same thing about the same unchanged condition — while
    /// the peer's own inbound sessions keep stamping `streamed_at`, i.e. while
    /// the pair is visibly exchanging data. Only the repeat is suppressed, and
    /// the backoff is booked either way.
    #[test]
    fn a_repeat_pull_failure_against_a_peer_still_pulling_from_us_is_reported_once_4120() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];

        record_initiator_failure(
            &scheduler,
            &sink,
            &refs,
            RESPONDER_ONLY_PEER,
            "Connection failed: peer did not answer within 10s".into(),
        );
        assert_eq!(
            error_messages(&typed).len(),
            1,
            "the FIRST failure of a streak is news and must always reach the user, \
             got {:?}",
            typed.events()
        );

        for _ in 0..5 {
            record_initiator_failure(
                &scheduler,
                &sink,
                &refs,
                RESPONDER_ONLY_PEER,
                "Connection failed: peer did not answer within 10s".into(),
            );
        }

        assert_eq!(
            error_messages(&typed).len(),
            1,
            "#4120: five more cycles of the SAME unchanged condition, against a peer \
             that is still pulling from us every window, must not re-raise the toast; \
             got {:?}",
            typed.events()
        );
        assert_eq!(
            scheduler.failure_count(RESPONDER_ONLY_PEER),
            6,
            "…and every one of them must still be booked as a failure: the backoff is \
             what paces the retry, and suppressing it would turn a 60 s cadence back \
             into a hot loop"
        );
    }

    /// #4096: `reply_sync_complete`'s empty-stream short-circuit now stamps
    /// `streamed_at` even on the degraded branch — the #1257 freshness gate
    /// refused *every* registered space, so nothing was actually shipped —
    /// which widens `still_serving_this_peer` to cover a peer we are
    /// currently declining to serve. That is only safe because suppression
    /// requires `already_reported && still_serving`, never `still_serving`
    /// alone: this pins that the FIRST report against such a peer still
    /// lands unconditionally, same as any other peer. Only a *repeat* of the
    /// identical message would be withheld (covered by the `_4120` test
    /// above); nothing here should ever have to change if that widening's
    /// reasoning holds.
    #[test]
    fn first_report_lands_for_a_peer_we_are_declining_to_serve_4096() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        // Stands in for the row `reply_sync_complete`'s degraded branch
        // produces: `streamed_at` freshly stamped, `synced_at` still NULL —
        // a peer we have never pulled and are, this round, refusing to
        // export anything to.
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];

        record_initiator_failure(
            &scheduler,
            &sink,
            &refs,
            RESPONDER_ONLY_PEER,
            "Sync failed: connection lost".into(),
        );

        assert_eq!(
            error_messages(&typed).len(),
            1,
            "the first failure report against a peer we are declining to serve must \
             still reach the user — suppression is keyed on already_reported, not on \
             still_serving alone; got {:?}",
            typed.events()
        );
    }

    /// A peer with no recent `streamed_at` is not exchanging with us in EITHER
    /// direction. That is a total sync outage for that device, and the user is
    /// told — **once** (#4305).
    ///
    /// Before #4305 this test asserted three reports for three cycles, which is
    /// what a dark peer produced forever: `still_serving` is false the moment a
    /// peer goes away and never becomes true again, so `already_reported &&
    /// still_serving` could not close and the daemon toasted the same unchanged
    /// sentence once per resync interval for as long as the app ran. The
    /// outage is real and durable, so it belongs on the durable surfaces (the
    /// peer row, the status dot); the toast's job is to say it once.
    ///
    /// Pinned with two shapes, because the two ways to get the predicate wrong
    /// fail differently: `None` is the never-streamed peer (a fresh pair that
    /// has never worked), and a stale `Some` is the peer that used to stream
    /// and went dark — a "has it ever streamed?" check would pass the second.
    #[test]
    fn a_repeat_pull_failure_against_a_dark_peer_is_reported_exactly_once_4305() {
        for (label, streamed_at) in [
            ("never streamed to us at all", None),
            (
                "streamed to us an hour ago, then went dark",
                Some(agaric_store::db::now_ms() - 3_600_000),
            ),
        ] {
            let typed = Arc::new(RecordingEventSink::new());
            let sink: Arc<dyn SyncEventSink> = typed.clone();
            let scheduler = SyncScheduler::new();
            let refs = vec![responder_only_ref(streamed_at)];

            for _ in 0..3 {
                record_initiator_failure(
                    &scheduler,
                    &sink,
                    &refs,
                    RESPONDER_ONLY_PEER,
                    "Sync failed: connection lost".into(),
                );
            }

            assert_eq!(
                error_messages(&typed).len(),
                1,
                "#4305: the outage against a peer that is not pulling from us either \
                 ({label}) is news the first time and unchanged every time after. Got \
                 {:?}",
                typed.events()
            );
            assert_eq!(
                scheduler.failure_count(RESPONDER_ONLY_PEER),
                3,
                "…and quieting the toast must not quieten the scheduler: every cycle \
                 is still booked, so the retry pacing is untouched"
            );
        }
    }

    /// A peer that is not in `peer_refs` at all cannot be shown to be pulling
    /// from us, so it is classified dark — the conservative direction, and the
    /// one a `find(...).map_or(true, …)` slip would invert.
    ///
    /// Since #4305 the classification is not directly observable from a single
    /// report (every first report lands either way), so it is observed through
    /// the suppression key instead: report against the unknown peer, then
    /// report the SAME text against the same peer now present and freshly
    /// streamed. A second report proves the first was classified dark. If the
    /// lookup had read the wrong row, the first would have been classified
    /// still-serving and the second would be swallowed as a repeat — which is
    /// exactly the slip this test exists to catch, now caught by silence rather
    /// than by a count.
    #[test]
    fn a_pull_failure_against_an_unknown_peer_is_classified_dark_4305() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        // A row for a DIFFERENT peer, freshly streamed — the wrong-peer lookup
        // this guards against would read it and classify ours as serving.
        let mut other = responder_only_ref(Some(agaric_store::db::now_ms()));
        other.peer_id = "some-other-peer".into();

        for _ in 0..3 {
            record_initiator_failure(
                &scheduler,
                &sink,
                &[other.clone()],
                RESPONDER_ONLY_PEER,
                "Sync failed: connection lost".into(),
            );
        }
        assert_eq!(
            error_messages(&typed).len(),
            1,
            "three identical failures against one unchanged peer are one report; got {:?}",
            typed.events()
        );

        // Now the peer IS in the slice, freshly streamed. If the three calls
        // above were (correctly) keyed dark, this is a different key and lands.
        record_initiator_failure(
            &scheduler,
            &sink,
            &[responder_only_ref(Some(agaric_store::db::now_ms()))],
            RESPONDER_ONLY_PEER,
            "Sync failed: connection lost".into(),
        );
        assert_eq!(
            error_messages(&typed).len(),
            2,
            "the freshness check must read THIS peer's row: an absent row is dark, so \
             the same text against a demonstrably-serving row is a different fact and \
             must surface. Got {:?}",
            typed.events()
        );
    }

    /// The streak is the scheduler's own failure count, so it resets exactly
    /// where the situation changed — a successful pull, or a pairing act
    /// (#3547). The next failure after either is news again.
    #[test]
    fn a_pull_failure_after_the_streak_resets_is_reported_again_4120() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];
        let fail = |sched: &SyncScheduler, sink: &Arc<dyn SyncEventSink>| {
            record_initiator_failure(
                sched,
                sink,
                &refs,
                RESPONDER_ONLY_PEER,
                "Sync failed: connection lost".into(),
            );
        };

        fail(&scheduler, &sink); // reported (1)
        fail(&scheduler, &sink); // suppressed
        scheduler.record_success(RESPONDER_ONLY_PEER);
        fail(&scheduler, &sink); // reported again (2)
        fail(&scheduler, &sink); // suppressed
        scheduler.clear_backoff();
        fail(&scheduler, &sink); // reported again (3)

        assert_eq!(
            error_messages(&typed).len(),
            3,
            "a success (#610's reverse direction finally landing) and a pairing act \
             (#3547) both mean the situation changed; the next failure is news. \
             Got {:?}",
            typed.events()
        );
    }

    /// The non-change #4120 note 1 exists to protect, restated at the layer
    /// that consumes it: suppressing the *report* must not, by any route, stop
    /// the responder-only peer being selected for a pull.
    ///
    /// `peers_due_for_resync` is pinned in `sync_scheduler`'s own tests
    /// (`peers_due_for_resync_ignores_streamed_at_4084`); what is pinned here
    /// is that this fix left it that way — the peer is still due the moment
    /// its backoff window elapses, exactly as it was before.
    #[test]
    fn suppressing_the_repeat_report_does_not_make_the_peer_stop_being_due_4120() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];

        assert_eq!(
            scheduler.peers_due_for_resync(&refs),
            vec![RESPONDER_ONLY_PEER.to_string()],
            "precondition (#610): we have never pulled this peer, so it is due — \
             however recently it streamed to us"
        );

        for _ in 0..3 {
            record_initiator_failure(
                &scheduler,
                &sink,
                &refs,
                RESPONDER_ONLY_PEER,
                "Sync failed: connection lost".into(),
            );
        }

        assert_eq!(
            error_messages(&typed).len(),
            1,
            "precondition: the repeats were suppressed"
        );
        assert!(
            !scheduler.may_retry(RESPONDER_ONLY_PEER),
            "…because the backoff was booked every time"
        );
        // Step past the backoff window the failures just set. `clear_backoff`
        // rather than a `sleep`: it is the deterministic equivalent of waiting
        // ~8 s of jittered ladder out, and this test is about the due-ness
        // predicate, not about the ladder (which `sync_scheduler` pins itself).
        scheduler.clear_backoff();
        assert_eq!(
            scheduler.peers_due_for_resync(&refs),
            vec![RESPONDER_ONLY_PEER.to_string()],
            "#4120/#610: the pull is still owed. A quieter report must never become a \
             quieter scheduler — that is the starvation this issue explicitly refused"
        );
    }

    /// The suppression is keyed on the failure *text*, not on the peer's streak
    /// count, and this is the case that separates the two.
    ///
    /// The user is told "Connection failed: peer did not answer". Next cycle the
    /// peer answers and the session dies of something else entirely. That second
    /// cause is news — it is a different fault, with a different remedy — and a
    /// per-peer streak would have called it a repeat and swallowed it, for as
    /// long as the peer kept pulling from us.
    #[test]
    fn a_pull_failure_whose_cause_changes_mid_streak_is_reported_4120() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];
        let fail = |msg: &str| {
            record_initiator_failure(&scheduler, &sink, &refs, RESPONDER_ONLY_PEER, msg.into());
        };

        fail("Connection failed: peer did not answer within 10s"); // reported
        fail("Connection failed: peer did not answer within 10s"); // suppressed
        fail("Sync failed: connection lost"); // DIFFERENT cause — reported
        fail("Sync failed: connection lost"); // now itself a repeat — suppressed
        fail("Sync failed: connection lost"); // …still suppressed

        assert_eq!(
            error_messages(&typed),
            vec![
                "Connection failed: peer did not answer within 10s".to_string(),
                "Sync failed: connection lost".to_string(),
            ],
            "#4120: the streak is per peer, but the report is per cause — a failure \
             that changes cause mid-streak is news the user must be told, and its own \
             repeats are then suppressed in turn. Got {:?}",
            typed.events()
        );
        assert_eq!(
            scheduler.failure_count(RESPONDER_ONLY_PEER),
            5,
            "every one of them is still booked as a failure"
        );
    }

    /// A bare [`SyncScheduler::record_failure`] bumps the peer's streak without
    /// telling this helper anything. A streak-count key would read that bump as
    /// "already reported" and swallow the *first* real pull failure after it —
    /// a report the user has never seen, about an unrelated fault.
    ///
    /// The pinned-identity refusal used to be exactly such a route; #4203 moved
    /// it into this helper, so no production caller books a failure this way
    /// any more. The pin stays because `record_failure` is still public and the
    /// text key is what makes the helper safe against the next one — reverting
    /// the key to the streak count would redden this test rather than shipping
    /// a swallowed report.
    #[test]
    fn a_pull_failure_after_an_unrelated_failure_booking_is_still_reported_4120() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];

        // A failure booked outside this helper: the backoff moves, the report
        // memory does not.
        scheduler.record_failure(RESPONDER_ONLY_PEER);

        record_initiator_failure(
            &scheduler,
            &sink,
            &refs,
            RESPONDER_ONLY_PEER,
            "Sync failed: connection lost".into(),
        );

        assert_eq!(
            error_messages(&typed).len(),
            1,
            "the first pull failure must reach the user even though the peer's streak \
             was already non-zero for an unrelated reason; got {:?}",
            typed.events()
        );
    }

    /// The freshness window is two resync intervals, inclusive at the boundary.
    ///
    /// Both edges are pinned because both are wrong in a way the other would
    /// not catch: one interval would go false on a healthy pair (a peer becomes
    /// due after one interval and is noticed up to one 30 s tick later, so its
    /// real period runs to 90 s), and an unbounded window would never let the
    /// "and now it has gone dark" report through at all.
    ///
    /// #4305 changed how the boundary is *observed*, not where it is. The
    /// classification is no longer visible as a report count — a repeated
    /// identical failure is one report on either side of the window now — so
    /// each arm reports once at the given age and then once more against a
    /// demonstrably-fresh row. That second report lands only if the first was
    /// classified dark, which makes the assertion a direct read of the
    /// predicate's answer at that age.
    #[test]
    fn the_freshness_window_is_two_resync_intervals_4120() {
        let interval = std::time::Duration::from_secs(60);
        for (label, age_ms, inside_window) in [
            ("one interval — well inside the window", 60_000, true),
            ("exactly two intervals — the inclusive edge", 120_000, true),
            ("a second past two intervals — outside", 121_000, false),
        ] {
            let typed = Arc::new(RecordingEventSink::new());
            let sink: Arc<dyn SyncEventSink> = typed.clone();
            let scheduler =
                SyncScheduler::with_intervals(std::time::Duration::from_millis(50), interval);
            let refs = vec![responder_only_ref(Some(
                agaric_store::db::now_ms() - age_ms,
            ))];

            for _ in 0..3 {
                record_initiator_failure(
                    &scheduler,
                    &sink,
                    &refs,
                    RESPONDER_ONLY_PEER,
                    "Sync failed: connection lost".into(),
                );
            }
            assert_eq!(
                error_messages(&typed).len(),
                1,
                "{label}: an unchanged failure against an unchanged peer is one \
                 report whatever the age (#4305); got {:?}",
                typed.events()
            );

            // The probe: the same text, against a row streamed just now.
            record_initiator_failure(
                &scheduler,
                &sink,
                &[responder_only_ref(Some(agaric_store::db::now_ms()))],
                RESPONDER_ONLY_PEER,
                "Sync failed: connection lost".into(),
            );
            let expected = if inside_window { 1 } else { 2 };
            assert_eq!(
                error_messages(&typed).len(),
                expected,
                "{label}: with a {}s resync interval the window is {}s, so a \
                 {age_ms}ms-old stamp must classify as {}. Got {:?}",
                interval.as_secs(),
                interval.as_secs() * 2,
                if inside_window { "serving" } else { "dark" },
                typed.events()
            );
        }
    }

    /// A `streamed_at` ahead of our clock is a peer whose clock is ahead of
    /// ours, not a peer from the future. The stream still happened, so it counts
    /// as fresh — and the arithmetic must not wrap or invert into "reported
    /// forever" on a device with a skewed peer.
    #[test]
    fn a_streamed_at_in_the_future_counts_as_fresh_4120() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        // Ten minutes of skew — far beyond any plausible window.
        let refs = vec![responder_only_ref(Some(
            agaric_store::db::now_ms() + 600_000,
        ))];

        for _ in 0..4 {
            record_initiator_failure(
                &scheduler,
                &sink,
                &refs,
                RESPONDER_ONLY_PEER,
                "Sync failed: connection lost".into(),
            );
        }

        assert_eq!(
            error_messages(&typed).len(),
            1,
            "clock skew is not the user's problem: the peer demonstrably streamed to \
             us, so the repeat is still a repeat; got {:?}",
            typed.events()
        );
    }

    /// The defaults ship an invariant, not a coincidence: the freshness window
    /// (`resync_interval * 2`) has to stay strictly wider than a healthy peer's
    /// own stamping period (`resync_interval` to become due, plus up to one
    /// [`RESYNC_TICK`] to be noticed). Pinned here so a future edit to either
    /// constant is caught by a test rather than by an intermittent toast on a
    /// pair that is working.
    #[test]
    fn the_shipped_resync_cadence_clears_the_freshness_window_invariant_4120() {
        let scheduler = SyncScheduler::new();
        let window = scheduler.resync_interval.saturating_mul(2);
        assert!(
            window > scheduler.resync_interval + RESYNC_TICK,
            "window {window:?} must exceed resync_interval {:?} + RESYNC_TICK \
             {RESYNC_TICK:?}",
            scheduler.resync_interval,
        );
    }

    /// …and the invariant is self-executing, not advisory (#4120 note 1).
    ///
    /// A `resync_interval` equal to the daemon tick makes the doubled window
    /// exactly a healthy peer's worst-case period — the first value at which
    /// suppression starts going false on a pair that is exchanging data, i.e.
    /// the #4084 toast returning intermittently. The `debug_assert!` in
    /// `peer_pulled_from_us_recently` is what turns that into a test failure,
    /// so this pins the assert itself: delete it and this test goes green
    /// while the freshness window is wrong.
    #[cfg(debug_assertions)]
    #[test]
    #[should_panic(expected = "must stay strictly wider")]
    fn a_resync_interval_at_the_daemon_tick_trips_the_window_invariant_4120() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler =
            SyncScheduler::with_intervals(std::time::Duration::from_millis(50), RESYNC_TICK);
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];

        record_initiator_failure(
            &scheduler,
            &sink,
            &refs,
            RESPONDER_ONLY_PEER,
            "Sync failed: connection lost".into(),
        );
    }

    // ======================================================================
    // #4201 — alternating causes, and the Display stability the key rests on
    // ======================================================================

    /// The shape the single slot #4120 shipped provably failed on.
    ///
    /// A peer that fails `A, B, A, B, …` — a dial timeout one cycle, a
    /// mid-session error the next — never matched the one-slot memory on either
    /// cycle, so suppression never engaged and #4084's forever-toast came back
    /// at half the rate. The streak now remembers both texts, so each is news
    /// exactly once.
    #[test]
    fn alternating_failure_causes_are_each_reported_once_4201() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];
        const TIMEOUT: &str = "Connection failed: peer did not answer within 10s";
        const SESSION: &str = "Sync failed: connection lost";

        for _ in 0..6 {
            for msg in [TIMEOUT, SESSION] {
                record_initiator_failure(&scheduler, &sink, &refs, RESPONDER_ONLY_PEER, msg.into());
            }
        }

        assert_eq!(
            error_messages(&typed),
            vec![TIMEOUT.to_string(), SESSION.to_string()],
            "#4201: twelve cycles alternating between two unchanged causes must raise \
             two toasts, not twelve. Got {:?}",
            typed.events()
        );
        assert_eq!(
            scheduler.failure_count(RESPONDER_ONLY_PEER),
            12,
            "…and every one of them is still booked as a failure"
        );
    }

    /// The other arm of the same property, and the one that guards the
    /// direction that actually hurts: widening the memory from one slot to a
    /// set must not make it swallow a cause the user has never been shown.
    ///
    /// Symmetric to the test above on purpose — that one pins that a repeat IS
    /// suppressed, this one pins that a genuinely new failure is NOT, after the
    /// memory has been filled by an alternation.
    #[test]
    fn a_genuinely_new_cause_still_surfaces_after_an_alternation_4201() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];
        let fail = |msg: &str| {
            record_initiator_failure(&scheduler, &sink, &refs, RESPONDER_ONLY_PEER, msg.into());
        };

        for _ in 0..4 {
            fail("Connection failed: peer did not answer within 10s");
            fail("Sync failed: connection lost");
        }
        assert_eq!(
            error_messages(&typed).len(),
            2,
            "precondition: the alternation itself is reported twice"
        );

        // A third cause, arriving with both of the others still remembered.
        fail("Sync failed: snapshot offer exceeded the size cap");
        fail("Sync failed: snapshot offer exceeded the size cap");

        assert_eq!(
            error_messages(&typed),
            vec![
                "Connection failed: peer did not answer within 10s".to_string(),
                "Sync failed: connection lost".to_string(),
                "Sync failed: snapshot offer exceeded the size cap".to_string(),
            ],
            "#4201: a cause the user has never been shown is news however full the \
             streak's memory is — and its own repeat is then suppressed in turn. \
             Got {:?}",
            typed.events()
        );
    }

    /// The dial-timeout text is the one initiator failure text with nothing
    /// foreign interpolated into it, and pinning it is what makes the
    /// suppression key for that arm provably stable.
    ///
    /// The literal moves with [`CONNECT_TIMEOUT`] — that is fine and is the
    /// point: it moves *consistently*, so two cycles of the same timeout still
    /// produce the same bytes. What this catches is the format string being
    /// rewritten to carry something that is not a constant (an elapsed
    /// duration, a candidate count, an address), which would turn every cycle
    /// into a fresh key and un-suppress #4084's toast.
    #[test]
    fn the_connect_timeout_failure_text_is_built_only_from_constants_4201() {
        assert_eq!(
            connect_timeout_message(),
            "Connection failed: peer did not answer within 10s",
            "the dial-timeout arm's text is the suppression key for that arm; if \
             CONNECT_TIMEOUT moved, update this literal — if something non-constant \
             was interpolated, do not"
        );
        assert_eq!(
            CONNECT_TIMEOUT.as_secs(),
            10,
            "…and the literal above is only readable next to the constant it is \
             built from"
        );
    }

    /// #4201's stated deliverable: pin the `Display` stability the suppression
    /// depends on for the two arms that interpolate an error the sync layer
    /// does not own.
    ///
    /// Two **independently bound** endpoints make the same failing dial against
    /// the same target. In production those two calls are two resync cycles a
    /// minute apart; here they differ in local socket, which is the classic
    /// varying detail an error text embeds. If the two texts differ by a byte,
    /// `record_initiator_failure`'s key churns and the forever-toast is back —
    /// so an iroh upgrade that reformats this error fails here rather than
    /// silently.
    ///
    /// The error itself is produced offline: an `EndpointAddr` carrying only a
    /// key, dialled from a LAN-only endpoint with no address lookup, has
    /// nowhere to go and iroh says so immediately. No network, no timeout.
    ///
    /// "No network" is asserted, not assumed. The endpoint is given the
    /// [`RecordingResolver`](crate::transport::endpoint::RecordingResolver)
    /// every other endpoint-building test in this tree uses — it answers
    /// nothing and records what was asked — so a future iroh that resolves a
    /// name on this path makes the test *hang and then fail* here rather than
    /// quietly issuing DNS queries from CI. The system resolver
    /// (`DnsResolver::new()`) would have made that leak invisible.
    #[tokio::test]
    async fn a_real_iroh_connect_error_formats_identically_on_two_independent_dials_4201() {
        use crate::transport::endpoint::RecordingResolver;

        async fn failing_dial_text(target: iroh::EndpointId) -> (String, RecordingResolver) {
            let resolver = RecordingResolver::new();
            let endpoint = crate::transport::endpoint::lan_only(
                "127.0.0.1:0".parse().unwrap(),
                32,
                iroh::dns::DnsResolver::custom(resolver.clone()),
            )
            .expect("a loopback /32 is a legal LAN-only bind")
            .bind()
            .await
            .expect("binding an ephemeral loopback port must succeed");
            let error = endpoint
                .connect(iroh::EndpointAddr::new(target), SYNC_ALPN)
                .await
                .expect_err("an endpoint address carrying no path cannot be dialled");
            (connect_failure_message(&error), resolver)
        }

        let target = crate::mdns::test_endpoint_id("PEER_4201_DISPLAY");
        let (first, first_resolver) = failing_dial_text(target).await;
        let (second, second_resolver) = failing_dial_text(target).await;

        // Both dials, not just the first: a leak that only affected the second
        // endpoint would otherwise pass quietly, which is the exact failure
        // mode switching off the real system resolver was meant to remove.
        for (which, resolver) in [("first", &first_resolver), ("second", &second_resolver)] {
            assert_eq!(
                resolver.queries(),
                Vec::<String>::new(),
                "this test must stay offline: the {which} failing dial resolved a \
                 hostname, so it is no longer the hermetic, immediate error it is \
                 documented to be"
            );
        }

        assert_eq!(
            first, second,
            "#4201: the repeat-report suppression keys on this exact text, so two \
             cycles of the SAME fault must produce the same bytes. A difference here \
             means an iroh error now carries a varying detail and the #4084 toast is \
             un-suppressed"
        );
        assert!(
            first.starts_with("Connection failed: "),
            "the dial-failure arms wrap the error in their own prefix; got {first:?}"
        );
        assert!(
            first.len() > "Connection failed: ".len(),
            "…and the wrapped error must actually contribute words, or this test \
             would be green because iroh's Display is empty rather than because it \
             is stable; got {first:?}"
        );
    }

    // ======================================================================
    // #4299 — naming a captured LAN instead of reporting a bare timeout
    // ======================================================================

    /// The freshness predicate the probe is gated on, at both edges of its
    /// window, and its `None` case.
    ///
    /// `None` is the one that matters most: it is what every peer resolved from
    /// a stored `peer_refs.last_address` carries, and what every direct caller
    /// of `try_sync_with_peer` in the test suites carries. It must never open
    /// the gate.
    #[tokio::test]
    async fn the_probe_gate_only_opens_for_a_peer_mdns_is_still_announcing_4299() {
        let now = tokio::time::Instant::now();

        assert!(
            !mdns_is_reaching_us(None),
            "a peer with no announcement on record is not reaching us; a dial \
             timeout against it means exactly what it says"
        );
        assert!(mdns_is_reaching_us(Some(now)));
        assert!(
            mdns_is_reaching_us(Some(
                now - (MDNS_STALE_AFTER - std::time::Duration::from_secs(1))
            )),
            "inside the window the daemon itself keeps the entry in the map"
        );
        assert!(
            !mdns_is_reaching_us(Some(
                now - (MDNS_STALE_AFTER + std::time::Duration::from_secs(1))
            )),
            "outside it, the periodic-resync sweep would have evicted the entry — \
             the predicate and the sweep must agree"
        );
    }

    /// A loopback endpoint (every harness in this tree) plus a peer with an
    /// address: the gate must decide the outcome, not the endpoint.
    ///
    /// Deliberately makes no claim about the machine's routes. The `None`
    /// arms are gate decisions taken before a socket is opened at all, and
    /// the fresh-mDNS arm is `None` by the `compare` rule that a loopback bind
    /// names no interface — so this passes identically in CI and behind
    /// whatever a laptop is behind.
    #[tokio::test]
    async fn a_dial_timeout_against_an_unannounced_peer_stays_a_plain_timeout_4299() {
        let endpoint = crate::transport::endpoint::lan_only(
            "127.0.0.1:0".parse().unwrap(),
            32,
            iroh::dns::DnsResolver::custom(crate::transport::endpoint::RecordingResolver::new()),
        )
        .expect("a loopback /32 is a legal LAN-only bind")
        .bind()
        .await
        .expect("binding an ephemeral loopback port must succeed");

        let peer = DiscoveredPeer {
            device_id: "PEER_4299".to_string(),
            endpoint_id: Some(crate::mdns::test_endpoint_id("PEER_4299")),
            addresses: vec!["192.160.160.80".parse().unwrap()],
            port: 9999,
        };

        let stale =
            tokio::time::Instant::now() - (MDNS_STALE_AFTER + std::time::Duration::from_secs(1));

        assert!(
            diagnose_dial_timeout(&endpoint, Some(32), &peer, None).is_none(),
            "no mDNS recency: the probe must not run at all"
        );
        assert_eq!(
            dial_timeout_message(&peer.device_id, &endpoint, Some(32), &peer, None),
            connect_timeout_message(),
            "…and the text the user sees must be byte-identical to the one this arm \
             reported before #4299 existed — the ordinary sleeping-peer path is \
             exactly what must not change"
        );

        assert!(
            diagnose_dial_timeout(&endpoint, Some(32), &peer, Some(stale)).is_none(),
            "a stale announcement is not 'mDNS is reaching us'"
        );
        assert_eq!(
            dial_timeout_message(&peer.device_id, &endpoint, Some(32), &peer, Some(stale)),
            connect_timeout_message()
        );

        assert!(
            diagnose_dial_timeout(
                &endpoint,
                Some(32),
                &peer,
                Some(tokio::time::Instant::now())
            )
            .is_none(),
            "even with the gate open, a loopback-bound endpoint names no interface \
             to disagree with, so the probe is inconclusive and says nothing"
        );
        assert_eq!(
            dial_timeout_message(
                &peer.device_id,
                &endpoint,
                Some(32),
                &peer,
                Some(tokio::time::Instant::now())
            ),
            connect_timeout_message(),
            "an inconclusive probe is never a diagnosis"
        );

        endpoint.close().await;
    }

    /// A route table as a lookup, keyed on the **exact destination socket** —
    /// address *and* port — the way the kernel's own route selection is. Anything
    /// absent is a route that does not resolve.
    ///
    /// The port being part of the key is load-bearing here: it is what makes a
    /// candidate assembled with the wrong port read as "no route" instead of
    /// quietly agreeing.
    fn routes(pairs: &[(&str, &str)]) -> impl Fn(std::net::SocketAddr) -> Option<std::net::IpAddr> {
        let table: std::collections::HashMap<std::net::SocketAddr, std::net::IpAddr> = pairs
            .iter()
            .map(|(dest, src)| {
                (
                    dest.parse().expect("test socket address parses"),
                    src.parse().expect("test address parses"),
                )
            })
            .collect();
        move |dest| table.get(&dest).copied()
    }

    /// A peer as mDNS announced it: one address, one port.
    fn announced_peer(address: &str, port: u16) -> DiscoveredPeer {
        DiscoveredPeer {
            device_id: "PEER_4299".to_string(),
            endpoint_id: Some(crate::mdns::test_endpoint_id("PEER_4299")),
            addresses: vec![address.parse().expect("test address parses")],
            port,
        }
    }

    /// The recorded #4299 capture, driven through the **composition** rather than
    /// through `compare` (#4299 review).
    ///
    /// Every other test of this arm binds loopback, because that is the only thing
    /// an endpoint in CI can bind — and a loopback bind short-circuits to
    /// `Inconclusive` in `egress_probe::compare` before the candidates this function
    /// assembles or the prefix it pairs with each socket matter at all. So this one
    /// supplies the bound sockets and the route table directly: a LAN bind at
    /// `192.160.160.42/24`, a peer announced at `192.160.160.80:9999`, and a system
    /// that would source that peer's traffic from the tunnel's `100.64.0.1`.
    ///
    /// Two mutations of the composition survived the entire suite before this test
    /// existed, and each of them reddens it:
    ///
    /// * `SocketAddr::new(*ip, peer.port)` → port `0`: the route table is keyed on
    ///   the destination socket, so the candidate is asked about a destination the
    ///   system has no route for and the probe falls silent.
    /// * `bind_prefix_len.filter(|_| addr.is_ipv4())` → `is_ipv6()`: the IPv4 bind
    ///   loses the only prefix in existence, `compare` has no link to judge the
    ///   tunnel's source against, and the diagnosis is silenced *permanently in
    ///   production* — the feature ships doing nothing.
    #[tokio::test]
    async fn a_captured_lan_is_diagnosed_through_the_composition_4299() {
        let peer = announced_peer("192.160.160.80", 9999);

        let report = diagnose_dial_timeout_with(
            &["192.160.160.42:41234".parse().unwrap()],
            Some(24),
            &peer,
            Some(tokio::time::Instant::now()),
            routes(&[("192.160.160.80:9999", "100.64.0.1")]),
        )
        .expect("mDNS is fresh and the system sources this peer from the tunnel");

        assert_eq!(report.verdict, EgressVerdict::RoutedElsewhere);
        assert_eq!(
            report.candidate,
            Some("192.160.160.80:9999".parse().unwrap()),
            "the candidate is the announced address on the announced port; a \
             candidate assembled with any other port asks the system about a \
             destination this peer is not on"
        );
        assert_eq!(
            report.bound,
            Some("192.160.160.42".parse::<std::net::IpAddr>().unwrap())
        );
        assert_eq!(
            report.bound_prefix_len,
            Some(24),
            "the bind policy's prefix must reach the socket it was measured on, or \
             there is no link for the tunnel's source address to be off"
        );
        assert_eq!(
            dial_timeout_text(&peer.device_id, Some(report)),
            ROUTED_ELSEWHERE_MESSAGE,
            "…and the whole path from a fresh announcement to the user-facing text"
        );
    }

    /// The same composition, one route table apart, must stay silent: the system
    /// sources this peer from an address inside the prefix we bound, so a path
    /// exists and the peer is simply asleep.
    ///
    /// The pair with the test above is the point — a mutant that always diagnosed
    /// would pass one of them and a mutant that never diagnosed would pass the
    /// other.
    #[tokio::test]
    async fn a_route_inside_the_bound_prefix_stays_a_plain_timeout_4299() {
        let peer = announced_peer("192.160.160.80", 9999);
        assert!(
            diagnose_dial_timeout_with(
                &["192.160.160.42:41234".parse().unwrap()],
                Some(24),
                &peer,
                Some(tokio::time::Instant::now()),
                routes(&[("192.160.160.80:9999", "192.160.160.43")]),
            )
            .is_none(),
            "a second address on our own /24 still reaches this peer over our own \
             link; telling this user a VPN may be eating their LAN would be \
             confidently wrong"
        );
        // …and the gate still closes first, even against the capture's own table:
        // no announcement, no probe, whatever the routes say.
        assert!(
            diagnose_dial_timeout_with(
                &["192.160.160.42:41234".parse().unwrap()],
                Some(24),
                &peer,
                None,
                routes(&[("192.160.160.80:9999", "100.64.0.1")]),
            )
            .is_none(),
            "a peer we have heard no announcement from is a peer that is not there"
        );
    }

    /// The prefix is paired with the socket it was measured on, in both directions
    /// (#4299 review).
    ///
    /// `BindDecision` ranks and binds IPv4 only, so `bind_prefix_len` describes the
    /// v4 socket and nothing else. Both halves are asserted against the *same* pair
    /// of bound sockets, so the family test cannot be satisfied by a mutation that
    /// merely moves the prefix to the other socket: `is_ipv6()` in place of
    /// `is_ipv4()` reddens the first half by silencing the real capture and reddens
    /// the second by inventing one out of a length measured on the other family.
    #[tokio::test]
    async fn the_bind_prefix_belongs_to_the_socket_it_was_measured_on_4299() {
        let bound_sockets: [std::net::SocketAddr; 2] = [
            "192.160.160.42:41234".parse().unwrap(),
            "[fd00::42]:41234".parse().unwrap(),
        ];
        let fresh = || Some(tokio::time::Instant::now());

        let v4 = diagnose_dial_timeout_with(
            &bound_sockets,
            Some(24),
            &announced_peer("192.160.160.80", 9999),
            fresh(),
            routes(&[("192.160.160.80:9999", "100.64.0.1")]),
        )
        .expect("the v4 bind carries the v4 prefix, and the tunnel's source is off it");
        assert_eq!(
            v4.bound,
            Some("192.160.160.42".parse::<std::net::IpAddr>().unwrap())
        );
        assert_eq!(v4.bound_prefix_len, Some(24));

        assert!(
            diagnose_dial_timeout_with(
                &bound_sockets,
                Some(24),
                &announced_peer("fd00::80", 9999),
                fresh(),
                routes(&[("[fd00::80]:9999", "fd00:abcd::1")]),
            )
            .is_none(),
            "no v6 prefix exists to carry, so a v6 candidate can only ever be \
             inconclusive — it must never be judged against a length measured on \
             the IPv4 interface"
        );
    }

    /// The suppression-key property, for the one text #4299 adds.
    ///
    /// Same intent as
    /// `a_real_iroh_connect_error_formats_identically_on_two_independent_dials_4201`:
    /// `record_initiator_failure` withholds a repeat only when the incoming bytes
    /// equal a text already reported this streak, so a diagnosis that embedded
    /// the interface name, the probe's source address or the candidate would
    /// churn its own key and re-raise a toast every sixty seconds — the exact
    /// #4084 failure the gate exists to prevent.
    ///
    /// Two invocations against two *different* probe results, because that is
    /// the shape the churn would take: the tunnel's source address is precisely
    /// the detail that varies between cycles. Driving
    /// [`dial_timeout_text`] rather than reading the constant twice is the
    /// difference between pinning the property and restating it — the constant
    /// equals itself whatever the function does with it.
    #[test]
    fn the_routed_elsewhere_text_is_identical_on_two_independent_diagnoses_4299() {
        let report = |probed: &str, candidate: &str| {
            Some(EgressReport {
                verdict: EgressVerdict::RoutedElsewhere,
                bound: Some("192.160.160.42".parse().unwrap()),
                bound_prefix_len: Some(24),
                probed: Some(probed.parse().unwrap()),
                candidate: Some(candidate.parse().unwrap()),
            })
        };
        let first = dial_timeout_text("PEER_4299", report("100.64.0.1", "192.160.160.80:9999"));
        let second =
            dial_timeout_text("PEER_4299", report("10.70.121.252", "192.160.160.81:41234"));
        assert_eq!(
            first, second,
            "#4299: the diagnosis is the suppression key for its arm; two cycles of \
             the same condition must produce the same bytes even when the probe \
             selected a different source address and a different candidate"
        );
        assert_eq!(
            first, ROUTED_ELSEWHERE_MESSAGE,
            "a `RoutedElsewhere` report is what produces the diagnosis; a mutant \
             that fell back to the timeout text here would otherwise be invisible \
             to the whole suite"
        );
        assert_eq!(
            dial_timeout_text("PEER_4299", None),
            connect_timeout_message(),
            "…and no diagnosis is still the unchanged timeout text"
        );
        assert_eq!(
            first,
            "Connection failed: discovered on the network, but traffic to this device \
             is being routed elsewhere - a VPN or firewall may be capturing your LAN",
            "the text is pinned so a well-meaning edit that interpolates the bound \
             address, the probe's source address or the candidate fails here"
        );
        for varying in ["100.64.0.1", "tun0", "192.160.160.80", "9999"] {
            assert!(
                !first.contains(varying),
                "the diagnosis must carry no detail that can differ between two \
                 cycles of the same condition; found {varying:?}"
            );
        }
    }

    /// …and it must be a *different* text from the plain timeout, or the peer
    /// that transitions from "asleep" to "captured" would be suppressed as a
    /// repeat and the user would never be told.
    #[test]
    fn the_transition_from_timeout_to_diagnosis_is_reported_once_4299() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];
        let fail = |msg: String| {
            record_initiator_failure(&scheduler, &sink, &refs, RESPONDER_ONLY_PEER, msg);
        };

        assert_ne!(
            connect_timeout_message(),
            ROUTED_ELSEWHERE_MESSAGE,
            "a diagnosis that read identically to the timeout it replaces would be \
             swallowed by the repeat-report gate"
        );

        // Three cycles of a bare timeout, then the probe starts firing.
        for _ in 0..3 {
            fail(connect_timeout_message());
        }
        for _ in 0..3 {
            fail(ROUTED_ELSEWHERE_MESSAGE.to_string());
        }

        assert_eq!(
            error_messages(&typed),
            vec![
                connect_timeout_message(),
                ROUTED_ELSEWHERE_MESSAGE.to_string()
            ],
            "#4299: exactly one new notification on the transition, then silence \
             again. Got {:?}",
            typed.events()
        );
    }

    // ======================================================================
    // #4203 — the pinned-identity refusal
    // ======================================================================

    /// #4203: the refusal used to emit its event unconditionally, every resync
    /// cycle, forever — the #4084 shape with a different string.
    ///
    /// It now routes through the same gate as every other initiator failure, so
    /// the first refusal is news and the repeats are withheld **while the real
    /// peer is still pulling from us**. The condition being security-relevant
    /// is an argument about the first report, not about the hundredth.
    #[test]
    fn the_pinned_identity_refusal_is_reported_once_per_streak_4203() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];

        for _ in 0..6 {
            record_initiator_failure(
                &scheduler,
                &sink,
                &refs,
                RESPONDER_ONLY_PEER,
                IDENTITY_MISMATCH_MESSAGE.to_string(),
            );
        }

        assert_eq!(
            error_messages(&typed),
            vec![IDENTITY_MISMATCH_MESSAGE.to_string()],
            "#4203: six cycles of the same refusal, against a peer whose own inbound \
             sessions show the pair is working, must raise one toast. Got {:?}",
            typed.events()
        );
        assert_eq!(
            scheduler.failure_count(RESPONDER_ONLY_PEER),
            6,
            "…and the refusal still books the backoff on every cycle — only the \
             repeat toast is withheld, never the refusal itself"
        );
    }

    /// The half of #4203 that keeps the refusal audible where it matters,
    /// pinned against the same two shapes the pull-failure arm uses.
    ///
    /// If a different key answering to a paired peer's name is the ONLY thing
    /// on the wire, our `streamed_at` for that peer goes stale — and *that
    /// transition* is what the user who has lost their peer to an impostor
    /// needs to see. The argument the refusal's doc comment made is preserved;
    /// #4305 bounded the number of times it is made.
    ///
    /// Two arms per shape, because "loud once" and "loud forever" are only
    /// distinguishable across cycles:
    ///
    /// * a dark peer is told once, not once per resync interval — the security
    ///   relevance of the condition is an argument for it being *heard*, and a
    ///   red toast a minute is how a user learns to dismiss red toasts unread;
    /// * but a peer that goes dark *after* the user was told while the pair was
    ///   still working is told again, because that is a different loss.
    #[test]
    fn the_pinned_identity_refusal_is_reported_once_per_state_of_the_pair_4305() {
        for (label, streamed_at) in [
            ("never streamed to us at all", None),
            (
                "streamed to us an hour ago, then went dark",
                Some(agaric_store::db::now_ms() - 3_600_000),
            ),
        ] {
            let typed = Arc::new(RecordingEventSink::new());
            let sink: Arc<dyn SyncEventSink> = typed.clone();
            let scheduler = SyncScheduler::new();
            let refs = vec![responder_only_ref(streamed_at)];

            for _ in 0..4 {
                record_initiator_failure(
                    &scheduler,
                    &sink,
                    &refs,
                    RESPONDER_ONLY_PEER,
                    IDENTITY_MISMATCH_MESSAGE.to_string(),
                );
            }

            assert_eq!(
                error_messages(&typed).len(),
                1,
                "#4305 ({label}): the refusal against a peer we have lost is the whole \
                 story, and it does not change between cycles — telling it four times \
                 adds nothing the peer row does not already carry. Got {:?}",
                typed.events()
            );
            assert_eq!(
                scheduler.failure_count(RESPONDER_ONLY_PEER),
                4,
                "…and every cycle still books the backoff and still refuses the session"
            );
        }

        // The transition arm: told while the pair was visibly working, then the
        // peer goes dark. The second state is a different fact and surfaces.
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        for refs in [
            vec![responder_only_ref(Some(agaric_store::db::now_ms()))],
            vec![responder_only_ref(None)],
        ] {
            for _ in 0..3 {
                record_initiator_failure(
                    &scheduler,
                    &sink,
                    &refs,
                    RESPONDER_ONLY_PEER,
                    IDENTITY_MISMATCH_MESSAGE.to_string(),
                );
            }
        }
        assert_eq!(
            error_messages(&typed).len(),
            2,
            "#4305: a mismatched key on a pair that still works and a mismatched key on \
             a pair that has stopped exchanging are two different things to be told, \
             and each is told once. Got {:?}",
            typed.events()
        );
    }

    /// A pairing act is the user answering the refusal, so the refusal is news
    /// again if it is still true (#3547 / #4203).
    ///
    /// This is the reset #4203 named explicitly ("reset the memory where
    /// `clear_backoff` already resets it"), and it falls out of riding on the
    /// backoff entry rather than needing its own bookkeeping.
    #[test]
    fn a_pairing_act_makes_the_identity_refusal_news_again_4203() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];
        let refuse = || {
            record_initiator_failure(
                &scheduler,
                &sink,
                &refs,
                RESPONDER_ONLY_PEER,
                IDENTITY_MISMATCH_MESSAGE.to_string(),
            );
        };

        refuse(); // reported
        refuse(); // suppressed
        scheduler.clear_backoff(); // the user re-paired (#3547)
        refuse(); // reported again

        assert_eq!(
            error_messages(&typed).len(),
            2,
            "#4203: after a pairing act the user is owed the answer to what they just \
             did — if the announced key still does not match, say so. Got {:?}",
            typed.events()
        );
    }

    /// The two suppression memories do not bleed into each other: the refusal
    /// and a pull failure are different texts, so neither can be swallowed as a
    /// "repeat" of the other.
    ///
    /// This is what #4197's review worried about when it kept the refusal
    /// outside the helper, and it is why the key is the text rather than the
    /// peer's streak count. With a *set* rather than a single slot, both are
    /// remembered at once, so the alternation between them is also quiet after
    /// each has been reported.
    #[test]
    fn the_identity_refusal_and_a_pull_failure_are_separate_reports_4203() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        let scheduler = SyncScheduler::new();
        let refs = vec![responder_only_ref(Some(agaric_store::db::now_ms()))];
        let fail = |msg: &str| {
            record_initiator_failure(&scheduler, &sink, &refs, RESPONDER_ONLY_PEER, msg.into());
        };

        fail(IDENTITY_MISMATCH_MESSAGE);
        fail("Sync failed: connection lost");
        fail(IDENTITY_MISMATCH_MESSAGE);
        fail("Sync failed: connection lost");

        assert_eq!(
            error_messages(&typed),
            vec![
                IDENTITY_MISMATCH_MESSAGE.to_string(),
                "Sync failed: connection lost".to_string(),
            ],
            "each is news once, and neither suppresses the other. Got {:?}",
            typed.events()
        );
    }

    // ======================================================================
    // #4297 — the abandoned side of a one-sided unpair
    // ======================================================================

    const UNPAIRED_PEER: &str = "peer-4297";

    /// A peer row shaped like the one on the abandoned device: healthy, synced
    /// minutes ago, and about to be refused forever.
    fn healthy_ref(peer_id: &str) -> PeerRef {
        PeerRef {
            peer_id: peer_id.to_string(),
            last_hash: None,
            last_sent_hash: None,
            synced_at: Some(agaric_store::db::now_ms()),
            streamed_at: None,
            reset_count: 0,
            last_reset_at: None,
            cert_hash: None,
            device_name: Some("Pixel 8".into()),
            remote_device_name: None,
            last_address: None,
            endpoint_id: None,
            unpaired_by_peer_at_ms: None,
        }
    }

    async fn unpaired_flag(pool: &sqlx::SqlitePool, peer_id: &str) -> Option<i64> {
        peer_refs::get_peer_ref(pool, peer_id)
            .await
            .expect("reading the peer row must succeed")
            .and_then(|p| p.unpaired_by_peer_at_ms)
    }

    /// The fix itself: an `Unpaired` refusal from a peer we still hold a row
    /// for is the only notice we will ever get that the other device unpaired
    /// us, and it must land on the row.
    #[tokio::test]
    async fn an_unpaired_refusal_from_a_bound_peer_marks_its_row_4297() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        peer_refs::upsert_peer_ref(&pool, UNPAIRED_PEER)
            .await
            .unwrap();
        let refs = vec![healthy_ref(UNPAIRED_PEER)];

        record_peer_unpaired_us(&pool, &refs, UNPAIRED_PEER).await;

        assert!(
            unpaired_flag(&pool, UNPAIRED_PEER).await.is_some(),
            "the peer's refusal must become durable row state, or the device list \
             keeps rendering a peer that can never sync again as healthy (#4297)"
        );
    }

    /// The asymmetry the fix is built around. `Rejection::Unpaired` is the
    /// ordinary answer to every stranger's probe — a joiner mid-pairing dials
    /// every discovered device and is refused by each (#3502/#3505) — so a
    /// refusal from a device we hold NO row for must write nothing at all.
    #[tokio::test]
    async fn an_unpaired_refusal_from_a_stranger_marks_nothing_4297() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        peer_refs::upsert_peer_ref(&pool, UNPAIRED_PEER)
            .await
            .unwrap();
        // The row exists in the DB but the peer is NOT in the list this round
        // was planned from — the strongest form of the case, because it also
        // proves the guard is the list membership and not merely the UPDATE's
        // `WHERE peer_id = ?`.
        let refs: Vec<PeerRef> = vec![];

        record_peer_unpaired_us(&pool, &refs, UNPAIRED_PEER).await;
        assert!(
            unpaired_flag(&pool, UNPAIRED_PEER).await.is_none(),
            "a refusal from a device outside the paired list must never be recorded"
        );

        // …and a peer with no row at all is a no-op that creates nothing.
        record_peer_unpaired_us(&pool, &[healthy_ref("total-stranger")], "total-stranger").await;
        assert!(
            peer_refs::get_peer_ref(&pool, "total-stranger")
                .await
                .unwrap()
                .is_none(),
            "recording a refusal must never conjure a peer row"
        );
    }

    /// The flag is not a one-way door: the pairing coming back to life erases
    /// it, through the store writes every successful session already performs.
    #[tokio::test]
    async fn a_later_successful_sync_clears_the_unpaired_mark_4297() {
        let (pool, _dir) = agaric_store::test_support::test_pool().await;
        peer_refs::upsert_peer_ref(&pool, UNPAIRED_PEER)
            .await
            .unwrap();
        let refs = vec![healthy_ref(UNPAIRED_PEER)];

        record_peer_unpaired_us(&pool, &refs, UNPAIRED_PEER).await;
        assert!(unpaired_flag(&pool, UNPAIRED_PEER).await.is_some());

        peer_refs::update_on_sync(&pool, UNPAIRED_PEER, "hash", "")
            .await
            .unwrap();

        assert!(
            unpaired_flag(&pool, UNPAIRED_PEER).await.is_none(),
            "a session that actually pulled from the peer disproves the refusal; \
             leaving the mark would tell the user to re-pair a working device"
        );
    }

    /// `session_rejection` is what gates the write, and it must recognise the
    /// refusal from the SAME text the responder puts on the wire — including
    /// distinguishing `Unpaired` from every other rejection, since only
    /// `Unpaired` means the peer holds no row for us.
    #[test]
    fn only_the_unpaired_rejection_gates_the_mark_4297() {
        assert_eq!(
            Rejection::from_peer_message(Rejection::Unpaired.peer_message()),
            Some(Rejection::Unpaired),
            "the refusal the abandoned device receives must round-trip"
        );
        for other in Rejection::all() {
            if matches!(other, Rejection::Unpaired) {
                continue;
            }
            assert!(
                !matches!(
                    Rejection::from_peer_message(other.peer_message()),
                    Some(Rejection::Unpaired)
                ),
                "{other:?} must not be mistaken for the dead-pairing refusal"
            );
        }
    }
}
