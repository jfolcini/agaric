//! Tests for the op-log writer.
//!
//! `append_local_op`, `append_local_op_at`, `get_op_by_seq`,
//! `get_latest_seq`, `get_ops_since`, `serialize_inner_payload`.
//!
//! Covers sequential appending, parent-chain linking, per-device isolation,
//! hash integrity, op type, concurrent writes, DB round-trips,
//! helpers, timestamp determinism.
//!
//! The body is split into thematic submodules; this module holds the shared
//! imports, fixture constants, and helpers re-exported (`pub(super)`) so each
//! submodule can pull them in via `use super::*;`.

mod append;
mod hash;
mod immutability;
mod origin;
mod payload;
mod read;

pub(super) use crate::db::{ReadPool, init_pool};
pub(super) use crate::error::AppError;
pub(super) use crate::hash::compute_op_hash;
pub(super) use crate::op::*;
pub(super) use crate::op_log::*;
pub(super) use crate::ulid::BlockId;
pub(super) use sqlx::SqlitePool;
pub(super) use std::path::PathBuf;
pub(super) use tempfile::TempDir;

// ── Test fixture constants ──────────────────────────────────────────

// 2025-01-15T12:00:00Z in epoch-ms (op_log.created_at INTEGER, #109).
pub(super) const FIXED_TS: i64 = 1_736_942_400_000;
pub(super) const TEST_DEVICE: &str = "test-device";

// ── Helpers ─────────────────────────────────────────────────────────

/// Create a temp-file-backed SQLite pool with migrations applied.
pub(super) async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Build a minimal `CreateBlock` payload with the given block ID.
pub(super) fn make_create_payload(block_id: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".into(),
        parent_id: None,
        position: Some(1),
        index: None,
        content: "test".into(),
    })
}

/// Build a minimal [`OpPayload`] for each of the 12 variants.
pub(super) fn all_op_payloads() -> Vec<(&'static str, OpPayload)> {
    vec![
        (
            "create_block",
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK001"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                index: None,
                content: "hello".into(),
            }),
        ),
        (
            "edit_block",
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK001"),
                to_text: "updated".into(),
                prev_edit: None,
            }),
        ),
        (
            "delete_block",
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::test_id("BLK001"),
            }),
        ),
        (
            "restore_block",
            OpPayload::RestoreBlock(RestoreBlockPayload {
                block_id: BlockId::test_id("BLK001"),
                deleted_at_ref: 1_735_689_600_000, // 2025-01-01T00:00:00Z
            }),
        ),
        (
            "purge_block",
            OpPayload::PurgeBlock(PurgeBlockPayload {
                block_id: BlockId::test_id("BLK001"),
            }),
        ),
        (
            "move_block",
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK001"),
                new_parent_id: Some(BlockId::test_id("BLK000")),
                new_position: 3,
                new_index: None,
            }),
        ),
        (
            "add_tag",
            OpPayload::AddTag(AddTagPayload {
                block_id: BlockId::test_id("BLK001"),
                tag_id: BlockId::test_id("TAG01"),
            }),
        ),
        (
            "remove_tag",
            OpPayload::RemoveTag(RemoveTagPayload {
                block_id: BlockId::test_id("BLK001"),
                tag_id: BlockId::test_id("TAG01"),
            }),
        ),
        (
            "set_property",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK001"),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
            }),
        ),
        (
            "delete_property",
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::test_id("BLK001"),
                key: "priority".into(),
            }),
        ),
        (
            "add_attachment",
            OpPayload::AddAttachment(AddAttachmentPayload {
                attachment_id: BlockId::test_id("ATT01"),
                block_id: BlockId::test_id("BLK001"),
                mime_type: "text/plain".into(),
                filename: "readme.txt".into(),
                size_bytes: 256,
                fs_path: "/tmp/readme.txt".into(),
            }),
        ),
        (
            "delete_attachment",
            OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                attachment_id: BlockId::test_id("ATT01"),
                fs_path: "/tmp/readme.txt".into(),
            }),
        ),
        // #652: keep RenameAttachment exercised through the append /
        // L-13 sidecar / canonical-JSON-ordering harnesses too.
        (
            "rename_attachment",
            OpPayload::RenameAttachment(RenameAttachmentPayload {
                attachment_id: BlockId::test_id("ATT01"),
                old_filename: "readme.txt".into(),
                new_filename: "manual.txt".into(),
            }),
        ),
    ]
}
