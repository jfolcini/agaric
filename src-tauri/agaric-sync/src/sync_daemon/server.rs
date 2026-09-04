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
//! [`EndpointId`](iroh::EndpointId) is not a claim. It is an ed25519 public key
//! authenticated by the
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
//! [`Role::Responder`] carries the opening frame, so [`run_session`] cannot dispatch a
//! frame it was not handed, and the only way to hand it one is to have received it here —
//! where the authorization is.
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
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_protocol::{SyncMessage, SyncOrchestrator, clamp_device_name};
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
/// Both session loops now run inside [`run_session`], which applies this bound itself
/// via [`SessionLimits::dispatch`] — so this helper's remaining consumers are the
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

/// The rejection text for [`Rejection::PairingProofMissing`] — the first of the
/// two strings in this file with a **machine** consumer as well as a human one.
///
/// `src/lib/pairing-rejections.ts` re-declares it, and
/// `src/components/dialogs/PairingDialog.tsx` matches on it
/// (`syncError.includes(PAIRING_PROOF_REQUIRED_MESSAGE)`) to turn a waiting
/// joiner's dialog into an immediate "wrong code" straight away, instead of
/// letting it sit out the full pairing TTL and then blame an *expired* code for
/// what was a *wrong* one.
///
/// Nothing in the type system connects the two declarations: this is a prose string
/// crossing a process boundary as free text. Reword it here and every Rust and
/// TypeScript test stays green while the dialog silently loses its failure path
/// (#3492). `scripts/check-pairing-rejection-contract.mjs`, wired into `prek.toml`
/// so it fires when ANY of the three files changes, is what makes that reword red.
pub const PAIRING_PROOF_REQUIRED_MESSAGE: &str = "pairing passphrase proof required";

/// The rejection text for [`Rejection::Unpaired`] — the *second* rejection
/// string a device can meet while it is mid-pairing, and the second with a
/// machine consumer.
///
/// #3504: a joiner whose own window is still open dials a host whose window has
/// already lapsed (the host armed at dialog-open, the joiner at confirm-time, so
/// the joiner's window outlives the host's by however long the user spent
/// walking over and typing). The host has no marker left, S-1 falls to its
/// `Unpaired` arm, and *this* is what comes back — not
/// [`PAIRING_PROOF_REQUIRED_MESSAGE`], which was the only string the frontend
/// knew.
///
/// It is declared, and re-declared in `src/lib/pairing-rejections.ts`, for the
/// same reason as the proof message and under the same guard. What the frontend
/// does with the two is deliberately **not** the same, and the asymmetry is the
/// whole content of #3504's review — see `isPairingWindowRejection` in that
/// module for why matching this one as a *terminal* pairing failure would break
/// pairing a third device into an existing pair.
pub const PEER_NOT_PAIRED_MESSAGE: &str = "peer not paired with this device";

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
            Self::Unpaired => PEER_NOT_PAIRED_MESSAGE,
            Self::PairingProofMissing => PAIRING_PROOF_REQUIRED_MESSAGE,
            Self::Self_ => "cannot sync with self",
            Self::Busy => "peer is busy with another sync session",
        }
    }

    /// Every variant, as data.
    ///
    /// The closure is not dead weight: a `match` with no wildcard stops
    /// compiling the moment a variant is added, so this list cannot silently
    /// fall behind the enum — which is the failure mode that would make
    /// [`from_peer_message`](Self::from_peer_message) quietly stop recognising
    /// a rejection, and with it turn a pairing-window outcome back into a
    /// "sync failure" (#3505).
    #[must_use]
    pub fn all() -> [Self; 5] {
        let _exhaustive = |r: &Self| match r {
            Self::NotHeadExchange
            | Self::Unpaired
            | Self::PairingProofMissing
            | Self::Self_
            | Self::Busy => (),
        };
        [
            Self::NotHeadExchange,
            Self::Unpaired,
            Self::PairingProofMissing,
            Self::Self_,
            Self::Busy,
        ]
    }

    /// Read a rejection back out of the text a peer sent — the inverse of
    /// [`peer_message`](Self::peer_message), and `None` for anything else.
    ///
    /// #3505/#3547: the initiator needs to know *whether the session ended
    /// because the peer turned it away*, and the only thing it has to go on is
    /// the string the responder put on the wire, which arrives as
    /// `SyncState::Failed(message)`. Doing that comparison here — against the
    /// same `match` that produced the string — is what stops the recognition
    /// from becoming a third, drifting copy of the prose in
    /// `session_supervisor`.
    ///
    /// Exact equality, not `contains`: `peer_message` is what the responder
    /// sends verbatim, and a substring test would also match the daemon's own
    /// `format!("Sync failed: {e}")` wrapper and any future message that quotes
    /// a rejection.
    #[must_use]
    pub fn from_peer_message(message: &str) -> Option<Self> {
        Self::all()
            .into_iter()
            .find(|r| r.peer_message() == message)
    }

    /// The text this device shows **its own** user, or `None` for a rejection the
    /// user neither caused nor can act on.
    ///
    /// #3491: the #855 proof gate runs on the *responder*, so before this existed a
    /// device learned of a passphrase mismatch only when it was the side that
    /// dialled. Which side dials first is daemon timing, not a user choice, so the
    /// same mistyped passphrase produced a two-second error or a five-minute wrong
    /// one depending on who won the race. Returning the *same* string
    /// [`peer_message`](Self::peer_message) puts on the wire means the frontend's
    /// single matcher handles both origins — a locally-detected rejection and a
    /// received one are indistinguishable to the UI, which is the point.
    ///
    /// Only `PairingProofMissing` is user-facing, and the other four are `None`
    /// deliberately rather than by omission:
    ///
    /// * `Unpaired` fires constantly and by design — every stranger's probe, and
    ///   (per #3502) both devices dialling and rejecting each other in the moments
    ///   before a passphrase is typed. Surfacing it would make the error banner
    ///   permanent background noise.
    /// * `Busy` and `Self_` are the scheduler working correctly; there is nothing
    ///   for a user to do about either.
    /// * `NotHeadExchange` means a peer spoke a protocol this build does not, which
    ///   is a log line for a developer, not a sentence for a user.
    #[must_use]
    pub fn user_facing_message(&self) -> Option<&'static str> {
        match self {
            Self::PairingProofMissing => Some(PAIRING_PROOF_REQUIRED_MESSAGE),
            Self::NotHeadExchange | Self::Unpaired | Self::Self_ | Self::Busy => None,
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
    // #2621 (agaric-sync inversion): the already-erased `Arc<dyn ApplyHost>` is handed
    // to the responder session — the concrete coordinator is never named here (callers
    // wrap it with `Arc::new`; since #4502 there is no `From` to hide that).
    materializer: Arc<dyn ApplyHost>,
    scheduler: Arc<SyncScheduler>,
    event_sink: Arc<dyn SyncEventSink>,
    cancel: Arc<AtomicBool>,
) -> Result<(), AppError> {
    // `Box::pin` keeps THIS wrapper's future tiny (just a heap pointer) instead of
    // embedding the large `_inner` future inline, so the delegation does not push the
    // already-large responder future over the `clippy::large_futures` threshold at the
    // spawn sites.
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

/// Tell the peer why it was turned away — and, when the reason is one its own user
/// caused, tell this device's user too — then close.
///
/// The close is `finish_session` rather than a bare `conn.close()` so a rejection sends
/// its final frame the same way a completed session does. `Connection::close` lets the
/// remote "drop any data it received but is as yet undelivered to the application", so
/// closing immediately after the write is what discards the explanation — and a peer
/// that is told nothing retries blindly, which is the behaviour the rejection strings
/// exist to prevent.
///
/// #3491: the local emit lives HERE, next to the wire send, rather than at the one
/// call site that needs it today. Both destinations for a single rejection are then
/// one thing to read and one thing to change, which is the same reason [`Rejection`]
/// itself exists — and [`Rejection::user_facing_message`], not this function, decides
/// which rejections a user hears about, so that policy is a `match` a reviewer can
/// check exhaustively rather than a judgement re-made at each of five call sites.
///
/// The emit reuses the ordinary [`SyncEvent::Error`] path every other sync failure
/// already travels (`sync_event_sinks.rs` → `sync:error` → `useSyncEvents.ts` →
/// `useSyncStore.setState('error', message)`), so the frontend needs no second
/// listener and cannot tell a locally-detected rejection from a received one.
async fn reject(
    session: &mut InboundSession,
    reason: &Rejection,
    remote_device_id: &str,
    event_sink: &Arc<dyn SyncEventSink>,
    limits: SessionLimits,
) -> Result<(), AppError> {
    if let Some(message) = reason.user_facing_message() {
        event_sink.on_sync_event(SyncEvent::Error {
            message: message.to_owned(),
            remote_device_id: remote_device_id.to_owned(),
        });
    }
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
/// # Two callers (#4230)
///
/// The bind below is one. The other is
/// [`SyncOrchestrator::with_unverified_claim_guard`](crate::sync_protocol::SyncOrchestrator::with_unverified_claim_guard),
/// which asks the same question of the same claimed id *during* the session, before
/// the `streamed_at` / `loro_vv_bytes` writes. The two used to disagree by one
/// session: the bind refused the take-over while the bookkeeping had already been
/// stamped on the victim's row. One predicate, asked at both moments, is what makes
/// them agree.
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
pub(crate) fn peer_is_bound_to_another_key(
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

#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
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
    // All three fields are copied out of the frame here rather than borrowed from it,
    // because `opening` is moved into the driver below and everything between now and
    // then needs `&mut session`.
    //
    // #4298: `device_name` is clamped as it is copied out, at the boundary rather than
    // at the write site further down. It is the first thing this process does with an
    // untrusted string from the wire, so there is no window in which an unbounded value
    // exists in a variable something else could pick up.
    //
    // #4380: `sender_device_id` is normalised here for the same reason — it is
    // untrusted wire text that ends up as a `peer_refs.peer_id`, and
    // `accept_stated_device_id` REJECTS rather than truncates, so an unusable
    // value becomes `None` at the boundary and every reader below sees one
    // answer to "did this peer identify itself".
    let opening_parts = match &opening {
        SyncMessage::HeadExchange {
            heads,
            pairing_proof,
            device_name,
            sender_device_id,
            ..
        } => Some((
            heads.clone(),
            pairing_proof.clone(),
            device_name.as_deref().and_then(clamp_device_name),
            sender_device_id
                .as_deref()
                .and_then(crate::sync_protocol::accept_stated_device_id),
        )),
        _ => None,
    };
    let Some((heads, offered_proof, offered_device_name, stated_device_id)) = opening_parts else {
        // Log the variant only (`discriminant`, the convention in
        // `session_state_machine::handle_message`) — never the payload.
        tracing::warn!(
            %endpoint_id,
            msg = ?std::mem::discriminant(&opening),
            "rejecting sync: first message was not a HeadExchange"
        );
        return reject(
            &mut session,
            &Rejection::NotHeadExchange,
            &endpoint_id_str,
            &event_sink,
            limits,
        )
        .await;
    };

    // ── S-1: is this key allowed to sync with us? ─────────────────────────────
    //
    // The lookup is by the handshake-authenticated key, not by anything the peer said.
    // `get_peer_ref_by_endpoint_id` refuses to resolve a key bound to two peers rather
    // than picking one, because this is the lookup that decides whose vault a
    // connection may touch.
    let bound = peer_refs::get_peer_ref_by_endpoint_id(&pool_ref, &endpoint_id_str).await?;

    // The identity the peer *claims*. #778: heads are sync state, not identity — a
    // fresh device (empty op_log) has no head of its own, so this can legitimately be
    // empty and MUST NOT be treated as "self". #2481: a peer advertises the frontier of
    // every device it holds, so the first non-self head is not reliably the peer's own
    // identity either. It is used only where there is nothing better, and never as an
    // authorization input.
    //
    // #4380: `sender_device_id` is the peer stating which device it is, so prefer it —
    // it is exactly as unverified as the heads (nothing signs either, and a hostile
    // peer that could state an id could equally have advertised it as a head), but it
    // answers the question actually being asked. The heads-derived value answers a
    // different one: `get_local_heads` is `ORDER BY d.device_id`, so the first non-self
    // entry is *the lowest-sorting device id in the peer's op log*. In a three-device
    // vault that is the joiner's own id about half the time, and the TOFU bind below
    // used to make the coin flip permanent.
    //
    // #4451: and it goes through the SAME normaliser as the stated id.
    // `accept_stated_device_id` was applied above and not here, so the value
    // that reaches `bind_endpoint_id` — which validates only `is_empty()` —
    // could still be arbitrarily long or display-hostile wire text, on a row
    // that is permanent and in a device list the user acts on. One function,
    // called from both interpreters (this one and the FSM's), so the two
    // cannot drift on what counts as a usable id.
    let heads_derived_id = crate::sync_protocol::heads_derived_device_id(&heads, &device_id);
    // #4380: whether the heads ALONE identify the joiner, for the peers too old to
    // state an id. They do not once the peer holds more than one foreign frontier:
    // picking one is picking by sort order, and there is nothing in the frame that
    // says which is right. Read at the bind, which is the write that cannot be undone
    // — `bind_endpoint_id` refuses to re-point a key afterwards, and nothing in the
    // codebase notices that the row names the wrong device.
    //
    // Deliberately NOT extended to "one non-self head" (the pre-#4380 case that is
    // also wrong: a peer that has replicated one device's ops and authored none of its
    // own advertises exactly one head, its peer's). That case is indistinguishable
    // from the overwhelmingly common correct one — the ordinary two-device first pair,
    // where the single non-self head IS the joiner — and refusing it would change the
    // first-pair flow for every peer predating this field to close a corner of it.
    // The residual is bounded and shrinking: it needs a joiner on a pre-#4380 build
    // that has never authored an op, and the stated id closes it outright for any
    // build that has the field.
    let heads_are_ambiguous = stated_device_id.is_none()
        && heads
            .iter()
            .filter(|h| h.device_id != device_id)
            .map(|h| &h.device_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            > 1;
    // Computed after `heads_are_ambiguous` because that is the last reader of
    // `stated_device_id` as an `Option`; this consumes it.
    let claimed_id = stated_device_id.unwrap_or(heads_derived_id);

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
                // The authenticated key, not `claimed_id`: inside this branch no
                // `peer_refs` row binds the caller, so its self-reported device id is
                // an unverified claim. The key is what actually dialled.
                return reject(
                    &mut session,
                    &Rejection::Unpaired,
                    &endpoint_id_str,
                    &event_sink,
                    limits,
                )
                .await;
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
                // #3491: this `reject` also raises the rejection on THIS device's own
                // event sink (see the function's docs), so the side that detected the
                // mismatch stops depending on having been the side that dialled.
                // `endpoint_id_str` for the same reason as the S-1 branch above: a
                // peer that just failed the proof has not earned the right to name
                // itself, and the frontend keys on `message` regardless.
                return reject(
                    &mut session,
                    &Rejection::PairingProofMissing,
                    &endpoint_id_str,
                    &event_sink,
                    limits,
                )
                .await;
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
        return reject(
            &mut session,
            &Rejection::Self_,
            &remote_id,
            &event_sink,
            limits,
        )
        .await;
    }

    // ── S-5: per-peer mutual exclusion ────────────────────────────────────────
    //
    // The key is the handshake-authenticated endpoint id, which is also what
    // `session_supervisor::try_sync_with_peer` locks on — see [`peer_lock_key`] for why
    // that identifier and not the device id. The lock only does its job if both roles
    // on THIS device agree on the spelling, and this is the only identifier both of
    // them hold unconditionally: we have it here before the peer has said anything at
    // all, and the initiator has it before it can dial.
    //
    // It is deliberately NOT `remote_id`. That is empty for a fresh joiner with an
    // empty `op_log` — the pairing window — and the endpoint-id fallback the old code
    // used there disagreed with the initiator's device-id key, so an inbound and an
    // outbound session with one physical peer could overlap in exactly the window where
    // both ends arm a dial. `remote_id` stays the *reported* identity below; it is no
    // longer the lock's spelling.
    let lock_key = super::peer_lock_key(endpoint_id);
    let Some(_peer_guard) = scheduler.try_lock_peer(&lock_key) else {
        tracing::info!(
            %endpoint_id,
            peer_id = %remote_id,
            "rejecting incoming sync: already syncing with this peer"
        );
        return reject(
            &mut session,
            &Rejection::Busy,
            &remote_id,
            &event_sink,
            limits,
        )
        .await;
    };
    tracing::info!(%endpoint_id, peer_id = %remote_id, "responder locked peer for sync");

    // #2537: identity checks passed and the per-peer lock is held — this session is now
    // committed. Take cancel ownership (the guard's Drop becomes the legitimate
    // post-run reset) and register live-session activity so `cancel_active_sync` /
    // `cancel_sync` latch the flag.
    cancel_guard.owns = true;
    _session_activity = Some(scheduler.begin_session_activity());

    // Build the orchestrator now that identity is settled. `expected_remote_id` is set
    // only from a *bound* row: it is authoritative there, and the FSM takes it verbatim
    // in preference to the id it would otherwise derive from the peer's advertised
    // heads. It does NOT reject a disagreeing `HeadExchange` — the advertised heads are
    // never compared against it, precisely because #2481 frontier advertisement makes
    // the first non-self head an unreliable identity and a mismatch would false-fail a
    // legitimate multi-device peer. It is deliberately NOT set from `claimed_id` for the
    // same reason; with it unset the FSM derives the same value this function did, by
    // the same #4380 precedence — the peer's stated `sender_device_id` first, the
    // first non-self head only for a peer too old to state one. The two must agree,
    // because `heads_are_ambiguous` above is computed from THIS frame and gates the
    // bind on `settled_remote_id`, which is the FSM's answer.
    // #3328: the orchestrator takes ownership of the host, but the file-transfer
    // phase below still needs it to resolve the attachment root. An `Arc` clone
    // is a refcount bump — the host itself is not duplicated.
    let mut orch = SyncOrchestrator::new(pool, device_id.clone(), Arc::clone(&materializer))
        .with_event_sink(event_sink_box);
    if !pairing_pending && !remote_id.is_empty() {
        orch = orch.with_expected_remote_id(remote_id.clone());
    } else if pairing_pending {
        // #4230: and because it is deliberately unset here, the id this session
        // ends up keyed on is whatever the peer advertised. That is fine for
        // *naming* the session — the bind below is what decides whether the name
        // sticks — but the session also writes `streamed_at` and
        // `loro_vv_bytes` under it, and those writes run BEFORE the bind check.
        // Arming the guard with the authenticated key makes
        // `peer_is_bound_to_another_key` cover them too, so a passphrase-holder
        // cannot poison an already-bound peer's export floor on the way past.
        orch = orch.with_unverified_claim_guard(endpoint_id_str.clone());
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
                // The offering side writes last: the Loro catch-up ends with
                // `LoroSync { is_last: true }` (or `SyncComplete` for an empty
                // registry) and the receiver answers nothing. (#3487 deleted the
                // legacy CBOR path, which ended with the blob after the peer's
                // `SnapshotAccept`; it held the same property.) So this
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
        // #3328: the attachment root comes from the app-side host, with the
        // DB-path derivation only as a fallback — so files received here land
        // in the same tree the app's attachment GC reconciles.
        match crate::sync_files::attachment_root(materializer.as_ref(), &pool_ref).await {
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
    // #4380: which is why this block asks TWO questions, not one. `already_bound_elsewhere`
    // asks whether the row is somebody else's; `heads_are_ambiguous` asks whether we
    // actually know whose row it is. The second is new, and it is the one that fires
    // with no attacker present.
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
    // Set only where this session ESTABLISHED that `settled_remote_id` is the device
    // behind the key the handshake authenticated — i.e. the TOFU bind below returned
    // `Ok(())`, so the row that id names now carries this key. Read by the #4298 name
    // write, which must not run on an id this session merely heard claimed.
    let mut bound_to_this_key = false;
    if already_bound_elsewhere {
        tracing::warn!(
            peer_id = %settled_remote_id,
            %endpoint_id,
            "refusing to re-bind an already-bound peer to a different key; the device id \
             came from the peer's advertised heads, which is a claim (#800)"
        );
    } else if pairing_pending && heads_are_ambiguous {
        // #4380: the peer did not state an id and its heads name more than one
        // candidate, so `settled_remote_id` is whichever sorted lowest. Refuse.
        //
        // Refusing is the strictly better failure. A wrong bind is permanent and
        // silent: `bind_endpoint_id` writes only its own column, so nothing later
        // corrects it, it then refuses to re-point the key, and every guard keyed on
        // "is this peer bound?" starts permitting the session — for the wrong device.
        // The user sees one device-list entry where two devices are involved and has
        // no way to tell it is wrong. Declining leaves no PERMANENT wrong state: the
        // session still moved its data, the pairing window is deliberately left open
        // (it is only consumed by a bind), and the pair completes through the
        // responder's own initiator pass, which binds against the id the peer
        // ANNOUNCED over mDNS rather than one this frame sorted into first place —
        // the path `discovery::should_attempt_sync_with_discovered_peer` keeps open
        // for exactly the duration of the window (#2008/#3502).
        //
        // Residual, and it is not nothing. The bookkeeping this session already wrote
        // is keyed on the same wrongly-sorted id. It ran under
        // `with_unverified_claim_guard`, but that guard refuses only an id whose row
        // is bound to ANOTHER key — a foreign id this host holds no bound row for is
        // not refused, so `record_stream_in_tx` and `persist_peer_loro_vvs` upsert a
        // row for it and stamp a `loro_vv_bytes` export floor that is the JOINER's
        // frontier, on a row named for a device that never received those ops. What
        // that costs when the real device does pair is bounded: the floor is read
        // back only as the fallback for a space the peer advertised no vv for, and
        // `apply_remote`'s reachability gate turns an unbridgeable `from_vv` into a
        // full snapshot — so the price is a `ResetRequired` round trip and a phantom
        // peer row, not silently dropped ops. That is #4230/#4251's residual, which
        // this branch neither creates nor closes; it is strictly smaller than what
        // preceded #4380 (the same row, PLUS a permanent mis-bind). Refusing here is
        // a refusal to create permanent state, not a claim that the session wrote
        // none.
        tracing::warn!(
            peer_id = %settled_remote_id,
            %endpoint_id,
            "refusing to bind a pairing peer that did not state its own device id and \
             advertised more than one foreign frontier: the id would be whichever \
             sorted lowest, not the joiner's (#4380). Leaving it unbound for its own \
             initiator pass to bind."
        );
    } else if !settled_remote_id.is_empty() && settled_remote_id != device_id {
        match peer_refs::bind_endpoint_id(&pool_ref, &settled_remote_id, &endpoint_id_str).await {
            Ok(()) => {
                bound_to_this_key = true;
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

    // ── Record what the peer calls itself (#4298) ─────────────────────────────
    //
    // Here, and not earlier, for the same reason the bind is here: this is the first
    // point at which the authoritative peer id is known. A name is worthless without an
    // id to hang it on, and the id an unpaired device advertises up front is not one
    // (an empty op log advertises no head of its own).
    //
    // Gated on this session having AUTHENTICATED the peer as `settled_remote_id`, which
    // is exactly the two outcomes above where the id and the handshake key are known to
    // belong together:
    //
    // * `!pairing_pending` — S-1 resolved the row from the key the QUIC handshake
    //   proved, and that row's id went to the FSM as `expected_remote_id`, which it
    //   takes verbatim in preference to the advertised heads. The id is our store's,
    //   not the peer's word.
    // * `bound_to_this_key` — the TOFU bind just accepted this key for this id, so from
    //   the next session on the peer resolves through the first bullet.
    //
    // What that deliberately excludes is the `already_bound_elsewhere` refusal, and the
    // earlier shape of this block — outside the branches, "a peer whose bind was refused
    // still gets its name refreshed if we already hold a row for it" — inverted the
    // guard it sat under. `peer_is_bound_to_another_key` exists precisely because "a
    // device that changed keys" and "an impostor claiming that device's id" are
    // indistinguishable at this point: the id is derived from advertised heads, which is
    // a claim, and the row it names is pinned to somebody else's key. Writing a name
    // there lets an unbound passphrase-holder relabel an already-paired device in the
    // user's device list — and in the sync-failure toast, the unpair dialog and the
    // rename/address labels — wherever no local `device_name` override exists, which is
    // the default state this feature exists to improve. It is #4230's invariant applied
    // to one more column: a session keyed on a CLAIMED device id writes nothing to the
    // row that id names. A device that legitimately changed keys is re-paired through
    // `delete_peer_ref`, and its name arrives with the bind that follows.
    //
    // Nothing is lost on the honest paths: `update_remote_device_name` is a
    // `WHERE peer_id = ?`, so a stranger with no row still records nothing, and the
    // joiner that just paired binds first and is named in the same pass. The value was
    // clamped at the frame boundary; the store write is conditional on an actual change,
    // so a steady-state session costs one read and no write.
    //
    // Best-effort: a failure here loses a display nicety for one session and the next
    // one re-sends the name. It must not fail a session that has already moved data.
    let authenticated_as_settled_id = !pairing_pending || bound_to_this_key;
    if authenticated_as_settled_id
        && !settled_remote_id.is_empty()
        && settled_remote_id != device_id
        && let Some(name) = offered_device_name.as_deref()
    {
        match peer_refs::update_remote_device_name(&pool_ref, &settled_remote_id, Some(name)).await
        {
            Ok(true) => tracing::info!(
                peer_id = %settled_remote_id,
                "recorded the name this peer advertises for itself (#4298)"
            ),
            Ok(false) => {}
            Err(e) => tracing::warn!(
                peer_id = %settled_remote_id,
                error = %e,
                "failed to record the peer's advertised device name (#4298); the device \
                 list keeps whatever name it already had"
            ),
        }
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
            streamed_at: None,
            reset_count: 0,
            last_reset_at: None,
            cert_hash: None,
            device_name: None,
            remote_device_name: None,
            last_address: None,
            endpoint_id: endpoint_id.map(str::to_owned),
            unpaired_by_peer_at_ms: None,
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

    /// #3491: WHICH rejections reach this device's own user is a policy, and
    /// `reject` consults it for all five. The end-to-end pair in
    /// `src/sync_daemon/tests.rs` drives only the passphrase case, so without this
    /// the four `None` arms are decided by a `match` nothing reads back.
    ///
    /// Both halves matter, and the negative half is the one with teeth: `Unpaired`
    /// fires on every stranger's probe and (per #3502) on both devices dialling
    /// each other in the seconds before a passphrase is typed, so flipping it to
    /// `Some` would make the error banner permanent background noise on an idle,
    /// healthy LAN — a regression no pairing test would notice, because none of
    /// them is about an idle LAN.
    #[test]
    fn only_the_passphrase_rejection_is_shown_to_this_devices_own_user() {
        assert_eq!(
            Rejection::PairingProofMissing.user_facing_message(),
            Some(PAIRING_PROOF_REQUIRED_MESSAGE),
            "the passphrase mismatch is the one rejection a user caused and can fix"
        );

        for quiet in [
            Rejection::NotHeadExchange,
            Rejection::Unpaired,
            Rejection::Self_,
            Rejection::Busy,
        ] {
            assert_eq!(
                quiet.user_facing_message(),
                None,
                "{quiet:?} is routine daemon traffic, not a sentence for a user"
            );
        }
    }

    /// The local emit and the wire send must carry the SAME text.
    ///
    /// `PairingDialog.tsx` has exactly one matcher for this rejection, and it is a
    /// substring test against whatever string arrives. So if the message a device
    /// raises for itself and the message it sends the peer ever diverge, one of the
    /// two roles silently stops being handled — which is the #3491 bug re-created
    /// one level down, inside the fix for it.
    /// #3505: every rejection must be readable back off the wire, or the
    /// initiator cannot tell "the peer turned me away" from "the network broke"
    /// — and it books the first as the second, which is the whole defect.
    ///
    /// Round-tripping ALL of them rather than the two the pairing window
    /// produces: the classification in `session_supervisor` is written against
    /// `from_peer_message`, not against a list of interesting variants, so a
    /// variant this cannot read back is a variant that silently re-acquires the
    /// old behaviour.
    #[test]
    fn every_rejection_can_be_read_back_off_the_wire() {
        for rejection in Rejection::all() {
            assert_eq!(
                Rejection::from_peer_message(rejection.peer_message()),
                Some(rejection.clone()),
                "{rejection:?} must round-trip through the text it puts on the wire"
            );
        }
    }

    /// …and nothing else may be, or an ordinary session failure would be
    /// excused from the backoff that exists for it.
    ///
    /// The `format!` case is the one with teeth: `session_supervisor` wraps a
    /// terminal failure as `"Sync failed: {e}"`, and a `contains`-based reading
    /// would match that wrapper — so a real failure whose message merely quoted
    /// a rejection would stop being recorded.
    #[test]
    fn only_the_exact_wire_texts_are_read_as_rejections() {
        for not_a_rejection in [
            "",
            "connection reset by peer",
            PAIRING_PROOF_REQUIRED_MESSAGE.to_uppercase().as_str(),
            &format!("Sync failed: {PAIRING_PROOF_REQUIRED_MESSAGE}"),
            &format!("{PEER_NOT_PAIRED_MESSAGE} (and then the socket died)"),
        ] {
            assert_eq!(
                Rejection::from_peer_message(not_a_rejection),
                None,
                "{not_a_rejection:?} is not a rejection this responder ever sent"
            );
        }
    }

    #[test]
    fn the_local_and_wire_rejection_texts_are_the_same_string() {
        assert_eq!(
            Rejection::PairingProofMissing.user_facing_message(),
            Some(Rejection::PairingProofMissing.peer_message()),
            "the frontend cannot tell the two origins apart, and must not have to"
        );
    }
}
