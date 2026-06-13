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
pub(crate) const SCHEMA_VERSION: u32 = 5;

// #706 item 1 — version gate BEFORE table decode.
//
// The accepted floor is NOT `1`. The `deleted_at TEXT → Option<i64>`
// (migration 0080) and `created_at TEXT → i64` (0081) column-type
// changes in `BlockSnapshot` / `AttachmentSnapshot` carry no
// `#[serde(default)]` and are not type-compatible with the original
// shape, so a genuine pre-0080/0081 (`v1..=v3`) blob can never decode
// into today's structs — it fails deep inside `tables` as a raw "CBOR
// decode" error long after a `1..=SCHEMA_VERSION` check would have
// admitted it. That made the old post-decode gate actively misleading
// (it nominally accepted v1, then the table decode blew up).
//
// `MIN_SCHEMA_VERSION` is the first version whose on-wire layout matches
// the current structs. #109 Phase 2 introduced the i64 epoch-ms columns
// (`blocks.deleted_at` / `attachments.created_at`) together with the v4
// bump, so v4 and v5 (v5 only adds the `#[serde(default)]` `space_id`,
// which is forward-compatible) share the current decodable shape. v1..=v3
// carried the old TEXT timestamp columns and can never deserialize into
// today's structs. Snapshots at or above the floor decode cleanly; older
// ones are rejected up front with an honest "unsupported schema version"
// message instead of a confusing decode failure buried in `tables`.
pub(crate) const MIN_SCHEMA_VERSION: u32 = 4;

/// Validating deserializer for [`SnapshotData::schema_version`].
///
/// #706 item 1: because ciborium deserializes struct fields in
/// declaration order and `schema_version` is the FIRST field of
/// [`SnapshotData`], running the range check *here* gates the version
/// BEFORE the expensive / type-fragile `tables` field is decoded. An
/// incompatible version is rejected without ever attempting to parse the
/// old table shapes, so the error is the honest "unsupported version …"
/// rather than a misleading "CBOR decode" failure originating inside a
/// renamed/retyped column. The whole decode still happens in the single
/// streaming pass (no second read of the reader), preserving the
/// memory-bounded L-67 / #428 decode contract.
fn deserialize_gated_schema_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let version = u32::deserialize(deserializer)?;
    if !(MIN_SCHEMA_VERSION..=SCHEMA_VERSION).contains(&version) {
        return Err(serde::de::Error::custom(format!(
            "unsupported schema version {version} \
             (expected {MIN_SCHEMA_VERSION}..={SCHEMA_VERSION})"
        )));
    }
    Ok(version)
}

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
    /// #533: native space membership (`blocks.space_id`, migration 0086).
    /// Captured + restored so a snapshot RESET preserves space membership —
    /// without it every restored block lands NULL and vanishes from
    /// space-filtered reads (the `block_properties(key='space')` rows are
    /// gone and the op_log is wiped on restore, so it can't be re-derived).
    /// `#[serde(default)]` keeps pre-v5 snapshots decodable (→ None).
    #[serde(default)]
    pub space_id: Option<crate::ulid::BlockId>,
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
    #[serde(deserialize_with = "deserialize_gated_schema_version")]
    pub schema_version: u32,
    pub snapshot_device_id: String,
    pub up_to_seqs: BTreeMap<String, i64>,
    pub up_to_hash: String,
    pub tables: SnapshotTables,
}
