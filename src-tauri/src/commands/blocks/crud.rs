use crate::db::{CommandTx, WriteCtx};
use crate::op::{
    DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, PurgeBlockPayload,
    RestoreBlockPayload, SPACE_PROPERTY_KEY,
};
use std::sync::Arc;

use tracing::instrument;

use super::super::*;
// #882: the create-block / set-property tx cores moved to the neutral
// `crate::domain::block_ops` layer. The `*_inner` wrappers below (which own
// the transaction + post-commit dispatch) stay here and call into domain.
use crate::domain::block_ops::{
    PropertyDeclaration, create_block_in_tx, set_property_in_tx,
    set_property_in_tx_with_declaration,
};
use crate::space::{SpaceId, SpaceScope};

/// Look up the most-recent `edit_block`/`create_block` op for the given
/// `block_id`, scoped to the supplied connection (typically a live
/// transaction). Returns the originating `(device_id, seq)` pair if any,
/// shaped to drop straight into [`EditBlockPayload::prev_edit`].
///
/// Extracted to deduplicate the identical query that used
/// to live inline in [`edit_block_inner`] and `commands::drafts::flush_draft_inner`.
/// Keeping it on a `&mut SqliteConnection` lets both callers pass either
/// `&mut **CommandTx` (this file) or `&mut *Transaction` (drafts.rs)
/// without extra deref gymnastics.
pub(crate) async fn find_prev_edit_in_tx(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Option<(String, i64)>, AppError> {
    // B.1: query the native `block_id` column (migration 0030)
    // instead of `json_extract(payload, '$.block_id')` so the lookup is
    // index-supported by `idx_op_log_block_id` (migration 0030, line 23)
    // rather than a full op_log scan.
    //
    // The `ORDER BY (seq DESC, device_id DESC)` is the op log's natural
    // primary-key ordering and is functionally equivalent to the previous
    // `created_at DESC` for this single-row lookup: within one device the
    // most-recent edit is always the highest seq, and across devices the
    // tuple is well-defined and total. There is no compound
    // `(block_id, seq DESC, device_id DESC)` index today — the
    // `idx_op_log_block_id` index narrows the scan to ops touching this
    // block (typically a handful) and SQLite resolves the ORDER BY in
    // memory on that small set, which is the desired plan.
    let row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE block_id = ?1 \
         AND op_type IN ('edit_block', 'create_block') \
         ORDER BY seq DESC, device_id DESC \
         LIMIT 1",
        block_id
    )
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|r| (r.device_id, r.seq)))
}

#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn create_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_type: String,
    content: String,
    parent_id: Option<BlockId>,
    index: Option<i64>,
) -> Result<BlockRow, AppError> {
    // CommandTx couples commit + post-commit dispatch.
    let parent_id = parent_id.map(BlockId::into_string);
    let mut tx = CommandTx::begin_immediate(pool, "create_block").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let (block, op_record) = create_block_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        block_type,
        content,
        parent_id,
        index,
    )
    .await?;
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;
    Ok(block)
}

/// IPC-tightened `create_block`.
///
/// Wraps [`create_block_inner`] with the invariant
/// "every page belongs to a space". When `block_type == "page"`:
///
/// * `scope == SpaceScope::Global` → return [`AppError::Validation`];
///   the caller must use [`create_page_in_space_inner`] semantics or
///   pass the active space's ULID through this IPC. No op is appended,
///   the page is rejected at the IPC boundary so a misbehaving frontend
///   (e.g. a stale `createBlock({ blockType: 'page' })` callsite)
///   cannot leak unscoped pages into the materialized state.
/// * `scope == SpaceScope::Active(sid)` → delegates to
///   [`crate::commands::spaces::create_page_in_space_inner`] which
///   emits `CreateBlock` + `SetProperty(space=<sid>)` inside a single
///   `BEGIN IMMEDIATE` transaction.
///
/// Other block types (`content`, `tag`) ignore the parameter and
/// pass through to [`create_block_inner`] unchanged.
///
/// Returns a [`BlockRow`] for the new block — for the page path, the
/// row is re-fetched after the transaction commits so it carries the
/// freshly-materialized state (`page_id = self`, etc.).
///
/// # Errors
///
/// - [`AppError::Validation`] — `block_type == "page"` AND
///   `scope == SpaceScope::Global`, or the wrapped [`SpaceId`] does
///   not refer to a live space block (propagated from
///   `create_page_in_space_inner`).
/// - All errors from [`create_block_inner`] propagate unchanged for
///   non-page block types.
// 8 args (one over the clippy threshold of 7) — adding `scope` to the
// existing 7-arg `create_block_inner` shape is the cleanest way to satisfy
// The invariant without forcing every non-page caller to flip to a
// builder pattern. Restructuring into an args struct would touch hundreds
// of callsites for zero behavioural gain.
#[allow(clippy::too_many_arguments)]
// #2110 M1a — PII-safe command span. Records ONLY opaque fields: the
// block_type tag (an enum-like "page"/"task"/… string, never user text), the
// parent ULID (opaque id), and the sibling index (a count). `content` and the
// space scope's inner value are deliberately NOT recorded — `skip_all` drops
// every argument and only the explicit `fields(...)` below are attached.
#[instrument(
    level = "info",
    name = "create_block",
    skip_all,
    fields(
        block_type = %block_type,
        parent_id = ?parent_id,
        index = ?index,
    ),
    err
)]
pub async fn create_block_inner_with_space(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_type: String,
    content: String,
    parent_id: Option<BlockId>,
    index: Option<i64>,
    scope: &SpaceScope,
) -> Result<BlockRow, AppError> {
    if block_type == "page" {
        let SpaceScope::Active(sid) = scope else {
            return Err(AppError::validation(
                "page blocks require space_id: \
                 use createPageInSpace or pass the active space's ULID"
                    .to_owned(),
            ));
        };

        // Delegate to the atomic 2-op helper. It emits `CreateBlock` +
        // `SetProperty(space = <sid>)` inside a single
        // `BEGIN IMMEDIATE` transaction so a page never exists without
        // Its space property — the "nothing outside of spaces"
        // invariant. `position` is intentionally NOT threaded through:
        // `create_page_in_space_inner` mirrors PageBrowser's "New page"
        // semantics (append after last sibling). If a future caller
        // needs explicit positioning for top-level pages we can extend
        // the helper; today no callsite uses it.
        //
        // `_inner` now dispatches background cache rebuilds
        // via `CommandTx::commit_and_dispatch`; the previous re-fetch
        // + loop is gone because the op records never leave the
        // transaction scope.
        let _index = index;
        let new_page_id = crate::commands::create_page_in_space_inner(
            pool,
            device_id,
            materializer,
            parent_id.map(BlockId::into_string),
            content,
            sid.as_str().to_owned(),
        )
        .await?;

        // Re-fetch the materialized BlockRow so the caller (Tauri IPC)
        // can return the same shape `create_block_inner` would.
        //
        // `get_active_block_inner` (not `get_block_inner`)
        // because the row was just inserted by `create_page_in_space_inner`
        // and therefore is not soft-deleted. Using the active variant
        // is consistent with the rest of the public surface and means
        // a future bug that leaves a page tombstoned at creation time
        // will surface here as `NotFound` rather than silently
        // returning a row with `deleted_at` set.
        return get_active_block_inner(pool, new_page_id).await;
    }

    // Non-page block types ignore `scope` and follow the legacy path —
    // `content`, `tag` blocks have no space invariant.
    let _ignore_scope = scope;
    create_block_inner(
        pool,
        device_id,
        materializer,
        block_type,
        content,
        parent_id,
        index,
    )
    .await
}

/// Edit a block's content.
///
/// Validates the block exists and is not deleted, looks up the previous edit
/// reference for conflict detection, appends an `EditBlock` op, updates the
/// `blocks` table, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
#[instrument(skip(pool, device_id, materializer, to_text), err)]
pub async fn edit_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
    to_text: String,
) -> Result<BlockRow, AppError> {
    // #107: BlockId newtype already normalises to canonical uppercase on
    // construction (AGENTS.md invariant #8 — ULID uppercase for blake3 hash
    // determinism). Re-derive the owned String form the rest of this body
    // binds for sqlx/format!.
    let block_id = block_id.into_string();

    // Validate content length BEFORE taking the writer lock or fetching any row.
    // Content length is a pure function of the input needing no DB state, so an
    // over-length payload is rejected without acquiring the IMMEDIATE writer lock
    // or doing the wasted existence fetch (fail fast on the input).
    if to_text.len() > MAX_CONTENT_LENGTH {
        return Err(AppError::validation(format!(
            "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
            to_text.len()
        )));
    }

    // F02: Begin IMMEDIATE transaction for atomic validation + op_log + blocks write.
    // All reads (block existence, prev_edit lookup) happen inside the tx
    // to prevent TOCTOU races (a concurrent delete_block could soft-delete
    // the block between validation and update, and another edit could make
    // The prev_edit reference stale). CommandTx couples commit
    // + post-commit dispatch via `enqueue_edit_background` (the
    // block-type-aware variant that restricts the cache rebuild fan-out).
    let mut tx = CommandTx::begin_immediate(pool, "edit_block").await?;
    // #2604 — arm rollback-safe engine apply: if this tx aborts after the
    // in-place `apply_op_projected` engine mutation below, the engine is rewound.
    tx.arm_engine_rollback(materializer.loro_state());

    // 1. Validate block exists and is not deleted (inside tx = TOCTOU-safe)
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;
    let block_type = existing.block_type;
    let parent_id = existing.parent_id;
    let position = existing.position;

    // 2. Find prev_edit inside transaction (delegates to the shared
    //    helper — same query also used by `flush_draft_inner`; see
    // (b)).
    let prev_edit = find_prev_edit_in_tx(&mut tx, &block_id).await?;

    // Referential cross-space integrity: reject an edit that
    // introduces `[[ULID]]` / `#[ULID]` tokens pointing at a block in a
    // different space than this one.
    crate::spaces::cross_space_validation::validate_content_cross_space_refs(
        &mut tx,
        &BlockId::from_trusted(&block_id),
        &to_text,
    )
    .await?;

    // 3. Build OpPayload
    let block_id_ulid = BlockId::from_trusted(&block_id);
    let edit_payload = EditBlockPayload {
        block_id: block_id_ulid,
        to_text: to_text.clone(),
        prev_edit,
    };

    let op_record = op_log::append_local_op_in_tx(
        &mut tx,
        device_id,
        OpPayload::EditBlock(edit_payload.clone()),
        crate::db::now_ms(),
    )
    .await?;

    // 4. #2344/#2325 route the just-appended `op_record` through the SINGLE
    // collapsed apply-projection entry point (`apply_op_projected`), IN this
    // CommandTx, INSTEAD of the direct `apply_edit_block_via_loro` call — the
    // EditBlock arm of the #2325 apply-path collapse. This is the SAME
    // engine-apply + SQL projection the boot-replay / sync `ApplyOp` path uses
    // (via `apply_op_tx`), so the LOCAL and REMOTE edit paths now share one
    // entry point. `apply_op_projected` re-derives the `EditBlockPayload` from
    // `op_record.payload` and runs the SAME `apply_edit_block_via_loro`
    // (resolve space → per-space Loro engine apply → IDENTICAL
    // `UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL`),
    // PLUS the in-tx `reindex_block_links` + `inbound_link_count` recompute the
    // Edit arm of `apply_op_tx` runs (previously deferred to the background
    // `enqueue_edit_background` fan-out on the LOCAL path). We pass
    // `advance_cursor = false`: the apply cursor stays put on the LOCAL path so
    // boot replay re-applies idempotently (the safety net while local
    // engine-apply hardens — #1257). If the block's space can't be resolved
    // (#2250: `SpaceUnresolved`), the helper internally FALLS BACK to
    // `apply_edit_block_sql_only`, so the row is never skipped and we never
    // crash. `apply_op_projected` borrows `&op_record` here, BEFORE the
    // `Arc::new(op_record)` move below. The returned `ApplyEffects` is empty for
    // Edit (LOCAL edit runs no post-commit cohort fan-out), so it is discarded.
    crate::materializer::apply_op_projected(&mut tx, &op_record, materializer.loro_state(), false)
        .await?;

    // 5. Commit + dispatch edit background cache tasks (fire-and-forget).
    //    The `block_type` hint restricts the rebuild fan-out so content
    //    blocks skip tags/pages cache work.
    //
    // Wrap once in `Arc` so the dispatch queue borrows
    //    the record by refcount (atomic increment) rather than
    //    deep-cloning the owned `String` payloads.
    let op_record = Arc::new(op_record);
    // #2397 LOAD-BEARING: the background `ReindexBlockLinks` task this enqueues is
    // the SOLE writer of the `page_link_cache` `(source_page, target_page,
    // edge_count)` rollup (via `reindex_page_link_cache_for_block`). The in-tx
    // `apply_op_projected` above maintains `block_links` + `inbound_link_count`,
    // but NOT that page-level rollup — so this enqueue must NOT be pruned as
    // redundant. Pinned by `local_edit_page_link_cache_converges_local_matches_remote_2397`.
    tx.enqueue_edit_background(Arc::clone(&op_record), block_type.clone());
    tx.commit_and_dispatch(materializer).await?;

    // 6. Return response
    Ok(BlockRow {
        id: BlockId::from_trusted(&block_id),
        block_type,
        content: Some(to_text),
        parent_id,
        position,
        deleted_at: None,
        // #656: an edit only changes `content`; the task metadata is
        // untouched, so thread the existing values through rather than
        // hardcoding `None` (which would wipe task state for any consumer
        // that applies this row optimistically).
        todo_state: existing.todo_state,
        priority: existing.priority,
        due_date: existing.due_date,
        scheduled_date: existing.scheduled_date,
        page_id: existing.page_id,
    })
}

/// Soft-delete a block and all its descendants (cascade).
///
/// Validates the block exists and is not already deleted, appends a
/// `DeleteBlock` op, sets `deleted_at` on the block and all descendants
/// via recursive CTE, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is already soft-deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn delete_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
) -> Result<DeleteResponse, AppError> {
    // #107: BlockId normalises to uppercase on construction. Re-derive the
    // owned String form for sqlx binds / format! below.
    let block_id = block_id.into_string();

    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
    });

    // Single IMMEDIATE transaction: validation + op_log + cascade soft-delete.
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // and the actual mutation.
    //
    // + `CommandTx::begin_immediate` inherits the
    // slow-acquire tracing from `begin_immediate_logged` AND couples
    // commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "cmd_delete_block").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Validate inside transaction (TOCTOU-safe). #2037 pt2: also read
    // `block_type` so the post-commit dispatch can narrow the cache-rebuild
    // fan-out for a CONTENT block (skip `RebuildTagsCache`/`RebuildPagesCache`).
    let row = sqlx::query!(
        "SELECT deleted_at, block_type FROM blocks WHERE id = ?",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    let row = row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))?;
    if row.deleted_at.is_some() {
        return Err(AppError::InvalidOperation(format!(
            "block '{block_id}' is already deleted"
        )));
    }
    let block_type = row.block_type;

    // Refuse to delete a non-empty space. The frontend
    // SpaceManageDialog already disables the delete button until the space
    // is empty, but a concurrent device creating a page in the same space
    // between the frontend probe and this IPC would otherwise leave the
    // space soft-deleted with orphan pages whose `space` ref now dangles.
    // The check runs INSIDE this BEGIN IMMEDIATE tx so no concurrent
    // CreateBlock-with-space-property can sneak in between the count and
    // the cascade. #708: "is a space" is now schema-defined — a row in the
    // `spaces` registry (kept in lockstep with the `is_space = 'true'`
    // property by the 0089 `spaces_register_is_space` trigger).
    let is_space_block = sqlx::query_scalar!(
        "SELECT 1 AS \"flag!: i64\" FROM spaces WHERE id = ?",
        block_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if is_space_block {
        // #533 Phase 2: pages in this space carry `blocks.space_id = ?`
        // (the old `block_properties(key='space')` rows are gone).
        let child_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) AS \"n!: i64\" FROM blocks b \
             WHERE b.deleted_at IS NULL \
             AND b.block_type = 'page' \
             AND b.space_id = ?",
            block_id,
        )
        .fetch_one(&mut **tx)
        .await?;
        if child_count > 0 {
            return Err(AppError::InvalidOperation(format!(
                "cannot delete space '{block_id}': it contains {child_count} pages"
            )));
        }
    }

    // Single timestamp for both op_log and blocks — reverse_delete_block uses
    // record.created_at as deleted_at_ref, so they must match exactly.
    //
    // #1549: source the delete timestamp from the monotonic-per-process
    // delete clock, NOT wall-clock `now_ms()`. The value is the cohort
    // identity for restore (`WHERE deleted_at = ?`) and for cascade-root
    // detection (`op.created_at = blocks.deleted_at`); two independent
    // deletes landing in the same wall-clock ms would otherwise collide and
    // let a restore over-restore a separately-deleted nested subtree. The
    // SAME value is written to both the op_log `created_at` and `deleted_at`,
    // so they still match exactly.
    let now = crate::db::next_delete_ms();

    // Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now).await?;

    // #2344/#2325 route the just-appended `op_record` through the SINGLE
    // collapsed apply-projection entry point (`apply_op_projected`), IN this
    // CommandTx, INSTEAD of the hand-rolled `descendants_cte_active!()` cascade
    // UPDATE — the DeleteBlock arm of the #2325 apply-path collapse. This runs
    // the SAME engine-apply + SQL projection the boot-replay / sync `ApplyOp`
    // path uses (via `apply_op_tx`'s DeleteBlock arm): the seed's per-space
    // Loro `apply_delete_block`, the IDENTICAL `project_delete_block_to_sql`
    // cascade (stamping `deleted_at = op_record.created_at = now` on the seed
    // AND every active descendant via `descendants_cte_active!()`), and the
    // `remove_subtree_inherited` tag sweep — all previously hand-rolled here.
    // `apply_op_projected` re-derives the `DeleteBlockPayload` from
    // `op_record.payload`. We pass `advance_cursor = false`: the apply cursor
    // stays put on the LOCAL path so boot replay re-applies idempotently (the
    // #1257 safety net). If the block's space can't be resolved (#2250), the
    // helper internally FALLS BACK to `apply_delete_block_sql_only` (same
    // cascade + sweep), so the row is never skipped and we never crash.
    // `apply_op_projected` borrows `&op_record` here, BEFORE the `Arc::new`
    // move below. The returned `ApplyEffects` carries the pre-UPDATE
    // `deleted_cohort` (seed + descendants) and the pre-UPDATE `delete_space_id`
    // for the post-commit engine fan-out below. The #1582/#2268 depth-cap
    // saturation warn that used to live here now runs (still gated on the
    // cascade's affected-row count >= SATURATION_PROBE_MIN_ROWS) inside
    // `project_delete_block_to_sql`, so it also covers the sql_only/replay paths.
    let effects = crate::materializer::apply_op_projected(
        &mut tx,
        &op_record,
        materializer.loro_state(),
        false,
    )
    .await?;

    // #2042: `pages_cache.{child_block_count,inbound_link_count}` for the pages
    // this subtree owned / linked into are recomputed by the background
    // `RebuildPagesCacheCounts` task (enqueued by `enqueue_lifecycle_background`
    // below, via `dispatch`'s lifecycle rebuild set) — NOT synchronously here.
    // A large-subtree delete must not hold the single-writer lock for the
    // O(descendants) `COUNT(DISTINCT)` walk. The counts are briefly stale until
    // the background drain (eventual consistency, same model as the link
    // caches that already rebuild on this path).

    // Commit + fire-and-forget background cache dispatch. #2037 pt2: thread
    // the block's type so the materializer narrows the rebuild fan-out for a
    // content-block delete (the page/tag-scoped caches can't change).
    //
    // Wrap once in `Arc` so the dispatch queue borrows the record by refcount
    // (atomic increment) rather than deep-cloning the owned `String` payloads,
    // AND the post-commit cohort fan-out below can still reference it.
    let op_record = Arc::new(op_record);
    tx.enqueue_lifecycle_background(Arc::clone(&op_record), block_type);
    tx.commit_and_dispatch(materializer).await?;

    // #2344 NEW post-commit engine cohort fan-out — the LOCAL counterpart of
    // the `dispatch_delete_descendants` call `apply_op` runs after ITS commit.
    // The in-tx engine apply above (`apply_delete_block_via_loro`) reached only
    // the SEED; the per-space Loro `apply_delete_block` is per-block-id, so the
    // DESCENDANT deletes never reach the engine without this fan-out (SQL would
    // report them deleted while the engine still shows them alive). Drives the
    // captured cohort (seed + descendants) onto the per-space engine using the
    // space id captured PRE-UPDATE (post-delete `resolve_block_space` returns
    // None for the now-tombstoned rows). Infallible / log-only, mirroring
    // `apply_op`'s call shape exactly (args, await, no `?`).
    crate::materializer::dispatch_delete_descendants(
        &op_record,
        &effects.deleted_cohort,
        effects.delete_space_id.as_ref(),
        materializer.loro_state(),
    )
    .await;

    Ok(DeleteResponse {
        block_id,
        deleted_at: now,
        // The cohort INCLUDES the seed (depth-0 anchor of `collect_delete_cohort`'s
        // active CTE), so its length equals the old cascade UPDATE's
        // `rows_affected()` exactly — the same set of rows the UPDATE touched.
        descendants_affected: effects.deleted_cohort.len() as u64,
    })
}

/// Batch variant of [`delete_block_inner`].
///
/// Soft-deletes every block in `block_ids` plus all their descendants
/// (via a single recursive CTE seeded from every root) inside one
/// `BEGIN IMMEDIATE` transaction. Replaces the per-row IPC loop the
/// FE used to drive in `useBlockMultiSelect.handleBatchDelete` —
/// 50 selected rows previously took 50 round-trips, 50 writer-lock
/// acquisitions, and 50 op_log append windows. The new path is one
/// of each.
///
/// **CTE shape**: a `WITH RECURSIVE` whose seed selects every id from
/// the input list (via `json_each`) that resolves to a non-deleted,
/// non-conflict block, and whose recursive arm walks `parent_id`
/// downward with the canonical AGENTS.md invariant #9 filters
/// (deleted_at IS NULL` in the recursive member,
/// `depth < 100` bound). Because the seed already covers every root
/// simultaneously, an ancestor's subtree subsumes any selected
/// Descendant — the FE's ancestor-pre-walk becomes
/// unnecessary (descendant ids that are also in the input set produce
/// the same union via the recursive walk).
///
/// **Tolerance for missing / already-deleted rows**: ids that don't
/// resolve, or are soft-deleted at probe time, are silently dropped
/// from the seed. The batch is best-effort across the surviving
/// subset (mirrors `set_todo_state_batch_inner`'s lenient policy and
/// matches multi-select-against-concurrent-delete reality). The
/// returned count is the number of `blocks` rows whose `deleted_at`
/// flipped from NULL to non-NULL.
///
/// **Op log shape**: one `DeleteBlock` op is appended per resolved
/// ROOT (the inputs minus the misses), NOT per descendant — the
/// recursive UPDATE captures the cascade. Mirrors the single-row
/// `delete_block_inner` shape (one op, descendants_affected reflects
/// the cascade), scaled. `tag_inheritance::remove_subtree_inherited`
/// runs once per root to sweep orphan inherited tag rows (whether
/// the cascade root was reached via single-delete or batch-delete).
///
/// **Space-block guard**: the single-row path refuses to delete a
/// Non-empty space. The batch path enforces the same guard
/// per root — if any root in the batch is a non-empty space, the
/// whole tx aborts with `InvalidOperation` (the safer choice: a
/// "delete everything but skip the space" outcome would silently
/// surface as data the user thought they deleted).
///
/// #2325/#2250 — INTENTIONAL EXCEPTION to the single-entry-point apply collapse.
/// The MULTI-ROOT batch delete soft-deletes several roots in ONE combined
/// cascade CTE (`json_each(?1)` seeds every root at once). It is deliberately
/// NOT routed through `apply_op_projected` (which projects a single
/// `DeleteBlock` at a time): fanning it out into N per-root
/// `apply_op_projected` calls would lose the single-pass combined-cascade
/// UPDATE. This is a documented, permanent exception (Stage 3) — leave the
/// combined cascade as-is.
#[instrument(skip(pool, device_id, materializer, block_ids), err)]
pub async fn delete_blocks_by_ids_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
) -> Result<i64, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;

    // #107: BlockId already normalises to uppercase on construction; re-derive
    // owned String form for the SQL membership probe below.
    let block_ids: Vec<String> = block_ids.into_iter().map(BlockId::into_string).collect();
    let ids_json = serde_json::to_string(&block_ids)?;

    let mut tx = CommandTx::begin_immediate(pool, "delete_blocks_by_ids").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Resolve the live root set INSIDE the tx so a row that was
    // soft-deleted between FE selection and this call drops out
    // cleanly.
    // #2201 item 2a: carry `block_type` alongside `id` in the live-root
    // probe so the per-root fan-out loop below no longer needs a separate
    // `SELECT block_type` per root (N+1). `block_type` is `TEXT NOT NULL`
    // (0001_initial + 0005 CHECK trigger), hence the `block_type!` annotation.
    let live_roots: Vec<(String, String)> = sqlx::query!(
        r#"SELECT id AS "id!: String", block_type AS "block_type!: String" FROM blocks
           WHERE id IN (SELECT value FROM json_each(?1))
             AND deleted_at IS NULL
"#,
        ids_json,
    )
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|row| (row.id, row.block_type))
    .collect();

    if live_roots.is_empty() {
        // Every requested id is missing or already deleted. Commit the
        // (empty) tx so any reads it took settle, return zero.
        tx.commit_and_dispatch(materializer).await?;
        return Ok(0);
    }

    // Mirror — refuse the batch if any root is a non-empty
    // space. Same reasoning as `delete_block_inner`: a partial delete
    // would silently leak orphan pages whose `space` ref dangles. We
    // surface the FIRST offending space + its child count so the
    // operator sees actionable detail.
    for (root, _root_block_type) in &live_roots {
        // #708: registry-backed "is a space" check — see the single-row
        // path above.
        let is_space_block =
            sqlx::query_scalar!("SELECT 1 AS \"flag!: i64\" FROM spaces WHERE id = ?", root,)
                .fetch_optional(&mut **tx)
                .await?
                .is_some();
        if is_space_block {
            // #533 Phase 2: pages in this space carry `blocks.space_id`.
            let child_count: i64 = sqlx::query_scalar!(
                "SELECT COUNT(*) AS \"n!: i64\" FROM blocks b \
                 WHERE b.deleted_at IS NULL \
                 AND b.block_type = 'page' \
                 AND b.space_id = ?",
                root,
            )
            .fetch_one(&mut **tx)
            .await?;
            if child_count > 0 {
                return Err(AppError::InvalidOperation(format!(
                    "cannot delete space '{root}': it contains {child_count} pages"
                )));
            }
        }
    }

    // Single timestamp for op_log + cascade UPDATE so reverse_delete_block
    // can match `op_record.created_at` against `blocks.deleted_at`.
    //
    // #1549: monotonic-per-process delete clock, NOT wall-clock `now_ms()`.
    // Each root in this batch is stamped from the SAME `now` (one cohort per
    // batch), but distinct delete *operations* (separate command invocations)
    // get distinct timestamps even within the same wall-clock ms, so a
    // restore keyed on `deleted_at = ?` cannot over-restore an
    // independently-deleted nested subtree. The value feeds both the op_log
    // `created_at` and the cascade `deleted_at` so they match exactly.
    let now = crate::db::next_delete_ms();

    // Append one `DeleteBlock` op per root (NOT per descendant — the
    // cascade is captured by the recursive UPDATE below). This mirrors
    // the single-row path's op_log shape (one op, cascade rolls up via
    // the materialised state) so revert / undo replay against the same
    // rows behaves identically regardless of whether they were deleted
    // via the single or batch path.
    // #1257 CASCADE engine routing. We must capture each root's
    // active subtree COHORT and resolve its SPACE *before* the SQL
    // soft-delete UPDATE runs below: `resolve_block_space` filters
    // `deleted_at IS NULL`, so a post-UPDATE resolve returns `None` for
    // every (now-deleted) cohort row → the engine would never see the
    // cascade and the #1257 phantom (engine-live-but-SQL-deleted) appears.
    // This mirrors `apply_op_tx`'s DeleteBlock arm exactly: capture cohort +
    // space per root here, then drive the WHOLE captured cohort onto the
    // engine via the post-commit fan-out (`dispatch_delete_descendants`,
    // run after `commit_and_dispatch` below). The fan-out is the right
    // mechanism for this MULTI-ROOT path (rather than the per-seed in-tx
    // `apply_delete_block_via_loro`): the helper's own SQL projection would
    // either double-count the cascade if run before the batch UPDATE, or
    // hit the same dead-space-resolution wall if run after it — the
    // pre-captured space sidesteps both. The op-log shape (one op per root)
    // and the apply cursor are untouched (cursor advance stays a
    // boot-replay / `dispatch_op` concern, #1248 / #1257).
    let mut delete_fanout: Vec<(
        Arc<op_log::OpRecord>,
        Vec<String>,
        Option<crate::space::SpaceId>,
    )> = Vec::with_capacity(live_roots.len());
    for (root, root_block_type) in &live_roots {
        let payload = DeleteBlockPayload {
            block_id: BlockId::from_trusted(root),
        };
        let op_record = op_log::append_local_op_in_tx(
            &mut tx,
            device_id,
            OpPayload::DeleteBlock(payload.clone()),
            now,
        )
        .await?;
        let op_record = Arc::new(op_record);
        // #2037 pt2: the root's `block_type` (used to narrow the rebuild
        // fan-out for a CONTENT root) now rides along on the `live_roots`
        // probe above (#2201 item 2a), dropping the former per-root
        // `SELECT block_type` N+1 lookup.
        tx.enqueue_lifecycle_background(Arc::clone(&op_record), root_block_type.clone());

        // PRE-UPDATE capture (load-bearing — see comment above): the active
        // subtree cohort (seed + active descendants) and the seed's space,
        // both resolved while the rows are still `deleted_at IS NULL`.
        let cohort = crate::materializer::collect_delete_cohort(&mut tx, &payload).await?;
        let delete_space_id =
            crate::space::resolve_block_space(&mut **tx, &payload.block_id).await?;
        delete_fanout.push((op_record, cohort, delete_space_id));
    }

    // Stamp the UNION of the pre-captured per-root cohorts. The cohorts were
    // collected above (pre-UPDATE, same tx) by `collect_delete_cohort`, whose
    // walk is depth-UNBOUNDED (R27: batched capped CTEs re-anchored at the
    // depth-100 boundary — a merged sync tree can legally exceed the local
    // depth bound, and the old single capped CTE silently truncated its
    // cascade there). Stamping exactly the captured union keeps the SQL rows
    // and the post-commit engine fan-out consuming ONE list, so the two can
    // never diverge on pathological trees. `deleted_at IS NULL` keeps the
    // UPDATE idempotent; overlapping roots (one selected root inside another's
    // subtree) dedupe via the `IN`. Cap crossings warn loudly inside the
    // walker (superseding the former `MAX(depth) >= 99` saturation probe).
    let union_cohort: Vec<&str> = {
        let mut seen = std::collections::HashSet::new();
        delete_fanout
            .iter()
            .flat_map(|(_, cohort, _)| cohort.iter())
            .filter(|id| seen.insert(id.as_str()))
            .map(String::as_str)
            .collect()
    };
    let union_cohort_json = serde_json::to_string(&union_cohort)?;
    // dynamic-sql: json_each id-list UPDATE over the walked cohort union;
    // single bound JSON parameter, immune to the SQLite variable limit.
    let result = sqlx::query(
        "UPDATE blocks SET deleted_at = ?2 \
         WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL",
    )
    .bind(&union_cohort_json)
    .bind(now)
    .execute(&mut **tx)
    .await?;

    // P-4 — sweep inherited tag rows for every root. Per-root call
    // (the helper takes a single seed); the SQL it emits is bounded
    // by the same depth-100 invariant.
    for (root, _root_block_type) in &live_roots {
        crate::tag_inheritance::remove_subtree_inherited(&mut tx, root).await?;
    }

    // #2042: pages_cache counts are recomputed by the background
    // `RebuildPagesCacheCounts` task (enqueued per root via
    // `enqueue_lifecycle_background` above), not synchronously here — a
    // multi-root subtree delete must not hold the single-writer lock for the
    // O(descendants) count walk. See `delete_block_inner`.

    tx.commit_and_dispatch(materializer).await?;

    // #1257 POST-COMMIT engine fan-out. Drive each root's
    // pre-captured cohort (seed + active descendants) onto the per-space
    // Loro engine using the PRE-UPDATE-captured space id. Mirrors
    // `apply_op`'s `dispatch_delete_descendants` call: the engine's
    // `apply_delete_block` is per-block-id and idempotent, so re-applying
    // the seed is harmless, and the captured space sidesteps the
    // dead-space-resolution problem (post-delete `resolve_block_space`
    // returns None for every cohort row). Without this the engine would
    // keep the cohort alive while SQL reports it deleted — the #1257
    // Phantom the freshness gate refuses to ship. A cohort row whose
    // space did not resolve is a no-op inside the helper; the SQL cascade
    // above stands as the durable outcome.
    for (op_record, cohort, delete_space_id) in &delete_fanout {
        crate::materializer::dispatch_delete_descendants(
            op_record,
            cohort,
            delete_space_id.as_ref(),
            materializer.loro_state(),
        )
        .await;
    }

    // Return the number of blocks the cascade soft-deleted (roots +
    // descendants combined). Callers can compare against
    // `block_ids.len()` to compute "skipped because missing".
    Ok(result.rows_affected().cast_signed())
}

/// Tauri command: batch-delete blocks by ids.
///
/// Delegates to [`delete_blocks_by_ids_inner`]. Single IMMEDIATE tx
/// covers the whole batch — collapses the legacy N-IPC loop in
/// `useBlockMultiSelect.handleBatchDelete` into one round-trip and
/// one writer-lock window. Returns the number of blocks soft-deleted
/// (roots + descendants combined).
#[tauri::command]
#[specta::specta]
pub async fn delete_blocks_by_ids(
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<BlockId>,
) -> Result<i64, AppError> {
    delete_blocks_by_ids_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), block_ids)
        .await
        .map_err(sanitize_internal_error)
}

/// #81 / bulk move N blocks to a target space (the Pages
/// multi-select "move selected to space" action).
///
/// A "space" is a page block flagged `is_space = 'true'`; a block's
/// membership is the reserved `space` ref-property pointing at the space
/// block (see `commands/spaces.rs`). Moving a block between spaces is
/// exactly `SetProperty(key = "space", value_ref = <space_id>)` — the same
/// op the single-row frontend path emits via `set_property`. This command
/// applies that op to every block in `block_ids` inside ONE
/// `BEGIN IMMEDIATE` transaction, collapsing what would otherwise be one
/// `set_property` IPC per selected row.
///
/// One `SetProperty(space)` op is appended per block actually moved, so the
/// `LAST_APPEND` task-local drains as ONE activity-feed entry covering the
/// whole batch. The whole batch shares one op-log seq range.
///
/// **Space validation runs ONCE** (mirrors `create_page_in_space_inner`):
/// `space_id` must resolve to a live, non-conflict block carrying
/// `is_space = 'true'`. A bad target aborts the whole tx with
/// `AppError::Validation` — a caller error, not data drift.
///
/// **Per-block leniency** (mirrors `set_todo_state_batch_inner`): each id
/// that no longer resolves to a live block is silently SKIPPED rather than
/// aborting the batch — multi-select races against concurrent deletes /
/// sync replay. The per-block write reuses [`set_property_in_tx`] so the
/// reserved-`space`-key materialisation + op-log shape is identical to the
/// single-row path (the `space` key is exempt from the cross-space ref
/// guard — it is precisely *how* blocks move between spaces).
///
/// Returns the number of blocks actually moved (NOT the input list length).
///
/// # Errors
///
/// - [`AppError::Validation`] — empty input list, > [`MAX_BATCH_BLOCK_IDS`](crate::commands::MAX_BATCH_BLOCK_IDS) entries, or `space_id` is not a live space block
#[instrument(skip(pool, device_id, materializer, block_ids), err)]
pub async fn move_blocks_to_space_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
    space_id: String,
) -> Result<i64, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;

    // #107: BlockId normalises to uppercase on construction; re-derive owned
    // String form. `space_id` (SpaceId, separate type) is still a String arg
    // and needs explicit normalisation.
    let block_ids: Vec<String> = block_ids.into_iter().map(BlockId::into_string).collect();
    let space_id = space_id.to_ascii_uppercase();

    // One IMMEDIATE tx covers space validation + every per-block move.
    let mut tx = CommandTx::begin_immediate(pool, "move_blocks_to_space").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Validate `space_id` ONCE inside the tx (TOCTOU-safe against a
    // concurrent space delete). Mirrors `create_page_in_space_inner`: the
    // target must be a live, non-conflict block carrying `is_space = 'true'`.
    let space_ok = sqlx::query_scalar!(
        r#"SELECT 1 as "ok: i32" FROM blocks b
           WHERE b.id = ?
             AND b.deleted_at IS NULL
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
        space_id,
    )
    .fetch_optional(&mut **tx)
    .await?;
    if space_ok.is_none() {
        return Err(AppError::validation(format!(
            "space_id '{space_id}' does not refer to a live space block (is_space = 'true')"
        )));
    }

    // #2038: resolve the live target set in ONE membership query instead of a
    // per-block existence SELECT inside the loop (N+1). Skip-on-miss preserved:
    // a row deleted between FE selection and this call is absent from `alive`.
    let block_ids_json = serde_json::to_string(&block_ids)?;
    let alive: std::collections::HashSet<String> = sqlx::query_scalar!(
        r#"SELECT id FROM blocks
           WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL"#,
        block_ids_json
    )
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect();

    // #2201: hoist the `space` key's `property_definitions` lookup out of the
    // per-block loop. `set_property_in_tx` runs `SELECT value_type, options
    // FROM property_definitions WHERE key = ?` on EVERY iteration; the row for
    // the fixed `space` key is invariant across the loop, so fetch it ONCE and
    // feed it to `set_property_in_tx_with_declaration` per block. Identical
    // behaviour: the declaration is exactly what the wrapper would have
    // fetched each time (the same SELECT, same `key`), so validation and the
    // written rows are unchanged — only the redundant N-1 SELECTs are removed.
    // (Non-clear write — `value_ref` is Some — so the wrapper's `is_clear`
    // skip never applied; the lookup always ran.)
    let space_declaration: Option<PropertyDeclaration> = sqlx::query!(
        "SELECT value_type, options FROM property_definitions WHERE key = ?",
        SPACE_PROPERTY_KEY,
    )
    .fetch_optional(&mut **tx)
    .await?
    .map(|row| PropertyDeclaration {
        value_type: row.value_type,
        options: row.options,
    });

    let mut moved: i64 = 0;
    for block_id in block_ids {
        if !alive.contains(&block_id) {
            continue;
        }

        // Reuse the canonical per-row helper so reserved/ref-key validation,
        // op_log append (recorded in LAST_APPEND), and the `block_properties`
        // materialised write share the single source of truth with the
        // single-row `set_property` path. The `space` key is non-reserved and
        // is exempt from the cross-space ref guard (see `set_property_in_tx`).
        // Pass the pre-fetched declaration (#2201) so the per-block
        // `property_definitions` SELECT is skipped.
        let (_row, op_record) = set_property_in_tx_with_declaration(
            &mut tx,
            materializer.loro_state(),
            device_id,
            block_id,
            SPACE_PROPERTY_KEY,
            None,
            None,
            None,
            Some(space_id.clone()),
            None,
            space_declaration.clone(),
        )
        .await?;
        tx.enqueue_background(op_record);
        moved += 1;
    }

    tx.commit_and_dispatch(materializer).await?;

    Ok(moved)
}

/// Tauri command: move N blocks to a target space (#81).
/// Delegates to [`move_blocks_to_space_inner`]. Returns the number of
/// blocks actually moved.
#[tauri::command]
#[specta::specta]
pub async fn move_blocks_to_space(
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<BlockId>,
    space_id: SpaceId,
) -> Result<i64, AppError> {
    // b2 (#2248): required-target-space commands take the `SpaceId` newtype at
    // the wire boundary. The lenient `Deserialize` only uppercases, so reject a
    // malformed id here rather than letting a never-matching filter reach the
    // space-existence check with an opaque error.
    space_id.validate_shape()?;
    move_blocks_to_space_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_ids,
        space_id.into_string(),
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Restore a soft-deleted block and its descendants.
///
/// Validates the block exists and is deleted with the expected `deleted_at`
/// timestamp (optimistic concurrency guard), appends a `RestoreBlock` op,
/// clears `deleted_at` on matching descendants, and dispatches background
/// cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is not deleted, or `deleted_at` timestamp mismatch
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn restore_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
    deleted_at_ref: i64,
) -> Result<RestoreResponse, AppError> {
    // #107: BlockId normalises to uppercase on construction; re-derive owned
    // String form for sqlx binds / format! below.
    let block_id = block_id.into_string();

    // Single IMMEDIATE transaction: validation + op_log + restore.
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // and the actual mutation.
    //
    // Slow-acquire timed via `begin_immediate_logged`.
    // + CommandTx inherits slow-acquire tracing from
    // begin_immediate_logged AND couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "cmd_restore_block").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Validate inside transaction (TOCTOU-safe). #2037 pt2: also read
    // `block_type` so the post-commit dispatch can narrow the cache-rebuild
    // fan-out for a CONTENT block.
    let row = sqlx::query!(
        "SELECT deleted_at, block_type FROM blocks WHERE id = ?",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let block_type = match row {
        None => {
            return Err(AppError::NotFound(format!("block '{block_id}'")));
        }
        Some(ref r) if r.deleted_at.is_none() => {
            return Err(AppError::InvalidOperation(format!(
                "block '{block_id}' is not deleted"
            )));
        }
        Some(r) => {
            if let Some(ref actual_deleted_at) = r.deleted_at
                && *actual_deleted_at != deleted_at_ref
            {
                return Err(AppError::InvalidOperation(format!(
                    "block '{block_id}' deleted_at mismatch: expected '{deleted_at_ref}', got '{actual_deleted_at}'"
                )));
            }
            r.block_type
        }
    };

    let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        deleted_at_ref,
    });

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, crate::db::now_ms()).await?;

    // Restore within same transaction.
    //
    // R27: cohort-contiguous, depth-UNBOUNDED walk (batched capped CTEs,
    // re-anchored at the depth-100 boundary) + json_each UPDATE — the SAME
    // shape as `project_restore_block_to_sql` and `collect_restore_cohort`,
    // so the SQL rows this command clears, the replay projection, and the
    // post-commit engine fan-out all consume one walk definition and cannot
    // diverge on a merged tree deeper than the cap. Cohort identity stays
    // structural (#1055): each batch's recursive arm only descends through
    // `deleted_at = ?` children, which also keeps conflict copies (independent
    // lifecycles) out of the bulk restore.
    let restore_cohort = crate::block_descendants::collect_subtree_ids_unbounded(
        &mut tx,
        &block_id,
        crate::block_descendants::DescendantWalkFilter::Cohort(deleted_at_ref),
    )
    .await?;
    let restore_cohort_json = serde_json::Value::from(restore_cohort).to_string();
    // dynamic-sql: json_each id-list UPDATE over the walked cohort; single
    // bound JSON parameter, immune to the SQLite variable limit.
    let result = sqlx::query(
        "UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at = ?2",
    )
    .bind(&restore_cohort_json)
    .bind(deleted_at_ref)
    .execute(&mut **tx)
    .await?;

    // #1884: also restore UPWARD. The downward CTE above only clears
    // `deleted_at` on the block and its descendants, but the block's PARENT
    // may itself be soft-deleted (delete child → later delete parent: the
    // parent's cascade SKIPS the already-deleted child, so the child becomes
    // a trash root). Restoring the child alone would make it LIVE under a
    // still-tombstoned, invisible parent — absent from both tree and trash.
    // Walk up the contiguous soft-deleted ancestor chain to the nearest live
    // ancestor (or root) and restore it, reconnecting the block to the live
    // tree. Done BEFORE the page/space re-derivation below so it sees the
    // restored ancestors. Returns the TOPMOST restored ancestor id (or `None`
    // when the parent chain was already live), used below as the re-derivation
    // root so the whole reconnected subtree is refreshed.
    // #2017: the engine fan-out for the restored ancestor chain happens in the
    // materializer replay arm (`apply_op` → `dispatch_restore_ancestors`),
    // driven by the op enqueued via `commit_and_dispatch` below — the same path
    // that fans the descendant cohort out. The command tx only owns the SQL
    // `deleted_at` clear here; we keep `topmost` for the re-derivation root.
    let restored_ancestor_top =
        crate::block_descendants::restore_deleted_ancestor_chain(&mut tx, &block_id)
            .await?
            .topmost;

    // R27: the pre-fix #2268 `MAX(depth)` saturation probe is gone — the
    // batched walk above no longer truncates at the depth-100 cap (crossing
    // it warns loudly inside `collect_subtree_ids_unbounded` instead).

    // Refresh `page_id` for the restored subtree synchronously,
    // mirroring the recursive-CTE UPDATE in `move_block_inner` (see
    // `move_ops.rs:177-234`). The async `RebuildPageIds` task dispatched
    // via `commit_and_dispatch` below stays in place (idempotent — running
    // it again is safe), but without this sync update there's a window
    // where callers reading right after commit see a stale `page_id`
    // (e.g. pointing at a page the parent has since been moved out of:
    // `move_block_inner`'s recursive UPDATE skips deleted descendants,
    // so a soft-deleted block keeps its pre-move `page_id` until restore).
    //
    // Invariant #9: the recursive CTE filters  in both
    // members AND bounds `depth < 100`. Conflict copies inherit
    // `parent_id` from the original and would otherwise be reparented
    // under the restored subtree.
    //
    // #664: recompute `page_id` AND `space_id` for the restored subtree,
    // synchronously (callers read space-scoped lists right after commit, so
    // both columns must be re-derived in-tx). Shared helper lives in
    // `crate::commands::block_cleanup`.
    crate::commands::block_cleanup::rederive_page_and_space_ids(&mut tx, &block_id).await?;

    // #1884: when an ancestor chain was also restored above, drive the
    // re-derivation / inheritance / cache recompute from the TOPMOST restored
    // ancestor, so the entire reconnected subtree — not just `block_id`'s —
    // gets correct `page_id`/`space_id`, inherited tags, and page counts. When
    // no ancestor was restored this resolves to `block_id` (unchanged
    // behaviour).
    let inheritance_root = restored_ancestor_top
        .clone()
        .unwrap_or_else(|| block_id.clone());
    if inheritance_root != block_id {
        crate::commands::block_cleanup::rederive_page_and_space_ids(&mut tx, &inheritance_root)
            .await?;
    }

    // P-4: Recompute inherited tags for restored subtree
    crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &inheritance_root).await?;

    // #2042: pages_cache counts for the restored subtree's pages are recomputed
    // by the background `RebuildPagesCacheCounts` task (enqueued via
    // `enqueue_lifecycle_background` below), not synchronously here — see
    // `delete_block_inner`. Counts are briefly stale until the background drain.

    // Commit + fire-and-forget background cache dispatch. #2037 pt2: thread
    // the block's type so the materializer narrows the rebuild fan-out for a
    // content-block restore.
    tx.enqueue_lifecycle_background(Arc::new(op_record), block_type);
    tx.commit_and_dispatch(materializer).await?;

    Ok(RestoreResponse {
        block_id,
        restored_count: result.rows_affected(),
    })
}

/// One purge root's post-commit engine fan-out inputs: the appended
/// `PurgeBlock` op record (for op identity + timestamp), the pre-cascade
/// subtree cohort ids, and the root's space.
type PurgeEngineFanout = (
    Arc<op_log::OpRecord>,
    Vec<String>,
    Option<crate::space::SpaceId>,
);

/// #1257 PRE-CASCADE capture for the post-commit engine purge fan-out.
///
/// Captures a purge root's full subtree COHORT and its SPACE while the SQL
/// rows still exist — once `purge_subtree_tables` runs they are physically
/// gone and neither could be reconstructed. A purged block is SQL-ABSENT
/// (not soft-deleted), so it does not itself create the #1257
/// engine-live-but-SQL-deleted phantom the sync gate refuses; but the
/// engine must still drop the purged subtree from its LoroDoc to stay in
/// lockstep — otherwise the subtree keeps exporting over sync and any
/// inbound peer change touching it resurrects the purged rows into SQL.
///
/// The cohort walk mirrors the SQL cascade's shape (`deleted_at`-free,
/// `depth < 100` cap). The root is soft-deleted, so the canonical
/// `resolve_block_space` (which filters `deleted_at IS NULL`) would return
/// `None`; the denormalized `blocks.space_id` column (which survives a
/// soft-delete) is read directly instead. Shared by all three purge
/// variants (`purge_block_inner`, `purge_all_deleted_inner`,
/// `purge_blocks_by_ids_inner`) so their engine handling cannot drift.
async fn capture_purge_engine_fanout(
    tx: &mut CommandTx,
    root_id: &str,
) -> Result<(Vec<String>, Option<crate::space::SpaceId>), AppError> {
    let cohort = sqlx::query_scalar::<_, String>(concat!(
        // #1655: single-root purge cohort walk via the shared
        // `descendants_cte_purge!()` macro (no `deleted_at` filter,
        // `depth < 100` cap) instead of re-inlining the CTE body.
        crate::descendants_cte_purge!(),
        "SELECT id FROM descendants",
    ))
    .bind(root_id)
    .fetch_all(&mut ***tx)
    .await?;
    let space_id = sqlx::query_scalar!("SELECT space_id FROM blocks WHERE id = ?", root_id)
        .fetch_optional(&mut ***tx)
        .await?
        .flatten()
        .map(|s| crate::space::SpaceId::from_trusted(&s));
    Ok((cohort, space_id))
}

/// #1257 POST-COMMIT engine fan-out shared by all three purge variants.
///
/// Drops each purged subtree from the per-space Loro engine using the
/// PRE-CASCADE-captured cohort + space (the SQL rows are physically gone
/// by now, so neither could be recovered here). `engine_apply(PurgeBlock)`
/// removes a block's `blocks`/`block_properties`/`block_tags` entries from
/// the LoroDoc; it is per-block-id, so the whole captured cohort is
/// driven. Mirrors the delete/restore fan-out. A no-space root is a no-op;
/// the SQL cascade stands as the durable outcome.
fn dispatch_purge_engine_fanout(materializer: &Materializer, fanout: &[PurgeEngineFanout]) {
    for (op_record, cohort, purge_space_id) in fanout {
        let Some(space_id) = purge_space_id else {
            continue;
        };
        for cohort_id in cohort {
            let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
                block_id: BlockId::from_trusted(cohort_id),
            });
            let op_id = format!(
                "{}/{}#cohort/{}",
                op_record.device_id, op_record.seq, cohort_id,
            );
            crate::merge::engine_apply(
                &op_id,
                &payload,
                &op_record.device_id,
                space_id,
                &op_record.created_at.to_string(),
                materializer.loro_state(),
            );
        }
    }
}

/// Permanently purge a soft-deleted block and all its descendants.
///
/// Validates the block exists and is already soft-deleted, appends a
/// `PurgeBlock` op, then physically deletes the block, its descendants,
/// and all related rows (tags, properties, links, caches, FTS, drafts,
/// attachments) in a single deferred-FK transaction.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is not soft-deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn purge_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
) -> Result<PurgeResponse, AppError> {
    // #107: BlockId normalises to uppercase on construction; re-derive owned
    // String form for sqlx binds / format! below.
    let block_id = block_id.into_string();

    // F03: Single IMMEDIATE transaction for validation + op_log + physical purge.
    // Previously the op_log write and the physical purge were split across two
    // transactions, meaning a crash between them left the op_log recording a
    // purge that never happened.  Now everything is in one atomic tx.
    //
    // Slow-acquire timed via `begin_immediate_logged`. Purge is
    // the most cascade-heavy write path and the most likely to show
    // contention under load.
    // + CommandTx inherits slow-acquire tracing from
    // begin_immediate_logged AND couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "cmd_purge_block").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Validate inside transaction (TOCTOU-safe). #2037 pt2: also read
    // `block_type` so the post-commit dispatch can narrow the cache-rebuild
    // fan-out for a CONTENT block.
    let row = sqlx::query!(
        "SELECT deleted_at, block_type FROM blocks WHERE id = ?",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let block_type = match row {
        None => {
            return Err(AppError::NotFound(format!("block \'{block_id}\'")));
        }
        Some(ref r) if r.deleted_at.is_none() => {
            return Err(AppError::InvalidOperation(format!(
                "block \'{block_id}\' must be soft-deleted before purging"
            )));
        }
        Some(r) => r.block_type, // block is deleted, proceed with purge
    };

    // Refuse to purge a tree that is so deep the cascade
    // would saturate the depth-100 cap. Hard delete must be
    // all-or-nothing — a saturating cascade leaves dangling rows past
    // depth 100. Checked BEFORE the physical delete so the abort is
    // a clean rollback (op_log entry not yet appended; tx not yet
    // committed). Standard-variant under-detection of pure-conflict
    // chains is acceptable: the cap is preserved either way and the
    // operator gets a clear error on the common case.
    if crate::block_descendants::cascade_depth_saturated(&mut **tx, &block_id).await? {
        return Err(AppError::validation(format!(
            "block '{block_id}' subtree is too deep to purge (>=99 levels); \
             the recursive cascade would hit the depth-100 cap and leave \
             descendants below depth 100 dangling. Purge in chunks instead.",
        )));
    }

    let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
    });

    // Append to op_log within transaction
    let op_record = Arc::new(
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, crate::db::now_ms()).await?,
    );

    // #1257 PRE-CASCADE capture: the purge cohort + space must be read
    // BEFORE the physical delete below erases them — see
    // `capture_purge_engine_fanout`. Drives the post-commit engine fan-out
    // that keeps the per-space LoroDoc in lockstep with the SQL purge
    // (mirroring `purge_blocks_by_ids_inner`).
    let (purge_cohort, purge_space_id) = capture_purge_engine_fanout(&mut tx, &block_id).await?;

    // --- Inline physical purge (previously soft_delete::purge_block) ---
    // Defer FK checks until commit — the entire subtree will be gone by then
    // so no constraints will be violated.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut **tx)
        .await?;

    // #2042: pages_cache counts for surviving pages that lose an inbound edge
    // (or a child) from this purged subtree are recomputed by the background
    // `RebuildPagesCacheCounts` task (enqueued via `enqueue_lifecycle_background`
    // below), not synchronously here — a large-subtree purge must not hold the
    // single-writer lock for the O(descendants) count walk. See
    // `delete_block_inner`.

    // PURGE: erase every row descended from the purged block. The
    // single-root `descendants_cte_purge!()` walks the subtree without
    // filters, bounded only by `depth < 100` against corrupted parent_id
    // chains. #664: the satellite-table chain (block_tags … blocks, with
    // the pre-DELETE attachment-path capture) lives in the shared
    // `crate::commands::block_cleanup::purge_subtree_tables` helper — the
    // single source of truth across all three purge variants. The
    // materializer's `OpType::PurgeBlock` handler mirrors this sequence for
    // remote ops.
    let (purged_attachment_paths, count) = crate::commands::block_cleanup::purge_subtree_tables(
        &mut tx,
        crate::descendants_cte_purge!(),
        "SELECT id FROM descendants",
        Some(&block_id),
    )
    .await?;

    // #2042: see the note above — surviving pages' counts are recomputed by the
    // background `RebuildPagesCacheCounts` task, not synchronously here.

    // Commit + fire-and-forget background cache dispatch. #2037 pt2: thread
    // the block's type so the materializer narrows the rebuild fan-out for a
    // content-block purge.
    tx.enqueue_lifecycle_background(Arc::clone(&op_record), block_type);
    tx.commit_and_dispatch(materializer).await?;

    // #1257 POST-COMMIT engine fan-out: drop the purged subtree from the
    // per-space Loro engine (see `dispatch_purge_engine_fanout`).
    dispatch_purge_engine_fanout(materializer, &[(op_record, purge_cohort, purge_space_id)]);

    // #85 F2: unlink the purged attachment files post-commit (best-effort).
    spawn_purged_attachment_cleanup(materializer.app_data_dir(), purged_attachment_paths);

    Ok(PurgeResponse {
        block_id,
        purged_count: count,
    })
}

/// Restore ALL soft-deleted blocks in a single transaction.
///
/// Finds cascade roots from the op-log, creates a `RestoreBlock` op for
/// each, then clears `deleted_at` on ALL deleted blocks. Recomputes tag
/// inheritance afterward.
///
/// # Cascade-root derivation (C9, #345 — fixed)
///
/// Cascade roots are derived from the `delete_block` op-log entries
/// (`op.created_at = blocks.deleted_at`) when one exists, falling back to
/// the structural `deleted_at`-equality heuristic only for op-less
/// tombstones (recovery / legacy / the low-level `cascade_soft_delete`
/// primitive, which does not append to `op_log`). This closes the prior
/// same-millisecond collision window where two distinct cascade-delete
/// events whose roots shared a timestamp were conflated into a single root,
/// emitting one fewer `RestoreBlock` op than performed and leaving a peer's
/// replay with one subtree unrestored. `now_ms()` is not strictly monotonic
/// across pool connections, so a pure structural heuristic could not be made
/// collision-safe; for op-backed deletes the op id is authoritative.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn restore_all_deleted_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BulkTrashResponse, AppError> {
    // CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "bulk_restore_trash").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // C9 (#345) — derive cascade roots from the op-log when one exists,
    // falling back to the structural heuristic only for op-less tombstones.
    //
    // Production deletes go through `delete_block_inner`, which appends one
    // `DeleteBlock` op per root with `op.created_at == blocks.deleted_at`
    // (the same `now` is written to both). Matching on that timestamp makes
    // the root test exact and collision-proof:
    //   * a true root's tombstone equals its own delete op's timestamp;
    //   * a cascade descendant carries the ROOT's timestamp (different
    //     `block_id`), so it never matches its own (absent) op;
    //   * a block re-trashed as a descendant after a prior root delete
    //     (del@T1 → restore → cascade@T2) carries `deleted_at = T2` while
    //     its stale op has `created_at = T1` — correctly demoted.
    //
    // This fixes the same-ms collision the old structural heuristic
    // ("root = parent_id NULL or parent's `deleted_at` differs") produced:
    // `del child@T` then `del parent@T` left both sharing `deleted_at = T`,
    // so the heuristic demoted the child → one fewer `RestoreBlock` op →
    // a peer's replay left the child unrestored. `now_ms()` is not strictly
    // monotonic across pool connections, so a pure structural test could
    // never be made collision-safe; the op id is authoritative.
    //
    // The structural fallback (the `OR NOT EXISTS(delete_block op)` branch)
    // is retained ONLY for tombstones with no `delete_block` op at all —
    // op-less soft-deletes from recovery, legacy data, or the low-level
    // `cascade_soft_delete` primitive (which does not append to `op_log`).
    // For those there is no op id to key on, so the original parent-vs-self
    // `deleted_at` comparison remains the best available signal.
    // #2037 pt2: select `block_type` so each per-root dispatch can narrow
    // the rebuild fan-out for a CONTENT root.
    let roots = sqlx::query!(
        "SELECT b.id, b.deleted_at, b.block_type FROM blocks b \
         WHERE b.deleted_at IS NOT NULL \
         AND ( \
           EXISTS ( \
             SELECT 1 FROM op_log o \
             WHERE o.op_type = 'delete_block' \
               AND o.block_id = b.id \
               AND o.created_at = b.deleted_at \
           ) \
           OR ( \
             NOT EXISTS ( \
               SELECT 1 FROM op_log o \
               WHERE o.op_type = 'delete_block' AND o.block_id = b.id \
             ) \
             AND ( \
               b.parent_id IS NULL \
               OR NOT EXISTS ( \
                 SELECT 1 FROM blocks p \
                 WHERE p.id = b.parent_id AND p.deleted_at = b.deleted_at \
               ) \
             ) \
           ) \
         )"
    )
    .fetch_all(&mut **tx)
    .await?;

    if roots.is_empty() {
        return Ok(BulkTrashResponse { affected_count: 0 });
    }

    let now = crate::db::now_ms();
    // Append one RestoreBlock op per root for sync compatibility.
    for root in &roots {
        // The selecting query filters `WHERE deleted_at IS NOT NULL`, so this
        // is a structural invariant. Return a graceful AppError instead of
        // panicking if a schema/migration bug ever violates it (#542).
        let deleted_at_ref = root.deleted_at.ok_or_else(|| {
            AppError::InvalidOperation(format!(
                "restore: block {} selected as deleted but has NULL deleted_at",
                root.id
            ))
        })?;
        let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(&root.id),
            deleted_at_ref,
        });
        let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now).await?;
        tx.enqueue_lifecycle_background(Arc::new(op_record), root.block_type.clone());
    }

    // Bulk restore: clear deleted_at on ALL deleted blocks
    let result = sqlx::query!("UPDATE blocks SET deleted_at = NULL WHERE deleted_at IS NOT NULL")
        .execute(&mut **tx)
        .await?;

    let count = result.rows_affected();

    // (a) + P7 (#346): refresh `page_id` for every restored block
    // synchronously. The async `RebuildPageIds` materializer task dispatched
    // via `commit_and_dispatch` below stays in place (idempotent), but
    // without this sync update callers reading right after commit can see a
    // stale `page_id` (e.g. a soft-deleted block keeps its pre-move
    // `page_id` because `move_block_inner`'s recursive UPDATE skips deleted
    // descendants).
    //
    // P7: the prior implementation looped ~4 single-row queries per root
    // (SELECT parent_id, SELECT parent page_id, SELECT block_type, UPDATE
    // self, then a per-root recursive UPDATE). Because `restore_all_deleted`
    // clears `deleted_at` on the ENTIRE table above, every block is now
    // alive, so `page_id` can be recomputed for the whole tree set-based in
    // two statements regardless of root count:
    //   1. pages self-reference (`page_id = id`);
    //   2. a single recursive CTE walks parent→child from the page roots,
    //      propagating each page's id down to its non-page descendants.
    // This mirrors the post-recovery fixpoint in
    // `recover_blocks_from_op_log` (`db.rs`), collapsed into one recursive
    // pass (`depth < 100` bounds runaway recursion on corrupted chains;
    // invariant #9). No `deleted_at` filter is needed — nothing is deleted
    // at this point — and conflict copies, now also alive, are correctly
    // routed to their own page ancestry.
    sqlx::query!("UPDATE blocks SET page_id = id WHERE block_type = 'page'")
        .execute(&mut **tx)
        .await?;
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    sqlx::query!(
        "WITH RECURSIVE page_of(id, page_id, depth) AS ( \
             SELECT id, id, 0 FROM blocks WHERE block_type = 'page' \
             UNION ALL \
             SELECT b.id, p.page_id, p.depth + 1 \
             FROM blocks b \
             JOIN page_of p ON b.parent_id = p.id \
             WHERE b.block_type != 'page' AND p.depth < 100 \
         ) \
         UPDATE blocks SET page_id = ( \
             SELECT page_id FROM page_of WHERE page_of.id = blocks.id \
         ) \
         WHERE block_type != 'page' \
           AND EXISTS (SELECT 1 FROM page_of WHERE page_of.id = blocks.id)"
    )
    .execute(&mut **tx)
    .await?;

    // Recompute tag inheritance for all restored root blocks
    for root in &roots {
        crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &root.id).await?;
    }

    // Commit + drain enqueued background dispatches in FIFO order.
    tx.commit_and_dispatch(materializer).await?;

    Ok(BulkTrashResponse {
        affected_count: count,
    })
}

/// Permanently purge ALL soft-deleted blocks in a single transaction.
///
/// Creates `PurgeBlock` ops for cascade roots, then bulk-deletes all
/// dependent rows and the blocks themselves. Irreversible.
///
/// # Cascade-root derivation (C9, #345 — fixed)
///
/// Same as `restore_all_deleted_inner`: cascade roots are derived from the
/// `delete_block` op-log entries (`op.created_at = blocks.deleted_at`) when
/// one exists, falling back to the structural heuristic only for op-less
/// tombstones. This closes the prior same-millisecond collision window where
/// two delete events sharing a timestamp emitted a single `PurgeBlock` op
/// instead of two, leaving a peer with one subtree intact after replay.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn purge_all_deleted_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BulkTrashResponse, AppError> {
    // CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "purge_all_deleted").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // C9 (#345) — derive cascade roots from the op-log when one exists
    // (`op.created_at = blocks.deleted_at`), falling back to the structural
    // heuristic only for op-less tombstones. This is collision-proof on the
    // same-ms window the old `parent.deleted_at = b.deleted_at` heuristic
    // conflated. See the matching block in `restore_all_deleted_inner` for
    // the full rationale.
    // #2037 pt2: select `block_type` so each per-root dispatch can narrow
    // the rebuild fan-out for a CONTENT root.
    let roots = sqlx::query!(
        "SELECT b.id, b.deleted_at, b.block_type FROM blocks b \
         WHERE b.deleted_at IS NOT NULL \
         AND ( \
           EXISTS ( \
             SELECT 1 FROM op_log o \
             WHERE o.op_type = 'delete_block' \
               AND o.block_id = b.id \
               AND o.created_at = b.deleted_at \
           ) \
           OR ( \
             NOT EXISTS ( \
               SELECT 1 FROM op_log o \
               WHERE o.op_type = 'delete_block' AND o.block_id = b.id \
             ) \
             AND ( \
               b.parent_id IS NULL \
               OR NOT EXISTS ( \
                 SELECT 1 FROM blocks p \
                 WHERE p.id = b.parent_id AND p.deleted_at = b.deleted_at \
               ) \
             ) \
           ) \
         )"
    )
    .fetch_all(&mut **tx)
    .await?;

    if roots.is_empty() {
        return Ok(BulkTrashResponse { affected_count: 0 });
    }

    let now = crate::db::now_ms();
    let mut purge_fanout: Vec<PurgeEngineFanout> = Vec::with_capacity(roots.len());
    for root in &roots {
        let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::from_trusted(&root.id),
        });
        let op_record =
            Arc::new(op_log::append_local_op_in_tx(&mut tx, device_id, payload, now).await?);
        tx.enqueue_lifecycle_background(Arc::clone(&op_record), root.block_type.clone());

        // #1257 PRE-CASCADE capture: cohort + space per root, read before
        // the flat delete below erases the rows — drives the post-commit
        // engine fan-out (mirroring `purge_blocks_by_ids_inner`).
        let (cohort, space_id) = capture_purge_engine_fanout(&mut tx, &root.id).await?;
        purge_fanout.push((op_record, cohort, space_id));
    }

    // Defer FK checks until commit
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut **tx)
        .await?;

    // Cleanup for every table referencing `blocks.id`: match any row whose
    // target block is soft-deleted. Since ALL deleted blocks (and their
    // descendants — the cascade already ran at the individual purge layer)
    // carry `deleted_at IS NOT NULL`, the member set is the flat
    // `deleted_at IS NOT NULL` selection rather than a recursive CTE; there
    // is no seed-id placeholder, so `bind` is `None`. #664: the
    // satellite-table chain (block_tags … blocks, with the pre-DELETE
    // attachment-path capture) lives in the shared
    // `crate::commands::block_cleanup::purge_subtree_tables` helper.
    let (attachment_rows, count) = crate::commands::block_cleanup::purge_subtree_tables(
        &mut tx,
        "",
        "SELECT id FROM blocks WHERE deleted_at IS NOT NULL",
        None,
    )
    .await?;
    // Commit + drain the queued PurgeBlock op records for background
    // dispatch. Attachment-file unlink runs after dispatch (cache
    // rebuilds are independent of the filesystem side effect).
    tx.commit_and_dispatch(materializer).await?;

    // #1257 POST-COMMIT engine fan-out: drop every purged subtree from the
    // per-space Loro engine (see `dispatch_purge_engine_fanout`).
    dispatch_purge_engine_fanout(materializer, &purge_fanout);

    // + #85 F2: post-commit attachment-file unlink on a blocking thread
    // (the per-file `unlink` syscalls must not hold up the IPC reply; the DB tx
    // has committed, so failures are best-effort warn-logs). Resolves paths
    // against the materializer's `app_data_dir` — no longer a CWD-relative
    // `remove_file`.
    spawn_purged_attachment_cleanup(materializer.app_data_dir(), attachment_rows);

    Ok(BulkTrashResponse {
        affected_count: count,
    })
}

/// Restore N soft-deleted blocks (and their cascaded
/// descendants) in a single IMMEDIATE transaction.
///
/// Mirrors [`restore_all_deleted_inner`]'s body but scopes the work to the
/// supplied id list via `WHERE id IN (SELECT value FROM json_each(?1))`.
/// The TrashView batch-restore action loops `restore_block_inner` once per
/// selected row today (50 IMMEDIATE txs for a 50-row selection); this
/// command collapses that to a single round trip and a single op_log
/// scope.
///
/// Each input id is treated as a *root* of a soft-delete cascade —
/// the frontend's batch action is sourced from
/// `listTrash` which already returns roots only.
///
/// C3 (#345): the descendant walk is a cohort-scoped recursive CTE — it
/// only restores descendants that share their seed root's exact
/// `deleted_at` timestamp, matching the single-row path's
/// `AND deleted_at = deleted_at_ref` guard per-root (NOT "any tombstoned
/// descendant"). A child trashed in a different delete event keeps its
/// tombstone, and the emitted `RestoreBlock(deleted_at_ref)` op restores
/// the same cohort a peer's replay would — no sync divergence. Non-deleted
/// ids in the input are silently no-ops.
///
/// Returns the number of blocks whose `deleted_at` was actually cleared
/// (roots + descendants), NOT the input list length.
///
/// # Errors
///
/// - [`AppError::Validation`] — empty input list, or > [`MAX_BATCH_BLOCK_IDS`](crate::commands::MAX_BATCH_BLOCK_IDS) entries
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn restore_blocks_by_ids_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
) -> Result<BulkTrashResponse, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;

    // #107: BlockId normalises to uppercase on construction; re-derive owned
    // String form for the JSON membership probe below.
    let block_ids: Vec<String> = block_ids.into_iter().map(BlockId::into_string).collect();
    let ids_json = serde_json::to_string(&block_ids)?;

    // CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "restore_blocks_by_ids").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Resolve which input ids are actually soft-deleted "roots" — a
    // present, deleted block. Skips ids that are alive or missing
    // (mirrors `restore_all_deleted_inner`'s no-throw policy on its
    // sweep). Each surviving root contributes one `RestoreBlock` op.
    // #2037 pt2: select `block_type` so each per-root dispatch can narrow
    // the rebuild fan-out for a CONTENT root.
    let roots = sqlx::query!(
        "SELECT b.id, b.deleted_at, b.block_type FROM blocks b \
         WHERE b.id IN (SELECT value FROM json_each(?1)) \
           AND b.deleted_at IS NOT NULL",
        ids_json,
    )
    .fetch_all(&mut **tx)
    .await?;

    if roots.is_empty() {
        return Ok(BulkTrashResponse { affected_count: 0 });
    }

    let now = crate::db::now_ms();

    // One RestoreBlock op per root for sync compatibility (mirrors
    // `restore_all_deleted_inner`).
    //
    // #1257 CASCADE engine routing. Capture each root's connected
    // delete cohort (the #1055 `deleted_at_ref`-scoped subtree) BEFORE the
    // UPDATE clears `deleted_at` — once the rows are alive again the
    // `deleted_at = deleted_at_ref` filter no longer identifies the cohort.
    // We drive the captured cohort onto the engine via the post-commit
    // `dispatch_restore_descendants` fan-out (run after `commit_and_dispatch`
    // below), mirroring `apply_op`. The restore fan-out resolves the space
    // inline post-commit (the cohort is alive by then, so
    // `resolve_block_space` succeeds — the asymmetry with delete noted in
    // `ApplyEffects`). Engine `apply_restore_block` is idempotent, so the
    // seed re-apply is harmless. The op-log shape (one op per root) and the
    // apply cursor are untouched.
    let mut restore_fanout: Vec<(Arc<op_log::OpRecord>, Vec<String>)> =
        Vec::with_capacity(roots.len());
    for root in &roots {
        // The selecting query filters `WHERE deleted_at IS NOT NULL`, so this
        // is a structural invariant. Return a graceful AppError instead of
        // panicking if a schema/migration bug ever violates it (#542).
        let deleted_at_ref = root.deleted_at.ok_or_else(|| {
            AppError::InvalidOperation(format!(
                "restore: block {} selected as deleted but has NULL deleted_at",
                root.id
            ))
        })?;
        let inner_payload = RestoreBlockPayload {
            block_id: BlockId::from_trusted(&root.id),
            deleted_at_ref,
        };
        let op_record = op_log::append_local_op_in_tx(
            &mut tx,
            device_id,
            OpPayload::RestoreBlock(inner_payload.clone()),
            now,
        )
        .await?;
        let op_record = Arc::new(op_record);
        // #2037 pt2: thread this root's type so a content-block restore
        // skips the page/tag-scoped rebuilds.
        tx.enqueue_lifecycle_background(Arc::clone(&op_record), root.block_type.clone());

        // PRE-UPDATE capture of the connected cohort (#1055 contiguous walk).
        let cohort = crate::materializer::collect_restore_cohort(&mut tx, &inner_payload).await?;
        restore_fanout.push((op_record, cohort));
    }

    // C3 (#345): restore each root's EXACT delete cohort, not "any
    // tombstoned descendant" — a child trashed at T1 that later sits under
    // a root cascade-deleted at T2 must NOT be restored with the T2 root
    // (the per-root op emitted above carries the root's own `deleted_at`,
    // so a peer replaying it restores only the T2 cohort; over-restoring
    // locally would diverge from sync).
    //
    // The cohort identity is enforced at CAPTURE time: each root's
    // `collect_restore_cohort` walk above only descends through children
    // sharing the root's `deleted_at_ref` (and is depth-UNBOUNDED per R27
    // — batched capped CTEs re-anchored at the depth-100 boundary — so a
    // merged tree deeper than the cap restores its whole cohort). Stamping
    // exactly the captured union keeps the SQL rows and the post-commit
    // engine fan-out consuming ONE list, so the two can never diverge.
    // Overlapping roots dedupe via the `IN`; `deleted_at IS NOT NULL`
    // keeps the UPDATE idempotent.
    let union_cohort: Vec<&str> = {
        let mut seen = std::collections::HashSet::new();
        restore_fanout
            .iter()
            .flat_map(|(_, cohort)| cohort.iter())
            .filter(|id| seen.insert(id.as_str()))
            .map(String::as_str)
            .collect()
    };
    let union_cohort_json = serde_json::to_string(&union_cohort)?;
    // dynamic-sql: json_each id-list UPDATE over the walked cohort union;
    // single bound JSON parameter, immune to the SQLite variable limit.
    let result = sqlx::query(
        "UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NOT NULL",
    )
    .bind(&union_cohort_json)
    .execute(&mut **tx)
    .await?;
    let count = result.rows_affected();

    // Recompute tag inheritance for each restored root subtree.
    for root in &roots {
        crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &root.id).await?;
    }

    // #2042: pages_cache counts for the restored subtrees' pages are recomputed
    // by the background `RebuildPagesCacheCounts` task (enqueued per root via
    // `enqueue_lifecycle_background` above), not synchronously here — see
    // `delete_block_inner`.

    // Commit + drain enqueued background dispatches.
    tx.commit_and_dispatch(materializer).await?;

    // #1257 POST-COMMIT engine fan-out. Restore each root's captured
    // cohort on the per-space Loro engine (mirrors `apply_op`'s
    // `dispatch_restore_descendants`). The fan-out resolves the space inline
    // from the pool — valid because the cohort is alive again post-commit.
    // Engine `apply_restore_block` is idempotent. Engine-absent is a no-op.
    for (op_record, cohort) in &restore_fanout {
        crate::materializer::dispatch_restore_descendants(
            pool,
            op_record,
            cohort,
            materializer.loro_state(),
        )
        .await;
    }

    Ok(BulkTrashResponse {
        affected_count: count,
    })
}

/// Permanently purge N soft-deleted blocks (and their
/// cascaded descendants) in a single IMMEDIATE transaction.
///
/// Mirrors [`purge_all_deleted_inner`]'s ~13-table cleanup chain but
/// scopes each `DELETE` to descendants of the input id list via a
/// multi-root recursive CTE. The TrashView batch-purge action loops
/// `purge_block_inner` once per selected row today (50 IMMEDIATE txs,
/// each running the full cleanup chain); this command collapses that to
/// a single round trip and runs each cleanup-chain query exactly once.
///
/// Each input id must already be soft-deleted (the TrashView only
/// surfaces deleted rows). Non-deleted or missing ids in the input
/// are silently dropped (mirrors the "all" variant's `WHERE
/// deleted_at IS NOT NULL` skip semantics). The descendant walk uses
/// the purge variant of the recursive CTE — every trace of the
/// subtree is erased.
///
/// Returns the number of `blocks` rows physically removed.
///
/// # Errors
///
/// - [`AppError::Validation`] — empty input list, or > [`MAX_BATCH_BLOCK_IDS`](crate::commands::MAX_BATCH_BLOCK_IDS) entries
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn purge_blocks_by_ids_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
) -> Result<BulkTrashResponse, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;

    // #107: BlockId normalises to uppercase on construction; re-derive owned
    // String form for the JSON membership probe below.
    let block_ids: Vec<String> = block_ids.into_iter().map(BlockId::into_string).collect();
    let ids_json = serde_json::to_string(&block_ids)?;

    // CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "purge_blocks_by_ids").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Audit Validator I11 note: the "all" variant's root-selection step
    // (`SELECT roots WHERE deleted_at IS NOT NULL AND parent NOT cascade`)
    // is replaced here by the simpler "input list filtered to actually
    // soft-deleted rows" lookup — the input IS the root set. Non-deleted
    // / missing ids get silently skipped, matching the "all" variant's
    // implicit behaviour against a mixed table.
    // #2037 pt2: select `block_type` so each per-root dispatch can narrow
    // the rebuild fan-out for a CONTENT root.
    let roots = sqlx::query!(
        "SELECT b.id, b.block_type FROM blocks b \
         WHERE b.id IN (SELECT value FROM json_each(?1)) \
           AND b.deleted_at IS NOT NULL",
        ids_json,
    )
    .fetch_all(&mut **tx)
    .await?;

    if roots.is_empty() {
        return Ok(BulkTrashResponse { affected_count: 0 });
    }

    // Multi-root descendant CTE — variant of `descendants_cte_purge!()`
    // seeded from `json_each(?1)`. Like the single-root purge CTE this
    // does NOT filter `deleted_at` (PURGE is the documented exception to
    // invariant #9). `depth < 100` still bounds runaway recursion. Kept
    // inline as a `&str` so each `sqlx::query(...)` call can `concat!`
    // against per-table tail clauses without macro expansion gymnastics.
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    let cte = "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks \
             WHERE id IN (SELECT value FROM json_each(?1)) \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE d.depth < 100 \
         ) ";

    // + R5 (#347) — refuse to purge if ANY root's subtree
    // saturates the depth-100 cap; mirroring the single-row guard. The
    // prior implementation ran `cascade_depth_saturated` once per root (up
    // to MAX_BATCH_BLOCK_IDS = 1000 separate recursive walks). Collapse it
    // into a single `SELECT MAX(depth)` over the SAME multi-root CTE the
    // deletes below already use: one walk covers every root's subtree, and
    // `MAX(depth) >= 99` flags saturation exactly as
    // `cascade_depth_saturated` does (the recursive arm's `d.depth < 100`
    // lets the walk step from 99 to 100, so >= 99 is the conservative
    // boundary). When saturated we can't cheaply name the offending root
    // without re-walking, so the message points at the batch.
    let max_depth: Option<i64> = sqlx::query_scalar::<_, Option<i64>>(sqlx::AssertSqlSafe(
        format!("{cte}SELECT MAX(depth) FROM descendants"),
    ))
    .bind(&ids_json)
    .fetch_one(&mut **tx)
    .await?;
    if max_depth.unwrap_or(0) >= 99 {
        return Err(AppError::validation(
            "a selected block's subtree is too deep to purge (>=99 levels); \
             the recursive cascade would hit the depth-100 cap and leave \
             descendants below depth 100 dangling. Purge in chunks instead."
                .into(),
        ));
    }

    // Emit one PurgeBlock op per root.
    //
    // #1257 CASCADE engine routing. Capture each root's full purge
    // subtree COHORT and its SPACE BEFORE the SQL cascade physically
    // removes the rows below: once the rows are gone we cannot reconstruct
    // the cohort or resolve its space. A purged block is SQL-ABSENT (not
    // soft-deleted), so it does not itself create the #1257
    // Engine-live-but-SQL-deleted phantom the gate refuses; but the
    // engine must still drop the purged subtree from its LoroDoc to stay in
    // lockstep. We drive the captured cohort onto the engine via a
    // post-commit `engine_apply(PurgeBlock)` fan-out (run after
    // `commit_and_dispatch`), mirroring the delete/restore fan-out and the
    // boot-replay path. The roots are soft-deleted, so the canonical
    // `resolve_block_space` (which filters `deleted_at IS NULL`) returns
    // None — we read the denormalized `blocks.space_id` column directly
    // (it survives a soft-delete) at this pre-cascade moment. Engine-absent
    // / no-space is a no-op; the SQL cascade stands. The op-log shape (one
    // op per root) and the apply cursor are untouched.
    let now = crate::db::now_ms();
    let mut purge_fanout: Vec<PurgeEngineFanout> = Vec::with_capacity(roots.len());
    for root in &roots {
        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(&root.id),
        };
        let op_record = op_log::append_local_op_in_tx(
            &mut tx,
            device_id,
            OpPayload::PurgeBlock(payload.clone()),
            now,
        )
        .await?;
        let op_record = Arc::new(op_record);
        // #2037 pt2: thread this root's type so a content-block purge skips
        // the page/tag-scoped rebuilds.
        tx.enqueue_lifecycle_background(Arc::clone(&op_record), root.block_type.clone());

        // PRE-CASCADE capture: the full subtree (purge ignores `deleted_at`,
        // invariant #9 exception — mirror the same shape the cascade walks)
        // and the seed's denormalized space (read directly; the canonical
        // resolver filters out this soft-deleted row). Shared helper used by
        // all three purge variants.
        let (cohort, purge_space_id) = capture_purge_engine_fanout(&mut tx, &root.id).await?;
        purge_fanout.push((op_record, cohort, purge_space_id));
    }

    // Defer FK checks until commit — the entire subtree(s) will be gone
    // by then so no constraints will be violated.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut **tx)
        .await?;

    // #664: the satellite-table chain (block_tags … blocks, with the
    // pre-DELETE attachment-path capture) lives in the shared
    // `crate::commands::block_cleanup::purge_subtree_tables` helper — the
    // single source of truth across all three purge variants. Here the
    // member set is the multi-root `json_each`-seeded `descendants` CTE
    // (the `cte` prefix built above), bound to the `?1` JSON id array.
    let (attachment_rows, count) = crate::commands::block_cleanup::purge_subtree_tables(
        &mut tx,
        cte,
        "SELECT id FROM descendants",
        Some(&ids_json),
    )
    .await?;

    // #2042: pages_cache counts for surviving pages that had inbound links from
    // the purged subtrees are recomputed by the background
    // `RebuildPagesCacheCounts` task (enqueued per root via
    // `enqueue_lifecycle_background` above), not synchronously here — see
    // `delete_block_inner`.

    // Commit + drain enqueued background dispatches.
    tx.commit_and_dispatch(materializer).await?;

    // #1257 POST-COMMIT engine fan-out. Drop each purged subtree from the
    // per-space Loro engine using the PRE-CASCADE-captured cohort + space
    // (see `dispatch_purge_engine_fanout` — shared by all three purge
    // variants).
    dispatch_purge_engine_fanout(materializer, &purge_fanout);

    // + #85 F2: post-commit attachment-file unlink (mirrors
    // `purge_all_deleted_inner`), resolved against the materializer's
    // `app_data_dir` rather than a CWD-relative `remove_file`.
    spawn_purged_attachment_cleanup(materializer.app_data_dir(), attachment_rows);

    Ok(BulkTrashResponse {
        affected_count: count,
    })
}

/// Delete (or clear) a property on a block inside an existing transaction.
///
/// Sibling of [`set_property_in_tx`] for the recurrence/timestamp paths in
/// [`set_todo_state_inner`] (H-4) that need to clear `created_at` /
/// `completed_at` as part of a multi-op atomic state transition. Unlike
/// [`delete_property_core`](super::super::delete_property_core) (which opens
/// its own `BEGIN IMMEDIATE` and dispatches background work on commit), this
/// helper runs entirely inside the caller's transaction. The caller is
/// responsible for `tx.enqueue_background(op)` + `tx.commit_and_dispatch(...)`.
///
/// Reserved keys (`todo_state` / `priority` / `due_date` / `scheduled_date`)
/// clear the matching column on `blocks`; non-reserved keys delete the row
/// from `block_properties`.
///
/// Returns the [`op_log::OpRecord`] for the appended `DeleteProperty` op so
/// the caller can queue background dispatch.
pub(crate) async fn delete_property_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    block_id: &str,
    key: &str,
) -> Result<op_log::OpRecord, AppError> {
    // 1. Validate block exists (TOCTOU-safe — read inside the same tx as
    //    the write below).
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id,
    )
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // 2. Append DeleteProperty op.
    let del_payload = DeletePropertyPayload {
        block_id: BlockId::from_trusted(block_id),
        key: key.to_owned(),
    };
    let op_record = op_log::append_local_op_in_tx(
        &mut *tx,
        device_id,
        OpPayload::DeleteProperty(del_payload.clone()),
        crate::db::now_ms(),
    )
    .await?;

    // 3. #1257 route the clear/delete through the SAME engine-apply +
    // projection the boot-replay / sync `ApplyOp` path uses, IN this CommandTx,
    // INSTEAD of the inline reserved-column / `space` fan-out / `block_properties`
    // DELETE branches. `apply_delete_property_via_loro` resolves the block's
    // space, removes the key from the per-space Loro engine (sync guard, dropped
    // before any `.await`), then `project_delete_property_to_sql` runs the
    // IDENTICAL per-key SQL (reserved → column NULL; `space` → the
    // `space_id` page-group clear; non-reserved → `DELETE FROM block_properties`).
    // We do NOT call `apply_op_tx` / `advance_apply_cursor`: the apply cursor
    // stays put on the LOCAL path so boot replay re-applies idempotently (the
    // safety net while local engine-apply hardens — #1257). If the block's
    // space cannot be resolved the helper internally FALLS BACK to
    // `apply_delete_property_sql_only`, which runs the SAME projection — so the
    // clear is never skipped and we never crash.
    // #2325/#2250: route through the collapsed single-entry-point projection
    // (`advance_cursor = false`, #1257). It re-derives the
    // `DeletePropertyPayload` from `op_record.payload` and runs the SAME
    // `apply_delete_property_via_loro` (DeleteProperty is `PreOpState::None`, so
    // `apply_op_tx`'s count maintenance is a no-op and the effects are empty).
    crate::materializer::apply_op_projected(&mut *tx, &op_record, state, false).await?;

    Ok(op_record)
}

/// Tauri command: create a new block. Delegates to
/// [`create_block_inner_with_space`] which enforces the
/// "every page has a space" invariant at the IPC boundary
/// The optional `space_id` is required when
/// `block_type == "page"` and ignored otherwise.
///
/// #2468: the response carries the produced op ref(s) (`WithOps` — a
/// flattened, strict superset of the previous `BlockRow` shape) so the
/// frontend undo stack can address the action by exact ref (`undo_op`).
#[tauri::command]
#[specta::specta]
pub async fn create_block(
    ctx: State<'_, WriteCtx>,
    block_type: String,
    content: String,
    parent_id: Option<BlockId>,
    // #400: 0-based sibling slot among `parent_id`'s children; `None` appends.
    index: Option<i64>,
    scope: SpaceScope,
) -> Result<WithOps<BlockRow>, AppError> {
    capture_op_refs(create_block_inner_with_space(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_type,
        content,
        parent_id,
        index,
        &scope,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: edit a block's content. Delegates to [`edit_block_inner`].
/// #2468: the response carries the produced op ref(s) — see [`create_block`].
#[tauri::command]
#[specta::specta]
pub async fn edit_block(
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    to_text: String,
) -> Result<WithOps<BlockRow>, AppError> {
    capture_op_refs(edit_block_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_id,
        to_text,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: soft-delete a block and descendants. Delegates to [`delete_block_inner`].
/// #2468: the response carries the produced op ref(s) — see [`create_block`].
#[tauri::command]
#[specta::specta]
pub async fn delete_block(
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
) -> Result<WithOps<DeleteResponse>, AppError> {
    capture_op_refs(delete_block_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_id,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: restore a soft-deleted block. Delegates to [`restore_block_inner`].
#[tauri::command]
#[specta::specta]
pub async fn restore_block(
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    deleted_at_ref: i64,
) -> Result<RestoreResponse, AppError> {
    restore_block_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_id,
        deleted_at_ref,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: permanently purge a soft-deleted block. Delegates to [`purge_block_inner`].
#[tauri::command]
#[specta::specta]
pub async fn purge_block(
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
) -> Result<PurgeResponse, AppError> {
    purge_block_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: restore all soft-deleted blocks. Delegates to [`restore_all_deleted_inner`].
#[tauri::command]
#[specta::specta]
pub async fn restore_all_deleted(ctx: State<'_, WriteCtx>) -> Result<BulkTrashResponse, AppError> {
    restore_all_deleted_inner(ctx.pool(), ctx.device_id(), ctx.materializer())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: permanently purge all soft-deleted blocks. Delegates to [`purge_all_deleted_inner`].
#[tauri::command]
#[specta::specta]
pub async fn purge_all_deleted(ctx: State<'_, WriteCtx>) -> Result<BulkTrashResponse, AppError> {
    purge_all_deleted_inner(ctx.pool(), ctx.device_id(), ctx.materializer())
        .await
        .map_err(sanitize_internal_error)
}

/// Restore a list of soft-deleted blocks in one IPC.
/// Delegates to [`restore_blocks_by_ids_inner`].
#[tauri::command]
#[specta::specta]
pub async fn restore_blocks_by_ids(
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<BlockId>,
) -> Result<BulkTrashResponse, AppError> {
    restore_blocks_by_ids_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), block_ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Permanently purge a list of soft-deleted blocks in one IPC.
/// Delegates to [`purge_blocks_by_ids_inner`].
#[tauri::command]
#[specta::specta]
pub async fn purge_blocks_by_ids(
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<BlockId>,
) -> Result<BulkTrashResponse, AppError> {
    purge_blocks_by_ids_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), block_ids)
        .await
        .map_err(sanitize_internal_error)
}

// ===========================================================================
// Create_blocks_batch
// ===========================================================================

/// One row of [`create_blocks_batch_inner`]'s input list.
///
/// Mirrors the per-block argument set the FE used to send to `create_block`
/// once per descendant / per markdown line in `template-utils.ts`. The
/// `properties` map carries arbitrary `key -> value_text` pairs that land
/// as `SetProperty` ops inside the same transaction (mirrors
/// `import_markdown_inner`'s precedent — see `pages.rs:622-637`). Reserved
/// keys (`todo_state` / `priority` / `due_date` / `scheduled_date`) route
/// through the same `set_property_in_tx` helper so they hit the right
/// columns on `blocks` instead of `block_properties`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateBlockSpec {
    /// `"content"`, `"tag"`, or `"page"`. Validated per-spec by
    /// [`create_block_in_tx`] — an unknown value rolls back the whole
    /// batch with [`AppError::Validation`].
    pub block_type: String,
    /// Block content (markdown / plain text). Validated against
    /// `MAX_CONTENT_LENGTH` per spec.
    pub content: String,
    /// Optional parent block id. When `Some`, the parent must resolve
    /// to a live (non-deleted, non-conflict) block — including parents
    /// created EARLIER in the same batch. When `None`, the new block is
    /// top-level.
    pub parent_id: Option<BlockId>,
    /// Optional 1-based sibling position (stable wire field). `None` appends
    /// after the last sibling. #400: converted to the engine's 0-based sibling
    /// `index` at the call site (position 1 → index 0).
    pub position: Option<i64>,
    /// Optional `key -> value_text` map. Each entry expands to a
    /// `SetProperty` op inside the same transaction. Empty map → no
    /// property ops appended. Mirror of the (key, value) loop in
    /// `import_markdown_inner` for parsed markdown property lines.
    #[serde(default)]
    pub properties: std::collections::HashMap<String, String>,
}

/// Atomically create N blocks (with optional
/// per-block properties) in a single `BEGIN IMMEDIATE` transaction.
///
/// Replaces the per-block `create_block` IPC loop the FE used to drive
/// in `template-utils.ts::insertTemplateBlocks` /
/// `insertTemplateBlocksFromString` (one IPC per descendant / per
/// markdown line). The new path is one IPC, one writer-lock window, one
/// op_log scope.
///
/// Per-spec semantics: each entry in `specs` runs through
/// [`create_block_in_tx`] (the same helper [`import_markdown_inner`] uses,
/// see `pages.rs:607`), accumulating `(BlockRow, OpRecord)` pairs. After
/// the `CreateBlock` op is appended, every `(key, value)` pair in
/// `properties` runs through [`set_property_in_tx`] — same precedent as
/// the markdown-import loop (`pages.rs:622-637`). All ops enqueue for
/// background dispatch; one `commit_and_dispatch` at the end drains them
/// in FIFO order.
///
/// **Atomicity contract — all-or-nothing:** any error inside the loop
/// (e.g. invalid `block_type`, missing parent, oversize content,
/// property validation rejection) propagates via `?` and rolls the
/// entire transaction back. No partial commits, no half-written
/// templates.
///
/// **Order:** the returned `Vec<BlockRow>` is in input order (1:1 with
/// `specs`). Callers (template insertion) rely on this to map their
/// template-line index → returned block id.
///
/// **Validation:**
/// - Empty `specs` list → [`AppError::Validation`].
/// - `specs.len()` > [`MAX_BATCH_BLOCK_IDS`](crate::commands::MAX_BATCH_BLOCK_IDS) → [`AppError::Validation`].
///
/// **Forward references:** a spec's `parent_id` may reference a block
/// id created EARLIER in the same batch. `create_block_in_tx`'s parent
/// validation runs against the live transaction state, so a row
/// inserted at index `i` is visible to the parent probe at index
/// `j > i`.
#[instrument(skip(pool, device_id, materializer, specs), err)]
pub async fn create_blocks_batch_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    specs: Vec<CreateBlockSpec>,
) -> Result<Vec<BlockRow>, AppError> {
    if specs.is_empty() {
        return Err(AppError::validation("specs list cannot be empty".into()));
    }
    crate::commands::ensure_batch_within_cap("specs", specs.len())?;

    // PRE-VALIDATE every spec's pure shape (block_type membership, content
    // length) BEFORE the loop's first `apply_op_projected` commits a block
    // into the shared per-space Loro engine. The engine has NO rollback: a
    // mid-batch shape rejection used to roll back SQL + op_log while specs
    // `0..k` stayed committed in the LoroDoc — phantom nodes that export
    // over sync. The loop's own `create_block_in_tx` re-runs these checks
    // (unchanged), so behaviour is identical for single creates; per-spec
    // checks that need tx state (parent liveness, depth, cross-space refs,
    // property validation) still run in-loop and are covered by
    // `create_block_in_tx`'s validate-before-engine-apply ordering.
    for spec in &specs {
        crate::domain::block_ops::validate_create_block_shape(&spec.block_type, &spec.content)?;
    }

    let mut tx = CommandTx::begin_immediate(pool, "create_blocks_batch").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    let mut created: Vec<BlockRow> = Vec::with_capacity(specs.len());

    for spec in specs {
        // Contract — any failure here rolls back the whole tx via
        // `?`. Mirrors `import_markdown_inner`'s per-block loop.
        // #400: the spec keeps its stable 1-based `position` wire field;
        // `create_block_in_tx` now takes a 0-based `index`, so convert
        // (position 1 → index 0 = first child). `None` still appends.
        let index = spec.position.map(|p| (p - 1).max(0));
        let (block, block_op) = create_block_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            spec.block_type,
            spec.content,
            spec.parent_id.map(BlockId::into_string),
            index,
        )
        .await?;
        tx.enqueue_background(block_op);

        // Properties — same shape as `import_markdown_inner`. Each
        // (key, value) pair becomes one `SetProperty` op inside this same
        // transaction. Reserved keys (`todo_state` / `priority` /
        // `due_date` / `scheduled_date`) route through the column-write
        // branch of `set_property_in_tx`, but the date reserved keys need
        // the `value_date` field shape (not `value_text`) to validate —
        // #623. The helper types the flat string value per key.
        for (key, value) in &spec.properties {
            let (value_text, value_num, value_date, value_ref, value_bool) =
                crate::domain::block_ops::typed_property_args_for_string_value(key, value.clone());
            let (_block, prop_op) = set_property_in_tx(
                &mut tx,
                materializer.loro_state(),
                device_id,
                block.id.clone().into_string(),
                key,
                value_text,
                value_num,
                value_date,
                value_ref,
                value_bool,
            )
            .await?;
            tx.enqueue_background(prop_op);
        }

        created.push(block);
    }

    tx.commit_and_dispatch(materializer).await?;

    Ok(created)
}

/// Tauri command: atomically create a batch of blocks. Delegates to
/// [`create_blocks_batch_inner`].
///
/// Collapses the per-block `create_block` IPC loop
/// in `src/lib/template-utils.ts::insertTemplateBlocks` /
/// `insertTemplateBlocksFromString` into one round-trip and one
/// writer-lock window. A 10-line template that previously fired 10
/// IPCs now fires 1.
#[tauri::command]
#[specta::specta]
pub async fn create_blocks_batch(
    ctx: State<'_, WriteCtx>,
    specs: Vec<CreateBlockSpec>,
) -> Result<Vec<BlockRow>, AppError> {
    create_blocks_batch_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), specs)
        .await
        .map_err(sanitize_internal_error)
}

/// Render an attachment path for structured logs without leaking the raw
/// filename.
///
/// Returns `(path_hash, extension)` where:
/// * `path_hash` is a 16-hex-char truncation of `blake3(path.as_bytes())`,
///   stable across runs so repeated failures for the same path correlate.
/// * `extension` is the lowercase file extension (or `""` when there is
///   none). The extension is retained because it's low-entropy and helps
///   diagnose "is this a PDF vs an image" problems without exposing the
///   user's chosen filename.
///
/// Used by the trash/purge paths (`purge_block_inner`,
/// `purge_all_deleted_inner`) where the full path would otherwise be
/// written to the log.
pub(crate) fn anonymize_attachment_path(path: &str) -> (String, String) {
    let hash = blake3::hash(path.as_bytes());
    // First 8 bytes == 16 hex chars is enough for correlation without
    // approaching brute-force reversibility concerns.
    let short_hash: String = hash
        .as_bytes()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect();
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    (short_hash, extension)
}

/// Remove the on-disk files for a set of just-purged attachments.
///
/// #85: attachment `fs_path`s are stored **app-data-relative**
/// (e.g. `attachments/<ULID>`). This resolves each against `app_data_dir`
/// (`app_data_dir.join(fs_path)`) — the proper absolute path — rather than the
/// earlier bulk paths' bare relative `remove_file`, which only worked when the
/// process CWD happened to equal the app-data dir. All three purge paths funnel
/// through here so the single-block purge no longer leaks files and the bulk
/// paths stop depending on CWD.
///
/// Defensive: an `fs_path` that is absolute or contains a `..` component is
/// skipped (it cannot be a legitimate app-relative attachment path and joining
/// it could escape the attachments dir). A missing file is a no-op — the
/// `CleanupOrphanedAttachments` GC sweep is the backstop. Pure + synchronous so
/// it is unit-testable; the spawn wrapper handles the off-thread, post-commit,
/// best-effort execution.
pub(crate) fn remove_purged_attachment_files(app_data_dir: &std::path::Path, fs_paths: &[String]) {
    for fs_path in fs_paths {
        let p = std::path::Path::new(fs_path.as_str());
        if p.is_absolute()
            || p.components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            let (path_hash, ext) = anonymize_attachment_path(fs_path);
            tracing::warn!(
                path_hash = %path_hash,
                extension = %ext,
                "skipping attachment deletion: unsafe path"
            );
            continue;
        }
        let full = app_data_dir.join(p);
        match std::fs::remove_file(&full) {
            Ok(()) => {}
            // Already gone (double-purge, prior GC sweep) — not an error.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                let (path_hash, ext) = anonymize_attachment_path(fs_path);
                tracing::warn!(
                    path_hash = %path_hash,
                    extension = %ext,
                    error = %e,
                    "failed to remove attachment file after purge"
                );
            }
        }
    }
}

/// Post-commit, best-effort unlink of purged attachment files on a blocking
/// thread (per-file `unlink` syscalls must not hold up the IPC reply; the DB
/// tx has already committed, so failures are warn-logged only). `app_data_dir`
/// comes from the `Materializer` (`None` when unwired, e.g. in tests) — a
/// `None` dir or empty path list skips the spawn entirely. The `JoinHandle` is
/// intentionally dropped (fire-and-forget).
fn spawn_purged_attachment_cleanup(
    app_data_dir: Option<std::path::PathBuf>,
    fs_paths: Vec<String>,
) {
    if fs_paths.is_empty() {
        return;
    }
    let Some(app_data_dir) = app_data_dir else {
        tracing::debug!(
            count = fs_paths.len(),
            "skipping purged-attachment unlink: app_data_dir not set (GC sweep is the backstop)"
        );
        return;
    };
    tokio::task::spawn_blocking(move || {
        remove_purged_attachment_files(&app_data_dir, &fs_paths);
    });
}

#[cfg(test)]
mod saturation_probe_tests {
    //! #2268: the depth-saturation probe on the single-block delete/restore and
    //! batch-delete paths is now gated behind a cheap `rows_affected` threshold
    //! so the common (shallow) case does ZERO extra `MAX(depth)` walks. These
    //! tests assert the gate still SURFACES the `>=99`-level warn on a genuinely
    //! pathological chain, and stays SILENT (probe skipped) on a shallow tree.
    //!
    //! R27 update: the SINGLE-block delete path now routes through
    //! `project_delete_block_to_sql`, whose cascade walks the subtree in
    //! depth-capped BATCHES (`collect_subtree_ids_unbounded`) instead of one
    //! capped CTE — a merged sync tree can legally exceed the local depth
    //! bound, and truncating its cascade stranded live orphans under
    //! tombstoned ancestors. That path therefore COMPLETES past the cap and
    //! emits the walker's cap-crossing breadcrumb rather than the old
    //! truncation warn (`delete_block_inner_cascades_past_depth_cap_r27`).
    //! The local restore / batch-delete paths keep the capped CTE + the
    //! original saturation warn (their tests below are unchanged).
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        (pool, dir)
    }

    /// Insert a linear parent→child chain of `n` content blocks directly into
    /// `blocks` (bypassing the command layer, like the integration-test
    /// `insert_block` helper). Returns the root id. Node `i` sits at cascade
    /// depth `i`, so `n = 101` yields a subtree whose `MAX(depth) = 100 >= 99`.
    async fn insert_chain(pool: &SqlitePool, prefix: &str, n: usize) -> String {
        let root = format!("{prefix}000");
        for i in 0..n {
            let id = format!("{prefix}{i:03}");
            let parent = if i == 0 {
                None
            } else {
                Some(format!("{prefix}{:03}", i - 1))
            };
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'content', ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(format!("node {i}"))
            .bind(parent.as_deref())
            .bind(i64::try_from(i).unwrap() + 1)
            .bind(&root)
            .execute(pool)
            .await
            .unwrap();
        }
        root
    }

    /// Thread-safe buffered writer for in-process log capture (mirrors the
    /// helper in `materializer/tests/agenda_fts_misc.rs`; per tests/AGENTS.md
    /// "Test helper duplication is intentional"). Paired with a current-thread
    /// runtime (`#[tokio::test]`) so `set_default`'s thread-local guard covers
    /// every `.await` point — a multi-thread runtime could migrate the task off
    /// the thread that installed the subscriber and miss the warn.
    #[derive(Clone, Default)]
    struct WarnBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for WarnBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for WarnBuf {
        type Writer = WarnBuf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
    fn capture() -> (WarnBuf, tracing::subscriber::DefaultGuard) {
        use tracing_subscriber::layer::SubscriberExt;
        let buf = WarnBuf::default();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(buf.clone())
                    .with_ansi(false),
            );
        let guard = tracing::subscriber::set_default(subscriber);
        (buf, guard)
    }
    fn logged(buf: &WarnBuf) -> String {
        String::from_utf8_lossy(&buf.0.lock().unwrap()).into_owned()
    }

    const DEV: &str = "sat-probe-device";

    #[tokio::test]
    async fn delete_block_inner_cascades_past_depth_cap_r27() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // 130 nodes → deepest at depth 129, PAST the depth-100 CTE cap. The
        // old single-CTE cascade flipped only the 101 rows within the cap
        // (stranding 29 live orphans under tombstoned ancestors); the batched
        // walker must flip ALL 130 and surface the cap-crossing breadcrumb.
        let root = insert_chain(&pool, "DELSAT", 130).await;

        let (buf, guard) = capture();
        let resp = delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&root))
            .await
            .unwrap();
        drop(guard);
        assert_eq!(
            resp.descendants_affected, 130,
            "the whole 130-node chain must be soft-deleted (root + descendants), \
             including the 29 nodes past the depth-100 cap"
        );
        let live_below_cap: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            live_below_cap, 0,
            "no live orphan may survive under the tombstoned chain"
        );
        let out = logged(&buf);
        assert!(
            out.contains("crossed the depth-100 CTE cap"),
            "a past-cap delete must emit the batched-walk breadcrumb warn, got: {out:?}"
        );
        mat.shutdown();
    }

    #[tokio::test]
    async fn delete_block_inner_skips_probe_no_warn_on_shallow_tree_2268() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // 5 nodes → rows_affected (5) < 99, so the probe is skipped entirely
        // and no warn is emitted (the common-case zero-extra-walk path).
        let root = insert_chain(&pool, "DELSHAL", 5).await;

        let (buf, guard) = capture();
        delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&root))
            .await
            .unwrap();
        drop(guard);
        assert!(
            !logged(&buf).contains("cascade-depth cap reached"),
            "a shallow delete must NOT trip the saturation warn (probe skipped)"
        );
        mat.shutdown();
    }

    #[tokio::test]
    async fn restore_block_inner_restores_past_depth_cap_r27() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // 130 nodes → deepest at depth 129, PAST the depth-100 CTE cap: both
        // the delete and the restore must cover the full chain via the
        // batched walker (the old capped CTEs stopped at 101 rows).
        let root = insert_chain(&pool, "RESSAT", 130).await;

        // Delete the whole chain first (single shared `deleted_at`).
        delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&root))
            .await
            .unwrap();
        let deleted_at: i64 = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&root)
            .fetch_one(&pool)
            .await
            .unwrap();

        let (buf, guard) = capture();
        let resp = restore_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&root), deleted_at)
            .await
            .unwrap();
        drop(guard);
        assert_eq!(
            resp.restored_count, 130,
            "the whole 130-node chain must be restored, including the 29 \
             nodes past the depth-100 cap"
        );
        let still_deleted: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NOT NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            still_deleted, 0,
            "no tombstoned tail may survive under the restored chain"
        );
        let out = logged(&buf);
        assert!(
            out.contains("crossed the depth-100 CTE cap"),
            "a past-cap restore must emit the batched-walk breadcrumb warn, got: {out:?}"
        );
        mat.shutdown();
    }

    #[tokio::test]
    async fn batch_delete_cascades_past_depth_cap_r27() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // 130 nodes → deepest at depth 129, PAST the depth-100 CTE cap. The
        // batch path stamps the union of the pre-captured walker cohorts, so
        // all 130 rows must flip (the old capped multi-seed CTE stopped at 101).
        let root = insert_chain(&pool, "BATSAT", 130).await;

        let (buf, guard) = capture();
        let n = delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![BlockId::from_trusted(&root)])
            .await
            .unwrap();
        drop(guard);
        assert_eq!(n, 130, "the batch cascade must soft-delete all 130 nodes");
        let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            live, 0,
            "no live orphan may survive under the tombstoned chain"
        );
        let out = logged(&buf);
        assert!(
            out.contains("crossed the depth-100 CTE cap"),
            "a past-cap batch delete must emit the batched-walk breadcrumb warn, got: {out:?}"
        );
        mat.shutdown();
    }
}
