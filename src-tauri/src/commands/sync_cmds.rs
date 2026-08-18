//! Sync Cmds command handlers.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use sqlx::SqlitePool;

use tauri::State;
use tracing::instrument;

use crate::db::{ReadPool, WritePool};
use agaric_core::error::AppError;
use agaric_store::peer_refs::{self, PeerRef};
use agaric_sync::device::DeviceId;
use agaric_sync::pairing::PairingSession;
use agaric_sync::pairing::{generate_qr_svg, pairing_qr_payload};
use agaric_sync::sync_events::{
    BindExposureStatus, BindExposureStatusState, MdnsStatus, MdnsStatusState, OsNetworkBlockStatus,
};
use agaric_sync::sync_scheduler::SyncScheduler;

use super::*;

/// Acquire the pairing-state mutex, mapping a poisoned-lock failure
/// to a stable [`AppError::InvalidOperation`]. The error message is fixed
/// at `"pairing state lock poisoned"` so callers and tests can pattern-match
/// on it.
fn lock_pairing_state(
    pairing_state: &Mutex<Option<PairingSession>>,
) -> Result<MutexGuard<'_, Option<PairingSession>>, AppError> {
    pairing_state
        .lock()
        .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))
}

/// List all known sync peers, ordered by most-recently-synced first.
#[instrument(skip(pool), err)]
pub async fn list_peer_refs_inner(pool: &SqlitePool) -> Result<Vec<PeerRef>, AppError> {
    peer_refs::list_peer_refs(pool).await
}

/// Fetch a single sync peer by its `peer_id`.
///
/// Returns `None` if the peer does not exist (not an error).
#[instrument(skip(pool), err)]
pub async fn get_peer_ref_inner(
    pool: &SqlitePool,
    peer_id: String,
) -> Result<Option<PeerRef>, AppError> {
    peer_refs::get_peer_ref(pool, &peer_id).await
}

/// Delete (unpair) a sync peer by its `peer_id`.
///
/// Returns [`AppError::NotFound`] if the peer does not exist.
#[instrument(skip(pool), err)]
pub async fn delete_peer_ref_inner(pool: &SqlitePool, peer_id: String) -> Result<(), AppError> {
    peer_refs::delete_peer_ref(pool, &peer_id).await
}

#[instrument(skip(pool), err)]
pub async fn update_peer_name_inner(
    pool: &SqlitePool,
    peer_id: String,
    device_name: Option<String>,
) -> Result<(), AppError> {
    peer_refs::update_device_name(pool, &peer_id, device_name.as_deref()).await
}

/// Set (or update) a peer's last-known network address for direct connection.
///
/// Accepts `host:port` — host may be an IP literal or a hostname (e.g. mDNS
/// `*.local`). The host string is left opaque; the daemon resolves it at
/// connect time. The port must be a non-zero `u16`. Verifies the peer exists
/// before persisting.
#[instrument(skip(pool), err)]
pub async fn set_peer_address_inner(
    pool: &SqlitePool,
    peer_id: String,
    address: String,
) -> Result<(), AppError> {
    // Validate the address format.
    // Accepts host:port — host may be an IP literal or a hostname
    // (e.g. mDNS `*.local`). Splits on the LAST `:` so bracketed IPv6
    // literals (`[::1]:1234`) parse correctly. Resolution is deferred to
    // the daemon at connect time.
    validate_host_port(&address)?;

    // Verify peer exists
    let peer = peer_refs::get_peer_ref(pool, &peer_id).await?;
    if peer.is_none() {
        return Err(AppError::NotFound(format!("peer '{peer_id}' not found")));
    }

    // `update_last_address` now returns `NotFound` if the peer row is
    // gone. We just verified it exists above, so a `NotFound` here is a
    // TOCTOU race with `delete_peer_ref` — log and swallow per the documented
    // threat model (peer is the user's own device, not a hostile actor).
    // Other errors (DB failures, etc.) still propagate.
    if let Err(e) = peer_refs::update_last_address(pool, &peer_id, &address).await {
        match &e {
            AppError::NotFound(_) => {
                tracing::warn!(
                    error = %e,
                    peer_id = %peer_id,
                    "peer disappeared between existence check and update_last_address; \
                     race with delete_peer_ref"
                );
            }
            _ => return Err(e),
        }
    }
    Ok(())
}

/// Validate a `host:port` string for [`set_peer_address_inner`].
///
/// Accepts `host:port` — host may be an IP literal or a hostname (e.g. mDNS
/// `*.local`). Splits on the LAST `:` to handle bracketed IPv6 literals
/// (`[::1]:1234`) and plain `host:port`. The host string is left opaque so
/// the daemon can resolve it at connect time; only the port is validated as
/// a non-zero `u16`.
fn validate_host_port(address: &str) -> Result<(), AppError> {
    let invalid = || {
        AppError::validation(format!(
            "invalid address: {address}. Expected host:port \
             (host may be an IP literal or hostname, e.g. mDNS `*.local`)"
        ))
    };
    let (host, port) = address.rsplit_once(':').ok_or_else(invalid)?;
    if host.is_empty() || port.is_empty() {
        return Err(invalid());
    }
    let port: u16 = port.parse().map_err(|_| invalid())?;
    if port == 0 {
        return Err(invalid());
    }
    Ok(())
}

/// Return the local device's persistent UUID.
#[instrument(skip(device_id))]
pub fn get_device_id_inner(device_id: &DeviceId) -> String {
    device_id.as_str().to_string()
}

/// Start a new pairing session.
///
/// Generates a fresh passphrase, creates a QR code SVG for sharing,
/// stores the session in `pairing_state`, and returns the pairing info
/// to the frontend.
///
/// The QR payload + [`PairingInfo`] both carry only the passphrase.
/// mDNS owns discovery + address resolution end-to-end; the QR is not a
/// scan-bootstrap channel for a direct `host:port` connection.
#[instrument(skip(pairing_state), err)]
pub fn start_pairing_inner(
    pairing_state: &Mutex<Option<PairingSession>>,
    device_id: &str,
) -> Result<PairingInfo, AppError> {
    let session = PairingSession::new(device_id, "");
    let passphrase = session.passphrase.clone();
    let qr_svg = generate_qr_svg(&pairing_qr_payload(&passphrase))?;

    *lock_pairing_state(pairing_state)? = Some(session);

    Ok(PairingInfo { passphrase, qr_svg })
}

/// Start pairing AND arm the pairing window so the host's dormant daemon
/// activates for the duration.
///
/// #2008: a first-ever pair has zero peers, so on the host
/// [`agaric_sync::sync_daemon::SyncDaemon::should_start_active`] would return
/// `false` and the daemon would stay dormant — not announcing over mDNS,
/// not listening — so the joining device could neither discover nor connect
/// to it and pairing would deadlock. Setting the pending-pairing marker
/// (the same TTL-bounded marker the joiner's [`confirm_pairing_inner`] sets)
/// flips `should_start_active` to `true`; `notify_change()` wakes a dormant
/// daemon immediately instead of waiting for its next poll. The marker is
/// cleared once a real `peer_ref` exists (`should_start_active`).
#[instrument(skip(pool, pairing_state, scheduler, device_id), err)]
pub async fn start_pairing_armed_inner(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    scheduler: &SyncScheduler,
    device_id: &str,
) -> Result<PairingInfo, AppError> {
    let info = start_pairing_inner(pairing_state, device_id)?;
    // #855: store the passphrase proof in the pending-pairing marker so the
    // responder can require the joiner to prove knowledge of the passphrase
    // before we TOFU-pin it (closes the CN-spoof window).
    peer_refs::set_pending_pairing(pool, &agaric_sync::pairing::pairing_proof(&info.passphrase))
        .await?;
    // #3547: the wake below is a SINGLE wake, and it is what Branch B turns into
    // the dial a first-ever pair depends on. Backoff standing against a peer
    // would let `may_retry` skip it, and nothing would retry until the next
    // scheduled round. See `SyncScheduler::clear_backoff` for why a user-initiated
    // pairing act is new information, and why it clears every peer.
    scheduler.clear_backoff();
    scheduler.notify_change();
    Ok(info)
}

/// Confirm pairing with a remote device — the **joiner** half of the flow.
///
/// The user typed the passphrase displayed on the *other* device. This arms
/// **this** device's TTL-bounded pending-pairing marker with
/// `pairing_proof(typed)` and clears the local offer session, because a device
/// that accepts someone else's passphrase is a joiner, not a host.
///
/// # #3463 — why there is no local comparison any more
///
/// Before #3463 this compared the typed passphrase against the passphrase in
/// *this* device's own `pairing_state` slot. Two-device pairing therefore could
/// never succeed: the pairing dialog starts a session on every device that
/// opens it, so the two devices hold independently-random passphrases and the
/// joiner's comparison mismatched with probability ~1.
///
/// Removing it costs nothing, because it never authenticated anything: the slot
/// is local state the local user created seconds earlier, so "matches the local
/// slot" is a statement about this device only. The check that actually gates
/// trust is on the wire and is untouched — `sync_daemon::server` admits an
/// unpaired device during the pairing window only if the `pairing_proof` it
/// offers constant-time-matches the proof in the responder's own marker (#855),
/// and the initiator sources that offered proof from its own marker
/// (`session_state_machine::start`). The protocol's precondition is thus
/// "both devices hold a marker for the SAME passphrase", and establishing that
/// is exactly this function's job.
///
/// # Attempt limiting (#1603) is gone — deliberately
///
/// `MAX_PASSPHRASE_ATTEMPTS` / `pairing.attempts_exhausted` bounded repeated
/// *local* guesses against the local slot. With no local comparison there is no
/// local guess to count, so keeping the counter would be dead code that reads
/// like a security control. The bound that matters is on the wire and already
/// exists: the pending-pairing marker expires after
/// `agaric_store::peer_refs::PAIRING_TIMEOUT` (5 minutes), after which
/// `get_pending_pairing_proof` reads as absent and an unpaired peer is rejected
/// outright. A remote guesser must produce `pairing_proof(P)` for a ~51.7-bit
/// passphrase inside that window, one TLS connection per try.
///
/// # Errors
///
/// No longer fails on passphrase content. #3463 removed both the local
/// comparison and the "a pairing session must exist" precondition, so this
/// function is infallible apart from DB and lock failures — it arms a local
/// marker, which is a local act that cannot be wrong about a value the user
/// just typed. In particular `pairing.no_active_session` is **not** returned
/// here any more; a correct joiner has no local session by construction.
///
/// The consequence is that a mistyped passphrase succeeds here and only fails
/// later, at the wire-side proof check. The UI must not claim success on the
/// strength of this returning `Ok` — see #3469.
///
/// On success the pending-pairing marker is armed and the scheduler is
/// signalled so a dormant sync daemon transitions to active mode without
/// waiting for its next poll interval.
#[instrument(skip(pool, pairing_state, scheduler, passphrase), err)]
pub async fn confirm_pairing_inner(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    scheduler: &SyncScheduler,
    _device_id: &str,
    passphrase: String,
    _remote_device_id: String,
) -> Result<(), AppError> {
    // #3463: there is deliberately NO "a local pairing session must exist" guard
    // here, and removing it is part of the fix rather than a relaxation of it.
    //
    // A correct joiner never has a local session. It did not generate a
    // passphrase — it was handed one. Requiring a session would mean requiring
    // the joiner to first mint a competing passphrase of its own, which is
    // exactly the role confusion that made two-device pairing impossible: both
    // devices offering, neither accepting.
    //
    // The guard that used to live here read like a safety check but could only
    // ever be satisfied by a device in the *wrong* role, so it was not
    // protecting an invariant — it was enforcing the defect.
    //
    // Nothing security-relevant is lost. It tested state this same frontend had
    // written seconds earlier via `start_pairing`, so it authenticated nothing;
    // and arming the marker is inert without a passphrase the user typed. The
    // real bound is the marker's 5-minute TTL plus the wire-side constant-time
    // proof check in `sync_daemon::server`.
    //
    // Role exclusivity now lives where the roles actually are: the UI, which
    // requires an explicit host/joiner choice before either path can run. Making
    // that unrepresentable in the *backend* type (a `PairingRole` enum replacing
    // `Option<PairingSession>`) is the right end state and is scoped into the
    // pairing rewrite on plan #3464, where the passphrase becomes an iroh ticket.

    // The FE has no remote device_id at confirm time — the QR carries only the
    // passphrase, and mDNS + TOFU establish the real peer on the first
    // authenticated connection. So we set a persistent pending-pairing marker
    // that wakes the dormant daemon to *accept* that first connection, instead
    // of writing a junk empty-string `peer_refs` row (which used to be the only
    // thing tripping `should_start_active`, but showed as a blank ghost peer and
    // lingered forever). `_remote_device_id` is consequently always `""` from
    // the FE; the old branch that pre-created a NULL-`cert_hash` `peer_ref` for
    // a supplied device id was the CN-spoof pinning surface removed by #855.
    //
    // #855/#3463: the marker carries `pairing_proof` of the TYPED passphrase, so
    // this device and the host end up holding the same proof — each can then
    // both offer it (as initiator) and require it (as responder).
    peer_refs::set_pending_pairing(pool, &agaric_sync::pairing::pairing_proof(&passphrase)).await?;

    // Clear the local offer session: this device is a joiner, and leaving its
    // own competing passphrase on display invites the role confusion of #3463.
    *lock_pairing_state(pairing_state)? = None;

    // #3547: this is the confirm the whole #3502 fix exists to serve — the
    // moment the two markers finally agree — and the wake below is the single
    // wake that turns it into a dial. Every pre-confirm dial in this window was
    // doomed by construction (the user had not typed yet), so any backoff they
    // left behind is not evidence about *this* dial; it would just make the one
    // that matters probabilistic. See `SyncScheduler::clear_backoff`.
    scheduler.clear_backoff();

    // Wake a dormant daemon (if any). Harmless if the daemon is
    // already active — `notify_change` is debounced by
    // `wait_for_debounced_change`.
    scheduler.notify_change();

    Ok(())
}

/// Cancel an in-progress pairing session.
///
/// Clears the stored in-memory session (no-op if none is active) AND the
/// DB-side pending-pairing marker.
///
/// # #3493 — why the marker clear cannot be gated on the session
///
/// Before this fix, cancel only cleared `pairing_state`. Both pairing roles
/// arm the marker (`start_pairing_armed_inner` for the host,
/// `confirm_pairing_inner` for the joiner) *before* a wire connection has
/// completed, so a cancelled wait left the marker armed for the rest of its
/// TTL. The wire-side responder (`sync_daemon::server`) admits any unpaired
/// device that offers a proof matching that marker, so a stale or concurrent
/// inbound connection could still complete pairing against a row the user
/// had already cancelled.
///
/// The marker clear is therefore unconditional — it does not check whether
/// `pairing_state` held a session. `confirm_pairing_inner` (the joiner path)
/// already nulls the local session the instant it arms the marker, since a
/// joiner is waiting on the *wire* handshake, not on local state. If cancel
/// only cleared the marker when a local session was present, cancelling
/// during that wait (session already `None`, marker still live) would be a
/// no-op on the very row this fix targets — reintroducing the defect via an
/// ordering trap rather than fixing it.
///
/// # Why unconditional is not over-clearing
///
/// The marker is a single device-global `app_settings` row, not a per-attempt
/// record: `set_pending_pairing` upserts one key, so a second attempt already
/// overwrites the first's proof with no ownership check. There is therefore no
/// attempt identity for a clear to respect — "disarm this device" is the only
/// meaning the row can carry, and it is exactly what an explicit user cancel
/// asks for. (Contrast #3536, where the frontend needed a generation token:
/// there the stale value was a *poll result* being judged against a newer
/// wait, so the two attempts genuinely coexisted and had to be told apart.)
/// The caller-side counterpart is `PairingDialog`'s `backendArmedRef`, which
/// keeps a cancel with nothing armed from firing at all.
///
/// # Known residual window (accepted)
///
/// The responder reads the marker once, at admission time
/// (`sync_daemon::server`), and pins the peer later in the same handshake. A
/// cancel that lands between that read and the pin does not abort the
/// connection, so a handshake already in flight can still complete. This is
/// inherent — cancel is a local state change, not a wire abort — and it is
/// bounded by a single in-flight handshake rather than the full 5-minute TTL,
/// which is the whole of what #3493 removes.
///
/// # Behaviour change (review, not a bug): closing the host dialog now genuinely cancels
///
/// The frontend already called `cancel_pairing` when the *host* dialog
/// closed, before this fix existed — but the marker clear used to be gated
/// (or, pre-#3493, simply absent in the ways described above), so that call
/// was effectively a no-op on the marker: a joiner mid-attempt could still
/// complete pairing after the host had closed its dialog. Now that the
/// clear is unconditional, that same call genuinely disarms the marker, so
/// a joiner submitting a passphrase after the host closes its dialog can no
/// longer complete against it. This follows directly from the fix above
/// rather than being a bug in its own right, but it regresses a flow that
/// used to work (by accident) and is worth knowing before assuming "host
/// closed its dialog" is harmless to an in-flight joiner.
#[instrument(skip(pool, pairing_state), err)]
pub async fn cancel_pairing_inner(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
) -> Result<(), AppError> {
    *lock_pairing_state(pairing_state)? = None;
    peer_refs::clear_pending_pairing(pool).await?;
    Ok(())
}

/// Start a sync session with a remote peer.
///
/// Checks the backoff schedule, probes the daemon's per-peer lock, and wakes
/// the SyncDaemon (#382) to sync now.  Actual network sync happens in
/// the daemon; this returns immediately with a "complete" status to
/// indicate the trigger was accepted.
///
/// # Why this takes a pool (#3550)
///
/// It used to be synchronous and poolless, and the busy probe below paid for it.
/// The probe called `try_lock_peer(&peer_id)` — a *device* id — while #3511 had
/// moved S-5's lock to be keyed on the peer's `EndpointId` on both roles, because
/// the responder cannot key on a device id it has not been told yet. A device id
/// looked up in a table keyed by endpoint id can never collide, so the
/// `"Sync already in progress for this peer"` arm became unreachable: a guard that
/// read as protective and could not fire, with no test to notice.
///
/// Resolving the peer's bound `endpoint_id` means a `peer_refs` read, which means a
/// pool, which is why this signature changed rather than the probe being deleted.
/// The key itself is derived by [`agaric_sync::sync_daemon::peer_lock_key_from_stored`],
/// which delegates to the same `peer_lock_key` the daemon's two roles call — so the
/// probe and the lock it probes agree *by construction*, not because two call sites
/// spell the same thing.
#[instrument(skip(pool, scheduler), err)]
pub async fn start_sync_inner(
    pool: &SqlitePool,
    scheduler: &SyncScheduler,
    device_id: &str,
    peer_id: String,
) -> Result<SyncSessionInfo, AppError> {
    // Check backoff. Still keyed on `peer_id`: only the *lock* moved to the
    // endpoint id (#3529), backoff/events/`peer_refs` remain device-keyed.
    if !scheduler.may_retry(&peer_id) {
        return Err(AppError::InvalidOperation(
            "Peer is in backoff, try again later".into(),
        ));
    }

    // HEALTH CHECK ONLY — this is a *probe*, not an exclusion lock, and the
    // distinction is load-bearing in both directions.
    //
    // What it does do (again, since #3550): if the daemon is mid-session with
    // this peer it holds the S-5 lock under `peer_lock_key(endpoint_id)` for the
    // duration of the real network sync, so `try_lock_peer` on that same key
    // returns `None` and the user gets a message instead of a "complete" that
    // silently did nothing.
    //
    // What it does NOT do: serialise concurrent wrapper calls. The guard falls
    // out of scope at the end of this block, microseconds later, so two
    // back-to-back `start_sync` invocations can both observe `Some(...)`, both
    // drop, and both call `notify_change()` below. Real per-peer exclusion lives
    // in the daemon, where `try_sync_with_peer` and `handle_incoming_sync` hold
    // the same key across the whole session. Do not lean on this for
    // correctness.
    //
    // A peer with no bound `endpoint_id` is skipped rather than probed under some
    // substitute key. That is a *best-effort gap, not a proof of idleness*, and the
    // distinction is worth stating precisely because the tempting version of this
    // comment is wrong:
    //
    // It is NOT true that an unbound peer can never be mid-sync. The daemon does
    // not read the lock key from `peer_refs`; it reads it off the `DiscoveredPeer`,
    // and `discovery::resolve_peer_address` prefers the mDNS-discovered peer
    // unconditionally — `discovered.get(peer_id)` wins before the `peer_refs`
    // fallback is even consulted. So a row with `endpoint_id IS NULL` whose device
    // is announcing on the LAN yields a `DiscoveredPeer` with
    // `endpoint_id: Some(announced)`, which sails past `try_sync_with_peer`'s step 2,
    // takes S-5 at step 3 under `peer_lock_key(announced)`, and passes step 4
    // because an unbound row has nothing to mismatch against (that is the TOFU
    // path by which a pre-iroh `peer_ref` re-acquires its binding at all — `0107`
    // could not backfill a key from a cert hash). During that session the daemon
    // genuinely holds a lock this probe cannot see.
    //
    // We skip anyway because there is no honest alternative: the key is not
    // knowable from `peer_refs`, and probing under the device id is precisely the
    // never-colliding non-probe #3550 exists to remove. The window closes itself —
    // the first successful sync binds the key, and every later press is probed for
    // real. For a *bound* row the probe is exact, because step 4 refuses any
    // announced key that differs from the bound one, so the key the daemon locks
    // under is the key read here.
    //
    // Cost of probing under the daemon's real key, stated: for the microseconds
    // this guard is held, a concurrent `handle_incoming_sync` for the same endpoint
    // rejects with `Rejection::Busy` and a concurrent `try_sync_with_peer` skips the
    // peer for that round. The local skip is free (step 3 returns without
    // `record_failure`); the rejection is not, since the remote initiator counts a
    // refused session as a failure and doubles its own backoff. The window is a few
    // microseconds around a user button press, which is why this is documented
    // rather than serialised, but it is a real interference that did not exist when
    // the probe used a key the daemon never touched.
    if let Some(endpoint_id) = peer_refs::get_peer_ref(pool, &peer_id)
        .await?
        .and_then(|peer| peer.endpoint_id)
    {
        let lock_key = agaric_sync::sync_daemon::peer_lock_key_from_stored(&endpoint_id)?;
        let _health_check_only_guard = scheduler.try_lock_peer(&lock_key).ok_or_else(|| {
            AppError::InvalidOperation("Sync already in progress for this peer".into())
        })?;
    }

    // Wake the SyncDaemon to sync now (#382). The wrapper does NOT
    // pre-credit `record_success` — the daemon's own success path calls
    // `scheduler.record_success(peer_id)` after a real network sync
    // Succeeds. Pre-crediting here wiped per-peer backoff state
    // before the daemon had even attempted the sync, defeating the
    // backoff invariant documented in docs/architecture/sync-and-network.md § Dual-backoff ("`record_failure(id)`
    // Doubles backoff: 1s → 2s → 4s → … → 60s max"). The wrapper's job
    // is to *trigger* a sync, not to mark it successful.
    scheduler.notify_change();

    Ok(SyncSessionInfo {
        state: "complete".into(),
        local_device_id: device_id.to_string(),
        remote_device_id: peer_id,
        ops_received: 0,
        ops_sent: 0,
    })
}

/// Cancel an active sync session.
///
/// Sets the cancel flag that is checked each iteration of the sync message
/// exchange loops (initiator and responder).
///
/// #2537: the flag is only latched while a session is actually live
/// ([`SyncScheduler::request_cancel`] gates on the scheduler's
/// live-session count). With nothing running the call is a no-op —
/// previously the flag was stored unconditionally, and since the only
/// resetter was the initiator-side session guard, a cancel with no active
/// session latched `true` forever, instantly failing every inbound
/// responder session and burning the next outbound one (recorded as a
/// backoff-doubling failure) just to clear it.
#[instrument(skip(cancel_flag, scheduler), err)]
pub fn cancel_sync_inner(
    cancel_flag: &AtomicBool,
    scheduler: &SyncScheduler,
) -> Result<(), AppError> {
    if !scheduler.request_cancel(cancel_flag) {
        tracing::debug!("cancel_sync ignored: no sync session is active");
    }
    Ok(())
}

/// Tauri command: list all sync peers. Delegates to [`list_peer_refs_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_peer_refs(pool: State<'_, ReadPool>) -> Result<Vec<PeerRef>, AppError> {
    list_peer_refs_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get a single sync peer by ID. Delegates to [`get_peer_ref_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_peer_ref(
    pool: State<'_, ReadPool>,
    peer_id: String,
) -> Result<Option<PeerRef>, AppError> {
    get_peer_ref_inner(&pool.0, peer_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: delete (unpair) a sync peer. Delegates to [`delete_peer_ref_inner`].
#[tauri::command]
#[specta::specta]
pub async fn delete_peer_ref(pool: State<'_, WritePool>, peer_id: String) -> Result<(), AppError> {
    delete_peer_ref_inner(&pool.0, peer_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: rename a paired sync peer's display name (or clear
/// it back to the device-supplied value when `device_name` is `None`).
/// Delegates to [`update_peer_name_inner`].
#[tauri::command]
#[specta::specta]
pub async fn update_peer_name(
    pool: State<'_, WritePool>,
    peer_id: String,
    device_name: Option<String>,
) -> Result<(), AppError> {
    update_peer_name_inner(&pool.0, peer_id, device_name)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: set a peer's last-known network address for direct connection.
#[tauri::command]
#[specta::specta]
pub async fn set_peer_address(
    peer_id: String,
    address: String,
    pool: State<'_, WritePool>,
) -> Result<(), AppError> {
    set_peer_address_inner(&pool.0, peer_id, address)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: return the local device's persistent UUID.
#[tauri::command]
#[specta::specta]
pub async fn get_device_id(device_id: State<'_, DeviceId>) -> Result<String, AppError> {
    Ok(get_device_id_inner(&device_id))
}

/// Tauri command: start a new pairing session.
/// Generates a passphrase + QR SVG and stores the session in managed state.
#[tauri::command]
#[specta::specta]
pub async fn start_pairing(
    pool: State<'_, WritePool>,
    pairing_state: State<'_, PairingState>,
    device_id: State<'_, DeviceId>,
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<PairingInfo, AppError> {
    start_pairing_armed_inner(&pool.0, &pairing_state.0, &scheduler, device_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: confirm pairing with a remote device.
/// Stores the peer ref in the database and clears the pairing session.
#[tauri::command]
#[specta::specta]
pub async fn confirm_pairing(
    passphrase: String,
    remote_device_id: String,
    pool: State<'_, WritePool>,
    pairing_state: State<'_, PairingState>,
    device_id: State<'_, DeviceId>,
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<(), AppError> {
    confirm_pairing_inner(
        &pool.0,
        &pairing_state.0,
        &scheduler,
        device_id.as_str(),
        passphrase,
        remote_device_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: cancel an in-progress pairing session.
#[tauri::command]
#[specta::specta]
pub async fn cancel_pairing(
    pool: State<'_, WritePool>,
    pairing_state: State<'_, PairingState>,
) -> Result<(), AppError> {
    cancel_pairing_inner(&pool.0, &pairing_state.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: start sync with a remote peer.
/// Checks backoff (#278), acquires the per-peer lock, and returns session info.
#[tauri::command]
#[specta::specta]
pub async fn start_sync(
    peer_id: String,
    pool: State<'_, ReadPool>,
    device_id: State<'_, DeviceId>,
    scheduler: State<'_, Arc<SyncScheduler>>,
    progress: tauri::ipc::Channel<agaric_sync::sync_events::SyncProgressUpdate>,
) -> Result<SyncSessionInfo, AppError> {
    // #2621 Sync-D: the scheduler (in `agaric-sync`) stores an opaque
    // `SessionSinkWrapper` rather than the Tauri channel itself, keeping Tauri
    // out of the sync layer. Build the wrapper here (where Tauri is available):
    // it wraps the daemon's base event sink in a `ChannelEventSink` that streams
    // progress to this command's `progress` channel.
    scheduler.register_channel(
        &peer_id,
        Box::new(move |inner| {
            std::sync::Arc::new(crate::sync_event_sinks::ChannelEventSink {
                inner,
                channel: progress,
            })
        }),
    );
    // #3550: the read pool is here so the busy probe can resolve the peer's bound
    // `endpoint_id` and take the S-5 key the daemon actually locks under. Read
    // rather than write — this only ever `SELECT`s a `peer_refs` row.
    start_sync_inner(&pool.0, &scheduler, device_id.as_str(), peer_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: cancel an active sync session.
#[tauri::command]
#[specta::specta]
pub async fn cancel_sync(
    cancel_flag: State<'_, crate::SyncCancelFlag>,
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<(), AppError> {
    cancel_sync_inner(&cancel_flag.0, &scheduler).map_err(sanitize_internal_error)
}

/// Tauri command: return the current mDNS peer-discovery status (#2506).
///
/// Used by the peers/device-management surface to backfill the
/// "discovery unavailable" signal on mount, in case its
/// `sync:mdns_disabled` listener registered after the sync daemon already
/// emitted (the daemon can start before the webview finishes mounting —
/// same race `get_recovery_status` covers for `recovery:degraded`).
#[tauri::command]
#[specta::specta]
pub async fn get_mdns_status(state: State<'_, MdnsStatusState>) -> Result<MdnsStatus, AppError> {
    let guard = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Ok(guard.clone())
}

/// Tauri command: return whether the sync endpoint bound a globally-routable
/// address (#3864).
///
/// The device-management surface backfills its "reachable from outside your
/// local network" banner from this on mount. Unlike the mDNS case the backfill
/// is not a fallback — the endpoint binds within the first moments of
/// `daemon_loop`, so a webview that is still mounting misses the live
/// `sync:internet_facing_bind` event essentially every time.
#[tauri::command]
#[specta::specta]
pub async fn get_bind_exposure_status(
    state: State<'_, BindExposureStatusState>,
) -> Result<BindExposureStatus, AppError> {
    let guard = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Ok(guard.clone())
}

/// Tauri command: return whether the OS is blocking this app's traffic **right
/// now** (#4035).
///
/// The pairing UI calls this as soon as its `sync:network_blocked`
/// subscription is live. Unlike the two commands above this is not a race fix:
/// `SyncEvent::NetworkBlockedByOs` is emitted only on a *transition*, and the
/// dedup behind that is process-global, so a listener that subscribes while a
/// block is already in progress gets no event however early it subscribes —
/// the one event for that block is already spent, and the next will not come
/// until the block ends. Without this query the screen the user opened
/// *because* pairing stopped working is a clean one, on a device whose network
/// is cut: #3852's failure mode, arrived at from the other direction.
///
/// Takes no managed state: the answer lives in the `android_network_block`
/// process-global that the JNI callback writes, which is where the platform's
/// statements land and the only place they are complete (the event stream drops
/// every repeat). Returns "not blocked" on every non-Android platform, where
/// nothing ever writes it.
#[tauri::command]
#[specta::specta]
pub fn get_os_network_block_status() -> Result<OsNetworkBlockStatus, AppError> {
    Ok(agaric_sync::sync_daemon::android_network_block::current_status())
}

#[cfg(test)]
mod tests_m35 {
    //! `set_peer_address_inner` previously rejected hostnames despite
    //! advertising "host:port" semantics. The validator now accepts arbitrary
    //! `host:port` (host opaque, port a non-zero u16), so mDNS `*.local`
    //! hosts and other DNS names round-trip without resolution at the
    //! command layer. Resolution is deferred to the daemon.
    use super::{AppError, validate_host_port};

    fn assert_accepts(addr: &str) {
        match validate_host_port(addr) {
            Ok(()) => {}
            Err(e) => panic!("expected `{addr}` to be accepted, got error: {e:?}"),
        }
    }

    fn assert_rejects(addr: &str) {
        match validate_host_port(addr) {
            Err(AppError::Validation { message: msg, .. }) => {
                assert!(
                    msg.contains("host:port"),
                    "validation error for `{addr}` should mention host:port, got: {msg}"
                );
            }
            Err(other) => panic!("expected Validation error for `{addr}`, got: {other:?}"),
            Ok(()) => panic!("expected `{addr}` to be rejected, but it was accepted"),
        }
    }

    #[test]
    fn m35_accepts_valid_host_port_forms() {
        // Includes the formats the previous SocketAddr validator accepted
        // (IPv4:port, [IPv6]:port) plus DNS / mDNS hostnames that the old
        // validator wrongly rejected.
        let cases = [
            "127.0.0.1:8080",
            "[::1]:1234",
            "myphone.local:12345",
            "agaric-deviceA:1024",
            "hostname.example.com:65535",
            "a.b.c.d.example:1",
        ];
        for addr in cases {
            assert_accepts(addr);
        }
    }

    #[test]
    fn m35_rejects_malformed_addresses() {
        // Empty / no port, empty host, empty port, non-numeric port,
        // zero port, out-of-range ports, negative ports.
        let cases = [
            "",
            "hostonly",
            ":1234",
            "host:",
            "host:abc",
            "host:0",
            "host:65536",
            "host:-1",
        ];
        for addr in cases {
            assert_rejects(addr);
        }
    }

    #[test]
    fn m35_error_message_mentions_hostname_guidance() {
        // The error should steer the user toward "host may be a hostname",
        // not the old "Expected host:port" wording that misled callers into
        // thinking only IP literals were allowed.
        let err = validate_host_port("host:abc").expect_err("host:abc must fail");
        let AppError::Validation { message: msg, .. } = err else {
            panic!("expected Validation error, got: {err:?}");
        };
        assert!(
            msg.contains("hostname"),
            "error message should mention hostname guidance, got: {msg}"
        );
        assert!(
            msg.contains("host:port"),
            "error message should still mention host:port, got: {msg}"
        );
    }
}
