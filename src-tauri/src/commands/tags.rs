//! Tags command handlers.

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op::{AddTagPayload, OpPayload, RemoveTagPayload, SetPropertyPayload};
use crate::op_log;
use crate::pagination::ActiveBlockRow;
use crate::pagination::PageResponse;
use crate::space::SpaceScope;
use crate::tag_query::{self, TagCacheRow, TagExpr};
use crate::ulid::BlockId;

use super::*;

/// Upper bound on the caller-supplied `tag_ids` filter array accepted by the
/// no-clamp "return all of X" listing IPCs ([`query_by_tags_inner`] and
/// [`list_all_pages_in_space_inner`]). #1325.
///
/// Tag filtering on those surfaces is a *secondary* predicate over an
/// already-bounded result set (every page / block in a single space), so a
/// cap of 1000 is generous for any legitimate UI gesture while keeping the
/// dynamic SQL placeholder + bind count — which scales 1:1 with this array —
/// safely under SQLite's default parameter limit (999 / 32 766 depending on
/// build). Mirrors the [`MAX_BATCH_BLOCK_IDS`](crate::commands::MAX_BATCH_BLOCK_IDS)
/// cap on the `*_by_ids` write family.
pub(crate) const MAX_FILTER_TAG_IDS: usize = 1000;

/// Add a tag to a block.
///
/// Validates both the block and the tag block exist and are not deleted,
/// checks that `tag_id` refers to a block with `block_type = 'tag'`, ensures
/// the association does not already exist, appends an `AddTag` op, inserts
/// into `block_tags`, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block or tag block does not exist or is deleted
/// - [`AppError::InvalidOperation`] — `tag_id` is not a tag block, or tag already applied
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn add_tag_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
    tag_id: BlockId,
) -> Result<TagResponse, AppError> {
    // I-CommandsCRUD-2 / AGENTS.md invariant #8: both ids reference
    // `blocks.id` and are already canonical uppercase — the `BlockId`
    // newtype normalises on construction (`Deserialize` / `from_trusted` /
    // `From`), so no separate `to_ascii_uppercase()` pass is needed for
    // the byte-exact ULID comparisons below.
    let block_id_str = block_id.as_str();
    let tag_id_str = tag_id.as_str();

    // L-34: defence-in-depth guard against pathological inputs (MCP tool, sync
    // replay, scripted import) where a block tries to tag itself. Reject up-front
    // before any DB work; otherwise `tag_inheritance::propagate_tag_to_descendants`
    // could re-enter if the tag also appears in its own ancestry.
    if block_id == tag_id {
        return Err(AppError::InvalidOperation(
            "a block cannot tag itself".into(),
        ));
    }

    // 1. Build OpPayload
    let payload = OpPayload::AddTag(AddTagPayload {
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
    });

    // 2. Single IMMEDIATE transaction: validation + op_log + block_tags write.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation. MAINT-112: CommandTx couples commit +
    //    post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "add_tag").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id_str
    )
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Validate tag_id refers to a block with block_type = 'tag' and is not deleted (TOCTOU-safe)
    let tag_row = sqlx::query!(
        "SELECT block_type FROM blocks WHERE id = ? AND deleted_at IS NULL",
        tag_id_str
    )
    .fetch_optional(&mut **tx)
    .await?;
    match tag_row {
        None => {
            return Err(AppError::NotFound(format!(
                "tag block '{tag_id}' (not found or deleted)"
            )));
        }
        Some(ref r) if r.block_type != "tag" => {
            return Err(AppError::InvalidOperation(format!(
                "block '{tag_id}' has block_type '{}', expected 'tag'",
                r.block_type
            )));
        }
        _ => {}
    }

    // 3-5. Cross-space resolution / orphan adoption + dup-check + op append +
    //      block_tags insert + inheritance propagation, all via the shared
    //      `apply_tag_to_block_in_tx` helper (also used by the bulk path).
    //      `payload` is consumed inside the helper. A `None` result means the
    //      association already exists — the single-row path surfaces that as
    //      an explicit `InvalidOperation` error (the bulk path skips it).
    let op_record = apply_tag_to_block_in_tx(&mut tx, device_id, block_id_str, tag_id_str, payload)
        .await?
        .ok_or_else(|| AppError::InvalidOperation("tag already applied".into()))?;

    // 6. Commit + dispatch background cache tasks (fire-and-forget).
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    // 7. Return response
    Ok(TagResponse {
        block_id: block_id.into_string(),
        tag_id: tag_id.into_string(),
    })
}

/// Apply a single `tag_id → block_id` association inside an existing
/// transaction. Shared by the single-row [`add_tag_inner`] and the bulk
/// [`add_tags_by_ids_inner`] so the cross-space / orphan-adoption /
/// inheritance-propagation logic has ONE source of truth.
///
/// Performs, in order:
/// 1. PEND-15 Phase 2 cross-space guard with PEND-76 F4 orphan adoption —
///    a tag with no space is adopted into the source block's space (emitting
///    a `SetProperty(space)` op + materialising the row); a genuine
///    cross-space pairing is rejected with [`AppError::Validation`].
/// 2. Duplicate detection — if the `block_tags` row already exists this
///    returns `Ok(None)` WITHOUT appending any op. Callers decide whether a
///    duplicate is an error (single path) or a silent skip (bulk path).
/// 3. Appends the supplied `AddTag` `payload` to the op_log (via
///    `append_local_op_in_tx`, so the `LAST_APPEND` task-local sees it).
/// 4. Inserts the `block_tags` row.
/// 5. Propagates the inherited tag to descendants (P-4).
///
/// On success returns `Ok(Some(op_record))` — the `AddTag` op record the
/// caller must `enqueue_background` for post-commit dispatch. The caller is
/// responsible for commit + dispatch.
///
/// Pre-conditions the caller MUST have already validated (this helper does
/// NOT re-check): `block_id` exists + is live, `tag_id` exists + is live +
/// has `block_type = 'tag'`, and `block_id != tag_id`.
async fn apply_tag_to_block_in_tx(
    tx: &mut CommandTx,
    device_id: &str,
    block_id: &str,
    tag_id: &str,
    payload: OpPayload,
) -> Result<Option<op_log::OpRecord>, AppError> {
    // PEND-15 Phase 2 (Path A) — tags are space-scoped; a tag may not be
    // applied across spaces.
    //
    // PEND-76 F4: a tag with no space yet (an orphan — e.g. one created
    // mid-session via `handleCreateTag`, which creates the tag block
    // without a space property) is ADOPTED into the source block's space
    // here instead of being rejected. This is the eager equivalent of the
    // boot-time `migrate_orphan_tags_to_space` and mirrors its op-emit +
    // inline-materialise shape, so a freshly created tag can be applied in
    // a non-default space immediately rather than failing with a
    // `tags.addFailed` toast until the next launch.
    {
        let src_space =
            crate::space::resolve_block_space(&mut ***tx, &BlockId::from_trusted(block_id)).await?;
        let tag_space =
            crate::space::resolve_block_space(&mut ***tx, &BlockId::from_trusted(tag_id)).await?;
        if src_space != tag_space {
            match (&src_space, &tag_space) {
                // Orphan tag + spaced source block — adopt the tag into the
                // source's space rather than reject.
                (Some(space_id), None) => {
                    let space_ref = space_id.as_str().to_owned();
                    let set_space = OpPayload::SetProperty(SetPropertyPayload {
                        block_id: BlockId::from_trusted(tag_id),
                        key: "space".to_owned(),
                        value_text: None,
                        value_num: None,
                        value_date: None,
                        value_ref: Some(BlockId::from(space_ref.clone())),
                        value_bool: None,
                    });
                    op_log::append_local_op_in_tx(tx, device_id, set_space, crate::db::now_ms())
                        .await?;
                    // #533 Phase 2: materialise the adopted space into the
                    // `blocks.space_id` column (the sole source of truth) —
                    // NOT a block_properties row (those are gone). A tag is
                    // top-level so the `OR page_id` arm is a no-op; the `id`
                    // arm sets the tag's own space. Mirrors the boot-time
                    // twin `migrate_orphan_tags_to_space`.
                    sqlx::query!(
                        "UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?",
                        space_ref,
                        tag_id,
                        tag_id,
                    )
                    .execute(&mut ***tx)
                    .await?;
                }
                // Genuine cross-space (both spaced but differ) or a spaced
                // tag on an unspaced source block — reject.
                _ => {
                    return Err(AppError::Validation(format!(
                        "cross-space tag: block '{block_id}' (space {src_space:?}) cannot use tag '{tag_id}' (space {tag_space:?})",
                    )));
                }
            }
        }
    }

    // Check for existing association (TOCTOU-safe). A duplicate is reported
    // to the caller as `Ok(None)` — NO op is appended — so the single-row
    // path can raise `InvalidOperation` while the bulk path silently skips.
    let dup = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        block_id,
        tag_id
    )
    .fetch_optional(&mut ***tx)
    .await?;
    if dup.is_some() {
        return Ok(None);
    }

    // Append the AddTag op to the op_log (records the OpRef in LAST_APPEND).
    let op_record =
        op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms()).await?;

    // #1257 PR-3: route the `block_tags` write + inheritance fan-out through the
    // SAME engine-apply + projection the boot-replay / sync `ApplyOp` path uses,
    // IN this CommandTx, INSTEAD of the inline `INSERT INTO block_tags` +
    // `propagate_tag_to_descendants`. `apply_add_tag_via_loro` resolves the
    // block's space, pushes the tag onto the per-space Loro engine's `block_tags`
    // list (sync guard, dropped before any `.await`), then
    // `project_add_tag_to_sql` runs `INSERT OR IGNORE INTO block_tags` and
    // `propagate_tag_to_descendants` runs the IDENTICAL `block_tag_inherited`
    // fan-out — so BOTH `block_tags` AND `block_tag_inherited` end up identical to
    // before (#1323 convergence). The plain `INSERT` → `INSERT OR IGNORE` swap is
    // inert: the dup-check above already returned `Ok(None)` if the row existed,
    // so the row is always absent here. We do NOT call `apply_op_tx` /
    // `advance_apply_cursor`: the apply cursor stays put on the LOCAL path so boot
    // replay re-applies idempotently (the safety net — #1257). If the engine
    // can't be resolved (source block has no space / engine uninitialised — e.g.
    // a test without `install_for_test`), the helper FALLS BACK to
    // `apply_add_tag_sql_only`, which runs the SAME projection + inheritance — so
    // the association is never skipped and we never crash.
    let add_payload = AddTagPayload {
        block_id: BlockId::from_trusted(block_id),
        tag_id: BlockId::from_trusted(tag_id),
    };
    crate::materializer::apply_add_tag_via_loro(tx, device_id, &add_payload).await?;

    Ok(Some(op_record))
}

/// Remove a tag from a block.
///
/// Validates the block exists and is not deleted, checks the tag association
/// exists, appends a `RemoveTag` op, deletes from `block_tags`, and dispatches
/// background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist, is deleted, or tag association missing
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn remove_tag_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
    tag_id: BlockId,
) -> Result<TagResponse, AppError> {
    // I-CommandsCRUD-2 / AGENTS.md invariant #8: both ids reference
    // `blocks.id` and are already canonical uppercase — the `BlockId`
    // newtype normalises on construction, so no separate
    // `to_ascii_uppercase()` pass is needed for the byte-exact ULID
    // comparisons below.
    let block_id_str = block_id.as_str();
    let tag_id_str = tag_id.as_str();

    // 1. Build OpPayload
    let remove_payload = RemoveTagPayload {
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
    };
    let payload = OpPayload::RemoveTag(remove_payload.clone());

    // 2. Single IMMEDIATE transaction: validation + op_log + block_tags write.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation. MAINT-112: CommandTx couples commit +
    //    post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "remove_tag").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id_str
    )
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Check association exists (TOCTOU-safe)
    let assoc = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        block_id_str,
        tag_id_str
    )
    .fetch_optional(&mut **tx)
    .await?;
    if assoc.is_none() {
        return Err(AppError::NotFound("tag association".into()));
    }

    // 3. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, crate::db::now_ms()).await?;

    // 4. #1257 PR-3: route the `block_tags` delete + inherited-tag cleanup
    // through the SAME engine-apply + projection the boot-replay / sync `ApplyOp`
    // path uses, IN this CommandTx, INSTEAD of the inline
    // `DELETE FROM block_tags` + `remove_inherited_tag`. `apply_remove_tag_via_loro`
    // resolves the block's space, removes the tag from the per-space Loro engine's
    // `block_tags` list (sync guard, dropped before any `.await`), then
    // `project_remove_tag_to_sql` runs the IDENTICAL
    // `DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?` and
    // `remove_inherited_tag` runs the IDENTICAL `block_tag_inherited` cleanup — so
    // BOTH `block_tags` AND `block_tag_inherited` end up identical to before
    // (#1323 convergence). We do NOT call `apply_op_tx` / `advance_apply_cursor`:
    // the apply cursor stays put on the LOCAL path so boot replay re-applies
    // idempotently (the safety net — #1257). If the engine can't be resolved
    // (block has no space / engine uninitialised — e.g. a test without
    // `install_for_test`), the helper FALLS BACK to `apply_remove_tag_sql_only`,
    // which runs the SAME projection + cleanup — so the removal is never skipped
    // and we never crash.
    crate::materializer::apply_remove_tag_via_loro(&mut tx, device_id, &remove_payload).await?;

    // 5. Commit + dispatch background cache tasks (fire-and-forget).
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    // 6. Return response
    Ok(TagResponse {
        block_id: block_id.into_string(),
        tag_id: tag_id.into_string(),
    })
}

/// Query blocks by boolean tag expression.
///
/// Builds a `TagExpr` from the provided tag_ids, prefixes, and mode.
/// `mode` is `"and"` for intersection, anything else defaults to `"or"` (union).
/// Returns an empty page when no tag IDs or prefixes are supplied.
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts the result
/// set to blocks whose owning page carries `space = ?space_id`.
/// [`SpaceScope::Global`] is the unscoped (pre-FEAT-3) behaviour
/// preserved for callsites that span every space.
///
/// `block_type` (PEND-35 Tier 3.4) — when `Some`, restricts results to
/// blocks whose `block_type` equals the supplied value. `None` is the
/// unfiltered behaviour. Pushes GraphView's JS-side
/// `pagesResp.items.filter(p => p.block_type === 'page')` predicate
/// into SQL so the unbounded `limit:5000` over-fetch and post-filter
/// discard collapses into one paginated query.
///
/// #1325 — `tag_ids` is capped at [`MAX_FILTER_TAG_IDS`]: each element fans
/// into a `TagExpr::Tag` leaf (resolved via its own per-tag query), so an
/// unbounded array would scale the query/bind work 1:1 with caller input
/// (SQLite param-limit error / cheap DoS). Tag filtering here is a
/// secondary predicate over an already-bounded (space-scoped) result set, so
/// the cap is generous while keeping the per-tag query count and any dynamic
/// bind count safely bounded. Oversized input is rejected up-front with
/// [`AppError::Validation`]`("tag_ids.too_many")` before any expression is
/// built.
#[instrument(skip(pool, tag_ids), err)]
#[allow(clippy::too_many_arguments)]
pub async fn query_by_tags_inner(
    pool: &SqlitePool,
    tag_ids: Vec<String>,
    prefixes: Vec<String>,
    mode: String,
    include_inherited: Option<bool>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
    block_type: Option<String>,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    // #1325: bound the caller-supplied filter array before fanning each
    // element into a `TagExpr::Tag` leaf (each resolved via its own per-tag query).
    if tag_ids.len() > MAX_FILTER_TAG_IDS {
        return Err(AppError::Validation("tag_ids.too_many".into()));
    }

    let mut exprs = Vec::new();
    for tag_id in tag_ids {
        exprs.push(TagExpr::Tag(tag_id));
    }
    for prefix in prefixes {
        exprs.push(TagExpr::Prefix(prefix));
    }

    if exprs.is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: None,
        });
    }

    let expr = match mode.as_str() {
        "and" => TagExpr::And(exprs),
        "not" => TagExpr::Not(Box::new(TagExpr::Or(exprs))),
        _ => TagExpr::Or(exprs), // default to OR
    };

    let page = pagination::PageRequest::new(cursor, limit)?;
    tag_query::eval_tag_query(
        pool,
        &expr,
        &page,
        include_inherited.unwrap_or(false),
        scope.as_filter_param(),
        block_type.as_deref(),
    )
    .await
}

/// List all tags matching a name prefix (autocomplete / UI).
#[instrument(skip(pool), err)]
pub async fn list_tags_by_prefix_inner(
    pool: &SqlitePool,
    prefix: String,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    tag_query::list_tags_by_prefix(pool, &prefix, limit).await
}

/// Return every tag in `space_id`, ordered by name.  No pagination,
/// no clamp — bounded by the space's intrinsic tag count.
///
/// limit-clamp-followup — backs the tag-management list view
/// (`TagList.tsx`), which used to call
/// `list_tags_by_prefix({ prefix: "", limit: 500 })` and silently get
/// only 200 rows because `list_tags_by_prefix_inner` clamps at
/// `MAX_TAGS_PREFIX = 200`.  Tags are space-scoped via the tag block's
/// own `blocks.space_id` column (#533, migration 0086 — see
/// `add_tag_inner`'s cross-space guard), so this command takes a
/// `space_id` and applies the same filter shape as
/// `list_all_pages_in_space_inner`.
#[instrument(skip(pool), err)]
pub async fn list_all_tags_in_space_inner(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<TagCacheRow>, AppError> {
    tag_query::list_all_tags_in_space(pool, space_id).await
}

/// List every tag in the tag cache with cursor-based pagination
/// (M-85, AGENTS.md invariant #3).
///
/// Backs the FEAT-4c MCP `list_tags` tool. Ordered by `tag_id ASC`
/// (ULIDs sort chronologically) so the keyset cursor encoded via
/// [`Cursor::for_id`] is monotonic. `limit` is forwarded through
/// [`pagination::PageRequest::new`] which clamps to the canonical
/// `[1, MAX_PAGE_SIZE]` range; the MCP tool boundary applies its own
/// `LIST_RESULT_CAP` clamp.
///
/// M-85: previously a thin wrapper over `list_tags_by_prefix_inner("")`
/// returning a flat `Vec<TagCacheRow>`. Now returns a
/// [`PageResponse<TagCacheRow>`] so the tool surface is consistent with
/// the rest of the paginated read commands. The frontend `listTags()`
/// wrapper destructures `.items`; MCP agents thread `cursor` /
/// `next_cursor` / `has_more`.
#[instrument(skip(pool), err)]
pub async fn list_tags_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<TagCacheRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.as_str()),
        None => (None, ""),
    };
    let fetch_limit = page.limit + 1;
    let rows = sqlx::query_as!(
        TagCacheRow,
        r#"SELECT tag_id, name, usage_count, updated_at
         FROM tags_cache
         WHERE (?1 IS NULL OR tag_id > ?2)
         ORDER BY tag_id ASC
         LIMIT ?3"#,
        cursor_flag,
        cursor_id,
        fetch_limit,
    )
    .fetch_all(pool)
    .await?;
    pagination::build_page_response(rows, page.limit, |last| {
        pagination::Cursor::for_id(last.tag_id.clone())
    })
}

/// List all tag_ids currently associated with a block.
#[instrument(skip(pool), err)]
pub async fn list_tags_for_block_inner(
    pool: &SqlitePool,
    block_id: BlockId,
) -> Result<Vec<String>, AppError> {
    // I-CommandsCRUD-2 / AGENTS.md invariant #8: `block_id` references
    // `blocks.id` and the `BlockId` newtype already normalises to canonical
    // uppercase on construction, so the byte-exact ULID membership probe in
    // `list_tags_for_block` matches regardless of caller casing.
    tag_query::list_tags_for_block(pool, block_id.as_str()).await
}

/// List the tag_ids a block holds via inheritance (`block_tag_inherited`).
///
/// #1423 — paired with [`list_tags_for_block_inner`] so the UI can render
/// derived (inherited) tag chips distinctly from directly-applied ones.
#[instrument(skip(pool), err)]
pub async fn list_inherited_tags_for_block_inner(
    pool: &SqlitePool,
    block_id: BlockId,
) -> Result<Vec<String>, AppError> {
    tag_query::list_inherited_tags_for_block(pool, block_id.as_str()).await
}

/// Tauri command: add a tag to a block. Delegates to [`add_tag_inner`].
#[tauri::command]
#[specta::specta]
pub async fn add_tag(
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    tag_id: BlockId,
) -> Result<TagResponse, AppError> {
    add_tag_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_id,
        tag_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// #81 / PEND-57 — bulk variant of [`add_tag_inner`]: apply ONE `tag_id`
/// to N `block_ids` in a single `BEGIN IMMEDIATE` transaction (the Pages
/// multi-select "tag selected" action).
///
/// Collapses what the frontend would otherwise drive as one `add_tag` IPC
/// per selected row into a single round-trip, a single writer-lock window,
/// and a single op-log seq range. One `AddTag` op is appended per block
/// that is actually newly tagged; the `LAST_APPEND` task-local therefore
/// drains as ONE activity-feed entry covering the whole batch (the first
/// op is the primary `OpRef`, the rest `additionalOpRefs`).
///
/// **Tag validation runs ONCE** (mirrors `add_tag_inner`): `tag_id` must
/// resolve to a live block carrying `block_type = 'tag'`. A bad tag aborts
/// the whole batch with the same `NotFound` / `InvalidOperation` error the
/// single path raises — that's a caller error, not data drift.
///
/// **Per-block leniency** (mirrors `set_todo_state_batch_inner` /
/// `delete_blocks_by_ids_inner`): for each id the batch silently SKIPS
/// — without aborting — when the block is missing / soft-deleted, equals
/// `tag_id` (self-tag), or already carries the tag. The per-block
/// cross-space / orphan-adoption resolution is shared with the single path
/// via [`apply_tag_to_block_in_tx`]; a genuine cross-space pairing DOES
/// abort the whole tx (consistent with the single path's hard rejection —
/// silently dropping a cross-space target would hide a real data error).
///
/// Returns the number of blocks newly tagged (NOT the input list length).
///
/// # Errors
///
/// - [`AppError::Validation`] — empty input list, or > [`MAX_BATCH_BLOCK_IDS`](crate::commands::MAX_BATCH_BLOCK_IDS) entries, or a cross-space pairing
/// - [`AppError::NotFound`] — `tag_id` does not resolve to a live block
/// - [`AppError::InvalidOperation`] — `tag_id` is not a `block_type = 'tag'` block
#[instrument(skip(pool, device_id, materializer, block_ids), err)]
pub async fn add_tags_by_ids_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
    tag_id: BlockId,
) -> Result<i64, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::Validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;

    // I-CommandsCRUD-2 / AGENTS.md invariant #8 — every id (block ids + tag
    // id) is a `BlockId`, already normalised to canonical uppercase on
    // construction, so the byte-exact ULID membership probes match
    // regardless of caller casing without an explicit normalise pass.
    let tag_id_str = tag_id.as_str();

    // One IMMEDIATE tx covers the whole batch: tag validation + every
    // per-block op_log append + block_tags insert + inheritance propagation.
    let mut tx = CommandTx::begin_immediate(pool, "add_tags_by_ids").await?;

    // Validate `tag_id` ONCE: live block with block_type = 'tag' (TOCTOU-safe
    // inside the tx). Mirrors `add_tag_inner`.
    let tag_row = sqlx::query!(
        "SELECT block_type FROM blocks WHERE id = ? AND deleted_at IS NULL",
        tag_id_str
    )
    .fetch_optional(&mut **tx)
    .await?;
    match tag_row {
        None => {
            return Err(AppError::NotFound(format!(
                "tag block '{tag_id}' (not found or deleted)"
            )));
        }
        Some(ref r) if r.block_type != "tag" => {
            return Err(AppError::InvalidOperation(format!(
                "block '{tag_id}' has block_type '{}', expected 'tag'",
                r.block_type
            )));
        }
        _ => {}
    }

    let mut tagged: i64 = 0;
    for block_id in &block_ids {
        // L-34 mirror — a block cannot tag itself. Skip rather than abort:
        // a multi-select that happens to include the tag block is a benign
        // gesture, not a caller error.
        if block_id == &tag_id {
            continue;
        }

        let block_id_str = block_id.as_str();

        // Probe existence inside the tx so a row deleted between FE selection
        // and this call cleanly skips rather than aborting the whole batch.
        let exists = sqlx::query_scalar!(
            r#"SELECT 1 AS "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            block_id_str
        )
        .fetch_optional(&mut **tx)
        .await?;
        if exists.is_none() {
            continue;
        }

        let payload = OpPayload::AddTag(AddTagPayload {
            block_id: block_id.clone(),
            tag_id: tag_id.clone(),
        });

        // Shared per-block logic: cross-space/orphan resolution, dup-check,
        // op append, block_tags insert, inheritance propagation. `None` means
        // the tag was already applied — silently skip (lenient batch).
        if let Some(op_record) =
            apply_tag_to_block_in_tx(&mut tx, device_id, block_id_str, tag_id_str, payload).await?
        {
            tx.enqueue_background(op_record);
            tagged += 1;
        }
    }

    tx.commit_and_dispatch(materializer).await?;

    Ok(tagged)
}

/// Tauri command: add ONE tag to N blocks (#81 / PEND-57). Delegates to
/// [`add_tags_by_ids_inner`]. Returns the number of blocks newly tagged.
#[tauri::command]
#[specta::specta]
pub async fn add_tags_by_ids(
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<BlockId>,
    tag_id: BlockId,
) -> Result<i64, AppError> {
    add_tags_by_ids_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_ids,
        tag_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: remove a tag from a block. Delegates to [`remove_tag_inner`].
#[tauri::command]
#[specta::specta]
pub async fn remove_tag(
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    tag_id: BlockId,
) -> Result<TagResponse, AppError> {
    remove_tag_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_id,
        tag_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: query blocks by boolean tag expression. Delegates to [`query_by_tags_inner`].
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn query_by_tags(
    pool: State<'_, ReadPool>,
    tag_ids: Vec<String>,
    prefixes: Vec<String>,
    mode: String,
    include_inherited: Option<bool>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
    block_type: Option<String>,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    query_by_tags_inner(
        &pool.0,
        tag_ids,
        prefixes,
        mode,
        include_inherited,
        cursor,
        limit,
        &scope,
        block_type,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list tags matching a name prefix. Delegates to [`list_tags_by_prefix_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_tags_by_prefix(
    pool: State<'_, ReadPool>,
    prefix: String,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    list_tags_by_prefix_inner(&pool.0, prefix, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list tag IDs for a block. Delegates to [`list_tags_for_block_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_tags_for_block(
    pool: State<'_, ReadPool>,
    block_id: BlockId,
) -> Result<Vec<String>, AppError> {
    list_tags_for_block_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list inherited tag IDs for a block (#1423).
/// Delegates to [`list_inherited_tags_for_block_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_inherited_tags_for_block(
    pool: State<'_, ReadPool>,
    block_id: BlockId,
) -> Result<Vec<String>, AppError> {
    list_inherited_tags_for_block_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list every tag in `space_id` as `TagCacheRow[]`. No
/// pagination, no clamp.  Delegates to [`list_all_tags_in_space_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_all_tags_in_space(
    pool: State<'_, ReadPool>,
    space_id: String,
) -> Result<Vec<TagCacheRow>, AppError> {
    list_all_tags_in_space_inner(&pool.0, &space_id)
        .await
        .map_err(sanitize_internal_error)
}
