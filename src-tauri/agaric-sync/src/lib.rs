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

// ---------------------------------------------------------------------------
// Sync-D (#2621): the mutually-recursive net / protocol / daemon / files
// cluster + `snapshot`, `apply_host`, and the pure `sync_events` types. The app
// crate re-exports each (`pub use agaric_sync::X;`, or a test-hosting shim for
// the directory modules with app-coupled tests) so every `crate::sync_*::…` /
// `crate::snapshot::…` / `crate::apply_host::…` path resolves unchanged.
// ---------------------------------------------------------------------------

/// The narrow apply/materialize surface the sync layer needs from the app-side
/// `Materializer`, expressed as a trait so the sync modules depend DOWN on this
/// abstraction. The app's `impl ApplyHost for Materializer` stays app-side.
pub mod apply_host;

/// Pure `SyncEvent` / `SyncProgressUpdate` types + the `SyncEventSink` trait.
/// Tauri-backed sinks live app-side (`src/sync_event_sinks.rs`).
pub mod sync_events;

/// QUIC transport built on iroh (#78, plan #3464). Replaces the WebSocket +
/// mTLS stack in [`sync_net`], which is retired as the port lands. Carries the
/// LAN-only endpoint configuration and the offline guard that keeps it that way.
pub mod transport;

/// LAN peer discovery over mDNS (#3488). Lifted out of [`sync_net`], whose other
/// half the cutover deletes: iroh's own address lookup is cleared by
/// [`transport::endpoint::lan_only`], so this is the only discovery left.
pub mod mdns;

/// Networking primitives: TLS cert gen, WebSocket server/client, the unified
/// `SyncConnection`.
///
/// Superseded by [`transport`] and slated for deletion — see plan #3464.
pub mod sync_net;

/// Sync protocol orchestrator: head exchange, Loro-CRDT engine sync, peer-ref
/// bookkeeping.
pub mod sync_protocol;

/// Auto-sync daemon: background peer discovery, connection, and sync sessions.
pub mod sync_daemon;

/// Attachment file transfer over the sync connection.
pub mod sync_files;

/// Per-peer sync locks, exponential backoff, debounced change notifications.
pub mod sync_scheduler;

/// Persistent self-signed TLS certificate load/generation for the mTLS sync
/// handshake.
pub mod sync_cert;

/// LAN device pairing (passphrase + QR handshake).
pub mod pairing;

/// Snapshot encoding, crash-safe write, RESET apply, and 90-day compaction.
pub mod snapshot;
