use crate::db::{CommandTx, WritePool};
use crate::device::DeviceId;
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
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        new_parent_id: new_parent_block_id.clone(),
        new_position: provisional_position,
        new_index: Some(new_index),
    });

    // 3. Single IMMEDIATE transaction: validation + op_log + move.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation. MAINT-112: CommandTx couples commit
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

        // Cycle detection: walk all ancestors of the new parent using the
        // shared `ancestors_cte_standard!()` macro. If block_id appears
        // among the ancestors, reparenting would create a cycle (e.g.
        // moving A under its own grandchild C in a chain A→B→C).
        //
        // The macro pins AGENTS.md invariant #9 (`a.depth < 100` recursion
        // bound). Without it, a corrupted parent_id chain could run unbounded
        // recursion.
        //
        // The macro seeds the CTE at `pid` itself (depth 0) rather than at
        // `pid`'s parent_id; including `pid` in the ancestor set is harmless
        // here because the `pid == block_id` case is rejected upfront with
        // `AppError::InvalidOperation` (above), so the `WHERE id = ?` row
        // match against `block_id` cannot mask that error.
        let cycle = sqlx::query(concat!(
            crate::ancestors_cte_standard!(),
            "SELECT 1 FROM ancestors WHERE id = ?",
        ))
        .bind(pid)
        .bind(&block_id)
        .fetch_optional(&mut **tx)
        .await?;
        if cycle.is_some() {
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
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, crate::db::now_ms()).await?;

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

    // 5. Update blocks table within same transaction (optimistic; the
    //    materializer reprojects the authoritative dense rank from the engine).
    sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
        .bind(&new_parent_id)
        .bind(provisional_position)
        .bind(&block_id)
        .execute(&mut **tx)
        .await?;

    // Update page_id for the moved block and all its descendants.
    // First, compute the new page_id based on the new parent.
    let new_page_id: Option<String> = if let Some(ref pid) = new_parent_id {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END FROM blocks WHERE id = ?"
        )
        .bind(pid)
        .fetch_optional(&mut **tx)
        .await?
        .flatten()
    } else {
        None
    };

    // Update the moved block itself (unless it's a page — pages always have page_id = self)
    let is_page: bool =
        sqlx::query_scalar::<_, String>("SELECT block_type FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_one(&mut **tx)
            .await?
            == "page";

    if !is_page {
        sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
            .bind(&new_page_id)
            .bind(&block_id)
            .execute(&mut **tx)
            .await?;
    }

    // Update all non-page descendants to inherit the moved block's page_id.
    // Pages keep their own id as page_id regardless of parent.
    //
    // Recursive CTE filters  in both members — conflict
    // copies inherit `parent_id` from the original and would otherwise be
    // reparented under the moved subtree. `depth < 100` bounds the walk
    // (invariant #9).
    let effective_page_id = if is_page {
        Some(block_id.clone())
    } else {
        new_page_id
    };
    sqlx::query(
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
    )
    .bind(&block_id)
    .bind(&effective_page_id)
    .execute(&mut **tx)
    .await?;

    // P-4: Recompute inherited tags for moved subtree
    crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &block_id).await?;

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
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn move_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    new_parent_id: Option<String>,
    new_index: i64,
) -> Result<MoveResponse, AppError> {
    move_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id.into(),
        new_parent_id.map(Into::into),
        new_index,
    )
    .await
    .map_err(sanitize_internal_error)
}
