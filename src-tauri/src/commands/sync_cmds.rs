//! Sync Cmds command handlers.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tracing::instrument;

use crate::db::{ReadPool, WritePool};
use agaric_core::error::AppError;
use agaric_store::peer_refs::{self, PeerRef};
use agaric_sync::device::DeviceId;
use agaric_sync::pairing::{PairingSession, ScannedPeerCandidate, lock_pairing_state};
use agaric_sync::sync_events::{
    BindExposureStatus, BindExposureStatusState, MdnsStatus, MdnsStatusState, OsNetworkBlockStatus,
};
use agaric_sync::sync_protocol::loro_sync_quarantine::{
    QuarantinedSlot, count_quarantined_slots, list_quarantined_slots, readmit_quarantined_slot,
};
use agaric_sync::sync_scheduler::SyncScheduler;

use super::*;

/// List all known sync peers, ordered by most-recently-synced first.
#[instrument(skip(pool), err)]
pub async fn list_peer_refs_inner(pool: &SqlitePool) -> Result<Vec<PeerRef>, AppError> {
    peer_refs::list_peer_refs(pool).await
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

/// The most rows [`list_quarantined_sync_slots_inner`] returns in one call. The
/// quarantine holds a handful of rows by design, so this is a flat lookup, not a
/// paginated list; `total` still counts every row.
const MAX_QUARANTINED_SYNC_SLOTS: i64 = 100;

/// Quarantined Loro sync deltas (#6057): the listed rows plus the full count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct QuarantinedSlotList {
    /// Newest first, at most the requested `limit`.
    pub slots: Vec<QuarantinedSlot>,
    /// Every quarantined row, including those past `limit`.
    pub total: u64,
}

/// List the sync deltas the boot replay gave up on and moved to
/// `loro_sync_quarantine` (#3226), across every space.
///
/// Returns [`AppError::Validation`] when `limit` is outside
/// `[1, MAX_QUARANTINED_SYNC_SLOTS]`.
#[instrument(skip(pool), err)]
pub async fn list_quarantined_sync_slots_inner(
    pool: &SqlitePool,
    limit: i64,
) -> Result<QuarantinedSlotList, AppError> {
    if !(1..=MAX_QUARANTINED_SYNC_SLOTS).contains(&limit) {
        return Err(AppError::validation(format!(
            "list_quarantined_sync_slots limit must be in [1, {MAX_QUARANTINED_SYNC_SLOTS}]; got {limit}"
        )));
    }
    Ok(QuarantinedSlotList {
        slots: list_quarantined_slots(pool, limit).await?,
        total: count_quarantined_slots(pool).await?,
    })
}

/// Move quarantined sync delta `id` back into the boot replay's inbox (#6057).
/// The next start retries it once and quarantines it again if it still fails.
///
/// Returns [`AppError::NotFound`] when no quarantined row has that id, as for a
/// row already retried.
#[instrument(skip(pool), err)]
pub async fn readmit_quarantined_sync_slot_inner(
    pool: &SqlitePool,
    id: i64,
) -> Result<(), AppError> {
    readmit_quarantined_slot(pool, id)
        .await?
        .map(|_inbox_id| ())
        .ok_or_else(|| AppError::NotFound(format!("quarantined sync slot {id}")))
}

/// `app_settings` key: `'1'` when the opt-in internet fallback is on (#4549),
/// anything else off. Read by the daemon once at start, so a change takes
/// effect at the next app launch.
const INTERNET_RELAY_KEY: &str = "sync.internet_relay";

/// The device-local sync relay preference (#4549), stored in `app_settings`
/// so the daemon can read it at bind time without the webview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncRelaySettings {
    /// Off by default: a fresh install never talks to a relay until the user
    /// opts in from Settings → Sync & Devices.
    pub enabled: bool,
}

/// Read the sync relay preference; an absent row reads as off.
#[instrument(skip(pool), err)]
pub async fn get_sync_relay_settings_inner(
    pool: &SqlitePool,
) -> Result<SyncRelaySettings, AppError> {
    let value = sqlx::query_scalar!(
        "SELECT value FROM app_settings WHERE key = ?",
        INTERNET_RELAY_KEY
    )
    .fetch_optional(pool)
    .await?;
    Ok(SyncRelaySettings {
        enabled: value.as_deref() == Some("1"),
    })
}

/// Persist the sync relay preference. The daemon picks it up at the next app
/// launch; the setting's copy says so.
#[instrument(skip(pool), err)]
pub async fn set_sync_relay_settings_inner(
    pool: &SqlitePool,
    settings: SyncRelaySettings,
) -> Result<(), AppError> {
    let now = crate::db::now_ms();
    let enabled = if settings.enabled { "1" } else { "0" };
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        INTERNET_RELAY_KEY,
        enabled,
        now,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Where this device's sync endpoint listens, for Settings › Sync & devices (#6526).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct LocalSyncAddress {
    /// The bound socket, `ip:port`.
    pub address: String,
    /// The endpoint is on the loopback fallback: there is no local network, and
    /// no other device can reach `address`.
    pub loopback: bool,
}

/// The address the daemon's endpoint is bound to; `None` while it has bound none.
#[instrument(skip(scheduler))]
pub fn get_local_sync_address_inner(scheduler: &SyncScheduler) -> Option<LocalSyncAddress> {
    let bound = *scheduler.local_endpoint()?.addrs.first()?;
    Some(LocalSyncAddress {
        address: bound.to_string(),
        loopback: bound.ip().is_loopback(),
    })
}

/// Return the local device's persistent UUID.
#[instrument(skip(device_id))]
pub fn get_device_id_inner(device_id: &DeviceId) -> String {
    device_id.as_str().to_string()
}

/// Start a new pairing session. The logic lives in
/// [`agaric_sync::pairing::start_pairing`] (#3120); this keeps the command's
/// `_inner` shape.
pub fn start_pairing_inner(
    pairing_state: &Mutex<Option<PairingSession>>,
    device_id: &str,
) -> Result<PairingInfo, AppError> {
    // `None`: this variant does not arm the pairing window, so it never wakes a
    // dormant daemon and has nothing to resolve an address from. Its QR is the
    // passphrase-only shape (#4037). The command the frontend actually calls is
    // `start_pairing_armed_inner`.
    agaric_sync::pairing::start_pairing(pairing_state, device_id)
}

/// Start pairing AND arm the pairing window; see
/// [`agaric_sync::pairing::start_pairing_armed`].
pub async fn start_pairing_armed_inner(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    scheduler: &SyncScheduler,
    device_id: &str,
) -> Result<PairingInfo, AppError> {
    agaric_sync::pairing::start_pairing_armed(pool, pairing_state, scheduler, device_id).await
}

/// Confirm pairing with a remote device (the joiner half); see
/// [`agaric_sync::pairing::confirm_pairing`].
pub async fn confirm_pairing_inner(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    scheduler: &SyncScheduler,
    passphrase: String,
    scanned: Option<ScannedPeerCandidate>,
) -> Result<(), AppError> {
    agaric_sync::pairing::confirm_pairing(pool, pairing_state, scheduler, passphrase, scanned).await
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
#[instrument(skip(pool, pairing_state, scheduler), err)]
pub async fn cancel_pairing_inner(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    scheduler: &SyncScheduler,
) -> Result<(), AppError> {
    *lock_pairing_state(pairing_state)? = None;
    peer_refs::clear_pending_pairing(pool).await?;
    // #4037: the scanned candidate belongs to the attempt being cancelled. The
    // `pairing_pending` gate keeps it inert only BETWEEN windows, so without
    // this it would be re-dialled in every later window for the process
    // lifetime — including one this device opens as host for a different peer.
    scheduler.clear_scanned_peer();
    Ok(())
}

/// Start a sync session with a remote peer.
///
/// Probes the daemon's per-peer lock and wakes the SyncDaemon to sync now.
/// Actual network sync happens in the daemon; this returns immediately with a
/// "queued" status, because no session has run yet. The session's outcome
/// arrives later as the terminal update on the progress channel `start_sync`
/// registered.
///
/// A peer in backoff is dialled only when `user_initiated`: a press clears the
/// backoff, so it reports that dial's result (#6523). A scheduled call leaves
/// the backoff alone and returns "backoff", which is the peer waiting, not a
/// failure.
///
/// It takes a pool because the daemon keys its per-peer lock on the peer's
/// bound `endpoint_id`, which only `peer_refs` knows; the key comes from
/// [`agaric_sync::sync_daemon::peer_lock_key_from_stored`], the same derivation
/// the daemon's two roles use, so the probe and the lock agree by construction.
#[instrument(skip(pool, scheduler), err)]
pub async fn start_sync_inner(
    pool: &SqlitePool,
    scheduler: &SyncScheduler,
    device_id: &str,
    peer_id: String,
    user_initiated: bool,
) -> Result<SyncSessionInfo, AppError> {
    let info = |state: &str, peer_id: String| SyncSessionInfo {
        state: state.into(),
        local_device_id: device_id.to_string(),
        remote_device_id: peer_id,
        ops_received: 0,
        ops_sent: 0,
    };
    // Backoff, events and `peer_refs` are device-keyed; only the lock is keyed
    // on the endpoint id.
    if user_initiated {
        scheduler.clear_peer_backoff(&peer_id);
    } else if !scheduler.may_retry(&peer_id) {
        return Ok(info("backoff", peer_id));
    }

    // A probe, not an exclusion lock: it turns "the daemon is mid-session with
    // this peer" into a message instead of a silent "queued". The guard drops at
    // the end of this block, so it does not serialise concurrent calls; real
    // per-peer exclusion lives in the daemon. For those microseconds a concurrent
    // inbound session for the same endpoint is refused as busy, which the remote
    // counts as a failure.
    //
    // A peer with no bound `endpoint_id` is not probed: the daemon may still be
    // mid-session with it under the key it announces on mDNS, but that key is
    // not knowable from `peer_refs`, and probing under the device id could never
    // collide. The first successful sync binds the key.
    if let Some(endpoint_id) = peer_refs::get_peer_ref(pool, &peer_id)
        .await?
        .and_then(|peer| peer.endpoint_id)
    {
        let lock_key = agaric_sync::sync_daemon::peer_lock_key_from_stored(&endpoint_id)?;
        let _health_check_only_guard = scheduler.try_lock_peer(&lock_key).ok_or_else(|| {
            AppError::InvalidOperation("Sync already in progress for this peer".into())
        })?;
    }

    // A call the user did not start clears no backoff here: the daemon's
    // success path does, once the sync has run.
    scheduler.notify_change();

    Ok(info("queued", peer_id))
}

/// Cancel an active sync session.
///
/// Sets the cancel flag that the dial and every receive of the sync message
/// exchange loops (initiator and responder) race against (#5739).
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
///
/// #4298 made the parenthesis above true. It described the intent from the
/// start, but no device ever supplied a name — `device_name` was never on the
/// wire — so clearing the override left the row empty and the device list fell
/// back to a truncated peer id. The peer's own name now arrives in
/// `HeadExchange` and lands in the separate `peer_refs.remote_device_name`
/// column, which this command deliberately does not touch: it writes only the
/// user's override, and clearing that override is what reveals the name
/// underneath.
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
    // #4037: the host a scanned QR named, or `None` when the passphrase was
    // typed. A candidate to race mDNS with, never a substitute for it.
    scanned_peer: Option<ScannedPeerCandidate>,
    pool: State<'_, WritePool>,
    pairing_state: State<'_, PairingState>,
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<(), AppError> {
    confirm_pairing_inner(
        &pool.0,
        &pairing_state.0,
        &scheduler,
        passphrase,
        scanned_peer,
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
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<(), AppError> {
    cancel_pairing_inner(&pool.0, &pairing_state.0, &scheduler)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: start sync with a remote peer.
///
/// `user_initiated` is `true` for a press on Sync, which dials a peer in
/// backoff at once; a scheduled call passes `false` and gets state `"backoff"`
/// for such a peer.
#[tauri::command]
#[specta::specta]
pub async fn start_sync<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    peer_id: String,
    user_initiated: bool,
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
                channel: crate::main_thread::UiChannel::new(app, progress),
            })
        }),
    );
    // #3550: the read pool is here so the busy probe can resolve the peer's bound
    // `endpoint_id` and take the S-5 key the daemon actually locks under. Read
    // rather than write — this only ever `SELECT`s a `peer_refs` row.
    start_sync_inner(
        &pool.0,
        &scheduler,
        device_id.as_str(),
        peer_id,
        user_initiated,
    )
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

/// Tauri command: the address this device's sync endpoint is bound to (#6526).
#[tauri::command]
#[specta::specta]
pub async fn get_local_sync_address(
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<Option<LocalSyncAddress>, AppError> {
    Ok(get_local_sync_address_inner(&scheduler))
}

/// Tauri command: read the device-local sync relay preference (#4549).
#[tauri::command]
#[specta::specta]
pub async fn get_sync_relay_settings(
    pool: State<'_, ReadPool>,
) -> Result<SyncRelaySettings, AppError> {
    get_sync_relay_settings_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list quarantined sync deltas (#6057). Delegates to
/// [`list_quarantined_sync_slots_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_quarantined_sync_slots(
    pool: State<'_, ReadPool>,
    limit: i64,
) -> Result<QuarantinedSlotList, AppError> {
    list_quarantined_sync_slots_inner(&pool.0, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: retry a quarantined sync delta at the next start (#6057).
/// Delegates to [`readmit_quarantined_sync_slot_inner`].
#[tauri::command]
#[specta::specta]
pub async fn readmit_quarantined_sync_slot(
    pool: State<'_, WritePool>,
    id: i64,
) -> Result<(), AppError> {
    readmit_quarantined_sync_slot_inner(&pool.0, id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: persist the device-local sync relay preference (#4549).
#[tauri::command]
#[specta::specta]
pub async fn set_sync_relay_settings(
    pool: State<'_, WritePool>,
    settings: SyncRelaySettings,
) -> Result<(), AppError> {
    set_sync_relay_settings_inner(&pool.0, settings)
        .await
        .map_err(sanitize_internal_error)
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
mod relay_settings_tests {
    use super::{SyncRelaySettings, get_sync_relay_settings_inner, set_sync_relay_settings_inner};
    use tempfile::TempDir;

    #[tokio::test]
    async fn a_fresh_install_reads_off_and_a_write_round_trips() {
        let dir = TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();

        assert_eq!(
            get_sync_relay_settings_inner(&pool).await.unwrap(),
            SyncRelaySettings { enabled: false },
            "no row is off: a fresh install never talks to a relay"
        );

        set_sync_relay_settings_inner(&pool, SyncRelaySettings { enabled: true })
            .await
            .unwrap();
        assert_eq!(
            get_sync_relay_settings_inner(&pool).await.unwrap(),
            SyncRelaySettings { enabled: true }
        );

        // Off stores '0' rather than deleting the row, and reads back as off.
        set_sync_relay_settings_inner(&pool, SyncRelaySettings { enabled: false })
            .await
            .unwrap();
        assert_eq!(
            get_sync_relay_settings_inner(&pool).await.unwrap(),
            SyncRelaySettings { enabled: false }
        );
        let rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM app_settings WHERE key = 'sync.internet_relay'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 1);
    }
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
