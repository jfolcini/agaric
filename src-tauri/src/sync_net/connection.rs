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
    #[cfg(test)]
    Test(WebSocketStream<tokio::io::DuplexStream>),
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
            other => Err(sync_err(format!(
                "expected text message, got {}",
                describe_message(&other)
            ))),
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
                "expected binary message, got {}",
                describe_message(&other)
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

    /// Set the test certificate fields (CN and hash) on this connection.
    ///
    /// Only available in test builds.  Use this after calling
    /// [`test_connection_pair()`] to inject cert values for the cert
    /// verification branches in `handle_incoming_sync`.
    #[cfg(test)]
    pub fn set_test_cert(&mut self, cn: Option<String>, hash: Option<String>) {
        self.peer_cert_cn_val = cn;
        self.peer_cert_hash_val = hash;
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
            #[cfg(test)]
            InnerStream::Test(mut ws) => ws
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
            #[cfg(test)]
            InnerStream::Test(ws) => ws
                .send(msg)
                .await
                .map_err(|e| sync_err(format!("send: {e}"))),
        }
    }

    async fn recv_message(&mut self) -> Result<Message, AppError> {
        let result = match &mut self.inner {
            InnerStream::Server(ws) => timeout(Self::RECV_TIMEOUT, ws.next()).await,
            InnerStream::Client(ws) => timeout(Self::RECV_TIMEOUT, ws.next()).await,
            #[cfg(test)]
            InnerStream::Test(ws) => timeout(Self::RECV_TIMEOUT, ws.next()).await,
        };
        match result {
            Ok(Some(Ok(msg))) => Ok(msg),
            Ok(Some(Err(e))) => Err(sync_err(format!("recv: {e}"))),
            Ok(None) => Err(sync_err("connection closed")),
            Err(_elapsed) => Err(sync_err("recv timed out after 30s")),
        }
    }
}

/// I-Sync-2: Render a clipped, human-friendly description of a tungstenite
/// `Message` for log/error strings.
///
/// The default `Debug` impl on `Message::Binary(Vec<u8>)` renders the entire
/// byte buffer; on a 5 MB binary frame received in a place expecting JSON,
/// that explodes the error string. This helper renders binary as
/// `Binary(<{n} bytes>)` and text as `Text(<{n} chars>: "{first 80 chars}…")`,
/// keeping the discriminant useful while bounding the size.
fn describe_message(msg: &Message) -> String {
    /// Maximum number of leading characters of a text payload to include in
    /// the description.
    const TEXT_PREVIEW_CHARS: usize = 80;

    match msg {
        Message::Binary(data) => format!("Binary(<{} bytes>)", data.len()),
        Message::Text(text) => {
            let n_chars = text.chars().count();
            let preview: String = text.chars().take(TEXT_PREVIEW_CHARS).collect();
            if n_chars > TEXT_PREVIEW_CHARS {
                format!("Text(<{n_chars} chars>: {preview:?}…)")
            } else {
                format!("Text(<{n_chars} chars>: {preview:?})")
            }
        }
        // Ping/Pong/Close are small or trivially-bounded; Debug is fine.
        Message::Ping(_) | Message::Pong(_) | Message::Close(_) | Message::Frame(_) => {
            format!("{msg:?}")
        }
    }
}

#[cfg(test)]
mod describe_message_tests {
    use super::describe_message;
    use tokio_tungstenite::tungstenite::Message;

    #[test]
    fn binary_5mb_frame_is_clipped() {
        let payload = vec![0u8; 5 * 1024 * 1024];
        let msg = Message::Binary(payload.into());
        let s = describe_message(&msg);
        assert_eq!(
            s, "Binary(<5242880 bytes>)",
            "5MB binary frame must render as a short summary, got: {s}"
        );
        assert!(
            s.len() < 64,
            "rendered description must be short, got {} chars",
            s.len()
        );
    }

    #[test]
    fn binary_empty_is_clipped() {
        let msg = Message::Binary(Vec::<u8>::new().into());
        assert_eq!(describe_message(&msg), "Binary(<0 bytes>)");
    }

    #[test]
    fn short_text_is_rendered_verbatim() {
        let msg = Message::Text("hello".into());
        let s = describe_message(&msg);
        assert!(
            s.contains("Text(<5 chars>"),
            "short text must include length prefix, got: {s}"
        );
        assert!(s.contains("hello"), "short text body must appear, got: {s}");
        assert!(
            !s.contains('…'),
            "short text must not be truncated, got: {s}"
        );
    }

    #[test]
    fn long_text_is_truncated_with_ellipsis() {
        // 200 'a' chars; preview budget is 80.
        let body: String = "a".repeat(200);
        let msg = Message::Text(body.into());
        let s = describe_message(&msg);
        assert!(
            s.contains("Text(<200 chars>"),
            "long text must include length prefix, got: {s}"
        );
        assert!(
            s.ends_with("…)"),
            "long text must end with ellipsis, got: {s}"
        );
        assert!(
            s.len() < 200,
            "rendered description must be shorter than the body, got {} chars",
            s.len()
        );
    }

    #[test]
    fn ping_uses_debug() {
        let msg = Message::Ping(Vec::<u8>::new().into());
        let s = describe_message(&msg);
        assert!(s.starts_with("Ping"), "ping must start with Ping, got: {s}");
    }

    /// I-Sync-2 (R1 follow-up): pin the multi-byte UTF-8 boundary
    /// invariant on the text-preview path. The implementation uses
    /// `text.chars().take(TEXT_PREVIEW_CHARS).collect()` which iterates
    /// Unicode scalar values (never bytes), so a mid-codepoint split is
    /// structurally impossible. This test locks that invariant in:
    /// 79 ASCII chars + 1 four-byte emoji = exactly 80 chars / 83 bytes,
    /// landing the emoji at the precise preview boundary.
    #[test]
    fn text_with_emoji_at_preview_boundary_does_not_split_codepoint() {
        let text = "a".repeat(79) + "🎉";
        assert_eq!(
            text.chars().count(),
            80,
            "test setup: text must be exactly 80 chars (TEXT_PREVIEW_CHARS)",
        );
        assert_eq!(
            text.len(),
            79 + 4,
            "test setup: text must be 83 bytes (79 ASCII + 1 four-byte emoji)",
        );

        // Must not panic, and must produce a valid String.
        let s = describe_message(&Message::Text(text.into()));

        // Every Rust `String` is valid UTF-8; pinning the byte-boundary
        // invariant defensively in case the helper ever changes.
        assert!(
            s.is_char_boundary(s.len()),
            "rendered description must end on a char boundary, got: {s}",
        );

        // n_chars == TEXT_PREVIEW_CHARS, so the truncation branch is
        // *not* taken — the rendered description must not end with the
        // ellipsis marker that signals an over-cap preview.
        assert!(
            !s.ends_with("…)"),
            "exact-boundary text must not include the truncation marker, got: {s}",
        );

        // The emoji must appear in full (chars().take(80) cannot split a
        // Unicode scalar value mid-codepoint).
        assert!(
            s.contains("🎉"),
            "emoji at the exact preview boundary must appear in full, got: {s}",
        );
        assert!(
            s.contains("Text(<80 chars>"),
            "char-count prefix must report 80, got: {s}",
        );
    }

    /// I-Sync-2 (R1 follow-up): all-emoji text >> preview cap. The
    /// output must end on a char boundary (no mid-codepoint split) and
    /// must contain exactly TEXT_PREVIEW_CHARS (80) emoji in the
    /// preview body — i.e. the cap is enforced in *characters*, not
    /// bytes.
    #[test]
    fn text_with_all_emoji_clipped_at_preview_chars() {
        let text: String = "🎉".repeat(200);
        assert_eq!(
            text.chars().count(),
            200,
            "test setup: 200 emoji repeats should be 200 chars",
        );
        assert_eq!(text.len(), 200 * 4, "test setup: each emoji is 4 bytes",);

        let s = describe_message(&Message::Text(text.into()));

        assert!(
            s.is_char_boundary(s.len()),
            "rendered description must end on a char boundary, got: {s}",
        );

        // n_chars > TEXT_PREVIEW_CHARS, so truncation marker is present.
        assert!(
            s.ends_with("…)"),
            "long all-emoji text must end with truncation marker, got: {s}",
        );

        assert!(
            s.contains("Text(<200 chars>"),
            "char-count prefix must report 200, got: {s}",
        );

        // The preview body must hold exactly TEXT_PREVIEW_CHARS = 80
        // emoji — the cap is character-based, not byte-based.
        let emoji_count = s.matches('🎉').count();
        assert_eq!(
            emoji_count, 80,
            "preview must contain exactly 80 emoji (the configured char cap), \
             got {emoji_count} in: {s}",
        );
    }
}

/// Create an in-memory WebSocket pair for testing sync protocol flows.
#[cfg(test)]
pub async fn test_connection_pair() -> (SyncConnection, SyncConnection) {
    let (a, b) = tokio::io::duplex(64 * 1024);
    let ws_a = WebSocketStream::from_raw_socket(
        a,
        tokio_tungstenite::tungstenite::protocol::Role::Server,
        None,
    )
    .await;
    let ws_b = WebSocketStream::from_raw_socket(
        b,
        tokio_tungstenite::tungstenite::protocol::Role::Client,
        None,
    )
    .await;

    (
        SyncConnection {
            inner: InnerStream::Test(ws_a),
            peer_cert_hash_val: None,
            peer_cert_cn_val: None,
        },
        SyncConnection {
            inner: InnerStream::Test(ws_b),
            peer_cert_hash_val: None,
            peer_cert_cn_val: None,
        },
    )
}
