//! History command handlers.

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::now_rfc3339;
use crate::op::{OpPayload, OpRef, UndoResult};
use crate::op_log;
use crate::pagination;
use crate::pagination::HistoryEntry;
use crate::pagination::PageResponse;
use crate::ulid::BlockId;

use super::*;

/// Apply the materialized effect of a reverse [`OpPayload`] to the blocks/tags/properties
/// tables inside an existing transaction.
///
/// This mirrors the SQL patterns used in the original command handlers (e.g.,
/// reverse of `create_block` → same SQL as `delete_block`, reverse of
/// `edit_block` → same SQL as `edit_block`, etc.).
///
/// Only handles the subset of op types that can result from `compute_reverse`:
/// `DeleteBlock`, `RestoreBlock`, `EditBlock`, `MoveBlock`, `AddTag`,
/// `RemoveTag`, `SetProperty`, `DeleteProperty`, `DeleteAttachment`.
pub async fn apply_reverse_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    reverse_payload: &OpPayload,
) -> Result<(), AppError> {
    match reverse_payload {
        // Idempotency policy:
        //
        // Reverses are idempotent except for EditBlock and MoveBlock, which
        // represent user-visible live-block edits. A zero-rows result on those
        // two indicates the target block was soft-deleted (or otherwise vanished)
        // between the original op and the undo — silently succeeding would mask
        // a real bug, so we surface it as `NotFound`.
        //
        // Everything else is intentionally idempotent so a batch undo
        // (`revert_ops_inner`) never aborts mid-transaction because one row was
        // already restored / removed by an earlier replay or a manual edit:
        //   - cascade ops (DeleteBlock, RestoreBlock) - already idempotent; the
        //     UPDATE simply finds 0 rows when the target is in the desired state
        //   - tag ops (AddTag uses INSERT OR IGNORE, RemoveTag DELETEs)
        //   - property ops (SetProperty uses INSERT OR REPLACE, DeleteProperty
        //     DELETEs without a rows_affected check)
        //   - attachment ops (AddAttachment uses INSERT OR REPLACE, DeleteAttachment
        //     UPDATEs without a rows_affected check)
        OpPayload::DeleteBlock(p) => {
            // Cascade soft-delete (same as delete_block_inner).
            //
            // Recursive member filters `is_conflict = 0` so conflict
            // copies aren't swept into the reverse cascade (invariant #9).
            // `depth < 100` bounds the walk.
            let now = now_rfc3339();
            sqlx::query(
                "WITH RECURSIVE descendants(id, depth) AS ( \
                     SELECT id, 0 FROM blocks WHERE id = ? \
                     UNION ALL \
                     SELECT b.id, d.depth + 1 FROM blocks b \
                     INNER JOIN descendants d ON b.parent_id = d.id \
                     WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
                 ) \
                 UPDATE blocks SET deleted_at = ? \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
            )
            .bind(p.block_id.as_str())
            .bind(&now)
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::RestoreBlock(p) => {
            // Cascade restore (same as restore_block_inner).
            //
            // Recursive member filters `is_conflict = 0` — conflict copies
            // have independent lifecycles (invariant #9). `depth < 100`
            // bounds the walk.
            sqlx::query(
                "WITH RECURSIVE descendants(id, depth) AS ( \
                     SELECT id, 0 FROM blocks WHERE id = ? \
                     UNION ALL \
                     SELECT b.id, d.depth + 1 FROM blocks b \
                     INNER JOIN descendants d ON b.parent_id = d.id \
                     WHERE b.is_conflict = 0 AND d.depth < 100 \
                 ) \
                 UPDATE blocks SET deleted_at = NULL \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
            )
            .bind(p.block_id.as_str())
            .bind(&p.deleted_at_ref)
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::EditBlock(p) => {
            let result =
                sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
                    .bind(&p.to_text)
                    .bind(p.block_id.as_str())
                    .execute(&mut **tx)
                    .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "block '{}' not found or soft-deleted during undo",
                    p.block_id
                )));
            }
        }
        OpPayload::MoveBlock(p) => {
            let result = sqlx::query(
                "UPDATE blocks SET parent_id = ?, position = ? \
                 WHERE id = ? AND deleted_at IS NULL",
            )
            .bind(p.new_parent_id.as_ref().map(BlockId::as_str))
            .bind(p.new_position)
            .bind(p.block_id.as_str())
            .execute(&mut **tx)
            .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "block '{}' not found or soft-deleted during undo",
                    p.block_id
                )));
            }
        }
        // AddTag and RemoveTag are intentionally idempotent: INSERT OR IGNORE
        // silently handles duplicates, and the DELETE below does not check
        // rows_affected.  During sync replays the same undo/redo sequence can
        // be applied more than once, so both directions must be lenient.
        OpPayload::AddTag(p) => {
            sqlx::query("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(&mut **tx)
                .await?;
        }
        OpPayload::RemoveTag(p) => {
            sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(p.block_id.as_str())
                .bind(p.tag_id.as_str())
                .execute(&mut **tx)
                .await?;
        }
        OpPayload::SetProperty(p) => {
            sqlx::query(
                "INSERT OR REPLACE INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(p.block_id.as_str())
            .bind(&p.key)
            .bind(&p.value_text)
            .bind(p.value_num)
            .bind(&p.value_date)
            .bind(&p.value_ref)
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::DeleteProperty(p) => {
            sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                .bind(p.block_id.as_str())
                .bind(&p.key)
                .execute(&mut **tx)
                .await?;
        }
        OpPayload::DeleteAttachment(p) => {
            sqlx::query("UPDATE attachments SET deleted_at = ? WHERE id = ?")
                .bind(now_rfc3339())
                .bind(p.attachment_id.as_str())
                .execute(&mut **tx)
                .await?;
        }
        OpPayload::AddAttachment(p) => {
            // Preserve original created_at from the existing (soft-deleted) attachment record
            let original_created_at: Option<String> =
                sqlx::query_scalar("SELECT created_at FROM attachments WHERE id = ?")
                    .bind(p.attachment_id.as_str())
                    .fetch_optional(&mut **tx)
                    .await?;

            let created_at = original_created_at.unwrap_or_else(now_rfc3339);

            sqlx::query(
                "INSERT OR REPLACE INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
            )
            .bind(p.attachment_id.as_str())
            .bind(p.block_id.as_str())
            .bind(&p.mime_type)
            .bind(&p.filename)
            .bind(p.size_bytes)
            .bind(&p.fs_path)
            .bind(&created_at)
            .execute(&mut **tx)
            .await?;
        }
        // Note: CreateBlock never appears here because reverse::compute_reverse
        // maps CreateBlock → DeleteBlock, and RestoreBlock → DeleteBlock.
        // Both are handled by the DeleteBlock arm above.
        other => {
            return Err(AppError::InvalidOperation(format!(
                "cannot apply reverse payload of type '{}' — unexpected variant",
                other.op_type_str()
            )));
        }
    }
    Ok(())
}

/// List all ops for blocks descended from a page, with cursor pagination
/// and optional op_type filter.
///
/// FEAT-3 Phase 8 — `space_id` narrows the global (`page_id == "__all__"`)
/// query to ops whose `payload.block_id` belongs to the requested space.
/// It is ignored in per-page mode (a real ULID `page_id` is already
/// space-bound).
pub async fn list_page_history_inner(
    pool: &SqlitePool,
    page_id: String,
    op_type_filter: Option<String>,
    space_id: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_page_history(
        pool,
        &page_id,
        op_type_filter.as_deref(),
        space_id.as_deref(),
        &page,
    )
    .await
}

/// Batch revert: compute and apply reverse ops for a list of op refs.
///
/// All ops are processed in a single transaction for atomicity. Ops are
/// sorted newest-first (by `created_at DESC, seq DESC`) and reversed in
/// that order. Non-reversible ops cause early abort (before any are applied).
pub async fn revert_ops_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    ops: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    use crate::reverse;

    if ops.is_empty() {
        return Ok(vec![]);
    }

    // Phase 1: Validate all ops are reversible by computing their reverse payloads.
    // This uses read-only access — no mutations yet.
    let mut reverses = Vec::with_capacity(ops.len());
    for op_ref in &ops {
        let reverse_payload = reverse::compute_reverse(pool, &op_ref.device_id, op_ref.seq).await?;
        // Fetch created_at for sorting AND op_type for the UndoResult response
        // I-Core-8: wrap to typed read-pool — caller is in write context
        let record =
            op_log::get_op_by_seq(&ReadPool(pool.clone()), &op_ref.device_id, op_ref.seq).await?;
        reverses.push((
            op_ref.clone(),
            reverse_payload,
            record.created_at,
            record.op_type,
        ));
    }

    // Sort newest-first (by created_at DESC, seq DESC, device_id DESC)
    reverses.sort_by(|a, b| {
        b.2.cmp(&a.2) // created_at DESC
            .then_with(|| b.0.seq.cmp(&a.0.seq)) // seq DESC
            .then_with(|| b.0.device_id.cmp(&a.0.device_id)) // device_id DESC
    });

    // Phase 2: Apply all reverses in a single IMMEDIATE transaction.
    //
    // MAINT-112: `CommandTx` couples the BEGIN IMMEDIATE + commit +
    // post-commit `dispatch_background_or_warn` steps so a failed commit
    // cannot leak queued records to the materializer, and a missing
    // dispatch is structurally impossible (commit_and_dispatch drains
    // the pending queue in order).
    let mut tx = CommandTx::begin_immediate(pool, "revert_ops").await?;
    let mut results = Vec::with_capacity(reverses.len());

    for (op_ref, reverse_payload, _created_at, reversed_op_type) in reverses {
        let new_op_type = reverse_payload.op_type_str().to_owned();

        // Append reverse op to log first, then apply — same order as
        // undo_page_op_inner / redo_page_op_inner.  The clone is needed
        // because append_local_op_in_tx consumes the payload.
        let op_record = op_log::append_local_op_in_tx(
            &mut tx,
            device_id,
            reverse_payload.clone(),
            now_rfc3339(),
        )
        .await?;

        apply_reverse_in_tx(&mut tx, &reverse_payload).await?;

        results.push(UndoResult {
            reversed_op: op_ref,
            reversed_op_type,
            new_op_ref: OpRef {
                device_id: op_record.device_id.clone(),
                seq: op_record.seq,
            },
            new_op_type,
            is_redo: false,
        });

        tx.enqueue_background(op_record);
    }

    // Commits, then fires queued dispatches in enqueue order. If commit
    // fails, no dispatches fire.
    tx.commit_and_dispatch(materializer).await?;

    Ok(results)
}

/// Restore a page to its state at a specific operation (point-in-time restore).
///
/// Finds all ops that occurred AFTER the target op on blocks belonging to the
/// given page (or all blocks if `page_id == "__all__"`), filters out non-reversible
/// ops, and calls `revert_ops_inner()` with the remainder.
///
/// # Snapshot semantics (L-31)
///
/// The list of ops to revert is computed against the bare pool **before**
/// `revert_ops_inner` opens its `BEGIN IMMEDIATE` transaction. New ops
/// landing between the read here and the write inside `revert_ops_inner`
/// (for example, a sync replay or a concurrent local edit) are **not**
/// included in the revert: they keep their forward-direction effects.
///
/// In a single-user threat model the practical window between the two
/// steps is bounded by one DB round-trip — concurrent ops in that window
/// are vanishingly rare and survive the restore intentionally rather than
/// being silently rolled back. Lifting the read into the same write
/// transaction would close the window but is not motivated today; this
/// doc-block names the snapshot-at-read-time behaviour explicitly so a
/// future contributor reasoning about "what gets restored" does not
/// have to re-derive it from the call graph.
pub async fn restore_page_to_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: String,
    target_device_id: String,
    target_seq: i64,
) -> Result<RestoreToOpResult, AppError> {
    // Fetch the target op's created_at timestamp
    // I-Core-8: wrap to typed read-pool — caller is in write context
    let target_record =
        op_log::get_op_by_seq(&ReadPool(pool.clone()), &target_device_id, target_seq).await?;
    let target_ts = &target_record.created_at;

    // Query all ops after the target.
    // NOTE: We intentionally do NOT filter by deleted_at IS NULL in the blocks subquery.
    // We need to find ops on blocks that may have been deleted after the target point,
    // since restoring to that point means un-deleting those blocks.
    let ops_after: Vec<(String, i64, String)> = if page_id == "__all__" {
        sqlx::query_as::<_, (String, i64, String)>(
            "SELECT device_id, seq, op_type FROM op_log \
             WHERE (created_at > ?1 OR (created_at = ?1 AND (seq > ?2 OR (seq = ?2 AND device_id > ?3)))) \
             ORDER BY created_at DESC, seq DESC, device_id DESC",
        )
        .bind(target_ts)
        .bind(target_seq)
        .bind(&target_device_id)
        .fetch_all(pool)
        .await?
    } else {
        // Recursive CTE must filter `is_conflict = 0` in the recursive member —
        // conflict copies inherit `parent_id` from the original block and would
        // otherwise leak into page-scoped results. `depth < 100` bounds the walk
        // against runaway recursion on corrupted data (invariant #9).
        sqlx::query_as::<_, (String, i64, String)>(
            "WITH RECURSIVE page_blocks(id, depth) AS ( \
               SELECT id, 0 FROM blocks WHERE id = ?1 AND is_conflict = 0 \
               UNION ALL \
               SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
               WHERE b.is_conflict = 0 AND pb.depth < 100 \
             ) \
             SELECT o.device_id, o.seq, o.op_type FROM op_log o \
             WHERE ( \
               json_extract(o.payload, '$.block_id') IN (SELECT id FROM page_blocks) \
               OR (o.op_type = 'delete_attachment' AND EXISTS ( \
                   SELECT 1 FROM attachments a \
                   WHERE a.id = json_extract(o.payload, '$.attachment_id') \
                   AND a.block_id IN (SELECT id FROM page_blocks) \
               )) \
             ) \
             AND (o.created_at > ?2 OR (o.created_at = ?2 AND (o.seq > ?3 OR (o.seq = ?3 AND o.device_id > ?4)))) \
             ORDER BY o.created_at DESC, o.seq DESC, o.device_id DESC",
        )
        .bind(&page_id)
        .bind(target_ts)
        .bind(target_seq)
        .bind(&target_device_id)
        .fetch_all(pool)
        .await?
    };

    // Separate reversible from non-reversible ops
    let non_reversible = ["purge_block", "delete_attachment"];
    let mut reversible_ops = Vec::new();
    let mut non_reversible_count: u64 = 0;

    for (dev_id, seq, op_type) in &ops_after {
        if non_reversible.contains(&op_type.as_str()) {
            non_reversible_count += 1;
        } else {
            reversible_ops.push(OpRef {
                device_id: dev_id.clone(),
                seq: *seq,
            });
        }
    }

    // Revert the reversible ops using existing infrastructure
    let results = if reversible_ops.is_empty() {
        vec![]
    } else {
        revert_ops_inner(pool, device_id, materializer, reversible_ops).await?
    };

    Ok(RestoreToOpResult {
        ops_reverted: results.len() as u64,
        non_reversible_skipped: non_reversible_count,
        results,
    })
}

/// Undo the Nth most recent undoable op on a page.
///
/// `undo_depth` is 0-based: 0 = most recent op, 1 = second most recent, etc.
/// Queries the page's op history (using recursive CTE), applies OFFSET to
/// skip `undo_depth` ops, then computes and applies the reverse.
pub async fn undo_page_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: String,
    undo_depth: i64,
) -> Result<UndoResult, AppError> {
    if undo_depth < 0 {
        return Err(AppError::Validation(
            "undo_depth must be non-negative".into(),
        ));
    }
    if undo_depth > 1000 {
        return Err(AppError::Validation(
            "undo_depth exceeds maximum of 1000".into(),
        ));
    }

    use crate::reverse;

    // Find the op to undo: page ops ordered newest first, offset by undo_depth.
    // Uses the write pool for consistency — these reads feed into the write
    // transaction below.
    //
    // Recursive CTE must filter `is_conflict = 0` in the recursive member —
    // conflict copies inherit `parent_id` from the original block and would
    // otherwise leak into page-scoped results. `depth < 100` bounds the walk
    // against runaway recursion on corrupted data (invariant #9).
    //
    // `LIMIT 1 OFFSET ?2` is a deliberate carve-out of invariant #3 ("no
    // offset pagination"): we are not paginating a list, we are fetching the
    // single Nth-most-recent op in the page's history. `undo_depth` is
    // validated to `[0, 1000]` upstream (see the bounds check at the top of
    // this function), so the OFFSET is bounded by a small constant; combined
    // with the indexed `(created_at DESC, seq DESC)` order, scan cost is
    // fixed. Invariant #3 protects unbounded list-query latency, which does
    // not apply to this "fetch Nth row" semantics.
    // REVIEW-LATER: I-CommandsCRUD-1 — the AGENTS.md "Backend Patterns"
    // carve-out for this pattern is deferred (locked AGENTS.md self-rule).
    let target = sqlx::query_as!(
        HistoryEntry,
        "WITH RECURSIVE page_blocks(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ?1 AND is_conflict = 0 \
             UNION ALL \
             SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
             WHERE b.is_conflict = 0 AND pb.depth < 100 \
         ) \
         SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at \
         FROM op_log ol \
         WHERE ( \
             json_extract(ol.payload, '$.block_id') IN (SELECT id FROM page_blocks) \
             OR ( \
                 ol.op_type = 'delete_attachment' \
                 AND EXISTS ( \
                     SELECT 1 FROM attachments a \
                     WHERE a.id = json_extract(ol.payload, '$.attachment_id') \
                     AND a.block_id IN (SELECT id FROM page_blocks) \
                 ) \
             ) \
         ) \
         ORDER BY ol.created_at DESC, ol.seq DESC \
         LIMIT 1 OFFSET ?2",
        page_id,    // ?1
        undo_depth, // ?2
    )
    .fetch_optional(pool)
    .await?;

    let target = target.ok_or_else(|| {
        AppError::NotFound(format!(
            "no op found at undo_depth {undo_depth} for page '{page_id}'"
        ))
    })?;

    // Compute reverse
    let reverse_payload = reverse::compute_reverse(pool, &target.device_id, target.seq).await?;
    let new_op_type = reverse_payload.op_type_str().to_owned();

    // Apply in single IMMEDIATE transaction.
    //
    // MAINT-112: see `revert_ops_inner` for the rationale — CommandTx
    // makes the commit + dispatch pair atomic and impossible to
    // desequence.
    let mut tx = CommandTx::begin_immediate(pool, "undo_page_op").await?;

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, reverse_payload.clone(), now_rfc3339())
            .await?;

    apply_reverse_in_tx(&mut tx, &reverse_payload).await?;

    // Retain the identity fields the UndoResult needs after the tx
    // consumes its owned clone.
    let new_op_device_id = op_record.device_id.clone();
    let new_op_seq = op_record.seq;
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    Ok(UndoResult {
        reversed_op: OpRef {
            device_id: target.device_id,
            seq: target.seq,
        },
        reversed_op_type: target.op_type,
        new_op_ref: OpRef {
            device_id: new_op_device_id,
            seq: new_op_seq,
        },
        new_op_type,
        is_redo: false,
    })
}

/// Redo by reversing an undo op.
///
/// The `(undo_device_id, undo_seq)` identifies the UNDO op that was
/// previously appended. Reversing the undo effectively re-applies the
/// original operation.
pub async fn redo_page_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    undo_device_id: String,
    undo_seq: i64,
) -> Result<UndoResult, AppError> {
    use crate::reverse;

    // Fetch the undo op's op_type (the one we're reversing).
    // Surfaces to the frontend as `reversed_op_type` for descriptive toasts.
    // I-Core-8: wrap to typed read-pool — caller is in write context
    let undo_record =
        op_log::get_op_by_seq(&ReadPool(pool.clone()), &undo_device_id, undo_seq).await?;

    // Compute reverse of the undo op
    let reverse_payload = reverse::compute_reverse(pool, &undo_device_id, undo_seq).await?;
    let new_op_type = reverse_payload.op_type_str().to_owned();

    // Apply in single IMMEDIATE transaction.
    //
    // MAINT-112: see `revert_ops_inner` for the rationale — CommandTx
    // makes the commit + dispatch pair atomic and impossible to
    // desequence.
    let mut tx = CommandTx::begin_immediate(pool, "redo_page_op").await?;

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, reverse_payload.clone(), now_rfc3339())
            .await?;

    apply_reverse_in_tx(&mut tx, &reverse_payload).await?;

    // Retain the identity fields the UndoResult needs after the tx
    // consumes its owned clone.
    let new_op_device_id = op_record.device_id.clone();
    let new_op_seq = op_record.seq;
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    Ok(UndoResult {
        reversed_op: OpRef {
            device_id: undo_device_id,
            seq: undo_seq,
        },
        reversed_op_type: undo_record.op_type,
        new_op_ref: OpRef {
            device_id: new_op_device_id,
            seq: new_op_seq,
        },
        new_op_type,
        is_redo: true,
    })
}

/// Tauri command: list page history. Delegates to [`list_page_history_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_page_history(
    pool: State<'_, ReadPool>,
    page_id: String,
    op_type_filter: Option<String>,
    space_id: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    list_page_history_inner(&pool.0, page_id, op_type_filter, space_id, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch revert ops. Delegates to [`revert_ops_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn revert_ops(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    ops: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    revert_ops_inner(&pool.0, device_id.as_str(), &materializer, ops)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: point-in-time restore. Delegates to [`restore_page_to_op_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn restore_page_to_op(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    page_id: String,
    target_device_id: String,
    target_seq: i64,
) -> Result<RestoreToOpResult, AppError> {
    restore_page_to_op_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        page_id,
        target_device_id,
        target_seq,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: undo page op. Delegates to [`undo_page_op_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn undo_page_op(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    page_id: String,
    undo_depth: i64,
) -> Result<UndoResult, AppError> {
    undo_page_op_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        page_id,
        undo_depth,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: redo page op. Delegates to [`redo_page_op_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn redo_page_op(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    undo_device_id: String,
    undo_seq: i64,
) -> Result<UndoResult, AppError> {
    redo_page_op_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        undo_device_id,
        undo_seq,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Compute a word-level diff for an `edit_block` op by looking up the prior
/// text in the op log and comparing with the op's `to_text`.
///
/// Returns `Ok(None)` if the op is not `edit_block` or if no prior text exists
/// (i.e. the block was just created and this is the first edit).
#[instrument(skip(pool), err)]
pub async fn compute_edit_diff_inner(
    pool: &SqlitePool,
    device_id: String,
    seq: i64,
) -> Result<Option<Vec<crate::word_diff::DiffSpan>>, AppError> {
    let row = sqlx::query!(
        "SELECT op_type, payload, created_at FROM op_log \
         WHERE device_id = ?1 AND seq = ?2",
        device_id,
        seq,
    )
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Err(AppError::NotFound(format!("op ({device_id}, {seq})")));
    };

    if row.op_type != "edit_block" {
        return Ok(None);
    }

    // Surface a precise, user-actionable error if the on-disk payload cannot
    // be parsed: include `device_id`, `seq`, and the underlying serde
    // diagnostic so a corruption-recovery path tells the operator exactly
    // which row failed.  Using `AppError::InvalidOperation` instead of the
    // `?`-propagated `AppError::Json` matters because
    // [`sanitize_internal_error`] (commands/mod.rs) collapses `Json` to a
    // generic "an internal error occurred" string before it reaches the
    // frontend, dropping the row identifiers.  `InvalidOperation` is in the
    // pass-through set, so this message survives sanitisation intact.
    let payload: crate::op::EditBlockPayload = serde_json::from_str(&row.payload).map_err(|e| {
        AppError::InvalidOperation(format!(
            "op ({device_id}, {seq}) payload not parseable as EditBlockPayload: {e}"
        ))
    })?;
    let prior =
        crate::reverse::find_prior_text(pool, payload.block_id.as_str(), &row.created_at, seq)
            .await?;

    let old_text = prior.unwrap_or_default();
    Ok(Some(crate::word_diff::compute_word_diff(
        &old_text,
        &payload.to_text,
    )))
}

/// Tauri command: compute word-level diff for an edit_block history entry.
/// Delegates to [`compute_edit_diff_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn compute_edit_diff(
    pool: State<'_, ReadPool>,
    device_id: String,
    seq: i64,
) -> Result<Option<Vec<crate::word_diff::DiffSpan>>, AppError> {
    compute_edit_diff_inner(&pool.0, device_id, seq)
        .await
        .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    //! Inline unit tests for [`compute_edit_diff_inner`] focused on the L-39
    //! error-path fix: parse failures of `EditBlockPayload` must surface a
    //! row-identifying [`AppError::InvalidOperation`] (which passes through
    //! [`super::sanitize_internal_error`] unchanged) rather than a generic
    //! [`AppError::Json`] (which gets collapsed to "an internal error
    //! occurred").  Happy-path and dispatch-rule cases live alongside.
    use super::*;
    use crate::commands::{create_block_inner, edit_block_inner};
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use crate::op::{CreateBlockPayload, OpPayload};
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEV: &str = "L39-test-device";
    const FIXED_TS: &str = "2025-01-01T00:00:00Z";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a raw `op_log` row, including the `block_id` index column
    /// (migration 0030), without going through `append_local_op_at` —
    /// needed only by the corrupt-payload regression test, where the
    /// payload is intentionally malformed and would not survive the
    /// canonicalising serializer used by the real append path.
    async fn insert_raw_op(
        pool: &SqlitePool,
        device_id: &str,
        seq: i64,
        op_type: &str,
        payload: &str,
        block_id: Option<&str>,
        created_at: &str,
    ) {
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(seq)
        .bind("test-hash-placeholder")
        .bind(op_type)
        .bind(payload)
        .bind(created_at)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Empty pool + missing `(device_id, seq)` → [`AppError::NotFound`]
    /// whose message embeds both identifiers so callers (and toast UI)
    /// can name the missing row.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compute_edit_diff_inner_returns_not_found_for_missing_op() {
        let (pool, _dir) = test_pool().await;

        let result = compute_edit_diff_inner(&pool, "DEVICE".into(), 99).await;

        let err = result.expect_err("missing op must return an error");
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected AppError::NotFound, got: {err:?}"
        );
        let msg = err.to_string();
        assert!(
            msg.contains("DEVICE") && msg.contains("99"),
            "NotFound message must name (device_id, seq); got: {msg}"
        );
    }

    /// Non-`edit_block` ops (e.g. `create_block`) are not diffable —
    /// `compute_edit_diff_inner` returns `Ok(None)` so the frontend can
    /// fall back to "no diff available".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compute_edit_diff_inner_returns_none_for_non_edit_op() {
        let (pool, _dir) = test_pool().await;

        // Append a real `create_block` op so the (device_id, seq) lookup
        // succeeds and we exercise the `op_type != "edit_block"` branch.
        let bid = BlockId::test_id("BLK1");
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: bid,
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "hello".into(),
        });
        let record = append_local_op_at(&pool, DEV, payload, FIXED_TS.into())
            .await
            .unwrap();

        let result = compute_edit_diff_inner(&pool, record.device_id, record.seq).await;

        assert!(
            matches!(result, Ok(None)),
            "non-edit op must yield Ok(None); got: {result:?}"
        );
    }

    /// L-39 regression: a corrupted `edit_block` payload must surface as
    /// [`AppError::InvalidOperation`] with `(device_id, seq)` and the
    /// `EditBlockPayload` parser context embedded.  Crucially this is a
    /// pass-through variant in [`super::sanitize_internal_error`] — the
    /// previous `?`-propagated `AppError::Json` was collapsed to "an
    /// internal error occurred", erasing the row identity needed for
    /// recovery diagnostics.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compute_edit_diff_inner_returns_invalid_operation_for_corrupt_payload() {
        let (pool, _dir) = test_pool().await;

        // Malformed: missing the required `block_id` and `to_text` fields.
        // Direct SQL insert bypasses the canonical serializer (which would
        // refuse to emit this).
        insert_raw_op(
            &pool,
            DEV,
            42,
            "edit_block",
            r#"{"missing fields":true}"#,
            None,
            FIXED_TS,
        )
        .await;

        let result = compute_edit_diff_inner(&pool, DEV.into(), 42).await;

        let err = result.expect_err("corrupt payload must return an error");
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "expected AppError::InvalidOperation (pass-through in sanitize_internal_error), \
             got: {err:?}"
        );
        let msg = err.to_string();
        assert!(
            msg.contains(DEV),
            "error message must name device_id; got: {msg}"
        );
        assert!(
            msg.contains("42"),
            "error message must name seq; got: {msg}"
        );
        assert!(
            msg.contains("EditBlockPayload"),
            "error message must name the parser target; got: {msg}"
        );

        // Defence-in-depth: confirm the variant is not in the sanitiser's
        // collapse-set.  If a future refactor adds InvalidOperation to the
        // set, this assertion forces an explicit decision before silently
        // regressing the L-39 fix.
        let sanitised = super::sanitize_internal_error(err);
        assert!(
            matches!(sanitised, AppError::InvalidOperation(ref m) if m.contains("EditBlockPayload")),
            "InvalidOperation must pass through sanitize_internal_error unchanged; \
             got: {sanitised:?}"
        );
    }

    /// Happy path: a real create + edit chain produces a `Some(diff)` with
    /// at least one [`crate::word_diff::DiffSpan`], confirming
    /// `find_prior_text` was consulted and `compute_word_diff` was driven.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compute_edit_diff_inner_returns_diff_for_valid_edit() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello world".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "hello rust".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let op_row = sqlx::query!(
            "SELECT device_id, seq FROM op_log \
             WHERE op_type = 'edit_block' ORDER BY seq DESC LIMIT 1"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let diff = compute_edit_diff_inner(&pool, op_row.device_id, op_row.seq)
            .await
            .expect("happy-path diff must be Ok")
            .expect("edit_block op must produce Some(diff)");

        assert!(
            !diff.is_empty(),
            "diff must contain at least one DiffSpan; got an empty Vec"
        );
    }
}
