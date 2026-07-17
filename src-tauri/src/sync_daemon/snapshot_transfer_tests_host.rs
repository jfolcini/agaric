//! #2621 Sync-D wrapper: hosts the app-coupled `snapshot_transfer_tests.rs`,
//! which was an inline child of the `snapshot_transfer` submodule (Sync-C-prep).
//! Its `use super::*` reached that module's namespace, so this wrapper
//! reconstructs it (`super` = this module). Declared as a real file — rather than
//! an inline `mod { … }` — so the `#[path]` below resolves against
//! `src/sync_daemon/` (an inline module's implied directory does not exist on
//! disk, which breaks a `../`-relative path).
#![allow(unused_imports)]

pub use agaric_sync::sync_daemon::snapshot_transfer::*;

pub use std::collections::BTreeMap;
pub use std::sync::Arc;
pub use std::sync::atomic::AtomicBool;
pub use tokio::io::AsyncWriteExt;

pub use crate::snapshot::{SCHEMA_VERSION, apply_snapshot, get_latest_snapshot_with_frontier};
pub use crate::sync_constants::BINARY_FRAME_CHUNK_SIZE;
pub use crate::sync_events::{SyncEvent, SyncEventSink};
pub use crate::sync_net::SyncConnection;
pub use crate::sync_protocol::loro_sync::{self, ApplyOutcome};
pub use crate::sync_protocol::loro_sync_types::LoroSyncMessage;
pub use crate::sync_protocol::{DeviceHead, SyncMessage};
pub use agaric_core::error::AppError;
pub use agaric_store::peer_refs;

#[path = "snapshot_transfer_tests.rs"]
mod snapshot_transfer_tests;
