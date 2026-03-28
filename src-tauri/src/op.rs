//! Op payload types for the CRDT op log (ADR-07).
//!
//! Each operation in the log has a typed payload. The [`OpType`] enum identifies
//! the operation kind, and [`OpPayload`] is an internally-tagged enum that wraps
//! all payload structs for (de)serialization.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// OpType — the string tag stored in op_log.op_type
// ---------------------------------------------------------------------------

/// Operation type tag. Serialized as snake_case strings for storage in the
/// `op_log.op_type` TEXT column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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
    pub fn op_type_str(&self) -> &'static str {
        match self {
            OpPayload::CreateBlock(_) => "create_block",
            OpPayload::EditBlock(_) => "edit_block",
            OpPayload::DeleteBlock(_) => "delete_block",
            OpPayload::RestoreBlock(_) => "restore_block",
            OpPayload::PurgeBlock(_) => "purge_block",
            OpPayload::MoveBlock(_) => "move_block",
            OpPayload::AddTag(_) => "add_tag",
            OpPayload::RemoveTag(_) => "remove_tag",
            OpPayload::SetProperty(_) => "set_property",
            OpPayload::DeleteProperty(_) => "delete_property",
            OpPayload::AddAttachment(_) => "add_attachment",
            OpPayload::DeleteAttachment(_) => "delete_attachment",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_block_payload_roundtrip() {
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "01HZ00000000000000000000AB".into(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "Hello world".into(),
        });

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"op_type\":\"create_block\""));

        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.op_type_str(), "create_block");
    }

    #[test]
    fn edit_block_prev_edit_serializes_as_array_or_null() {
        let with = EditBlockPayload {
            block_id: "01HZ00000000000000000000AB".into(),
            to_text: "new text".into(),
            prev_edit: Some(("device-1".into(), 5)),
        };
        let json = serde_json::to_string(&with).unwrap();
        assert!(json.contains("[\"device-1\",5]"));

        let without = EditBlockPayload {
            block_id: "01HZ00000000000000000000AB".into(),
            to_text: "new text".into(),
            prev_edit: None,
        };
        let json = serde_json::to_string(&without).unwrap();
        assert!(json.contains("\"prev_edit\":null"));
    }

    #[test]
    fn op_type_serde_snake_case() {
        let serialized = serde_json::to_string(&OpType::AddAttachment).unwrap();
        assert_eq!(serialized, "\"add_attachment\"");

        let deser: OpType = serde_json::from_str("\"delete_property\"").unwrap();
        assert_eq!(deser, OpType::DeleteProperty);
    }

    #[test]
    fn all_op_type_str_values() {
        // Ensure exhaustive coverage — compiler enforces no wildcards
        let cases: Vec<(OpPayload, &str)> = vec![
            (
                OpPayload::CreateBlock(CreateBlockPayload {
                    block_id: "X".into(),
                    block_type: "content".into(),
                    parent_id: None,
                    position: None,
                    content: "".into(),
                }),
                "create_block",
            ),
            (
                OpPayload::EditBlock(EditBlockPayload {
                    block_id: "X".into(),
                    to_text: "".into(),
                    prev_edit: None,
                }),
                "edit_block",
            ),
            (
                OpPayload::DeleteBlock(DeleteBlockPayload {
                    block_id: "X".into(),
                    cascade: false,
                }),
                "delete_block",
            ),
            (
                OpPayload::RestoreBlock(RestoreBlockPayload {
                    block_id: "X".into(),
                    deleted_at_ref: "".into(),
                }),
                "restore_block",
            ),
            (
                OpPayload::PurgeBlock(PurgeBlockPayload {
                    block_id: "X".into(),
                }),
                "purge_block",
            ),
            (
                OpPayload::MoveBlock(MoveBlockPayload {
                    block_id: "X".into(),
                    new_parent_id: None,
                    new_position: 0,
                }),
                "move_block",
            ),
            (
                OpPayload::AddTag(AddTagPayload {
                    block_id: "X".into(),
                    tag_id: "T".into(),
                }),
                "add_tag",
            ),
            (
                OpPayload::RemoveTag(RemoveTagPayload {
                    block_id: "X".into(),
                    tag_id: "T".into(),
                }),
                "remove_tag",
            ),
            (
                OpPayload::SetProperty(SetPropertyPayload {
                    block_id: "X".into(),
                    key: "k".into(),
                    value_text: None,
                    value_num: None,
                    value_date: None,
                    value_ref: None,
                }),
                "set_property",
            ),
            (
                OpPayload::DeleteProperty(DeletePropertyPayload {
                    block_id: "X".into(),
                    key: "k".into(),
                }),
                "delete_property",
            ),
            (
                OpPayload::AddAttachment(AddAttachmentPayload {
                    attachment_id: "A".into(),
                    block_id: "X".into(),
                    mime_type: "text/plain".into(),
                    filename: "f.txt".into(),
                    size_bytes: 100,
                    fs_path: "/tmp/f.txt".into(),
                }),
                "add_attachment",
            ),
            (
                OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                    attachment_id: "A".into(),
                }),
                "delete_attachment",
            ),
        ];

        for (payload, expected) in cases {
            assert_eq!(payload.op_type_str(), expected);
        }
    }
}
