//! Op payload types for the CRDT op log (ADR-07).
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

#![allow(dead_code)]

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

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
    type Err = serde_json::Error;

    /// Parses a snake_case string (e.g. `"create_block"`) into an [`OpType`].
    ///
    /// Uses serde deserialization internally so the accepted strings are always
    /// consistent with the `#[serde(rename_all = "snake_case")]` attribute.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(s.to_owned()))
    }
}

// ---------------------------------------------------------------------------
// Payload structs — one per OpType variant
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateBlockPayload {
    pub block_id: String,
    pub block_type: String,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditBlockPayload {
    pub block_id: String,
    pub to_text: String,
    /// Previous edit reference as `(device_id, seq)`. Serialized as a JSON
    /// two-element array `[device_id, seq]` or `null`.
    pub prev_edit: Option<(String, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteBlockPayload {
    pub block_id: String,
    pub cascade: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreBlockPayload {
    pub block_id: String,
    pub deleted_at_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurgeBlockPayload {
    pub block_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveBlockPayload {
    pub block_id: String,
    pub new_parent_id: Option<String>,
    pub new_position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddTagPayload {
    pub block_id: String,
    pub tag_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveTagPayload {
    pub block_id: String,
    pub tag_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetPropertyPayload {
    pub block_id: String,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletePropertyPayload {
    pub block_id: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddAttachmentPayload {
    pub attachment_id: String,
    pub block_id: String,
    pub mime_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub fs_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteAttachmentPayload {
    pub attachment_id: String,
}

// ---------------------------------------------------------------------------
// OpPayload — tagged union of all payload structs
// ---------------------------------------------------------------------------

/// Wrapper enum for all op payloads. Uses serde's internally-tagged
/// representation so that serialized JSON includes `"op_type": "..."` alongside
/// the payload fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
            OpPayload::CreateBlock(p) => Some(&p.block_id),
            OpPayload::EditBlock(p) => Some(&p.block_id),
            OpPayload::DeleteBlock(p) => Some(&p.block_id),
            OpPayload::RestoreBlock(p) => Some(&p.block_id),
            OpPayload::PurgeBlock(p) => Some(&p.block_id),
            OpPayload::MoveBlock(p) => Some(&p.block_id),
            OpPayload::AddTag(p) => Some(&p.block_id),
            OpPayload::RemoveTag(p) => Some(&p.block_id),
            OpPayload::SetProperty(p) => Some(&p.block_id),
            OpPayload::DeleteProperty(p) => Some(&p.block_id),
            OpPayload::AddAttachment(p) => Some(&p.block_id),
            OpPayload::DeleteAttachment(_) => None,
        }
    }

    /// Normalize all ULID-typed String fields to uppercase Crockford base32.
    ///
    /// This ensures that payloads received from external sources (sync, import)
    /// have canonical IDs before being hashed or stored. Affects:
    /// - `block_id` (all variants except DeleteAttachment)
    /// - `parent_id` (CreateBlock, MoveBlock)
    /// - `tag_id` (AddTag, RemoveTag)
    /// - `attachment_id` (AddAttachment, DeleteAttachment)
    /// - `value_ref` (SetProperty)
    ///
    /// Non-ULID fields (content, key, etc.) are left untouched.
    pub fn normalize_block_ids(&mut self) {
        fn norm(s: &mut String) {
            if let Ok(parsed) = ulid::Ulid::from_str(s) {
                let upper = parsed.to_string();
                if *s != upper {
                    *s = upper;
                }
            }
        }
        fn norm_opt(s: &mut Option<String>) {
            if let Some(inner) = s.as_mut() {
                norm(inner);
            }
        }

        match self {
            OpPayload::CreateBlock(p) => {
                norm(&mut p.block_id);
                norm_opt(&mut p.parent_id);
            }
            OpPayload::EditBlock(p) => norm(&mut p.block_id),
            OpPayload::DeleteBlock(p) => norm(&mut p.block_id),
            OpPayload::RestoreBlock(p) => norm(&mut p.block_id),
            OpPayload::PurgeBlock(p) => norm(&mut p.block_id),
            OpPayload::MoveBlock(p) => {
                norm(&mut p.block_id);
                norm_opt(&mut p.new_parent_id);
            }
            OpPayload::AddTag(p) => {
                norm(&mut p.block_id);
                norm(&mut p.tag_id);
            }
            OpPayload::RemoveTag(p) => {
                norm(&mut p.block_id);
                norm(&mut p.tag_id);
            }
            OpPayload::SetProperty(p) => {
                norm(&mut p.block_id);
                norm_opt(&mut p.value_ref);
            }
            OpPayload::DeleteProperty(p) => norm(&mut p.block_id),
            OpPayload::AddAttachment(p) => {
                norm(&mut p.attachment_id);
                norm(&mut p.block_id);
            }
            OpPayload::DeleteAttachment(p) => norm(&mut p.attachment_id),
        }
    }
}

/// Validate that a [`SetPropertyPayload`] has exactly one non-null value field.
///
/// The schema allows multiple value columns (text, num, date, ref) but the
/// domain invariant is that exactly one must be set per operation. This
/// function enforces that invariant at the command layer, before the payload
/// is appended to the op log.
///
/// Returns `Ok(())` if exactly one is `Some`, or an `AppError::Validation`
/// describing the violation.
pub fn validate_set_property(p: &SetPropertyPayload) -> Result<(), crate::error::AppError> {
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

    /// Builds one test instance of each OpPayload variant with block_id "B1".
    fn all_test_payloads() -> Vec<OpPayload> {
        vec![
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "B1".into(),
                block_type: "content".into(),
                parent_id: Some("P1".into()),
                position: Some(1),
                content: "hello".into(),
            }),
            OpPayload::EditBlock(EditBlockPayload {
                block_id: "B1".into(),
                to_text: "updated".into(),
                prev_edit: Some(("dev-1".into(), 1)),
            }),
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: "B1".into(),
                cascade: true,
            }),
            OpPayload::RestoreBlock(RestoreBlockPayload {
                block_id: "B1".into(),
                deleted_at_ref: "ref-1".into(),
            }),
            OpPayload::PurgeBlock(PurgeBlockPayload {
                block_id: "B1".into(),
            }),
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: "B1".into(),
                new_parent_id: Some("P2".into()),
                new_position: 3,
            }),
            OpPayload::AddTag(AddTagPayload {
                block_id: "B1".into(),
                tag_id: "T1".into(),
            }),
            OpPayload::RemoveTag(RemoveTagPayload {
                block_id: "B1".into(),
                tag_id: "T1".into(),
            }),
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: "B1".into(),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: "B1".into(),
                key: "priority".into(),
            }),
            OpPayload::AddAttachment(AddAttachmentPayload {
                attachment_id: "A1".into(),
                block_id: "B1".into(),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
            OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                attachment_id: "A1".into(),
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
            block_id: "B1".into(),
            to_text: "new text".into(),
            prev_edit: Some(("device-1".into(), 5)),
        };
        let json = serde_json::to_string(&with).unwrap();
        assert!(json.contains("[\"device-1\",5]"));

        let without = EditBlockPayload {
            block_id: "B1".into(),
            to_text: "new text".into(),
            prev_edit: None,
        };
        let json = serde_json::to_string(&without).unwrap();
        assert!(json.contains("\"prev_edit\":null"));
    }

    #[test]
    fn create_block_with_null_optional_fields_roundtrips() {
        let p = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "B1".into(),
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
                        Some("B1"),
                        "{:?} should have block_id B1",
                        payload.op_type()
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
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
    // 12. F02: normalize_block_ids
    // -----------------------------------------------------------------------

    #[test]
    fn normalize_block_ids_uppercases_lowercase_block_id() {
        let lower = "01arz3ndektsv4rrffq69g5fav";
        let upper = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let mut payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: lower.into(),
            block_type: "content".into(),
            parent_id: Some(lower.into()),
            position: Some(1),
            content: "test".into(),
        });
        payload.normalize_block_ids();
        assert_eq!(payload.block_id(), Some(upper));
        let OpPayload::CreateBlock(inner) = &payload else {
            panic!("expected CreateBlock");
        };
        assert_eq!(inner.parent_id.as_deref(), Some(upper));
    }

    #[test]
    fn normalize_block_ids_handles_all_variant_fields() {
        let lower = "01arz3ndektsv4rrffq69g5fav";
        let upper = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

        // AddTag — normalizes both block_id and tag_id
        let mut tag_payload = OpPayload::AddTag(AddTagPayload {
            block_id: lower.into(),
            tag_id: lower.into(),
        });
        tag_payload.normalize_block_ids();
        let OpPayload::AddTag(inner) = &tag_payload else {
            panic!("expected AddTag");
        };
        assert_eq!(inner.block_id, upper);
        assert_eq!(inner.tag_id, upper);

        // SetProperty — normalizes block_id and value_ref
        let mut prop_payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: lower.into(),
            key: "ref".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(lower.into()),
        });
        prop_payload.normalize_block_ids();
        let OpPayload::SetProperty(inner) = &prop_payload else {
            panic!("expected SetProperty");
        };
        assert_eq!(inner.block_id, upper);
        assert_eq!(inner.value_ref.as_deref(), Some(upper));
    }

    #[test]
    fn normalize_block_ids_leaves_non_ulid_strings_unchanged() {
        let mut payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: "not-a-ulid".into(),
            to_text: "content not touched".into(),
            prev_edit: None,
        });
        payload.normalize_block_ids();
        let OpPayload::EditBlock(inner) = &payload else {
            panic!("expected EditBlock");
        };
        assert_eq!(inner.block_id, "not-a-ulid");
        assert_eq!(inner.to_text, "content not touched");
    }

    // -----------------------------------------------------------------------
    // 13. F04: validate_set_property
    // -----------------------------------------------------------------------

    #[test]
    fn validate_set_property_accepts_exactly_one_value() {
        let p = SetPropertyPayload {
            block_id: "B1".into(),
            key: "k".into(),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        };
        assert!(validate_set_property(&p).is_ok());
    }

    #[test]
    fn validate_set_property_rejects_zero_values() {
        let p = SetPropertyPayload {
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
            block_id: "B1".into(),
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
}
