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

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::materializer::Materializer;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_net::SyncCert;
use crate::sync_scheduler::SyncScheduler;

// Re-export submodule items
pub use discovery::{
    build_fallback_peer, format_peer_address, get_peer_cert_hash, process_discovery_event,
    resolve_peer_address, should_attempt_sync_with_discovered_peer, should_store_cert_hash,
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
    shutdown: Arc<AtomicBool>,
    shutdown_notify: Arc<Notify>,
    cancel: Arc<AtomicBool>,
    #[allow(dead_code)]
    handle: Option<JoinHandle<()>>,
}

impl SyncDaemon {
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
        let shutdown = Arc::new(AtomicBool::new(false));
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
            )
            .await
            {
                tracing::error!(error = %e, "SyncDaemon exited with error");
            }
        });

        Ok(Self {
            shutdown,
            shutdown_notify,
            cancel,
            handle: Some(handle),
        })
    }

    /// Signal the daemon to shut down gracefully.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
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
