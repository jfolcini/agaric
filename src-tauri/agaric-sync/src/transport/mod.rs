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

pub use endpoint::{RecordingResolver, is_publicly_routable, lan_only};
