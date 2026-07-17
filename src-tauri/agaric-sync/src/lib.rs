//! agaric-sync — the peer-to-peer sync layer of the layered `agaric` workspace
//! (#2621).
//!
//! Sits above `agaric-engine` and below the `agaric` app crate. This crate owns
//! the LAN pairing / device-sync stack. Sync-B seeds it with the three
//! dependency-free leaf modules peeled off the app crate; the mutually-recursive
//! net / protocol / daemon / files cluster and `snapshot` land in a later wave.
//!
//! The app crate re-exports each module (`pub use agaric_sync::{device,
//! foreground, sync_constants};`) so existing `crate::device::…` /
//! `crate::foreground::…` / `crate::sync_constants::…` paths resolve unchanged.

/// Stable per-install device identity — the persisted `DeviceId` UUID that
/// pairs and op-log origin attribution key off. Query-free; depends only on
/// `agaric-core` (`error::AppError`).
pub mod device;

/// Foreground/background gating primitive (`LifecycleHooks`) shared across the
/// sync / materializer / app layers. Query-free; depends only on `tokio`'s
/// `Notify`.
pub mod foreground;

/// Wire-protocol tunables (frame sizes, batch payload caps, handshake / connect
/// timeouts) shared across the sync stack. Pure constants; no dependencies.
pub mod sync_constants;
