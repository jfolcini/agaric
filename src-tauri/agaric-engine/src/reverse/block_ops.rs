//! Reverse functions for block ops (create, edit, delete, move, restore).

use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::ReadPool;
use agaric_store::op::{
    CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    RestoreBlockPayload,
};
use agaric_store::op_log::{OpRecord, resolve_prev_edit_target};

// #1543: the reverse of a `create_block` is a SOFT delete (`DeleteBlock`), not a
// hard purge. This is deliberate and internally consistent with the rest of the
// undo/redo machinery:
//
//   * Undo-of-create leaves the row soft-deleted (`deleted_at` set) and its
//     engine node tombstoned, rather than physically removing it. The block
//     disappears from the live view (the user-visible "undo create = remove
//     from view" expectation) while remaining recoverable.
//   * Redo (`apply.rs::apply_restore_via_loro` path) then re-applies onto the
//     EXISTING tombstoned node — a hard purge would have destroyed the node and
//     forced redo to recreate it, breaking CRDT identity / convergence.
// * It mirrors `reverse_restore_block` and `reverse_delete_block`: the
//     whole reverse family operates on soft-delete state, never hard purge.
//
// The cost is a lingering soft-deleted row + tombstone after create-then-undo,
// surfaced in the Trash. The pinning test
// `reverse_create_block_leaves_recoverable_soft_delete_not_purge` in
// `tests/command_integration/undo_integration.rs` makes this design loud rather
// than silent; flipping that assertion (to expect a purged/absent row) is the
// signal that the soft-delete trade-off is being renegotiated.
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

    // Resolve the causal pointer, if the op carries one. `None` covers
    // "no pointer" and "pointer dangles (op-log compaction)" — both mean the
    // same thing to `resolve_prior_text`: fall back to the timestamp scan.
    // A pointer naming a REPLICATED audit row resolves normally (#3644): it
    // is a locally-authored record of what this block held, and for a
    // peer-originated block it is the only such record there is.
    let prev_row = match &payload.prev_edit {
        Some((prev_device, prev_seq)) => {
            resolve_prev_edit_target(&ReadPool(pool.clone()), prev_device, *prev_seq).await?
        }
        None => None,
    };

    // Perf short-circuit ONLY: `resolve_prior_text` ignores the fallback
    // whenever the causal pointer resolved, so skipping the scan here cannot
    // change the answer — it just avoids a query the single-op path would
    // otherwise pay on every undo.
    let timestamp_prior = if prev_row.is_some() {
        None
    } else {
        find_prior_text_row(
            pool,
            payload.block_id.as_str(),
            record.created_at,
            record.seq,
            &record.device_id,
        )
        .await?
    };

    let prev_ptr = payload
        .prev_edit
        .as_ref()
        .map(|(device, seq)| (device.as_str(), *seq));
    let prior_text = resolve_prior_text(prev_row.as_ref().zip(prev_ptr), timestamp_prior.as_ref())?
        .ok_or_else(
            // #3645: `NonReversible`, matching the batch kernel byte-for-byte.
            // This condition means "no inverse can be reconstructed for this op",
            // which is exactly what `NonReversible` names; `NotFound` claimed a
            // missing RESOURCE and, more importantly, differed from the answer
            // `batch::build_reverse_edit_block` gives for the identical input —
            // so the same op was fatal under Ctrl+Z and skippable under a bulk
            // restore. The parity oracle compares `Ok` payloads only and could
            // not see the split.
            || AppError::NonReversible {
                op_type: record.op_type.clone(),
            },
        )?;

    Ok(OpPayload::EditBlock(EditBlockPayload {
        block_id: payload.block_id,
        to_text: prior_text,
        prev_edit: Some((record.device_id.clone(), record.seq)),
    }))
}

/// A resolved `prev_edit` row paired with the `(device_id, seq)` of the
/// pointer that named it. The pairing is the point: see
/// [`resolve_prior_text`] for why the row and its pointer are one `Option`
/// and not two.
type ResolvedPrevEdit<'a> = (&'a (String, String), (&'a str, i64));

/// The #1526 precedence, in ONE place — shared by the single-op kernel
/// ([`reverse_edit_block`]) and the batch kernel
/// (`reverse::batch::build_reverse_edit_block`). #3280.
///
/// Follow the op's CAUSAL predecessor (`EditBlockPayload::prev_edit`) when it
/// resolves, rather than reconstructing the pre-image purely by timestamp
/// order. `prev_edit` is the `(device_id, seq)` of the edit/create that was
/// the live value when this edit was authored (stamped by
/// `find_prev_edit_in_tx`, which keys on `seq DESC` — the per-device causal
/// counter — NOT `created_at`). Restoring exactly that op's text is the
/// correct undo target even under cross-device clock skew, where the
/// `(created_at, seq, device_id)` scan could pick a DIFFERENT ancestor that
/// the live edit had already superseded.
///
/// Fall back to the timestamp-ordered scan only when `prev` is `None` —
/// i.e. `prev_edit` was absent (pre-existing ops, or an edit whose pointer
/// was never recorded) or the pointed-at op is gone (op-log compaction).
/// A pointer into a replicated audit row RESOLVES; see
/// [`agaric_store::op_log::resolve_prev_edit_target`] for why the pointer
/// path and the blind scan take opposite provenance policies (#3644).
///
/// # Why this is shared
///
/// The batch kernel used to implement the FALLBACK ONLY: it derived the undo
/// text purely from the timestamp scan and never read `payload.prev_edit`,
/// while still writing a `prev_edit` onto the reverse op it produced. Since
/// `compute_reverse_batch` serves `revert_ops`, `restore_page_to_op`,
/// `undo_page_group` AND `undo_op`, two near-identical affordances ran
/// divergent kernels — against a module contract asserting they could not.
/// Returns `Ok(None)` when neither source yields text; the caller decides
/// whether that is fatal (single-op) or skippable (batch).
///
/// `prev` pairs the resolved `prev_edit` row with the `(device_id, seq)` of
/// the pointer that produced it — the pointer exists purely to give
/// [`text_of_prior_row`]'s corruption-path error message an identity to
/// point at. Pairing them in ONE `Option` (rather than two independently
/// optional parameters) makes "a resolved row with no known pointer"
/// unrepresentable: both call sites derive the row and the pointer from the
/// same `payload.prev_edit`, so they are always Some/None together — the
/// signature now says so instead of leaving a branch that merely assumed it.
pub(crate) fn resolve_prior_text(
    prev: Option<ResolvedPrevEdit<'_>>,
    timestamp_prior: Option<&(String, String)>,
) -> Result<Option<String>, AppError> {
    if let Some(((op_type, payload), (device, seq))) = prev {
        let origin = format!("named by prev_edit ({device}, {seq})");
        return Ok(Some(text_of_prior_row(op_type, payload, &origin)?));
    }
    timestamp_prior
        .map(|(op_type, payload)| text_of_prior_row(op_type, payload, "from the timestamp scan"))
        .transpose()
}

/// Extract the text an `edit_block`/`create_block` op contributed to its
/// block: `to_text` for an edit, `content` for a create.
///
/// Shared by both reverse kernels via [`resolve_prior_text`] so the two can
/// never disagree on how a prior row is decoded.
///
/// `origin` identifies where `(op_type, payload)` came from — e.g. "named by
/// prev_edit (<device>, <seq>)" or "from the timestamp scan" — and is folded
/// into the error message on the (fatal, op-log-corruption) unexpected-op-type
/// path so the bad row can actually be located.
pub(crate) fn text_of_prior_row(
    op_type: &str,
    payload: &str,
    origin: &str,
) -> Result<String, AppError> {
    match op_type {
        "edit_block" => {
            let p: EditBlockPayload = serde_json::from_str(payload)?;
            Ok(p.to_text)
        }
        "create_block" => {
            let p: CreateBlockPayload = serde_json::from_str(payload)?;
            Ok(p.content)
        }
        other => Err(AppError::InvalidOperation(format!(
            "prior-text row {origin} is a non-text op '{other}'; expected edit_block/create_block"
        ))),
    }
}

/// Reverse of a `move_block` op: re-home the block to its prior sibling slot.
///
/// #1526: unlike [`reverse_edit_block`], the reverse of a move CANNOT follow a
/// causal `prev_edit`-style pointer — [`MoveBlockPayload`] carries no
/// predecessor reference, so the only available reconstruction of the prior
/// placement is [`find_prior_position`]'s `(created_at, seq, device_id)`
/// timestamp scan. This is therefore INTENTIONALLY timestamp-ordered: undo of a
/// move is well-defined under single-device editing (where `seq` is a strictly
/// monotonic causal counter, so timestamp order agrees with causal order), and
/// the placement-recovery semantics for cross-device clock skew would require a
/// wire-format (op payload) extension — out of scope under AGENTS.md
/// "Architectural Stability". If a `prev_move` pointer is ever added to
/// `MoveBlockPayload`, mirror the `prev_edit` branch in `reverse_edit_block`
/// here.
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

// Reverse-of-restore is a bare `DeleteBlock(block_id)`. The
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

/// Timestamp-ordered fallback scan, returning the raw `(op_type, payload)`
/// row so both reverse kernels feed [`resolve_prior_text`] the same shape.
///
/// Delegates to the single scan primitive
/// ([`agaric_store::op_log::latest_block_edit_before`]), which owns the
/// `is_replicated = 0` policy (#2549) and the canonical
/// `(created_at, seq, device_id)` total order including the `device_id`
/// tie-break (#382).
pub async fn find_prior_text_row(
    pool: &SqlitePool,
    block_id: &str,
    created_at: i64,
    seq: i64,
    device_id: &str,
) -> Result<Option<(String, String)>, AppError> {
    let row = agaric_store::op_log::latest_block_edit_before(
        pool,
        block_id,
        agaric_store::op_log::BlockEditScan::StrictlyBefore {
            created_at,
            seq,
            device_id,
        },
    )
    .await?;
    Ok(row.map(|r| (r.op_type, r.payload)))
}

/// Text-extracting wrapper over [`find_prior_text_row`], kept for
/// `commands::history::compute_edit_diff_inner` and the #1526 sanity
/// assertions in the reverse tests.
pub async fn find_prior_text(
    pool: &SqlitePool,
    block_id: &str,
    created_at: i64,
    seq: i64,
    device_id: &str,
) -> Result<Option<String>, AppError> {
    find_prior_text_row(pool, block_id, created_at, seq, device_id)
        .await?
        .map(|(op_type, payload)| text_of_prior_row(&op_type, &payload, "from the timestamp scan"))
        .transpose()
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
                new_position: agaric_store::pagination::index_to_provisional_position(idx),
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
    // See `find_prior_text` — use the indexed `block_id` column and
    // normalize to uppercase per AGENTS.md invariant #8.
    let bid_upper = block_id.to_ascii_uppercase();
    // #382: tie-break on the canonical `(created_at, seq, device_id)`
    // total order — see the matching note in `find_prior_text`.
    // #2549: `AND is_replicated = 0` — see `find_prior_text`. Prior placement
    // must be reconstructed from locally-applied move/create ops only; a
    // never-applied audit row (#2495) would restore a slot this device never
    // laid out.
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE block_id = ?1 \
           AND op_type IN ('move_block', 'create_block') \
           AND is_replicated = 0 \
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
                // Ancient `create_block` payloads predate the position
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
    //! regression tests: ensure `find_prior_text` and
    //! `find_prior_position` use the indexed `op_log.block_id` column
    //! (migration 0030) and uppercase-normalize the bound parameter so
    //! lookups remain case-insensitive against AGENTS.md invariant #8.
    use super::*;
    use agaric_core::ulid::BlockId;
    use agaric_store::op::{CreateBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload};
    use agaric_store::op_log::append_local_op_at;
    use agaric_store::test_support::test_pool;

    const TEST_DEVICE: &str = "test-device";

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
