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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::Notify;
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
            if let Err(e) = daemon_loop(
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
                tracing::error!("SyncDaemon exited with error: {e}");
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

// ---------------------------------------------------------------------------
// daemon_loop — the core async select! loop
// ---------------------------------------------------------------------------

/// Main event-driven loop for the sync daemon.
///
/// Uses `tokio::select!` to react to mDNS peer-discovery events,
/// debounced local-change notifications, periodic resync checks, and
/// shutdown signals — without polling.
#[allow(clippy::too_many_arguments)]
async fn daemon_loop(
    pool: SqlitePool,
    device_id: String,
    materializer: Materializer,
    scheduler: Arc<SyncScheduler>,
    cert: SyncCert,
    event_sink: Arc<dyn SyncEventSink>,
    shutdown_notify: Arc<Notify>,
    cancel: Arc<AtomicBool>,
) -> Result<(), AppError> {
    // 1. Start mDNS service (graceful fallback — #522)
    //
    // mDNS may fail on platforms where raw UDP sockets are blocked (e.g. iOS).
    // When this happens we log a warning and continue without peer discovery.
    // Sync still works via manual IP entry (stored in peer_refs); the mDNS
    // branch in the select! loop is simply never triggered.
    let mdns = match MdnsService::new() {
        Ok(m) => Some(m),
        Err(e) => {
            tracing::warn!("mDNS initialization failed (peer discovery disabled): {e}");
            tracing::info!("Sync will work via manual IP entry only");
            None
        }
    };

    // 2. Start TLS WebSocket server (responder mode — #615)
    let resp_pool = pool.clone();
    let resp_device_id = device_id.clone();
    let resp_materializer = materializer.clone();
    let resp_scheduler = scheduler.clone();
    let resp_event_sink = event_sink.clone();
    let (server, port) = SyncServer::start(&cert, move |conn| {
        let pool = resp_pool.clone();
        let device_id = resp_device_id.clone();
        let mat = resp_materializer.clone();
        let sched = resp_scheduler.clone();
        let sink = resp_event_sink.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_incoming_sync(conn, pool, device_id, mat, sched, sink).await {
                tracing::warn!("responder sync session failed: {e}");
            }
        });
    })
    .await?;

    // 3. Announce this device on mDNS (skipped when mDNS is unavailable)
    if let Some(ref mdns) = mdns {
        match mdns.announce(&device_id, port) {
            Ok(_) => tracing::info!(port, "SyncDaemon started, mDNS announced"),
            Err(e) => tracing::warn!("mDNS announce failed (peer discovery disabled): {e}"),
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
                tracing::warn!("mDNS browse failed (peer discovery disabled): {e}");
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

    // 5. Maintain discovered peers (device_id → DiscoveredPeer)
    let mut discovered: HashMap<String, DiscoveredPeer> = HashMap::new();

    // 6. Periodic resync interval (replaces the former 500ms poll cadence)
    let mut resync_interval = tokio::time::interval(std::time::Duration::from_secs(30));
    resync_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // 7. Main event-driven loop
    loop {
        tokio::select! {
            // Branch A: mDNS peer-discovery event (event-driven, no polling)
            Some(event) = mdns_rx.recv() => {
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
                                    &cancel,
                                )
                                .await;
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
                            &cancel,
                        )
                        .await;
                    }
                }
            }

            // Branch C: periodic resync check (30s interval)
            _ = resync_interval.tick() => {
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
                            &cancel,
                        )
                        .await;
                    }
                }
            }

            // Branch D: shutdown signal
            _ = shutdown_notify.notified() => {
                break;
            }
        }
    }

    // Cleanup
    server.shutdown().await;
    if let Some(mdns) = mdns {
        if let Err(e) = mdns.shutdown() {
            tracing::warn!("mDNS shutdown error: {e}");
        }
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
#[allow(clippy::too_many_arguments)]
async fn try_sync_with_peer(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    scheduler: &SyncScheduler,
    event_sink: &Arc<dyn SyncEventSink>,
    peer: &DiscoveredPeer,
    peer_refs: &[PeerRef],
    cancel: &AtomicBool,
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
        .with_event_sink(event_sink_box)
        .with_expected_remote_id(peer_id.to_string());

    match run_sync_session(&mut orch, &mut conn, cancel).await {
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

    // Clear cancel flag after session completes (whether by success, error, or cancellation)
    cancel.store(false, Ordering::Release);

    let _ = conn.close().await.map_err(|e| {
        tracing::debug!("failed to close sync connection: {e}");
    });
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
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    // Initiator sends first message
    let first_msg = orch.start().await?;
    conn.send_json(&first_msg).await?;

    // Exchange messages until terminal state
    while !orch.is_terminal() {
        // Check cancellation before waiting for the next message
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::InvalidOperation("sync cancelled by user".into()));
        }

        let incoming: SyncMessage = conn.recv_json().await?;
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            orch.handle_message(incoming),
        )
        .await
        .map_err(|_| AppError::InvalidOperation("handle_message timed out after 120s".into()))??;
        match response {
            Some(response) => {
                conn.send_json(&response).await?;
            }
            None => {
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

// ---------------------------------------------------------------------------
// handle_incoming_sync — responder-mode sync session (#615)
// ---------------------------------------------------------------------------

/// Drive a complete responder-side sync session over an incoming connection.
///
/// Unlike the initiator path (`run_sync_session`), the responder does **not**
/// call `SyncOrchestrator::start()`.  Instead it waits for the initiator's
/// `HeadExchange`, processes it via `handle_message()` (which computes and
/// returns an `OpBatch`), and then continues the message loop until a
/// terminal state is reached.
///
/// Per-peer mutual exclusion is enforced after the first message reveals
/// the remote device identity: if the scheduler already holds a lock for
/// that peer (e.g. an outbound initiator-mode session is in progress) the
/// connection is rejected with an `Error` message.
async fn handle_incoming_sync(
    mut conn: SyncConnection,
    pool: SqlitePool,
    device_id: String,
    materializer: Materializer,
    scheduler: Arc<SyncScheduler>,
    event_sink: Arc<dyn SyncEventSink>,
) -> Result<(), AppError> {
    tracing::info!("incoming sync connection received, starting responder session");

    let event_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(Arc::clone(&event_sink)));
    let mut orch = SyncOrchestrator::new(pool, device_id.clone(), materializer)
        .with_event_sink(event_sink_box);

    // ── Receive the initiator's first message ─────────────────────────────
    let first_msg: SyncMessage = conn.recv_json().await?;

    // ── Per-peer mutual exclusion ─────────────────────────────────────────
    // We can only identify the peer after seeing the HeadExchange.
    let _peer_guard = if let SyncMessage::HeadExchange { ref heads } = first_msg {
        let remote_id = heads
            .iter()
            .find(|h| h.device_id != device_id)
            .map(|h| h.device_id.clone())
            .unwrap_or_default();

        if !remote_id.is_empty() {
            match scheduler.try_lock_peer(&remote_id) {
                Some(guard) => {
                    tracing::info!(peer_id = %remote_id, "responder locked peer for sync");
                    Some(guard)
                }
                None => {
                    tracing::info!(
                        peer_id = %remote_id,
                        "rejecting incoming sync: already syncing with this peer"
                    );
                    conn.send_json(&SyncMessage::Error {
                        message: "peer is busy with another sync session".into(),
                    })
                    .await?;
                    let _ = conn.close().await;
                    return Ok(());
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // ── Process first message ─────────────────────────────────────────────
    let response = orch.handle_message(first_msg).await?;
    if let Some(resp) = response {
        conn.send_json(&resp).await?;
    }

    // ── Message loop (same structure as initiator) ────────────────────────
    while !orch.is_terminal() {
        let incoming: SyncMessage = conn.recv_json().await?;
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            orch.handle_message(incoming),
        )
        .await
        .map_err(|_| AppError::InvalidOperation("handle_message timed out after 120s".into()))??;

        match response {
            Some(resp) => {
                conn.send_json(&resp).await?;
            }
            None => {
                let state = &orch.session().state;
                if matches!(state, SyncState::Failed(_) | SyncState::ResetRequired) {
                    tracing::warn!(state = ?state, "responder sync ended in non-complete state");
                    break;
                }
            }
        }
    }

    let session = orch.session();
    tracing::info!(
        ops_rx = session.ops_received,
        ops_tx = session.ops_sent,
        state = ?session.state,
        "responder sync session finished"
    );

    if let Err(e) = conn.close().await {
        tracing::debug!("failed to close responder connection: {e}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_events::RecordingEventSink;
    use std::sync::atomic::Ordering;

    #[test]
    fn shared_event_sink_forwards_to_inner() {
        let inner = Arc::new(RecordingEventSink::new());
        let shared = SharedEventSink(inner.clone());
        shared.on_sync_event(SyncEvent::Progress {
            state: "testing".into(),
            remote_device_id: "PEER_A".into(),
            ops_received: 0,
            ops_sent: 0,
        });
        let events = inner.events();
        assert_eq!(
            events.len(),
            1,
            "SharedEventSink must forward exactly one event"
        );
        assert!(
            matches!(&events[0], SyncEvent::Progress { state, .. } if state == "testing"),
            "forwarded event must match the original"
        );
    }

    #[test]
    fn shutdown_sets_flag() {
        let shutdown = Arc::new(AtomicBool::new(false));
        let daemon = SyncDaemon {
            shutdown: shutdown.clone(),
            shutdown_notify: Arc::new(Notify::new()),
            cancel: Arc::new(AtomicBool::new(false)),
            handle: None,
        };
        assert!(!shutdown.load(Ordering::Acquire), "flag must start false");
        daemon.shutdown();
        assert!(
            shutdown.load(Ordering::Acquire),
            "shutdown must set the flag"
        );
    }

    #[test]
    fn cancel_active_sync_sets_flag() {
        let cancel = Arc::new(AtomicBool::new(false));
        let daemon = SyncDaemon {
            shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_notify: Arc::new(Notify::new()),
            cancel: cancel.clone(),
            handle: None,
        };
        assert!(
            !cancel.load(Ordering::Acquire),
            "cancel flag must start false"
        );
        daemon.cancel_active_sync();
        assert!(
            cancel.load(Ordering::Acquire),
            "cancel_active_sync must set the flag"
        );
    }

    #[test]
    fn shutdown_and_cancel_are_independent() {
        let shutdown = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        let daemon = SyncDaemon {
            shutdown: shutdown.clone(),
            shutdown_notify: Arc::new(Notify::new()),
            cancel: cancel.clone(),
            handle: None,
        };
        daemon.shutdown();
        assert!(shutdown.load(Ordering::Acquire), "shutdown must be set");
        assert!(!cancel.load(Ordering::Acquire), "cancel must remain unset");

        daemon.cancel_active_sync();
        assert!(cancel.load(Ordering::Acquire), "cancel must now be set");
        assert!(
            shutdown.load(Ordering::Acquire),
            "shutdown must still be set"
        );
    }

    #[test]
    fn cancel_flag_clear_after_session() {
        let cancel = Arc::new(AtomicBool::new(false));
        let daemon = SyncDaemon {
            shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_notify: Arc::new(Notify::new()),
            cancel: cancel.clone(),
            handle: None,
        };
        daemon.cancel_active_sync();
        assert!(cancel.load(Ordering::Acquire), "cancel must be set");

        // Simulate what try_sync_with_peer does after the session ends
        cancel.store(false, Ordering::Release);
        assert!(!cancel.load(Ordering::Acquire), "cancel must be cleared");
    }

    #[test]
    fn shared_event_sink_concurrent_emission() {
        let inner = Arc::new(RecordingEventSink::new());
        let shared = Arc::new(SharedEventSink(inner.clone()));
        let mut handles = vec![];

        for i in 0..4 {
            let s = shared.clone();
            handles.push(std::thread::spawn(move || {
                s.on_sync_event(SyncEvent::Progress {
                    state: format!("thread-{i}"),
                    remote_device_id: "PEER".into(),
                    ops_received: 0,
                    ops_sent: 0,
                });
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(
            inner.events().len(),
            4,
            "all 4 concurrent events must be captured"
        );
    }

    #[test]
    fn cancel_is_idempotent() {
        let cancel = Arc::new(AtomicBool::new(false));
        let daemon = SyncDaemon {
            shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_notify: Arc::new(Notify::new()),
            cancel: cancel.clone(),
            handle: None,
        };
        daemon.cancel_active_sync();
        daemon.cancel_active_sync();
        daemon.cancel_active_sync();
        assert!(
            cancel.load(Ordering::Acquire),
            "flag must remain set after multiple calls"
        );
    }
}
