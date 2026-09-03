//! Auto-sync daemon — background orchestrator for peer discovery,
//! connection, and sync sessions.
//!
//! Ties together mDNS discovery (#383), the sync protocol orchestrator,
//! and the scheduler's exponential backoff (#278).  The daemon runs as
//! a single `tokio::spawn` task for the lifetime of the application.
//!
//! Supports **both** initiator and responder modes:
//! - **Initiator:** discovers peers via mDNS, connects outbound, sends
//!   HeadExchange first, and receives ops from the responder.
//! - **Responder (#615):** accepts inbound QUIC connections on the sync
//!   ALPN, receives the initiator's HeadExchange, computes and sends
//!   missing ops, and completes the session.  Per-peer mutual exclusion
//!   prevents concurrent sync sessions with the same device.

mod discovery;
// Which local interface the sync endpoint binds (#3853). Its own module because the
// selection is a *policy* with a table of cases, and the policy has to be a pure
// function over synthetic interface lists or no test of it can be reproducible.
mod lan_interface;
pub mod server;
mod session_supervisor;
pub mod snapshot_transfer;

// Android-only: acquire WifiManager.MulticastLock at daemon start so the
// `mdns-sd` crate's UDP multicast sockets receive packets. The module carries
// its own `#![cfg(any(target_os = "android", test))]`, so it is empty on a
// non-test host build but still compiles (and is tested) under `cargo test` —
// that is how the "no Android context" degrade path of #3847 is covered
// without a device.
pub(crate) mod android_multicast;

// #3852: report Android's per-uid background firewall to the user instead of
// spinning. Unlike `android_multicast` this module compiles on every target —
// its reporting rule is a pure function with no JNI in it, and only the
// registration call is `cfg(target_os = "android")` — so the rule that decides
// what the pairing UI is told is tested on the host, on every platform.
pub mod android_network_block;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::apply_host::ApplyHost;
use crate::foreground::LifecycleHooks;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_scheduler::SyncScheduler;
use agaric_core::error::AppError;
use agaric_store::peer_refs;
use iroh::SecretKey;

// Re-export submodule items
pub use discovery::{
    DiscoveredPeers, build_fallback_peer, format_peer_addresses, get_peer_cert_hash,
    peers_for_change_round, process_discovery_event, resolve_peer_address,
    should_attempt_sync_with_discovered_peer, should_store_cert_hash,
};
// These helpers are only called from test siblings — guard against unused_imports
// on non-test builds (same rationale as the orchestrator/server re-exports below).
#[allow(unused_imports)]
pub use discovery::{format_peer_address, process_service_removed};
// `pub(crate) use` re-exports consumed only by the `#[cfg(test)]` sibling
// `sync_daemon/tests.rs` (the crate-level `sync_integration_tests.rs` that
// once also consumed these was deleted with the diffy sync layer). Without
// this `#[allow]` rustc fires `unused_imports` on non-test builds because no
// production code path imports through this module.
#[allow(unused_imports)]
pub use session_supervisor::{
    SyncDaemonContext, SyncSessionContext, run_sequential_sync_round, run_sync_session,
    try_sync_with_peer,
};
// Same rationale as above: only the test sibling reaches into these.
#[allow(unused_imports)]
pub use server::{Rejection, handle_incoming_sync};
// #2696 — boot-time cleanup of orphaned `snapshot-recv-*.tmp` files,
// called from the app `setup` hook before the daemon accepts connections.
pub use snapshot_transfer::sweep_orphaned_snapshot_temps;

// ---------------------------------------------------------------------------
// S-5 — the per-peer lock key, for both roles
// ---------------------------------------------------------------------------

/// The key both sync roles take the S-5 per-peer lock under (#3511, #3529).
///
/// # Why this is a function and not two literals
///
/// S-5 is *mutual exclusion across roles*: an inbound and an outbound session with the
/// same physical peer must not overlap. That property is a statement about two call
/// sites agreeing on a spelling, so it can only be held by one of them — a lock whose
/// key is derived independently on each side is not a lock, it is two locks that
/// usually happen to collide. [`server::handle_incoming_sync`] and
/// [`session_supervisor::try_sync_with_peer`] both call this and nothing else.
///
/// # Why the [`EndpointId`](iroh::EndpointId) and not the `device_id`
///
/// The key has to be available to both roles at the moment each takes the lock, and
/// `device_id` is not:
///
/// * the initiator has it from `peer_refs` / the mDNS announcement, always;
/// * the responder can only learn it from the peer's `HeadExchange`, and only if the
///   peer advertised a head — a fresh joiner with an empty `op_log` advertises none,
///   which is exactly the pairing window in which both ends arm a dial and are
///   therefore most likely to contend.
///
/// So the responder used to fall back to the endpoint id when the frame named no
/// device, the initiator always used the device id, and during the pairing window the
/// two disagreed: S-5 was open in the one window it most needed to be shut. The old
/// stack did not have that gap because the TLS certificate CN handed the responder a
/// device id unconditionally; QUIC authenticates a key, not a name.
///
/// The `EndpointId` has none of that shape. The responder gets it from the QUIC/TLS 1.3
/// handshake before any application byte, and the initiator must have it to dial at
/// all (`mdns::parse_service_event` refuses an announcement with no parseable one,
/// precisely so "we discovered a peer" and "we can attempt a session" stay the same
/// statement). No wire field is involved, in either direction.
///
/// # The trade-off, stated
///
/// An `EndpointId` is 1:1 with an *install*: a reinstall mints a new key
/// (`transport::identity`) while `device_id` may persist. Keying here therefore admits
/// one concurrent session per install rather than per device id. That is not a
/// regression — `device_id` has the mirror problem (a duplicated install shares one) —
/// and it is confined to the lock. `device_id` remains the durable identity that
/// `op_log` frontiers, `peer_refs` rows and the UI are keyed on: `device_id` answers
/// "whose data is this?", `EndpointId` answers "who am I talking to right now?", and
/// the lock is the second question (#3529).
pub fn peer_lock_key(endpoint_id: iroh::EndpointId) -> String {
    endpoint_id.to_string()
}

/// [`peer_lock_key`], reached from the *stored* spelling of an `EndpointId` —
/// `agaric_store::peer_refs::PeerRef::endpoint_id`, 64 lowercase hex chars.
///
/// The command layer holds that column as a `String`, never as an
/// [`EndpointId`](iroh::EndpointId): it reads `peer_refs`, it does not run a QUIC
/// handshake or parse an mDNS announcement. So it cannot call [`peer_lock_key`]
/// directly, and the obvious workaround — noticing that the function body is
/// `to_string()` and passing the stored text to `try_lock_peer` as-is — is exactly the
/// failure [`peer_lock_key`]'s docs describe: a second, independent derivation of the
/// key that agrees today because two authors wrote the same expression, and stops
/// agreeing the day one of them changes (#3550).
///
/// Parsing back into the type and delegating costs one ed25519 point decompression per
/// `start_sync` press and buys the property that there is still exactly one place the
/// spelling is decided. The round trip is lossless for every value the write path
/// actually produces: `peer_refs` writes `EndpointId`'s `Display`, which is
/// `HEXLOWER` over the 32 raw bytes of a key that by construction decompressed
/// successfully, so `parse` → `to_string()` is the identity there.
///
/// # Errors
///
/// [`AppError::Validation`] if `endpoint_id` is not a parseable `EndpointId`.
///
/// Note that this is **strictly stronger than the storage layer's own validation**, and
/// deliberately so. `peer_refs::validate_endpoint_id` and migration `0107`'s column
/// CHECK both test only *spelling* — 64 lowercase hex characters — while parsing here
/// additionally decompresses the ed25519 point. Those are not the same predicate:
/// roughly half of all 64-hex strings are not valid curve points
/// (`deadbeef…deadbeef` is one), so a row that both validators admit can still fail
/// here. The write paths only ever store a real key's `Display`, so this is a corrupt
/// row rather than a user error, and it is surfaced rather than treated as "no key" —
/// the latter would silently reinstate the unprobeable state this helper exists to end.
pub fn peer_lock_key_from_stored(endpoint_id: &str) -> Result<String, AppError> {
    let parsed: iroh::EndpointId = endpoint_id.parse().map_err(|e| {
        AppError::validation(format!(
            "stored endpoint_id {endpoint_id:?} is not a parseable iroh EndpointId: {e}"
        ))
    })?;
    Ok(peer_lock_key(parsed))
}

// ---------------------------------------------------------------------------
// SharedEventSink — wrapper to satisfy Sized bound
// ---------------------------------------------------------------------------

/// Wrapper around `Arc<dyn SyncEventSink>` that implements `SyncEventSink`.
///
/// The blanket impl in `sync_events` requires `T: Sized`, so
/// `Arc<dyn SyncEventSink>` does not directly implement the trait.
/// This newtype bridges the gap, allowing us to pass a shared sink into
/// `SyncOrchestrator::with_event_sink`.
pub struct SharedEventSink(pub Arc<dyn SyncEventSink>);

impl SyncEventSink for SharedEventSink {
    fn on_sync_event(&self, event: SyncEvent) {
        self.0.on_sync_event(event);
    }
}

// ---------------------------------------------------------------------------
// DaemonActivation — the dormant→active observable
// ---------------------------------------------------------------------------

/// Whether the daemon has committed to the ACTIVE path — it has left the
/// dormant waiter (or never entered one) and is about to call
/// [`session_supervisor::daemon_loop`].
///
/// Not "is inside `daemon_loop`", and the difference is load-bearing for every
/// caller: on the paired-at-startup path [`SyncDaemon::start_seeded`] flips the
/// flag synchronously, *before* `tokio::spawn`, so `true` can be read before
/// the daemon task has been polled at all — and it stays `true` if
/// `daemon_loop` then returns `Err` at the QUIC bind without ever reaching its
/// `select!`. The flag states which BRANCH was taken; nothing here observes
/// the loop itself. There is deliberately no observable for that: the claim
/// worth testing is the branch, and a caller that needs the loop to be running
/// has to establish it some other way (see
/// `dormant_daemon_unaffected_when_last_peer_removed`, which does not need to).
///
/// # Why this exists (#3533, and the vacuity #3852 flagged)
///
/// The dormant waiter's transition was, until now, unobservable from outside
/// the task: `dormant_daemon_wakes_on_pair_notification` inserted a peer,
/// notified the scheduler, slept, and then asserted only that `shutdown()`
/// completed. The dormant `select!` has a `shutdown_notify` branch that
/// returns immediately, so a waiter that **never** transitioned satisfied that
/// assertion just as well as one that did — the test could not fail for the
/// reason it named. The same gap made the sleep a gamble rather than a
/// barrier: nothing in the test was actually waiting for the wake.
///
/// A `watch` channel rather than an `AtomicBool` because the interesting
/// operation is *awaiting* the transition, and `watch` is awaitable without a
/// polling loop — a poll-and-sleep observer would only move the race it was
/// added to remove. The sender is `Arc`-shared with the [`SyncDaemon`] handle,
/// so a late subscriber still sees a transition that already happened (which a
/// bare `Notify` would have dropped).
///
/// It is `false` while the daemon sits in the dormant waiter, and `true` from
/// the moment it commits to `daemon_loop` — on the dormant→active path *and*
/// on the paired-at-startup path, which calls `daemon_loop` directly. It is
/// never reset: an active daemon that later shuts down still reads `true`.
#[derive(Clone)]
pub struct DaemonActivation(Arc<tokio::sync::watch::Sender<bool>>);

impl Default for DaemonActivation {
    fn default() -> Self {
        Self(Arc::new(tokio::sync::watch::channel(false).0))
    }
}

impl DaemonActivation {
    /// Record that the daemon has committed to the active path and is about to
    /// call `daemon_loop`.
    ///
    /// `pub(crate)` so only the two start paths in this module can flip it: a
    /// flag a test could set itself would observe nothing about production.
    pub(crate) fn mark_active(&self) {
        self.0.send_replace(true);
    }

    /// Whether the daemon has committed to the active path — see
    /// [`DaemonActivation`] for why this is not "is inside `daemon_loop`".
    #[must_use]
    pub fn is_active(&self) -> bool {
        *self.0.borrow()
    }

    /// Resolve once the daemon has committed to the active path, returning
    /// `true`. Not a barrier for `daemon_loop` having been entered — see
    /// [`DaemonActivation`].
    ///
    /// Resolves immediately if the transition already happened.
    ///
    /// # Callers MUST impose a deadline
    ///
    /// Wrap this in [`tokio::time::timeout`]. It does not impose one because
    /// the deadline that matters is the caller's claim (e.g. "the *notify*
    /// wake, not the 30 s poll, made this happen") — but the omission is not
    /// merely untidy: **an unwrapped call against a daemon that dies without
    /// activating hangs forever rather than returning `false`.** The `false`
    /// path needs the watch channel to close, and the sender is owned by the
    /// [`SyncDaemon`] handle, not by the daemon task, so a shut-down-while-
    /// dormant daemon leaves the channel open with the handle still in scope.
    /// The `false` return is therefore a defence against a *dropped* handle,
    /// not against a dead daemon; only the caller's timeout covers that, and a
    /// test that hangs is worse than one that fails.
    ///
    /// Returns `false` only if the watch channel closed without the daemon
    /// activating — reported rather than swallowed so a closed channel can
    /// never be mistaken for an activation.
    ///
    /// `#[must_use]` for that last reason (#4031): the whole point of returning
    /// `false` rather than swallowing it is that the caller act on it, and
    /// `daemon.activation.wait_until_active().await;` as a statement reads as a
    /// barrier while being satisfied by a closed channel. [`is_active`] was
    /// already `#[must_use]`; the awaitable one — the one whose `false` arm the
    /// paragraph above exists to warn about — was not.
    ///
    /// The guard for that is this example, which must keep failing to compile:
    ///
    /// ```compile_fail
    /// use agaric_sync::sync_daemon::DaemonActivation;
    ///
    /// // Reads as a barrier; a dropped `SyncDaemon` handle satisfies it just as
    /// // well as an activation, and the difference is in the return value.
    /// //
    /// // `deny` on the ITEM, not a crate-level `#![deny]`: rustdoc merges
    /// // doctests into one compilation unit, and an inner attribute does not
    /// // survive that merge — the example then compiles clean and this guard
    /// // silently stops guarding.
    /// #[deny(unused_must_use)]
    /// async fn wait_for_daemon(activation: &DaemonActivation) {
    ///     activation.wait_until_active().await;
    /// }
    /// ```
    ///
    /// Removing the `#[must_use]` below makes that example compile, which makes
    /// this doctest fail — the falsification is the deletion of the attribute
    /// it guards.
    ///
    /// [`is_active`]: Self::is_active
    #[must_use = "a `false` return means the channel closed WITHOUT the daemon activating; \
                  discarding it turns this await into a barrier that anything satisfies"]
    pub async fn wait_until_active(&self) -> bool {
        let mut rx = self.0.subscribe();
        rx.wait_for(|active| *active).await.is_ok()
    }
}

// ---------------------------------------------------------------------------
// SyncDaemon — public handle
// ---------------------------------------------------------------------------

/// Handle to the background sync daemon task.
///
/// Call [`shutdown`](Self::shutdown) to signal the daemon to stop.  The
/// task will clean up mDNS announcements and close the QUIC endpoint
/// before exiting.
pub struct SyncDaemon {
    // #2621 Sync-D: `pub` so the app-hosted daemon tests can construct a
    // `SyncDaemon { … }` directly across the crate boundary.
    pub shutdown_notify: Arc<Notify>,
    pub cancel: Arc<AtomicBool>,
    /// #2537: shared scheduler handle, used by [`Self::cancel_active_sync`]
    /// to gate the cancel flag on live-session activity so a cancel with
    /// no running session can never latch the flag.
    pub scheduler: Arc<SyncScheduler>,
    /// Read only by `#[cfg(test)] mod tests` — assertions that the
    /// daemon holds a handle (e.g. in dormant mode) and to await
    /// graceful shutdown after `shutdown()`. The production drop path
    /// doesn't read it, but the field is *held* (rather than
    /// `.detach()`-ed or dropped at construction) so the spawned task
    /// is anchored to the daemon's lifetime — the `#[cfg_attr]`
    /// silences the resulting `dead_code` warning on non-test builds
    /// without sacrificing the join-able test handle.
    // #2621 Sync-D: `pub` so the app-hosted `sync_daemon::tests` (which assert on
    // the join handle across the crate boundary) can read it; also silences the
    // dead_code lint on non-test builds without the `#[cfg_attr]` gymnastics.
    pub handle: Option<JoinHandle<()>>,
    /// Whether the daemon has committed to the active path — see
    /// [`DaemonActivation`] for why the dormant→active transition needs an
    /// observable at all, and for why "committed" is not "inside the loop".
    pub activation: DaemonActivation,
}

impl SyncDaemon {
    /// Interval at which the dormant waiter re-checks the peer table.
    ///
    /// Exposed so tests can reason about the polling cadence; the dormant
    /// waiter also wakes immediately on `scheduler.notify_change()`, so
    /// pair events transition to active within milliseconds.
    pub const DORMANT_POLL_INTERVAL: Duration = Duration::from_secs(30);

    /// Count the paired peers to decide whether the daemon should
    /// enter active mode on startup.
    ///
    /// Returns `Ok(true)` when at least one paired peer exists — the
    /// daemon must initialize mDNS and the QUIC endpoint right away.
    /// Returns `Ok(false)` when no peers exist — the daemon can skip mDNS
    /// multicast traffic and endpoint binding until the user pairs a device.
    ///
    /// On query failure, returns the underlying error; callers should fail
    /// open (start the full daemon) rather than silently staying dormant,
    /// because a transient DB issue must not prevent sync.
    pub async fn should_start_active(pool: &SqlitePool) -> Result<bool, AppError> {
        let peers = peer_refs::list_peer_refs(pool).await?;
        if !peers.is_empty() {
            // A real peer exists — the pending-pairing activation bridge (if
            // any) is no longer needed. Clear it for hygiene; best-effort so a
            // failed clear never prevents the daemon from going active.
            if let Err(e) = peer_refs::clear_pending_pairing(pool).await {
                tracing::warn!(error = %e, "failed to clear pending-pairing marker");
            }
            return Ok(true);
        }
        // No real peers yet — activate iff a pairing is awaiting
        // its first peer connection. `confirm_pairing` sets this marker so the
        // dormant daemon wakes to accept that first inbound connection (the
        // TOFU path then writes the real peer row). Replaces the old junk
        // empty-string `peer_refs` row that used to force activation here.
        peer_refs::is_pending_pairing(pool).await
    }

    /// Spawn the daemon only if peers exist, otherwise start a
    /// dormant waiter that transitions to active once peers appear.
    ///
    /// This avoids mDNS announce/browse, QUIC endpoint binding, and the
    /// 30s resync tick for users who have not yet paired a device. On
    /// first-launch (the common case), it is a pure overhead save.
    ///
    /// ## Wake mechanisms
    ///
    /// The dormant waiter observes peer arrival through two channels:
    /// 1. A periodic poll (`DORMANT_POLL_INTERVAL`, default 30 s) so the
    ///    daemon eventually transitions even if no signal is delivered.
    /// 2. `scheduler.wait_for_debounced_change()` — `confirm_pairing`
    ///    calls `scheduler.notify_change()` after a successful pair, so
    ///    the transition typically happens within milliseconds.
    ///
    /// On DB error the daemon falls back to active startup so a transient
    /// failure does not disable sync.
    pub async fn start_if_peers_exist(
        pool: SqlitePool,
        device_id: String,
        materializer: Arc<dyn ApplyHost>,
        scheduler: Arc<SyncScheduler>,
        endpoint_secret: SecretKey,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, AppError> {
        Self::start_if_peers_exist_with_lifecycle(SyncDaemonContext {
            pool,
            device_id,
            materializer,
            scheduler,
            endpoint_secret,
            event_sink,
            cancel,
            lifecycle: LifecycleHooks::default(),
        })
        .await
    }

    /// Lifecycle-aware variant of [`Self::start_if_peers_exist`].
    ///
    /// The `lifecycle` hooks are propagated into the full daemon loop so
    /// the periodic resync tick skips its body while the app is
    /// backgrounded and wakes immediately on foreground transitions.
    pub async fn start_if_peers_exist_with_lifecycle(
        ctx: SyncDaemonContext,
    ) -> Result<Self, AppError> {
        // A pending-pairing marker is only meaningful while the in-memory
        // `PairingSession` that armed it (in `start_pairing_armed_inner` /
        // `confirm_pairing_inner`) is alive. That session lives in
        // Tauri-managed state and never survives a process restart, so any
        // marker still present at *startup* is orphaned — there is no
        // interactive pairing it could belong to. Left in place it drives
        // `should_start_active` straight into the active mDNS + QUIC-endpoint
        // path on every launch until the marker's TTL elapses. On Android
        // that startup path can crash the process (release builds use
        // `panic = "abort"`, and a native JNI fault is uncatchable either
        // way), so a single mid-pairing crash would otherwise recur on every
        // relaunch for the whole TTL window — a boot crash-loop. Clear the
        // stale marker first so a fresh process only goes active for a *real*
        // paired peer; an in-session pairing still wakes the dormant waiter
        // via `scheduler.notify_change()`. Best-effort: a failed clear must
        // not block startup.
        if let Err(e) = peer_refs::clear_pending_pairing(&ctx.pool).await {
            tracing::warn!(
                error = %e,
                "failed to clear stale pending-pairing marker at startup"
            );
        }

        match Self::should_start_active(&ctx.pool).await {
            Ok(true) => {
                // Paired peers already exist — start the full daemon.
                Self::start_with_lifecycle(ctx).await
            }
            Ok(false) => {
                // No paired peers — spawn a lightweight waiter. The mDNS
                // service and QUIC endpoint are NOT initialized here; they
                // are created only once the user pairs a device.
                tracing::info!(
                    "SyncDaemon starting in dormant mode (no paired peers, mDNS and QUIC endpoint deferred)"
                );
                Self::spawn_dormant_waiter(ctx)
            }
            Err(e) => {
                // Fail-open: a transient DB query error must not keep the
                // daemon dormant forever. Log and proceed with normal
                // startup — the daemon's own `list_peer_refs` calls will
                // retry each cycle.
                tracing::warn!(
                    error = %e,
                    "peer_refs query failed at daemon start; falling back to active startup"
                );
                Self::start_with_lifecycle(ctx).await
            }
        }
    }

    /// Internal: spawn the dormant waiter task that polls for peers and
    /// transitions to the full `daemon_loop` when any arrive.
    fn spawn_dormant_waiter(ctx: SyncDaemonContext) -> Result<Self, AppError> {
        let shutdown_notify = Arc::new(Notify::new());
        let shutdown_notify_task = shutdown_notify.clone();
        // Clone the shared cancel flag + scheduler for the returned handle;
        // the owned `ctx` (carrying the same Arcs) is moved into
        // `daemon_loop` below.
        let cancel = ctx.cancel.clone();
        let scheduler = ctx.scheduler.clone();
        let activation = DaemonActivation::default();
        let activation_task = activation.clone();

        let handle = tokio::spawn(async move {
            let mut poll = tokio::time::interval(Self::DORMANT_POLL_INTERVAL);
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Burn the first immediate tick so we don't double-query on start.
            poll.tick().await;

            loop {
                tokio::select! {
                    _ = poll.tick() => {
                        if peers_appeared(&ctx.pool).await {
                            break;
                        }
                    }
                    () = ctx.scheduler.wait_for_debounced_change() => {
                        // Likely a pair event; recheck immediately.
                        if peers_appeared(&ctx.pool).await {
                            break;
                        }
                    }
                    () = shutdown_notify_task.notified() => {
                        tracing::info!("SyncDaemon shutdown received while dormant");
                        return;
                    }
                }
            }

            tracing::info!(
                "SyncDaemon transitioning from dormant to active (paired peer detected)"
            );
            // Publish the transition before the loop runs, not after: the claim
            // under test is that the waiter *left* the dormant select!, and
            // `daemon_loop` only returns at shutdown (or on a bind error), so a
            // flag set on the far side of the call would never be observed.
            activation_task.mark_active();

            if let Err(e) =
                session_supervisor::daemon_loop(ctx, shutdown_notify_task, DiscoveredPeers::new())
                    .await
            {
                tracing::error!(error = %e, "SyncDaemon (post-dormant) exited with error");
            }
        });

        Ok(Self {
            shutdown_notify,
            cancel,
            scheduler,
            handle: Some(handle),
            activation,
        })
    }

    /// Spawn the background daemon task.
    ///
    /// The daemon will:
    /// 1. Bind the QUIC endpoint and accept incoming connections.
    /// 2. Announce this device via mDNS.
    /// 3. Browse for peers and sync with any that are already paired.
    /// 4. React to local-change notifications from the scheduler.
    /// 5. Periodically re-sync with peers that are overdue.
    pub async fn start(
        pool: SqlitePool,
        device_id: String,
        materializer: Arc<dyn ApplyHost>,
        scheduler: Arc<SyncScheduler>,
        endpoint_secret: SecretKey,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, AppError> {
        Self::start_with_lifecycle(SyncDaemonContext {
            pool,
            device_id,
            materializer,
            scheduler,
            endpoint_secret,
            event_sink,
            cancel,
            lifecycle: LifecycleHooks::default(),
        })
        .await
    }

    /// Lifecycle-aware variant of [`Self::start`].
    ///
    /// The daemon's periodic resync tick short-circuits when
    /// `lifecycle.is_foreground` is `false`, and wakes immediately when
    /// `lifecycle.wake` is notified.
    pub async fn start_with_lifecycle(ctx: SyncDaemonContext) -> Result<Self, AppError> {
        Self::start_seeded(ctx, DiscoveredPeers::new()).await
    }

    /// [`Self::start_with_lifecycle`] with `daemon_loop`'s discovered-peer map
    /// pre-seeded — the #3533 seam.
    ///
    /// # Why this exists
    ///
    /// `daemon_loop`'s `discovered` map is written by exactly one thing: Branch
    /// A, on a real `mdns_rx.recv()`. Branch B's pairing-window round
    /// ([`peers_for_change_round`], #3502 Part 2) is the only *reader*, so with
    /// no way to put a peer in that map from outside, reverting Branch B's call
    /// to the helper turned nothing red — the helper's own unit tests pass a map
    /// they construct themselves and never enter `daemon_loop`, and #3507's
    /// two-device harness calls `process_discovery_event` and
    /// `try_sync_with_peer` directly rather than through the loop.
    ///
    /// Seeding the map is the smallest thing that makes Branch B reachable
    /// without a live mDNS responder announcing at the right instant. It is
    /// gated behind `test-util` so production cannot acquire a second way to
    /// populate discovery: Branch A remains the only one.
    #[cfg(any(test, feature = "test-util"))]
    pub async fn start_with_lifecycle_seeded(
        ctx: SyncDaemonContext,
        discovered: DiscoveredPeers,
    ) -> Result<Self, AppError> {
        Self::start_seeded(ctx, discovered).await
    }

    /// Shared body of [`Self::start_with_lifecycle`] and its seeded variant.
    async fn start_seeded(
        ctx: SyncDaemonContext,
        discovered: DiscoveredPeers,
    ) -> Result<Self, AppError> {
        let shutdown_notify = Arc::new(Notify::new());
        let shutdown_notify_flag = shutdown_notify.clone();
        // Clone the shared cancel flag + scheduler for the returned handle;
        // the owned `ctx` (carrying the same Arcs) is moved into
        // `daemon_loop` below.
        let cancel = ctx.cancel.clone();
        let scheduler = ctx.scheduler.clone();
        // This path *is* the active one — there is no dormant waiter to leave,
        // so the daemon is active from the start rather than at some later
        // transition. Flipped here, synchronously, BEFORE `tokio::spawn`: the
        // caller therefore observes `true` the instant `start_seeded` returns,
        // which is what makes this a statement about the branch taken and not
        // about the task's progress. See [`DaemonActivation`].
        let activation = DaemonActivation::default();
        activation.mark_active();

        let handle = tokio::spawn(async move {
            if let Err(e) =
                session_supervisor::daemon_loop(ctx, shutdown_notify_flag, discovered).await
            {
                tracing::error!(error = %e, "SyncDaemon exited with error");
            }
        });

        Ok(Self {
            shutdown_notify,
            cancel,
            scheduler,
            handle: Some(handle),
            activation,
        })
    }

    /// Signal the daemon to shut down gracefully.
    pub fn shutdown(&self) {
        self.shutdown_notify.notify_one();
    }

    /// Signal the active sync session(s) to cancel.
    ///
    /// The cancellation flag is checked each iteration of the message
    /// exchange loops in `run_sync_session` (initiator) and
    /// `handle_incoming_sync` (responder).
    ///
    /// #2537: the flag is only latched while a session is actually live
    /// ([`SyncScheduler::request_cancel`]); with nothing running the call
    /// is a no-op. Previously the flag was stored unconditionally and the
    /// only resetter was the initiator-side session guard — a cancel with
    /// no active session latched `true` forever, instantly failing every
    /// inbound session and burning (plus back-off-penalising) the next
    /// outbound one just to clear it.
    pub fn cancel_active_sync(&self) {
        if !self.scheduler.request_cancel(&self.cancel) {
            tracing::debug!("cancel_active_sync ignored: no sync session is active");
        }
    }
}

/// / #466: peek at the peer table from the dormant waiter.
///
/// Returns `true` if at least one paired peer row exists, OR if a
/// pending-pairing marker is set (QR-only pairing path: no peer row exists
/// yet, but `confirm_pairing` set the marker so the daemon must wake to
/// accept the TOFU inbound connection). Mirrors the same OR-condition used
/// in `SyncDaemon::should_start_active`. Any DB error is logged at `warn!`
/// and treated as "no peers" so the waiter loops again instead of crashing.
pub async fn peers_appeared(pool: &SqlitePool) -> bool {
    match SyncDaemon::should_start_active(pool).await {
        Ok(active) => active,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "peer_refs query failed in dormant waiter; remaining dormant"
            );
            false
        }
    }
}

#[cfg(test)]
mod peer_lock_key_tests {
    use super::{peer_lock_key, peer_lock_key_from_stored};
    use agaric_core::error::AppError;

    /// The property the helper exists for: the stored spelling round-trips to the
    /// key the daemon locks under, without the caller ever spelling it itself.
    #[test]
    fn from_stored_agrees_with_peer_lock_key_for_a_real_key() {
        let key = crate::transport::SecretKey::generate().public();
        let stored = key.to_string();

        assert_eq!(
            peer_lock_key_from_stored(&stored).unwrap(),
            peer_lock_key(key),
            "the stored round trip must land on the daemon's key"
        );
    }

    /// #3550 review: the storage layer's validation is *weaker* than parsing.
    ///
    /// `peer_refs::validate_endpoint_id` and migration 0107's column CHECK both
    /// test spelling only — 64 lowercase hex — while `EndpointId`'s `FromStr` also
    /// decompresses the ed25519 point. `deadbeef…` satisfies both validators and is
    /// still not a curve point, so this is a value the table genuinely admits and
    /// this helper genuinely rejects. Pins that the rejection is a named
    /// `Validation` error rather than a panic or a silent "no key".
    #[test]
    fn from_stored_rejects_a_check_valid_but_uncompressable_endpoint_id() {
        let corrupt = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        assert_eq!(corrupt.len(), 64, "fixture must satisfy the column CHECK");
        assert!(
            corrupt
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "fixture must satisfy the column CHECK"
        );

        let err = peer_lock_key_from_stored(corrupt)
            .expect_err("a non-curve-point must not yield a lock key");
        assert!(
            matches!(err, AppError::Validation { ref message, .. } if message.contains(corrupt)),
            "expected a Validation error naming the offending value, got: {err:?}"
        );
    }

    #[test]
    fn from_stored_rejects_truncated_and_empty_input() {
        for bad in ["", "abcd", "not-hex-at-all"] {
            assert!(
                peer_lock_key_from_stored(bad).is_err(),
                "{bad:?} must not yield a lock key"
            );
        }
    }
}
