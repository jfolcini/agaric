use super::super::*;
use super::common::*;
use agaric_store::peer_refs;
use agaric_sync::sync_scheduler::SyncScheduler;
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
    let device_id = agaric_sync::device::DeviceId::new("test-device-uuid-1234".to_string());

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

    // PairingInfo no longer carries host/port — mDNS owns
    // discovery + address resolution end-to-end. Asserted here as a
    // compile-time + structural check via the new test below.

    // Session should be stored in state
    let session = pairing_state.lock().unwrap();
    assert!(session.is_some(), "pairing session must be stored in state");
}

/// Parse the QR JSON embedded in the pairing flow and assert the
/// payload shape is exactly `{"v": 1, "passphrase": "..."}` — no `host`
/// and no `port`. Locks down the wire format on the orchestration side
/// (the unit-level encoder/parser test lives in `pairing.rs`).
#[test]
fn start_pairing_qr_payload_carries_only_passphrase_m34() {
    let pairing_state = Mutex::new(None);
    let info =
        start_pairing_inner(&pairing_state, "device-A").expect("start_pairing_inner must succeed");

    // Re-derive the exact JSON the QR encodes (the SVG is opaque
    // bytes, but `pairing_qr_payload` is what was rendered).
    let payload = agaric_sync::pairing::pairing_qr_payload(&info.passphrase);
    let parsed: serde_json::Value =
        serde_json::from_str(&payload).expect("QR payload must be valid JSON");
    let object = parsed
        .as_object()
        .expect("QR payload must be a JSON object");

    // Exact-count assertion: only `v` (schema version) and `passphrase`.
    assert_eq!(
        object.len(),
        2,
        "QR payload must contain exactly two keys (v, passphrase), got: {:?}",
        object.keys().collect::<Vec<_>>()
    );
    assert_eq!(
        object.get("passphrase").and_then(|v| v.as_str()),
        Some(info.passphrase.as_str()),
        "'passphrase' field must round-trip"
    );
    assert!(
        !object.contains_key("host"),
        "QR payload must not contain 'host' — mDNS owns discovery"
    );
    assert!(
        !object.contains_key("port"),
        "QR payload must not contain 'port' — mDNS owns address resolution"
    );
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
// Sync — confirm_pairing (#275, #3463)
// ======================================================================
//
// #3463: pairing is asymmetric. The HOST calls `start_pairing_armed_inner`,
// which mints a passphrase and arms this device's pending-pairing marker with
// its proof. The JOINER types that same passphrase into
// `confirm_pairing_inner`, which arms the joiner's marker with the proof of
// what was TYPED. Both devices then hold a marker for the SAME passphrase —
// exactly the precondition the wire-side #855 gate enforces:
// `sync_daemon::server` admits an unpaired peer during the pairing window only
// if the `pairing_proof` it offers constant-time-matches the responder's own
// marker, and `session_state_machine::start` sources that offered proof from
// the initiator's own marker.
//
// Every test below therefore models TWO devices — two `pairing_state` slots and
// two pools. Feeding a session's own passphrase back into
// `confirm_pairing_inner` on the same slot (what these tests used to do) is not
// a pairing; it is a device confirming itself, and it stays green no matter how
// broken the real two-device flow is. That is precisely why #3463 shipped.

/// Passphrase + proof of a device acting as pairing HOST.
///
/// Uses `start_pairing_armed_inner` (what the `start_pairing` command calls),
/// so the host's own marker is armed — without it the joiner's first connection
/// is rejected as "peer not paired".
async fn host_offers_pairing(
    pool: &SqlitePool,
    pairing_state: &Mutex<Option<agaric_sync::pairing::PairingSession>>,
    scheduler: &SyncScheduler,
    device_id: &str,
) -> String {
    start_pairing_armed_inner(pool, pairing_state, scheduler, device_id)
        .await
        .expect("host start_pairing must succeed")
        .passphrase
}

// ----------------------------------------------------------------------
// #3463 falsification pair
// ----------------------------------------------------------------------
//
// (a) below MUST fail on a tree where `confirm_pairing_inner` still compares
//     the typed passphrase against the local slot: device B's slot holds
//     B's own random passphrase, so confirming with A's returns
//     `pairing.passphrase.mismatch` and B never arms its marker.
// (b) is its opposite and MUST stay green either way for (a) to mean anything —
//     it pins that the proofs are derived from the passphrase rather than
//     being some constant both devices trivially agree on.

/// (a) #3463: two devices, each with its own pairing state and its own DB, must
/// converge on the SAME pending-pairing proof when B confirms with A's
/// passphrase — including the realistic case where B's pairing dialog already
/// minted a competing passphrase of its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_pairing_two_devices_converge_on_same_proof_3463() {
    // Device A — the host.
    let (pool_a, _dir_a) = test_pool().await;
    let state_a = Mutex::new(None);
    let sched_a = SyncScheduler::new();
    let passphrase_a = host_offers_pairing(&pool_a, &state_a, &sched_a, "device-A").await;

    // Device B — the joiner. Its dialog unconditionally starts a session too,
    // so B holds a *different* passphrase. This is the real-world state and the
    // exact reason the old local comparison could never succeed.
    let (pool_b, _dir_b) = test_pool().await;
    let state_b = Mutex::new(None);
    let sched_b = SyncScheduler::new();
    let passphrase_b = host_offers_pairing(&pool_b, &state_b, &sched_b, "device-B").await;
    assert_ne!(
        passphrase_a, passphrase_b,
        "precondition: the two devices must hold independently-random passphrases"
    );

    // B's user types the passphrase shown on A.
    confirm_pairing_inner(
        &pool_b,
        &state_b,
        &sched_b,
        "device-B",
        passphrase_a.clone(),
        String::new(),
    )
    .await
    .expect("#3463: the joiner must accept the HOST's passphrase");

    let proof_a = peer_refs::get_pending_pairing_proof(&pool_a)
        .await
        .unwrap()
        .expect("host must hold a pending-pairing marker after start_pairing");
    let proof_b = peer_refs::get_pending_pairing_proof(&pool_b)
        .await
        .unwrap()
        .expect("joiner must hold a pending-pairing marker after confirm");

    assert_eq!(
        proof_a, proof_b,
        "#3463: both devices must end up holding the SAME pairing proof — this is \
         the precondition of the wire-side #855 gate, and without it no first \
         connection can ever be admitted"
    );
    assert_eq!(
        proof_a,
        agaric_sync::pairing::pairing_proof(&passphrase_a),
        "the shared proof must be the proof of the HOST's passphrase"
    );

    // B is a joiner now, not a host: its competing offer is withdrawn.
    assert!(
        state_b.lock().unwrap().is_none(),
        "confirming makes this device a joiner; its own offer session must be cleared"
    );
    // Neither side writes a peer_ref at confirm time (#855) — TOFU does, on the
    // first proof-verified connection.
    assert!(
        peer_refs::list_peer_refs(&pool_b).await.unwrap().is_empty(),
        "confirm must not create a peer_ref row directly (#855)"
    );
}

/// (b) #3463, the opposite: a passphrase neither device ever generated must NOT
/// produce matching proofs. Confirm still succeeds locally — arming a marker is
/// a local act with no remote knowledge to validate against — but the marker it
/// arms disagrees with the host's, so the wire-side gate rejects the peer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_pairing_foreign_passphrase_yields_no_matching_proof_3463() {
    let (pool_a, _dir_a) = test_pool().await;
    let state_a = Mutex::new(None);
    let sched_a = SyncScheduler::new();
    let passphrase_a = host_offers_pairing(&pool_a, &state_a, &sched_a, "device-A").await;

    let (pool_b, _dir_b) = test_pool().await;
    let state_b = Mutex::new(None);
    let sched_b = SyncScheduler::new();
    let passphrase_b = host_offers_pairing(&pool_b, &state_b, &sched_b, "device-B").await;

    // A typo / a guess: four words that neither device minted.
    let typed = "correct horse battery staple";
    assert_ne!(typed, passphrase_a);
    assert_ne!(typed, passphrase_b);

    confirm_pairing_inner(
        &pool_b,
        &state_b,
        &sched_b,
        "device-B",
        typed.into(),
        String::new(),
    )
    .await
    .expect("arming a local marker is a local act and cannot fail on content");

    let proof_a = peer_refs::get_pending_pairing_proof(&pool_a)
        .await
        .unwrap()
        .unwrap();
    let proof_b = peer_refs::get_pending_pairing_proof(&pool_b)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        proof_a, proof_b,
        "a passphrase neither device generated must NOT produce matching proofs — \
         otherwise the #855 gate would admit anyone"
    );

    // And the degenerate self-confirm is equally useless: B confirming with its
    // OWN passphrase still disagrees with A.
    confirm_pairing_inner(
        &pool_b,
        &state_b,
        &sched_b,
        "device-B",
        passphrase_b.clone(),
        String::new(),
    )
    .await
    .expect_err("the slot was consumed by the previous confirm");
    assert_ne!(
        proof_a,
        agaric_sync::pairing::pairing_proof(&passphrase_b),
        "a device's own passphrase can never match the host's proof"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_confirm_pairing_sets_pending_marker_with_proof_and_clears_session() {
    // Two devices: the joiner types the HOST's passphrase.
    let (pool_host, _dir_host) = test_pool().await;
    let state_host = Mutex::new(None);
    let sched_host = SyncScheduler::new();
    let host_passphrase =
        host_offers_pairing(&pool_host, &state_host, &sched_host, "device-host").await;

    let (pool, _dir) = test_pool().await;
    let pairing_state = Mutex::new(None);
    let scheduler = SyncScheduler::new();
    start_pairing_inner(&pairing_state, "device-local").unwrap();

    // A non-empty remote id, exercising the path that pre-#855 took the
    // now-deleted peer_ref else-branch.
    confirm_pairing_inner(
        &pool,
        &pairing_state,
        &scheduler,
        "device-local",
        host_passphrase.clone(),
        "device-remote".into(),
    )
    .await
    .unwrap();

    // #855: confirm no longer writes a peer_ref directly (the CN-spoof-prone
    // NULL-cert row is gone). It sets the pending-pairing marker carrying the
    // passphrase proof; the peer_ref is established by proof-verified TOFU on
    // the first connection.
    assert!(
        peer_refs::list_peer_refs(&pool).await.unwrap().is_empty(),
        "confirm must not create a peer_ref row directly (#855)"
    );
    assert_eq!(
        peer_refs::get_pending_pairing_proof(&pool)
            .await
            .unwrap()
            .as_deref(),
        Some(agaric_sync::pairing::pairing_proof(&host_passphrase).as_str()),
        "the pending marker stores the proof of the TYPED passphrase for the \
         responder gate (#855, #3463)"
    );

    // Pairing session should be cleared
    let session = pairing_state.lock().unwrap();
    assert!(
        session.is_none(),
        "pairing session must be cleared after confirm"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_pairing_empty_remote_id_sets_pending_marker_not_peer() {
    // Production FE passes an empty remote_device_id (it doesn't
    // know the peer's id at confirm time — mDNS + TOFU establish it later). That
    // must set the pending-pairing marker (so the dormant daemon wakes to accept
    // the first connection) and NOT write a junk empty-string peer_refs row.
    let (pool_host, _dir_host) = test_pool().await;
    let state_host = Mutex::new(None);
    let sched_host = SyncScheduler::new();
    let host_passphrase =
        host_offers_pairing(&pool_host, &state_host, &sched_host, "device-host").await;

    let (pool, _dir) = test_pool().await;
    let pairing_state = Mutex::new(None);
    let scheduler = SyncScheduler::new();

    start_pairing_inner(&pairing_state, "device-local").unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing_state,
        &scheduler,
        "device-local",
        host_passphrase,
        String::new(),
    )
    .await
    .unwrap();

    assert!(
        peer_refs::list_peer_refs(&pool).await.unwrap().is_empty(),
        "an empty remote id must not create a peer_refs row"
    );
    assert!(
        peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "an empty remote id must set the pending-pairing marker"
    );
}

/// #3463 (replaces the #1603 attempt-cap tests): a mistyped passphrase must be
/// correctable by simply typing it again.
///
/// `MAX_PASSPHRASE_ATTEMPTS` / `pairing.attempts_exhausted` bounded repeated
/// guesses against the *local* slot. With the local comparison gone there is no
/// local guess to count, so the cap was removed rather than left as unreachable
/// code that reads like a security control. What replaces it is (i) the marker's
/// `PAIRING_TIMEOUT` TTL, and (ii) the fact that a wrong passphrase simply
/// arms a proof the host will not accept. This test pins the user-visible
/// consequence: retrying is not rationed, and the last value typed wins.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_pairing_retry_after_typo_is_not_rationed_3463() {
    let (pool_host, _dir_host) = test_pool().await;
    let state_host = Mutex::new(None);
    let sched_host = SyncScheduler::new();
    let host_passphrase =
        host_offers_pairing(&pool_host, &state_host, &sched_host, "device-host").await;

    let (pool, _dir) = test_pool().await;
    let pairing_state = Mutex::new(None);
    let scheduler = SyncScheduler::new();

    // Six typos — one more than the retired cap of 5 — each re-opening the
    // dialog (which is what re-arms the slot in production).
    for attempt in 0..6 {
        start_pairing_inner(&pairing_state, "device-local").unwrap();
        confirm_pairing_inner(
            &pool,
            &pairing_state,
            &scheduler,
            "device-local",
            format!("wrong wrong wrong {attempt}"),
            String::new(),
        )
        .await
        .unwrap_or_else(|e| panic!("typo {attempt} must not be rationed, got {e:?}"));
    }

    // Now the correct passphrase, well past the retired budget.
    start_pairing_inner(&pairing_state, "device-local").unwrap();
    confirm_pairing_inner(
        &pool,
        &pairing_state,
        &scheduler,
        "device-local",
        host_passphrase.clone(),
        String::new(),
    )
    .await
    .expect("the correct passphrase must succeed however many typos preceded it");

    assert_eq!(
        peer_refs::get_pending_pairing_proof(&pool)
            .await
            .unwrap()
            .as_deref(),
        Some(agaric_sync::pairing::pairing_proof(&host_passphrase).as_str()),
        "the last confirm wins: the marker must hold the correct proof"
    );
    assert!(
        peer_refs::get_peer_ref(&pool, "device-remote")
            .await
            .unwrap()
            .is_none(),
        "confirm must not persist a peer_ref directly (#855)"
    );
    assert!(
        pairing_state.lock().unwrap().is_none(),
        "slot must be cleared on success"
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
        matches!(result, Err(AppError::Validation { message: ref msg, .. }) if msg == "pairing.no_active_session"),
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
    // Regression: `start_sync_inner` used to call
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
fn sync_cancel_sync_sets_flag_while_session_active() {
    let flag = AtomicBool::new(false);
    let scheduler = SyncScheduler::new();
    // #2537: the cancel only latches while a session is live.
    let _activity = scheduler.begin_session_activity();
    let result = cancel_sync_inner(&flag, &scheduler);
    assert!(result.is_ok(), "cancel_sync must succeed");
    assert!(
        flag.load(Ordering::Acquire),
        "cancel flag must be set after cancel_sync while a session is active"
    );
}

/// #2537: with NO live session there is nothing to cancel — and, crucially,
/// nothing that would ever reset the flag. `cancel_sync` must be a no-op so
/// the flag cannot latch and instantly fail every future inbound session.
#[test]
fn sync_cancel_sync_is_noop_without_active_session() {
    let flag = AtomicBool::new(false);
    let scheduler = SyncScheduler::new();
    let result = cancel_sync_inner(&flag, &scheduler);
    assert!(
        result.is_ok(),
        "cancel_sync must still succeed (idempotent no-op)"
    );
    assert!(
        !flag.load(Ordering::Acquire),
        "#2537: cancel with no active session must NOT latch the shared flag"
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
        matches!(result, Err(AppError::Validation { .. })),
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
