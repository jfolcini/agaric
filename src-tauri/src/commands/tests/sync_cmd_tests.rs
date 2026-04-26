#![allow(unused_imports)]
use super::super::*;
use super::common::*;
use crate::peer_refs;
use crate::sync_scheduler::SyncScheduler;
use std::sync::atomic::{AtomicBool, Ordering};

// ======================================================================
// Sync — list_peer_refs
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_list_peer_refs_returns_empty_vec_initially() {
    let (pool, _dir) = test_pool().await;

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert!(
        peers.is_empty(),
        "list_peer_refs must return empty vec on fresh DB"
    );
}

// ======================================================================
// Sync — get_peer_ref
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_get_peer_ref_returns_none_for_nonexistent() {
    let (pool, _dir) = test_pool().await;

    let result = get_peer_ref_inner(&pool, "nonexistent-peer".into())
        .await
        .unwrap();
    assert!(
        result.is_none(),
        "get_peer_ref must return None for nonexistent peer"
    );
}

// ======================================================================
// Sync — delete_peer_ref
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_delete_peer_ref_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let result = delete_peer_ref_inner(&pool, "ghost-peer".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "delete_peer_ref on nonexistent peer must return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_delete_peer_ref_removes_existing_peer() {
    let (pool, _dir) = test_pool().await;

    // Insert a peer directly
    peer_refs::upsert_peer_ref(&pool, "peer-to-delete")
        .await
        .unwrap();

    // Verify it exists
    let before = get_peer_ref_inner(&pool, "peer-to-delete".into())
        .await
        .unwrap();
    assert!(before.is_some(), "peer must exist before delete");

    // Delete it
    delete_peer_ref_inner(&pool, "peer-to-delete".into())
        .await
        .unwrap();

    // Verify it's gone
    let after = get_peer_ref_inner(&pool, "peer-to-delete".into())
        .await
        .unwrap();
    assert!(after.is_none(), "peer must be gone after delete");
}

// ======================================================================
// Sync — get_device_id
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_get_device_id_returns_non_empty_string() {
    let device_id = crate::device::DeviceId::new("test-device-uuid-1234".to_string());

    let result = get_device_id_inner(&device_id);
    assert!(
        !result.is_empty(),
        "get_device_id must return a non-empty string"
    );
    assert_eq!(
        result, "test-device-uuid-1234",
        "get_device_id must return the exact device ID"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_list_peer_refs_returns_inserted_peers() {
    let (pool, _dir) = test_pool().await;

    // Insert some peers
    peer_refs::upsert_peer_ref(&pool, "peer-A").await.unwrap();
    peer_refs::upsert_peer_ref(&pool, "peer-B").await.unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 2, "must return all 2 inserted peers");

    let ids: Vec<&str> = peers.iter().map(|p| p.peer_id.as_str()).collect();
    assert!(ids.contains(&"peer-A"), "must contain peer-A");
    assert!(ids.contains(&"peer-B"), "must contain peer-B");
}

// ======================================================================
// Sync — start_pairing (#275)
// ======================================================================

#[test]
fn sync_start_pairing_returns_passphrase_and_qr() {
    let pairing_state = Mutex::new(None);
    let result = start_pairing_inner(&pairing_state, "device-A");
    assert!(result.is_ok(), "start_pairing must succeed");

    let info = result.unwrap();
    // Passphrase should be 4 words
    let words: Vec<&str> = info.passphrase.split(' ').collect();
    assert_eq!(words.len(), 4, "passphrase must contain 4 words");

    // QR SVG should contain <svg
    assert!(
        info.qr_svg.contains("<svg"),
        "qr_svg must contain an SVG tag"
    );

    // Port is a placeholder
    assert_eq!(info.port, 0, "port must be 0 (placeholder)");

    // Session should be stored in state
    let session = pairing_state.lock().unwrap();
    assert!(session.is_some(), "pairing session must be stored in state");
}

#[test]
fn sync_start_pairing_replaces_existing_session() {
    let pairing_state = Mutex::new(None);

    let info1 = start_pairing_inner(&pairing_state, "device-A").unwrap();
    let info2 = start_pairing_inner(&pairing_state, "device-A").unwrap();

    // Each call generates a new passphrase (astronomically unlikely to collide)
    // Just verify both succeed
    assert!(
        !info1.passphrase.is_empty(),
        "first passphrase should not be empty"
    );
    assert!(
        !info2.passphrase.is_empty(),
        "second passphrase should not be empty"
    );
}

// ======================================================================
// Sync — confirm_pairing (#275)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_confirm_pairing_stores_peer_and_clears_session() {
    let (pool, _dir) = test_pool().await;
    let pairing_state = Mutex::new(None);
    let scheduler = SyncScheduler::new();

    // Start pairing first
    let info = start_pairing_inner(&pairing_state, "device-local").unwrap();

    // Confirm with the passphrase
    confirm_pairing_inner(
        &pool,
        &pairing_state,
        &scheduler,
        "device-local",
        info.passphrase,
        "device-remote".into(),
    )
    .await
    .unwrap();

    // Peer ref should now exist
    let peer = peer_refs::get_peer_ref(&pool, "device-remote")
        .await
        .unwrap();
    assert!(peer.is_some(), "peer ref must exist after confirm_pairing");

    // Pairing session should be cleared
    let session = pairing_state.lock().unwrap();
    assert!(
        session.is_none(),
        "pairing session must be cleared after confirm"
    );
}

// ----------------------------------------------------------------------
// H-1 — Pairing passphrase verification against the active slot
// ----------------------------------------------------------------------
//
// `confirm_pairing_inner` must reject any passphrase that does not match
// the active `pairing_state` slot. Before H-1 the function accepted any
// string; the entire `PairingMessage` + `verify_device_exchange`
// machinery in `pairing.rs` was dead code. These tests pin down the
// post-H-1 contract:
//
// 1. Wrong passphrase → `Err(AppError::Validation(_))` tagged
//    `pairing.passphrase.mismatch`.
// 2. Correct passphrase → `Ok(())`, peer persisted, session cleared.
// 3. No active slot → `Err(AppError::Validation(_))` tagged
//    `pairing.no_active_session`.
//
// Per the threat model in AGENTS.md, the pairing passphrase is the one
// place where input from outside the local trust boundary matters: the
// user has typed it from the QR display on the source device, so a
// mismatch means we are talking to the wrong peer.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_pairing_inner_rejects_wrong_passphrase() {
    let (pool, _dir) = test_pool().await;
    let pairing_state = Mutex::new(None);
    let scheduler = SyncScheduler::new();

    // Start pairing — generates a fresh passphrase stored in the slot.
    let _info = start_pairing_inner(&pairing_state, "device-local").unwrap();

    // Confirm with a deliberately-wrong passphrase. Use 4 words so the
    // shape matches what a real user would type, ruling out any stray
    // length/format check masking a real mismatch.
    let result = confirm_pairing_inner(
        &pool,
        &pairing_state,
        &scheduler,
        "device-local",
        "wrong wrong wrong wrong".into(),
        "device-remote".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg == "pairing.passphrase.mismatch"),
        "wrong passphrase must surface as Validation(\"pairing.passphrase.mismatch\"), got {result:?}"
    );

    // Peer must NOT have been persisted.
    let peer = peer_refs::get_peer_ref(&pool, "device-remote")
        .await
        .unwrap();
    assert!(
        peer.is_none(),
        "peer ref must NOT be persisted after a passphrase mismatch"
    );

    // Pairing slot must remain populated so the user can retry without
    // re-displaying the QR.
    assert!(
        pairing_state.lock().unwrap().is_some(),
        "active pairing slot must survive a failed confirmation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_pairing_inner_accepts_correct_passphrase() {
    let (pool, _dir) = test_pool().await;
    let pairing_state = Mutex::new(None);
    let scheduler = SyncScheduler::new();

    let info = start_pairing_inner(&pairing_state, "device-local").unwrap();

    // Confirm with the exact passphrase from the active slot.
    confirm_pairing_inner(
        &pool,
        &pairing_state,
        &scheduler,
        "device-local",
        info.passphrase,
        "device-remote".into(),
    )
    .await
    .expect("correct passphrase must succeed");

    let peer = peer_refs::get_peer_ref(&pool, "device-remote")
        .await
        .unwrap();
    assert!(
        peer.is_some(),
        "peer ref must be persisted on successful confirmation"
    );
    assert!(
        pairing_state.lock().unwrap().is_none(),
        "active pairing slot must be cleared on successful confirmation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_pairing_inner_errors_when_no_pairing_in_flight() {
    let (pool, _dir) = test_pool().await;
    // Empty slot — start_pairing_inner was never called.
    let pairing_state = Mutex::new(None);
    let scheduler = SyncScheduler::new();

    let result = confirm_pairing_inner(
        &pool,
        &pairing_state,
        &scheduler,
        "device-local",
        "any pass phrase here".into(),
        "device-remote".into(),
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg == "pairing.no_active_session"),
        "missing slot must surface as Validation(\"pairing.no_active_session\"), got {result:?}"
    );

    // No peer should have been persisted.
    let peer = peer_refs::get_peer_ref(&pool, "device-remote")
        .await
        .unwrap();
    assert!(
        peer.is_none(),
        "peer ref must NOT be persisted when no pairing is in flight"
    );
}

// ======================================================================
// Sync — cancel_pairing (#275)
// ======================================================================

#[test]
fn sync_cancel_pairing_clears_session() {
    let pairing_state = Mutex::new(None);

    // Start pairing
    start_pairing_inner(&pairing_state, "device-A").unwrap();
    assert!(
        pairing_state.lock().unwrap().is_some(),
        "pairing session should exist after start"
    );

    // Cancel
    cancel_pairing_inner(&pairing_state).unwrap();
    assert!(
        pairing_state.lock().unwrap().is_none(),
        "pairing session must be cleared after cancel"
    );
}

#[test]
fn sync_cancel_pairing_noop_when_no_session() {
    let pairing_state = Mutex::new(None);

    // Cancel with no active session — should succeed
    let result = cancel_pairing_inner(&pairing_state);
    assert!(
        result.is_ok(),
        "cancel_pairing with no session must succeed"
    );
}

// ======================================================================
// Sync — start_sync (#278: backoff integration)
// ======================================================================

#[test]
fn sync_start_sync_returns_complete_info() {
    let scheduler = SyncScheduler::new();
    let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
    assert!(result.is_ok(), "start_sync must succeed for a fresh peer");

    let info = result.unwrap();
    assert_eq!(info.state, "complete", "sync state should be complete");
    assert_eq!(
        info.local_device_id, "device-local",
        "local device id should match"
    );
    assert_eq!(
        info.remote_device_id, "peer-1",
        "remote device id should match"
    );
    assert_eq!(info.ops_received, 0, "fresh sync should receive zero ops");
    assert_eq!(info.ops_sent, 0, "fresh sync should send zero ops");
}

#[test]
fn sync_start_sync_respects_backoff() {
    let scheduler = SyncScheduler::new();
    scheduler.record_failure("peer-1");

    let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
    assert!(
        result.is_err(),
        "start_sync must fail when peer is in backoff"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("backoff"),
        "error should mention backoff, got: {err}"
    );
}

#[test]
fn sync_start_sync_after_backoff_reset_succeeds() {
    let scheduler = SyncScheduler::new();
    scheduler.record_failure("peer-1");
    scheduler.record_success("peer-1"); // reset backoff

    let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
    assert!(
        result.is_ok(),
        "start_sync must succeed after backoff is reset"
    );
}

#[test]
fn sync_start_sync_does_not_record_success_preemptively() {
    // M-32 regression: `start_sync_inner` used to call
    // `scheduler.record_success(peer_id)` immediately after
    // `notify_change`, wiping per-peer backoff state before the
    // SyncDaemon had attempted (let alone succeeded at) a real sync.
    // The wrapper now only *triggers* a sync; the daemon's own
    // success path records the result after a real network round-trip.
    let scheduler = SyncScheduler::new();
    let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
    assert!(result.is_ok(), "start_sync must succeed for a fresh peer");

    // No backoff entries should exist for peer-1 — `start_sync_inner`
    // does not add one (the daemon does), and post-M-32 it must not
    // touch the backoff map at all.
    assert!(
        scheduler.failure_counts().is_empty(),
        "start_sync_inner must not touch backoff state; found: {:?}",
        scheduler.failure_counts()
    );
}

// ======================================================================
// Sync — cancel_sync
// ======================================================================

#[test]
fn sync_cancel_sync_succeeds() {
    let flag = AtomicBool::new(false);
    let result = cancel_sync_inner(&flag);
    assert!(result.is_ok(), "cancel_sync must succeed");
    assert!(
        flag.load(Ordering::Acquire),
        "cancel flag must be set after cancel_sync"
    );
}

// ======================================================================
// set_peer_address — manual peer address management (#522)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_peer_address_stores_address() {
    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "peer-1").await.unwrap();

    set_peer_address_inner(&pool, "peer-1".into(), "192.168.1.100:9090".into())
        .await
        .unwrap();

    let peer = peer_refs::get_peer_ref(&pool, "peer-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        peer.last_address.as_deref(),
        Some("192.168.1.100:9090"),
        "peer address should be updated"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_peer_address_rejects_invalid_address() {
    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "peer-1").await.unwrap();

    let result = set_peer_address_inner(&pool, "peer-1".into(), "not-an-address".into()).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid address should return Validation error"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_peer_address_rejects_unknown_peer() {
    let (pool, _dir) = test_pool().await;

    let result =
        set_peer_address_inner(&pool, "nonexistent".into(), "192.168.1.1:9090".into()).await;
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "unknown peer should return NotFound error"
    );
}
