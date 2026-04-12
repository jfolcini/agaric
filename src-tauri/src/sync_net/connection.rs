use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::pem_to_der;
use super::sync_err;
use super::tls::{PinningCertVerifier, SyncCert};
use crate::error::AppError;

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
/// * `local_cert` – the local device's TLS certificate, sent to the server
///   during the handshake so the responder can verify our identity (mTLS).
pub async fn connect_to_peer(
    addr: &str,
    expected_cert_hash: Option<&str>,
    local_cert: &SyncCert,
) -> Result<SyncConnection, AppError> {
    let observed_hash = Arc::new(std::sync::Mutex::new(None::<String>));

    let verifier = PinningCertVerifier {
        expected_hash: expected_cert_hash.map(String::from),
        observed_hash: observed_hash.clone(),
    };

    // Prepare client certificate chain + private key for mTLS
    let cert_der = pem_to_der(&local_cert.cert_pem)?;
    let key_der = pem_to_der(&local_cert.key_pem)?;
    let certs = vec![rustls::pki_types::CertificateDer::from(cert_der)];
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(
        key_der,
    ));

    let client_config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_client_auth_cert(certs, key)
        .map_err(|e| sync_err(format!("client TLS config: {e}")))?;

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
        peer_cert_cn_val: None, // CN verification is server-side only
    })
}

// =========================================================================
// 5. SyncConnection Abstraction
// =========================================================================

/// Underlying WebSocket stream – either server-side (over TLS directly) or
/// client-side (wrapped in `MaybeTlsStream`).
pub enum InnerStream {
    Server(WebSocketStream<tokio_rustls::server::TlsStream<tokio::net::TcpStream>>),
    Client(WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>),
}

/// A bidirectional WebSocket connection used by the sync protocol.
pub struct SyncConnection {
    pub(super) inner: InnerStream,
    pub(super) peer_cert_hash_val: Option<String>,
    /// Device ID extracted from the peer's TLS certificate CN (`agaric-{id}`).
    /// Populated on server-side connections only (responder path).
    pub(super) peer_cert_cn_val: Option<String>,
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

    /// Get the device ID extracted from the remote peer's TLS certificate CN.
    ///
    /// For server-side connections the CN is parsed from the client cert after
    /// the TLS handshake (`agaric-{device_id}` → `{device_id}`).
    /// Returns `None` for client-side connections or when no client cert was
    /// presented.
    pub fn peer_cert_cn(&self) -> Option<&str> {
        self.peer_cert_cn_val.as_deref()
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
            Err(_elapsed) => Err(sync_err("recv timed out after 30s")),
        }
    }
}
