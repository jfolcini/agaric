//! Snapshot encoding, crash-safe write, RESET apply, and 90-day compaction.
//!
//! Snapshots capture the full state of all core tables (blocks, block_tags,
//! block_properties, block_links, attachments) as zstd-compressed CBOR blobs
//! stored in the `log_snapshots` table.
//!
//! # Crash-safe write protocol
//!
//! 1. INSERT with `status = 'pending'` (includes the compressed data).
//! 2. UPDATE to `status = 'complete'`.
//!
//! If a crash occurs between steps 1 and 2, boot recovery
//! (`recovery::recover_at_boot`) deletes all pending rows.
//!
//! # Compaction
//!
//! [`compact_op_log`] creates a snapshot and then purges `op_log` rows older
//! than the configured retention window (default 90 days).

pub mod codec;
mod create;
mod restore;
pub mod types;

pub use codec::{decode_snapshot, encode_snapshot};
pub use create::{
    DEFAULT_RETENTION_DAYS, cleanup_old_snapshots, compact_op_log, create_snapshot,
    get_latest_snapshot, get_latest_snapshot_with_frontier,
};
#[allow(unused_imports)]
pub use create::{
    SNAPSHOT_WARN_PAYLOAD_BYTES, SNAPSHOT_WARN_ROW_COUNT, collect_frontier, collect_tables,
    measure_op_log_size,
};
pub use restore::apply_snapshot;
pub use types::{
    AttachmentSnapshot, BlockLinkSnapshot, BlockPropertySnapshot, BlockSnapshot, BlockTagSnapshot,
    PageAliasSnapshot, PropertyDefinitionSnapshot, SnapshotData, SnapshotTables,
};
// Re-export for tests and internal use
#[allow(unused_imports)]
pub use types::{MIN_SCHEMA_VERSION, SCHEMA_VERSION};
