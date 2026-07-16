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

pub(super) use crate::db::ReadPool;
pub(super) use crate::op::*;
pub(super) use crate::op_log::*;
pub(super) use agaric_core::error::AppError;
pub(super) use agaric_core::hash::compute_op_hash;
pub(super) use agaric_core::ulid::BlockId;
pub(super) use sqlx::SqlitePool;
pub(super) use tempfile::TempDir;

// ── Test fixture constants ──────────────────────────────────────────

// 2025-01-15T12:00:00Z in epoch-ms (op_log.created_at INTEGER, #109).
pub(super) const FIXED_TS: i64 = 1_736_942_400_000;
pub(super) const TEST_DEVICE: &str = "test-device";

// ── Helpers ─────────────────────────────────────────────────────────

/// Create a temp-file-backed SQLite pool with the workspace migrations
/// applied — a store-local stand-in for the app's `crate::db::init_pool`
/// (#2621, wave S3b-ii).
///
/// The app's `init_pool` couples to the app-only `recovery` module
/// (`ensure_blocks_table_exists` / `recover_derived_state_from_op_log` /
/// `reproject_blocks_from_engine`), which cannot move down into the store.
/// The op_log tests never need recovery-derived `blocks` state — only the
/// migrated schema — so this helper reproduces `init_pool`'s pool shape
/// minus recovery: `base_connect_options` (WAL journalling + `foreign_keys`)
/// on a temp file with `max_connections(5)`. WAL + a real file are load-bearing
/// for the immutability sibling-connection tests (WAL cross-connection snapshot
/// semantics) and the concurrent-append test (a shared DB across pooled
/// connections) — an in-memory pool cannot satisfy either.
pub(super) async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(crate::db::base_connect_options(&db_path))
        .await
        .unwrap();
    sqlx::migrate!("../migrations").run(&pool).await.unwrap();
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
        // Sidecar / canonical-JSON-ordering harnesses too.
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
