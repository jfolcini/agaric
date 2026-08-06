//! QUIC transport for peer sync, built on iroh (#78, plan #3464).
//!
//! # Why this exists
//!
//! This module replaces the hand-rolled WebSocket-over-mTLS stack in `sync_net`.
//! The decision, the measurements behind it, and the rejected alternatives live on
//! #78 and in the architecture plan #3464. In short: iroh retires roughly three
//! times as much code as plain `quinn` would, because `quinn` supplies QUIC
//! transport only and leaves identity, discovery and bulk transfer to us.
//!
//! # LAN-only is a posture, not a default
//!
//! Agaric syncs peer-to-peer with **no centralized servers**. iroh does not default
//! to that — it defaults to n0's relays and n0's DNS-based address lookup. Worse,
//! the preset whose name reads like our requirement, `presets::N0DisableRelay`,
//! disables only the relay and leaves all three n0 address-lookup services running,
//! so an endpoint built from it still publishes this device's addresses to a third
//! party on every start.
//!
//! [`endpoint::lan_only`] is the configuration that actually holds, and
//! [`endpoint`]'s test module is the guard that proves it still holds after an iroh
//! upgrade. That guard is the reason this module carries tests that look paranoid:
//! the failure mode it defends against is silent, and it is one `cargo update` away.

pub mod endpoint;

/// [`SyncMessage`](crate::sync_protocol::SyncMessage) framing over a QUIC bi-stream.
/// The QUIC counterpart of `sync_daemon::wire`, and a fraction of its size — see the
/// module docs for why the chunking layer does not come along.
pub mod session;

/// Bulk byte transfer (attachments, compressed snapshots) over a QUIC bi-stream.
/// The replacement for `SyncConnection`'s `send_binary_streaming` family — see the
/// module docs for why the chunk loop does not come along and why the receive cap
/// belongs to the caller.
pub mod bulk;

/// Driving a [`SyncOrchestrator`](crate::sync_protocol::SyncOrchestrator) to a terminal
/// state over a bi-stream. One loop for both roles — see the module docs for why the
/// old transport needed two.
pub mod driver;

/// The endpoint service: owns the LAN-only endpoint, admits inbound peers under a
/// concurrency cap, and hands out accepted sessions for a caller to drive. It does not
/// drive them — see [`driver`] for that.
pub mod service;

/// This device's long-lived iroh secret key, and its persistence.
///
/// Separate from [`endpoint`] because the key outlives any one endpoint and, unlike
/// everything else here, is a thing on disk: `peer_refs.endpoint_id` is only a pin if
/// the key behind it survives a restart.
pub mod identity;

/// A live QUIC bi-stream between two loopback endpoints, for tests.
///
/// Gated rather than `#[cfg(test)]` so the app crate's own sync tests — which live
/// across a crate boundary — can build on it, the same way they built on
/// `sync_net::test_connection_pair`.
#[cfg(any(test, feature = "test-util"))]
pub mod test_support;

pub use bulk::{BULK_COPY_BYTES, recv_bulk, send_bulk};
pub use driver::{Role, SessionEnd, SessionLimits, Shutdown, finish_session, run_session};
pub use endpoint::{RecordingResolver, is_publicly_routable, lan_only};
pub use identity::get_or_create_endpoint_secret;
/// This device's iroh secret key type, re-exported so the app crate can thread one
/// through boot without taking a direct `iroh` dependency — the whole point of
/// `agaric-sync` owning the transport.
pub use iroh::SecretKey;
pub use service::{AdmittedConnection, InboundSession, SYNC_ALPN, ServiceBindError, SyncService};
pub use session::{MAX_FRAME_SIZE, recv_sync_message, send_sync_message};
pub use session::{RECV_TIMEOUT, recv_sync_message_within};
#[cfg(any(test, feature = "test-util"))]
pub use test_support::{QuicPair, ServiceHarness, TestSide, quic_pair};
