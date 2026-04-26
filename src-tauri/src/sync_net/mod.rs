//! Networking primitives for local-network sync.
//!
//! This module is self-contained: it provides TLS certificate generation,
//! mDNS service announcement/discovery, WebSocket server and client, a
//! unified `SyncConnection` abstraction, and the sync message types.
//!
//! The orchestrator (`sync.rs`) wires these into the higher-level sync flow.

mod connection;
mod tls;
mod websocket;

#[cfg(test)]
mod tests;

use crate::error::AppError;

/// Map any networking / TLS / WS error into an `AppError`.
///
/// NOTE: Uses `AppError::InvalidOperation` until the orchestrator adds an
/// `AppError::Internal` variant; swap the variant at that time.
pub(crate) fn sync_err(msg: impl std::fmt::Display) -> AppError {
    AppError::InvalidOperation(format!("[sync_net] {msg}"))
}

/// Parse PEM-encoded data (certificate or key) into raw DER bytes.
pub(crate) fn pem_to_der(pem: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine;
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| sync_err(format!("invalid PEM: {e}")))
}

#[cfg(test)]
pub use connection::test_connection_pair;
pub use connection::{connect_to_peer, SyncConnection};
pub use tls::{generate_self_signed_cert, SyncCert};
pub use websocket::{
    parse_service_event, DiscoveredPeer, MdnsService, ServiceEventKind, SyncServer,
    MDNS_BROWSE_TIMEOUT, MDNS_SERVICE_NAME, MDNS_SERVICE_TYPE,
};
