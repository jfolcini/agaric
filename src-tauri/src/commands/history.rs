//! History command handlers.

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::op::{OpPayload, OpRef, UndoResult};
use agaric_store::op_log;
use agaric_store::pagination;
use agaric_store::pagination::HistoryEntry;
use agaric_store::pagination::PageResponse;
use agaric_store::space::SpaceScope;

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

/// #928: Re-densify the LIVE children of `parent_id` to dense 1-based positions
/// inside an existing transaction.
///
/// Reads the canonical sibling order — `(position ASC, id ASC)`, the same tuple
/// the read side and engine projection use — over the non-tombstoned children of
/// `parent_id`, then delegates to
/// [`agaric_engine::loro::projection::reproject_dense_positions`] (a single set-based
/// `UPDATE … FROM json_each`). This is the SQL-only analogue of the engine
/// reprojection the foreground apply path runs: the reverse-apply path
/// ([`apply_reverse_in_tx`]) never enters `apply_op_tx`, so its MoveBlock arm
/// must re-densify the affected groups itself or leave gaps/dupes.
///
/// Tombstoned siblings are excluded: they are not part of the live order a user
/// sees, and the reverse path has no engine fractional order to anchor their
/// retained slot to. Live siblings collapse to `1..N` with no duplicates/gaps.
async fn reproject_live_sibling_group(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    parent_id: Option<&str>,
) -> Result<(), AppError> {
    // `parent_id IS ?` matches NULL (top-level blocks) and concrete parents
    // alike; `deleted_at IS NULL` keeps tombstones out of the dense order.
    // dynamic-sql: test-only fixture/verification query (differential enumeration test, #2190 review).
    let ordered: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT id FROM blocks \
         WHERE parent_id IS ? AND deleted_at IS NULL \
         ORDER BY position ASC, id ASC",
    )
    .bind(parent_id)
    .fetch_all(&mut **tx)
    .await?;
    // `reproject_dense_positions` takes `&mut SqliteConnection`; `&mut Transaction`
    // deref-coerces to it, so pass `tx` directly (clippy::explicit_auto_deref).
    agaric_engine::loro::projection::reproject_dense_positions(tx, &ordered).await
}

/// Preflight a reverse [`OpPayload::MoveBlock`] against the CURRENT tree
/// state. `compute_reverse` reconstructs the prior placement purely from
/// op-log history, so by the time an undo/redo/revert applies it the target
/// parent may have been soft-deleted or purged, or may have become a
/// DESCENDANT of the moved block (reverting only the older of two moves).
/// The forward path validates both inside its tx (parent liveness + the
/// shared `block_descendants::move_would_cycle` probe, `move_ops.rs`);
/// without the same checks here the raw UPDATE commits a live block under a
/// tombstone (invisible in both tree and trash, hard-deleted by a later
/// purge of the parent), a dangling `parent_id` (opaque FK abort), or a
/// `parent_id` CYCLE (both subtrees unreachable from every page root).
///
/// Failures are classified [`AppError::NonReversible`] — the same contract
/// `compute_reverse` uses for ops discovered non-reversible at runtime — so
/// the interactive paths abort loudly (the whole tx rolls back) while a
/// point-in-time restore SKIPS + COUNTS the op (#2020 best-effort contract,
/// enforced pre-append in [`revert_ops_in_tx`] via
/// `reverse::is_skippable_non_reversible`).
async fn reverse_move_preflight(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    p: &agaric_store::op::MoveBlockPayload,
) -> Result<(), AppError> {
    // A move back to top level (`new_parent_id = None`) has no target parent
    // to validate and can never form a cycle.
    let Some(pid) = p.new_parent_id.as_ref().map(BlockId::as_str) else {
        return Ok(());
    };

    // Target parent must exist and be live — same probe as the forward path
    // (`move_block_in_tx`). A purged parent would otherwise abort the COMMIT
    // on the deferred `parent_id` FK; a tombstoned one would strand the moved
    // block as a live orphan.
    let parent_live = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        pid
    )
    .fetch_optional(&mut **tx)
    .await?;
    if parent_live.is_none() {
        tracing::warn!(
            block_id = %p.block_id,
            prior_parent = %pid,
            "reverse move rejected: the prior parent is missing or soft-deleted",
        );
        return Err(AppError::NonReversible {
            op_type: "move_block".into(),
        });
    }

    // Cycle probe — the SAME shared helper the forward command path
    // (`move_ops.rs`) and the materializer SQL-only fallback (`sql_only.rs`)
    // use, so the three SQL-side `parent_id` writers cannot drift.
    if agaric_store::block_descendants::move_would_cycle(&mut **tx, p.block_id.as_str(), pid)
        .await?
    {
        tracing::warn!(
            block_id = %p.block_id,
            prior_parent = %pid,
            "reverse move rejected: reparenting onto the prior parent would form a parent_id cycle",
        );
        return Err(AppError::NonReversible {
            op_type: "move_block".into(),
        });
    }
    Ok(())
}

/// #1553: Reverse a [`OpPayload::MoveBlock`] inside an existing transaction as a
/// single inseparable unit: the current-state preflight
/// ([`reverse_move_preflight`]), the raw `parent_id`/`position` UPDATE, the
/// dense 1-based reprojection of BOTH affected sibling groups, the `page_id` /
/// `space_id` re-derivation of the moved subtree, and the per-space engine
/// convergence apply.
///
/// The reverse-apply path ([`apply_reverse_in_tx`]) never enters `apply_op_tx`,
/// so the engine reprojection the forward path relies on does NOT run here. The
/// raw UPDATE writes the PROVISIONAL `new_position`
/// (`index_to_provisional_position`); without the immediately following
/// reprojection the moved block would persist that provisional rank while its
/// new siblings keep their old ranks — duplicates/gaps that never converge
/// (this path only enqueues a background CACHE rebuild). Folding the write and
/// both reprojections into one helper makes the densification structurally
/// inseparable from the raw write, so the settled position is what persists, not
/// the transient provisional one.
///
/// After the SQL settle, the SAME reverse move is driven into the shared
/// per-space Loro engine (`apply_move_block_to` with the SQL-settled slot):
/// the forward move path is engine-authoritative — it translates the
/// requested slot against the ENGINE's sibling order and dense-reprojects
/// EVERY sibling's SQL position from it — so leaving the engine on the
/// pre-undo order would make the NEXT forward move in the group silently
/// re-apply the undone move over SQL.
///
/// `extra_exclude` (#2305 cross-parent-swap fix): block ids to exclude from
/// the target sibling-group baseline IN ADDITION to `p.block_id` itself.
/// `revert_ops_in_tx`'s ascending-`(parent, slot)` batch path passes the
/// CROSS-FRAME subset of the distinct-move group here — every group member
/// whose OWN reverse targets a parent DIFFERENT from `p`'s — because the
/// target-group query below reads LIVE state, and such a sibling (its own
/// reverse hasn't run yet) may currently be sitting inside `p`'s target parent
/// (e.g. two separate moves that swap a block each BETWEEN two parents: A:
/// P1→P2, B: P2→P1, grouped into one undo — B is a permanent contaminant of
/// P1's frame until B's own reverse moves it OUT, since B's reverse never
/// inserts it back into P1). Left unexcluded, that member pollutes the
/// insertion index computed from `p.new_index`/`p.new_position` (which were
/// recorded against the ORIGINAL, group-member-free sibling set) and can land
/// the restored block one slot off — REGARDLESS of application order, LIFO or
/// ascending (verified empirically:
/// `undo_group_cross_parent_swap_restores_exact_layout_2305` in
/// `conformance.rs` fails under both orderings without this exclusion).
///
/// A group member sharing `p`'s OWN target parent must NOT be excluded: for a
/// genuine single-parent multi-select batch undo (multiple members all
/// reverting back to the SAME parent), the ascending-order insertion-sort
/// correctness relies on an earlier-processed same-parent sibling already
/// occupying its FINAL resting slot when a later sibling's baseline is read
/// (the standard array-from-permutation reconstruction) — excluding it too
/// would double-count/collide slots. (Caught empirically: a naive whole-group
/// exclusion regressed `move_blocks_batch_undo_restores_exact_original_layout_2305`
/// and `batched_move_undo_group_redo_undo_roundtrip_engine_2274`.) The
/// single-op call site (`apply_reverse_in_tx`) passes an empty set — the
/// self-exclusion below is unconditional.
async fn reverse_move_block(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    p: &agaric_store::op::MoveBlockPayload,
    extra_exclude: &std::collections::HashSet<&str>,
) -> Result<(), AppError> {
    let new_parent_id_str = p.new_parent_id.as_ref().map(BlockId::as_str);
    let move_block_id_str = p.block_id.as_str();

    // Validate the reconstructed target against the CURRENT tree (parent
    // liveness + cycle probe) BEFORE any write. `revert_ops_in_tx` runs the
    // same preflight pre-append so a point-in-time restore can SKIP the op;
    // this in-helper check is the authoritative guard for every entry point
    // (single undo, redo, batch revert).
    reverse_move_preflight(tx, p).await?;

    // #928: capture the moved block's CURRENT parent BEFORE the reverse UPDATE
    // reparents it. The reverse of a move re-homes the block from its present
    // parent (the forward move's target) back to `new_parent_id` (the forward
    // move's source). BOTH groups change membership, so — exactly like the
    // forward `apply_move_block_via_loro` — both need a dense 1-based
    // reprojection afterward.
    let old_parent_id: Option<String> =
        // dynamic-sql: test-only fixture/verification query (differential enumeration test, #2190 review).
        sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(move_block_id_str)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();

    // Raw write of the PROVISIONAL `new_position`. This rank is transient: the
    // reprojections below replace it with the settled dense 1-based position.
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

    // #928 / #2274: settle BOTH affected sibling groups to dense 1-based
    // positions.
    //
    // Target group — the payload's placement is a 0-based SLOT (`new_index`;
    // `new_position - 1` for pre-#400 payloads), so place the block at that
    // slot among the group's OTHER live siblings and densify in that explicit
    // order — the same interpretation the forward engine path gives the same
    // fields. Re-densifying by `(position, id)` with the raw provisional rank
    // (the pre-#2274 approach) is NOT faithful when that rank collides with an
    // existing sibling's: the ULID tie-break, not the slot, would decide the
    // order, so undoing/redoing a move could land the block on the wrong side
    // of a same-ranked sibling (caught by the batched-move undo→redo→undo
    // trace in `conformance.rs`).
    // dynamic-sql: test-only fixture/verification query (differential enumeration test, #2190 review).
    // `extra_exclude` (#2305) is filtered IN RUST rather than folded into the
    // SQL `WHERE` so the caller can pass an arbitrarily large distinct-move
    // group without building a dynamic `NOT IN (...)` list.
    let mut target_group: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT id FROM blocks \
         WHERE parent_id IS ? AND deleted_at IS NULL \
         ORDER BY position ASC, id ASC",
    )
    .bind(new_parent_id_str)
    .fetch_all(&mut **tx)
    .await?;
    target_group
        .retain(|id| id.as_str() != move_block_id_str && !extra_exclude.contains(id.as_str()));
    let group_len = i64::try_from(target_group.len()).unwrap_or(i64::MAX);
    let slot = p
        .new_index
        .unwrap_or_else(|| p.new_position.saturating_sub(1))
        .clamp(0, group_len);
    let slot = usize::try_from(slot).unwrap_or(target_group.len());
    target_group.insert(slot, move_block_id_str.to_owned());
    agaric_engine::loro::projection::reproject_dense_positions(tx, &target_group).await?;

    // Source group — it lost a member on a cross-parent undo and must
    // re-densify (order unchanged, so the `(position, id)` sort is exact
    // here). A same-parent undo touches a single group (old == new), already
    // settled above.
    if old_parent_id.as_deref() != new_parent_id_str {
        reproject_live_sibling_group(tx, old_parent_id.as_deref()).await?;
    }

    // #664: refresh `page_id` AND `space_id` for the moved block and its
    // descendants synchronously, mirroring `move_block_inner`. Without this sync
    // update, callers reading right after commit see a stale `page_id` /
    // `space_id` (#533) for the moved subtree until the async `RebuildPageIds`
    // materializer task lands.
    agaric_store::block_descendants::rederive_page_and_space_ids(tx, move_block_id_str).await?;

    // Drive the SAME reverse move into the shared per-space engine so its
    // fractional sibling order converges with the SQL settle above. The
    // engines are session-persistent singletons reconciled only at boot
    // replay; without this apply the engine keeps the PRE-undo order and the
    // next forward move in either affected group reprojects that stale order
    // over SQL — silently resurrecting the undone move. `slot` is the
    // SQL-settled live-sibling slot, the same interpretation
    // `apply_move_block_to` gives a forward move's `new_index`. Mirrors the
    // forward path's engine-unavailable handling (`apply_move_block_via_loro`):
    // an unresolved space or a block/parent missing from the engine falls back
    // to the SQL-only result with a breadcrumb — boot replay reconciles.
    let space_id = agaric_store::space::resolve_block_space(&mut **tx, &p.block_id).await?;
    if let Some(space_id) = space_id {
        // #2604 — record a rollback checkpoint (the reverse-move is the only
        // engine mutation on the undo/redo path, which bypasses
        // `apply_op_projected`) so an aborted undo tx rewinds it.
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        let block_in_engine = engine.read_block(move_block_id_str)?.is_some();
        let parent_in_engine = match new_parent_id_str {
            Some(pid) => engine.read_block(pid)?.is_some(),
            None => true,
        };
        if block_in_engine && parent_in_engine {
            engine.apply_move_block_to(move_block_id_str, new_parent_id_str, slot)?;
        } else {
            tracing::warn!(
                block_id = %move_block_id_str,
                "reverse move: block or prior parent missing from the per-space \
                 engine; SQL reversed without engine convergence (boot replay reconciles)",
            );
        }
        drop(guard);
    } else {
        tracing::warn!(
            block_id = %move_block_id_str,
            "reverse move: space unresolved; SQL reversed without engine \
             convergence (boot replay reconciles)",
        );
    }
    Ok(())
}

/// Mint the SINGLE timestamp for a reverse op: it becomes both the op's
/// `op_log.created_at` (via `append_local_*op_in_tx`) and any
/// `blocks.deleted_at` stamp the apply writes ([`apply_reverse_in_tx`]).
///
/// DeleteBlock reverses (undo of create / restore) take the process-monotonic
/// delete clock, exactly like the forward delete path (`delete_block_inner`):
/// `deleted_at` is the restore-cohort IDENTITY, so it must be unique per
/// delete (#1549 — two same-millisecond deletes would otherwise merge cohorts
/// and over-restore) and must equal the op's `created_at` exactly
/// (`reverse_delete_block` reconstructs `RestoreBlock { deleted_at_ref:
/// record.created_at }`). Every other reverse keeps wall-clock `now_ms`,
/// matching its forward counterpart.
fn reverse_op_timestamp(reverse_payload: &OpPayload) -> i64 {
    if matches!(reverse_payload, OpPayload::DeleteBlock(_)) {
        crate::db::next_delete_ms()
    } else {
        crate::db::now_ms()
    }
}

/// #2655: drive a reverse op's settled effect into the shared per-space Loro
/// engine, mirroring the engine-convergence block of [`reverse_move_block`].
///
/// The reverse-apply path ([`apply_reverse_in_tx`]) never enters `apply_op_tx`,
/// so — exactly like the reverse MOVE arm (#1553) — every OTHER reverse op type
/// must fan its effect onto the per-space engine itself or the engine goes stale
/// after an undo/redo/revert. The staleness is not cosmetic: an undo-of-create
/// that tombstones the row in SQL but leaves the engine node LIVE trips the
/// #1257 sync-export freshness gate (`prepare_outgoing` sees an engine-live
/// block SQL has soft-deleted → `Ok(None)`), silently suspending p2p sync for
/// the WHOLE space until the app restarts (#2655).
///
/// `space_id` MUST be resolved by the caller at the correct moment: BEFORE a
/// soft-delete (`resolve_block_space` filters tombstones, so a post-delete
/// resolve returns `None`), AFTER a restore (once the block is live again), or
/// while the block is live for edit/property/tag reverses. A `None` space warns
/// and leaves the SQL write as the durable outcome — identical to the
/// reverse-move fallback (boot replay reconciles).
///
/// `apply` runs the SYNCHRONOUS engine mutation(s) under the recording guard
/// (the #2604 rollback checkpoint, armed by the caller via
/// `tx.arm_engine_rollback`); it must NOT `.await` — the `EngineGuard` is
/// `!Send` and cannot cross an await point.
fn drive_reverse_engine(
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    space_id: Option<agaric_store::space::SpaceId>,
    op_label: &str,
    apply: impl FnOnce(&mut agaric_engine::loro::engine::LoroEngine) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let Some(space_id) = space_id else {
        tracing::warn!(
            op = op_label,
            "reverse {op_label}: space unresolved; SQL reversed without engine \
             convergence (boot replay reconciles)",
        );
        return Ok(());
    };
    let mut guard = state
        .registry
        .for_space_recording(&space_id, device_id, &state.revert)?;
    apply(guard.engine_mut())?;
    drop(guard);
    Ok(())
}

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
///
/// #2325/#2250 — INTENTIONAL EXCEPTION to the single-entry-point apply collapse.
/// Undo/redo applies the *reverse* effect via bespoke reverse SQL (it is NOT an
/// op replayed through `apply_op_projected`/`apply_op_tx`); this is a documented,
/// permanent exception (Stage 3), NOT a site to route through the collapsed
/// projection. Leave the SQL projection as reverse SQL.
///
/// #2655 — but the SQL write alone is not enough: the per-space Loro engine is
/// what sync exports, so EVERY engine-modeled reverse arm additionally fans its
/// settled effect onto the engine (via [`drive_reverse_engine`], mirroring the
/// MoveBlock arm's #1553 convergence). Without this the engine goes stale after
/// an undo/redo/revert — and an undo-of-create leaves an engine-live block SQL
/// has soft-deleted, tripping the #1257 sync-export freshness gate and silently
/// suspending p2p sync for the whole space until reboot (#2655). The engine
/// drives here:
///   * DeleteBlock (undo-of-create / reverse-of-restore) — tombstone the cohort;
///   * RestoreBlock (undo-of-delete / redo-of-create) — restore the cohort + the
///     restored ancestor chain;
///   * EditBlock — diff-splice back to the prior text;
///   * SetProperty / DeleteProperty — set/clear the engine property (the
///     column-backed `space` key is EXCLUDED, exactly as the forward path
///     `apply_set_property_via_loro` never stores it in the engine property map);
///   * AddTag / RemoveTag — mirror the tag association.
///
/// Attachment reverses (DeleteAttachment / RenameAttachment / AddAttachment) stay
/// SQL-only: attachments are NOT modeled in the engine, so there is nothing to
/// converge and they cannot trip the block-scoped #1257 gate.
///
/// `op_created_at` is the SAME timestamp the caller bound as the reverse op's
/// `op_log.created_at` (mint it via [`reverse_op_timestamp`]). The DeleteBlock
/// arm stamps it into `blocks.deleted_at`, preserving the forward-path cohort
/// invariant `op.created_at == blocks.deleted_at` (#1549): `reverse_delete_block`
/// later reconstructs `RestoreBlock { deleted_at_ref: record.created_at }`, so
/// a second independent clock read here would make redo-of-that-undo match
/// ZERO rows and silently no-op.
pub async fn apply_reverse_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    reverse_payload: &OpPayload,
    op_created_at: i64,
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
            // `agaric_store::block_descendants`.
            //
            // Page_id is invariant under re-delete; the
            // descendants keep their existing `page_id` and on next
            // restore the M6/restore-path (`restore_block_inner` or
            // `OpPayload::RestoreBlock` below) picks them up. No
            // page_id work is needed here.
            //
            // Cohort invariant (#1549): stamp the CALLER-minted op timestamp,
            // never a fresh `now_ms()` — `deleted_at` must equal the reverse
            // op's `created_at` exactly or the matching redo/undo
            // `RestoreBlock { deleted_at_ref }` finds zero rows.
            //
            // R27: walk depth-UNBOUNDED (batched capped CTEs) + json_each
            // UPDATE — the same shape as `project_delete_block_to_sql` — so
            // an undo-produced delete of a merged tree deeper than the
            // depth-100 cap tombstones the WHOLE subtree instead of leaving
            // a live tail stranded under tombstoned ancestors.
            let now = op_created_at;
            let cohort = agaric_store::block_descendants::collect_subtree_ids_unbounded(
                tx,
                p.block_id.as_str(),
                agaric_store::block_descendants::DescendantWalkFilter::Active,
            )
            .await?;
            // #2655: resolve the space from the seed BEFORE the cascade tombstones
            // it — `resolve_block_space` filters `deleted_at IS NULL`, so a
            // post-delete resolve returns None. Mirrors the forward delete path
            // (`apply_delete_block_via_loro`), which likewise resolves first.
            let space_id = agaric_store::space::resolve_block_space(&mut **tx, &p.block_id).await?;
            // Borrowed serialization (`to_string(&cohort)`) so `cohort` stays
            // alive for the engine fan-out below; `serde_json::Error` converts to
            // `AppError::Json`.
            let cohort_json = serde_json::to_string(&cohort)?;
            // dynamic-sql: json_each id-list UPDATE over the walked cohort;
            // single bound JSON parameter, immune to the SQLite variable limit.
            sqlx::query(
                "UPDATE blocks SET deleted_at = ?2 \
                 WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL",
            )
            .bind(&cohort_json)
            .bind(now)
            .execute(&mut **tx)
            .await?;

            // #2655: tombstone the SAME cohort in the per-space engine so its
            // `live_block_ids()` no longer holds a block SQL has soft-deleted —
            // the exact #1257 freshness-gate divergence that suspends sync. The
            // per-id present-guard mirrors the forward path (engine
            // `apply_delete_block` errors on an absent node); stamp the SAME
            // `op_created_at` the SQL cascade wrote (engine `deleted_at` is a
            // String slot, #109 Phase 2), matching `apply_delete_block_via_loro`.
            // `cohort` was collected with the `Active` filter, so it holds only
            // currently-live ids — identical membership to the `deleted_at IS
            // NULL` SQL guard above.
            let deleted_at_str = now.to_string();
            drive_reverse_engine(state, device_id, space_id, "delete_block", |engine| {
                for id in &cohort {
                    if engine.read_block(id)?.is_some() {
                        engine.apply_delete_block(id, &deleted_at_str)?;
                    }
                }
                Ok(())
            })?;
        }
        OpPayload::RestoreBlock(p) => {
            // Cascade restore (same as restore_block_inner).
            //
            // R27: cohort-contiguous, depth-UNBOUNDED walk + json_each
            // UPDATE — the same shape as `restore_block_inner` /
            // `project_restore_block_to_sql` / `collect_restore_cohort` —
            // so undo/revert restores the WHOLE cohort of a merged tree
            // deeper than the depth-100 cap.
            let cohort = agaric_store::block_descendants::collect_subtree_ids_unbounded(
                tx,
                p.block_id.as_str(),
                agaric_store::block_descendants::DescendantWalkFilter::Cohort(p.deleted_at_ref),
            )
            .await?;
            // #2655: borrowed serialization keeps `cohort` alive for the engine
            // fan-out at the end of this arm.
            let cohort_json = serde_json::to_string(&cohort)?;
            // dynamic-sql: json_each id-list UPDATE over the walked cohort;
            // single bound JSON parameter, immune to the SQLite variable limit.
            sqlx::query(
                "UPDATE blocks SET deleted_at = NULL \
                 WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at = ?2",
            )
            .bind(&cohort_json)
            .bind(p.deleted_at_ref)
            .execute(&mut **tx)
            .await?;

            // #1884: also restore UPWARD, mirroring the two other restore
            // writers (`restore_block_inner`, `project_restore_block_to_sql`).
            // The downward cohort UPDATE alone leaves the block LIVE under a
            // still-tombstoned parent when that parent was deleted SEPARATELY
            // (its cascade skipped the already-deleted block, so the block
            // kept its own cohort): invisible in both the tree and trash, and
            // hard-deleted by a later purge of the parent. Walk the contiguous
            // soft-deleted ancestor chain up to the nearest live ancestor and
            // clear it. Idempotent (an already-live chain restores nothing),
            // preserving the batch-undo idempotency policy above.
            // (`&mut Transaction` deref-coerces to `&mut SqliteConnection`,
            // so pass `tx` directly — clippy::explicit_auto_deref.)
            // #2655: keep the FULL restored chain (`chain`), not only `topmost`
            // — the engine fan-out below re-clears `deleted_at` on every restored
            // ancestor so the CRDT converges with the SQL UPDATE (mirrors the
            // forward path's `dispatch_restore_ancestors`, #2017).
            let restored_chain = agaric_store::block_descendants::restore_deleted_ancestor_chain(
                tx,
                p.block_id.as_str(),
            )
            .await?;
            let restored_ancestor_top = restored_chain.topmost.clone();

            // Idempotency guard: the reverse of a delete may target a block
            // that was since PURGED (row gone). The cohort UPDATE above
            // matched zero rows — fine per the idempotency policy — but the
            // page/space re-derivation reads the seed row and errors on a
            // missing block, so probe first.
            let seed_id = p.block_id.as_str();
            let seed_row = sqlx::query!(
                "SELECT deleted_at, block_type FROM blocks WHERE id = ?",
                seed_id
            )
            .fetch_optional(&mut **tx)
            .await?;
            if seed_row.is_some() {
                // #664: refresh `page_id` AND `space_id` for the restored
                // subtree synchronously, mirroring `restore_block_inner` and
                // ultimately `move_block_inner`. Without this sync update,
                // callers reading right after commit can see a stale `page_id`
                // (the moved-then-deleted descendant case described in
                // `restore_block_inner`) or stale `space_id` (#533). Before
                // #664 this arm open-coded the chain and had drifted to skip
                // the `space_id` step; routing through the shared helper makes
                // the complete behaviour structurally impossible to drift.
                agaric_store::block_descendants::rederive_page_and_space_ids(
                    tx,
                    p.block_id.as_str(),
                )
                .await?;

                // #1884: when an ancestor chain was restored above, ALSO
                // re-derive from the TOPMOST restored ancestor so the whole
                // reconnected subtree — not just `block_id`'s — is refreshed,
                // mirroring `restore_block_inner`'s `inheritance_root`.
                if let Some(ref top) = restored_ancestor_top {
                    agaric_store::block_descendants::rederive_page_and_space_ids(tx, top).await?;
                }

                // #2655: converge the per-space engine with the SQL restore. The
                // seed is now LIVE again (its `deleted_at` cleared above), so
                // `resolve_block_space` — which filters tombstones — resolves it.
                // `apply_restore_block` is idempotent and silently no-ops on an
                // absent node, so re-clearing an already-live cohort/chain member
                // (or one never in the engine) is harmless. Restoring the cohort
                // clears the engine tombstones the reverse-of-restore / redo path
                // set; restoring the ancestor chain mirrors the forward path's
                // `dispatch_restore_ancestors` (#2017) so a later reproject does
                // not re-delete the reconnected ancestors in SQL.
                let space_id =
                    agaric_store::space::resolve_block_space(&mut **tx, &p.block_id).await?;
                drive_reverse_engine(state, device_id, space_id, "restore_block", |engine| {
                    for id in cohort.iter().chain(restored_chain.chain.iter()) {
                        engine.apply_restore_block(id)?;
                    }
                    Ok(())
                })?;
            }
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

            // #2655: splice the prior text into the per-space engine's `LoroText`
            // so the CRDT matches the SQL content, mirroring the forward
            // `apply_edit_block_via_loro`. `apply_edit_via_diff_splice` computes
            // the minimal diff from the engine's CURRENT content to `to_text`,
            // and the block is live (the UPDATE matched a row), so it resolves a
            // space. The present-guard mirrors the forward path's block-absent
            // fallback.
            let space_id = agaric_store::space::resolve_block_space(&mut **tx, &p.block_id).await?;
            drive_reverse_engine(state, device_id, space_id, "edit_block", |engine| {
                if engine.read_block(block_id_str)?.is_some() {
                    engine.apply_edit_via_diff_splice(block_id_str, &p.to_text)?;
                }
                Ok(())
            })?;
        }
        OpPayload::MoveBlock(p) => {
            // #1553: the preflight + raw write + both sibling-group reprojections
            // + page/space re-derivation + engine convergence are encapsulated in
            // `reverse_move_block` so the dense reprojection (which replaces the
            // provisional `new_position` with the settled 1-based rank) cannot be
            // separated from the raw write.
            reverse_move_block(tx, state, device_id, p, &std::collections::HashSet::new()).await?;
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

            // #2655: mirror the tag association into the per-space engine's
            // `block_tags` map (idempotent, per-key LWW), matching the forward
            // `apply_add_tag_via_loro`, so the exported CRDT carries the tag.
            let space_id = agaric_store::space::resolve_block_space(&mut **tx, &p.block_id).await?;
            drive_reverse_engine(state, device_id, space_id, "add_tag", |engine| {
                if engine.read_block(block_id_str)?.is_some() {
                    engine.apply_add_tag(block_id_str, tag_id_str)?;
                }
                Ok(())
            })?;
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

            // #2655: mirror the tag removal into the per-space engine (idempotent
            // — no-ops when the tag is absent), matching the forward
            // `apply_remove_tag_via_loro`.
            let space_id = agaric_store::space::resolve_block_space(&mut **tx, &p.block_id).await?;
            drive_reverse_engine(state, device_id, space_id, "remove_tag", |engine| {
                if engine.read_block(block_id_str)?.is_some() {
                    engine.apply_remove_tag(block_id_str, tag_id_str)?;
                }
                Ok(())
            })?;
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
            agaric_engine::loro::projection::project_set_property_to_sql(tx, p).await?;

            // #2655: mirror the property write into the per-space engine's
            // property map, matching the forward `apply_set_property_via_loro`.
            // The `space` key is EXCLUDED: it is column-backed in `blocks` (not a
            // `block_properties` row) and its forward handling is the subtree
            // hydration special-case — the forward path NEVER stores `space` in
            // the engine property map, so applying it here would inject a spurious
            // property. `space`-key reverses stay SQL-only (they cannot trip the
            // block-scoped #1257 gate). Reserved non-space keys (todo_state /
            // priority / due_date / scheduled_date) DO enter the engine map on the
            // forward path, so they are driven here too. `PropertyValue::from(p)`
            // recovers the native typed value by the same precedence the forward
            // path uses.
            if p.key != agaric_store::op::SPACE_PROPERTY_KEY {
                let space_id =
                    agaric_store::space::resolve_block_space(&mut **tx, &p.block_id).await?;
                drive_reverse_engine(state, device_id, space_id, "set_property", |engine| {
                    if engine.read_block(p.block_id.as_str())?.is_some() {
                        let value = agaric_engine::loro::engine::PropertyValue::from(p);
                        engine.apply_set_property_typed(p.block_id.as_str(), &p.key, &value)?;
                    }
                    Ok(())
                })?;
            }
        }
        OpPayload::DeleteProperty(p) => {
            // #604: same routing note as SetProperty above — reserved keys
            // NULL their `blocks` column, `space` NULLs `space_id` for the
            // owning-page group, generic keys DELETE the `block_properties`
            // row. All branches are idempotent (0-row UPDATE/DELETE no-ops).
            agaric_engine::loro::projection::project_delete_property_to_sql(
                tx,
                p.block_id.as_str(),
                &p.key,
            )
            .await?;

            // #2655: clear the key from the per-space engine property map
            // (idempotent — no-ops when the key is absent), matching the forward
            // `apply_delete_property_via_loro`. The `space` key is EXCLUDED for
            // the same reason as the SetProperty arm above (column-backed; never
            // in the engine property map).
            if p.key != agaric_store::op::SPACE_PROPERTY_KEY {
                let space_id =
                    agaric_store::space::resolve_block_space(&mut **tx, &p.block_id).await?;
                drive_reverse_engine(state, device_id, space_id, "delete_property", |engine| {
                    if engine.read_block(p.block_id.as_str())?.is_some() {
                        engine.apply_delete_property(p.block_id.as_str(), &p.key)?;
                    }
                    Ok(())
                })?;
            }
        }
        OpPayload::DeleteAttachment(p) => {
            // C7 (#345): hard-DELETE the row to match the runtime /
            // materializer model. The forward `delete_attachment` path
            // (`materializer::handlers::apply_delete_attachment_tx`) hard-
            // deletes the row, and the runtime command
            // (`commands::attachments::delete_attachment_inner`) deletes the
            // row and defers byte reclamation to the GC pass (#1993). Undo is
            // the *only* producer of soft-deleted
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
/// Phase 8 — `scope` narrows the global (`page_id == "__all__"`)
/// query. [`SpaceScope::Active`] restricts the result set to ops whose
/// `payload.block_id` belongs to the named space.
/// [`SpaceScope::Global`] is the unscoped (cross-space) view.
/// The `scope` is ignored in per-page mode (a real ULID `page_id` is
/// already space-bound).
#[instrument(skip_all, fields(page_id, limit), err)]
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
#[instrument(skip_all, fields(ops_count = ops.len()), err)]
pub async fn revert_ops_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    ops: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    if ops.is_empty() {
        return Ok(vec![]);
    }

    // Open the IMMEDIATE write transaction, run the whole revert inside it,
    // then commit + fire dispatches.
    //
    // `CommandTx` couples the BEGIN IMMEDIATE + commit +
    // post-commit `dispatch_background_or_warn` steps so a failed commit
    // cannot leak queued records to the materializer, and a missing
    // dispatch is structurally impossible (commit_and_dispatch drains
    // the pending queue in order).
    let mut tx = CommandTx::begin_immediate(pool, "revert_ops").await?;
    // #2604 — rollback-safe engine apply: an aborted undo/revert tx rewinds the
    // reverse-move engine mutation (see `reverse_move_block`).
    tx.arm_engine_rollback(materializer.loro_state());
    // Interactive batch undo preserves the historical contract: a single
    // non-reversible op aborts the whole revert (skip_non_reversible =
    // false). The discarded skip count is irrelevant on this path.
    let (results, _skipped) = revert_ops_in_tx(
        &mut tx,
        pool,
        materializer.loro_state(),
        device_id,
        ops,
        false,
    )
    .await?;

    // Commits, then fires queued dispatches in enqueue order. If commit
    // fails, no dispatches fire.
    tx.commit_and_dispatch(materializer).await?;

    Ok(results)
}

/// Compute and apply reverse ops for `ops` inside an already-open IMMEDIATE
/// transaction, enqueueing the produced records on `tx` for post-commit
/// dispatch. The caller owns the BEGIN IMMEDIATE / commit boundary.
///
/// Factored out of [`revert_ops_inner`] so that
/// [`restore_page_to_op_inner`] can run *its* ops-to-revert SELECT inside the
/// same transaction that performs the revert, closing the TOCTOU window where
/// an op landing between the membership read and the write would keep its
/// forward effect (issue #1551).
///
/// `skip_non_reversible` selects the per-op non-reversible policy, unified
/// through [`reverse::is_skippable_non_reversible`] (#2020):
///   * `false` (interactive batch undo) — a single non-reversible op in the
///     batch aborts the whole revert before any reverse is applied.
///   * `true` (point-in-time restore) — non-reversible ops are SKIPPED and
///     COUNTED; the reversible remainder is applied.
///
/// Returns `(results, non_reversible_skipped)`. The skip count is always 0
/// when `skip_non_reversible` is `false` (such a batch errors out instead).
async fn revert_ops_in_tx(
    tx: &mut CommandTx,
    pool: &SqlitePool,
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    ops: Vec<OpRef>,
    skip_non_reversible: bool,
) -> Result<(Vec<UndoResult>, u64), AppError> {
    use crate::reverse;

    if ops.is_empty() {
        return Ok((vec![], 0));
    }

    // C5 (#344): bound the batch size before any DB work. This is the
    // single choke point for both interactive batch undo (`revert_ops`)
    // and point-in-time restore (`restore_page_to_op_inner`), so the cap
    // is enforced once here rather than at every caller.
    if ops.len() > MAX_REVERT_OPS {
        return Err(AppError::validation(format!(
            "cannot revert {} ops in a single batch (maximum is {MAX_REVERT_OPS})",
            ops.len()
        )));
    }

    let mut non_reversible_skipped: u64 = 0;

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
    // These reads target already-committed ops (the records being reverted),
    // so they run against the bare pool. The membership read that decides
    // *which* ops are reverted — `restore_page_to_op_inner`'s ops-to-revert
    // SELECT — runs inside `tx` so it shares the IMMEDIATE write lock.
    // #2549: refuse to revert a REPLICATED audit op (`is_replicated = 1`,
    // #2481/#2495). Such rows were ingested for provenance only and never
    // applied to local state, so applying their inverse would corrupt local
    // state by "undoing" a forward effect that never happened here. Reject
    // before any reverse is computed or applied.
    reverse::reject_replicated_targets(pool, &ops).await?;
    let records = reverse::get_op_records_batch(pool, &ops).await?;
    // #2020: `compute_reverse_batch` returns a per-op `Result`. A
    // non-reversible op surfaces as an inner `Err(NonReversible)` (e.g. a
    // position-less `move_block`, a `delete_attachment` whose paired
    // `add_attachment` is gone, or a `purge_block`) — the SAME unified
    // mechanism that subsumes the old static `[purge_block,
    // delete_attachment]` skip list. The non-reversible *contract* lives
    // in `reverse::is_skippable_non_reversible`.
    let reverse_payloads = reverse::compute_reverse_batch(pool, &records).await?;
    let mut reverses: Vec<(OpRef, OpPayload, i64, String)> = Vec::with_capacity(ops.len());
    for ((op_ref, reverse_payload), record) in ops.iter().zip(reverse_payloads).zip(records.iter())
    {
        let reverse_payload = match reverse_payload {
            Ok(p) => p,
            // Per-op non-reversible. Restore SKIPS+COUNTS it and presses
            // on; interactive undo aborts the whole batch (preserving the
            // historical contract). `compute_reverse_batch` only emits an
            // inner `Err` for skippable non-reversible ops, so any other
            // error already aborted via `?` on the call above.
            Err(e) => {
                if skip_non_reversible && reverse::is_skippable_non_reversible(&e) {
                    non_reversible_skipped += 1;
                    continue;
                }
                return Err(e);
            }
        };
        reverses.push((
            op_ref.clone(),
            reverse_payload,
            record.created_at,
            record.op_type.clone(),
        ));
    }

    // Sort newest-first (by created_at DESC, seq DESC, device_id DESC). This is
    // the RESULTS order the caller returns (the FE redo stack + activity feed
    // depend on it) AND the default APPLICATION order (LIFO — the correct inverse
    // when a later op in the group depends on an earlier op's effect on the SAME
    // entity, e.g. a block moved twice).
    reverses.sort_by(|a, b| {
        b.2.cmp(&a.2) // created_at DESC
            .then_with(|| b.0.seq.cmp(&a.0.seq)) // seq DESC
            .then_with(|| b.0.device_id.cmp(&a.0.device_id)) // device_id DESC
    });

    // #2305 (Refs #914): APPLICATION order may differ from RESULTS order. The
    // per-op reverse of a move restores the block to a slot recorded in the
    // ORIGINAL tree frame; applying a group of DISTINCT-block move reverses
    // newest-first does NOT reconstruct the pre-batch layout after a
    // contiguous-run batch move — a not-yet-restored member displaces the target
    // slot of the one being restored (e.g. undoing [A,B,C,D] → B,D,A,C would land
    // C after D). Applying the reverses in ASCENDING (parent, slot) order —
    // insertion-sort order — instead restores each member to its original index
    // against an already-rebuilt prefix, reproducing the EXACT original tree.
    //
    // This reorder is sound ONLY for a group of MoveBlock reverses on DISTINCT
    // blocks (a multi-select drag undo): distinct blocks moved once each are
    // independent, so no LIFO dependency exists, and inserting each at its
    // recorded original index in ascending order is the standard array-from-
    // permutation reconstruction. Any other group (a same-block move sequence
    // that needs LIFO, or a mixed group) keeps the newest-first order. The
    // RESULTS Vec is re-sorted newest-first below regardless, so the redo stack
    // is unaffected.
    let distinct_move_group = reverses.len() > 1
        && reverses
            .iter()
            .all(|(_, p, _, _)| matches!(p, OpPayload::MoveBlock(_)))
        && {
            let mut ids: Vec<&str> = reverses
                .iter()
                .filter_map(|(_, p, _, _)| match p {
                    OpPayload::MoveBlock(m) => Some(m.block_id.as_str()),
                    _ => None,
                })
                .collect();
            let n = ids.len();
            ids.sort_unstable();
            ids.dedup();
            ids.len() == n
        };
    // #2305 cross-parent-swap fix: block_id -> the reverse-target parent it
    // will land under, for every member of a distinct-move group. Threaded
    // down to `reverse_move_block` (per-op, see the apply loop below) so a
    // sibling group member whose OWN reverse targets a DIFFERENT parent — and
    // which may currently be sitting inside THIS op's target parent because
    // its own reverse hasn't run yet — never pollutes this op's live-sibling
    // insertion index. A group member sharing the SAME target parent must stay
    // VISIBLE (not excluded): the ascending-order insertion-sort correctness
    // (see the doc block above) relies on each earlier-processed same-parent
    // sibling already occupying its final resting slot when a later sibling's
    // baseline is read; excluding it too would double-count/collide slots
    // (this was caught empirically —
    // `move_blocks_batch_undo_restores_exact_original_layout_2305` and
    // `batched_move_undo_group_redo_undo_roundtrip_engine_2274` both regressed
    // under a naive whole-group exclusion). See `reverse_move_block`'s doc
    // comment.
    let group_target_parent: std::collections::HashMap<&str, Option<&str>> = if distinct_move_group
    {
        reverses
            .iter()
            .filter_map(|(_, p, _, _)| match p {
                OpPayload::MoveBlock(m) => Some((
                    m.block_id.as_str(),
                    m.new_parent_id.as_ref().map(BlockId::as_str),
                )),
                _ => None,
            })
            .collect()
    } else {
        std::collections::HashMap::new()
    };

    // Application order = indices into `reverses`.
    let mut apply_order: Vec<usize> = (0..reverses.len()).collect();
    if distinct_move_group {
        // Ascending (parent, 0-based slot); ties by original seq for determinism.
        let key = |idx: usize| -> (String, i64, i64) {
            match &reverses[idx].1 {
                OpPayload::MoveBlock(m) => (
                    m.new_parent_id
                        .as_ref()
                        .map(|b| b.as_str().to_owned())
                        .unwrap_or_default(),
                    m.new_index
                        .unwrap_or_else(|| m.new_position.saturating_sub(1)),
                    reverses[idx].0.seq,
                ),
                _ => (String::new(), 0, reverses[idx].0.seq),
            }
        };
        apply_order.sort_by_key(|&i| key(i));
    }

    // Phase 2: Apply all reverses inside the caller's IMMEDIATE transaction.
    // Collected in APPLICATION order tagged with the original op's `created_at`,
    // then re-sorted newest-first to preserve the returned-order contract.
    let mut results_tagged: Vec<(i64, UndoResult)> = Vec::with_capacity(reverses.len());

    for idx in apply_order {
        let (op_ref, reverse_payload, created_at, reversed_op_type) = &reverses[idx];
        // Preflight state-dependent reverses against the CURRENT (in-tx) tree
        // BEFORE appending: a reverse move whose reconstructed prior parent is
        // gone/tombstoned, or that would form a `parent_id` cycle, is
        // non-reversible against today's tree. Checking pre-append keeps the
        // append-only op_log free of never-applied reverse ops when the
        // point-in-time restore path SKIPS the op (#2020); the interactive
        // paths (`skip_non_reversible = false`) abort the whole batch with the
        // same classified error — the tx rolls back, nothing is applied.
        if let OpPayload::MoveBlock(p) = reverse_payload
            && let Err(e) = reverse_move_preflight(tx, p).await
        {
            if skip_non_reversible && reverse::is_skippable_non_reversible(&e) {
                non_reversible_skipped += 1;
                continue;
            }
            return Err(e);
        }

        let new_op_type = reverse_payload.op_type_str().to_owned();

        // Append reverse op to log first, then apply — same order as
        // undo_page_op_inner / redo_page_op_inner.  The clone is needed
        // because append_local_op_in_tx consumes the payload.
        // #659: batch reverts are undo-producing too — their `new_op_ref`s
        // are legitimate redo targets (activity-feed / point-in-time
        // restore undo), so flag them `is_undo = 1` like the interactive
        // undo path.
        //
        // ONE timestamp for the append AND the apply (`reverse_op_timestamp`):
        // the DeleteBlock arm stamps it into `blocks.deleted_at`, and the
        // cohort invariant `op.created_at == blocks.deleted_at` (#1549) is
        // what lets a later undo/redo of this reverse find its rows.
        // #2468: stamp the reversed op's ref (`reverses_*`, migration 0101)
        // so the ref-addressed undo's already-reversed guard sees reverses
        // produced by EVERY path (batch revert, group undo, ref undo,
        // restore), not just `undo_op`/`undo_ops` themselves.
        let op_ts = reverse_op_timestamp(reverse_payload);
        let op_record = op_log::append_local_undo_op_in_tx(
            tx,
            device_id,
            reverse_payload.clone(),
            op_ts,
            op_ref,
        )
        .await?;

        // #2305: a distinct-move group's MoveBlock reverses bypass
        // `apply_reverse_in_tx` and call `reverse_move_block` directly so
        // OTHER group members targeting a DIFFERENT parent than this op are
        // excluded from the target sibling-group baseline — see
        // `reverse_move_block`'s doc comment. Same-target-parent siblings stay
        // visible (not excluded), preserving the ascending-order insertion-sort
        // correctness for a genuine single-parent multi-select batch undo.
        if distinct_move_group && let OpPayload::MoveBlock(p) = reverse_payload {
            let this_target = p.new_parent_id.as_ref().map(BlockId::as_str);
            let cross_frame_exclude: std::collections::HashSet<&str> = group_target_parent
                .iter()
                .filter(|&(&id, &target)| id != p.block_id.as_str() && target != this_target)
                .map(|(&id, _)| id)
                .collect();
            reverse_move_block(tx, state, device_id, p, &cross_frame_exclude).await?;
        } else {
            apply_reverse_in_tx(tx, state, device_id, reverse_payload, op_ts).await?;
        }

        results_tagged.push((
            *created_at,
            UndoResult {
                reversed_op: op_ref.clone(),
                reversed_op_type: reversed_op_type.clone(),
                new_op_ref: OpRef {
                    device_id: op_record.device_id.clone(),
                    seq: op_record.seq,
                },
                new_op_type,
                is_redo: false,
            },
        ));

        tx.enqueue_background(op_record);
    }

    // Re-sort results newest-first (created_at DESC, seq DESC, device_id DESC) —
    // the returned-order contract, independent of the application order above.
    results_tagged.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.reversed_op.seq.cmp(&a.1.reversed_op.seq))
            .then_with(|| b.1.reversed_op.device_id.cmp(&a.1.reversed_op.device_id))
    });
    let results: Vec<UndoResult> = results_tagged.into_iter().map(|(_, r)| r).collect();

    Ok((results, non_reversible_skipped))
}

/// Restore a page to its state at a specific operation (point-in-time restore).
///
/// Finds all ops that occurred AFTER the target op on blocks belonging to the
/// given page (or all blocks if `page_id == "__all__"`) and reverts them inside
/// a single IMMEDIATE transaction. Non-reversible ops are SKIPPED and counted
/// (`non_reversible_skipped`) rather than aborting the restore (#2020): the
/// revert path classifies them through `reverse::is_skippable_non_reversible`,
/// so both statically non-reversible op-types (`purge_block`,
/// `delete_attachment`) and ops only discovered to be non-reversible at runtime
/// (a position-less `move_block`, a `delete_attachment` whose paired
/// `add_attachment` is gone) are skipped uniformly. The restore completes and
/// reverses everything that CAN be reversed.
///
/// # Snapshot semantics — atomic read+revert (#1551)
///
/// The ops-to-revert membership SELECT runs **inside** the same
/// `BEGIN IMMEDIATE` transaction that performs the revert (it executes on
/// `tx`, sharing the write lock). There is therefore no TOCTOU window: an
/// op landing between deciding *which* ops to revert and applying the
/// reverses cannot slip through. Because `BEGIN IMMEDIATE` takes the
/// database write lock up front, any concurrent writer (sync replay or a
/// concurrent local edit) is serialized — it either commits strictly
/// before this transaction's membership read (and so is seen and reverted)
/// or strictly after the commit (and so is correctly excluded), never in
/// between.
///
/// The target op's `created_at` is still sourced ahead of the transaction:
/// it reads a single already-committed op by `(device_id, seq)` whose
/// timestamp is immutable, so it is not part of the membership decision and
/// cannot be affected by a concurrent write.
#[instrument(skip_all, fields(page_id, target_seq), err)]
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

    // #1551: open the IMMEDIATE write transaction up front so the
    // ops-to-revert membership SELECT below runs *inside* the same
    // transaction that applies the reverses. This takes the database write
    // lock before the read, eliminating the TOCTOU window in which an op
    // landing between "which ops to revert" and "apply the reverses" would
    // keep its forward effect. See the `Snapshot semantics` doc-block above.
    let mut tx = CommandTx::begin_immediate(pool, "restore_page_to_op").await?;
    // #2604 — rollback-safe engine apply (rewind reverse-move on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Query all ops after the target — executed on `tx` (the IMMEDIATE
    // transaction), not the bare pool.
    // NOTE: We intentionally do NOT filter by deleted_at IS NULL in the blocks subquery.
    // We need to find ops on blocks that may have been deleted after the target point,
    // since restoring to that point means un-deleting those blocks.
    let ops_after: Vec<(String, i64, String)> = if page_id == "__all__" {
        sqlx::query!(
            // #2549: `AND is_replicated = 0` — this sweep feeds
            // `revert_ops_in_tx`, whose `reject_replicated_targets` guard
            // rejects the WHOLE batch if it sees a replicated op. A #2495
            // audit-only row (foreign device, never applied to local state)
            // touching the same block/page after the target timestamp must
            // not be swept in here — it has no local forward effect to
            // undo, so it belongs out of scope entirely rather than aborting
            // an otherwise-legitimate point-in-time restore.
            "SELECT device_id, seq, op_type FROM op_log \
             WHERE is_replicated = 0 \
             AND (created_at > ?1 OR (created_at = ?1 AND (seq > ?2 OR (seq = ?2 AND device_id > ?3)))) \
             ORDER BY created_at DESC, seq DESC, device_id DESC",
            target_ts,
            target_seq,
            target_device_id,
        )
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .map(|r| (r.device_id, r.seq, r.op_type))
        .collect()
    } else {
        // #2201: materialize the page subtree ONCE and feed it to the op-log
        // scan as a `json_each` id list. The previous shape inlined a
        // `WITH RECURSIVE page_blocks(...)` CTE and referenced it TWICE
        // (block-op membership + the attachments EXISTS probe), letting
        // SQLite re-evaluate the recursive walk per reference. The walk uses
        // `DescendantWalkFilter::All` (NO deleted_at filter — see the NOTE
        // above: ops on blocks deleted after the target must still be found)
        // and runs on `tx`, so the subtree read stays inside the same
        // IMMEDIATE transaction as the membership SELECT (#1551 atomicity).
        // The batched walker keeps invariant #9 per batch
        // (depth<100: DESCENDANT_DEPTH_CAP, see block_descendants).
        let subtree_ids = agaric_store::block_descendants::collect_subtree_ids_unbounded(
            &mut tx,
            &page_id,
            agaric_store::block_descendants::DescendantWalkFilter::All,
        )
        .await?;
        // sqlx requires `String` (NOT `Vec<String>`) for `json_each(?)`
        let subtree_json = serde_json::Value::from(subtree_ids).to_string();
        sqlx::query!(
            // #2549: `AND o.is_replicated = 0` — see the matching note on
            // the `__all__` branch above; a replicated audit row must not
            // be swept into a page-scoped restore either.
            "SELECT o.device_id, o.seq, o.op_type FROM op_log o \
             WHERE ( \
               o.block_id IN (SELECT value FROM json_each(?1)) \
               OR (o.op_type IN ('delete_attachment', 'rename_attachment') AND EXISTS ( \
                   SELECT 1 FROM attachments a \
                   WHERE a.id = json_extract(o.payload, '$.attachment_id') \
                   AND a.block_id IN (SELECT value FROM json_each(?1)) \
               )) \
             ) \
             AND o.is_replicated = 0 \
             AND (o.created_at > ?2 OR (o.created_at = ?2 AND (o.seq > ?3 OR (o.seq = ?3 AND o.device_id > ?4)))) \
             ORDER BY o.created_at DESC, o.seq DESC, o.device_id DESC",
            subtree_json,
            target_ts,
            target_seq,
            target_device_id,
        )
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .map(|r| (r.device_id, r.seq, r.op_type))
        .collect()
    };

    // #2020: split the swept suffix through the UNIFIED non-reversible
    // contract, which has two halves living in `reverse`:
    //
    //   * STATIC (`reverse::is_statically_non_reversible`) — op-types a
    //     restore skips on sight (`purge_block`, `delete_attachment`),
    //     filtered + counted here.
    //   * DYNAMIC (`reverse::is_skippable_non_reversible`) — ops that
    //     `compute_reverse_batch` only discovers to be non-reversible at
    //     RUNTIME (a position-less `move_block`, a `delete_attachment`
    //     whose paired `add_attachment` is gone). These flow through as
    //     candidates and are SKIPPED+COUNTED by `revert_ops_in_tx`.
    //
    // The old code had only the static half, so a dynamically
    // non-reversible op propagated `NonReversible` via `?` and aborted the
    // ENTIRE restore. Routing the remainder through `revert_ops_in_tx`
    // with `skip_non_reversible = true` closes that gap; the two skip
    // counts are summed into `non_reversible_skipped`.
    let mut static_non_reversible_skipped: u64 = 0;
    let mut candidate_ops: Vec<OpRef> = Vec::with_capacity(ops_after.len());
    for (dev_id, seq, op_type) in &ops_after {
        if crate::reverse::is_statically_non_reversible(op_type) {
            // STATIC half of the contract: op-types a restore skips on
            // sight (`purge_block`, `delete_attachment`). `delete_attachment`
            // is skipped even when an inverse could be reconstructed,
            // preserving the established restore behaviour.
            static_non_reversible_skipped += 1;
        } else {
            candidate_ops.push(OpRef {
                device_id: dev_id.clone(),
                seq: *seq,
            });
        }
    }

    // C5 (#344): reject an over-large restore up front with a
    // restore-specific message. `revert_ops_in_tx` enforces the same
    // `MAX_REVERT_OPS` cap as a backstop, but checking here means a
    // point-in-time restore that would sweep thousands of ops fails
    // cleanly before any batch work rather than relying on the inner
    // guard. The bound matches the interactive `undo_depth` ceiling.
    // (Returning here drops `tx`, rolling the IMMEDIATE transaction back.)
    if candidate_ops.len() > MAX_REVERT_OPS {
        return Err(AppError::validation(format!(
            "restore would revert {} ops, exceeding the maximum of {MAX_REVERT_OPS}; \
             restore to a more recent point",
            candidate_ops.len()
        )));
    }

    // Revert the candidate ops inside the SAME IMMEDIATE transaction the
    // membership SELECT ran in (#1551 — read and revert are now atomic),
    // then commit and fire post-commit dispatches. Dynamically
    // non-reversible ops are skipped+counted rather than aborting (#2020).
    let (results, dynamic_non_reversible_skipped) = if candidate_ops.is_empty() {
        // Nothing to revert; release the write lock without churning the
        // materializer. (Membership read already saw a quiescent suffix.)
        tx.rollback().await?;
        (vec![], 0)
    } else {
        let (results, skipped) = revert_ops_in_tx(
            &mut tx,
            pool,
            materializer.loro_state(),
            device_id,
            candidate_ops,
            true,
        )
        .await?;
        if results.is_empty() {
            // Every candidate op was non-reversible — nothing was applied,
            // so release the write lock without churning the materializer.
            tx.rollback().await?;
        } else {
            tx.commit_and_dispatch(materializer).await?;
        }
        (results, skipped)
    };

    Ok(RestoreToOpResult {
        ops_reverted: results.len() as u64,
        non_reversible_skipped: static_non_reversible_skipped + dynamic_non_reversible_skipped,
        results,
    })
}

/// Undo the Nth most recent undoable op on a page.
///
/// `undo_depth` is 0-based: 0 = most recent op, 1 = second most recent, etc.
/// Queries the page's op history (using recursive CTE), applies OFFSET to
/// skip `undo_depth` ops, then computes and applies the reverse.
#[instrument(skip_all, fields(page_id, undo_depth), err)]
pub async fn undo_page_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: String,
    undo_depth: i64,
) -> Result<UndoResult, AppError> {
    if undo_depth < 0 {
        return Err(AppError::validation(
            "undo_depth must be non-negative".into(),
        ));
    }
    if undo_depth > 1000 {
        return Err(AppError::validation(
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
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    //
    // #2481 phase 2: `is_replicated = 0` — implicit (Ctrl+Z) undo targets
    // only locally-authored ops. Replicated foreign audit rows (migration
    // 0099) appear in History but were never applied to local state, so
    // reversing one from the undo stack would mutate state that the op
    // never produced. Reverting a foreign op stays legitimate ONLY as an
    // explicit History-view action (`revert_ops`, deliberately unfiltered).
    // also #2549: this interactive-undo target-selection query calls
    // `reverse::compute_reverse` directly and never routes through
    // `revert_ops_in_tx`'s `reject_replicated_targets` guard, so the filter
    // here is the sole line of defense against selecting an audit-only row.
    let target = sqlx::query_as!(
        HistoryEntry,
        "WITH RECURSIVE page_blocks(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
             WHERE pb.depth < 100 \
         ) \
         SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at, \
                ol.is_replicated AS \"is_replicated!: bool\" \
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
           AND ol.is_undo = 0 \
           AND ol.is_replicated = 0 \
         ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC \
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
    // See `revert_ops_inner` for the rationale — CommandTx
    // makes the commit + dispatch pair atomic and impossible to
    // desequence.
    let mut tx = CommandTx::begin_immediate(pool, "undo_page_op").await?;
    // #2604 — rollback-safe engine apply (rewind reverse-move on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // #659: flag the reverse op as an undo op (`op_log.is_undo = 1`) so
    // `redo_page_op_inner` can verify that the ref it is asked to reverse
    // really came from an undo.
    //
    // ONE timestamp threads through BOTH the append and the apply
    // (`reverse_op_timestamp`): the DeleteBlock arm stamps it into
    // `blocks.deleted_at`, preserving the `op.created_at == deleted_at`
    // cohort invariant (#1549) that redo relies on.
    // #2468: stamp the reversed op's ref (`reverses_*`, migration 0101) so
    // the ref-addressed undo's already-reversed guard also sees reverses
    // produced by this positional path.
    let target_ref = OpRef {
        device_id: target.device_id,
        seq: target.seq,
    };
    let op_ts = reverse_op_timestamp(&reverse_payload);
    let op_record = op_log::append_local_undo_op_in_tx(
        &mut tx,
        device_id,
        reverse_payload.clone(),
        op_ts,
        &target_ref,
    )
    .await?;

    apply_reverse_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        &reverse_payload,
        op_ts,
    )
    .await?;

    // Retain the identity fields the UndoResult needs after the tx
    // consumes its owned clone.
    let new_op_device_id = op_record.device_id.clone();
    let new_op_seq = op_record.seq;
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    Ok(UndoResult {
        reversed_op: target_ref,
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
#[instrument(skip_all, fields(undo_seq), err)]
pub async fn redo_page_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    undo_device_id: String,
    undo_seq: i64,
) -> Result<UndoResult, AppError> {
    use crate::reverse;

    // Fetch the undo op's op_type (surfaced to the frontend as
    // `reversed_op_type` for descriptive toasts), its `is_undo` flag, and its
    // `is_replicated` flag in a SINGLE query — all three come from the same
    // `(device_id, seq)` row, so there is no need for a second round-trip
    // (perf-redo-double-query-same-row).
    let undo_row = sqlx::query!(
        r#"SELECT op_type, is_undo as "is_undo!: i64", is_replicated as "is_replicated!: i64" FROM op_log WHERE device_id = ? AND seq = ?"#,
        undo_device_id,
        undo_seq,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("op_log ({undo_device_id}, {undo_seq})")))?;
    let undo_op_type = undo_row.op_type;

    // #659: redo means "reverse an undo op" — verify the target's recorded
    // provenance before reversing anything. Without this check a buggy IPC
    // caller could hand any forward op ref to redo and get it reversed,
    // mislabelled `is_redo: true`. The flag is stamped at append time by
    // `undo_page_op_inner` (`op_log.is_undo`, migration 0090); pre-0090
    // undo ops backfill to 0 and are no longer redoable (the FE redo stack
    // is session-scoped, so no live ref can point at one).
    if undo_row.is_undo == 0 {
        return Err(AppError::validation(format!(
            "redo target ({undo_device_id}, {undo_seq}) is a '{undo_op_type}' op that was not \
             produced by undo — refusing to reverse a forward op via redo (#659)"
        )));
    }
    // #2549: `is_undo = 1` alone does not prove the row is a LOCAL undo op —
    // a foreign device's own undo op can arrive here as a #2495 audit-only
    // replicated row (`is_replicated = 1`, `is_undo = 1`), never applied to
    // local state. `compute_reverse` + `apply_reverse_in_tx` below would
    // otherwise happily mutate local state from it. Reject before computing
    // any reverse, same as `reject_replicated_targets` does for `revert_ops`.
    if undo_row.is_replicated != 0 {
        return Err(AppError::validation(format!(
            "redo target ({undo_device_id}, {undo_seq}) is a replicated audit op \
             (never applied to local state) and has no local forward effect to redo (#2549)"
        )));
    }

    // Compute reverse of the undo op
    let reverse_payload = reverse::compute_reverse(pool, &undo_device_id, undo_seq).await?;
    let new_op_type = reverse_payload.op_type_str().to_owned();

    // Apply in single IMMEDIATE transaction.
    //
    // See `revert_ops_inner` for the rationale — CommandTx
    // makes the commit + dispatch pair atomic and impossible to
    // desequence.
    let mut tx = CommandTx::begin_immediate(pool, "redo_page_op").await?;
    // #2604 — rollback-safe engine apply (rewind reverse-move on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // ONE timestamp threads through BOTH the append and the apply
    // (`reverse_op_timestamp`): a redo that re-deletes stamps
    // `blocks.deleted_at = op.created_at`, so the NEXT undo's
    // `RestoreBlock { deleted_at_ref }` finds the cohort (#1549).
    //
    // #2468: the redo op stamps `reverses_* = the undo op` (migration
    // 0101) while keeping `is_undo = 0` (its effect is forward-equivalent,
    // #659). The link returns the ORIGINAL op to the "not currently
    // reversed" state, so a later ref-addressed undo of it is legal again.
    let undo_ref = OpRef {
        device_id: undo_device_id,
        seq: undo_seq,
    };
    let op_ts = reverse_op_timestamp(&reverse_payload);
    let op_record = op_log::append_local_redo_op_in_tx(
        &mut tx,
        device_id,
        reverse_payload.clone(),
        op_ts,
        &undo_ref,
    )
    .await?;

    apply_reverse_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        &reverse_payload,
        op_ts,
    )
    .await?;

    // Retain the identity fields the UndoResult needs after the tx
    // consumes its owned clone.
    let new_op_device_id = op_record.device_id.clone();
    let new_op_seq = op_record.seq;
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    Ok(UndoResult {
        reversed_op: undo_ref,
        reversed_op_type: undo_op_type,
        new_op_ref: OpRef {
            device_id: new_op_device_id,
            seq: new_op_seq,
        },
        new_op_type,
        is_redo: true,
    })
}

/// Compute the size of the consecutive same-device,
/// within-window undo group starting at the Nth-most-recent **undoable** op
/// of a page.
///
/// Mirrors the frontend grouping semantics that previously required
/// `list_page_history` re-fetches with a growing window after every
/// Ctrl+Z:
///
/// * "Undoable" excludes reverse ops — those carry `op_log.is_undo = 1`
///   (stamped by [`undo_page_op_inner`] via
///   `op_log::append_local_undo_op_in_tx`, migration 0090). They use a
///   plain `op_type` (e.g. `edit_block`), NOT an `undo_`/`redo_` prefix,
///   so the filter must key on the `is_undo` flag, not the op_type. They
///   are not themselves undoable from the user's POV (redo reverses them
///   instead).
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
        return Err(AppError::validation("depth must be non-negative".into()));
    }
    if window_ms < 0 {
        return Err(AppError::validation(
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
    //
    // #2549: `AND ol.is_replicated = 0` — replicated audit rows (#2495,
    // never applied to local state) are excluded from `ordered_ops`, exactly
    // as in `undo_page_op_inner`'s target query and `undo_page_group_inner`'s
    // enumeration. All three MUST share the same row-numbering universe:
    // the FE sizes the group here and then addresses ops by depth/rn, so a
    // replicated row visible to one query but not the others would skew
    // depth addressing (and a replicated row in the walk would either break
    // the same-device chain or seed a group that `reject_replicated_targets`
    // then aborts wholesale).
    let seed_rn: i64 = depth + 1; // depth=0 → rn=1 (newest)
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    //
    // #2481 phase 2: `is_replicated = 0` in `ordered_ops` — undo groups are
    // built over locally-authored ops only, matching `undo_page_op_inner`'s
    // target filter. A replicated foreign audit row (migration 0099) must
    // neither seed/extend a group nor BREAK one: filtered out here, two
    // local ops with a replicated row between them stay adjacent in the
    // walk, exactly as they present in the implicit undo stack.
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
               AND ol.is_undo = 0 \
               AND ol.is_replicated = 0 \
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
    let raw = count.unwrap_or(0).max(0).min(i64::from(i32::MAX));
    Ok(i32::try_from(raw).unwrap_or(i32::MAX))
}

/// #2190: Undo an entire consecutive same-device, within-window undo group in a
/// SINGLE IMMEDIATE transaction, replacing the frontend's `find_undo_group` +
/// N × `undo_page_op` IPC loop (one IPC / one page-subtree CTE walk / one
/// writer-lock acquisition per op) with one command.
///
/// This is the fused batch analogue of [`undo_page_op_inner`] +
/// [`find_undo_group_inner`]:
///
///  1. The page subtree is resolved ONCE (the `page_blocks` CTE) and the
///     group's op refs are enumerated ONCE by the same `ordered_ops` +
///     recursive `walk` used to *size* the group in `find_undo_group_inner`
///     — here the walk additionally carries `seq`, so it projects the concrete
///     `(device_id, seq)` of every op in the group instead of just the count.
///     Previously the FE loop re-ran the page-subtree recursive CTE plus a
///     `LIMIT 1 OFFSET N` membership scan on every `undo_page_op` call.
///  2. The enumerated ops are reverted through the shared
///     [`revert_ops_in_tx`], which sorts them newest-first
///     (`created_at DESC, seq DESC, device_id DESC`) and applies the reverses
///     in that order — preserving the newest-first offset semantics the
///     sequential `undo_page_op(undo_depth = depth + i)` loop had (each of
///     those calls walked the same is_undo = 0 ordered stream at increasing
///     offsets). `skip_non_reversible = false` keeps the interactive contract:
///     a single non-reversible op aborts the whole batch before any reverse is
///     applied.
///
/// # Snapshot semantics — atomic read+revert (mirrors #1551)
///
/// The group-enumeration SELECT runs **inside** the same `BEGIN IMMEDIATE`
/// transaction that performs the revert (it executes on `tx`, sharing the write
/// lock). There is therefore no TOCTOU window: an op landing between deciding
/// *which* ops form the group and applying the reverses cannot slip through.
/// This is stronger than the old FE loop, which sized the group once and then
/// issued N offset-based undos that could drift if the op stream shifted
/// mid-loop.
///
/// `depth` is 0-based (0 = seed at the most-recent undoable op, matching
/// `find_undo_group_inner`); `window_ms` is the same grouping window the FE
/// passes to `find_undo_group`. An empty group (seed op doesn't exist / page
/// has no undoable ops) returns `Ok(vec![])` after releasing the write lock.
#[instrument(skip_all, fields(page_id, depth, window_ms), err)]
pub async fn undo_page_group_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: String,
    depth: i64,
    window_ms: i64,
) -> Result<Vec<UndoResult>, AppError> {
    if depth < 0 {
        return Err(AppError::validation("depth must be non-negative".into()));
    }
    if window_ms < 0 {
        return Err(AppError::validation(
            "window_ms must be non-negative".into(),
        ));
    }

    // Open the IMMEDIATE write transaction up front so the group-enumeration
    // SELECT below runs *inside* the same transaction that applies the
    // reverses (atomic read+revert — see the `Snapshot semantics` doc-block).
    let mut tx = CommandTx::begin_immediate(pool, "undo_page_group").await?;
    // #2604 — rollback-safe engine apply (rewind reverse-move on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Resolve the page subtree ONCE and enumerate the group's op refs. The
    // `page_blocks` + `ordered_ops` CTEs are identical to
    // `find_undo_group_inner`; the recursive `walk` additionally threads `seq`
    // so we can project each op's concrete `(device_id, seq)` rather than only
    // `MAX(count_so_far)`. `depth + 1` seeds at the newest undoable op for
    // `depth = 0`. The `count_so_far < 1000` bound matches the `undo_depth`
    // ceiling in `undo_page_op_inner`. #2481 phase 2: `is_replicated = 0`
    // keeps replicated foreign audit rows out of the group (and out of the
    // rn-numbering, so they don't break a local group either) — implicit
    // undo is local-only; explicit `revert_ops` stays unfiltered.
    // also #2549: without this filter a replicated audit row seeding or
    // joining the walk would flow into `revert_ops_in_tx`, whose
    // `reject_replicated_targets` guard aborts the WHOLE group; excluding it
    // here keeps group undo usable and the rn universe identical to
    // `find_undo_group_inner` / `undo_page_op_inner`.
    let seed_rn: i64 = depth + 1;
    let rows = sqlx::query!(
        r#"WITH RECURSIVE page_blocks(id, depth) AS (
             SELECT id, 0 FROM blocks WHERE id = ?1
             UNION ALL
             SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id
             WHERE pb.depth < 100
         ),
         ordered_ops AS (
             SELECT
                 ROW_NUMBER() OVER (ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC) AS rn,
                 ol.device_id, ol.seq, ol.created_at
             FROM op_log ol
             WHERE (
                 ol.block_id IN (SELECT id FROM page_blocks)
                 OR (
                     ol.op_type IN ('delete_attachment', 'rename_attachment')
                     AND EXISTS (
                         SELECT 1 FROM attachments a
                         WHERE a.id = json_extract(ol.payload, '$.attachment_id')
                         AND a.block_id IN (SELECT id FROM page_blocks)
                     )
                 )
             )
               AND ol.is_undo = 0
               AND ol.is_replicated = 0
         ),
         walk(rn, device_id, seq, created_at, count_so_far) AS (
             SELECT rn, device_id, seq, created_at, 1
             FROM ordered_ops
             WHERE rn = ?2
             UNION ALL
             SELECT o.rn, o.device_id, o.seq, o.created_at, w.count_so_far + 1
             FROM walk w
             JOIN ordered_ops o ON o.rn = w.rn + 1
             WHERE o.device_id = w.device_id
               AND (w.created_at - o.created_at) <= ?3
               AND w.count_so_far < 1000
         )
         SELECT device_id AS "device_id!: String", seq AS "seq!: i64"
         FROM walk
         ORDER BY count_so_far"#,
        page_id,
        seed_rn,
        window_ms,
    )
    .fetch_all(&mut **tx)
    .await?;

    let ops: Vec<OpRef> = rows
        .into_iter()
        .map(|r| OpRef {
            device_id: r.device_id,
            seq: r.seq,
        })
        .collect();

    if ops.is_empty() {
        // No group — the seed op doesn't exist (depth exceeds the page's
        // undoable-op count) or the page has no undoable ops. Release the
        // write lock without churning the materializer. (Dropping/rolling
        // `tx` back leaves the DB untouched.)
        tx.rollback().await?;
        return Ok(vec![]);
    }

    // Interactive batch undo preserves the historical contract: a single
    // non-reversible op aborts the whole revert before any reverse is applied
    // (`skip_non_reversible = false`), so a mid-group failure rolls the entire
    // IMMEDIATE transaction back — no partial undo. `revert_ops_in_tx` sorts
    // the ops newest-first and applies the reverses in that order; the
    // discarded skip count is always 0 on this path.
    let (results, _skipped) = revert_ops_in_tx(
        &mut tx,
        pool,
        materializer.loro_state(),
        device_id,
        ops,
        false,
    )
    .await?;

    // Commit, then fire queued dispatches in enqueue order. If commit fails, no
    // dispatches fire.
    tx.commit_and_dispatch(materializer).await?;

    Ok(results)
}

/// #2468: ref-addressed interactive undo — revert an explicit set of op
/// refs with EXACTLY the interactive undo stack's semantics, replacing the
/// positional `undo_depth` addressing whose offset shifts whenever an op
/// lands between the user's intent and the IPC (#2446).
///
/// This is the batch/group form (a coalesced `UNDO_GROUP_WINDOW_MS` group
/// becomes one explicit ref-set revert — the same shape MCP session revert
/// already exercises via `revert_ops`). [`undo_op_inner`] is the
/// single-ref special case. Both differ from the sanctioned explicit
/// `revert_ops` in ONE way: a guard verifying every ref is a legitimate
/// implicit-undo target, enforced INSIDE the IMMEDIATE transaction that
/// applies the reverses (no TOCTOU window — a concurrent double-submit of
/// the same ref serializes and the loser is rejected):
///
/// * **local** — `is_replicated = 0` (#2481 phase 2: replicated foreign
///   audit rows were never applied to local state; reverting one stays
///   legitimate only as an explicit History-view `revert_ops` action);
/// * **forward** — `is_undo = 0` (#659: reversing an undo op is redo's
///   job, `redo_page_op`);
/// * **not already reversed** — no unreversed reverse op links to the ref
///   via `reverses_*` (migration 0101). An undo → redo cycle clears the
///   state (the redo op links to the undo op), so re-undoing after redo is
///   legal.
///
/// The revert itself is the shared [`revert_ops_in_tx`] with
/// `skip_non_reversible = false` — the interactive contract: a single
/// non-reversible op (including a reverse-move preflight failure,
/// classified `NonReversible`) ABORTS the whole batch before any reverse
/// is applied; nothing is skipped. Results are newest-first
/// [`UndoResult`]s whose `new_op_ref`s are the frontend's redo targets.
///
/// An empty `ops` returns `Ok(vec![])` (mirrors `revert_ops_inner`).
#[instrument(skip_all, fields(ops_count = ops.len()), err)]
pub async fn undo_ops_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    ops: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    if ops.is_empty() {
        return Ok(vec![]);
    }

    // C5 (#344): bound the batch before any DB work — same ceiling as
    // `revert_ops_in_tx` (which re-enforces it as a backstop), surfaced
    // here so an oversized group fails before taking the write lock.
    if ops.len() > MAX_REVERT_OPS {
        return Err(AppError::validation(format!(
            "cannot undo {} ops in a single batch (maximum is {MAX_REVERT_OPS})",
            ops.len()
        )));
    }

    // A duplicate ref would append (and apply) the SAME inverse twice
    // inside one transaction — the second application is exactly the
    // double-undo the already-reversed guard exists to prevent, but the
    // guard reads committed state and cannot see the first in-batch
    // reverse. Reject up front.
    {
        let mut seen = std::collections::HashSet::with_capacity(ops.len());
        for r in &ops {
            if !seen.insert((r.device_id.as_str(), r.seq)) {
                return Err(AppError::validation(format!(
                    "duplicate op ref ({}, {}) in undo batch",
                    r.device_id, r.seq
                )));
            }
        }
    }

    // Open the IMMEDIATE write transaction BEFORE the guard reads so guard
    // and revert are atomic (mirrors #1551 / `undo_page_group_inner`).
    let mut tx = CommandTx::begin_immediate(pool, "undo_ops").await?;
    // #2604 — rollback-safe engine apply (rewind reverse-move on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    verify_undo_targets_in_tx(&mut tx, &ops).await?;

    // Interactive contract: `skip_non_reversible = false` — one
    // non-reversible op aborts the whole batch (the tx rolls back, nothing
    // is applied). The discarded skip count is always 0 on this path.
    let (results, _skipped) = revert_ops_in_tx(
        &mut tx,
        pool,
        materializer.loro_state(),
        device_id,
        ops,
        false,
    )
    .await?;

    // Commit, then fire queued dispatches in enqueue order. If commit
    // fails, no dispatches fire.
    tx.commit_and_dispatch(materializer).await?;

    Ok(results)
}

/// #2468: ref-addressed single undo — the `undo_page_op` successor. Same
/// [`UndoResult`] contract (`is_redo: false`, `new_op_ref` is the redo
/// target), same reverse-move preflight → `NonReversible` ABORTS (no
/// skip), but the target is the exact `(device_id, seq)` the frontend
/// captured when the action was performed, not the Nth row of a shifting
/// positional walk. See [`undo_ops_inner`] for the guard semantics.
#[instrument(skip_all, fields(device_id = %op_ref.device_id, seq = op_ref.seq), err)]
pub async fn undo_op_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    op_ref: OpRef,
) -> Result<UndoResult, AppError> {
    let mut results = undo_ops_inner(pool, device_id, materializer, vec![op_ref]).await?;
    // Exactly one input ref + `skip_non_reversible = false` (errors abort
    // via `?` above) ⇒ exactly one result. The branch is unreachable; it
    // exists so a future contract drift fails loudly instead of panicking.
    results.pop().ok_or_else(|| {
        AppError::Internal(
            "undo_op produced no result for a single-ref batch (revert_ops_in_tx \
             contract drift)"
                .into(),
        )
    })
}

/// #2468: verify — inside the caller's IMMEDIATE transaction — that every
/// ref in `ops` is a legitimate ref-addressed-undo target: it exists, is
/// locally authored (`is_replicated = 0`, #2481), is a forward op
/// (`is_undo = 0`, #659), and is not CURRENTLY reversed (no unreversed
/// reverse op links to it via `reverses_*`, migration 0101 — an undo →
/// redo cycle clears the state).
///
/// One batched query (row-value `IN` over `json_each`, the
/// `dag::ingest_remote_record` parent-check pattern); the `EXISTS` probes
/// ride the partial `idx_op_log_reverses` index. `ops` is caller-bounded
/// by `MAX_REVERT_OPS` and deduplicated, so the missing-ref check is a
/// straight count comparison resolved to a per-ref `NotFound`.
async fn verify_undo_targets_in_tx(tx: &mut CommandTx, ops: &[OpRef]) -> Result<(), AppError> {
    let refs_json = serde_json::to_string(
        &ops.iter()
            .map(|r| (r.device_id.as_str(), r.seq))
            .collect::<Vec<_>>(),
    )?;

    let rows = sqlx::query!(
        r#"SELECT ol.device_id AS "device_id!: String",
                  ol.seq AS "seq!: i64",
                  ol.op_type AS "op_type!: String",
                  ol.is_undo AS "is_undo!: i64",
                  ol.is_replicated AS "is_replicated!: i64",
                  EXISTS(
                      SELECT 1 FROM op_log u
                      WHERE u.reverses_device_id = ol.device_id
                        AND u.reverses_seq = ol.seq
                        AND NOT EXISTS(
                            SELECT 1 FROM op_log r
                            WHERE r.reverses_device_id = u.device_id
                              AND r.reverses_seq = u.seq
                        )
                  ) AS "currently_reversed!: i64"
           FROM op_log ol
           WHERE (ol.device_id, ol.seq) IN (
               SELECT json_extract(value, '$[0]'),
                      CAST(json_extract(value, '$[1]') AS INTEGER)
               FROM json_each(?1)
           )"#,
        refs_json,
    )
    .fetch_all(&mut ***tx)
    .await?;

    // Missing refs: the join drops them, so resolve by set difference for
    // a precise NotFound instead of an anonymous count mismatch.
    if rows.len() != ops.len() {
        let found: std::collections::HashSet<(&str, i64)> =
            rows.iter().map(|r| (r.device_id.as_str(), r.seq)).collect();
        if let Some(missing) = ops
            .iter()
            .find(|r| !found.contains(&(r.device_id.as_str(), r.seq)))
        {
            return Err(AppError::NotFound(format!(
                "op_log ({}, {})",
                missing.device_id, missing.seq
            )));
        }
    }

    for row in &rows {
        if row.is_replicated != 0 {
            return Err(AppError::validation(format!(
                "undo target ({}, {}) is a replicated foreign '{}' op — the \
                 interactive undo stack is scoped to locally-authored ops; \
                 revert it explicitly from the History view instead (#2481)",
                row.device_id, row.seq, row.op_type
            )));
        }
        if row.is_undo != 0 {
            return Err(AppError::validation(format!(
                "undo target ({}, {}) is a '{}' op produced by undo — \
                 reversing an undo op is redo's job (`redo_page_op`, #659)",
                row.device_id, row.seq, row.op_type
            )));
        }
        if row.currently_reversed != 0 {
            return Err(AppError::validation(format!(
                "undo target ({}, {}) ('{}') is already reversed — refusing \
                 to apply the same inverse twice (#2468)",
                row.device_id, row.seq, row.op_type
            )));
        }
    }

    Ok(())
}

/// Tauri command: list page history. Delegates to [`list_page_history_inner`].
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
#[tauri::command]
#[specta::specta]
pub async fn revert_ops(
    ctx: State<'_, WriteCtx>,
    ops: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    revert_ops_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), ops)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: point-in-time restore. Delegates to [`restore_page_to_op_inner`].
#[tauri::command]
#[specta::specta]
pub async fn restore_page_to_op(
    ctx: State<'_, WriteCtx>,
    page_id: String,
    target_device_id: String,
    target_seq: i64,
) -> Result<RestoreToOpResult, AppError> {
    restore_page_to_op_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        page_id,
        target_device_id,
        target_seq,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: undo page op. Delegates to [`undo_page_op_inner`].
#[tauri::command]
#[specta::specta]
pub async fn undo_page_op(
    ctx: State<'_, WriteCtx>,
    page_id: String,
    undo_depth: i64,
) -> Result<UndoResult, AppError> {
    undo_page_op_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        page_id,
        undo_depth,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: ref-addressed single undo (#2468). Delegates to
/// [`undo_op_inner`]. The `undo_page_op` successor: the frontend passes the
/// exact `OpRef` it captured when the action was performed, killing the
/// positional-offset race (#2446). Same `UndoResult` contract.
#[tauri::command]
#[specta::specta]
pub async fn undo_op(ctx: State<'_, WriteCtx>, op_ref: OpRef) -> Result<UndoResult, AppError> {
    undo_op_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), op_ref)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: ref-addressed group undo (#2468). Delegates to
/// [`undo_ops_inner`]. The `undo_page_group` successor: a coalesced undo
/// group is an explicit ref-set revert with atomic-abort semantics.
#[tauri::command]
#[specta::specta]
pub async fn undo_ops(
    ctx: State<'_, WriteCtx>,
    ops: Vec<OpRef>,
) -> Result<Vec<UndoResult>, AppError> {
    undo_ops_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), ops)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: redo page op. Delegates to [`redo_page_op_inner`].
#[tauri::command]
#[specta::specta]
pub async fn redo_page_op(
    ctx: State<'_, WriteCtx>,
    undo_device_id: String,
    undo_seq: i64,
) -> Result<UndoResult, AppError> {
    redo_page_op_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        undo_device_id,
        undo_seq,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: compute the size of the consecutive same-device,
/// within-window undo group starting at the Nth-most-recent undoable op.
/// Delegates to [`find_undo_group_inner`]..
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

/// Tauri command: undo an entire consecutive same-device, within-window undo
/// group in a single IMMEDIATE transaction. Delegates to
/// [`undo_page_group_inner`]. #2190 — replaces the FE's `find_undo_group` +
/// N × `undo_page_op` IPC loop with one command.
#[tauri::command]
#[specta::specta]
pub async fn undo_page_group(
    ctx: State<'_, WriteCtx>,
    page_id: String,
    depth: i64,
    window_ms: i64,
) -> Result<Vec<UndoResult>, AppError> {
    undo_page_group_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        page_id,
        depth,
        window_ms,
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
) -> Result<Option<Vec<agaric_core::word_diff::DiffSpan>>, AppError> {
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
    let payload: agaric_store::op::EditBlockPayload =
        serde_json::from_str(&row.payload).map_err(|e| {
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
    Ok(Some(agaric_core::word_diff::compute_word_diff(
        &old_text,
        &payload.to_text,
    )))
}

/// Tauri command: compute word-level diff for an edit_block history entry.
/// Delegates to [`compute_edit_diff_inner`].
#[tauri::command]
#[specta::specta]
pub async fn compute_edit_diff(
    pool: State<'_, ReadPool>,
    device_id: String,
    seq: i64,
) -> Result<Option<Vec<agaric_core::word_diff::DiffSpan>>, AppError> {
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
) -> Result<Vec<agaric_core::word_diff::DiffSpan>, AppError> {
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
    // ORDER BY `created_at DESC, seq DESC` (not `seq DESC`
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

    // Same `InvalidOperation` strategy as `compute_edit_diff_inner`:
    // surface row identity through `sanitize_internal_error`'s pass-through
    // set when the on-disk payload is corrupt.
    let historical = if row.op_type == "edit_block" {
        let p: agaric_store::op::EditBlockPayload = serde_json::from_str(&row.payload).map_err(|e| {
            AppError::InvalidOperation(format!(
                "op for '{block_id_upper}' at seq <= {historical_seq} payload not parseable as EditBlockPayload: {e}"
            ))
        })?;
        p.to_text
    } else {
        let p: agaric_store::op::CreateBlockPayload =
            serde_json::from_str(&row.payload).map_err(|e| {
                AppError::InvalidOperation(format!(
                    "op for '{block_id_upper}' at seq <= {historical_seq} payload not parseable as CreateBlockPayload: {e}"
                ))
            })?;
        p.content
    };

    Ok(agaric_core::word_diff::compute_word_diff(
        &historical,
        &current,
    ))
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
#[tauri::command]
#[specta::specta]
pub async fn compute_block_vs_current_diff(
    pool: State<'_, ReadPool>,
    block_id: BlockId,
    historical_created_at: i64,
    historical_seq: i64,
) -> Result<Vec<agaric_core::word_diff::DiffSpan>, AppError> {
    compute_block_vs_current_diff_inner(&pool.0, block_id, historical_created_at, historical_seq)
        .await
        .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    //! Inline unit tests for [`compute_edit_diff_inner`] focused on the
    //! error-path fix: parse failures of `EditBlockPayload` must surface a
    //! row-identifying [`AppError::InvalidOperation`] (which passes through
    //! [`super::sanitize_internal_error`] unchanged) rather than a generic
    //! [`AppError::Json`] (which gets collapsed to "an internal error
    //! occurred").  Happy-path and dispatch-rule cases live alongside.
    use super::*;
    use crate::commands::{create_block_inner, edit_block_inner};
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use agaric_core::ulid::BlockId;
    use agaric_store::op::{CreateBlockPayload, OpPayload};
    use agaric_store::op_log::append_local_op_at;
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

    /// Regression: a corrupted `edit_block` payload must surface as
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
        // Regressing the fix.
        let sanitised = super::sanitize_internal_error(err);
        assert!(
            matches!(sanitised, AppError::InvalidOperation(ref m) if m.contains("EditBlockPayload")),
            "InvalidOperation must pass through sanitize_internal_error unchanged; \
             got: {sanitised:?}"
        );
    }

    /// Happy path: a real create + edit chain produces a `Some(diff)` with
    /// at least one [`agaric_core::word_diff::DiffSpan`], confirming
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
        use agaric_store::op::{AddAttachmentPayload, DeleteAttachmentPayload, EditBlockPayload};

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

    /// Insert a raw `op_log` row with an explicit `is_undo` flag — used by the
    /// #1517 regression test to stamp a REVERSE op (plain `op_type`,
    /// `is_undo = 1`) without driving a full undo through the pipeline (which
    /// would use real `now_ms()` timestamps and defeat the deterministic
    /// window placement the test relies on).
    #[allow(clippy::too_many_arguments)] // raw-insert test helper mirrors the op_log columns
    async fn insert_raw_op_is_undo(
        pool: &SqlitePool,
        device_id: &str,
        seq: i64,
        op_type: &str,
        payload: &str,
        block_id: Option<&str>,
        created_at: i64,
        is_undo: i64,
    ) {
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id, is_undo) \
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(seq)
        .bind("test-hash-placeholder")
        .bind(op_type)
        .bind(payload)
        .bind(created_at)
        .bind(block_id)
        .bind(is_undo)
        .execute(pool)
        .await
        .unwrap();
    }

    /// #1517: `find_undo_group_inner`'s `ordered_ops` CTE must EXCLUDE reverse
    /// ops from the undoable set. A reverse op (the one an undo appends) carries
    /// `op_log.is_undo = 1` but a PLAIN `op_type` (e.g. `edit_block`) with NO
    /// `undo_`/`redo_` prefix. The old filter keyed on dead
    /// `op_type NOT LIKE 'undo\_%'`/`'redo\_%'` predicates that matched zero
    /// rows, so reverse ops were counted as ordinary undoable ops — a held
    /// Ctrl+Z within the window then extended the group across ops already
    /// undone. The fix keys on `is_undo = 0`.
    ///
    /// Setup: page + child, two consecutive same-device forward `edit_block`
    /// ops, then ONE reverse `edit_block` op (plain op_type, `is_undo = 1`)
    /// stacked on top — all three within the group window. With the fix the
    /// reverse op is excluded, so the depth-0 group seeds at the forward
    /// `edit2` and spans only the two forward edits ⇒ 2. Were the reverse op
    /// (wrongly) counted, it would become the seed and the group would inflate
    /// to 3.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn find_undo_group_excludes_reverse_ops_1517() {
        use agaric_store::op::EditBlockPayload;

        let (pool, _dir) = test_pool().await;

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

        // Two consecutive same-device FORWARD edits (is_undo = 0).
        for (i, text) in ["edit1", "edit2"].into_iter().enumerate() {
            let edit = OpPayload::EditBlock(EditBlockPayload {
                block_id: child_id.clone(),
                to_text: text.into(),
                prev_edit: None,
            });
            append_local_op_at(&pool, DEV, edit, FIXED_TS + i64::try_from(i).unwrap())
                .await
                .unwrap();
        }

        // Sanity: before any reverse op, the depth-0 group spans both forward
        // edits (same device, within the 10ms window).
        let before = find_undo_group_inner(&pool, page_id.as_str(), 0, 10)
            .await
            .unwrap();
        assert_eq!(before, 2, "two consecutive forward edits form a group of 2");

        // Stack a REVERSE op on top: same device, plain `edit_block` op_type,
        // is_undo = 1, within the window of the two forward edits. This is the
        // exact row shape the dead `op_type NOT LIKE 'undo_%'` predicate failed
        // to exclude.
        let reverse_payload = serde_json::to_string(&EditBlockPayload {
            block_id: child_id.clone(),
            to_text: "edit1".into(),
            prev_edit: Some((DEV.to_string(), 2)),
        })
        .unwrap();
        insert_raw_op_is_undo(
            &pool,
            DEV,
            3,
            "edit_block",
            &reverse_payload,
            Some(child_id.as_str()),
            FIXED_TS + 2,
            1, // is_undo
        )
        .await;

        // CORE #1517 ASSERTION: the depth-0 group still seeds at the forward
        // `edit2` and counts only the two forward edits — the reverse op is
        // excluded. A regression that counts the reverse op would seed at it
        // and inflate the group to 3.
        let after = find_undo_group_inner(&pool, page_id.as_str(), 0, 10)
            .await
            .unwrap();
        assert_eq!(
            after, 2,
            "#1517: reverse ops (is_undo = 1) must be excluded from the \
             undoable set; group must stay 2, not inflate to 3; got {after}"
        );

        // Guard against a false pass: the reverse op really is present and would
        // be enumerated were the filter dead.
        let reverse_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE is_undo = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(reverse_rows, 1, "exactly one reverse op seeded");
    }
}
