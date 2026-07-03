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

    // Single IMMEDIATE transaction: validation + op_log + move. BEGIN IMMEDIATE
    // eagerly acquires the write lock, fixing the TOCTOU window between
    // validation and mutation. CommandTx couples commit + post-commit dispatch
    // so a failed commit never leaks the op_record to the materializer.
    //
    // #2274: the per-move body now lives in `move_block_in_tx` so the batched
    // `move_blocks_batch_inner` can run N moves inside ONE tx with identical
    // slot/cycle/depth semantics — this wrapper is the single-move arity of it.
    let mut tx = CommandTx::begin_immediate(pool, "move_block").await?;
    let response = move_block_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        block_id,
        new_parent_id,
        new_index,
    )
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(response)
}

/// Apply ONE move inside an already-open [`CommandTx`], WITHOUT committing.
///
/// Extracted from [`move_block_inner`] (#2274) so both the single-move command
/// and the batched [`move_blocks_batch_inner`] share one implementation of the
/// validation + op_log-append + engine-apply + reprojection + cache-recompute
/// pipeline. The caller owns the transaction lifecycle (BEGIN / COMMIT); this
/// helper only appends the op via `enqueue_background` so the caller's single
/// `commit_and_dispatch` drains every enqueued op in FIFO order.
///
/// Called back-to-back within one tx, each invocation reads the state the
/// PREVIOUS move committed in-tx (`apply_op_projected` writes the engine + SQL
/// AND runs the inline count/page-id maintenance synchronously — `chunk = None`),
/// which is exactly what preserves the #774 slot
/// semantics for a batch: parking block[k] at slot `start+k` drops block[k+1]
/// at `start+k+1` immediately after it. Any `?` propagation rolls the WHOLE
/// transaction back (nothing moved) because the caller never reaches commit.
///
/// See [`move_block_inner`]'s original inline body for the full rationale on
/// each step; the comments are preserved verbatim below.
#[instrument(skip(tx, state, device_id), err)]
async fn move_block_in_tx(
    tx: &mut CommandTx,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    block_id: String,
    new_parent_id: Option<String>,
    new_index: i64,
) -> Result<MoveResponse, AppError> {
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
    // #1257 keep the typed `MoveBlockPayload` so the command path can append it
    // to the op_log; `apply_op_projected` then re-derives the payload from the
    // appended `op_record` to drive the in-tx move. The op-log carries an owned
    // `OpPayload::MoveBlock(move_payload.clone())`.
    let move_payload = MoveBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        new_parent_id: new_parent_block_id.clone(),
        new_position: provisional_position,
        new_index: Some(new_index),
    };

    // 3. Validation + op_log + move, inside the caller-owned IMMEDIATE tx.
    //    The caller's BEGIN IMMEDIATE eagerly acquired the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation.

    // Validate block exists and is not deleted (TOCTOU-safe)
    let existing = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut ***tx)
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
        .fetch_optional(&mut ***tx)
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
        if crate::block_descendants::move_would_cycle(&mut ***tx, &block_id, pid).await? {
            return Err(AppError::validation("cycle detected".into()));
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
        // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants (both the path
        // and descendants recursive arms carry the cap)
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
        .fetch_one(&mut ***tx)
        .await?;

        let parent_depth = depths.parent_depth;
        let subtree_depth = depths.subtree_depth;

        if parent_depth + 1 + subtree_depth > MAX_BLOCK_DEPTH {
            return Err(AppError::validation(format!(
                "maximum nesting depth of {MAX_BLOCK_DEPTH} exceeded"
            )));
        }
    }

    // 4. Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(
        &mut *tx,
        device_id,
        OpPayload::MoveBlock(move_payload.clone()),
        crate::db::now_ms(),
    )
    .await?;

    // 5. #2344/#2325 route the just-appended `op_record` through the SINGLE
    //    collapsed apply-projection entry point (`apply_op_projected`), IN this
    //    CommandTx, INSTEAD of the direct `apply_move_block_via_loro` call plus
    //    the hand-rolled LOCAL maintenance that used to follow it — the MoveBlock
    //    arm of the #2325 apply-path collapse, the FINAL single-op slice. This is
    //    the SAME engine-apply + SQL projection the boot-replay / sync `ApplyOp`
    //    path uses (via `apply_op_tx`'s MoveBlock arm), so the LOCAL and REMOTE
    //    move paths now share one entry point. `apply_op_projected` re-derives the
    //    `MoveBlockPayload` from `op_record.payload` and runs the SAME
    //    `apply_move_block_via_loro` (resolve space → per-space Loro engine apply →
    //    `project_move_block_to_sql` parent_id/position write →
    //    `reproject_dense_positions` of both sibling groups →
    //    `recompute_subtree_inheritance` for the moved subtree), PLUS — via
    //    `PreOpState::Move` in `maintain_pages_cache_counts_after_op` (#2351) —
    //    ALL of the LOCAL maintenance that used to live inline here:
    //      * the shared `rederive_page_and_space_ids` (page_id AND space_id for
    //        the moved subtree, #664),
    //      * the IDENTICAL affected-pages CTE (old owning page ∪ the moved
    //        subtree's page ids ∪ its outbound-target pages, #417) fed to
    //        `recompute_pages_cache_counts_for_pages`, and
    //      * the #2200 same-parent reorder early-out (skip ALL count maintenance
    //        when `old_parent_id == new_parent_id`).
    //    The maintain step captures `old_parent_id` / `src_page` PRE-projection
    //    itself, so the former LOCAL captures + `same_parent_reorder` gate are now
    //    redundant and removed. Because `apply_op_projected` passes `chunk = None`
    //    (a "chunk of one"), that maintenance runs INLINE per-op — synchronously,
    //    before this call returns — which preserves the #774 in-tx slot semantics
    //    the batch path (`move_blocks_batch_inner`) relies on. We pass
    //    `advance_cursor = false`: the apply cursor (`materialized_through_seq`)
    //    stays put on the LOCAL path so boot replay re-applies these ops
    //    idempotently — the intended safety net while local engine-apply hardens
    //    (#1248 / #1257). The op-log append above is unchanged, and the
    //    cycle/TOCTOU/depth checks above still gate this user-driven move (the
    //    helper's own cycle probe no-op-warns; the command already surfaced the
    //    error). If the block's space can't be resolved (#2250: `SpaceUnresolved`,
    //    the only remaining sql_only trigger), the helper internally FALLS BACK to
    //    `apply_move_block_sql_only` (provisional rank + `parent_id`), so the row
    //    is never skipped and we never crash — preserving #1323 convergence.
    //    `apply_op_projected` borrows `&op_record` here, BEFORE the
    //    `enqueue_background(op_record)` move below. The returned `ApplyEffects`
    //    is empty for Move (LOCAL move runs no post-commit cohort fan-out), so it
    //    is discarded.
    crate::materializer::apply_op_projected(&mut *tx, &op_record, state, false).await?;

    // 6. Enqueue the op for background dispatch. The CALLER's single
    //    `commit_and_dispatch` drains every enqueued op in FIFO order (one op
    //    for the single-move path, N for the batch path).
    tx.enqueue_background(op_record);

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

/// Atomically move an ORDERED list of block subtrees under a single new parent,
/// landing them at consecutive slots starting at `new_index` (#2274).
///
/// This is the batched arity of [`move_block_inner`]: instead of the frontend
/// firing N sequential `move_block` IPCs (each its own IMMEDIATE tx + writer-lock
/// window) plus a full page reload, the multi-select drag issues ONE IPC that
/// runs all moves inside ONE BEGIN IMMEDIATE transaction and returns the
/// authoritative per-root parent/position so the frontend reconciles WITHOUT a
/// blind `load()`.
///
/// Semantics mirror `create_blocks_batch`:
///
/// - **One tx, N ops:** each move runs through the shared [`move_block_in_tx`]
///   helper, which appends one `MoveBlock` op to the op_log (so undo / sync
///   convergence stay per-op — no new "batch move" op type is invented) and
///   drives the same engine-apply + dense-rank reprojection path a single
///   `move_block` uses. A single `commit_and_dispatch` at the end drains every
///   enqueued op in order.
/// - **#774 slot preservation IN-tx:** because each move applies to the engine +
///   SQL synchronously before the next runs, block[k] parked at slot
///   `new_index + k` is visible to block[k+1]'s move at slot `new_index + k + 1`,
///   which drops it immediately after — an order-preserving contiguous run,
///   identical to the old sequential single-move loop.
/// - **All-or-nothing:** any per-move rejection (missing block/parent, cycle —
///   target inside a moved subtree — or depth-cap violation) propagates via `?`,
///   which drops the tx before commit and rolls the WHOLE batch back. Nothing
///   moves. The cycle and depth checks are performed per move against the
///   in-tx state, so a target that is a descendant of ANY moved block is caught.
///
/// **Ordering contract:** `block_ids` MUST already be in the desired destination
/// order (the frontend sorts the selection by current document position first).
///
/// **Validation:** empty list → [`AppError::Validation`]; `block_ids.len()` over
/// [`MAX_BATCH_BLOCK_IDS`](crate::commands::MAX_BATCH_BLOCK_IDS) →
/// [`AppError::Validation`].
///
/// Returns one [`MoveResponse`] per moved root, in input order (1:1 with
/// `block_ids`), carrying its new `parent_id` + provisional `position`.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn move_blocks_batch_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
    new_parent_id: Option<BlockId>,
    new_index: i64,
) -> Result<Vec<MoveResponse>, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    ensure_batch_within_cap("block_ids", block_ids.len())?;

    let new_parent_id = new_parent_id.map(BlockId::into_string);
    // #400: `new_index` is a 0-based sibling slot; clamp a stray negative once
    // (each per-move call re-clamps its own derived slot defensively).
    let start_index = new_index.max(0);

    let mut tx = CommandTx::begin_immediate(pool, "move_blocks_batch").await?;
    let mut responses = Vec::with_capacity(block_ids.len());
    for (k, id) in block_ids.into_iter().enumerate() {
        // Consecutive destination slots: block[k] → slot `start_index + k`.
        // In-tx, the previous move is already committed to the engine + SQL, so
        // this slot is read against the post-prior-move state (#774 semantics).
        // (`k` is bounded by `MAX_BATCH_BLOCK_IDS`, so the conversion is
        // infallible in practice; saturate defensively rather than wrap.)
        let slot = start_index.saturating_add(i64::try_from(k).unwrap_or(i64::MAX));
        let response = move_block_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            id.into_string(),
            new_parent_id.clone(),
            slot,
        )
        .await?;
        responses.push(response);
    }
    tx.commit_and_dispatch(materializer).await?;
    Ok(responses)
}

/// Tauri command: batched intra-page reorder/reparent (#2274). See
/// [`move_blocks_batch_inner`]. `block_ids` are moved, in the given order, under
/// `new_parent_id` (a real block id, or `None` for top-level) at consecutive
/// slots starting at the 0-based `new_index`.
#[tauri::command]
#[specta::specta]
pub async fn move_blocks_batch(
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<String>,
    new_parent_id: Option<String>,
    new_index: i64,
) -> Result<Vec<MoveResponse>, AppError> {
    move_blocks_batch_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_ids.into_iter().map(Into::into).collect(),
        new_parent_id.map(Into::into),
        new_index,
    )
    .await
    .map_err(sanitize_internal_error)
}
