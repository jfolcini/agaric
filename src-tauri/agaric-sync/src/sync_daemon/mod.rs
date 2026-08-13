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
    build_fallback_peer, format_peer_addresses, get_peer_cert_hash, peers_for_change_round,
    process_discovery_event, resolve_peer_address, should_attempt_sync_with_discovered_peer,
    should_store_cert_hash,
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
        materializer: impl Into<Arc<dyn ApplyHost>>,
        scheduler: Arc<SyncScheduler>,
        endpoint_secret: SecretKey,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, AppError> {
        Self::start_if_peers_exist_with_lifecycle(SyncDaemonContext {
            pool,
            device_id,
            materializer: materializer.into(),
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

            if let Err(e) = session_supervisor::daemon_loop(ctx, shutdown_notify_task).await {
                tracing::error!(error = %e, "SyncDaemon (post-dormant) exited with error");
            }
        });

        Ok(Self {
            shutdown_notify,
            cancel,
            scheduler,
            handle: Some(handle),
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
        materializer: impl Into<Arc<dyn ApplyHost>>,
        scheduler: Arc<SyncScheduler>,
        endpoint_secret: SecretKey,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, AppError> {
        Self::start_with_lifecycle(SyncDaemonContext {
            pool,
            device_id,
            materializer: materializer.into(),
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
        let shutdown_notify = Arc::new(Notify::new());
        let shutdown_notify_flag = shutdown_notify.clone();
        // Clone the shared cancel flag + scheduler for the returned handle;
        // the owned `ctx` (carrying the same Arcs) is moved into
        // `daemon_loop` below.
        let cancel = ctx.cancel.clone();
        let scheduler = ctx.scheduler.clone();

        let handle = tokio::spawn(async move {
            if let Err(e) = session_supervisor::daemon_loop(ctx, shutdown_notify_flag).await {
                tracing::error!(error = %e, "SyncDaemon exited with error");
            }
        });

        Ok(Self {
            shutdown_notify,
            cancel,
            scheduler,
            handle: Some(handle),
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
