use super::*;
use crate::db::init_pool;
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_store::peer_refs::{self, PeerRef};
use agaric_sync::mdns;
use agaric_sync::sync_events::RecordingEventSink;
use agaric_sync::sync_protocol::{DeviceHead, SyncMessage, SyncOrchestrator};
use agaric_sync::sync_scheduler::SyncScheduler;
use agaric_sync::transport::SecretKey;
use agaric_sync::transport::session::{recv_sync_message, send_sync_message};
use agaric_sync::transport::test_support::{ServiceHarness, TestSide, quic_pair};
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

// ── the responder fixture (#78, plan #3464) ────────────────────────────────
//
// `handle_incoming_sync` takes an `InboundSession`, and that type has no public
// constructor: the only way to obtain one is to run the real admission path
// (bind → accept → establish). That is precisely the property that makes "a
// handler cannot name an unauthenticated peer" hold, so every responder test
// below stands up two real loopback endpoints instead of handing the responder
// a fabricated connection whose identity the test chose — which is what the old
// `test_connection_pair` + `set_test_cert` pair did.

/// Spawn the production responder against the next inbound session of `harness`.
///
/// `establish` resolves on the peer's FIRST frame, so the returned handle stays
/// parked until the caller's first [`send_sync_message`] — deliberately, because
/// that is what production does and because a fixture byte here would be
/// dispatched as a protocol frame.
fn spawn_responder(
    harness: &ServiceHarness,
    pool: SqlitePool,
    device_id: &str,
    materializer: Materializer,
    scheduler: Arc<SyncScheduler>,
    event_sink: Arc<dyn SyncEventSink>,
    cancel: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<Result<(), AppError>> {
    let service = harness.service.clone();
    let device_id = device_id.to_string();
    tokio::spawn(async move {
        let session = service
            .accept()
            .await
            .expect("the accept loop does not error")
            .expect("an inbound connection is admitted")
            .establish()
            .await
            .expect("the peer completes the handshake and opens its stream");
        handle_incoming_sync(
            session,
            pool,
            device_id,
            materializer,
            scheduler,
            event_sink,
            cancel,
        )
        .await
    })
}

/// The dialling endpoint's authenticated key, in the canonical `Display` spelling
/// `peer_refs.endpoint_id` stores (64 lowercase hex — `fmt_short` is rejected).
fn client_key(harness: &ServiceHarness) -> String {
    harness.client_endpoint.id().to_string()
}

/// Make the responder resolve the dialling endpoint as `peer_id`.
///
/// This is what `set_test_cert(Some(peer_id), _)` used to do, and the difference
/// is the whole identity model: the old transport let a peer *claim* an identity
/// in a certificate CN it minted itself, so a test could assign one from either
/// side. Here identity is the ed25519 key the QUIC handshake authenticated, and
/// the responder resolves it through `peer_refs` — so "the responder sees this
/// peer as X" is a row this device wrote, and a test that wants it has to write
/// that row.
async fn bind_client_as(pool: &SqlitePool, peer_id: &str, harness: &ServiceHarness) {
    peer_refs::upsert_peer_ref(pool, peer_id).await.unwrap();
    peer_refs::bind_endpoint_id(pool, peer_id, &client_key(harness))
        .await
        .unwrap();
}

/// A `HeadExchange` advertising exactly `heads`, with every negotiable feature
/// left off — the shape all the responder-gate tests below send.
fn head_exchange(heads: Vec<DeviceHead>, pairing_proof: Option<String>) -> SyncMessage {
    SyncMessage::HeadExchange {
        heads,
        loro_vvs: vec![],
        engine_format_version: agaric_engine::loro::engine::ENGINE_FORMAT_VERSION,
        op_log_replication: false,
        op_log_batch_chunked: false,
        pairing_proof,
        device_name: None,
    }
}

/// One synthetic head for `device_id`: what a device with a single op advertises.
fn fake_head(device_id: &str) -> DeviceHead {
    DeviceHead {
        device_id: device_id.to_string(),
        seq: 0,
        hash: "fakehash".to_string(),
    }
}

/// The `DiscoveredPeer` an mDNS announcement of `harness`'s service produces.
///
/// A dial names a key now, so the key is the load-bearing field and the
/// addresses are candidate paths iroh races. `endpoint_id` is taken from the
/// service itself rather than derived, for the reason `SyncService::endpoint_id`
/// documents: a record advertising a key nobody is listening on is worse than no
/// record at all.
fn discovered_service_peer(device_id: &str, harness: &ServiceHarness) -> mdns::DiscoveredPeer {
    let sa = harness
        .service
        .addr()
        .ip_addrs()
        .copied()
        .find(|sa: &std::net::SocketAddr| sa.ip().is_loopback())
        .expect("a loopback-bound service publishes its loopback socket address");
    mdns::DiscoveredPeer {
        device_id: device_id.to_string(),
        endpoint_id: Some(harness.service.endpoint_id()),
        addresses: vec![sa.ip()],
        port: sa.port(),
    }
}

/// A peer announcing a well-formed key that nobody is listening on, at a
/// loopback port nothing is bound to.
///
/// This is the "connection refused" case restated for a transport that dials
/// keys: there is no socket to refuse the connection, so the dial fails by
/// exhausting its own budget rather than by an immediate RST. Every caller wraps
/// it in a `tokio::time::timeout` for that reason.
fn unreachable_peer(device_id: &str) -> mdns::DiscoveredPeer {
    mdns::DiscoveredPeer {
        device_id: device_id.to_string(),
        endpoint_id: Some(mdns::test_endpoint_id(device_id)),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port: 1,
    }
}

/// Tear down a *rejected* session's client side, then reap the responder.
///
/// A rejection ends in `finish_session(spoke_last = true)`, which waits up to
/// `SessionLimits::close_wait` for the peer to close — the responder is a round
/// trip ahead of our read and the peer's close is its only evidence the
/// rejection landed. Closing from here resolves that wait at once instead of
/// letting every rejection test burn the full budget.
///
/// Also asserts the invariant every rejection path shares: a rejection is not an
/// error, so `handle_incoming_sync` returns `Ok(())`.
async fn close_and_join_ok(
    client: TestSide,
    handle: tokio::task::JoinHandle<Result<(), AppError>>,
) {
    client.conn.close(0u32.into(), b"test done");
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), handle)
        .await
        .expect("the responder must resolve once the peer closes")
        .expect("the responder task must not panic");
    assert!(
        result.is_ok(),
        "a rejection is not an error — handle_incoming_sync must return Ok, got {result:?}"
    );
}

/// Assert `response` is the wire rejection the responder sends for `rejection`.
///
/// Asserted through [`Rejection::peer_message`] rather than against a duplicated
/// literal, so a reworded rejection cannot leave a test green while asserting on
/// text nothing sends any more.
fn assert_rejected(response: &SyncMessage, rejection: &Rejection) {
    let expected = rejection.peer_message();
    assert!(
        matches!(response, SyncMessage::Error { message } if message == expected),
        "expected the responder's {rejection:?} rejection ({expected:?}), got: {response:?}"
    );
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
        activation: DaemonActivation::default(),
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
        activation: DaemonActivation::default(),
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
        activation: DaemonActivation::default(),
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
        activation: DaemonActivation::default(),
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
        activation: DaemonActivation::default(),
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
        activation: DaemonActivation::default(),
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

    let mut discovered: HashMap<String, (mdns::DiscoveredPeer, Instant)> = HashMap::new();

    let fresh_peer = mdns::DiscoveredPeer {
        device_id: "FRESH_PEER".into(),
        endpoint_id: None,
        addresses: vec!["192.168.1.10".parse().unwrap()],
        port: 9000,
    };
    discovered.insert("FRESH_PEER".into(), (fresh_peer, Instant::now()));

    let stale_peer = mdns::DiscoveredPeer {
        device_id: "STALE_PEER".into(),
        endpoint_id: None,
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

// ── the cert-verification unit tests are gone with the mechanism ──────
//
// `verify_peer_cert` / `CertVerifyResult` answered "is this claimed identity
// really the peer's". Under the old transport the answer had to be computed in
// the app layer, because identity arrived as a certificate CN the peer minted
// for itself (`CN=agaric-{victim}` was one `rcgen` call away). The B-33 hash
// pin, B-34's CN check and #800's missing-cert rejection were all compensation
// for that one fact.
//
// The QUIC handshake now answers it, before a single application byte moves, so
// the functions are gone from production and their unit tests with them. What
// those tests were ultimately protecting — that an unrecognised peer cannot sync
// this vault — did not go anywhere; it is the S-1 / #855 / #800 responder tests
// further down, which exercise the real admission path rather than a pure
// function over four `Option<&str>`s.

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
        streamed_at: None,
        reset_count: 0,
        last_reset_at: None,
        cert_hash: None,
        device_name: None,
        remote_device_name: None,
        last_address: None,
        endpoint_id: None,
        unpaired_by_peer_at_ms: None,
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
    let refs: Vec<agaric_store::peer_refs::PeerRef> = vec![]; // no peer_refs yet — mid-pairing
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
    let refs: Vec<agaric_store::peer_refs::PeerRef> = vec![];
    assert!(
        !should_attempt_sync_with_discovered_peer("MY_DEVICE", "MY_DEVICE", false, &refs, true),
        "self-discovery guard must hold even while pairing is pending"
    );
}

/// #3502: the pairing-pending bypass MUST override the already-discovered
/// guard. This test previously asserted the exact opposite and was the thing
/// that made the deadlock look like intended behaviour; its name is now the
/// specification of the fix.
///
/// A first-ever pair is always in this configuration by the time the user
/// finishes typing the code: both dialogs arm on open, both devices dial and
/// reject each other on a proof mismatch, and both therefore sit in each
/// other's `discovered` map before the passphrase is ever entered. If
/// `already_discovered` outranks `pairing_pending`, the window closes with
/// nobody dialling.
///
/// The guard's real job — not re-firing a session on every mDNS refresh of an
/// already-known peer in the *paired steady state* — is unaffected, and is
/// pinned by `should_attempt_sync_rejects_already_discovered_peer` above
/// (same inputs, `pairing_pending: false`). The two tests differ in exactly
/// one argument, which is the whole of the fix.
#[test]
fn should_attempt_sync_accepts_already_discovered_while_pairing_pending() {
    let refs: Vec<agaric_store::peer_refs::PeerRef> = vec![];
    assert!(
        should_attempt_sync_with_discovered_peer("PEER_NEW", "MY_DEVICE", true, &refs, true),
        "#3502: a rediscovered unpaired peer must be re-initiated against while \
         pairing is pending — the window is exactly when rediscovery MUST dial"
    );
}

// ======================================================================
// T-41 — Fallback peer construction
// ======================================================================

#[test]
fn build_fallback_peer_parses_valid_ipv4_socket_addr() {
    let peer = build_fallback_peer("DEV_A", "192.168.1.42:9443", None);
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
    // The consequence of this being the one constructor that yields no key: a
    // peer built from `last_address` alone cannot be dialled at all, because a
    // dial names a key now. `try_sync_with_peer_skips_peer_it_cannot_dial` is
    // what that costs. Pinned here so the two facts sit next to each other —
    // see the note above `daemon_branch_c_resync_timer_attempts_overdue_peer`.
    assert!(
        peer.endpoint_id.is_none(),
        "a peer synthesised from last_address carries no key to dial"
    );
}

#[test]
fn build_fallback_peer_parses_valid_ipv6_socket_addr() {
    let peer = build_fallback_peer("DEV_B", "[::1]:8080", None);
    assert!(peer.is_some(), "valid IPv6 socket addr must parse");
    let peer = peer.unwrap();
    assert_eq!(peer.device_id, "DEV_B", "device_id must match input");
    assert_eq!(peer.port, 8080, "port must be extracted from socket addr");
    assert!(peer.addresses[0].is_loopback(), "::1 must be loopback");
}

#[test]
fn build_fallback_peer_returns_none_for_invalid_address() {
    assert!(
        build_fallback_peer("DEV_X", "not-an-address", None).is_none(),
        "garbage input must return None"
    );
    assert!(
        build_fallback_peer("DEV_X", "192.168.1.1", None).is_none(),
        "IP without port must return None (not a SocketAddr)"
    );
    assert!(
        build_fallback_peer("DEV_X", "", None).is_none(),
        "empty string must return None"
    );
}

#[test]
fn build_fallback_peer_parses_ipv6_link_local_with_scope_id() {
    // Bracketed form — the canonical IPv6+port syntax with a scope ID.
    let peer = build_fallback_peer("DEV_LINK_LOCAL", "[fe80::1%eth0]:8080", None);
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
    let peer = build_fallback_peer("DEV_LINK_LOCAL_2", "fe80::1%eth0:8080", None);
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
    let peer = build_fallback_peer("DEV_NUM_SCOPE", "[fe80::1%2]:8080", None);
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

    let mut discovered: HashMap<String, (mdns::DiscoveredPeer, Instant)> = HashMap::new();
    for i in 0..5 {
        let peer = mdns::DiscoveredPeer {
            device_id: format!("PEER_{i}"),
            endpoint_id: None,
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

    let mut discovered: HashMap<String, (mdns::DiscoveredPeer, Instant)> = HashMap::new();
    for i in 0..3 {
        let peer = mdns::DiscoveredPeer {
            device_id: format!("OLD_{i}"),
            endpoint_id: None,
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
    let harness = ServiceHarness::new().await;

    let peer = unreachable_peer("PEER_X");
    let refs = vec![make_peer_ref("PEER_X")];

    // Put peer in backoff
    scheduler.record_failure("PEER_X");
    assert!(
        !scheduler.may_retry("PEER_X"),
        "peer must be in backoff after failure"
    );

    let apply_host_ctx_845: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_DEV",
        materializer: &apply_host_ctx_845,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
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
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(false);
    let harness = ServiceHarness::new().await;

    // Peer with unreachable address (connection will be refused)
    let peer = unreachable_peer("PEER_UNREACHABLE");
    let refs = vec![make_peer_ref("PEER_UNREACHABLE")];

    let apply_host_ctx_896: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_DEV",
        materializer: &apply_host_ctx_896,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    // Wrap in a timeout to prevent the test from hanging if the dial blocks.
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
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

/// #4120 note 6: the repeat-report suppression is *wired into* the real
/// initiator path, not merely correct inside its helper.
///
/// Every other #4120 test calls `record_initiator_failure` directly, which pins the
/// predicate but not the call. A call site that handed it the wrong `peer_id`,
/// or a `peer_refs` slice that did not contain this peer, would satisfy all of
/// them and still re-raise the toast on every cycle — the exact bug. So this
/// one drives `try_sync_with_peer` end to end against a peer that does not
/// answer, and asserts on what the user is told.
///
/// The daemon reaches the suppressed state by failing twice; a test cannot,
/// because the first failure arms the backoff gate and the second dial costs
/// another connect budget. So the "already reported once" state is *seeded*
/// (`record_failure` + `remember_reported_failure`, then the gate is waited
/// out, exactly as the daemon waits it out) and the observed text of a real
/// failure is what gets seeded — arm A produces it, arm B feeds it back.
/// Nothing here hardcodes the message.
///
/// Four arms, because no one of them alone is enough:
///
/// * **A — a failure the user has not been shown reports.** It also supplies
///   the failure text and proves the run reaches `record_initiator_failure` at
///   all.
/// * **B — the same failure against a peer that is still pulling from us is
///   silent**, and the `connecting` progress event proves the run got past the
///   backoff gate and really dialled rather than returning early.
/// * **C (#4305) — the same failure against a peer that has gone dark, already
///   reported while dark, is also silent.** This is the arm the pre-#4305 gate
///   fails: `already_reported && still_serving` could never close for a peer
///   that had stopped streaming, so this text re-toasted every 60 s forever.
/// * **D (#4305) — a peer that goes dark after being told while it was still
///   serving reports once more.** The signal the old `still_serving` term
///   existed to protect survives; only its unbounded repetition does not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_repeat_report_suppression_is_wired_into_try_sync_with_peer_4120() {
    const PEER: &str = "PEER_RESPONDER_ONLY_4120";

    /// One daemon cycle against an unreachable peer, entered in the state a
    /// second cycle of a streak is in: one failure booked, `already_reported`
    /// already shown to the user, backoff expired.
    ///
    /// Returns every event the sink saw plus the peer's failure count.
    async fn cycle(
        streamed_at: Option<i64>,
        already_reported: &str,
        // #4305: the suppression key is `(text, still-serving)`, so seeding
        // "already shown" now has to say which of the two the user was shown.
        reported_while_serving: bool,
    ) -> (Vec<SyncEvent>, u32) {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let scheduler = Arc::new(SyncScheduler::new());
        let sink = Arc::new(RecordingEventSink::new());
        let event_sink: Arc<dyn SyncEventSink> = sink.clone();
        let cancel = AtomicBool::new(false);
        let harness = ServiceHarness::new().await;

        // `remember_reported_failure` is a no-op without a backoff entry, so
        // the booking has to come first — which is also the real ordering.
        scheduler.record_failure(PEER);
        scheduler.remember_reported_failure(PEER, already_reported, reported_while_serving);
        // …and that booking arms the backoff gate (~2 s for the first
        // failure). Waiting it out is what makes this a *second cycle* rather
        // than an early return at step 1.
        let waited_from = std::time::Instant::now();
        while !scheduler.may_retry(PEER) {
            assert!(
                waited_from.elapsed() < std::time::Duration::from_secs(30),
                "the first failure's backoff must expire in seconds, not minutes"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        let peer = unreachable_peer(PEER);
        let mut peer_ref = make_peer_ref(PEER);
        peer_ref.streamed_at = streamed_at;
        let refs = vec![peer_ref];

        let apply_host: Arc<dyn agaric_sync::apply_host::ApplyHost> =
            Arc::new(materializer.clone());
        let ctx = SyncSessionContext {
            pool: &pool,
            device_id: "LOCAL_DEV",
            materializer: &apply_host,
            scheduler: &scheduler,
            event_sink: &event_sink,
            cancel: &cancel,
            endpoint: &harness.client_endpoint,
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(60),
            try_sync_with_peer(&ctx, &peer, &refs),
        )
        .await
        .expect("the dial must exhaust its own budget well inside the test timeout");

        let events = sink.events();
        let failures = scheduler.failure_count(PEER);
        materializer.shutdown();
        (events, failures)
    }

    fn error_texts(events: &[SyncEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                SyncEvent::Error { message, .. } => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    // ---- Arm A: a failure text the user has never been shown. Reports, and
    // hands us the exact text a real failure produces.
    let (dark_events, dark_failures) =
        cycle(None, "a failure text nothing will ever produce", false).await;
    let reported = error_texts(&dark_events);
    assert_eq!(
        reported.len(),
        1,
        "the first report of a given failure is news and must always land — a peer \
         going from healthy to unreachable may never fail in silence; got {dark_events:?}"
    );
    assert!(
        reported[0].starts_with("Connection failed"),
        "the dial-failure arms of try_sync_with_peer report a 'Connection failed: …' \
         text; got {:?}",
        reported[0]
    );
    assert_eq!(
        dark_failures, 2,
        "the seeded failure plus this one — the backoff is booked on every cycle"
    );

    // ---- Arm B: the same failure, same peer id, against a peer whose
    // `streamed_at` says it is still pulling from us. Silent.
    //
    // This is the assertion the helper-level tests cannot make: it goes red if
    // the call site passes a `peer_id` the scheduler's memory is not keyed on,
    // or a `peer_refs` slice this peer is not in.
    let (fresh_events, fresh_failures) =
        cycle(Some(agaric_store::db::now_ms()), &reported[0], true).await;
    assert!(
        error_texts(&fresh_events).is_empty(),
        "#4084/#4120: the SAME failure against a peer that is still streaming to us \
         must not re-raise the toast, through the real call path and not just the \
         helper; got {fresh_events:?}"
    );
    assert!(
        fresh_events.iter().any(|e| matches!(
            e,
            SyncEvent::Progress { state, remote_device_id, .. }
                if state == "connecting" && remote_device_id == PEER
        )),
        "…and the run must actually have dialled: without the 'connecting' event \
         this arm would be green because nothing ran, not because the report was \
         suppressed; got {fresh_events:?}"
    );
    assert_eq!(
        fresh_failures, 2,
        "suppressing the report must not suppress the booking — the backoff is what \
         paces the retry (#4120)"
    );

    // ---- Arm C (#4305): the same failure against a peer that has gone dark,
    // already reported *while dark*. Silent.
    //
    // This is the arm that was red before #4305. `still_serving` is false here
    // and stays false — a peer that has genuinely gone away stops streaming
    // immediately — so the old `already_reported && still_serving` gate could
    // never close and this text fired once every resync interval, forever, with
    // nothing about it having changed since the first time.
    let (dark_repeat_events, dark_repeat_failures) = cycle(None, &reported[0], false).await;
    assert!(
        error_texts(&dark_repeat_events).is_empty(),
        "#4305: an unchanged failure against a peer the user has already been told \
         about must not re-raise the toast just because the peer is no longer \
         streaming to us. The peer row and the status dot are the durable \
         surfaces; a toast is transient and transient means once. Got \
         {dark_repeat_events:?}"
    );
    assert_eq!(
        dark_repeat_failures, 2,
        "…and the backoff is still booked on the suppressed cycle"
    );

    // ---- Arm D (#4305): the peer has gone dark, but what the user was told
    // was told while it was still serving us. That is a different fact about
    // the pair — "we cannot pull" became "we are not exchanging at all" — so it
    // reports once more.
    let (went_dark_events, _) = cycle(None, &reported[0], true).await;
    assert_eq!(
        error_texts(&went_dark_events),
        vec![reported[0].clone()],
        "#4305: folding still-serving into the key rather than deleting it is what \
         keeps a pair going dark audible — exactly once. Got {went_dark_events:?}"
    );
}

/// #4203, through the real initiator path: the pinned-identity refusal now
/// routes through the same repeat-report gate as every other initiator failure.
///
/// The refusal fires at step 4 of `try_sync_with_peer` — before the dial — so
/// two real cycles cost nothing but the backoff wait between them. That is what
/// makes this the wiring pin the helper-level tests cannot be: it goes red if
/// the call site books the failure and emits its own event again (the pre-#4203
/// shape), if it passes a `peer_id` the scheduler's memory is not keyed on, or
/// if it passes a `peer_refs` slice this peer is not in.
///
/// Three arms are driven because since #4305 the suppression key is
/// `(text, still_serving)`: the pair going dark is still news, but it is news
/// once — not once per cycle, which is what the pre-#4305 gate produced for a
/// security-relevant refusal that by its nature never resolves on its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pinned_identity_refusal_is_wired_into_try_sync_with_peer_4203() {
    const PEER: &str = "PEER_IDENTITY_4203";
    const REFUSAL: &str = "peer identity does not match the one paired with this device";

    /// Two consecutive refusal cycles against the same peer, with the backoff
    /// the first one arms waited out in between.
    async fn two_cycles(streamed_at: [Option<i64>; 2]) -> (Vec<SyncEvent>, u32) {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());
        let scheduler = Arc::new(SyncScheduler::new());
        let sink = Arc::new(RecordingEventSink::new());
        let event_sink: Arc<dyn SyncEventSink> = sink.clone();
        let cancel = AtomicBool::new(false);
        let harness = ServiceHarness::new().await;

        // The row this peer is pinned to names a DIFFERENT key from the one the
        // discovery record announces — "a different device answering to a paired
        // peer's name", which is the condition step 4 refuses on.
        let peer = unreachable_peer(PEER);
        let mut peer_ref = make_peer_ref(PEER);
        peer_ref.endpoint_id = Some(mdns::test_endpoint_id("A_DIFFERENT_DEVICE").to_string());
        assert_ne!(
            peer_ref.endpoint_id.as_deref(),
            peer.endpoint_id.map(|k| k.to_string()).as_deref(),
            "precondition: the pinned key and the announced key must differ, or this \
             test would exercise the ordinary dial path"
        );

        let apply_host: Arc<dyn agaric_sync::apply_host::ApplyHost> =
            Arc::new(materializer.clone());
        for (cycle, streamed) in streamed_at.iter().enumerate() {
            // #4305: per-cycle, so an arm can move the peer from "still
            // pulling from us" to "gone dark" between the two refusals — the
            // transition the key exists to keep audible.
            let mut peer_ref = peer_ref.clone();
            peer_ref.streamed_at = *streamed;
            let refs = vec![peer_ref];
            if cycle > 0 {
                // The first refusal booked a failure, which arms the ~2 s
                // backoff gate at step 1. Waiting it out is what makes the
                // second call a second *cycle* rather than an early return.
                let waited_from = std::time::Instant::now();
                while !scheduler.may_retry(PEER) {
                    assert!(
                        waited_from.elapsed() < std::time::Duration::from_secs(30),
                        "the first failure's backoff must expire in seconds"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
            let ctx = SyncSessionContext {
                pool: &pool,
                device_id: "LOCAL_DEV",
                materializer: &apply_host,
                scheduler: &scheduler,
                event_sink: &event_sink,
                cancel: &cancel,
                endpoint: &harness.client_endpoint,
            };
            try_sync_with_peer(&ctx, &peer, &refs).await;
        }

        let events = sink.events();
        let failures = scheduler.failure_count(PEER);
        materializer.shutdown();
        (events, failures)
    }

    fn refusals(events: &[SyncEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                SyncEvent::Error { message, .. } => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    // ---- Arm A: the pair is visibly working in the other direction.
    let now = agaric_store::db::now_ms();
    let (fresh_events, fresh_failures) = two_cycles([Some(now), Some(now)]).await;
    assert_eq!(
        refusals(&fresh_events),
        vec![REFUSAL.to_string()],
        "#4203: two cycles of the same refusal against a peer that is still pulling \
         from us must raise ONE toast, not one per cycle; got {fresh_events:?}"
    );
    assert!(
        !fresh_events
            .iter()
            .any(|e| matches!(e, SyncEvent::Progress { state, .. } if state == "connecting")),
        "…and the refusal must still refuse: reaching the dial would mean step 4 \
         stopped gating. Got {fresh_events:?}"
    );
    assert_eq!(
        fresh_failures, 2,
        "…while the backoff is booked on every cycle — quieting the toast must not \
         quieten the scheduler"
    );

    // ---- Arm B: nothing is pulling from us either. The refusal is the whole
    // story of a peer we have lost, so it is told — and, since #4305, told
    // once. The condition does not resolve by itself, so repeating it every
    // cycle taught the user to dismiss red toasts unread, which costs them the
    // *next* one. The peer row carries it from here.
    let (dark_events, dark_failures) = two_cycles([None, None]).await;
    assert_eq!(
        refusals(&dark_events),
        vec![REFUSAL.to_string()],
        "#4305: an unchanged refusal against an unchanged peer is one toast per \
         streak, not one per resync interval; got {dark_events:?}"
    );
    assert_eq!(dark_failures, 2);

    // ---- Arm C (#4305): the peer was still pulling from us when we told the
    // user, and has since gone dark. That is new information — a key mismatch
    // while the pair still works is a nuisance, a key mismatch on a pair that
    // has stopped exchanging is the loss of the device — so it reports again.
    let (went_dark_events, went_dark_failures) = two_cycles([Some(now), None]).await;
    assert_eq!(
        refusals(&went_dark_events),
        vec![REFUSAL.to_string(), REFUSAL.to_string()],
        "#4305: still-serving lives in the suppression KEY, so a pair going dark \
         mid-streak surfaces the refusal a second time; got {went_dark_events:?}"
    );
    assert_eq!(went_dark_failures, 2);
}

// The old `handle_incoming_sync_rejects_sync_with_self` lived here. It was the
// real-loopback-TLS twin of the in-memory self-sync test, and the two collapsed
// into one when the fixtures did: there is now a single responder fixture (a
// real admitted QUIC session), so `handle_incoming_sync_rejects_self` further
// down is both. Its setup changed with the identity model — a device that dials
// itself is recognised by its key resolving to our own `peer_refs` row, not by a
// certificate CN it minted saying so.

/// Test 4: When the cancel flag is set before (or during) a sync session,
/// `run_sync_session` returns Err("sync cancelled by user") after sending the
/// initial `HeadExchange`.
///
/// Runs over a real loopback QUIC bi-stream. The peer is never driven: the
/// point is that the initiator gives up on its own signal, not that anyone
/// answered. `quic_pair` owns both endpoints, so the connection stays up for as
/// long as the fixture is held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_sync_session_respects_cancel_flag() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    let mut pair = quic_pair().await;

    let mut orch = SyncOrchestrator::new(
        pool.clone(),
        "INITIATOR_DEV".to_string(),
        materializer.clone(),
    );

    // Set the cancel flag BEFORE calling run_sync_session.
    let cancel = AtomicBool::new(true);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // run_sync_session:
    // 1. orch.start() → HeadExchange  (succeeds)
    // 2. send_sync_message(...)        (succeeds — the frame is written)
    // 3. the driver loop's pre-recv cancel check → Err("sync cancelled by user")
    let run_session_host: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let result = run_sync_session(
        &mut orch,
        &mut pair.client.send,
        &mut pair.client.recv,
        &pair.client.conn,
        &cancel,
        &pool,
        &run_session_host,
        &event_sink,
    )
    .await;

    assert!(
        result.is_err(),
        "run_sync_session should return an error when cancelled"
    );
    // The cancellation error moved with the loop. It used to read "sync cancelled
    // by user" and be produced by `run_sync_session`'s own loop; the one driver
    // that replaced both loops produces this one instead. Pinned exactly, not by
    // substring: `try_sync_with_peer` distinguishes a cancel from a failure by
    // reading the shared flag rather than by matching this text (#2537), so this
    // string is what a user and a log see and nothing else keeps it honest.
    let err = result.unwrap_err();
    assert!(
        matches!(&err, AppError::InvalidOperation(msg) if msg == "[transport::driver] session cancelled"),
        "expected AppError::InvalidOperation(\"[transport::driver] session cancelled\"), got: {err:?}"
    );

    materializer.shutdown();
}

// ======================================================================
// T-41 — Additional edge-case tests for daemon async functions
// ======================================================================

/// When a DiscoveredPeer cannot be dialled at all, try_sync_with_peer returns
/// early with no events and no failure recorded.
///
/// The undiallable case moved. It used to be an empty address list, because a
/// dial named a socket; under iroh a dial names a KEY and the addresses are only
/// candidate paths to it, so the peer that cannot be dialled is the one with no
/// `endpoint_id` — the shape `build_fallback_peer` still synthesises from a
/// pre-iroh `peer_refs.last_address` row. An empty address list is no longer an
/// early exit at all: iroh is handed a keyed `EndpointAddr` with no paths and
/// fails the connect, which is a *failure*, not a skip.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_skips_peer_it_cannot_dial() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(false);
    let harness = ServiceHarness::new().await;

    let peer = mdns::DiscoveredPeer {
        device_id: "PEER_NOADDR".to_string(),
        // No key: nothing to dial, whatever the addresses say.
        endpoint_id: None,
        addresses: vec!["192.168.1.1".parse().unwrap()],
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_NOADDR")];

    let apply_host_ctx_1171: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &apply_host_ctx_1171,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

    // #3511: and it is skipped before the per-peer lock too, not after it. The key is
    // derived from the endpoint id, so resolving that had to move above the lock —
    // which also means a peer we cannot dial at all no longer takes and releases a
    // lock on its way out. `gc_unused_peer_locks` counts the entries `try_lock_peer`
    // would have left behind; before the reorder this was 1.
    assert_eq!(
        scheduler.gc_unused_peer_locks(),
        0,
        "#3511: a peer that cannot be dialled must not allocate a peer lock"
    );

    // No events — the peer is skipped before the "connecting" event
    assert_eq!(
        sink.events().len(),
        0,
        "no events should be emitted for a peer that cannot be dialled"
    );
    assert_eq!(
        scheduler.failure_count("PEER_NOADDR"),
        0,
        "no failure should be recorded for a peer that was never dialled"
    );

    materializer.shutdown();
}

/// A peer that announced no *name* is skipped before anything is spent on it.
///
/// The empty `device_id` is refused in four independent places (mDNS parse, here,
/// `bind_endpoint_id`, `get_peer_ref_by_endpoint_id`) because each closes the hole on
/// its own and an announcement is not the only way a `DiscoveredPeer` is built —
/// `build_fallback_peer` synthesises one from a `peer_refs` row. The row an empty id
/// produces is filtered out of `list_peer_refs` (`WHERE peer_id != ''`), so it is
/// absent from the device list and from unpair while still being present enough to
/// resolve the responder's S-1 gate.
///
/// # Why this asserts on events rather than the return value
///
/// The return value is `false` either way: without the skip the peer falls through to
/// the dial, which fails, which also returns `false`. What separates the two is what
/// was *spent* — the "connecting" event, the error event, and the recorded failure that
/// backs this nameless id off. Asserting zero of each is the only reading that can tell
/// the skip from the failure.
///
/// The endpoint id is real and the address is the same one
/// `try_sync_with_peer_emits_error_event_on_connection_failure` uses, so nothing but
/// the empty name distinguishes this case from that one — which emits exactly 2 events
/// and records 1 failure.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_skips_a_peer_with_no_device_id() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(false);
    let harness = ServiceHarness::new().await;

    // Everything about this peer is well-formed except its name.
    let peer = unreachable_peer("");
    assert!(
        peer.endpoint_id.is_some(),
        "the fixture must carry a real key, or this test would exercise the \
         cannot-dial arm instead"
    );
    // A ref list that does not mention this peer, so the pinned-key check at step 4
    // could not be what stops it.
    let refs = vec![make_peer_ref("SOME_OTHER_PEER")];

    let apply_host: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &apply_host,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    let cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer must complete within the timeout");

    assert!(!cancelled, "no session ran, so no cancel was observed");
    assert_eq!(
        sink.events().len(),
        0,
        "a nameless peer must be skipped before the 'connecting' event — reaching the \
         dial means the empty id was carried far enough to be bound"
    );
    assert_eq!(
        scheduler.failure_count(""),
        0,
        "nothing may be recorded against a device id that does not exist"
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
    let harness = ServiceHarness::new().await;

    let peer = unreachable_peer("PEER_LOCKED");
    let refs = vec![make_peer_ref("PEER_LOCKED")];

    // Acquire the per-peer lock before calling try_sync_with_peer. #3511: the key is
    // the peer's endpoint id, not its device id — the responder cannot key on a device
    // id it has not been told, so both roles key on the handshake identity.
    let _guard = scheduler
        .try_lock_peer(&peer_lock_key(peer.endpoint_id.unwrap()))
        .unwrap();

    let apply_host_ctx_1219: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &apply_host_ctx_1219,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

    assert_eq!(
        sink.events().len(),
        0,
        "no events should be emitted when peer is already locked"
    );

    materializer.shutdown();
}

// The old `handle_incoming_sync_rejects_unpaired_device` lived here — the
// real-loopback-TLS twin of the in-memory S-1 test. Like the self-sync pair
// above, the two collapsed into one when the fixtures did:
// `handle_incoming_sync_rejects_unpaired` further down runs the real admission
// path, so there is no longer an "in-memory" version for it to be the socket
// counterpart of.

/// S-11 / #637: When `try_sync_with_peer` exits via the connection-failure
/// path it runs NO real session, so it does NOT own the cancel and must
/// LEAVE a pre-set (user) cancel flag intact — otherwise an early-exiting
/// peer would swallow a cancel aimed at a still-running sibling. The guard
/// only clears the flag once a real session was reached (`owns == true`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn try_sync_with_peer_preserves_cancel_flag_after_connection_failure() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // start with cancel set
    let harness = ServiceHarness::new().await;

    let peer = unreachable_peer("PEER_FAIL");
    let refs = vec![make_peer_ref("PEER_FAIL")];

    let apply_host_ctx_1351: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_DEV",
        materializer: &apply_host_ctx_1351,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
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
    let harness = ServiceHarness::new().await;

    let peer = unreachable_peer("PEER_BACKOFF");
    let refs = vec![make_peer_ref("PEER_BACKOFF")];

    // Put peer in backoff so the gate triggers
    scheduler.record_failure("PEER_BACKOFF");
    assert!(
        !scheduler.may_retry("PEER_BACKOFF"),
        "peer must be in backoff"
    );

    let apply_host_ctx_1421: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &apply_host_ctx_1421,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
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
    let harness = ServiceHarness::new().await;

    let peer = unreachable_peer("PEER_LOCKED");
    let refs = vec![make_peer_ref("PEER_LOCKED")];

    // Hold the per-peer lock so the function returns early. #3511: keyed on the
    // endpoint id, which is what `try_sync_with_peer` locks on.
    let _lock = scheduler
        .try_lock_peer(&peer_lock_key(peer.endpoint_id.unwrap()))
        .unwrap();

    let apply_host_ctx_1463: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &apply_host_ctx_1463,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

    assert!(
        cancel.load(Ordering::Acquire),
        "#637: already-syncing early-exit must PRESERVE a pre-set cancel flag"
    );

    materializer.shutdown();
}

/// S-11 / #637: the undiallable-peer early return runs no session, so it must
/// PRESERVE a pre-set user cancel rather than clear a sibling's cancel.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s11_cancel_preserved_on_undiallable_peer_early_exit() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // cancel is set
    let harness = ServiceHarness::new().await;

    let peer = mdns::DiscoveredPeer {
        device_id: "PEER_NOADDR".to_string(),
        // No key → the early return, before anything is dialled.
        endpoint_id: None,
        addresses: vec!["192.168.1.1".parse().unwrap()],
        port: 9999,
    };
    let refs = vec![make_peer_ref("PEER_NOADDR")];

    let apply_host_ctx_1501: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL",
        materializer: &apply_host_ctx_1501,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    try_sync_with_peer(&ctx, &peer, &refs).await;

    assert!(
        cancel.load(Ordering::Acquire),
        "#637: the undiallable-peer early-exit must PRESERVE a pre-set cancel flag"
    );

    materializer.shutdown();
}

// ======================================================================
// T-16 — responder gate tests, over a real admitted QUIC session
// ======================================================================
//
// These were "in-memory WebSocket tests": a `test_connection_pair` plus
// `set_test_cert(Some(id), _)`, which let the test hand the responder whatever
// identity it liked — because the old transport let the *peer* do exactly the
// same, with a self-signed `CN=agaric-{id}`. The port removes both halves.
// `handle_incoming_sync` takes an `InboundSession`, which only the real
// admission path can produce, and the identity it reads is the ed25519 key the
// QUIC handshake authenticated. So a test that wants the responder to see
// `REMOTE_DEV` now binds the dialling key to that row (`bind_client_as`),
// exactly as `confirm_pairing` and the initiator's TOFU do in production.

/// #778, now key-derived: a connection whose authenticated key resolves to our
/// OWN device id is refused as a self-sync.
///
/// The mechanism moved; the guarantee did not. Identity used to be a certificate
/// CN, so a device that dialled itself through a stale mDNS record presented
/// `CN=agaric-LOCAL_DEV` and the responder compared that string. Now the key is
/// resolved through `peer_refs` and the resulting `peer_id` is compared — so the
/// case is set up by binding the dialling key to a row named after this device,
/// not by minting a certificate.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_self() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let harness = ServiceHarness::new().await;
    // The dialling endpoint resolves to LOCAL_DEV — this device's own id.
    bind_client_as(&pool, "LOCAL_DEV", &harness).await;

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler,
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &head_exchange(vec![fake_head("LOCAL_DEV")], None),
    )
    .await
    .unwrap();

    let response = recv_sync_message(&mut client.recv).await.unwrap();
    assert_rejected(&response, &Rejection::Self_);

    close_and_join_ok(client, handle).await;
    materializer.shutdown();
}

/// S-1: a key with no `peer_refs` row and no pairing in progress is a stranger,
/// however well the handshake authenticated it.
///
/// This is the gate the whole cert apparatus used to sit in front of. QUIC now
/// proves *which key* dialled and proves it cryptographically — which is exactly
/// why this test still matters: anyone can generate a keypair, so "authenticated"
/// and "authorized to sync this vault" remain different questions.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_unpaired() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // No peer_refs row for the dialling key, and no pairing window open.
    let harness = ServiceHarness::new().await;

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler,
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &head_exchange(vec![fake_head("UNKNOWN_DEVICE")], None),
    )
    .await
    .unwrap();

    let response = recv_sync_message(&mut client.recv).await.unwrap();
    assert_rejected(&response, &Rejection::Unpaired);

    close_and_join_ok(client, handle).await;
    materializer.shutdown();
}

/// #800's surviving guarantee: a key that is NOT bound to the target row is
/// refused even though a row for that device id exists with a *different* key.
///
/// The original attack shape — an anonymous, cert-less TLS socket claiming a
/// cert-pinned device id in its `HeadExchange` heads — is unrepresentable now:
/// there is no anonymous connection (the handshake names a key) and the heads
/// are not an identity input at all. What is still representable, and is what
/// #800 was ultimately about, is a peer that presents *some* authenticated key
/// and wants to be treated as `REMOTE_PAIRED`. It is refused, and refused at
/// S-1 rather than by a hash comparison, because the lookup runs on the key the
/// handshake proved and finds nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_a_key_not_bound_to_the_claimed_peer_800() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // The victim is fully paired AND already key-bound — to somebody else's key.
    peer_refs::upsert_peer_ref(&pool, "REMOTE_PAIRED")
        .await
        .unwrap();
    peer_refs::bind_endpoint_id(
        &pool,
        "REMOTE_PAIRED",
        &mdns::test_endpoint_id("the real REMOTE_PAIRED").to_string(),
    )
    .await
    .unwrap();

    // The attacker dials with its own key and claims the victim's id in its heads.
    let harness = ServiceHarness::new().await;
    assert_ne!(
        client_key(&harness),
        mdns::test_endpoint_id("the real REMOTE_PAIRED").to_string(),
        "test premise: the attacker must not hold the victim's key"
    );

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler,
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &head_exchange(vec![fake_head("REMOTE_PAIRED")], None),
    )
    .await
    .unwrap();

    let response = recv_sync_message(&mut client.recv).await.unwrap();
    assert_rejected(&response, &Rejection::Unpaired);

    close_and_join_ok(client, handle).await;

    // And the claim left no trace: the victim's binding is untouched, so the
    // legitimate device can still connect.
    let victim = peer_refs::get_peer_ref(&pool, "REMOTE_PAIRED")
        .await
        .unwrap()
        .expect("the victim row must survive the refused claim");
    assert_eq!(
        victim.endpoint_id.as_deref(),
        Some(
            mdns::test_endpoint_id("the real REMOTE_PAIRED")
                .to_string()
                .as_str()
        ),
        "#800: a refused claim must not re-point the victim's key binding"
    );

    materializer.shutdown();
}

/// S-5: a second concurrent session with the same peer is refused.
///
/// The per-peer lock keys on the peer's endpoint id in both roles (#3511), so an
/// inbound session cannot run alongside an outbound one to the same install.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_busy_peer() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let harness = ServiceHarness::new().await;
    bind_client_as(&pool, "REMOTE_DEV", &harness).await;

    // Pre-acquire the per-peer lock to simulate a concurrent outbound session. The key
    // is the dialling endpoint's, which is what `try_sync_with_peer` would hold.
    let _guard = scheduler.try_lock_peer(&client_key(&harness)).unwrap();

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler.clone(),
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &head_exchange(vec![fake_head("REMOTE_DEV")], None),
    )
    .await
    .unwrap();

    let response = recv_sync_message(&mut client.recv).await.unwrap();
    assert_rejected(&response, &Rejection::Busy);

    close_and_join_ok(client, handle).await;
    materializer.shutdown();
}

/// S-5 across the two roles (#3511): an inbound session is refused while an
/// OUTBOUND session with the same physical peer is in flight — *during the
/// pairing window*, which is the only window in which the two used to disagree.
///
/// # Why this test and not `handle_incoming_sync_rejects_busy_peer`
///
/// That test pre-holds the lock with a bare `try_lock_peer`, so it asserts the
/// responder honours *a* lock. S-5 is a stronger claim: mutual exclusion **across
/// roles**, which is a statement about two call sites agreeing on a spelling. A
/// test that exercises one role cannot see a disagreement. So the lock here is
/// held by the real `try_sync_with_peer`, and the two halves are checked to
/// overlap in time (`!outbound.is_finished()` on both sides of the exchange).
///
/// # The fixture detail the whole test hangs on
///
/// The joiner's `HeadExchange` advertises **no heads at all**. That is not
/// decoration — it is the case:
///
/// * `get_local_heads` reads only `op_log`, so a fresh joiner with an empty log
///   has no head of its own to advertise;
/// * the responder's `claimed_id` therefore resolves to `""`, and before this fix
///   the responder fell back to locking on the endpoint id while the initiator
///   locked on `peer.device_id` — two keys, no exclusion.
///
/// Hand this test `head_exchange(vec![fake_head("JOINING_DEV")], …)` instead and
/// it passes with or without the fix, because both roles would then have the
/// device id and would agree by accident. Empty heads is what makes it a test.
///
/// # Why the outbound half never connects
///
/// It dials the peer's real key at a loopback port nothing is bound to, so it sits
/// in `CONNECT_TIMEOUT` holding the peer lock — the state a live outbound session
/// is in, reached without needing a second full daemon. `lan_only` clears address
/// lookup and disables relays, so the dial cannot find the peer's endpoint by any
/// route other than the (dead) address given.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inbound_is_refused_while_outbound_holds_the_same_peer_3511() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    // ONE scheduler, as in production: both roles on this device share it. Two
    // schedulers would make the test vacuous.
    let scheduler = Arc::new(SyncScheduler::new());

    // The pairing window: a pending marker and NO `peer_refs` row for the joiner.
    let proof = agaric_sync::pairing::pairing_proof("the pairing passphrase");
    peer_refs::set_pending_pairing(&pool, &proof).await.unwrap();

    // `harness.service` is THIS device's inbound service; `harness.client_endpoint` is
    // the PEER's endpoint — the identity that dials us, and the identity we dial.
    let harness = ServiceHarness::new().await;
    // A second harness, used only for its endpoint: this device's outbound dialler.
    let local = ServiceHarness::new().await;
    assert_ne!(
        local.client_endpoint.id(),
        harness.client_endpoint.id(),
        "precondition: the dialler and the peer must be distinct identities"
    );
    assert!(
        peer_refs::get_peer_ref_by_endpoint_id(&pool, &client_key(&harness))
            .await
            .unwrap()
            .is_none(),
        "precondition: the peer must be unbound — that is what the pairing window is"
    );

    // ── the outbound half ────────────────────────────────────────────────────
    //
    // The same physical peer as seen from the initiator's side: a device id (which
    // the initiator always has, from the announcement) and the endpoint id it dials.
    let peer = mdns::DiscoveredPeer {
        device_id: "JOINING_DEV".to_string(),
        endpoint_id: Some(harness.client_endpoint.id()),
        addresses: vec!["127.0.0.1".parse().unwrap()],
        port: 1,
    };

    let out_sink = Arc::new(RecordingEventSink::new());
    let outbound = tokio::spawn({
        let pool = pool.clone();
        let scheduler = scheduler.clone();
        let materializer = materializer.clone();
        let endpoint = local.client_endpoint.clone();
        let out_sink = out_sink.clone();
        let peer = peer.clone();
        async move {
            let apply_host: Arc<dyn agaric_sync::apply_host::ApplyHost> = Arc::new(materializer);
            let event_sink: Arc<dyn SyncEventSink> = out_sink;
            let cancel = AtomicBool::new(false);
            let ctx = SyncSessionContext {
                pool: &pool,
                device_id: "LOCAL_DEV",
                materializer: &apply_host,
                scheduler: &scheduler,
                event_sink: &event_sink,
                cancel: &cancel,
                endpoint: &endpoint,
            };
            // An empty ref list, so the step-4 pinned-key check cannot be what stops
            // (or fails to stop) anything here.
            try_sync_with_peer(&ctx, &peer, &[]).await
        }
    });

    // Barrier: the "connecting" event is emitted AFTER the per-peer lock is taken and
    // BEFORE the dial, in both the old and the new step order — so it marks the start
    // of the overlap window without itself assuming which key was used.
    wait_for(
        || !out_sink.events().is_empty(),
        std::time::Duration::from_secs(10),
        "the outbound half takes the peer lock and reaches its dial",
    )
    .await;
    assert!(
        !outbound.is_finished(),
        "fixture: the outbound half must still hold the peer lock when the inbound \
         session arrives"
    );

    // ── the inbound half, from that same peer ────────────────────────────────
    let in_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler.clone(),
        in_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        // No heads: the fresh joiner. See the doc comment — this is the fixture
        // detail that makes the two roles' keys differ before the fix.
        &head_exchange(vec![], Some(proof.clone())),
    )
    .await
    .unwrap();

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        recv_sync_message(&mut client.recv),
    )
    .await
    .expect(
        "the responder must answer the inbound HeadExchange; a silent responder here \
         means it was admitted past S-5 and is running a session that overlaps the \
         outbound one",
    )
    .unwrap();

    assert!(
        !outbound.is_finished(),
        "fixture: the outbound half must still have been holding the peer lock while \
         the responder decided — otherwise there was nothing to contend with"
    );
    assert_rejected(&response, &Rejection::Busy);

    outbound.abort();
    close_and_join_ok(client, handle).await;
    materializer.shutdown();
}

/// #1519: the documented pairing flow leaves the responder with NO `peer_refs`
/// row at confirm time — `confirm_pairing_inner` only writes the
/// `set_pending_pairing` marker, because the QR carries a passphrase and not the
/// joiner's identity. The first post-pair connection therefore arrives from a
/// device this side has never heard of.
///
/// The port did not change that. `peer_refs.endpoint_id` cannot be written
/// before the key that fills it has connected, so an unbound key during the
/// pairing window is still the normal case and S-1 would still deadlock pairing
/// without this exception.
///
/// The transition is proven by pre-acquiring the per-peer lock: a device that
/// gets past S-1 lands on the busy branch, an observably different answer from
/// the "not paired" rejection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_admits_first_connection_while_pairing_pending() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // The responder has just confirmed pairing: no peer_refs row exists yet,
    // only the marker, which is what admits an unbound key past S-1.
    let expected_proof = agaric_sync::pairing::pairing_proof("pass one two three four");
    peer_refs::set_pending_pairing(&pool, &expected_proof)
        .await
        .unwrap();
    assert!(
        peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "precondition: a pairing must be pending"
    );

    let harness = ServiceHarness::new().await;

    // Pre-acquire the per-peer lock so that — and only if — the connection gets
    // PAST the S-1 unpaired gate, it lands on the busy branch. #3511: the key is the
    // dialling endpoint's, which is what both roles lock on; the harness therefore has
    // to exist before the lock is taken.
    let _guard = scheduler.try_lock_peer(&client_key(&harness)).unwrap();

    assert!(
        peer_refs::get_peer_ref_by_endpoint_id(&pool, &client_key(&harness))
            .await
            .unwrap()
            .is_none(),
        "precondition: the joiner's key must be unknown to this device"
    );

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler.clone(),
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        // #855: the matching proof is what admits the device past S-1.
        &head_exchange(vec![fake_head("JOINING_DEV")], Some(expected_proof.clone())),
    )
    .await
    .unwrap();

    let response = recv_sync_message(&mut client.recv).await.unwrap();
    assert_rejected(&response, &Rejection::Busy);
    assert_ne!(
        &response,
        &SyncMessage::Error {
            message: Rejection::Unpaired.peer_message().to_owned()
        },
        "#1519: the first post-pair connection must NOT be rejected as unpaired \
         while a pairing is pending"
    );

    close_and_join_ok(client, handle).await;
    materializer.shutdown();
}

/// #855 driver: with a pairing pending (the marker holding the proof for
/// `"the real passphrase"`), drive `handle_incoming_sync` against a first
/// connection from an unbound key that offers `offered_proof`, and return
/// `(response, victim_was_bound, still_pending)`.
///
/// The per-peer lock for the dialling endpoint is pre-held throughout, so an
/// ADMITTED connection has a distinct observable — the busy rejection — rather
/// than running a whole session. That makes one driver serve the reject cases
/// and the admit case alike.
#[cfg(test)]
async fn run_pairing_proof_scenario_855(
    offered_proof: Option<String>,
) -> (SyncMessage, bool, bool) {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let expected_proof = agaric_sync::pairing::pairing_proof("the real passphrase");
    peer_refs::set_pending_pairing(&pool, &expected_proof)
        .await
        .unwrap();

    let harness = ServiceHarness::new().await;
    // #3511: the responder locks on the dialling endpoint's key, so that is what has to
    // be pre-held for an admitted connection to land on the busy branch.
    let _guard = scheduler.try_lock_peer(&client_key(&harness)).unwrap();

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler.clone(),
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &head_exchange(vec![fake_head("VICTIM_DEV")], offered_proof),
    )
    .await
    .unwrap();

    let response = recv_sync_message(&mut client.recv).await.unwrap();
    close_and_join_ok(client, handle).await;

    // Did the connection get TOFU-bound as the victim device? Under the old
    // stack the question was "was a cert hash pinned"; the key binding is what
    // replaced it, and it is the thing an admitted attacker would walk away with.
    let victim_was_bound = peer_refs::get_peer_ref(&pool, "VICTIM_DEV")
        .await
        .unwrap()
        .is_some();
    let still_pending = peer_refs::is_pending_pairing(&pool).await.unwrap();

    materializer.shutdown();
    (response, victim_was_bound, still_pending)
}

/// #855 (security): an unpaired device that connects during the pairing window
/// with NO passphrase proof is REJECTED at the S-1 gate, is never bound, and
/// does not consume the pairing window.
///
/// **This is the most important test in this file, and the one this port was
/// most likely to delete by mistake.** The comment it used to carry called the
/// attacker a "CN-spoofer", which reads like the proof was part of the
/// certificate defence — it was not. QUIC proves *which key* dialled; it says
/// nothing about whether that key may touch this vault, and anyone can generate
/// a keypair. Without the proof, the pairing window would admit *and bind*
/// whichever endpoint happened to connect during it. Cryptographic identity
/// narrowed the proof's job — from "defend against a forged identity" to
/// "authorize a genuine but unknown one" — it did not retire it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_pairing_without_proof_855() {
    let (response, victim_bound, still_pending) = run_pairing_proof_scenario_855(None).await;
    assert_rejected(&response, &Rejection::PairingProofMissing);
    assert!(
        !victim_bound,
        "#855: a proofless connection must never be bound as the victim device"
    );
    assert!(
        still_pending,
        "#855: a rejected proofless attempt must not consume the pairing window"
    );
}

/// #855 (security): the same, but the peer offers a WRONG proof — a value it
/// guessed or minted without knowing the passphrase. Constant-time-mismatched →
/// rejected, never bound, window preserved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_pairing_with_wrong_proof_855() {
    let wrong = agaric_sync::pairing::pairing_proof("a wrong passphrase guess");
    let (response, victim_bound, still_pending) = run_pairing_proof_scenario_855(Some(wrong)).await;
    assert_rejected(&response, &Rejection::PairingProofMissing);
    assert!(
        !victim_bound,
        "#855: an attacker with a wrong proof must never be bound as the victim device"
    );
    assert!(
        still_pending,
        "#855: a rejected wrong-proof attempt must not consume the pairing window"
    );
}

/// #855 (the positive half): the SAME unbound key, during the SAME pairing
/// window, offering the RIGHT proof is admitted past S-1 — landing on the
/// pre-held lock's busy branch rather than on either rejection.
///
/// Without this the two tests above would be satisfied by a responder that
/// refuses everything, which is not the property #855 describes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_admits_pairing_with_correct_proof_855() {
    let right = agaric_sync::pairing::pairing_proof("the real passphrase");
    let (response, _victim_bound, still_pending) =
        run_pairing_proof_scenario_855(Some(right)).await;
    assert_rejected(&response, &Rejection::Busy);
    assert!(
        still_pending,
        "the pairing window is consumed by a completed session, not by admission"
    );
}

/// #3463 (end-to-end): drive the real command layer on TWO devices, then feed
/// the joiner's resulting proof into the responder's #855 gate.
///
/// This closes a loop the unit tests can only assert half of. The host runs
/// `start_pairing_armed_inner` (what the `start_pairing` command calls) and the
/// joiner runs `start_pairing_inner` + `confirm_pairing_inner` with the host's
/// passphrase — the exact production call sequence, on two independent pools.
///
/// As in `handle_incoming_sync_admits_first_connection_while_pairing_pending`,
/// the per-peer lock is pre-held so admission has an observable that is not a
/// whole sync session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pairing_proof_from_two_device_command_flow_is_admitted_3463() {
    // --- Device JOINER: real command-layer pairing with the HOST's passphrase.
    let (joiner_pool, _joiner_dir) = test_pool().await;
    let joiner_state = std::sync::Mutex::new(None);
    let joiner_sched = SyncScheduler::new();

    // --- Device HOST: the test's responder. Its pool is the daemon's pool.
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let host_passphrase = crate::commands::start_pairing_armed_inner(
        &pool,
        &std::sync::Mutex::new(None),
        &scheduler,
        "LOCAL_DEV",
    )
    .await
    .unwrap()
    .passphrase;

    // The joiner's dialog mints a competing passphrase of its own (#3463's root
    // cause), but the user types the host's.
    crate::commands::start_pairing_inner(&joiner_state, "JOINING_DEV").unwrap();
    crate::commands::confirm_pairing_inner(
        &joiner_pool,
        &joiner_state,
        &joiner_sched,
        "JOINING_DEV",
        host_passphrase,
        String::new(),
    )
    .await
    .expect("#3463: the joiner accepts the host's passphrase");

    // What the initiator puts on the wire (`session_state_machine::start`).
    let offered_proof = peer_refs::get_pending_pairing_proof(&joiner_pool)
        .await
        .unwrap()
        .expect("#3463: the joiner must hold a pending-pairing marker after confirm");

    assert!(
        peer_refs::get_peer_ref(&pool, "JOINING_DEV")
            .await
            .unwrap()
            .is_none(),
        "precondition: the joining device must still be unpaired on the host"
    );
    let harness = ServiceHarness::new().await;
    // #3511: pre-held on the dialling endpoint's key, the spelling both roles use.
    let _guard = scheduler.try_lock_peer(&client_key(&harness)).unwrap();

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler.clone(),
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &head_exchange(vec![fake_head("JOINING_DEV")], Some(offered_proof)),
    )
    .await
    .unwrap();

    let response = recv_sync_message(&mut client.recv).await.unwrap();
    close_and_join_ok(client, handle).await;
    materializer.shutdown();

    assert_rejected(&response, &Rejection::Busy);
    assert_ne!(
        &response,
        &SyncMessage::Error {
            message: Rejection::Unpaired.peer_message().to_owned()
        },
        "#3463: the joiner must not be rejected as unpaired"
    );
    assert_ne!(
        &response,
        &SyncMessage::Error {
            message: Rejection::PairingProofMissing.peer_message().to_owned()
        },
        "#3463: the joiner's proof must satisfy the #855 constant-time check"
    );
}

/// #1519 (control): the pending-pairing exception is gated on the marker — an
/// unbound key with NO active marker is still rejected at the S-1 gate. This
/// guards against the exception accidentally admitting every unknown key.
/// Mirrors `handle_incoming_sync_admits_first_connection_while_pairing_pending`
/// but with no marker set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_unpaired_without_pending_marker() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // No peer_refs row for the dialling key AND no pending-pairing marker.
    assert!(
        !peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "precondition: no pairing may be pending"
    );

    let harness = ServiceHarness::new().await;
    // Hold the lock too: if the gate were (wrongly) bypassed we would see
    // "busy"; the correct behaviour is the "not paired" rejection before it.
    // #3511: keyed on the dialling endpoint, the key the responder locks on.
    let _guard = scheduler.try_lock_peer(&client_key(&harness)).unwrap();

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler.clone(),
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &head_exchange(vec![fake_head("UNKNOWN_DEV")], None),
    )
    .await
    .unwrap();

    let response = recv_sync_message(&mut client.recv).await.unwrap();
    assert_rejected(&response, &Rejection::Unpaired);

    close_and_join_ok(client, handle).await;
    materializer.shutdown();
}

/// #1605: when the daemon's shared cancel flag is set, the responder session
/// aborts PROMPTLY — well before the 180 s receive bound it would otherwise
/// block on while waiting for the next message from a slow/hung initiator — and
/// releases the per-peer lock.
///
/// Reproduces the bug fixed here: the responder used to thread a fresh,
/// never-set `AtomicBool`, so a flipped shutdown/user-cancel signal was
/// invisible to it. The client sends a single `HeadExchange` and then goes
/// silent; without the cancel check the responder would block for the full
/// receive budget.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_aborts_on_cancel_and_releases_lock() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Bind the peer so the session reaches the message loop (an unbound key is
    // rejected before the orchestrator is even built).
    let harness = ServiceHarness::new().await;
    bind_client_as(&pool, "REMOTE_DEV", &harness).await;

    // The daemon's REAL shared cancel flag, flipped to simulate a shutdown /
    // user-cancel that arrives while the session is in flight.
    let cancel = Arc::new(AtomicBool::new(true));

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler.clone(),
        event_sink,
        cancel.clone(),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &head_exchange(vec![fake_head("REMOTE_DEV")], None),
    )
    .await
    .unwrap();

    // Drain whatever the responder managed to send and then close, so its
    // shutdown is never waiting on our read. The assertion is the timeout: a
    // responder that ignored the cancel would sit on the receive bound instead.
    tokio::spawn(async move {
        while recv_sync_message(&mut client.recv).await.is_ok() {}
        client.conn.close(0u32.into(), b"test done");
    });

    let _result = tokio::time::timeout(std::time::Duration::from_secs(20), handle)
        .await
        .expect("a cancelled responder session must abort promptly, not sit on the recv bound")
        .expect("the responder task must not panic");

    // The per-peer lock must have been released when the session aborted —
    // otherwise a cancelled/hung responder would strand the peer as "busy".
    assert!(
        scheduler.try_lock_peer(&client_key(&harness)).is_some(),
        "the per-peer lock must be released after the responder aborts on cancel"
    );

    // #2537: the responder session that consumed the cancel is a legitimate
    // resetter (mirroring the initiator's CancelGuard owns-path) — the flag must
    // be cleared on teardown, not latched forever.
    assert!(
        !cancel.load(Ordering::Acquire),
        "#2537: a responder session that consumed the cancel must clear the \
         shared flag on exit"
    );

    materializer.shutdown();
}

/// #3324 shared harness: drive `handle_incoming_sync` with `first_msg` as the
/// responder's FIRST frame and assert the connection is refused before the
/// orchestrator — and therefore before
/// `snapshot_transfer::try_offer_loro_snapshot_catchup` — ever sees it.
///
/// The port changed the shape of the guarantee. Under the old stack this check
/// was the *authorization* gate: everything (the self-sync check, S-1, #855,
/// S-5, the cert pin) lived inside an `if let SyncMessage::HeadExchange { .. }`
/// block, so any other first frame fell through it and a single `ResetRequired`
/// reached the snapshot export. Now nothing is dispatched until the checks below
/// have run, AND `Role::Responder { opening }` carries the frame, so the driver
/// cannot dispatch a frame this function did not hand it. The rejection stays
/// because it is still load-bearing for something else: the #855 proof rides
/// *inside* `HeadExchange`, so admitting any other variant during the pairing
/// window would be #3324 wearing different clothes.
///
/// No key is bound and no pairing is pending, which is deliberate: the frame is
/// refused ahead of the peer lookup, so an authorized peer would fare no better.
///
/// Asserts, in order:
/// 1. the responder's reply is `Error` naming `HeadExchange`;
/// 2. nothing follows it on the wire (no snapshot / `SyncComplete` — the
///    catch-up sub-flow was never entered);
/// 3. the task returns `Ok` and does not panic (the file-transfer variants trip
///    a `debug_assert!` if they reach `handle_message`);
/// 4. NO sync event was emitted — the orchestrator was never constructed.
async fn assert_non_head_exchange_first_msg_rejected(first_msg: SyncMessage) {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();

    let harness = ServiceHarness::new().await;
    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler,
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(&mut client.send, &first_msg)
        .await
        .unwrap();

    // (1)
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        recv_sync_message(&mut client.recv),
    )
    .await
    .expect("the responder must reply within the timeout")
    .expect("the responder must send a rejection before closing");
    assert_rejected(&response, &Rejection::NotHeadExchange);

    // (2) Nothing else on the wire: the responder finishes its send stream right
    // after the rejection, so the next receive fails rather than yielding a
    // `LoroSync` snapshot or the catch-up's terminal `SyncComplete`.
    let after = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        recv_sync_message(&mut client.recv),
    )
    .await
    .expect("the responder must close promptly after rejecting");
    assert!(
        after.is_err(),
        "the responder must send NOTHING after the rejection (no vault snapshot \
         export) for first message {first_msg:?}, got: {after:?}"
    );

    // (3)
    close_and_join_ok(client, handle).await;

    // (4) Pre-#3324 a `ResetRequired` first message emitted a `SyncEvent::Error`
    // from the orchestrator plus the catch-up's `loro_snapshot_offered` progress
    // event; a refused connection must emit neither.
    assert_eq!(
        sink.events().len(),
        0,
        "a refused connection must emit no sync events, got: {:?}",
        sink.events()
    );

    materializer.shutdown();
}

/// #3324: `SyncComplete` as a first frame is refused up front.
///
/// This variant is always harmless (the state table rejects it in `Idle`), which
/// is precisely why the original version of this test did not catch #3324.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_sync_complete_first_msg() {
    assert_non_head_exchange_first_msg_rejected(SyncMessage::SyncComplete {
        last_hash: "fakehash".to_string(),
    })
    .await;
}

/// #3324 (HIGH) regression: `ResetRequired` was the exploit primitive. The state
/// machine accepts it in ANY state, its dispatch arm sets
/// `SyncState::ResetRequired`, and `is_terminal()` counts it terminal — so
/// pre-fix a single anonymous `{"type":"ResetRequired","reason":"x"}` frame
/// skipped the message loop and fell straight into
/// `try_offer_loro_snapshot_catchup`, which exports every registered space's
/// full `LoroDoc`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_reset_required_first_msg() {
    assert_non_head_exchange_first_msg_rejected(SyncMessage::ResetRequired {
        reason: "x".to_string(),
    })
    .await;
}

/// #3324 regression: `Error` is `ResetRequired`'s nearest miss — the only OTHER
/// variant the state table accepts in *any* state (`session_state_machine.rs`,
/// the `(_, SyncMessage::Error { .. } | SyncMessage::ResetRequired { .. })` arm)
/// and the only other one whose dispatch returns `Ok(None)` while moving the
/// session into a state `is_terminal()` accepts. Pinned here so the guard, and
/// not one `matches!`, is what keeps it out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_error_first_msg() {
    assert_non_head_exchange_first_msg_rejected(SyncMessage::Error {
        message: "x".to_string(),
    })
    .await;
}

/// #3324 regression: `FileRequest` passes state-validation in any state, so
/// pre-fix an unauthenticated first message reached `handle_message`'s
/// file-transfer dispatch arm and tripped its `debug_assert!`. It must be
/// refused before the orchestrator exists.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_file_request_first_msg() {
    assert_non_head_exchange_first_msg_rejected(SyncMessage::FileRequest {
        attachment_ids: vec!["att-1".to_string()],
    })
    .await;
}

/// #3324 regression: the same as `FileRequest` but for the unit variant
/// `FileTransferComplete`, reachable as a two-field-free frame
/// (`{"type":"FileTransferComplete"}`) thanks to `#[serde(tag = "type")]`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_incoming_sync_rejects_file_transfer_complete_first_msg() {
    assert_non_head_exchange_first_msg_rejected(SyncMessage::FileTransferComplete).await;
}

// ── B-34 / B-33 responder tests are gone with their mechanism ─────────
//
// `inmem_handle_incoming_sync_rejects_cert_cn_mismatch` fed the responder a
// certificate CN that disagreed with the device id claimed in the heads, and
// `..._rejects_cert_hash_mismatch` fed it an observed cert hash that disagreed
// with the pinned one. Both questions were artefacts of identity arriving as a
// self-asserted string next to a separately self-asserted claim; the handshake
// answers them now, and there is no second claim left to disagree with. The
// third, `..._rejects_certless_claim_of_pinned_peer_800`, could not be ported at
// all — its whole premise was an anonymous connection, which the ALPN + TLS 1.3
// handshake no longer produces. Its surviving guarantee is
// `handle_incoming_sync_rejects_a_key_not_bound_to_the_claimed_peer_800` above.
//
// `inmem_handle_incoming_sync_rejects_unidentifiable_peer` went the same way:
// the "cannot identify remote device" rejection no longer exists, because
// identity is no longer derived from the wire at all. A peer that advertises
// empty heads is now simply resolved by its key — which is a property worth
// pinning, and `issue778_fresh_device_empty_heads_completes_session_against_seeded_responder`
// pins it end to end.

// ======================================================================
// T-16e — resolve_peer_address tests
// ======================================================================

#[test]
fn resolve_peer_address_returns_discovered_peer() {
    use tokio::time::Instant;

    let mut discovered: HashMap<String, (mdns::DiscoveredPeer, Instant)> = HashMap::new();
    let dp = mdns::DiscoveredPeer {
        device_id: "PEER_A".into(),
        endpoint_id: None,
        addresses: vec!["10.0.0.1".parse().unwrap()],
        port: 9443,
    };
    discovered.insert("PEER_A".into(), (dp, Instant::now()));

    let result = resolve_peer_address("PEER_A", Some("192.168.1.1:8080"), None, &discovered);
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

    let discovered: HashMap<String, (mdns::DiscoveredPeer, Instant)> = HashMap::new();

    let result = resolve_peer_address(
        "PEER_B",
        Some("192.168.1.42:9443"),
        Some(&"a".repeat(64)),
        &discovered,
    );
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

    let discovered: HashMap<String, (mdns::DiscoveredPeer, Instant)> = HashMap::new();

    let result = resolve_peer_address("PEER_C", None, None, &discovered);
    assert!(
        result.is_none(),
        "must return None when neither discovered nor cached"
    );
}

#[test]
fn resolve_peer_address_prefers_discovered_over_fallback() {
    use tokio::time::Instant;

    let mut discovered: HashMap<String, (mdns::DiscoveredPeer, Instant)> = HashMap::new();
    let dp = mdns::DiscoveredPeer {
        device_id: "PEER_D".into(),
        endpoint_id: None,
        addresses: vec!["10.0.0.99".parse().unwrap()],
        port: 5555,
    };
    discovered.insert("PEER_D".into(), (dp, Instant::now()));

    let result = resolve_peer_address("PEER_D", Some("192.168.1.1:8080"), None, &discovered);
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
    let peer = mdns::DiscoveredPeer {
        device_id: "DEV".into(),
        endpoint_id: None,
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
    let peer = mdns::DiscoveredPeer {
        device_id: "DEV".into(),
        endpoint_id: None,
        addresses: vec![],
        port: 9443,
    };
    let result = format_peer_address(&peer);
    assert!(result.is_none(), "must return None for empty addresses");
}

#[test]
fn format_peer_address_uses_first_address_when_multiple() {
    let peer = mdns::DiscoveredPeer {
        device_id: "DEV".into(),
        endpoint_id: None,
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
    let peer = mdns::DiscoveredPeer {
        device_id: "DEV".into(),
        endpoint_id: None,
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
    let peer = mdns::DiscoveredPeer {
        device_id: "DEV".into(),
        endpoint_id: None,
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
    let peer = mdns::DiscoveredPeer {
        device_id: "DEV".into(),
        endpoint_id: None,
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
    let peer = mdns::DiscoveredPeer {
        device_id: "DEV".into(),
        endpoint_id: None,
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
    let peer = mdns::DiscoveredPeer {
        device_id: "REMOVED_PEER".into(),
        endpoint_id: None,
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
    let peer = mdns::DiscoveredPeer {
        device_id: "OTHER_PEER".into(),
        endpoint_id: None,
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
    let peer = mdns::DiscoveredPeer {
        device_id: "REMOVED".into(),
        endpoint_id: None,
        addresses: vec!["192.168.1.42".parse().unwrap()],
        port: 9443,
    };
    discovered.insert("REMOVED".to_string(), (peer, tokio::time::Instant::now()));

    let event = mdns_sd::ServiceEvent::ServiceRemoved(
        mdns::MDNS_SERVICE_TYPE.to_string(),
        format!(
            "{name}_REMOVED.{ty}",
            name = mdns::MDNS_SERVICE_NAME,
            ty = mdns::MDNS_SERVICE_TYPE,
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
        streamed_at: None,
        reset_count: 0,
        last_reset_at: None,
        cert_hash: cert_hash.map(String::from),
        device_name: None,
        remote_device_name: None,
        last_address: None,
        endpoint_id: None,
        unpaired_by_peer_at_ms: None,
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
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    // Generate a real self-signed cert for the test
    let endpoint_secret = SecretKey::generate();

    // Start the daemon — this binds a TLS server on a random port
    // and may or may not start mDNS (depends on test environment)
    let daemon = SyncDaemon::start(
        pool.clone(),
        "TEST_DEV".to_string(),
        mat.clone(),
        scheduler,
        endpoint_secret,
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
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let endpoint_secret = SecretKey::generate();

    let daemon = SyncDaemon::start(
        pool.clone(),
        "TEST_DEV2".to_string(),
        mat.clone(),
        scheduler,
        endpoint_secret,
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

    // Assert the daemon loop is still alive before shutdown — otherwise
    // this test cannot distinguish "cancel left the daemon running" from
    // "cancel wrongly killed the daemon loop", since shutdown() + the
    // closing wait_for() below would pass identically either way.
    assert!(
        daemon.handle.as_ref().is_some_and(|h| !h.is_finished()),
        "cancel_active_sync must not terminate the daemon loop"
    );

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

// `generate_cert_produces_valid_pem` lived here. It asserted the PEM shape of
// the self-signed certificate the daemon used to be started with; the daemon is
// now started with an ed25519 `SecretKey` and there is no PEM. The identity that
// replaced it — its stable spelling and its persistence across restarts, which
// is what actually makes `peer_refs.endpoint_id` a pin — is owned by
// `agaric_sync::transport::identity`, where its tests live.

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_daemons_start_on_different_ports() {
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

    let endpoint_secret1 = SecretKey::generate();
    let endpoint_secret2 = SecretKey::generate();

    let d1 = SyncDaemon::start(
        pool1,
        "DEV_A".into(),
        mat1.clone(),
        sched1,
        endpoint_secret1,
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
        endpoint_secret2,
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

// ── the three Branch B / Branch C dispatch tests below FAIL after the port ──
//
// They are left failing deliberately, because the failure is real and is not
// theirs. All three prove "the daemon dispatched this peer" by pointing it at an
// unreachable `peer_refs.last_address` and waiting for a recorded failure. That
// probe no longer fires, and the reason is upstream of the tests:
//
//   * `daemon_loop`'s Branch B and Branch C resolve a peer with
//     `resolve_peer_address`, which falls back to `build_fallback_peer` when
//     mDNS has not announced it;
//   * `build_fallback_peer` is documented as the one constructor that yields
//     `endpoint_id: None`, because `last_address` is a pre-iroh column with no
//     key in it;
//   * `try_sync_with_peer` step 3 returns `false` for a peer with no key,
//     before the "connecting" event and before any `record_failure`.
//
// So the fallback path resolves a peer that can never be dialled, and does it
// silently. `resolve_peer_address` never consults `peer_refs.endpoint_id`, which
// means a peer that IS key-bound — one this device has already synced with and
// TOFU-bound — still cannot be reached from Branch B or Branch C unless mDNS
// announced it in this process's lifetime. Under the old transport
// `last_address` was exactly the mDNS-independent bootstrap for that case.
//
// Making these tests green would mean either weakening them to assert the
// silent skip, or reaching for the mDNS path they were written to avoid.
// Neither is a test-file decision.

/// Give a `peer_refs` row the two things a dial now needs: a cached candidate address
/// **and** a bound key.
///
/// Under the old transport an address was enough — `connect_to_peer` dialled it. Under
/// iroh a dial names a *key*, and addresses are only candidate paths to it, so a row with
/// one and not the other resolves a peer nothing can reach. `resolve_peer_address`
/// therefore requires both, and these branch tests exist to prove the daemon *dispatches*
/// a due peer, which it cannot do for a peer it cannot resolve.
///
/// The key is freshly generated, so nothing is listening on it. That is deliberate: the
/// dial must fail, and it must fail as a recorded failure rather than a silent skip.
async fn seed_unreachable_peer(pool: &sqlx::SqlitePool, peer_id: &str) {
    peer_refs::upsert_peer_ref(pool, peer_id).await.unwrap();
    sqlx::query("UPDATE peer_refs SET last_address = '127.0.0.1:1' WHERE peer_id = ?")
        .bind(peer_id)
        .execute(pool)
        .await
        .unwrap();
    peer_refs::bind_endpoint_id(pool, peer_id, &SecretKey::generate().public().to_string())
        .await
        .unwrap();
}

/// How long a branch test waits for an unreachable peer's failure to be recorded.
///
/// Sized from the bound the dial is actually charged to, not guessed: `try_sync_with_peer`
/// wraps `Endpoint::connect` in `sync_constants::CONNECT_TIMEOUT` (10 s), and a key with
/// nothing listening on it burns the whole budget before failing. 15 s is that plus 50 %
/// for a loaded runner. The previous 3.2 s was sized against a TCP connection refused,
/// which returned in milliseconds — the same number against a different wait.
const BRANCH_DISPATCH_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

/// How long the daemon gets to shut down after a round that dialled an unreachable peer.
///
/// Was 800 ms, and that number was right for the transport it was written against: a TCP
/// connect to a closed port returns `ECONNREFUSED` in microseconds, so a round against a
/// dead peer ended immediately and the shutdown branch of the `select!` was reached at
/// once. QUIC runs over UDP, where a closed port produces **no response at all**, so the
/// dial has nothing to fail fast on and burns its whole `CONNECT_TIMEOUT`. Branch B
/// awaits its `JoinSet` inline (a `KNOWN:` in `daemon_loop`, #490 M3), so shutdown is not
/// observed until that round finishes.
///
/// This is a real change in shutdown latency for a dead peer — 0 ms to up to 10 s — and
/// it is inherent to UDP rather than to anything this port chose. Sized from
/// `CONNECT_TIMEOUT` plus 50 % for a loaded runner, the same way
/// [`BRANCH_DISPATCH_DEADLINE`] is.
///
/// #4031 — READ THIS BEFORE DEBUGGING A TIMEOUT HERE. The 50 % is 5 s of slack over a
/// 10 s worst case, and #4027 added another test riding it. When one of these expires,
/// the message says "shutdown hung"; the far likelier cause is that a contended runner
/// ate the slack while the seeded peer's dial burned the full `CONNECT_TIMEOUT`
/// (`session_supervisor.rs`). Nothing here is worsened per-test and the margin is
/// recorded rather than widened — but "the daemon deadlocked on shutdown" is the wrong
/// first hypothesis, and confirming it costs an afternoon.
const BRANCH_SHUTDOWN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

/// Branch B: A local-change notification triggers the debounced-change path in
/// `daemon_loop`, which resolves paired peers and calls `try_sync_with_peer`. With an
/// unreachable peer the dial fails and the scheduler records a failure.
///
/// Approach: start the daemon with NO peer refs (so Branch C's immediate first tick
/// finds nothing), then insert a peer ref that is resolvable but unreachable (see
/// [`seed_unreachable_peer`]), fire `notify_change()`, and verify a failure is recorded.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_branch_b_local_change_triggers_sync_attempt() {
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
    let endpoint_secret = SecretKey::generate();

    // Start daemon with NO peer refs — Branch C's first tick finds nothing.
    let daemon = SyncDaemon::start(
        pool.clone(),
        "BRANCH_B_DEV".into(),
        mat.clone(),
        scheduler.clone(),
        endpoint_secret,
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
    //
    // #4025: (b) is the load-bearing part, and it is a workaround — this sleep
    // is dodging the permit that `wait_for_debounced_change` loses when Branch
    // C's immediate first tick cancels its debounce window. It is one of the
    // three things #4025's acceptance criterion 3 says to delete when the
    // scheduler is fixed (the others are `wait_for_change_round` and
    // `CHANGE_WAKE_NUDGE`). This is also the suspected cause of this test's
    // known flakiness.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Insert a peer ref with an unreachable last_address (port 1).
    seed_unreachable_peer(&pool, "REMOTE_PEER").await;

    // Trigger Branch B by notifying a local change.
    scheduler.notify_change();

    // Poll until the unreachable peer accumulates a failure, with a
    // 4× cap on the original 800 ms guess so a real hang fails fast.
    {
        let sched = scheduler.clone();
        wait_for(
            move || sched.failure_count("REMOTE_PEER") >= 1,
            BRANCH_DISPATCH_DEADLINE,
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
        BRANCH_SHUTDOWN_DEADLINE,
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
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::with_intervals(
        std::time::Duration::from_millis(100),
        std::time::Duration::from_secs(60),
    ));
    let sink = Arc::new(RecordingEventSink::new());
    let sink_dyn: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let endpoint_secret = SecretKey::generate();

    let daemon = SyncDaemon::start(
        pool.clone(),
        "BRANCH_B_L61_DEV".into(),
        mat.clone(),
        scheduler.clone(),
        endpoint_secret,
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
        seed_unreachable_peer(&pool, peer_id).await;
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
            BRANCH_DISPATCH_DEADLINE,
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
        BRANCH_SHUTDOWN_DEADLINE,
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
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let sink_dyn: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let endpoint_secret = SecretKey::generate();

    // Insert a peer ref that has NEVER synced (synced_at IS NULL → always due)
    // with a last_address so resolve_peer_address can find it.
    seed_unreachable_peer(&pool, "OVERDUE_PEER").await;

    // Start daemon — the first resync tick fires immediately.
    let daemon = SyncDaemon::start(
        pool.clone(),
        "BRANCH_C_DEV".into(),
        mat.clone(),
        scheduler.clone(),
        endpoint_secret,
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
            BRANCH_DISPATCH_DEADLINE,
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
        BRANCH_SHUTDOWN_DEADLINE,
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
///
/// The TXT record carries an `endpoint_id` as well as a `device_id` because
/// `agaric_sync::mdns::parse_service_event` refuses an announcement it cannot dial
/// (#3488) — a record with only a `device_id` resolves to `None`, and every test
/// below that expects a peer would then be asserting on the wrong thing. The key is
/// derived from `device_id` so distinct devices get distinct identities.
fn make_resolved_event(device_id: &str, port: u16) -> mdns_sd::ServiceEvent {
    let mut props = HashMap::new();
    props.insert("device_id".to_string(), device_id.to_string());
    props.insert(
        "endpoint_id".to_string(),
        mdns::test_endpoint_id(device_id).to_string(),
    );

    let info = mdns_sd::ServiceInfo::new(
        mdns::MDNS_SERVICE_TYPE,
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
        mdns::MDNS_SERVICE_TYPE.into(),
        format!("test.{}", mdns::MDNS_SERVICE_TYPE),
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

/// #2008 / #3502: an UNPAIRED discovered peer returns `None` normally but
/// `Some` while a pairing is pending, so Branch A initiates the first session
/// that the responder's admit-while-pending (#1519) is waiting to accept.
///
/// # Why this drives ONE map across both halves
///
/// It used to swap in a fresh `HashMap` for the pending half, commented "use a
/// fresh map so the already-discovered guard doesn't short-circuit." That made
/// the test unable to fail for the reason it names: it asserted the
/// pairing-initiation property against the one configuration in which that
/// property already held, and skipped the configuration production is *always*
/// in by the time the user types the code (the peer is in the map, put there
/// by the pre-code dial that failed the proof check).
///
/// So the map persists across the flip, which is #3502's own "cheaper
/// refutation": drive the event twice against the same map with
/// `pairing_pending` going `false → true`, and require the second call to
/// return `Some`. That is unsatisfiable unless BOTH the caller's
/// `already_discovered` short-circuit is gone AND
/// `should_attempt_sync_with_discovered_peer` orders `pairing_pending` above
/// `already_discovered` — either half alone still returns `None` here.
#[test]
fn process_discovery_unpaired_returns_some_only_while_pairing_pending() {
    let no_refs: Vec<agaric_store::peer_refs::PeerRef> = vec![];
    let mut discovered = HashMap::new();

    // Not pending: unpaired peer is ignored (paired-only steady-state
    // behaviour) — but it IS recorded in the map, which is what sets up the
    // second half.
    let event = make_resolved_event("UNPAIRED_PEER", 8443);
    assert!(
        process_discovery_event(event, "LOCAL", &mut discovered, &no_refs, false).is_none(),
        "unpaired peer must be ignored when no pairing is pending"
    );
    assert!(
        discovered.contains_key("UNPAIRED_PEER"),
        "the peer must be in the discovered map before the pairing window opens — \
         without this the second half proves nothing (#3502)"
    );

    // Pending, SAME map: the already-known unpaired peer becomes a valid
    // initiation target. This is the user typing the code after both devices
    // have already found and rejected each other.
    let event = make_resolved_event("UNPAIRED_PEER", 8443);
    let result = process_discovery_event(event, "LOCAL", &mut discovered, &no_refs, true);
    assert!(
        result.is_some(),
        "an ALREADY-DISCOVERED unpaired peer must trigger sync while pairing is \
         pending (#2008, #3502) — the rediscovery guard must not outrank the window"
    );
    assert_eq!(result.unwrap().device_id, "UNPAIRED_PEER");
    assert_eq!(
        discovered.len(),
        1,
        "the rediscovery must refresh the existing entry, not add a second"
    );
}

// ======================================================================
// #3502 Part 2 — peers_for_change_round (Branch B's pairing-window round)
// ======================================================================

/// Build a `DiscoveredPeer` map entry for the change-round tests.
fn discovered_entry(
    device_id: &str,
) -> (
    String,
    (agaric_sync::mdns::DiscoveredPeer, tokio::time::Instant),
) {
    (
        device_id.to_string(),
        (
            agaric_sync::mdns::DiscoveredPeer {
                device_id: device_id.to_string(),
                endpoint_id: Some(mdns::test_endpoint_id(device_id)),
                addresses: vec![std::net::IpAddr::from([127, 0, 0, 1])],
                port: 8443,
            },
            tokio::time::Instant::now(),
        ),
    )
}

/// Steady state: a discovered but unpaired peer is NOT a target for a
/// debounced local change. Branch B pushes local work to devices we are paired
/// with; outside a pairing window an unpaired peer is not one.
#[tokio::test]
async fn change_round_ignores_unpaired_discovered_peer_when_not_pairing() {
    let no_refs: Vec<PeerRef> = vec![];
    let discovered: HashMap<_, _> = [discovered_entry("UNPAIRED_PEER")].into_iter().collect();

    let round = peers_for_change_round(&no_refs, &discovered, false);

    assert!(
        round.is_empty(),
        "outside a pairing window an unpaired discovered peer must not be dialled \
         by Branch B; got {:?}",
        round.iter().map(|p| &p.device_id).collect::<Vec<_>>()
    );
}

/// #3502 Part 2: the first-ever pair. `peer_refs` is EMPTY — which is why
/// Branch B (and Branch C, same source) could never produce a partner and the
/// whole flow depended on a subsequent mDNS announcement that a quiet network
/// need never send. With the window open, the peer already in the `discovered`
/// map becomes the round.
///
/// This is the branch reached by `confirm_pairing_inner`'s `notify_change()`,
/// the moment the user's typed code lands in the marker.
#[tokio::test]
async fn change_round_dials_discovered_unpaired_peer_while_pairing_pending() {
    let no_refs: Vec<PeerRef> = vec![];
    let discovered: HashMap<_, _> = [discovered_entry("UNPAIRED_PEER")].into_iter().collect();

    let round = peers_for_change_round(&no_refs, &discovered, true);

    assert_eq!(
        round
            .iter()
            .map(|p| p.device_id.as_str())
            .collect::<Vec<_>>(),
        vec!["UNPAIRED_PEER"],
        "#3502: while a pairing is pending, a peer already in the discovered map \
         must be re-attempted on the change wake without waiting for mDNS"
    );
}

/// A peer that is both paired and discovered must appear ONCE, not twice:
/// the pairing tail adds only peers with no `peer_ref`. Two entries would mean
/// two concurrent dials to one device per round — harmless thanks to
/// `try_lock_peer`, but it would burn the second as a lock-contention no-op
/// and make the round's size meaningless.
#[tokio::test]
async fn change_round_does_not_duplicate_a_paired_and_discovered_peer() {
    let refs = vec![make_peer_ref("PEER_A")];
    let discovered: HashMap<_, _> = [discovered_entry("PEER_A"), discovered_entry("PEER_B")]
        .into_iter()
        .collect();

    let round = peers_for_change_round(&refs, &discovered, true);

    assert_eq!(
        round
            .iter()
            .map(|p| p.device_id.as_str())
            .collect::<Vec<_>>(),
        vec!["PEER_A", "PEER_B"],
        "the paired peer must appear exactly once, and the unpaired one must be \
         appended after it in device-id order"
    );
}

// ======================================================================
// #3533 — the same claims, through `daemon_loop` rather than the helper
// ======================================================================
//
// The three tests above call `peers_for_change_round` directly, so they pin
// what the round *should* contain and nothing about who asks for it. Branch B
// is the only production caller, and its `discovered` map used to be a bare
// local written only by Branch A (a real `mdns_rx.recv()`), so no test could
// put a peer where Branch B would look: deleting the call site turned nothing
// red, and #3507's two-device harness does not close the gap either — it drives
// `process_discovery_event` / `try_sync_with_peer` directly and never enters
// `daemon_loop`.
//
// `SyncDaemon::start_with_lifecycle_seeded` hands `daemon_loop` its map, so
// these two drive the real select! loop. The observable is the "connecting"
// progress event `try_sync_with_peer` emits immediately before it dials —
// earlier than the failure it eventually records, and specific to one peer.

/// How often [`wait_for_change_round`] re-arms the local-change wake.
///
/// Part of the #4025 workaround; remove it with that fix.
///
/// Must exceed the scheduler's debounce window (the #3533 daemon tests use
/// 100 ms) or every nudge would restart the window and Branch B would never
/// leave it. 300 ms leaves each wake 200 ms of quiet to complete in.
const CHANGE_WAKE_NUDGE: std::time::Duration = std::time::Duration::from_millis(300);

/// [`wait_for`], re-arming `notify_change()` on a cadence while it polls.
///
/// # This is a WORKAROUND for #4025, not a design
///
/// The re-arm exists only because the production wake path loses permits
/// (#4025). It is not how a test should have to wait for a local change, and
/// #4025's acceptance criterion 3 names this function and
/// [`CHANGE_WAKE_NUDGE`] as the things whose removal proves the fix landed: if
/// the scheduler is repaired and these are still needed, the fix is incomplete.
/// Delete both, and the 300 ms sleep in
/// [`daemon_branch_b_local_change_triggers_sync_attempt`], with that fix.
///
/// # Why a single `notify_change()` is not enough
///
/// `notify_change` stores at most one permit, and `wait_for_debounced_change`
/// *consumes* that permit and then waits out its debounce window. If another
/// `select!` branch becomes ready during that window the debounced future is
/// dropped — and the consumed permit goes with it, because by then it is no
/// longer held by a `Notified` that could hand it back. At daemon startup
/// there is always such a branch: Branch C's resync interval fires its first
/// tick immediately. So a wake fired right after `start` is regularly eaten,
/// which is what the fixed 300 ms sleep in
/// `daemon_branch_b_local_change_triggers_sync_attempt` has been avoiding by
/// luck rather than by construction.
///
/// Re-arming is what production does anyway — every local change notifies —
/// and it removes the race instead of narrowing it. It cannot rescue a Branch B
/// that composes the wrong round: no number of wakes produces a peer the round
/// does not contain.
async fn wait_for_change_round<F>(
    scheduler: &SyncScheduler,
    mut predicate: F,
    timeout: std::time::Duration,
    label: &'static str,
) where
    F: FnMut() -> bool,
{
    let start = std::time::Instant::now();
    loop {
        scheduler.notify_change();
        let nudged = std::time::Instant::now();
        while nudged.elapsed() < CHANGE_WAKE_NUDGE {
            if predicate() {
                return;
            }
            assert!(
                start.elapsed() < timeout,
                "wait_for_change_round({label}) timed out after {timeout:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
}

/// Whether the sink shows a dial being *started* against `peer_id`.
///
/// `try_sync_with_peer` emits this after the backoff gate, the per-peer lock
/// and the pinned-key check, and before `Endpoint::connect` — so it is the
/// first externally visible consequence of a peer being in a round, and it
/// does not wait out a 10 s connect timeout to appear.
fn dial_started(sink: &RecordingEventSink, peer_id: &str) -> bool {
    sink.events().iter().any(|e| {
        matches!(
            e,
            SyncEvent::Progress { state, remote_device_id, .. }
                if state == "connecting" && remote_device_id == peer_id
        )
    })
}

/// #3533 (the wiring #3502 Part 2 left uncovered): with a pairing window open
/// and `peer_refs` EMPTY, Branch B must dial a peer that exists only in
/// `daemon_loop`'s discovered map.
///
/// This is the first-ever-pair shape: the paired-only enumeration produces
/// nothing at all, so the round can only be non-empty if Branch B composes it
/// with `peers_for_change_round(&refs, &discovered, pairing_pending)`. Reverting
/// that call site to the paired-only round reds this test — which is the property
/// #3533 was filed for.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_branch_b_dials_discovered_unpaired_peer_while_pairing_pending_3533() {
    const SEEDED_PEER: &str = "SEEDED_UNPAIRED_3533";

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // Short debounce so Branch B's round starts ~100 ms after the notify.
    let scheduler = Arc::new(SyncScheduler::with_intervals(
        std::time::Duration::from_millis(100),
        std::time::Duration::from_secs(60),
    ));
    let sink = Arc::new(RecordingEventSink::new());
    let sink_dyn: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));

    // The pairing window is open and NO peer is paired — `confirm_pairing`'s
    // state at the moment it calls `notify_change()`.
    peer_refs::set_pending_pairing(&pool, "test-proof")
        .await
        .unwrap();
    let refs = peer_refs::list_peer_refs(&pool).await.unwrap();
    assert!(
        refs.is_empty(),
        "precondition: the paired-only round must be empty, or this test could \
         pass through the ordinary paired path"
    );

    let discovered: DiscoveredPeers = [discovered_entry(SEEDED_PEER)].into_iter().collect();

    let daemon = SyncDaemon::start_with_lifecycle_seeded(
        SyncDaemonContext {
            pool: pool.clone(),
            device_id: "DEV_3533_A".into(),
            materializer: mat.clone().into(),
            scheduler: scheduler.clone(),
            endpoint_secret: SecretKey::generate(),
            event_sink: sink_dyn,
            cancel,
            lifecycle: agaric_sync::foreground::LifecycleHooks::new(),
        },
        discovered,
    )
    .await
    .expect("the seeded daemon must start");

    // The wake both pairing commands end with. Branch C cannot be the thing
    // that dials here: its round is `peers_due_for_resync(&refs)` and `refs` is
    // empty, so Branch B is the only branch that can produce this peer.
    {
        let sink = sink.clone();
        wait_for_change_round(
            &scheduler,
            move || dial_started(&sink, SEEDED_PEER),
            BRANCH_DISPATCH_DEADLINE,
            "branch_b/#3533: connecting event for the seeded unpaired peer",
        )
        .await;
    }

    daemon.shutdown();
    wait_for(
        || {
            daemon
                .handle
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
        },
        BRANCH_SHUTDOWN_DEADLINE,
        "branch_b/#3533: handle.is_finished()",
    )
    .await;
    mat.shutdown();
}

/// The other arm: with NO pairing window open, Branch B must NOT dial a
/// discovered-but-unpaired peer.
///
/// This pins the `is_pending_pairing` read at the wiring site, which the
/// positive test above cannot: a Branch B that passed a hard-coded `true` (or
/// appended the discovered tail unconditionally) would satisfy it.
///
/// The "no dial" is asserted against two barriers rather than a sleep, so it
/// cannot pass by simply out-running the round:
///
/// 1. `PAIRED_MISMATCH` is paired, discovered, and announces a key that is not
///    the one bound to it — so `try_sync_with_peer` records a failure at the
///    pinned-key check, before any dial. That failure proves the round *ran*.
///    The daemon starts backgrounded so that only Branch B could have produced
///    it: Branch C's body short-circuits on `is_backgrounded`, while the
///    event-driven branches are documented as ungated. Without that, a failure
///    recorded by Branch C's immediate first tick would let this test pass with
///    Branch B never running at all.
/// 2. Shutdown then completes only once Branch B's `JoinSet` has joined every
///    task it spawned, so any peer that had been in the round has necessarily
///    reached (and got past) its "connecting" event by the time we assert.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_branch_b_ignores_discovered_unpaired_peer_outside_pairing_window_3533() {
    const SEEDED_PEER: &str = "SEEDED_UNPAIRED_3533_B";
    const PAIRED_MISMATCH: &str = "PAIRED_MISMATCH_3533";

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::with_intervals(
        std::time::Duration::from_millis(100),
        std::time::Duration::from_secs(60),
    ));
    let sink = Arc::new(RecordingEventSink::new());
    let sink_dyn: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));

    // `seed_unreachable_peer` binds a freshly generated key, while
    // `discovered_entry` announces `test_endpoint_id(peer_id)` — two different
    // keys for one device, which is exactly the pinned-identity refusal.
    seed_unreachable_peer(&pool, PAIRED_MISMATCH).await;
    assert!(
        !peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "precondition: no pairing window is open"
    );

    let discovered: DiscoveredPeers = [
        discovered_entry(PAIRED_MISMATCH),
        discovered_entry(SEEDED_PEER),
    ]
    .into_iter()
    .collect();

    let lifecycle = agaric_sync::foreground::LifecycleHooks::new();
    lifecycle.mark_backgrounded();

    let daemon = SyncDaemon::start_with_lifecycle_seeded(
        SyncDaemonContext {
            pool: pool.clone(),
            device_id: "DEV_3533_B".into(),
            materializer: mat.clone().into(),
            scheduler: scheduler.clone(),
            endpoint_secret: SecretKey::generate(),
            event_sink: sink_dyn,
            cancel,
            lifecycle,
        },
        discovered,
    )
    .await
    .expect("the seeded daemon must start");

    // Barrier 1 — a Branch B round ran.
    {
        let sched = scheduler.clone();
        wait_for_change_round(
            &scheduler,
            move || sched.failure_count(PAIRED_MISMATCH) >= 1,
            BRANCH_DISPATCH_DEADLINE,
            "branch_b/#3533: paired peer's pinned-key refusal recorded",
        )
        .await;
    }

    // Barrier 2 — every task the round spawned has been joined.
    daemon.shutdown();
    wait_for(
        || {
            daemon
                .handle
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
        },
        BRANCH_SHUTDOWN_DEADLINE,
        "branch_b/#3533 (negative): handle.is_finished()",
    )
    .await;

    assert!(
        !dial_started(&sink, SEEDED_PEER),
        "outside a pairing window Branch B must not dial a discovered-but-unpaired \
         peer; events were: {:?}",
        sink.events()
    );
    mat.shutdown();
}

// ── conditional daemon startup ──────────────────────────────
//
// `SyncDaemon::start_if_peers_exist` avoids starting mDNS + the QUIC endpoint
// when no paired peers exist. These tests exercise the peer-count helper,
// the pending-pairing wake path (#466), and the dormant/active transition.

/// How long the dormant waiter gets to reach `daemon_loop` after a pair
/// notification.
///
/// Bounded on both sides, and both bounds carry meaning. It must be *large*
/// enough to absorb a loaded runner: the wake itself is a `Notify` permit plus
/// one `should_start_active` query against a temp-file SQLite DB, observed in
/// the low milliseconds. It must be *far below* `SyncDaemon::DORMANT_POLL_INTERVAL`
/// (30 s) or a daemon that only ever transitioned on the periodic poll would
/// also pass, and the notify path — the one `confirm_pairing` depends on, and
/// the one #3852 suspected on Android — would go untested. 5 s is ~1000× the
/// observed cost and 6× under the poll.
const DORMANT_ACTIVATION_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

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
    peer_refs::set_pending_pairing(&pool, "test-proof")
        .await
        .unwrap();

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
    peer_refs::set_pending_pairing(&pool, "test-proof")
        .await
        .unwrap();
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
    peer_refs::set_pending_pairing(&pool, "test-proof")
        .await
        .unwrap();

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
    // mDNS or the QUIC endpoint. We verify this by:
    //   1. spawning `start_if_peers_exist` with an empty peer table,
    //   2. observing that the returned handle is alive (dormant task),
    //   3. shutting down cleanly.
    //
    // If the daemon had started in active mode, it would have bound a
    // random-port QUIC endpoint and attempted mDNS init — both of which
    // are side effects we want to avoid. The dormant task has no such
    // side effects; it just polls `peer_refs`.

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let endpoint_secret = SecretKey::generate();
    let event_sink: Arc<dyn agaric_sync::sync_events::SyncEventSink> =
        Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool,
        "DEV_LOCAL".into(),
        materializer,
        scheduler,
        endpoint_secret,
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
    // The other half of what `activation` means (#3533): a daemon that never
    // left the dormant waiter reads false. Without this arm, a flag that was
    // simply always true would satisfy every "wakes on ..." assertion.
    assert!(
        !daemon.activation.is_active(),
        "with an empty peer table the daemon must NOT enter daemon_loop"
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

    let (pool, _dir) = test_pool().await;

    // Simulate a process that armed pairing and then restarted: the marker
    // survived in the DB, but there are no real peers and no live session.
    peer_refs::set_pending_pairing(&pool, "test-proof")
        .await
        .unwrap();
    assert!(
        peer_refs::is_pending_pairing(&pool).await.unwrap(),
        "precondition: the pending-pairing marker is set before startup"
    );

    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let endpoint_secret = SecretKey::generate();
    let event_sink: Arc<dyn agaric_sync::sync_events::SyncEventSink> =
        Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool.clone(),
        "DEV_LOCAL".into(),
        materializer,
        scheduler,
        endpoint_secret,
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
    assert!(
        !daemon.activation.is_active(),
        "the daemon this boot actually started must be the dormant one — \
         `should_start_active` above says what a fresh call would decide, not \
         which path this instance took"
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
    // full `start` path rather than the dormant waiter. `daemon.activation`
    // states which one ran (#3533): the active path marks it before spawning,
    // the dormant path only after leaving its select!, so with a peer already
    // present it must read `true` the moment `start_if_peers_exist` returns —
    // no wait, and no inference from a sink the environment may or may not
    // populate.

    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_X").await.unwrap();

    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let endpoint_secret = SecretKey::generate();
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn agaric_sync::sync_events::SyncEventSink> = sink.clone();
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool,
        "DEV_LOCAL".into(),
        materializer,
        scheduler,
        endpoint_secret,
        event_sink,
        cancel,
    )
    .await
    .unwrap();

    assert!(
        daemon.activation.is_active(),
        "with a paired peer present, start_if_peers_exist must take the active \
         path — a daemon that parked in the dormant waiter reads false here"
    );

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
    // not succeed in the test environment.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dormant_daemon_wakes_on_pair_notification() {
    // `confirm_pairing_inner` calls `scheduler.notify_change()` after
    // persisting the peer. The dormant waiter selects on that notify
    // and on a periodic poll; the notify path transitions to active
    // much faster than the 30s poll.
    //
    // What this used to assert, and why it could not fail (#3852): it slept
    // 200 ms and then checked only that `shutdown()` completed within 10 s.
    // The dormant `select!` has a `shutdown_notify` branch that returns
    // immediately, so a waiter that NEVER left dormant mode satisfied that
    // just as well as one that transitioned — and the 200 ms sleep was a
    // gamble against the wake rather than a wait for it.
    //
    // It now awaits `daemon.activation` (#3533), which the waiter marks at
    // the point it commits to `daemon_loop`. The deadline is deliberately far
    // below `DORMANT_POLL_INTERVAL` (30 s): if the transition could only
    // happen on the periodic poll, this test would time out, so what passes
    // here is specifically the notify path the pairing commands rely on.

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let endpoint_secret = SecretKey::generate();
    let event_sink: Arc<dyn agaric_sync::sync_events::SyncEventSink> =
        Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool.clone(),
        "DEV_LOCAL".into(),
        materializer,
        scheduler.clone(),
        endpoint_secret,
        event_sink,
        cancel,
    )
    .await
    .unwrap();

    assert!(
        !daemon.activation.is_active(),
        "with an empty peer table the daemon must start dormant — otherwise the \
         wake this test is about has nothing left to prove"
    );

    // Simulate a pair event: insert a peer, then wake the dormant waiter.
    peer_refs::upsert_peer_ref(&pool, "PEER_NEW").await.unwrap();
    scheduler.notify_change();

    let activated = tokio::time::timeout(
        DORMANT_ACTIVATION_DEADLINE,
        daemon.activation.wait_until_active(),
    )
    .await
    .expect(
        "the dormant waiter must transition to active on the pair notification, \
         well inside DORMANT_POLL_INTERVAL",
    );
    assert!(
        activated,
        "wait_until_active resolved without the daemon becoming active"
    );

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

    let (pool, _dir) = test_pool().await;
    peer_refs::upsert_peer_ref(&pool, "PEER_TRANSIENT")
        .await
        .unwrap();

    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let endpoint_secret = SecretKey::generate();
    let event_sink: Arc<dyn agaric_sync::sync_events::SyncEventSink> =
        Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));

    let daemon = SyncDaemon::start_if_peers_exist(
        pool.clone(),
        "DEV_LOCAL".into(),
        materializer,
        scheduler,
        endpoint_secret,
        event_sink,
        cancel,
    )
    .await
    .unwrap();

    // The peer-presence check has to have chosen the ACTIVE path, or "keeps
    // running after the peer is removed" would be a claim about a daemon that
    // never started. `activation` states exactly that and no more (#3533,
    // #4031): `start_seeded` flips it synchronously before `tokio::spawn`, so
    // it is a fact about the branch `start_if_peers_exist` took, readable
    // before the daemon task has been polled once.
    //
    // What it does NOT establish is that `daemon_loop` has been entered — and
    // it replaced a 100 ms sleep whose job was precisely to wait for that, so
    // the peer below is now deleted at an arbitrarily earlier point. That is
    // safe only because `daemon_loop` never re-reads peer presence as a
    // liveness condition: it lists peer refs per sync cycle and proceeds with
    // whatever it gets (`list_peer_refs_or_empty`), so an empty peer table at
    // any point in the loop's life ends nothing. The timeout below is what
    // actually holds up "still alive, shuts down cleanly".
    assert!(
        daemon.activation.is_active(),
        "the daemon must have taken the active path before the peer is deleted"
    );

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
//    clones (covered in `agaric_sync::foreground::tests`; smoke-asserted here
//    too to catch integration drift).
// 2. Full daemon startup — `start_with_lifecycle` completes and the
//    daemon shuts down cleanly regardless of initial foreground state.
//    We cannot wait 30 s for the resync tick in a unit test, but the
//    gate is also exercised by the isolated lifecycle test and by
//    dedicated unit tests in `agaric_sync::foreground` / `coordinator.rs`.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_with_lifecycle_accepts_backgrounded_initial_state() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let endpoint_secret = SecretKey::generate();

    let lifecycle = agaric_sync::foreground::LifecycleHooks::new();
    lifecycle.mark_backgrounded();
    assert!(
        lifecycle.is_backgrounded(),
        "test precondition: hooks must reflect backgrounded state"
    );

    let daemon = SyncDaemon::start_with_lifecycle(SyncDaemonContext {
        pool: pool.clone(),
        device_id: "DEV_LIFECYCLE_A".into(),
        materializer: mat.clone().into(),
        scheduler,
        endpoint_secret,
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
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let endpoint_secret = SecretKey::generate();

    let lifecycle = agaric_sync::foreground::LifecycleHooks::new();
    let daemon = SyncDaemon::start_with_lifecycle(SyncDaemonContext {
        pool: pool.clone(),
        device_id: "DEV_LIFECYCLE_B".into(),
        materializer: mat.clone().into(),
        scheduler,
        endpoint_secret,
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
    let hooks = agaric_sync::foreground::LifecycleHooks::default();
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
    use agaric_core::ulid::BlockId;
    use agaric_store::op::{CreateBlockPayload, OpPayload};
    use agaric_store::op_log::append_local_op_at;
    use agaric_sync::snapshot::create_snapshot;

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
    let resp_space = agaric_store::space::SpaceId::from_trusted("01HZFEAT6SPACEXXXXXXXXXXXX");
    let resp_state = resp_mat.loro_state();
    agaric_engine::merge::engine_apply(
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
    agaric_store::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM op_log")
        .execute(&mut *tx)
        .await
        .unwrap();
    agaric_store::op_log::disable_op_log_mutation_bypass(&mut tx)
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

    // ── Wire the two sides together over a real admitted QUIC session ──
    let harness = ServiceHarness::new().await;
    // The responder resolves the initiator by its authenticated key. The
    // `upsert_peer_ref` above is no longer sufficient on its own: a row with no
    // key bound to it is a row no inbound connection can match.
    peer_refs::bind_endpoint_id(&resp_pool, "FEAT6_INIT", &client_key(&harness))
        .await
        .unwrap();

    let server_task = spawn_responder(
        &harness,
        resp_pool.clone(),
        "FEAT6_RESP",
        resp_mat.clone(),
        resp_scheduler.clone(),
        resp_sink.clone(),
        Arc::new(AtomicBool::new(false)),
    );
    let mut client = harness.dial().await;

    // Initiator side: we drive a minimal client manually through the
    // wire protocol to exercise the same code path as
    // `run_sync_session` without the full daemon scaffolding.
    //
    // #602/#2502: the initiator advertises its own device at seq 0 (it has no
    // local ops — its DB is empty) plus a STALE op-log claim on the responder's
    // history at seq 1 (for the covering check). The head no longer doubles as
    // peer identification: that comes from the handshake now, which is why the
    // key binding above had to be written. #2502 retired the op-log-seq reset lookup: the
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
        let mut craft = agaric_engine::loro::engine::LoroEngine::with_peer_id("FEAT6_RESP")
            .expect("craft engine");
        for i in 0..5_i64 {
            craft
                .apply_create_block(&format!("01HZFEAT6CRAFT{i:012}"), "content", "x", None, i)
                .expect("craft op");
        }
        craft.version_vector()
    };
    send_sync_message(
        &mut client.send,
        &SyncMessage::HeadExchange {
            heads: vec![init_self_head, stale_resp_head],
            loro_vvs: vec![agaric_sync::sync_protocol::types::SpaceVersionVector {
                space_id: resp_space.clone(),
                vv: crafted_resp_vv,
            }],
            engine_format_version: agaric_engine::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            op_log_batch_chunked: false,
            pairing_proof: None,
            device_name: None,
        },
    )
    .await
    .unwrap();

    // Responder must reply with ResetRequired.
    let reset = recv_sync_message(&mut client.recv).await.unwrap();
    match reset {
        SyncMessage::ResetRequired { .. } => {}
        other => panic!("expected ResetRequired, got {other:?}"),
    }

    // Now emulate what `run_sync_session` does after seeing ResetRequired: run
    // the initiator-side catch-up helper. We use the public helper directly so
    // the test does not depend on the mDNS / daemon scaffolding; the wiring in
    // `run_sync_session` is covered by the shorter sub-flow tests in the
    // snapshot_transfer module.
    // #2503: the responder now streams a Loro snapshot (engine truth); the
    // initiator MERGES it into its own engine and reprojects SQL. Thread the
    // initiator's live registry so `apply_remote` has an engine to merge into.
    let init_state = init_mat.loro_state();
    let outcome = agaric_sync::sync_daemon::snapshot_transfer::try_receive_snapshot_catchup(
        &mut client.send,
        &mut client.recv,
        &init_pool,
        &init_mat,
        &init_sink,
        "FEAT6_RESP",
        None,
        Some(
            agaric_sync::sync_daemon::snapshot_transfer::EngineReloadCtx {
                registry: &init_state.registry,
                device_id: "FEAT6_INIT",
            },
        ),
    )
    .await
    .expect("catch-up must succeed end-to-end");

    assert!(
        matches!(
            outcome,
            agaric_sync::sync_daemon::snapshot_transfer::CatchupOutcome::Applied { .. }
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
        let space = agaric_store::space::SpaceId::from_trusted("01HZFEAT6SPACEXXXXXXXXXXXX");
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
    initiator: &mut agaric_sync::sync_protocol::SyncOrchestrator,
    responder: &mut agaric_sync::sync_protocol::SyncOrchestrator,
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
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    space: &agaric_store::space::SpaceId,
    block_id: &str,
    content: &str,
    ts: i64,
) {
    use agaric_store::op::{CreateBlockPayload, OpPayload};
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: agaric_core::ulid::BlockId::from_trusted(block_id),
        block_type: "content".into(),
        parent_id: None,
        position: Some(1),
        index: None,
        content: content.into(),
    });
    let record = agaric_store::op_log::append_local_op_at(pool, device_id, payload.clone(), ts)
        .await
        .expect("append_local_op_at");
    mat.dispatch_op(&record).await.expect("dispatch_op");
    mat.flush_foreground().await.expect("flush_foreground");
    agaric_engine::merge::engine_apply(
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
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    space: &agaric_store::space::SpaceId,
    payload: agaric_store::op::OpPayload,
    ts: i64,
) {
    let record = agaric_store::op_log::append_local_op_at(pool, device_id, payload.clone(), ts)
        .await
        .expect("append_local_op_at");
    mat.dispatch_op(&record).await.expect("dispatch_op");
    mat.flush_foreground().await.expect("flush_foreground");
    agaric_engine::merge::engine_apply(
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
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV602A";
    const DEV_B: &str = "DEV602B";
    const BLOCK_A: &str = "01HZ602BLKAXXXXXXXXXXXXXXX";
    const BLOCK_B: &str = "01HZ602BLKBXXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ602SPACEXXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    // #602 test seam: one Loro registry per device. Each `Materializer`
    // owns its own `Arc<LoroState>` (#2249: an explicitly threaded value,
    // not a process global), so cloning the `Arc` keeps the two devices'
    // engine state independent.
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
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV2536A";
    const DEV_B: &str = "DEV2536B";
    const BLOCK_PERSONAL: &str = "01HZ2536BLKPERSONALXXXXXXX";
    const BLOCK_WORK: &str = "01HZ2536BLKWORKXXXXXXXXXXX";
    let space_personal = agaric_store::space::SpaceId::from_trusted("01HZ2536SPACEPERSONALXXXXX");
    let space_work = agaric_store::space::SpaceId::from_trusted("01HZ2536SPACEWORKXXXXXXXXX");

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
    use agaric_sync::sync_protocol::{SyncMessage, SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV2536IA";
    const DEV_B: &str = "DEV2536IB";
    const BLOCK_PERSONAL: &str = "01HZ2536IBLKPERSONALXXXXXX";
    const BLOCK_WORK: &str = "01HZ2536IBLKWORKXXXXXXXXXX";
    let space_personal = agaric_store::space::SpaceId::from_trusted("01HZ2536ISPACEPERSONALXXXX");
    let space_work = agaric_store::space::SpaceId::from_trusted("01HZ2536ISPACEWORKXXXXXXXX");

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
// #2129 — two-instance convergence over a REAL loopback QUIC socket
// ======================================================================

/// #2129: drive ONE full sync session — initiator → responder — over a genuine
/// loopback QUIC connection.
///
/// This is the real-transport analog of #602's in-memory
/// `pump_full_session_602`. Where that helper hand-pumps two orchestrators
/// through an in-process `VecDeque` (no socket, no handshake, no framing), this
/// stands up a real `SyncService` and a real dialling endpoint, runs the
/// production responder (`handle_incoming_sync`, over an `InboundSession` the
/// service's own admission path produced) and the production initiator
/// (`run_sync_session`) against each other, and drives the initiator to
/// completion. Every message therefore rides the length-prefixed QUIC framing in
/// `transport::session`.
///
/// Both orchestrators carry a PER-DEVICE `LoroState` (the #602 two-registry test
/// seam), which is required because one process-global registry cannot represent
/// two distinct devices in one test process.
///
/// # Why the key is bound here and not once per device
///
/// The old helper took one STABLE identity cert per device, because the
/// responder pinned its hash on first connection and a fresh cert per session
/// would have tripped "certificate hash mismatch" on the second. The equivalent
/// stable thing here would be a per-device `SecretKey` threaded into a
/// per-device endpoint, but `ServiceHarness` mints its own — so instead each
/// session binds the dialling key to the initiator's `peer_refs` row before it
/// dials. `bind_endpoint_id` is `ON CONFLICT(peer_id) DO UPDATE`, so re-binding
/// the same peer to a new key preserves its `last_hash` / `synced_at` /
/// `reset_count`, which is what these multi-session convergence tests depend on.
/// It refuses only the other direction — one key pointed at two peers — which
/// two freshly generated keys never hit.
///
/// Returns the initiator orchestrator's terminal `SyncState` so the caller can
/// assert it reached `Complete` (NOT `ResetRequired` — i.e. no snapshot fallback
/// was taken; this is an incremental-reachable session).
async fn run_one_real_loopback_session_2129(
    init_pool: &SqlitePool,
    init_mat: &Materializer,
    init_device: &str,
    resp_pool: &SqlitePool,
    resp_mat: &Materializer,
    resp_device: &str,
) -> agaric_sync::sync_protocol::SyncState {
    use agaric_sync::sync_protocol::SyncOrchestrator;

    let timeout = std::time::Duration::from_secs(20);

    let harness = ServiceHarness::new().await;
    // The responder resolves its peer from the handshake-authenticated key, so
    // the initiator's key has to be bound to its device id before it dials.
    bind_client_as(resp_pool, init_device, &harness).await;

    let resp_handle = spawn_responder(
        &harness,
        resp_pool.clone(),
        resp_device,
        resp_mat.clone(),
        Arc::new(SyncScheduler::new()),
        Arc::new(RecordingEventSink::new()),
        Arc::new(AtomicBool::new(false)),
    );

    // The initiator dials; its first `HeadExchange` is what completes the
    // responder's `establish`.
    let mut client = harness.dial().await;

    let mut init_orch =
        SyncOrchestrator::new(init_pool.clone(), init_device.into(), init_mat.clone())
            .with_expected_remote_id(resp_device.into());
    let init_cancel = AtomicBool::new(false);
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let init_run_host: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(init_mat.clone());
    let init_result = tokio::time::timeout(
        timeout,
        run_sync_session(
            &mut init_orch,
            &mut client.send,
            &mut client.recv,
            &client.conn,
            &init_cancel,
            init_pool,
            &init_run_host,
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
    use agaric_sync::sync_protocol::SyncState;

    let space = agaric_store::space::SpaceId::from_trusted("01HZ2481REPLSPACEXXXXXXXXX");
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
    let a_head = agaric_sync::sync_protocol::get_local_heads(&a.pool)
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
        &b.pool, &b.mat, &b.id, // init = B (puller)
        &a.pool, &a.mat, &a.id, // resp = A (streamer)
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

/// #2593 (acceptance) — a single op record whose payload exceeds the inline
/// frame cap (a sync-applied/imported op carrying a large block `content`,
/// bypassing the command-layer 256 KiB cap) replicates as an audit record over
/// a REAL socket via the chunked `OpLogBatchChunked` transport, and the session
/// completes. Before #2593 the streamer skipped such a record (no chunked
/// OpLogBatch transport), silently losing its cross-device History entry.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2593_oversized_op_record_replicates_chunked_over_real_socket() {
    use agaric_sync::sync_protocol::SyncState;

    let devices = make_n_devices_2141(&["DEV2593AA", "DEV2593BB"]).await;
    let (a, b) = (&devices[0], &devices[1]);

    // A holds an op whose serialised payload exceeds OP_LOG_BATCH_INLINE_MAX_BYTES
    // (~11 MB content > the 10 MB inline frame cap). `append_local_op_at`
    // bypasses the command-layer 256 KiB content cap — modelling a
    // sync-applied/imported op — and computes the correct blake3 hash.
    let big_content = "z".repeat(11_000_000);
    let payload = agaric_store::op::OpPayload::CreateBlock(agaric_store::op::CreateBlockPayload {
        block_id: agaric_core::ulid::BlockId::test_id("BIG2593"),
        block_type: "content".into(),
        parent_id: None,
        position: Some(0),
        index: None,
        content: big_content.clone(),
    });
    agaric_store::op_log::append_local_op_at(&a.pool, &a.id, payload, 1_736_942_400_000)
        .await
        .expect("append oversized op to A");

    let a_head = agaric_sync::sync_protocol::get_local_heads(&a.pool)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.device_id == a.id)
        .expect("A has an op head for its own device");

    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(&a.id)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(before, 0, "B starts without any of A's ops");

    // B pulls from A over a real TLS socket: B initiator (puller), A streamer.
    let init_state = run_one_real_loopback_session_2129(
        &b.pool, &b.mat, &b.id, // init = B (puller)
        &a.pool, &a.mat, &a.id, // resp = A (streamer)
    )
    .await;
    assert_eq!(
        init_state,
        SyncState::Complete,
        "the pull completes despite the oversized (chunked) audit record"
    );

    // A's oversized op replicated into B as audit metadata, full payload intact.
    let rows: Vec<(String, i64, String, i64, String)> = sqlx::query_as(
        "SELECT device_id, seq, hash, is_replicated, payload FROM op_log \
         WHERE device_id = ? ORDER BY seq",
    )
    .bind(&a.id)
    .fetch_all(&b.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "A's oversized op replicated into B");
    let (device_id, seq, hash, is_replicated, stored_payload) = &rows[0];
    assert_eq!(device_id, &a.id);
    assert_eq!(*seq, a_head.seq);
    assert_eq!(hash, &a_head.hash, "hash stored verbatim (blake3-verified)");
    assert_eq!(
        *is_replicated, 1,
        "stored audit-only (never applied to state)"
    );
    assert!(
        stored_payload.len() > agaric_sync::sync_constants::OP_LOG_BATCH_INLINE_MAX_BYTES,
        "the full oversized payload replicated (chunked transport), not truncated"
    );
    assert!(
        stored_payload.contains(&big_content),
        "the block content survived the chunked round-trip intact"
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
    use agaric_sync::sync_protocol::SyncState;

    let space = agaric_store::space::SpaceId::from_trusted("01HZ2481HEALSPACEXXXXXXXXX");
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

    let a_head = agaric_sync::sync_protocol::get_local_heads(&a.pool)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.device_id == a.id)
        .expect("A authored an op");

    // Session 1: B pulls from A → B now holds A's op as an audit record.
    let s1 = run_one_real_loopback_session_2129(
        &b.pool, &b.mat, &b.id, // init = B (puller)
        &a.pool, &a.mat, &a.id, // resp = A (streamer)
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
    agaric_store::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM op_log WHERE device_id = ?")
        .bind(&a.id)
        .execute(&mut *tx)
        .await
        .unwrap();
    agaric_store::op_log::disable_op_log_mutation_bypass(&mut tx)
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
        &a.pool, &a.mat, &a.id, // init = A (puller)
        &b.pool, &b.mat, &b.id, // resp = B (streamer)
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
    use agaric_store::op::{
        AddTagPayload, CreateBlockPayload, DeleteBlockPayload, OpPayload, SetPropertyPayload,
    };
    use agaric_sync::sync_protocol::SyncState;

    const DEV_A: &str = "DEV2129A";
    const DEV_B: &str = "DEV2129B";
    // Device A's blocks: a content block (kept), a property carrier, and
    // a second block that A soft-deletes.
    const BLOCK_A: &str = "01HZ2129BLKAXXXXXXXXXXXXXX";
    const BLOCK_A_DEL: &str = "01HZ2129BLKADELXXXXXXXXXX";
    // Device B's blocks: a content block plus a tag block it links.
    const BLOCK_B: &str = "01HZ2129BLKBXXXXXXXXXXXXXX";
    const TAG_B: &str = "01HZ2129TAGBXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ2129SPACEXXXXXXXXXXXXX");

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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_A),
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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_A_DEL),
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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_A_DEL),
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
            block_id: agaric_core::ulid::BlockId::from_trusted(TAG_B),
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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_B),
            tag_id: agaric_core::ulid::BlockId::from_trusted(TAG_B),
        }),
        1_736_942_401_200,
    )
    .await;

    // ── Session 1: A initiates, B responds (B's state flows to A) ────
    let state1 =
        run_one_real_loopback_session_2129(&pool_a, &mat_a, DEV_A, &pool_b, &mat_b, DEV_B).await;
    assert_eq!(
        state1,
        SyncState::Complete,
        "#2129 session 1 must complete incrementally over the real socket \
         (ResetRequired would mean a snapshot fallback was taken — this is \
         an incremental-reachable session)"
    );

    // ── Session 2: B initiates, A responds (A's state flows to B) ────
    let state2 =
        run_one_real_loopback_session_2129(&pool_b, &mat_b, DEV_B, &pool_a, &mat_a, DEV_A).await;
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
    let state3 =
        run_one_real_loopback_session_2129(&pool_a, &mat_a, DEV_A, &pool_b, &mat_b, DEV_B).await;
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
    use agaric_store::op::{
        DeleteBlockPayload, MoveBlockPayload, OpPayload, PurgeBlockPayload, RestoreBlockPayload,
    };
    use agaric_sync::sync_protocol::SyncState;

    const DEV_A: &str = "DEV2129MA";
    const DEV_B: &str = "DEV2129MB";
    // Parent container, child-to-move, restore-target, purge-target.
    const BLOCK_P: &str = "01HZ21290000000000000000PP";
    const BLOCK_C: &str = "01HZ21290000000000000000CC";
    const BLOCK_D: &str = "01HZ21290000000000000000DD";
    const BLOCK_E: &str = "01HZ21290000000000000000EE";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ2129MOVESPACEXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());

    // #602 test seam: one leaked Loro registry per device.
    let state_a = std::sync::Arc::clone(mat_a.loro_state());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

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
    let s =
        run_one_real_loopback_session_2129(&pool_a, &mat_a, DEV_A, &pool_b, &mat_b, DEV_B).await;
    assert_eq!(
        s,
        SyncState::Complete,
        "#2129 mvp: base sync A->B must complete"
    );
    let s =
        run_one_real_loopback_session_2129(&pool_b, &mat_b, DEV_B, &pool_a, &mat_a, DEV_A).await;
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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_C),
            new_parent_id: Some(agaric_core::ulid::BlockId::from_trusted(BLOCK_P)),
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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_D),
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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_D),
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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_E),
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
            block_id: agaric_core::ulid::BlockId::from_trusted(BLOCK_E),
        }),
        ts,
    )
    .await;

    // ── Final bidirectional sync ─────────────────────────────────────────
    let s =
        run_one_real_loopback_session_2129(&pool_a, &mat_a, DEV_A, &pool_b, &mat_b, DEV_B).await;
    assert_eq!(
        s,
        SyncState::Complete,
        "#2129 mvp: final sync A->B must complete"
    );
    let s =
        run_one_real_loopback_session_2129(&pool_b, &mat_b, DEV_B, &pool_a, &mat_a, DEV_A).await;
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
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV2006A";
    const DEV_B: &str = "DEV2006B";
    const BLOCK_SHARED: &str = "01HZ2006BLKXXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ2006SPACEXXXXXXXXXXXXX");

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
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV2006IRA";
    const DEV_B: &str = "DEV2006IRB";
    const BLOCK_A: &str = "01HZ2006IRBLKAXXXXXXXXXXXX";
    const BLOCK_B: &str = "01HZ2006IRBLKBXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ2006IRSPACEXXXXXXXXXXX");

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
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV610A";
    const DEV_B: &str = "DEV610B";
    const BLOCK_B: &str = "01HZ610BLKBXXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ610SPACEXXXXXXXXXXXXXX");

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
    let scheduler = agaric_sync::sync_scheduler::SyncScheduler::default();
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

/// #4084 — a responder-only device records its progress in `streamed_at`,
/// and #610's `synced_at` rule survives intact.
///
/// The sibling of `issue610_only_the_puller_records_synced_at`, and the same
/// session shape. Before this, #610's rule had an unintended consequence: a
/// session is one-directional, `synced_at`/`last_hash` are written by the
/// puller and `last_address` by the initiator, so a device that only ever
/// succeeds as RESPONDER wrote no progress at all. Its row was
/// indistinguishable from a peer it had never synced with — the device list
/// said "never synced" about a peer it was demonstrably syncing with, every
/// 30 s.
///
/// The fix records the stream in its own column. This pins all three halves of
/// that being correct:
///   * the responder stamps `streamed_at` (the bookkeeping gap is closed),
///   * the responder still does NOT advance `synced_at` (#610's rule holds —
///     this is the assertion that would catch a "just stamp synced_at" fix),
///   * the scheduler still finds the initiator due from the responder's side
///     (a `streamed_at`-aware scheduler would be #610's starvation under a new
///     column name).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue4084_responder_only_device_records_streamed_at() {
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV4084A";
    const DEV_B: &str = "DEV4084B";
    const BLOCK_B: &str = "01HZ4084BLKBXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ4084SPACEXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());
    let state_b = std::sync::Arc::clone(mat_b.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Only B has state, so A pulls and B streams — the responder-only shape.
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

    let before_ms = agaric_store::db::now_ms();

    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_expected_remote_id(DEV_A.into());
    pump_full_session_602(&mut init_a, &mut resp_b).await;

    assert_eq!(init_a.session().state, SyncState::Complete);
    assert_eq!(resp_b.session().state, SyncState::Complete);

    let after_ms = agaric_store::db::now_ms();

    // ── Responder B: streamed to A, pulled nothing ──────────────────
    let b_view_of_a = peer_refs::get_peer_ref(&pool_b, DEV_A)
        .await
        .unwrap()
        .expect("B's peer row for A must exist");
    let streamed = b_view_of_a.streamed_at.expect(
        "#4084: the responder must record streamed_at — without it a \
         responder-only device writes no progress at all and reads as \
         'never synced' forever",
    );
    assert!(
        (before_ms..=after_ms).contains(&streamed),
        "streamed_at must be stamped during this session: {streamed} not in \
         {before_ms}..={after_ms}"
    );
    assert!(
        b_view_of_a.synced_at.is_none(),
        "#610 still holds: the streamer must NOT advance synced_at. Stamping it \
         here would starve the reverse direction, which is exactly why #4084 \
         needed a separate column"
    );

    // ── Initiator A: pulled from B, streamed nothing ────────────────
    let a_view_of_b = peer_refs::get_peer_ref(&pool_a, DEV_B)
        .await
        .unwrap()
        .expect("A's peer row for B must exist");
    assert!(
        a_view_of_b.synced_at.is_some(),
        "#610: the puller records synced_at"
    );
    assert!(
        a_view_of_b.streamed_at.is_none(),
        "the puller streamed nothing this session, so streamed_at stays NULL — \
         the two columns record two different directions, not one event twice"
    );

    // ── The scheduler must be unmoved by streamed_at ────────────────
    let scheduler = agaric_sync::sync_scheduler::SyncScheduler::default();
    let b_peers = peer_refs::list_peer_refs(&pool_b).await.unwrap();
    assert!(
        scheduler
            .peers_due_for_resync(&b_peers)
            .iter()
            .any(|p| p == DEV_A),
        "#4084/#610: a fresh streamed_at must NOT suppress B's own resync toward \
         A. Under sustained one-way activity A refreshes B's streamed_at every \
         tick, so a streamed_at-aware scheduler would never find A overdue — \
         #610's starvation wearing a new column name"
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
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV610EA";
    const DEV_B: &str = "DEV610EB";
    const BLOCK_A: &str = "01HZ610EBLKAXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ610ESPACEXXXXXXXXXXXXX");

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

/// #4096 — the empty-stream short-circuit is a real session, and it records
/// the bookkeeping a real session owes.
///
/// Same shape as `issue610_empty_registry_initiator_records_via_synccomplete`
/// (B's registry is empty, so B replies `SyncComplete` straight out of
/// `head_exchange_outgoing_loro` without ever entering `StreamingOps`), but
/// asserted from **B's** side, which that test only ever checked a negative on.
///
/// The short-circuit returns *before* `streamed_to_peer = true` and before the
/// `SyncComplete`-receive arm that carries every other completion's
/// bookkeeping, so it used to record nothing whatsoever: no `streamed_at`, no
/// `synced_at`, no `loro_vv_bytes`. A device whose sessions all take this
/// branch — a fresh install, or one whose spaces the #1257 freshness gate keeps
/// refusing — completed session after session while its `peer_refs` row stayed
/// as blank as a peer it had never met.
///
/// Which column it writes is the substance, not a detail:
///   * `streamed_at` — this is the responder half; the peer pulled from us,
///     and got zero bytes, but it pulled.
///   * NOT `synced_at` — we received no state at all, and `synced_at` is the
///     scheduler's only staleness input (`peers_due_for_resync`). A responder
///     stamping it on every inbound session never finds the initiator overdue:
///     #610's starvation, re-entered through the short-circuit.
/// The negative assertion is the load-bearing one — a "just stamp synced_at"
/// fix passes every positive check below and re-opens #610.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue4096_empty_stream_short_circuit_records_streamed_at() {
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const DEV_A: &str = "DEV4096A";
    const DEV_B: &str = "DEV4096B";
    const BLOCK_A: &str = "01HZ4096BLKAXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ4096SPACEXXXXXXXXXXXXX");

    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());
    let state_a = std::sync::Arc::clone(mat_a.loro_state());

    peer_refs::upsert_peer_ref(&pool_a, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&pool_b, DEV_A).await.unwrap();

    // Only A has state. B's Loro registry stays EMPTY and B's op_log holds no
    // audit records either, so B takes the `messages.is_empty() &&
    // op_batches.is_empty()` short-circuit — the path under test.
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

    let before_ms = agaric_store::db::now_ms();

    let mut init_a = SyncOrchestrator::new(pool_a.clone(), DEV_A.into(), mat_a.clone())
        .with_expected_remote_id(DEV_B.into());
    let mut resp_b = SyncOrchestrator::new(pool_b.clone(), DEV_B.into(), mat_b.clone())
        .with_expected_remote_id(DEV_A.into());
    pump_full_session_602(&mut init_a, &mut resp_b).await;

    assert_eq!(
        resp_b.session().state,
        SyncState::Complete,
        "the empty-registry responder must complete via the short-circuit — \
         without a completed session there is no bookkeeping question to answer"
    );
    assert_eq!(init_a.session().state, SyncState::Complete);
    assert_eq!(
        init_a.session().ops_received,
        0,
        "the short-circuit must have shipped nothing: this is the EMPTY-stream \
         path, not a one-message stream"
    );

    let after_ms = agaric_store::db::now_ms();

    let b_view_of_a = peer_refs::get_peer_ref(&pool_b, DEV_A)
        .await
        .unwrap()
        .expect("B's peer row for A must exist");

    // ── What it must record ─────────────────────────────────────────
    let streamed = b_view_of_a.streamed_at.expect(
        "#4096: the empty-stream short-circuit completes a session, so it must \
         record one. Before the fix it returned before `streamed_to_peer = true` \
         and before the SyncComplete arm, leaving peer_refs completely untouched \
         — a device whose every session takes this branch reads as 'never \
         synced' forever",
    );
    assert!(
        (before_ms..=after_ms).contains(&streamed),
        "streamed_at must be stamped during THIS session, not inherited from an \
         earlier one: {streamed} not in {before_ms}..={after_ms}"
    );
    assert!(
        peer_refs::get_loro_vv_bytes(&pool_b, DEV_A)
            .await
            .unwrap()
            .is_some(),
        "#4096/#2502: the session completed, so the frontier A advertised in its \
         HeadExchange is a valid export floor for next time. Dropping it on this \
         branch is what leaves the short-circuit re-deriving from nothing"
    );

    // ── What it must NOT record ─────────────────────────────────────
    assert!(
        b_view_of_a.synced_at.is_none(),
        "#4096/#610: B pulled NOTHING this session — it only answered. Stamping \
         synced_at here is not a display change, it is a scheduling change: \
         `peers_due_for_resync` reads synced_at and only synced_at, so a \
         responder refreshing it every inbound session never finds the initiator \
         overdue. That is #610's starvation, re-entered through the short-circuit"
    );
    assert!(
        b_view_of_a.last_hash.is_none(),
        "last_hash is the pulled frontier and B pulled nothing; writing it would \
         mean recording the pull that did not happen"
    );

    // ── And the scheduler must be unmoved by the new stamp ──────────
    let scheduler = agaric_sync::sync_scheduler::SyncScheduler::default();
    let b_peers = peer_refs::list_peer_refs(&pool_b).await.unwrap();
    assert!(
        scheduler
            .peers_due_for_resync(&b_peers)
            .iter()
            .any(|p| p == DEV_A),
        "#4096/#4084: a fresh streamed_at must not suppress B's own pull toward \
         A — the reverse direction is exactly how A's edits reach B"
    );

    // ── The initiator's own halves stay where #610 put them ─────────
    let a_view_of_b = peer_refs::get_peer_ref(&pool_a, DEV_B)
        .await
        .unwrap()
        .expect("A's peer row for B must exist");
    assert!(
        a_view_of_b.synced_at.is_some(),
        "#610: A pulled (an empty state is still a state), so A records synced_at"
    );
    assert!(
        a_view_of_b.streamed_at.is_none(),
        "A streamed nothing — the two columns record two directions, not one \
         event twice"
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
    use agaric_sync::sync_protocol::SyncOrchestrator;
    use agaric_sync::sync_protocol::loro_sync_types::LoroSyncMessage;
    use agaric_sync::sync_protocol::types::{DeviceHead, SpaceVersionVector};

    const DEV_A: &str = "DEVVVA";
    const DEV_B: &str = "DEVVVB";
    const BLOCK_A: &str = "01HZVVBLKAXXXXXXXXXXXXXXXX";
    const BLOCK_B: &str = "01HZVVBLKBXXXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZVVSPACEXXXXXXXXXXXXXXX");

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
            engine_format_version: agaric_engine::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            op_log_batch_chunked: false,
            pairing_proof: None,
            device_name: None,
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
            let outcome = agaric_sync::sync_protocol::loro_sync::apply_remote(
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
                    agaric_sync::sync_protocol::loro_sync::ApplyOutcome::Imported { .. }
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
            engine_format_version: agaric_engine::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            op_log_batch_chunked: false,
            pairing_proof: None,
            device_name: None,
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
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState};

    const RESP_DEV: &str = "RESP778";
    const FRESH_DEV: &str = "FRESH778";
    const BLOCK: &str = "01HZ778BLKXXXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ778SPACEXXXXXXXXXXXXXX");

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
    let harness = ServiceHarness::new().await;
    // Production shape: the handshake-authenticated key identifies the fresh
    // initiator, because its heads cannot — they are empty. This is the same
    // role the verified client-cert CN used to play, on a key the peer cannot
    // choose for itself.
    peer_refs::bind_endpoint_id(&resp_pool, FRESH_DEV, &client_key(&harness))
        .await
        .unwrap();

    let server_task = spawn_responder(
        &harness,
        resp_pool.clone(),
        RESP_DEV,
        resp_mat.clone(),
        resp_scheduler.clone(),
        resp_sink.clone(),
        Arc::new(AtomicBool::new(false)),
    );
    let mut client = harness.dial().await;

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
    send_sync_message(&mut client.send, &first).await.unwrap();

    while !init_orch.is_terminal() {
        let incoming = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            recv_sync_message(&mut client.recv),
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
            send_sync_message(&mut client.send, &resp).await.unwrap();
            while let Some(m) = init_orch.next_message() {
                send_sync_message(&mut client.send, &m).await.unwrap();
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
    // `finish` and not `conn.close`, for the reason `finish_session` documents:
    // closing would discard our own final frame before the peer read it.
    client
        .send
        .finish()
        .expect("the initiator finishes its stream");
    let resp_result = tokio::time::timeout(std::time::Duration::from_secs(20), server_task)
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

    // ── the responder identified the session by the peer's key, not by its
    //    heads (which were empty), so the peer row is the one that key is
    //    bound to. ────────────────────────────────────────────────────────
    let peer = peer_refs::get_peer_ref(&resp_pool, FRESH_DEV)
        .await
        .unwrap()
        .expect("peer_refs row for the fresh device must exist on the responder");
    assert_eq!(
        peer.endpoint_id.as_deref(),
        Some(client_key(&harness).as_str()),
        "#778: the session must have been resolved through the bound key"
    );
    // #610: the responder STREAMED its seeded block to the fresh initiator
    // and pulled nothing back, so it must NOT advance synced_at for that
    // peer — only the puller (here the initiator) records synced_at.
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
/// session through the REAL `handle_incoming_sync` responder over a
/// QUIC pair (so the production send path runs — since #3464 an
/// over-threshold payload rides one frame rather than the retired
/// chunked encoding), pumps the initiator via the same helpers
/// `run_sync_session` uses, and asserts the session completes and the
/// 4 MB block lands in the initiator's DB byte-for-byte.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue611_oversized_loro_snapshot_syncs_via_chunked_wire_path() {
    use agaric_sync::sync_constants::LORO_INLINE_MAX_BYTES;
    use agaric_sync::sync_protocol::{SyncOrchestrator, SyncState, loro_sync};

    const RESP_DEV: &str = "RESP611";
    const INIT_DEV: &str = "INIT611";
    const BLOCK: &str = "01HZ611BLKXXXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ611SPACEXXXXXXXXXXXXXX");

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
        agaric_sync::sync_protocol::loro_sync_types::LoroSyncMessage::Snapshot {
            bytes, ..
        } => bytes.len(),
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
    let harness = ServiceHarness::new().await;
    peer_refs::bind_endpoint_id(&resp_pool, INIT_DEV, &client_key(&harness))
        .await
        .unwrap();

    let server_task = spawn_responder(
        &harness,
        resp_pool.clone(),
        RESP_DEV,
        resp_mat.clone(),
        resp_scheduler.clone(),
        resp_sink.clone(),
        Arc::new(AtomicBool::new(false)),
    );
    let mut client = harness.dial().await;

    // ── Drive the initiator through the SAME framing helpers
    //    `run_sync_session` uses ───────────────────────────────────────
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(init_sink.clone()));
    let mut init_orch = SyncOrchestrator::new(init_pool.clone(), INIT_DEV.into(), init_mat.clone())
        .with_event_sink(init_sink_box)
        .with_expected_remote_id(RESP_DEV.into());

    let first = init_orch.start().await.expect("initiator start");
    send_sync_message(&mut client.send, &first).await.unwrap();

    while !init_orch.is_terminal() {
        let incoming = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            recv_sync_message(&mut client.recv),
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
            send_sync_message(&mut client.send, &resp).await.unwrap();
            while let Some(m) = init_orch.next_message() {
                send_sync_message(&mut client.send, &m).await.unwrap();
            }
        }
    }

    assert_eq!(
        init_orch.session().state,
        SyncState::Complete,
        "#611: the initiator must complete a session whose LoroSync \
         payload exceeds the old inline cap"
    );

    // Finish the client's stream to end the responder's post-Complete
    // file-transfer phase (non-fatal by design), then reap it. Finishing rather
    // than closing, so the final frame we wrote is not discarded under us.
    client
        .send
        .finish()
        .expect("the initiator finishes its stream");
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
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let cancel = AtomicBool::new(true); // pre-set; early-exit must still return false
    let harness = ServiceHarness::new().await;

    let peer = unreachable_peer("PEER_M46_FAIL");
    let refs = vec![make_peer_ref("PEER_M46_FAIL")];

    let apply_host_ctx_7140: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_M46",
        materializer: &apply_host_ctx_7140,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
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
    let harness = ServiceHarness::new().await;

    let peer = unreachable_peer("PEER_M46_BACK");
    let refs = vec![make_peer_ref("PEER_M46_BACK")];
    scheduler.record_failure("PEER_M46_BACK");
    assert!(!scheduler.may_retry("PEER_M46_BACK"));

    let apply_host_ctx_7193: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_M46_B",
        materializer: &apply_host_ctx_7193,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
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
    let harness = ServiceHarness::new().await;

    // The user has cancelled the round; the cancel is aimed at the still-
    // running sibling. This is the SHARED flag every per-peer task observes.
    let cancel = Arc::new(AtomicBool::new(true));

    // The early-exiting peer: put it in backoff so `try_sync_with_peer`
    // returns via the no-session early-exit path and drops its CancelGuard.
    let early_peer = unreachable_peer("PEER_EARLY_637");
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
        let endpoint = harness.client_endpoint.clone();
        tokio::spawn(async move {
            let apply_host_ctx_7262: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
                std::sync::Arc::new(materializer.clone());
            let ctx = SyncSessionContext {
                pool: &pool,
                device_id: "LOCAL_637",
                materializer: &apply_host_ctx_7262,
                scheduler: &scheduler,
                event_sink: &event_sink,
                cancel: &cancel,
                endpoint: &endpoint,
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
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let harness = ServiceHarness::new().await;

    // A live loopback responder so the dial succeeds and the function commits to
    // a real session (sets `owns = true`). It reads the initiator's opening frame
    // and answers nothing: what is under test is the initiator giving up on its
    // own cancel flag, not anything the peer says.
    let responder = {
        let service = harness.service.clone();
        tokio::spawn(async move {
            let mut session = service
                .accept()
                .await
                .expect("the accept loop does not error")
                .expect("an inbound connection is admitted")
                .establish()
                .await
                .expect("the peer completes the handshake and opens its stream");
            let _ = recv_sync_message(&mut session.recv).await;
            // Hold the session open until the initiator has returned.
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        })
    };

    let peer = discovered_service_peer("PEER_637_OWNS", &harness);
    let refs = vec![make_peer_ref("PEER_637_OWNS")];

    // Cancel pre-set: once `run_sync_session` starts, its first loop iteration's
    // cancel check fires and returns Err("sync cancelled by user").
    let cancel = AtomicBool::new(true);

    let apply_host_ctx_7341: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_637_OWNS",
        materializer: &apply_host_ctx_7341,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer must complete within timeout");

    // The responder was only ever holding the connection open; reclaim it.
    responder.abort();

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

    materializer.shutdown();
}

/// #637 (normal reset): the owns-path post-run reset still happens when NO
/// cancel is pending. A real session is reached (live loopback) with the
/// cancel flag clear; after the session ends the flag remains clear — the
/// legitimate reset is preserved and nothing spuriously sets it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_637_owns_path_normal_reset_leaves_flag_clear() {
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let harness = ServiceHarness::new().await;

    // A live loopback responder that establishes the session and immediately
    // drops it. With cancel clear, `run_sync_session` sends its first message
    // then errors on the first recv against the closed connection — a real
    // session ran and FAILED, which is still the owns-path. It is deterministic:
    // the initiator's recv returns an error promptly rather than blocking.
    //
    // The session is *established* rather than refused on purpose. Dropping an
    // `AdmittedConnection` before `establish` is an implicit reject, which would
    // fail the initiator's dial instead — the connect-failure path, not the one
    // this test is about.
    let responder = {
        let service = harness.service.clone();
        tokio::spawn(async move {
            let session = service
                .accept()
                .await
                .expect("the accept loop does not error")
                .expect("an inbound connection is admitted")
                .establish()
                .await
                .expect("the peer completes the handshake and opens its stream");
            drop(session);
        })
    };

    let peer = discovered_service_peer("PEER_637_NORM", &harness);
    let refs = vec![make_peer_ref("PEER_637_NORM")];

    // No cancel pending.
    let cancel = AtomicBool::new(false);

    let apply_host_ctx_7429: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_637_NORM",
        materializer: &apply_host_ctx_7429,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(30),
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

    responder.abort();
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
    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let endpoint_secret = SecretKey::generate();
    let event_sink: Arc<dyn agaric_sync::sync_events::SyncEventSink> =
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
        endpoint_secret,
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
// #2141 — N-device convergence over a REAL loopback QUIC socket
// ======================================================================

/// #2141: a single device's real-loopback fixture — its DB pool, materializer
/// and per-device Loro registry (the #602 two-registry test seam: the
/// process-global registry cannot represent more than one device in one test
/// process).
///
/// The stable identity cert this used to carry is gone. It existed because the
/// responder pinned a cert hash on first connection, so a per-session cert would
/// have tripped a hash mismatch on the second session. Its replacement is not a
/// field here: `run_one_real_loopback_session_2129` binds the dialling key to
/// the initiator's `peer_refs` row per session, which is a re-bind the store
/// explicitly permits and which preserves every other column.
///
/// The materializer is shut down via [`Device2141::flush_and_shutdown`] at test
/// end.
struct Device2141 {
    id: String,
    pool: SqlitePool,
    mat: Materializer,
    state: std::sync::Arc<agaric_engine::loro::shared::LoroState>,
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

/// #2141: build N mutually-paired devices for real-loopback convergence tests.
/// Each device gets its own DB pool, materializer and `LoroState` registry (the
/// #602 seam). Every ORDERED pair is paired via `upsert_peer_ref` so any device
/// can act as responder for any other (the responder rejects unknown peers); the
/// per-session key binding that row then needs is done by
/// `run_one_real_loopback_session_2129`.
///
/// This generalises the two-device setup that
/// `two_edited_devices_converge_over_real_loopback_tls` open-codes into an
/// N-device fixture, the reusable building block for the round-robin and
/// concurrent-role tests below.
async fn make_n_devices_2141(ids: &[&str]) -> Vec<Device2141> {
    let mut devices = Vec::with_capacity(ids.len());
    for id in ids {
        let (pool, dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // #602/#2249: the device's registry is its materializer's own
        // per-instance state (the process global is gone).
        let state = std::sync::Arc::clone(mat.loro_state());
        devices.push(Device2141 {
            id: (*id).to_string(),
            pool,
            mat,
            state,
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
) -> agaric_sync::sync_protocol::SyncState {
    run_one_real_loopback_session_2129(
        &initiator.pool,
        &initiator.mat,
        &initiator.id,
        &responder.pool,
        &responder.mat,
        &responder.id,
    )
    .await
}

/// #2141: decode a device's engine version vector for `space`.
fn device_vv_2141(dev: &Device2141, space: &agaric_store::space::SpaceId) -> loro::VersionVector {
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
    use agaric_store::op::{AddTagPayload, OpPayload, SetPropertyPayload};
    use agaric_sync::sync_protocol::SyncState;

    // Run the same scenario for N = 3 and N = 4.
    for ids in [
        vec!["DEV2141A", "DEV2141B", "DEV2141C"],
        vec!["DEV2141W", "DEV2141X", "DEV2141Y", "DEV2141Z"],
    ] {
        let n = ids.len();
        let space = agaric_store::space::SpaceId::from_trusted("01HZ2141SPACEXXXXXXXXXXXXX");
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
                block_id: agaric_core::ulid::BlockId::from_trusted(&block_ids[0]),
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
            OpPayload::CreateBlock(agaric_store::op::CreateBlockPayload {
                block_id: agaric_core::ulid::BlockId::from_trusted(tag_block),
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
                block_id: agaric_core::ulid::BlockId::from_trusted(&block_ids[1]),
                tag_id: agaric_core::ulid::BlockId::from_trusted(tag_block),
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
    use agaric_sync::sync_protocol::SyncState;

    let space = agaric_store::space::SpaceId::from_trusted("01HZ2141CONCSPACEXXXXXXXXX");
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

// #2140's harness is now the `ServiceHarness` itself. The old
// `connect_real_pair_2140` handed BOTH raw `SyncConnection`s back so a
// failure-mode test could drive them directly; under QUIC the responder side is
// an `InboundSession` that only the service's admission path can mint, and it
// only exists once the peer has spoken. So the tests below spawn the real
// responder and keep the client side, which is the same freedom for everything
// they actually do: drop the connection mid-stream, or write a hand-built frame.

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
    use agaric_sync::sync_protocol::SyncState;

    let space = agaric_store::space::SpaceId::from_trusted("01HZ2140DROPSPACEXXXXXXXXX");
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

    let timeout = std::time::Duration::from_secs(20);

    // ── Drop mid-stream: A opens, sends HeadExchange, then disconnects ──
    let harness = ServiceHarness::new().await;
    bind_client_as(&b.pool, &a.id, &harness).await;
    let resp_handle = spawn_responder(
        &harness,
        b.pool.clone(),
        &b.id,
        b.mat.clone(),
        Arc::new(SyncScheduler::new()),
        Arc::new(RecordingEventSink::new()),
        Arc::new(AtomicBool::new(false)),
    );
    let mut client = harness.dial().await;

    // Send a valid opening HeadExchange so the responder is mid-session,
    // then drop the client connection.
    let heads = agaric_sync::sync_protocol::get_local_heads(&a.pool)
        .await
        .unwrap();
    tokio::time::timeout(
        timeout,
        send_sync_message(&mut client.send, &head_exchange(heads, None)),
    )
    .await
    .expect("send HeadExchange timed out")
    .expect("send HeadExchange");
    // Wait for the responder to answer before pulling the wire. `establish`
    // resolves on our FIRST frame, so a drop that races it is a dropped
    // handshake, not a dropped session — and this test is about the latter.
    let _first_reply = tokio::time::timeout(timeout, recv_sync_message(&mut client.recv))
        .await
        .expect("the responder must answer the HeadExchange")
        .expect("the responder's first reply");
    // Abruptly drop the connection mid-stream (no graceful close handshake).
    drop(client);

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
    drop(harness);

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

/// #2140 — an OVERSIZED frame is rejected with a bounded error, no panic and no
/// hang.
///
/// The cap moved with the transport: the old test wrote an over-`MAX_MSG_SIZE`
/// WebSocket binary frame and relied on `ws_config()` refusing it at the frame
/// header. QUIC has no frames of its own at this layer, so the cap is
/// `transport::session`'s own four-byte length prefix, and the guarantee is
/// stated where it matters: the announced length is checked BEFORE anything is
/// allocated for it. This test therefore announces an over-cap length and sends
/// no body at all — a receiver that allocated first would have to be reached
/// through the allocation to fail, and this one fails without it.
///
/// Now duplicated one layer down by
/// `transport::session::tests::an_oversized_length_prefix_is_refused_before_allocating`,
/// which owns the framing contract post-cutover. Kept because #2140 is a
/// failure-mode acceptance issue and its list is what it is, not because this
/// layer adds anything the other test does not already prove.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_oversized_frame_is_rejected_with_bounded_error() {
    use agaric_sync::transport::MAX_FRAME_SIZE;

    let mut pair = quic_pair().await;
    let timeout = std::time::Duration::from_secs(5);

    // One byte over the cap, announced and never delivered.
    let announced = u32::try_from(MAX_FRAME_SIZE + 1).expect("the cap fits the frame prefix");
    pair.client
        .send
        .write_all(&announced.to_be_bytes())
        .await
        .expect("the length prefix is written");

    let recv_result = tokio::time::timeout(timeout, recv_sync_message(&mut pair.server.recv))
        .await
        .expect("#2140: an oversized recv must not hang");
    assert!(
        recv_result.is_err(),
        "#2140: the receiver must reject an announced length above MAX_FRAME_SIZE \
         with a bounded error, got Ok"
    );
}

/// #2140 — garbage / non-`SyncMessage` bytes are rejected by the receiver with a
/// bounded deserialize error, no panic and no hang.
///
/// The sender ships a correctly framed, in-cap payload whose body is not a
/// `SyncMessage`. `recv_sync_message` must surface a bounded error rather than
/// panicking or hanging. Written as a hand-built frame because
/// `send_sync_message` takes a `&SyncMessage` and so cannot express this — which
/// is itself the reason the receiver still has to.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_garbage_frame_is_rejected_with_bounded_error() {
    let mut pair = quic_pair().await;
    let timeout = std::time::Duration::from_secs(5);

    let body = br#""not a sync message {{{ garbage""#;
    let mut frame = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
    frame.extend_from_slice(body);
    pair.client
        .send
        .write_all(&frame)
        .await
        .expect("the garbage frame is written");

    let recv_result = tokio::time::timeout(timeout, recv_sync_message(&mut pair.server.recv))
        .await
        .expect("#2140: a garbage recv must not hang");
    assert!(
        recv_result.is_err(),
        "#2140: a well-framed non-SyncMessage payload must be rejected with a \
         bounded deserialize error, got Ok"
    );
}

/// #2140 — a PARTIAL message (the peer stops mid-frame and closes) surfaces as a
/// bounded error, not a hang.
///
/// The sender announces a frame and then writes half of it before finishing the
/// stream. The receiver, blocked on the rest, must observe the end of the stream
/// and return a bounded error. The half-write is the point: an EOF before the
/// length prefix is the easy case, and the old test only covered that one.
///
/// Now duplicated one layer down by
/// `transport::session::tests::a_truncated_frame_is_an_error_not_a_partial_message`
/// — see the note on the oversized-frame test above.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue2140_partial_message_then_close_is_bounded_error() {
    let mut pair = quic_pair().await;
    let timeout = std::time::Duration::from_secs(5);

    let mut frame = 64_u32.to_be_bytes().to_vec();
    frame.extend_from_slice(&[b'{'; 8]);
    pair.client
        .send
        .write_all(&frame)
        .await
        .expect("the partial frame is written");
    pair.client
        .send
        .finish()
        .expect("the sender finishes early");

    let recv_result = tokio::time::timeout(timeout, recv_sync_message(&mut pair.server.recv))
        .await
        .expect("#2140: a recv after a partial frame must not hang");
    assert!(
        recv_result.is_err(),
        "#2140: a stream that ends mid-frame must yield a bounded error, got Ok"
    );
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
    use agaric_store::op::{CreateBlockPayload, OpPayload};
    use agaric_store::op_log::append_local_op_at;
    use agaric_sync::snapshot::create_snapshot;
    use agaric_sync::sync_protocol::SyncState;

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
            block_id: agaric_core::ulid::BlockId::from_trusted(SNAP_BLOCK),
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
    agaric_engine::merge::engine_apply(
        &format!("{RESP_DEV}/{}", record.seq),
        &OpPayload::CreateBlock(CreateBlockPayload {
            block_id: agaric_core::ulid::BlockId::from_trusted(SNAP_BLOCK),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "compacted-state content".into(),
        }),
        RESP_DEV,
        &agaric_store::space::SpaceId::from_trusted("01HZ2140SNAPSPACEXXXXXXXXX"),
        &record.created_at.to_string(),
        &resp.state,
    );

    create_snapshot(&resp.pool, RESP_DEV).await.unwrap();

    // Simulate compaction: wipe the responder's op_log (H-13 bypass dance).
    let mut tx = resp.pool.begin().await.unwrap();
    agaric_store::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM op_log")
        .execute(&mut *tx)
        .await
        .unwrap();
    agaric_store::op_log::disable_op_log_mutation_bypass(&mut tx)
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
            block_id: agaric_core::ulid::BlockId::from_trusted(SNAP_BLOCK),
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
    let snap_space = agaric_store::space::SpaceId::from_trusted("01HZ2140SNAPSPACEXXXXXXXXX");
    for i in 0..6 {
        agaric_engine::merge::engine_apply(
            &format!("{RESP_DEV}/{}", i + 1),
            &OpPayload::CreateBlock(CreateBlockPayload {
                block_id: agaric_core::ulid::BlockId::from_trusted(&format!(
                    "01HZ2140INITCLAIM{i:09}"
                )),
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
    use agaric_sync::sync_protocol::SyncState;

    let space = agaric_store::space::SpaceId::from_trusted("01HZ2140BOSPACEXXXXXXXXXXX");
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
    let timeout = std::time::Duration::from_secs(20);

    // ── A broken session: initiator drops mid-stream → the session fails,
    //    so we record a failure for the peer on the scheduler.
    let harness = ServiceHarness::new().await;
    bind_client_as(&b.pool, &a.id, &harness).await;
    let resp_handle = spawn_responder(
        &harness,
        b.pool.clone(),
        &b.id,
        b.mat.clone(),
        Arc::new(SyncScheduler::new()),
        Arc::new(RecordingEventSink::new()),
        Arc::new(AtomicBool::new(false)),
    );
    let mut client = harness.dial().await;
    let heads = agaric_sync::sync_protocol::get_local_heads(&a.pool)
        .await
        .unwrap();
    tokio::time::timeout(
        timeout,
        send_sync_message(&mut client.send, &head_exchange(heads, None)),
    )
    .await
    .expect("send HeadExchange timed out")
    .expect("send HeadExchange");
    // As above: let the responder answer first, so the drop lands mid-session
    // rather than mid-handshake.
    let _first_reply = tokio::time::timeout(timeout, recv_sync_message(&mut client.recv))
        .await
        .expect("the responder must answer the HeadExchange")
        .expect("the responder's first reply");
    drop(client);
    let resp_join = tokio::time::timeout(timeout, resp_handle)
        .await
        .expect("#2140 backoff: responder must not hang on the failed session")
        .expect("responder task panicked");
    assert!(
        resp_join.is_err(),
        "#2140 backoff: the broken session must fail so a failure is recorded"
    );
    drop(harness);

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
/// responder session (`handle_incoming_sync`) over a real admitted QUIC session
/// with the SAME shared cancel flag + scheduler, and asserts the session
/// completes and data flows — plus that the cancel never bumped any
/// scheduler backoff/failure state.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_2537_no_session_cancel_does_not_poison_inbound_session() {
    use agaric_sync::sync_protocol::SyncState;

    const RESP_DEV: &str = "RESP2537";
    const INIT_DEV: &str = "INIT2537";
    const BLOCK: &str = "01HZ2537BLKXXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ2537SPACEXXXXXXXXXXXXX");

    // Shared daemon-wide state: ONE cancel flag + ONE scheduler, exactly as
    // production wires them into both the daemon handle and the responder.
    let cancel = Arc::new(AtomicBool::new(false));
    let scheduler = Arc::new(SyncScheduler::new());
    let daemon = SyncDaemon {
        shutdown_notify: Arc::new(Notify::new()),
        cancel: cancel.clone(),
        scheduler: scheduler.clone(),
        handle: None,
        activation: DaemonActivation::default(),
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

    let harness = ServiceHarness::new().await;
    peer_refs::bind_endpoint_id(&resp_pool, INIT_DEV, &client_key(&harness))
        .await
        .unwrap();

    let server_task = spawn_responder(
        &harness,
        resp_pool.clone(),
        RESP_DEV,
        resp_mat.clone(),
        scheduler.clone(),
        resp_sink.clone(),
        cancel.clone(),
    );
    let mut client = harness.dial().await;

    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink_box: Box<dyn SyncEventSink> = Box::new(SharedEventSink(init_sink.clone()));
    let mut init_orch = SyncOrchestrator::new(init_pool.clone(), INIT_DEV.into(), init_mat.clone())
        .with_event_sink(init_sink_box)
        .with_expected_remote_id(RESP_DEV.into());

    let first = init_orch.start().await.expect("initiator start");
    send_sync_message(&mut client.send, &first).await.unwrap();

    while !init_orch.is_terminal() {
        let incoming = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            recv_sync_message(&mut client.recv),
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
            send_sync_message(&mut client.send, &resp).await.unwrap();
            while let Some(m) = init_orch.next_message() {
                send_sync_message(&mut client.send, &m).await.unwrap();
            }
        }
    }

    assert_eq!(
        init_orch.session().state,
        SyncState::Complete,
        "#2537: the inbound session after a no-session cancel must COMPLETE"
    );

    // End the responder's post-Complete file-transfer phase and reap it.
    //
    // `finish` and not `conn.close`: `Connection::close` lets the remote drop data
    // it has received but not yet delivered to the application, so closing here
    // would discard the `SyncComplete` we just wrote and the responder would fail
    // its next read instead of completing. Finishing the stream delivers what is
    // already written and then signals the end.
    client
        .send
        .finish()
        .expect("the initiator finishes its stream");
    let resp_result = tokio::time::timeout(std::time::Duration::from_secs(20), server_task)
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
///
/// **This test fails after the port**, on its last assertion only, and it is a
/// race: measured 1 pass in 6 runs on loopback. See that assertion for the cause
/// — the initiator closes the connection immediately after writing
/// `SnapshotReject`, and `Connection::close` may discard it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn catchup_2538_oversize_rejection_records_failure_not_success() {
    const PEER: &str = "PEER_2538";

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let harness = ServiceHarness::new().await;

    // A live loopback responder whose admitted session is scripted by a test
    // task (the same harness shape as the #637 owns-path tests). It drives raw
    // frames rather than `handle_incoming_sync`, because what is under test is
    // the INITIATOR's bookkeeping for an offer no real responder would make.
    let script = {
        let service = harness.service.clone();
        tokio::spawn(async move {
            let mut session = service
                .accept()
                .await
                .expect("the accept loop does not error")
                .expect("an inbound connection is admitted")
                .establish()
                .await
                .expect("the peer completes the handshake and opens its stream");
            let first = recv_sync_message(&mut session.recv)
                .await
                .expect("script recv HeadExchange");
            assert!(
                matches!(first, SyncMessage::HeadExchange { .. }),
                "initiator must open with HeadExchange, got {first:?}"
            );
            send_sync_message(
                &mut session.send,
                &SyncMessage::ResetRequired {
                    reason: "test: force snapshot catch-up".into(),
                },
            )
            .await
            .expect("script send ResetRequired");
            send_sync_message(
                &mut session.send,
                &SyncMessage::SnapshotOffer {
                    size_bytes: super::snapshot_transfer::MAX_SNAPSHOT_SIZE + 1,
                    // Rejected on size before any bytes/checksum are exchanged.
                    blob_blake3: String::new(),
                },
            )
            .await
            .expect("script send SnapshotOffer");
            // Returned rather than asserted in the task: a panic here would abort
            // the whole test and take the initiator-side bookkeeping assertions
            // — the actual subject of #2538 — down with it. The assertion is
            // made at the end, unchanged.
            let reply = recv_sync_message(&mut session.recv).await;
            (session, reply)
        })
    };

    let peer = discovered_service_peer(PEER, &harness);
    let refs = vec![make_peer_ref(PEER)];
    let cancel = AtomicBool::new(false);

    let apply_host_ctx_8925: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL_2538",
        materializer: &apply_host_ctx_8925,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer must complete within timeout");
    assert!(!was_cancelled, "no cancel was issued");

    // Keep the scripted session alive until the initiator returned.
    let (_session, peer_reply) = tokio::time::timeout(std::time::Duration::from_secs(20), script)
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
        "#2538: a rejected catch-up must skip the TOFU key binding and the \
         synced_at bookkeeping, got {row:?}"
    );

    // ── The peer was TOLD why ─────────────────────────────────────────
    //
    // Asserted last, after every initiator-side assertion above has run, because
    // this one FAILS after the port and the rest do not. The rejection is a
    // message and not just a local outcome: a responder that never receives it
    // cannot tell "your snapshot is over my cap" from "the link died", and
    // re-offers the same blob on the next tick — the loop #2538 exists to break.
    //
    // The cause is in `run_sync_session`'s `CatchupOutcome::Rejected` arm, which
    // calls `finish_session(false, ..)` immediately after
    // `try_receive_snapshot_catchup` wrote `SnapshotReject`. `spoke_last = false`
    // means "the peer spoke last and owes us nothing", so `finish_session` closes
    // the connection at once — and `Connection::close` lets the remote drop data
    // it received but has not yet delivered to the application. On this path WE
    // spoke last, so the close discards the very frame that was just written.
    // `server.rs`'s `reject()` documents this exact hazard and avoids it; this
    // call site does not. Not fixed here: production is out of scope for this
    // file.
    assert_eq!(
        peer_reply.as_ref().ok(),
        Some(&SyncMessage::SnapshotReject),
        "#2538: the offering peer must receive the initiator's SnapshotReject, got: {peer_reply:?}"
    );

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
/// structural tests in `transport::driver` pin the `SessionLimits` ordering.
///
/// `start_paused` virtual time makes the 120 s timeout elapse instantly and
/// deterministically.
#[tokio::test(start_paused = true)]
async fn dispatch_guard_2539_times_out_with_session_loop_error_shape() {
    use agaric_sync::sync_constants::HANDSHAKE_TIMEOUT;

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
/// responder over a real loopback QUIC socket, with a seeded responder edit so
/// the session takes the streamed-ops path, and counts Complete events on
/// BOTH roles' sinks.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn complete_2539_full_session_emits_single_complete_per_role() {
    const INIT_DEV: &str = "INIT2539";
    const RESP_DEV: &str = "RESP2539";
    const BLOCK: &str = "01HZ2539BLKXXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ2539SPACEXXXXXXXXXXXXX");

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
    let harness = ServiceHarness::new().await;
    peer_refs::bind_endpoint_id(&resp_pool, INIT_DEV, &client_key(&harness))
        .await
        .unwrap();

    let resp_sink_dyn: Arc<dyn SyncEventSink> = resp_sink.clone();
    let resp_task = spawn_responder(
        &harness,
        resp_pool.clone(),
        RESP_DEV,
        resp_mat.clone(),
        Arc::new(SyncScheduler::new()),
        resp_sink_dyn,
        Arc::new(AtomicBool::new(false)),
    );

    // ── Initiator: the REAL daemon layer (try_sync_with_peer) ─────────
    let (init_pool, _init_dir) = test_pool().await;
    let init_mat = Materializer::new(init_pool.clone());
    let init_sink = Arc::new(RecordingEventSink::new());
    let init_sink_dyn: Arc<dyn SyncEventSink> = init_sink.clone();
    let scheduler = Arc::new(SyncScheduler::new());
    let cancel = AtomicBool::new(false);

    let apply_host_ctx_9155: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(init_mat.clone());
    let ctx = SyncSessionContext {
        pool: &init_pool,
        device_id: INIT_DEV,
        materializer: &apply_host_ctx_9155,
        scheduler: &scheduler,
        event_sink: &init_sink_dyn,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };
    let peer = discovered_service_peer(RESP_DEV, &harness);
    let refs = vec![make_peer_ref(RESP_DEV)];

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer timed out");
    assert!(!was_cancelled, "no cancel was issued");

    let resp_result = tokio::time::timeout(std::time::Duration::from_secs(20), resp_task)
        .await
        .expect("responder task timed out")
        .expect("responder task panicked");
    resp_result.expect("responder session must succeed");

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
    const PEER: &str = "PEER2539CU";
    const BLOCK: &str = "01HZ2539CBLKXXXXXXXXXXXXXX";
    let space = agaric_store::space::SpaceId::from_trusted("01HZ2539CSPACEXXXXXXXXXXXX");

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let sink = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = sink.clone();
    let harness = ServiceHarness::new().await;

    // Scripted responder: force the catch-up, then stream ONE valid Loro
    // space snapshot so the initiator's merge path (#2503) applies it.
    let script_space = space.clone();
    let script = {
        let service = harness.service.clone();
        tokio::spawn(async move {
            let mut session = service
                .accept()
                .await
                .expect("the accept loop does not error")
                .expect("an inbound connection is admitted")
                .establish()
                .await
                .expect("the peer completes the handshake and opens its stream");
            let first = recv_sync_message(&mut session.recv)
                .await
                .expect("script recv HeadExchange");
            assert!(
                matches!(first, SyncMessage::HeadExchange { .. }),
                "initiator must open with HeadExchange, got {first:?}"
            );
            send_sync_message(
                &mut session.send,
                &SyncMessage::ResetRequired {
                    reason: "test: force snapshot catch-up (#2539)".into(),
                },
            )
            .await
            .expect("script send ResetRequired");

            let bytes = {
                let mut e = agaric_engine::loro::engine::LoroEngine::with_peer_id(PEER)
                    .expect("script engine");
                e.apply_create_block(BLOCK, "content", "caught-up content (#2539)", None, 0)
                    .expect("script create block");
                e.export_snapshot().expect("script export snapshot")
            };
            send_sync_message(
                &mut session.send,
                &SyncMessage::LoroSync {
                    msg: agaric_sync::sync_protocol::loro_sync_types::LoroSyncMessage::Snapshot {
                        protocol_version:
                            agaric_sync::sync_protocol::loro_sync_types::LORO_SYNC_PROTOCOL_VERSION,
                        space_id: script_space,
                        bytes,
                    },
                    is_last: true,
                },
            )
            .await
            .expect("script send LoroSync snapshot");
            session
        })
    };

    let peer = discovered_service_peer(PEER, &harness);
    let refs = vec![make_peer_ref(PEER)];
    let cancel = AtomicBool::new(false);

    let apply_host_ctx_9312: std::sync::Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(materializer.clone());
    let ctx = SyncSessionContext {
        pool: &pool,
        device_id: "LOCAL2539CU",
        materializer: &apply_host_ctx_9312,
        scheduler: &scheduler,
        event_sink: &event_sink,
        cancel: &cancel,
        endpoint: &harness.client_endpoint,
    };

    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        try_sync_with_peer(&ctx, &peer, &refs),
    )
    .await
    .expect("try_sync_with_peer must complete within timeout");
    assert!(!was_cancelled, "no cancel was issued");

    // Keep the scripted session alive until the initiator returned.
    let _session = tokio::time::timeout(std::time::Duration::from_secs(20), script)
        .await
        .expect("script task timed out")
        .expect("script task panicked");

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

// ======================================================================
// #3507 — two devices, one pairing, both sides asserted
// ======================================================================
//
// # Why this section exists
//
// Three defects reached `main` through the same hole: #3463 (the joiner
// compared the typed passphrase against its OWN session), #3469 (success was
// announced the moment `confirm_pairing` returned, before anything verified
// it) and #3502 (the `already_discovered` short-circuit ran ahead of the
// `pairing_pending` clause, so a first-ever pair was undiallable). Every one
// of them survived review and a full suite, because nothing anywhere drove
// two devices through a real pairing and looked at what BOTH of them ended up
// holding.
//
// # Why it is only affordable now
//
// It was not an oversight that this test did not exist. First contact used to
// require mDNS, and multicast in CI is unreliable. Under QUIC a peer is dialled
// by `EndpointId` — a key this test reads off the responder's service and hands
// to the initiator through a synthesised announcement — so there is no
// multicast, no service resolution and no timing window left to be flaky about.
//
// # What it drives, and what it refuses to fake
//
// Everything between `start_pairing` and the settled row is production code:
//
//   * `start_pairing_armed_inner` on the host and `start_pairing_inner` +
//     `confirm_pairing_inner` on the joiner — the exact command sequence the
//     frontend issues, on two independent pools;
//   * `process_discovery_event` — the joiner's initiate-or-not decision, run
//     TWICE so the peer is already known by the time it matters (#3502);
//   * `try_sync_with_peer` — the real initiator, whose orchestrator sources the
//     offered `pairing_proof` from the joiner's OWN marker
//     (`session_state_machine::start`), rather than from a value the test read
//     out of the database and posted by hand;
//   * `handle_incoming_sync` — the real responder and its #855 gate, over a
//     real loopback QUIC connection.
//
// The one thing the fixture supplies is the mDNS announcement, because there is
// no mDNS. It supplies it by asking the responder's service for its own key and
// address, so what the initiator dials is what is actually listening.

/// The mDNS announcement device `device_id` would make if it were serving on
/// `harness`'s endpoint.
///
/// Deliberately not [`make_resolved_event`], which derives a *synthetic* key
/// from the device id. That is right for testing the decision function, whose
/// answer does not depend on the key, and wrong here: the `DiscoveredPeer` this
/// produces is handed to `try_sync_with_peer`, which dials the key and reaches
/// nothing unless it is the one the service is listening on.
fn resolved_event_for_service(device_id: &str, harness: &ServiceHarness) -> mdns_sd::ServiceEvent {
    let sa = harness
        .service
        .addr()
        .ip_addrs()
        .copied()
        .find(|sa: &std::net::SocketAddr| sa.ip().is_loopback())
        .expect("a loopback-bound service publishes its loopback socket address");
    let mut props = HashMap::new();
    props.insert("device_id".to_string(), device_id.to_string());
    props.insert(
        "endpoint_id".to_string(),
        harness.service.endpoint_id().to_string(),
    );
    let info = mdns_sd::ServiceInfo::new(
        mdns::MDNS_SERVICE_TYPE,
        device_id,
        &format!("{device_id}.local."),
        sa.ip().to_string().as_str(),
        sa.port(),
        Some(props),
    )
    .expect("a well-formed announcement for a loopback service");
    mdns_sd::ServiceEvent::ServiceResolved(Box::new(info.as_resolved_service()))
}

const HOST_DEV_3507: &str = "HOST3507";
const JOINER_DEV_3507: &str = "JOIN3507";
const HOST_BLOCK_3507: &str = "01HZ3507HBLKXXXXXXXXXXXXXX";
const JOINER_BLOCK_3507: &str = "01HZ3507JBLKXXXXXXXXXXXXXX";
const SPACE_3507: &str = "01HZ3507SPACEXXXXXXXXXXXXX";
const HOST_CONTENT_3507: &str = "seeded on the host (#3507)";

/// Everything one pairing run leaves behind, on **both** devices.
///
/// Returned as data rather than asserted inside the driver so the success case
/// and the mistyped-passphrase case read the same run through opposite
/// expectations — and so a future assertion does not have to re-run the flow.
struct PairingOutcome3507 {
    /// The host's `peer_refs` row for the joiner, if it bound one.
    host_row_for_joiner: Option<PeerRef>,
    /// The joiner's `peer_refs` row for the host, if it bound one.
    joiner_row_for_host: Option<PeerRef>,
    host_events: Vec<SyncEvent>,
    joiner_events: Vec<SyncEvent>,
    /// Whether each device's pairing window is still open afterwards.
    host_still_pending: bool,
    /// The keys the two endpoints actually authenticated with, so the rows
    /// above can be checked against an identity the test did not choose.
    host_key: String,
    joiner_key: String,
    /// The host's seeded block, as projected into the joiner's `blocks` table.
    ///
    /// The settled reprojection, not a transient session counter: this is the
    /// difference between "a session ran" and "these two devices are paired and
    /// converged".
    host_block_on_joiner: Option<String>,
    /// #3505/#3547 — how many consecutive failures the joiner's scheduler booked
    /// against the host as a result of this run.
    ///
    /// Carried out of the driver rather than asserted inside it because the two
    /// runs want opposite things from it and neither is "don't care": a
    /// successful pair must leave it at zero because nothing failed, and a
    /// *rejected* one must leave it at zero because a refusal during a pairing
    /// window is not a failure.
    joiner_failures_against_host: u32,
}

/// Drive one complete two-device pairing and report what both devices hold.
///
/// `joiner_types_the_hosts_passphrase` is the only difference between the
/// success run and the failure run, and it is the only thing a user controls.
async fn drive_two_device_pairing_3507(
    joiner_types_the_hosts_passphrase: bool,
) -> PairingOutcome3507 {
    drive_two_device_pairing_windowed_3507(joiner_types_the_hosts_passphrase, true).await
}

/// The same run, with control over whether the joiner's own pairing window is
/// still open at the moment it dials.
///
/// `joiner_window_open: false` is not a scenario a user reaches — it exists so
/// the #3505 classification can be falsified from BOTH sides. "A rejection is
/// not a failure" is only correct while a pairing window is open; outside one,
/// a peer telling us we are not paired is exactly the peer the backoff exists
/// for. A test suite that only ever asserts the suppression would stay green if
/// the condition were dropped and every rejection excused.
///
/// The window is cleared *after* the discovery decision and *before* the dial,
/// because the decision is what puts the peer in the round at all — closing it
/// earlier would test nothing, since nothing would dial.
async fn drive_two_device_pairing_windowed_3507(
    joiner_types_the_hosts_passphrase: bool,
    joiner_window_open: bool,
) -> PairingOutcome3507 {
    let space = agaric_store::space::SpaceId::from_trusted(SPACE_3507);

    // ── The host: shows the code, arms its own window ──────────────────
    let (host_pool, _host_dir) = test_pool().await;
    let host_mat = Materializer::new(host_pool.clone());
    let host_state = std::sync::Arc::clone(host_mat.loro_state());
    let host_sched = Arc::new(SyncScheduler::new());
    let host_sink = Arc::new(RecordingEventSink::new());
    let host_slot = std::sync::Mutex::new(None);

    let host_passphrase = crate::commands::start_pairing_armed_inner(
        &host_pool,
        &host_slot,
        &host_sched,
        HOST_DEV_3507,
    )
    .await
    .expect("the host arms its pairing window")
    .passphrase;

    // ── The joiner: its dialog mints a competing passphrase of its own,
    //    which is #3463's root cause, and then the user types the host's ──
    let (joiner_pool, _joiner_dir) = test_pool().await;
    let joiner_mat = Materializer::new(joiner_pool.clone());
    let joiner_state = std::sync::Arc::clone(joiner_mat.loro_state());
    let joiner_sched = Arc::new(SyncScheduler::new());
    let joiner_sink = Arc::new(RecordingEventSink::new());
    let joiner_slot = std::sync::Mutex::new(None);
    crate::commands::start_pairing_inner(&joiner_slot, JOINER_DEV_3507)
        .expect("the joiner's dialog opens a session of its own");

    // A mistype is derived from the real passphrase rather than invented, so
    // "wrong" cannot accidentally collide with a random 4-word phrase.
    let typed = if joiner_types_the_hosts_passphrase {
        host_passphrase.clone()
    } else {
        format!("{host_passphrase} typo")
    };
    crate::commands::confirm_pairing_inner(
        &joiner_pool,
        &joiner_slot,
        &joiner_sched,
        JOINER_DEV_3507,
        typed,
        String::new(),
    )
    .await
    .expect(
        "#3463/#3469: confirming is a purely local act — it arms a marker with the \
         proof of whatever was typed and returns Ok even for a mistype. It must NOT \
         compare against this device's own session, and its Ok must never be read \
         as 'paired'",
    );

    // ── Divergent local edits, through the real foreground pipeline ────
    //
    // The host's edit is what the joiner must end up holding, and asserting its
    // SETTLED reprojection is what stops this test from passing on a session
    // that merely completed.
    //
    // The joiner's edit is load-bearing for a different reason. The responder
    // binds `orch.session().remote_device_id`, which comes from the joiner's
    // advertised heads; a joiner with an empty op log advertises no head of its
    // own and `server.rs` then deliberately leaves it unbound. Without this the
    // host's half of the both-sides assertion could never hold, for a reason
    // that has nothing to do with pairing.
    make_local_edit_602(
        &host_pool,
        &host_mat,
        &host_state,
        HOST_DEV_3507,
        &space,
        HOST_BLOCK_3507,
        HOST_CONTENT_3507,
        1_736_942_400_000,
    )
    .await;
    make_local_edit_602(
        &joiner_pool,
        &joiner_mat,
        &joiner_state,
        JOINER_DEV_3507,
        &space,
        JOINER_BLOCK_3507,
        "seeded on the joiner (#3507)",
        1_736_942_400_100,
    )
    .await;

    // ── Two real endpoints: the host serves, the joiner dials ──────────
    let harness = ServiceHarness::new().await;
    let host_key = harness.service.endpoint_id().to_string();
    let joiner_key = client_key(&harness);
    assert_ne!(
        host_key, joiner_key,
        "the fixture must hand the two devices distinct identities, or every \
         identity assertion below is vacuous"
    );

    // Precondition: a FIRST pair. Neither device knows the other, which is why
    // the peer-enumerating initiation branches produce nothing and the pairing
    // window is the only thing that can start this.
    assert!(
        peer_refs::list_peer_refs(&host_pool)
            .await
            .unwrap()
            .is_empty(),
        "precondition: the host must not already know the joiner"
    );
    assert!(
        peer_refs::list_peer_refs(&joiner_pool)
            .await
            .unwrap()
            .is_empty(),
        "precondition: the joiner must not already know the host"
    );

    // ── #3502: the peer is ALREADY known when the passphrase lands ─────
    //
    // Both dialogs arm on open, both devices dial and reject each other, and
    // both land in each other's `discovered` map — and only THEN does the user
    // finish typing. So by the time there is anything to dial *about*, the peer
    // is never new. The announcement is therefore processed twice and the peer
    // this test dials is the one the SECOND call returns: the gate has to be
    // opened by production code, not by the fixture.
    let mut discovered: HashMap<String, (mdns::DiscoveredPeer, tokio::time::Instant)> =
        HashMap::new();
    let joiner_refs = peer_refs::list_peer_refs(&joiner_pool).await.unwrap();
    let joiner_pending = peer_refs::is_pending_pairing(&joiner_pool).await.unwrap();
    assert!(
        joiner_pending,
        "confirm_pairing must leave the joiner's pairing window open, or the \
         initiate decision below is not being asked the question this test is about"
    );

    let first = process_discovery_event(
        resolved_event_for_service(HOST_DEV_3507, &harness),
        JOINER_DEV_3507,
        &mut discovered,
        &joiner_refs,
        joiner_pending,
    );
    assert!(
        first.is_some(),
        "the first sight of an unpaired peer during a pairing window must initiate"
    );
    assert!(
        discovered.contains_key(HOST_DEV_3507),
        "the first announcement must leave the peer in `discovered`, which is what \
         makes the second call the #3502 configuration"
    );
    let peer = process_discovery_event(
        resolved_event_for_service(HOST_DEV_3507, &harness),
        JOINER_DEV_3507,
        &mut discovered,
        &joiner_refs,
        joiner_pending,
    )
    .expect(
        "#3502: an mDNS refresh of a peer ALREADY in `discovered` must still \
         initiate while a pairing window is open. This is the configuration every \
         first-ever pair is in by the time the code is typed, and the \
         `already_discovered` short-circuit made it undiallable",
    );
    assert_eq!(
        peer.endpoint_id.map(|k| k.to_string()).as_deref(),
        Some(host_key.as_str()),
        "the discovered peer must carry the host's real key — under QUIC a dial \
         names a key, and a peer resolved without one is a peer nothing can reach"
    );

    if !joiner_window_open {
        peer_refs::clear_pending_pairing(&joiner_pool)
            .await
            .expect("the joiner's window closes");
    }

    // ── The responder: production `handle_incoming_sync` on the host ───
    let host_sink_dyn: Arc<dyn SyncEventSink> = host_sink.clone();
    let host_task = spawn_responder(
        &harness,
        host_pool.clone(),
        HOST_DEV_3507,
        host_mat.clone(),
        host_sched.clone(),
        host_sink_dyn,
        Arc::new(AtomicBool::new(false)),
    );

    // ── The initiator: production `try_sync_with_peer` on the joiner ───
    //
    // `joiner_refs` is empty, which is the whole point: the proof that goes on
    // the wire is not passed in here, it is read from the joiner's own marker by
    // `session_state_machine::start`.
    let joiner_sink_dyn: Arc<dyn SyncEventSink> = joiner_sink.clone();
    let joiner_apply: Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(joiner_mat.clone());
    let joiner_cancel = AtomicBool::new(false);
    let ctx = SyncSessionContext {
        pool: &joiner_pool,
        device_id: JOINER_DEV_3507,
        materializer: &joiner_apply,
        scheduler: &joiner_sched,
        event_sink: &joiner_sink_dyn,
        cancel: &joiner_cancel,
        endpoint: &harness.client_endpoint,
    };
    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        try_sync_with_peer(&ctx, &peer, &joiner_refs),
    )
    .await
    .expect("try_sync_with_peer must finish inside its own connect budget");
    assert!(!was_cancelled, "no cancel is issued in this test");

    // A rejection is not an error: on the mistyped run the responder still
    // returns Ok, having spent at most one `close_wait` (10 s) on the peer's
    // close — which the initiator's `drop(conn)` has already delivered.
    let host_result = tokio::time::timeout(std::time::Duration::from_secs(40), host_task)
        .await
        .expect("the responder must resolve once the initiator's session ends")
        .expect("the responder task must not panic");
    assert!(
        host_result.is_ok(),
        "handle_incoming_sync must return Ok for both an accepted and a rejected \
         session, got {host_result:?}"
    );

    let outcome = PairingOutcome3507 {
        host_row_for_joiner: peer_refs::get_peer_ref(&host_pool, JOINER_DEV_3507)
            .await
            .unwrap(),
        joiner_row_for_host: peer_refs::get_peer_ref(&joiner_pool, HOST_DEV_3507)
            .await
            .unwrap(),
        host_events: host_sink.events(),
        joiner_events: joiner_sink.events(),
        host_still_pending: peer_refs::is_pending_pairing(&host_pool).await.unwrap(),
        host_key,
        joiner_key,
        host_block_on_joiner: sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(HOST_BLOCK_3507)
            .fetch_optional(&joiner_pool)
            .await
            .unwrap(),
        joiner_failures_against_host: joiner_sched.failure_count(HOST_DEV_3507),
    };

    host_mat.shutdown();
    joiner_mat.shutdown();
    outcome
}

/// Does this device's sink hold a terminal success?
fn saw_complete_3507(events: &[SyncEvent]) -> bool {
    events
        .iter()
        .any(|e| matches!(e, SyncEvent::Complete { .. }))
}

/// Does this device's sink hold an error naming `needle`?
fn saw_error_containing_3507(events: &[SyncEvent], needle: &str) -> bool {
    events
        .iter()
        .any(|e| matches!(e, SyncEvent::Error { message, .. } if message.contains(needle)))
}

/// #3507 (the success path): two devices that never met complete a pairing and
/// end up holding each other — pinned to the identity the QUIC handshake
/// authenticated, and converged on each other's content.
///
/// # What each assertion is defending
///
/// * **Both rows, each pinned to the OTHER device's key.** #3463 could never get
///   here at all; the assertion that catches it is upstream, in the driver's
///   `confirm_pairing_inner` call. What these catch is the quieter failure where
///   one side binds and the other does not, which is the state #3503 describes
///   the UI consequence of.
/// * **The settled reprojection.** `blocks.content` on the joiner, written by
///   the materializer, not a session counter and not a provisional command-path
///   value. A session that "completed" without moving state fails here.
/// * **Both sinks see a terminal Complete.** The host is a full participant in
///   the outcome, not merely the thing that was dialled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_devices_pair_bind_each_other_and_converge_3507() {
    let out = drive_two_device_pairing_3507(true).await;

    // ── 1. Both devices end with a row for the other ───────────────────
    let host_row = out.host_row_for_joiner.as_ref().expect(
        "the host must end with a peer_refs row for the joiner — TOFU-pinned by \
         `handle_incoming_sync` once the session named the peer",
    );
    assert_eq!(
        host_row.endpoint_id.as_deref(),
        Some(out.joiner_key.as_str()),
        "the host must pin the key the joiner's QUIC handshake authenticated, not \
         one it was told about"
    );
    let joiner_row = out.joiner_row_for_host.as_ref().expect(
        "the joiner must end with a peer_refs row for the host — TOFU-bound by \
         `try_sync_with_peer` on a successful session",
    );
    assert_eq!(
        joiner_row.endpoint_id.as_deref(),
        Some(out.host_key.as_str()),
        "the joiner must pin the host's real endpoint id"
    );

    // ── 2. The settled state, not a transient one ──────────────────────
    assert_eq!(
        out.host_block_on_joiner.as_deref(),
        Some(HOST_CONTENT_3507),
        "the host's block must be projected into the joiner's `blocks` table — a \
         pairing that binds rows but moves no state is not a pairing"
    );

    // ── 3. BOTH devices observe the outcome (#3503) ────────────────────
    assert!(
        saw_complete_3507(&out.joiner_events),
        "the joiner must observe a terminal Complete, got {:?}",
        out.joiner_events
    );
    assert!(
        saw_complete_3507(&out.host_events),
        "#3503: the HOST must observe the outcome too. It is not a bystander to a \
         pairing it started — a host told nothing keeps counting down and then \
         offers a Retry over a pairing that already succeeded. Got {:?}",
        out.host_events
    );
    assert!(
        !saw_error_containing_3507(&out.joiner_events, "pairing passphrase proof"),
        "a correct passphrase must not trip the #855 gate, got {:?}",
        out.joiner_events
    );
    // The same negative on the RESPONDER, which #3491 gave a local emit of its own.
    //
    // Note what this can and cannot catch, because the two are easy to confuse.
    // It CANNOT catch the emit policy going wrong: a correct passphrase means the
    // host never calls `reject` at all, so widening
    // `Rejection::user_facing_message` to `Some` for every variant leaves this
    // green (verified by trying it). The exhaustive policy check lives where it
    // can actually fail — `only_the_passphrase_rejection_is_shown_to_this_devices_own_user`
    // in `agaric-sync/src/sync_daemon/server.rs`, which does redden under that edit.
    //
    // What it DOES catch is the emit reaching a healthy host's sink at all: raised
    // from the session path or a future scheduler/announce path rather than from
    // `reject`, or `reject` itself being called here because the #855 proof gate
    // inverted. Both are real, and both would put a "wrong code" banner on a
    // successful pair. Neither is subtle — the assertions above would also fall
    // over — so read this as a cheap second net on a specific user-visible
    // symptom, not as the guard that makes the emit policy safe.
    assert!(
        !saw_error_containing_3507(&out.host_events, "pairing passphrase proof"),
        "#3491: the responder's local rejection emit must be reachable only through \
         `reject` — a correct passphrase must leave the host's own sink free of it, \
         got {:?}",
        out.host_events
    );

    // ── 4. The window closes behind a completed pair (#1519) ───────────
    assert!(
        !out.host_still_pending,
        "the host must clear its pending-pairing marker once it has bound the \
         joiner, so a later unpaired device cannot ride the same open window"
    );
}

/// #3507 (the failure path): a mistyped passphrase pairs NEITHER device, and
/// the device that dialled is told why.
///
/// # Why this is the #3469 harness
///
/// #3469 was "success announced the moment `confirm_pairing` returned, before
/// anything verified it". The driver asserts the premise directly — that call
/// returns `Ok` here, on a passphrase that is wrong — so this test is the
/// standing proof that `Ok` and "paired" are different facts. Any code that
/// closes the loop on the earlier one turns these assertions red.
///
/// # What is deliberately NOT asserted here
///
/// That the *host* surfaces the rejection to its own user. It now does (#3491:
/// `reject` raises the same message on the rejecting device's own event sink),
/// but that is the OTHER role's arm of this pair and it is asserted in its own
/// test below — this one is the dialler's view, and keeping the two apart is
/// what makes it visible that only one of them was ever red.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_mistyped_passphrase_pairs_neither_device_3507() {
    let out = drive_two_device_pairing_3507(false).await;

    assert!(
        out.host_row_for_joiner.is_none(),
        "#855: a device that could not prove it knows the passphrase must never be \
         bound, got {:?}",
        out.host_row_for_joiner
    );
    assert!(
        out.joiner_row_for_host.is_none(),
        "#3469: the joiner must not record a pairing it only *asked* for. \
         `confirm_pairing` returned Ok on a wrong passphrase — that Ok is a local \
         act, not an outcome. Got {:?}",
        out.joiner_row_for_host
    );
    assert!(
        out.host_block_on_joiner.is_none(),
        "a rejected session must move no state"
    );
    assert!(
        !saw_complete_3507(&out.joiner_events),
        "the joiner must not observe success, got {:?}",
        out.joiner_events
    );
    assert!(
        !saw_complete_3507(&out.host_events),
        "the host must not observe success, got {:?}",
        out.host_events
    );

    // The dialling device is told, in the responder's own words — so the UI can
    // say "wrong code" rather than falling through to a timeout that blames an
    // expired one.
    assert!(
        saw_error_containing_3507(
            &out.joiner_events,
            Rejection::PairingProofMissing.peer_message()
        ),
        "the device that dialled must observe the responder's rejection verbatim, \
         got {:?}",
        out.joiner_events
    );

    // A wrong guess must not consume the window: the user retypes.
    assert!(
        out.host_still_pending,
        "#855: a rejected attempt must leave the host's pairing window open"
    );
}

/// #3505/#3547: a refusal received while this device is mid-pairing is the
/// handshake working. It must not be booked as a sync failure — neither as a
/// "Sync failed" the user reads, nor as backoff the next dial has to wait out.
///
/// # Why this is one test and not two
///
/// The two issues describe one mis-classification seen from two distances.
/// `try_sync_with_peer`'s failure arm did exactly two things — emit
/// `SyncEvent::Error { "Sync failed: …" }` and `record_failure` — and a pairing
/// rejection reached both. #3505 is the first (a red toast on a device whose
/// user has not typed anything yet, at the moment they are being asked to trust
/// the flow); #3547 is the second (the backoff those doomed dials accumulate
/// then gates the single post-confirm dial that #3502's fix exists to make,
/// because `confirm_pairing`'s `notify_change()` is one wake and `may_retry`
/// simply skips it). Asserting them together is what says they are the same
/// bug.
///
/// # What it must NOT suppress, and how that is held
///
/// The responder's own words still reach the UI: the assertion in
/// `a_mistyped_passphrase_pairs_neither_device_3507` that the dialler observes
/// `PairingProofMissing.peer_message()` verbatim runs against this same driver,
/// so a fix that suppressed the rejection event itself — rather than only this
/// layer's generic wrapper around it — turns *that* test red. The two
/// assertions are deliberately in different tests for that reason: one says
/// "say this", the other says "and nothing else".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pairing_window_rejection_is_not_a_sync_failure_3505() {
    let out = drive_two_device_pairing_3507(false).await;

    assert_eq!(
        out.joiner_failures_against_host, 0,
        "#3547: the peer is not flaky, it is not paired yet. A failure booked here \
         doubles the per-peer backoff (2s → … → 60s), and the very next thing the \
         user does — typing the code — fires ONE `notify_change` wake that \
         `may_retry` then skips. Got {} consecutive failures",
        out.joiner_failures_against_host
    );

    assert!(
        !saw_error_containing_3507(&out.joiner_events, "Sync failed"),
        "#3505: a rejection during a pairing window must not be dressed up as a \
         failed sync. This is what reaches `notify.error` as a red \"Sync failed: \
         …\" toast on a device whose user has not typed a passphrase yet. Got {:?}",
        out.joiner_events
    );
}

/// The other half of the classification, and the half with teeth: the SAME
/// rejection, arriving when this device has no pairing window open, is still an
/// ordinary sync failure.
///
/// Without this, #3505's fix would pass just as well if the pairing-window
/// condition were dropped and every rejection excused — and the backoff exists
/// for a real reason (#278). A peer that says we are not paired, when we are not
/// mid-pairing, is precisely the peer that should not be dialled flat out.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rejection_outside_a_pairing_window_is_still_a_sync_failure_3505() {
    let out = drive_two_device_pairing_windowed_3507(true, false).await;

    // Precondition: the run really did end in a rejection. Without the joiner's
    // marker there is no proof to offer, so the host's #855 gate refuses it —
    // and if that ever stopped being true, the assertions below would pass for
    // the wrong reason.
    assert!(
        out.joiner_row_for_host.is_none() && out.host_row_for_joiner.is_none(),
        "precondition: a joiner with no marker offers no proof and must be refused"
    );

    assert_eq!(
        out.joiner_failures_against_host, 1,
        "outside a pairing window a refusal is ordinary evidence about a peer, and \
         must still advance the backoff"
    );
    assert!(
        saw_error_containing_3507(&out.joiner_events, "Sync failed"),
        "…and must still be surfaced as a failed sync, got {:?}",
        out.joiner_events
    );
}

/// #3491: the device that *rejects* a passphrase must surface the rejection to
/// its own user, not only to the peer.
///
/// # The sibling of the assertion above, and why the pair is the point
///
/// The test above pins the DIALLER's view: the initiator receives the
/// responder's rejection over the wire and its dialog can say "wrong code". That
/// arm passed before #3491 and still does. This arm is the same user-visible
/// outcome asked of the other role, and it is the one that was red: `reject`
/// sent the reason over the wire and logged it, and touched no event sink, so a
/// device learned of a mismatch only when it happened to be the side that
/// dialled. Which side dials first is daemon timing, not a user choice — so the
/// same mistyped passphrase produced a two-second error or a five-minute one
/// that blamed an expired code.
///
/// Both arms assert against the SAME string (`peer_message()`, which #3492 made
/// one constant shared with `PairingDialog.tsx`), because the frontend has one
/// matcher: if the local emit said anything else the dialog would ignore it, and
/// a test asserting merely "some error was emitted" would not notice.
///
/// It was previously `#[ignore]`d rather than written as an assertion of the
/// broken behaviour (`host_events.is_empty()`), which would have pinned the
/// defect and gone red on the fix. The `#[ignore]` comes off here.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_rejecting_device_surfaces_its_own_rejection_3491() {
    let out = drive_two_device_pairing_3507(false).await;

    assert!(
        saw_error_containing_3507(
            &out.host_events,
            Rejection::PairingProofMissing.peer_message()
        ),
        "#3491: the responder detected the mismatch, told the peer and logged it — \
         it must also tell its own user, got {:?}",
        out.host_events
    );
}

// ── #4230: bookkeeping keyed on an UNVERIFIED claimed device id ─────────────
//
// The responder has two branches. On the bound one, `handle_incoming_sync`
// resolves the peer through `get_peer_ref_by_endpoint_id` on the key the QUIC
// handshake authenticated and passes it as `expected_remote_id`, which the FSM
// takes verbatim. On the pairing one — no row for that key, and the caller
// proved the #855 passphrase — `expected_remote_id` is deliberately left unset,
// and the session is keyed on the first non-self **advertised head**: a claim.
//
// The session writes two things under that id BEFORE the bind check:
// `streamed_at`, and `loro_vv_bytes`, the export floor the NEXT session computes
// its incremental update from. The post-session bind already refuses to let a
// claim take over an already-bound peer's row (`peer_is_bound_to_another_key`);
// these tests began as being about the writes that run *before* that check.
//
// #4298 added a third, `remote_device_name`, and it sits AFTER the bind check —
// which turned out not to be enough on its own, because a write placed after a
// refusal is only safe if it reads the refusal. It did not, so a claimant could
// relabel the row the guard had just refused to re-bind. That is why these tests
// now also cover the write on the far side of the bind: the invariant is about
// the row, not about a position in the function.
//
// # Why the joiner's claim is seeded as a real op rather than a fabricated frame
//
// `make_local_edit_602` takes the authoring device id, so seeding the joiner's
// op_log with an op authored by the victim makes `get_local_heads` advertise the
// victim's head through the production initiator — no hand-built `HeadExchange`,
// no test-only wire path. That is also exactly the shape #2481 says is
// LEGITIMATE (a peer advertises the frontier of every device whose ops it
// holds), which is the reason the guard must skip the write rather than fail the
// session.

const HOST_DEV_4230: &str = "HOST4230";
const JOINER_DEV_4230: &str = "JOIN4230";
const VICTIM_DEV_4230: &str = "VICT4230";
const BOUND_DEV_4230: &str = "BOUND4230";
const HOST_BLOCK_4230: &str = "01HZ4230HBLKXXXXXXXXXXXXXX";
const JOINER_BLOCK_4230: &str = "01HZ4230JBLKXXXXXXXXXXXXXX";
const SPACE_4230: &str = "01HZ4230SPACEXXXXXXXXXXXXX";
const HOST_CONTENT_4230: &str = "seeded on the host (#4230)";

/// The victim's persisted export floor before the run.
///
/// Opaque bytes on purpose: `peer_refs.loro_vv_bytes` is a blob the store layer
/// takes no view of, and what matters here is byte-identity across the session,
/// not what it decodes to. A distinctive value beats "was NULL, still NULL"
/// because it also fails if the row is rewritten with something that merely
/// looks empty.
const VICTIM_FLOOR_4230: &[u8] = b"the real VICT4230's frontier (#4230)";

/// The name the victim's real device advertised in an earlier session, already
/// on its row when the claimant dials.
///
/// A distinctive pre-existing value for the same reason `VICTIM_FLOOR_4230` is
/// one: "was NULL, still NULL" would also be satisfied by a write that happened
/// to record nothing, and this column is the one the device list, the
/// sync-failure toast, the unpair dialog and the rename/address labels all fall
/// back to when the user has set no override of their own — which is the
/// default state (#4298).
const VICTIM_NAME_4230: &str = "the real VICT4230";

/// What the claimant advertises for itself: a name chosen to be indistinguishable
/// from the victim's in a device list, which is the point of overwriting it.
const CLAIMANT_NAME_4230: &str = "Javier's Laptop (SAFE)";

/// What one run left on the host, sampled either side of the session.
struct PairingClaimRun4230 {
    victim_before: Option<PeerRef>,
    victim_after: Option<PeerRef>,
    victim_vv_before: Option<Vec<u8>>,
    victim_vv_after: Option<Vec<u8>>,
    /// The host's row for the id the run is expected to key bookkeeping on, and
    /// its frontier. `None` when the host never wrote one.
    expected_after: Option<PeerRef>,
    expected_vv_after: Option<Vec<u8>>,
    host_events: Vec<SyncEvent>,
    joiner_events: Vec<SyncEvent>,
    /// The host's seeded block as projected into the joiner's `blocks` table —
    /// the settled reprojection, so "the session completed" is not asserted from
    /// a counter.
    host_block_on_joiner: Option<String>,
    host_still_pending: bool,
    joiner_key: String,
}

/// Drive one responder session against a host that already holds a **bound**
/// victim peer, and report what the host wrote.
///
/// * `joiner_head_device` — the device id the joiner's one seeded op is authored
///   by, i.e. the id its `HeadExchange` advertises and the responder's
///   `claimed_id` therefore resolves to.
/// * `prebind_joiner_as` — `Some(id)` binds the joiner's key to that peer row on
///   the host *before* the session, which puts the responder on the BOUND branch
///   (and leaves the host's pairing window closed, since nothing needs it).
///   `None` is the pairing branch: a window is armed and no row names the key.
/// * `expected_peer` — the id whose row the run is expected to key bookkeeping
///   on; its post-run row and frontier are returned for the caller to judge.
async fn drive_pairing_claim_4230(
    joiner_head_device: &str,
    prebind_joiner_as: Option<&str>,
    expected_peer: &str,
) -> PairingClaimRun4230 {
    let space = agaric_store::space::SpaceId::from_trusted(SPACE_4230);

    // ── The host: one already-paired peer, and content worth streaming ──
    let (host_pool, _host_dir) = test_pool().await;
    let host_mat = Materializer::new(host_pool.clone());
    let host_state = std::sync::Arc::clone(host_mat.loro_state());
    let host_sched = Arc::new(SyncScheduler::new());
    let host_sink = Arc::new(RecordingEventSink::new());

    // The victim is a settled peer: bound to ITS OWN key, with a stream stamp
    // and an export floor from an earlier session. Its key is a well-formed
    // endpoint id that belongs to nothing in this test, which is the point —
    // the attacker's key must not be it.
    let victim_key = mdns::test_endpoint_id(VICTIM_DEV_4230).to_string();
    peer_refs::upsert_peer_ref(&host_pool, VICTIM_DEV_4230)
        .await
        .unwrap();
    peer_refs::bind_endpoint_id(&host_pool, VICTIM_DEV_4230, &victim_key)
        .await
        .unwrap();
    {
        let mut tx = host_pool.begin().await.unwrap();
        peer_refs::update_on_stream_in_tx(&mut tx, VICTIM_DEV_4230)
            .await
            .unwrap();
        peer_refs::update_loro_vv_bytes_in_tx(&mut tx, VICTIM_DEV_4230, VICTIM_FLOOR_4230)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    // #4298: and the name its real device told the host it is called. The user
    // has set no override, so this is what every surface renders for it.
    peer_refs::update_remote_device_name(&host_pool, VICTIM_DEV_4230, Some(VICTIM_NAME_4230))
        .await
        .unwrap();

    make_local_edit_602(
        &host_pool,
        &host_mat,
        &host_state,
        HOST_DEV_4230,
        &space,
        HOST_BLOCK_4230,
        HOST_CONTENT_4230,
        1_736_942_400_000,
    )
    .await;

    // ── The joiner: one op, authored by whoever it is going to claim ────
    let (joiner_pool, _joiner_dir) = test_pool().await;
    let joiner_mat = Materializer::new(joiner_pool.clone());
    let joiner_state = std::sync::Arc::clone(joiner_mat.loro_state());
    let joiner_sched = Arc::new(SyncScheduler::new());
    let joiner_sink = Arc::new(RecordingEventSink::new());

    make_local_edit_602(
        &joiner_pool,
        &joiner_mat,
        &joiner_state,
        joiner_head_device,
        &space,
        JOINER_BLOCK_4230,
        "seeded on the joiner (#4230)",
        1_736_942_400_100,
    )
    .await;

    // The proof the initiator will offer is read from the joiner's OWN marker by
    // `session_state_machine::start`, so both sides arm the same passphrase.
    let proof = agaric_sync::pairing::pairing_proof("the pairing passphrase 4230");
    peer_refs::set_pending_pairing(&joiner_pool, &proof)
        .await
        .unwrap();

    // #4298: the joiner advertises a device name in its `HeadExchange` — read by
    // the production initiator off its own `app_settings`, so the name travels
    // the real path rather than a hand-built frame. Without it the claim run
    // exercises the id-keyed writes but never reaches the name write at all, and
    // a hole there would be invisible to this whole family of tests.
    peer_refs::set_local_device_name(&joiner_pool, CLAIMANT_NAME_4230)
        .await
        .unwrap();

    // ── Two real endpoints: the host serves, the joiner dials ───────────
    let harness = ServiceHarness::new().await;
    let joiner_key = client_key(&harness);
    assert_ne!(
        joiner_key, victim_key,
        "the fixture must hand the joiner a key that is not the victim's, or the \
         whole question — may a claim be keyed on another device's row — cannot arise"
    );

    if let Some(peer_id) = prebind_joiner_as {
        bind_client_as(&host_pool, peer_id, &harness).await;
    } else {
        peer_refs::set_pending_pairing(&host_pool, &proof)
            .await
            .unwrap();
        assert!(
            peer_refs::get_peer_ref_by_endpoint_id(&host_pool, &joiner_key)
                .await
                .unwrap()
                .is_none(),
            "precondition: the pairing branch is the one where NO row names the \
             dialling key"
        );
    }

    let victim_before = peer_refs::get_peer_ref(&host_pool, VICTIM_DEV_4230)
        .await
        .unwrap();
    let victim_vv_before = peer_refs::get_loro_vv_bytes(&host_pool, VICTIM_DEV_4230)
        .await
        .unwrap();
    assert!(
        victim_before
            .as_ref()
            .is_some_and(|r| r.streamed_at.is_some()),
        "precondition: the victim must carry a stream stamp to be robbed of"
    );
    assert_eq!(
        victim_before
            .as_ref()
            .and_then(|r| r.remote_device_name.as_deref()),
        Some(VICTIM_NAME_4230),
        "precondition: the victim must carry the name its real device advertised, or \
         `assert_victim_untouched_4230` cannot tell an overwrite from a no-op (#4298)"
    );

    // ── The responder: production `handle_incoming_sync` on the host ────
    let host_sink_dyn: Arc<dyn SyncEventSink> = host_sink.clone();
    let host_task = spawn_responder(
        &harness,
        host_pool.clone(),
        HOST_DEV_4230,
        host_mat.clone(),
        host_sched.clone(),
        host_sink_dyn,
        Arc::new(AtomicBool::new(false)),
    );

    // ── The initiator: production `try_sync_with_peer` on the joiner ────
    let joiner_sink_dyn: Arc<dyn SyncEventSink> = joiner_sink.clone();
    let joiner_apply: Arc<dyn agaric_sync::apply_host::ApplyHost> =
        std::sync::Arc::new(joiner_mat.clone());
    let joiner_cancel = AtomicBool::new(false);
    let ctx = SyncSessionContext {
        pool: &joiner_pool,
        device_id: JOINER_DEV_4230,
        materializer: &joiner_apply,
        scheduler: &joiner_sched,
        event_sink: &joiner_sink_dyn,
        cancel: &joiner_cancel,
        endpoint: &harness.client_endpoint,
    };
    let peer = discovered_service_peer(HOST_DEV_4230, &harness);
    let was_cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        try_sync_with_peer(&ctx, &peer, &[]),
    )
    .await
    .expect("try_sync_with_peer must finish inside its own connect budget");
    assert!(!was_cancelled, "no cancel is issued in this test");

    let host_result = tokio::time::timeout(std::time::Duration::from_secs(40), host_task)
        .await
        .expect("the responder must resolve once the initiator's session ends")
        .expect("the responder task must not panic");
    assert!(
        host_result.is_ok(),
        "handle_incoming_sync must return Ok, got {host_result:?}"
    );

    let out = PairingClaimRun4230 {
        victim_before,
        victim_after: peer_refs::get_peer_ref(&host_pool, VICTIM_DEV_4230)
            .await
            .unwrap(),
        victim_vv_before,
        victim_vv_after: peer_refs::get_loro_vv_bytes(&host_pool, VICTIM_DEV_4230)
            .await
            .unwrap(),
        expected_after: peer_refs::get_peer_ref(&host_pool, expected_peer)
            .await
            .unwrap(),
        expected_vv_after: peer_refs::get_loro_vv_bytes(&host_pool, expected_peer)
            .await
            .unwrap(),
        host_events: host_sink.events(),
        joiner_events: joiner_sink.events(),
        host_block_on_joiner: sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(HOST_BLOCK_4230)
            .fetch_optional(&joiner_pool)
            .await
            .unwrap(),
        host_still_pending: peer_refs::is_pending_pairing(&host_pool).await.unwrap(),
        joiner_key,
    };

    host_mat.shutdown();
    joiner_mat.shutdown();
    out
}

/// Assert the run left the victim's row byte-for-byte as it found it.
///
/// The columns are collected rather than asserted one at a time so a failure
/// reports the WHOLE of the damage. The issue names two writes and ranks them
/// the other way round from the order a reader meets them — `loro_vv_bytes` is
/// the export floor, so poisoning it is a data-correctness problem, where
/// `streamed_at` costs a few suppressed toasts — and a short-circuiting
/// `assert_eq!` chain would show only the first.
///
/// # The `damage` vector is this guard's surface, and it has to grow
///
/// This function is what #4230's invariant — *a session keyed on a CLAIMED
/// device id must write nothing to the row that id names* — actually consists
/// of. It is not a statement about `peer_refs`; it is a statement about the
/// columns listed below, and it says nothing whatsoever about a column that is
/// missing from them.
///
/// #4298 proved that the hard way. It added `remote_device_name` and a write
/// near the bind point that was reachable on the refused-bind path, and every
/// test in this family stayed green — because the vector listed three columns
/// and the new one was not among them. **Whenever a column is added to
/// `peer_refs` and written anywhere around the bind, add it here**, and make
/// sure the fixture actually drives a value into it (see
/// `CLAIMANT_NAME_4230`): a column the run never supplies a value for cannot
/// fail this assertion however wrong the production code is.
fn assert_victim_untouched_4230(out: &PairingClaimRun4230) {
    let before = out
        .victim_before
        .as_ref()
        .expect("fixture: the victim row exists before the session");
    let after = out
        .victim_after
        .as_ref()
        .expect("the victim row must survive the session");

    let mut damage: Vec<String> = Vec::new();
    if out.victim_vv_after.as_deref() != out.victim_vv_before.as_deref() {
        damage.push(format!(
            "`loro_vv_bytes` was rewritten ({:?} -> {:?}): it is the export floor the \
             NEXT session computes its incremental update from, so another device's \
             floor replaced by a frontier that device never held makes the next sync \
             ship a delta from a baseline the peer does not have",
            out.victim_vv_before, out.victim_vv_after
        ));
    }
    if after.streamed_at != before.streamed_at {
        damage.push(format!(
            "`streamed_at` was re-stamped ({:?} -> {:?}): #4203's refusal-suppression \
             gate reads this column as evidence that the device holding the PINNED key \
             streamed to us",
            before.streamed_at, after.streamed_at
        ));
    }
    if after.endpoint_id != before.endpoint_id {
        damage.push(format!(
            "the binding moved ({:?} -> {:?}), which #800's post-session check is \
             supposed to refuse outright",
            before.endpoint_id, after.endpoint_id
        ));
    }
    if after.remote_device_name != before.remote_device_name {
        damage.push(format!(
            "`remote_device_name` was rewritten ({:?} -> {:?}): #4298 makes this the \
             name the device list, the sync-failure toast, the unpair dialog and the \
             rename/address labels all render for a peer whenever the user has set no \
             override — the default — so a claimant that can write it here relabels a \
             legitimately paired device in the user's own UI",
            before.remote_device_name, after.remote_device_name
        ));
    }
    if after.device_name != before.device_name {
        damage.push(format!(
            "`device_name`, the USER'S override, was rewritten ({:?} -> {:?}); nothing \
             on the wire may ever touch that column",
            before.device_name, after.device_name
        ));
    }
    assert!(
        damage.is_empty(),
        "#4230: a session keyed on a CLAIMED device id must write nothing to the row \
         that id names. Damage:\n  - {}",
        damage.join("\n  - ")
    );
}

/// #4230 (the acceptance test): a device that proves the pairing passphrase and
/// advertises an ALREADY-PAIRED peer's device id as its head must not have the
/// session's bookkeeping stamped on that peer's row.
///
/// # What makes this reachable
///
/// Only the pairing branch. A bound peer is resolved through the authenticated
/// key and passed as `expected_remote_id`, which the FSM prefers over the heads;
/// during a pairing window there is no row to resolve, so the daemon leaves it
/// unset and the claim is all there is. The passphrase and the 5-minute window
/// are the price of entry — this is a narrow hole, not an open one, and it is
/// inside a window the user deliberately opened.
///
/// # Why the session is still required to complete
///
/// Because "nothing was written" is trivially true of a session that failed, and
/// that would be a fix worse than the bug — #2481 makes advertising another
/// device's frontier a legitimate thing for a joiner to do. The completion
/// assertions are what stop this test from passing for the wrong reason, and the
/// legitimate-pairing test below is what stops the guard from being a blanket
/// refusal.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pairing_claim_on_a_bound_peers_id_writes_no_bookkeeping_4230() {
    let out = drive_pairing_claim_4230(VICTIM_DEV_4230, None, VICTIM_DEV_4230).await;

    // The session really ran: the host streamed, the joiner applied, both saw a
    // terminal Complete. Without this the assertions below could be satisfied by
    // a responder that refused the connection outright.
    assert!(
        saw_complete_3507(&out.host_events),
        "the host must still complete the session — the guard skips a write, it does \
         not fail a peer that advertised a frontier it legitimately holds. Got {:?}",
        out.host_events
    );
    assert!(
        saw_complete_3507(&out.joiner_events),
        "the joiner must still complete the session, got {:?}",
        out.joiner_events
    );
    assert_eq!(
        out.host_block_on_joiner.as_deref(),
        Some(HOST_CONTENT_4230),
        "the host's block must have reached the joiner — the session moved state, \
         so the bookkeeping site really was reached"
    );

    assert_victim_untouched_4230(&out);

    // The binding was already protected (#800's `peer_is_bound_to_another_key`);
    // this pins that the fix did not have to relax it to skip the writes.
    assert_ne!(
        out.victim_after
            .as_ref()
            .and_then(|r| r.endpoint_id.clone())
            .as_deref(),
        Some(out.joiner_key.as_str()),
        "the claimant must never end up bound as the victim"
    );
    assert!(
        out.host_still_pending,
        "a session that bound nothing does not consume the pairing window — the \
         real device the user is pairing must still be able to arrive"
    );
}

/// The symmetric arm, and the one a blanket refusal would fail: a LEGITIMATE
/// joiner — same pairing window, same passphrase, advertising its OWN device id
/// — still completes the pair and still records its own bookkeeping.
///
/// A fix that protected the victim by declining to write anything during a
/// pairing window would leave the first post-pair session with no `streamed_at`
/// and no export floor, so every subsequent session re-ships full snapshots
/// (#2502's churn, restored) and the device list reads "never synced" for a
/// device that just paired (#4084/#4103). This is where that hides.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_legitimate_pairing_still_records_its_own_bookkeeping_4230() {
    let out = drive_pairing_claim_4230(JOINER_DEV_4230, None, JOINER_DEV_4230).await;

    let row = out
        .expected_after
        .as_ref()
        .expect("the host must end with a peer_refs row for the joiner it just paired with");
    assert_eq!(
        row.endpoint_id.as_deref(),
        Some(out.joiner_key.as_str()),
        "…pinned to the key the joiner's QUIC handshake authenticated"
    );
    assert!(
        row.streamed_at.is_some(),
        "#4084/#4103: the host streamed to the joiner this session, so the joiner's \
         row must carry the stamp — a paired device that reads 'never synced' is \
         the bug that column exists to close"
    );
    assert!(
        out.expected_vv_after.is_some(),
        "#2502: the joiner's advertised frontier must be persisted as the export \
         floor, or the next session re-ships a full snapshot per space"
    );
    assert_eq!(
        row.remote_device_name.as_deref(),
        Some(CLAIMANT_NAME_4230),
        "#4298: and the name it advertised must be recorded on the row it just bound. \
         This is the half the guard must NOT cost: the gate is on having been \
         authenticated as this id, and a joiner that binds has been — so the very \
         first session after a pair names the device, instead of leaving the user \
         looking at a truncated UUID until they rename it by hand"
    );
    assert!(
        !out.host_still_pending,
        "#1519: a completed pair closes the window behind it"
    );
    assert_eq!(
        out.host_block_on_joiner.as_deref(),
        Some(HOST_CONTENT_4230),
        "and the pair converged"
    );

    // The victim is a bystander to a legitimate pairing, and stays one.
    assert_victim_untouched_4230(&out);
}

/// The bound-peer branch, which this change must not disturb.
///
/// The joiner's key is already bound as `BOUND4230`, so `handle_incoming_sync`
/// resolves the row through the AUTHENTICATED key and passes it as
/// `expected_remote_id` — and the FSM takes that verbatim in preference to the
/// heads. The joiner nonetheless advertises the victim's head, so this run also
/// says what the bound branch does with a claim: nothing. The identity that
/// counts is the one the handshake proved, the bookkeeping lands on `BOUND4230`,
/// and the guard is inert here (it is never armed on this branch).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_bound_branch_keys_bookkeeping_on_the_authenticated_row_4230() {
    let out = drive_pairing_claim_4230(VICTIM_DEV_4230, Some(BOUND_DEV_4230), BOUND_DEV_4230).await;

    let row = out
        .expected_after
        .as_ref()
        .expect("the bound peer's row must survive its own session");
    assert!(
        row.streamed_at.is_some(),
        "the bound branch must still stamp the row the authenticated key resolves \
         to — this is the path #4203's suppression gate reads, and it is sound \
         precisely because it is keyed on the handshake, not on a claim"
    );
    assert!(
        out.expected_vv_after.is_some(),
        "…and must still persist the peer's advertised export floor"
    );
    assert!(
        saw_complete_3507(&out.host_events),
        "the bound session must complete, got {:?}",
        out.host_events
    );

    // The head it advertised named the victim; `expected_remote_id` outranked it.
    assert_victim_untouched_4230(&out);
}

/// #4298 — the responder records the name the initiator advertised, clamps it,
/// and does not touch the name the user set by hand.
///
/// This is the whole user-visible fix driven through the real admission path.
/// Before it, `device_name` appeared nowhere in the wire protocol, so a freshly
/// paired peer rendered as `truncateId(peer_id)` — `e3d48f0a-45a…` — on both
/// devices until the user renamed it separately on each.
///
/// Three things are pinned here that the store-level tests cannot reach:
///
/// * the name survives the frame boundary and reaches `peer_refs` at all;
/// * it is re-clamped **on receive**. The sender clamps too, but the sender is
///   an untrusted remote and a hostile one simply would not — so the bound has
///   to be re-applied by the side that has to render it;
/// * `device_name` is untouched. A peer whose next sync could overwrite the
///   user's rename would silently undo it, which is the outcome the two-column
///   design exists to prevent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handle_incoming_sync_records_the_peer_supplied_device_name_4298() {
    const REMOTE: &str = "REMOTE4298";

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());
    let scheduler = Arc::new(SyncScheduler::new());
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let harness = ServiceHarness::new().await;
    bind_client_as(&pool, REMOTE, &harness).await;
    // The user has already renamed this peer on THIS device. That override must
    // outrank whatever the peer calls itself.
    peer_refs::update_device_name(&pool, REMOTE, Some("Javier's Phone"))
        .await
        .unwrap();

    let handle = spawn_responder(
        &harness,
        pool.clone(),
        "LOCAL_DEV",
        materializer.clone(),
        scheduler,
        event_sink,
        Arc::new(AtomicBool::new(false)),
    );

    let mut client = harness.dial().await;
    send_sync_message(
        &mut client.send,
        &SyncMessage::HeadExchange {
            heads: vec![fake_head(REMOTE)],
            loro_vvs: vec![],
            engine_format_version: agaric_engine::loro::engine::ENGINE_FORMAT_VERSION,
            op_log_replication: false,
            op_log_batch_chunked: false,
            pairing_proof: None,
            // Deliberately over-long: a peer can put anything in this field.
            device_name: Some("p".repeat(200)),
        },
    )
    .await
    .unwrap();

    // Empty registry on both sides, so the responder short-circuits straight to
    // `SyncComplete` with nothing to stream.
    let response = recv_sync_message(&mut client.recv).await.unwrap();
    assert!(
        matches!(response, SyncMessage::SyncComplete { .. }),
        "an empty-registry session must short-circuit to SyncComplete, got {response:?}"
    );

    close_and_join_ok(client, handle).await;

    let peer = peer_refs::get_peer_ref(&pool, REMOTE)
        .await
        .unwrap()
        .expect("the peer row must survive the session");
    let recorded = peer
        .remote_device_name
        .expect("#4298: the responder must record the name the peer advertised");
    assert_eq!(
        recorded.chars().count(),
        64,
        "the receiving side must re-clamp — the sender's clamp is not a bound this \
         device may rely on"
    );
    assert_eq!(recorded, "p".repeat(64));
    assert_eq!(
        peer.device_name.as_deref(),
        Some("Javier's Phone"),
        "a peer-supplied name must never overwrite the user's own rename"
    );

    materializer.shutdown();
}
