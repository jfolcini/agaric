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
pub const SCHEMA_VERSION: u32 = 6;

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
// bump, so v4..=v6 share the current decodable shape: v5 only adds the
// `#[serde(default)]` `space_id` and v6 only adds the `#[serde(default)]`
// `attachments.content_hash` (#2022) — both forward/backward-compatible
// (an old blob omits the field → decodes as `None`; a new blob's extra
// field is simply absent in older readers). v1..=v3 carried the old TEXT
// timestamp columns and can never deserialize into today's structs.
// Snapshots at or above the floor decode cleanly; older ones are rejected
// up front with an honest "unsupported schema version" message instead of
// a confusing decode failure buried in `tables`.
pub const MIN_SCHEMA_VERSION: u32 = 4;

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
/// Memory-bounded / #428 decode contract.
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
    pub id: agaric_core::ulid::BlockId,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<agaric_core::ulid::BlockId>,
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
    pub space_id: Option<agaric_core::ulid::BlockId>,
}

/// A block–tag association captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockTagSnapshot {
    pub block_id: agaric_core::ulid::BlockId,
    pub tag_id: String,
}

/// A block property row captured in a snapshot (key–value with typed values).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockPropertySnapshot {
    pub block_id: agaric_core::ulid::BlockId,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
    /// Native boolean property storage. Defaults to `None` so
    /// Snapshots written before (no `value_bool` column) still
    /// deserialize. SQLite represents booleans as INTEGER (0/1).
    #[serde(default)]
    pub value_bool: Option<i64>,
}

/// A block-to-block link captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BlockLinkSnapshot {
    pub source_id: agaric_core::ulid::BlockId,
    pub target_id: agaric_core::ulid::BlockId,
}

/// A file attachment row captured in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AttachmentSnapshot {
    pub id: agaric_core::ulid::BlockId,
    pub block_id: agaric_core::ulid::BlockId,
    pub mime_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub fs_path: String,
    /// Epoch-ms (attachments.created_at is INTEGER since migration 0081).
    pub created_at: i64,
    /// STAYS TEXT — `attachments.deleted_at` is out of scope for #109 Phase 2.
    pub deleted_at: Option<String>,
    /// #2022: blake3 content hash (`attachments.content_hash`, migration 0093).
    /// Captured + restored so a snapshot RESET preserves the attachment dedup
    /// link — without it every restored attachment lands NULL and the
    /// `attachment_blobs` (hash → path) layer is inconsistent until the
    /// boot-time backfill re-hashes every file. `#[serde(default)]` keeps
    /// pre-v6 snapshots decodable (→ None).
    #[serde(default)]
    pub content_hash: Option<String>,
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

// ---------------------------------------------------------------------------
// #3460 — schema shape pinning
// ---------------------------------------------------------------------------
//
// `SCHEMA_VERSION`'s doc comment states a back-compat rule ("a dropped field
// must carry `#[serde(default)]`") but nothing enforced it before this test
// module: six versions shipped on an honour system, and a violation would
// only surface at a user's restore. These tests pin the exact serialized
// shape of every row type in this module (via `insta`) so ANY change to a
// field — add, remove, rename, retype — shows up as a mandatory, reviewable
// `.snap` diff instead of silently changing the wire format. They also pin
// `SCHEMA_VERSION` / `MIN_SCHEMA_VERSION` themselves and round-trip a full
// `SnapshotData` through `encode_snapshot` / `decode_snapshot`.
//
// Every fixture below gives EVERY field a distinct, non-default value — a
// fixture full of `None` / `0` / `""` would still serialize identically after
// a field is silently dropped (serde just omits it), so it would pin nothing.
#[cfg(test)]
mod tests {
    use super::*;
    use agaric_core::ulid::BlockId;

    fn block_fixture() -> BlockSnapshot {
        BlockSnapshot {
            id: BlockId::test_id("BLK01"),
            block_type: "heading".to_string(),
            content: Some("Quarterly roadmap".to_string()),
            parent_id: Some(BlockId::test_id("PARENT01")),
            position: Some(7),
            deleted_at: Some(1_700_000_000_000),
            todo_state: Some("doing".to_string()),
            priority: Some("high".to_string()),
            due_date: Some("2026-01-15".to_string()),
            scheduled_date: Some("2026-01-10".to_string()),
            space_id: Some(BlockId::test_id("SPACE01")),
        }
    }

    fn block_tag_fixture() -> BlockTagSnapshot {
        BlockTagSnapshot {
            block_id: BlockId::test_id("BLK02"),
            tag_id: "tag-important".to_string(),
        }
    }

    fn block_property_fixture() -> BlockPropertySnapshot {
        BlockPropertySnapshot {
            block_id: BlockId::test_id("BLK03"),
            key: "due".to_string(),
            value_text: Some("needs review".to_string()),
            value_num: Some(42.5),
            value_date: Some("2026-02-02".to_string()),
            value_ref: Some(BlockId::test_id("REF01").to_string()),
            value_bool: Some(1),
        }
    }

    fn block_link_fixture() -> BlockLinkSnapshot {
        BlockLinkSnapshot {
            source_id: BlockId::test_id("SRC01"),
            target_id: BlockId::test_id("TGT01"),
        }
    }

    /// The insta redactions on `AttachmentSnapshot::deleted_at` and
    /// `PropertyDefinitionSnapshot::created_at` replace the value with
    /// `[TIMESTAMP]` **by path, regardless of its type**. That closes the
    /// non-determinism the redaction guard requires, but it opens a hole exactly
    /// where the history says the risk lives: a TEXT -> INTEGER retype of either
    /// field would leave all nine `.snap` files byte-identical, and a
    /// column-retype migration is precisely the class of change credited with
    /// forcing `MIN_SCHEMA_VERSION = 4`.
    ///
    /// These two are the only snapshot timestamps still carried as
    /// `Option<String>` ISO-8601 rather than `i64` epoch-ms (a deliberate #109
    /// Phase 2 carve-out), which is why they need redacting at all while
    /// `BlockSnapshot::deleted_at` does not.
    ///
    /// So the shape is pinned here instead, independently of the snapshots: the
    /// serialized value must be a JSON **string**.
    ///
    /// One nuance found while falsifying this, which narrows what it is for.
    /// Retyping the Rust field alone does **not** reach this test — it is a
    /// compile error, because `sqlx::query_as!` verifies the field type against
    /// the live column at build time (`Option<String>` will not coerce to
    /// `Option<i64>`). Likewise a migration that retypes the column alone breaks
    /// the same macro. So the uncoordinated half of the risk is already caught,
    /// and caught earlier, by the compiler.
    ///
    /// What this test covers is the **coordinated** change: a migration and the
    /// struct moving together, which compiles cleanly, leaves every `.snap`
    /// byte-identical because the redaction erases the value's type along with
    /// its content, and would otherwise ship silently.
    #[test]
    fn iso8601_timestamp_fields_serialize_as_strings_not_numbers() {
        let attachment = serde_json::to_value(attachment_fixture()).expect("serializes");
        assert!(
            attachment["deleted_at"].is_string(),
            "AttachmentSnapshot::deleted_at must serialize as a string; a retype to \
             INTEGER is invisible to the redacted snapshots. Got: {:?}",
            attachment["deleted_at"]
        );

        let prop = serde_json::to_value(property_definition_fixture()).expect("serializes");
        assert!(
            prop["created_at"].is_string(),
            "PropertyDefinitionSnapshot::created_at must serialize as a string; a retype \
             to INTEGER is invisible to the redacted snapshots. Got: {:?}",
            prop["created_at"]
        );
    }

    fn attachment_fixture() -> AttachmentSnapshot {
        AttachmentSnapshot {
            id: BlockId::test_id("ATT01"),
            block_id: BlockId::test_id("BLK04"),
            mime_type: "image/png".to_string(),
            filename: "photo.png".to_string(),
            size_bytes: 123_456,
            fs_path: "/vault/attachments/photo.png".to_string(),
            created_at: 1_690_000_000_000,
            deleted_at: Some("2026-03-03T00:00:00Z".to_string()),
            content_hash: Some("b3:deadbeefcafebabe".to_string()),
        }
    }

    fn property_definition_fixture() -> PropertyDefinitionSnapshot {
        PropertyDefinitionSnapshot {
            key: "priority".to_string(),
            value_type: "select".to_string(),
            options: Some("low,medium,high".to_string()),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn page_alias_fixture() -> PageAliasSnapshot {
        PageAliasSnapshot {
            page_id: "PAGE01".to_string(),
            alias: "Q1 Roadmap".to_string(),
        }
    }

    fn snapshot_tables_fixture() -> SnapshotTables {
        SnapshotTables {
            blocks: vec![block_fixture()],
            block_tags: vec![block_tag_fixture()],
            block_properties: vec![block_property_fixture()],
            block_links: vec![block_link_fixture()],
            attachments: vec![attachment_fixture()],
            property_definitions: vec![property_definition_fixture()],
            page_aliases: vec![page_alias_fixture()],
        }
    }

    fn snapshot_data_fixture() -> SnapshotData {
        SnapshotData {
            schema_version: SCHEMA_VERSION,
            snapshot_device_id: "device-abc-123".to_string(),
            up_to_seqs: BTreeMap::from([
                ("device-abc-123".to_string(), 42),
                ("device-xyz-999".to_string(), 17),
            ]),
            up_to_hash: "deadbeefcafebabe0011223344556677".to_string(),
            tables: snapshot_tables_fixture(),
        }
    }

    // -----------------------------------------------------------------------
    // Shape-pinning snapshots — one per row type named in #3460.
    // -----------------------------------------------------------------------

    #[test]
    fn snapshot_block_snapshot_shape() {
        insta::assert_yaml_snapshot!(block_fixture());
    }

    #[test]
    fn snapshot_block_tag_snapshot_shape() {
        insta::assert_yaml_snapshot!(block_tag_fixture());
    }

    #[test]
    fn snapshot_block_property_snapshot_shape() {
        insta::assert_yaml_snapshot!(block_property_fixture());
    }

    #[test]
    fn snapshot_block_link_snapshot_shape() {
        insta::assert_yaml_snapshot!(block_link_fixture());
    }

    #[test]
    fn snapshot_attachment_snapshot_shape() {
        insta::assert_yaml_snapshot!(attachment_fixture(), {
            ".deleted_at" => "[TIMESTAMP]",
        });
    }

    #[test]
    fn snapshot_property_definition_snapshot_shape() {
        insta::assert_yaml_snapshot!(property_definition_fixture(), {
            ".created_at" => "[TIMESTAMP]",
        });
    }

    #[test]
    fn snapshot_page_alias_snapshot_shape() {
        insta::assert_yaml_snapshot!(page_alias_fixture());
    }

    #[test]
    fn snapshot_snapshot_tables_shape() {
        insta::assert_yaml_snapshot!(snapshot_tables_fixture(), {
            ".attachments[].deleted_at" => "[TIMESTAMP]",
            ".property_definitions[].created_at" => "[TIMESTAMP]",
        });
    }

    #[test]
    fn snapshot_snapshot_data_shape() {
        insta::assert_yaml_snapshot!(snapshot_data_fixture(), {
            ".tables.attachments[].deleted_at" => "[TIMESTAMP]",
            ".tables.property_definitions[].created_at" => "[TIMESTAMP]",
        });
    }

    // -----------------------------------------------------------------------
    // Version constants — a bump must be a deliberate, visible diff.
    // -----------------------------------------------------------------------

    #[test]
    fn schema_version_constants_are_pinned() {
        assert_eq!(
            SCHEMA_VERSION, 6,
            "SCHEMA_VERSION changed — this must be a deliberate bump, reviewed \
             alongside the corresponding shape-pinning `.snap` diffs above, not \
             an incidental side effect of an unrelated change"
        );
        assert_eq!(
            MIN_SCHEMA_VERSION, 4,
            "MIN_SCHEMA_VERSION changed — verify old snapshots in that range \
             genuinely still decode under the current struct shapes before \
             widening (or narrowing) the accepted range"
        );
    }

    // -----------------------------------------------------------------------
    // Round-trip — encode_snapshot / decode_snapshot must be inverses.
    // -----------------------------------------------------------------------

    #[test]
    fn snapshot_data_round_trips_through_encode_decode() {
        let original = snapshot_data_fixture();

        let encoded =
            super::super::codec::encode_snapshot(&original).expect("encode_snapshot failed");
        let decoded =
            super::super::codec::decode_snapshot(&encoded[..]).expect("decode_snapshot failed");

        // Compare via JSON `Value` rather than deriving `PartialEq` on the
        // production types (which would otherwise exist only for this test):
        // any field dropped or altered in transit — including one silently
        // defaulted by a permissive `#[serde(default)]` deserializer — shows
        // up as a JSON diff.
        let original_json = serde_json::to_value(&original).expect("serialize original");
        let decoded_json = serde_json::to_value(&decoded).expect("serialize decoded");
        assert_eq!(
            original_json, decoded_json,
            "SnapshotData did not round-trip through encode_snapshot/decode_snapshot \
             byte-for-byte — a field was lost or altered on the way through"
        );
    }
}
