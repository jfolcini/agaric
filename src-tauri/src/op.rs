//! Op payload types for the CRDT op log.
//!
//! Each operation in the log has a typed payload. The [`OpType`] enum identifies
//! the operation kind, and [`OpPayload`] is an internally-tagged enum that wraps
//! all payload structs for (de)serialization.
//!
//! ## Validation
//!
//! These types are *structural* — they enforce correct shapes at
//! (de)serialization time but do **not** validate domain invariants such as
//! non-empty `block_id`. Domain validation is the responsibility of the command
//! layer that constructs payloads before appending to the op log.
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::ulid::{AttachmentId, BlockId};

// ---------------------------------------------------------------------------
// OpType — the string tag stored in op_log.op_type
// ---------------------------------------------------------------------------

/// Operation type tag. Serialized as snake_case strings for storage in the
/// `op_log.op_type` TEXT column.
///
/// Marked `#[non_exhaustive]` so that new variants can be added in future
/// versions without breaking downstream match arms outside this crate.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum OpType {
    CreateBlock,
    EditBlock,
    DeleteBlock,
    RestoreBlock,
    PurgeBlock,
    MoveBlock,
    AddTag,
    RemoveTag,
    SetProperty,
    DeleteProperty,
    AddAttachment,
    DeleteAttachment,
}

impl OpType {
    /// Returns the snake_case string representation, matching the serde
    /// serialization and the `op_log.op_type` column value.
    ///
    /// This is the single source of truth for the string mapping. Both
    /// [`Display`] and [`OpPayload::op_type_str`] delegate here.
    pub fn as_str(&self) -> &'static str {
        match self {
            OpType::CreateBlock => "create_block",
            OpType::EditBlock => "edit_block",
            OpType::DeleteBlock => "delete_block",
            OpType::RestoreBlock => "restore_block",
            OpType::PurgeBlock => "purge_block",
            OpType::MoveBlock => "move_block",
            OpType::AddTag => "add_tag",
            OpType::RemoveTag => "remove_tag",
            OpType::SetProperty => "set_property",
            OpType::DeleteProperty => "delete_property",
            OpType::AddAttachment => "add_attachment",
            OpType::DeleteAttachment => "delete_attachment",
        }
    }
}

impl fmt::Display for OpType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for OpType {
    type Err = String;

    /// Parses a snake_case string (e.g. `"create_block"`) into an [`OpType`].
    ///
    /// Uses a manual match to avoid the overhead of serde_json deserialization
    /// for this simple string-to-enum conversion. The match arms mirror
    /// [`OpType::as_str`] to guarantee round-trip consistency.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "create_block" => Ok(OpType::CreateBlock),
            "edit_block" => Ok(OpType::EditBlock),
            "delete_block" => Ok(OpType::DeleteBlock),
            "restore_block" => Ok(OpType::RestoreBlock),
            "purge_block" => Ok(OpType::PurgeBlock),
            "move_block" => Ok(OpType::MoveBlock),
            "add_tag" => Ok(OpType::AddTag),
            "remove_tag" => Ok(OpType::RemoveTag),
            "set_property" => Ok(OpType::SetProperty),
            "delete_property" => Ok(OpType::DeleteProperty),
            "add_attachment" => Ok(OpType::AddAttachment),
            "delete_attachment" => Ok(OpType::DeleteAttachment),
            other => Err(format!("unknown op type: {other}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Payload structs — one per OpType variant
// ---------------------------------------------------------------------------

/// Payload for the `create_block` op — creates a new block with the given type, content, and optional parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateBlockPayload {
    pub block_id: BlockId,
    pub block_type: String,
    pub parent_id: Option<BlockId>,
    pub position: Option<i64>,
    pub content: String,
}

/// Payload for the `edit_block` op — replaces a block's content with `to_text`, tracking the previous edit for conflict detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditBlockPayload {
    pub block_id: BlockId,
    pub to_text: String,
    /// Previous edit reference as `(device_id, seq)`. Serialized as a JSON
    /// two-element array `[device_id, seq]` or `null`.
    pub prev_edit: Option<(String, i64)>,
}

/// Delete always cascades to all descendants. The `cascade` field
/// was removed — it was always `true` and never read by any code path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteBlockPayload {
    pub block_id: BlockId,
}

/// Payload for the `restore_block` op — un-deletes a block and its descendants using the `deleted_at` timestamp as a guard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreBlockPayload {
    pub block_id: BlockId,
    pub deleted_at_ref: String,
}

/// Payload for the `purge_block` op — physically deletes a soft-deleted block and all its descendants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurgeBlockPayload {
    pub block_id: BlockId,
}

/// Payload for the `move_block` op — reparents a block under a new parent at the given position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveBlockPayload {
    pub block_id: BlockId,
    pub new_parent_id: Option<BlockId>,
    pub new_position: i64,
}

/// Payload for the `add_tag` op — associates a tag block with a content/page block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddTagPayload {
    pub block_id: BlockId,
    pub tag_id: BlockId,
}

/// Payload for the `remove_tag` op — dissociates a tag block from a content/page block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveTagPayload {
    pub block_id: BlockId,
    pub tag_id: BlockId,
}

/// Payload for the `set_property` op — upserts a typed key-value property on a block (exactly one value field must be set).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetPropertyPayload {
    pub block_id: BlockId,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
}

/// Payload for the `delete_property` op — removes a property by key from a block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeletePropertyPayload {
    pub block_id: BlockId,
    pub key: String,
}

/// Payload for the `add_attachment` op — records a new file attachment linked to a block.
///
/// `attachment_id` is an [`AttachmentId`] (alias of [`BlockId`]) so that it
/// auto-uppercases on construction / deserialization. Storing it as a raw
/// `String` would bypass the uppercase contract and feed un-normalized bytes
/// into [`compute_op_hash`](crate::hash::compute_op_hash), breaking the
/// blake3 hash determinism that AGENTS.md invariant #8 relies on for
/// cross-device sync. The serde wire format is unchanged (`BlockId` is
/// `#[serde(transparent)]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddAttachmentPayload {
    pub attachment_id: AttachmentId,
    pub block_id: BlockId,
    pub mime_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub fs_path: String,
}

/// Payload for the `delete_attachment` op — removes an attachment by its ID (block_id is not needed).
///
/// `fs_path` carries the on-disk path (relative to `app_data_dir`) of the
/// attachment file at the time of deletion so the local apply step can
/// unlink it. Marked `#[serde(default)]` so op-log entries written before
/// C-3 (which had no `fs_path`) still deserialize — they yield `fs_path
/// = ""` and will be reconciled by the C-3c GC pass.
///
/// `attachment_id` is an [`AttachmentId`] (alias of [`BlockId`]) for the
/// same uppercase-normalization contract as [`AddAttachmentPayload`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteAttachmentPayload {
    pub attachment_id: AttachmentId,
    #[serde(default)]
    pub fs_path: String,
}

// ---------------------------------------------------------------------------
// Undo/Redo types
// ---------------------------------------------------------------------------

/// Reference to a specific op in the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct OpRef {
    pub device_id: String,
    pub seq: i64,
}

/// Result of an undo or redo operation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UndoResult {
    /// The op that was reversed (the original op for undo, the undo-op for redo).
    pub reversed_op: OpRef,
    /// The op_type of the reversed op (e.g. `create_block`, `edit_block`, `set_property`).
    /// Used by the frontend to show a descriptive toast ("Undid create", "Undid edit", etc.).
    pub reversed_op_type: String,
    /// The newly appended reverse op.
    pub new_op_ref: OpRef,
    /// The op_type of the newly appended op.
    pub new_op_type: String,
    /// Whether this was a redo (true) or undo (false).
    pub is_redo: bool,
}

// ---------------------------------------------------------------------------
// OpPayload — tagged union of all payload structs
// ---------------------------------------------------------------------------

/// Wrapper enum for all op payloads. Uses serde's internally-tagged
/// representation so that serialized JSON includes `"op_type": "..."` alongside
/// the payload fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op_type", rename_all = "snake_case")]
pub enum OpPayload {
    CreateBlock(CreateBlockPayload),
    EditBlock(EditBlockPayload),
    DeleteBlock(DeleteBlockPayload),
    RestoreBlock(RestoreBlockPayload),
    PurgeBlock(PurgeBlockPayload),
    MoveBlock(MoveBlockPayload),
    AddTag(AddTagPayload),
    RemoveTag(RemoveTagPayload),
    SetProperty(SetPropertyPayload),
    DeleteProperty(DeletePropertyPayload),
    AddAttachment(AddAttachmentPayload),
    DeleteAttachment(DeleteAttachmentPayload),
}

impl OpPayload {
    /// Returns the [`OpType`] corresponding to this payload variant.
    pub fn op_type(&self) -> OpType {
        match self {
            OpPayload::CreateBlock(_) => OpType::CreateBlock,
            OpPayload::EditBlock(_) => OpType::EditBlock,
            OpPayload::DeleteBlock(_) => OpType::DeleteBlock,
            OpPayload::RestoreBlock(_) => OpType::RestoreBlock,
            OpPayload::PurgeBlock(_) => OpType::PurgeBlock,
            OpPayload::MoveBlock(_) => OpType::MoveBlock,
            OpPayload::AddTag(_) => OpType::AddTag,
            OpPayload::RemoveTag(_) => OpType::RemoveTag,
            OpPayload::SetProperty(_) => OpType::SetProperty,
            OpPayload::DeleteProperty(_) => OpType::DeleteProperty,
            OpPayload::AddAttachment(_) => OpType::AddAttachment,
            OpPayload::DeleteAttachment(_) => OpType::DeleteAttachment,
        }
    }

    /// Returns the op type as a snake_case string suitable for the
    /// `op_log.op_type` column.
    ///
    /// Delegates to [`OpType::as_str`] to keep the string mapping in one place.
    pub fn op_type_str(&self) -> &'static str {
        self.op_type().as_str()
    }

    /// Returns the `block_id` from the inner payload, if present.
    ///
    /// All payload variants except [`DeleteAttachment`](OpPayload::DeleteAttachment)
    /// carry a `block_id`. `DeleteAttachment` identifies the target by
    /// `attachment_id` only, so this method returns `None` for that variant.
    pub fn block_id(&self) -> Option<&str> {
        match self {
            OpPayload::CreateBlock(p) => Some(p.block_id.as_str()),
            OpPayload::EditBlock(p) => Some(p.block_id.as_str()),
            OpPayload::DeleteBlock(p) => Some(p.block_id.as_str()),
            OpPayload::RestoreBlock(p) => Some(p.block_id.as_str()),
            OpPayload::PurgeBlock(p) => Some(p.block_id.as_str()),
            OpPayload::MoveBlock(p) => Some(p.block_id.as_str()),
            OpPayload::AddTag(p) => Some(p.block_id.as_str()),
            OpPayload::RemoveTag(p) => Some(p.block_id.as_str()),
            OpPayload::SetProperty(p) => Some(p.block_id.as_str()),
            OpPayload::DeleteProperty(p) => Some(p.block_id.as_str()),
            OpPayload::AddAttachment(p) => Some(p.block_id.as_str()),
            OpPayload::DeleteAttachment(_) => None,
        }
    }

    /// Normalize all ULID-typed fields to uppercase Crockford base32.
    ///
    /// BlockId fields auto-normalize to uppercase Crockford base32 on
    /// construction and deserialization. This function is retained as a
    /// call-site marker for the normalization contract.
    pub fn normalize_block_ids(&mut self) {
        // BlockId fields auto-normalize to uppercase Crockford base32 on
        // construction and deserialization. This function is retained as a
        // call-site marker for the normalization contract.
    }
}

/// Validate that a [`SetPropertyPayload`] has exactly one non-null value field
/// and that the `key` matches the allowed format.
///
/// Reserved property keys that map to fixed columns on the `blocks` table.
pub fn is_reserved_property_key(key: &str) -> bool {
    matches!(
        key,
        "todo_state" | "priority" | "due_date" | "scheduled_date"
    )
}

/// Property keys that are system-managed and must not be deleted by users.
///
/// Reserved column keys (`todo_state`, `priority`, `due_date`,
/// `scheduled_date`) live on the `blocks` table and are managed via
/// dedicated setters.  System-lifecycle keys (`created_at`, `completed_at`,
/// `repeat-*`) are written by internal state-transition helpers.
///
/// User-settable properties like `effort`, `assignee`, and `location` are
/// intentionally **not** included — users must be able to remove them.
pub fn is_builtin_property_key(key: &str) -> bool {
    matches!(
        key,
        "todo_state"
            | "priority"
            | "due_date"
            | "scheduled_date"
            | "created_at"
            | "completed_at"
            | "repeat"
            | "repeat-until"
            | "repeat-count"
            | "repeat-seq"
            | "repeat-origin"
    )
}

/// The schema allows multiple value columns (text, num, date, ref) but the
/// domain invariant is that exactly one must be set per operation. This
/// function enforces that invariant at the command layer, before the payload
/// is appended to the op log.
///
/// Key format: alphanumeric characters, hyphens, and underscores only,
/// 1–64 characters. This prevents garbage keys that could break UI rendering
/// or sync.
///
/// Returns `Ok(())` if valid, or an `AppError::Validation` describing the
/// violation.
pub fn validate_set_property(p: &SetPropertyPayload) -> Result<(), crate::error::AppError> {
    // Validate key format: alphanumeric + hyphens + underscores, 1-64 chars
    if p.key.is_empty() || p.key.len() > 64 {
        return Err(crate::error::AppError::Validation(format!(
            "property key must be 1-64 characters, got {} characters",
            p.key.len()
        )));
    }
    if !p
        .key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(crate::error::AppError::Validation(format!(
            "property key must contain only alphanumeric characters, hyphens, and underscores, got '{}'",
            p.key
        )));
    }

    // Reject NaN / Infinity — these are not valid domain values and would
    // corrupt downstream consumers that expect finite numbers.
    if let Some(num) = p.value_num {
        if !num.is_finite() {
            return Err(crate::error::AppError::Validation(format!(
                "value_num must be finite, got {num}"
            )));
        }
    }

    let count = [
        p.value_text.is_some(),
        p.value_num.is_some(),
        p.value_date.is_some(),
        p.value_ref.is_some(),
    ]
    .iter()
    .filter(|&&b| b)
    .count();

    if count == 1 {
        // L-6 — Reject empty / whitespace-only string fields. The frontend
        // already enforces non-empty values, but op-log entries can also
        // originate from MCP tools and import paths, so backend-side
        // validation prevents downstream parse failures (e.g. agenda code
        // parses `value_date` as ISO 8601 and chokes on `""`).
        // `value_num` is unaffected — finite-ness is checked above.
        if p.value_text.as_ref().is_some_and(|s| s.trim().is_empty()) {
            return Err(crate::error::AppError::Validation(
                "set_property.value_text.empty".into(),
            ));
        }
        if p.value_date.as_ref().is_some_and(|s| s.trim().is_empty()) {
            return Err(crate::error::AppError::Validation(
                "set_property.value_date.empty".into(),
            ));
        }
        if p.value_ref.as_ref().is_some_and(|s| s.trim().is_empty()) {
            return Err(crate::error::AppError::Validation(
                "set_property.value_ref.empty".into(),
            ));
        }
        Ok(())
    } else if count == 0 && is_reserved_property_key(&p.key) {
        // Reserved keys allow all-null values (= clear the column)
        Ok(())
    } else {
        Err(crate::error::AppError::Validation(format!(
            "SetProperty must have exactly 1 non-null value field, found {count}"
        )))
    }
}

// ===========================================================================
// Tests
// ===========================================================================

/// Tests for `OpType`, `OpPayload`, and all 12 payload structs.
///
/// Covers serde round-trips, `Display`/`FromStr` consistency, `block_id()`
/// extraction, raw-JSON deserialization, error handling for malformed or
/// unknown inputs, and edge cases (unicode, empty, large content, optional
/// fields).
#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Valid ULID fixture constants for tests that go through serde round-trips.
    const TEST_BID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const TEST_PID: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const TEST_TID: &str = "01BX5ZZKBKACTAV9WEVGEMMVS0";

    /// All OpType variants, for exhaustive iteration in tests.
    fn all_op_types() -> Vec<OpType> {
        vec![
            OpType::CreateBlock,
            OpType::EditBlock,
            OpType::DeleteBlock,
            OpType::RestoreBlock,
            OpType::PurgeBlock,
            OpType::MoveBlock,
            OpType::AddTag,
            OpType::RemoveTag,
            OpType::SetProperty,
            OpType::DeleteProperty,
            OpType::AddAttachment,
            OpType::DeleteAttachment,
        ]
    }

    /// Builds one test instance of each OpPayload variant with valid ULID block_ids
    /// so serde round-trips work.
    fn all_test_payloads() -> Vec<OpPayload> {
        vec![
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_string(TEST_PID).unwrap()),
                position: Some(1),
                content: "hello".into(),
            }),
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                to_text: "updated".into(),
                prev_edit: Some(("dev-1".into(), 1)),
            }),
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
            }),
            OpPayload::RestoreBlock(RestoreBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                deleted_at_ref: "ref-1".into(),
            }),
            OpPayload::PurgeBlock(PurgeBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
            }),
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                new_parent_id: Some(BlockId::from_string(TEST_PID).unwrap()),
                new_position: 3,
            }),
            OpPayload::AddTag(AddTagPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                tag_id: BlockId::from_string(TEST_TID).unwrap(),
            }),
            OpPayload::RemoveTag(RemoveTagPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                tag_id: BlockId::from_string(TEST_TID).unwrap(),
            }),
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                key: "priority".into(),
            }),
            OpPayload::AddAttachment(AddAttachmentPayload {
                attachment_id: BlockId::test_id("A1"),
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
            OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                attachment_id: BlockId::test_id("A1"),
                fs_path: "/tmp/photo.png".into(),
            }),
        ]
    }

    // -----------------------------------------------------------------------
    // 1. Serde roundtrip — all 12 payload types
    // -----------------------------------------------------------------------

    #[test]
    fn all_payload_serde_roundtrip() {
        let payloads = all_test_payloads();
        // Sanity: we must cover all 12 variants
        assert_eq!(payloads.len(), 12);

        for payload in payloads {
            let tag = payload.op_type_str();
            let json =
                serde_json::to_string(&payload).unwrap_or_else(|e| panic!("serialize {tag}: {e}"));

            // Internally-tagged representation must include the op_type field
            assert!(
                json.contains(&format!("\"op_type\":\"{tag}\"")),
                "{tag}: missing op_type tag in {json}"
            );

            // Deserialize back and verify the tag round-trips
            let deser: OpPayload =
                serde_json::from_str(&json).unwrap_or_else(|e| panic!("deserialize {tag}: {e}"));
            assert_eq!(deser.op_type_str(), tag);

            // Re-serialize and verify JSON stability (serialize -> deser -> serialize)
            let json2 = serde_json::to_string(&deser).unwrap();
            assert_eq!(json, json2, "{tag}: re-serialization mismatch");
        }
    }

    // -----------------------------------------------------------------------
    // 2. Individual payload edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn edit_block_prev_edit_serializes_as_array_or_null() {
        let with = EditBlockPayload {
            block_id: BlockId::test_id("B1"),
            to_text: "new text".into(),
            prev_edit: Some(("device-1".into(), 5)),
        };
        let json = serde_json::to_string(&with).unwrap();
        assert!(json.contains("[\"device-1\",5]"));

        let without = EditBlockPayload {
            block_id: BlockId::test_id("B1"),
            to_text: "new text".into(),
            prev_edit: None,
        };
        let json = serde_json::to_string(&without).unwrap();
        assert!(json.contains("\"prev_edit\":null"));
    }

    #[test]
    fn create_block_with_null_optional_fields_roundtrips() {
        let p = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "".into(),
        });
        let json = serde_json::to_string(&p).unwrap();
        assert!(
            json.contains("\"parent_id\":null"),
            "parent_id should serialize as null"
        );
        assert!(
            json.contains("\"position\":null"),
            "position should serialize as null"
        );

        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::CreateBlock(inner) = deser else {
            panic!("expected CreateBlock variant");
        };
        assert!(inner.parent_id.is_none(), "parent_id should be None");
        assert!(inner.position.is_none(), "position should be None");
    }

    /// C-3a backwards-compat: pre-existing op-log rows for `delete_attachment`
    /// were written without an `fs_path` field. Those entries must continue to
    /// deserialize, with `fs_path` defaulting to the empty string. The C-3c
    /// GC pass is responsible for reconciling such rows against on-disk state.
    #[test]
    fn delete_attachment_payload_legacy_json_deserializes_without_fs_path() {
        let legacy = r#"{"attachment_id":"ATT-LEGACY"}"#;
        let parsed: DeleteAttachmentPayload = serde_json::from_str(legacy)
            .expect("legacy DeleteAttachmentPayload JSON without fs_path must still deserialize");
        assert_eq!(parsed.attachment_id, "ATT-LEGACY");
        assert_eq!(
            parsed.fs_path, "",
            "missing fs_path in legacy JSON must default to empty string"
        );

        // Also exercise the OpPayload-tagged form (this is the on-wire shape
        // used by the op_log; the inner-struct test above guards
        // serde_json::from_str on the bare payload).
        let legacy_tagged = r#"{"op_type":"delete_attachment","attachment_id":"ATT-LEGACY-2"}"#;
        let parsed: OpPayload = serde_json::from_str(legacy_tagged)
            .expect("legacy tagged OpPayload JSON without fs_path must still deserialize");
        match parsed {
            OpPayload::DeleteAttachment(inner) => {
                assert_eq!(inner.attachment_id, "ATT-LEGACY-2");
                assert_eq!(inner.fs_path, "");
            }
            other => panic!("expected DeleteAttachment, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // 3. OpType — serde, Display, FromStr
    // -----------------------------------------------------------------------

    #[test]
    fn op_type_serializes_as_snake_case_string() {
        let serialized = serde_json::to_string(&OpType::AddAttachment).unwrap();
        assert_eq!(serialized, "\"add_attachment\"");

        let deser: OpType = serde_json::from_str("\"delete_property\"").unwrap();
        assert_eq!(deser, OpType::DeleteProperty);
    }

    #[test]
    fn op_type_as_str_matches_serde_for_all_variants() {
        for variant in all_op_types() {
            let serde_json_str = serde_json::to_string(&variant).unwrap();
            // serde produces `"snake_case"` — strip the surrounding quotes
            let serde_str = serde_json_str.trim_matches('"');
            assert_eq!(
                variant.as_str(),
                serde_str,
                "as_str() vs serde mismatch for {:?}",
                variant
            );
        }
    }

    #[test]
    fn op_type_display_matches_as_str_for_all_variants() {
        for variant in all_op_types() {
            assert_eq!(
                variant.to_string(),
                variant.as_str(),
                "Display vs as_str mismatch for {:?}",
                variant
            );
        }
    }

    #[test]
    fn op_type_from_str_roundtrip() {
        for variant in all_op_types() {
            let s = variant.as_str();
            let parsed: OpType = s.parse().unwrap_or_else(|e| panic!("parse '{s}': {e}"));
            assert_eq!(parsed, variant);
        }
    }

    #[test]
    fn op_type_from_str_rejects_invalid() {
        assert!("not_a_real_op".parse::<OpType>().is_err());
        assert!("CreateBlock".parse::<OpType>().is_err()); // PascalCase rejected
        assert!("CREATE_BLOCK".parse::<OpType>().is_err()); // UPPER_SNAKE rejected
        assert!("".parse::<OpType>().is_err());
    }

    // -----------------------------------------------------------------------
    // 4. OpPayload::op_type_str consistency with serde tag
    // -----------------------------------------------------------------------

    #[test]
    fn op_type_str_consistent_with_serde_tag() {
        for payload in all_test_payloads() {
            let json = serde_json::to_string(&payload).unwrap();
            let value: serde_json::Value = serde_json::from_str(&json).unwrap();
            let serde_tag = value["op_type"].as_str().unwrap();
            assert_eq!(
                payload.op_type_str(),
                serde_tag,
                "op_type_str vs JSON tag mismatch for {:?}",
                payload.op_type()
            );
        }
    }

    // -----------------------------------------------------------------------
    // 5. OpPayload::block_id()
    // -----------------------------------------------------------------------

    #[test]
    fn block_id_returns_value_for_block_bearing_variants() {
        for payload in all_test_payloads() {
            match payload {
                OpPayload::DeleteAttachment(_) => {
                    assert_eq!(
                        payload.block_id(),
                        None,
                        "DeleteAttachment should return None"
                    );
                }
                _ => {
                    assert_eq!(
                        payload.block_id(),
                        Some(TEST_BID),
                        "{:?} should have block_id {}",
                        payload.op_type(),
                        TEST_BID
                    );
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // 6. Deserialization from raw JSON (simulating DB reads)
    // -----------------------------------------------------------------------

    #[test]
    fn deserialize_create_block_from_raw_json() {
        let raw = r#"{
            "op_type": "create_block",
            "block_id": "01HZ00000000000000000000AB",
            "block_type": "content",
            "parent_id": null,
            "position": 0,
            "content": "Hello from DB"
        }"#;

        let payload: OpPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.op_type_str(), "create_block");
        assert_eq!(payload.block_id(), Some("01HZ00000000000000000000AB"));

        let OpPayload::CreateBlock(inner) = &payload else {
            panic!("expected CreateBlock");
        };
        assert_eq!(inner.content, "Hello from DB");
        assert!(inner.parent_id.is_none());
        assert_eq!(inner.position, Some(0));
    }

    #[test]
    fn deserialize_set_property_from_raw_json() {
        let raw = r#"{
            "op_type": "set_property",
            "block_id": "B42",
            "key": "status",
            "value_text": "done",
            "value_num": null,
            "value_date": null,
            "value_ref": null
        }"#;

        let payload: OpPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.op_type_str(), "set_property");
        let OpPayload::SetProperty(inner) = &payload else {
            panic!("expected SetProperty");
        };
        assert_eq!(inner.value_text.as_deref(), Some("done"));
        assert!(inner.value_num.is_none());
    }

    #[test]
    fn deserialize_delete_attachment_from_raw_json() {
        let raw = r#"{"op_type": "delete_attachment", "attachment_id": "A99"}"#;
        let payload: OpPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.op_type_str(), "delete_attachment");
        assert_eq!(payload.block_id(), None);
    }

    // -----------------------------------------------------------------------
    // 7. Error handling — malformed / unknown
    // -----------------------------------------------------------------------

    #[test]
    fn deserialize_malformed_json_returns_error() {
        assert!(
            serde_json::from_str::<OpPayload>("not json").is_err(),
            "invalid JSON should fail"
        );
        assert!(
            serde_json::from_str::<OpPayload>(r#"{"op_type": "create_block"}"#).is_err(),
            "missing required fields should fail"
        );
        assert!(
            serde_json::from_str::<OpPayload>("{}").is_err(),
            "empty object without op_type tag should fail"
        );
        assert!(
            serde_json::from_str::<OpPayload>("[]").is_err(),
            "array instead of object should fail"
        );
    }

    #[test]
    fn unknown_op_type_returns_error() {
        let raw = r#"{"op_type": "frobnicate", "block_id": "B1"}"#;
        let result = serde_json::from_str::<OpPayload>(raw);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        // serde should mention the unknown variant name
        assert!(
            err_msg.contains("frobnicate") || err_msg.contains("unknown variant"),
            "error should reference the bad variant: {err_msg}"
        );
    }

    // -----------------------------------------------------------------------
    // 8. Edge cases — Unicode, empty, long content
    // -----------------------------------------------------------------------

    #[test]
    fn unicode_content_roundtrips_through_serde() {
        let text = "日本語テスト 🚀 spëcial — «guillemets» \u{200B}";
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: text.into(),
        });
        let json = serde_json::to_string(&payload).unwrap();
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::CreateBlock(inner) = deser else {
            panic!("expected CreateBlock");
        };
        assert_eq!(
            inner.content, text,
            "unicode content must survive round-trip"
        );
    }

    #[test]
    fn empty_content_roundtrips_through_serde() {
        let payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            to_text: "".into(),
            prev_edit: None,
        });
        let json = serde_json::to_string(&payload).unwrap();
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::EditBlock(inner) = &deser else {
            panic!("expected EditBlock");
        };
        assert_eq!(inner.to_text, "", "empty string must survive round-trip");
    }

    #[test]
    fn large_content_100kb_roundtrips_through_serde() {
        let long_text = "x".repeat(100_000);
        let payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            to_text: long_text.clone(),
            prev_edit: None,
        });
        let json = serde_json::to_string(&payload).unwrap();
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::EditBlock(inner) = deser else {
            panic!("expected EditBlock");
        };
        assert_eq!(
            inner.to_text.len(),
            100_000,
            "100 KB content must survive round-trip"
        );
    }

    // -----------------------------------------------------------------------
    // 9. Optional field handling
    // -----------------------------------------------------------------------

    #[test]
    fn all_optional_set_property_fields_serialize_as_null() {
        let payload = SetPropertyPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            key: "k".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"value_text\":null"));
        assert!(json.contains("\"value_num\":null"));
        assert!(json.contains("\"value_date\":null"));
        assert!(json.contains("\"value_ref\":null"));

        // Roundtrip through deserialization
        let deser: SetPropertyPayload = serde_json::from_str(&json).unwrap();
        assert!(deser.value_text.is_none());
        assert!(deser.value_num.is_none());
        assert!(deser.value_date.is_none());
        assert!(deser.value_ref.is_none());
    }

    #[test]
    fn set_property_with_numeric_value_roundtrips() {
        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            key: "score".into(),
            value_text: None,
            value_num: Some(42.5),
            value_date: None,
            value_ref: None,
        });
        let json = serde_json::to_string(&payload).unwrap();
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::SetProperty(inner) = deser else {
            panic!("expected SetProperty");
        };
        assert!(inner.value_text.is_none(), "value_text should be None");
        assert_eq!(inner.value_num, Some(42.5), "value_num mismatch");
        assert!(inner.value_date.is_none(), "value_date should be None");
        assert!(inner.value_ref.is_none(), "value_ref should be None");
    }

    // -----------------------------------------------------------------------
    // 10. Additional edge cases
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // 11. insta snapshot tests — OpPayload JSON serialization
    // -----------------------------------------------------------------------

    /// Snapshot the JSON serialization of every OpPayload variant.
    /// These are fully deterministic (no timestamps, no ULIDs).
    #[test]
    fn snapshot_all_payload_json_serialization() {
        for payload in all_test_payloads() {
            let tag = payload.op_type_str();
            let json: serde_json::Value = serde_json::to_value(&payload).unwrap();
            insta::assert_yaml_snapshot!(format!("op_payload_json_{tag}"), json);
        }
    }

    #[test]
    fn move_block_to_root_serializes_null_parent() {
        let payload = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            new_parent_id: None,
            new_position: 0,
        });
        let json = serde_json::to_string(&payload).unwrap();
        assert!(
            json.contains("\"new_parent_id\":null"),
            "move to root should have null parent"
        );
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::MoveBlock(inner) = deser else {
            panic!("expected MoveBlock");
        };
        assert!(
            inner.new_parent_id.is_none(),
            "deserialized parent should be None for root move"
        );
    }

    // -----------------------------------------------------------------------
    // 12. F02: normalize_block_ids — now a no-op since BlockId auto-normalizes
    // -----------------------------------------------------------------------

    #[test]
    fn normalize_block_ids_is_no_op_since_block_id_auto_normalizes() {
        let lower = "01arz3ndektsv4rrffq69g5fav";
        let upper = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        // BlockId::from_string auto-normalizes to uppercase
        let mut payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(lower).unwrap(),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_string(lower).unwrap()),
            position: Some(1),
            content: "test".into(),
        });
        // Already uppercase from construction
        assert_eq!(payload.block_id(), Some(upper));
        // normalize_block_ids is a no-op but should not panic
        payload.normalize_block_ids();
        assert_eq!(payload.block_id(), Some(upper));
        let OpPayload::CreateBlock(inner) = &payload else {
            panic!("expected CreateBlock");
        };
        assert_eq!(inner.parent_id.as_ref().unwrap().as_str(), upper);
    }

    #[test]
    fn normalize_block_ids_is_no_op_for_all_payload_variants() {
        let payloads = all_test_payloads();
        assert_eq!(payloads.len(), 12, "must cover all 12 variants");

        for mut payload in payloads {
            let tag = payload.op_type_str();
            let json_before = serde_json::to_string(&payload)
                .unwrap_or_else(|e| panic!("serialize before normalize {tag}: {e}"));
            payload.normalize_block_ids();
            let json_after = serde_json::to_string(&payload)
                .unwrap_or_else(|e| panic!("serialize after normalize {tag}: {e}"));
            assert_eq!(
                json_before, json_after,
                "normalize_block_ids must be a no-op for {tag}"
            );
        }
    }

    #[test]
    fn block_id_auto_normalizes_on_construction() {
        let lower = "01arz3ndektsv4rrffq69g5fav";
        let upper = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

        // AddTag — both block_id and tag_id normalize on construction
        let tag_payload = OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_string(lower).unwrap(),
            tag_id: BlockId::from_string(lower).unwrap(),
        });
        let OpPayload::AddTag(inner) = &tag_payload else {
            panic!("expected AddTag");
        };
        assert_eq!(inner.block_id.as_str(), upper);
        assert_eq!(inner.tag_id.as_str(), upper);
    }

    // -----------------------------------------------------------------------
    // 13. F04: validate_set_property
    // -----------------------------------------------------------------------

    #[test]
    fn validate_set_property_accepts_exactly_one_value() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        };
        assert!(
            validate_set_property(&p).is_ok(),
            "validate_set_property should accept a payload with exactly one value (value_text set)"
        );
    }

    #[test]
    fn validate_set_property_rejects_zero_values() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "expected Validation error, got: {err:?}"
        );
        assert!(err.to_string().contains("found 0"));
    }

    #[test]
    fn validate_set_property_rejects_multiple_values() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: Some("v".into()),
            value_num: Some(1.0),
            value_date: None,
            value_ref: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "expected Validation error, got: {err:?}"
        );
        assert!(err.to_string().contains("found 2"));
    }

    // -----------------------------------------------------------------------
    // 13b. Key format validation (#23)
    // -----------------------------------------------------------------------

    #[test]
    fn validate_set_property_accepts_valid_keys() {
        for key in [
            "due",
            "priority",
            "my-key",
            "my_key",
            "key123",
            "a",
            &"k".repeat(64),
        ] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: key.into(),
                value_text: Some("v".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            };
            assert!(
                validate_set_property(&p).is_ok(),
                "key '{key}' should be accepted"
            );
        }
    }

    #[test]
    fn validate_set_property_rejects_empty_key() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "".into(),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "empty key should be rejected"
        );
        assert!(err.to_string().contains("1-64 characters"));
    }

    #[test]
    fn validate_set_property_rejects_too_long_key() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".repeat(65),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "65-char key should be rejected"
        );
        assert!(err.to_string().contains("1-64 characters"));
    }

    #[test]
    fn validate_set_property_rejects_special_char_keys() {
        for key in ["bad key", "key.name", "key/name", "key@here", "k!ey", "a b"] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: key.into(),
                value_text: Some("v".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            };
            let err = validate_set_property(&p).unwrap_err();
            assert!(
                matches!(err, crate::error::AppError::Validation(_)),
                "key '{key}' should be rejected"
            );
            assert!(
                err.to_string().contains("alphanumeric"),
                "error should mention alphanumeric for key '{key}'"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 14. F09: OpType Display/FromStr exhaustive
    // -----------------------------------------------------------------------

    #[test]
    fn op_type_display_from_str_roundtrip_all_variants() {
        for variant in all_op_types() {
            let displayed = variant.to_string();
            let parsed: OpType = displayed
                .parse()
                .unwrap_or_else(|e| panic!("FromStr failed for '{displayed}': {e}"));
            assert_eq!(
                parsed, variant,
                "Display → FromStr round-trip failed for {variant:?}"
            );
        }
    }

    #[test]
    fn op_type_as_str_display_from_str_all_consistent() {
        for variant in all_op_types() {
            let as_str = variant.as_str();
            let display = format!("{variant}");
            let from_str: OpType = as_str.parse().unwrap();
            assert_eq!(
                as_str, display,
                "as_str vs Display mismatch for {variant:?}"
            );
            assert_eq!(
                from_str, variant,
                "FromStr(as_str) mismatch for {variant:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 15. F24: validate_set_property rejects NaN / Infinity
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_set_property_nan() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: None,
            value_num: Some(f64::NAN),
            value_date: None,
            value_ref: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "NaN value_num must return Validation error, got: {err:?}"
        );
        assert!(
            err.to_string().contains("finite"),
            "error message must mention 'finite', got: {err}"
        );
    }

    #[test]
    fn test_validate_set_property_infinity() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: None,
            value_num: Some(f64::INFINITY),
            value_date: None,
            value_ref: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "Infinity value_num must return Validation error, got: {err:?}"
        );
        assert!(
            err.to_string().contains("finite"),
            "error message must mention 'finite', got: {err}"
        );

        // Also test negative infinity
        let p_neg = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: None,
            value_num: Some(f64::NEG_INFINITY),
            value_date: None,
            value_ref: None,
        };
        let err_neg = validate_set_property(&p_neg).unwrap_err();
        assert!(
            matches!(err_neg, crate::error::AppError::Validation(_)),
            "NEG_INFINITY value_num must return Validation error, got: {err_neg:?}"
        );
    }

    #[test]
    fn validate_set_property_allows_clear_for_reserved_key() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "todo_state".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
        };
        assert!(
            validate_set_property(&p).is_ok(),
            "reserved key with all-null values should be allowed (clear)"
        );
    }

    // -----------------------------------------------------------------------
    // L-6: validate_set_property rejects empty / whitespace-only string fields
    // -----------------------------------------------------------------------

    #[test]
    fn validate_set_property_rejects_empty_value_text() {
        for empty in ["", "   ", "\t\n"] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: "k".into(),
                value_text: Some(empty.into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            };
            let err = validate_set_property(&p).unwrap_err();
            assert!(
                matches!(
                    err,
                    crate::error::AppError::Validation(ref m)
                        if m == "set_property.value_text.empty"
                ),
                "empty value_text ({empty:?}) must return the value_text.empty error, got: {err:?}"
            );
        }
    }

    #[test]
    fn validate_set_property_rejects_empty_value_date() {
        for empty in ["", "   ", "\t\n"] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: "k".into(),
                value_text: None,
                value_num: None,
                value_date: Some(empty.into()),
                value_ref: None,
            };
            let err = validate_set_property(&p).unwrap_err();
            assert!(
                matches!(
                    err,
                    crate::error::AppError::Validation(ref m)
                        if m == "set_property.value_date.empty"
                ),
                "empty value_date ({empty:?}) must return the value_date.empty error, got: {err:?}"
            );
        }
    }

    #[test]
    fn validate_set_property_rejects_empty_value_ref() {
        for empty in ["", "   ", "\t\n"] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: "k".into(),
                value_text: None,
                value_num: None,
                value_date: None,
                value_ref: Some(empty.into()),
            };
            let err = validate_set_property(&p).unwrap_err();
            assert!(
                matches!(
                    err,
                    crate::error::AppError::Validation(ref m)
                        if m == "set_property.value_ref.empty"
                ),
                "empty value_ref ({empty:?}) must return the value_ref.empty error, got: {err:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // is_reserved_property_key
    // -----------------------------------------------------------------------

    #[test]
    fn is_reserved_property_key_recognizes_all_four() {
        assert!(
            is_reserved_property_key("todo_state"),
            "todo_state must be recognized as reserved"
        );
        assert!(
            is_reserved_property_key("priority"),
            "priority must be recognized as reserved"
        );
        assert!(
            is_reserved_property_key("due_date"),
            "due_date must be recognized as reserved"
        );
        assert!(
            is_reserved_property_key("scheduled_date"),
            "scheduled_date must be recognized as reserved"
        );
    }

    #[test]
    fn is_reserved_property_key_rejects_non_reserved() {
        assert!(
            !is_reserved_property_key("custom_key"),
            "custom_key must not be recognized as reserved"
        );
        assert!(
            !is_reserved_property_key("todo"),
            "todo must not be recognized as reserved"
        );
        assert!(
            !is_reserved_property_key(""),
            "empty string must not be recognized as reserved"
        );
    }

    // -----------------------------------------------------------------------
    // is_builtin_property_key
    // -----------------------------------------------------------------------

    #[test]
    fn is_builtin_property_key_recognizes_all() {
        let builtin_keys = [
            "todo_state",
            "priority",
            "due_date",
            "scheduled_date",
            "created_at",
            "completed_at",
            "repeat",
            "repeat-until",
            "repeat-count",
            "repeat-seq",
            "repeat-origin",
        ];
        for key in builtin_keys {
            assert!(
                is_builtin_property_key(key),
                "'{key}' must be recognized as built-in"
            );
        }
    }

    #[test]
    fn is_builtin_property_key_rejects_custom() {
        assert!(
            !is_builtin_property_key("custom_key"),
            "custom_key must not be recognized as built-in"
        );
        assert!(
            !is_builtin_property_key(""),
            "empty string must not be recognized as built-in"
        );
    }

    #[test]
    fn user_settable_properties_are_not_builtin() {
        for key in ["effort", "assignee", "location"] {
            assert!(
                !is_builtin_property_key(key),
                "'{key}' is user-settable and must NOT be treated as built-in"
            );
        }
    }
}

// ===========================================================================
// Property-based tests (proptest)
// ===========================================================================

#[cfg(test)]
mod proptest_tests {
    use super::*;
    use proptest::prelude::*;
    use std::str::FromStr;

    // ── ULID normalization is idempotent ────────────────────────────────

    proptest! {
        /// Normalizing a BlockId via `from_trusted` is idempotent: applying
        /// the normalization twice yields the same result as applying it once.
        #[test]
        fn normalize_block_id_idempotent(s in "[0-9A-Za-z]{26}") {
            let normalized = BlockId::from_trusted(&s).as_str().to_string();
            let double_normalized = BlockId::from_trusted(&normalized).as_str().to_string();
            prop_assert_eq!(&normalized, &double_normalized);
        }
    }

    // ── OpType as_str / FromStr round-trip ──────────────────────────────

    /// Strategy that produces one of the 12 known OpType variants.
    fn arb_op_type() -> impl Strategy<Value = OpType> {
        prop_oneof![
            Just(OpType::CreateBlock),
            Just(OpType::EditBlock),
            Just(OpType::DeleteBlock),
            Just(OpType::RestoreBlock),
            Just(OpType::PurgeBlock),
            Just(OpType::MoveBlock),
            Just(OpType::AddTag),
            Just(OpType::RemoveTag),
            Just(OpType::SetProperty),
            Just(OpType::DeleteProperty),
            Just(OpType::AddAttachment),
            Just(OpType::DeleteAttachment),
        ]
    }

    proptest! {
        /// Every OpType variant survives a round-trip through `as_str` → `FromStr`.
        #[test]
        fn op_type_as_str_from_str_roundtrip(variant in arb_op_type()) {
            let s = variant.as_str();
            let parsed = OpType::from_str(s).unwrap();
            prop_assert_eq!(variant, parsed);
        }

        /// Every OpType variant maps to a unique string — no two variants
        /// share the same `as_str` value.
        #[test]
        fn op_type_as_str_unique(a in arb_op_type(), b in arb_op_type()) {
            prop_assume!(a != b);
            prop_assert_ne!(a.as_str(), b.as_str());
        }
    }
}
