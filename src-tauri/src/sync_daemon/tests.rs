use super::*;
use crate::db::init_pool;
use crate::error::AppError;
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

/// TEST-4 — generic polling barrier for `SyncDaemon` / `SyncScheduler` tests.
///
/// Repeatedly evaluates `predicate` every 5 ms until it returns `true` or
/// `timeout` elapses, in which case it panics with `label` for triage.
///
/// Use this in place of a `tokio::time::sleep(…)` "barrier" whenever the
/// test has an observable predicate it can poll (e.g.
/// `scheduler.failure_count(peer) >= 1`, `daemon.handle.is_finished()`,
/// `sink.events().iter().any(…)`). Pick `timeout` generously (rule of
/// thumb: 4× the original sleep) so the converted test still fails fast
/// on a real hang rather than masking a regression.
///
/// If no observable predicate exists for a given sleep, leave the sleep
/// in place with a `// TEST-4: no observable predicate available` comment
/// — a blind `|| true` predicate would just hide the same race.
async fn wait_for<F>(mut predicate: F, timeout: std::time::Duration, label: &'static str)
where
    F: FnMut() -> bool,
{
    let start = std::time::Instant::now();
    loop {
        if predicate() {
            return;
        }
        if start.elapsed() >= timeout {
            panic!("wait_for({label}) timed out after {:?}", timeout);
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
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

// The drain pattern (handle_message returns first message;
// next_message drains the rest) is covered for `LoroSync` by the
// `loro_sync_e2e_*` tests in `sync_protocol::tests`.

// ── S-1: peer_refs helper lookup test ───────────────────────────────

/// Verify the peer_refs helper: get_peer_ref returns None for unknown
/// devices and Some for paired devices. The full rejection path (where
/// None triggers a connection refusal) is covered by
/// `inmem_handle_incoming_sync_rejects_unpaired`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peer_ref_lookup_returns_none_for_unknown_device() {
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
fn issue800_certless_claim_of_pinned_peer_rejected() {
    // #800: a cert-less connection (no cert CN, no observed hash) claiming
    // a peer that IS already cert-pinned (stored hash exists) must be
    // rejected — not silently accepted. Pre-#800 this returned `Ok`
    // because B-33's hash check requires BOTH observed AND stored, so the
    // absent observed hash skipped the pin entirely, granting a full
    // session under a stolen identity.
    let result = verify_peer_cert(
        "device-A",
        None,         // no cert CN (cert-less / anonymous)
        None,         // no observed hash (no client cert presented)
        Some("aaaa"), // stored hash exists → peer is cert-pinned
    );
    assert_eq!(
        result,
        CertVerifyResult::MissingCert {
            remote_id: "device-A".into()
        },
        "#800: cert-less connection claiming a cert-pinned peer must be rejected"
    );
}

#[test]
fn issue800_no_stored_hash_allows_certless_pairing() {
    // #800 control: when the peer is NOT yet pinned (no stored hash —
    // initial pairing / pre-TOFU first connect), a cert-less connection is
    // still allowed through the cert gate. This is the only legitimate
    // anonymous flow and must not be broken by the #800 rejection.
    let result = verify_peer_cert(
        "device-A", None, // no cert CN
        None, // no observed hash
        None, // NOT pinned yet
    );
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "#800: a not-yet-pinned peer may connect anonymously (pairing / TOFU first connect)"
    );
}

#[test]
fn issue800_pinned_peer_with_matching_cert_accepted() {
    // #800 control: an existing paired device that DOES present its cert
    // (observed hash matches the pinned stored hash) is accepted — the
    // rejection targets *missing* certs, never legitimate reconnections.
    let result = verify_peer_cert(
        "device-A",
        Some("device-A"),
        Some("aaaa"), // observed cert hash present
        Some("aaaa"), // matches the pinned stored hash
    );
    assert_eq!(
        result,
        CertVerifyResult::Ok,
        "#800: a pinned peer presenting its matching cert must still be accepted"
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

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_DEV",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

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

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_DEV",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    // Wrap in timeout to prevent test from hanging if connect blocks
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        try_sync_with_peer(&ctx, &peer, &refs),
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

    // Second event: Error — `SyncEvent::Error.message` is unstructured `String`,
    // so combine the variant pin (matches!) with a substring check for the failure category.
    assert!(
        matches!(
            &events[1],
            SyncEvent::Error { message, remote_device_id }
                if message.contains("Connection failed")
                    && remote_device_id.as_str() == "PEER_UNREACHABLE"
        ),
        "expected SyncEvent::Error mentioning 'Connection failed' for PEER_UNREACHABLE, got: {:?}",
        &events[1]
    );

    // Scheduler records the failure
    assert_eq!(
        scheduler.failure_count("PEER_UNREACHABLE"),
        1,
        "one failure should be recorded after connection failure"
    );

    materializer.shutdown();
}

/// Test 3: When the connecting client's TLS certificate CN is the
/// responder's OWN device_id, the responder sends
/// `SyncMessage::Error("cannot sync with self")` and returns Ok.
///
/// #778: identity now comes from the verified cert CN, not from the
/// advertised heads — so the self-sync case is "the cert CN IS our own
/// device", not "the heads only mention our own device".
///
/// Uses a real loopback TLS WebSocket connection pair.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_sync_with_self() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Generate certs for server (responder) and client (initiator).
    // The client presents a cert whose CN is the responder's OWN
    // device_id — a genuine self-sync (e.g. a device connecting to
    // itself through a stale mDNS record).
    let server_cert = sync_net::generate_self_signed_cert("LOCAL_DEV").unwrap();
    let client_cert = sync_net::generate_self_signed_cert("LOCAL_DEV").unwrap();

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

    // Send HeadExchange with only LOCAL_DEV. The heads claim no
    // foreign identity, so the cert CN ("LOCAL_DEV" — our own
    // device_id) is the identity → self-sync rejection (#778).
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "LOCAL_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    // Receive the rejection response — `SyncMessage::Error.message` is
    // unstructured `String`, so combine the variant pin (matches!) with a
    // substring check for the rejection reason.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("cannot sync with self")
        ),
        "expected SyncMessage::Error mentioning 'cannot sync with self', got: {response:?}"
    );

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
    // `AppError::InvalidOperation` carries an unstructured `String`, so combine
    // the variant pin (matches!) with a substring check for the cancellation reason.
    let err = result.unwrap_err();
    assert!(
        matches!(&err, AppError::InvalidOperation(msg) if msg.contains("sync cancelled by user")),
        "expected AppError::InvalidOperation mentioning 'sync cancelled by user', got: {err:?}"
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

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

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

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

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
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    // Receive rejection response — `SyncMessage::Error.message` is unstructured
    // `String`, so combine the variant pin (matches!) with a substring check.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("not paired")
        ),
        "expected SyncMessage::Error mentioning 'not paired' for unpaired device, got: {response:?}"
    );

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting unpaired device"
    );

    server.shutdown().await;
    materializer.shutdown();
}

/// S-11 / #637: When `try_sync_with_peer` exits via the connection-failure
/// path it runs NO real session, so it does NOT own the cancel and must
/// LEAVE a pre-set (user) cancel flag intact — otherwise an early-exiting
/// peer would swallow a cancel aimed at a still-running sibling. The guard
/// only clears the flag once a real session was reached (`owns == true`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_preserves_cancel_flag_after_connection_failure() {
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

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_DEV",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await;

    assert!(result.is_ok(), "must complete within timeout");

    // #637: connection-failure early-exit ran no session → must NOT clear a
    // pre-set user cancel (it could be aimed at a still-running sibling).
    assert!(
        cancel.load(Ordering::Acquire),
        "#637: connection-failure early-exit must PRESERVE a pre-set cancel flag"
    );

    // Verify we got the error event (connection failed)
    let events = sink.events();
    assert_eq!(events.len(), 2, "should emit connecting + error events");

    materializer.shutdown();
}

// ======================================================================
// S-11 / #637 — Cancel flag ownership on early-exit paths
//
// Original S-11 invariant ("clear the flag on every exit path") was unsafe
// once Branch B started spawning one task per peer against a single SHARED
// cancel flag: an early-exiting task would clear a user cancel aimed at a
// still-running sibling (#637). The corrected invariant: only a task that
// actually ran a real session OWNS the cancel and clears it; early-exit
// paths (backoff / lock / no-address / connect failure) PRESERVE a pre-set
// flag so a sibling-targeted cancel survives.
// ======================================================================

/// S-11 / #637: the backoff-gate early return runs no session, so it must
/// PRESERVE a pre-set user cancel (it may be aimed at a still-running
/// sibling) — not clear it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s11_cancel_preserved_on_backoff_early_exit() {
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

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

    assert!(
        cancel.load(Ordering::Acquire),
        "#637: backoff early-exit must PRESERVE a pre-set cancel flag"
    );

    materializer.shutdown();
}

/// S-11 / #637: the already-syncing (per-peer lock held) early return runs
/// no session here, so it must PRESERVE a pre-set user cancel rather than
/// clear a sibling's cancel.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s11_cancel_preserved_on_already_syncing_early_exit() {
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

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

    assert!(
        cancel.load(Ordering::Acquire),
        "#637: already-syncing early-exit must PRESERVE a pre-set cancel flag"
    );

    materializer.shutdown();
}

/// S-11 / #637: the no-addresses early return runs no session, so it must
/// PRESERVE a pre-set user cancel rather than clear a sibling's cancel.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s11_cancel_preserved_on_no_addresses_early_exit() {
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

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

    assert!(
        cancel.load(Ordering::Acquire),
        "#637: no-addresses early-exit must PRESERVE a pre-set cancel flag"
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

/// T-16 Test 1 (#778): A connection whose TLS certificate CN equals the
/// local device_id triggers the self-sync rejection branch — identity
/// comes from the verified cert CN, not from the advertised heads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_self() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let (mut server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    // The "remote" presents a cert whose CN is our OWN device_id.
    server_conn.set_test_cert(Some("LOCAL_DEV".to_string()), None);

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

    // The heads claim no foreign identity (only the local device's
    // head), so the cert CN "LOCAL_DEV" is the identity → self-sync.
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "LOCAL_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    // `SyncMessage::Error.message` is unstructured `String`, so combine the
    // variant pin (matches!) with a substring check for the rejection reason.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("self")
        ),
        "expected SyncMessage::Error mentioning self-sync, got: {response:?}"
    );

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting self-sync"
    );

    materializer.shutdown();
}

/// T-16 Test 1b (#778): degenerate case — no client certificate AND no
/// foreign head (empty heads list). The session cannot be attributed to
/// any peer, so the responder sends `Error("cannot identify remote
/// device")` and returns Ok. Before #778 this case was misreported as
/// "cannot sync with self".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_unidentifiable_peer() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // In-memory pair → no TLS cert → `peer_cert_cn()` is None.
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

    // Empty heads (a fresh device's HeadExchange) + no cert: there is
    // nothing to identify the peer by.
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![],
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("cannot identify")
        ),
        "expected SyncMessage::Error mentioning 'cannot identify', got: {response:?}"
    );

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting unidentifiable peer"
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
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    // `SyncMessage::Error.message` is unstructured `String`, so combine the
    // variant pin (matches!) with a substring check for the rejection reason.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("not paired")
        ),
        "expected SyncMessage::Error mentioning 'not paired' for unpaired device, got: {response:?}"
    );

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
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    // `SyncMessage::Error.message` is unstructured `String`, so combine the
    // variant pin (matches!) with a substring check for the rejection reason.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("busy")
        ),
        "expected SyncMessage::Error mentioning 'busy' for already-locked peer, got: {response:?}"
    );

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
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    // Receive rejection response — `SyncMessage::Error.message` is unstructured
    // `String`, so combine the variant pin (matches!) with a substring check.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("certificate")
        ),
        "expected SyncMessage::Error mentioning 'certificate' for CN mismatch, got: {response:?}"
    );

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
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    // Receive rejection response — `SyncMessage::Error.message` is unstructured
    // `String`, so combine the variant pin (matches!) with a substring check.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("hash mismatch")
        ),
        "expected SyncMessage::Error mentioning 'hash mismatch', got: {response:?}"
    );

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting hash mismatch"
    );

    materializer.shutdown();
}

/// #800 (security): a connection presenting NO client certificate
/// (cert-less / anonymous) that claims a paired device id whose
/// `cert_hash` is already pinned must be rejected before any session
/// runs.
///
/// Attack shape (pre-#800): the acceptor allows anonymous TLS
/// (`client_auth_mandatory = false`), so a cert-less socket reaches
/// `handle_incoming_sync`. Identity falls back to the heads-claimed
/// device id; the pairing lookup passes (it IS a paired peer), and
/// B-33's hash check is silently skipped because the *observed* hash is
/// `None` without a cert — even though a `cert_hash` is stored. Result:
/// a full session under a stolen identity.
///
/// This drives the REAL `handle_incoming_sync` responder over an
/// in-memory wire with `set_test_cert(None, None)` — exactly the
/// `peer_cert_cn() == None` / `peer_cert_hash() == None` shape that
/// `SyncServer` produces for a genuinely cert-less TLS connection (see
/// `sync_net::tests::mtls_server_extracts_peer_cert_hash` for the real
/// extraction) — and asserts the responder refuses with a "client
/// certificate required" error instead of proceeding.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_certless_claim_of_pinned_peer_800() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // The victim peer is fully paired AND cert-pinned (a stored cert_hash
    // exists from a prior authenticated connection).
    peer_refs::upsert_peer_ref_with_cert(&pool, "REMOTE_PAIRED", "victim_pinned_hash")
        .await
        .unwrap();

    // Cert-less attacker: no client cert → both CN and hash are None,
    // exactly as `SyncServer` reports for an anonymous TLS socket.
    let (mut server_conn, mut client_conn) = sync_net::test_connection_pair().await;
    server_conn.set_test_cert(None, None);

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

    // The attacker claims the victim's paired identity through the heads.
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "REMOTE_PAIRED".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
            loro_vvs: vec![],
        })
        .await
        .unwrap();

    // Must be rejected — pre-#800 this returned an `OpBatch`/`Snapshot`
    // (a live session), bypassing pinning.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("client certificate required")
        ),
        "#800: cert-less claim of a pinned peer must be rejected with a \
         'client certificate required' error, got: {response:?}"
    );

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting the cert-less claim"
    );

    materializer.shutdown();
}

// TOFU coverage: cert verification runs before protocol dispatch and
// is exercised by
// `inmem_handle_incoming_sync_rejects_cert_cn_mismatch` /
// `inmem_handle_incoming_sync_rejects_cert_hash_mismatch`.

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
/// fix (L-62).
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

    // TEST-4: no observable predicate available — sleep retained.
    // We just want the spawned daemon task to make a turn in its select!
    // loop before we issue shutdown. There is no production-side signal
    // exposing "select! loop entered", and adding one to the production
    // type just for this test is out of scope (TEST-4).
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Shutdown should exit cleanly
    daemon.shutdown();

    // TEST-4: poll until the spawned task finishes; 4× cap on the
    // original 200 ms guess so a real hang fails fast.
    wait_for(
        || {
            daemon
                .handle
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
        },
        std::time::Duration::from_millis(800),
        "daemon_start_and_shutdown: handle.is_finished()",
    )
    .await;

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

    // TEST-4: no observable predicate available — sleep retained.
    // cancel_active_sync() is a fire-and-forget atomic store; the
    // observable "daemon noticed and is still alive" requires a tick
    // through the select! loop with no production-side signal.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Daemon should still be running — shutdown it cleanly
    daemon.shutdown();
    // TEST-4: poll until the spawned task finishes; 4× cap on the
    // original 200 ms guess.
    wait_for(
        || {
            daemon
                .handle
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
        },
        std::time::Duration::from_millis(800),
        "daemon_cancel_does_not_trigger_shutdown: handle.is_finished()",
    )
    .await;

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

    // TEST-4: no observable predicate available — sleep retained.
    // Both daemons need a turn in their select! loop after start; no
    // production-side "loop entered" signal exists.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    d1.shutdown();
    d2.shutdown();
    // TEST-4: poll until BOTH daemon tasks finish; 4× cap on 200 ms.
    wait_for(
        || {
            d1.handle
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
                && d2
                    .handle
                    .as_ref()
                    .is_none_or(tokio::task::JoinHandle::is_finished)
        },
        std::time::Duration::from_millis(800),
        "two_daemons_start_on_different_ports: both handles finished",
    )
    .await;

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

    // TEST-4: no observable predicate available — sleep retained.
    // We need the daemon to (a) enter daemon_loop, (b) let Branch C's
    // immediate first resync tick fire and find zero peers (no-op), and
    // (c) sit on the next debounce wait. None of these transitions are
    // exposed to test code, so we still rely on a fixed wait here.
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

    // TEST-4: poll until the unreachable peer accumulates a failure, with a
    // 4× cap on the original 800 ms guess so a real hang fails fast.
    {
        let sched = scheduler.clone();
        wait_for(
            move || sched.failure_count("REMOTE_PEER") >= 1,
            std::time::Duration::from_millis(3200),
            "branch_b: REMOTE_PEER failure_count >= 1",
        )
        .await;
    }

    // Verify the scheduler recorded a failure for REMOTE_PEER
    // (try_sync_with_peer couldn't connect → record_failure was called).
    let failure_count = scheduler.failure_count("REMOTE_PEER");
    assert!(
        failure_count >= 1,
        "Branch B should have triggered a sync attempt that failed, got failure_count={failure_count}"
    );

    daemon.shutdown();
    // TEST-4: poll until the spawned task finishes; 4× cap on 200 ms.
    wait_for(
        || {
            daemon
                .handle
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
        },
        std::time::Duration::from_millis(800),
        "branch_b: handle.is_finished()",
    )
    .await;
    mat.shutdown();
}

/// L-61 smoke test: Branch B must dispatch ALL paired peers, not just
/// the first one. Pre-L-61 the loop was `for peer_ref in &refs { ...
/// .await; }`, so a hypothetical regression that dropped peers 2+ from
/// the iteration would still pass the single-peer
/// `daemon_branch_b_local_change_triggers_sync_attempt` above. This
/// test pins down "all peers in the round get a sync attempt" with two
/// unreachable peers and asserts BOTH end up with a recorded failure.
///
/// We do NOT directly assert wall-clock parallelism here: the existing
/// harness has no virtual-time hooks for `try_sync_with_peer` and
/// 127.0.0.1:1 connection refusals are sub-millisecond, so a sequential
/// vs concurrent dispatch is indistinguishable on the wire. The
/// concurrency property is guaranteed by the structural shift to
/// `JoinSet::spawn`; what this test verifies is the smoke property
/// that the new code dispatches every peer rather than dropping any.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_branch_b_dispatches_all_peers_in_round_l61() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::with_intervals(
        std::time::Duration::from_millis(100),
        std::time::Duration::from_secs(60),
    ));
    let sink = Arc::new(RecordingEventSink::new());
    let sink_dyn: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let cert = crate::sync_net::generate_self_signed_cert("BRANCH_B_L61_DEV").unwrap();

    let daemon = SyncDaemon::start(
        pool.clone(),
        "BRANCH_B_L61_DEV".into(),
        mat.clone(),
        scheduler.clone(),
        cert,
        sink_dyn,
        cancel,
    )
    .await
    .unwrap();

    // TEST-4: no observable predicate available — sleep retained.
    // Same rationale as the sibling branch_b test above: we need the
    // daemon to enter its loop and let Branch C's first tick pass on an
    // empty peer table before we insert peers, and the daemon doesn't
    // expose that transition to test code.
    // Let startup complete and Branch C's first tick pass (no peers → no-op).
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Insert TWO peer refs, both with unreachable addresses.  Pre-L-61
    // the sequential loop visited them one at a time; post-L-61 the
    // JoinSet visits them concurrently.  Either way, both must
    // accumulate a failure.
    for peer_id in ["REMOTE_PEER_1", "REMOTE_PEER_2"] {
        peer_refs::upsert_peer_ref(&pool, peer_id).await.unwrap();
        sqlx::query("UPDATE peer_refs SET last_address = '127.0.0.1:1' WHERE peer_id = ?")
            .bind(peer_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    // Trigger Branch B by notifying a local change.
    scheduler.notify_change();

    // TEST-4: poll until BOTH unreachable peers accumulate a failure (the
    // regression guard from L-61). 4× cap on the original 800 ms guess.
    {
        let sched = scheduler.clone();
        wait_for(
            move || {
                sched.failure_count("REMOTE_PEER_1") >= 1
                    && sched.failure_count("REMOTE_PEER_2") >= 1
            },
            std::time::Duration::from_millis(3200),
            "branch_b_l61: both peers failure_count >= 1",
        )
        .await;
    }

    let f1 = scheduler.failure_count("REMOTE_PEER_1");
    let f2 = scheduler.failure_count("REMOTE_PEER_2");
    assert!(
        f1 >= 1,
        "Branch B must dispatch peer 1; got failure_count={f1}"
    );
    assert!(
        f2 >= 1,
        "Branch B must dispatch peer 2 (regression guard for L-61 \
         concurrent dispatch dropping later peers); got failure_count={f2}"
    );

    daemon.shutdown();
    // TEST-4: poll until the spawned task finishes; 4× cap on 200 ms.
    wait_for(
        || {
            daemon
                .handle
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
        },
        std::time::Duration::from_millis(800),
        "branch_b_l61: handle.is_finished()",
    )
    .await;
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

    // TEST-4: poll until the first resync tick fires and the unreachable
    // OVERDUE_PEER accumulates a failure. 4× cap on the original 800 ms guess.
    {
        let sched = scheduler.clone();
        wait_for(
            move || sched.failure_count("OVERDUE_PEER") >= 1,
            std::time::Duration::from_millis(3200),
            "branch_c: OVERDUE_PEER failure_count >= 1",
        )
        .await;
    }

    // Check if a sync was attempted (failure recorded since port 1 is unreachable).
    let failure_count = scheduler.failure_count("OVERDUE_PEER");
    assert!(
        failure_count >= 1,
        "Branch C should have triggered a resync attempt for overdue peer, got failure_count={failure_count}"
    );

    daemon.shutdown();
    // TEST-4: poll until the spawned task finishes; 4× cap on 200 ms.
    wait_for(
        || {
            daemon
                .handle
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
        },
        std::time::Duration::from_millis(800),
        "branch_c: handle.is_finished()",
    )
    .await;
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
// when no paired peers exist. These tests exercise the peer-count helper,
// the pending-pairing wake path (#466), and the dormant/active transition.

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
async fn should_start_active_true_when_pairing_pending() {
    // PEND-76 F3: a just-completed pairing (no real peer yet) must wake the
    // dormant daemon so it can accept the first inbound connection.
    let (pool, _dir) = test_pool().await;
    peer_refs::set_pending_pairing(&pool).await.unwrap();

    let start = SyncDaemon::should_start_active(&pool).await.unwrap();
    assert!(
        start,
        "a pending pairing (no peers yet) must trigger active startup"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn should_start_active_clears_pending_marker_once_a_real_peer_exists() {
    // Once a real peer is established, the pending-pairing bridge is redundant
    // and should be cleared (hygiene) while still reporting active.
    let (pool, _dir) = test_pool().await;
    peer_refs::set_pending_pairing(&pool).await.unwrap();
    peer_refs::upsert_peer_ref(&pool, "PEER_REAL")
        .await
        .unwrap();

    let start = SyncDaemon::should_start_active(&pool).await.unwrap();
    assert!(start, "a real peer must trigger active startup");
    assert!(
        !peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "the pending-pairing marker must be cleared once a real peer exists"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peers_appeared_returns_true_on_pending_pairing_with_no_peer_rows() {
    // #466: the dormant waiter must wake when confirm_pairing sets the
    // pending-pairing marker even if no real peer row exists yet.
    // Before the fix, peers_appeared only checked list_peer_refs and
    // returned false here, leaving the daemon dormant forever.
    let (pool, _dir) = test_pool().await;
    peer_refs::set_pending_pairing(&pool).await.unwrap();

    // peers_appeared is private; exercise it via should_start_active
    // which is the same gate it now delegates to.
    let active = SyncDaemon::should_start_active(&pool).await.unwrap();
    assert!(
        active,
        "dormant waiter must transition to active when pending-pairing marker is set"
    );
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

    // TEST-4: no observable predicate available — sleep retained.
    // We want the daemon task to enter daemon_loop init (so this asserts
    // the "active" path was taken, not the dormant waiter). The daemon
    // does not surface the dormant→active transition to test code; the
    // post-shutdown timeout-await below is the actual liveness assertion
    // for the active path.
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

    // TEST-4: no observable predicate available — sleep retained.
    // The dormant→active transition isn't exposed to test code (it
    // happens inside the dormant waiter and continues into daemon_loop).
    // The shutdown-then-timeout pattern below is the actual liveness
    // assertion: a hung dormant task would surface there.
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

    // TEST-4: no observable predicate available — sleep retained.
    // We want the daemon to have transitioned past initial peer-presence
    // detection into daemon_loop before we delete the peer. That
    // transition isn't surfaced to test code.
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

    // TEST-4: no observable predicate available — sleep retained.
    // The "select! loop entered" signal isn't exposed; the post-shutdown
    // timeout-await is the actual liveness assertion.
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

    // TEST-4: no observable predicate available — sleep retained.
    // We need the daemon's select! loop to be running before we toggle
    // lifecycle state, but the daemon doesn't expose that. The actual
    // liveness assertion is the post-shutdown timeout-await below.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Simulate a background→foreground transition while the daemon is
    // running. The wake notify should cause the select! loop to
    // re-enter and reset the resync interval; it should NOT terminate
    // the daemon.
    lifecycle.mark_backgrounded();
    // TEST-4: no observable predicate available — sleep retained.
    // mark_backgrounded() is a fire-and-forget atomic; the wake notify's
    // effect on the select! loop isn't surfaced to test code.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    lifecycle.mark_foreground();

    // TEST-4: no observable predicate available — sleep retained.
    // Same rationale as the background sleep above — we want both wake
    // notifies to be processed by the select! loop before we shut down,
    // but the daemon doesn't expose that.
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
            index: None,
            content: "compacted-state content".into(),
        }),
        1_736_942_400_000,
    )
    .await
    .unwrap();
    resp_mat.dispatch_op(&record).await.unwrap();
    resp_mat.flush_foreground().await.unwrap();

    // #602: NO op is hand-seeded into the responder's op_log for the
    // initiator's device any more. Post-#490-M1 the op_log is strictly
    // device-local (only `append_local_op*` writes it; inbound sync
    // lands remote state via the Loro engine + SQL projection, never
    // the op_log), so a responder NEVER holds rows for the initiator's
    // device — the old hand-seed here ("delivered via a prior sync
    // session", a flow that no longer exists) masked exactly the #602
    // bug. The snapshot's `up_to_seqs` is therefore `{FEAT6_RESP: 1}`
    // only — the shape a real responder produces.

    // Create a snapshot BEFORE simulating compaction. The snapshot
    // captures the current state of `blocks`, etc., and an
    // `up_to_seqs` of `{FEAT6_RESP: 1}`.
    create_snapshot(&resp_pool, "FEAT6_RESP").await.unwrap();

    // Simulate compaction: wipe the responder's op_log so it cannot
    // satisfy any HeadExchange claim. In production this is what
    // `compact_op_log` would do after a 90-day cutoff.
    //
    // H-13: op_log mutations now require the compaction bypass. Wrap the
    // DELETE in the same enable/disable dance the real compaction path
    // uses so the BEFORE DELETE trigger (migration 0036) permits it.
    let mut tx = resp_pool.begin().await.unwrap();
    crate::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM op_log")
        .execute(&mut *tx)
        .await
        .unwrap();
    crate::op_log::disable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

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
    // `run_sync_session` without the full daemon scaffolding.
    //
    // #602: the initiator advertises its own device at seq 0 (it has no
    // local ops — its DB is empty; the head also serves as the wire-
    // level peer identification that production additionally gets from
    // the TLS cert CN) plus a STALE claim on the responder's own
    // history at seq 1. The responder's op_log is empty after the
    // simulated compaction, so `check_reset_required`'s own-device
    // lookup for `(FEAT6_RESP, 1)` fails — the orchestrator transitions
    // to `ResetRequired` (the one genuine reset case the local op_log
    // can still detect post-#490-M1: the peer observed ops we authored
    // but no longer have). M-58's covering check then confirms the
    // snapshot at `{FEAT6_RESP: 1}` covers the initiator's frontier
    // (seq-0 self head is trivially covered) and lets the offer
    // proceed. Had the initiator claimed own ops (seq >= 1), M-58 would
    // — correctly — refuse, because applying the snapshot wipes the
    // initiator's op_log (see
    // `try_offer_snapshot_catchup_sends_error_when_snapshot_behind_remote`).
    let init_self_head = DeviceHead {
        device_id: "FEAT6_INIT".into(),
        seq: 0,
        hash: String::new(),
    };
    let stale_resp_head = DeviceHead {
        device_id: "FEAT6_RESP".into(),
        seq: 1, // present in snapshot's frontier; absent from compacted op_log
        hash: "fake_resp_hash".into(),
    };
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![init_self_head, stale_resp_head],
            loro_vvs: vec![],
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
        None,
        None,
    )
    .await
    .expect("catch-up must succeed end-to-end");

    let applied_up_to_hash = match outcome {
        crate::sync_daemon::snapshot_transfer::CatchupOutcome::Applied { up_to_hash, .. } => {
            assert!(
                !up_to_hash.is_empty(),
                "snapshot up_to_hash must be populated"
            );
            up_to_hash
        }
        other => panic!("expected Applied, got {:?}", other),
    };

    // Let the server task finish cleanly.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), server_task).await;

    init_mat.flush_background().await.unwrap();

    // ── Verify: initiator now has the snapshot's blocks ───────────────
    // The snapshot covers the responder's seeded op only (#602: nothing
    // is hand-mirrored into the responder's op_log for FEAT6_INIT any
    // more), so the initiator's `blocks` table holds exactly that row
    // post-apply.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "initiator must have the responder's snapshot block"
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
    assert_eq!(
        peer.last_hash,
        Some(applied_up_to_hash),
        "last_hash must be advanced to the snapshot's up_to_hash after catch-up"
    );

    resp_mat.shutdown();
    init_mat.shutdown();
}

// ======================================================================
// #602 — two devices with local edits must converge via normal sessions
// ======================================================================

/// Serde round-trip a message through its JSON wire encoding — exactly
/// what `SyncConnection::send_json` / `recv_json` do on the real
/// transport.
fn wire_roundtrip_602(msg: &SyncMessage) -> SyncMessage {
    let json = serde_json::to_string(msg).expect("serialize SyncMessage");
    serde_json::from_str(&json).expect("deserialize SyncMessage")
}

/// Drive one full initiator↔responder session at the protocol layer,
/// mirroring the message loops of `run_sync_session` (initiator) and
/// `handle_incoming_sync` (responder): each side feeds incoming
/// messages to `handle_message`, forwards the reply, and drains
/// `next_message` — until neither side has anything left to deliver.
async fn pump_full_session_602(
    initiator: &mut crate::sync_protocol::SyncOrchestrator,
    responder: &mut crate::sync_protocol::SyncOrchestrator,
) {
    use std::collections::VecDeque;
    let first = initiator.start().await.expect("initiator start");
    let mut to_responder: VecDeque<SyncMessage> = VecDeque::from([wire_roundtrip_602(&first)]);
    let mut to_initiator: VecDeque<SyncMessage> = VecDeque::new();
    loop {
        let mut progressed = false;
        while let Some(msg) = to_responder.pop_front() {
            progressed = true;
            if let Some(resp) = responder
                .handle_message(msg)
                .await
                .expect("responder handle_message")
            {
                to_initiator.push_back(wire_roundtrip_602(&resp));
            }
            while let Some(m) = responder.next_message() {
                to_initiator.push_back(wire_roundtrip_602(&m));
            }
        }
        while let Some(msg) = to_initiator.pop_front() {
            progressed = true;
            if let Some(resp) = initiator
                .handle_message(msg)
                .await
                .expect("initiator handle_message")
            {
                to_responder.push_back(wire_roundtrip_602(&resp));
            }
            while let Some(m) = initiator.next_message() {
                to_responder.push_back(wire_roundtrip_602(&m));
            }
        }
        if !progressed {
            break;
        }
    }
}

/// #602: make ONE local edit on a device through the real local-edit
/// pipeline: op_log append (`append_local_op_at`, the only legitimate
/// op_log writer) → materializer SQL projection (`dispatch_op`) →
/// engine dispatch (`merge::engine_apply` — the same dispatcher the
/// production in-tx via-loro apply mirrors, invoked here against
/// THIS device's registry because the process-global `OnceLock`
/// registry cannot represent two devices in one test process).
///
/// Crucially this seeds ONLY the device's own state — nothing is ever
/// hand-written into the PEER's op_log (post-#490-M1 no real flow does).
// #639: surfaced once clippy began linting test targets (`--all-targets`).
// This is a test fixture that mirrors the local-edit pipeline's full
// parameter set (pool, materializer, engine state, device, space, block,
// content, timestamp); bundling them into a struct would obscure the
// call sites more than it helps. Allow the arg count for the helper.
#[allow(clippy::too_many_arguments)]
async fn make_local_edit_602(
    pool: &SqlitePool,
    mat: &Materializer,
    state: &'static crate::loro::shared::LoroState,
    device_id: &str,
    space: &crate::space::SpaceId,
    block_id: &str,
    content: &str,
    ts: i64,
) {
    use crate::op::{CreateBlockPayload, OpPayload};
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: crate::ulid::BlockId::from_trusted(block_id),
        block_type: "content".into(),
        parent_id: None,
        position: Some(1),
        index: None,
        content: content.into(),
    });
    let record = crate::op_log::append_local_op_at(pool, device_id, payload.clone(), ts)
        .await
        .expect("append_local_op_at");
    mat.dispatch_op(&record).await.expect("dispatch_op");
    mat.flush_foreground().await.expect("flush_foreground");
    crate::merge::engine_apply(
        &format!("{device_id}/{}", record.seq),
        &payload,
        device_id,
        space,
        &record.created_at.to_string(),
        state,
    );
}

/// #602 regression (keystone of #87) — two devices that have BOTH made
/// local edits must still be able to sync.
///
/// Post-#490-M1 the op_log is strictly device-local: only
/// `append_local_op*` writes it; inbound sync lands remote state via
/// the Loro engine + SQL projection + write-ahead inbox — never the
/// op_log. `check_reset_required` however resolved EVERY head the
/// remote advertised against the LOCAL op_log, so the moment the
/// initiator advertised any own-device op the responder's lookup was
/// `NotFound` → `ResetRequired` — every session, both directions. The
/// snapshot fallback then dead-ends: the responder's snapshot
/// `up_to_seqs` is built solely from its own op_log and can never
/// cover the initiator's own head, so M-58 (correctly) refuses the
/// offer → `SnapshotStale` → wire `Error` → backoff — no remaining
/// path to convergence, forever.
///
/// This test runs two devices (distinct device_ids, DBs, and Loro
/// registries — the #602 test seam) that each appended ONE local op
/// through the real local-edit pipeline, drives one full sync session
/// in each direction over the JSON wire encoding, and asserts:
///   1. every session completes — no `ResetRequired` (the #602
///      failure signature) and no `Failed`,
///   2. both SQL DBs hold both blocks,
///   3. both Loro engines converge to the same version vector.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue602_two_edited_devices_converge_without_reset_required() {
    use crate::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV602A";
    const DEV_B: &str = "DEV602B";
    const BLOCK_A: &str = "01HZ602BLKAXXXXXXXXXXXXXXX";
    const BLOCK_B: &str = "01HZ602BLKBXXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ602SPACEXXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    // #602 test seam: one Loro registry per device. Leaked to match the
    // `&'static` shape of the production process-global state.
    let state_a: &'static crate::loro::shared::LoroState = Box::leak(Box::default());
    let state_b: &'static crate::loro::shared::LoroState = Box::leak(Box::default());

    // The devices are mutually paired.
    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Each device makes one local edit of its own.
    make_local_edit_602(
        &pool_a,
        &mat_a,
        state_a,
        DEV_A,
        &space,
        BLOCK_A,
        "edit from device A",
        1_736_942_400_000,
    )
    .await;
    make_local_edit_602(
        &pool_b,
        &mat_b,
        state_b,
        DEV_B,
        &space,
        BLOCK_B,
        "edit from device B",
        1_736_942_401_000,
    )
    .await;

    // ── Session 1: A initiates, B responds (B's state flows to A) ────
    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_loro_state(state_a)
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_loro_state(state_b)
        .with_expected_remote_id(DEV_A.into());
    pump_full_session_602(&mut init_a, &mut resp_b).await;

    assert_eq!(
        resp_b.session().state,
        SyncState::Complete,
        "#602: responder B must complete the session for an initiator \
         that advertised its own op_log head — ResetRequired here means \
         check_reset_required resolved the remote's own-device head \
         against the LOCAL op_log, which never contains remote ops \
         post-#490-M1"
    );
    assert_eq!(
        init_a.session().state,
        SyncState::Complete,
        "#602: initiator A must complete session 1 (got a terminal \
         non-Complete state — see responder assertion)"
    );

    // ── Session 2: B initiates, A responds (A's state flows to B) ────
    let mut init_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_loro_state(state_b)
        .with_expected_remote_id(DEV_A.into());
    let mut resp_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_loro_state(state_a)
        .with_expected_remote_id(DEV_B.into());
    pump_full_session_602(&mut init_b, &mut resp_a).await;

    assert_eq!(
        resp_a.session().state,
        SyncState::Complete,
        "#602: responder A must complete session 2 (reverse direction)"
    );
    assert_eq!(
        init_b.session().state,
        SyncState::Complete,
        "#602: initiator B must complete session 2 (reverse direction)"
    );

    // ── Convergence: both SQL DBs hold both blocks ────────────────────
    for (label, pool) in [("A", &pool_a), ("B", &pool_b)] {
        for (block_id, content) in [
            (BLOCK_A, "edit from device A"),
            (BLOCK_B, "edit from device B"),
        ] {
            let row: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(block_id)
                .fetch_optional(pool)
                .await
                .unwrap();
            assert_eq!(
                row.as_deref(),
                Some(content),
                "device {label}'s DB must hold block {block_id} after both sessions"
            );
        }
    }

    // ── Convergence: both engines reached the same version vector ────
    let vv_a = {
        let mut g = state_a.registry.for_space(&space, DEV_A).expect("space A");
        g.engine_mut().version_vector()
    };
    let vv_b = {
        let mut g = state_b.registry.for_space(&space, DEV_B).expect("space B");
        g.engine_mut().version_vector()
    };
    let decoded_a = loro::VersionVector::decode(&vv_a).expect("decode vv A");
    let decoded_b = loro::VersionVector::decode(&vv_b).expect("decode vv B");
    assert_eq!(
        decoded_a, decoded_b,
        "both engines must converge to the same Loro version vector"
    );

    mat_a.flush_background().await.unwrap();
    mat_b.flush_background().await.unwrap();
    mat_a.shutdown();
    mat_b.shutdown();
}

/// #610 — directional `synced_at`: only the side that PULLED records it.
///
/// In a normal pull-only session the **initiator** pulls the responder's
/// state; the **responder** streams and pulls nothing back. Therefore:
///   * the initiator must record `synced_at` for the responder (so the
///     scheduler stops marking it due every tick and re-pulling a full
///     snapshot), and
///   * the responder must NOT advance `synced_at` for the initiator — it
///     pulled nothing, and advancing it refreshes the responder's clock
///     for the initiator on every inbound session, starving the reverse
///     direction (`peers_due_for_resync` would never find the initiator
///     overdue under sustained activity).
///
/// Pre-#610 the semantics were inverted: the initiator wrote nothing and
/// the responder advanced `synced_at` from the initiator's `SyncComplete`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue610_only_the_puller_records_synced_at() {
    use crate::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV610A";
    const DEV_B: &str = "DEV610B";
    const BLOCK_B: &str = "01HZ610BLKBXXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ610SPACEXXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());
    let state_a: &'static crate::loro::shared::LoroState = Box::leak(Box::default());
    let state_b: &'static crate::loro::shared::LoroState = Box::leak(Box::default());

    // Mutually paired; both peer rows start with synced_at = NULL.
    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Only B has state to stream (B is the puller's source this session).
    make_local_edit_602(
        &pool_b,
        &mat_b,
        state_b,
        DEV_B,
        &space,
        BLOCK_B,
        "edit from device B",
        1_736_942_401_000,
    )
    .await;

    // ── Session: A initiates (pulls from B); B responds (streams) ────
    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_loro_state(state_a)
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_loro_state(state_b)
        .with_expected_remote_id(DEV_A.into());
    pump_full_session_602(&mut init_a, &mut resp_b).await;

    assert_eq!(
        init_a.session().state,
        SyncState::Complete,
        "initiator must complete the pull session"
    );
    assert_eq!(
        resp_b.session().state,
        SyncState::Complete,
        "responder must complete the pull session"
    );

    // Initiator A PULLED B's state → must have recorded synced_at[B].
    let a_view_of_b = peer_refs::get_peer_ref(&pool_a, DEV_B)
        .await
        .unwrap()
        .expect("A's peer row for B must exist");
    assert!(
        a_view_of_b.synced_at.is_some(),
        "#610: the initiator (puller) must record synced_at after pulling the \
         peer's state (pre-#610 it stayed NULL → re-pulled a full snapshot every tick)"
    );

    // Responder B STREAMED to A and pulled nothing → must NOT advance synced_at[A].
    let b_view_of_a = peer_refs::get_peer_ref(&pool_b, DEV_A)
        .await
        .unwrap()
        .expect("B's peer row for A must exist");
    assert!(
        b_view_of_a.synced_at.is_none(),
        "#610: the responder (streamer) must NOT advance synced_at — it pulled \
         nothing this session; advancing it (the pre-#610 bug) starves the reverse direction"
    );

    // Consequence: the reverse direction is still 'due' — B will pull A's
    // state on its next scheduled tick (this is how A's edits reach B).
    let scheduler = crate::sync_scheduler::SyncScheduler::default();
    let b_peers = peer_refs::list_peer_refs(&pool_b).await.unwrap();
    assert!(
        scheduler
            .peers_due_for_resync(&b_peers)
            .iter()
            .any(|p| p == DEV_A),
        "#610: B must still consider A due for resync (reverse direction not starved)"
    );

    mat_a.shutdown();
    mat_b.shutdown();
}

/// #610 — the OTHER puller path: an initiator whose peer has an EMPTY
/// registry still records `synced_at`.
///
/// When the responder has no registered spaces, `head_exchange_outgoing_loro`
/// short-circuits straight to `SyncComplete` (no streaming phase), so the
/// initiator reaches the `SyncComplete`-receive arm with
/// `streamed_to_peer == false` and records via that arm's `!streamed_to_peer`
/// branch (the normal pull records via the `is_last` LoroSync arm instead).
/// This is the deliberately-preserved sub-case; without it a fresh peer
/// would leave the initiator perpetually "due". A regression that dropped
/// recording on the short-circuit branch would otherwise go undetected.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue610_empty_registry_initiator_records_via_synccomplete() {
    use crate::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV610EA";
    const DEV_B: &str = "DEV610EB";
    const BLOCK_A: &str = "01HZ610EBLKAXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ610ESPACEXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());
    let state_a: &'static crate::loro::shared::LoroState = Box::leak(Box::default());
    let state_b: &'static crate::loro::shared::LoroState = Box::leak(Box::default());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Only A has state; B's Loro registry stays EMPTY, so B short-circuits
    // straight to SyncComplete (no LoroSync stream) — the path under test.
    make_local_edit_602(
        &pool_a,
        &mat_a,
        state_a,
        DEV_A,
        &space,
        BLOCK_A,
        "edit from device A",
        1_736_942_400_000,
    )
    .await;

    // ── Session: A initiates; B (empty) responds via SyncComplete ────
    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_loro_state(state_a)
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_loro_state(state_b)
        .with_expected_remote_id(DEV_A.into());
    pump_full_session_602(&mut init_a, &mut resp_b).await;

    assert_eq!(
        init_a.session().state,
        SyncState::Complete,
        "initiator must complete against an empty-registry responder"
    );
    assert_eq!(
        resp_b.session().state,
        SyncState::Complete,
        "empty-registry responder must complete via the SyncComplete short-circuit"
    );

    // Initiator A reached the SyncComplete arm with streamed_to_peer=false
    // (B never streamed) → it must have recorded synced_at[B] via the
    // `!streamed_to_peer` branch.
    let a_view_of_b = peer_refs::get_peer_ref(&pool_a, DEV_B)
        .await
        .unwrap()
        .expect("A's peer row for B must exist");
    assert!(
        a_view_of_b.synced_at.is_some(),
        "#610: the initiator must record synced_at via the empty-registry \
         SyncComplete short-circuit branch (!streamed_to_peer)"
    );

    // B short-circuited (it streamed nothing and never reaches the
    // SyncComplete-receive arm) → it must not have recorded synced_at[A].
    let b_view_of_a = peer_refs::get_peer_ref(&pool_b, DEV_A)
        .await
        .unwrap()
        .expect("B's peer row for A must exist");
    assert!(
        b_view_of_a.synced_at.is_none(),
        "#610: the empty-registry responder must not record synced_at"
    );

    mat_a.shutdown();
    mat_b.shutdown();
}

/// Incremental sync (MAINT-228 / #87 §10.5): when the initiator advertises a
/// per-space Loro version vector in `HeadExchange`, the responder ships a
/// delta `Update` (the ops since that vv) instead of a full `Snapshot`. A
/// space the initiator did not advertise — or an older peer that sends no
/// vvs — still gets a full `Snapshot`. This is what ends the
/// full-snapshot-every-session churn (`prepare_outgoing` was hardcoded
/// `peer_vv=None` before).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn head_exchange_streams_update_when_initiator_advertises_vv() {
    use crate::sync_protocol::SyncOrchestrator;
    use crate::sync_protocol::loro_sync_types::LoroSyncMessage;
    use crate::sync_protocol::types::{DeviceHead, SpaceVersionVector};

    const DEV_A: &str = "DEVVVA";
    const DEV_B: &str = "DEVVVB";
    const BLOCK_A: &str = "01HZVVBLKAXXXXXXXXXXXXXXXX";
    const BLOCK_B: &str = "01HZVVBLKBXXXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZVVSPACEXXXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());
    let state_a: &'static crate::loro::shared::LoroState = Box::leak(Box::default());
    let state_b: &'static crate::loro::shared::LoroState = Box::leak(Box::default());

    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Both devices have an edit in the space, so A holds a non-empty vv to
    // advertise and B holds an op A is missing (the delta).
    make_local_edit_602(
        &pool_a,
        &mat_a,
        state_a,
        DEV_A,
        &space,
        BLOCK_A,
        "a",
        1_736_942_400_000,
    )
    .await;
    make_local_edit_602(
        &pool_b,
        &mat_b,
        state_b,
        DEV_B,
        &space,
        BLOCK_B,
        "b",
        1_736_942_401_000,
    )
    .await;

    let a_vv = {
        let mut g = state_a.registry.for_space(&space, DEV_A).expect("space A");
        g.engine_mut().version_vector()
    };
    let head = DeviceHead {
        device_id: DEV_A.into(),
        seq: 1,
        hash: String::new(),
    };

    // Case 1: initiator advertises its vv → responder streams an Update.
    let mut resp = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_loro_state(state_b)
        .with_expected_remote_id(DEV_A.into());
    let out = resp
        .handle_message(SyncMessage::HeadExchange {
            heads: vec![head.clone()],
            loro_vvs: vec![SpaceVersionVector {
                space_id: space.clone(),
                vv: a_vv.clone(),
            }],
        })
        .await
        .expect("responder handle_message")
        .expect("responder must reply with a LoroSync");
    match out {
        SyncMessage::LoroSync { msg, .. } => {
            assert!(
                matches!(&msg, LoroSyncMessage::Update { .. }),
                "responder must stream an incremental Update when the initiator \
                 advertised a vv, got {msg:?}"
            );
            // Round-trip: feed the Update into A's apply path and assert the
            // newly-live incremental apply converges (A gains B's block). The
            // Update's from_vv == A's own advertised vv, so the MAINT-228
            // reachability gate passes and the delta imports.
            let outcome = crate::sync_protocol::loro_sync::apply_remote(
                &pool_a,
                &state_a.registry,
                DEV_A,
                msg,
            )
            .await
            .expect("A must apply the responder's incremental Update");
            assert!(
                matches!(
                    outcome,
                    crate::sync_protocol::loro_sync::ApplyOutcome::Imported { .. }
                ),
                "A must import the Update (its own from_vv is reachable), got {outcome:?}"
            );
            let got: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(BLOCK_B)
                .fetch_optional(&pool_a)
                .await
                .unwrap();
            assert_eq!(
                got.as_deref(),
                Some("b"),
                "A must converge: the responder's block lands in A's DB via the incremental Update"
            );
        }
        other => panic!("expected LoroSync, got {other:?}"),
    }

    // Case 2: no advertised vv (older peer / fresh space) → full Snapshot.
    let mut resp2 = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_loro_state(state_b)
        .with_expected_remote_id(DEV_A.into());
    let out2 = resp2
        .handle_message(SyncMessage::HeadExchange {
            heads: vec![head],
            loro_vvs: vec![],
        })
        .await
        .expect("responder handle_message")
        .expect("responder must reply with a LoroSync");
    match out2 {
        SyncMessage::LoroSync { msg, .. } => assert!(
            matches!(msg, LoroSyncMessage::Snapshot { .. }),
            "responder must fall back to a full Snapshot when no vv is \
             advertised, got {msg:?}"
        ),
        other => panic!("expected LoroSync, got {other:?}"),
    }

    mat_a.shutdown();
    mat_b.shutdown();
}

// ======================================================================
// #778 — fresh device (empty op_log) must not be rejected as self-sync
// ======================================================================

/// #778 regression: a freshly paired device with ZERO local ops sends
/// `HeadExchange { heads: [] }` (`get_local_heads` on an empty op_log).
/// The responder used to derive `remote_id` from the advertised heads,
/// got `""`, and rejected the session as "cannot sync with self" —
/// before the BUG-27 mTLS fallback could apply. A brand-new device
/// could not pull anything until it made a local edit.
///
/// This test drives a REAL fresh-device initiator orchestrator over an
/// in-memory wire against the full `handle_incoming_sync` responder
/// (where the rejection lived) and asserts:
///   1. the session is NOT rejected — both sides reach `Complete`,
///   2. data flows: the responder's seeded block lands in the
///      initiator's DB,
///   3. the responder records the session under the cert-CN identity
///      (BUG-27 fallback: the heads never identified the peer).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue778_fresh_device_empty_heads_completes_session_against_seeded_responder() {
    use crate::sync_protocol::{SyncOrchestrator, SyncState};

    const RESP_DEV: &str = "RESP778";
    const FRESH_DEV: &str = "FRESH778";
    const BLOCK: &str = "01HZ778BLKXXXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ778SPACEXXXXXXXXXXXXXX");

    // ── Responder: one seeded local edit ─────────────────────────────
    // `handle_incoming_sync` builds its orchestrator against the
    // process-global Loro state, so the RESPONDER owns the global
    // registry; the initiator gets its own leaked registry via the
    // #602 `with_loro_state` test seam.
    let resp_state = crate::loro::shared::install_for_test();
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_mat = Materializer::new(resp_pool.clone());
    let resp_scheduler = Arc::new(SyncScheduler::new());
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    peer_refs::upsert_peer_ref(&resp_pool, FRESH_DEV)
        .await
        .unwrap();
    make_local_edit_602(
        &resp_pool,
        &resp_mat,
        resp_state,
        RESP_DEV,
        &space,
        BLOCK,
        "seeded on responder",
        1_736_942_400_000,
    )
    .await;

    // ── Initiator: completely fresh device — ZERO local ops ──────────
    let (init_pool, _init_dir) = test_pool().await;
    let init_mat = Materializer::new(init_pool.clone());
    let init_state: &'static crate::loro::shared::LoroState = Box::leak(Box::default());
    peer_refs::upsert_peer_ref(&init_pool, RESP_DEV)
        .await
        .unwrap();

    // ── Wire the two sides together ──────────────────────────────────
    let (mut server_conn, mut client_conn) = sync_net::test_connection_pair().await;
    // Production shape: the verified TLS client cert identifies the
    // fresh initiator (its heads cannot — they are empty).
    server_conn.set_test_cert(Some(FRESH_DEV.to_string()), None);

    let resp_pool_clone = resp_pool.clone();
    let resp_mat_clone = resp_mat.clone();
    let resp_scheduler_clone = resp_scheduler.clone();
    let resp_sink_clone = resp_sink.clone();
    let server_task = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            resp_pool_clone,
            RESP_DEV.to_string(),
            resp_mat_clone,
            resp_scheduler_clone,
            resp_sink_clone,
        )
        .await
    });

    // ── Drive the initiator (mirrors `run_sync_session`'s loop) ──────
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(init_sink.clone()));
    let mut init_orch =
        SyncOrchestrator::new(init_pool.clone(), FRESH_DEV.into(), init_mat.clone())
            .with_loro_state(init_state)
            .with_event_sink(init_sink_box)
            .with_expected_remote_id(RESP_DEV.into());

    let first = init_orch.start().await.expect("initiator start");
    match &first {
        SyncMessage::HeadExchange { heads, .. } => {
            assert!(
                heads.is_empty(),
                "#778 precondition: a fresh device's op_log yields EMPTY heads, got {heads:?}"
            );
        }
        other => panic!("initiator must start with HeadExchange, got {other:?}"),
    }
    client_conn.send_json(&first).await.unwrap();

    while !init_orch.is_terminal() {
        let incoming: SyncMessage = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            client_conn.recv_json::<SyncMessage>(),
        )
        .await
        .expect("initiator timed out waiting for responder message")
        .expect("initiator wire recv");
        // The #778 failure signature: the responder's very first reply
        // was `Error("cannot sync with self")`.
        if let SyncMessage::Error { message } = &incoming {
            panic!("responder rejected the fresh-device session: {message}");
        }
        if let Some(resp) = init_orch
            .handle_message(incoming)
            .await
            .expect("initiator handle_message")
        {
            client_conn.send_json(&resp).await.unwrap();
            while let Some(m) = init_orch.next_message() {
                client_conn.send_json(&m).await.unwrap();
            }
        }
    }

    assert_eq!(
        init_orch.session().state,
        SyncState::Complete,
        "#778: the fresh-device initiator must complete the session"
    );

    // The responder enters the file-transfer phase after Complete and
    // waits for the initiator's FileRequest; closing the client side
    // ends that sub-flow (non-fatal by design) and lets the handler
    // return.
    let _ = client_conn.close().await;
    let resp_result = tokio::time::timeout(std::time::Duration::from_secs(10), server_task)
        .await
        .expect("responder task timed out")
        .expect("responder task panicked");
    assert!(
        resp_result.is_ok(),
        "responder must complete the fresh-device session, got {resp_result:?}"
    );

    // ── Data flowed: responder's block landed on the fresh device ────
    let content: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK)
        .fetch_optional(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        content.as_deref(),
        Some("seeded on responder"),
        "#778: the responder's seeded block must reach the fresh initiator's DB"
    );

    // ── BUG-27 fallback: the responder identified the session under the
    //    cert-CN identity (the heads never identified the peer), so the
    //    peer row exists under FRESH_DEV (pinned during cert TOFU). ─────
    let peer = peer_refs::get_peer_ref(&resp_pool, FRESH_DEV)
        .await
        .unwrap()
        .expect("peer_refs row for the fresh device must exist on the responder");
    // #610: the responder STREAMED its seeded block to the fresh initiator
    // and pulled nothing back, so it must NOT advance synced_at for that
    // peer — only the puller (here the initiator) records synced_at. The
    // row existing above is the cert-CN identity signal; synced_at staying
    // NULL keeps the reverse direction schedulable.
    assert!(
        peer.synced_at.is_none(),
        "#610: the responder (streamer) must NOT record synced_at for the \
         fresh device — it pulled nothing this session"
    );

    resp_mat.shutdown();
    init_mat.shutdown();
}

// ======================================================================
// #611 — large Loro payloads ride the chunked binary path end-to-end
// ======================================================================

/// #611 regression: a per-space Loro snapshot whose JSON number-array
/// encoding exceeds the 10 MB text-frame cap must still sync. Before
/// the chunked wire path, `head_exchange_outgoing_loro` shipped the
/// full snapshot inline; once a space reached ~2.8 MB of Loro bytes
/// the responder's `LoroSync` blew the initiator's `recv_json` cap,
/// every session failed, and the scheduler retried forever.
///
/// This test seeds the responder with one block holding ~4 MB of
/// incompressible content (asserting the premise: the exported
/// snapshot really is over `LORO_INLINE_MAX_BYTES`), drives a full
/// session through the REAL `handle_incoming_sync` responder over an
/// in-memory wire (so the production `sync_daemon::wire` chunked send
/// path runs), pumps the initiator via the same wire helpers
/// `run_sync_session` uses, and asserts the session completes and the
/// 4 MB block lands in the initiator's DB byte-for-byte.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue611_oversized_loro_snapshot_syncs_via_chunked_wire_path() {
    use crate::sync_constants::LORO_INLINE_MAX_BYTES;
    use crate::sync_protocol::{SyncOrchestrator, SyncState, loro_sync};

    const RESP_DEV: &str = "RESP611";
    const INIT_DEV: &str = "INIT611";
    const BLOCK: &str = "01HZ611BLKXXXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ611SPACEXXXXXXXXXXXXXX");

    // ~4 MB of LCG-generated printable ASCII — high-entropy enough
    // that Loro's snapshot encoding cannot compress it back under the
    // inline threshold (the premise assert below verifies, so a future
    // Loro compression change fails loudly instead of silently
    // downgrading this test to the inline path).
    let big_content: String = {
        let target = 4_000_000usize;
        let mut s = String::with_capacity(target);
        let mut x: u32 = 0x2545_F491;
        while s.len() < target {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            s.push(char::from(33 + ((x >> 24) as u8 % 94)));
        }
        s
    };

    // ── Responder: one seeded local edit with the huge content ───────
    // (Same global-vs-leaked registry split as the #778 test above:
    // `handle_incoming_sync` reads the process-global Loro state.)
    let resp_state = crate::loro::shared::install_for_test();
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_mat = Materializer::new(resp_pool.clone());
    let resp_scheduler = Arc::new(SyncScheduler::new());
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    peer_refs::upsert_peer_ref(&resp_pool, INIT_DEV)
        .await
        .unwrap();
    make_local_edit_602(
        &resp_pool,
        &resp_mat,
        resp_state,
        RESP_DEV,
        &space,
        BLOCK,
        &big_content,
        1_736_942_400_000,
    )
    .await;
    // Drain the materializer's background queue (search-index etc. for
    // the 4 MB block) BEFORE the session: its write transactions are
    // long at this content size and would contend with the session's
    // `BEGIN IMMEDIATE` bookkeeping ("database is locked").
    resp_mat.flush_background().await.unwrap();

    // Premise: the snapshot the responder will ship is over the inline
    // threshold — i.e. with the pre-#611 wire this session COULD NOT
    // complete (its JSON number-array form would exceed the 10 MB cap).
    let outgoing = loro_sync::prepare_outgoing(&resp_state.registry, &space, RESP_DEV, None)
        .await
        .expect("prepare_outgoing for premise check");
    let snapshot_len = match &outgoing {
        crate::sync_protocol::loro_sync_types::LoroSyncMessage::Snapshot { bytes, .. } => {
            bytes.len()
        }
        other => panic!("peer_vv=None must yield a Snapshot, got {other:?}"),
    };
    assert!(
        snapshot_len > LORO_INLINE_MAX_BYTES,
        "test premise: the seeded space's snapshot ({snapshot_len} bytes) must exceed \
         LORO_INLINE_MAX_BYTES ({LORO_INLINE_MAX_BYTES}) so the chunked path is exercised"
    );

    // ── Initiator: fresh device, its own leaked registry ─────────────
    let (init_pool, _init_dir) = test_pool().await;
    let init_mat = Materializer::new(init_pool.clone());
    let init_state: &'static crate::loro::shared::LoroState = Box::leak(Box::default());
    peer_refs::upsert_peer_ref(&init_pool, RESP_DEV)
        .await
        .unwrap();

    // ── Wire the two sides together ──────────────────────────────────
    let (mut server_conn, mut client_conn) = sync_net::test_connection_pair().await;
    server_conn.set_test_cert(Some(INIT_DEV.to_string()), None);

    let resp_pool_clone = resp_pool.clone();
    let resp_mat_clone = resp_mat.clone();
    let server_task = tokio::spawn(handle_incoming_sync(
        server_conn,
        resp_pool_clone,
        RESP_DEV.to_string(),
        resp_mat_clone,
        resp_scheduler.clone(),
        resp_sink.clone(),
    ));

    // ── Drive the initiator through the SAME wire helpers
    //    `run_sync_session` uses (#611 reassembly on receive) ─────────
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(init_sink.clone()));
    let mut init_orch = SyncOrchestrator::new(init_pool.clone(), INIT_DEV.into(), init_mat.clone())
        .with_loro_state(init_state)
        .with_event_sink(init_sink_box)
        .with_expected_remote_id(RESP_DEV.into());

    let first = init_orch.start().await.expect("initiator start");
    super::wire::send_sync_message(&mut client_conn, &first)
        .await
        .unwrap();

    while !init_orch.is_terminal() {
        let incoming: SyncMessage = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            super::wire::recv_sync_message(&mut client_conn),
        )
        .await
        .expect("initiator timed out waiting for responder message")
        .expect("initiator wire recv");
        if let SyncMessage::Error { message } = &incoming {
            panic!("responder failed the session: {message}");
        }
        if let Some(resp) = init_orch
            .handle_message(incoming)
            .await
            .expect("initiator handle_message")
        {
            super::wire::send_sync_message(&mut client_conn, &resp)
                .await
                .unwrap();
            while let Some(m) = init_orch.next_message() {
                super::wire::send_sync_message(&mut client_conn, &m)
                    .await
                    .unwrap();
            }
        }
    }

    assert_eq!(
        init_orch.session().state,
        SyncState::Complete,
        "#611: the initiator must complete a session whose LoroSync \
         payload exceeds the old inline cap"
    );

    // Close the client side to end the responder's post-Complete
    // file-transfer phase (non-fatal by design), then reap it.
    let _ = client_conn.close().await;
    let resp_result = tokio::time::timeout(std::time::Duration::from_secs(30), server_task)
        .await
        .expect("responder task timed out")
        .expect("responder task panicked");
    assert!(
        resp_result.is_ok(),
        "responder must complete the oversized-snapshot session, got {resp_result:?}"
    );

    // ── The 4 MB block landed on the initiator byte-for-byte ─────────
    let content: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK)
        .fetch_optional(&init_pool)
        .await
        .unwrap();
    let content = content.expect("#611: the oversized block must reach the initiator's DB");
    assert_eq!(
        content.len(),
        big_content.len(),
        "synced content length must match the seeded content"
    );
    assert_eq!(
        content, big_content,
        "synced content must match the seeded content byte-for-byte"
    );

    resp_mat.shutdown();
    init_mat.shutdown();
}

// ======================================================================
// M-46 — try_sync_with_peer returns bool reflecting cancel observation
// ======================================================================

/// M-46: When `try_sync_with_peer` exits via the connection-failure
/// early-exit path (no real session ran), the function must return
/// `false` even if the cancel flag was pre-set. The `CancelGuard` still
/// clears the flag, but the returned bool reflects the spec: only
/// sessions that actually executed `run_sync_session` can report a
/// "session cancelled mid-flight" outcome.
///
/// Note: this test covers the FALSE-return path (connection refused,
/// no real session ran). The TRUE-return path (`run_sync_session` ran
/// AND cancel was observed) requires a reachable TLS loopback responder;
/// see TODO(#497) below.
///
/// TODO(#497): add true-path test — needs loopback TLS responder that
/// lets run_sync_session start before cancel is observed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_returns_false_when_connect_refused_even_if_cancel_preflagged_m46() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // pre-set; early-exit must still return false
    let cert = sync_net::generate_self_signed_cert("LOCAL_M46").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_M46_FAIL".to_string(),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port: 1, // refused
    };
    let refs = vec![make_peer_ref("PEER_M46_FAIL")];

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_M46",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("must complete within timeout");

    // M-46 spec: connect-failure early-exit returns false even when
    // cancel was pre-set, because run_sync_session never executed.
    assert!(
        !result,
        "M-46: connect-failure early-exit must return false (no real session ran), got true"
    );
    // #637 invariant: the early-exit task does NOT own the cancel, so it must
    // PRESERVE a pre-set flag (it could be aimed at a still-running sibling)
    // rather than clear it.
    assert!(
        cancel.load(Ordering::Acquire),
        "#637: connect-failure early-exit must PRESERVE a pre-set cancel flag"
    );

    materializer.shutdown();
}

/// M-46: backoff early-exit returns false (no real session ran).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_returns_false_on_backoff_early_exit_m46() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // pre-set, but early-exit must return false
    let cert = sync_net::generate_self_signed_cert("LOCAL_M46_B").unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_M46_BACK".to_string(),
        addresses: vec!["192.168.1.99".parse().unwrap()],
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_M46_BACK")];
    scheduler.record_failure("PEER_M46_BACK");
    assert!(!scheduler.may_retry("PEER_M46_BACK"));

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_M46_B",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };
    let result = try_sync_with_peer(&ctx, &peer, &refs).await;

    assert!(
        !result,
        "M-46: backoff early-exit must return false, got true"
    );
    materializer.shutdown();
}

// ======================================================================
// #637 — shared cancel flag is not swallowed by an early-exiting sibling
// ======================================================================

/// #637 (core regression): two peer tasks share a SINGLE cancel flag, as
/// Branch B spawns them (one `&AtomicBool` cloned into every task). A user
/// cancel is set, aimed at the still-running sibling. One peer exits early
/// (here: backoff gate, the same shape as lock contention / no-address /
/// connect-failure) and its `CancelGuard` drops. The sibling MUST still
/// observe the cancel — the early-exiter must NOT store `false` over a
/// cancel it does not own.
///
/// Before the fix, `CancelGuard::drop` cleared the shared flag
/// unconditionally on every exit path, so the early-exiter would swallow
/// the cancel and the sibling (and `abort_all`, which only fires on a
/// `true` return) would never see it — the round kept syncing despite the
/// user cancelling.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_637_early_exiter_does_not_swallow_sibling_cancel() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cert = sync_net::generate_self_signed_cert("LOCAL_637").unwrap();

    // The user has cancelled the round; the cancel is aimed at the still-
    // running sibling. This is the SHARED flag every per-peer task observes.
    let cancel = Arc::new(AtomicBool::new(true));

    // The early-exiting peer: put it in backoff so `try_sync_with_peer`
    // returns via the no-session early-exit path and drops its CancelGuard.
    let early_peer = sync_net::DiscoveredPeer {
        device_id: "PEER_EARLY_637".to_string(),
        addresses: vec!["192.168.1.50".parse().unwrap()],
        port: 9999,
    };
    let early_refs = vec![make_peer_ref("PEER_EARLY_637")];
    scheduler.record_failure("PEER_EARLY_637");
    assert!(
        !scheduler.may_retry("PEER_EARLY_637"),
        "early peer must be in backoff"
    );

    // Run the early-exiter against the SHARED flag, exactly as a spawned
    // Branch-B task would (owned clones, `&AtomicBool` borrowed from the Arc).
    let early_handle = {
        let pool = pool.clone();
        let materializer = materializer.clone();
        let scheduler = scheduler.clone();
        let event_sink = event_sink.clone();
        let cancel = cancel.clone();
        let cert = cert.clone();
        tokio::spawn(async move {
            let ctx = SyncSessionContext {
                pool: &pool,
                device_id: "LOCAL_637",
                materializer: &materializer,
                scheduler: &scheduler,
                event_sink: &event_sink,
                cancel: &cancel,
                cert: &cert,
            };
            try_sync_with_peer(&ctx, &early_peer, &early_refs).await
        })
    };

    let early_was_cancelled = early_handle.await.unwrap();

    // The early-exiter ran no real session, so it reports false (M-46) ...
    assert!(
        !early_was_cancelled,
        "#637: early-exiter (backoff) must report false — it ran no session"
    );
    // ... and, crucially, it must NOT have cleared the shared cancel flag:
    // the sibling still needs to observe it.
    assert!(
        cancel.load(Ordering::Acquire),
        "#637: early-exiting sibling swallowed the user cancel — the still-running \
         peer would never observe it"
    );

    // Sanity: a sibling now reading the SAME shared flag (as it would inside
    // `run_sync_session`'s cancel check) still sees the cancel.
    assert!(
        cancel.load(Ordering::Acquire),
        "#637: sibling must still observe the cancel after the early-exiter tore down"
    );

    materializer.shutdown();
}

/// #637 (owns-path): when `try_sync_with_peer` actually reaches a real
/// session it OWNS the cancel and IS the legitimate resetter — so it must
/// clear the shared flag on the way out. Here we reach `run_sync_session`
/// against a live loopback responder with the cancel pre-set; the session's
/// cancel check returns immediately ("sync cancelled by user"), the function
/// reports `true` (M-46), and the guard clears the flag.
///
/// This also exercises the M-46 TRUE-return path that was an acknowledged
/// TODO(#497): a real session ran AND the cancel was observed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_637_owns_path_clears_flag_after_real_session() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cert = sync_net::generate_self_signed_cert("LOCAL_637_OWNS").unwrap();

    // Live loopback responder so `try_connect_each_address` succeeds and the
    // function commits to a real session (sets `owns = true`).
    let server_cert = sync_net::generate_self_signed_cert("PEER_637_OWNS").unwrap();
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(&server_cert, move |conn| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_637_OWNS".to_string(),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port,
    };
    let refs = vec![make_peer_ref("PEER_637_OWNS")];

    // Cancel pre-set: once `run_sync_session` starts, its first loop iteration's
    // cancel check fires and returns Err("sync cancelled by user").
    let cancel = AtomicBool::new(true);

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_637_OWNS",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer must complete within timeout");

    // Keep the server-side connection alive until after the call returns so
    // the initiator's first send doesn't fail before the cancel check.
    drop(conn_rx.try_recv());

    // A real session ran and observed the cancel → true (M-46 true-path / #497).
    assert!(
        was_cancelled,
        "#637 owns-path: a real session that observed the cancel must return true"
    );
    // And because this task OWNS the cancel, the guard performs the legitimate
    // post-run reset — the next round starts clean.
    assert!(
        !cancel.load(Ordering::Acquire),
        "#637 owns-path: the resetter that ran a real session must clear the flag on exit"
    );

    server.shutdown().await;
    materializer.shutdown();
}

/// #637 (normal reset): the owns-path post-run reset still happens when NO
/// cancel is pending. A real session is reached (live loopback) with the
/// cancel flag clear; after the session ends the flag remains clear — the
/// legitimate reset is preserved and nothing spuriously sets it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_637_owns_path_normal_reset_leaves_flag_clear() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cert = sync_net::generate_self_signed_cert("LOCAL_637_NORM").unwrap();

    // Live loopback responder that accepts the connection and immediately
    // drops it (the closure's `conn` falls out of scope). With cancel clear,
    // `run_sync_session` sends its first message then errors on the first
    // recv against the closed connection — a real session ran and FAILED,
    // which is still the owns-path. This is deterministic (the initiator's
    // recv returns an error promptly rather than blocking).
    let server_cert = sync_net::generate_self_signed_cert("PEER_637_NORM").unwrap();
    let (server, port) = SyncServer::start(&server_cert, move |_conn| {
        // drop `_conn` immediately → initiator's recv fails fast
    })
    .await
    .unwrap();

    let peer = sync_net::DiscoveredPeer {
        device_id: "PEER_637_NORM".to_string(),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port,
    };
    let refs = vec![make_peer_ref("PEER_637_NORM")];

    // No cancel pending.
    let cancel = AtomicBool::new(false);

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_637_NORM",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer must complete within timeout");

    // No cancel was set, so nothing to observe.
    assert!(
        !was_cancelled,
        "#637 normal-reset: with no cancel pending the call must report false"
    );
    // The owns-path reset runs and leaves the flag clear (it was never set).
    assert!(
        !cancel.load(Ordering::Acquire),
        "#637 normal-reset: the post-run reset must leave the flag clear"
    );

    server.shutdown().await;
    materializer.shutdown();
}

/// M-46: the daemon-loop's "break on cancel" pattern must stop at the
/// first peer that reports cancellation.
///
/// Calls the production `run_sequential_sync_round` helper (extracted
/// from Branch C of `daemon_loop`) with a stub that returns `true` on
/// the first peer. A mutation to the real break logic inside
/// `run_sequential_sync_round` would cause this test to fail.
///
/// (Branch B no longer follows this shape post-L-61 — it dispatches
/// peers concurrently via `JoinSet` and uses `abort_all()`. The
/// bool→break contract this test pins down is the authoritative shape
/// for Branch C.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_loop_breaks_round_when_cancel_observed_during_first_peer_m46() {
    let peer_ids: Vec<String> = vec![
        "PEER_1".to_string(),
        "PEER_2".to_string(),
        "PEER_3".to_string(),
    ];

    let visited = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let visited2 = visited.clone();

    // PEER_1 signals cancel; PEER_2 and PEER_3 must never be reached.
    let was_cancelled = run_sequential_sync_round(&peer_ids, |pid| {
        visited2.lock().unwrap().push(pid.clone());
        async move { pid == "PEER_1" }
    })
    .await;

    assert!(
        was_cancelled,
        "M-46: run_sequential_sync_round must return true when first peer cancels"
    );
    assert_eq!(
        visited.lock().unwrap().clone(),
        vec!["PEER_1".to_string()],
        "M-46: daemon loop must break after the first peer reports cancellation; \
         got visited peers {:?}",
        visited.lock().unwrap().clone()
    );
}

/// M-46: when no peer reports cancellation, `run_sequential_sync_round`
/// must visit all peers in the round (regression guard against an over-eager break).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_loop_visits_all_peers_when_no_cancel_observed_m46() {
    let peer_ids: Vec<String> = vec![
        "PEER_A".to_string(),
        "PEER_B".to_string(),
        "PEER_C".to_string(),
    ];

    let visited = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let visited2 = visited.clone();

    let was_cancelled = run_sequential_sync_round(&peer_ids, |pid| {
        visited2.lock().unwrap().push(pid);
        async move { false }
    })
    .await;

    assert!(
        !was_cancelled,
        "M-46: run_sequential_sync_round must return false when no peer cancels"
    );
    assert_eq!(
        visited.lock().unwrap().clone(),
        vec![
            "PEER_A".to_string(),
            "PEER_B".to_string(),
            "PEER_C".to_string()
        ],
        "M-46: when no peer reports cancellation, all peers in the round must be visited"
    );
}

/// L-75: dormant-waiter race vs. immediate shutdown.
///
/// The daemon starts dormant (no peers in pool). We then race two events:
/// (1) a pair-arrival notification (insert peer + `scheduler.notify_change()`)
/// and (2) `daemon.shutdown()` firing essentially simultaneously. The daemon's
/// `select!` arms must accept either ordering cleanly:
///
/// - If the notify is consumed first: the dormant path transitions into
///   `daemon_loop`, which then observes the cancel flag on the very next
///   iteration and returns Ok.
/// - If the shutdown is consumed first: the dormant path simply exits
///   without ever entering `daemon_loop`.
///
/// In either case:
///
/// (a) The daemon task must `await` cleanly within a bounded timeout —
///     no hang, no panic, no leaked listener.
/// (b) The peer row inserted by the pair event must persist in `peer_refs`
///     (regardless of which branch won). This is the "no data loss on
///     immediate shutdown" invariant: a confirm_pairing that lands and a
///     simultaneous shutdown must not erase the peer.
///
/// Pass-1 source: 06/F51. The previous tests (`dormant_daemon_wakes_on_pair_notification`,
/// `peers_appeared_*`) cover the happy paths but not this exact interleaving.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dormant_waiter_races_pair_with_immediate_shutdown_l75() {
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let cert = sync_net::generate_self_signed_cert("DEV_LOCAL").unwrap();
    let event_sink: Arc<dyn crate::sync_events::SyncEventSink> =
        Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    // Pre-condition: no peers, so the daemon enters its dormant waiter
    // branch on start.
    assert!(
        !super::peers_appeared(&pool).await,
        "pre-condition: pool must have no peers"
    );

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

    // Race the pair event against the shutdown. Both fire from the
    // current task with no `await` between them so the daemon's
    // `select!` arms see them in essentially arbitrary order.
    peer_refs::upsert_peer_ref(&pool, "PEER_RACE_L75")
        .await
        .unwrap();
    scheduler.notify_change();
    daemon.shutdown();

    // (a) The daemon task must exit cleanly within a bounded timeout
    // regardless of which `select!` arm won the race.
    let handle = daemon.handle;
    tokio::time::timeout(std::time::Duration::from_secs(10), async move {
        if let Some(h) = handle {
            let _ = h.await;
        }
    })
    .await
    .expect(
        "L-75: daemon must shut down within 10s when pair-notify and shutdown \
         race; a hang here means a select! arm leaks across the race window",
    );

    // (b) The peer row persists. Whichever branch of the race won, the
    // confirm_pairing-equivalent insert must not be erased by the
    // simultaneous shutdown.
    let peer = peer_refs::get_peer_ref(&pool, "PEER_RACE_L75")
        .await
        .unwrap();
    assert!(
        peer.is_some(),
        "L-75: peer inserted before shutdown must persist regardless of \
         which select! arm consumed first; got None"
    );
}
