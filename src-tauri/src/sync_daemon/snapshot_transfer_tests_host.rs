//! #2621 Sync-D wrapper: hosts the app-coupled `snapshot_transfer_tests.rs`,
//! which was an inline child of the `snapshot_transfer` submodule (Sync-C-prep).
//! Its `use super::*` reached that module's namespace, so this wrapper
//! reconstructs it (`super` = this module). Declared as a real file — rather than
//! an inline `mod { … }` — so the `#[path]` below resolves against
//! `src/sync_daemon/` (an inline module's implied directory does not exist on
//! disk, which breaks a `../`-relative path).
#![allow(unused_imports)]

use agaric_sync::sync_daemon::snapshot_transfer::*;

pub use std::collections::BTreeMap;
pub use std::sync::Arc;
pub use std::sync::atomic::AtomicBool;
pub use tokio::io::AsyncWriteExt;

use agaric_core::error::AppError;
use agaric_store::peer_refs;
use agaric_sync::snapshot::{SCHEMA_VERSION, apply_snapshot, get_latest_snapshot_with_frontier};
use agaric_sync::sync_constants::BINARY_FRAME_CHUNK_SIZE;
use agaric_sync::sync_events::{SyncEvent, SyncEventSink};
use agaric_sync::sync_net::SyncConnection;
use agaric_sync::sync_protocol::loro_sync::{self, ApplyOutcome};
use agaric_sync::sync_protocol::loro_sync_types::LoroSyncMessage;
use agaric_sync::sync_protocol::{DeviceHead, SyncMessage};

#[path = "snapshot_transfer_tests.rs"]
mod snapshot_transfer_tests;
