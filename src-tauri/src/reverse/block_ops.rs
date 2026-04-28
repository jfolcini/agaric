//! Reverse functions for block ops (create, edit, delete, move, restore).

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::op::{
    CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    RestoreBlockPayload,
};
use crate::op_log::OpRecord;
use crate::ulid::BlockId;

pub fn reverse_create_block(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: payload.block_id,
    }))
}

pub fn reverse_delete_block(_pool: &SqlitePool, record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: payload.block_id,
        deleted_at_ref: record.created_at.clone(),
    }))
}

pub async fn reverse_edit_block(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
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

pub async fn reverse_move_block(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
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

pub fn reverse_restore_block(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: payload.block_id,
    }))
}

pub async fn find_prior_text(
    pool: &SqlitePool,
    block_id: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<String>, AppError> {
    // M-63: use the indexed `block_id` column (migration 0030) instead of
    // `json_extract(payload, '$.block_id')` so undo of `edit_block` is
    // O(log N) on op_log size. AGENTS.md invariant #8: ULIDs are stored
    // uppercase for hash determinism, so normalize the bound parameter to
    // match — mirrors `recovery/draft_recovery.rs`.
    let bid_upper = block_id.to_ascii_uppercase();
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE block_id = ?1 \
           AND op_type IN ('edit_block', 'create_block') \
           AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        bid_upper,
        created_at,
        seq,
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => {
            if r.op_type == "edit_block" {
                let p: EditBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some(p.to_text))
            } else {
                let p: CreateBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some(p.content))
            }
        }
        None => Ok(None),
    }
}

async fn find_prior_position(
    pool: &SqlitePool,
    block_id: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<(Option<BlockId>, i64)>, AppError> {
    // M-63: see `find_prior_text` — use the indexed `block_id` column and
    // normalize to uppercase per AGENTS.md invariant #8.
    let bid_upper = block_id.to_ascii_uppercase();
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE block_id = ?1 \
           AND op_type IN ('move_block', 'create_block') \
           AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        bid_upper,
        created_at,
        seq,
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => {
            if r.op_type == "move_block" {
                let p: MoveBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some((p.new_parent_id, p.new_position)))
            } else {
                let p: CreateBlockPayload = serde_json::from_str(&r.payload)?;
                // BUG-26: block positions are 1-based and `move_block_inner`
                // rejects position 0 (and negatives) with a Validation error.
                // Ancient `create_block` payloads serialized before position
                // became part of the wire format carry `position = None`; we
                // cannot fabricate a valid reverse move for them. Surface this
                // as a `NonReversible` error — matching the pattern used for
                // `DeleteAttachment` when the paired `AddAttachment` is gone —
                // instead of silently defaulting to 0 (which overflows into a
                // downstream Validation error) or 1 (which pretends to know
                // where the block started).
                match p.position {
                    Some(pos) => Ok(Some((p.parent_id, pos))),
                    None => Err(AppError::NonReversible {
                        op_type: "move_block".into(),
                    }),
                }
            }
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests_m63 {
    //! M-63 regression tests: ensure `find_prior_text` and
    //! `find_prior_position` use the indexed `op_log.block_id` column
    //! (migration 0030) and uppercase-normalize the bound parameter so
    //! lookups remain case-insensitive against AGENTS.md invariant #8.
    use super::*;
    use crate::db::init_pool;
    use crate::op::{CreateBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const TEST_DEVICE: &str = "test-device";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Happy path: with two distinct blocks each carrying their own
    /// create + edit history, `find_prior_text` for block A must return
    /// A's previous text and never leak B's text. Exercises the
    /// `block_id = ?1` predicate against the indexed column.
    #[tokio::test]
    async fn find_prior_text_uses_block_id_column() {
        let (pool, _dir) = test_pool().await;

        // Block A: create + first edit.
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLKA"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                content: "A original".into(),
            }),
            "2025-01-15T12:00:00Z".into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLKA"),
                to_text: "A first edit".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:01:00Z".into(),
        )
        .await
        .unwrap();

        // Block B: create + edit (different block, must NOT match A's lookup).
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLKB"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(2),
                content: "B original".into(),
            }),
            "2025-01-15T12:02:00Z".into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLKB"),
                to_text: "B first edit".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:03:00Z".into(),
        )
        .await
        .unwrap();

        // A second edit on Block A — find_prior_text should return
        // "A first edit", never any of B's content.
        let rec_a2 = append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLKA"),
                to_text: "A second edit".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:04:00Z".into(),
        )
        .await
        .unwrap();

        let prior = find_prior_text(&pool, "BLKA", &rec_a2.created_at, rec_a2.seq)
            .await
            .unwrap();
        assert_eq!(prior, Some("A first edit".into()));
    }

    /// Happy path for `find_prior_position`: with two distinct blocks
    /// each having a create + move history, the lookup for block A must
    /// return A's most-recent prior position and never B's.
    #[tokio::test]
    async fn find_prior_position_uses_block_id_column() {
        let (pool, _dir) = test_pool().await;

        // Block A: create at (P1, 1), then move to (P2, 3).
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLKMA"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("P1")),
                position: Some(1),
                content: "A".into(),
            }),
            "2025-01-15T12:00:00Z".into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLKMA"),
                new_parent_id: Some(BlockId::test_id("P2")),
                new_position: 3,
            }),
            "2025-01-15T12:01:00Z".into(),
        )
        .await
        .unwrap();

        // Block B: independent history — must not influence A's lookup.
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLKMB"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("P9")),
                position: Some(9),
                content: "B".into(),
            }),
            "2025-01-15T12:02:00Z".into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLKMB"),
                new_parent_id: Some(BlockId::test_id("P9X")),
                new_position: 99,
            }),
            "2025-01-15T12:03:00Z".into(),
        )
        .await
        .unwrap();

        // Move A again — prior position for A must be (P2, 3).
        let rec_a_move2 = append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLKMA"),
                new_parent_id: Some(BlockId::test_id("P3")),
                new_position: 5,
            }),
            "2025-01-15T12:04:00Z".into(),
        )
        .await
        .unwrap();

        let prior = find_prior_position(&pool, "BLKMA", &rec_a_move2.created_at, rec_a_move2.seq)
            .await
            .unwrap();
        assert_eq!(prior, Some((Some(BlockId::test_id("P2")), 3)));
    }

    /// Stored block_id is uppercase (BlockId serializes uppercase per
    /// AGENTS.md invariant #8). Calling `find_prior_text` with a
    /// lowercase ID must still find the row, mirroring the
    /// `recovery/draft_recovery.rs` normalization pattern.
    #[tokio::test]
    async fn find_prior_text_uppercase_normalization() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLKLOWER"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                content: "seed".into(),
            }),
            "2025-01-15T12:00:00Z".into(),
        )
        .await
        .unwrap();
        let rec = append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLKLOWER"),
                to_text: "edited".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:01:00Z".into(),
        )
        .await
        .unwrap();

        let upper_result = find_prior_text(&pool, "BLKLOWER", &rec.created_at, rec.seq)
            .await
            .unwrap();
        let lower_result = find_prior_text(&pool, "blklower", &rec.created_at, rec.seq)
            .await
            .unwrap();
        assert_eq!(upper_result, Some("seed".into()));
        assert_eq!(
            lower_result, upper_result,
            "lowercase block_id must match the same row as uppercase"
        );
    }
}
