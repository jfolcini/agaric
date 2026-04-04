//! Networking primitives for local-network sync.
//!
//! This module is self-contained: it provides TLS certificate generation,
//! mDNS service announcement/discovery, WebSocket server and client, a
//! unified `SyncConnection` abstraction, and the sync message types.
//!
//! The orchestrator (`sync.rs`) wires these into the higher-level sync flow.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};

const MDNS_BROWSE_TIMEOUT: Duration = Duration::from_secs(5);
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Map any networking / TLS / WS error into an `AppError`.
///
/// NOTE: Uses `AppError::InvalidOperation` until the orchestrator adds an
/// `AppError::Internal` variant; swap the variant at that time.
fn sync_err(msg: impl std::fmt::Display) -> AppError {
    AppError::InvalidOperation(format!("[sync_net] {msg}"))
}

/// Parse PEM-encoded data (certificate or key) into raw DER bytes.
fn pem_to_der(pem: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine;
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| sync_err(format!("invalid PEM: {e}")))
}

// =========================================================================
// 1. TLS Certificate Generation
// =========================================================================

/// A self-signed TLS certificate for sync transport.
#[derive(Debug, Clone)]
pub struct SyncCert {
    pub cert_pem: String,
    pub key_pem: String,
    /// SHA-256 of the DER-encoded certificate, hex-encoded.
    /// Used for certificate pinning in `peer_refs`.
    pub cert_hash: String,
}

/// Generate a self-signed ECDSA P-256 certificate for the given device.
///
/// * Subject: `CN=agaric-{device_id}`
/// * SAN: `localhost`, `127.0.0.1`
/// * Validity: rcgen defaults (long-lived); override to 365 days when
///   `time` is added as a direct dependency.
pub fn generate_self_signed_cert(device_id: &str) -> Result<SyncCert, AppError> {
    use rcgen::{CertificateParams, DnType, KeyPair};

    // Generate ECDSA P-256 key pair (rcgen default).
    let key_pair =
        KeyPair::generate().map_err(|e| sync_err(format!("key generation failed: {e}")))?;

    // Build certificate parameters.
    let mut params = CertificateParams::new(vec!["localhost".to_string(), "127.0.0.1".to_string()])
        .map_err(|e| sync_err(format!("cert params: {e}")))?;

    // Override the default CN.
    params
        .distinguished_name
        .push(DnType::CommonName, format!("agaric-{device_id}"));

    // Self-sign.
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| sync_err(format!("self-sign failed: {e}")))?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    let cert_der = cert.der().to_vec();

    // SHA-256 of the DER bytes, hex-encoded.
    let hash = Sha256::digest(&cert_der);
    let cert_hash = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();

    Ok(SyncCert {
        cert_pem,
        key_pem,
        cert_hash,
    })
}

// =========================================================================
// 2. mDNS Service
// =========================================================================

/// mDNS service type for BlockNotes sync discovery.
pub const MDNS_SERVICE_TYPE: &str = "_agaric._tcp.local.";

/// mDNS service name prefix.
pub const MDNS_SERVICE_NAME: &str = "BlockNotes";

/// Handle to the running mDNS daemon.
pub struct MdnsService {
    daemon: mdns_sd::ServiceDaemon,
}

impl MdnsService {
    /// Create a new mDNS service daemon.
    pub fn new() -> Result<Self, AppError> {
        let daemon =
            mdns_sd::ServiceDaemon::new().map_err(|e| sync_err(format!("mdns daemon: {e}")))?;
        Ok(Self { daemon })
    }

    /// Announce this device on the local network.
    ///
    /// Registers a `_agaric._tcp.local.` service with a TXT record
    /// containing `device_id=<id>`.  Returns the registered `ServiceInfo`.
    pub fn announce(&self, device_id: &str, port: u16) -> Result<mdns_sd::ServiceInfo, AppError> {
        let host_name = format!("{device_id}.local.");
        let instance_name = format!("{MDNS_SERVICE_NAME}_{device_id}");

        let mut properties = HashMap::new();
        properties.insert("device_id".to_string(), device_id.to_string());

        let service_info = mdns_sd::ServiceInfo::new(
            MDNS_SERVICE_TYPE,
            &instance_name,
            &host_name,
            "", // empty → the daemon will discover local IPs
            port,
            Some(properties),
        )
        .map_err(|e| sync_err(format!("service info: {e}")))?
        .enable_addr_auto();

        self.daemon
            .register(service_info.clone())
            .map_err(|e| sync_err(format!("register: {e}")))?;

        Ok(service_info)
    }

    /// Browse for other BlockNotes devices on the network.
    ///
    /// Returns a channel receiver that yields `ServiceEvent` values.
    pub fn browse(&self) -> Result<mdns_sd::Receiver<mdns_sd::ServiceEvent>, AppError> {
        self.daemon
            .browse(MDNS_SERVICE_TYPE)
            .map_err(|e| sync_err(format!("browse: {e}")))
    }

    /// Browse for peers with a timeout, preventing indefinite blocking.
    ///
    /// Collects all `DiscoveredPeer` entries received within the timeout window.
    /// Returns an empty vec if no peers are found before the timeout expires.
    pub async fn browse_with_timeout(&self) -> Result<Vec<DiscoveredPeer>, AppError> {
        let receiver = self.browse()?;
        let mut peers = Vec::new();
        let deadline = tokio::time::Instant::now() + MDNS_BROWSE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match timeout(remaining, receiver.recv_async()).await {
                Ok(Ok(event)) => {
                    if let Some(peer) = parse_service_event(event) {
                        peers.push(peer);
                    }
                }
                Ok(Err(_)) => break, // Channel closed
                Err(_) => break,     // Timeout expired
            }
        }
        Ok(peers)
    }

    /// Shut down the mDNS daemon, stopping all announce/browse activity.
    pub fn shutdown(self) -> Result<(), AppError> {
        self.daemon
            .shutdown()
            .map_err(|e| sync_err(format!("mdns shutdown: {e}")))?;
        Ok(())
    }
}

/// A peer discovered via mDNS.
#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub addresses: Vec<IpAddr>,
    pub port: u16,
}

/// Extract a [`DiscoveredPeer`] from a `ServiceEvent`, if applicable.
///
/// Only `ServiceEvent::ServiceResolved` events carry enough information;
/// all other variants return `None`.
pub fn parse_service_event(event: mdns_sd::ServiceEvent) -> Option<DiscoveredPeer> {
    match event {
        mdns_sd::ServiceEvent::ServiceResolved(info) => {
            let device_id = info.get_property_val_str("device_id")?.to_string();
            let addresses: Vec<IpAddr> = info
                .get_addresses()
                .iter()
                .map(|scoped| scoped.to_ip_addr())
                .collect();
            let port = info.get_port();
            Some(DiscoveredPeer {
                device_id,
                addresses,
                port,
            })
        }
        _ => None,
    }
}

// =========================================================================
// 3. WebSocket Server
// =========================================================================

/// A TLS-secured WebSocket server for sync connections.
pub struct SyncServer {
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    join_handle: Option<tokio::task::JoinHandle<()>>,
}

impl SyncServer {
    /// Start listening on a random available port.
    ///
    /// For each incoming connection the server performs a TLS handshake
    /// using the certificate from `cert`, upgrades to WebSocket, and
    /// invokes `on_connection` with the resulting `SyncConnection`.
    ///
    /// Returns the server handle together with the bound port.
    pub async fn start(
        cert: &SyncCert,
        on_connection: impl Fn(SyncConnection) + Send + Sync + 'static,
    ) -> Result<(Self, u16), AppError> {
        let tls_config = build_server_tls_config(cert)?;
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls_config));

        let listener = TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| sync_err(format!("bind: {e}")))?;

        let port = listener
            .local_addr()
            .map_err(|e| sync_err(format!("local_addr: {e}")))?
            .port();

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let on_connection = Arc::new(on_connection);

        let join_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((tcp_stream, _addr)) => {
                                let acceptor = acceptor.clone();
                                let on_conn = on_connection.clone();
                                tokio::spawn(async move {
                                    let tls_stream = match acceptor.accept(tcp_stream).await {
                                        Ok(s) => s,
                                        Err(e) => {
                                            tracing::debug!("TLS handshake failed: {e}");
                                            return;
                                        }
                                    };
                                    let ws_stream =
                                        match tokio_tungstenite::accept_async(tls_stream).await {
                                            Ok(s) => s,
                                            Err(e) => {
                                                tracing::debug!("WebSocket upgrade failed: {e}");
                                                return;
                                            }
                                        };
                                    let conn = SyncConnection {
                                        inner: InnerStream::Server(ws_stream),
                                        peer_cert_hash_val: None,
                                    };
                                    on_conn(conn);
                                });
                            }
                            Err(_e) => {
                                // Transient accept error – keep listening.
                            }
                        }
                    }
                    _ = &mut shutdown_rx => {
                        break;
                    }
                }
            }
        });

        Ok((
            SyncServer {
                shutdown_tx: Some(shutdown_tx),
                join_handle: Some(join_handle),
            },
            port,
        ))
    }

    /// Shut down the server gracefully.
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.await;
        }
    }
}

/// Build a `rustls::ServerConfig` from a [`SyncCert`].
fn build_server_tls_config(cert: &SyncCert) -> Result<rustls::ServerConfig, AppError> {
    let cert_der = pem_to_der(&cert.cert_pem)?;
    let key_der = pem_to_der(&cert.key_pem)?;

    let certs = vec![rustls::pki_types::CertificateDer::from(cert_der)];
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(
        key_der,
    ));

    rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| sync_err(format!("server TLS config: {e}")))
}

// =========================================================================
// 4. WebSocket Client
// =========================================================================

/// Connect to a peer's sync server.
///
/// * `addr` – `"host:port"` of the remote server.
/// * `expected_cert_hash` – if `Some`, the server's certificate hash must
///   match (reconnection / pinning mode).  If `None`, any certificate is
///   accepted (initial pairing) and the hash is available via
///   [`SyncConnection::peer_cert_hash`].
pub async fn connect_to_peer(
    addr: &str,
    expected_cert_hash: Option<&str>,
) -> Result<SyncConnection, AppError> {
    let observed_hash = Arc::new(std::sync::Mutex::new(None::<String>));

    let verifier = PinningCertVerifier {
        expected_hash: expected_cert_hash.map(String::from),
        observed_hash: observed_hash.clone(),
    };

    let client_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();

    let connector = tokio_tungstenite::Connector::Rustls(Arc::new(client_config));

    let url = format!("wss://{addr}");
    let (ws_stream, _response) =
        tokio_tungstenite::connect_async_tls_with_config(&url, None, false, Some(connector))
            .await
            .map_err(|e| sync_err(format!("connect: {e}")))?;

    let peer_hash = observed_hash
        .lock()
        .map_err(|e| sync_err(format!("lock: {e}")))?
        .clone();

    Ok(SyncConnection {
        inner: InnerStream::Client(ws_stream),
        peer_cert_hash_val: peer_hash,
    })
}

// ---------------------------------------------------------------------------
// Custom certificate verifier (cert pinning / accept-all)
// ---------------------------------------------------------------------------

/// A `ServerCertVerifier` that either accepts any certificate (pairing) or
/// pins a specific SHA-256 hash (reconnection).
///
/// The observed hash is stored in `observed_hash` so the caller can retrieve
/// it after the TLS handshake.
#[derive(Debug)]
struct PinningCertVerifier {
    expected_hash: Option<String>,
    observed_hash: Arc<std::sync::Mutex<Option<String>>>,
}

impl rustls::client::danger::ServerCertVerifier for PinningCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        // Compute SHA-256 of the DER-encoded certificate.
        let hash = Sha256::digest(end_entity.as_ref());
        let hex_hash: String = hash.iter().map(|b| format!("{b:02x}")).collect();

        // Store observed hash for the caller.
        if let Ok(mut guard) = self.observed_hash.lock() {
            *guard = Some(hex_hash.clone());
        }

        // If we have an expected hash, enforce it.
        if let Some(ref expected) = self.expected_hash {
            if *expected != hex_hash {
                return Err(rustls::Error::General(format!(
                    "cert pin mismatch: expected {expected}, got {hex_hash}"
                )));
            }
        }

        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// =========================================================================
// 5. SyncConnection Abstraction
// =========================================================================

/// Underlying WebSocket stream – either server-side (over TLS directly) or
/// client-side (wrapped in `MaybeTlsStream`).
enum InnerStream {
    Server(WebSocketStream<tokio_rustls::server::TlsStream<tokio::net::TcpStream>>),
    Client(WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>),
}

/// A bidirectional WebSocket connection used by the sync protocol.
pub struct SyncConnection {
    inner: InnerStream,
    peer_cert_hash_val: Option<String>,
}

impl SyncConnection {
    /// Send a JSON-serialised message.
    pub async fn send_json<T: Serialize>(&mut self, msg: &T) -> Result<(), AppError> {
        let text = serde_json::to_string(msg).map_err(|e| sync_err(format!("serialize: {e}")))?;
        self.send_message(Message::Text(text.into())).await
    }

    /// Receive and deserialise a JSON message.
    pub async fn recv_json<T: serde::de::DeserializeOwned>(&mut self) -> Result<T, AppError> {
        let msg = self.recv_message().await?;
        match msg {
            Message::Text(text) => {
                if text.len() > Self::MAX_MSG_SIZE {
                    return Err(sync_err(format!(
                        "text message too large: {} bytes (max {})",
                        text.len(),
                        Self::MAX_MSG_SIZE
                    )));
                }
                serde_json::from_str(&text).map_err(|e| sync_err(format!("deserialize: {e}")))
            }
            other => Err(sync_err(format!("expected text message, got {:?}", other))),
        }
    }

    /// Send raw bytes (e.g. snapshot transfer).
    pub async fn send_binary(&mut self, data: &[u8]) -> Result<(), AppError> {
        self.send_message(Message::Binary(data.to_vec().into()))
            .await
    }

    /// Receive raw bytes.
    pub async fn recv_binary(&mut self) -> Result<Vec<u8>, AppError> {
        let msg = self.recv_message().await?;
        match msg {
            Message::Binary(data) => {
                if data.len() > Self::MAX_MSG_SIZE {
                    return Err(sync_err(format!(
                        "binary message too large: {} bytes (max {})",
                        data.len(),
                        Self::MAX_MSG_SIZE
                    )));
                }
                Ok(data.into())
            }
            other => Err(sync_err(format!(
                "expected binary message, got {:?}",
                other
            ))),
        }
    }

    /// Get the remote peer's certificate hash (populated on client-side
    /// connections only).
    pub fn peer_cert_hash(&self) -> Option<String> {
        self.peer_cert_hash_val.clone()
    }

    /// Close the connection gracefully.
    pub async fn close(self) -> Result<(), AppError> {
        match self.inner {
            InnerStream::Server(mut ws) => ws
                .close(None)
                .await
                .map_err(|e| sync_err(format!("close: {e}"))),
            InnerStream::Client(mut ws) => ws
                .close(None)
                .await
                .map_err(|e| sync_err(format!("close: {e}"))),
        }
    }

    // -- private helpers --------------------------------------------------

    /// Timeout for waiting on the next WebSocket message.  If the peer goes
    /// silent (e.g. WiFi drop without TCP RST, peer crash), the sync session
    /// will fail rather than hang indefinitely.
    const RECV_TIMEOUT: Duration = Duration::from_secs(30);

    /// Maximum allowed WebSocket message size (10 MB).  Only paired devices
    /// on the user's own LAN can connect (TLS cert pinning + passphrase),
    /// so this is defense-in-depth against runaway payloads.
    const MAX_MSG_SIZE: usize = 10_000_000;

    async fn send_message(&mut self, msg: Message) -> Result<(), AppError> {
        match &mut self.inner {
            InnerStream::Server(ws) => ws
                .send(msg)
                .await
                .map_err(|e| sync_err(format!("send: {e}"))),
            InnerStream::Client(ws) => ws
                .send(msg)
                .await
                .map_err(|e| sync_err(format!("send: {e}"))),
        }
    }

    async fn recv_message(&mut self) -> Result<Message, AppError> {
        let result = match &mut self.inner {
            InnerStream::Server(ws) => timeout(Self::RECV_TIMEOUT, ws.next()).await,
            InnerStream::Client(ws) => timeout(Self::RECV_TIMEOUT, ws.next()).await,
        };
        match result {
            Ok(Some(Ok(msg))) => Ok(msg),
            Ok(Some(Err(e))) => Err(sync_err(format!("recv: {e}"))),
            Ok(None) => Err(sync_err("connection closed")),
            Err(_elapsed) => Err(sync_err("recv timed out after 60s")),
        }
    }
}

// =========================================================================
// 6. Sync Message Types
// =========================================================================

/// Messages exchanged over a sync connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SyncMessage {
    /// Step 1: Exchange heads.
    HeadExchange { heads: Vec<DeviceHead> },
    /// Step 2: Request ops after a certain sequence number.
    RequestOps { device_id: String, after_seq: i64 },
    /// Step 3: Stream ops in batches.
    OpBatch { ops: Vec<OpTransfer>, is_last: bool },
    /// Step 4: Reset required (hash-chain divergence).
    ResetRequired { reason: String },
    /// Snapshot offer (for the RESET flow).
    SnapshotOffer { size_bytes: u64 },
    /// Snapshot accept / reject.
    SnapshotResponse { accepted: bool },
    /// Sync complete acknowledgement.
    SyncComplete {
        our_last_hash: String,
        their_last_hash: String,
    },
    /// Error during sync.
    Error { message: String },
}

/// A device's current head in the op-log DAG.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceHead {
    pub device_id: String,
    pub seq: i64,
    pub hash: String,
}

/// A single operation transferred during sync.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpTransfer {
    pub device_id: String,
    pub seq: i64,
    pub parent_seqs: Option<String>,
    pub hash: String,
    pub op_type: String,
    pub payload: String,
    pub created_at: String,
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

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
            our_last_hash: "aaa".into(),
            their_last_hash: "bbb".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: SyncMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            SyncMessage::SyncComplete {
                our_last_hash,
                their_last_hash,
            } => {
                assert_eq!(our_last_hash, "aaa");
                assert_eq!(their_last_hash, "bbb");
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
            MDNS_SERVICE_TYPE.contains("._tcp.local.")
                || MDNS_SERVICE_TYPE.contains("._udp.local."),
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
        let mut client = connect_to_peer(&format!("127.0.0.1:{port}"), None)
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
        let expected_hash = cert.cert_hash.clone();

        let (server, port) = SyncServer::start(&cert, |_conn| {}).await.unwrap();

        // Connect with correct hash
        let conn = connect_to_peer(&format!("127.0.0.1:{port}"), Some(&expected_hash)).await;
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

        let (server, port) = SyncServer::start(&cert, |_conn| {}).await.unwrap();

        // Connect with wrong hash
        let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";
        let result = connect_to_peer(&format!("127.0.0.1:{port}"), Some(wrong_hash)).await;
        assert!(
            result.is_err(),
            "connection with wrong cert hash should fail"
        );

        let err = match result {
            Err(e) => e,
            Ok(_) => unreachable!("already asserted is_err"),
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
        // Use a port that's almost certainly not listening
        let result = connect_to_peer("127.0.0.1:1", None).await;
        assert!(result.is_err(), "connection to closed port should fail");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn binary_message_roundtrip() {
        install_crypto_provider();
        let cert = generate_self_signed_cert("binary-test").unwrap();

        let (server, port) = SyncServer::start(&cert, |mut conn| {
            tokio::spawn(async move {
                let data = conn.recv_binary().await.unwrap();
                conn.send_binary(&data).await.unwrap();
                conn.close().await.ok();
            });
        })
        .await
        .unwrap();

        let mut client = connect_to_peer(&format!("127.0.0.1:{port}"), None)
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

        let (server, port) = SyncServer::start(&cert, |_conn| {}).await.unwrap();

        let conn = connect_to_peer(&format!("127.0.0.1:{port}"), None)
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
}
