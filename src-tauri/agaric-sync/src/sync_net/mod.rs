//! Networking primitives for local-network sync.
//!
//! This module provides TLS certificate generation, the WebSocket server and
//! client, and a unified `SyncConnection` abstraction.
//!
//! The orchestrator (`sync.rs`) wires these into the higher-level sync flow.
//!
//! mDNS announcement/discovery used to live here too, in `websocket.rs`. It moved to
//! [`crate::mdns`] (#3488): everything left in this module is deleted by the iroh
//! cutover (#3464) and discovery is not — it is the *only* discovery Agaric has once
//! the port lands, so it must not sit in a module whose other half is on its way out.

pub mod connection;
pub mod tls;
pub mod websocket;

use agaric_core::error::AppError;

/// Map any networking / TLS / WS error into an `AppError`.
///
/// NOTE: Uses `AppError::InvalidOperation` until the orchestrator adds an
/// `AppError::Internal` variant; swap the variant at that time.
pub(crate) fn sync_err(msg: impl std::fmt::Display) -> AppError {
    AppError::InvalidOperation(format!("[sync_net] {msg}"))
}

/// Parse PEM-encoded data (certificate or key) into raw DER bytes.
pub fn pem_to_der(pem: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine;
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| sync_err(format!("invalid PEM: {e}")))
}

#[cfg(any(test, feature = "test-util"))]
pub use connection::test_connection_pair;
pub use connection::{SyncConnection, connect_to_peer};
pub use tls::{SyncCert, generate_self_signed_cert};
pub use websocket::SyncServer;
