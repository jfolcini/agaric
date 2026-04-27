use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

// MAINT-133: bumped 2 → 3 when `BlockSnapshot::conflict_type` joined the
// snapshot pipeline. The decoder accepts `1..=SCHEMA_VERSION`, and the
// `serde(default)` annotations on the new (and previously-added) `Option`
// fields mean older v1/v2 blobs decode cleanly with `None` for any
// missing field — see `decode_rejects_bad_version` and the v2-format
// regression test in tests.rs.
pub(crate) const SCHEMA_VERSION: u32 = 3;

// ---------------------------------------------------------------------------
// Row types (CBOR + DB round-trip)
// ---------------------------------------------------------------------------

/// A single block row captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockSnapshot {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
    pub is_conflict: i64,
    pub conflict_source: Option<String>,
    /// MAINT-133: type of conflict ('Text', 'Property', 'Move', 'DeleteEdit')
    /// for conflict-copy blocks; NULL for non-conflict blocks. Added to the
    /// snapshot pipeline alongside SCHEMA_VERSION = 3 so older v1/v2 blobs
    /// (which omit the field entirely) decode with `None` via `serde(default)`.
    #[serde(default)]
    pub conflict_type: Option<String>,
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
    pub block_id: String,
    pub tag_id: String,
}

/// A block property row captured in a snapshot (key–value with typed values).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockPropertySnapshot {
    pub block_id: String,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
}

/// A block-to-block link captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockLinkSnapshot {
    pub source_id: String,
    pub target_id: String,
}

/// A file attachment row captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AttachmentSnapshot {
    pub id: String,
    pub block_id: String,
    pub mime_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub fs_path: String,
    pub created_at: String,
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
