//! History command handlers.

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op::{OpPayload, OpRef, UndoResult};
use crate::op_log;
use crate::pagination;
use crate::pagination::HistoryEntry;
use crate::pagination::PageResponse;
use crate::space::SpaceScope;
use crate::ulid::BlockId;

use super::*;

/// C5 (#344): upper bound on the number of ops a single batch revert may
/// process. Matches the interactive `undo_depth` ceiling enforced in
/// [`undo_page_op_inner`] (`undo_depth > 1000` → `Validation`) and the
/// `count <= 1000` redo-walk bound in [`redo_page_op_inner`]. A
/// point-in-time restore (`restore_page_to_op_inner`) previously
/// collected *every* reversible op past the restore point with no
/// ceiling, so a long-lived page could hand `revert_ops_inner` a Vec
/// large enough to overflow even the chunked batch helpers' work and,
/// before chunking, SQLite's bind-parameter limit. Capping the op count
/// here returns a clean error instead.
const MAX_REVERT_OPS: usize = 1000;

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
        //   - property ops (#604: routed through the forward projections —
        //     column UPDATEs / INSERT OR REPLACE / DELETE, none of which
        //     check rows_affected)
        //   - attachment ops (AddAttachment uses INSERT OR REPLACE to recreate the
        //     row; DeleteAttachment hard-DELETEs without a rows_affected check)
        OpPayload::DeleteBlock(p) => {
            // Cascade soft-delete (same as delete_block_inner).
            //
            // `descendants_cte_active!()` filters `deleted_at IS NULL`
            // so already-deleted descendants aren't re-swept; `depth
            // < 100` bounds the walk. Shared CTE lives in
            // `crate::block_descendants`.
            //
            // MAINT-214 (b): page_id is invariant under re-delete; the
            // descendants keep their existing `page_id` and on next
            // restore the M6/restore-path (`restore_block_inner` or
            // `OpPayload::RestoreBlock` below) picks them up. No
            // page_id work is needed here.
            let now = crate::db::now_ms();
            sqlx::query(concat!(
                crate::descendants_cte_active!(),
                "UPDATE blocks SET deleted_at = ? \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
            ))
            .bind(p.block_id.as_str())
            .bind(now)
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::RestoreBlock(p) => {
            // Cascade restore (same as restore_block_inner).
            //
            // `descendants_cte_standard!()` with `depth < 100` bounds
            // the walk. Shared CTE lives in
            // `crate::block_descendants`.
            sqlx::query(concat!(
                crate::descendants_cte_standard!(),
                "UPDATE blocks SET deleted_at = NULL \
                 WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
            ))
            .bind(p.block_id.as_str())
            .bind(p.deleted_at_ref)
            .execute(&mut **tx)
            .await?;

            // MAINT-214 (b): refresh `page_id` for the restored subtree
            // synchronously, mirroring `restore_block_inner`
            // (`commands/blocks/crud.rs:1028-1099`) and ultimately
            // `move_block_inner` (`commands/blocks/move_ops.rs:174-231`).
            // Without this sync update, callers reading right after
            // commit can see a stale `page_id` (the moved-then-deleted
            // descendant case described in `restore_block_inner`).
            //
            // Invariant #9: the recursive CTE filters `deleted_at IS
            // NULL` in both members AND bounds `depth < 100`.
            let block_id_str = p.block_id.as_str();
            let parent_id: Option<String> =
                sqlx::query_scalar!("SELECT parent_id FROM blocks WHERE id = ?", block_id_str,)
                    .fetch_one(&mut **tx)
                    .await?;
            let new_page_id: Option<String> = if let Some(ref pid) = parent_id {
                sqlx::query_scalar!(
                    "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END \
                     FROM blocks WHERE id = ?",
                    pid,
                )
                .fetch_optional(&mut **tx)
                .await?
                .flatten()
            } else {
                None
            };
            let is_page: bool =
                sqlx::query_scalar!("SELECT block_type FROM blocks WHERE id = ?", block_id_str)
                    .fetch_one(&mut **tx)
                    .await?
                    == "page";
            if !is_page {
                sqlx::query!(
                    "UPDATE blocks SET page_id = ? WHERE id = ?",
                    new_page_id,
                    block_id_str,
                )
                .execute(&mut **tx)
                .await?;
            }
            let effective_page_id = if is_page {
                Some(block_id_str.to_string())
            } else {
                new_page_id
            };
            sqlx::query!(
                "WITH RECURSIVE descendants(id, depth) AS ( \
                     SELECT b.id, 0 FROM blocks b \
                     WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
                     UNION ALL \
                     SELECT b.id, d.depth + 1 FROM blocks b \
                     JOIN descendants d ON b.parent_id = d.id \
                     WHERE b.deleted_at IS NULL AND d.depth < 100 \
                 ) \
                 UPDATE blocks SET page_id = ?2 \
                 WHERE id IN (SELECT id FROM descendants) AND block_type != 'page'",
                block_id_str,
                effective_page_id,
            )
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::EditBlock(p) => {
            let block_id_str = p.block_id.as_str();
            let result = sqlx::query!(
                "UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL",
                p.to_text,
                block_id_str,
            )
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
            let new_parent_id_str = p.new_parent_id.as_ref().map(BlockId::as_str);
            let move_block_id_str = p.block_id.as_str();
            let result = sqlx::query!(
                "UPDATE blocks SET parent_id = ?, position = ? \
                 WHERE id = ? AND deleted_at IS NULL",
                new_parent_id_str,
                p.new_position,
                move_block_id_str,
            )
            .execute(&mut **tx)
            .await?;
            if result.rows_affected() == 0 {
                return Err(AppError::NotFound(format!(
                    "block '{}' not found or soft-deleted during undo",
                    p.block_id
                )));
            }

            // MAINT-214 (b): refresh `page_id` for the moved block and
            // its descendants synchronously, mirroring `move_block_inner`
            // (`commands/blocks/move_ops.rs:174-231`). Without this
            // sync update, callers reading right after commit see a
            // stale `page_id` for the moved subtree until the async
            // `RebuildPageIds` materializer task lands.
            //
            // Invariant #9: the recursive CTE filters `deleted_at IS
            // NULL` in both members AND bounds `depth < 100`. Conflict
            // copies inherit `parent_id` from the original and would
            // otherwise be reparented under the moved subtree.
            let block_id_str = p.block_id.as_str();
            let new_page_id: Option<String> = if let Some(ref pid) = p.new_parent_id {
                let pid_str = pid.as_str();
                sqlx::query_scalar!(
                    "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END \
                     FROM blocks WHERE id = ?",
                    pid_str,
                )
                .fetch_optional(&mut **tx)
                .await?
                .flatten()
            } else {
                None
            };
            let is_page: bool =
                sqlx::query_scalar!("SELECT block_type FROM blocks WHERE id = ?", block_id_str)
                    .fetch_one(&mut **tx)
                    .await?
                    == "page";
            if !is_page {
                sqlx::query!(
                    "UPDATE blocks SET page_id = ? WHERE id = ?",
                    new_page_id,
                    block_id_str,
                )
                .execute(&mut **tx)
                .await?;
            }
            let effective_page_id = if is_page {
                Some(block_id_str.to_string())
            } else {
                new_page_id
            };
            sqlx::query!(
                "WITH RECURSIVE descendants(id, depth) AS ( \
                     SELECT b.id, 0 FROM blocks b \
                     WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
                     UNION ALL \
                     SELECT b.id, d.depth + 1 FROM blocks b \
                     JOIN descendants d ON b.parent_id = d.id \
                     WHERE b.deleted_at IS NULL AND d.depth < 100 \
                 ) \
                 UPDATE blocks SET page_id = ?2 \
                 WHERE id IN (SELECT id FROM descendants) AND block_type != 'page'",
                block_id_str,
                effective_page_id,
            )
            .execute(&mut **tx)
            .await?;
        }
        // AddTag and RemoveTag are intentionally idempotent: INSERT OR IGNORE
        // silently handles duplicates, and the DELETE below does not check
        // rows_affected.  During sync replays the same undo/redo sequence can
        // be applied more than once, so both directions must be lenient.
        OpPayload::AddTag(p) => {
            let block_id_str = p.block_id.as_str();
            let tag_id_str = p.tag_id.as_str();
            sqlx::query!(
                "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)",
                block_id_str,
                tag_id_str,
            )
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::RemoveTag(p) => {
            let block_id_str = p.block_id.as_str();
            let tag_id_str = p.tag_id.as_str();
            sqlx::query!(
                "DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?",
                block_id_str,
                tag_id_str,
            )
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::SetProperty(p) => {
            // #604: route through the same projection as the forward paths.
            // Column-backed keys (`todo_state` / `priority` / `due_date` /
            // `scheduled_date` → same-named `blocks` columns; `space` →
            // `blocks.space_id` with owning-page-group fan-out) must UPDATE
            // the column, never INSERT a `block_properties` row — the
            // migration-0088 `key_not_reserved` CHECK aborts such inserts.
            // `project_set_property_to_sql` is the canonical SQL mirror of
            // `set_property_in_tx`'s routing (incl. the per-key value_text /
            // value_date / value_ref extraction) and stays idempotent on
            // every branch (UPDATE / INSERT OR REPLACE), preserving the
            // batch-undo idempotency policy documented above.
            crate::loro::projection::project_set_property_to_sql(tx, p).await?;
        }
        OpPayload::DeleteProperty(p) => {
            // #604: same routing note as SetProperty above — reserved keys
            // NULL their `blocks` column, `space` NULLs `space_id` for the
            // owning-page group, generic keys DELETE the `block_properties`
            // row. All branches are idempotent (0-row UPDATE/DELETE no-ops).
            crate::loro::projection::project_delete_property_to_sql(
                tx,
                p.block_id.as_str(),
                &p.key,
            )
            .await?;
        }
        OpPayload::DeleteAttachment(p) => {
            // C7 (#345): hard-DELETE the row to match the runtime /
            // materializer model. The forward `delete_attachment` path
            // (`materializer::handlers::apply_delete_attachment_tx`) hard-
            // deletes the row, and the runtime command
            // (`commands::attachments::delete_attachment_inner`) unlinks the
            // file post-commit. Undo is the *only* producer of soft-deleted
            // attachment rows, but `list_attachments_*` has no `deleted_at`
            // filter, so a soft-delete UPDATE here left a tombstone visible in
            // listings that is never GC'd. A hard DELETE keeps the reverse of
            // an `add_attachment` byte-identical to a normal delete's row
            // effect. The on-disk file is reconciled by the C-3c orphan-GC
            // sweep (`cleanup_orphaned_attachments`), the same backstop the
            // forward delete relies on.
            let attachment_id_str = p.attachment_id.as_str();
            sqlx::query!("DELETE FROM attachments WHERE id = ?", attachment_id_str,)
                .execute(&mut **tx)
                .await?;
        }
        OpPayload::RenameAttachment(p) => {
            // `reverse_payload` is already swapped by `reverse_rename_attachment`,
            // so the filename to restore lives in `new_filename` (mirroring the
            // forward materializer, which also writes `p.new_filename`). Reading
            // `old_filename` here would re-apply the current name — a no-op undo.
            let attachment_id_str = p.attachment_id.as_str();
            sqlx::query!(
                "UPDATE attachments SET filename = ? WHERE id = ?",
                p.new_filename,
                attachment_id_str
            )
            .execute(&mut **tx)
            .await?;
        }
        OpPayload::AddAttachment(p) => {
            // Undo of AddAttachment: the forward delete was a hard-DELETE, so
            // the row is gone and `original_created_at` is None in the normal
            // case. `created_at` is regenerated via `now_ms()` then. A row
            // may survive only via idempotency (e.g. double-undo replay), in
            // which case we preserve its existing `created_at`.
            let attachment_id_str = p.attachment_id.as_str();
            let original_created_at: Option<i64> = sqlx::query_scalar!(
                "SELECT created_at FROM attachments WHERE id = ?",
                attachment_id_str,
            )
            .fetch_optional(&mut **tx)
            .await?;

            let created_at = original_created_at.unwrap_or_else(crate::db::now_ms);
            let block_id_str = p.block_id.as_str();

            sqlx::query!(
                "INSERT OR REPLACE INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                attachment_id_str,
                block_id_str,
                p.mime_type,
                p.filename,
                p.size_bytes,
                p.fs_path,
                created_at,
            )
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
/// FEAT-3 Phase 8 — `scope` narrows the global (`page_id == "__all__"`)
/// query. [`SpaceScope::Active`] restricts the result set to ops whose
/// `payload.block_id` belongs to the named space.
/// [`SpaceScope::Global`] is the unscoped (cross-space) view.
/// The `scope` is ignored in per-page mode (a real ULID `page_id` is
/// already space-bound).
pub async fn list_page_history_inner(
    pool: &SqlitePool,
    page_id: String,
    op_type_filter: Option<String>,
    scope: &SpaceScope,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_page_history(
        pool,
        &page_id,
        op_type_filter.as_deref(),
        scope.as_filter_param(),
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

    // C5 (#344): bound the batch size before any DB work. This is the
    // single choke point for both interactive batch undo (`revert_ops`)
    // and point-in-time restore (`restore_page_to_op_inner`), so the cap
    // is enforced once here rather than at every caller.
    if ops.len() > MAX_REVERT_OPS {
        return Err(AppError::Validation(format!(
            "cannot revert {} ops in a single batch (maximum is {MAX_REVERT_OPS})",
            ops.len()
        )));
    }

    // Phase 1: Validate all ops are reversible by computing their reverse payloads.
    //
    // SQL-review B-3: previously this was a 3 × N per-op loop —
    // `compute_reverse` (`get_op_by_seq` + `find_prior_*`) plus a second
    // `get_op_by_seq` to source `created_at`/`op_type` for the
    // `UndoResult`. A 50-op undo fanned out to 150 sequential queries.
    //
    // The batched path collapses that to:
    //   1. one UNION-ALL `op_log` lookup for every input `OpRef`
    //      (`get_op_records_batch`),
    //   2. one UNION-ALL prior-context fetch per op-type present in
    //      the batch (`compute_reverse_batch` — at most 5 queries for
    //      the five context-bearing op-types).
    //
    // The reads run against the bare pool BEFORE the IMMEDIATE write
    // transaction below — same snapshot semantics as before (see
    // `restore_page_to_op_inner` for the wider rationale).
    let records = reverse::get_op_records_batch(pool, &ops).await?;
    let reverse_payloads = reverse::compute_reverse_batch(pool, &records).await?;
    let mut reverses: Vec<(OpRef, OpPayload, i64, String)> = Vec::with_capacity(ops.len());
    for ((op_ref, reverse_payload), record) in ops.iter().zip(reverse_payloads).zip(records.iter())
    {
        reverses.push((
            op_ref.clone(),
            reverse_payload,
            record.created_at,
            record.op_type.clone(),
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
            crate::db::now_ms(),
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
        sqlx::query!(
            "SELECT device_id, seq, op_type FROM op_log \
             WHERE (created_at > ?1 OR (created_at = ?1 AND (seq > ?2 OR (seq = ?2 AND device_id > ?3)))) \
             ORDER BY created_at DESC, seq DESC, device_id DESC",
            target_ts,
            target_seq,
            target_device_id,
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| (r.device_id, r.seq, r.op_type))
        .collect()
    } else {
        // Recursive CTE with `depth < 100` to bound the walk against
        // runaway recursion on corrupted data (invariant #9).
        sqlx::query!(
            "WITH RECURSIVE page_blocks(id, depth) AS ( \
               SELECT id, 0 FROM blocks WHERE id = ?1 \
               UNION ALL \
               SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
               WHERE pb.depth < 100 \
             ) \
             SELECT o.device_id, o.seq, o.op_type FROM op_log o \
             WHERE ( \
               o.block_id IN (SELECT id FROM page_blocks) \
               OR (o.op_type IN ('delete_attachment', 'rename_attachment') AND EXISTS ( \
                   SELECT 1 FROM attachments a \
                   WHERE a.id = json_extract(o.payload, '$.attachment_id') \
                   AND a.block_id IN (SELECT id FROM page_blocks) \
               )) \
             ) \
             AND (o.created_at > ?2 OR (o.created_at = ?2 AND (o.seq > ?3 OR (o.seq = ?3 AND o.device_id > ?4)))) \
             ORDER BY o.created_at DESC, o.seq DESC, o.device_id DESC",
            page_id,
            target_ts,
            target_seq,
            target_device_id,
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| (r.device_id, r.seq, r.op_type))
        .collect()
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

    // C5 (#344): reject an over-large restore up front with a
    // restore-specific message. `revert_ops_inner` enforces the same
    // `MAX_REVERT_OPS` cap as a backstop, but checking here means a
    // point-in-time restore that would sweep thousands of ops fails
    // cleanly before any batch work rather than relying on the inner
    // guard. The bound matches the interactive `undo_depth` ceiling.
    if reversible_ops.len() > MAX_REVERT_OPS {
        return Err(AppError::Validation(format!(
            "restore would revert {} ops, exceeding the maximum of {MAX_REVERT_OPS}; \
             restore to a more recent point",
            reversible_ops.len()
        )));
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
    // Recursive CTE with `depth < 100` to bound the walk against
    // runaway recursion on corrupted data (invariant #9).
    //
    // `LIMIT 1 OFFSET ?2` is a deliberate carve-out of invariant #3 ("no
    // offset pagination"): we are not paginating a list, we are fetching the
    // single Nth-most-recent op in the page's history. `undo_depth` is
    // validated to `[0, 1000]` upstream (see the bounds check at the top of
    // this function), so the OFFSET is bounded by a small constant; combined
    // with the indexed `(created_at DESC, seq DESC)` order, scan cost is
    // fixed. Invariant #3 protects unbounded list-query latency, which does
    // not apply to this "fetch Nth row" semantics.
    // I-CommandsCRUD-1 — the AGENTS.md "Backend Patterns"
    // carve-out for this pattern is deferred (locked AGENTS.md self-rule).
    let target = sqlx::query_as!(
        HistoryEntry,
        "WITH RECURSIVE page_blocks(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
             WHERE pb.depth < 100 \
         ) \
         SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at \
         FROM op_log ol \
         WHERE ( \
             ol.block_id IN (SELECT id FROM page_blocks) \
             OR ( \
                 ol.op_type IN ('delete_attachment', 'rename_attachment') \
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

    let op_record = op_log::append_local_op_in_tx(
        &mut tx,
        device_id,
        reverse_payload.clone(),
        crate::db::now_ms(),
    )
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

    let op_record = op_log::append_local_op_in_tx(
        &mut tx,
        device_id,
        reverse_payload.clone(),
        crate::db::now_ms(),
    )
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

/// PEND-35 Tier 4.4 — Compute the size of the consecutive same-device,
/// within-window undo group starting at the Nth-most-recent **undoable** op
/// of a page.
///
/// Mirrors the frontend grouping semantics that previously required
/// `list_page_history` re-fetches with a growing window after every
/// Ctrl+Z:
///
/// * "Undoable" excludes ops whose `op_type` starts with `undo_` or
///   `redo_` (those are reverse ops appended by [`undo_page_op_inner`] /
///   [`redo_page_op_inner`] and are not themselves undoable from the
///   user's POV).
/// * `depth = 0` seeds at the most-recent undoable op for the page.
///   `depth = N` seeds at the (N+1)-th most-recent.
/// * Walking forward in newest-first order, the group extends to the
///   next op whenever it is by the same `device_id` AND its `created_at`
///   is within `window_ms` of the previous op in the chain. The group
///   ends as soon as either condition fails or the page runs out of ops.
/// * Returns at least 1 (the seed itself) — never 0 unless the seed
///   doesn't exist (handled below by the caller; no-op = single
///   undo).
///
/// The query mirrors the standard page-scoped recursive CTE used by
/// `list_page_history` / `undo_page_op_inner`: `depth < 100` for the
/// page-blocks recursion, plus a second recursive CTE that walks the
/// ordered op stream until the group boundary is reached. The walk is
/// bounded by `count <= 1000` to match the `undo_depth` ceiling
/// enforced in [`undo_page_op_inner`].
///
/// Returns `i32` (FE callers store group sizes as JS numbers; the
/// 1000-row ceiling fits comfortably).
///
/// # Errors
///
/// * `AppError::Validation` — `depth < 0` or `window_ms < 0`.
/// * Database errors propagated from sqlx.
#[instrument(skip(pool), err)]
pub async fn find_undo_group_inner(
    pool: &SqlitePool,
    page_id: &str,
    depth: i64,
    window_ms: i64,
) -> Result<i32, AppError> {
    if depth < 0 {
        return Err(AppError::Validation("depth must be non-negative".into()));
    }
    if window_ms < 0 {
        return Err(AppError::Validation(
            "window_ms must be non-negative".into(),
        ));
    }

    // Two-stage CTE:
    //   1. `page_blocks` — page subtree (matches `list_page_history` / `undo_page_op_inner`).
    //   2. `ordered_ops` — undoable ops for those blocks, numbered newest-first.
    //   3. `walk` — recursive same-device + within-window walk seeded at row N+1.
    //
    // #109 Phase 2: `op_log.created_at` is INTEGER epoch-milliseconds, so the
    // within-window gap is a direct integer subtraction (`w.created_at -
    // o.created_at`) — no `julianday()` parse / `* 86400000` day-fraction
    // conversion needed (and `julianday()` would mis-parse a bare integer).
    //
    // The walk's `count <= 1000` matches the `undo_depth` ceiling in
    // `undo_page_op_inner`, bounding worst-case recursion against a
    // pathological burst of same-device ops.
    let seed_rn: i64 = depth + 1; // depth=0 → rn=1 (newest)
    let count: Option<i64> = sqlx::query_scalar!(
        "WITH RECURSIVE page_blocks(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
             WHERE pb.depth < 100 \
         ), \
         ordered_ops AS ( \
             SELECT \
                 ROW_NUMBER() OVER (ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC) AS rn, \
                 ol.device_id, ol.seq, ol.created_at \
             FROM op_log ol \
             WHERE ( \
                 ol.block_id IN (SELECT id FROM page_blocks) \
                 OR ( \
                     ol.op_type IN ('delete_attachment', 'rename_attachment') \
                     AND EXISTS ( \
                         SELECT 1 FROM attachments a \
                         WHERE a.id = json_extract(ol.payload, '$.attachment_id') \
                         AND a.block_id IN (SELECT id FROM page_blocks) \
                     ) \
                 ) \
             ) \
               AND ol.op_type NOT LIKE 'undo\\_%' ESCAPE '\\' \
               AND ol.op_type NOT LIKE 'redo\\_%' ESCAPE '\\' \
         ), \
         walk(rn, device_id, created_at, count_so_far) AS ( \
             SELECT rn, device_id, created_at, 1 \
             FROM ordered_ops \
             WHERE rn = ?2 \
             UNION ALL \
             SELECT o.rn, o.device_id, o.created_at, w.count_so_far + 1 \
             FROM walk w \
             JOIN ordered_ops o ON o.rn = w.rn + 1 \
             WHERE o.device_id = w.device_id \
               AND (w.created_at - o.created_at) <= ?3 \
               AND w.count_so_far < 1000 \
         ) \
         SELECT MAX(count_so_far) FROM walk",
        page_id,
        seed_rn,
        window_ms,
    )
    .fetch_one(pool)
    .await?;

    // `MAX(count_so_far)` is NULL when the seed row doesn't exist (depth
    // exceeds the page's undoable-op count). In that case there's no
    // group — the FE caller will skip extending and just record 1.
    //
    // The cast to i32 is bounded by the recursive walk's `count_so_far <
    // 1000` predicate so it can never truncate. The explicit `.min(i32::MAX
    // as i64)` defends against a future relaxation of that bound; the
    // `try_from(...).unwrap_or(i32::MAX)` form keeps clippy's
    // `cast_possible_truncation` lint quiet without an `#[allow]`.
    let raw = count.unwrap_or(0).max(0).min(i32::MAX as i64);
    Ok(i32::try_from(raw).unwrap_or(i32::MAX))
}

/// Tauri command: list page history. Delegates to [`list_page_history_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_page_history(
    pool: State<'_, ReadPool>,
    page_id: String,
    op_type_filter: Option<String>,
    scope: SpaceScope,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    list_page_history_inner(&pool.0, page_id, op_type_filter, &scope, cursor, limit)
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

/// Tauri command: compute the size of the consecutive same-device,
/// within-window undo group starting at the Nth-most-recent undoable op.
/// Delegates to [`find_undo_group_inner`]. PEND-35 Tier 4.4.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn find_undo_group(
    pool: State<'_, ReadPool>,
    page_id: String,
    depth: i64,
    window_ms: i64,
) -> Result<i32, AppError> {
    find_undo_group_inner(&pool.0, &page_id, depth, window_ms)
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
    // #382: pass the op's own `device_id` so `find_prior_text` tie-breaks
    // strictly before this op on the canonical `(created_at, seq,
    // device_id)` order — this op is identified by `(device_id, seq)`.
    let prior = crate::reverse::find_prior_text(
        pool,
        payload.block_id.as_str(),
        row.created_at,
        seq,
        &device_id,
    )
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

/// Compute a word-level diff between a block's historical content (as of
/// `historical_seq`) and its current live content.
///
/// The diff direction is `historical → current`, so:
///
/// * `Insert` spans = text added since the historical version → text that
///   would be REMOVED if the user restores to that version.
/// * `Delete` spans = text removed since the historical version → text that
///   would be RESTORED.
///
/// Returns an empty `Vec` when the historical and current contents are
/// byte-identical (the word-diff helper is documented to emit `Equal`
/// spans in that case; the caller can treat empty / all-`Equal` as "no
/// changes").
///
/// # Errors
///
/// * `AppError::NotFound` if the live block does not exist (purged) or
///   has been soft-deleted, or if no `create_block` / `edit_block` op
///   exists for the block at or before the selected point
///   `(historical_created_at, historical_seq)`.
#[instrument(skip(pool), err)]
pub async fn compute_block_vs_current_diff_inner(
    pool: &SqlitePool,
    block_id: BlockId,
    historical_created_at: i64,
    historical_seq: i64,
) -> Result<Vec<crate::word_diff::DiffSpan>, AppError> {
    // AGENTS.md invariant #8: ULIDs are stored uppercase; `BlockId`
    // already holds the canonical uppercase form on construction, so the
    // indexed column comparison hits the on-disk row directly.
    let block_id_upper = block_id.into_string();

    // 1. Live current content. We deliberately exclude soft-deleted
    //    blocks: there is nothing meaningful to diff against if the
    //    block has been moved to trash, and surfacing all-Insert spans
    //    in that case would mislead the user into thinking restore
    //    would just re-add the historical text. NotFound lets the UI
    //    fall back to the existing `compute_edit_diff` (single-step)
    //    view, which is still meaningful for the trash flow.
    // The `content` column on `blocks` is nullable, so `query_scalar!`
    // returns `Option<Option<String>>` — outer = row presence, inner =
    // column nullability. Treat a NULL `content` the same as the empty
    // string (matches the `payload.unwrap_or_default()` convention used
    // by `compute_edit_diff_inner` for missing prior text).
    let current_row: Option<Option<String>> = sqlx::query_scalar!(
        "SELECT content FROM blocks WHERE id = ?1 AND deleted_at IS NULL",
        block_id_upper,
    )
    .fetch_optional(pool)
    .await?;

    let Some(current_content_opt) = current_row else {
        return Err(AppError::NotFound(format!(
            "block '{block_id_upper}' not found or soft-deleted (cannot diff against current)"
        )));
    };
    let current = current_content_opt.unwrap_or_default();

    // 2. Historical content as of the selected point
    //    `(historical_created_at, historical_seq)` — the most recent
    //    `edit_block` or `create_block` payload for this block at or
    //    before that point in the canonical `(created_at, seq, device_id)`
    //    total order. Mirrors `find_prior_text` (which uses a strict `<`
    //    to find the state IMMEDIATELY BEFORE an op); here the bound is
    //    INCLUSIVE of the selected op (`seq <= ?`) so this snaps to the
    //    state PRODUCED by the historical op rather than the one before it.
    //
    // #382: bound on the canonical `(created_at, seq)` keyset rather than
    // on bare per-device `seq`. The op_log PK is `(device_id, seq)` and
    // `seq` is a PER-DEVICE counter, so `seq <= ?` alone is not a valid
    // global upper bound: a cross-device op with a numerically SMALLER
    // seq but a LATER `created_at` would pass `seq <= ?` yet sort first
    // under `ORDER BY created_at DESC`, returning content NEWER than the
    // selected point. Bounding by `(created_at < ?c OR (created_at = ?c
    // AND seq <= ?s))` makes the bound agree with the ORDER BY.
    //
    // MAINT-218: ORDER BY `created_at DESC, seq DESC` (not `seq DESC`
    // alone) to mirror `find_prior_text`'s cross-device tie-break and the
    // canonical total order used by `commands/history.rs` /
    // `pagination/history.rs`. Sorting by `created_at` first picks the
    // latest wall-clock op, matching the user's mental model of "most
    // recent change".
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE block_id = ?1 \
           AND op_type IN ('edit_block', 'create_block') \
           AND (created_at < ?2 OR (created_at = ?2 AND seq <= ?3)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        block_id_upper,
        historical_created_at,
        historical_seq,
    )
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Err(AppError::NotFound(format!(
            "no create_block or edit_block op for '{block_id_upper}' at or before \
             ({historical_created_at}, {historical_seq})"
        )));
    };

    // Same `InvalidOperation` strategy as `compute_edit_diff_inner` (L-39):
    // surface row identity through `sanitize_internal_error`'s pass-through
    // set when the on-disk payload is corrupt.
    let historical = if row.op_type == "edit_block" {
        let p: crate::op::EditBlockPayload = serde_json::from_str(&row.payload).map_err(|e| {
            AppError::InvalidOperation(format!(
                "op for '{block_id_upper}' at seq <= {historical_seq} payload not parseable as EditBlockPayload: {e}"
            ))
        })?;
        p.to_text
    } else {
        let p: crate::op::CreateBlockPayload =
            serde_json::from_str(&row.payload).map_err(|e| {
                AppError::InvalidOperation(format!(
                    "op for '{block_id_upper}' at seq <= {historical_seq} payload not parseable as CreateBlockPayload: {e}"
                ))
            })?;
        p.content
    };

    Ok(crate::word_diff::compute_word_diff(&historical, &current))
}

/// Tauri command: compute word-level diff between a block's historical
/// content (as of the selected point `(historical_created_at,
/// historical_seq)`) and its current live content. Delegates to
/// [`compute_block_vs_current_diff_inner`].
///
/// #382: the caller passes BOTH `historical_created_at` and
/// `historical_seq` (the history entry already carries both columns) so
/// the historical lookup can bound on the canonical `(created_at, seq)`
/// keyset instead of bare per-device `seq`, which is not a valid global
/// upper bound across devices.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn compute_block_vs_current_diff(
    pool: State<'_, ReadPool>,
    block_id: BlockId,
    historical_created_at: i64,
    historical_seq: i64,
) -> Result<Vec<crate::word_diff::DiffSpan>, AppError> {
    compute_block_vs_current_diff_inner(&pool.0, block_id, historical_created_at, historical_seq)
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
    const FIXED_TS: i64 = 1_735_689_600_000; // 2025-01-01T00:00:00Z

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
        created_at: i64,
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
            index: None,
            content: "hello".into(),
        });
        let record = append_local_op_at(&pool, DEV, payload, FIXED_TS)
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

    /// #384 regression: `find_undo_group_inner`'s `ordered_ops` CTE must
    /// enumerate the SAME op set as `undo_page_op_inner` — including
    /// `delete_attachment` ops, whose `block_id` index column is NULL but
    /// which target an attachment on a page block (resolved via the
    /// `attachments.block_id IN page_blocks` EXISTS branch).
    ///
    /// Setup: a page with one child block carrying an attachment, then three
    /// consecutive same-device, within-window ops on that subtree where the
    /// MIDDLE op is a `delete_attachment`. Before the fix the middle op was
    /// absent from `ordered_ops`, so the walk saw only two rows that were no
    /// longer rn-adjacent and the group collapsed; with the fix all three
    /// ops are enumerated and the group spans them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn find_undo_group_includes_delete_attachment_ops() {
        use crate::op::{AddAttachmentPayload, DeleteAttachmentPayload, EditBlockPayload};

        let (pool, _dir) = test_pool().await;

        // Page block + child block (child is a descendant of the page).
        let page_id = BlockId::test_id("PAGE1");
        let child_id = BlockId::test_id("CHILD1");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'page', 'P', 0)",
        )
        .bind(page_id.as_str())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, parent_id, block_type, content, position) \
             VALUES (?, ?, 'content', 'c', 0)",
        )
        .bind(child_id.as_str())
        .bind(page_id.as_str())
        .execute(&pool)
        .await
        .unwrap();

        // Attachment row on the child block — the EXISTS branch resolves the
        // delete_attachment op back to the page subtree through this row.
        let att_id = BlockId::test_id("ATT1");
        sqlx::query(
            "INSERT INTO attachments \
             (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, 'image/png', 'f.png', 1, 'p/f.png', ?)",
        )
        .bind(att_id.as_str())
        .bind(child_id.as_str())
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

        // Three consecutive same-device ops within a 1s window. The middle
        // op is the delete_attachment (block_id index column NULL).
        let edit1 = OpPayload::EditBlock(EditBlockPayload {
            block_id: child_id.clone(),
            to_text: "v1".into(),
            prev_edit: None,
        });
        append_local_op_at(&pool, DEV, edit1, FIXED_TS)
            .await
            .unwrap();

        let del = OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: att_id.clone(),
            fs_path: "p/f.png".into(),
        });
        append_local_op_at(&pool, DEV, del, FIXED_TS + 1)
            .await
            .unwrap();

        // (The add_attachment is appended last so the edit set is interesting;
        // it also lives on the page subtree via its block_id index column.)
        let add = OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: BlockId::test_id("ATT2"),
            block_id: child_id.clone(),
            mime_type: "image/png".into(),
            filename: "g.png".into(),
            size_bytes: 1,
            fs_path: "p/g.png".into(),
        });
        append_local_op_at(&pool, DEV, add, FIXED_TS + 2)
            .await
            .unwrap();

        // depth=0 seeds at the newest op; a 1s window covers all three. The
        // group must span all three consecutive same-device ops — which is
        // only possible if the delete_attachment is enumerated in
        // ordered_ops (otherwise the chain breaks and the count is < 3).
        let group = find_undo_group_inner(&pool, page_id.as_str(), 0, 1000)
            .await
            .unwrap();
        assert_eq!(
            group, 3,
            "undo group must span all three consecutive ops including the \
             delete_attachment; got {group}"
        );

        // Guard against a false pass: if the delete_attachment were silently
        // EXCLUDED from ordered_ops (the pre-fix bug), the same setup minus
        // the EXISTS branch would yield a group of 2. Assert the op log
        // actually holds the three ops we appended so the count reflects real
        // enumeration rather than an empty page.
        let total: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log WHERE op_type IN \
             ('edit_block', 'delete_attachment', 'add_attachment')"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(total, 3, "expected exactly three seeded ops; got {total}");
    }
}
