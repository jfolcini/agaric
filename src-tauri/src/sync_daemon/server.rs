use crate::error::AppError;
use crate::peer_refs;
use crate::sync_constants::HANDSHAKE_TIMEOUT;
use crate::sync_events::SyncEventSink;
use crate::sync_net::SyncConnection;
use crate::sync_protocol::{SyncMessage, SyncOrchestrator, SyncState};
use crate::sync_scheduler::SyncScheduler;

use super::session_supervisor::CancelGuard;

/// Result of verifying the peer's TLS certificate against its claimed identity.
#[derive(Debug, PartialEq)]
pub(crate) enum CertVerifyResult {
    /// Certificate checks pass (or are skipped when no cert is presented).
    Ok,
    /// B-34: HeadExchange device_id doesn't match the TLS certificate CN.
    CnMismatch { remote_id: String, cert_cn: String },
    /// B-33: TLS certificate hash doesn't match the stored cert_hash.
    HashMismatch { remote_id: String },
    /// #800: the claimed peer is already cert-pinned (it has a stored
    /// `cert_hash` from a prior authenticated connection) but THIS
    /// connection presented no client certificate (`observed_hash` is
    /// `None`).
    ///
    /// The acceptor uses `AllowAnyCert` (`client_auth_mandatory = false`)
    /// so an anonymous, cert-less socket can complete the TLS handshake —
    /// deliberate, so initial pairing can connect. But B-33's hash check
    /// requires BOTH an observed AND a stored hash; with no cert the
    /// observed hash is `None`, so the check was silently *skipped*. That
    /// let a cert-less connection claim a paired device id and run a full
    /// session under a stolen identity. A cert-pinned peer must always
    /// prove possession of its certificate, so a missing client cert on a
    /// pinned identity is a hard rejection. The only legitimate anonymous
    /// flow is initial pairing, which never claims an already-paired id
    /// (no stored `cert_hash` exists for it yet).
    MissingCert { remote_id: String },
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
    if let Some(cn) = cert_cn
        && cn != remote_id
    {
        return CertVerifyResult::CnMismatch {
            remote_id: remote_id.to_string(),
            cert_cn: cn.to_string(),
        };
    }

    // #800: A cert-pinned peer (stored_hash present, from a prior
    // authenticated connection) MUST present a client certificate. With no
    // observed hash the B-33 pin check below cannot run at all — and
    // treating "no observed hash" as "skip" let a cert-less connection
    // claim a paired identity and bypass pinning entirely. Reject before
    // B-33 so the missing-cert case is reported precisely rather than
    // sliding through as `Ok`. (When stored_hash is `None` the peer is not
    // yet pinned — initial pairing / pre-TOFU first connect — so an absent
    // cert is allowed here, preserving the only legitimate anonymous flow.)
    if stored_hash.is_some() && observed_hash.is_none() {
        return CertVerifyResult::MissingCert {
            remote_id: remote_id.to_string(),
        };
    }

    // B-33: Verify TLS certificate hash matches stored cert_hash
    if let Some(stored) = stored_hash
        && let Some(observed) = observed_hash
        && stored != observed
    {
        return CertVerifyResult::HashMismatch {
            remote_id: remote_id.to_string(),
        };
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
/// Wrapped in a `sync_resp` span so every log line emitted during
/// an inbound responder session (including nested orchestrator
/// `sync_msg{...}` child spans) is tagged with the responder session prefix.
///
/// #1605: `cancel` is the daemon's shared cancellation `AtomicBool` — the
/// SAME flag the initiator path (`run_sync_session`) and the shutdown path
/// observe. Threading it here (instead of the former throwaway,
/// never-set `AtomicBool`) means a shutdown or user-cancel that flips the
/// flag aborts the responder session within one recv cycle and releases
/// the per-peer lock and the #1581 concurrency permit, rather than letting
/// a slow/hung initiator pin both for up to `RECV_TIMEOUT` (180 s) per recv.
/// Like the initiator, the flag is checked between recvs (at the top of each
/// message-loop iteration and per-file in the transfer phase), so a single
/// in-flight recv still runs to its timeout; mid-recv abort is out of scope.
///
/// #2537: this responder path now mirrors the initiator's [`CancelGuard`] —
/// once the per-peer lock is acquired (`_cancel_guard.owns = true`, set
/// immediately after `try_lock_peer` succeeds in the peer-guard block
/// below — *not* deferred until identity/cert checks also pass; see
/// [`CancelGuard`]'s doc comment for why that distinction matters), this
/// session becomes a legitimate resetter of the shared flag on Drop (gated
/// on `!scheduler.is_any_peer_locked()`, i.e. only once it is the last
/// active session standing). Before this fix the responder only ever
/// *checked* the flag — it never cleared it, so a user cancel issued while
/// no initiator session was around to consume it left every subsequent
/// inbound session from any peer failing "sync cancelled" forever. See
/// `CancelGuard`'s doc comment in `session_supervisor.rs` for the full
/// concurrent-session race analysis.
#[tracing::instrument(skip_all, name = "sync_resp")]
pub(crate) async fn handle_incoming_sync(
    conn: SyncConnection,
    pool: sqlx::SqlitePool,
    device_id: String,
    materializer: crate::materializer::Materializer,
    scheduler: std::sync::Arc<SyncScheduler>,
    event_sink: std::sync::Arc<dyn SyncEventSink>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), AppError> {
    // The responder resolves its Loro engine state from the
    // materializer it is handed (#2249: each device — production or a
    // test's device — owns its `Arc<LoroState>`, so two devices in one
    // test process naturally use distinct engines with no override seam).
    //
    // `Box::pin` keeps THIS wrapper's future tiny (just a heap pointer)
    // instead of embedding the large `_inner` future inline, so the
    // delegation does not push the already-large responder future over the
    // `clippy::large_futures` threshold at the spawn sites.
    Box::pin(handle_incoming_sync_inner(
        conn,
        pool,
        device_id,
        materializer,
        scheduler,
        event_sink,
        cancel,
    ))
    .await
}

#[allow(clippy::too_many_arguments)]
async fn handle_incoming_sync_inner(
    mut conn: SyncConnection,
    pool: sqlx::SqlitePool,
    device_id: String,
    materializer: crate::materializer::Materializer,
    scheduler: std::sync::Arc<SyncScheduler>,
    event_sink: std::sync::Arc<dyn SyncEventSink>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), AppError> {
    tracing::info!("incoming sync connection received, starting responder session");

    let pool_ref = pool.clone();
    let event_sink_box: Box<dyn SyncEventSink> =
        Box::new(super::SharedEventSink(std::sync::Arc::clone(&event_sink)));

    // #2537: scope guard that clears the shared daemon-wide cancel flag on
    // Drop once this responder session both owns the cancel and is the
    // last active session standing — mirrors the initiator's `CancelGuard`
    // in `session_supervisor::try_sync_with_peer`. Declared BEFORE
    // `_peer_guard` below so, per Rust's reverse-declaration-order Drop
    // rule, this guard's Drop runs AFTER `_peer_guard` releases this
    // session's own per-peer lock — `scheduler.is_any_peer_locked()`
    // (consulted from `CancelGuard::drop`) therefore reflects only OTHER
    // still-active sessions, not this one. See `CancelGuard`'s doc comment
    // for the full race analysis.
    let mut _cancel_guard = CancelGuard {
        cancel: cancel.as_ref(),
        scheduler: scheduler.as_ref(),
        owns: false,
    };

    // Construction of `orch` is deferred until after the cert
    // check so we can wire the verified TLS certificate CN into the
    // orchestrator's `expected_remote_id`. This makes the orchestrator's
    // internal HeadExchange-vs-expected mismatch path active on the
    // responder side too — defence-in-depth for the case where the
    // initiator's HeadExchange identifies a different `device_id` than
    // the cert claims (a software-bug consistency check; the cert CN
    // is already checked against the heads-claimed id in the hoisted
    // B-34 check below, and #778 derives the peer identity from the
    // CN itself).

    // ── Receive the initiator's first message ─────────────────────────────
    // #611: all session-loop sends/recvs go through
    // `wire::{send,recv}_sync_message` so over-threshold LoroSync payloads
    // ride the chunked binary path instead of blowing the 10 MB JSON
    // text-frame cap. (The first message is always a small HeadExchange in
    // a well-behaved session; routing it through the helper just keeps the
    // loop uniform.)
    let first_msg: SyncMessage = super::wire::recv_sync_message(&mut conn).await?;

    // #2503: the responder's Loro-snapshot catch-up
    // (`try_offer_loro_snapshot_catchup`) exports from the live engine
    // registry, not from a stored SQL snapshot, so it no longer needs the
    // initiator's advertised heads to run a covering check — the retired
    // CBOR offer's `remote_heads` capture is gone.

    // #2200: record the initiator's compression capability on the
    // connection so the chunked `LoroSync` payloads we stream back ride
    // the zstd path only when the peer can decompress them. An older
    // initiator omits the flag (→ `false`) and we stream raw bytes.
    if let SyncMessage::HeadExchange {
        wire_compression, ..
    } = &first_msg
    {
        conn.set_peer_wire_compression(*wire_compression);
    }

    // ── Per-peer mutual exclusion ─────────────────────────────────────────
    // We can only identify the peer after seeing the HeadExchange.
    let _peer_guard = if let SyncMessage::HeadExchange { ref heads, .. } = first_msg {
        // The identity the initiator *claims* through its advertised
        // heads. #778: heads are sync state, not identity — a fresh
        // device (empty op_log) has no head of its own, so this can
        // legitimately be empty and MUST NOT be treated as "self".
        let claimed_id = heads
            .iter()
            .find(|h| h.device_id != device_id)
            .map(|h| h.device_id.clone())
            .unwrap_or_default();

        // B-34, hoisted ahead of the pairing lookup (#778): when the
        // heads claim an identity AND the connection carries a verified
        // client cert, the two must agree — otherwise a forged
        // HeadExchange could steer the rest of the handshake under a
        // different identity than the cert's. Pure CN check only
        // (no stored hash yet); B-33 runs below after the peer lock.
        if !claimed_id.is_empty()
            && let CertVerifyResult::CnMismatch {
                ref remote_id,
                ref cert_cn,
            } = verify_peer_cert(&claimed_id, conn.peer_cert_cn(), None, None)
        {
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

        // #778: the peer's identity is the verified TLS certificate CN
        // (mTLS), mirroring the initiator-side fallback
        // (`expected_remote_id` in `sync_protocol::session_state_machine`). The
        // heads-claimed id is only a fallback for cert-less connections
        // (in-memory test pairs); the hoisted B-34 check above
        // guarantees the two agree whenever both are present.
        let remote_id = match conn.peer_cert_cn() {
            Some(cn) => cn.to_string(),
            None => claimed_id,
        };

        if remote_id.is_empty() {
            // Degenerate case: no client certificate AND no foreign
            // head — the session cannot be attributed to any peer.
            tracing::warn!(
                "rejecting sync: cannot identify remote device (no cert CN, no foreign head)"
            );
            conn.send_json(&SyncMessage::Error {
                message: "cannot identify remote device".into(),
            })
            .await?;
            let _ = conn.close().await;
            return Ok(());
        }

        if remote_id == device_id {
            tracing::warn!("rejecting sync with self (remote_id matches local device_id)");
            conn.send_json(&SyncMessage::Error {
                message: "cannot sync with self".into(),
            })
            .await?;
            let _ = conn.close().await;
            return Ok(());
        }

        // Reject unpaired devices (S-1).
        //
        // #1519: the documented pairing flow leaves the responder with NO
        // `peer_refs` row at confirm time — `confirm_pairing_inner` only writes
        // a `set_pending_pairing` marker (the QR carries just the passphrase, so
        // the joiner's real `device_id` is unknown until it connects; the row is
        // established by TOFU on that first authenticated connection). Without an
        // exception here, this gate rejects that very first post-pair connection
        // before the TOFU upsert below can run, so neither device can complete
        // the first sync and the initiator is stuck with no forward path. When a
        // pairing is pending, accept the first connection and let the B-33 TOFU
        // path below persist the `peer_ref` + observed cert hash; we clear the
        // pending marker once that succeeds.
        let pairing_pending = if peer_refs::get_peer_ref(&pool_ref, &remote_id)
            .await?
            .is_none()
        {
            if peer_refs::is_pending_pairing(&pool_ref).await? {
                tracing::info!(
                    peer_id = %remote_id,
                    "accepting first sync from unpaired device while pairing is pending (#1519 TOFU)"
                );
                true
            } else {
                tracing::warn!(peer_id = %remote_id, "rejecting sync from unpaired device");
                conn.send_json(&SyncMessage::Error {
                    message: "peer not paired with this device".into(),
                })
                .await?;
                let _ = conn.close().await;
                return Ok(());
            }
        } else {
            false
        };

        // S-5: Acquire per-peer lock BEFORE reading/storing cert hash so
        // two devices that connect simultaneously after pairing cannot
        // race through the TOFU path and overwrite each other's hash.
        let guard = if let Some(guard) = scheduler.try_lock_peer(&remote_id) {
            tracing::info!(peer_id = %remote_id, "responder locked peer for sync");
            guard
        } else {
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
        };

        // #2537: the per-peer lock is acquired — this task now holds the
        // exact resource `is_any_peer_locked()` observes, so it is a
        // legitimate participant in "am I the last one standing" from here
        // on, regardless of whether the cert checks below pass and a full
        // session runs, or a post-lock identity/cert rejection exits early
        // (a rejected connection here still held the lock, potentially
        // across an `.await`ed DB lookup below — leaving `owns` unset until
        // full cert-check success would let this task's early exit fail to
        // ever clear a flag it could have been the last holder of; see
        // [`CancelGuard`]'s doc comment in `session_supervisor.rs`).
        _cancel_guard.owns = true;

        // B-33: Verify TLS certificate hash matches stored cert_hash.
        // (B-34's CN check is trivially satisfied here: #778 derives
        // `remote_id` from the cert CN whenever a cert is present, and
        // the heads-vs-CN mismatch was already rejected above. The
        // `CnMismatch` arm below is kept as defence-in-depth.)
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
                if stored_hash.is_none()
                    && let Some(ref observed) = conn.peer_cert_hash()
                {
                    match peer_refs::upsert_peer_ref_with_cert(&pool_ref, &remote_id, observed)
                        .await
                    {
                        Ok(()) => {
                            // #1519: the `peer_ref` now exists, so the
                            // pending-pairing bridge that admitted this first
                            // connection has done its job. Clear the marker so
                            // the daemon stops advertising "accepting pairing"
                            // and a later unpaired device cannot ride the same
                            // open window. Best-effort: a failure here only
                            // leaves the marker to expire on its TTL.
                            if pairing_pending
                                && let Err(e) = peer_refs::clear_pending_pairing(&pool_ref).await
                            {
                                tracing::warn!(
                                    peer_id = %remote_id,
                                    error = %e,
                                    "failed to clear pending-pairing marker after TOFU (#1519)"
                                );
                            }
                        }
                        Err(e) => {
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
            CertVerifyResult::MissingCert { ref remote_id } => {
                // #800: a cert-less connection claimed a cert-pinned device
                // id. B-33 pinning cannot be verified without a presented
                // certificate, so refuse rather than fall through under a
                // potentially stolen identity.
                tracing::warn!(
                    peer_id = %remote_id,
                    "rejecting sync: cert-less connection claimed a cert-pinned device id (#800)"
                );
                conn.send_json(&SyncMessage::Error {
                    message: "client certificate required for paired device".into(),
                })
                .await?;
                let _ = conn.close().await;
                return Ok(());
            }
        }

        // #2537: identity + pinning checks passed — this is now a committed,
        // real session, and the message loop below is the one that observes
        // `cancel`. `_cancel_guard.owns` was already armed right after the
        // per-peer lock was acquired above, so no further action is needed
        // here.
        Some(guard)
    } else {
        None
    };

    // Build the orchestrator now that the cert CN is known. If
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
        super::wire::send_sync_message(&mut conn, &resp).await?;
        // Drain any pending op batches (B-3)
        while let Some(batch) = orch.next_message() {
            super::wire::send_sync_message(&mut conn, &batch).await?;
        }
    }

    // ── Message loop (same structure as initiator) ────────────────────────
    while !orch.is_terminal() {
        // #1605: check cancellation before waiting for the next message,
        // mirroring `run_sync_session`'s initiator-side check. A shutdown or
        // user-cancel that flipped the daemon's shared flag aborts here within
        // one recv cycle, releasing the per-peer lock (`_peer_guard`) and the
        // #1581 permit (dropped by the caller when this fn resolves) instead of
        // pinning them for up to `RECV_TIMEOUT` per recv against a hung peer.
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(AppError::InvalidOperation("sync cancelled".into()));
        }

        let incoming: SyncMessage = super::wire::recv_sync_message(&mut conn).await?;
        let response = tokio::time::timeout(HANDSHAKE_TIMEOUT, orch.handle_message(incoming))
            .await
            .map_err(|_| {
                AppError::InvalidOperation(format!(
                    "handle_message timed out after {}s",
                    HANDSHAKE_TIMEOUT.as_secs()
                ))
            })??;

        if let Some(resp) = response {
            super::wire::send_sync_message(&mut conn, &resp).await?;
            // Drain any pending op batches (B-3)
            while let Some(batch) = orch.next_message() {
                super::wire::send_sync_message(&mut conn, &batch).await?;
            }
        } else {
            let state = &orch.session().state;
            if matches!(state, SyncState::Failed(_) | SyncState::ResetRequired) {
                tracing::warn!(state = ?state, "responder sync ended in non-complete state");
                break;
            }
        }
    }

    // Loro-snapshot-driven catch-up (post-ResetRequired, #2503).
    //
    // If the main loop exited with `state == ResetRequired`, we signalled
    // to the initiator that its Loro version vector is unreachable from
    // ours. Stream our per-space Loro snapshots (engine truth) so the
    // initiator can MERGE them into its own engine and reproject SQL —
    // preserving its unsynced local content (no wipe). Replaces the old
    // CBOR `SnapshotOffer` RESET.
    if matches!(orch.session().state, SyncState::ResetRequired) {
        let remote_id = orch.session().remote_device_id.clone();
        let loro_state = orch.loro_state();
        match super::snapshot_transfer::try_offer_loro_snapshot_catchup(
            &mut conn,
            &pool_ref,
            &loro_state.registry,
            &event_sink,
            &device_id,
            &remote_id,
        )
        .await
        {
            Ok(outcome) => {
                tracing::info!(
                    peer_id = %remote_id,
                    outcome = ?outcome,
                    "responder Loro-snapshot catch-up sub-flow complete (#2503)"
                );
            }
            Err(e) => {
                tracing::warn!(
                    peer_id = %remote_id,
                    error = %e,
                    "responder Loro-snapshot catch-up sub-flow failed (non-fatal)"
                );
            }
        }
    }

    // ── File transfer phase (F-14) ────────────────────────────────────────
    // After the op-sync completes, transfer missing attachment files.
    // The responder responds first, then requests its own files.
    //
    // #1605: thread the daemon's REAL shared cancel flag (same one the
    // initiator and shutdown path use) into the file-transfer phase,
    // Replacing the former throwaway `AtomicBool::new(false)`. The
    // per-file loops in `run_file_transfer_responder` observe it between
    // files, so a shutdown or user-cancel aborts a multi-gigabyte transfer
    // promptly rather than running it to completion (or to `RECV_TIMEOUT`
    // per file). Mirrors `run_sync_session`, which threads the same flag
    // through to `run_file_transfer_initiator`.
    if orch.is_succeeded() {
        match crate::sync_files::app_data_dir_from_pool(&pool_ref).await {
            Ok(app_data_dir) => {
                // Pass `None`: the responder is the
                // *incoming* side of a sync session, so no `start_sync`
                // command on this device has set up a `Channel` for file
                // progress. The active `Channel` lives on the initiator's
                // device; emitting `FileProgress` here would just drop on
                // the floor in `TauriEventSink`. Surfacing responder-side
                // file-receive progress to the local UI is a follow-up
                // (would need a new `app.emit` event or a daemon-owned
                // long-lived channel).
                match crate::sync_files::run_file_transfer_responder(
                    &mut conn,
                    &pool_ref,
                    &app_data_dir,
                    &cancel,
                    None,
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
            }
            _ => {
                tracing::warn!("could not determine app_data_dir, skipping file transfer");
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
        tracing::debug!(error = %e, "failed to close responder connection");
    }

    Ok(())
}
