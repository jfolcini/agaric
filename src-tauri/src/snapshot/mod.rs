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
//! ([`crate::recovery::recover_at_boot`]) deletes all pending rows.
//!
//! # Compaction
//!
//! [`compact_op_log`] creates a snapshot and then purges `op_log` rows older
//! than the configured retention window (default 90 days).

mod codec;
mod create;
mod restore;
mod types;

#[cfg(test)]
mod tests;

pub use codec::{decode_snapshot, encode_snapshot};
pub use create::{
    cleanup_old_snapshots, compact_op_log, create_snapshot, get_latest_snapshot,
    DEFAULT_RETENTION_DAYS,
};
pub use restore::apply_snapshot;
pub use types::{
    AttachmentSnapshot, BlockLinkSnapshot, BlockPropertySnapshot, BlockSnapshot, BlockTagSnapshot,
    SnapshotData, SnapshotTables,
};
// Re-export for tests and internal use
#[allow(unused_imports)]
pub(crate) use types::SCHEMA_VERSION;
