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
//! - **Responder (#615):** accepts inbound TLS WebSocket connections,
//!   receives the initiator's HeadExchange, computes and sends missing
//!   ops, and completes the session.  Per-peer mutual exclusion prevents
//!   concurrent sync sessions with the same device.

mod discovery;
mod orchestrator;
mod server;
mod snapshot_transfer;

// Android-only: acquire WifiManager.MulticastLock at daemon start so the
// `mdns-sd` crate's UDP multicast sockets receive packets (BUG-39).
#[cfg(target_os = "android")]
pub(crate) mod android_multicast;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::lifecycle::LifecycleHooks;
use crate::materializer::Materializer;
use crate::peer_refs;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_net::SyncCert;
use crate::sync_scheduler::SyncScheduler;

// Re-export submodule items
pub use discovery::{
    build_fallback_peer, format_peer_address, format_peer_addresses, get_peer_cert_hash,
    process_discovery_event, process_service_removed, resolve_peer_address,
    should_attempt_sync_with_discovered_peer, should_store_cert_hash,
};
#[allow(unused_imports)]
pub(crate) use orchestrator::{run_sync_session, try_sync_with_peer};
#[allow(unused_imports)]
pub(crate) use server::{handle_incoming_sync, verify_peer_cert, CertVerifyResult};

// ---------------------------------------------------------------------------
// SharedEventSink — wrapper to satisfy Sized bound
// ---------------------------------------------------------------------------

/// Wrapper around `Arc<dyn SyncEventSink>` that implements `SyncEventSink`.
///
/// The blanket impl in `sync_events` requires `T: Sized`, so
/// `Arc<dyn SyncEventSink>` does not directly implement the trait.
/// This newtype bridges the gap, allowing us to pass a shared sink into
/// `SyncOrchestrator::with_event_sink`.
pub(super) struct SharedEventSink(pub(super) Arc<dyn SyncEventSink>);

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
/// task will clean up mDNS announcements and the WebSocket server before
/// exiting.
pub struct SyncDaemon {
    shutdown_notify: Arc<Notify>,
    cancel: Arc<AtomicBool>,
    /// Read only by `#[cfg(test)] mod tests` — assertions that the
    /// daemon holds a handle (e.g. in dormant mode) and to await
    /// graceful shutdown. The production drop path doesn't need it.
    #[cfg_attr(not(test), allow(dead_code))]
    handle: Option<JoinHandle<()>>,
}

impl SyncDaemon {
    /// Interval at which the dormant waiter re-checks the peer table.
    ///
    /// Exposed so tests can reason about the polling cadence; the dormant
    /// waiter also wakes immediately on `scheduler.notify_change()`, so
    /// pair events transition to active within milliseconds.
    pub const DORMANT_POLL_INTERVAL: Duration = Duration::from_secs(30);

    /// PERF-25: count the paired peers to decide whether the daemon should
    /// enter active mode on startup.
    ///
    /// Returns `Ok(true)` when at least one paired peer exists — the
    /// daemon must initialize mDNS and the TLS listener right away.
    /// Returns `Ok(false)` when no peers exist — the daemon can skip mDNS
    /// multicast traffic and TCP listening until the user pairs a device.
    ///
    /// On query failure, returns the underlying error; callers should fail
    /// open (start the full daemon) rather than silently staying dormant,
    /// because a transient DB issue must not prevent sync.
    pub async fn should_start_active(pool: &SqlitePool) -> Result<bool, AppError> {
        let peers = peer_refs::list_peer_refs(pool).await?;
        Ok(!peers.is_empty())
    }

    /// PERF-25: Spawn the daemon only if peers exist, otherwise start a
    /// dormant waiter that transitions to active once peers appear.
    ///
    /// This avoids mDNS announce/browse, TLS listener binding, and the
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
    #[allow(clippy::too_many_arguments)]
    pub async fn start_if_peers_exist(
        pool: SqlitePool,
        device_id: String,
        materializer: Materializer,
        scheduler: Arc<SyncScheduler>,
        cert: SyncCert,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, AppError> {
        Self::start_if_peers_exist_with_lifecycle(
            pool,
            device_id,
            materializer,
            scheduler,
            cert,
            event_sink,
            cancel,
            LifecycleHooks::default(),
        )
        .await
    }

    /// PERF-24: lifecycle-aware variant of [`Self::start_if_peers_exist`].
    ///
    /// The `lifecycle` hooks are propagated into the full daemon loop so
    /// the periodic resync tick skips its body while the app is
    /// backgrounded and wakes immediately on foreground transitions.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_if_peers_exist_with_lifecycle(
        pool: SqlitePool,
        device_id: String,
        materializer: Materializer,
        scheduler: Arc<SyncScheduler>,
        cert: SyncCert,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
        lifecycle: LifecycleHooks,
    ) -> Result<Self, AppError> {
        match Self::should_start_active(&pool).await {
            Ok(true) => {
                // Paired peers already exist — start the full daemon.
                Self::start_with_lifecycle(
                    pool,
                    device_id,
                    materializer,
                    scheduler,
                    cert,
                    event_sink,
                    cancel,
                    lifecycle,
                )
                .await
            }
            Ok(false) => {
                // No paired peers — spawn a lightweight waiter. The mDNS
                // service and TLS listener are NOT initialized here; they
                // are created only once the user pairs a device.
                tracing::info!(
                    "SyncDaemon starting in dormant mode (no paired peers, mDNS and TLS listener deferred)"
                );
                Self::spawn_dormant_waiter(
                    pool,
                    device_id,
                    materializer,
                    scheduler,
                    cert,
                    event_sink,
                    cancel,
                    lifecycle,
                )
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
                Self::start_with_lifecycle(
                    pool,
                    device_id,
                    materializer,
                    scheduler,
                    cert,
                    event_sink,
                    cancel,
                    lifecycle,
                )
                .await
            }
        }
    }

    /// Internal: spawn the dormant waiter task that polls for peers and
    /// transitions to the full `daemon_loop` when any arrive.
    #[allow(clippy::too_many_arguments)]
    fn spawn_dormant_waiter(
        pool: SqlitePool,
        device_id: String,
        materializer: Materializer,
        scheduler: Arc<SyncScheduler>,
        cert: SyncCert,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
        lifecycle: LifecycleHooks,
    ) -> Result<Self, AppError> {
        let shutdown_notify = Arc::new(Notify::new());
        let shutdown_notify_task = shutdown_notify.clone();
        let cancel_flag = cancel.clone();

        let handle = tokio::spawn(async move {
            let mut poll = tokio::time::interval(Self::DORMANT_POLL_INTERVAL);
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Burn the first immediate tick so we don't double-query on start.
            poll.tick().await;

            loop {
                tokio::select! {
                    _ = poll.tick() => {
                        if peers_appeared(&pool).await {
                            break;
                        }
                    }
                    _ = scheduler.wait_for_debounced_change() => {
                        // Likely a pair event; recheck immediately.
                        if peers_appeared(&pool).await {
                            break;
                        }
                    }
                    _ = shutdown_notify_task.notified() => {
                        tracing::info!("SyncDaemon shutdown received while dormant");
                        return;
                    }
                }
            }

            tracing::info!(
                "SyncDaemon transitioning from dormant to active (paired peer detected)"
            );

            if let Err(e) = orchestrator::daemon_loop(
                pool,
                device_id,
                materializer,
                scheduler,
                cert,
                event_sink,
                shutdown_notify_task,
                cancel_flag,
                lifecycle,
            )
            .await
            {
                tracing::error!(error = %e, "SyncDaemon (post-dormant) exited with error");
            }
        });

        Ok(Self {
            shutdown_notify,
            cancel,
            handle: Some(handle),
        })
    }

    /// Spawn the background daemon task.
    ///
    /// The daemon will:
    /// 1. Start a TLS WebSocket server for incoming connections.
    /// 2. Announce this device via mDNS.
    /// 3. Browse for peers and sync with any that are already paired.
    /// 4. React to local-change notifications from the scheduler.
    /// 5. Periodically re-sync with peers that are overdue.
    pub async fn start(
        pool: SqlitePool,
        device_id: String,
        materializer: Materializer,
        scheduler: Arc<SyncScheduler>,
        cert: SyncCert,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, AppError> {
        Self::start_with_lifecycle(
            pool,
            device_id,
            materializer,
            scheduler,
            cert,
            event_sink,
            cancel,
            LifecycleHooks::default(),
        )
        .await
    }

    /// PERF-24: lifecycle-aware variant of [`Self::start`].
    ///
    /// The daemon's periodic resync tick short-circuits when
    /// `lifecycle.is_foreground` is `false`, and wakes immediately when
    /// `lifecycle.wake` is notified.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_with_lifecycle(
        pool: SqlitePool,
        device_id: String,
        materializer: Materializer,
        scheduler: Arc<SyncScheduler>,
        cert: SyncCert,
        event_sink: Arc<dyn SyncEventSink>,
        cancel: Arc<AtomicBool>,
        lifecycle: LifecycleHooks,
    ) -> Result<Self, AppError> {
        let shutdown_notify = Arc::new(Notify::new());
        let shutdown_notify_flag = shutdown_notify.clone();
        let cancel_flag = cancel.clone();

        let handle = tokio::spawn(async move {
            if let Err(e) = orchestrator::daemon_loop(
                pool,
                device_id,
                materializer,
                scheduler,
                cert,
                event_sink,
                shutdown_notify_flag,
                cancel_flag,
                lifecycle,
            )
            .await
            {
                tracing::error!(error = %e, "SyncDaemon exited with error");
            }
        });

        Ok(Self {
            shutdown_notify,
            cancel,
            handle: Some(handle),
        })
    }

    /// Signal the daemon to shut down gracefully.
    pub fn shutdown(&self) {
        self.shutdown_notify.notify_one();
    }

    /// Signal the active sync session to cancel.
    ///
    /// The cancellation flag is checked each iteration of the message exchange
    /// loop in `run_sync_session`.  If no sync is active the flag is harmlessly
    /// cleared on the next session attempt.
    pub fn cancel_active_sync(&self) {
        self.cancel.store(true, Ordering::Release);
    }
}

/// PERF-25: peek at the peer table from the dormant waiter.
///
/// Returns `true` if at least one paired peer row exists. Any DB error
/// is logged at `warn!` and treated as "no peers" so the waiter loops
/// again instead of crashing — this matches the fail-open stance in
/// `SyncDaemon::start_if_peers_exist`.
async fn peers_appeared(pool: &SqlitePool) -> bool {
    match peer_refs::list_peer_refs(pool).await {
        Ok(peers) => !peers.is_empty(),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "peer_refs query failed in dormant waiter; remaining dormant"
            );
            false
        }
    }
}
