use crate::db::{CommandTx, WriteCtx};
use crate::op::MoveBlockPayload;
use tracing::instrument;

use super::super::*;

/// Move a block to a new parent at a specific position.
///
/// Validates the block and optional new parent exist, detects cycles via
/// ancestor-walking CTE, appends a `MoveBlock` op, updates `parent_id` and
/// `position` in the `blocks` table, and dispatches background cache tasks.
///
/// # Position contract (#383)
///
/// `position` is **NOT unique** among siblings. The canonical sibling
/// ordering is `(position ASC, id ASC)` — `id` (a monotonically increasing
/// ULID) breaks ties when two siblings share a `position`. This function
/// performs **no in-transaction shift / renumber** of the other siblings:
/// it writes only the moved block's `position` verbatim. If a caller needs
/// gap-free or collision-free positions, it must renumber the siblings
/// itself (e.g. via its own pass before/after this call). Reusing an
/// existing sibling's `position` is therefore legal and simply places the
/// moved block adjacent to that sibling, ordered by `id`.
///
/// # Errors
///
/// - [`AppError::InvalidOperation`] — block cannot be its own parent
/// - [`AppError::Validation`] — non-positive position, or cycle detected
/// - [`AppError::NotFound`] — block or new parent does not exist or is deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn move_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
    new_parent_id: Option<BlockId>,
    new_index: i64,
) -> Result<MoveResponse, AppError> {
    // #107: BlockId normalises to uppercase on construction; re-derive owned
    // String form for sqlx binds / format! / the MoveResponse below.
    let block_id = block_id.into_string();
    let new_parent_id = new_parent_id.map(BlockId::into_string);

    // 1. Validate block cannot become its own parent (pure-logic check, no DB)
    if let Some(ref pid) = new_parent_id
        && pid == &block_id
    {
        return Err(AppError::InvalidOperation(format!(
            "block '{block_id}' cannot be its own parent"
        )));
    }

    // 1b. #400: `new_index` is a 0-based sibling slot. "Move to the top" / "nest
    // as first child" are slot 0 — both previously rejected as `position <= 0`.
    // The old positive-position validation is gone; clamp a stray negative.
    let new_index = new_index.max(0);
    // Provisional 1-based dense rank for the optimistic SQL write + response;
    // the materializer reprojects the authoritative ranks from the engine's
    // fractional order shortly after (eventual consistency, as for engine state).
    // #400/#383: overflow-safe 0-based slot → 1-based provisional rank, capped
    // below the reserved keyset tail marker; reprojection sets the dense rank.
    let provisional_position = crate::pagination::index_to_provisional_position(new_index);

    // 2. Build OpPayload (#400: carries the 0-based `new_index`; `new_position`
    // is a 1-based breadcrumb mirroring it for legacy readers).
    // (#383's NULL_POSITION_SENTINEL rejection is obsolete here: callers supply
    // a 0-based `new_index` slot, not a verbatim position. `provisional_position`
    // is a transient optimistic rank the materializer reprojects, so a caller can
    // no longer push a block into the synthetic sentinel tail bucket.)
    let new_parent_block_id = new_parent_id.as_ref().map(|s| BlockId::from_trusted(s));
    // #1257 keep the typed `MoveBlockPayload` so the command path can both
    // append it to the op_log AND drive `apply_move_block_via_loro` in-tx
    // (`create_payload`). The op-log carries an owned
    // `OpPayload::MoveBlock(move_payload.clone())`.
    let move_payload = MoveBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        new_parent_id: new_parent_block_id.clone(),
        new_position: provisional_position,
        new_index: Some(new_index),
    };

    // 3. Single IMMEDIATE transaction: validation + op_log + move.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // And the actual mutation. CommandTx couples commit
    //    + post-commit dispatch so a failed commit never leaks the
    //    op_record to the materializer.
    let mut tx = CommandTx::begin_immediate(pool, "move_block").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let existing = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    if existing.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Validate new parent exists and is not deleted (TOCTOU-safe)
    if let Some(ref pid) = new_parent_id {
        let exists = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            pid
        )
        .fetch_optional(&mut **tx)
        .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }

        // Cycle detection (#1323 Step 4): the SHARED
        // `block_descendants::move_would_cycle` probe — the SAME helper the
        // SQL-only fallback (`apply_move_block_sql_only`) uses, so the two
        // SQL-side paths cannot drift. It walks the new parent's ancestors via
        // `ancestors_cte_standard!()` (depth-100 bound, AGENTS.md invariant #9)
        // and reports whether reparenting `block_id` under `pid` would form a
        // cycle (e.g. moving A under its own grandchild C in a chain A→B→C).
        // The helper returns the boolean only; the rejection is the command
        // path's own (a user-driven move must surface the error, whereas the
        // sync-replay fallback no-op-warns — see the helper docstring).
        if crate::block_descendants::move_would_cycle(&mut **tx, &block_id, pid).await? {
            return Err(AppError::Validation("cycle detected".into()));
        }

        // Depth check: count ancestors of the target parent (its depth from
        // root) and the max descendant depth of the block being moved. The
        // deepest descendant will end up at parent_depth + 1 + subtree_depth.
        //
        // Recursive members bound the walk with `depth < 100`
        // (invariant #9).
        //
        // NOTE (#470 L2): the `path` CTE below is semantically identical to
        // `ancestors_cte_standard!()`.  It cannot be replaced by the macro
        // here because this query also needs a second CTE (`descendants`) that
        // walks in the opposite direction — a combined single-statement round
        // trip.  Splitting into two queries (one per CTE) would require two
        // separate SQL round trips and is not worth the overhead.  The inline
        // form is intentional: this is acceptable per the LOW finding.
        let depths = sqlx::query!(
            r#"WITH RECURSIVE
               path(id, depth) AS (
                 SELECT ?, 0
                 UNION ALL
                 SELECT b.parent_id, p.depth + 1
                 FROM path p JOIN blocks b ON b.id = p.id
                 WHERE b.parent_id IS NOT NULL AND p.depth < 100
               ),
               descendants(id, depth) AS (
                 SELECT ?, 0
                 UNION ALL
                 SELECT b.id, d.depth + 1
                 FROM descendants d JOIN blocks b ON b.parent_id = d.id
                 WHERE b.deleted_at IS NULL AND d.depth < 100
               )
             SELECT
               (SELECT MAX(depth) FROM path) as "parent_depth: i64",
               (SELECT MAX(depth) FROM descendants) as "subtree_depth: i64""#,
            pid,
            block_id
        )
        .fetch_one(&mut **tx)
        .await?;

        let parent_depth = depths.parent_depth;
        let subtree_depth = depths.subtree_depth;

        if parent_depth + 1 + subtree_depth > MAX_BLOCK_DEPTH {
            return Err(AppError::Validation(format!(
                "maximum nesting depth of {MAX_BLOCK_DEPTH} exceeded"
            )));
        }
    }

    // 4. Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(
        &mut tx,
        device_id,
        OpPayload::MoveBlock(move_payload.clone()),
        crate::db::now_ms(),
    )
    .await?;

    // #417: capture the moved block's OLD owning page BEFORE the move
    // re-derives `page_id`. The affected-page set for a move is
    //   { old owning page } ∪ { new owning page } ∪
    //   { outbound target pages of the moved subtree }
    // — `child_block_count` changes on both the old and new owners, and
    // `inbound_link_count` changes on the link targets only if the moved
    // subtree crossed into / out of those targets' own page (a same-page
    // link does not count; the canonical recompute applies that rule).
    // Recompute runs AFTER the move + `page_id` reprojection below so the
    // subqueries see the new ownership.
    let old_owning_page: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT page_id FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();

    // 5. #1257 route the move through the SAME engine-apply + dense-rank
    //    reprojection the boot-replay / sync `ApplyOp` path uses, IN this
    //    CommandTx, INSTEAD of the inline provisional `UPDATE blocks SET
    //    parent_id, position`. `apply_move_block_via_loro`:
    //      1. resolves the block's space,
    //      2. applies the move to the per-space Loro engine (sync guard, dropped
    //         before any `.await`), reads back the engine `BlockSnapshot` plus the
    //         authoritative pre/post sibling orders,
    //      3. `project_move_block_to_sql` UPDATEs the row's `parent_id` +
    //         engine-dense `position`,
    //      4. `reproject_dense_positions` re-ranks BOTH the source (old parent)
    //         and target (new parent) sibling groups so the SQL `position`
    //         matches the engine's fractional tree order in each (a same-parent
    //         reorder reprojects the single shared group once), and
    //      5. runs `recompute_subtree_inheritance` for the moved subtree.
    //    The op-log append above is unchanged, and the cycle/TOCTOU/depth checks
    //    above still gate this user-driven move (the helper's own cycle probe
    //    no-op-warns; the command must surface the error, which we already did).
    //    We deliberately do NOT call the full `apply_op_tx` wrapper /
    //    `advance_apply_cursor`: the apply cursor (`materialized_through_seq`)
    //    must stay put on the LOCAL path so boot replay re-applies these ops
    //    idempotently (engine apply is idempotent; the projection UPDATEs are by
    //    construction) — the intended safety net while local engine-apply hardens
    //    (#1248 / #1257). If the engine can't be resolved (space unresolvable /
    //    engine uninitialised — e.g. a test without `install_for_test`), the
    //    helper internally FALLS BACK to `apply_move_block_sql_only`, which writes
    //    the provisional rank (`index_to_provisional_position`) + `parent_id` — so
    //    the row is never skipped and we never crash. This mirrors the
    //    engine-absent handling the sync `ApplyOp` path already relies on, and
    //    preserves the #1323 convergence (parent_id updated either way; position
    //    dense on the engine path, provisional on the fallback).
    crate::materializer::apply_move_block_via_loro(&mut tx, device_id, &move_payload).await?;

    // #664: recompute `page_id` AND `space_id` for the moved subtree,
    // synchronously. The async `RebuildPageIds` task chains
    // `rebuild_space_ids`, but callers read space-scoped lists right after
    // commit, so both columns must be re-derived in-tx here. Shared helper
    // (the single source of truth for this chain) lives in
    // `crate::commands::block_cleanup`.
    crate::commands::block_cleanup::rederive_page_and_space_ids(&mut tx, &block_id).await?;

    // #1392: tag-inheritance recompute for the moved subtree is now owned by
    // `apply_move_block_via_loro` (step 5 above) — and by its engine-absent
    // `apply_move_block_sql_only` fallback — so BOTH arms already recompute
    // `block_tag_inherited`. The former explicit call here (left over from the
    // pre-#1257-route-through inline path) was a redundant second subtree walk
    // on every move; dropped. `local_move_inheritance_both_arms_1392` pins that
    // both arms keep the inheritance correct without it.

    // #417: refresh `pages_cache` counts for the affected pages WITHOUT the
    // full-table pass. Set = old owning page ∪ new owning page ∪ outbound
    // target pages of the moved subtree (resolved against the just-updated
    // `page_id` + `block_links`). Bounded by the same depth-100 subtree CTE
    // and indexed `block_links` join.
    {
        use std::collections::HashSet;
        let mut affected: HashSet<String> = HashSet::new();
        if let Some(p) = old_owning_page {
            affected.insert(p);
        }
        // New owning page + outbound target pages of the moved subtree.
        let rows = sqlx::query_scalar::<_, String>(
            "WITH RECURSIVE subtree(id, depth) AS ( \
                 SELECT id, 0 FROM blocks WHERE id = ?1 \
                 UNION ALL \
                 SELECT b.id, s.depth + 1 FROM blocks b \
                 JOIN subtree s ON b.parent_id = s.id \
                 WHERE b.deleted_at IS NULL AND s.depth < 100 \
             ) \
             SELECT DISTINCT page_id FROM blocks \
                 WHERE id IN (SELECT id FROM subtree) AND page_id IS NOT NULL \
             UNION \
             SELECT DISTINCT b.page_id FROM block_links bl \
                 JOIN blocks b ON b.id = bl.target_id \
                 WHERE bl.source_id IN (SELECT id FROM subtree) \
                   AND b.page_id IS NOT NULL",
        )
        .bind(&block_id)
        .fetch_all(&mut **tx)
        .await?;
        affected.extend(rows);
        let affected: Vec<String> = affected.into_iter().collect();
        crate::materializer::recompute_pages_cache_counts_for_pages(&mut tx, &affected).await?;
    }

    // 6. Commit + dispatch background cache tasks (fire-and-forget).
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    // 7. Return response. `new_position` is the provisional 1-based dense rank;
    // the frontend uses optimistic local splices (R5) and re-reads on navigation.
    Ok(MoveResponse {
        block_id,
        new_parent_id,
        new_position: provisional_position,
    })
}

/// Tauri command: move a block under a new parent at a 0-based sibling slot
/// (#400). `new_index` is an insertion slot among the target parent's other
/// children; slot 0 is "first child" / "top". Delegates to [`move_block_inner`].
#[tauri::command]
#[specta::specta]
pub async fn move_block(
    ctx: State<'_, WriteCtx>,
    block_id: String,
    new_parent_id: Option<String>,
    new_index: i64,
) -> Result<MoveResponse, AppError> {
    move_block_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_id.into(),
        new_parent_id.map(Into::into),
        new_index,
    )
    .await
    .map_err(sanitize_internal_error)
}
