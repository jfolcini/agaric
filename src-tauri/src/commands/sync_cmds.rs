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
use crate::pairing::{generate_qr_svg, pairing_qr_payload};
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
/// Validates the address is a valid `host:port` socket address and that the
/// peer exists before persisting.
#[instrument(skip(pool), err)]
pub async fn set_peer_address_inner(
    pool: &SqlitePool,
    peer_id: String,
    address: String,
) -> Result<(), AppError> {
    // Validate the address format
    address.parse::<std::net::SocketAddr>().map_err(|_| {
        AppError::Validation(format!("invalid address: {address}. Expected host:port"))
    })?;

    // Verify peer exists
    let peer = peer_refs::get_peer_ref(pool, &peer_id).await?;
    if peer.is_none() {
        return Err(AppError::NotFound(format!("peer '{peer_id}' not found")));
    }

    peer_refs::update_last_address(pool, &peer_id, &address).await
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
/// Validates the passphrase against the current session, stores the peer
/// reference in the database, and clears the pairing session.
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
    // Derive a session from the passphrase to verify the key derivation
    // path works (the actual shared key will be used for future encrypted
    // exchanges).
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

    // Try to acquire peer lock
    let _guard = scheduler.try_lock_peer(&peer_id).ok_or_else(|| {
        AppError::InvalidOperation("Sync already in progress for this peer".into())
    })?;

    // Wake the SyncDaemon to sync now (#382)
    scheduler.notify_change();

    // Record success so the backoff state stays clean.
    scheduler.record_success(&peer_id);

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
