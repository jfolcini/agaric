//! The responder half of a sync session, over QUIC (#78, plan #3464).
//!
//! # What the port deleted, and what it must not have
//!
//! `handle_incoming_sync_inner` used to be 540 lines, and most of what made it long was
//! one thing: **identity arrived after the connection did.** The old TLS acceptor took
//! anonymous clients and the certificates were self-signed, so `CN=agaric-{victim}`
//! could be minted by anyone. The CN was a *claim*, and everything guarding it —
//! `verify_peer_cert`, `CertVerifyResult`, the B-33 hash pin, #800's missing-cert
//! rejection, B-34's CN-vs-heads check — was app-layer compensation for that.
//!
//! [`EndpointId`] is not a claim. It is an ed25519 public key authenticated by the
//! TLS 1.3 handshake inside QUIC, before a single application byte moves, and
//! [`InboundSession::remote`] is that key. So all of the above is gone, and the
//! impersonation it defended against is now cryptographically impossible rather than
//! app-layer-gated.
//!
//! # Identity is not authorization, and that is the whole reason this file still exists
//!
//! QUIC answers *which key is this*. It does not answer *may this key sync my vault*.
//! Anyone can generate a keypair and dial. Every one of the following therefore stays,
//! and the reason each survives is that none of them was ever about proving the peer's
//! identity:
//!
//! * **S-1**, the unpaired gate. A key with no `peer_refs` row is a stranger, however
//!   well authenticated.
//! * **#855**, the pairing-passphrase proof. Its comment used to say "CN-spoof guard",
//!   which makes it read like part of the cert defence — the single most likely mistake
//!   in this port. Without it the pairing window would admit *and bind* any endpoint
//!   that connected during it. What changed is the proof's job, not its necessity: from
//!   "defend against a spoofed identity being pinned as the victim" to "authorize a
//!   genuine but unknown identity". Narrower, still required.
//! * **S-5**, the per-peer lock, so an inbound session cannot run concurrently with an
//!   outbound one to the same device.
//! * **#2537**, cancel ownership: rejection paths leave `owns == false` so a pending
//!   user cancel is preserved for its real target.
//! * **#1519**, the pending-pairing bridge. A first connection still arrives before any
//!   `peer_refs` row exists; the row is now keyed by `endpoint_id`.
//!
//! # Authorization runs before dispatch, but not before the first receive
//!
//! The design note this port was written from claimed #3324's bug class becomes
//! *unrepresentable* because authorization can run before the first `recv`. That is
//! true for a **paired** peer — the handshake names the key and the key resolves a row —
//! and false for one in the pairing window, because the #855 proof rides *inside*
//! `HeadExchange`. There is nothing to authorize against until that frame arrives.
//!
//! So the order here is `recv` → authorize → dispatch, and only the first two are
//! reordered relative to the old stack. What makes the bug class unrepresentable rather
//! than merely guarded is that the third step is not this function's to skip:
//! [`Role::Responder`] carries the opening frame, so
//! [`run_session`](crate::transport::driver::run_session) cannot dispatch a frame it was
//! not handed, and the only way to hand it one is to have received it here — where the
//! authorization is.
//!
//! # The identity a migrated install does not have yet
//!
//! `peer_refs.endpoint_id` replaces `cert_hash`, and migration `0107` adds it nullable
//! with no backfill, because there is nothing to backfill *from*: a certificate hash
//! does not yield an ed25519 key. So immediately after an upgrade every existing pair
//! has a row with no key bound, and this function — which resolves an inbound peer *by*
//! that key — cannot recognise any of them.
//!
//! The bootstrap is the initiator's, not this one's: `try_sync_with_peer` matches an
//! mDNS-announced `device_id` against an existing `peer_refs` row and binds the
//! announced key on success. Both devices run both roles and both dial on the resync
//! tick, so a migrated pair re-binds in each direction within one tick and inbound
//! sessions start being recognised. Until then this side rejects them, which is the
//! correct answer to "a key I have never seen".
//!
//! That transition is a one-time re-TOFU over the LAN, and it is worth naming plainly:
//! for the length of that window, an mDNS announcement claiming a paired device's
//! `device_id` could be bound instead of the real one. It is the same trust-on-first-use
//! the old stack performed on the very first connection, moved to the upgrade, and it
//! sits inside the stated threat model (AGENTS.md §"Threat Model": the user's own paired
//! devices on a trusted LAN, not an adversarial peer). It is not a property this port
//! *improves*, and it is not one the plan named.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::apply_host::ApplyHost;
use crate::sync_constants::HANDSHAKE_TIMEOUT;
use crate::sync_events::SyncEventSink;
use crate::sync_protocol::{SyncMessage, SyncOrchestrator};
use crate::sync_scheduler::SyncScheduler;
use crate::transport::driver::{Role, SessionLimits, finish_session, run_session};
use crate::transport::service::InboundSession;
use crate::transport::session::{RECV_TIMEOUT, recv_sync_message_within, send_sync_message};
use agaric_core::error::AppError;
use agaric_store::peer_refs;

/// #2539 (item 1): bound a single `SyncOrchestrator::handle_message` dispatch
/// by [`HANDSHAKE_TIMEOUT`], mapping the elapsed case to the same
/// `InvalidOperation` error every session loop has always produced.
///
/// Both session loops now run inside
/// [`run_session`](crate::transport::driver::run_session), which applies this bound
/// itself via [`SessionLimits::dispatch`] — so this helper's remaining consumers are the
/// direct unit tests that pin the timeout and error shape. It is kept rather than
/// inlined because that pinning is the only thing that would notice the two drifting
/// apart, and `HANDSHAKE_TIMEOUT` is the one inherited constant whose *scope* genuinely
/// did not change across the transport swap: it wraps `orch.handle_message`, which is
/// database and engine work, and not any I/O.
pub async fn dispatch_with_handshake_timeout<T>(
    fut: impl std::future::Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, fut)
        .await
        .map_err(|_| {
            AppError::InvalidOperation(format!(
                "handle_message timed out after {}s",
                HANDSHAKE_TIMEOUT.as_secs()
            ))
        })?
}

/// Why a connection was turned away before it became a session.
///
/// Every variant is a *rejection*, which in #2537's terms means `cancel_guard.owns`
/// stays `false` and a pending user cancel is preserved for its real target. Modelled
/// as a type rather than five inline `return Ok(())`s so that property is one thing to
/// check instead of five, and so the message sent to the peer and the reason logged
/// cannot drift apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// The first frame was not a `HeadExchange`.
    NotHeadExchange,
    /// The key is not bound to any peer and no pairing is in progress (S-1).
    Unpaired,
    /// A pairing is in progress but the peer did not prove it knows the passphrase
    /// (#855).
    PairingProofMissing,
    /// The peer resolved to this very device.
    Self_,
    /// Another session with this peer is already running (S-5).
    Busy,
}

impl Rejection {
    /// The text sent to the peer, unchanged from the strings the old responder used so
    /// a peer's logs read the same across the cutover.
    #[must_use]
    pub fn peer_message(&self) -> &'static str {
        match self {
            Self::NotHeadExchange => "HeadExchange expected as the first message",
            Self::Unpaired => "peer not paired with this device",
            Self::PairingProofMissing => "pairing passphrase proof required",
            Self::Self_ => "cannot sync with self",
            Self::Busy => "peer is busy with another sync session",
        }
    }
}

/// Drive a complete responder-side sync session over an admitted inbound connection.
///
/// Takes an [`InboundSession`] rather than a connection and a claimed identity: the type
/// cannot be constructed except by [`AdmittedConnection::establish`](crate::transport::service::AdmittedConnection::establish),
/// and its `remote` comes from the QUIC handshake, so a handler with one in hand cannot
/// be looking at an unauthenticated peer. It also cannot be destructured (`impl Drop`),
/// so the concurrency permit it carries cannot be separated from the streams it paid
/// for — see the type's own docs.
///
/// Wrapped in a `sync_resp` span so every log line emitted during an inbound responder
/// session (including nested orchestrator `sync_msg{...}` child spans) is tagged with
/// the responder session prefix.
///
/// #1605: `cancel` is the daemon's shared cancellation `AtomicBool` — the SAME flag the
/// initiator path and the shutdown path observe. A shutdown or user-cancel that flips it
/// aborts this session within one recv cycle and releases the per-peer lock and the
/// concurrency permit, rather than letting a slow initiator pin both for up to
/// `RECV_TIMEOUT` (180 s) per recv.
///
/// # Errors
/// If the session loop, a sub-flow, or the shutdown fails. A *rejection* is not an
/// error: it is a session that correctly did not happen, and returns `Ok(())`.
#[tracing::instrument(skip_all, name = "sync_resp")]
pub async fn handle_incoming_sync(
    session: InboundSession,
    pool: sqlx::SqlitePool,
    device_id: String,
    // #2621 (agaric-sync inversion): accept a `Materializer` (tests) or an already-erased
    // `Arc<dyn ApplyHost>` (production) uniformly, then hand the `Arc<dyn ApplyHost>` to
    // the responder session — the concrete coordinator is never named here.
    materializer: impl Into<Arc<dyn ApplyHost>>,
    scheduler: Arc<SyncScheduler>,
    event_sink: Arc<dyn SyncEventSink>,
    cancel: Arc<AtomicBool>,
) -> Result<(), AppError> {
    // `Box::pin` keeps THIS wrapper's future tiny (just a heap pointer) instead of
    // embedding the large `_inner` future inline, so the delegation does not push the
    // already-large responder future over the `clippy::large_futures` threshold at the
    // spawn sites.
    let materializer: Arc<dyn ApplyHost> = materializer.into();
    Box::pin(handle_incoming_sync_inner(
        session,
        pool,
        device_id,
        materializer,
        scheduler,
        event_sink,
        cancel,
    ))
    .await
}

/// Tell the peer why it was turned away, then close.
///
/// The close is `finish_session` rather than a bare `conn.close()` so a rejection sends
/// its final frame the same way a completed session does. `Connection::close` lets the
/// remote "drop any data it received but is as yet undelivered to the application", so
/// closing immediately after the write is what discards the explanation — and a peer
/// that is told nothing retries blindly, which is the behaviour the rejection strings
/// exist to prevent.
async fn reject(
    session: &mut InboundSession,
    reason: &Rejection,
    limits: SessionLimits,
) -> Result<(), AppError> {
    send_sync_message(
        &mut session.send,
        &SyncMessage::Error {
            message: reason.peer_message().to_owned(),
        },
    )
    .await?;
    if let Err(e) = finish_session(true, &mut session.send, &session.conn, limits).await {
        tracing::debug!(error = %e, "failed to shut down a rejected connection");
    }
    Ok(())
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
/// #800's surviving guarantee, as a decision rather than an expression buried in the
/// session's tail.
///
/// `bind_endpoint_id` refuses to point one *key* at two peers, but its
/// `ON CONFLICT(peer_id) DO UPDATE` would happily re-point one *peer* at a new key — and
/// the id we would bind under came from the peer's advertised heads, which is a claim.
/// So a device admitted on the pairing proof could otherwise take over an already-bound
/// peer's row by naming it. `true` here means "do not re-bind".
///
/// # Why a read failure denies
///
/// This took `list_peer_refs(…).unwrap_or_default()`, which makes the guarantee fail
/// **open**: any error — `SQLITE_BUSY` is entirely realistic on this pool, which the
/// session has been writing to throughout — yields an empty list, nothing matches, and
/// the re-bind proceeds. The evidence that the peer is already bound is exactly what a
/// failed read does not have, so the only reading of `Err` that preserves the property
/// is "assume it is". The cost of being wrong is one skipped bind, re-attempted on the
/// next sync cycle; the cost of the other reading is a silently re-pointed row. The old
/// stack propagated the error with `?` for the same reason.
///
/// Split out from the caller because a failing `list_peer_refs` is not reachable from a
/// session test — every earlier step in the session needs the same pool — and an
/// untestable branch on an authorization path is how this one came to be written the
/// wrong way round.
fn peer_is_bound_to_another_key(
    peers: Result<Vec<peer_refs::PeerRef>, AppError>,
    settled_remote_id: &str,
    endpoint_id: &str,
) -> bool {
    if settled_remote_id.is_empty() {
        // Nothing was named, so there is nothing to take over; the caller's own
        // `!settled_remote_id.is_empty()` arm is what declines to bind.
        return false;
    }
    match peers {
        Ok(peers) => peers.into_iter().any(|p| {
            p.peer_id == settled_remote_id && p.endpoint_id.is_some_and(|k| k != endpoint_id)
        }),
        Err(e) => {
            tracing::warn!(
                peer_id = %settled_remote_id,
                error = %e,
                "could not read peer_refs to check whether this peer is already bound to \
                 another key; refusing the re-bind rather than assuming it is safe (#800)"
            );
            true
        }
    }
}

async fn handle_incoming_sync_inner(
    mut session: InboundSession,
    pool: sqlx::SqlitePool,
    device_id: String,
    materializer: Arc<dyn ApplyHost>,
    scheduler: Arc<SyncScheduler>,
    event_sink: Arc<dyn SyncEventSink>,
    cancel: Arc<AtomicBool>,
) -> Result<(), AppError> {
    let endpoint_id = session.remote;
    let endpoint_id_str = endpoint_id.to_string();
    let limits = SessionLimits::default();
    tracing::info!(
        %endpoint_id,
        "incoming sync connection received, starting responder session"
    );

    // #2537: mirror the initiator's cancel ownership (see
    // `session_supervisor::CancelGuard`). Once identity checks pass and the per-peer
    // lock is held, THIS responder session is a legitimate consumer of a user cancel —
    // and therefore also its resetter. Rejection paths leave `owns == false` and
    // preserve a pending flag for its real target, exactly like the initiator's
    // early-exit paths (#637).
    let mut cancel_guard = super::session_supervisor::CancelGuard {
        cancel: &cancel,
        owns: false,
    };
    // #2537: live-session marker for `SyncScheduler::request_cancel`; armed together
    // with `owns` below. Declared after `cancel_guard` so the activity count drops
    // before the flag is cleared on unwind.
    let mut _session_activity = None;

    let pool_ref = pool.clone();
    let event_sink_box: Box<dyn SyncEventSink> =
        Box::new(super::SharedEventSink(Arc::clone(&event_sink)));

    // ── The opening frame ─────────────────────────────────────────────────────
    //
    // Bounded explicitly. The old transport applied `SyncConnection::RECV_TIMEOUT` to
    // every receive, so there is no timeout at this call site to port — which is
    // exactly why it is the kind of bound a transport swap drops in silence. The
    // service's `FIRST_FRAME_TIMEOUT` bounds `accept_bi`, which resolves when the peer
    // *starts* speaking; this bounds it finishing.
    let opening = recv_sync_message_within(&mut session.recv, RECV_TIMEOUT).await?;

    // ── The first frame must be a HeadExchange ────────────────────────────────
    //
    // Under the old stack this was #3324's fix and it was an *authorization* gate: a
    // non-`HeadExchange` first message fell through to the orchestrator with no
    // per-peer lock and no identity check, and a single `ResetRequired` frame reached
    // `try_offer_loro_snapshot_catchup`, which exports every registered space's full
    // `LoroDoc`.
    //
    // It is no longer load-bearing for that, twice over: nothing here dispatches
    // anything until the checks below have run, and the driver cannot dispatch a frame
    // this function did not hand it. It is kept because it is still load-bearing for
    // something else — the #855 proof rides inside `HeadExchange`, so a peer that opens
    // with any other variant has no way to present one, and admitting it during the
    // pairing window would be #3324 wearing different clothes. Rejecting the variant
    // here says that once, rather than leaving it to be re-derived from the shape of
    // the `Option` below.
    //
    // Both fields are copied out of the frame here rather than borrowed from it,
    // because `opening` is moved into the driver below and everything between now and
    // then needs `&mut session`.
    let opening_parts = match &opening {
        SyncMessage::HeadExchange {
            heads,
            pairing_proof,
            ..
        } => Some((heads.clone(), pairing_proof.clone())),
        _ => None,
    };
    let Some((heads, offered_proof)) = opening_parts else {
        // Log the variant only (`discriminant`, the convention in
        // `session_state_machine::handle_message`) — never the payload.
        tracing::warn!(
            %endpoint_id,
            msg = ?std::mem::discriminant(&opening),
            "rejecting sync: first message was not a HeadExchange"
        );
        return reject(&mut session, &Rejection::NotHeadExchange, limits).await;
    };

    // ── S-1: is this key allowed to sync with us? ─────────────────────────────
    //
    // The lookup is by the handshake-authenticated key, not by anything the peer said.
    // `get_peer_ref_by_endpoint_id` refuses to resolve a key bound to two peers rather
    // than picking one, because this is the lookup that decides whose vault a
    // connection may touch.
    let bound = peer_refs::get_peer_ref_by_endpoint_id(&pool_ref, &endpoint_id_str).await?;

    // The identity the peer *claims* through its advertised heads. #778: heads are sync
    // state, not identity — a fresh device (empty op_log) has no head of its own, so
    // this can legitimately be empty and MUST NOT be treated as "self". #2481: a peer
    // advertises the frontier of every device it holds, so the first non-self head is
    // not reliably the peer's own identity either. It is used only where there is
    // nothing better, and never as an authorization input.
    let claimed_id = heads
        .iter()
        .find(|h| h.device_id != device_id)
        .map(|h| h.device_id.clone())
        .unwrap_or_default();

    let (remote_id, pairing_pending) = match bound {
        // A bound key. This is the authoritative identity, and the one the orchestrator
        // is told to expect.
        Some(ref pr) => (pr.peer_id.clone(), false),
        None => {
            // #1519: the documented pairing flow leaves the responder with NO
            // `peer_refs` row at confirm time — `confirm_pairing_inner` only writes a
            // `set_pending_pairing` marker, because the QR carries just the passphrase
            // and the joiner's real identity is unknown until it connects. Without an
            // exception here, S-1 rejects that very first post-pair connection before
            // any binding can happen, and neither device can complete a first sync.
            let Some(expected_proof) = peer_refs::get_pending_pairing_proof(&pool_ref).await?
            else {
                tracing::warn!(
                    %endpoint_id,
                    "rejecting sync from an unpaired device: no pairing is in progress"
                );
                return reject(&mut session, &Rejection::Unpaired, limits).await;
            };

            // #855: admit an unpaired device during the pairing window ONLY if it
            // proves knowledge of the pairing passphrase.
            //
            // Cryptographic identity does NOT retire this, and reading it as part of
            // the cert defence is the mistake this port is most likely to make. QUIC
            // proves *which key* dialled; it says nothing about whether that key may
            // touch this vault. Anyone can generate a keypair. Without the proof the
            // pairing window would admit — and bind — whichever endpoint happened to
            // connect during it.
            //
            // Constant-time compare so a wrong guess leaks no timing signal (the
            // bounded window and attempt cap already make guessing impractical; this is
            // defence in depth).
            let proof_ok = offered_proof.as_deref().is_some_and(|offered| {
                agaric_core::hash::constant_time_eq(offered.as_bytes(), expected_proof.as_bytes())
            });
            if !proof_ok {
                tracing::warn!(
                    %endpoint_id,
                    "rejecting first sync from unpaired device: missing/mismatched pairing \
                     passphrase proof (#855)"
                );
                return reject(&mut session, &Rejection::PairingProofMissing, limits).await;
            }
            tracing::info!(
                %endpoint_id,
                "accepting first sync from unpaired device: pairing passphrase proof \
                 verified (#1519, #855)"
            );
            (claimed_id.clone(), true)
        }
    };

    if !remote_id.is_empty() && remote_id == device_id {
        tracing::warn!(%endpoint_id, "rejecting sync with self");
        return reject(&mut session, &Rejection::Self_, limits).await;
    }

    // ── S-5: per-peer mutual exclusion ────────────────────────────────────────
    //
    // The key is the device id whenever we have one, because that is what the
    // initiator side locks on — and the lock only does its job if both roles on THIS
    // device agree on the spelling. During the pairing window a fresh joiner may
    // advertise no head of its own, leaving `remote_id` empty; the endpoint id is the
    // fallback because a lock keyed on "" would serialize every unidentified peer
    // against every other.
    //
    // Stated honestly: in that fallback case the two roles do not agree, so an inbound
    // and an outbound session with the same *device* can overlap for the length of the
    // pairing window. The old stack did not have this gap, because the cert CN gave the
    // responder a device id unconditionally. It closes the moment a binding exists.
    let lock_key = if remote_id.is_empty() {
        endpoint_id_str.clone()
    } else {
        remote_id.clone()
    };
    let Some(_peer_guard) = scheduler.try_lock_peer(&lock_key) else {
        tracing::info!(
            %endpoint_id,
            peer_id = %remote_id,
            "rejecting incoming sync: already syncing with this peer"
        );
        return reject(&mut session, &Rejection::Busy, limits).await;
    };
    tracing::info!(%endpoint_id, peer_id = %remote_id, "responder locked peer for sync");

    // #2537: identity checks passed and the per-peer lock is held — this session is now
    // committed. Take cancel ownership (the guard's Drop becomes the legitimate
    // post-run reset) and register live-session activity so `cancel_active_sync` /
    // `cancel_sync` latch the flag.
    cancel_guard.owns = true;
    _session_activity = Some(scheduler.begin_session_activity());

    // Build the orchestrator now that identity is settled. `expected_remote_id` is set
    // only from a *bound* row: it is authoritative there, and the FSM rejects a
    // `HeadExchange` that disagrees with it. It is deliberately NOT set from
    // `claimed_id`, because #2481 frontier advertisement makes the first non-self head
    // an unreliable identity and a mismatch would false-fail a legitimate multi-device
    // peer. With it unset the FSM falls back to the same heads-derived id, which is
    // exactly what the old cert-less path did.
    let mut orch = SyncOrchestrator::new(pool, device_id.clone(), materializer)
        .with_event_sink(event_sink_box);
    if !pairing_pending && !remote_id.is_empty() {
        orch = orch.with_expected_remote_id(remote_id.clone());
    }

    // ── The session ───────────────────────────────────────────────────────────
    //
    // The opening frame goes in as data. That is the barrier: the driver dispatches
    // what it is given and never reads an opening frame of its own, so there is no path
    // by which a frame reaches `handle_message` without having passed everything above.
    let end = match run_session(
        Role::Responder { opening },
        &mut orch,
        &mut session.send,
        &mut session.recv,
        Some(&cancel),
        limits,
    )
    .await
    {
        Ok(end) => end,
        Err(e) => {
            // Every failure path out of `run_session` leaves the connection open and
            // `send` unfinished. Closing here is what releases the peer promptly rather
            // than leaving it to QUIC's idle timeout — and a failure is exactly when
            // the permit and the per-peer lock are worth giving back quickly.
            if let Err(close_err) =
                finish_session(false, &mut session.send, &session.conn, limits).await
            {
                tracing::debug!(error = %close_err, "failed to close a failed responder session");
            }
            return Err(e);
        }
    };

    // Who owes the shutdown wait, tracked across the two post-loop phases.
    //
    // Keyed on who spoke last, never on the role — the protocol says `SyncComplete` is
    // "sent once by the puller … in the normal flow that is the initiator; in the
    // empty-registry short-circuit the responder sends it directly because it had
    // nothing to stream". Both phases below move the answer, which is why it is a
    // variable rather than a field read at the end.
    let mut spoke_last = end.spoke_last;

    // ── Loro-snapshot-driven catch-up (post-ResetRequired, #2503) ─────────────
    //
    // `ResetRequired` is terminal for the FSM and simultaneously where the real work
    // starts: we told the initiator its Loro version vector is unreachable from ours,
    // so we stream our per-space snapshots (engine truth) for it to MERGE, preserving
    // its unsynced local content.
    if end.needs_snapshot_catchup() {
        let remote_device_id = orch.session().remote_device_id.clone();
        let loro_state = orch.loro_state();
        match super::snapshot_transfer::try_offer_loro_snapshot_catchup(
            &mut session.send,
            &mut session.recv,
            &pool_ref,
            &loro_state.registry,
            &event_sink,
            &device_id,
            &remote_device_id,
        )
        .await
        {
            Ok(outcome) => {
                // The offering side writes last on both catch-up paths: the Loro path
                // ends with `LoroSync { is_last: true }` (or `SyncComplete` for an
                // empty registry) and the receiver answers nothing; the legacy CBOR
                // path ends with the blob after the peer's `SnapshotAccept`. So this
                // side is a round trip ahead of the peer's read, and closing without
                // waiting is what would truncate a catch-up at the tail — silently,
                // since the peer's error would be "connection lost".
                spoke_last = true;
                tracing::info!(
                    peer_id = %remote_device_id,
                    outcome = ?outcome,
                    "responder Loro-snapshot catch-up sub-flow complete (#2503)"
                );
            }
            Err(e) => tracing::warn!(
                peer_id = %remote_device_id,
                error = %e,
                "responder Loro-snapshot catch-up sub-flow failed (non-fatal)"
            ),
        }
    }

    // ── File transfer phase (F-14) ────────────────────────────────────────────
    //
    // #1605: the daemon's REAL shared cancel flag is threaded through, so a shutdown or
    // user-cancel aborts a multi-gigabyte transfer between files rather than running it
    // to completion.
    if orch.is_succeeded() {
        match crate::sync_files::app_data_dir_from_pool(&pool_ref).await {
            Ok(app_data_dir) => {
                // `None` progress: the responder is the *incoming* side, so no
                // `start_sync` command on this device has set up a `Channel` for file
                // progress. The active `Channel` lives on the initiator's device.
                match crate::sync_files::run_file_transfer_responder(
                    &mut session.send,
                    &mut session.recv,
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
                    // File transfer failure must not abort the sync.
                    Err(e) => {
                        tracing::warn!(error = %e, "responder file transfer failed (non-fatal)");
                    }
                }
                // The responder's file-transfer phases are the initiator's in the
                // opposite order, so this side ends by *receiving* a
                // `FileTransferComplete` rather than sending one. `session_supervisor`
                // sets this to `true` for exactly that reason — if both sides waited,
                // every session would pay a `close_wait` before ending.
                spoke_last = false;
            }
            _ => tracing::warn!("could not determine app_data_dir, skipping file transfer"),
        }
    }

    // ── Bind the key to the peer (TOFU), now that the session named it ────────
    //
    // Deliberately after the session rather than before it. The peer's device id is not
    // knowable up front for an unpaired device with an empty op log — the frontier it
    // advertises contains no head of its own — and binding a key to the wrong id is the
    // one write here that is expensive to undo, since `bind_endpoint_id` then refuses to
    // re-point it.
    //
    // `bind_endpoint_id` is an `ON CONFLICT(peer_id) DO UPDATE` touching only its own
    // column, so re-binding a peer preserves its version vectors and sync state; a
    // device that merely re-paired must not be reset.
    let settled_remote_id = orch.session().remote_device_id.clone();
    // #800's surviving guarantee; see `peer_is_bound_to_another_key` for what it holds
    // and why a failed read denies rather than assumes.
    //
    // The old stack refused this because the cert CN was checked against the pinned
    // hash (#800, B-33). Here the check is simpler and stronger: a peer whose row
    // already names a different key is not re-bound, whatever it claims. Re-pairing a
    // device that legitimately changed keys goes through `delete_peer_ref` first, which
    // is a deliberate act rather than a side effect of one session.
    let already_bound_elsewhere = peer_is_bound_to_another_key(
        peer_refs::list_peer_refs(&pool_ref).await,
        &settled_remote_id,
        &endpoint_id_str,
    );
    if already_bound_elsewhere {
        tracing::warn!(
            peer_id = %settled_remote_id,
            %endpoint_id,
            "refusing to re-bind an already-bound peer to a different key; the device id \
             came from the peer's advertised heads, which is a claim (#800)"
        );
    } else if !settled_remote_id.is_empty() && settled_remote_id != device_id {
        match peer_refs::bind_endpoint_id(&pool_ref, &settled_remote_id, &endpoint_id_str).await {
            Ok(()) => {
                // #1519: a binding now exists, so the pending-pairing bridge that
                // admitted this connection has done its job. Clear the marker so the
                // daemon stops advertising "accepting pairing" and a later unpaired
                // device cannot ride the same open window. Best-effort: a failure only
                // leaves the marker to expire on its TTL.
                if pairing_pending && let Err(e) = peer_refs::clear_pending_pairing(&pool_ref).await
                {
                    tracing::warn!(
                        peer_id = %settled_remote_id,
                        error = %e,
                        "failed to clear the pending-pairing marker after binding (#1519)"
                    );
                }
            }
            Err(e) => tracing::warn!(
                peer_id = %settled_remote_id,
                %endpoint_id,
                error = %e,
                "failed to bind the peer's endpoint id"
            ),
        }
    } else if pairing_pending {
        tracing::info!(
            %endpoint_id,
            "pairing peer did not identify itself in this session; leaving it unbound \
             for its own initiator pass to bind"
        );
    }

    let session_state = orch.session();
    tracing::info!(
        ops_rx = session_state.ops_received,
        ops_tx = session_state.ops_sent,
        state = ?session_state.state,
        "responder sync session finished"
    );

    // Shutdown is a protocol step, not cleanup: the side that spoke last is a round trip
    // ahead of the peer's read, and the peer's close is the only evidence its final
    // frame landed.
    match finish_session(spoke_last, &mut session.send, &session.conn, limits).await {
        Ok(shutdown) => tracing::debug!(?shutdown, "responder connection shut down"),
        Err(e) => tracing::debug!(error = %e, "failed to close responder connection"),
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    //! The responder's session-level tests live app-side (`src/sync_daemon/tests.rs`),
    //! which is where the real admission path can be driven end to end. This one cannot
    //! be: it is about what happens when `list_peer_refs` *fails*, and a session test
    //! reaching this point has necessarily been using the same pool successfully for
    //! the whole session. So the decision is a function and the failure is an input.

    use super::*;

    fn peer(peer_id: &str, endpoint_id: Option<&str>) -> peer_refs::PeerRef {
        peer_refs::PeerRef {
            peer_id: peer_id.to_owned(),
            last_hash: None,
            last_sent_hash: None,
            synced_at: None,
            reset_count: 0,
            last_reset_at: None,
            cert_hash: None,
            device_name: None,
            last_address: None,
            endpoint_id: endpoint_id.map(str::to_owned),
        }
    }

    const KEY_A: &str = "aa11bb22cc33dd44ee55ff6607788990a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const KEY_B: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// The guarantee itself: a peer whose row already names a different key is not
    /// re-bound. Without this the whole function would be testing nothing.
    #[test]
    fn a_peer_already_bound_to_a_different_key_is_refused() {
        let peers = Ok(vec![peer("PEER-A", Some(KEY_A))]);
        assert!(
            peer_is_bound_to_another_key(peers, "PEER-A", KEY_B),
            "the peer's row names KEY_A and this session authenticated KEY_B; the id \
             came from the peer's advertised heads, which is a claim"
        );
    }

    /// The other three shapes must NOT refuse, or the guard would block every ordinary
    /// bind and re-bind and nothing would ever pair.
    #[test]
    fn the_ordinary_shapes_are_allowed() {
        assert!(
            !peer_is_bound_to_another_key(Ok(vec![peer("PEER-A", Some(KEY_A))]), "PEER-A", KEY_A),
            "re-binding the same key to the same peer is a no-op, not a takeover"
        );
        assert!(
            !peer_is_bound_to_another_key(Ok(vec![peer("PEER-A", None)]), "PEER-A", KEY_A),
            "an unbound peer is the TOFU path every migrated install takes"
        );
        assert!(
            !peer_is_bound_to_another_key(Ok(vec![peer("PEER-B", Some(KEY_A))]), "PEER-A", KEY_B),
            "another peer's binding is not this peer's"
        );
        assert!(
            !peer_is_bound_to_another_key(Ok(vec![peer("PEER-A", Some(KEY_A))]), "", KEY_B),
            "a peer that never named itself has nothing to take over"
        );
    }

    /// #800's guarantee must not fail **open**.
    ///
    /// `unwrap_or_default()` turned any read error into an empty list, so nothing
    /// matched, `already_bound_elsewhere` was `false`, and the already-bound peer's row
    /// was re-pointed at the key that just connected. `SQLITE_BUSY` is not exotic here:
    /// the session has been writing to this pool throughout.
    ///
    /// The evidence that the peer is already bound is precisely what a failed read does
    /// not have. Refusing costs one skipped bind, retried next cycle.
    #[test]
    fn a_failed_read_refuses_the_re_bind_rather_than_permitting_it() {
        let failed: Result<Vec<peer_refs::PeerRef>, AppError> =
            Err(AppError::InvalidOperation("database is locked".to_owned()));
        assert!(
            peer_is_bound_to_another_key(failed, "PEER-A", KEY_B),
            "a read that failed is not a read that found nothing; deny"
        );
    }
}
