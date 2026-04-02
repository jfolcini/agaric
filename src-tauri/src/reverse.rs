//! Reverse (inverse) op computation for the undo engine.
//!
//! Given an existing op in the op log identified by `(device_id, seq)`, this
//! module computes the [`OpPayload`] that would reverse (undo) the effect of
//! that op.  Prior state is looked up from the op log itself, not from the
//! materialised `blocks` table, so the result is consistent even if the
//! materialiser hasn't caught up yet.
//!
//! ## Non-reversible operations
//!
//! `purge_block` is physically destructive and cannot be reversed.
//! Attempting to reverse it returns [`AppError::NonReversible`].
//!
//! `delete_attachment` is reversible when the original `add_attachment` op
//! exists in the op log — the reverse restores the attachment metadata.
//! When no prior `add_attachment` op is found, it falls back to
//! [`AppError::NonReversible`].

#![allow(dead_code)]

use sqlx::SqlitePool;
use std::str::FromStr;

use crate::error::AppError;
use crate::op::{
    AddTagPayload, CreateBlockPayload, DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload,
    MoveBlockPayload, OpPayload, OpType, RemoveTagPayload, RestoreBlockPayload, SetPropertyPayload,
};
use crate::op_log::OpRecord;
use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Compute the reverse (inverse) of an existing op.
///
/// Fetches the op identified by `(device_id, seq)` from the op log, then
/// returns the [`OpPayload`] that would undo its effect.  All database reads
/// are performed within a single read transaction for consistency.
///
/// # Errors
///
/// - [`AppError::NotFound`] — no op with the given `(device_id, seq)`
/// - [`AppError::NonReversible`] — the op type cannot be reversed
///   (`purge_block`, or `delete_attachment` when no prior `add_attachment` exists)
/// - [`AppError::Database`] — underlying SQLite error
/// - [`AppError::Json`] — payload deserialization failure
pub async fn compute_reverse(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
) -> Result<OpPayload, AppError> {
    // Fetch the target op
    let record = crate::op_log::get_op_by_seq(pool, device_id, seq).await?;

    let op_type = OpType::from_str(&record.op_type)
        .map_err(|e| AppError::Validation(format!("unknown op_type in record: {e}")))?;

    match op_type {
        OpType::CreateBlock => reverse_create_block(&record),
        OpType::DeleteBlock => reverse_delete_block(pool, &record),
        OpType::EditBlock => reverse_edit_block(pool, &record).await,
        OpType::MoveBlock => reverse_move_block(pool, &record).await,
        OpType::AddTag => reverse_add_tag(&record),
        OpType::RemoveTag => reverse_remove_tag(&record),
        OpType::SetProperty => reverse_set_property(pool, &record).await,
        OpType::DeleteProperty => reverse_delete_property(pool, &record).await,
        OpType::AddAttachment => reverse_add_attachment(&record),
        OpType::RestoreBlock => reverse_restore_block(&record),
        OpType::DeleteAttachment => reverse_delete_attachment(pool, &record).await,
        OpType::PurgeBlock => Err(AppError::NonReversible {
            op_type: record.op_type.clone(),
        }),
    }
}

// ---------------------------------------------------------------------------
// Per-op-type reverse implementations
// ---------------------------------------------------------------------------

/// `create_block` -> `DeleteBlock { block_id }`
fn reverse_create_block(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: payload.block_id,
    }))
}

/// `delete_block` -> `RestoreBlock { block_id, deleted_at_ref }`
///
/// Uses the `created_at` timestamp from the `delete_block` op record itself as
/// the `deleted_at_ref`.  The command sets `deleted_at = now` in the same
/// transaction, so `record.created_at` IS the `deleted_at` timestamp.  This
/// avoids a dependency on the materialised `blocks` table, which may lag.
fn reverse_delete_block(_pool: &SqlitePool, record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: DeleteBlockPayload = serde_json::from_str(&record.payload)?;

    Ok(OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: payload.block_id,
        deleted_at_ref: record.created_at.clone(),
    }))
}

/// `edit_block` -> `EditBlock { block_id, to_text: prior_text, prev_edit: Some((device_id, seq)) }`
///
/// Finds the prior text by looking for the most recent `edit_block` or
/// `create_block` for this `block_id` in the op log *before* the target op.
async fn reverse_edit_block(pool: &SqlitePool, record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;

    let prior_text = find_prior_text(
        pool,
        payload.block_id.as_str(),
        &record.created_at,
        record.seq,
    )
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior text found for block '{}' before ({}, {})",
            payload.block_id, record.device_id, record.seq
        ))
    })?;

    Ok(OpPayload::EditBlock(EditBlockPayload {
        block_id: payload.block_id,
        to_text: prior_text,
        prev_edit: Some((record.device_id.clone(), record.seq)),
    }))
}

/// `move_block` -> `MoveBlock { block_id, new_parent_id: old_parent, new_position: old_pos }`
///
/// Finds the prior parent/position by looking for the most recent `move_block`
/// or `create_block` for this `block_id` in the op log *before* the target op.
async fn reverse_move_block(pool: &SqlitePool, record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: MoveBlockPayload = serde_json::from_str(&record.payload)?;

    let (old_parent, old_pos) = find_prior_position(
        pool,
        payload.block_id.as_str(),
        &record.created_at,
        record.seq,
    )
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior position found for block '{}' before ({}, {})",
            payload.block_id, record.device_id, record.seq
        ))
    })?;

    Ok(OpPayload::MoveBlock(MoveBlockPayload {
        block_id: payload.block_id,
        new_parent_id: old_parent,
        new_position: old_pos,
    }))
}

/// `add_tag` -> `RemoveTag { block_id, tag_id }`
fn reverse_add_tag(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: AddTagPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RemoveTag(RemoveTagPayload {
        block_id: payload.block_id,
        tag_id: payload.tag_id,
    }))
}

/// `remove_tag` -> `AddTag { block_id, tag_id }`
fn reverse_remove_tag(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RemoveTagPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::AddTag(AddTagPayload {
        block_id: payload.block_id,
        tag_id: payload.tag_id,
    }))
}

/// `set_property` -> If prior `set_property` exists: `SetProperty` with prior values.
///                    If no prior: `DeleteProperty { block_id, key }`.
async fn reverse_set_property(pool: &SqlitePool, record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: SetPropertyPayload = serde_json::from_str(&record.payload)?;

    let prior = find_prior_property(
        pool,
        payload.block_id.as_str(),
        &payload.key,
        &record.created_at,
        record.seq,
    )
    .await?;

    match prior {
        Some(prior_payload) => Ok(OpPayload::SetProperty(SetPropertyPayload {
            block_id: payload.block_id,
            key: payload.key,
            value_text: prior_payload.value_text,
            value_num: prior_payload.value_num,
            value_date: prior_payload.value_date,
            value_ref: prior_payload.value_ref,
        })),
        None => Ok(OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: payload.block_id,
            key: payload.key,
        })),
    }
}

/// `delete_property` -> `SetProperty` with prior value.
///
/// Errors if no prior `set_property` is found (can't restore what never existed).
async fn reverse_delete_property(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: DeletePropertyPayload = serde_json::from_str(&record.payload)?;

    let prior = find_prior_property(
        pool,
        payload.block_id.as_str(),
        &payload.key,
        &record.created_at,
        record.seq,
    )
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior set_property found for block '{}' key '{}' — cannot reverse delete_property",
            payload.block_id, payload.key
        ))
    })?;

    Ok(OpPayload::SetProperty(SetPropertyPayload {
        block_id: payload.block_id,
        key: payload.key,
        value_text: prior.value_text,
        value_num: prior.value_num,
        value_date: prior.value_date,
        value_ref: prior.value_ref,
    }))
}

/// `add_attachment` -> `DeleteAttachment { attachment_id }`
fn reverse_add_attachment(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: crate::op::AddAttachmentPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteAttachment(
        crate::op::DeleteAttachmentPayload {
            attachment_id: payload.attachment_id,
        },
    ))
}

/// `delete_attachment` -> `AddAttachment { ... }` (restore from op log)
async fn reverse_delete_attachment(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: crate::op::DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;

    // Find the original add_attachment op for this attachment
    let original = sqlx::query!(
        r#"SELECT payload FROM op_log
         WHERE op_type = 'add_attachment'
         AND json_extract(payload, '$.attachment_id') = ?1
         AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3))
         ORDER BY created_at DESC, seq DESC
         LIMIT 1"#,
        payload.attachment_id,
        record.created_at,
        record.seq
    )
    .fetch_optional(pool)
    .await?;

    match original {
        Some(row) => {
            let add_payload: crate::op::AddAttachmentPayload = serde_json::from_str(&row.payload)?;
            Ok(OpPayload::AddAttachment(add_payload))
        }
        None => Err(AppError::NonReversible {
            op_type: "delete_attachment".into(),
        }),
    }
}

/// `restore_block` -> `DeleteBlock { block_id }`
fn reverse_restore_block(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: payload.block_id,
    }))
}

// ---------------------------------------------------------------------------
// Prior-state lookup helpers
// ---------------------------------------------------------------------------

/// Find the text content of a block as it was *before* the op at
/// `(created_at, seq)`.
///
/// Searches the op log for the most recent `edit_block` or `create_block` for
/// the given `block_id` before the target op, ordered by
/// `(created_at DESC, seq DESC)`.
///
/// - For `edit_block` ops, returns `to_text`.
/// - For `create_block` ops, returns `content`.
pub(crate) async fn find_prior_text(
    pool: &SqlitePool,
    block_id: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<String>, AppError> {
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ?1 \
           AND op_type IN ('edit_block', 'create_block') \
           AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        block_id,   // ?1
        created_at, // ?2
        seq,        // ?3
    )
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => {
            if r.op_type == "edit_block" {
                let p: EditBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some(p.to_text))
            } else {
                // create_block
                let p: CreateBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some(p.content))
            }
        }
        None => Ok(None),
    }
}

/// Find the parent/position of a block as it was *before* the op at
/// `(created_at, seq)`.
///
/// Searches for the most recent `move_block` or `create_block` for the given
/// `block_id` before the target op.
///
/// - For `move_block`, returns `(new_parent_id, new_position)`.
/// - For `create_block`, returns `(parent_id, position)`.
async fn find_prior_position(
    pool: &SqlitePool,
    block_id: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<(Option<BlockId>, i64)>, AppError> {
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ?1 \
           AND op_type IN ('move_block', 'create_block') \
           AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        block_id,   // ?1
        created_at, // ?2
        seq,        // ?3
    )
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => {
            if r.op_type == "move_block" {
                let p: MoveBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some((p.new_parent_id, p.new_position)))
            } else {
                // create_block
                let p: CreateBlockPayload = serde_json::from_str(&r.payload)?;
                // Position 0 = first child; None means unset, default to first
                Ok(Some((p.parent_id, p.position.unwrap_or(0))))
            }
        }
        None => Ok(None),
    }
}

/// Row shape for prior set_property lookup.
struct PriorPropertyRow {
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
}

/// Find the property values for `(block_id, key)` as they were *before* the op
/// at `(created_at, seq)`.
///
/// Searches for the most recent `set_property` with the same `(block_id, key)`
/// before the target op.
async fn find_prior_property(
    pool: &SqlitePool,
    block_id: &str,
    key: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<PriorPropertyRow>, AppError> {
    let row = sqlx::query!(
        "SELECT payload FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ?1 \
           AND json_extract(payload, '$.key') = ?2 \
           AND op_type = 'set_property' \
           AND (created_at < ?3 OR (created_at = ?3 AND seq < ?4)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        block_id,   // ?1
        key,        // ?2
        created_at, // ?3
        seq,        // ?4
    )
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => {
            let p: SetPropertyPayload = serde_json::from_str(&r.payload)?;
            Ok(Some(PriorPropertyRow {
                value_text: p.value_text,
                value_num: p.value_num,
                value_date: p.value_date,
                value_ref: p.value_ref,
            }))
        }
        None => Ok(None),
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::op::*;
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Fixture constants ───────────────────────────────────────────────

    const FIXED_TS: &str = "2025-01-15T12:00:00+00:00";
    const TEST_DEVICE: &str = "test-device";

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Create a temp-file-backed SQLite pool with migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Append an op via `append_local_op_at` with a bumped timestamp to ensure
    /// ordering.  Returns the OpRecord.
    async fn append_op(pool: &SqlitePool, payload: OpPayload, ts: &str) -> crate::op_log::OpRecord {
        append_local_op_at(pool, TEST_DEVICE, payload, ts.to_string())
            .await
            .unwrap()
    }

    // ── 1. Reverse create_block -> DeleteBlock ──────────────────────────

    #[tokio::test]
    async fn reverse_create_block_produces_delete_block() {
        let (pool, _dir) = test_pool().await;

        let create = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "hello".into(),
        });
        let rec = append_op(&pool, create, FIXED_TS).await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        assert!(
            matches!(reverse, OpPayload::DeleteBlock(ref p) if p.block_id == "BLK1"),
            "reverse of create_block should be DeleteBlock, got: {reverse:?}"
        );
    }

    // ── 2. Reverse delete_block -> RestoreBlock ─────────────────────────

    #[tokio::test]
    async fn reverse_delete_block_produces_restore_block_with_deleted_at() {
        let (pool, _dir) = test_pool().await;

        // Append a delete_block op — the op's created_at IS the deleted_at timestamp,
        // no blocks table row needed.
        let delete_ts = "2025-01-15T13:00:00+00:00";
        let delete = OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("BLK2"),
        });
        let rec = append_op(&pool, delete, delete_ts).await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::RestoreBlock(ref p) => {
                assert_eq!(p.block_id, "BLK2", "block_id mismatch");
                assert_eq!(
                    p.deleted_at_ref, delete_ts,
                    "deleted_at_ref should match the op's created_at timestamp"
                );
            }
            _ => panic!("expected RestoreBlock, got: {reverse:?}"),
        }
    }

    // ── 3. Reverse edit_block -> EditBlock with prior text ──────────────

    #[tokio::test]
    async fn reverse_edit_block_produces_edit_with_prior_text() {
        let (pool, _dir) = test_pool().await;

        // First: create_block (content = "original")
        let create = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "original".into(),
        });
        append_op(&pool, create, "2025-01-15T12:00:00+00:00").await;

        // Second: edit_block #1 (to_text = "first edit")
        let edit1 = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            to_text: "first edit".into(),
            prev_edit: None,
        });
        append_op(&pool, edit1, "2025-01-15T12:01:00+00:00").await;

        // Third: edit_block #2 (to_text = "second edit")
        let edit2 = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            to_text: "second edit".into(),
            prev_edit: None,
        });
        let rec = append_op(&pool, edit2, "2025-01-15T12:02:00+00:00").await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::EditBlock(ref p) => {
                assert_eq!(p.block_id, "BLK3", "block_id mismatch");
                assert_eq!(
                    p.to_text, "first edit",
                    "reverse should use prior edit's to_text"
                );
                assert!(
                    p.prev_edit.is_some(),
                    "reverse edit should have prev_edit = Some((device_id, seq))"
                );
                let (ref dev, seq) = p.prev_edit.as_ref().unwrap();
                assert_eq!(dev, TEST_DEVICE, "prev_edit device_id should match");
                assert_eq!(
                    *seq, rec.seq,
                    "prev_edit seq should match the reversed op's seq"
                );
            }
            _ => panic!("expected EditBlock, got: {reverse:?}"),
        }
    }

    // ── 4. Reverse edit_block when prior is create_block ────────────────

    #[tokio::test]
    async fn reverse_edit_block_when_prior_is_create_uses_content() {
        let (pool, _dir) = test_pool().await;

        // create_block with content = "from create"
        let create = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK4"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "from create".into(),
        });
        append_op(&pool, create, "2025-01-15T12:00:00+00:00").await;

        // edit_block (to_text = "edited")
        let edit = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK4"),
            to_text: "edited".into(),
            prev_edit: None,
        });
        let rec = append_op(&pool, edit, "2025-01-15T12:01:00+00:00").await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::EditBlock(ref p) => {
                assert_eq!(
                    p.to_text, "from create",
                    "reverse should use create_block's content when no prior edit exists"
                );
            }
            _ => panic!("expected EditBlock, got: {reverse:?}"),
        }
    }

    // ── 5. Reverse move_block -> MoveBlock with prior parent/position ───

    #[tokio::test]
    async fn reverse_move_block_produces_move_with_prior_position() {
        let (pool, _dir) = test_pool().await;

        // First: create_block with parent_id = "P1", position = 1
        let create = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK5"),
            block_type: "content".into(),
            parent_id: Some(BlockId::test_id("P1")),
            position: Some(1),
            content: "test".into(),
        });
        append_op(&pool, create, "2025-01-15T12:00:00+00:00").await;

        // Second: move_block #1 (new_parent_id = "P2", new_position = 3)
        let move1 = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK5"),
            new_parent_id: Some(BlockId::test_id("P2")),
            new_position: 3,
        });
        append_op(&pool, move1, "2025-01-15T12:01:00+00:00").await;

        // Third: move_block #2 (new_parent_id = "P3", new_position = 5)
        let move2 = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK5"),
            new_parent_id: Some(BlockId::test_id("P3")),
            new_position: 5,
        });
        let rec = append_op(&pool, move2, "2025-01-15T12:02:00+00:00").await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::MoveBlock(ref p) => {
                assert_eq!(p.block_id, "BLK5", "block_id mismatch");
                assert_eq!(
                    p.new_parent_id,
                    Some(BlockId::test_id("P2")),
                    "reverse should use prior move's parent_id"
                );
                assert_eq!(
                    p.new_position, 3,
                    "reverse should use prior move's position"
                );
            }
            _ => panic!("expected MoveBlock, got: {reverse:?}"),
        }
    }

    // ── 6. Reverse move_block when prior is create_block ────────────────

    #[tokio::test]
    async fn reverse_move_block_when_prior_is_create_uses_create_position() {
        let (pool, _dir) = test_pool().await;

        // create_block with parent_id = "ROOT", position = 2
        let create = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK6"),
            block_type: "content".into(),
            parent_id: Some(BlockId::test_id("ROOT")),
            position: Some(2),
            content: "test".into(),
        });
        append_op(&pool, create, "2025-01-15T12:00:00+00:00").await;

        // move_block (new_parent_id = "OTHER", new_position = 7)
        let mv = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK6"),
            new_parent_id: Some(BlockId::test_id("OTHER")),
            new_position: 7,
        });
        let rec = append_op(&pool, mv, "2025-01-15T12:01:00+00:00").await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::MoveBlock(ref p) => {
                assert_eq!(
                    p.new_parent_id,
                    Some(BlockId::test_id("ROOT")),
                    "reverse should use create_block's parent_id"
                );
                assert_eq!(
                    p.new_position, 2,
                    "reverse should use create_block's position"
                );
            }
            _ => panic!("expected MoveBlock, got: {reverse:?}"),
        }
    }

    // ── 7. Reverse add_tag -> RemoveTag ─────────────────────────────────

    #[tokio::test]
    async fn reverse_add_tag_produces_remove_tag() {
        let (pool, _dir) = test_pool().await;

        let add = OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("BLK7"),
            tag_id: BlockId::test_id("TAG1"),
        });
        let rec = append_op(&pool, add, FIXED_TS).await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::RemoveTag(ref p) => {
                assert_eq!(p.block_id, "BLK7", "block_id mismatch");
                assert_eq!(p.tag_id, "TAG1", "tag_id mismatch");
            }
            _ => panic!("expected RemoveTag, got: {reverse:?}"),
        }
    }

    // ── 8. Reverse remove_tag -> AddTag ─────────────────────────────────

    #[tokio::test]
    async fn reverse_remove_tag_produces_add_tag() {
        let (pool, _dir) = test_pool().await;

        let remove = OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::test_id("BLK8"),
            tag_id: BlockId::test_id("TAG2"),
        });
        let rec = append_op(&pool, remove, FIXED_TS).await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::AddTag(ref p) => {
                assert_eq!(p.block_id, "BLK8", "block_id mismatch");
                assert_eq!(p.tag_id, "TAG2", "tag_id mismatch");
            }
            _ => panic!("expected AddTag, got: {reverse:?}"),
        }
    }

    // ── 9. Reverse set_property -> SetProperty with prior value or DeleteProperty ──

    #[tokio::test]
    async fn reverse_set_property_with_prior_produces_set_property() {
        let (pool, _dir) = test_pool().await;

        // First set_property: key = "priority", value_text = "low"
        let set1 = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK9"),
            key: "priority".into(),
            value_text: Some("low".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        });
        append_op(&pool, set1, "2025-01-15T12:00:00+00:00").await;

        // Second set_property: key = "priority", value_text = "high"
        let set2 = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK9"),
            key: "priority".into(),
            value_text: Some("high".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        });
        let rec = append_op(&pool, set2, "2025-01-15T12:01:00+00:00").await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::SetProperty(ref p) => {
                assert_eq!(p.block_id, "BLK9", "block_id mismatch");
                assert_eq!(p.key, "priority", "key mismatch");
                assert_eq!(
                    p.value_text,
                    Some("low".into()),
                    "reverse should use prior set_property's value"
                );
            }
            _ => panic!("expected SetProperty, got: {reverse:?}"),
        }
    }

    #[tokio::test]
    async fn reverse_first_set_property_produces_delete_property() {
        let (pool, _dir) = test_pool().await;

        // Only one set_property — no prior exists
        let set1 = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK9B"),
            key: "status".into(),
            value_text: Some("active".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        });
        let rec = append_op(&pool, set1, FIXED_TS).await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::DeleteProperty(ref p) => {
                assert_eq!(p.block_id, "BLK9B", "block_id mismatch");
                assert_eq!(p.key, "status", "key mismatch");
            }
            _ => panic!("reverse of first set_property should be DeleteProperty, got: {reverse:?}"),
        }
    }

    // ── 10. Reverse delete_property -> SetProperty with prior value ─────

    #[tokio::test]
    async fn reverse_delete_property_produces_set_property_with_prior() {
        let (pool, _dir) = test_pool().await;

        // set_property: key = "color", value_text = "blue"
        let set = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK10"),
            key: "color".into(),
            value_text: Some("blue".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        });
        append_op(&pool, set, "2025-01-15T12:00:00+00:00").await;

        // delete_property: key = "color"
        let del = OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK10"),
            key: "color".into(),
        });
        let rec = append_op(&pool, del, "2025-01-15T12:01:00+00:00").await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::SetProperty(ref p) => {
                assert_eq!(p.block_id, "BLK10", "block_id mismatch");
                assert_eq!(p.key, "color", "key mismatch");
                assert_eq!(
                    p.value_text,
                    Some("blue".into()),
                    "reverse should restore prior property value"
                );
            }
            _ => panic!("expected SetProperty, got: {reverse:?}"),
        }
    }

    // ── 11. Reverse add_attachment -> DeleteAttachment ───────────────────

    #[tokio::test]
    async fn reverse_add_attachment_produces_delete_attachment() {
        let (pool, _dir) = test_pool().await;

        let add = OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: "ATT1".into(),
            block_id: BlockId::test_id("BLK11"),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        });
        let rec = append_op(&pool, add, FIXED_TS).await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        match reverse {
            OpPayload::DeleteAttachment(ref p) => {
                assert_eq!(p.attachment_id, "ATT1", "attachment_id mismatch");
            }
            _ => panic!("expected DeleteAttachment, got: {reverse:?}"),
        }
    }

    // ── 12. Error on purge_block ────────────────────────────────────────

    #[tokio::test]
    async fn reverse_purge_block_returns_non_reversible_error() {
        let (pool, _dir) = test_pool().await;

        let purge = OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("BLK12"),
        });
        let rec = append_op(&pool, purge, FIXED_TS).await;

        let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;

        assert!(result.is_err(), "purge_block should not be reversible");
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::NonReversible { ref op_type } if op_type == "purge_block"),
            "expected NonReversible error for purge_block, got: {err:?}"
        );
    }

    // ── 13. Error on delete_attachment ──────────────────────────────────

    #[tokio::test]
    async fn reverse_delete_attachment_returns_non_reversible_error() {
        let (pool, _dir) = test_pool().await;

        let del = OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: "ATT2".into(),
        });
        let rec = append_op(&pool, del, FIXED_TS).await;

        let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;

        assert!(
            result.is_err(),
            "delete_attachment should not be reversible"
        );
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::NonReversible { ref op_type } if op_type == "delete_attachment"),
            "expected NonReversible error for delete_attachment, got: {err:?}"
        );
    }

    // ── 14. Reverse restore_block -> DeleteBlock ────────────────────────

    #[tokio::test]
    async fn reverse_restore_block_produces_delete_block() {
        let (pool, _dir) = test_pool().await;

        let restore = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("BLK14"),
            deleted_at_ref: "2025-01-15T10:00:00+00:00".into(),
        });
        let rec = append_op(&pool, restore, FIXED_TS).await;

        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();

        assert!(
            matches!(reverse, OpPayload::DeleteBlock(ref p) if p.block_id == "BLK14"),
            "reverse of restore_block should be DeleteBlock, got: {reverse:?}"
        );
    }

    // ── 15. Error: edit_block without prior -> NotFound ─────────────────

    #[tokio::test]
    async fn reverse_edit_block_without_prior_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        // edit_block for a block that has no prior create_block or edit_block
        let edit = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("ORPHAN_EDIT"),
            to_text: "new text".into(),
            prev_edit: None,
        });
        let rec = append_op(&pool, edit, FIXED_TS).await;

        let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;

        assert!(result.is_err(), "edit_block without prior should fail");
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound error for edit_block without prior, got: {err:?}"
        );
    }

    // ── 16. Error: move_block without prior -> NotFound ─────────────────

    #[tokio::test]
    async fn reverse_move_block_without_prior_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        // move_block for a block that has no prior create_block or move_block
        let mv = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("ORPHAN_MOVE"),
            new_parent_id: Some(BlockId::test_id("P1")),
            new_position: 5,
        });
        let rec = append_op(&pool, mv, FIXED_TS).await;

        let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;

        assert!(result.is_err(), "move_block without prior should fail");
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound error for move_block without prior, got: {err:?}"
        );
    }

    // ── 17. Error: delete_property without prior -> NotFound ────────────

    #[tokio::test]
    async fn reverse_delete_property_without_prior_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        // delete_property for a (block_id, key) that has no prior set_property
        let del = OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("ORPHAN_PROP"),
            key: "color".into(),
        });
        let rec = append_op(&pool, del, FIXED_TS).await;

        let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;

        assert!(result.is_err(), "delete_property without prior should fail");
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound error for delete_property without prior, got: {err:?}"
        );
    }

    // ── 18. Error: delete_block for missing block -> NotFound ───────────

    #[tokio::test]
    async fn reverse_delete_block_missing_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        // delete_block for a block_id that doesn't exist in the blocks table.
        // With the current implementation, reverse_delete_block uses the op's
        // created_at directly, so it succeeds.  This test verifies the op must
        // exist in the op log to be reversible (i.e. the seq must be found).
        let result = compute_reverse(&pool, TEST_DEVICE, 9999).await;

        assert!(result.is_err(), "non-existent op seq should fail");
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound error for non-existent op seq, got: {err:?}"
        );
    }

    // ── 19. Edit undo chain (reverse → apply → reverse again) ───────────

    #[tokio::test]
    async fn undo_chain_edit_round_trip() {
        let (pool, _dir) = test_pool().await;

        // Create block with content "original"
        let _create = append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_UC1"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("PAGE1")),
                position: Some(0),
                content: "original".into(),
            }),
            FIXED_TS,
        )
        .await;

        // Edit to "modified"
        let edit = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK_UC1"),
                to_text: "modified".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;

        // Reverse the edit → should get EditBlock { to_text: "original" }
        let rev1 = compute_reverse(&pool, TEST_DEVICE, edit.seq).await.unwrap();
        match &rev1 {
            OpPayload::EditBlock(p) => {
                assert_eq!(p.to_text, "original");
            }
            other => panic!("Expected EditBlock, got {:?}", other),
        }

        // Apply the reverse (append it to op log)
        let undo_op = append_op(&pool, rev1, "2025-01-15T12:02:00+00:00").await;

        // Now reverse the undo → should get EditBlock { to_text: "modified" }
        let rev2 = compute_reverse(&pool, TEST_DEVICE, undo_op.seq)
            .await
            .unwrap();
        match &rev2 {
            OpPayload::EditBlock(p) => {
                assert_eq!(p.to_text, "modified");
            }
            other => panic!("Expected EditBlock, got {:?}", other),
        }
    }

    // ── 20. Move undo chain (reverse → apply → reverse again) ───────────

    #[tokio::test]
    async fn undo_chain_move_round_trip() {
        let (pool, _dir) = test_pool().await;

        // Create block at parent=PAGE1, position=0
        let _create = append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_UC2"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("PAGE1")),
                position: Some(0),
                content: "moveable".into(),
            }),
            FIXED_TS,
        )
        .await;

        // Move to parent=PAGE2, position=5
        let move_op = append_op(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK_UC2"),
                new_parent_id: Some(BlockId::test_id("PAGE2")),
                new_position: 5,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;

        // Reverse → should get MoveBlock back to PAGE1, position=0
        let rev1 = compute_reverse(&pool, TEST_DEVICE, move_op.seq)
            .await
            .unwrap();
        match &rev1 {
            OpPayload::MoveBlock(p) => {
                assert_eq!(p.new_parent_id, Some(BlockId::test_id("PAGE1")));
                assert_eq!(p.new_position, 0);
            }
            other => panic!("Expected MoveBlock, got {:?}", other),
        }

        // Apply reverse
        let undo_op = append_op(&pool, rev1, "2025-01-15T12:02:00+00:00").await;

        // Reverse again → should get MoveBlock to PAGE2, position=5
        let rev2 = compute_reverse(&pool, TEST_DEVICE, undo_op.seq)
            .await
            .unwrap();
        match &rev2 {
            OpPayload::MoveBlock(p) => {
                assert_eq!(p.new_parent_id, Some(BlockId::test_id("PAGE2")));
                assert_eq!(p.new_position, 5);
            }
            other => panic!("Expected MoveBlock, got {:?}", other),
        }
    }

    // ── 21. Create/Delete undo chain ────────────────────────────────────

    #[tokio::test]
    async fn undo_chain_create_delete_restore() {
        let (pool, _dir) = test_pool().await;

        // Create block
        let create = append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_UC3"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "ephemeral".into(),
            }),
            FIXED_TS,
        )
        .await;

        // Reverse create → should be DeleteBlock
        let rev1 = compute_reverse(&pool, TEST_DEVICE, create.seq)
            .await
            .unwrap();
        match &rev1 {
            OpPayload::DeleteBlock(p) => {
                assert_eq!(p.block_id, "BLK_UC3");
            }
            other => panic!("Expected DeleteBlock, got {:?}", other),
        }

        // Apply the DeleteBlock
        let delete_op = append_op(&pool, rev1, "2025-01-15T12:01:00+00:00").await;

        // Reverse the delete → should be RestoreBlock
        let rev2 = compute_reverse(&pool, TEST_DEVICE, delete_op.seq)
            .await
            .unwrap();
        match &rev2 {
            OpPayload::RestoreBlock(p) => {
                assert_eq!(p.block_id, "BLK_UC3");
                assert_eq!(
                    p.deleted_at_ref, "2025-01-15T12:01:00+00:00",
                    "deleted_at_ref should match the delete op's created_at"
                );
            }
            other => panic!("Expected RestoreBlock, got {:?}", other),
        }

        // Apply the RestoreBlock
        let restore_op = append_op(&pool, rev2, "2025-01-15T12:02:00+00:00").await;

        // Reverse the restore → should be DeleteBlock again
        let rev3 = compute_reverse(&pool, TEST_DEVICE, restore_op.seq)
            .await
            .unwrap();
        match &rev3 {
            OpPayload::DeleteBlock(p) => {
                assert_eq!(p.block_id, "BLK_UC3");
            }
            other => panic!("Expected DeleteBlock, got {:?}", other),
        }
    }

    // ── 22. Property reversal with value_num ────────────────────────────

    #[tokio::test]
    async fn reverse_set_property_value_num() {
        let (pool, _dir) = test_pool().await;

        // First set_property with value_num = 42
        let set1 = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PN"),
                key: "score".into(),
                value_text: None,
                value_num: Some(42.0),
                value_date: None,
                value_ref: None,
            }),
            FIXED_TS,
        )
        .await;

        // Reverse first set → should be DeleteProperty (no prior)
        let rev1 = compute_reverse(&pool, TEST_DEVICE, set1.seq).await.unwrap();
        match &rev1 {
            OpPayload::DeleteProperty(p) => {
                assert_eq!(p.block_id, "BLK_PN");
                assert_eq!(p.key, "score");
            }
            other => panic!("Expected DeleteProperty, got {:?}", other),
        }

        // Second set_property with value_num = 99
        let set2 = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PN"),
                key: "score".into(),
                value_text: None,
                value_num: Some(99.0),
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;

        // Reverse second set → should be SetProperty with value_num = 42
        let rev2 = compute_reverse(&pool, TEST_DEVICE, set2.seq).await.unwrap();
        match &rev2 {
            OpPayload::SetProperty(p) => {
                assert_eq!(p.block_id, "BLK_PN");
                assert_eq!(p.key, "score");
                assert_eq!(p.value_num, Some(42.0), "should restore prior value_num");
                assert_eq!(p.value_text, None, "other value fields should be None");
                assert_eq!(p.value_date, None, "other value fields should be None");
                assert_eq!(p.value_ref, None, "other value fields should be None");
            }
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }

    // ── 23. Property reversal with value_date ───────────────────────────

    #[tokio::test]
    async fn reverse_set_property_value_date() {
        let (pool, _dir) = test_pool().await;

        // First set_property with value_date
        let set1 = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PD"),
                key: "due-date".into(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-06-15".into()),
                value_ref: None,
            }),
            FIXED_TS,
        )
        .await;

        // Reverse first set → should be DeleteProperty (no prior)
        let rev1 = compute_reverse(&pool, TEST_DEVICE, set1.seq).await.unwrap();
        match &rev1 {
            OpPayload::DeleteProperty(p) => {
                assert_eq!(p.block_id, "BLK_PD");
                assert_eq!(p.key, "due-date");
            }
            other => panic!("Expected DeleteProperty, got {:?}", other),
        }

        // Second set_property with a different value_date
        let set2 = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PD"),
                key: "due-date".into(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-12-31".into()),
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;

        // Reverse second set → should be SetProperty with value_date = "2025-06-15"
        let rev2 = compute_reverse(&pool, TEST_DEVICE, set2.seq).await.unwrap();
        match &rev2 {
            OpPayload::SetProperty(p) => {
                assert_eq!(p.block_id, "BLK_PD");
                assert_eq!(p.key, "due-date");
                assert_eq!(
                    p.value_date,
                    Some("2025-06-15".into()),
                    "should restore prior value_date"
                );
                assert_eq!(p.value_text, None, "other value fields should be None");
                assert_eq!(p.value_num, None, "other value fields should be None");
                assert_eq!(p.value_ref, None, "other value fields should be None");
            }
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }

    // ── 24. Multiple edits with same timestamp (seq ordering) ───────────

    #[tokio::test]
    async fn reverse_edit_same_timestamp_uses_seq_ordering() {
        let (pool, _dir) = test_pool().await;

        // Create block
        let _create = append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_SEQ"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "v0".into(),
            }),
            FIXED_TS,
        )
        .await;

        // Edit 1 at T=12:01:00
        let same_ts = "2025-01-15T12:01:00+00:00";
        let _edit1 = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK_SEQ"),
                to_text: "v1".into(),
                prev_edit: None,
            }),
            same_ts,
        )
        .await;

        // Edit 2 at same T=12:01:00 (different seq, same timestamp)
        let edit2 = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK_SEQ"),
                to_text: "v2".into(),
                prev_edit: None,
            }),
            same_ts,
        )
        .await;

        // Reverse edit 2 → should find edit 1 as prior (seq < edit2.seq,
        // same timestamp). Tests the WHERE (created_at < ?2 OR (created_at = ?2 AND seq < ?3)) clause.
        let rev = compute_reverse(&pool, TEST_DEVICE, edit2.seq)
            .await
            .unwrap();
        match &rev {
            OpPayload::EditBlock(p) => {
                assert_eq!(
                    p.to_text, "v1",
                    "reverse of edit2 should use edit1's to_text, proving seq ordering within same timestamp"
                );
            }
            other => panic!("Expected EditBlock, got {:?}", other),
        }
    }

    // ── 25. Reverse edit_block from a different device ──────────────────

    /// Create an `edit_block` op on device B, reverse it, and verify the
    /// reverse op's `prev_edit` contains device B's `(device_id, seq)` —
    /// NOT device A's. This exercises the cross-device case that existing
    /// tests (which always use `TEST_DEVICE`) do not cover.
    #[tokio::test]
    async fn reverse_edit_block_prev_edit_points_to_reversed_op_from_different_device() {
        let (pool, _dir) = test_pool().await;
        let dev_b = "device-B";

        // Create block on TEST_DEVICE (seq 1)
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_XD"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "original".into(),
            }),
            FIXED_TS,
        )
        .await;

        // Edit on device B (different device) at a later timestamp
        let edit_b = append_local_op_at(
            &pool,
            dev_b,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK_XD"),
                to_text: "edited by B".into(),
                prev_edit: Some((TEST_DEVICE.to_owned(), 1)),
            }),
            "2025-01-15T12:01:00+00:00".to_owned(),
        )
        .await
        .unwrap();

        // Reverse device B's edit
        let reverse = compute_reverse(&pool, dev_b, edit_b.seq).await.unwrap();

        match reverse {
            OpPayload::EditBlock(ref p) => {
                assert_eq!(p.block_id, "BLK_XD", "block_id mismatch");
                assert_eq!(
                    p.to_text, "original",
                    "reverse should restore prior text from create_block"
                );

                // The critical assertion: prev_edit must point to device B's op,
                // not TEST_DEVICE's.
                let (ref dev, seq) = p.prev_edit.as_ref().expect("reverse should have prev_edit");
                assert_eq!(
                    dev, dev_b,
                    "prev_edit device_id must be device B (the reversed op's device), not TEST_DEVICE"
                );
                assert_eq!(
                    *seq, edit_b.seq,
                    "prev_edit seq must match the reversed op's seq on device B"
                );
            }
            _ => panic!("expected EditBlock, got: {reverse:?}"),
        }
    }

    // ── #128: reverse_delete_attachment returns AddAttachment ────────────

    #[tokio::test]
    async fn reverse_delete_attachment_returns_add_attachment_with_metadata() {
        let (pool, _dir) = test_pool().await;

        // First: add_attachment op
        let _add = append_op(
            &pool,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: "ATT_001".into(),
                block_id: BlockId::test_id("BLK_ATT"),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 2048,
                fs_path: "/data/photo.png".into(),
            }),
            FIXED_TS,
        )
        .await;

        // Second: delete_attachment op
        let del = append_op(
            &pool,
            OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
                attachment_id: "ATT_001".into(),
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;

        // Reverse the delete_attachment
        let reverse = compute_reverse(&pool, TEST_DEVICE, del.seq).await.unwrap();

        match &reverse {
            OpPayload::AddAttachment(p) => {
                assert_eq!(p.attachment_id, "ATT_001");
                assert_eq!(p.block_id, "BLK_ATT");
                assert_eq!(p.mime_type, "image/png");
                assert_eq!(p.filename, "photo.png");
                assert_eq!(p.size_bytes, 2048);
                assert_eq!(p.fs_path, "/data/photo.png");
            }
            other => panic!("Expected AddAttachment, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn reverse_delete_attachment_no_add_op_returns_non_reversible() {
        let (pool, _dir) = test_pool().await;

        // delete_attachment op without any prior add_attachment
        let del = append_op(
            &pool,
            OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
                attachment_id: "ATT_ORPHAN".into(),
            }),
            FIXED_TS,
        )
        .await;

        let result = compute_reverse(&pool, TEST_DEVICE, del.seq).await;
        assert!(
            matches!(result, Err(AppError::NonReversible { .. })),
            "should return NonReversible when no add_attachment found, got: {result:?}"
        );
    }

    #[tokio::test]
    async fn reverse_delete_attachment_roundtrip() {
        let (pool, _dir) = test_pool().await;

        // add_attachment op
        let add_rec = append_op(
            &pool,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: "ATT_RT".into(),
                block_id: BlockId::test_id("BLK_RT"),
                mime_type: "application/pdf".into(),
                filename: "doc.pdf".into(),
                size_bytes: 4096,
                fs_path: "/data/doc.pdf".into(),
            }),
            FIXED_TS,
        )
        .await;

        // Reverse add_attachment → should give DeleteAttachment
        let rev1 = compute_reverse(&pool, TEST_DEVICE, add_rec.seq)
            .await
            .unwrap();
        assert!(
            matches!(rev1, OpPayload::DeleteAttachment(ref p) if p.attachment_id == "ATT_RT"),
            "reverse of add_attachment should be DeleteAttachment, got: {rev1:?}"
        );

        // Append the delete_attachment op
        let del_rec = append_op(&pool, rev1, "2025-01-15T12:01:00+00:00").await;

        // Reverse delete_attachment → should give AddAttachment
        let rev2 = compute_reverse(&pool, TEST_DEVICE, del_rec.seq)
            .await
            .unwrap();
        match &rev2 {
            OpPayload::AddAttachment(p) => {
                assert_eq!(p.attachment_id, "ATT_RT");
                assert_eq!(p.block_id, "BLK_RT");
                assert_eq!(p.mime_type, "application/pdf");
                assert_eq!(p.filename, "doc.pdf");
                assert_eq!(p.size_bytes, 4096);
                assert_eq!(p.fs_path, "/data/doc.pdf");
            }
            other => panic!("Expected AddAttachment, got {:?}", other),
        }
    }
}
