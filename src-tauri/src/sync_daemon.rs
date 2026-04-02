//! Auto-sync daemon — background orchestrator for peer discovery,
//! connection, and sync sessions.
//!
//! Ties together mDNS discovery (#383), the sync protocol orchestrator,
//! and the scheduler's exponential backoff (#278).  The daemon runs as
//! a single `tokio::spawn` task for the lifetime of the application.
//!
//! **Current scope:** initiator-only mode.  The daemon discovers peers,
//! connects outbound, and drives sync sessions.  Responder-mode (accepting
//! inbound connections) is stubbed but not yet wired.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::materializer::Materializer;
use crate::peer_refs::{self, PeerRef};
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_net::{self, DiscoveredPeer, MdnsService, SyncCert, SyncConnection, SyncServer};
use crate::sync_protocol::{SyncMessage, SyncOrchestrator, SyncState};
use crate::sync_scheduler::SyncScheduler;

// ---------------------------------------------------------------------------
// SharedEventSink — wrapper to satisfy Sized bound
// ---------------------------------------------------------------------------

/// Wrapper around `Arc<dyn SyncEventSink>` that implements `SyncEventSink`.
///
/// The blanket impl in `sync_events` requires `T: Sized`, so
/// `Arc<dyn SyncEventSink>` does not directly implement the trait.
/// This newtype bridges the gap, allowing us to pass a shared sink into
/// `SyncOrchestrator::with_event_sink`.
struct SharedEventSink(Arc<dyn SyncEventSink>);

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
    ) -> Result<Self, AppError> {
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_flag = shutdown.clone();

        let handle = tokio::spawn(async move {
            if let Err(e) = daemon_loop(
                pool,
                device_id,
                materializer,
                scheduler,
                cert,
                event_sink,
                shutdown_flag,
            )
            .await
            {
                tracing::error!("SyncDaemon exited with error: {e}");
            }
        });

        Ok(Self {
            shutdown,
            handle: Some(handle),
        })
    }

    /// Signal the daemon to shut down gracefully.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// daemon_loop — the core async select! loop
// ---------------------------------------------------------------------------

/// Main loop for the sync daemon.
///
/// Alternates between polling mDNS discovery events and waiting for
/// debounced local-change notifications.  On every iteration it also
/// checks whether any peers are due for a periodic resync.
async fn daemon_loop(
    pool: SqlitePool,
    device_id: String,
    materializer: Materializer,
    scheduler: Arc<SyncScheduler>,
    cert: SyncCert,
    event_sink: Arc<dyn SyncEventSink>,
    shutdown: Arc<AtomicBool>,
) -> Result<(), AppError> {
    // 1. Start mDNS service
    let mdns = MdnsService::new()?;

    // 2. Start TLS WebSocket server (responder mode is a placeholder)
    let (server, port) = SyncServer::start(&cert, |_conn| {
        // TODO(#382): wire responder-mode sync sessions
        tracing::info!("incoming sync connection received (responder not yet wired)");
    })
    .await?;

    // 3. Announce this device on mDNS
    mdns.announce(&device_id, port)?;
    tracing::info!(port, "SyncDaemon started, mDNS announced");

    // 4. Start mDNS browse
    let browse_rx = mdns.browse()?;

    // 5. Maintain discovered peers (device_id → DiscoveredPeer)
    let mut discovered: HashMap<String, DiscoveredPeer> = HashMap::new();

    // 6. Main loop
    loop {
        if shutdown.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            // Branch A: poll mDNS discovery events (~500ms tick)
            //
            // `browse_rx` is a `mdns_sd::Receiver` (backed by flume) which
            // does not expose an async `.recv()` that works natively in
            // tokio::select!.  Instead we tick and drain via `try_recv()`.
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                while let Ok(event) = browse_rx.try_recv() {
                    if let Some(peer) = sync_net::parse_service_event(event) {
                        if peer.device_id != device_id {
                            let is_new = !discovered.contains_key(&peer.device_id);
                            discovered.insert(peer.device_id.clone(), peer.clone());
                            if is_new {
                                tracing::info!(
                                    peer_id = %peer.device_id,
                                    "discovered new peer via mDNS"
                                );
                                // If this peer is already paired, sync immediately
                                let refs = peer_refs::list_peer_refs(&pool)
                                    .await
                                    .unwrap_or_else(|e| {
                                        tracing::warn!("list_peer_refs failed: {e}");
                                        vec![]
                                    });
                                if refs.iter().any(|p| p.peer_id == peer.device_id) {
                                    try_sync_with_peer(
                                        &pool,
                                        &device_id,
                                        &materializer,
                                        &scheduler,
                                        &event_sink,
                                        &peer,
                                        &refs,
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                }
            }

            // Branch B: debounced local-change notification
            _ = scheduler.wait_for_debounced_change() => {
                let refs = peer_refs::list_peer_refs(&pool).await.unwrap_or_else(|e| {
                    tracing::warn!("list_peer_refs failed: {e}");
                    vec![]
                });
                for peer_ref in &refs {
                    if let Some(dp) = discovered.get(&peer_ref.peer_id) {
                        try_sync_with_peer(
                            &pool,
                            &device_id,
                            &materializer,
                            &scheduler,
                            &event_sink,
                            dp,
                            &refs,
                        )
                        .await;
                    }
                }
            }
        }

        // Periodic resync check (runs every loop iteration, ~500ms cadence)
        let refs = peer_refs::list_peer_refs(&pool).await.unwrap_or_else(|e| {
            tracing::warn!("list_peer_refs failed: {e}");
            vec![]
        });
        let peer_tuples: Vec<(String, Option<String>)> = refs
            .iter()
            .map(|p| (p.peer_id.clone(), p.synced_at.clone()))
            .collect();
        let due = scheduler.peers_due_for_resync(&peer_tuples);
        for pid in due {
            if let Some(dp) = discovered.get(&pid) {
                try_sync_with_peer(
                    &pool,
                    &device_id,
                    &materializer,
                    &scheduler,
                    &event_sink,
                    dp,
                    &refs,
                )
                .await;
            }
        }
    }

    // Cleanup
    server.shutdown().await;
    if let Err(e) = mdns.shutdown() {
        tracing::warn!("mDNS shutdown error: {e}");
    }
    tracing::info!("SyncDaemon shut down cleanly");
    Ok(())
}

// ---------------------------------------------------------------------------
// try_sync_with_peer — single sync session with backoff
// ---------------------------------------------------------------------------

/// Attempt to sync with a single discovered peer.
///
/// Respects the scheduler's per-peer backoff (#278) and mutual-exclusion
/// lock.  On success the backoff is reset; on failure a failure is recorded
/// which doubles the next retry delay.
async fn try_sync_with_peer(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    scheduler: &SyncScheduler,
    event_sink: &Arc<dyn SyncEventSink>,
    peer: &DiscoveredPeer,
    peer_refs: &[PeerRef],
) {
    let peer_id = &peer.device_id;

    // 1. Backoff gate
    if !scheduler.may_retry(peer_id) {
        return;
    }

    // 2. Per-peer mutex (prevents concurrent syncs to the same peer)
    let _guard = match scheduler.try_lock_peer(peer_id) {
        Some(g) => g,
        None => return, // already syncing with this peer
    };

    // 3. Resolve address from discovered peer info
    let addr = match peer.addresses.first() {
        Some(ip) => format!("{ip}:{}", peer.port),
        None => {
            tracing::warn!(peer_id, "peer has no addresses, skipping sync");
            return;
        }
    };

    // 4. Look up cert hash for TLS certificate pinning
    let cert_hash = peer_refs
        .iter()
        .find(|p| p.peer_id == *peer_id)
        .and_then(|p| p.cert_hash.clone());

    // 5. Emit "connecting" progress event
    event_sink.on_sync_event(SyncEvent::Progress {
        state: "connecting".into(),
        remote_device_id: peer_id.clone(),
        ops_received: 0,
        ops_sent: 0,
    });

    // 6. Connect to peer with optional cert pinning (#278: reconnect with backoff)
    let mut conn = match sync_net::connect_to_peer(&addr, cert_hash.as_deref()).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(peer_id, error = %e, "failed to connect to peer");
            scheduler.record_failure(peer_id);
            event_sink.on_sync_event(SyncEvent::Error {
                message: format!("Connection failed: {e}"),
                remote_device_id: peer_id.clone(),
            });
            return;
        }
    };

    // 7. Run sync protocol through the orchestrator
    let event_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(Arc::clone(event_sink)));
    let mut orch = SyncOrchestrator::new(pool.clone(), device_id.to_string(), materializer.clone())
        .with_event_sink(event_sink_box);

    match run_sync_session(&mut orch, &mut conn).await {
        Ok(()) => {
            scheduler.record_success(peer_id);
            let session = orch.session();
            event_sink.on_sync_event(SyncEvent::Complete {
                remote_device_id: peer_id.clone(),
                ops_received: session.ops_received,
                ops_sent: session.ops_sent,
            });
            tracing::info!(
                peer_id,
                ops_rx = session.ops_received,
                ops_tx = session.ops_sent,
                "sync complete"
            );
        }
        Err(e) => {
            scheduler.record_failure(peer_id);
            event_sink.on_sync_event(SyncEvent::Error {
                message: format!("Sync failed: {e}"),
                remote_device_id: peer_id.clone(),
            });
            tracing::warn!(peer_id, error = %e, "sync session failed");
        }
    }

    let _ = conn.close().await;
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
async fn run_sync_session(
    orch: &mut SyncOrchestrator,
    conn: &mut SyncConnection,
) -> Result<(), AppError> {
    // Initiator sends first message
    let first_msg = orch.start().await?;
    conn.send_json(&first_msg).await?;

    // Exchange messages until complete
    while !orch.is_complete() {
        let incoming: SyncMessage = conn.recv_json().await?;
        match orch.handle_message(incoming).await? {
            Some(response) => {
                conn.send_json(&response).await?;
            }
            None => {
                // No response to send — check if we hit a terminal error state
                // so we don't hang waiting for a message that will never arrive.
                let state = &orch.session().state;
                if matches!(state, SyncState::Failed(_) | SyncState::ResetRequired) {
                    return Err(AppError::InvalidOperation(format!(
                        "sync ended in terminal state: {state:?}"
                    )));
                }
            }
        }
    }

    Ok(())
}
