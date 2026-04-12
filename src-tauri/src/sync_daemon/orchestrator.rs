use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::Notify;

use crate::error::AppError;
use crate::materializer::Materializer;
use crate::peer_refs::{self, PeerRef};
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_net::{self, DiscoveredPeer, MdnsService, SyncCert, SyncConnection, SyncServer};
use crate::sync_protocol::{SyncMessage, SyncOrchestrator, SyncState};
use crate::sync_scheduler::SyncScheduler;

use super::discovery::{build_fallback_peer, should_attempt_sync_with_discovered_peer};
use super::server::handle_incoming_sync;
use super::SharedEventSink;

// ---------------------------------------------------------------------------
// daemon_loop — the core async select! loop
// ---------------------------------------------------------------------------

/// Main event-driven loop for the sync daemon.
///
/// Uses `tokio::select!` to react to mDNS peer-discovery events,
/// debounced local-change notifications, periodic resync checks, and
/// shutdown signals — without polling.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn daemon_loop(
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

    // 5. Maintain discovered peers (device_id → (DiscoveredPeer, last_seen))
    let mut discovered: HashMap<String, (DiscoveredPeer, tokio::time::Instant)> = HashMap::new();

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
                        let already_discovered = discovered.contains_key(&peer.device_id);
                        discovered.insert(peer.device_id.clone(), (peer.clone(), tokio::time::Instant::now()));
                        if !already_discovered {
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
                            if should_attempt_sync_with_discovered_peer(
                                &peer.device_id,
                                &device_id,
                                already_discovered,
                                &refs,
                            ) {
                                try_sync_with_peer(
                                    &pool,
                                    &device_id,
                                    &materializer,
                                    &scheduler,
                                    &event_sink,
                                    &peer,
                                    &refs,
                                    &cancel,
                                    &cert,
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
                    if let Some((dp, _)) = discovered.get(&peer_ref.peer_id) {
                        try_sync_with_peer(
                            &pool,
                            &device_id,
                            &materializer,
                            &scheduler,
                            &event_sink,
                            dp,
                            &refs,
                            &cancel,
                            &cert,
                        )
                        .await;
                    } else if let Some(ref addr) = peer_ref.last_address {
                        // Fallback: use last-known address (manual IP / stored from previous sync)
                        if let Some(fallback_peer) = build_fallback_peer(&peer_ref.peer_id, addr) {
                            try_sync_with_peer(
                                &pool,
                                &device_id,
                                &materializer,
                                &scheduler,
                                &event_sink,
                                &fallback_peer,
                                &refs,
                                &cancel,
                                &cert,
                            )
                            .await;
                        }
                    }
                }
            }

            // Branch C: periodic resync check (30s interval)
            _ = resync_interval.tick() => {
                // Evict stale mDNS peers not seen in last 5 minutes
                let stale_threshold = tokio::time::Instant::now() - std::time::Duration::from_secs(300);
                discovered.retain(|_, (_, last_seen)| *last_seen > stale_threshold);

                let refs = peer_refs::list_peer_refs(&pool).await.unwrap_or_else(|e| {
                    tracing::warn!("list_peer_refs failed: {e}");
                    vec![]
                });
                let peer_tuples: Vec<(String, Option<String>)> = refs
                    .iter()
                    .map(|p| (p.peer_id.clone(), p.synced_at.clone()))
                    .collect();
                let due = scheduler.peers_due_for_resync(&peer_tuples);
                let refs_by_id: std::collections::HashMap<&str, &peer_refs::PeerRef> =
                    refs.iter().map(|r| (r.peer_id.as_str(), r)).collect();
                for pid in due {
                    if let Some((dp, _)) = discovered.get(&pid) {
                        try_sync_with_peer(
                            &pool,
                            &device_id,
                            &materializer,
                            &scheduler,
                            &event_sink,
                            dp,
                            &refs,
                            &cancel,
                            &cert,
                        )
                        .await;
                    } else if let Some(ref addr) = refs_by_id.get(pid.as_str()).and_then(|r| r.last_address.clone()) {
                        // Fallback: use last-known address (manual IP / stored from previous sync)
                        if let Some(fallback_peer) = build_fallback_peer(&pid, addr) {
                            try_sync_with_peer(
                                &pool,
                                &device_id,
                                &materializer,
                                &scheduler,
                                &event_sink,
                                &fallback_peer,
                                &refs,
                                &cancel,
                                &cert,
                            )
                            .await;
                        }
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
pub(crate) async fn try_sync_with_peer(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    scheduler: &SyncScheduler,
    event_sink: &Arc<dyn SyncEventSink>,
    peer: &DiscoveredPeer,
    peer_refs: &[PeerRef],
    cancel: &AtomicBool,
    cert: &SyncCert,
) {
    let peer_id = &peer.device_id;

    // Scope guard: always clear the cancel flag when this function returns,
    // regardless of which path is taken (backoff, lock, no-address, connect
    // failure, or after a completed/failed sync session).  Without this,
    // early-exit paths would leave the flag permanently set (S-11).
    struct CancelGuard<'a>(&'a AtomicBool);
    impl Drop for CancelGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let _cancel_guard = CancelGuard(cancel);

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
    let mut conn = match sync_net::connect_to_peer(&addr, cert_hash.as_deref(), cert).await {
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

    match run_sync_session(&mut orch, &mut conn, cancel, pool).await {
        Ok(()) => {
            scheduler.record_success(peer_id);
            // Save the peer's address for future direct connections
            if let Err(e) = peer_refs::update_last_address(pool, peer_id, &addr).await {
                tracing::warn!("failed to save peer address: {e}");
            }
            // TOFU: Store observed cert hash if none was stored (initiator side)
            if cert_hash.is_none() {
                if let Some(ref observed) = conn.peer_cert_hash() {
                    if let Err(e) =
                        peer_refs::upsert_peer_ref_with_cert(pool, peer_id, observed).await
                    {
                        tracing::warn!(
                            peer_id,
                            error = %e,
                            "failed to store peer cert hash (TOFU)"
                        );
                    }
                }
            }
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

    // Cancel flag is cleared by `_cancel_guard` (Drop) on all exit paths.

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
pub(crate) async fn run_sync_session(
    orch: &mut SyncOrchestrator,
    conn: &mut SyncConnection,
    cancel: &AtomicBool,
    pool: &SqlitePool,
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
                // Drain any pending op batches (B-3)
                while let Some(batch) = orch.next_message() {
                    conn.send_json(&batch).await?;
                }
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

    // ── File transfer phase (F-14) ────────────────────────────────────────
    // After the op-sync completes, transfer missing attachment files.
    // The initiator requests first, then responds to the responder's request.
    if orch.is_complete() {
        if let Ok(app_data_dir) = crate::sync_files::app_data_dir_from_pool(pool).await {
            match crate::sync_files::run_file_transfer_initiator(conn, pool, &app_data_dir).await {
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
        } else {
            tracing::warn!("could not determine app_data_dir, skipping file transfer");
        }
    }

    Ok(())
}
