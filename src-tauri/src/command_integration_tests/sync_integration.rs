use super::common::*;
use crate::peer_refs;
use crate::sync_scheduler::SyncScheduler;
use std::sync::Mutex;

// ======================================================================
// list_peer_refs / update_peer_name / delete_peer_ref — wiring tests (#455)
// ======================================================================

#[tokio::test]
async fn list_peer_refs_returns_empty_when_no_peers() {
    let (pool, _dir) = test_pool().await;
    let result = list_peer_refs_inner(&pool).await.unwrap();
    assert!(result.is_empty(), "no peers should exist in fresh DB");
}

#[tokio::test]
async fn list_peer_refs_returns_peers_ordered_by_synced_at() {
    let (pool, _dir) = test_pool().await;

    peer_refs::upsert_peer_ref(&pool, "PEER_A").await.unwrap();
    peer_refs::upsert_peer_ref(&pool, "PEER_B").await.unwrap();

    // PEER_A synced earlier, PEER_B synced later → PEER_B should appear first.
    sqlx::query!(
        "UPDATE peer_refs SET synced_at = ? WHERE peer_id = ?",
        "2025-01-01T00:00:00Z",
        "PEER_A"
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query!(
        "UPDATE peer_refs SET synced_at = ? WHERE peer_id = ?",
        "2025-01-02T00:00:00Z",
        "PEER_B"
    )
    .execute(&pool)
    .await
    .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();

    assert_eq!(peers.len(), 2, "both peers should be returned");
    assert_eq!(
        peers[0].peer_id, "PEER_B",
        "most recently synced peer should be first"
    );
    assert_eq!(
        peers[1].peer_id, "PEER_A",
        "earlier synced peer should be second"
    );
}

#[tokio::test]
async fn update_peer_name_sets_and_clears_name() {
    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_X").await.unwrap();

    // Set a device name.
    update_peer_name_inner(&pool, "PEER_X".into(), Some("My Phone".into()))
        .await
        .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1, "one peer should exist");
    assert_eq!(
        peers[0].device_name.as_deref(),
        Some("My Phone"),
        "device_name should be set to 'My Phone'"
    );

    // Clear the device name.
    update_peer_name_inner(&pool, "PEER_X".into(), None)
        .await
        .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(
        peers[0].device_name, None,
        "device_name should be cleared to None"
    );
}

#[tokio::test]
async fn update_peer_name_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let err = update_peer_name_inner(&pool, "NO_SUCH_PEER".into(), Some("Name".into()))
        .await
        .unwrap_err();

    assert!(
        matches!(err, AppError::NotFound(_)),
        "expected NotFound for nonexistent peer, got {err:?}"
    );
}

#[tokio::test]
async fn delete_peer_ref_removes_peer() {
    let (pool, _dir) = test_pool().await;

    peer_refs::upsert_peer_ref(&pool, "PEER_KEEP")
        .await
        .unwrap();
    peer_refs::upsert_peer_ref(&pool, "PEER_DEL").await.unwrap();

    delete_peer_ref_inner(&pool, "PEER_DEL".into())
        .await
        .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1, "only one peer should remain after delete");
    assert_eq!(
        peers[0].peer_id, "PEER_KEEP",
        "the surviving peer should be PEER_KEEP"
    );
}

#[tokio::test]
async fn delete_peer_ref_nonexistent_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    let err = delete_peer_ref_inner(&pool, "GHOST_PEER".into())
        .await
        .unwrap_err();

    assert!(
        matches!(err, AppError::NotFound(_)),
        "expected NotFound for nonexistent peer, got {err:?}"
    );
}

#[tokio::test]
async fn update_peer_name_special_characters() {
    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_UNI").await.unwrap();

    let fancy_name = "Javier's 📱 Phone";
    update_peer_name_inner(&pool, "PEER_UNI".into(), Some(fancy_name.into()))
        .await
        .unwrap();

    let peers = list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1, "one peer should exist");
    assert_eq!(
        peers[0].device_name.as_deref(),
        Some(fancy_name),
        "unicode/special-char device name should roundtrip correctly"
    );
}

// =========================================================================
// Sync command integration tests — pairing + sync workflows
// =========================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pairing_lifecycle_creates_peer_ref() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();
    let device_id = "dev-local";

    // Start pairing
    let info = start_pairing_inner(&pairing.0, device_id).unwrap();
    assert!(!info.passphrase.is_empty(), "passphrase must be non-empty");

    // Confirm pairing with remote device
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        &scheduler,
        device_id,
        info.passphrase.clone(),
        "dev-remote".into(),
    )
    .await
    .unwrap();

    // Verify peer_ref was created
    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1, "one peer_ref should exist after confirm");
    assert_eq!(
        peers[0].peer_id, "dev-remote",
        "peer_id should be the remote device"
    );

    // Verify pairing session was cleared
    assert!(
        pairing.0.lock().unwrap().is_none(),
        "pairing session must be cleared after confirm"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pairing_start_then_cancel_clears_session() {
    let pairing = PairingState(Mutex::new(None));

    let _info = start_pairing_inner(&pairing.0, "dev-1").unwrap();
    assert!(
        pairing.0.lock().unwrap().is_some(),
        "session must exist after start"
    );

    cancel_pairing_inner(&pairing.0).unwrap();
    assert!(
        pairing.0.lock().unwrap().is_none(),
        "session must be cleared after cancel"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_without_prior_start_still_creates_peer() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();

    // Confirm without starting — confirm_pairing_inner doesn't validate against
    // a stored session; it creates a new one from the passphrase directly.
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        &scheduler,
        "dev-1",
        "some random phrase".into(),
        "dev-remote".into(),
    )
    .await
    .unwrap();

    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(
        peers.len(),
        1,
        "peer_ref should be created on confirm regardless of prior start"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_sync_returns_complete_info() {
    let scheduler = SyncScheduler::new();

    let info = start_sync_inner(&scheduler, "dev-local", "dev-remote".into()).unwrap();
    assert_eq!(info.state, "complete", "sync state should be complete");
    assert_eq!(info.local_device_id, "dev-local");
    assert_eq!(info.remote_device_id, "dev-remote");
    assert_eq!(info.ops_received, 0);
    assert_eq!(info.ops_sent, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_sync_rejects_peer_in_backoff() {
    let scheduler = SyncScheduler::new();

    // Record a failure to trigger backoff
    scheduler.record_failure("dev-remote");

    let result = start_sync_inner(&scheduler, "dev-local", "dev-remote".into());
    assert!(
        result.is_err(),
        "sync should be rejected when peer is in backoff"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("backoff"),
        "error should mention backoff"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_pair_then_sync_workflow() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();

    // Pair
    let info = start_pairing_inner(&pairing.0, "dev-local").unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        &scheduler,
        "dev-local",
        info.passphrase,
        "dev-remote".into(),
    )
    .await
    .unwrap();

    // Sync
    let sync_info = start_sync_inner(&scheduler, "dev-local", "dev-remote".into()).unwrap();
    assert_eq!(sync_info.state, "complete");

    // Verify peer_ref persists
    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_sync_succeeds() {
    let flag = std::sync::atomic::AtomicBool::new(false);
    let result = cancel_sync_inner(&flag);
    assert!(result.is_ok(), "cancel_sync should always succeed");
    assert!(
        flag.load(std::sync::atomic::Ordering::Acquire),
        "cancel flag must be set after cancel_sync"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pair_multiple_devices_creates_separate_peer_refs() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();
    let device_id = "dev-local";

    // Pair with first device
    let info1 = start_pairing_inner(&pairing.0, device_id).unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        &scheduler,
        device_id,
        info1.passphrase,
        "dev-phone".into(),
    )
    .await
    .unwrap();

    // Pair with second device
    let info2 = start_pairing_inner(&pairing.0, device_id).unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        &scheduler,
        device_id,
        info2.passphrase,
        "dev-tablet".into(),
    )
    .await
    .unwrap();

    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(peers.len(), 2, "two separate peer_refs should exist");

    let ids: Vec<&str> = peers.iter().map(|p| p.peer_id.as_str()).collect();
    assert!(ids.contains(&"dev-phone"), "phone peer should exist");
    assert!(ids.contains(&"dev-tablet"), "tablet peer should exist");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_pairing_same_device_upserts_peer_ref() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();
    let device_id = "dev-local";

    // Pair with device
    let info1 = start_pairing_inner(&pairing.0, device_id).unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        &scheduler,
        device_id,
        info1.passphrase,
        "dev-remote".into(),
    )
    .await
    .unwrap();

    // Re-pair with same device
    let info2 = start_pairing_inner(&pairing.0, device_id).unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing.0,
        &scheduler,
        device_id,
        info2.passphrase,
        "dev-remote".into(),
    )
    .await
    .unwrap();

    // Should still be 1 peer_ref (upsert, not duplicate)
    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(
        peers.len(),
        1,
        "re-pairing same device should upsert, not create duplicate"
    );
}
