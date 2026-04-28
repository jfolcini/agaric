use crate::error::AppError;
use crate::peer_refs;
use crate::sync_constants::HANDSHAKE_TIMEOUT;
use crate::sync_events::SyncEventSink;
use crate::sync_net::SyncConnection;
use crate::sync_protocol::{DeviceHead, SyncMessage, SyncOrchestrator, SyncState};
use crate::sync_scheduler::SyncScheduler;

/// Result of verifying the peer's TLS certificate against its claimed identity.
#[derive(Debug, PartialEq)]
pub(crate) enum CertVerifyResult {
    /// Certificate checks pass (or are skipped when no cert is presented).
    Ok,
    /// B-34: HeadExchange device_id doesn't match the TLS certificate CN.
    CnMismatch { remote_id: String, cert_cn: String },
    /// B-33: TLS certificate hash doesn't match the stored cert_hash.
    HashMismatch { remote_id: String },
}

/// Verify the peer's TLS certificate CN matches the claimed device ID (B-34)
/// and the certificate hash matches what was stored during pairing (B-33).
///
/// Extracted as a pure function so it can be unit-tested without TLS.
pub(crate) fn verify_peer_cert(
    remote_id: &str,
    cert_cn: Option<&str>,
    observed_hash: Option<&str>,
    stored_hash: Option<&str>,
) -> CertVerifyResult {
    // B-34: Verify device ID matches TLS certificate CN
    if let Some(cn) = cert_cn {
        if cn != remote_id {
            return CertVerifyResult::CnMismatch {
                remote_id: remote_id.to_string(),
                cert_cn: cn.to_string(),
            };
        }
    }

    // B-33: Verify TLS certificate hash matches stored cert_hash
    if let Some(stored) = stored_hash {
        if let Some(observed) = observed_hash {
            if stored != observed {
                return CertVerifyResult::HashMismatch {
                    remote_id: remote_id.to_string(),
                };
            }
        }
    }

    CertVerifyResult::Ok
}

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
///
/// MAINT-21: wrapped in a `sync_resp` span so every log line emitted during
/// an inbound responder session (including nested orchestrator
/// `sync_msg{...}` child spans) is tagged with the responder session prefix.
#[tracing::instrument(skip_all, name = "sync_resp")]
pub(crate) async fn handle_incoming_sync(
    mut conn: SyncConnection,
    pool: sqlx::SqlitePool,
    device_id: String,
    materializer: crate::materializer::Materializer,
    scheduler: std::sync::Arc<SyncScheduler>,
    event_sink: std::sync::Arc<dyn SyncEventSink>,
) -> Result<(), AppError> {
    tracing::info!("incoming sync connection received, starting responder session");

    let pool_ref = pool.clone();
    let event_sink_box: Box<dyn SyncEventSink> =
        Box::new(super::SharedEventSink(std::sync::Arc::clone(&event_sink)));

    // L-71: construction of `orch` is deferred until after the cert
    // check so we can wire the verified TLS certificate CN into the
    // orchestrator's `expected_remote_id`. This makes the orchestrator's
    // internal HeadExchange-vs-expected mismatch path active on the
    // responder side too — defence-in-depth for the case where the
    // initiator's HeadExchange identifies a different `device_id` than
    // the cert claims (a software-bug consistency check; the cert CN
    // alone is already verified at line ~169 below).

    // ── Receive the initiator's first message ─────────────────────────────
    let first_msg: SyncMessage = conn.recv_json().await?;

    // M-58: capture the initiator's advertised heads BEFORE the
    // orchestrator consumes `first_msg`. If the session later exits in
    // `ResetRequired` we need these heads to verify our snapshot's
    // `up_to_seqs` actually covers the remote's frontier — otherwise
    // `try_offer_snapshot_catchup` would silently re-apply an older
    // snapshot. For non-HeadExchange first messages (a protocol
    // violation) we leave it empty; the orchestrator will reject the
    // session before we ever reach the snapshot offer path.
    let remote_heads: Vec<DeviceHead> = match &first_msg {
        SyncMessage::HeadExchange { heads } => heads.clone(),
        _ => Vec::new(),
    };

    // ── Per-peer mutual exclusion ─────────────────────────────────────────
    // We can only identify the peer after seeing the HeadExchange.
    let _peer_guard = if let SyncMessage::HeadExchange { ref heads } = first_msg {
        let remote_id = heads
            .iter()
            .find(|h| h.device_id != device_id)
            .map(|h| h.device_id.clone())
            .unwrap_or_default();

        if remote_id.is_empty() || remote_id == device_id {
            tracing::warn!("rejecting sync with self (remote_id matches local device_id)");
            conn.send_json(&SyncMessage::Error {
                message: "cannot sync with self".into(),
            })
            .await?;
            let _ = conn.close().await;
            return Ok(());
        }

        // Reject unpaired devices (S-1)
        if peer_refs::get_peer_ref(&pool_ref, &remote_id)
            .await?
            .is_none()
        {
            tracing::warn!(peer_id = %remote_id, "rejecting sync from unpaired device");
            conn.send_json(&SyncMessage::Error {
                message: "peer not paired with this device".into(),
            })
            .await?;
            let _ = conn.close().await;
            return Ok(());
        }

        // S-5: Acquire per-peer lock BEFORE reading/storing cert hash so
        // two devices that connect simultaneously after pairing cannot
        // race through the TOFU path and overwrite each other's hash.
        let guard = match scheduler.try_lock_peer(&remote_id) {
            Some(guard) => {
                tracing::info!(peer_id = %remote_id, "responder locked peer for sync");
                guard
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
        };

        // B-34: Verify device ID matches TLS certificate CN
        // B-33: Verify TLS certificate hash matches stored cert_hash
        let stored_hash = peer_refs::get_peer_ref(&pool_ref, &remote_id)
            .await?
            .and_then(|pr| pr.cert_hash);
        match verify_peer_cert(
            &remote_id,
            conn.peer_cert_cn(),
            conn.peer_cert_hash().as_deref(),
            stored_hash.as_deref(),
        ) {
            CertVerifyResult::Ok => {
                // TOFU: Store cert hash on first authenticated connection
                // (trust-on-first-use, same model as SSH known_hosts)
                if stored_hash.is_none() {
                    if let Some(ref observed) = conn.peer_cert_hash() {
                        if let Err(e) =
                            peer_refs::upsert_peer_ref_with_cert(&pool_ref, &remote_id, observed)
                                .await
                        {
                            tracing::warn!(
                                peer_id = %remote_id,
                                error = %e,
                                "failed to store peer cert hash (TOFU)"
                            );
                        }
                    }
                }
            }
            CertVerifyResult::CnMismatch {
                ref remote_id,
                ref cert_cn,
            } => {
                tracing::warn!(
                    peer_id = %remote_id,
                    cert_cn = %cert_cn,
                    "rejecting sync: HeadExchange device_id does not match TLS certificate CN"
                );
                conn.send_json(&SyncMessage::Error {
                    message: "device ID does not match certificate".into(),
                })
                .await?;
                let _ = conn.close().await;
                return Ok(());
            }
            CertVerifyResult::HashMismatch { ref remote_id } => {
                tracing::warn!(
                    peer_id = %remote_id,
                    "rejecting sync: TLS certificate hash mismatch"
                );
                conn.send_json(&SyncMessage::Error {
                    message: "certificate hash mismatch".into(),
                })
                .await?;
                let _ = conn.close().await;
                return Ok(());
            }
        }

        Some(guard)
    } else {
        None
    };

    // L-71: build the orchestrator now that the cert CN is known. If
    // the connection carried a verified peer cert (the production
    // path), wire its CN as `expected_remote_id`; the orchestrator's
    // HeadExchange handler then rejects any first_msg whose advertised
    // device_id disagrees with what the cert claims. Without a cert
    // (in-memory test connections), we simply do not set the field —
    // the existing test harness never fires the mismatch branch.
    let mut orch = SyncOrchestrator::new(pool, device_id.clone(), materializer)
        .with_event_sink(event_sink_box);
    if let Some(cert_cn) = conn.peer_cert_cn() {
        orch = orch.with_expected_remote_id(cert_cn.to_string());
    }

    // ── Process first message ─────────────────────────────────────────────
    let response = orch.handle_message(first_msg).await?;
    if let Some(resp) = response {
        conn.send_json(&resp).await?;
        // Drain any pending op batches (B-3)
        while let Some(batch) = orch.next_message() {
            conn.send_json(&batch).await?;
        }
    }

    // ── Message loop (same structure as initiator) ────────────────────────
    while !orch.is_terminal() {
        let incoming: SyncMessage = conn.recv_json().await?;
        let response = tokio::time::timeout(HANDSHAKE_TIMEOUT, orch.handle_message(incoming))
            .await
            .map_err(|_| {
                AppError::InvalidOperation(format!(
                    "handle_message timed out after {}s",
                    HANDSHAKE_TIMEOUT.as_secs()
                ))
            })??;

        match response {
            Some(resp) => {
                conn.send_json(&resp).await?;
                // Drain any pending op batches (B-3)
                while let Some(batch) = orch.next_message() {
                    conn.send_json(&batch).await?;
                }
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

    // FEAT-6: Snapshot-driven catch-up (post-ResetRequired).
    //
    // If the main loop exited with `state == ResetRequired`, we
    // signalled to the initiator that our op log cannot satisfy its
    // heads (typically after compaction). Offer our most recent
    // snapshot as an alternative path. If `log_snapshots` is empty
    // (e.g. no compaction has run yet) we simply close the session,
    // matching pre-FEAT-6 behavior.
    if matches!(orch.session().state, SyncState::ResetRequired) {
        let remote_id = orch.session().remote_device_id.clone();
        match super::snapshot_transfer::try_offer_snapshot_catchup(
            &mut conn,
            &pool_ref,
            &event_sink,
            &remote_id,
            &remote_heads,
        )
        .await
        {
            Ok(outcome) => {
                tracing::info!(
                    peer_id = %remote_id,
                    outcome = ?outcome,
                    "responder snapshot-offer sub-flow complete"
                );
            }
            Err(e) => {
                tracing::warn!(
                    peer_id = %remote_id,
                    error = %e,
                    "responder snapshot-offer sub-flow failed (non-fatal)"
                );
            }
        }
    }

    // ── File transfer phase (F-14) ────────────────────────────────────────
    // After the op-sync completes, transfer missing attachment files.
    // The responder responds first, then requests its own files.
    //
    // M-47: the responder side of the connection has no plumbed-in
    // cancel signal today (only the initiator surfaces the user-visible
    // "cancel sync" button on its end). We pass a fresh, never-set
    // `AtomicBool` so the file-transfer helpers compile and behave
    // exactly as before on the responder. Responder-side cancellation
    // is a follow-up — once the daemon's per-incoming-session
    // cancel context is wired through `handle_incoming_sync` we can
    // replace this placeholder with the real flag. The user-visible
    // case (initiator cancels its own outbound sync) is fully handled
    // via the orchestrator's `run_sync_session` cancel parameter, which
    // *is* threaded through to `run_file_transfer_initiator`.
    let responder_cancel = std::sync::atomic::AtomicBool::new(false);
    if orch.is_complete() {
        if let Ok(app_data_dir) = crate::sync_files::app_data_dir_from_pool(&pool_ref).await {
            match crate::sync_files::run_file_transfer_responder(
                &mut conn,
                &pool_ref,
                &app_data_dir,
                &responder_cancel,
            )
            .await
            {
                Ok(stats) => {
                    if stats.files_received > 0 || stats.files_sent > 0 {
                        tracing::info!(
                            files_rx = stats.files_received,
                            files_tx = stats.files_sent,
                            "responder file transfer complete"
                        );
                    }
                }
                Err(e) => {
                    // File transfer failure should not abort the sync
                    tracing::warn!(error = %e, "responder file transfer failed (non-fatal)");
                }
            }
        } else {
            tracing::warn!("could not determine app_data_dir, skipping file transfer");
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
        tracing::debug!(error = %e, "failed to close responder connection");
    }

    Ok(())
}
