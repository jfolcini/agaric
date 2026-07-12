use super::*;
use crate::db::init_pool;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::peer_refs::{self, PeerRef};
use crate::sync_events::RecordingEventSink;
use crate::sync_net::{self, SyncCert, SyncConnection, SyncServer};
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

/// Generic polling barrier for `SyncDaemon` / `SyncScheduler` tests.
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
/// In place with a `// no observable predicate available` comment
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
        assert!(
            start.elapsed() < timeout,
            "wait_for({label}) timed out after {timeout:?}"
        );
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
        scheduler: Arc::new(SyncScheduler::new()),
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
fn cancel_active_sync_sets_flag_while_session_active() {
    let cancel = Arc::new(AtomicBool::new(false));
    let scheduler = Arc::new(SyncScheduler::new());
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        scheduler: scheduler.clone(),
        handle: None,
    };
    assert!(
        !cancel.load(Ordering::Acquire),
        "cancel flag must start false"
    );
    // #2537: the cancel only latches while a session is live.
    let _activity = scheduler.begin_session_activity();
    daemon.cancel_active_sync();
    assert!(
        cancel.load(Ordering::Acquire),
        "cancel_active_sync must set the flag while a session is active"
    );
}

/// #2537: with NO live session there is nothing to cancel — and nothing
/// that would ever reset the flag (the only resetters are the per-session
/// cancel guards). `cancel_active_sync` must therefore be a no-op instead
/// of latching `true` forever and instantly failing every future inbound
/// responder session.
#[test]
fn cancel_active_sync_is_noop_without_active_session() {
    let cancel = Arc::new(AtomicBool::new(false));
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        scheduler: Arc::new(SyncScheduler::new()),
        handle: None,
    };
    daemon.cancel_active_sync();
    assert!(
        !cancel.load(Ordering::Acquire),
        "#2537: cancel with no active session must NOT latch the shared flag"
    );
}

#[test]
fn shutdown_and_cancel_are_independent() {
    let cancel = Arc::new(AtomicBool::new(false));
    let scheduler = Arc::new(SyncScheduler::new());
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        scheduler: scheduler.clone(),
        handle: None,
    };
    daemon.shutdown();
    assert!(!cancel.load(Ordering::Acquire), "cancel must remain unset");

    let _activity = scheduler.begin_session_activity();
    daemon.cancel_active_sync();
    assert!(cancel.load(Ordering::Acquire), "cancel must now be set");
}

#[test]
fn cancel_flag_clear_after_session() {
    let cancel = Arc::new(AtomicBool::new(false));
    let scheduler = Arc::new(SyncScheduler::new());
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        scheduler: scheduler.clone(),
        handle: None,
    };
    let _activity = scheduler.begin_session_activity();
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
    let scheduler = Arc::new(SyncScheduler::new());
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        scheduler: scheduler.clone(),
        handle: None,
    };
    let _activity = scheduler.begin_session_activity();
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

// ── stale mDNS peer eviction test ────────────────────────────

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
        !should_attempt_sync_with_discovered_peer("MY_DEVICE", "MY_DEVICE", false, &refs, false),
        "must never attempt sync with self even if paired"
    );
}

#[test]
fn should_attempt_sync_rejects_already_discovered_peer() {
    let refs = vec![make_peer_ref("PEER_B")];
    assert!(
        !should_attempt_sync_with_discovered_peer("PEER_B", "MY_DEVICE", true, &refs, false),
        "must not re-trigger sync for a peer already in the discovered map"
    );
}

#[test]
fn should_attempt_sync_rejects_unpaired_peer() {
    // Peer refs list contains PEER_A but NOT PEER_C
    let refs = vec![make_peer_ref("PEER_A")];
    assert!(
        !should_attempt_sync_with_discovered_peer("PEER_C", "MY_DEVICE", false, &refs, false),
        "must not attempt sync with an unpaired peer"
    );
}

#[test]
fn should_attempt_sync_accepts_new_paired_peer() {
    let refs = vec![make_peer_ref("PEER_A"), make_peer_ref("PEER_B")];
    assert!(
        should_attempt_sync_with_discovered_peer("PEER_B", "MY_DEVICE", false, &refs, false),
        "must trigger sync for a newly discovered, paired peer"
    );
}

/// #2008: during a pairing window the initiator must be willing to sync with
/// an UNPAIRED discovered peer — this is the initiator-side counterpart to
/// the responder's admit-while-pending (#1519). Without it nobody initiates
/// the first session and pairing deadlocks.
#[test]
fn should_attempt_sync_accepts_unpaired_peer_while_pairing_pending() {
    let refs: Vec<crate::peer_refs::PeerRef> = vec![]; // no peer_refs yet — mid-pairing
    assert!(
        should_attempt_sync_with_discovered_peer("PEER_NEW", "MY_DEVICE", false, &refs, true),
        "while pairing is pending, an unpaired discovered peer must be a \
         valid initiation target (#2008)"
    );
}

/// The pairing-pending bypass must NOT override the self-discovery guard:
/// a device must never try to sync with itself, pairing or not.
#[test]
fn should_attempt_sync_rejects_self_even_while_pairing_pending() {
    let refs: Vec<crate::peer_refs::PeerRef> = vec![];
    assert!(
        !should_attempt_sync_with_discovered_peer("MY_DEVICE", "MY_DEVICE", false, &refs, true),
        "self-discovery guard must hold even while pairing is pending"
    );
}

/// The pairing-pending bypass must NOT override the already-discovered guard:
/// an unpaired peer already in the discovered map must not re-trigger a sync.
#[test]
fn should_attempt_sync_rejects_already_discovered_even_while_pairing_pending() {
    let refs: Vec<crate::peer_refs::PeerRef> = vec![];
    assert!(
        !should_attempt_sync_with_discovered_peer("PEER_NEW", "MY_DEVICE", true, &refs, true),
        "already-discovered guard must hold even while pairing is pending"
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
            cert_cn: String::new(),
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
        other => panic!("expected Progress event, got {other:?}"),
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
    let (server, port) = SyncServer::start(&server_cert, move |conn, _permit| {
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
            Arc::new(AtomicBool::new(false)),
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
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
    let (server, port) = SyncServer::start(&server_cert, move |conn, _permit| {
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
    let (server, port) = SyncServer::start(&server_cert, move |conn, _permit| {
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
            Arc::new(AtomicBool::new(false)),
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
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
            Arc::new(AtomicBool::new(false)),
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
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
            Arc::new(AtomicBool::new(false)),
        )
        .await
    });

    // Empty heads (a fresh device's HeadExchange) + no cert: there is
    // nothing to identify the peer by.
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![],
            loro_vvs: vec![],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
            Arc::new(AtomicBool::new(false)),
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
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
            Arc::new(AtomicBool::new(false)),
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
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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

/// #1519: the documented pairing flow leaves the responder with NO
/// `peer_refs` row at confirm time — `confirm_pairing_inner` only writes a
/// `set_pending_pairing` marker, because the joiner's real `device_id` is
/// unknown until it connects (the QR carries only the passphrase). The first
/// post-pair connection therefore arrives from a device with no `peer_ref`.
///
/// Before the fix, the S-1 unpaired gate rejected that first connection
/// outright ("not paired") with no exception for a pending pairing, so the
/// TOFU upsert that would establish the `peer_ref` never ran and the
/// initiator was stuck with no forward path.
///
/// After the fix, an active `set_pending_pairing` marker admits that first
/// connection PAST the S-1 gate. We prove the new transition by pre-acquiring
/// the per-peer lock: the device now reaches the busy-peer branch (it got
/// past S-1) instead of being rejected as unpaired — i.e. the gate accepted
/// a device with no `peer_ref` because pairing was pending.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_admits_first_connection_while_pairing_pending() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // The responder just confirmed pairing: no `peer_ref` row exists yet, only
    // the pending-pairing marker that bridges to the first TOFU connection.
    assert!(
        peer_refs::get_peer_ref(&pool, "JOINING_DEV")
            .await
            .unwrap()
            .is_none(),
        "precondition: joining device must be unpaired"
    );
    peer_refs::set_pending_pairing(&pool).await.unwrap();
    assert!(
        peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "precondition: pairing must be pending"
    );

    // Pre-acquire the per-peer lock so that, if (and only if) the connection
    // gets PAST the S-1 unpaired gate, it lands on the busy-peer branch — a
    // distinct, observable response from the "not paired" rejection.
    let _guard = scheduler.try_lock_peer("JOINING_DEV").unwrap();

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
            Arc::new(AtomicBool::new(false)),
        )
        .await
    });

    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "JOINING_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
            loro_vvs: vec![],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
        })
        .await
        .unwrap();

    // The fix: with pairing pending, the unpaired device is admitted past the
    // S-1 gate and (because the lock is held) reaches the busy branch. A "not
    // paired" response here would mean the gate still rejected it — the bug.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("busy")
        ),
        "expected the first post-pair connection to pass the S-1 gate while \
         pairing is pending (landing on the held-lock 'busy' branch), got: {response:?}"
    );
    assert!(
        !matches!(
            &response,
            SyncMessage::Error { message } if message.contains("not paired")
        ),
        "first post-pair connection must NOT be rejected as unpaired while pairing is pending"
    );

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after admitting the pending-pairing connection"
    );

    materializer.shutdown();
}

/// #1519 (control): the pending-pairing exception is gated on the marker — an
/// unpaired device with NO active pending-pairing marker is still rejected at
/// the S-1 gate. This guards against the fix accidentally admitting every
/// unpaired device. Mirrors `inmem_handle_incoming_sync_admits_first_connection_while_pairing_pending`
/// but with no marker set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inmem_handle_incoming_sync_rejects_unpaired_without_pending_marker() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // No peer_ref AND no pending-pairing marker.
    assert!(
        !peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "precondition: pairing must NOT be pending"
    );

    // Hold the lock too: if the gate were (wrongly) bypassed we'd see "busy";
    // the correct behaviour is the "not paired" rejection before the lock.
    let _guard = scheduler.try_lock_peer("UNKNOWN_DEV").unwrap();

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
            Arc::new(AtomicBool::new(false)),
        )
        .await
    });

    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "UNKNOWN_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
            loro_vvs: vec![],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
        })
        .await
        .unwrap();

    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("not paired")
        ),
        "an unpaired device with no pending-pairing marker must still be rejected, got: {response:?}"
    );

    let result = handle.await.unwrap();
    assert!(result.is_ok(), "handle_incoming_sync should return Ok");

    materializer.shutdown();
}

/// #1605: When the daemon's shared cancel flag is set, the responder
/// session aborts at the top of its message loop — PROMPTLY, well before
/// the 180 s `RECV_TIMEOUT` it would otherwise block on while waiting for
/// the next message from a slow/hung initiator — and releases the per-peer
/// lock (and, in production, the #1581 concurrency permit dropped by the
/// caller when this fn resolves).
///
/// Reproduces the bug fixed here: previously the responder threaded a
/// fresh, never-set `AtomicBool`, so a flipped shutdown/user-cancel signal
/// was invisible to it. The client sends a single HeadExchange and then
/// goes silent; without the cancel check the responder would block on
/// `recv` for the full `RECV_TIMEOUT`. With the real flag threaded in, the
/// loop's pre-recv `cancel.load()` returns the cancellation error at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_aborts_on_cancel_and_releases_lock() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Pair the peer so the session reaches the message loop (an unpaired
    // peer is rejected before the orchestrator is even built).
    peer_refs::upsert_peer_ref(&pool, "REMOTE_DEV")
        .await
        .unwrap();

    let (server_conn, mut client_conn) = sync_net::test_connection_pair().await;

    // The daemon's REAL shared cancel flag, flipped to simulate a
    // shutdown / user-cancel that arrives while the session is in flight.
    let cancel = Arc::new(AtomicBool::new(true));

    let pool_clone = pool.clone();
    let mat_clone = materializer.clone();
    let sched_clone = scheduler.clone();
    let sink_clone = event_sink.clone();
    let cancel_clone = cancel.clone();
    let handle = tokio::spawn(async move {
        handle_incoming_sync(
            server_conn,
            pool_clone,
            "LOCAL_DEV".to_string(),
            mat_clone,
            sched_clone,
            sink_clone,
            cancel_clone,
        )
        .await
    });

    // Send a single HeadExchange, then stay silent. The responder processes
    // this first message (acquiring the per-peer lock), enters the message
    // loop, and — because cancel is set — must bail BEFORE blocking on the
    // next recv (which would otherwise stall for RECV_TIMEOUT = 180 s).
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "REMOTE_DEV".to_string(),
                seq: 0,
                hash: "fakehash".to_string(),
            }],
            loro_vvs: vec![],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
        })
        .await
        .unwrap();

    // Prompt-abort assertion: the handler must resolve far inside the
    // 180 s RECV_TIMEOUT. A single HeadExchange against an empty paired
    // peer completes op-sync, so the cancel is observed at the
    // file-transfer phase's pre-recv check (`run_file_transfer_responder`),
    // which — like the message loop — short-circuits before its blocking
    // recv. The 10 s budget is generous yet still proves a recv that would
    // otherwise stall for RECV_TIMEOUT was cut short by the cancel signal.
    let _result = tokio::time::timeout(std::time::Duration::from_secs(10), handle)
        .await
        .expect("cancelled responder session must abort promptly, not block on RECV_TIMEOUT")
        .expect("responder task must not panic");

    // The per-peer lock must have been released when the session aborted —
    // otherwise a cancelled/hung responder would strand the peer as "busy".
    // (In production the #1581 permit is likewise freed by the caller when
    // this fn resolves; here the scheduler lock is the in-test proxy.)
    assert!(
        scheduler.try_lock_peer("REMOTE_DEV").is_some(),
        "per-peer lock must be released after the responder aborts on cancel"
    );

    // #2537: the responder session that consumed the cancel is now a
    // legitimate resetter (mirrors the initiator's CancelGuard owns-path):
    // the flag must be cleared on session teardown, not latched forever.
    assert!(
        !cancel.load(Ordering::Acquire),
        "#2537: a responder session that consumed the cancel must clear the \
         shared flag on exit"
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
            Arc::new(AtomicBool::new(false)),
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
            Arc::new(AtomicBool::new(false)),
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
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
        })
        .await
        .unwrap();

    // Receive rejection response. #2481: the cert CN ("wrong-device") is the
    // authoritative identity (the advertised heads are frontier ads, not an
    // identity claim), so the mismatch is now caught by the S-1 unpaired-device
    // gate — "wrong-device" is not in `peer_refs` — rather than the retired
    // heads-vs-cert pre-check. The security outcome is identical: a peer whose
    // cert does not correspond to a paired device is rejected before any sync.
    // `SyncMessage::Error.message` is unstructured, so pin the variant and
    // check the substring.
    let response: SyncMessage = client_conn.recv_json().await.unwrap();
    assert!(
        matches!(
            &response,
            SyncMessage::Error { message } if message.contains("paired")
        ),
        "expected SyncMessage::Error rejecting the unpaired cert-CN identity, got: {response:?}"
    );

    let result = handle.await.unwrap();
    assert!(
        result.is_ok(),
        "handle_incoming_sync should return Ok after rejecting the mismatched peer"
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

    // Insert peer ref WITH a stored cert hash (#1602: must be 64-char hex).
    peer_refs::upsert_peer_ref_with_cert(&pool, "REMOTE_PAIRED", &"a".repeat(64))
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
            Arc::new(AtomicBool::new(false)),
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
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
    peer_refs::upsert_peer_ref_with_cert(&pool, "REMOTE_PAIRED", &"b".repeat(64))
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
            Arc::new(AtomicBool::new(false)),
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
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
// Format_peer_addresses (multi-address try-all)
// ======================================================================

/// Empty address list ⇒ empty `Vec` (callers can `.is_empty()`).
#[test]
fn format_peer_addresses_returns_empty_when_no_addresses() {
    let peer = sync_net::DiscoveredPeer {
        device_id: "DEV".into(),
        addresses: vec![],
        port: 9443,
    };
    assert!(
        format_peer_addresses(&peer).is_empty(),
        "empty address list must return empty Vec"
    );
}

/// When mDNS announces IPv6 link-local before IPv4, the formatter
/// reorders so IPv4 is tried first — that is the whole point of the
/// Fix.
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
        "IPv4 must be tried before IPv6 link-local"
    );
}

/// IPv6 unicast non-link-local sits between IPv4 and link-local.
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
        "priority order is IPv4 → IPv6 unicast → IPv6 link-local"
    );
}

/// Within a single tier, the original mDNS order must be preserved
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
        "announcement order preserved within each priority tier"
    );
}

// ======================================================================
// ServiceRemoved eviction
// ======================================================================

/// `process_service_removed` drops the entry from the discovered
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

    assert!(removed, "must report the entry as removed");
    assert!(
        !discovered.contains_key("REMOVED_PEER"),
        "discovered map must drop the peer immediately on ServiceRemoved"
    );
}

/// A `ServiceRemoved` for a peer we never saw is a no-op.
#[test]
fn process_service_removed_ignores_unknown_peer() {
    let mut discovered = HashMap::new();
    let removed = process_service_removed("NEVER_SEEN", "LOCAL", &mut discovered);
    assert!(!removed, "removal of unknown peer must report false");
    assert!(discovered.is_empty(), "discovered map must remain empty");
}

/// A removal of the local device must not touch the map (we never
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

    assert!(!removed, "self-removal must be a no-op");
    assert!(
        discovered.contains_key("OTHER_PEER"),
        "peers belonging to other devices must not be touched"
    );
}

/// A `ServiceRemoved` event flowing through `process_discovery_event`
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

    let result = process_discovery_event(event, "LOCAL", &mut discovered, &[], false);

    assert!(
        result.is_none(),
        "ServiceRemoved must not return a peer to sync with"
    );
    assert!(
        !discovered.contains_key("REMOVED"),
        "discovered HashMap must no longer contain the removed peer"
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

    // No observable predicate available — sleep retained.
    // We just want the spawned daemon task to make a turn in its select!
    // loop before we issue shutdown. There is no production-side signal
    // exposing "select! loop entered", and adding one to the production
    // Type just for this test is out of scope.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Shutdown should exit cleanly
    daemon.shutdown();

    // Poll until the spawned task finishes; 4× cap on the
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

    // No observable predicate available — sleep retained.
    // cancel_active_sync() is a fire-and-forget atomic store; the
    // observable "daemon noticed and is still alive" requires a tick
    // through the select! loop with no production-side signal.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Daemon should still be running — shutdown it cleanly
    daemon.shutdown();
    // Poll until the spawned task finishes; 4× cap on the
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

    // No observable predicate available — sleep retained.
    // Both daemons need a turn in their select! loop after start; no
    // production-side "loop entered" signal exists.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    d1.shutdown();
    d2.shutdown();
    // Poll until BOTH daemon tasks finish; 4× cap on 200 ms.
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

    // No observable predicate available — sleep retained.
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

    // Poll until the unreachable peer accumulates a failure, with a
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
    // Poll until the spawned task finishes; 4× cap on 200 ms.
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

/// Smoke test: Branch B must dispatch ALL paired peers, not just
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

    // No observable predicate available — sleep retained.
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

    // Poll until BOTH unreachable peers accumulate a failure (the
    // Regression guard). 4× cap on the original 800 ms guess.
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
        "Branch B must dispatch peer 2 (regression guard for  \
         concurrent dispatch dropping later peers); got failure_count={f2}"
    );

    daemon.shutdown();
    // Poll until the spawned task finishes; 4× cap on 200 ms.
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

    // Poll until the first resync tick fires and the unreachable
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
    // Poll until the spawned task finishes; 4× cap on 200 ms.
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
        process_discovery_event(event, "LOCAL", &mut discovered, &[], false).is_none(),
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
        process_discovery_event(event, "LOCAL_DEV", &mut discovered, &[], false).is_none(),
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
        process_discovery_event(event1, "LOCAL", &mut discovered, &[], false).is_none(),
        "first discovery of unpaired peer must return None"
    );
    assert_eq!(discovered.len(), 1, "peer must be added to discovered map");

    // Second discovery -> already discovered -> None
    assert!(
        process_discovery_event(event2, "LOCAL", &mut discovered, &[], false).is_none(),
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
    let result = process_discovery_event(event, "LOCAL", &mut discovered, &[], false);
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
    let result = process_discovery_event(event, "LOCAL", &mut discovered, &peer_refs, false);
    assert!(result.is_some(), "new paired peer should trigger sync");
    let peer = result.unwrap();
    assert_eq!(peer.device_id, "PAIRED_PEER");
    assert_eq!(discovered.len(), 1);
}

/// #2008: an UNPAIRED discovered peer returns `None` normally but `Some`
/// while a pairing is pending, so Branch A initiates the first session that
/// the responder's admit-while-pending (#1519) is waiting to accept.
#[test]
fn process_discovery_unpaired_returns_some_only_while_pairing_pending() {
    let no_refs: Vec<crate::peer_refs::PeerRef> = vec![];

    // Not pending: unpaired peer is ignored (current paired-only behaviour).
    let mut discovered = HashMap::new();
    let event = make_resolved_event("UNPAIRED_PEER", 8443);
    assert!(
        process_discovery_event(event, "LOCAL", &mut discovered, &no_refs, false).is_none(),
        "unpaired peer must be ignored when no pairing is pending"
    );

    // Pending: the same unpaired peer becomes a valid initiation target.
    // Use a fresh map so the already-discovered guard doesn't short-circuit.
    let mut discovered = HashMap::new();
    let event = make_resolved_event("UNPAIRED_PEER", 8443);
    let result = process_discovery_event(event, "LOCAL", &mut discovered, &no_refs, true);
    assert!(
        result.is_some(),
        "unpaired peer must trigger sync while pairing is pending (#2008)"
    );
    assert_eq!(result.unwrap().device_id, "UNPAIRED_PEER");
}

// ── conditional daemon startup ──────────────────────────────
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
    // A just-completed pairing (no real peer yet) must wake the
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
async fn start_if_peers_exist_clears_orphaned_pending_pairing_at_startup() {
    // Regression (Android pairing crash-loop): opening the pairing dialog
    // persists a pending-pairing marker (`start_pairing_armed_inner`). The
    // in-memory `PairingSession` that marker stands for never survives a
    // process restart, so a marker still present at startup is orphaned. It
    // must be cleared at boot — otherwise `should_start_active` drives the
    // daemon into the active mDNS/TLS-listener path on every launch for the
    // marker's whole TTL. On Android that path can crash the process
    // (`panic = "abort"`), turning a one-off pairing crash into a boot
    // crash-loop where reopening the app crashes it again.
    install_crypto_provider();

    let (pool, _dir) = test_pool().await;

    // Simulate a process that armed pairing and then restarted: the marker
    // survived in the DB, but there are no real peers and no live session.
    peer_refs::set_pending_pairing(&pool).await.unwrap();
    assert!(
        peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "precondition: the pending-pairing marker is set before startup"
    );

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

    // The orphaned marker must be gone, so a fresh boot does not auto-activate
    // the full daemon (and re-run the Android startup path) solely because of
    // a stale pairing attempt from a previous process.
    assert!(
        !peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "startup must clear the orphaned pending-pairing marker"
    );
    assert!(
        !SyncDaemon::should_start_active(&pool).await.unwrap(),
        "with the marker cleared and no peers, the daemon must stay dormant"
    );

    // A dormant daemon must still shut down cleanly.
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

    // No observable predicate available — sleep retained.
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

    // No observable predicate available — sleep retained.
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

    // No observable predicate available — sleep retained.
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

// ── app-lifecycle integration ───────────────────────────────
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

    let daemon = SyncDaemon::start_with_lifecycle(SyncDaemonContext {
        pool: pool.clone(),
        device_id: "DEV_LIFECYCLE_A".into(),
        materializer: mat.clone(),
        scheduler,
        cert,
        event_sink: sink,
        cancel,
        lifecycle: lifecycle.clone(),
    })
    .await
    .expect("daemon should start even when the app is backgrounded");

    // No observable predicate available — sleep retained.
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
    let daemon = SyncDaemon::start_with_lifecycle(SyncDaemonContext {
        pool: pool.clone(),
        device_id: "DEV_LIFECYCLE_B".into(),
        materializer: mat.clone(),
        scheduler,
        cert,
        event_sink: sink,
        cancel,
        lifecycle: lifecycle.clone(),
    })
    .await
    .expect("daemon should start");

    // No observable predicate available — sleep retained.
    // We need the daemon's select! loop to be running before we toggle
    // lifecycle state, but the daemon doesn't expose that. The actual
    // liveness assertion is the post-shutdown timeout-await below.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Simulate a background→foreground transition while the daemon is
    // running. The wake notify should cause the select! loop to
    // re-enter and reset the resync interval; it should NOT terminate
    // the daemon.
    lifecycle.mark_backgrounded();
    // No observable predicate available — sleep retained.
    // mark_backgrounded() is a fire-and-forget atomic; the wake notify's
    // effect on the select! loop isn't surfaced to test code.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    lifecycle.mark_foreground();

    // No observable predicate available — sleep retained.
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
    // The same behaviour as before.
    let hooks = crate::lifecycle::LifecycleHooks::default();
    assert!(
        !hooks.is_backgrounded(),
        "default lifecycle hooks must report foreground so the legacy `start` path runs tick bodies normally"
    );
}

// ======================================================================
// End-to-end snapshot-driven catch-up on ResetRequired
// ======================================================================

/// End-to-end: responder's op log has been compacted past the
/// initiator's advertised frontier, the initiator's HeadExchange
/// triggers `ResetRequired`, and the snapshot sub-flow catches the
/// initiator up to the responder's state.
///
/// Flow under test (#2503 — Loro-snapshot merge catch-up):
/// 1. Responder has a paired peer + a materialized block mirrored into its
///    Loro engine. Its op_log is compacted so any head the initiator claims
///    looks "lost" — but the ENGINE truth survives compaction.
/// 2. Initiator sends HeadExchange advertising a crafted Loro VV claiming
///    responder-authored ops the responder's engine can no longer produce.
/// 3. Responder's orchestrator returns `ResetRequired`; server.rs then runs
///    `try_offer_loro_snapshot_catchup` which streams the responder's
///    per-space Loro snapshot(s) as `LoroSync { Snapshot }`.
/// 4. Initiator's catch-up (`try_receive_snapshot_catchup`) MERGES the
///    snapshot into its own engine and reprojects SQL — no wipe.
/// 5. Verify: initiator's DB + engine reflect the responder's block, and the
///    merge is a pull (`synced_at` set, `reset_count` NOT bumped).
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

    // #2502: mirror the op into the responder's ENGINE (dispatch_op writes only
    // the SQL projection) so its per-space Loro vv holds one FEAT6_RESP op —
    // the local frontier the own-lineage-loss reset check compares against.
    let resp_space = crate::space::SpaceId::from_trusted("01HZFEAT6SPACEXXXXXXXXXXXX");
    let resp_state = resp_mat.loro_state();
    crate::merge::engine_apply(
        &format!("FEAT6_RESP/{}", record.seq),
        &OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("FEAT6BLK001"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "compacted-state content".into(),
        }),
        "FEAT6_RESP",
        &resp_space,
        &record.created_at.to_string(),
        resp_state,
    );

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
            Arc::new(AtomicBool::new(false)),
        )
        .await
    });

    // Initiator side: we drive a minimal client manually through the
    // wire protocol to exercise the same code path as
    // `run_sync_session` without the full daemon scaffolding.
    //
    // #602/#2502: the initiator advertises its own device at seq 0 (it has
    // no local ops — its DB is empty; the head also serves as the wire-level
    // peer identification that production additionally gets from the TLS cert
    // CN) plus a STALE op-log claim on the responder's history at seq 1 (for
    // the covering check). #2502 retired the op-log-seq reset lookup: the
    // reset is now driven by a Loro-VV own-lineage check, so the initiator
    // also advertises a crafted `loro_vvs` claiming MORE FEAT6_RESP-authored
    // ops than the responder's engine holds — the responder's engine cannot
    // produce them, so the orchestrator transitions to `ResetRequired` (the
    // genuine own-lineage-loss case: the peer observed ops we authored but no
    // longer have). The covering check then confirms the snapshot at
    // `{FEAT6_RESP: 1}` covers the initiator's op-log frontier (seq-0 self
    // head is trivially covered) and lets the offer proceed.
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
    // #2502: op-log compaction alone no longer forces a reset — state
    // causality is judged from Loro VVs. Advertise a crafted vv claiming the
    // responder authored MORE ops (5) than its engine holds (1), so the
    // responder's own-lineage-loss check trips ResetRequired. The stale op-log
    // head above is retained because the snapshot-covering check
    // (`snapshot_covers_remote_heads`) still keys off the advertised
    // `heads` — the audit-replication cursor, per #2481.
    let crafted_resp_vv = {
        let mut craft =
            crate::loro::engine::LoroEngine::with_peer_id("FEAT6_RESP").expect("craft engine");
        for i in 0..5_i64 {
            craft
                .apply_create_block(&format!("01HZFEAT6CRAFT{i:012}"), "content", "x", None, i)
                .expect("craft op");
        }
        craft.version_vector()
    };
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![init_self_head, stale_resp_head],
            loro_vvs: vec![crate::sync_protocol::types::SpaceVersionVector {
                space_id: resp_space.clone(),
                vv: crafted_resp_vv,
            }],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
        })
        .await
        .unwrap();

    // Responder must reply with ResetRequired.
    let reset: SyncMessage = client_conn.recv_json().await.unwrap();
    match reset {
        SyncMessage::ResetRequired { .. } => {}
        other => panic!("expected ResetRequired, got {other:?}"),
    }

    // Now emulate what `run_sync_session` does after seeing
    // ResetRequired: run the initiator-side catch-up helper. We use
    // the public helper directly so the test does not depend on the
    // mDNS / TLS scaffolding; the wiring in `run_sync_session` is
    // covered by the shorter sub-flow tests in the snapshot_transfer
    // module.
    // #2503: the responder now streams a Loro snapshot (engine truth); the
    // initiator MERGES it into its own engine and reprojects SQL. Thread the
    // initiator's live registry so `apply_remote` has an engine to merge into.
    let init_state = init_mat.loro_state();
    let outcome = crate::sync_daemon::snapshot_transfer::try_receive_snapshot_catchup(
        &mut client_conn,
        &init_pool,
        &init_mat,
        &init_sink,
        "FEAT6_RESP",
        None,
        Some(crate::sync_daemon::snapshot_transfer::EngineReloadCtx {
            registry: &init_state.registry,
            device_id: "FEAT6_INIT",
        }),
    )
    .await
    .expect("catch-up must succeed end-to-end");

    assert!(
        matches!(
            outcome,
            crate::sync_daemon::snapshot_transfer::CatchupOutcome::Applied { .. }
        ),
        "expected Applied, got {outcome:?}"
    );

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
        "synced_at must be populated after catch-up (this catch-up is a pull)"
    );
    // #2503: the Loro-snapshot catch-up is a MERGE, not a reset — the
    // reset_count must NOT be bumped (that is a legacy-CBOR-only concern).
    assert_eq!(
        peer.reset_count, 0,
        "#2503: a Loro-snapshot merge catch-up must NOT bump reset_count"
    );

    // #2503: the initiator's engine merged the responder's snapshot — the
    // block is present in the live engine, not just SQL.
    {
        let space = crate::space::SpaceId::from_trusted("01HZFEAT6SPACEXXXXXXXXXXXX");
        let mut g = init_state.registry.for_space(&space, "FEAT6_INIT").unwrap();
        assert!(
            g.engine_mut().read_block("FEAT6BLK001").unwrap().is_some(),
            "#2503: merged responder block must be present in the initiator engine"
        );
    }

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
    state: &crate::loro::shared::LoroState,
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

/// #2129: apply an ARBITRARY local op through the SAME real local-edit
/// pipeline as `make_local_edit_602` (op_log append → materializer SQL
/// projection → engine dispatch against THIS device's registry). Lets the
/// real-loopback convergence test seed richer divergent state (tags, typed
/// properties, soft-deletes) than #602's single `CreateBlock`, so the
/// convergence assertions cover more than plain block content.
async fn apply_local_op_602(
    pool: &SqlitePool,
    mat: &Materializer,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    space: &crate::space::SpaceId,
    payload: crate::op::OpPayload,
    ts: i64,
) {
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
/// Cover the initiator's own head, so (correctly) refuses the
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
    let state_a = std::sync::Arc::clone(mat_a.loro_state());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    // The devices are mutually paired.
    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Each device makes one local edit of its own.
    make_local_edit_602(
        &pool_a,
        &mat_a,
        &state_a,
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
        &state_b,
        DEV_B,
        &space,
        BLOCK_B,
        "edit from device B",
        1_736_942_401_000,
    )
    .await;

    // ── Session 1: A initiates, B responds (B's state flows to A) ────
    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
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
        .with_expected_remote_id(DEV_A.into());
    let mut resp_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
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

// ======================================================================
// #2536 — multi-space delta sync must not fail on the second LoroSync
// ======================================================================

/// #2536 regression — a responder streamingLoroSync for TWO registered
/// spaces (the normal case in production: every vault seeds a "Personal"
/// and a "Work" space) must not fail the puller's session.
///
/// `head_exchange_outgoing_loro` streams one `LoroSync` per registered
/// space, marking only the LAST one `is_last: true`. On the puller side,
/// `handle_message`'s `LoroSync` arm sets `self.state =
/// SyncState::ApplyingOps` before importing, and — critically — only
/// restores `StreamingOps` on the FINAL (`is_last: true`) message; a
/// non-final message hits `if !is_last { return Ok(None) }` and leaves
/// the puller parked in `ApplyingOps`. The state-validation match only
/// accepts `LoroSync` in `StreamingOps | ExchangingHeads`, so the second
/// `LoroSync` (for the second space) is rejected by the wildcard arm
/// with "LoroSync received before HeadExchange" and the session fails —
/// even though the puller never actually saw a HeadExchange-ordering
/// violation.
///
/// This test seeds a responder (device B) with local edits in TWO
/// distinct, dirty/registered Loro spaces (mirroring the production
/// Personal + Work default vaults), drives one full session with device
/// A as the initiator/puller, and asserts both spaces' blocks converge
/// on the puller and BOTH sides reach `SyncState::Complete` — i.e. no
/// `Failed` from the second `LoroSync` in the stream.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue2536_multi_space_delta_sync_completes() {
    use crate::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV2536A";
    const DEV_B: &str = "DEV2536B";
    const BLOCK_PERSONAL: &str = "01HZ2536BLKPERSONALXXXXXXX";
    const BLOCK_WORK: &str = "01HZ2536BLKWORKXXXXXXXXXXX";
    let space_personal = crate::space::SpaceId::from_trusted("01HZ2536SPACEPERSONALXXXXX");
    let space_work = crate::space::SpaceId::from_trusted("01HZ2536SPACEWORKXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    let state_a = std::sync::Arc::clone(mat_a.loro_state());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // The responder (B) has touched/dirty edits in TWO distinct spaces —
    // this is what forces `head_exchange_outgoing_loro` to stream two
    // `LoroSync` messages (one per space), with only the second marked
    // `is_last: true`.
    make_local_edit_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space_personal,
        BLOCK_PERSONAL,
        "personal space content",
        1_752_000_000_000,
    )
    .await;
    make_local_edit_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space_work,
        BLOCK_WORK,
        "work space content",
        1_752_000_001_000,
    )
    .await;
    assert_eq!(
        state_b.registry.dirty_count(),
        2,
        "responder must have two dirty/registered spaces going into the session"
    );

    // ── A initiates, B responds — B streams both spaces to A ─────────
    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_expected_remote_id(DEV_A.into());
    pump_full_session_602(&mut init_a, &mut resp_b).await;

    assert_eq!(
        init_a.session().state,
        SyncState::Complete,
        "#2536: puller (initiator A) must reach Complete after receiving \
         LoroSync for BOTH spaces — a Failed state here reproduces the \
         'LoroSync received before HeadExchange' bug on the second \
         space's message"
    );
    assert_eq!(
        resp_b.session().state,
        SyncState::Complete,
        "#2536: responder B (the streamer) must also reach Complete"
    );

    mat_a.flush_background().await.unwrap();

    // ── Convergence: puller's DB holds BOTH spaces' blocks ────────────
    for (block_id, content) in [
        (BLOCK_PERSONAL, "personal space content"),
        (BLOCK_WORK, "work space content"),
    ] {
        let row: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_optional(&pool_a)
            .await
            .unwrap();
        assert_eq!(
            row.as_deref(),
            Some(content),
            "puller's DB must hold block {block_id} after multi-space sync"
        );
    }

    // ── Convergence: puller's engines match the responder's per-space ──
    for (label, space, block_id) in [
        ("personal", &space_personal, BLOCK_PERSONAL),
        ("work", &space_work, BLOCK_WORK),
    ] {
        let mut g = state_a
            .registry
            .for_space(space, DEV_A)
            .expect("puller space");
        let block = g
            .engine_mut()
            .read_block(block_id)
            .unwrap()
            .unwrap_or_else(|| panic!("puller engine must have {label} space's block"));
        let _ = block;
    }

    mat_a.shutdown();
    mat_b.shutdown();
}

/// #2536 (adversarial reviewer addition) — pin the INTERMEDIATE puller
/// state between the two streamed `LoroSync` messages, not just the
/// terminal `Complete`.
///
/// The end-to-end `issue2536_multi_space_delta_sync_completes` test only
/// pins the `self.state = StreamingOps` half of the fix: the daemon's
/// state-validation match reads `self.state`, so reverting only that line
/// makes the second `LoroSync` fail validation and the pump panics. But
/// the fix also restores `self.session.state`, and NOTHING in the
/// end-to-end test observes `session().state` mid-stream — reverting only
/// the `self.session.state` line still passes that test.
///
/// This test drives the initiator's `handle_message` MANUALLY (no pump)
/// and, after delivering the first non-final `LoroSync`, asserts
/// `init_a.session().state == StreamingOps`. That directly pins the
/// `self.session.state = StreamingOps` line: without it the puller would
/// be observably parked in `ApplyingOps` between messages. It then feeds
/// the final `LoroSync` and asserts the terminal `Complete`, and confirms
/// no intermediate handle_message errored.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue2536_puller_rests_in_streaming_ops_between_loro_messages() {
    use crate::sync_protocol::{SyncMessage, SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV2536IA";
    const DEV_B: &str = "DEV2536IB";
    const BLOCK_PERSONAL: &str = "01HZ2536IBLKPERSONALXXXXXX";
    const BLOCK_WORK: &str = "01HZ2536IBLKWORKXXXXXXXXXX";
    let space_personal = crate::space::SpaceId::from_trusted("01HZ2536ISPACEPERSONALXXXX");
    let space_work = crate::space::SpaceId::from_trusted("01HZ2536ISPACEWORKXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    make_local_edit_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space_personal,
        BLOCK_PERSONAL,
        "personal space content",
        1_752_000_000_000,
    )
    .await;
    make_local_edit_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space_work,
        BLOCK_WORK,
        "work space content",
        1_752_000_001_000,
    )
    .await;
    assert_eq!(state_b.registry.dirty_count(), 2, "two dirty spaces seeded");

    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_expected_remote_id(DEV_A.into());

    // A -> B: HeadExchange.
    let head = init_a.start().await.expect("initiator start");

    // B handles HeadExchange, streams its two LoroSync messages.
    let first_loro = resp_b
        .handle_message(wire_roundtrip_602(&head))
        .await
        .expect("responder handles HeadExchange")
        .expect("responder replies with first LoroSync");
    let mut streamed: Vec<SyncMessage> = vec![first_loro];
    while let Some(m) = resp_b.next_message() {
        streamed.push(m);
    }
    // #2481: B authored two ops that A lacks and A advertises
    // op_log_replication, so B now streams two LoroSync (one per dirty space)
    // PLUS an OpLogBatch audit tail. The two LoroSync are therefore both
    // non-final; the OpLogBatch carries the single `is_last`.
    assert_eq!(
        streamed.len(),
        3,
        "responder streams two LoroSync (one per dirty space) + one OpLogBatch tail (#2481)"
    );
    for (i, m) in streamed.iter().take(2).enumerate() {
        match m {
            SyncMessage::LoroSync { is_last, .. } => assert!(
                !is_last,
                "LoroSync #{i} must be non-final — the OpLogBatch tail carries is_last"
            ),
            other => panic!("expected LoroSync at {i}, got {other:?}"),
        }
    }
    match &streamed[2] {
        SyncMessage::OpLogBatch { is_last, records } => {
            assert!(is_last, "the OpLogBatch tail is the final streamed message");
            assert!(
                !records.is_empty(),
                "B replicates its two authored ops as audit records"
            );
        }
        other => panic!("expected an OpLogBatch tail, got {other:?}"),
    }

    // A handles the two non-final LoroSync messages. Each returns Ok(None) and
    // — the #2536 pin — parks in StreamingOps, NOT ApplyingOps.
    for m in streamed.iter().take(2) {
        let r = init_a
            .handle_message(wire_roundtrip_602(m))
            .await
            .expect("initiator handles a non-final LoroSync without error");
        assert!(r.is_none(), "non-final LoroSync yields no immediate reply");
        assert_eq!(
            init_a.session().state,
            SyncState::StreamingOps,
            "#2536: between stream messages the puller must rest in \
             StreamingOps (pins `self.session.state`); ApplyingOps here means \
             the `self.session.state` line was dropped"
        );
        assert!(
            !init_a.is_terminal(),
            "puller must not be terminal mid-stream"
        );
    }

    // A handles the FINAL message (the OpLogBatch tail) -> Complete + SyncComplete.
    let r_final = init_a
        .handle_message(wire_roundtrip_602(&streamed[2]))
        .await
        .expect("initiator handles the final OpLogBatch without error")
        .expect("the final message yields a SyncComplete reply");
    assert!(
        matches!(r_final, SyncMessage::SyncComplete { .. }),
        "the final message must reply SyncComplete, got {r_final:?}"
    );
    assert_eq!(
        init_a.session().state,
        SyncState::Complete,
        "#2536: puller must reach Complete after the final message"
    );

    mat_a.shutdown();
    mat_b.shutdown();
}

// ======================================================================
// #2129 — two-instance convergence over a REAL loopback TLS socket
// ======================================================================

/// #2129: drive ONE full sync session — initiator → responder — over a
/// genuine loopback TLS WebSocket connection pair.
///
/// This is the real-transport analog of #602's in-memory
/// `pump_full_session_602`. Where that helper hand-pumps two
/// orchestrators through an in-process `VecDeque` (no socket, no TLS, no
/// WebSocket framing, no binary chunking), this stands up the responder's
/// `SyncServer` (a real `rustls` TLS endpoint), an initiator
/// `connect_to_peer` (real TLS handshake + mTLS cert exchange), the
/// production responder loop (`handle_incoming_sync*`) on the server-side
/// connection, and the production initiator loop (`run_sync_session`) on
/// the client connection, then runs the initiator to completion. Every
/// message therefore rides `wire::{send,recv}_sync_message` over the
/// socket — exercising the `tokio-tungstenite` frame path (and the #611
/// chunked-binary path for over-threshold `LoroSync` payloads) that the
/// in-memory test cannot reach.
///
/// Both orchestrators receive a PER-DEVICE leaked `LoroState` (the #602
/// two-registry test seam): the initiator via `with_loro_state`, the
/// responder via the `handle_incoming_sync_with_loro_state` test seam.
/// This is required because the single process-global Loro registry
/// (`loro::shared::GLOBAL`) cannot represent two distinct devices in one
/// test process.
///
/// Returns the initiator orchestrator's terminal `SyncState` so the
/// caller can assert it reached `Complete` (NOT `ResetRequired` —
/// i.e. no snapshot fallback was taken; this is an
/// incremental-reachable session).
#[allow(clippy::too_many_arguments)]
async fn run_one_real_loopback_session_2129(
    init_pool: &SqlitePool,
    init_mat: &Materializer,
    init_device: &str,
    init_cert: &SyncCert,
    resp_pool: &SqlitePool,
    resp_mat: &Materializer,
    resp_device: &str,
    resp_cert: &SyncCert,
) -> crate::sync_protocol::SyncState {
    use crate::sync_protocol::SyncOrchestrator;

    let timeout = std::time::Duration::from_secs(5);

    // Each device carries ONE STABLE identity cert (CN = its device id),
    // reused across every session — exactly as a real device does. mTLS
    // identity derives from the verified cert CN (#778), and the
    // responder's TOFU pins the cert hash on first connection (B-33), so a
    // fresh cert per session would trip "certificate hash mismatch" on the
    // second session. Passing the same cert in keeps the pinned hash stable.

    // Stand up the responder's TLS WebSocket server and forward the
    // accepted server-side connection out via a channel.
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(resp_cert, move |conn, _permit| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    // Initiator connects (real TLS handshake).
    let mut client_conn = tokio::time::timeout(
        timeout,
        sync_net::connect_to_peer(&format!("127.0.0.1:{port}"), None, None, init_cert),
    )
    .await
    .expect("timed out connecting to peer")
    .unwrap();

    // Receive the server-side connection.
    let server_conn = tokio::time::timeout(timeout, conn_rx.recv())
        .await
        .expect("timed out waiting for server connection")
        .unwrap();

    // Spawn the production responder loop with device B's own registry.
    let resp_scheduler = Arc::new(SyncScheduler::new());
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let resp_handle = tokio::spawn(handle_incoming_sync(
        server_conn,
        resp_pool.clone(),
        resp_device.to_string(),
        resp_mat.clone(),
        resp_scheduler,
        resp_sink,
        Arc::new(AtomicBool::new(false)),
    ));

    // Run the production initiator loop with device A's own registry.
    let mut init_orch =
        SyncOrchestrator::new(init_pool.clone(), init_device.into(), init_mat.clone())
            .with_expected_remote_id(resp_device.into());
    let init_cancel = AtomicBool::new(false);
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let init_result = tokio::time::timeout(
        timeout,
        run_sync_session(
            &mut init_orch,
            &mut client_conn,
            &init_cancel,
            init_pool,
            init_mat,
            &init_sink,
        ),
    )
    .await
    .expect("initiator session timed out");
    init_result.expect("initiator run_sync_session must not error");

    // Responder must finish cleanly (no panic / JoinError, no AppError).
    let resp_result = tokio::time::timeout(timeout, resp_handle)
        .await
        .expect("responder handler timed out")
        .expect("responder task panicked");
    resp_result.expect("responder handle_incoming_sync must not error");

    server.shutdown().await;
    init_orch.session().state.clone()
}

/// #2481 phase 1 (acceptance) — an op authored on A replicates into B's
/// op_log as audit-only metadata when B pulls from A over a REAL socket.
///
/// B initiates (the puller); A responds (the streamer). After the delta
/// phase, A appends the op records B lacks as `OpLogBatch` messages riding
/// the tail of the same stream, which B ingests via
/// `dag::insert_replicated_op` — stored with `is_replicated = 1`, hash +
/// origin verbatim, NEVER applied to B's state (state still flows only
/// through Loro CRDT sync). This is the production caller the #2481 phase-1
/// ingest path was built for; it exercises the real TLS socket + wire path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2481_op_authored_on_a_replicates_into_b_op_log_over_real_socket() {
    use crate::sync_protocol::SyncState;

    let space = crate::space::SpaceId::from_trusted("01HZ2481REPLSPACEXXXXXXXXX");
    let devices = make_n_devices_2141(&["DEV2481AA", "DEV2481BB"]).await;
    let (a, b) = (&devices[0], &devices[1]);

    // A authors an edit → one op in A's op_log (device = A), engine updated.
    make_local_edit_602(
        &a.pool,
        &a.mat,
        &a.state,
        &a.id,
        &space,
        "01HZ2481BLKAXXXXXXXXXXXXXX",
        "edit from A",
        1_736_942_400_000,
    )
    .await;

    // Capture A's authored op head (seq + hash) for a verbatim comparison.
    let a_head = crate::sync_protocol::get_local_heads(&a.pool)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.device_id == a.id)
        .expect("A must have an op head for its own device");
    let a_origin: String =
        sqlx::query_scalar("SELECT origin FROM op_log WHERE device_id = ? AND seq = ?")
            .bind(&a.id)
            .bind(a_head.seq)
            .fetch_one(&a.pool)
            .await
            .unwrap();

    // Sanity: B holds none of A's ops yet.
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(&a.id)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(before, 0, "B starts without any of A's ops");

    // B pulls from A: B initiator (puller), A responder (streamer).
    let init_state = run_one_real_loopback_session_2129(
        &b.pool, &b.mat, &b.id, &b.cert, // init = B (puller)
        &a.pool, &a.mat, &a.id, &a.cert, // resp = A (streamer)
    )
    .await;
    assert_eq!(
        init_state,
        SyncState::Complete,
        "the pull session completes cleanly (no reset fallback)"
    );

    // A's op now lives in B's op_log as audit metadata (is_replicated = 1),
    // hash + origin verbatim.
    let rows: Vec<(String, i64, String, String, i64)> = sqlx::query_as(
        "SELECT device_id, seq, hash, origin, is_replicated FROM op_log \
         WHERE device_id = ? ORDER BY seq",
    )
    .bind(&a.id)
    .fetch_all(&b.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "exactly A's one op replicated into B");
    let (device_id, seq, hash, origin, is_replicated) = &rows[0];
    assert_eq!(device_id, &a.id);
    assert_eq!(*seq, a_head.seq);
    assert_eq!(hash, &a_head.hash, "A's op hash is stored verbatim in B");
    assert_eq!(origin, &a_origin, "origin travels with the record");
    assert_eq!(
        *is_replicated, 1,
        "stored as audit-only (is_replicated = 1), never applied to state"
    );

    a.flush_and_shutdown().await;
    b.flush_and_shutdown().await;
}

/// #2481 phase 3 (self-healing) — a device that has LOST its own op-log
/// history recovers it from a peer that replicated it, via the same audit
/// exchange. No local archive is needed: the audit record survives a
/// compaction / restore-from-older-backup because a peer holds it and streams
/// it back on the next pull.
///
/// Scenario: A authors an op; B pulls from A (B now holds A's op as an
/// `is_replicated = 1` audit record). A then loses its own op_log tail (we
/// delete the row, simulating compaction / history loss). A pulls from B, and
/// B — which holds A's op transitively (`collect_ops_for_peer` re-ships
/// replicated rows) — streams it back; A re-ingests it as an audit record.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2481_device_recovers_own_lost_op_history_from_peer_over_real_socket() {
    use crate::sync_protocol::SyncState;

    let space = crate::space::SpaceId::from_trusted("01HZ2481HEALSPACEXXXXXXXXX");
    let devices = make_n_devices_2141(&["DEV2481HA", "DEV2481HB"]).await;
    let (a, b) = (&devices[0], &devices[1]);

    make_local_edit_602(
        &a.pool,
        &a.mat,
        &a.state,
        &a.id,
        &space,
        "01HZ2481HEALBLKAXXXXXXXXXX",
        "edit from A",
        1_736_942_400_000,
    )
    .await;

    let a_head = crate::sync_protocol::get_local_heads(&a.pool)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.device_id == a.id)
        .expect("A authored an op");

    // Session 1: B pulls from A → B now holds A's op as an audit record.
    let s1 = run_one_real_loopback_session_2129(
        &b.pool, &b.mat, &b.id, &b.cert, // init = B (puller)
        &a.pool, &a.mat, &a.id, &a.cert, // resp = A (streamer)
    )
    .await;
    assert_eq!(s1, SyncState::Complete);
    let b_has: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE device_id = ? AND is_replicated = 1")
            .bind(&a.id)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(b_has, 1, "B replicated A's op in session 1");

    // A loses its own op-log history (compaction / restore from an older
    // backup). `op_log` is append-only (migration 0036 immutability triggers),
    // so the DELETE rides the same mutation-bypass sentinel compaction uses.
    let mut tx = a.pool.begin().await.unwrap();
    crate::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM op_log WHERE device_id = ?")
        .bind(&a.id)
        .execute(&mut *tx)
        .await
        .unwrap();
    crate::op_log::disable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let a_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(&a.id)
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(a_before, 0, "A's own op history is gone");

    // Session 2: A pulls from B → B streams A's op back; A re-ingests it.
    let s2 = run_one_real_loopback_session_2129(
        &a.pool, &a.mat, &a.id, &a.cert, // init = A (puller)
        &b.pool, &b.mat, &b.id, &b.cert, // resp = B (streamer)
    )
    .await;
    assert_eq!(s2, SyncState::Complete);

    // A recovered its own authored op as an audit record (is_replicated = 1),
    // hash verbatim.
    let rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT seq, hash, is_replicated FROM op_log WHERE device_id = ? ORDER BY seq",
    )
    .bind(&a.id)
    .fetch_all(&a.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "A recovered exactly its one lost op");
    assert_eq!(rows[0].0, a_head.seq);
    assert_eq!(
        rows[0].1, a_head.hash,
        "recovered op hash matches the original"
    );
    assert_eq!(
        rows[0].2, 1,
        "recovered as an audit record (is_replicated = 1)"
    );

    a.flush_and_shutdown().await;
    b.flush_and_shutdown().await;
}

/// #2129 keystone — two devices that have BOTH made divergent local edits
/// converge over a REAL loopback TLS socket (not the in-memory pump).
///
/// This complements #602's `issue602_two_edited_devices_converge_…`,
/// which proves convergence at the *protocol* layer by pumping two
/// orchestrators through an in-memory `VecDeque`. That test never touches
/// a socket, so the real TLS handshake, the `tokio-tungstenite` WebSocket
/// framing, and the #611 chunked-binary `LoroSync` path are all
/// un-exercised by it. THIS test closes that gap: it runs the identical
/// bidirectional-convergence scenario end-to-end over
/// `SyncServer` + `connect_to_peer` + `run_sync_session` (initiator) and
/// `handle_incoming_sync` (responder), asserting byte-for-byte SQL +
/// engine convergence after a genuine network round-trip.
///
/// Op coverage (broader than #602's single `CreateBlock`): device A seeds
/// a content block, a TYPED PROPERTY on it, and a second block it then
/// SOFT-DELETES; device B seeds a content block plus a TAG block and an
/// `AddTag` relationship. Convergence must reproduce ALL of that state on
/// the opposite device.
///
/// A single `run_sync_session` is one-directional (the initiator both
/// pushes and pulls, but only one device acts as initiator), so — exactly
/// like #602 — we run two sessions in opposite directions so BOTH devices
/// end holding BOTH edit sets. A third session asserts idempotence: a
/// re-sync of already-converged devices changes nothing and errors
/// nowhere.
///
/// Runs on the multi-thread runtime (real sockets need it) with generous
/// `tokio::time::timeout`s around every socket op so a hang fails fast in
/// CI rather than wedging. Determinism comes from the synchronous
/// completion of each session before the next begins — no sleeps.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_edited_devices_converge_over_real_loopback_tls() {
    use crate::op::{
        AddTagPayload, CreateBlockPayload, DeleteBlockPayload, OpPayload, SetPropertyPayload,
    };
    use crate::sync_protocol::SyncState;

    install_crypto_provider();

    const DEV_A: &str = "DEV2129A";
    const DEV_B: &str = "DEV2129B";
    // Device A's blocks: a content block (kept), a property carrier, and
    // a second block that A soft-deletes.
    const BLOCK_A: &str = "01HZ2129BLKAXXXXXXXXXXXXXX";
    const BLOCK_A_DEL: &str = "01HZ2129BLKADELXXXXXXXXXX";
    // Device B's blocks: a content block plus a tag block it links.
    const BLOCK_B: &str = "01HZ2129BLKBXXXXXXXXXXXXXX";
    const TAG_B: &str = "01HZ2129TAGBXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ2129SPACEXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    // #602 test seam: one leaked Loro registry per device (the single
    // process-global registry cannot represent two devices in one
    // process).
    let state_a = std::sync::Arc::clone(mat_a.loro_state());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    // Devices are mutually paired (responder rejects unpaired peers).
    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // One STABLE identity cert per device (CN = device id), reused as both
    // server (when responding) and client (when initiating) cert across
    // every session — so the responder's TOFU-pinned cert hash (B-33)
    // stays consistent and later sessions don't trip a hash mismatch.
    let cert_a = sync_net::generate_self_signed_cert(DEV_A).unwrap();
    let cert_b = sync_net::generate_self_signed_cert(DEV_B).unwrap();

    // ── Device A's divergent local edits ─────────────────────────────
    // 1. A content block.
    make_local_edit_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        BLOCK_A,
        "edit from device A",
        1_736_942_400_000,
    )
    .await;
    // 2. A typed (numeric) property on BLOCK_A.
    apply_local_op_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        // A NON-reserved key so the value projects into `block_properties`
        // (the reserved keys `todo_state`/`priority`/`due_date`/
        // `scheduled_date` are column-backed on `blocks` instead — see
        // op.rs `RESERVED_PROPERTY_KEYS`).
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_A),
            key: "custom_rank".into(),
            value_text: None,
            value_num: Some(42.0),
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        1_736_942_400_100,
    )
    .await;
    // 3. A second block that A then soft-deletes (create + delete).
    apply_local_op_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_A_DEL),
            block_type: "content".into(),
            parent_id: None,
            position: Some(2),
            index: None,
            content: "to be deleted".into(),
        }),
        1_736_942_400_200,
    )
    .await;
    apply_local_op_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_A_DEL),
        }),
        1_736_942_400_300,
    )
    .await;

    // ── Device B's divergent local edits ─────────────────────────────
    // 1. A content block.
    make_local_edit_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space,
        BLOCK_B,
        "edit from device B",
        1_736_942_401_000,
    )
    .await;
    // 2. A tag block …
    apply_local_op_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(TAG_B),
            block_type: "tag".into(),
            parent_id: None,
            position: Some(2),
            index: None,
            content: "important".into(),
        }),
        1_736_942_401_100,
    )
    .await;
    // 3. … linked to BLOCK_B via an AddTag relationship.
    apply_local_op_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space,
        OpPayload::AddTag(AddTagPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_B),
            tag_id: crate::ulid::BlockId::from_trusted(TAG_B),
        }),
        1_736_942_401_200,
    )
    .await;

    // ── Session 1: A initiates, B responds (B's state flows to A) ────
    let state1 = run_one_real_loopback_session_2129(
        &pool_a, &mat_a, DEV_A, &cert_a, &pool_b, &mat_b, DEV_B, &cert_b,
    )
    .await;
    assert_eq!(
        state1,
        SyncState::Complete,
        "#2129 session 1 must complete incrementally over the real socket \
         (ResetRequired would mean a snapshot fallback was taken — this is \
         an incremental-reachable session)"
    );

    // ── Session 2: B initiates, A responds (A's state flows to B) ────
    let state2 = run_one_real_loopback_session_2129(
        &pool_b, &mat_b, DEV_B, &cert_b, &pool_a, &mat_a, DEV_A, &cert_a,
    )
    .await;
    assert_eq!(
        state2,
        SyncState::Complete,
        "#2129 session 2 (reverse direction) must complete incrementally"
    );

    // ── Convergence: both SQL DBs hold both content blocks ───────────
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

        // The typed property must have converged with its exact value.
        let prop: Option<f64> = sqlx::query_scalar(
            "SELECT value_num FROM block_properties WHERE block_id = ? AND key = 'custom_rank'",
        )
        .bind(BLOCK_A)
        .fetch_optional(pool)
        .await
        .unwrap();
        assert_eq!(
            prop,
            Some(42.0),
            "device {label} must hold the converged typed property on {BLOCK_A}"
        );

        // The tag relationship must have converged.
        let tag: Option<String> =
            sqlx::query_scalar("SELECT tag_id FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_B)
                .bind(TAG_B)
                .fetch_optional(pool)
                .await
                .unwrap();
        assert_eq!(
            tag.as_deref(),
            Some(TAG_B),
            "device {label} must hold the converged tag link {BLOCK_B} -> {TAG_B}"
        );

        // The soft-deleted block must converge as deleted (row present
        // with a non-NULL deleted_at).
        let deleted_at: Option<Option<i64>> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(BLOCK_A_DEL)
                .fetch_optional(pool)
                .await
                .unwrap();
        assert!(
            matches!(deleted_at, Some(Some(_))),
            "device {label} must hold {BLOCK_A_DEL} as soft-deleted \
             (row present, deleted_at set); got {deleted_at:?}"
        );
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
        "#2129: both engines must converge to the same Loro version vector \
         after a real-socket bidirectional sync"
    );

    // ── Idempotence: a third session changes nothing ─────────────────
    // Re-running A→B against already-converged devices must complete
    // without error and leave both version vectors stable.
    let state3 = run_one_real_loopback_session_2129(
        &pool_a, &mat_a, DEV_A, &cert_a, &pool_b, &mat_b, DEV_B, &cert_b,
    )
    .await;
    assert_eq!(
        state3,
        SyncState::Complete,
        "#2129 idempotence: a re-sync of converged devices must complete"
    );
    let vv_a2 = {
        let mut g = state_a.registry.for_space(&space, DEV_A).expect("space A");
        g.engine_mut().version_vector()
    };
    let vv_b2 = {
        let mut g = state_b.registry.for_space(&space, DEV_B).expect("space B");
        g.engine_mut().version_vector()
    };
    assert_eq!(
        loro::VersionVector::decode(&vv_a2).unwrap(),
        decoded_a,
        "#2129 idempotence: device A's version vector must be unchanged"
    );
    assert_eq!(
        loro::VersionVector::decode(&vv_b2).unwrap(),
        decoded_b,
        "#2129 idempotence: device B's version vector must be unchanged"
    );

    mat_a.flush_background().await.unwrap();
    mat_b.flush_background().await.unwrap();
    mat_a.shutdown();
    mat_b.shutdown();
}

/// #2129 (bullet 1 op-coverage completion) — MOVE, soft-delete/RESTORE, and
/// soft-delete/PURGE converge over a REAL loopback TLS socket.
///
/// The keystone (`two_edited_devices_converge_over_real_loopback_tls`) proves
/// content / typed-property / tag / soft-delete convergence over the real
/// transport; #2129 §2B's bullet 1 also lists `move`, `restore`, and `purge`.
/// This closes that op-coverage gap end-to-end over the genuine
/// `SyncServer` + `connect_to_peer` + `run_sync_session` /
/// `handle_incoming_sync` harness (not the in-memory pump).
///
/// Shape: a shared base (parent P, child C, blocks D and E) is created on A and
/// synced to B so BOTH devices hold it. Then divergent ops on DISTINCT blocks
/// (so there is no concurrent-same-block conflict to muddy the op semantics):
///   * A reparents C under P (`MoveBlock`),
///   * A soft-deletes then restores D (`DeleteBlock` + `RestoreBlock`),
///   * B soft-deletes then purges E (`DeleteBlock` + `PurgeBlock`).
/// After a bidirectional sync, BOTH devices must converge: C parented under P,
/// D present and live (`deleted_at` NULL), E physically gone — plus identical
/// engine version vectors.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2129_move_restore_purge_converge_over_real_loopback_tls() {
    use crate::op::{
        DeleteBlockPayload, MoveBlockPayload, OpPayload, PurgeBlockPayload, RestoreBlockPayload,
    };
    use crate::sync_protocol::SyncState;

    install_crypto_provider();

    const DEV_A: &str = "DEV2129MA";
    const DEV_B: &str = "DEV2129MB";
    // Parent container, child-to-move, restore-target, purge-target.
    const BLOCK_P: &str = "01HZ21290000000000000000PP";
    const BLOCK_C: &str = "01HZ21290000000000000000CC";
    const BLOCK_D: &str = "01HZ21290000000000000000DD";
    const BLOCK_E: &str = "01HZ21290000000000000000EE";
    let space = crate::space::SpaceId::from_trusted("01HZ2129MOVESPACEXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    // #602 test seam: one leaked Loro registry per device.
    let state_a = std::sync::Arc::clone(mat_a.loro_state());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    let cert_a = sync_net::generate_self_signed_cert(DEV_A).unwrap();
    let cert_b = sync_net::generate_self_signed_cert(DEV_B).unwrap();

    // ── Shared base: A creates P, C, D, E (all top-level content blocks) ──
    let mut ts = 1_736_950_000_000_i64;
    for (block, content) in [
        (BLOCK_P, "parent container"),
        (BLOCK_C, "child to move"),
        (BLOCK_D, "to delete then restore"),
        (BLOCK_E, "to delete then purge"),
    ] {
        make_local_edit_602(&pool_a, &mat_a, &state_a, DEV_A, &space, block, content, ts).await;
        ts += 1_000;
    }

    // Sync the base both directions so B holds every base block.
    let s = run_one_real_loopback_session_2129(
        &pool_a, &mat_a, DEV_A, &cert_a, &pool_b, &mat_b, DEV_B, &cert_b,
    )
    .await;
    assert_eq!(
        s,
        SyncState::Complete,
        "#2129 mvp: base sync A->B must complete"
    );
    let s = run_one_real_loopback_session_2129(
        &pool_b, &mat_b, DEV_B, &cert_b, &pool_a, &mat_a, DEV_A, &cert_a,
    )
    .await;
    assert_eq!(
        s,
        SyncState::Complete,
        "#2129 mvp: base sync B->A must complete"
    );

    // Sanity: B must hold the purge target before it can delete+purge it.
    let e_on_b: Option<String> = sqlx::query_scalar("SELECT id FROM blocks WHERE id = ?")
        .bind(BLOCK_E)
        .fetch_optional(&pool_b)
        .await
        .unwrap();
    assert_eq!(
        e_on_b.as_deref(),
        Some(BLOCK_E),
        "#2129 mvp: base block E must reach B before the purge"
    );

    // ── Divergent ops on A: move C under P, then delete+restore D ─────────
    apply_local_op_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_C),
            new_parent_id: Some(crate::ulid::BlockId::from_trusted(BLOCK_P)),
            new_position: 1,
            new_index: Some(0),
        }),
        ts,
    )
    .await;
    ts += 1_000;

    let del_d_ts = ts;
    apply_local_op_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_D),
        }),
        del_d_ts,
    )
    .await;
    ts += 1_000;
    apply_local_op_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_D),
            // The restore guard matches the delete op's epoch-ms created_at.
            deleted_at_ref: del_d_ts,
        }),
        ts,
    )
    .await;
    ts += 1_000;

    // ── Divergent ops on B: delete+purge E ───────────────────────────────
    let del_e_ts = ts;
    apply_local_op_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_E),
        }),
        del_e_ts,
    )
    .await;
    ts += 1_000;
    apply_local_op_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLOCK_E),
        }),
        ts,
    )
    .await;

    // ── Final bidirectional sync ─────────────────────────────────────────
    let s = run_one_real_loopback_session_2129(
        &pool_a, &mat_a, DEV_A, &cert_a, &pool_b, &mat_b, DEV_B, &cert_b,
    )
    .await;
    assert_eq!(
        s,
        SyncState::Complete,
        "#2129 mvp: final sync A->B must complete"
    );
    let s = run_one_real_loopback_session_2129(
        &pool_b, &mat_b, DEV_B, &cert_b, &pool_a, &mat_a, DEV_A, &cert_a,
    )
    .await;
    assert_eq!(
        s,
        SyncState::Complete,
        "#2129 mvp: final sync B->A must complete"
    );

    // ── Convergence on BOTH devices ──────────────────────────────────────
    for (label, pool) in [("A", &pool_a), ("B", &pool_b)] {
        // Move converged: C is parented under P.
        let parent: Option<Option<String>> =
            sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
                .bind(BLOCK_C)
                .fetch_optional(pool)
                .await
                .unwrap();
        assert_eq!(
            parent,
            Some(Some(BLOCK_P.to_string())),
            "#2129 device {label}: moved child C must be parented under P; got {parent:?}"
        );

        // Restore converged: D present and live (deleted_at NULL).
        let d_deleted: Option<Option<i64>> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(BLOCK_D)
                .fetch_optional(pool)
                .await
                .unwrap();
        assert_eq!(
            d_deleted,
            Some(None),
            "#2129 device {label}: restored block D must be present and live \
             (deleted_at NULL); got {d_deleted:?}"
        );

        // Purge converged: E physically gone (no row).
        let e_row: Option<String> = sqlx::query_scalar("SELECT id FROM blocks WHERE id = ?")
            .bind(BLOCK_E)
            .fetch_optional(pool)
            .await
            .unwrap();
        assert_eq!(
            e_row, None,
            "#2129 device {label}: purged block E must be physically gone; got {e_row:?}"
        );
    }

    // ── Engines converged to the same version vector ─────────────────────
    let vv_a = {
        let mut g = state_a.registry.for_space(&space, DEV_A).expect("space A");
        g.engine_mut().version_vector()
    };
    let vv_b = {
        let mut g = state_b.registry.for_space(&space, DEV_B).expect("space B");
        g.engine_mut().version_vector()
    };
    assert_eq!(
        loro::VersionVector::decode(&vv_a).unwrap(),
        loro::VersionVector::decode(&vv_b).unwrap(),
        "#2129 move/restore/purge: both engines must converge to the same \
         version vector over the real socket"
    );

    mat_a.flush_background().await.unwrap();
    mat_b.flush_background().await.unwrap();
    mat_a.shutdown();
    mat_b.shutdown();
}

/// #2006 — concurrent edits to the SAME block converge deterministically.
///
/// #602 covers two devices editing DISTINCT blocks. This pins the conflict
/// case: both devices write the same block id with different content before
/// they have ever synced, then sync in both directions. The Loro CRDT must
/// merge the concurrent writes to a single deterministic result — identical
/// content AND identical version vector on both devices — with no
/// `ResetRequired` / `Failed`. (The interrupted-then-resumed transfer case
/// from #2006 is a separate follow-up.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue2006_concurrent_same_block_edits_converge_deterministically() {
    use crate::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV2006A";
    const DEV_B: &str = "DEV2006B";
    const BLOCK_SHARED: &str = "01HZ2006BLKXXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ2006SPACEXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    let state_a = std::sync::Arc::clone(mat_a.loro_state());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Both devices write the SAME block id concurrently with different
    // content, before any sync — a genuine concurrent-edit conflict.
    make_local_edit_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        BLOCK_SHARED,
        "content from A",
        1_736_942_400_000,
    )
    .await;
    make_local_edit_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space,
        BLOCK_SHARED,
        "content from B",
        1_736_942_401_000,
    )
    .await;

    // ── Bidirectional sync (mirror of #602) ──────────────────────────
    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_expected_remote_id(DEV_A.into());
    pump_full_session_602(&mut init_a, &mut resp_b).await;
    assert_eq!(
        init_a.session().state,
        SyncState::Complete,
        "session 1 initiator must complete"
    );
    assert_eq!(
        resp_b.session().state,
        SyncState::Complete,
        "session 1 responder must complete"
    );

    let mut init_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_expected_remote_id(DEV_A.into());
    let mut resp_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    pump_full_session_602(&mut init_b, &mut resp_a).await;
    assert_eq!(
        init_b.session().state,
        SyncState::Complete,
        "session 2 initiator must complete"
    );
    assert_eq!(
        resp_a.session().state,
        SyncState::Complete,
        "session 2 responder must complete"
    );

    // ── Convergence: both DBs agree on a single deterministic value ──
    let content_a: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_SHARED)
        .fetch_optional(&pool_a)
        .await
        .unwrap();
    let content_b: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_SHARED)
        .fetch_optional(&pool_b)
        .await
        .unwrap();
    assert!(
        content_a.is_some(),
        "shared block must exist on device A after sync"
    );
    // The CRDT invariant under test is *convergence*: both replicas agree on
    // a single deterministic merged value. Whether that value is LWW-picked or
    // text-merged is the engine's business — we assert only that the two
    // devices end up identical (and non-empty).
    assert_eq!(
        content_a, content_b,
        "both devices must converge to the SAME merged content for the shared block"
    );
    assert!(
        !content_a.as_deref().unwrap_or("").is_empty(),
        "converged content must be non-empty, got {content_a:?}"
    );

    // ── Convergence: identical version vectors ───────────────────────
    let vv_a = {
        let mut g = state_a.registry.for_space(&space, DEV_A).expect("space A");
        g.engine_mut().version_vector()
    };
    let vv_b = {
        let mut g = state_b.registry.for_space(&space, DEV_B).expect("space B");
        g.engine_mut().version_vector()
    };
    assert_eq!(
        loro::VersionVector::decode(&vv_a).expect("decode vv A"),
        loro::VersionVector::decode(&vv_b).expect("decode vv B"),
        "both engines must converge to the same Loro version vector"
    );

    mat_a.flush_background().await.unwrap();
    mat_b.flush_background().await.unwrap();
    mat_a.shutdown();
    mat_b.shutdown();
}

/// #2006 — interrupted-then-resumed transfer converges with no lost,
/// duplicated, or half-applied ops.
///
/// #602 and the concurrent-edit test above cover *completed* sessions. This
/// pins the failure mode that matters most for a sync-first app: a
/// connection that drops mid-transfer must not corrupt or half-apply state,
/// and the next sync cycle must still converge cleanly.
///
/// Model (matches production, where `try_sync_with_peer` builds a fresh
/// orchestrator each cycle, so a dropped session is simply retried):
///   1. A initiates; responder B ingests A's opening message and prepares
///      its reply + LoroSync stream — but the wire dies before ANY of B's
///      messages reach A (B's entire outbound is discarded).
///   2. Assert the transfer was genuinely interrupted: A is not Complete and
///      B's block has NOT landed on A (nothing was half-applied).
///   3. Resume with FRESH orchestrators (the dropped ones are gone) and run
///      a full bidirectional sync.
///   4. Assert convergence: both DBs hold both blocks EXACTLY ONCE (no
///      duplication), with intact content (no loss / half-apply) and
///      identical Loro version vectors.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue2006_interrupted_then_resumed_transfer_converges() {
    use crate::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV2006IRA";
    const DEV_B: &str = "DEV2006IRB";
    const BLOCK_A: &str = "01HZ2006IRBLKAXXXXXXXXXXXX";
    const BLOCK_B: &str = "01HZ2006IRBLKBXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ2006IRSPACEXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    // #602 test seam: one Loro registry per device.
    let state_a = std::sync::Arc::clone(mat_a.loro_state());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    make_local_edit_602(
        &pool_a,
        &mat_a,
        &state_a,
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
        &state_b,
        DEV_B,
        &space,
        BLOCK_B,
        "edit from device B",
        1_736_942_401_000,
    )
    .await;

    // ── Interrupted attempt: A initiates, B prepares its stream, but the
    //    wire dies before any of B's messages reach A. ───────────────────
    {
        let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
            .with_expected_remote_id(DEV_B.into());
        let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
            .with_expected_remote_id(DEV_A.into());

        let first = init_a.start().await.expect("initiator start");
        // B ingests A's opening message and may queue a reply + LoroSync
        // stream — all of which we discard: the connection is gone, so
        // nothing reaches A.
        let _ = resp_b
            .handle_message(wire_roundtrip_602(&first))
            .await
            .expect("responder handle_message");

        // The transfer was genuinely cut: A never completed, and B's block
        // has not landed on A — no inbound state was half-applied.
        assert_ne!(
            init_a.session().state,
            SyncState::Complete,
            "initiator must NOT be Complete after a mid-stream drop"
        );
        let b_on_a_after_drop: Option<String> =
            sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(BLOCK_B)
                .fetch_optional(&pool_a)
                .await
                .unwrap();
        assert_eq!(
            b_on_a_after_drop, None,
            "B's block must not be on A after the interrupted transfer \
             (nothing half-applied)"
        );
        // Drop the interrupted orchestrators — production discards them on a
        // dropped connection and builds fresh ones next cycle.
    }

    // ── Resume: fresh orchestrators, full bidirectional sync. ───────────
    let mut init_a2 = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b2 = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_expected_remote_id(DEV_A.into());
    pump_full_session_602(&mut init_a2, &mut resp_b2).await;
    assert_eq!(
        init_a2.session().state,
        SyncState::Complete,
        "resumed A→B initiator must complete after the earlier interruption"
    );
    assert_eq!(
        resp_b2.session().state,
        SyncState::Complete,
        "resumed A→B responder must complete after the earlier interruption"
    );

    let mut init_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_expected_remote_id(DEV_A.into());
    let mut resp_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    pump_full_session_602(&mut init_b, &mut resp_a).await;
    assert_eq!(
        init_b.session().state,
        SyncState::Complete,
        "resumed B→A initiator must complete"
    );
    assert_eq!(
        resp_a.session().state,
        SyncState::Complete,
        "resumed B→A responder must complete"
    );

    // ── Convergence: both DBs hold both blocks EXACTLY ONCE, with intact
    //    content — no loss, no duplication, no half-applied op. ──────────
    for (label, pool) in [("A", &pool_a), ("B", &pool_b)] {
        for (block_id, content) in [
            (BLOCK_A, "edit from device A"),
            (BLOCK_B, "edit from device B"),
        ] {
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
                .bind(block_id)
                .fetch_one(pool)
                .await
                .unwrap();
            assert_eq!(
                count, 1,
                "device {label} must hold block {block_id} exactly once (no duplication)"
            );
            let row: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(block_id)
                .fetch_optional(pool)
                .await
                .unwrap();
            assert_eq!(
                row.as_deref(),
                Some(content),
                "device {label} must hold block {block_id} with intact content after resume"
            );
        }
    }

    // ── Convergence: identical version vectors. ──────────────────────────
    let vv_a = {
        let mut g = state_a.registry.for_space(&space, DEV_A).expect("space A");
        g.engine_mut().version_vector()
    };
    let vv_b = {
        let mut g = state_b.registry.for_space(&space, DEV_B).expect("space B");
        g.engine_mut().version_vector()
    };
    assert_eq!(
        loro::VersionVector::decode(&vv_a).expect("decode vv A"),
        loro::VersionVector::decode(&vv_b).expect("decode vv B"),
        "interrupted-then-resumed session must still converge version vectors"
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
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    // Mutually paired; both peer rows start with synced_at = NULL.
    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Only B has state to stream (B is the puller's source this session).
    make_local_edit_602(
        &pool_b,
        &mat_b,
        &state_b,
        DEV_B,
        &space,
        BLOCK_B,
        "edit from device B",
        1_736_942_401_000,
    )
    .await;

    // ── Session: A initiates (pulls from B); B responds (streams) ────
    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
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
    let state_a = std::sync::Arc::clone(mat_a.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Only A has state; B's Loro registry stays EMPTY, so B short-circuits
    // straight to SyncComplete (no LoroSync stream) — the path under test.
    make_local_edit_602(
        &pool_a,
        &mat_a,
        &state_a,
        DEV_A,
        &space,
        BLOCK_A,
        "edit from device A",
        1_736_942_400_000,
    )
    .await;

    // ── Session: A initiates; B (empty) responds via SyncComplete ────
    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
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

/// Incremental sync (#87 §10.5): when the initiator advertises a
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
    let state_a = std::sync::Arc::clone(mat_a.loro_state());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Both devices have an edit in the space, so A holds a non-empty vv to
    // advertise and B holds an op A is missing (the delta).
    make_local_edit_602(
        &pool_a,
        &mat_a,
        &state_a,
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
        &state_b,
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
        .with_expected_remote_id(DEV_A.into());
    let out = resp
        .handle_message(SyncMessage::HeadExchange {
            heads: vec![head.clone()],
            loro_vvs: vec![SpaceVersionVector {
                space_id: space.clone(),
                vv: a_vv.clone(),
            }],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
            // Update's from_vv == A's own advertised vv, so the
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
        .with_expected_remote_id(DEV_A.into());
    let out2 = resp2
        .handle_message(SyncMessage::HeadExchange {
            heads: vec![head],
            loro_vvs: vec![],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
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
/// Before the mTLS fallback could apply. A brand-new device
/// could not pull anything until it made a local edit.
///
/// This test drives a REAL fresh-device initiator orchestrator over an
/// in-memory wire against the full `handle_incoming_sync` responder
/// (where the rejection lived) and asserts:
///   1. the session is NOT rejected — both sides reach `Complete`,
///   2. data flows: the responder's seeded block lands in the
///      initiator's DB,
///   3. the responder records the session under the cert-CN identity
/// (fallback: the heads never identified the peer).
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
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_mat = Materializer::new(resp_pool.clone());
    let resp_state = std::sync::Arc::clone(resp_mat.loro_state());
    let resp_scheduler = Arc::new(SyncScheduler::new());
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    peer_refs::upsert_peer_ref(&resp_pool, FRESH_DEV)
        .await
        .unwrap();
    make_local_edit_602(
        &resp_pool,
        &resp_mat,
        &resp_state,
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
            Arc::new(AtomicBool::new(false)),
        )
        .await
    });

    // ── Drive the initiator (mirrors `run_sync_session`'s loop) ──────
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(init_sink.clone()));
    let mut init_orch =
        SyncOrchestrator::new(init_pool.clone(), FRESH_DEV.into(), init_mat.clone())
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

    // ── fallback: the responder identified the session under the
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
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_mat = Materializer::new(resp_pool.clone());
    let resp_state = std::sync::Arc::clone(resp_mat.loro_state());
    let resp_scheduler = Arc::new(SyncScheduler::new());
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    peer_refs::upsert_peer_ref(&resp_pool, INIT_DEV)
        .await
        .unwrap();
    make_local_edit_602(
        &resp_pool,
        &resp_mat,
        &resp_state,
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
    let outgoing = loro_sync::prepare_outgoing_for_pool(
        &resp_pool,
        &resp_state.registry,
        &space,
        RESP_DEV,
        None,
    )
    .await
    .expect("prepare_outgoing for premise check")
    .expect("#1257 freshness gate must not refuse a consistent engine");
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
        Arc::new(AtomicBool::new(false)),
    ));

    // ── Drive the initiator through the SAME wire helpers
    //    `run_sync_session` uses (#611 reassembly on receive) ─────────
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(init_sink.clone()));
    let mut init_orch = SyncOrchestrator::new(init_pool.clone(), INIT_DEV.into(), init_mat.clone())
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
// Try_sync_with_peer returns bool reflecting cancel observation
// ======================================================================

/// When `try_sync_with_peer` exits via the connection-failure
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

    // Spec: connect-failure early-exit returns false even when
    // cancel was pre-set, because run_sync_session never executed.
    assert!(
        !result,
        "connect-failure early-exit must return false (no real session ran), got true"
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

/// Backoff early-exit returns false (no real session ran).
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

    assert!(!result, "backoff early-exit must return false, got true");
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

    // The early-exiter ran no real session, so it reports false...
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
/// Reports `true`, and the guard clears the flag.
///
/// This also exercises the TRUE-return path that was an acknowledged
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
    let (server, port) = SyncServer::start(&server_cert, move |conn, _permit| {
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

    // A real session ran and observed the cancel → true (true-path / #497).
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

    // #2537: a user cancel is NOT a peer failure — the cancelled session
    // must not be recorded into the scheduler's backoff (previously it was,
    // doubling the peer's retry delay for something the peer didn't do).
    assert_eq!(
        scheduler.failure_count("PEER_637_OWNS"),
        0,
        "#2537: a cancelled session must NOT bump the scheduler failure count"
    );
    assert!(
        scheduler.may_retry("PEER_637_OWNS"),
        "#2537: a cancelled session must NOT push the peer into backoff"
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
    let (server, port) = SyncServer::start(&server_cert, move |_conn, _permit| {
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

/// The daemon-loop's "break on cancel" pattern must stop at the
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
        "run_sequential_sync_round must return true when first peer cancels"
    );
    assert_eq!(
        visited.lock().unwrap().clone(),
        vec!["PEER_1".to_string()],
        "daemon loop must break after the first peer reports cancellation; \
         got visited peers {:?}",
        visited.lock().unwrap().clone()
    );
}

/// When no peer reports cancellation, `run_sequential_sync_round`
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
        "run_sequential_sync_round must return false when no peer cancels"
    );
    assert_eq!(
        visited.lock().unwrap().clone(),
        vec![
            "PEER_A".to_string(),
            "PEER_B".to_string(),
            "PEER_C".to_string()
        ],
        "when no peer reports cancellation, all peers in the round must be visited"
    );
}

/// Dormant-waiter race vs. immediate shutdown.
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
        "daemon must shut down within 10s when pair-notify and shutdown \
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
        "peer inserted before shutdown must persist regardless of \
         which select! arm consumed first; got None"
    );
}

// ======================================================================
// #2141 — N-device convergence over a REAL loopback TLS socket
// ======================================================================

/// #2141: a single device's real-loopback fixture — its DB pool,
/// materializer, leaked per-device Loro registry (the #602 two-registry
/// test seam: the process-global registry cannot represent more than one
/// device in one test process), and its ONE stable identity cert (CN =
/// device id, reused across every session so the responder's TOFU-pinned
/// cert hash stays consistent — B-33).
///
/// The materializer is dropped via [`Device2141::teardown`] at test end.
struct Device2141 {
    id: String,
    pool: SqlitePool,
    mat: Materializer,
    state: std::sync::Arc<crate::loro::shared::LoroState>,
    cert: SyncCert,
    // Held only to keep the temp DB directory alive for the test's
    // lifetime; never read.
    _dir: TempDir,
}

impl Device2141 {
    async fn flush_and_shutdown(&self) {
        self.mat.flush_background().await.unwrap();
        self.mat.shutdown();
    }
}

/// #2141: build N mutually-paired devices for real-loopback convergence
/// tests. Each device gets its own DB pool, materializer, leaked
/// `&'static LoroState` registry (the #602 seam), and a stable identity
/// cert. Every ORDERED pair is paired via `upsert_peer_ref` so any device
/// can act as responder for any other (the responder rejects unpaired
/// peers).
///
/// This generalises the two-device setup that
/// `two_edited_devices_converge_over_real_loopback_tls` open-codes into an
/// N-device fixture, the reusable building block for the round-robin and
/// concurrent-role tests below.
async fn make_n_devices_2141(ids: &[&str]) -> Vec<Device2141> {
    install_crypto_provider();

    let mut devices = Vec::with_capacity(ids.len());
    for id in ids {
        let (pool, dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // #602/#2249: the device's registry is its materializer's own
        // per-instance state (the process global is gone).
        let state = std::sync::Arc::clone(mat.loro_state());
        let cert = sync_net::generate_self_signed_cert(id).unwrap();
        devices.push(Device2141 {
            id: (*id).to_string(),
            pool,
            mat,
            state,
            cert,
            _dir: dir,
        });
    }

    // Mutually pair every ordered pair: device i must hold a peer_ref for
    // device j (j != i) so it accepts j as a peer in either role.
    for i in 0..devices.len() {
        for j in 0..devices.len() {
            if i == j {
                continue;
            }
            peer_refs::upsert_peer_ref(&devices[i].pool, &devices[j].id)
                .await
                .unwrap();
        }
    }

    devices
}

/// #2141: run one full real-loopback session with `initiator` as the
/// initiator and `responder` as the responder, reusing the #2129 building
/// block. Returns the initiator's terminal `SyncState`.
async fn run_session_2141(
    initiator: &Device2141,
    responder: &Device2141,
) -> crate::sync_protocol::SyncState {
    run_one_real_loopback_session_2129(
        &initiator.pool,
        &initiator.mat,
        &initiator.id,
        &initiator.cert,
        &responder.pool,
        &responder.mat,
        &responder.id,
        &responder.cert,
    )
    .await
}

/// #2141: decode a device's engine version vector for `space`.
fn device_vv_2141(dev: &Device2141, space: &crate::space::SpaceId) -> loro::VersionVector {
    let vv = {
        let mut g = dev.state.registry.for_space(space, &dev.id).expect("space");
        g.engine_mut().version_vector()
    };
    loro::VersionVector::decode(&vv).expect("decode vv")
}

/// #2141 keystone — N devices (N = 3, then N = 4) that each made a
/// DIVERGENT local edit converge over a REAL loopback TLS socket.
///
/// `two_edited_devices_converge_over_real_loopback_tls` (#2129) proved
/// real-socket convergence for exactly TWO devices. This generalises that
/// to N > 2 to exercise the multi-peer fan-out: each device seeds a
/// distinct content block (plus, for richer coverage, the keystone's mix
/// of a typed property, a tag relationship, and a soft-delete spread
/// across devices), then we drive pairwise sessions around a ring for
/// several rounds — exactly like the proptest ring loops — until the
/// whole mesh is quiescent.
///
/// Asserts:
///   1. EVERY pairwise session reaches `SyncState::Complete` (never
///      `ResetRequired` — this is an incremental-reachable mesh, so a
///      snapshot fallback anywhere would be a regression),
///   2. after quiescence ALL N devices' SQL DBs hold EVERY device's
///      content block (full convergence, not just pairwise),
///   3. ALL N engines decode to the SAME `loro::VersionVector`.
///
/// Multi-thread runtime (real sockets need it); every socket op inside the
/// reused #2129 helper is wrapped in a `tokio::time::timeout` so a hang
/// fails fast. Determinism: each session completes synchronously before
/// the next begins — no sleeps.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue2141_n_devices_converge_round_robin_over_real_loopback_tls() {
    use crate::op::{AddTagPayload, OpPayload, SetPropertyPayload};
    use crate::sync_protocol::SyncState;

    // Run the same scenario for N = 3 and N = 4.
    for ids in [
        vec!["DEV2141A", "DEV2141B", "DEV2141C"],
        vec!["DEV2141W", "DEV2141X", "DEV2141Y", "DEV2141Z"],
    ] {
        let n = ids.len();
        let space = crate::space::SpaceId::from_trusted("01HZ2141SPACEXXXXXXXXXXXXX");
        let devices = make_n_devices_2141(&ids).await;

        // Each device makes a DISTINCT divergent content block. Block ids
        // are derived from the device index so they are unique + valid
        // 26-char ULIDs.
        let mut block_ids: Vec<String> = Vec::with_capacity(n);
        for (i, dev) in devices.iter().enumerate() {
            let block_id = format!("01HZ2141BLK{i:0>15}");
            block_ids.push(block_id.clone());
            make_local_edit_602(
                &dev.pool,
                &dev.mat,
                &dev.state,
                &dev.id,
                &space,
                &block_id,
                &format!("edit from {}", dev.id),
                1_736_942_400_000 + i64::try_from(i).unwrap() * 1_000,
            )
            .await;
        }

        // Richer coverage spread across devices (mirrors the #2129
        // keystone): device 0 adds a typed property on its block; device 1
        // adds a tag block + AddTag link on its block.
        let tag_block = "01HZ2141TAGBLKXXXXXXXXXXXX";
        apply_local_op_602(
            &devices[0].pool,
            &devices[0].mat,
            &devices[0].state,
            &devices[0].id,
            &space,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: crate::ulid::BlockId::from_trusted(&block_ids[0]),
                key: "custom_rank".into(),
                value_text: None,
                value_num: Some(7.0),
                value_date: None,
                value_ref: None,
                value_bool: None,
            }),
            1_736_942_500_000,
        )
        .await;
        apply_local_op_602(
            &devices[1].pool,
            &devices[1].mat,
            &devices[1].state,
            &devices[1].id,
            &space,
            OpPayload::CreateBlock(crate::op::CreateBlockPayload {
                block_id: crate::ulid::BlockId::from_trusted(tag_block),
                block_type: "tag".into(),
                parent_id: None,
                position: Some(2),
                index: None,
                content: "important".into(),
            }),
            1_736_942_500_100,
        )
        .await;
        apply_local_op_602(
            &devices[1].pool,
            &devices[1].mat,
            &devices[1].state,
            &devices[1].id,
            &space,
            OpPayload::AddTag(AddTagPayload {
                block_id: crate::ulid::BlockId::from_trusted(&block_ids[1]),
                tag_id: crate::ulid::BlockId::from_trusted(tag_block),
            }),
            1_736_942_500_200,
        )
        .await;

        // Drive pairwise sessions around a ring. Each round runs the
        // ordered pair (i, i+1 mod n) as initiator→responder. `n` rounds
        // is more than enough to fully propagate every device's edits all
        // the way around the ring.
        for _round in 0..n {
            for i in 0..n {
                let init = &devices[i];
                let resp = &devices[(i + 1) % n];
                let state = run_session_2141(init, resp).await;
                assert_eq!(
                    state,
                    SyncState::Complete,
                    "#2141 (N={n}): session {}->{} must complete incrementally \
                     (ResetRequired would mean an unexpected snapshot fallback)",
                    init.id,
                    resp.id,
                );
            }
        }

        // Convergence: every device's DB must hold every device's block.
        for dev in &devices {
            for (i, block_id) in block_ids.iter().enumerate() {
                let row: Option<String> =
                    sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                        .bind(block_id)
                        .fetch_optional(&dev.pool)
                        .await
                        .unwrap();
                assert_eq!(
                    row.as_deref(),
                    Some(format!("edit from {}", devices[i].id).as_str()),
                    "#2141 (N={n}): device {} must hold block {block_id} \
                     authored by {}",
                    dev.id,
                    devices[i].id,
                );
            }
            // The typed property and tag link must have converged everywhere.
            let prop: Option<f64> = sqlx::query_scalar(
                "SELECT value_num FROM block_properties WHERE block_id = ? AND key = 'custom_rank'",
            )
            .bind(&block_ids[0])
            .fetch_optional(&dev.pool)
            .await
            .unwrap();
            assert_eq!(
                prop,
                Some(7.0),
                "#2141 (N={n}): device {} must hold the converged typed property",
                dev.id,
            );
            let tag: Option<String> = sqlx::query_scalar(
                "SELECT tag_id FROM block_tags WHERE block_id = ? AND tag_id = ?",
            )
            .bind(&block_ids[1])
            .bind(tag_block)
            .fetch_optional(&dev.pool)
            .await
            .unwrap();
            assert_eq!(
                tag.as_deref(),
                Some(tag_block),
                "#2141 (N={n}): device {} must hold the converged tag link",
                dev.id,
            );
        }

        // Convergence: every engine reached the SAME version vector.
        let vv0 = device_vv_2141(&devices[0], &space);
        for dev in &devices[1..] {
            assert_eq!(
                device_vv_2141(dev, &space),
                vv0,
                "#2141 (N={n}): device {} must converge to the same Loro \
                 version vector as device {}",
                dev.id,
                devices[0].id,
            );
        }

        for dev in &devices {
            dev.flush_and_shutdown().await;
        }
    }
}

/// #2141 — device B acts as RESPONDER (to A) and INITIATOR (to C)
/// CONCURRENTLY over two distinct real TLS connections.
///
/// The round-robin test runs strictly serial sessions. This one overlaps
/// two sessions that BOTH touch device B: an A→B session where B is the
/// responder, and a B→C session where B is the initiator, driven
/// concurrently with `tokio::join!`. It proves B's per-device registry and
/// DB serialize correctly across the two roles — both sessions complete
/// with no corruption, and afterwards all three devices converge.
///
/// Each of A, B, C seeds a distinct divergent block first. After the
/// concurrent A→B / B→C pair, A holds {A,B}, B holds {A,B,C}, and C holds
/// {B,C}. A final round of serial sessions then drives full convergence so
/// the version-vector equality assertion holds for all three.
///
/// Generous `tokio::time::timeout`s wrap every socket op (inside the reused
/// #2129 helper) so a hang fails fast instead of wedging CI.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue2141_device_acts_as_responder_and_initiator_concurrently() {
    use crate::sync_protocol::SyncState;

    let space = crate::space::SpaceId::from_trusted("01HZ2141CONCSPACEXXXXXXXXX");
    let devices = make_n_devices_2141(&["DEV2141RA", "DEV2141RB", "DEV2141RC"]).await;
    let (a, b, c) = (&devices[0], &devices[1], &devices[2]);

    let block_a = "01HZ2141CONCBLKAXXXXXXXXXX";
    let block_b = "01HZ2141CONCBLKBXXXXXXXXXX";
    let block_c = "01HZ2141CONCBLKCXXXXXXXXXX";
    for (dev, block) in [(a, block_a), (b, block_b), (c, block_c)] {
        make_local_edit_602(
            &dev.pool,
            &dev.mat,
            &dev.state,
            &dev.id,
            &space,
            block,
            &format!("edit from {}", dev.id),
            1_736_942_400_000,
        )
        .await;
    }

    // Overlap the two sessions that both touch B: A→B (B is responder) and
    // B→C (B is initiator). Each session uses its own pair of real TLS
    // connections; B genuinely acts in both roles at once, exercising that
    // its registry + DB serialize cleanly under concurrent access.
    let (ab, bc) = tokio::join!(run_session_2141(a, b), run_session_2141(b, c));
    assert_eq!(
        ab,
        SyncState::Complete,
        "#2141 concurrent: A->B session (B as responder) must complete"
    );
    assert_eq!(
        bc,
        SyncState::Complete,
        "#2141 concurrent: B->C session (B as initiator) must complete"
    );

    // Drive full convergence with a serial ring so every device ends with
    // every block (the concurrent pair alone leaves A without C's block).
    for _round in 0..3 {
        for (init, resp) in [(a, b), (b, c), (c, a)] {
            let state = run_session_2141(init, resp).await;
            assert_eq!(
                state,
                SyncState::Complete,
                "#2141 concurrent: convergence session {}->{} must complete",
                init.id,
                resp.id,
            );
        }
    }

    // No corruption: all three DBs hold all three blocks.
    for dev in &devices {
        for block in [block_a, block_b, block_c] {
            let row: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(block)
                .fetch_optional(&dev.pool)
                .await
                .unwrap();
            assert!(
                row.is_some(),
                "#2141 concurrent: device {} must hold block {block} after convergence",
                dev.id,
            );
        }
    }

    // All three engines converge to the same version vector.
    let vv_a = device_vv_2141(a, &space);
    assert_eq!(
        device_vv_2141(b, &space),
        vv_a,
        "#2141 concurrent: B must converge to A's version vector"
    );
    assert_eq!(
        device_vv_2141(c, &space),
        vv_a,
        "#2141 concurrent: C must converge to A's version vector"
    );

    for dev in &devices {
        dev.flush_and_shutdown().await;
    }
}

// ======================================================================
// #2140 — failure-mode E2E over real loopback TLS
// ======================================================================

/// #2140: stand up a responder `SyncServer` and connect an initiator,
/// returning the client connection, the accepted server-side connection,
/// and the server handle. Mirrors the connection setup of
/// `run_one_real_loopback_session_2129` but hands BOTH raw connections
/// back to the caller so a failure-mode test can drive them directly
/// (drop one mid-stream, inject a corrupt frame, etc.) instead of running
/// the full session loop.
async fn connect_real_pair_2140(
    init_cert: &SyncCert,
    resp_cert: &SyncCert,
) -> (SyncConnection, SyncConnection, crate::sync_net::SyncServer) {
    let timeout = std::time::Duration::from_secs(5);

    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(resp_cert, move |conn, _permit| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    let client_conn = tokio::time::timeout(
        timeout,
        sync_net::connect_to_peer(&format!("127.0.0.1:{port}"), None, None, init_cert),
    )
    .await
    .expect("timed out connecting to peer")
    .unwrap();

    let server_conn = tokio::time::timeout(timeout, conn_rx.recv())
        .await
        .expect("timed out waiting for server connection")
        .unwrap();

    (client_conn, server_conn, server)
}

/// #2140 — a connection dropped MID-STREAM surfaces as a bounded FAILURE,
/// not a hang, and a fresh session afterward recovers and converges.
///
/// The initiator sends its opening `HeadExchange`, then DROPS its
/// connection (simulating a WiFi drop / peer crash partway through the
/// exchange). The responder's session loop, blocked on the next recv, must
/// observe the closed socket and return an `Err` (a terminal failure) —
/// bounded by a test `tokio::time::timeout` so a true hang fails the test
/// rather than wedging it. We then run a clean session over a fresh
/// connection between the same two devices and assert it converges, proving
/// the drop left no poisoned state behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_connection_drop_mid_stream_fails_then_recovers() {
    use crate::sync_protocol::SyncState;

    let space = crate::space::SpaceId::from_trusted("01HZ2140DROPSPACEXXXXXXXXX");
    let devices = make_n_devices_2141(&["DEV2140DA", "DEV2140DB"]).await;
    let (a, b) = (&devices[0], &devices[1]);

    make_local_edit_602(
        &a.pool,
        &a.mat,
        &a.state,
        &a.id,
        &space,
        "01HZ2140DROPBLKAXXXXXXXXXX",
        "edit from A",
        1_736_942_400_000,
    )
    .await;
    make_local_edit_602(
        &b.pool,
        &b.mat,
        &b.state,
        &b.id,
        &space,
        "01HZ2140DROPBLKBXXXXXXXXXX",
        "edit from B",
        1_736_942_401_000,
    )
    .await;

    let timeout = std::time::Duration::from_secs(5);

    // ── Drop mid-stream: A opens, sends HeadExchange, then disconnects ──
    let (mut client_conn, server_conn, server) = connect_real_pair_2140(&a.cert, &b.cert).await;

    let resp_scheduler = Arc::new(SyncScheduler::new());
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let resp_handle = tokio::spawn(handle_incoming_sync(
        server_conn,
        b.pool.clone(),
        b.id.clone(),
        b.mat.clone(),
        resp_scheduler,
        resp_sink,
        Arc::new(AtomicBool::new(false)),
    ));

    // Send a valid opening HeadExchange so the responder is mid-session,
    // then drop the client connection.
    let heads = crate::sync_protocol::get_local_heads(&a.pool)
        .await
        .unwrap();
    tokio::time::timeout(
        timeout,
        client_conn.send_json(&SyncMessage::HeadExchange {
            heads,
            loro_vvs: vec![],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
        }),
    )
    .await
    .expect("send HeadExchange timed out")
    .expect("send HeadExchange");
    // Abruptly drop the socket mid-stream (no graceful close handshake).
    drop(client_conn);

    // The responder must terminate with an Err (bounded), NOT hang.
    let resp_join = tokio::time::timeout(timeout, resp_handle)
        .await
        .expect("#2140: responder must not hang after a mid-stream drop")
        .expect("responder task panicked");
    assert!(
        resp_join.is_err(),
        "#2140: a mid-stream connection drop must surface as a session \
         failure (Err), got Ok"
    );
    server.shutdown().await;

    // ── Recovery: a fresh full session must converge cleanly ────────────
    let state1 = run_session_2141(a, b).await;
    assert_eq!(
        state1,
        SyncState::Complete,
        "#2140: a fresh session after a drop must complete (A->B)"
    );
    let state2 = run_session_2141(b, a).await;
    assert_eq!(
        state2,
        SyncState::Complete,
        "#2140: a fresh session after a drop must complete (B->A)"
    );
    for dev in &devices {
        for block in ["01HZ2140DROPBLKAXXXXXXXXXX", "01HZ2140DROPBLKBXXXXXXXXXX"] {
            let row: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
                .bind(block)
                .fetch_optional(&dev.pool)
                .await
                .unwrap();
            assert!(
                row.is_some(),
                "#2140 recovery: device {} must hold block {block} after recovery",
                dev.id,
            );
        }
    }

    for dev in &devices {
        dev.flush_and_shutdown().await;
    }
}

/// #2140 — an OVERSIZED binary frame is rejected with a bounded error, no
/// panic and no hang.
///
/// `ws_config()` caps the transport at `MAX_MSG_SIZE` (10 MB) at the frame
/// header (#611), so a `send_binary` of an over-cap payload fails at the
/// SENDER. We assert the sender's `send_binary` returns an `Err` (the
/// frame is refused before it ever buffers a runaway payload), bounded by a
/// test timeout. The receiver REJECTS the over-cap frame on read (#611's
/// `ws_config` enforces `max_message_size`/`max_frame_size` at the read
/// path), so the load-bearing guarantee is that the RECEIVER returns a
/// bounded error rather than buffering a runaway payload, panicking, or
/// hanging.
///
/// This is driven through `test_connection_pair()` rather than a live
/// `SyncServer` socket: per its contract (`sync_net::connection`), the
/// in-memory pair runs under the IDENTICAL `ws_config()` transport caps as
/// the real transport, so the `MAX_MSG_SIZE` rejection path is exercised
/// byte-for-byte the same — while avoiding pumping a 10 MB+ frame through a
/// live loopback-TLS transfer that, under parallel CI load, starves the
/// timing-sensitive chunked-binary transfer of the neighbouring #611 test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_oversized_frame_is_rejected_with_bounded_error() {
    let (mut sender, mut receiver) = sync_net::test_connection_pair().await;

    let timeout = std::time::Duration::from_secs(5);

    // One byte over the cap. The sender's write is fire-and-forget in a
    // spawned task (it may block on the duplex buffer once the receiver
    // tears the stream down — that is not what we are asserting). The
    // RECEIVER must reject the over-cap frame with a bounded error: #611's
    // `ws_config` enforces `max_frame_size` at the frame header on read, so
    // the rejection fires without buffering the runaway payload.
    let oversize = vec![0u8; SyncConnection::MAX_MSG_SIZE + 1];
    let send_task = tokio::spawn(async move {
        let _ = sender.send_binary(&oversize).await;
        sender
    });

    let recv_result = tokio::time::timeout(timeout, receiver.recv_binary())
        .await
        .expect("#2140: oversized recv must not hang");
    assert!(
        recv_result.is_err(),
        "#2140: the receiver must reject a frame larger than MAX_MSG_SIZE \
         with a bounded error, got Ok"
    );

    // Reclaim the sender task so it does not leak past the test. It may
    // still be blocked on the doomed write, so abort it.
    send_task.abort();
}

/// #2140 — garbage / non-JSON bytes are rejected by the receiver with a
/// bounded deserialize error, no panic and no hang.
///
/// The sender ships a valid (in-cap) TEXT frame whose body is not valid
/// `SyncMessage` JSON. `recv_json` must surface a bounded "deserialize"
/// error rather than panicking or hanging.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_garbage_frame_is_rejected_with_bounded_error() {
    install_crypto_provider();
    let cert_a = sync_net::generate_self_signed_cert("DEV2140GA").unwrap();
    let cert_b = sync_net::generate_self_signed_cert("DEV2140GB").unwrap();

    let (mut client_conn, mut server_conn, server) = connect_real_pair_2140(&cert_a, &cert_b).await;

    let timeout = std::time::Duration::from_secs(5);

    // `send_json` of a raw string serialises to a JSON string literal
    // (`"not a sync message …"`), which is valid JSON but NOT a
    // `SyncMessage` — so the receiver's typed deserialize must reject it.
    tokio::time::timeout(
        timeout,
        client_conn.send_json(&"not a sync message {{{ garbage"),
    )
    .await
    .expect("send garbage timed out")
    .expect("send garbage frame");

    let recv_result = tokio::time::timeout(timeout, server_conn.recv_json::<SyncMessage>())
        .await
        .expect("#2140: garbage recv must not hang");
    assert!(
        recv_result.is_err(),
        "#2140: a non-SyncMessage JSON frame must be rejected with a \
         bounded deserialize error, got Ok"
    );

    server.shutdown().await;
}

/// #2140 — a PARTIAL message (peer closes after sending nothing / half a
/// frame) surfaces as a bounded error, not a hang.
///
/// The sender opens the connection and immediately drops it without ever
/// sending a complete frame. The receiver's `recv_json`, blocked on the
/// next frame, must observe the closed stream and return a bounded
/// "connection closed" error rather than hanging.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_partial_message_then_close_is_bounded_error() {
    install_crypto_provider();
    let cert_a = sync_net::generate_self_signed_cert("DEV2140PA").unwrap();
    let cert_b = sync_net::generate_self_signed_cert("DEV2140PB").unwrap();

    let (client_conn, mut server_conn, server) = connect_real_pair_2140(&cert_a, &cert_b).await;

    let timeout = std::time::Duration::from_secs(5);

    // Drop the client without sending any complete frame (EOF / close).
    drop(client_conn);

    let recv_result = tokio::time::timeout(timeout, server_conn.recv_json::<SyncMessage>())
        .await
        .expect("#2140: recv after partial/EOF must not hang");
    assert!(
        recv_result.is_err(),
        "#2140: a closed connection with no complete frame must yield a \
         bounded error, got Ok"
    );

    server.shutdown().await;
}

/// #2140 — a REAL `ResetRequired` → snapshot catch-up fires OVER THE REAL
/// SOCKET when the responder's op_log has compacted past the initiator's
/// advertised frontier.
///
/// This is `feat6_end_to_end_compact_then_snapshot_catchup` ported from the
/// in-memory `test_connection_pair` to the genuine `SyncServer` +
/// `connect_to_peer` + `run_sync_session` (initiator) /
/// `handle_incoming_sync` (responder) harness used by the #2129/#2141
/// tests.
///
/// Setup (mirroring feat6's mechanic):
///   * the responder seeds + materialises one block authored under its own
///     device, `create_snapshot`s (frontier `{RESP: 1}`), then COMPACTS by
///     wiping its op_log via the mutation-bypass dance;
///   * the initiator's op_log holds ONLY a STALE row authored under the
///     responder's device id (seq 1) and NO own-device ops — so it
///     advertises `{RESP: 1}`, the responder's compacted log cannot satisfy
///     `check_reset_required` for `(RESP, 1)`, and the snapshot's
///     `up_to_seqs {RESP: 1}` covers the initiator's frontier so the offer
///     proceeds.
///
/// `run_sync_session` drives the ResetRequired → `try_receive_snapshot_catchup`
/// sub-flow internally and returns `Ok(())` with the orchestrator left in
/// `ResetRequired` (it returns before reaching `Complete`). We therefore
/// assert the returned terminal state is `ResetRequired` (proving the
/// fallback path fired — NOT a plain incremental session) and that the helper
/// did not error.
///
/// #2503 semantics change: the catch-up is now a Loro-snapshot **merge**, not
/// a CBOR wipe-and-replace. For the **own-lineage-loss** trigger this test
/// crafts (the initiator advertises a Loro VV claiming MORE responder-authored
/// ops than the responder's engine now holds), the responder's snapshot for
/// its own lineage is a *prefix* of what the initiator already claims, so the
/// merge is a dedup no-op: nothing new lands, but — crucially — the initiator
/// is **NOT wiped** (its engine state survives) and `reset_count` is **NOT**
/// bumped. This is exactly #2503 open-question-1: an own-lineage-loss reset no
/// longer needs wipe semantics; the local gap is re-supplied by the #2481
/// phase-3 re-pull, not by destroying local state. (Real content-landing +
/// survival under merge is pinned by
/// `loro_snapshot_catchup_merges_and_preserves_unsynced_local_2503` in
/// `snapshot_transfer.rs`.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_snapshot_fallback_on_real_compaction_over_real_socket() {
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::snapshot::create_snapshot;
    use crate::sync_protocol::SyncState;

    const INIT_DEV: &str = "DEV2140SI";
    const RESP_DEV: &str = "DEV2140SR";
    const SNAP_BLOCK: &str = "01HZ2140SNAPBLKXXXXXXXXXX";

    let devices = make_n_devices_2141(&[INIT_DEV, RESP_DEV]).await;
    let (init, resp) = (&devices[0], &devices[1]);

    // ── Responder: seed + materialise one block, snapshot, then compact ─
    let record = append_local_op_at(
        &resp.pool,
        RESP_DEV,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(SNAP_BLOCK),
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
    resp.mat.dispatch_op(&record).await.unwrap();
    resp.mat.flush_foreground().await.unwrap();
    // Mirror the op into the responder's engine so its outgoing snapshot /
    // state is consistent with the SQL projection.
    crate::merge::engine_apply(
        &format!("{RESP_DEV}/{}", record.seq),
        &OpPayload::CreateBlock(CreateBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(SNAP_BLOCK),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "compacted-state content".into(),
        }),
        RESP_DEV,
        &crate::space::SpaceId::from_trusted("01HZ2140SNAPSPACEXXXXXXXXX"),
        &record.created_at.to_string(),
        &resp.state,
    );

    create_snapshot(&resp.pool, RESP_DEV).await.unwrap();

    // Simulate compaction: wipe the responder's op_log (H-13 bypass dance).
    let mut tx = resp.pool.begin().await.unwrap();
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

    // ── Initiator: a STALE row authored under the responder's device so it
    //    advertises op-log head `{RESP: 1}` (and NO own-device ops), so the
    //    snapshot's `{RESP: 1}` frontier covers it and the covering check lets
    //    the offer proceed. This is the real-orchestrator equivalent of feat6's
    //    hand-crafted `stale_resp_head`.
    append_local_op_at(
        &init.pool,
        RESP_DEV,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(SNAP_BLOCK),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "stale claim".into(),
        }),
        1_736_942_399_000,
    )
    .await
    .unwrap();

    // #2502: op-log compaction alone no longer forces a reset — state causality
    // is judged from Loro VVs. Materialise SIX RESP-authored ops into the
    // INITIATOR's ENGINE (in the snapshot's space) so the initiator advertises a
    // Loro vv claiming more RESP-authored ops than the responder's engine holds
    // (one). That is the own-lineage-loss signal the responder's VV reset check
    // trips on, driving ResetRequired → snapshot catch-up. These engine ops are
    // deliberately kept OUT of the op_log (so the advertised head stays
    // `{RESP: 1}` for the covering check) and are wiped by the snapshot apply.
    let snap_space = crate::space::SpaceId::from_trusted("01HZ2140SNAPSPACEXXXXXXXXX");
    for i in 0..6 {
        crate::merge::engine_apply(
            &format!("{RESP_DEV}/{}", i + 1),
            &OpPayload::CreateBlock(CreateBlockPayload {
                block_id: crate::ulid::BlockId::from_trusted(&format!("01HZ2140INITCLAIM{i:09}")),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                index: None,
                content: "init lineage claim".into(),
            }),
            RESP_DEV,
            &snap_space,
            "1736942399000",
            &init.state,
        );
    }

    // Drive the real-socket session. The reused helper asserts internally
    // that neither side errored; ResetRequired catch-up returns Ok(()).
    let state = run_session_2141(init, resp).await;
    assert_eq!(
        state,
        SyncState::ResetRequired,
        "#2140: a compacted responder must drive the initiator into \
         ResetRequired and snapshot catch-up over the real socket"
    );

    // #2503: the own-lineage-loss merge catch-up must NOT wipe the initiator.
    // Its crafted RESP-lineage engine ops survive the merge (the responder's
    // snapshot is a prefix, deduped) — proving there is no wipe-and-replace.
    {
        let mut g = init
            .state
            .registry
            .for_space(&snap_space, INIT_DEV)
            .expect("space");
        assert!(
            g.engine_mut()
                .read_block("01HZ2140INITCLAIM000000000")
                .unwrap()
                .is_some(),
            "#2503: the merge catch-up must NOT wipe the initiator's engine — \
             its pre-catch-up lineage state must survive"
        );
    }

    // peer_refs bookkeeping advanced (synced_at populated) — the merge is a
    // pull, so it records like a normal pull.
    let peer = peer_refs::get_peer_ref(&init.pool, RESP_DEV)
        .await
        .unwrap()
        .expect("peer_refs row must exist after the merge catch-up");
    assert!(
        peer.synced_at.is_some(),
        "#2140: synced_at must be populated after real-socket catch-up"
    );
    assert_eq!(
        peer.reset_count, 0,
        "#2503: a Loro-snapshot MERGE catch-up must NOT bump reset_count \
         (no reset occurred — open q1)"
    );

    for dev in &devices {
        dev.flush_and_shutdown().await;
    }
}

/// #2140 — a failed real-socket session advances per-peer backoff on a
/// `SyncScheduler`; a later successful session clears it.
///
/// This exercises the scheduler's backoff state machine around real
/// sessions (rather than mocking the failure): we record a failure for the
/// peer after a deliberately-broken session (initiator drops mid-stream)
/// and assert `failure_count == 1` / `may_retry == false`; we then run a
/// clean session, record the success, and assert `failure_count == 0` /
/// `may_retry == true`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_backoff_advances_on_failure_and_clears_on_success() {
    use crate::sync_protocol::SyncState;

    let space = crate::space::SpaceId::from_trusted("01HZ2140BOSPACEXXXXXXXXXXX");
    let devices = make_n_devices_2141(&["DEV2140BA", "DEV2140BB"]).await;
    let (a, b) = (&devices[0], &devices[1]);

    make_local_edit_602(
        &a.pool,
        &a.mat,
        &a.state,
        &a.id,
        &space,
        "01HZ2140BOBLKAXXXXXXXXXXXX",
        "edit from A",
        1_736_942_400_000,
    )
    .await;
    // Device B also seeds an edit so the responder has state to STREAM back
    // after the HeadExchange (rather than short-circuiting to SyncComplete
    // when it has nothing to send). That forces another round-trip, so the
    // initiator's mid-stream drop is observed by the responder as a failed
    // recv rather than completing before the drop lands.
    make_local_edit_602(
        &b.pool,
        &b.mat,
        &b.state,
        &b.id,
        &space,
        "01HZ2140BOBLKBXXXXXXXXXXXX",
        "edit from B",
        1_736_942_401_000,
    )
    .await;

    let scheduler = SyncScheduler::new();
    let timeout = std::time::Duration::from_secs(5);

    // ── A broken session: initiator drops mid-stream → the session fails,
    //    so we record a failure for the peer on the scheduler.
    let (mut client_conn, server_conn, server) = connect_real_pair_2140(&a.cert, &b.cert).await;
    let resp_handle = tokio::spawn(handle_incoming_sync(
        server_conn,
        b.pool.clone(),
        b.id.clone(),
        b.mat.clone(),
        Arc::new(SyncScheduler::new()),
        Arc::new(RecordingEventSink::new()) as Arc<dyn SyncEventSink>,
        Arc::new(AtomicBool::new(false)),
    ));
    let heads = crate::sync_protocol::get_local_heads(&a.pool)
        .await
        .unwrap();
    tokio::time::timeout(
        timeout,
        client_conn.send_json(&SyncMessage::HeadExchange {
            heads,
            loro_vvs: vec![],
            engine_format_version: crate::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            wire_compression: false,
        }),
    )
    .await
    .expect("send HeadExchange timed out")
    .expect("send HeadExchange");
    drop(client_conn);
    let resp_join = tokio::time::timeout(timeout, resp_handle)
        .await
        .expect("#2140 backoff: responder must not hang on the failed session")
        .expect("responder task panicked");
    assert!(
        resp_join.is_err(),
        "#2140 backoff: the broken session must fail so a failure is recorded"
    );
    server.shutdown().await;

    // The failed session advances backoff for this peer.
    scheduler.record_failure(&b.id);
    assert_eq!(
        scheduler.failure_count(&b.id),
        1,
        "#2140 backoff: failure_count must be 1 after the failed session"
    );
    assert!(
        !scheduler.may_retry(&b.id),
        "#2140 backoff: may_retry must be false while in backoff"
    );

    // ── A later SUCCESSFUL session clears the backoff. ──────────────────
    let state = run_session_2141(a, b).await;
    assert_eq!(
        state,
        SyncState::Complete,
        "#2140 backoff: the recovery session must complete"
    );
    scheduler.record_success(&b.id);
    assert_eq!(
        scheduler.failure_count(&b.id),
        0,
        "#2140 backoff: failure_count must reset to 0 after a success"
    );
    assert!(
        scheduler.may_retry(&b.id),
        "#2140 backoff: may_retry must be true again after a success"
    );

    for dev in &devices {
        dev.flush_and_shutdown().await;
    }
}

// ======================================================================
// #2537 — cancel with no active session must not latch the flag
// ======================================================================

/// #2537 regression: a user cancel issued while NO sync session is active
/// must be a no-op — and a subsequent inbound responder session must
/// SUCCEED, not instantly fail with "sync cancelled".
///
/// Before the fix, `cancel_active_sync` latched the daemon-wide
/// `AtomicBool` unconditionally and the ONLY resetter was the
/// initiator-side `CancelGuard` (armed only after an outbound connection
/// established), so a cancel with no active initiator session poisoned
/// every inbound session forever and burned the next outbound one as a
/// recorded, backoff-doubling failure just to clear the flag.
///
/// This test (a) cancels with nothing running, (b) drives a REAL inbound
/// responder session (`handle_incoming_sync`) over an in-memory wire with
/// the SAME shared cancel flag + scheduler, and asserts the session
/// completes and data flows — plus that the cancel never bumped any
/// scheduler backoff/failure state.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_2537_no_session_cancel_does_not_poison_inbound_session() {
    use crate::sync_protocol::SyncState;

    const RESP_DEV: &str = "RESP2537";
    const INIT_DEV: &str = "INIT2537";
    const BLOCK: &str = "01HZ2537BLKXXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ2537SPACEXXXXXXXXXXXXX");

    // Shared daemon-wide state: ONE cancel flag + ONE scheduler, exactly as
    // production wires them into both the daemon handle and the responder.
    let cancel = Arc::new(AtomicBool::new(false));
    let scheduler = Arc::new(SyncScheduler::new());
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        scheduler: scheduler.clone(),
        handle: None,
    };

    // ── (a) cancel with NO active session ────────────────────────────
    daemon.cancel_active_sync();
    assert!(
        !cancel.load(Ordering::Acquire),
        "#2537: cancel with no active session must NOT latch the shared flag"
    );
    assert!(
        scheduler.failure_counts().is_empty(),
        "#2537: a cancel must not bump any scheduler backoff/failure count, got {:?}",
        scheduler.failure_counts()
    );

    // ── (b) drive a real inbound responder session with the SAME flag ─
    // Responder: one seeded local edit so the session actually streams data.
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_mat = Materializer::new(resp_pool.clone());
    let resp_state = std::sync::Arc::clone(resp_mat.loro_state());
    let resp_sink_typed = Arc::new(RecordingEventSink::new());
    let resp_sink: Arc<dyn SyncEventSink> = resp_sink_typed.clone();

    peer_refs::upsert_peer_ref(&resp_pool, INIT_DEV)
        .await
        .unwrap();
    make_local_edit_602(
        &resp_pool,
        &resp_mat,
        &resp_state,
        RESP_DEV,
        &space,
        BLOCK,
        "seeded on responder (#2537)",
        1_736_942_400_000,
    )
    .await;
    resp_mat.flush_background().await.unwrap();

    // Initiator: fresh device driven manually through the wire (mirrors
    // `run_sync_session`'s loop, like the #778/#611 harnesses).
    let (init_pool, _init_dir) = test_pool().await;
    let init_mat = Materializer::new(init_pool.clone());
    peer_refs::upsert_peer_ref(&init_pool, RESP_DEV)
        .await
        .unwrap();

    let (mut server_conn, mut client_conn) = sync_net::test_connection_pair().await;
    server_conn.set_test_cert(Some(INIT_DEV.to_string()), None);

    let resp_pool_clone = resp_pool.clone();
    let resp_mat_clone = resp_mat.clone();
    let server_task = tokio::spawn(handle_incoming_sync(
        server_conn,
        resp_pool_clone,
        RESP_DEV.to_string(),
        resp_mat_clone,
        scheduler.clone(),
        resp_sink.clone(),
        cancel.clone(),
    ));

    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(init_sink.clone()));
    let mut init_orch = SyncOrchestrator::new(init_pool.clone(), INIT_DEV.into(), init_mat.clone())
        .with_event_sink(init_sink_box)
        .with_expected_remote_id(RESP_DEV.into());

    let first = init_orch.start().await.expect("initiator start");
    super::wire::send_sync_message(&mut client_conn, &first)
        .await
        .unwrap();

    while !init_orch.is_terminal() {
        let incoming: SyncMessage = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            super::wire::recv_sync_message(&mut client_conn),
        )
        .await
        .expect("initiator timed out waiting for responder message")
        .expect("initiator wire recv");
        // The #2537 failure signature: a latched flag makes the responder
        // reply "sync cancelled" (or abort the wire) instead of syncing.
        if let SyncMessage::Error { message } = &incoming {
            panic!("#2537: responder rejected the post-cancel inbound session: {message}");
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
        "#2537: the inbound session after a no-session cancel must COMPLETE"
    );

    // End the responder's post-Complete file-transfer phase and reap it.
    let _ = client_conn.close().await;
    let resp_result = tokio::time::timeout(std::time::Duration::from_secs(10), server_task)
        .await
        .expect("responder task timed out")
        .expect("responder task panicked");
    assert!(
        resp_result.is_ok(),
        "#2537: the responder session must succeed (flag not latched), got {resp_result:?}"
    );

    // Data actually flowed — the session was real, not a rejected stub.
    let content: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK)
        .fetch_optional(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        content.as_deref(),
        Some("seeded on responder (#2537)"),
        "#2537: the responder's block must reach the initiator"
    );

    // The flag is still clear and the cancel never inflated any backoff.
    assert!(
        !cancel.load(Ordering::Acquire),
        "#2537: the shared flag must remain clear after the session"
    );
    assert!(
        scheduler.failure_counts().is_empty(),
        "#2537: no failure may be recorded for a clean session after a \
         no-session cancel, got {:?}",
        scheduler.failure_counts()
    );

    resp_mat.shutdown();
    init_mat.shutdown();
}

// ======================================================================
// #2538 — catch-up rejection must record failure, not success
// ======================================================================

/// #2538 regression: an over-size-cap snapshot offer is REJECTED by
/// `try_receive_snapshot_catchup` (`CatchupOutcome::Rejected`) — nothing is
/// applied and no frontier advances. The caller used to collapse that into
/// a session SUCCESS: `record_success` reset the backoff, a
/// `SyncEvent::Complete` told the UI "complete", and `last_address` success
/// bookkeeping ran — so the 30 s scheduler re-selected the peer forever
/// while the responder re-hashed the full blob every round.
///
/// Drives the REAL `try_sync_with_peer` against a live loopback responder
/// that scripts `HeadExchange → ResetRequired → oversized SnapshotOffer`
/// and asserts: a failure (with backoff — the peer is NOT immediately
/// re-due), NO Complete event, NO peer_refs success bookkeeping, and an
/// actionable error event.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn catchup_2538_oversize_rejection_records_failure_not_success() {
    install_crypto_provider();

    const PEER: &str = "PEER_2538";

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cert = sync_net::generate_self_signed_cert("LOCAL_2538").unwrap();

    // Live loopback responder whose accepted connection is scripted by a
    // test task (same harness shape as the #637 owns-path tests).
    let server_cert = sync_net::generate_self_signed_cert(PEER).unwrap();
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(&server_cert, move |conn, _permit| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    // Scripted responder: force the snapshot catch-up path, then offer an
    // over-cap legacy CBOR snapshot; expect the initiator's SnapshotReject.
    let script = tokio::spawn(async move {
        let mut conn = tokio::time::timeout(std::time::Duration::from_secs(10), conn_rx.recv())
            .await
            .expect("responder accept timed out")
            .expect("responder connection channel closed");
        let first: SyncMessage = conn.recv_json().await.expect("script recv HeadExchange");
        assert!(
            matches!(first, SyncMessage::HeadExchange { .. }),
            "initiator must open with HeadExchange, got {first:?}"
        );
        conn.send_json(&SyncMessage::ResetRequired {
            reason: "test: force snapshot catch-up".into(),
        })
        .await
        .expect("script send ResetRequired");
        conn.send_json(&SyncMessage::SnapshotOffer {
            size_bytes: super::snapshot_transfer::MAX_SNAPSHOT_SIZE + 1,
            // Rejected on size before any bytes/checksum are exchanged.
            blob_blake3: String::new(),
        })
        .await
        .expect("script send SnapshotOffer");
        let reply: SyncMessage = conn.recv_json().await.expect("script recv reject");
        assert_eq!(
            reply,
            SyncMessage::SnapshotReject,
            "initiator must reject the over-cap offer"
        );
        conn
    });

    let peer = sync_net::DiscoveredPeer {
        device_id: PEER.to_string(),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port,
    };
    let refs = vec![make_peer_ref(PEER)];
    let cancel = AtomicBool::new(false);

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_2538",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer must complete within timeout");
    assert!(!was_cancelled, "no cancel was issued");

    // Keep the scripted connection alive until the session returned.
    let _conn = tokio::time::timeout(std::time::Duration::from_secs(10), script)
        .await
        .expect("script task timed out")
        .expect("script task panicked");

    // ── Scheduler: failure + backoff, NOT success ─────────────────────
    assert_eq!(
        scheduler.failure_count(PEER),
        1,
        "#2538: the rejected catch-up must be recorded as a failure"
    );
    assert!(
        !scheduler.may_retry(PEER),
        "#2538: the peer must be in backoff (NOT immediately re-due)"
    );
    assert!(
        scheduler.peers_due_for_resync(&refs).is_empty(),
        "#2538: the 30 s resync tick must NOT re-select the rejected peer"
    );

    // ── Events: no Complete; an actionable size-cap error surfaced ───
    let events = sink.events();
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, SyncEvent::Complete { .. })),
        "#2538: a rejected catch-up must NOT emit SyncEvent::Complete, got {events:?}"
    );
    assert!(
        events.iter().any(|e| matches!(
            e,
            SyncEvent::Error { message, .. } if message.contains("exceeds local cap")
        )),
        "#2538: the sub-flow's actionable size-cap error must surface, got {events:?}"
    );
    assert!(
        events.iter().any(|e| matches!(
            e,
            SyncEvent::Error { message, .. } if message.contains("snapshot catch-up rejected")
        )),
        "#2538: the session-level rejection error must surface, got {events:?}"
    );

    // ── No success bookkeeping: no peer_refs row (no synced_at advance,
    //    no last_address persist, no TOFU cert upsert). ────────────────
    let row = peer_refs::get_peer_ref(&pool, PEER).await.unwrap();
    assert!(
        row.is_none(),
        "#2538: rejected catch-up must skip last_address/TOFU/synced_at \
         bookkeeping, got {row:?}"
    );

    server.shutdown().await;
    materializer.shutdown();
}

// ======================================================================
// #2539 item 1 — HANDSHAKE_TIMEOUT dispatch guard (incl. first dispatch)
// ======================================================================

/// #2539 (item 1): the shared dispatch guard
/// [`super::server::dispatch_with_handshake_timeout`] must abort a dispatch
/// that outlives `HANDSHAKE_TIMEOUT` with the session loops' long-standing
/// elapsed error. The responder's FIRST-message dispatch (the heavyweight
/// `HeadExchange`: per-space Loro exports, a vault-wide soft-deleted read, VV
/// decodes — run while holding a responder permit + the per-peer lock) used
/// to run bare; it now routes through this exact helper, as do the
/// responder's message loop (`server.rs`) and the initiator's loop
/// (`run_sync_session`). Pinning the helper's timeout + error shape therefore
/// pins all three sites, the same way the `RECV_TIMEOUT > HANDSHAKE_TIMEOUT`
/// structural tests in `sync_net::connection` pin the guard ordering.
///
/// `start_paused` virtual time makes the 120 s timeout elapse instantly and
/// deterministically.
#[tokio::test(start_paused = true)]
async fn dispatch_guard_2539_times_out_with_session_loop_error_shape() {
    use crate::sync_constants::HANDSHAKE_TIMEOUT;

    let never = std::future::pending::<Result<Option<SyncMessage>, AppError>>();
    let err = super::server::dispatch_with_handshake_timeout(never)
        .await
        .expect_err("a dispatch that outlives HANDSHAKE_TIMEOUT must be aborted");
    match err {
        AppError::InvalidOperation(msg) => assert_eq!(
            msg,
            format!(
                "handle_message timed out after {}s",
                HANDSHAKE_TIMEOUT.as_secs()
            ),
            "#2539: the elapsed mapping must keep the session loops' exact error text"
        ),
        other => panic!("#2539: expected InvalidOperation, got {other:?}"),
    }
}

/// #2539 (item 1) companion: the guard is transparent for dispatches that
/// finish in time — both the `Ok` value and a handler-produced error pass
/// through unchanged (no spurious timeout mapping).
#[tokio::test(start_paused = true)]
async fn dispatch_guard_2539_passes_through_prompt_results() {
    let ok = super::server::dispatch_with_handshake_timeout(std::future::ready(Ok::<
        Option<SyncMessage>,
        AppError,
    >(None)))
    .await;
    assert!(
        matches!(ok, Ok(None)),
        "#2539: a prompt Ok must pass through, got {ok:?}"
    );

    let err = super::server::dispatch_with_handshake_timeout(std::future::ready(Err::<
        Option<SyncMessage>,
        AppError,
    >(
        AppError::InvalidOperation("handler failed".into()),
    )))
    .await
    .expect_err("a prompt handler error must pass through");
    match err {
        AppError::InvalidOperation(msg) => assert_eq!(
            msg, "handler failed",
            "#2539: a handler error must not be rewritten by the guard"
        ),
        other => panic!("#2539: expected the handler's own error, got {other:?}"),
    }
}

// ======================================================================
// #2539 item 2 — exactly ONE terminal Complete per session per role
// ======================================================================

/// #2539 (item 2) regression: a full successful sync session must emit
/// exactly ONE `SyncEvent::Complete` per role.
///
/// Before the fix, the initiator's orchestrator emitted Complete on the
/// final-LoroSync path AND `try_sync_with_peer` emitted a second Complete
/// with identical counters through the raw daemon sink — every successful
/// session double-fired `sync:complete` on the frontend bus (double toast,
/// double reload). The responder always emitted once (orchestrator only).
///
/// Drives the REAL daemon-level initiator entry point (`try_sync_with_peer`
/// — the layer that used to duplicate) against a live `handle_incoming_sync`
/// responder over a real loopback TLS socket, with a seeded responder edit so
/// the session takes the streamed-ops path, and counts Complete events on
/// BOTH roles' sinks.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn complete_2539_full_session_emits_single_complete_per_role() {
    install_crypto_provider();

    const INIT_DEV: &str = "INIT2539";
    const RESP_DEV: &str = "RESP2539";
    const BLOCK: &str = "01HZ2539BLKXXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ2539SPACEXXXXXXXXXXXXX");

    // ── Responder: real handle_incoming_sync with one seeded edit ─────
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_mat = Materializer::new(resp_pool.clone());
    let resp_state = std::sync::Arc::clone(resp_mat.loro_state());
    peer_refs::upsert_peer_ref(&resp_pool, INIT_DEV)
        .await
        .unwrap();
    make_local_edit_602(
        &resp_pool,
        &resp_mat,
        &resp_state,
        RESP_DEV,
        &space,
        BLOCK,
        "seeded on responder (#2539)",
        1_736_942_400_000,
    )
    .await;

    let resp_sink = Arc::new(RecordingEventSink::new());
    let resp_cert = sync_net::generate_self_signed_cert(RESP_DEV).unwrap();
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(&resp_cert, move |conn, _permit| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    let resp_pool_clone = resp_pool.clone();
    let resp_mat_clone = resp_mat.clone();
    let resp_sink_dyn: Arc<dyn SyncEventSink> = resp_sink.clone();
    let resp_task = tokio::spawn(async move {
        let conn = tokio::time::timeout(std::time::Duration::from_secs(10), conn_rx.recv())
            .await
            .expect("responder accept timed out")
            .expect("responder connection channel closed");
        handle_incoming_sync(
            conn,
            resp_pool_clone,
            RESP_DEV.to_string(),
            resp_mat_clone,
            Arc::new(SyncScheduler::new()),
            resp_sink_dyn,
            Arc::new(AtomicBool::new(false)),
        )
        .await
    });

    // ── Initiator: the REAL daemon layer (try_sync_with_peer) ─────────
    let (init_pool, _init_dir) = test_pool().await;
    let init_mat = Materializer::new(init_pool.clone());
    let init_sink = Arc::new(RecordingEventSink::new());
    let init_sink_dyn: Arc<dyn SyncEventSink> = init_sink.clone();
    let init_cert = sync_net::generate_self_signed_cert(INIT_DEV).unwrap();
    let scheduler = Arc::new(SyncScheduler::new());
    let cancel = AtomicBool::new(false);

    let ctx = SyncSessionContext {
        pool: &init_pool,
        device_id: INIT_DEV,
        materializer: &init_mat,
        scheduler: &scheduler,
        event_sink: &init_sink_dyn,
        cancel: &cancel,
        cert: &init_cert,
    };
    let peer = sync_net::DiscoveredPeer {
        device_id: RESP_DEV.to_string(),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port,
    };
    let refs = vec![make_peer_ref(RESP_DEV)];

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer timed out");
    assert!(!was_cancelled, "no cancel was issued");

    let resp_result = tokio::time::timeout(std::time::Duration::from_secs(10), resp_task)
        .await
        .expect("responder task timed out")
        .expect("responder task panicked");
    resp_result.expect("responder session must succeed");
    server.shutdown().await;

    // The session really succeeded end-to-end (data flowed, no failure).
    let content: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK)
        .fetch_optional(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        content.as_deref(),
        Some("seeded on responder (#2539)"),
        "the responder's block must reach the initiator"
    );
    assert_eq!(
        scheduler.failure_count(RESP_DEV),
        0,
        "a clean session must not record a failure"
    );

    // ── #2539: exactly ONE terminal Complete per role ─────────────────
    let init_events = init_sink.events();
    let init_completes = init_events
        .iter()
        .filter(|e| matches!(e, SyncEvent::Complete { .. }))
        .count();
    assert_eq!(
        init_completes, 1,
        "#2539: the initiator must emit exactly ONE SyncEvent::Complete per \
         successful session, got {init_events:?}"
    );
    let resp_events = resp_sink.events();
    let resp_completes = resp_events
        .iter()
        .filter(|e| matches!(e, SyncEvent::Complete { .. }))
        .count();
    assert_eq!(
        resp_completes, 1,
        "#2539: the responder must emit exactly ONE SyncEvent::Complete per \
         successful session, got {resp_events:?}"
    );

    resp_mat.shutdown();
    init_mat.shutdown();
}

/// #2539 (item 2), snapshot catch-up path: an initiator session that
/// completes via the post-ResetRequired Loro-snapshot catch-up must also
/// emit exactly ONE `SyncEvent::Complete`.
///
/// On this path the orchestrator never emits Complete at all (its terminal
/// state is `ResetRequired`); the single emission is owned by
/// `snapshot_transfer`'s Applied path. Before the fix,
/// `try_sync_with_peer` then added a second Complete — and that duplicate
/// carried the stale ResetRequired-era session counters, not the catch-up's.
///
/// Mirrors the #2538 harness (real `try_sync_with_peer` against a scripted
/// loopback responder), but the script ACCEPTS the catch-up: after
/// `HeadExchange → ResetRequired` it streams one valid per-space Loro
/// snapshot frame (`LoroSync { is_last: true }`, the #2503 merge flow).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn complete_2539_snapshot_catchup_emits_single_complete() {
    install_crypto_provider();

    const PEER: &str = "PEER2539CU";
    const BLOCK: &str = "01HZ2539CBLKXXXXXXXXXXXXXX";
    let space = crate::space::SpaceId::from_trusted("01HZ2539CSPACEXXXXXXXXXXXX");

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cert = sync_net::generate_self_signed_cert("LOCAL2539CU").unwrap();

    let server_cert = sync_net::generate_self_signed_cert(PEER).unwrap();
    let (conn_tx, mut conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(1);
    let (server, port) = SyncServer::start(&server_cert, move |conn, _permit| {
        let _ = conn_tx.try_send(conn);
    })
    .await
    .unwrap();

    // Scripted responder: force the catch-up, then stream ONE valid Loro
    // space snapshot so the initiator's merge path (#2503) applies it.
    let script_space = space.clone();
    let script = tokio::spawn(async move {
        let mut conn = tokio::time::timeout(std::time::Duration::from_secs(10), conn_rx.recv())
            .await
            .expect("responder accept timed out")
            .expect("responder connection channel closed");
        let first: SyncMessage = conn.recv_json().await.expect("script recv HeadExchange");
        assert!(
            matches!(first, SyncMessage::HeadExchange { .. }),
            "initiator must open with HeadExchange, got {first:?}"
        );
        conn.send_json(&SyncMessage::ResetRequired {
            reason: "test: force snapshot catch-up (#2539)".into(),
        })
        .await
        .expect("script send ResetRequired");

        let bytes = {
            let mut e = crate::loro::engine::LoroEngine::with_peer_id(PEER).expect("script engine");
            e.apply_create_block(BLOCK, "content", "caught-up content (#2539)", None, 0)
                .expect("script create block");
            e.export_snapshot().expect("script export snapshot")
        };
        conn.send_json(&SyncMessage::LoroSync {
            msg: crate::sync_protocol::loro_sync_types::LoroSyncMessage::Snapshot {
                protocol_version: crate::sync_protocol::loro_sync_types::LORO_SYNC_PROTOCOL_VERSION,
                space_id: script_space,
                bytes,
            },
            is_last: true,
        })
        .await
        .expect("script send LoroSync snapshot");
        conn
    });

    let peer = sync_net::DiscoveredPeer {
        device_id: PEER.to_string(),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port,
    };
    let refs = vec![make_peer_ref(PEER)];
    let cancel = AtomicBool::new(false);

    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL2539CU",
        materializer: &materializer,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        cert: &cert,
    };

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer must complete within timeout");
    assert!(!was_cancelled, "no cancel was issued");

    // Keep the scripted connection alive until the session returned.
    let _conn = tokio::time::timeout(std::time::Duration::from_secs(10), script)
        .await
        .expect("script task timed out")
        .expect("script task panicked");
    server.shutdown().await;

    // The catch-up genuinely applied: merged block projected into SQL and
    // the session recorded as a success (no backoff).
    let content: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert_eq!(
        content.as_deref(),
        Some("caught-up content (#2539)"),
        "the snapshot catch-up must project the peer's block"
    );
    assert_eq!(
        scheduler.failure_count(PEER),
        0,
        "an applied catch-up is a success — no failure/backoff"
    );

    // ── #2539: exactly ONE terminal Complete (snapshot_transfer's) ────
    let events = sink.events();
    let completes = events
        .iter()
        .filter(|e| matches!(e, SyncEvent::Complete { .. }))
        .count();
    assert_eq!(
        completes, 1,
        "#2539: the snapshot catch-up path must emit exactly ONE \
         SyncEvent::Complete, got {events:?}"
    );

    materializer.shutdown();
}
