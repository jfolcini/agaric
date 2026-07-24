use super::common::*;
use agaric_store::peer_refs;
use agaric_sync::sync_scheduler::SyncScheduler;
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
    // #109 Phase 2: synced_at is now epoch-ms (INTEGER), not an RFC 3339 string.
    sqlx::query!(
        "UPDATE peer_refs SET synced_at = ? WHERE peer_id = ?",
        1_735_689_600_000_i64, // 2025-01-01T00:00:00Z
        "PEER_A"
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query!(
        "UPDATE peer_refs SET synced_at = ? WHERE peer_id = ?",
        1_735_776_000_000_i64, // 2025-01-02T00:00:00Z
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
async fn pairing_lifecycle_arms_pending_window_with_proof() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();
    let device_id = "dev-local";

    // Start pairing
    let info = start_pairing_inner(&pairing.0, device_id).unwrap();
    assert!(!info.passphrase.is_empty(), "passphrase must be non-empty");

    // Confirm pairing with remote device
    let passphrase = info.passphrase.clone();
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

    // #855: confirm arms the pending-pairing window with the passphrase proof
    // rather than persisting a peer_ref directly — the peer_ref is established by
    // proof-verified TOFU on the first connection (removing the CN-spoof-prone
    // NULL-cert row the old else-branch created).
    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert!(
        peers.is_empty(),
        "confirm must not create a peer_ref directly (#855); TOFU does it on connect"
    );
    assert_eq!(
        peer_refs::get_pending_pairing_proof(&pool)
            .await
            .unwrap()
            .as_deref(),
        Some(agaric_sync::pairing::pairing_proof(&passphrase).as_str()),
        "the pending marker carries the passphrase proof for the responder gate (#855)"
    );

    // Verify pairing session was cleared
    assert!(
        pairing.0.lock().unwrap().is_none(),
        "pairing session must be cleared after confirm"
    );
}

/// #2008: the host side (`start_pairing`) must also arm the pairing window
/// — set the pending-pairing marker so its dormant daemon goes active and
/// announces/listens — otherwise the joiner can never reach it. The marker
/// must be set even though no `peer_ref` exists yet (TOFU writes that on the
/// first connection).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_pairing_armed_inner_arms_pending_window() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();

    assert!(
        !peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "no pending marker before pairing starts"
    );

    let info =
        crate::commands::start_pairing_armed_inner(&pool, &pairing.0, &scheduler, "dev-host")
            .await
            .unwrap();
    assert!(!info.passphrase.is_empty(), "passphrase must be non-empty");

    assert!(
        peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "start_pairing must arm the pending-pairing window so the host daemon \
         activates (#2008)"
    );
    assert!(
        peer_refs::list_peer_refs(&pool).await.unwrap().is_empty(),
        "no peer_ref yet — it is written by TOFU on the first connection"
    );
    assert!(
        pairing.0.lock().unwrap().is_some(),
        "pairing session must be live after start"
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

/// H-1 regression: `confirm_pairing_inner` must refuse to persist a peer
/// when no pairing session is active. Before H-1 the function happily
/// created a peer ref for any string and any caller; the post-H-1
/// contract is that the joining device must produce the passphrase
/// that was generated on the host side, which requires an active
/// `pairing_state` slot to compare against.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_without_prior_start_returns_no_active_session() {
    let (pool, _dir) = test_pool().await;
    let pairing = PairingState(Mutex::new(None));
    let scheduler = SyncScheduler::new();

    let result = confirm_pairing_inner(
        &pool,
        &pairing.0,
        &scheduler,
        "dev-1",
        "some random phrase".into(),
        "dev-remote".into(),
    )
    .await;

    assert!(
        matches!(&result, Err(AppError::Validation { message: msg, .. }) if msg == "pairing.no_active_session"),
        "confirm without prior start must surface as Validation(\"pairing.no_active_session\"), got {result:?}"
    );

    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert!(
        peers.is_empty(),
        "no peer_ref must be created when no pairing is in flight"
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

    // #855: confirm arms the pending-pairing window (proof stored) rather than
    // persisting a peer_ref; the peer_ref is established by proof-verified TOFU
    // on the first real connection (not exercised by this stubbed sync helper).
    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert!(
        peers.is_empty(),
        "confirm must not persist a peer_ref directly (#855)"
    );
    assert!(
        peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "the pending-pairing window must be armed after confirm"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_sync_succeeds() {
    let flag = std::sync::atomic::AtomicBool::new(false);
    let scheduler = SyncScheduler::new();

    // #2537: with no live session the cancel is a no-op (nothing would ever
    // reset the flag) — it must still succeed but NOT latch the flag.
    let result = cancel_sync_inner(&flag, &scheduler);
    assert!(result.is_ok(), "cancel_sync should always succeed");
    assert!(
        !flag.load(std::sync::atomic::Ordering::Acquire),
        "#2537: cancel with no active session must not latch the flag"
    );

    // With a live session, the cancel latches.
    let _activity = scheduler.begin_session_activity();
    let result = cancel_sync_inner(&flag, &scheduler);
    assert!(result.is_ok(), "cancel_sync should always succeed");
    assert!(
        flag.load(std::sync::atomic::Ordering::Acquire),
        "cancel flag must be set after cancel_sync while a session is active"
    );
}

/// Multi-device peer_refs. #855 moved peer_ref creation off `confirm_pairing`
/// (the deleted NULL-`cert_hash` else-branch) onto proof-verified TOFU on the
/// first connection — so pinning two devices (as the responder does after each
/// proves its passphrase) yields two separate peer_refs, each with its own cert.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tofu_pins_multiple_devices_as_separate_peer_refs() {
    let (pool, _dir) = test_pool().await;

    peer_refs::upsert_peer_ref_with_cert(&pool, "dev-phone", &"a".repeat(64))
        .await
        .unwrap();
    peer_refs::upsert_peer_ref_with_cert(&pool, "dev-tablet", &"b".repeat(64))
        .await
        .unwrap();

    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(
        peers.len(),
        2,
        "TOFU-pinning two devices yields two separate peer_refs"
    );
    let ids: Vec<&str> = peers.iter().map(|p| p.peer_id.as_str()).collect();
    assert!(ids.contains(&"dev-phone"), "phone peer should exist");
    assert!(ids.contains(&"dev-tablet"), "tablet peer should exist");
}

/// Re-pairing the same device upserts (does not duplicate) its peer_ref and
/// updates the pinned cert. #855: this is the TOFU path
/// (`upsert_peer_ref_with_cert`), the responder's action after a re-pair's
/// passphrase proof — not `confirm_pairing`, which now only arms the window.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tofu_re_pin_same_device_upserts_peer_ref() {
    let (pool, _dir) = test_pool().await;

    peer_refs::upsert_peer_ref_with_cert(&pool, "dev-remote", &"a".repeat(64))
        .await
        .unwrap();
    // Re-pair → new cert observed for the same device id.
    peer_refs::upsert_peer_ref_with_cert(&pool, "dev-remote", &"b".repeat(64))
        .await
        .unwrap();

    let peers = crate::commands::list_peer_refs_inner(&pool).await.unwrap();
    assert_eq!(
        peers.len(),
        1,
        "re-pairing the same device upserts, not duplicates"
    );
    assert_eq!(
        peers[0].cert_hash.as_deref(),
        Some("b".repeat(64).as_str()),
        "the pinned cert is updated on re-pair"
    );
}
