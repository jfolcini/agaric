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

pub fn reverse_delete_block(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: payload.block_id,
        deleted_at_ref: record.created_at,
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
        record.created_at,
        record.seq,
        &record.device_id,
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
    let prior = find_prior_position(
        pool,
        payload.block_id.as_str(),
        record.created_at,
        record.seq,
        &record.device_id,
    )
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior position found for block '{}' before ({}, {})",
            payload.block_id, record.device_id, record.seq
        ))
    })?;
    // #400: restore the block to its prior sibling slot. New-scheme prior ops
    // carry a 0-based `index`; legacy prior ops carry a sparse `position`.
    Ok(OpPayload::MoveBlock(
        prior.into_move_payload(payload.block_id),
    ))
}

// M-71: Reverse-of-restore is a bare `DeleteBlock(block_id)`. The
// original `RestoreBlockPayload::deleted_at_ref` is intentionally
// discarded — we do *not* propagate it into the reverse op.
//
// Trade-off: when the reverse is applied, `cascade_soft_delete` mints
// a fresh `deleted_at` timestamp. That new timestamp will not match
// the original cascade group's timestamp, so the Trash UI's
// timestamp-based grouping does not reproduce the original
// cascade-group identity across an undo→redo→undo→redo cycle. The
// asymmetry is observable in the Trash UI grouping but does not
// corrupt structural state — every block still has a coherent
// `deleted_at` and is restorable.
//
// Carrying `deleted_at_ref` through the reverse would require
// extending `DeleteBlockPayload` with a new optional field, which is
// an op_log payload (wire-format) extension and out of scope under
// AGENTS.md "Architectural Stability" — op payload extensions
// require explicit user approval. The pinning test
// `compute_reverse_restore_discards_deleted_at_ref_m71` in
// `reverse/tests.rs` makes this asymmetry loud rather than silent;
// flipping that assertion is the signal that the trade-off has been
// renegotiated.
pub fn reverse_restore_block(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: payload.block_id,
    }))
}

pub async fn find_prior_text(
    pool: &SqlitePool,
    block_id: &str,
    created_at: i64,
    seq: i64,
    device_id: &str,
) -> Result<Option<String>, AppError> {
    // M-63: use the indexed `block_id` column (migration 0030) instead of
    // `json_extract(payload, '$.block_id')` so undo of `edit_block` is
    // O(log N) on op_log size. AGENTS.md invariant #8: ULIDs are stored
    // uppercase for hash determinism, so normalize the bound parameter to
    // match — mirrors `recovery/draft_recovery.rs`.
    let bid_upper = block_id.to_ascii_uppercase();
    // #382: the op_log PK is `(device_id, seq)` and `seq` is a PER-DEVICE
    // counter, so the "strictly before" predicate must tie-break on the
    // full canonical `(created_at, seq, device_id)` total order — the same
    // order used by `commands/history.rs` and `pagination/history.rs`.
    // Omitting `device_id` leaves the bound ambiguous when two devices
    // share a `(created_at, seq)` pair: the equal-key op could fall on
    // either side of the boundary. Including `device_id` makes "the op
    // immediately before this one" well-defined cross-device.
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE block_id = ?1 \
           AND op_type IN ('edit_block', 'create_block') \
           AND (created_at < ?2 \
                OR (created_at = ?2 AND (seq < ?3 OR (seq = ?3 AND device_id < ?4)))) \
         ORDER BY created_at DESC, seq DESC, device_id DESC \
         LIMIT 1",
        bid_upper,
        created_at,
        seq,
        device_id,
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

/// A block's parent + sibling slot reconstructed from its last create/move op,
/// used to build the inverse of a `MoveBlock` (#400). The slot is index-based
/// for new-scheme prior ops and position-based for pre-#400 ops; `into_move_payload`
/// emits the matching `MoveBlockPayload`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PriorPlacement {
    parent: Option<BlockId>,
    /// 0-based slot when `Some` (new scheme); falls back to `position`.
    index: Option<i64>,
    /// Legacy 1-based position when `Some` (pre-#400 ops).
    position: Option<i64>,
}

impl PriorPlacement {
    fn into_move_payload(self, block_id: BlockId) -> MoveBlockPayload {
        match self.index {
            Some(idx) => MoveBlockPayload {
                block_id,
                new_parent_id: self.parent,
                // 1-based breadcrumb mirroring new_index (overflow-safe, shared).
                new_position: crate::pagination::index_to_provisional_position(idx),
                new_index: Some(idx),
            },
            None => MoveBlockPayload {
                block_id,
                new_parent_id: self.parent,
                new_position: self.position.unwrap_or(1),
                new_index: None,
            },
        }
    }
}

async fn find_prior_position(
    pool: &SqlitePool,
    block_id: &str,
    created_at: i64,
    seq: i64,
    device_id: &str,
) -> Result<Option<PriorPlacement>, AppError> {
    // M-63: see `find_prior_text` — use the indexed `block_id` column and
    // normalize to uppercase per AGENTS.md invariant #8.
    let bid_upper = block_id.to_ascii_uppercase();
    // #382: tie-break on the canonical `(created_at, seq, device_id)`
    // total order — see the matching note in `find_prior_text`.
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE block_id = ?1 \
           AND op_type IN ('move_block', 'create_block') \
           AND (created_at < ?2 \
                OR (created_at = ?2 AND (seq < ?3 OR (seq = ?3 AND device_id < ?4)))) \
         ORDER BY created_at DESC, seq DESC, device_id DESC \
         LIMIT 1",
        bid_upper,
        created_at,
        seq,
        device_id,
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => {
            if r.op_type == "move_block" {
                let p: MoveBlockPayload = serde_json::from_str(&r.payload)?;
                Ok(Some(PriorPlacement {
                    parent: p.new_parent_id,
                    index: p.new_index,
                    position: Some(p.new_position),
                }))
            } else {
                let p: CreateBlockPayload = serde_json::from_str(&r.payload)?;
                // #400: a new-scheme create carries a 0-based `index`; restore
                // to it. A pre-#400 create carries a 1-based `position`.
                // BUG-26: ancient `create_block` payloads predate the position
                // wire field (both `index` and `position` absent); we cannot
                // fabricate a valid reverse move for them — surface a
                // `NonReversible` error (matching `DeleteAttachment` when the
                // paired `AddAttachment` is gone) rather than guessing a slot.
                match (p.index, p.position) {
                    (Some(idx), _) => Ok(Some(PriorPlacement {
                        parent: p.parent_id,
                        index: Some(idx),
                        position: None,
                    })),
                    (None, Some(pos)) => Ok(Some(PriorPlacement {
                        parent: p.parent_id,
                        index: None,
                        position: Some(pos),
                    })),
                    (None, None) => Err(AppError::NonReversible {
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
                index: None,
                content: "A original".into(),
            }),
            1_736_942_400_000,
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
            1_736_942_460_000,
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
                index: None,
                content: "B original".into(),
            }),
            1_736_942_520_000,
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
            1_736_942_580_000,
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
            1_736_942_640_000,
        )
        .await
        .unwrap();

        let prior = find_prior_text(
            &pool,
            "BLKA",
            rec_a2.created_at,
            rec_a2.seq,
            &rec_a2.device_id,
        )
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
                index: None,
                content: "A".into(),
            }),
            1_736_942_400_000,
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
                new_index: None,
            }),
            1_736_942_460_000,
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
                index: None,
                content: "B".into(),
            }),
            1_736_942_520_000,
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
                new_index: None,
            }),
            1_736_942_580_000,
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
                new_index: None,
            }),
            1_736_942_640_000,
        )
        .await
        .unwrap();

        let prior = find_prior_position(
            &pool,
            "BLKMA",
            rec_a_move2.created_at,
            rec_a_move2.seq,
            &rec_a_move2.device_id,
        )
        .await
        .unwrap();
        // Legacy (pre-#400) prior move op → position-based PriorPlacement.
        assert_eq!(
            prior,
            Some(PriorPlacement {
                parent: Some(BlockId::test_id("P2")),
                index: None,
                position: Some(3),
            })
        );
    }

    /// #400: the NEW index-carrying branch of `find_prior_position` /
    /// `into_move_payload`. A prior move op that carried `new_index: Some(n)`
    /// must produce a `PriorPlacement { index: Some(n), .. }`, and its inverse
    /// `MoveBlockPayload` must carry `new_index: Some(n)` plus the `new_position`
    /// breadcrumb `n + 1` — so undo of a new-scheme move restores the slot, not
    /// a stale 1-based position. (The legacy branch is covered above.)
    #[tokio::test]
    async fn find_prior_position_new_scheme_index_branch() {
        let (pool, _dir) = test_pool().await;
        // Create BLKNEW, then move it with a new-scheme slot (new_index Some).
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLKNEW"),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                index: Some(0),
                content: "n".into(),
            }),
            1_736_950_000_000,
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLKNEW"),
                new_parent_id: Some(BlockId::test_id("PNEW")),
                new_position: 3,
                new_index: Some(2),
            }),
            1_736_950_060_000,
        )
        .await
        .unwrap();
        // A later move whose inverse we are reconstructing.
        let rec = append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLKNEW"),
                new_parent_id: Some(BlockId::test_id("POTHER")),
                new_position: 9,
                new_index: Some(8),
            }),
            1_736_950_120_000,
        )
        .await
        .unwrap();

        let prior = find_prior_position(&pool, "BLKNEW", rec.created_at, rec.seq, &rec.device_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            prior,
            PriorPlacement {
                parent: Some(BlockId::test_id("PNEW")),
                index: Some(2),
                position: Some(3),
            }
        );

        // The inverse move uses the index branch: new_index Some(2) + breadcrumb 3.
        let inv = prior.into_move_payload(BlockId::test_id("BLKNEW"));
        assert_eq!(inv.new_index, Some(2));
        assert_eq!(inv.new_position, 3);
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
                index: None,
                content: "seed".into(),
            }),
            1_736_942_400_000,
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
            1_736_942_460_000,
        )
        .await
        .unwrap();

        let upper_result =
            find_prior_text(&pool, "BLKLOWER", rec.created_at, rec.seq, &rec.device_id)
                .await
                .unwrap();
        let lower_result =
            find_prior_text(&pool, "blklower", rec.created_at, rec.seq, &rec.device_id)
                .await
                .unwrap();
        assert_eq!(upper_result, Some("seed".into()));
        assert_eq!(
            lower_result, upper_result,
            "lowercase block_id must match the same row as uppercase"
        );
    }
}
