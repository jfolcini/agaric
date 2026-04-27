use super::*;
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::peer_refs::{self, PeerRef};
use crate::sync_events::RecordingEventSink;
use crate::sync_net::{self, SyncConnection, SyncServer};
use crate::sync_protocol::{DeviceHead, SyncMessage, SyncOrchestrator};
use crate::sync_scheduler::SyncScheduler;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tempfile::TempDir;

/// Create a fresh DB pool for daemon tests.
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Install the `ring` CryptoProvider for TLS tests (idempotent).
fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[test]
fn shared_event_sink_forwards_to_inner() {
    let inner = Arc::new(RecordingEventSink::new());
    let shared = SharedEventSink(inner.clone());
    shared.on_sync_event(SyncEvent::Progress {
        state: "testing".into(),
        remote_device_id: "PEER_A".into(),
        ops_received: 0,
        ops_sent: 0,
    });
    let events = inner.events();
    assert_eq!(
        events.len(),
        1,
        "SharedEventSink must forward exactly one event"
    );
    assert!(
        matches!(&events[0], SyncEvent::Progress { state, .. } if state == "testing"),
        "forwarded event must match the original"
    );
}

#[test]
fn shutdown_notifies_waiter() {
    let shutdown_notify = Arc::new(Notify::new());
    let daemon = SyncDaemon {
        shutdown_notify: shutdown_notify.clone(),
        cancel: Arc::new(AtomicBool::new(false)),
        handle: None,
    };
    daemon.shutdown();
    // A subsequent `notified()` future must complete immediately because
    // notify_one() stored a permit on the Notify.
    let permit_ready = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                shutdown_notify.notified(),
            )
            .await
            .is_ok()
        });
    assert!(
        permit_ready,
        "shutdown() must deliver a permit to the shutdown_notify"
    );
}

#[test]
fn cancel_active_sync_sets_flag() {
    let cancel = Arc::new(AtomicBool::new(false));
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        handle: None,
    };
    assert!(
        !cancel.load(Ordering::Acquire),
        "cancel flag must start false"
    );
    daemon.cancel_active_sync();
    assert!(
        cancel.load(Ordering::Acquire),
        "cancel_active_sync must set the flag"
    );
}

#[test]
fn shutdown_and_cancel_are_independent() {
    let cancel = Arc::new(AtomicBool::new(false));
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        handle: None,
    };
    daemon.shutdown();
    assert!(!cancel.load(Ordering::Acquire), "cancel must remain unset");

    daemon.cancel_active_sync();
    assert!(cancel.load(Ordering::Acquire), "cancel must now be set");
}

#[test]
fn cancel_flag_clear_after_session() {
    let cancel = Arc::new(AtomicBool::new(false));
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        handle: None,
    };
    daemon.cancel_active_sync();
    assert!(cancel.load(Ordering::Acquire), "cancel must be set");

    // Simulate what try_sync_with_peer does after the session ends
    cancel.store(false, Ordering::Release);
    assert!(!cancel.load(Ordering::Acquire), "cancel must be cleared");
}

#[test]
fn shared_event_sink_concurrent_emission() {
    let inner = Arc::new(RecordingEventSink::new());
    let shared = Arc::new(SharedEventSink(inner.clone()));
    let mut handles = vec![];

    for i in 0..4 {
        let s = shared.clone();
        handles.push(std::thread::spawn(move || {
            s.on_sync_event(SyncEvent::Progress {
                state: format!("thread-{i}"),
                remote_device_id: "PEER".into(),
                ops_received: 0,
                ops_sent: 0,
            });
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    assert_eq!(
        inner.events().len(),
        4,
        "all 4 concurrent events must be captured"
    );
}

#[test]
fn cancel_is_idempotent() {
    let cancel = Arc::new(AtomicBool::new(false));
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        handle: None,
    };
    daemon.cancel_active_sync();
    daemon.cancel_active_sync();
    daemon.cancel_active_sync();
    assert!(
        cancel.load(Ordering::Acquire),
        "flag must remain set after multiple calls"
    );
}

// ── B-3: batch draining test ────────────────────────────────────────

/// Verify the drain pattern works: a SyncOrchestrator with >1000 ops
/// returns one batch from handle_message() and the rest via
/// next_message(), with correct is_last flags.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drain_pending_batches_after_handle_message() {
    use crate::db::init_pool;
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use tempfile::TempDir;

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    let materializer = Materializer::new(pool.clone());

    // Insert 2500 ops on "responder-dev" to exceed OP_BATCH_SIZE (1000)
    for i in 1..=2500 {
        append_local_op_at(
            &pool,
            "responder-dev",
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id(&format!("BLK{i}")),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "test".into(),
            }),
            "2025-01-15T12:00:00+00:00".into(),
        )
        .await
        .unwrap();
    }

    // Responder-side orchestrator
    let mut orch = SyncOrchestrator::new(pool, "responder-dev".into(), materializer.clone());

    // Simulate initiator sending HeadExchange with no heads
    // → responder must send all 2500 ops
    let first_response = orch
        .handle_message(SyncMessage::HeadExchange { heads: vec![] })
        .await
        .unwrap();

    // First batch: 1000 ops, is_last = false
    let (batch1_ops, batch1_last) = match first_response {
        Some(SyncMessage::OpBatch { ops, is_last }) => (ops.len(), is_last),
        other => panic!("expected OpBatch from handle_message, got {other:?}"),
    };
    assert_eq!(batch1_ops, 1000, "first batch should have 1000 ops");
    assert!(!batch1_last, "first batch must NOT be is_last");

    // Drain remaining batches (this is the B-3 pattern)
    let mut total_ops = batch1_ops;
    let mut batch_count = 1;
    while let Some(batch) = orch.next_message() {
        match batch {
            SyncMessage::OpBatch { ops, is_last } => {
                total_ops += ops.len();
                batch_count += 1;
                if is_last {
                    assert!(
                        orch.next_message().is_none(),
                        "no more batches after is_last=true"
                    );
                    break;
                }
            }
            other => panic!("expected OpBatch from next_message, got {other:?}"),
        }
    }

    assert_eq!(total_ops, 2500, "all 2500 ops must be drained");
    assert_eq!(batch_count, 3, "2500 ops / 1000 batch size = 3 batches");
    assert_eq!(
        orch.session().ops_sent,
        2500,
        "session must track all sent ops"
    );

    materializer.shutdown();
}

// ── S-1: unpaired device rejection test ─────────────────────────────

/// Verify that get_peer_ref returns None for unknown devices (triggers
/// rejection) and Some for paired devices.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpaired_device_rejected_via_peer_ref_lookup() {
    use crate::db::init_pool;
    use tempfile::TempDir;

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();

    // No peer_refs entries → lookup should return None (unpaired)
    let result = peer_refs::get_peer_ref(&pool, "UNKNOWN_DEVICE_XYZ")
        .await
        .unwrap();
    assert!(
        result.is_none(),
        "unknown device must return None (would be rejected)"
    );

    // Insert a paired device
    peer_refs::upsert_peer_ref(&pool, "PAIRED_DEVICE_ABC")
        .await
        .unwrap();

    // Paired device → lookup should return Some
    let result = peer_refs::get_peer_ref(&pool, "PAIRED_DEVICE_ABC")
        .await
        .unwrap();
    assert!(
        result.is_some(),
        "paired device must return Some (would be accepted)"
    );
    assert_eq!(
        result.unwrap().peer_id,
        "PAIRED_DEVICE_ABC",
        "returned peer_id must match"
    );
}

// ── M-15: stale mDNS peer eviction test ────────────────────────────

#[test]
fn stale_mdns_peers_evicted() {
    use std::time::Duration;
    use tokio::time::Instant;

    let mut discovered: HashMap<String, (sync_net::DiscoveredPeer, Instant)> = HashMap::new();

    let fresh_peer = sync_net::DiscoveredPeer {
        device_id: "FRESH_PEER".into(),
        addresses: vec!["192.168.1.10".parse().unwrap()],
        port: 9000,
    };
    discovered.insert("FRESH_PEER".into(), (fresh_peer, Instant::now()));

    let stale_peer = sync_net::DiscoveredPeer {
        device_id: "STALE_PEER".into(),
        addresses: vec!["192.168.1.20".parse().unwrap()],
        port: 9001,
    };
    // 10 minutes ago — well past the 5-minute threshold
    discovered.insert(
        "STALE_PEER".into(),
        (stale_peer, Instant::now() - Duration::from_secs(600)),
    );

    assert_eq!(discovered.len(), 2, "should start with 2 peers");

    let stale_threshold = Instant::now() - Duration::from_secs(300);
    discovered.retain(|_, (_, last_seen)| *last_seen > stale_threshold);

    assert_eq!(discovered.len(), 1, "stale peer must be evicted");
    assert!(
        discovered.contains_key("FRESH_PEER"),
        "fresh peer must be retained"
    );
    assert!(
        !discovered.contains_key("STALE_PEER"),
        "stale peer must be removed"
    );
}

// ── B-33: responder rejects cert hash mismatch ─────────────────────

#[test]
fn b33_cert_hash_mismatch_rejected() {
    let result = verify_peer_cert(
        "device-A",
        Some("device-A"), // CN matches
        Some("aaaa"),     // observed hash
        Some("bbbb"),     // stored hash — MISMATCH
    );
    assert_eq!(
        result,
        CertVerifyResult::HashMismatch {
            remote_id: "device-A".into()
        },
        "B-33: mismatched cert hash must be rejected"
    );
}

#[test]
fn b33_cert_hash_match_accepted() {
    let result = verify_peer_cert(
        "device-A",
        Some("device-A"), // CN matches
        Some("aaaa"),     // observed hash
        Some("aaaa"),     // stored hash — MATCH
    );
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "B-33: matching cert hash must be accepted"
    );
}

#[test]
fn b33_no_stored_hash_accepted() {
    // No stored hash (not yet paired with cert) — skip hash check
    let result = verify_peer_cert(
        "device-A",
        Some("device-A"),
        Some("aaaa"),
        None, // no stored hash
    );
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "B-33: no stored hash means hash check is skipped"
    );
}

#[test]
fn b33_no_observed_hash_accepted() {
    // No observed hash (anonymous/pairing connection) — skip hash check
    let result = verify_peer_cert(
        "device-A",
        None,         // no cert CN (anonymous)
        None,         // no observed hash
        Some("aaaa"), // stored hash exists
    );
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "B-33: no observed hash means hash check is skipped"
    );
}

// ── B-34: responder rejects CN mismatch ────────────────────────────

#[test]
fn b34_cn_mismatch_rejected() {
    let result = verify_peer_cert(
        "device-A",
        Some("device-B"), // CN does NOT match claimed device_id
        Some("aaaa"),
        Some("aaaa"),
    );
    assert_eq!(
        result,
        CertVerifyResult::CnMismatch {
            remote_id: "device-A".into(),
            cert_cn: "device-B".into(),
        },
        "B-34: CN mismatch must be rejected"
    );
}

#[test]
fn b34_cn_match_accepted() {
    let result = verify_peer_cert(
        "device-A",
        Some("device-A"), // CN matches claimed device_id
        Some("aaaa"),
        Some("aaaa"),
    );
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "B-34: matching CN must be accepted"
    );
}

#[test]
fn b34_no_cert_cn_accepted() {
    // No client cert presented (anonymous/pairing) — skip CN check
    let result = verify_peer_cert(
        "device-A", None, // no cert CN
        None, None,
    );
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "B-34: no cert CN means CN check is skipped"
    );
}

// ── Happy path: both CN and hash match ─────────────────────────────

#[test]
fn happy_path_cn_and_hash_match() {
    let result = verify_peer_cert(
        "device-X",
        Some("device-X"), // CN matches
        Some("deadbeef"), // observed hash
        Some("deadbeef"), // stored hash matches
    );
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "happy path: matching CN + hash must be accepted"
    );
}

#[test]
fn b34_cn_checked_before_b33_hash() {
    // Both CN mismatch and hash mismatch — CN should be checked first
    let result = verify_peer_cert(
        "device-A",
        Some("device-B"), // CN mismatch
        Some("aaaa"),     // observed hash
        Some("bbbb"),     // stored hash mismatch
    );
    assert!(
        matches!(result, CertVerifyResult::CnMismatch { .. }),
        "B-34 CN check must run before B-33 hash check"
    );
}

// ======================================================================
// T-41 — Peer discovery filtering logic
// ======================================================================

/// Helper to build a minimal `PeerRef` for filter tests.
fn make_peer_ref(peer_id: &str) -> PeerRef {
    PeerRef {
        peer_id: peer_id.to_string(),
        last_hash: None,
        last_sent_hash: None,
        synced_at: None,
        reset_count: 0,
        last_reset_at: None,
        cert_hash: None,
        device_name: None,
        last_address: None,
    }
}

#[test]
fn should_attempt_sync_rejects_self_discovery() {
    let refs = vec![make_peer_ref("MY_DEVICE")];
    assert!(
        !should_attempt_sync_with_discovered_peer("MY_DEVICE", "MY_DEVICE", false, &refs),
        "must never attempt sync with self even if paired"
    );
}

#[test]
fn should_attempt_sync_rejects_already_discovered_peer() {
    let refs = vec![make_peer_ref("PEER_B")];
    assert!(
        !should_attempt_sync_with_discovered_peer("PEER_B", "MY_DEVICE", true, &refs),
        "must not re-trigger sync for a peer already in the discovered map"
    );
}

#[test]
fn should_attempt_sync_rejects_unpaired_peer() {
    // Peer refs list contains PEER_A but NOT PEER_C
    let refs = vec![make_peer_ref("PEER_A")];
    assert!(
        !should_attempt_sync_with_discovered_peer("PEER_C", "MY_DEVICE", false, &refs),
        "must not attempt sync with an unpaired peer"
    );
}

#[test]
fn should_attempt_sync_accepts_new_paired_peer() {
    let refs = vec![make_peer_ref("PEER_A"), make_peer_ref("PEER_B")];
    assert!(
        should_attempt_sync_with_discovered_peer("PEER_B", "MY_DEVICE", false, &refs),
        "must trigger sync for a newly discovered, paired peer"
    );
}

// ======================================================================
// T-41 — Fallback peer construction
// ======================================================================

#[test]
fn build_fallback_peer_parses_valid_ipv4_socket_addr() {
    let peer = build_fallback_peer("DEV_A", "192.168.1.42:9443");
    assert!(peer.is_some(), "valid IPv4 socket addr must parse");
    let peer = peer.unwrap();
    assert_eq!(peer.device_id, "DEV_A", "device_id must match input");
    assert_eq!(peer.port, 9443, "port must be extracted from socket addr");
    assert_eq!(peer.addresses.len(), 1, "must contain exactly one address");
    assert_eq!(
        peer.addresses[0].to_string(),
        "192.168.1.42",
        "IP must match"
    );
}

#[test]
fn build_fallback_peer_parses_valid_ipv6_socket_addr() {
    let peer = build_fallback_peer("DEV_B", "[::1]:8080");
    assert!(peer.is_some(), "valid IPv6 socket addr must parse");
    let peer = peer.unwrap();
    assert_eq!(peer.device_id, "DEV_B", "device_id must match input");
    assert_eq!(peer.port, 8080, "port must be extracted from socket addr");
    assert!(peer.addresses[0].is_loopback(), "::1 must be loopback");
}

#[test]
fn build_fallback_peer_returns_none_for_invalid_address() {
    assert!(
        build_fallback_peer("DEV_X", "not-an-address").is_none(),
        "garbage input must return None"
    );
    assert!(
        build_fallback_peer("DEV_X", "192.168.1.1").is_none(),
        "IP without port must return None (not a SocketAddr)"
    );
    assert!(
        build_fallback_peer("DEV_X", "").is_none(),
        "empty string must return None"
    );
}

#[test]
fn build_fallback_peer_parses_ipv6_link_local_with_scope_id() {
    // Bracketed form — the canonical IPv6+port syntax with a scope ID.
    let peer = build_fallback_peer("DEV_LINK_LOCAL", "[fe80::1%eth0]:8080");
    assert!(
        peer.is_some(),
        "bracketed IPv6 with scope ID (%eth0) must parse; got None"
    );
    let peer = peer.unwrap();
    assert_eq!(
        peer.device_id, "DEV_LINK_LOCAL",
        "device_id must match input"
    );
    assert_eq!(peer.port, 8080, "port must be extracted after the bracket");
    assert_eq!(peer.addresses.len(), 1, "must contain exactly one address");
    assert_eq!(
        peer.addresses[0].to_string(),
        "fe80::1",
        "scope ID must be stripped from the stored IpAddr"
    );
}

#[test]
fn build_fallback_peer_parses_unbracketed_ipv6_with_scope_id() {
    // Some sources (legacy configs, user entry) omit the brackets even
    // though the result is ambiguous without them. Best-effort parse:
    // everything before '%' is the IPv6 literal, ':' after the scope is
    // the port boundary.
    let peer = build_fallback_peer("DEV_LINK_LOCAL_2", "fe80::1%eth0:8080");
    assert!(
        peer.is_some(),
        "un-bracketed IPv6 with scope ID must still parse; got None"
    );
    let peer = peer.unwrap();
    assert_eq!(peer.port, 8080, "port must be extracted from tail");
    assert_eq!(
        peer.addresses[0].to_string(),
        "fe80::1",
        "scope ID must be stripped"
    );
}

#[test]
fn build_fallback_peer_handles_numeric_scope_id() {
    // Numeric scope IDs are valid on some platforms (e.g. Windows).
    let peer = build_fallback_peer("DEV_NUM_SCOPE", "[fe80::1%2]:8080");
    assert!(peer.is_some(), "numeric scope ID must also parse");
    assert_eq!(peer.unwrap().addresses[0].to_string(), "fe80::1");
}

// ======================================================================
// T-41 — Stale mDNS eviction edge cases
// ======================================================================

#[test]
fn stale_eviction_all_fresh_retains_all() {
    use std::time::Duration;
    use tokio::time::Instant;

    let mut discovered: HashMap<String, (sync_net::DiscoveredPeer, Instant)> = HashMap::new();
    for i in 0..5 {
        let peer = sync_net::DiscoveredPeer {
            device_id: format!("PEER_{i}"),
            addresses: vec!["10.0.0.1".parse().unwrap()],
            port: 9000 + i,
        };
        // All seen just now
        discovered.insert(format!("PEER_{i}"), (peer, Instant::now()));
    }

    let stale_threshold = Instant::now() - Duration::from_secs(300);
    discovered.retain(|_, (_, last_seen)| *last_seen > stale_threshold);

    assert_eq!(
        discovered.len(),
        5,
        "all fresh peers must be retained when none are stale"
    );
}

#[test]
fn stale_eviction_all_stale_removes_all() {
    use std::time::Duration;
    use tokio::time::Instant;

    let mut discovered: HashMap<String, (sync_net::DiscoveredPeer, Instant)> = HashMap::new();
    for i in 0..3 {
        let peer = sync_net::DiscoveredPeer {
            device_id: format!("OLD_{i}"),
            addresses: vec!["10.0.0.1".parse().unwrap()],
            port: 9000,
        };
        // All seen 10 minutes ago (well past 5-minute threshold)
        discovered.insert(
            format!("OLD_{i}"),
            (peer, Instant::now() - Duration::from_secs(600)),
        );
    }

    let stale_threshold = Instant::now() - Duration::from_secs(300);
    discovered.retain(|_, (_, last_seen)| *last_seen > stale_threshold);

    assert_eq!(discovered.len(), 0, "all stale peers must be evicted");
}

// ======================================================================
// T-41 — verify_peer_cert additional edge cases
// ======================================================================

#[test]
fn verify_peer_cert_empty_cn_string_is_mismatch() {
    // An empty-string CN should still be compared against the remote_id
    let result = verify_peer_cert(
        "device-A",
        Some(""), // CN is empty string — doesn't match "device-A"
        Some("aaaa"),
        Some("aaaa"),
    );
    assert_eq!(
        result,
        CertVerifyResult::CnMismatch {
            remote_id: "device-A".into(),
            cert_cn: "".into(),
        },
        "empty CN string must trigger CnMismatch"
    );
}

#[test]
fn verify_peer_cert_empty_hash_strings_mismatch() {
    // Empty-string observed hash vs non-empty stored hash → mismatch
    let result = verify_peer_cert(
        "device-A",
        Some("device-A"),
        Some(""),         // observed hash is empty
        Some("deadbeef"), // stored hash is non-empty
    );
    assert_eq!(
        result,
        CertVerifyResult::HashMismatch {
            remote_id: "device-A".into(),
        },
        "empty observed hash must not match non-empty stored hash"
    );
}

// ======================================================================
// T-41 — Tests for daemon async functions (now pub(crate))
//
// Tests 1-2 exercise try_sync_with_peer without a live connection:
//   - backoff gate prevents connection attempt entirely
//   - connection failure to unreachable address emits error event
// Tests 3-4 use loopback TLS WebSocket connection pairs:
//   - handle_incoming_sync rejects self-sync via HeadExchange
//   - run_sync_session exits early when cancel flag is set
// Additional edge-case tests follow.
// ======================================================================

/// Test 1: When a peer is in backoff, try_sync_with_peer returns
/// immediately — no "connecting" event, no connection attempt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_respects_backoff_gate() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(false);
    let cert = sync_net::generate_self_signed_cert("LOCAL_DEV").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_X".to_string(),
        addresses: vec!["192.168.1.100".parse().unwrap()],
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_X")];

    // Put peer in backoff
    scheduler.record_failure("PEER_X");
    assert!(
        !scheduler.may_retry("PEER_X"),
        "peer must be in backoff after failure"
    );

    try_sync_with_peer(
        &pool,
        "LOCAL_DEV",
        &materializer,
        &scheduler,
        &event_sink,
        &peer,
        &refs,
        &cancel,
        &cert,
    )
    .await;

    // No events — backoff gate prevents any progress
    assert_eq!(
        sink.events().len(),
        0,
        "no events should be emitted when backoff gate blocks"
    );

    // Failure count stays at 1 (no additional failure recorded)
    assert_eq!(
        scheduler.failure_count("PEER_X"),
        1,
        "failure count must not change when backoff gate blocks"
    );

    materializer.shutdown();
}

/// Test 2: When connect_to_peer fails, try_sync_with_peer emits a
/// "connecting" progress event followed by an Error event, and records
/// one failure on the scheduler.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_emits_error_event_on_connection_failure() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(false);
    let cert = sync_net::generate_self_signed_cert("LOCAL_DEV").unwrap();

    // Peer with unreachable address (connection will be refused)
    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_UNREACHABLE".to_string(),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port: 1, // privileged port, no listener → connection refused
    };
    let refs = vec![make_peer_ref("PEER_UNREACHABLE")];

    // Wrap in timeout to prevent test from hanging if connect blocks
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        try_sync_with_peer(
            &pool,
            "LOCAL_DEV",
            &materializer,
            &scheduler,
            &event_sink,
            &peer,
            &refs,
            &cancel,
            &cert,
        ),
    )
    .await;

    assert!(
        result.is_ok(),
        "try_sync_with_peer must complete within timeout"
    );

    let events = sink.events();
    assert_eq!(
        events.len(),
        2,
        "should emit 'connecting' progress and then 'error' event"
    );

    // First event: Progress("connecting")
    match &events[0] {
        SyncEvent::Progress {
            state,
            remote_device_id,
            ..
        } => {
            assert_eq!(
                state, "connecting",
                "first event should be 'connecting' progress"
            );
            assert_eq!(
                remote_device_id, "PEER_UNREACHABLE",
                "remote_device_id must match peer"
            );
        }
        other => panic!("expected Progress event, got {:?}", other),
    }

    // Second event: Error
    match &events[1] {
        SyncEvent::Error {
            message,
            remote_device_id,
        } => {
            assert!(
                message.contains("Connection failed"),
                "error message should mention connection failure, got: {message}"
            );
            assert_eq!(
                remote_device_id, "PEER_UNREACHABLE",
                "remote_device_id must match peer"
            );
        }
        other => panic!("expected Error event, got {:?}", other),
    }

    // Scheduler records the failure
    assert_eq!(
        scheduler.failure_count("PEER_UNREACHABLE"),
        1,
        "one failure should be recorded after connection failure"
    );

    materializer.shutdown();
}

/// Test 3: When the responder receives a HeadExchange whose only
/// device_id matches the local device_id, it sends
/// `SyncMessage::Error("cannot sync with self")` and returns Ok.
///
/// Uses a real loopback TLS WebSocket connection pair.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_sync_with_self() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Generate certs for server (responder) and client (initiator)
    let server_cert = sync_net::generate_self_signed_cert("LOCAL_DEV").unwrap();
    let client_cert = sync_net::generate_self_signed_cert("REMOTE_DEV").unwrap();

    // Start TLS WebSocket server; forward incoming connections via channel
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(&server_cert, move |conn| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    // Connect from client side
    let mut client_conn =
        sync_net::connect_to_peer(&format!("127.0.0.1:{port}"), None, None, &client_cert)
            .await
            .unwrap();

    // Get the server-side connection
    let server_conn = tokio::time::timeout(std::time::Duration::from_secs(5), conn_rx.recv())
        .await
        .expect("timed out waiting for server connection")
        .unwrap();

    // Spawn the responder handler
    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
        )
        .await
    });

    // Send HeadExchange with only LOCAL_DEV (self-sync scenario).
    // `find(|h| h.device_id != device_id)` returns None → remote_id = ""
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "LOCAL_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
        })
        .await
        .unwrap();

    // Receive the rejection response
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    match response {
        SyncMessage::Error { message } => {
            assert!(
                message.contains("cannot sync with self"),
                "error should mention self-sync, got: {message}"
            );
        }
        other => panic!("expected SyncMessage::Error, got {:?}", other),
    }

    // Handler should complete without error
    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting self-sync"
    );

    server.shutdown().await;
    materializer.shutdown();
}

/// Test 4: When the cancel flag is set before (or during) a sync
/// session, run_sync_session returns Err("sync cancelled by user")
/// after sending the initial HeadExchange.
///
/// Uses a real loopback TLS WebSocket connection pair.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_sync_session_respects_cancel_flag() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let server_cert = sync_net::generate_self_signed_cert("RESPONDER_DEV").unwrap();
    let client_cert = sync_net::generate_self_signed_cert("INITIATOR_DEV").unwrap();

    // Start server and connect
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(&server_cert, move |conn| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    let mut client_conn =
        sync_net::connect_to_peer(&format!("127.0.0.1:{port}"), None, None, &client_cert)
            .await
            .unwrap();

    // Keep server-side connection alive so the client send doesn't fail
    let _server_conn = tokio::time::timeout(std::time::Duration::from_secs(5), conn_rx.recv())
        .await
        .expect("timed out waiting for server connection")
        .unwrap();

    // Set up initiator-side orchestrator
    let mut orch = SyncOrchestrator::new(
        pool.clone(),
        "INITIATOR_DEV".to_string(),
        materializer.clone(),
    );

    // Set cancel flag BEFORE calling run_sync_session
    let cancel = AtomicBool::new(true);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // run_sync_session:
    // 1. orch.start() → HeadExchange  (succeeds)
    // 2. conn.send_json(...)           (succeeds, message is buffered)
    // 3. while !is_terminal():
    //      cancel.load() → true → return Err("sync cancelled by user")
    let result = run_sync_session(
        &mut orch,
        &mut client_conn,
        &cancel,
        &pool,
        &materializer,
        &event_sink,
    )
    .await;

    assert!(
        result.is_err(),
        "run_sync_session should return error when cancelled"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("sync cancelled by user"),
        "error should mention cancellation, got: {err}"
    );

    server.shutdown().await;
    materializer.shutdown();
}

// ======================================================================
// T-41 — Additional edge-case tests for daemon async functions
// ======================================================================

/// When a DiscoveredPeer has an empty address list, try_sync_with_peer
/// returns early with no events and no failure recorded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_skips_peer_with_no_addresses() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(false);
    let cert = sync_net::generate_self_signed_cert("LOCAL").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_NOADDR".to_string(),
        addresses: vec![], // no addresses
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_NOADDR")];

    try_sync_with_peer(
        &pool,
        "LOCAL",
        &materializer,
        &scheduler,
        &event_sink,
        &peer,
        &refs,
        &cancel,
        &cert,
    )
    .await;

    // No events — address resolution fails before "connecting" event
    assert_eq!(
        sink.events().len(),
        0,
        "no events should be emitted when peer has no addresses"
    );
    assert_eq!(
        scheduler.failure_count("PEER_NOADDR"),
        0,
        "no failure should be recorded for empty address list"
    );

    materializer.shutdown();
}

/// When the per-peer lock is already held, try_sync_with_peer returns
/// immediately — no events emitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_skips_when_peer_locked() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(false);
    let cert = sync_net::generate_self_signed_cert("LOCAL").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_LOCKED".to_string(),
        addresses: vec!["192.168.1.1".parse().unwrap()],
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_LOCKED")];

    // Acquire the per-peer lock before calling try_sync_with_peer
    let _guard = scheduler.try_lock_peer("PEER_LOCKED").unwrap();

    try_sync_with_peer(
        &pool,
        "LOCAL",
        &materializer,
        &scheduler,
        &event_sink,
        &peer,
        &refs,
        &cancel,
        &cert,
    )
    .await;

    assert_eq!(
        sink.events().len(),
        0,
        "no events should be emitted when peer is already locked"
    );

    materializer.shutdown();
}

/// When a HeadExchange arrives from an unpaired device, the responder
/// sends `Error("peer not paired")` and returns Ok.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_unpaired_device() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let server_cert = sync_net::generate_self_signed_cert("LOCAL_DEV").unwrap();
    let client_cert = sync_net::generate_self_signed_cert("UNKNOWN_DEV").unwrap();

    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(&server_cert, move |conn| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    let mut client_conn =
        sync_net::connect_to_peer(&format!("127.0.0.1:{port}"), None, None, &client_cert)
            .await
            .unwrap();

    let server_conn = tokio::time::timeout(std::time::Duration::from_secs(5), conn_rx.recv())
        .await
        .expect("timed out waiting for server connection")
        .unwrap();

    // No peer_refs entries → UNKNOWN_DEV is not paired
    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
        )
        .await
    });

    // Send HeadExchange from an unpaired device
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "UNKNOWN_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
        })
        .await
        .unwrap();

    // Receive rejection response
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    match response {
        SyncMessage::Error { message } => {
            assert!(
                message.contains("not paired"),
                "error should mention unpaired device, got: {message}"
            );
        }
        other => panic!(
            "expected SyncMessage::Error for unpaired device, got {:?}",
            other
        ),
    }

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting unpaired device"
    );

    server.shutdown().await;
    materializer.shutdown();
}

/// S-11: Verify that cancel flag is cleared after try_sync_with_peer
/// exits via the connection-failure path.  The CancelGuard (scope guard)
/// ensures cleanup on ALL exit paths, including early returns.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_clears_cancel_flag_after_connection_failure() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // start with cancel set
    let cert = sync_net::generate_self_signed_cert("LOCAL_DEV").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_FAIL".to_string(),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port: 1, // connection will be refused
    };
    let refs = vec![make_peer_ref("PEER_FAIL")];

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        try_sync_with_peer(
            &pool,
            "LOCAL_DEV",
            &materializer,
            &scheduler,
            &event_sink,
            &peer,
            &refs,
            &cancel,
            &cert,
        ),
    )
    .await;

    assert!(result.is_ok(), "must complete within timeout");

    // S-11: CancelGuard clears the flag even on the connection-failure path
    assert!(
        !cancel.load(Ordering::Acquire),
        "S-11: cancel flag must be cleared after connection failure early-exit"
    );

    // Verify we got the error event (connection failed)
    let events = sink.events();
    assert_eq!(events.len(), 2, "should emit connecting + error events");

    materializer.shutdown();
}

// ======================================================================
// S-11 — Cancel flag cleared on ALL early-exit paths
// ======================================================================

/// S-11: Cancel flag must be cleared when the backoff gate triggers
/// an early return.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s11_cancel_cleared_on_backoff_early_exit() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // cancel is set
    let cert = sync_net::generate_self_signed_cert("LOCAL").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_BACKOFF".to_string(),
        addresses: vec!["192.168.1.100".parse().unwrap()],
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_BACKOFF")];

    // Put peer in backoff so the gate triggers
    scheduler.record_failure("PEER_BACKOFF");
    assert!(
        !scheduler.may_retry("PEER_BACKOFF"),
        "peer must be in backoff"
    );

    try_sync_with_peer(
        &pool,
        "LOCAL",
        &materializer,
        &scheduler,
        &event_sink,
        &peer,
        &refs,
        &cancel,
        &cert,
    )
    .await;

    assert!(
        !cancel.load(Ordering::Acquire),
        "S-11: cancel flag must be cleared after backoff early-exit"
    );

    materializer.shutdown();
}

/// S-11: Cancel flag must be cleared when the per-peer lock is already
/// held (already-syncing early return).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s11_cancel_cleared_on_already_syncing_early_exit() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // cancel is set
    let cert = sync_net::generate_self_signed_cert("LOCAL").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_LOCKED".to_string(),
        addresses: vec!["192.168.1.1".parse().unwrap()],
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_LOCKED")];

    // Hold the per-peer lock so the function returns early
    let _lock = scheduler.try_lock_peer("PEER_LOCKED").unwrap();

    try_sync_with_peer(
        &pool,
        "LOCAL",
        &materializer,
        &scheduler,
        &event_sink,
        &peer,
        &refs,
        &cancel,
        &cert,
    )
    .await;

    assert!(
        !cancel.load(Ordering::Acquire),
        "S-11: cancel flag must be cleared after already-syncing early-exit"
    );

    materializer.shutdown();
}

/// S-11: Cancel flag must be cleared when the peer has no addresses
/// (no-address early return).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s11_cancel_cleared_on_no_addresses_early_exit() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // cancel is set
    let cert = sync_net::generate_self_signed_cert("LOCAL").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_NOADDR".to_string(),
        addresses: vec![], // no addresses → early return
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_NOADDR")];

    try_sync_with_peer(
        &pool,
        "LOCAL",
        &materializer,
        &scheduler,
        &event_sink,
        &peer,
        &refs,
        &cancel,
        &cert,
    )
    .await;

    assert!(
        !cancel.load(Ordering::Acquire),
        "S-11: cancel flag must be cleared after no-addresses early-exit"
    );

    materializer.shutdown();
}

// ======================================================================
// T-16 — verify_peer_cert unit tests
// ======================================================================

#[test]
fn verify_peer_cert_both_none_returns_ok() {
    let result = verify_peer_cert("any-device", None, None, None);
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "both cert_cn and stored_hash None → Ok"
    );
}

#[test]
fn verify_peer_cert_cn_match_returns_ok() {
    let result = verify_peer_cert("dev-1", Some("dev-1"), None, None);
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "matching CN with no hash check → Ok"
    );
}

#[test]
fn verify_peer_cert_cn_mismatch_returns_cn_mismatch() {
    let result = verify_peer_cert("dev-1", Some("dev-2"), None, None);
    assert_eq!(
        result,
        CertVerifyResult::CnMismatch {
            remote_id: "dev-1".into(),
            cert_cn: "dev-2".into(),
        },
        "mismatching CN → CnMismatch"
    );
}

#[test]
fn verify_peer_cert_hash_match_returns_ok() {
    let result = verify_peer_cert("dev-1", None, Some("hash123"), Some("hash123"));
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "matching hash with no CN → Ok"
    );
}

#[test]
fn verify_peer_cert_hash_mismatch_returns_hash_mismatch() {
    let result = verify_peer_cert("dev-1", None, Some("hash_a"), Some("hash_b"));
    assert_eq!(
        result,
        CertVerifyResult::HashMismatch {
            remote_id: "dev-1".into(),
        },
        "mismatching hash with no CN → HashMismatch"
    );
}

#[test]
fn verify_peer_cert_cn_match_but_hash_mismatch() {
    let result = verify_peer_cert(
        "dev-1",
        Some("dev-1"),    // CN matches
        Some("observed"), // observed hash
        Some("stored"),   // stored hash — different
    );
    assert_eq!(
        result,
        CertVerifyResult::HashMismatch {
            remote_id: "dev-1".into(),
        },
        "CN match + hash mismatch → HashMismatch"
    );
}

// ======================================================================
// T-16 — In-memory WebSocket tests for handle_incoming_sync
// ======================================================================

/// T-16 Test 1: Sending a HeadExchange containing only the local device's
/// head triggers the self-sync rejection branch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_self() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let (server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
        )
        .await
    });

    // Send HeadExchange with only the local device's head → remote_id
    // resolves to "" (no head with device_id != "LOCAL_DEV"), triggering
    // the self-sync rejection.
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "LOCAL_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
        })
        .await
        .unwrap();

    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    match response {
        SyncMessage::Error { message } => {
            assert!(
                message.contains("self"),
                "error should mention self-sync, got: {message}"
            );
        }
        other => panic!("expected SyncMessage::Error, got {:?}", other),
    }

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting self-sync"
    );

    materializer.shutdown();
}

/// T-16 Test 2: Sending a HeadExchange from a device not present in
/// the peer_refs table triggers the unpaired-device rejection branch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_unpaired() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // No peer_refs entries → any remote device is "unpaired"
    let (server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
        )
        .await
    });

    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "UNKNOWN_DEVICE".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
        })
        .await
        .unwrap();

    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    match response {
        SyncMessage::Error { message } => {
            assert!(
                message.contains("not paired"),
                "error should mention unpaired, got: {message}"
            );
        }
        other => panic!(
            "expected SyncMessage::Error for unpaired device, got {:?}",
            other
        ),
    }

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting unpaired device"
    );

    materializer.shutdown();
}

/// T-16 Test 3: When the per-peer lock is already held (e.g. an outbound
/// session is in progress), the responder sends "busy" and returns Ok.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_busy_peer() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Insert a peer ref so the device is "paired"
    peer_refs::upsert_peer_ref(&pool, "REMOTE_DEV")
        .await
        .unwrap();

    // Pre-acquire the per-peer lock to simulate a concurrent session
    let _guard = scheduler.try_lock_peer("REMOTE_DEV").unwrap();

    let (server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
        )
        .await
    });

    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "REMOTE_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
        })
        .await
        .unwrap();

    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    match response {
        SyncMessage::Error { message } => {
            assert!(
                message.contains("busy"),
                "error should mention busy, got: {message}"
            );
        }
        other => panic!("expected SyncMessage::Error for busy peer, got {:?}", other),
    }

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting busy peer"
    );

    materializer.shutdown();
}

/// T-16 Test 4: Sending a non-HeadExchange message (SyncComplete) as
/// the first message skips peer validation and goes straight to
/// orch.handle_message(), which rejects it as out-of-order.
/// Verify the function completes without panicking.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_non_head_exchange_first_msg() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let (server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
        )
        .await
    });

    // Send SyncComplete as the first message — no HeadExchange
    client_conn
        .send_json(&SyncMessage::SyncComplete {
            last_hash: "fakehash".to_string(),
        })
        .await
        .unwrap();

    // The handler should complete (likely with an error from the
    // orchestrator rejecting SyncComplete in Idle state) but must
    // not panic.
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle)
        .await
        .expect("handle_incoming_sync must complete within timeout");

    // The spawned task itself must not panic
    assert!(
        result.is_ok(),
        "spawned task must not panic (JoinError would indicate a panic)"
    );

    materializer.shutdown();
}

/// T-16c Test 5 (B-34): When the TLS certificate CN doesn't match the
/// remote device ID claimed in HeadExchange, the responder sends an
/// error about "certificate" and closes the connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_cert_cn_mismatch() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Insert peer ref so the device is "paired"
    peer_refs::upsert_peer_ref(&pool, "REMOTE_PAIRED")
        .await
        .unwrap();

    let (mut server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    // Set CN to a WRONG value — doesn't match remote_id "REMOTE_PAIRED"
    server_conn.set_test_cert(Some("wrong-device".to_string()), None);

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
        )
        .await
    });

    // Send HeadExchange from REMOTE_PAIRED (include local head too)
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![
                DeviceHead {
                    device_id: "REMOTE_PAIRED".to_string(),
                    seq: 0,
                    hash: "fakehash".to_string(),
                },
                DeviceHead {
                    device_id: "LOCAL_DEV".to_string(),
                    seq: 0,
                    hash: "fakehash".to_string(),
                },
            ],
        })
        .await
        .unwrap();

    // Receive rejection response
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    match response {
        SyncMessage::Error { message } => {
            assert!(
                message.contains("certificate"),
                "error should mention certificate, got: {message}"
            );
        }
        other => panic!(
            "expected SyncMessage::Error for CN mismatch, got {:?}",
            other
        ),
    }

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting CN mismatch"
    );

    materializer.shutdown();
}

/// T-16c Test 6 (B-33): When the TLS certificate hash doesn't match the
/// stored cert_hash for this peer, the responder sends an error about
/// "hash mismatch" and closes the connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_cert_hash_mismatch() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Insert peer ref WITH a stored cert hash
    peer_refs::upsert_peer_ref_with_cert(&pool, "REMOTE_PAIRED", "stored_hash_abc")
        .await
        .unwrap();

    let (mut server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    // Set CN to match (passes B-34) but hash to a DIFFERENT value (fails B-33)
    server_conn.set_test_cert(
        Some("REMOTE_PAIRED".to_string()),
        Some("different_hash_xyz".to_string()),
    );

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
        )
        .await
    });

    // Send HeadExchange from REMOTE_PAIRED
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![
                DeviceHead {
                    device_id: "REMOTE_PAIRED".to_string(),
                    seq: 0,
                    hash: "fakehash".to_string(),
                },
                DeviceHead {
                    device_id: "LOCAL_DEV".to_string(),
                    seq: 0,
                    hash: "fakehash".to_string(),
                },
            ],
        })
        .await
        .unwrap();

    // Receive rejection response
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    match response {
        SyncMessage::Error { message } => {
            assert!(
                message.contains("hash mismatch"),
                "error should mention hash mismatch, got: {message}"
            );
        }
        other => panic!(
            "expected SyncMessage::Error for hash mismatch, got {:?}",
            other
        ),
    }

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting hash mismatch"
    );

    materializer.shutdown();
}

/// T-16c Test 7 (TOFU): When a paired peer has no stored cert_hash yet,
/// the responder stores the observed cert hash on first authenticated
/// connection (trust-on-first-use).
///
/// The TOFU store happens during cert verification (before protocol
/// message processing), so even if the orchestrator enters ResetRequired
/// because the fresh server DB has no ops for the remote's claimed head,
/// the cert hash should already be persisted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_tofu_stores_cert_hash() {
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Insert peer ref WITHOUT a cert hash (just the device_id)
    peer_refs::upsert_peer_ref(&pool, "REMOTE_PAIRED")
        .await
        .unwrap();

    // Verify cert_hash starts as None
    let peer_before = peer_refs::get_peer_ref(&pool, "REMOTE_PAIRED")
        .await
        .unwrap()
        .unwrap();
    assert!(
        peer_before.cert_hash.is_none(),
        "cert_hash must be None before TOFU"
    );

    // Insert one op for REMOTE_PAIRED into the server's DB so that
    // check_reset_required won't trigger ResetRequired.
    let op = append_local_op_at(
        &pool,
        "REMOTE_PAIRED",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TOFU_BLK"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "tofu test".into(),
        }),
        "2025-01-15T12:00:00+00:00".into(),
    )
    .await
    .unwrap();

    let (mut server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    // Set CN to match and provide a new cert hash for TOFU
    server_conn.set_test_cert(
        Some("REMOTE_PAIRED".to_string()),
        Some("new_hash_123".to_string()),
    );

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();

    // Run client side in a separate task since both sides send/receive
    let client_task = tokio::spawn(async move {
        // Client sends HeadExchange referencing the op we inserted
        client_conn
            .send_json(&SyncMessage::HeadExchange {
                heads: vec![DeviceHead {
                    device_id: "REMOTE_PAIRED".to_string(),
                    seq: op.seq,
                    hash: op.hash.clone(),
                }],
            })
            .await
            .unwrap();

        // Client receives the server's response (OpBatch)
        let resp: SyncMessage = client_conn.recv_json().await.unwrap();
        match resp {
            SyncMessage::OpBatch { is_last, .. } if is_last => {
                client_conn
                    .send_json(&SyncMessage::SyncComplete {
                        last_hash: "".to_string(),
                    })
                    .await
                    .unwrap();
            }
            SyncMessage::OpBatch { .. } => {}
            _ => {
                // ResetRequired or other — just let the session end
            }
        }
    });

    // Run server-side handler
    let result = handle_incoming_sync(
        server_conn,
        pool_clone,
        "LOCAL_DEV".to_string(),
        mat_clone,
        sched_clone,
        sink_clone,
    )
    .await;

    // Wait for client task to finish
    client_task.await.expect("client task must not panic");

    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok for TOFU path, got: {:?}",
        result
    );

    // Verify the cert hash was stored (TOFU)
    let peer_after = peer_refs::get_peer_ref(&pool, "REMOTE_PAIRED")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        peer_after.cert_hash.as_deref(),
        Some("new_hash_123"),
        "TOFU: cert_hash must be stored after first authenticated connection"
    );

    materializer.shutdown();
}

/// T-16c Test 8: Happy path — a complete sync session between two peers
/// with no ops to exchange.  Both sides reach terminal state normally.
///
/// We pre-insert one op for REMOTE_PAIRED so that the server's
/// `check_reset_required` passes (it verifies claimed head seqs exist).
/// The server has no LOCAL_DEV ops, so OpBatch is empty.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_happy_path_empty_sync() {
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Insert peer ref so the device is "paired"
    peer_refs::upsert_peer_ref(&pool, "REMOTE_PAIRED")
        .await
        .unwrap();

    // Insert one op for REMOTE_PAIRED so check_reset_required passes.
    let op = append_local_op_at(
        &pool,
        "REMOTE_PAIRED",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("HAPPY_BLK"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "happy path".into(),
        }),
        "2025-01-15T12:00:00+00:00".into(),
    )
    .await
    .unwrap();

    let (server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();

    // Run client side in a separate task since both sides need to
    // send/receive concurrently.
    let client_task = tokio::spawn(async move {
        // Client sends HeadExchange referencing the known op
        client_conn
            .send_json(&SyncMessage::HeadExchange {
                heads: vec![DeviceHead {
                    device_id: "REMOTE_PAIRED".to_string(),
                    seq: op.seq,
                    hash: op.hash.clone(),
                }],
            })
            .await
            .unwrap();

        // Client receives response (OpBatch with is_last=true for empty sync;
        // server has no LOCAL_DEV ops to send)
        let resp: SyncMessage = client_conn.recv_json().await.unwrap();
        match resp {
            SyncMessage::OpBatch { is_last, ops } => {
                assert!(
                    ops.is_empty(),
                    "empty sync should produce no ops, got {}",
                    ops.len()
                );
                assert!(is_last, "single batch should be the last one");
            }
            other => panic!("expected OpBatch from server, got {:?}", other),
        }

        // Client sends SyncComplete to end the session
        client_conn
            .send_json(&SyncMessage::SyncComplete {
                last_hash: "".to_string(),
            })
            .await
            .unwrap();
    });

    // Run the server-side handler
    let result = handle_incoming_sync(
        server_conn,
        pool_clone,
        "LOCAL_DEV".to_string(),
        mat_clone,
        sched_clone,
        sink_clone,
    )
    .await;

    // Wait for client task to finish
    client_task.await.expect("client task must not panic");

    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok for happy-path empty sync, got: {:?}",
        result
    );

    materializer.shutdown();
}

// ======================================================================
// T-16e — resolve_peer_address tests
// ======================================================================

#[test]
fn resolve_peer_address_returns_discovered_peer() {
    use tokio::time::Instant;

    let mut discovered: HashMap<String, (sync_net::DiscoveredPeer, Instant)> = HashMap::new();
    let dp = sync_net::DiscoveredPeer {
        device_id: "PEER_A".into(),
        addresses: vec!["10.0.0.1".parse().unwrap()],
        port: 9443,
    };
    discovered.insert("PEER_A".into(), (dp, Instant::now()));

    let result = resolve_peer_address("PEER_A", Some("192.168.1.1:8080"), &discovered);
    assert!(result.is_some(), "must return discovered peer");
    let peer = result.unwrap();
    assert_eq!(peer.device_id, "PEER_A");
    assert_eq!(
        peer.port, 9443,
        "must use discovered peer's port, not fallback"
    );
    assert_eq!(
        peer.addresses[0].to_string(),
        "10.0.0.1",
        "must use discovered peer's address"
    );
}

#[test]
fn resolve_peer_address_falls_back_to_cached_address() {
    use tokio::time::Instant;

    let discovered: HashMap<String, (sync_net::DiscoveredPeer, Instant)> = HashMap::new();

    let result = resolve_peer_address("PEER_B", Some("192.168.1.42:9443"), &discovered);
    assert!(
        result.is_some(),
        "must fall back to cached address when not discovered"
    );
    let peer = result.unwrap();
    assert_eq!(peer.device_id, "PEER_B");
    assert_eq!(peer.port, 9443);
    assert_eq!(peer.addresses[0].to_string(), "192.168.1.42");
}

#[test]
fn resolve_peer_address_returns_none_when_both_unavailable() {
    use tokio::time::Instant;

    let discovered: HashMap<String, (sync_net::DiscoveredPeer, Instant)> = HashMap::new();

    let result = resolve_peer_address("PEER_C", None, &discovered);
    assert!(
        result.is_none(),
        "must return None when neither discovered nor cached"
    );
}

#[test]
fn resolve_peer_address_prefers_discovered_over_fallback() {
    use tokio::time::Instant;

    let mut discovered: HashMap<String, (sync_net::DiscoveredPeer, Instant)> = HashMap::new();
    let dp = sync_net::DiscoveredPeer {
        device_id: "PEER_D".into(),
        addresses: vec!["10.0.0.99".parse().unwrap()],
        port: 5555,
    };
    discovered.insert("PEER_D".into(), (dp, Instant::now()));

    let result = resolve_peer_address("PEER_D", Some("192.168.1.1:8080"), &discovered);
    assert!(result.is_some(), "must return discovered peer");
    let peer = result.unwrap();
    assert_eq!(
        peer.port, 5555,
        "must prefer discovered (port 5555) over fallback (port 8080)"
    );
    assert_eq!(
        peer.addresses[0].to_string(),
        "10.0.0.99",
        "must prefer discovered address over fallback"
    );
}

// ======================================================================
// T-16e — format_peer_address tests
// ======================================================================

#[test]
fn format_peer_address_formats_single_ipv4() {
    let peer = sync_net::DiscoveredPeer {
        device_id: "DEV".into(),
        addresses: vec!["192.168.1.10".parse().unwrap()],
        port: 9443,
    };
    let result = format_peer_address(&peer);
    assert_eq!(
        result,
        Some("192.168.1.10:9443".to_string()),
        "must format as ip:port"
    );
}

#[test]
fn format_peer_address_returns_none_for_empty_addresses() {
    let peer = sync_net::DiscoveredPeer {
        device_id: "DEV".into(),
        addresses: vec![],
        port: 9443,
    };
    let result = format_peer_address(&peer);
    assert!(result.is_none(), "must return None for empty addresses");
}

#[test]
fn format_peer_address_uses_first_address_when_multiple() {
    let peer = sync_net::DiscoveredPeer {
        device_id: "DEV".into(),
        addresses: vec!["192.168.1.10".parse().unwrap(), "10.0.0.1".parse().unwrap()],
        port: 8080,
    };
    let result = format_peer_address(&peer);
    assert_eq!(
        result,
        Some("192.168.1.10:8080".to_string()),
        "must use the first address when multiple are available"
    );
}

// ======================================================================
// L-62 — format_peer_addresses (multi-address try-all)
// ======================================================================

/// L-62: empty address list ⇒ empty `Vec` (callers can `.is_empty()`).
#[test]
fn format_peer_addresses_returns_empty_when_no_addresses() {
    let peer = sync_net::DiscoveredPeer {
        device_id: "DEV".into(),
        addresses: vec![],
        port: 9443,
    };
    assert!(
        format_peer_addresses(&peer).is_empty(),
        "L-62: empty address list must return empty Vec"
    );
}

/// L-62: when mDNS announces IPv6 link-local before IPv4, the formatter
/// reorders so IPv4 is tried first — that is the whole point of the
/// fix per REVIEW-LATER.md.
#[test]
fn format_peer_addresses_prefers_ipv4_over_ipv6_link_local() {
    let peer = sync_net::DiscoveredPeer {
        device_id: "DEV".into(),
        addresses: vec![
            // IPv6 link-local listed first in the mDNS announcement.
            "fe80::1".parse().unwrap(),
            "192.168.1.10".parse().unwrap(),
        ],
        port: 8080,
    };
    let result = format_peer_addresses(&peer);
    assert_eq!(
        result,
        vec![
            "192.168.1.10:8080".to_string(),
            "[fe80::1]:8080".to_string()
        ],
        "L-62: IPv4 must be tried before IPv6 link-local"
    );
}

/// L-62: IPv6 unicast non-link-local sits between IPv4 and link-local.
#[test]
fn format_peer_addresses_orders_ipv4_then_ipv6_global_then_linklocal() {
    let peer = sync_net::DiscoveredPeer {
        device_id: "DEV".into(),
        addresses: vec![
            "fe80::1".parse().unwrap(),
            "2001:db8::1".parse().unwrap(),
            "10.0.0.5".parse().unwrap(),
        ],
        port: 9443,
    };
    let result = format_peer_addresses(&peer);
    assert_eq!(
        result,
        vec![
            "10.0.0.5:9443".to_string(),
            "[2001:db8::1]:9443".to_string(),
            "[fe80::1]:9443".to_string(),
        ],
        "L-62: priority order is IPv4 → IPv6 unicast → IPv6 link-local"
    );
}

/// L-62: within a single tier, the original mDNS order must be preserved
/// — important so a deterministic announcement produces a deterministic
/// connection sequence.
#[test]
fn format_peer_addresses_preserves_within_tier_order() {
    let peer = sync_net::DiscoveredPeer {
        device_id: "DEV".into(),
        addresses: vec![
            "192.168.1.20".parse().unwrap(),
            "192.168.1.10".parse().unwrap(),
        ],
        port: 8080,
    };
    let result = format_peer_addresses(&peer);
    assert_eq!(
        result,
        vec![
            "192.168.1.20:8080".to_string(),
            "192.168.1.10:8080".to_string()
        ],
        "L-62: announcement order preserved within each priority tier"
    );
}

// ======================================================================
// L-63 — ServiceRemoved eviction
// ======================================================================

/// L-63: `process_service_removed` drops the entry from the discovered
/// HashMap immediately and reports `true` so the caller can branch on
/// whether anything actually changed.
#[test]
fn process_service_removed_drops_entry() {
    let mut discovered = HashMap::new();
    let peer = sync_net::DiscoveredPeer {
        device_id: "REMOVED_PEER".into(),
        addresses: vec!["192.168.1.20".parse().unwrap()],
        port: 9443,
    };
    discovered.insert(
        "REMOVED_PEER".to_string(),
        (peer, tokio::time::Instant::now()),
    );
    assert!(
        discovered.contains_key("REMOVED_PEER"),
        "fixture: discovered map starts with the peer present"
    );

    let removed = process_service_removed("REMOVED_PEER", "LOCAL", &mut discovered);

    assert!(removed, "L-63: must report the entry as removed");
    assert!(
        !discovered.contains_key("REMOVED_PEER"),
        "L-63: discovered map must drop the peer immediately on ServiceRemoved"
    );
}

/// L-63: a `ServiceRemoved` for a peer we never saw is a no-op.
#[test]
fn process_service_removed_ignores_unknown_peer() {
    let mut discovered = HashMap::new();
    let removed = process_service_removed("NEVER_SEEN", "LOCAL", &mut discovered);
    assert!(!removed, "L-63: removal of unknown peer must report false");
    assert!(
        discovered.is_empty(),
        "L-63: discovered map must remain empty"
    );
}

/// L-63: a removal of the local device must not touch the map (we never
/// insert ourselves in the discovered HashMap to begin with).
#[test]
fn process_service_removed_ignores_self() {
    let mut discovered = HashMap::new();
    let peer = sync_net::DiscoveredPeer {
        device_id: "OTHER_PEER".into(),
        addresses: vec!["192.168.1.20".parse().unwrap()],
        port: 9443,
    };
    discovered.insert(
        "OTHER_PEER".to_string(),
        (peer, tokio::time::Instant::now()),
    );

    let removed = process_service_removed("LOCAL_DEV", "LOCAL_DEV", &mut discovered);

    assert!(!removed, "L-63: self-removal must be a no-op");
    assert!(
        discovered.contains_key("OTHER_PEER"),
        "L-63: peers belonging to other devices must not be touched"
    );
}

/// L-63: a `ServiceRemoved` event flowing through `process_discovery_event`
/// must remove the peer from the discovered HashMap and return `None`
/// (no peer to sync with — eviction is the side effect).
#[test]
fn process_discovery_event_evicts_on_service_removed() {
    let mut discovered = HashMap::new();
    let peer = sync_net::DiscoveredPeer {
        device_id: "REMOVED".into(),
        addresses: vec!["192.168.1.42".parse().unwrap()],
        port: 9443,
    };
    discovered.insert("REMOVED".to_string(), (peer, tokio::time::Instant::now()));

    let event = mdns_sd::ServiceEvent::ServiceRemoved(
        sync_net::MDNS_SERVICE_TYPE.to_string(),
        format!(
            "{name}_REMOVED.{ty}",
            name = sync_net::MDNS_SERVICE_NAME,
            ty = sync_net::MDNS_SERVICE_TYPE,
        ),
    );

    let result = process_discovery_event(event, "LOCAL", &mut discovered, &[]);

    assert!(
        result.is_none(),
        "L-63: ServiceRemoved must not return a peer to sync with"
    );
    assert!(
        !discovered.contains_key("REMOVED"),
        "L-63: discovered HashMap must no longer contain the removed peer"
    );
}

// ======================================================================
// T-16e — get_peer_cert_hash tests
// ======================================================================

fn make_peer_ref_with_cert(peer_id: &str, cert_hash: Option<&str>) -> PeerRef {
    PeerRef {
        peer_id: peer_id.to_string(),
        last_hash: None,
        last_sent_hash: None,
        synced_at: None,
        reset_count: 0,
        last_reset_at: None,
        cert_hash: cert_hash.map(String::from),
        device_name: None,
        last_address: None,
    }
}

#[test]
fn get_peer_cert_hash_returns_hash_when_present() {
    let refs = vec![make_peer_ref_with_cert("PEER_A", Some("deadbeef"))];
    let result = get_peer_cert_hash("PEER_A", &refs);
    assert_eq!(
        result,
        Some("deadbeef".to_string()),
        "must return the stored cert hash"
    );
}

#[test]
fn get_peer_cert_hash_returns_none_when_no_hash() {
    let refs = vec![make_peer_ref_with_cert("PEER_A", None)];
    let result = get_peer_cert_hash("PEER_A", &refs);
    assert!(
        result.is_none(),
        "must return None when peer has no cert hash"
    );
}

#[test]
fn get_peer_cert_hash_returns_none_when_peer_not_found() {
    let refs = vec![make_peer_ref_with_cert("PEER_A", Some("deadbeef"))];
    let result = get_peer_cert_hash("PEER_UNKNOWN", &refs);
    assert!(
        result.is_none(),
        "must return None when peer is not in the list"
    );
}

// ======================================================================
// T-16e — should_store_cert_hash tests
// ======================================================================

#[test]
fn should_store_cert_hash_true_when_none_stored_and_some_observed() {
    assert!(
        should_store_cert_hash(None, Some("deadbeef")),
        "must return true when no stored hash and observed hash is present"
    );
}

#[test]
fn should_store_cert_hash_false_when_already_stored() {
    assert!(
        !should_store_cert_hash(Some("existing"), Some("deadbeef")),
        "must return false when a hash is already stored"
    );
}

#[test]
fn should_store_cert_hash_false_when_nothing_observed() {
    assert!(
        !should_store_cert_hash(None, None),
        "must return false when no hash is observed"
    );
}

#[test]
fn should_store_cert_hash_false_when_both_present() {
    assert!(
        !should_store_cert_hash(Some("existing"), Some("observed")),
        "must return false when both stored and observed are present"
    );
}

// ======================================================================
// T-16 — Daemon lifecycle smoke tests
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_start_and_shutdown() {
    install_crypto_provider();
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    // Generate a real self-signed cert for the test
    let cert = crate::sync_net::generate_self_signed_cert("TEST_DEV")
        .expect("cert generation should succeed");

    // Start the daemon — this binds a TLS server on a random port
    // and may or may not start mDNS (depends on test environment)
    let daemon = SyncDaemon::start(
        pool.clone(),
        "TEST_DEV".to_string(),
        mat.clone(),
        scheduler,
        cert,
        sink,
        cancel,
    )
    .await
    .expect("daemon should start successfully");

    // Let the daemon run briefly to ensure the select! loop starts
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Shutdown should exit cleanly
    daemon.shutdown();

    // Give the task time to clean up
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_cancel_does_not_trigger_shutdown() {
    install_crypto_provider();
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let cert = crate::sync_net::generate_self_signed_cert("TEST_DEV2")
        .expect("cert generation should succeed");

    let daemon = SyncDaemon::start(
        pool.clone(),
        "TEST_DEV2".to_string(),
        mat.clone(),
        scheduler,
        cert,
        sink,
        cancel,
    )
    .await
    .expect("daemon should start");

    // Cancel active sync (should not affect daemon lifecycle)
    daemon.cancel_active_sync();

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Daemon should still be running — shutdown it cleanly
    daemon.shutdown();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    mat.shutdown();
}

#[test]
fn generate_cert_produces_valid_pem() {
    let cert = crate::sync_net::generate_self_signed_cert("TEST_DEV3")
        .expect("cert generation should succeed");

    assert!(cert.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(cert.key_pem.starts_with("-----BEGIN PRIVATE KEY-----"));
    assert_eq!(
        cert.cert_hash.len(),
        64,
        "SHA-256 hash should be 64 hex chars"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_daemons_start_on_different_ports() {
    install_crypto_provider();
    let (pool1, _dir1) = test_pool().await;
    let (pool2, _dir2) = test_pool().await;
    let mat1 = Materializer::new(pool1.clone());
    let mat2 = Materializer::new(pool2.clone());
    let sched1 = Arc::new(SyncScheduler::new());
    let sched2 = Arc::new(SyncScheduler::new());
    let sink1: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let sink2: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel1 = Arc::new(AtomicBool::new(false));
    let cancel2 = Arc::new(AtomicBool::new(false));

    let cert1 = crate::sync_net::generate_self_signed_cert("DEV_A").unwrap();
    let cert2 = crate::sync_net::generate_self_signed_cert("DEV_B").unwrap();

    let d1 = SyncDaemon::start(
        pool1,
        "DEV_A".into(),
        mat1.clone(),
        sched1,
        cert1,
        sink1,
        cancel1,
    )
    .await
    .expect("daemon 1 should start");
    let d2 = SyncDaemon::start(
        pool2,
        "DEV_B".into(),
        mat2.clone(),
        sched2,
        cert2,
        sink2,
        cancel2,
    )
    .await
    .expect("daemon 2 should start");

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    d1.shutdown();
    d2.shutdown();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    mat1.shutdown();
    mat2.shutdown();
}

// ======================================================================
// T-16f — Test daemon_loop select! branches B and C
// ======================================================================

/// Branch B: A local-change notification triggers the debounced change
/// path in daemon_loop, which resolves paired peers by last_address and
/// calls try_sync_with_peer.  With an unreachable address the connection
/// fails and the scheduler records a failure.
///
/// Approach: start the daemon with NO peer refs (so Branch C's immediate
/// first tick finds nothing), then insert a peer ref with an unreachable
/// last_address, fire notify_change(), and verify that a failure is
/// recorded for the peer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_branch_b_local_change_triggers_sync_attempt() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // Use a short debounce window (100 ms) so the test doesn't wait 3 s.
    let scheduler = Arc::new(SyncScheduler::with_intervals(
        std::time::Duration::from_millis(100),
        std::time::Duration::from_secs(60),
    ));
    let sink = Arc::new(RecordingEventSink::new());
    let sink_dyn: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let cert = crate::sync_net::generate_self_signed_cert("BRANCH_B_DEV").unwrap();

    // Start daemon with NO peer refs — Branch C's first tick finds nothing.
    let daemon = SyncDaemon::start(
        pool.clone(),
        "BRANCH_B_DEV".into(),
        mat.clone(),
        scheduler.clone(),
        cert,
        sink_dyn,
        cancel,
    )
    .await
    .unwrap();

    // Let startup complete and Branch C's first tick pass (no peers → no-op).
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Insert a peer ref with an unreachable last_address (port 1).
    peer_refs::upsert_peer_ref(&pool, "REMOTE_PEER")
        .await
        .unwrap();
    sqlx::query("UPDATE peer_refs SET last_address = '127.0.0.1:1' WHERE peer_id = 'REMOTE_PEER'")
        .execute(&pool)
        .await
        .unwrap();

    // Trigger Branch B by notifying a local change.
    scheduler.notify_change();

    // Wait for debounce window (100 ms) + connection attempt + margin.
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    // Verify the scheduler recorded a failure for REMOTE_PEER
    // (try_sync_with_peer couldn't connect → record_failure was called).
    let failure_count = scheduler.failure_count("REMOTE_PEER");
    assert!(
        failure_count >= 1,
        "Branch B should have triggered a sync attempt that failed, got failure_count={failure_count}"
    );

    daemon.shutdown();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    mat.shutdown();
}

/// Branch C: The periodic resync timer (30 s interval, first tick fires
/// immediately) calls peers_due_for_resync and attempts sync with overdue
/// peers.  A peer whose synced_at is NULL is always overdue.
///
/// Approach: insert a peer ref that has never synced (synced_at IS NULL)
/// with an unreachable last_address, start the daemon, and verify that
/// the immediate first tick triggers a sync attempt (failure recorded).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_branch_c_resync_timer_attempts_overdue_peer() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let sink_dyn: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let cert = crate::sync_net::generate_self_signed_cert("BRANCH_C_DEV").unwrap();

    // Insert a peer ref that has NEVER synced (synced_at IS NULL → always due)
    // with a last_address so resolve_peer_address can find it.
    peer_refs::upsert_peer_ref(&pool, "OVERDUE_PEER")
        .await
        .unwrap();
    sqlx::query("UPDATE peer_refs SET last_address = '127.0.0.1:1' WHERE peer_id = 'OVERDUE_PEER'")
        .execute(&pool)
        .await
        .unwrap();

    // Start daemon — the first resync tick fires immediately.
    let daemon = SyncDaemon::start(
        pool.clone(),
        "BRANCH_C_DEV".into(),
        mat.clone(),
        scheduler.clone(),
        cert,
        sink_dyn,
        cancel,
    )
    .await
    .unwrap();

    // Wait for the first resync tick to fire + sync attempt.
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    // Check if a sync was attempted (failure recorded since port 1 is unreachable).
    let failure_count = scheduler.failure_count("OVERDUE_PEER");
    assert!(
        failure_count >= 1,
        "Branch C should have triggered a resync attempt for overdue peer, got failure_count={failure_count}"
    );

    daemon.shutdown();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    mat.shutdown();
}

// ======================================================================
// T-16g — process_discovery_event (Branch A extraction)
// ======================================================================

/// Helper to construct a `ServiceEvent::ServiceResolved` event with the
/// given device_id and port, suitable for unit-testing `process_discovery_event`.
fn make_resolved_event(device_id: &str, port: u16) -> mdns_sd::ServiceEvent {
    let mut props = HashMap::new();
    props.insert("device_id".to_string(), device_id.to_string());

    let info = mdns_sd::ServiceInfo::new(
        "_agaric._tcp.local.",
        device_id,
        &format!("{device_id}.local."),
        "127.0.0.1",
        port,
        Some(props),
    )
    .unwrap();

    mdns_sd::ServiceEvent::ServiceResolved(Box::new(info.as_resolved_service()))
}

#[test]
fn process_discovery_non_resolved_returns_none() {
    let event = mdns_sd::ServiceEvent::ServiceFound(
        "_agaric._tcp.local.".into(),
        "test._agaric._tcp.local.".into(),
    );
    let mut discovered = HashMap::new();
    assert!(
        process_discovery_event(event, "LOCAL", &mut discovered, &[]).is_none(),
        "non-resolved event must return None"
    );
    assert!(
        discovered.is_empty(),
        "discovered map must remain empty for non-resolved event"
    );
}

#[test]
fn process_discovery_self_returns_none() {
    let event = make_resolved_event("LOCAL_DEV", 8443);
    let mut discovered = HashMap::new();
    assert!(
        process_discovery_event(event, "LOCAL_DEV", &mut discovered, &[]).is_none(),
        "self-discovery must return None"
    );
}

#[test]
fn process_discovery_already_discovered_returns_none() {
    let event1 = make_resolved_event("PEER_A", 8443);
    let event2 = make_resolved_event("PEER_A", 8443);
    let mut discovered = HashMap::new();

    // First discovery (unpaired -> None, but added to discovered)
    assert!(
        process_discovery_event(event1, "LOCAL", &mut discovered, &[]).is_none(),
        "first discovery of unpaired peer must return None"
    );
    assert_eq!(discovered.len(), 1, "peer must be added to discovered map");

    // Second discovery -> already discovered -> None
    assert!(
        process_discovery_event(event2, "LOCAL", &mut discovered, &[]).is_none(),
        "already-discovered peer must return None"
    );
    assert_eq!(
        discovered.len(),
        1,
        "discovered map must still have one entry"
    );
}

#[test]
fn process_discovery_unpaired_returns_none() {
    let event = make_resolved_event("UNKNOWN_PEER", 8443);
    let mut discovered = HashMap::new();
    let result = process_discovery_event(event, "LOCAL", &mut discovered, &[]);
    assert!(result.is_none(), "unpaired peer should not trigger sync");
    assert_eq!(
        discovered.len(),
        1,
        "peer should still be added to discovered map"
    );
}

#[test]
fn process_discovery_paired_returns_some() {
    let event = make_resolved_event("PAIRED_PEER", 8443);
    let mut discovered = HashMap::new();
    let peer_refs = vec![make_peer_ref("PAIRED_PEER")];
    let result = process_discovery_event(event, "LOCAL", &mut discovered, &peer_refs);
    assert!(result.is_some(), "new paired peer should trigger sync");
    let peer = result.unwrap();
    assert_eq!(peer.device_id, "PAIRED_PEER");
    assert_eq!(discovered.len(), 1);
}

// ── PERF-25: conditional daemon startup ──────────────────────────────
//
// `SyncDaemon::start_if_peers_exist` avoids starting mDNS + TLS listener
// when no paired peers exist. These tests exercise the peer-count helper
// and the dormant/active transition behaviour.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn should_start_active_returns_false_with_zero_peers() {
    let (pool, _dir) = test_pool().await;

    let start = SyncDaemon::should_start_active(&pool).await.unwrap();
    assert!(
        !start,
        "with no paired peers, SyncDaemon must remain dormant at startup"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn should_start_active_returns_true_with_one_peer() {
    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_ALPHA")
        .await
        .unwrap();

    let start = SyncDaemon::should_start_active(&pool).await.unwrap();
    assert!(
        start,
        "with a paired peer, SyncDaemon must start actively at startup"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn should_start_active_returns_true_with_many_peers() {
    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_A").await.unwrap();
    peer_refs::upsert_peer_ref(&pool, "PEER_B").await.unwrap();
    peer_refs::upsert_peer_ref(&pool, "PEER_C").await.unwrap();

    let start = SyncDaemon::should_start_active(&pool).await.unwrap();
    assert!(start, "multiple paired peers must trigger active startup");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_if_peers_exist_spawns_dormant_when_empty() {
    // When no peers are paired, the daemon task should NOT initialize
    // mDNS or the TLS listener. We verify this by:
    //   1. spawning `start_if_peers_exist` with an empty peer table,
    //   2. observing that the returned handle is alive (dormant task),
    //   3. shutting down cleanly.
    //
    // If the daemon had started in active mode, it would have bound a
    // random-port TLS listener and attempted mDNS init — both of which
    // are side effects we want to avoid. The dormant task has no such
    // side effects; it just polls `peer_refs`.
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let cert = sync_net::generate_self_signed_cert("DEV_LOCAL").unwrap();
    let event_sink: Arc<dyn crate::sync_events::SyncEventSink> =
        Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool,
        "DEV_LOCAL".into(),
        materializer,
        scheduler,
        cert,
        event_sink,
        cancel,
    )
    .await
    .unwrap();

    // The daemon is dormant but alive — it has a handle that will
    // terminate on shutdown.
    assert!(
        daemon.handle.is_some(),
        "dormant daemon must still hold a handle"
    );

    // Cleanly shutting down a dormant daemon must not hang.
    daemon.shutdown();
    let handle = daemon.handle;
    tokio::time::timeout(std::time::Duration::from_secs(5), async move {
        if let Some(h) = handle {
            let _ = h.await;
        }
    })
    .await
    .expect("dormant daemon must shut down within 5s");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_if_peers_exist_starts_actively_when_peers_present() {
    // With at least one paired peer, `start_if_peers_exist` must call the
    // full `start` path. We verify this indirectly: the returned daemon
    // runs the regular `daemon_loop`, which on test environments with no
    // mDNS support emits `SyncEvent::MdnsDisabled` via the event sink.
    // If the dormant waiter ran instead, no such event would be emitted
    // because mDNS init is deferred.
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_X").await.unwrap();

    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let cert = sync_net::generate_self_signed_cert("DEV_LOCAL").unwrap();
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn crate::sync_events::SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool,
        "DEV_LOCAL".into(),
        materializer,
        scheduler,
        cert,
        event_sink,
        cancel,
    )
    .await
    .unwrap();

    // Give the task a moment to make progress through daemon_loop init.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    daemon.shutdown();
    let handle = daemon.handle;
    tokio::time::timeout(std::time::Duration::from_secs(10), async move {
        if let Some(h) = handle {
            let _ = h.await;
        }
    })
    .await
    .expect("active daemon must shut down within 10s");
    // Note: we don't assert on the sink contents because mDNS may or may
    // not succeed in the test environment. The important observable is
    // that `start_if_peers_exist` went into the active `start` path and
    // did not deadlock.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dormant_daemon_wakes_on_pair_notification() {
    // `confirm_pairing_inner` calls `scheduler.notify_change()` after
    // persisting the peer. The dormant waiter selects on that notify
    // and on a periodic poll; the notify path transitions to active
    // much faster than the 30s poll.
    //
    // This test simulates the pair event by inserting a peer and then
    // calling notify_change, then asserts the daemon eventually
    // transitions off the dormant select branch (observable by the
    // daemon remaining alive and shutting down cleanly — the dormant
    // path only hits `peers_appeared` in the DB, and after the peer is
    // inserted the transition proceeds into `daemon_loop`).
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let cert = sync_net::generate_self_signed_cert("DEV_LOCAL").unwrap();
    let event_sink: Arc<dyn crate::sync_events::SyncEventSink> =
        Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool.clone(),
        "DEV_LOCAL".into(),
        materializer,
        scheduler.clone(),
        cert,
        event_sink,
        cancel,
    )
    .await
    .unwrap();

    // Simulate a pair event: insert a peer, then wake the dormant waiter.
    peer_refs::upsert_peer_ref(&pool, "PEER_NEW").await.unwrap();
    scheduler.notify_change();

    // Give the task a moment to transition.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    daemon.shutdown();
    let handle = daemon.handle;
    tokio::time::timeout(std::time::Duration::from_secs(10), async move {
        if let Some(h) = handle {
            let _ = h.await;
        }
    })
    .await
    .expect("daemon must shut down within 10s after pair notification");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peers_appeared_returns_false_on_empty_pool() {
    let (pool, _dir) = test_pool().await;

    let found = super::peers_appeared(&pool).await;
    assert!(
        !found,
        "peers_appeared must return false on empty peer table"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peers_appeared_returns_true_after_pair() {
    let (pool, _dir) = test_pool().await;

    assert!(!super::peers_appeared(&pool).await, "initially no peers");

    peer_refs::upsert_peer_ref(&pool, "PEER_FRESH")
        .await
        .unwrap();

    assert!(
        super::peers_appeared(&pool).await,
        "peers_appeared must return true after a peer is added"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dormant_daemon_unaffected_when_last_peer_removed() {
    // Once the daemon has transitioned to active, it keeps running even
    // if peers are later removed — `daemon_loop` does not re-check
    // `should_start_active` mid-run. This is the documented behaviour:
    // "graceful degradation" — the daemon stays up after initial
    // activation so future re-pairs don't require a restart.
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_TRANSIENT")
        .await
        .unwrap();

    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let cert = sync_net::generate_self_signed_cert("DEV_LOCAL").unwrap();
    let event_sink: Arc<dyn crate::sync_events::SyncEventSink> =
        Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool.clone(),
        "DEV_LOCAL".into(),
        materializer,
        scheduler,
        cert,
        event_sink,
        cancel,
    )
    .await
    .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Remove the only peer — daemon must still be alive and shutdown
    // cleanly.
    peer_refs::delete_peer_ref(&pool, "PEER_TRANSIENT")
        .await
        .unwrap();

    daemon.shutdown();
    let handle = daemon.handle;
    tokio::time::timeout(std::time::Duration::from_secs(10), async move {
        if let Some(h) = handle {
            let _ = h.await;
        }
    })
    .await
    .expect("daemon must continue running and shut down cleanly after peers removed");
}

// ── PERF-24: app-lifecycle integration ───────────────────────────────
//
// The daemon's periodic 30 s resync tick checks `lifecycle.is_foreground`
// before running its body. We exercise the gate at two levels:
//
// 1. `LifecycleHooks` in isolation — the atomic flag is shared between
//    clones (covered in `crate::lifecycle::tests`; smoke-asserted here
//    too to catch integration drift).
// 2. Full daemon startup — `start_with_lifecycle` completes and the
//    daemon shuts down cleanly regardless of initial foreground state.
//    We cannot wait 30 s for the resync tick in a unit test, but the
//    gate is also exercised by the isolated lifecycle test and by
//    dedicated unit tests in `crate::lifecycle` / `coordinator.rs`.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_with_lifecycle_accepts_backgrounded_initial_state() {
    install_crypto_provider();
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let cert = crate::sync_net::generate_self_signed_cert("DEV_LIFECYCLE_A").unwrap();

    let lifecycle = crate::lifecycle::LifecycleHooks::new();
    lifecycle.mark_backgrounded();
    assert!(
        lifecycle.is_backgrounded(),
        "test precondition: hooks must reflect backgrounded state"
    );

    let daemon = SyncDaemon::start_with_lifecycle(
        pool.clone(),
        "DEV_LIFECYCLE_A".into(),
        mat.clone(),
        scheduler,
        cert,
        sink,
        cancel,
        lifecycle.clone(),
    )
    .await
    .expect("daemon should start even when the app is backgrounded");

    // Let the daemon reach its select! loop.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    daemon.shutdown();

    let handle = daemon.handle;
    tokio::time::timeout(std::time::Duration::from_secs(10), async move {
        if let Some(h) = handle {
            let _ = h.await;
        }
    })
    .await
    .expect("daemon must shut down cleanly even when backgrounded at start");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_with_lifecycle_wake_notify_does_not_crash_daemon() {
    // Regression: the select! branch for `lifecycle.wake.notified()`
    // must not panic or leak the daemon when the wake fires while
    // foregrounded. We notify once and assert the daemon keeps running
    // until the explicit shutdown.
    install_crypto_provider();
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let cert = crate::sync_net::generate_self_signed_cert("DEV_LIFECYCLE_B").unwrap();

    let lifecycle = crate::lifecycle::LifecycleHooks::new();
    let daemon = SyncDaemon::start_with_lifecycle(
        pool.clone(),
        "DEV_LIFECYCLE_B".into(),
        mat.clone(),
        scheduler,
        cert,
        sink,
        cancel,
        lifecycle.clone(),
    )
    .await
    .expect("daemon should start");

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Simulate a background→foreground transition while the daemon is
    // running. The wake notify should cause the select! loop to
    // re-enter and reset the resync interval; it should NOT terminate
    // the daemon.
    lifecycle.mark_backgrounded();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    lifecycle.mark_foreground();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Daemon must still be alive. shutdown() terminates cleanly.
    daemon.shutdown();
    let handle = daemon.handle;
    tokio::time::timeout(std::time::Duration::from_secs(10), async move {
        if let Some(h) = handle {
            let _ = h.await;
        }
    })
    .await
    .expect("daemon must survive a wake-notify cycle");

    mat.shutdown();
}

#[tokio::test]
async fn lifecycle_default_from_start_is_equivalent_to_always_foreground() {
    // The non-lifecycle `start` variant constructs a
    // `LifecycleHooks::default()` internally. Assert the default
    // starts in foreground so legacy callers (tests, benches) observe
    // the same behaviour as before PERF-24.
    let hooks = crate::lifecycle::LifecycleHooks::default();
    assert!(
        !hooks.is_backgrounded(),
        "default lifecycle hooks must report foreground so the legacy `start` path runs tick bodies normally"
    );
}

// ======================================================================
// FEAT-6 — End-to-end snapshot-driven catch-up on ResetRequired
// ======================================================================

/// FEAT-6 — End-to-end: responder's op log has been compacted past the
/// initiator's advertised frontier, the initiator's HeadExchange
/// triggers `ResetRequired`, and the snapshot sub-flow catches the
/// initiator up to the responder's state.
///
/// Flow under test:
/// 1. Responder has a paired peer + a local op + a complete snapshot
///    in `log_snapshots`. Its op_log is compacted so any head the
///    initiator claims looks "lost".
/// 2. Initiator sends HeadExchange with a stale head for the responder
///    device that no longer exists in the responder's op_log.
/// 3. Responder's orchestrator returns `ResetRequired`; server.rs
///    then runs `try_offer_snapshot_catchup` which sends
///    `SnapshotOffer` and streams bytes on `SnapshotAccept`.
/// 4. Initiator's `run_sync_session` catches the `ResetRequired`,
///    runs `try_receive_snapshot_catchup`, accepts + applies.
/// 5. Verify: initiator's DB reflects the responder's block set and
///    `peer_refs.last_hash` is set to the snapshot's `up_to_hash`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn feat6_end_to_end_compact_then_snapshot_catchup() {
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::snapshot::create_snapshot;
    use crate::sync_net::test_connection_pair;
    use crate::ulid::BlockId;

    // ── Responder side: one materialized block + snapshot ────────────
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_mat = Materializer::new(resp_pool.clone());
    let resp_scheduler = Arc::new(SyncScheduler::new());
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Pair the initiator so responder doesn't reject as unpaired.
    peer_refs::upsert_peer_ref(&resp_pool, "FEAT6_INIT")
        .await
        .unwrap();

    // Seed + materialize one block on the responder.
    let record = append_local_op_at(
        &resp_pool,
        "FEAT6_RESP",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("FEAT6BLK001"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "compacted-state content".into(),
        }),
        "2025-01-15T12:00:00+00:00".into(),
    )
    .await
    .unwrap();
    resp_mat.dispatch_op(&record).await.unwrap();
    resp_mat.flush_foreground().await.unwrap();

    // M-58: also seed an op attributed to the initiator on the
    // responder side. In the real flow this would have been delivered
    // via a prior sync session; here we synthesize it directly so the
    // snapshot's `up_to_seqs` covers FEAT6_INIT as well as FEAT6_RESP.
    // Without this, M-58's covering check correctly rejects the offer
    // (snapshot would NOT cover the initiator's advertised FEAT6_INIT
    // head and applying it would silently wipe the initiator's own
    // op_log entry — see `apply_snapshot` which `DELETE FROM op_log`s).
    let init_record = append_local_op_at(
        &resp_pool,
        "FEAT6_INIT",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("FEAT6BLK002"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(2),
            content: "initiator-origin op already mirrored on responder".into(),
        }),
        "2025-01-15T12:00:01+00:00".into(),
    )
    .await
    .unwrap();
    resp_mat.dispatch_op(&init_record).await.unwrap();
    resp_mat.flush_foreground().await.unwrap();

    // Create a snapshot BEFORE simulating compaction. The snapshot
    // captures the current state of `blocks`, etc., and an
    // `up_to_seqs` of `{FEAT6_RESP: 1, FEAT6_INIT: 1}`.
    create_snapshot(&resp_pool, "FEAT6_RESP").await.unwrap();

    // Simulate compaction: wipe the responder's op_log so it cannot
    // satisfy any HeadExchange claim. In production this is what
    // `compact_op_log` would do after a 90-day cutoff.
    sqlx::query("DELETE FROM op_log")
        .execute(&resp_pool)
        .await
        .unwrap();

    // ── Initiator side: empty DB ─────────────────────────────────────
    let (init_pool, _init_dir) = test_pool().await;
    let init_mat = Materializer::new(init_pool.clone());
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Pair the responder on the initiator side (for peer_refs update
    // in the catch-up sub-flow).
    peer_refs::upsert_peer_ref(&init_pool, "FEAT6_RESP")
        .await
        .unwrap();

    // ── Wire the two sides together with an in-memory WebSocket ──────
    let (server_conn, mut client_conn) = test_connection_pair().await;

    // Responder: handle_incoming_sync. Needs a peer match on HeadExchange.
    let resp_pool_clone = resp_pool.clone();
    let resp_mat_clone = resp_mat.clone();
    let resp_scheduler_clone = resp_scheduler.clone();
    let resp_sink_clone = resp_sink.clone();
    let server_task = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            resp_pool_clone,
            "FEAT6_RESP".to_string(),
            resp_mat_clone,
            resp_scheduler_clone,
            resp_sink_clone,
        )
        .await
    });

    // Initiator side: we drive a minimal client manually through the
    // wire protocol to exercise the same code path as
    // `run_sync_session` without the full daemon scaffolding. The
    // initiator claims heads for BOTH devices at the seqs the
    // responder's snapshot recorded (1 each). The responder's op_log
    // is empty after the simulated compaction, so any head lookup
    // fails — `check_reset_required` returns true and the orchestrator
    // transitions to `ResetRequired`. M-58's covering check then
    // confirms the snapshot at `{FEAT6_RESP: 1, FEAT6_INIT: 1}` covers
    // the initiator's frontier and lets the offer proceed.
    let init_self_head = DeviceHead {
        device_id: "FEAT6_INIT".into(),
        seq: 1,
        hash: "fake_init_hash".into(),
    };
    let stale_resp_head = DeviceHead {
        device_id: "FEAT6_RESP".into(),
        seq: 1, // present in snapshot's frontier; absent from compacted op_log
        hash: "fake_resp_hash".into(),
    };
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![init_self_head, stale_resp_head],
        })
        .await
        .unwrap();

    // Responder must reply with ResetRequired.
    let reset: SyncMessage = client_conn.recv_json().await.unwrap();
    match reset {
        SyncMessage::ResetRequired { .. } => {}
        other => panic!("expected ResetRequired, got {:?}", other),
    }

    // Now emulate what `run_sync_session` does after seeing
    // ResetRequired: run the initiator-side catch-up helper. We use
    // the public helper directly so the test does not depend on the
    // mDNS / TLS scaffolding; the wiring in `run_sync_session` is
    // covered by the shorter sub-flow tests in the snapshot_transfer
    // module.
    let outcome = crate::sync_daemon::snapshot_transfer::try_receive_snapshot_catchup(
        &mut client_conn,
        &init_pool,
        &init_mat,
        &init_sink,
        "FEAT6_RESP",
    )
    .await
    .expect("catch-up must succeed end-to-end");

    match outcome {
        crate::sync_daemon::snapshot_transfer::CatchupOutcome::Applied { up_to_hash, .. } => {
            assert!(
                !up_to_hash.is_empty(),
                "snapshot up_to_hash must be populated"
            );
        }
        other => panic!("expected Applied, got {:?}", other),
    }

    // Let the server task finish cleanly.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), server_task).await;

    init_mat.flush_background().await.unwrap();

    // ── Verify: initiator now has the snapshot's blocks ───────────────
    // The snapshot covers both seeded ops (FEAT6_RESP's and the
    // mirrored FEAT6_INIT op added in the M-58 setup), so the
    // initiator's `blocks` table should hold both rows post-apply.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        count, 2,
        "initiator must have both blocks from the responder's snapshot"
    );

    let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = 'FEAT6BLK001'")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        content, "compacted-state content",
        "FEAT6BLK001 content must match the responder's pre-compaction state"
    );

    // peer_refs bookkeeping was updated on the initiator side.
    let peer = peer_refs::get_peer_ref(&init_pool, "FEAT6_RESP")
        .await
        .unwrap()
        .expect("peer_refs row must exist after snapshot catch-up");
    assert!(
        peer.synced_at.is_some(),
        "synced_at must be populated after catch-up"
    );

    resp_mat.shutdown();
    init_mat.shutdown();
}
