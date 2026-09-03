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

/// Foreground/background gating primitive (`LifecycleHooks`). In `agaric-core`
/// since #4502 so the materializer can gate on it without depending on this
/// crate; re-exported so `crate::foreground::…` paths resolve unchanged.
pub use agaric_core::foreground;

/// Wire-protocol tunables (frame sizes, batch payload caps, handshake / connect
/// timeouts) shared across the sync stack. Pure constants; no dependencies.
pub mod sync_constants;

/// Process-global Android `JavaVM` + Application `Context` (#3847). Installed
/// from `JNI_OnLoad` (exported by the app crate's `android_jni` module) and
/// read by the multicast lock; iroh's DNS resolver reads the same handles via
/// `ndk_context`. Compiles everywhere — off Android it is permanently "not
/// installed", which is what makes the degrade path testable on the host.
pub mod android_context;

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

/// QUIC transport built on iroh (#78, plan #3464). The sole sync transport: it
/// replaced the WebSocket + mTLS stack (`sync_net`, `sync_cert`), which this
/// crate no longer carries. Owns the LAN-only endpoint configuration, the
/// offline guard that keeps it that way, the session framing, and the device's
/// long-lived endpoint identity.
pub mod transport;

/// LAN peer discovery over mDNS (#3488). Lifted out of the retired `sync_net`,
/// whose other half the cutover deleted: iroh's own address lookup is cleared by
/// [`transport::endpoint::lan_only`], so this is the only discovery left.
pub mod mdns;

/// Sync protocol orchestrator: head exchange, Loro-CRDT engine sync, peer-ref
/// bookkeeping.
pub mod sync_protocol;

/// Auto-sync daemon: background peer discovery, connection, and sync sessions.
pub mod sync_daemon;

/// Attachment file transfer over the sync session's bulk stream.
pub mod sync_files;

/// Per-peer sync locks, exponential backoff, debounced change notifications.
pub mod sync_scheduler;

/// LAN device pairing (passphrase + QR handshake).
pub mod pairing;

/// Snapshot encoding, crash-safe write, RESET apply, and 90-day compaction.
pub mod snapshot;
