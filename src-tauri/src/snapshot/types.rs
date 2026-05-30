use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

// Schema version bumps when the on-the-wire snapshot shape changes
// (column added or removed from `BlockSnapshot` / sibling row types).
// Older blobs still deserialise as long as every dropped field carries
// `#[serde(default)]` on intermediate versions; values for retired
// columns are simply discarded on restore.
pub(crate) const SCHEMA_VERSION: u32 = 4;

// ---------------------------------------------------------------------------
// Row types (CBOR + DB round-trip)
// ---------------------------------------------------------------------------

/// A single block row captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockSnapshot {
    pub id: crate::ulid::BlockId,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<crate::ulid::BlockId>,
    pub position: Option<i64>,
    /// Epoch-ms (blocks.deleted_at is INTEGER since migration 0080).
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub todo_state: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub scheduled_date: Option<String>,
}

/// A block–tag association captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockTagSnapshot {
    pub block_id: crate::ulid::BlockId,
    pub tag_id: String,
}

/// A block property row captured in a snapshot (key–value with typed values).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockPropertySnapshot {
    pub block_id: crate::ulid::BlockId,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
    /// PEND-14: native boolean property storage. Defaults to `None` so
    /// snapshots written before PEND-14 (no `value_bool` column) still
    /// deserialize. SQLite represents booleans as INTEGER (0/1).
    #[serde(default)]
    pub value_bool: Option<i64>,
}

/// A block-to-block link captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockLinkSnapshot {
    pub source_id: crate::ulid::BlockId,
    pub target_id: crate::ulid::BlockId,
}

/// A file attachment row captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AttachmentSnapshot {
    pub id: crate::ulid::BlockId,
    pub block_id: crate::ulid::BlockId,
    pub mime_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub fs_path: String,
    /// Epoch-ms (attachments.created_at is INTEGER since migration 0081).
    pub created_at: i64,
    /// STAYS TEXT — `attachments.deleted_at` is out of scope for #109 Phase 2.
    pub deleted_at: Option<String>,
}

/// A property definition row captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PropertyDefinitionSnapshot {
    pub key: String,
    pub value_type: String,
    pub options: Option<String>,
    pub created_at: String,
}

/// A page alias row captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PageAliasSnapshot {
    pub page_id: String,
    pub alias: String,
}

// ---------------------------------------------------------------------------
// Aggregate types
// ---------------------------------------------------------------------------

/// All core tables bundled together for snapshot serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotTables {
    pub blocks: Vec<BlockSnapshot>,
    pub block_tags: Vec<BlockTagSnapshot>,
    pub block_properties: Vec<BlockPropertySnapshot>,
    pub block_links: Vec<BlockLinkSnapshot>,
    pub attachments: Vec<AttachmentSnapshot>,
    #[serde(default)]
    pub property_definitions: Vec<PropertyDefinitionSnapshot>,
    #[serde(default)]
    pub page_aliases: Vec<PageAliasSnapshot>,
}

/// Complete snapshot: schema version, op frontier, and all table data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotData {
    pub schema_version: u32,
    pub snapshot_device_id: String,
    pub up_to_seqs: BTreeMap<String, i64>,
    pub up_to_hash: String,
    pub tables: SnapshotTables,
}
