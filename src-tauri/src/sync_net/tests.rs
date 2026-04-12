use super::tls::{AllowAnyCert, PinningCertVerifier};
use super::*;
use crate::sync_protocol::{DeviceHead, OpTransfer, SyncMessage};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

// -- 1. Certificate generation ----------------------------------------

#[test]
fn generate_cert_produces_valid_pem() {
    let cert = generate_self_signed_cert("test-device-1").unwrap();
    assert!(
        cert.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"),
        "cert PEM should start with the standard header"
    );
    assert!(
        cert.key_pem.starts_with("-----BEGIN PRIVATE KEY-----"),
        "key PEM should start with the standard header"
    );
}

#[test]
fn generate_cert_hash_is_hex_sha256() {
    let cert = generate_self_signed_cert("test-device-2").unwrap();
    assert_eq!(
        cert.cert_hash.len(),
        64,
        "SHA-256 hex digest should be 64 characters"
    );
    assert!(
        cert.cert_hash.chars().all(|c| c.is_ascii_hexdigit()),
        "cert_hash should contain only hex digits"
    );
}

#[test]
fn generate_cert_different_device_ids_produce_different_certs() {
    let a = generate_self_signed_cert("device-a").unwrap();
    let b = generate_self_signed_cert("device-b").unwrap();
    assert_ne!(
        a.cert_hash, b.cert_hash,
        "different device IDs should produce different certs"
    );
}

// -- 2. SyncMessage round-trips ---------------------------------------

#[test]
fn sync_message_roundtrip_head_exchange() {
    let msg = SyncMessage::HeadExchange {
        heads: vec![DeviceHead {
            device_id: "dev-1".into(),
            seq: 42,
            hash: "abc123".into(),
        }],
    };
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
    match parsed {
        SyncMessage::HeadExchange { heads } => {
            assert_eq!(heads.len(), 1);
            assert_eq!(heads[0].device_id, "dev-1");
            assert_eq!(heads[0].seq, 42);
        }
        other => panic!("expected HeadExchange, got {other:?}"),
    }
}

#[test]
fn sync_message_roundtrip_op_batch() {
    let msg = SyncMessage::OpBatch {
        ops: vec![OpTransfer {
            device_id: "dev-1".into(),
            seq: 1,
            parent_seqs: Some("0".into()),
            hash: "h1".into(),
            op_type: "create_block".into(),
            payload: "{}".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
        }],
        is_last: true,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
    match parsed {
        SyncMessage::OpBatch { ops, is_last } => {
            assert_eq!(ops.len(), 1);
            assert_eq!(ops[0].op_type, "create_block");
            assert!(is_last);
        }
        other => panic!("expected OpBatch, got {other:?}"),
    }
}

#[test]
fn sync_message_roundtrip_reset_required() {
    let msg = SyncMessage::ResetRequired {
        reason: "hash divergence".into(),
    };
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
    match parsed {
        SyncMessage::ResetRequired { reason } => {
            assert_eq!(reason, "hash divergence");
        }
        other => panic!("expected ResetRequired, got {other:?}"),
    }
}

#[test]
fn sync_message_roundtrip_sync_complete() {
    let msg = SyncMessage::SyncComplete {
        last_hash: "aaa".into(),
    };
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
    match parsed {
        SyncMessage::SyncComplete { last_hash } => {
            assert_eq!(last_hash, "aaa");
        }
        other => panic!("expected SyncComplete, got {other:?}"),
    }
}

// -- 3. mDNS helpers --------------------------------------------------

#[test]
fn parse_service_event_returns_none_for_non_resolved() {
    // ServiceFound carries (service_type, fullname) – not enough info.
    let event = mdns_sd::ServiceEvent::ServiceFound(
        "_agaric._tcp.local.".into(),
        "test._agaric._tcp.local.".into(),
    );
    assert!(
        parse_service_event(event).is_none(),
        "non-Resolved events should return None"
    );
}

// -- 4. DiscoveredPeer fields -----------------------------------------

#[test]
fn discovered_peer_fields() {
    let peer = DiscoveredPeer {
        device_id: "abc-123".into(),
        addresses: vec!["192.168.1.5".parse().unwrap()],
        port: 9876,
    };
    assert_eq!(peer.device_id, "abc-123");
    assert_eq!(peer.addresses.len(), 1);
    assert_eq!(peer.port, 9876);
}

// -- 5. Server / client round-trip ------------------------------------

// Integration test: requires running server — tested in sync_integration_tests.rs
//
// A full TLS+WS round-trip test is deferred because it needs the
// tokio multi-thread runtime and careful shutdown sequencing that is
// better exercised in a dedicated integration-test file.

// -- 6. Additional coverage -------------------------------------------

/// Validate the mDNS service type follows RFC 6763:
/// `_<service>._tcp.local.` with lowercase alphanumeric + hyphen.
#[test]
fn mdns_service_type_follows_rfc6763() {
    // Must start with '_', contain '._tcp.local.' or '._udp.local.'
    assert!(
        MDNS_SERVICE_TYPE.starts_with('_'),
        "service type must start with '_'"
    );
    assert!(
        MDNS_SERVICE_TYPE.contains("._tcp.local.") || MDNS_SERVICE_TYPE.contains("._udp.local."),
        "service type must use _tcp or _udp transport"
    );
    // Service name part (between first _ and ._tcp) must be <= 15 chars
    // and only contain [a-z0-9-]
    let service_name = MDNS_SERVICE_TYPE
        .strip_prefix('_')
        .unwrap()
        .split("._tcp")
        .next()
        .unwrap();
    assert!(
        service_name.len() <= 15,
        "service name '{service_name}' must be <= 15 characters (RFC 6763 §7.2)"
    );
    assert!(
        service_name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "service name must only contain [a-z0-9-], got '{service_name}'"
    );
}

/// mDNS announce/browse lifecycle test is skipped in unit tests because
/// it requires binding to a real multicast socket on the host network,
/// which is not available in sandboxed CI environments.
///
/// The lifecycle is exercised in manual integration testing and the
/// dedicated `sync_integration_tests.rs` module.
#[test]
fn mdns_lifecycle_skipped_explanation() {
    // This test documents why mDNS announce/browse is not unit-tested.
    // See sync_integration_tests.rs for the full lifecycle test.
}

/// Verify the browse timeout constant is 5 seconds.
#[test]
fn mdns_browse_timeout_is_5_seconds() {
    assert_eq!(
        MDNS_BROWSE_TIMEOUT,
        Duration::from_secs(5),
        "mDNS browse timeout should be 5s per SYNC-PLATFORM-NOTES.md"
    );
}

/// Verify `SyncMessage::Error` serialisation round-trip.
#[test]
fn sync_message_roundtrip_error() {
    let msg = SyncMessage::Error {
        message: "unexpected protocol state".into(),
    };
    let json = serde_json::to_string(&msg).unwrap();
    let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
    match parsed {
        SyncMessage::Error { message } => {
            assert_eq!(message, "unexpected protocol state");
        }
        other => panic!("expected Error, got {other:?}"),
    }
}

// -- 7. Integration network tests -------------------------------------

/// Install the `ring` CryptoProvider for rustls (idempotent).
fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tls_roundtrip_json_exchange() {
    install_crypto_provider();
    let cert = generate_self_signed_cert("test-device").unwrap();
    let client_cert = generate_self_signed_cert("client-device").unwrap();

    // Start server
    let (server, port) = SyncServer::start(&cert, |mut conn| {
        tokio::spawn(async move {
            // Server: receive a message and echo it back
            let msg: SyncMessage = conn.recv_json().await.unwrap();
            conn.send_json(&msg).await.unwrap();
            conn.close().await.ok();
        });
    })
    .await
    .unwrap();

    // Connect client (no cert pinning)
    let mut client = connect_to_peer(&format!("127.0.0.1:{port}"), None, &client_cert)
        .await
        .unwrap();

    // Send a HeadExchange message
    let msg = SyncMessage::HeadExchange {
        heads: vec![DeviceHead {
            device_id: "dev-A".into(),
            seq: 42,
            hash: "abc123".into(),
        }],
    };
    client.send_json(&msg).await.unwrap();

    // Receive echo
    let response: SyncMessage = client.recv_json().await.unwrap();
    assert_eq!(response, msg, "server should echo the message back");

    client.close().await.ok();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cert_pinning_correct_hash_succeeds() {
    install_crypto_provider();
    let cert = generate_self_signed_cert("pin-test").unwrap();
    let client_cert = generate_self_signed_cert("client-pin-test").unwrap();
    let expected_hash = cert.cert_hash.clone();

    let (server, port) = SyncServer::start(&cert, |_conn| {}).await.unwrap();

    // Connect with correct hash
    let conn = connect_to_peer(
        &format!("127.0.0.1:{port}"),
        Some(&expected_hash),
        &client_cert,
    )
    .await;
    assert!(
        conn.is_ok(),
        "connection with correct cert hash should succeed"
    );

    // Verify the peer cert hash matches
    let conn = conn.unwrap();
    assert_eq!(
        conn.peer_cert_hash().as_deref(),
        Some(expected_hash.as_str()),
        "peer cert hash should match the server's cert hash"
    );

    conn.close().await.ok();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cert_pinning_wrong_hash_fails() {
    install_crypto_provider();
    let cert = generate_self_signed_cert("pin-fail").unwrap();
    let client_cert = generate_self_signed_cert("client-pin-fail").unwrap();

    let (server, port) = SyncServer::start(&cert, |_conn| {}).await.unwrap();

    // Connect with wrong hash
    let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";
    let result =
        connect_to_peer(&format!("127.0.0.1:{port}"), Some(wrong_hash), &client_cert).await;
    assert!(
        result.is_err(),
        "connection with wrong cert hash should fail"
    );

    let Err(err) = result else {
        unreachable!("already asserted is_err")
    };
    let err_msg = err.to_string();
    assert!(
        err_msg.contains("cert")
            || err_msg.contains("hash")
            || err_msg.contains("tls")
            || err_msg.contains("TLS")
            || err_msg.contains("alert"),
        "error should mention cert/hash/tls issue, got: {err_msg}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_refused_returns_error() {
    install_crypto_provider();
    let client_cert = generate_self_signed_cert("conn-refused").unwrap();
    // Use a port that's almost certainly not listening
    let result = connect_to_peer("127.0.0.1:1", None, &client_cert).await;
    assert!(result.is_err(), "connection to closed port should fail");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_message_roundtrip() {
    install_crypto_provider();
    let cert = generate_self_signed_cert("binary-test").unwrap();
    let client_cert = generate_self_signed_cert("client-binary-test").unwrap();

    let (server, port) = SyncServer::start(&cert, |mut conn| {
        tokio::spawn(async move {
            let data = conn.recv_binary().await.unwrap();
            conn.send_binary(&data).await.unwrap();
            conn.close().await.ok();
        });
    })
    .await
    .unwrap();

    let mut client = connect_to_peer(&format!("127.0.0.1:{port}"), None, &client_cert)
        .await
        .unwrap();

    let payload = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x42];
    client.send_binary(&payload).await.unwrap();

    let response = client.recv_binary().await.unwrap();
    assert_eq!(response, payload, "binary data should roundtrip correctly");

    client.close().await.ok();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peer_cert_hash_populated_on_client() {
    install_crypto_provider();
    let cert = generate_self_signed_cert("hash-capture").unwrap();
    let client_cert = generate_self_signed_cert("client-hash-capture").unwrap();

    let (server, port) = SyncServer::start(&cert, |_conn| {}).await.unwrap();

    let conn = connect_to_peer(&format!("127.0.0.1:{port}"), None, &client_cert)
        .await
        .unwrap();
    let hash = conn.peer_cert_hash();
    assert!(hash.is_some(), "client should capture peer cert hash");
    assert_eq!(
        hash.unwrap(),
        cert.cert_hash,
        "captured hash should match server cert"
    );

    conn.close().await.ok();
    server.shutdown().await;
}

// -- 8. CN verification (S-2) -----------------------------------------

#[test]
fn cn_verification_accepts_valid_agaric_cert() {
    install_crypto_provider();
    let cert = generate_self_signed_cert("test-device").unwrap();
    let cert_der = pem_to_der(&cert.cert_pem).unwrap();

    let verifier = PinningCertVerifier {
        expected_hash: Some(cert.cert_hash.clone()),
        observed_hash: Arc::new(std::sync::Mutex::new(None)),
    };

    let ee = rustls::pki_types::CertificateDer::from(cert_der);
    let server_name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    let now = rustls::pki_types::UnixTime::now();

    let result = rustls::client::danger::ServerCertVerifier::verify_server_cert(
        &verifier,
        &ee,
        &[],
        &server_name,
        &[],
        now,
    );
    assert!(
        result.is_ok(),
        "valid agaric-* CN should pass verification, got: {result:?}"
    );
}

#[test]
fn cn_verification_rejects_non_agaric_cn() {
    install_crypto_provider();
    use rcgen::{CertificateParams, DnType, KeyPair};

    // Generate a cert with a CN that does NOT start with "agaric-"
    let key_pair = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec!["localhost".to_string()]).unwrap();
    params
        .distinguished_name
        .push(DnType::CommonName, "malicious-cert".to_string());
    let bad_cert = params.self_signed(&key_pair).unwrap();
    let bad_der = bad_cert.der().to_vec();

    // Compute hash so the hash check passes
    let hash = Sha256::digest(&bad_der);
    let hex_hash: String = hash.iter().map(|b| format!("{b:02x}")).collect();

    let verifier = PinningCertVerifier {
        expected_hash: Some(hex_hash),
        observed_hash: Arc::new(std::sync::Mutex::new(None)),
    };

    let ee = rustls::pki_types::CertificateDer::from(bad_der);
    let server_name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    let now = rustls::pki_types::UnixTime::now();

    let result = rustls::client::danger::ServerCertVerifier::verify_server_cert(
        &verifier,
        &ee,
        &[],
        &server_name,
        &[],
        now,
    );
    assert!(result.is_err(), "non-agaric CN should be rejected");
    let err_msg = format!("{:?}", result.unwrap_err());
    assert!(
        err_msg.contains("CN does not match"),
        "error should mention CN mismatch, got: {err_msg}"
    );
}

#[test]
fn cn_verification_rejects_unparseable_cert() {
    install_crypto_provider();

    let verifier = PinningCertVerifier {
        expected_hash: None,
        observed_hash: Arc::new(std::sync::Mutex::new(None)),
    };

    // Garbage DER bytes that cannot be parsed as X.509
    let garbage = vec![0xDE, 0xAD, 0xBE, 0xEF];
    let ee = rustls::pki_types::CertificateDer::from(garbage);
    let server_name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    let now = rustls::pki_types::UnixTime::now();

    let result = rustls::client::danger::ServerCertVerifier::verify_server_cert(
        &verifier,
        &ee,
        &[],
        &server_name,
        &[],
        now,
    );
    assert!(result.is_err(), "unparseable cert should be rejected");
    let err_msg = format!("{:?}", result.unwrap_err());
    assert!(
        err_msg.contains("failed to parse certificate"),
        "error should mention parse failure, got: {err_msg}"
    );
}

// -- 9. mTLS peer certificate extraction (B-33 / B-34) ----------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mtls_server_extracts_peer_cert_hash() {
    install_crypto_provider();
    let server_cert = generate_self_signed_cert("server-device").unwrap();
    let client_cert = generate_self_signed_cert("client-device").unwrap();
    let expected_client_hash = client_cert.cert_hash.clone();

    let (hash_tx, hash_rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let hash_tx = std::sync::Mutex::new(Some(hash_tx));

    let (server, port) = SyncServer::start(&server_cert, move |conn| {
        if let Some(tx) = hash_tx.lock().unwrap().take() {
            let _ = tx.send(conn.peer_cert_hash());
        }
    })
    .await
    .unwrap();

    // Connect client with its cert (mTLS)
    let conn = connect_to_peer(&format!("127.0.0.1:{port}"), None, &client_cert)
        .await
        .unwrap();

    // Wait for server to receive the connection and extract the hash
    let server_observed_hash = tokio::time::timeout(std::time::Duration::from_secs(5), hash_rx)
        .await
        .expect("timeout waiting for server")
        .expect("channel closed");

    assert_eq!(
        server_observed_hash.as_deref(),
        Some(expected_client_hash.as_str()),
        "server should extract the client's cert hash via mTLS"
    );

    conn.close().await.ok();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mtls_server_extracts_peer_cert_cn() {
    install_crypto_provider();
    let server_cert = generate_self_signed_cert("server-device").unwrap();
    let client_cert = generate_self_signed_cert("my-client-id").unwrap();

    let (cn_tx, cn_rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let cn_tx = std::sync::Mutex::new(Some(cn_tx));

    let (server, port) = SyncServer::start(&server_cert, move |conn| {
        if let Some(tx) = cn_tx.lock().unwrap().take() {
            let _ = tx.send(conn.peer_cert_cn().map(String::from));
        }
    })
    .await
    .unwrap();

    let conn = connect_to_peer(&format!("127.0.0.1:{port}"), None, &client_cert)
        .await
        .unwrap();

    let server_observed_cn = tokio::time::timeout(std::time::Duration::from_secs(5), cn_rx)
        .await
        .expect("timeout waiting for server")
        .expect("channel closed");

    assert_eq!(
        server_observed_cn.as_deref(),
        Some("my-client-id"),
        "server should extract device ID from client cert CN (agaric-my-client-id → my-client-id)"
    );

    conn.close().await.ok();
    server.shutdown().await;
}

// -- 10. AllowAnyCert verifier tests -----------------------------------

#[test]
fn allow_any_cert_offers_but_does_not_mandate_client_auth() {
    let verifier = AllowAnyCert;
    assert!(
        rustls::server::danger::ClientCertVerifier::offer_client_auth(&verifier),
        "AllowAnyCert must offer client auth"
    );
    assert!(
        !rustls::server::danger::ClientCertVerifier::client_auth_mandatory(&verifier),
        "AllowAnyCert must NOT mandate client auth (pairing connections)"
    );
}

#[test]
fn allow_any_cert_root_hints_empty() {
    let verifier = AllowAnyCert;
    assert!(
        rustls::server::danger::ClientCertVerifier::root_hint_subjects(&verifier).is_empty(),
        "AllowAnyCert should return empty root hints (self-signed certs)"
    );
}

#[test]
fn allow_any_cert_accepts_any_certificate() {
    install_crypto_provider();
    let cert = generate_self_signed_cert("any-cert-test").unwrap();
    let cert_der = pem_to_der(&cert.cert_pem).unwrap();
    let ee = rustls::pki_types::CertificateDer::from(cert_der);
    let now = rustls::pki_types::UnixTime::now();

    let verifier = AllowAnyCert;
    let result =
        rustls::server::danger::ClientCertVerifier::verify_client_cert(&verifier, &ee, &[], now);
    assert!(
        result.is_ok(),
        "AllowAnyCert must accept any valid certificate"
    );
}

// -- 11. End-to-end mTLS handshake integration tests (T-30) -----------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mtls_full_handshake_both_sides_see_peer_identity() {
    install_crypto_provider();

    let cert_alice = generate_self_signed_cert("alice").unwrap();
    let cert_bob = generate_self_signed_cert("bob").unwrap();

    // Use a oneshot channel to extract the server-side SyncConnection.
    let (server_conn_tx, server_conn_rx) = tokio::sync::oneshot::channel::<SyncConnection>();
    let server_conn_tx = std::sync::Mutex::new(Some(server_conn_tx));

    let (server, port) = SyncServer::start(&cert_alice, move |conn| {
        if let Some(tx) = server_conn_tx.lock().unwrap().take() {
            let _ = tx.send(conn);
        }
    })
    .await
    .unwrap();

    let addr = format!("127.0.0.1:{port}");
    let mut client_conn = connect_to_peer(&addr, None, &cert_bob).await.unwrap();

    let mut server_conn = tokio::time::timeout(std::time::Duration::from_secs(5), server_conn_rx)
        .await
        .expect("timeout waiting for server connection")
        .expect("server connection channel closed");

    // Server side: verify client identity
    assert_eq!(
        server_conn.peer_cert_hash().as_deref(),
        Some(cert_bob.cert_hash.as_str()),
        "server should see bob's cert hash"
    );
    assert_eq!(
        server_conn.peer_cert_cn(),
        Some("bob"),
        "server should see bob's device ID from CN"
    );

    // Client side: verify server identity
    assert_eq!(
        client_conn.peer_cert_hash().as_deref(),
        Some(cert_alice.cert_hash.as_str()),
        "client should see alice's cert hash"
    );

    // Exchange a JSON message server → client to confirm the channel works
    server_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "alice".into(),
                seq: 1,
                hash: "head_hash_alice".into(),
            }],
        })
        .await
        .unwrap();

    let msg: SyncMessage = client_conn.recv_json().await.unwrap();
    match msg {
        SyncMessage::HeadExchange { heads } => {
            assert_eq!(heads.len(), 1);
            assert_eq!(heads[0].device_id, "alice");
        }
        other => panic!("expected HeadExchange from server, got {other:?}"),
    }

    // Reverse direction: client → server
    client_conn
        .send_json(&SyncMessage::HeadExchange {
            heads: vec![DeviceHead {
                device_id: "bob".into(),
                seq: 2,
                hash: "head_hash_bob".into(),
            }],
        })
        .await
        .unwrap();

    let msg: SyncMessage = server_conn.recv_json().await.unwrap();
    match msg {
        SyncMessage::HeadExchange { heads } => {
            assert_eq!(heads.len(), 1);
            assert_eq!(heads[0].device_id, "bob");
        }
        other => panic!("expected HeadExchange from client, got {other:?}"),
    }

    client_conn.close().await.ok();
    server_conn.close().await.ok();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mtls_reconnection_with_correct_cert_hash_succeeds() {
    install_crypto_provider();

    let cert_alice = generate_self_signed_cert("alice").unwrap();
    let cert_bob = generate_self_signed_cert("bob").unwrap();

    // mpsc channel: we need two connections across the test.
    let (server_conn_tx, mut server_conn_rx) = tokio::sync::mpsc::channel::<SyncConnection>(2);

    let (server, port) = SyncServer::start(&cert_alice, move |conn| {
        let tx = server_conn_tx.clone();
        let _ = tx.try_send(conn);
    })
    .await
    .unwrap();

    let addr = format!("127.0.0.1:{port}");

    // ── First connection: no pinning (initial pairing) ──
    let client_conn1 = connect_to_peer(&addr, None, &cert_bob).await.unwrap();
    let recorded_hash = client_conn1
        .peer_cert_hash()
        .expect("first connection should capture server cert hash");
    assert_eq!(
        recorded_hash, cert_alice.cert_hash,
        "recorded hash should match server cert"
    );

    // Drain server-side connection and close everything
    let server_conn1 =
        tokio::time::timeout(std::time::Duration::from_secs(5), server_conn_rx.recv())
            .await
            .expect("timeout waiting for server connection 1")
            .expect("server connection channel closed");
    client_conn1.close().await.ok();
    server_conn1.close().await.ok();

    // ── Second connection: with pinning using recorded hash ──
    let mut client_conn2 = connect_to_peer(&addr, Some(&recorded_hash), &cert_bob)
        .await
        .expect("reconnection with correct cert hash should succeed");

    let mut server_conn2 =
        tokio::time::timeout(std::time::Duration::from_secs(5), server_conn_rx.recv())
            .await
            .expect("timeout waiting for server connection 2")
            .expect("server connection channel closed");

    // Verify the pinned connection works: exchange a message
    server_conn2
        .send_json(&SyncMessage::SyncComplete {
            last_hash: "hash_a".into(),
        })
        .await
        .unwrap();

    let msg: SyncMessage = client_conn2.recv_json().await.unwrap();
    match msg {
        SyncMessage::SyncComplete { last_hash } => {
            assert_eq!(last_hash, "hash_a");
        }
        other => panic!("expected SyncComplete, got {other:?}"),
    }

    client_conn2.close().await.ok();
    server_conn2.close().await.ok();
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mtls_reconnection_with_wrong_cert_hash_fails() {
    install_crypto_provider();

    let cert_alice = generate_self_signed_cert("alice").unwrap();
    let cert_bob = generate_self_signed_cert("bob").unwrap();

    let (server, port) = SyncServer::start(&cert_alice, |_conn| {}).await.unwrap();

    let addr = format!("127.0.0.1:{port}");
    let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";

    let result = connect_to_peer(&addr, Some(wrong_hash), &cert_bob).await;

    let err_msg = match result {
        Err(e) => e.to_string(),
        Ok(_) => panic!("connection with wrong cert hash should fail (cert pinning rejection)"),
    };
    assert!(
        err_msg.contains("cert")
            || err_msg.contains("hash")
            || err_msg.contains("tls")
            || err_msg.contains("TLS")
            || err_msg.contains("alert")
            || err_msg.contains("pin"),
        "error should indicate cert pinning rejection, got: {err_msg}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mtls_tofu_store_and_verify_round_trip() {
    install_crypto_provider();

    // TOFU store: maps device_id → cert_hash
    let mut tofu_store: HashMap<String, String> = HashMap::new();

    // Generate original cert for "device-a" (acting as server)
    let cert_device_a_v1 = generate_self_signed_cert("device-a").unwrap();
    let client_cert = generate_self_signed_cert("tofu-client").unwrap();

    // ── First connection: no pinning → learn the server's hash (TOFU) ──
    let (server_v1, port_v1) = SyncServer::start(&cert_device_a_v1, |_conn| {})
        .await
        .unwrap();

    let conn = connect_to_peer(&format!("127.0.0.1:{port_v1}"), None, &client_cert)
        .await
        .unwrap();

    // Store the server's cert hash (Trust On First Use)
    let stored_hash = conn
        .peer_cert_hash()
        .expect("should capture server cert hash on first use");
    tofu_store.insert("device-a".to_string(), stored_hash.clone());
    assert_eq!(stored_hash, cert_device_a_v1.cert_hash);

    conn.close().await.ok();
    server_v1.shutdown().await;

    // ── Simulate device-a reinstall: generate a NEW cert ──
    let cert_device_a_v2 = generate_self_signed_cert("device-a").unwrap();
    assert_ne!(
        cert_device_a_v2.cert_hash, cert_device_a_v1.cert_hash,
        "reinstalled device should have a different cert hash"
    );

    // Start server with the NEW cert
    let (server_v2, port_v2) = SyncServer::start(&cert_device_a_v2, |_conn| {})
        .await
        .unwrap();

    // Attempt connection with the stored (old) hash → should fail
    let pinned_hash = tofu_store.get("device-a").unwrap();
    let result = connect_to_peer(
        &format!("127.0.0.1:{port_v2}"),
        Some(pinned_hash),
        &client_cert,
    )
    .await;

    assert!(
        result.is_err(),
        "TOFU verification should fail: stored hash doesn't match reinstalled device's new cert"
    );

    server_v2.shutdown().await;
}
