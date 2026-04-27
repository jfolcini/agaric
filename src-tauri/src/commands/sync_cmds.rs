//! Sync Cmds command handlers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;

use tauri::State;
use tracing::instrument;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::pairing::PairingSession;
use crate::pairing::{generate_qr_svg, pairing_qr_payload, verify_device_exchange, PairingMessage};
use crate::peer_refs::{self, PeerRef};
use crate::sync_scheduler::SyncScheduler;

use super::*;

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
    // M-35: Accepts host:port — host may be an IP literal or a hostname
    // (e.g. mDNS `*.local`). Splits on the LAST `:` so bracketed IPv6
    // literals (`[::1]:1234`) parse correctly. Resolution is deferred to
    // the daemon at connect time.
    validate_host_port(&address)?;

    // Verify peer exists
    let peer = peer_refs::get_peer_ref(pool, &peer_id).await?;
    if peer.is_none() {
        return Err(AppError::NotFound(format!("peer '{peer_id}' not found")));
    }

    peer_refs::update_last_address(pool, &peer_id, &address).await
}

/// M-35: Validate a `host:port` string for [`set_peer_address_inner`].
///
/// Accepts `host:port` — host may be an IP literal or a hostname (e.g. mDNS
/// `*.local`). Splits on the LAST `:` to handle bracketed IPv6 literals
/// (`[::1]:1234`) and plain `host:port`. The host string is left opaque so
/// the daemon can resolve it at connect time; only the port is validated as
/// a non-zero `u16`.
fn validate_host_port(address: &str) -> Result<(), AppError> {
    let invalid = || {
        AppError::Validation(format!(
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
#[instrument(skip(pairing_state), err)]
pub fn start_pairing_inner(
    pairing_state: &Mutex<Option<PairingSession>>,
    device_id: &str,
) -> Result<PairingInfo, AppError> {
    let session = PairingSession::new(device_id, "");
    let passphrase = session.passphrase.clone();
    let qr_svg = generate_qr_svg(&pairing_qr_payload(&passphrase, "0.0.0.0", 0))?;

    *pairing_state
        .lock()
        .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))? =
        Some(session);

    Ok(PairingInfo {
        passphrase,
        qr_svg,
        port: 0,
    })
}

/// Confirm pairing with a remote device.
///
/// H-1: validates the supplied `passphrase` against the active
/// `pairing_state` slot via [`verify_device_exchange`]. Before H-1 the
/// passphrase was accepted as-is and the entire `PairingMessage` +
/// `verify_device_exchange` machinery was dead code.
///
/// Failure modes (all use `AppError::Validation` so they pass through
/// `sanitize_internal_error` unchanged and reach the frontend with a
/// stable, machine-readable tag in `message`):
///
/// - `pairing.no_active_session` — the user pressed Confirm without an
///   active pairing session (slot is empty, e.g. cancelled or expired).
/// - `pairing.passphrase.mismatch` — the typed passphrase does not
///   match the one stored in the active slot. The slot is preserved so
///   the user can retry without re-displaying the QR.
///
/// On success: stores the peer reference and clears the slot.
///
/// PERF-25: After persisting the peer, signals the scheduler so the
/// dormant sync daemon (if any) transitions to active mode without
/// waiting for the next poll interval.
#[instrument(skip(pool, pairing_state, scheduler), err)]
pub async fn confirm_pairing_inner(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<PairingSession>>,
    scheduler: &SyncScheduler,
    device_id: &str,
    passphrase: String,
    remote_device_id: String,
) -> Result<(), AppError> {
    // H-1: pull the expected passphrase out of the active slot before
    // any await. Holding a std `Mutex` across `.await` is unsound under
    // tokio's single-threaded scheduler and would also be lock-order
    // hostile — so we clone the field and drop the guard before the
    // network/db call below.
    let expected_passphrase = {
        let guard = pairing_state
            .lock()
            .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))?;
        guard
            .as_ref()
            .ok_or_else(|| AppError::Validation("pairing.no_active_session".into()))?
            .passphrase
            .clone()
    };

    // H-1: build the device-exchange message representing the joining
    // device's response and route it through `verify_device_exchange`.
    // `cert_hash` is empty here — the actual TLS cert pin happens later
    // in the daemon path; this layer only authenticates "the typed
    // passphrase matches what we generated".
    let msg = PairingMessage::DeviceOffer {
        device_id: remote_device_id.clone(),
        cert_hash: String::new(),
        passphrase: passphrase.clone(),
    };
    verify_device_exchange(&msg, None, Some(&expected_passphrase))?;

    // Construct a session object for API symmetry with the initiator
    // path; immediately discard it. The pairing exchange's
    // confidentiality and authenticity come from the mTLS + TOFU-cert-pin
    // layer in `crate::sync_net::connection`, not from any application-
    // layer derived key — see the `pairing` module-level doc.
    let _session = PairingSession::from_passphrase(&passphrase, device_id, &remote_device_id);

    // Store the peer ref
    peer_refs::upsert_peer_ref(pool, &remote_device_id).await?;

    // Clear pairing session
    *pairing_state
        .lock()
        .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))? = None;

    // PERF-25: Wake a dormant daemon (if any). Harmless if the daemon is
    // already active — `notify_change` is debounced by
    // `wait_for_debounced_change`.
    scheduler.notify_change();

    Ok(())
}

/// Cancel an in-progress pairing session.
///
/// Clears the stored session; no-op if no session is active.
#[instrument(skip(pairing_state), err)]
pub fn cancel_pairing_inner(pairing_state: &Mutex<Option<PairingSession>>) -> Result<(), AppError> {
    *pairing_state
        .lock()
        .map_err(|_| AppError::InvalidOperation("pairing state lock poisoned".into()))? = None;
    Ok(())
}

/// Start a sync session with a remote peer.
///
/// Checks the backoff schedule, acquires the per-peer lock, and wakes
/// the SyncDaemon (#382) to sync now.  Actual network sync happens in
/// the daemon; this returns immediately with a "complete" status to
/// indicate the trigger was accepted.
#[instrument(skip(scheduler), err)]
pub fn start_sync_inner(
    scheduler: &SyncScheduler,
    device_id: &str,
    peer_id: String,
) -> Result<SyncSessionInfo, AppError> {
    // Check backoff
    if !scheduler.may_retry(&peer_id) {
        return Err(AppError::InvalidOperation(
            "Peer is in backoff, try again later".into(),
        ));
    }

    // M-33: HEALTH CHECK ONLY — this is *not* a real exclusion lock.
    //
    // The `Some` vs `None` result of `try_lock_peer` is used as a probe
    // for "is the daemon currently syncing this peer?" and the early
    // return surfaces a user-visible error when the daemon already
    // holds the per-peer lock. That probe is the only purpose of this
    // call at the wrapper layer.
    //
    // The returned guard (`_health_check_only_guard`) falls out of scope
    // when `start_sync_inner` returns microseconds later — it does NOT
    // serialise concurrent wrapper calls. Two back-to-back `start_sync`
    // invocations can both observe `Some(...)` here, both drop their
    // guards immediately, and both call `notify_change()` below.
    //
    // Real per-peer exclusion lives in the daemon, where
    // `try_sync_with_peer` re-acquires the same lock for the duration
    // of the actual network sync — see
    // `src-tauri/src/sync_daemon/orchestrator.rs::try_sync_with_peer`
    // (the `try_lock_peer` call there is what serialises real syncs).
    // If a wrapper call interleaves with a daemon sync exactly on the
    // lock acquisition the wrapper wins this probe and the daemon's
    // own guard returns `None`, so the daemon skips that tick — but
    // the wrapper's `notify_change()` will wake it on the next pass.
    //
    // Do not lean on this guard for correctness; it is named
    // `_health_check_only_guard` to make that misreading harder.
    let _health_check_only_guard = scheduler.try_lock_peer(&peer_id).ok_or_else(|| {
        AppError::InvalidOperation("Sync already in progress for this peer".into())
    })?;

    // Wake the SyncDaemon to sync now (#382). The wrapper does NOT
    // pre-credit `record_success` — the daemon's own success path calls
    // `scheduler.record_success(peer_id)` after a real network sync
    // succeeds. Pre-crediting here (M-32) wiped per-peer backoff state
    // before the daemon had even attempted the sync, defeating the
    // backoff invariant documented in ARCHITECTURE.md §18 ("`record_failure(id)`
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
/// exchange loop.  If no sync is active the flag is harmlessly cleared on
/// the next session start.
#[instrument(skip(cancel_flag), err)]
pub fn cancel_sync_inner(cancel_flag: &AtomicBool) -> Result<(), AppError> {
    cancel_flag.store(true, Ordering::Release);
    Ok(())
}

/// Tauri command: list all sync peers. Delegates to [`list_peer_refs_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_peer_refs(pool: State<'_, ReadPool>) -> Result<Vec<PeerRef>, AppError> {
    list_peer_refs_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get a single sync peer by ID. Delegates to [`get_peer_ref_inner`].
#[cfg(not(tarpaulin_include))]
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
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_peer_ref(pool: State<'_, WritePool>, peer_id: String) -> Result<(), AppError> {
    delete_peer_ref_inner(&pool.0, peer_id)
        .await
        .map_err(sanitize_internal_error)
}

#[cfg(not(tarpaulin_include))]
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
#[cfg(not(tarpaulin_include))]
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
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_device_id(device_id: State<'_, DeviceId>) -> Result<String, AppError> {
    Ok(get_device_id_inner(&device_id))
}

/// Tauri command: start a new pairing session.
/// Generates a passphrase + QR SVG and stores the session in managed state.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn start_pairing(
    pairing_state: State<'_, PairingState>,
    device_id: State<'_, DeviceId>,
) -> Result<PairingInfo, AppError> {
    start_pairing_inner(&pairing_state.0, device_id.as_str()).map_err(sanitize_internal_error)
}

/// Tauri command: confirm pairing with a remote device.
/// Stores the peer ref in the database and clears the pairing session.
#[cfg(not(tarpaulin_include))]
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
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn cancel_pairing(pairing_state: State<'_, PairingState>) -> Result<(), AppError> {
    cancel_pairing_inner(&pairing_state.0).map_err(sanitize_internal_error)
}

/// Tauri command: start sync with a remote peer.
/// Checks backoff (#278), acquires the per-peer lock, and returns session info.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn start_sync(
    peer_id: String,
    device_id: State<'_, DeviceId>,
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<SyncSessionInfo, AppError> {
    start_sync_inner(&scheduler, device_id.as_str(), peer_id).map_err(sanitize_internal_error)
}

/// Tauri command: cancel an active sync session.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn cancel_sync(cancel_flag: State<'_, crate::SyncCancelFlag>) -> Result<(), AppError> {
    cancel_sync_inner(&cancel_flag.0).map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests_m35 {
    //! M-35: `set_peer_address_inner` previously rejected hostnames despite
    //! advertising "host:port" semantics. The validator now accepts arbitrary
    //! `host:port` (host opaque, port a non-zero u16), so mDNS `*.local`
    //! hosts and other DNS names round-trip without resolution at the
    //! command layer. Resolution is deferred to the daemon.
    use super::{validate_host_port, AppError};

    fn assert_accepts(addr: &str) {
        match validate_host_port(addr) {
            Ok(()) => {}
            Err(e) => panic!("expected `{addr}` to be accepted, got error: {e:?}"),
        }
    }

    fn assert_rejects(addr: &str) {
        match validate_host_port(addr) {
            Err(AppError::Validation(msg)) => {
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
        let AppError::Validation(msg) = err else {
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
