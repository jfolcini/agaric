use std::collections::HashMap;

use tracing::instrument;

use super::super::*;
use crate::pagination::ActiveBlockRow;
use crate::space::SpaceScope;

/// List active blocks with pagination, applying at most one exclusive filter.
///
/// Dispatches to the appropriate pagination query based on which filter
/// parameter is set: `agenda_date`, `tag_id`, `block_type`, or `parent_id`
/// (children, the default). Page size is clamped to `[1, 100]`. Trash
/// (soft-deleted) blocks are served by [`list_trash_inner`] / the
/// [`list_trash`] Tauri command — never through this entry point.
///
/// FEAT-3 Phase 4 — `space_id` is required (not optional). The filter is
/// threaded through every dispatch path (agenda, tag, by-type, children)
/// so the result set always reflects the active space.
///
/// # Errors
///
/// - [`AppError::Validation`] — multiple conflicting filters, or invalid date format
#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool), err)]
pub async fn list_blocks_inner(
    pool: &SqlitePool,
    parent_id: Option<BlockId>,
    block_type: Option<String>,
    tag_id: Option<String>,
    agenda_date: Option<String>,
    agenda_date_start: Option<String>,
    agenda_date_end: Option<String>,
    agenda_source: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
    space_id: String,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    // #107: BlockId normalises to uppercase on construction; re-derive owned
    // String form so `as_deref()` / sqlx binds below stay unchanged.
    let parent_id = parent_id.map(BlockId::into_string);
    // Treat agenda_date_start/end as an agenda filter for conflict detection
    let has_agenda_range = agenda_date_start.is_some() && agenda_date_end.is_some();

    // Reject conflicting filters: only one of the exclusive filter parameters
    // may be set. `parent_id` is the default (list children) so it only
    // counts as a filter when explicitly provided alongside another.
    let filter_count = [
        parent_id.is_some(),
        block_type.is_some(),
        tag_id.is_some(),
        agenda_date.is_some(),
        has_agenda_range,
    ]
    .iter()
    .filter(|&&b| b)
    .count();

    if filter_count > 1 {
        return Err(AppError::Validation(
            "conflicting filters: only one of parent_id, block_type, tag_id, agenda_date, agenda_date_start+end may be set".to_string(),
        ));
    }

    // Validate: if only one of start/end is provided, reject
    if agenda_date_start.is_some() != agenda_date_end.is_some() {
        return Err(AppError::Validation(
            "agenda_date_start and agenda_date_end must both be provided together".to_string(),
        ));
    }

    // F06 / limit-clamp-followup Phase 1: reject limits outside `[1, 100]`
    // loudly.  Silent clamp was the BUG-48 root: callers asking for >100
    // got truncated to 100 with no signal.  Strict validation surfaces
    // the contract violation at the IPC boundary so a future BUG-48 fails
    // synchronously rather than as mysterious data loss months later.
    if let Some(l) = limit
        && !(1..=100).contains(&l)
    {
        return Err(AppError::Validation(format!(
            "list_blocks limit must be in [1, 100]; got {l}. \
                 For larger result sets, use cursor pagination."
        )));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;

    // FEAT-3 Phase 4: `space_id` is required, so every dispatch path
    // forwards `Some(&space_id)` to its pagination helper. The helpers
    // keep the `Option<&str>` shape so other callers (e.g.
    // `list_pages_inner`, MCP unscoped paths) can still pass `None`.
    let space_id_opt: Option<&str> = Some(space_id.as_str());
    if has_agenda_range {
        // `has_agenda_range` is computed from both being `Some`, so this is an
        // invariant; surface an AppError rather than panicking if the guard and
        // these reads ever drift apart (#542).
        let (Some(start), Some(end)) = (agenda_date_start.as_ref(), agenda_date_end.as_ref())
        else {
            return Err(AppError::InvalidOperation(
                "agenda range guard set but agenda_date_start/end missing".to_string(),
            ));
        };
        validate_date_format(start)?;
        validate_date_format(end)?;
        if start > end {
            return Err(AppError::Validation(
                "agenda_date_start must be <= agenda_date_end".to_string(),
            ));
        }
        pagination::list_agenda_range(
            pool,
            start,
            end,
            agenda_source.as_deref(),
            &page,
            space_id_opt,
        )
        .await
    } else if let Some(ref d) = agenda_date {
        validate_date_format(d)?;
        pagination::list_agenda(pool, d, agenda_source.as_deref(), &page, space_id_opt).await
    } else if let Some(ref t) = tag_id {
        pagination::list_by_tag(pool, t, &page, space_id_opt).await
    } else if let Some(ref bt) = block_type {
        // PageBrowser pagination UX (2026-05-14) — when the caller is
        // filtering by `block_type` (the PageBrowser path with
        // `block_type = 'page'`), compute `total_count` alongside the
        // limited fetch so the FE can drive an "X of Y" progress
        // chip. The COUNT query reuses the same predicate set as
        // `pagination::list_by_type` (block_type = ? AND deleted_at IS
        // NULL + space filter) and is covered by
        // `idx_blocks_type(block_type, deleted_at)`.
        let mut resp = pagination::list_by_type(pool, bt, &page, space_id_opt).await?;
        let total = count_blocks_by_type(pool, bt, space_id_opt).await?;
        resp.total_count = Some(total);
        Ok(resp)
    } else {
        pagination::list_children(pool, parent_id.as_deref(), &page, space_id_opt).await
    }
}

/// Count active blocks matching `block_type`, scoped to a single space.
///
/// Mirrors the predicate set used by [`pagination::list_by_type`]
/// (`block_type = ?` + `deleted_at IS NULL` + the canonical
/// space filter). Used by `list_blocks_inner` to drive the
/// PageBrowser "X of Y" progress indicator without paginating
/// through the entire result set.
///
/// Indexes (M7a, #348): the `block_type`/`deleted_at` scan uses
/// `idx_blocks_type(block_type, deleted_at)` — the same index the
/// LIMIT/OFFSET row fetch uses. The optional `space_id` subquery is a
/// *separate* fully-indexed lookup against `block_properties(key,
/// value_ref)`; it is not covered by `idx_blocks_type`. Both are
/// indexed, but no single index covers the whole statement.
///
/// # Errors
///
/// - [`AppError::Database`] — propagated from sqlx.
async fn count_blocks_by_type(
    pool: &SqlitePool,
    block_type: &str,
    space_id: Option<&str>,
) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) FROM blocks b
           WHERE block_type = ?1 AND deleted_at IS NULL
             AND (?2 IS NULL OR b.space_id = ?2)"#,
        block_type,
        space_id,
    )
    .fetch_one(pool)
    .await?;
    Ok(count)
}

/// Fetch a single block by ID, **including soft-deleted blocks**.
///
/// This function is intentionally permissive: callers that need to
/// inspect a row regardless of `deleted_at` (trash UI, restore /
/// purge / undo flows, snapshot recovery, drift tests) rely on this
/// shape. Public read surfaces — anything that would expose the
/// result to the user, an MCP agent, or an export — must NOT use
/// this function: use [`get_active_block_inner`] instead, which
/// adds `AND deleted_at IS NULL` and surfaces soft-deleted rows as
/// [`AppError::NotFound`]. M-98 audited and established this split.
///
/// # Errors
///
/// - [`AppError::NotFound`] — no block with the given ID exists
#[instrument(skip(pool), err)]
pub async fn get_block_inner(pool: &SqlitePool, block_id: BlockId) -> Result<BlockRow, AppError> {
    let row: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(pool)
    .await?;

    row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))
}

/// Fetch a single **active** (non-soft-deleted) block by ID.
///
/// M-98 — The active-only counterpart to [`get_block_inner`]. The
/// SQL is the same single-row lookup with one additional predicate
/// (`deleted_at IS NULL`), so a soft-deleted row surfaces as
/// [`AppError::NotFound`] rather than leaking through to the
/// caller. Use this from every public read surface (Tauri IPC, MCP
/// tools, export, page-fetch composition) — anything that would
/// otherwise expose a tombstoned row to the user. The SQL is
/// duplicated rather than factored into a shared helper because
/// the only difference is the `deleted_at` predicate and inlining
/// keeps the `query_as!` compile-time check trivially auditable
/// at each site.
///
/// # Errors
///
/// - [`AppError::NotFound`] — no active block with the given ID exists
///   (either the row does not exist at all, or it is soft-deleted)
#[instrument(skip(pool), err)]
pub async fn get_active_block_inner(
    pool: &SqlitePool,
    block_id: BlockId,
) -> Result<BlockRow, AppError> {
    let row: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(pool)
    .await?;

    row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))
}

/// Batch-resolve block metadata for a list of IDs in a single query.
///
/// Returns one [`ResolvedBlock`] per matched ID. IDs that don't exist in the
/// database **or whose owning page lives in a different space** are silently
/// omitted (no error). Soft-deleted blocks are included with `deleted = true`.
///
/// Uses `json_each()` so the full ID list is passed as a single JSON-encoded
/// bind parameter — no dynamic SQL construction.
///
/// FEAT-3 Phase 7 — `space_id` is required (not optional). Targets whose
/// `b.page_id` does not carry `space = ?space_id` are
/// dropped from the result. This is the policy enforcement point for
/// "no live links between spaces, ever": foreign-space chips fall into
/// the "unknown id" branch in the frontend and render as broken-link
/// chips via the existing UX (FEAT-3p7).
///
/// # Errors
///
/// - [`AppError::Validation`] — `ids` is empty
///
/// `scope` (FEAT-3p7) — [`SpaceScope::Active`] restricts the result set
/// to the named space (FEAT-3p7's broken-chip rendering for foreign-space
/// `[[ULID]]` targets). [`SpaceScope::Global`] keeps the cross-space
/// behaviour used by legacy surfaces like trash / search / agenda views
/// that have not yet been promoted to per-space scoping — tracked under
/// FEAT-3p4. The `Option<String>` shape this replaces mirrored
/// `list_page_history`'s FEAT-3p8 pattern; both migrated together in
/// PEND-18 Phase 2.
#[instrument(skip(pool, ids), err)]
pub async fn batch_resolve_inner(
    pool: &SqlitePool,
    ids: Vec<BlockId>,
    scope: &SpaceScope,
) -> Result<Vec<ResolvedBlock>, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation("ids list cannot be empty".into()));
    }

    // #107: re-derive owned String form for the JSON membership probe below.
    let ids: Vec<String> = ids.into_iter().map(BlockId::into_string).collect();
    let ids_json = serde_json::to_string(&ids)?;
    let space_filter = scope.as_filter_param();

    // FEAT-3 Phase 7: scope to the current space using the canonical
    // `b.page_id IN (SELECT bp.block_id FROM block_properties bp
    // WHERE bp.key = 'space' AND bp.value_ref = ?)` filter (matches the pattern
    // shipped in `pagination/{hierarchy,trash}.rs` and `fts/search.rs`).
    // The `?2 IS NULL OR …` shape lets cross-space callers
    // ([`SpaceScope::Global`]) bypass the filter entirely while
    // space-scoped callers ([`SpaceScope::Active`]) get the
    // foreign-target-drops-out behaviour the spec demands.
    //
    // Soft-deleted rows are excluded via the `deleted_at IS NOT NULL`
    // surfacing in the result row; the resolver itself does not need
    // an extra filter because page-id resolution already filters by
    // active rows and the chip caller treats `deleted: true` as a
    // sentinel.
    let rows = sqlx::query_as!(
        ResolvedBlockRow,
        r#"SELECT
             b.id,
             b.content AS title,
             b.block_type,
             (CASE WHEN b.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS "deleted: bool"
           FROM blocks b
           WHERE b.id IN (SELECT value FROM json_each(?1))
             AND (?2 IS NULL OR b.space_id = ?2)"#,
        ids_json,
        space_filter,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ResolvedBlock {
            id: r.id.into_string(),
            title: r.title,
            block_type: r.block_type,
            deleted: r.deleted.unwrap_or(false),
        })
        .collect())
}

/// Tauri command: list blocks with filtering and pagination. Delegates to [`list_blocks_inner`].
///
/// The three agenda knobs (`date`, `date_range`, `source`) are bundled
/// into a single [`AgendaQuery`] to keep this wrapper under the
/// `tauri-specta` 10-arg limit after FEAT-3 Phase 2 added `space_id`.
/// The hand-written TS wrapper in `src/lib/tauri.ts` keeps the flat
/// public API (accepts `agendaDate` / `agendaDateRange` / `agendaSource`
/// at the top level and marshals them into this struct for the IPC
/// boundary).
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn list_blocks(
    pool: State<'_, ReadPool>,
    parent_id: Option<BlockId>,
    block_type: Option<String>,
    tag_id: Option<String>,
    agenda: Option<AgendaQuery>,
    cursor: Option<String>,
    limit: Option<i64>,
    space_id: String,
) -> Result<PageResponse<BlockRow>, AppError> {
    let (agenda_date, agenda_date_start, agenda_date_end, agenda_source) = match agenda {
        Some(a) => (
            a.date,
            a.date_range.as_ref().map(|r| r.start.clone()),
            a.date_range.as_ref().map(|r| r.end.clone()),
            a.source,
        ),
        None => (None, None, None, None),
    };
    let resp = list_blocks_inner(
        &pool.0,
        parent_id,
        block_type,
        tag_id,
        agenda_date,
        agenda_date_start,
        agenda_date_end,
        agenda_source,
        cursor,
        limit,
        space_id,
    )
    .await
    .map_err(sanitize_internal_error)?;
    // Downcast `ActiveBlockRow` → `BlockRow` at the IPC boundary to keep
    // the generated frontend bindings stable. The wire format is
    // identical (`ActiveBlockId` is serde-transparent over `String`) but
    // the TS type name would change, forcing every consumer to migrate.
    Ok(PageResponse {
        items: resp.items.into_iter().map(BlockRow::from).collect(),
        next_cursor: resp.next_cursor,
        has_more: resp.has_more,
        total_count: resp.total_count,
    })
}

/// Paginate soft-deleted blocks (trash view), space-scoped.
///
/// Delegates to [`pagination::list_trash`], which returns deletion-batch
/// roots ordered by `deleted_at DESC, id ASC`. Active-block fan-out lives
/// in [`list_blocks_inner`] and never surfaces deleted rows.
///
/// # Errors
///
/// - [`AppError::Validation`] — invalid `limit` (must be in `[1, 100]`)
/// - [`AppError::Database`] — propagated from sqlx
#[instrument(skip(pool), err)]
pub async fn list_trash_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
    space_id: String,
) -> Result<PageResponse<BlockRow>, AppError> {
    if let Some(l) = limit
        && !(1..=100).contains(&l)
    {
        return Err(AppError::Validation(format!(
            "list_trash limit must be in [1, 100]; got {l}. \
                 For larger result sets, use cursor pagination."
        )));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_trash(pool, &page, Some(space_id.as_str())).await
}

/// Tauri command: paginate soft-deleted blocks. Delegates to [`list_trash_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_trash(
    pool: State<'_, ReadPool>,
    cursor: Option<String>,
    limit: Option<i64>,
    space_id: String,
) -> Result<PageResponse<BlockRow>, AppError> {
    list_trash_inner(&pool.0, cursor, limit, space_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: fetch a single block by ID. Delegates to
/// [`get_active_block_inner`].
///
/// M-98 — the public IPC must never surface soft-deleted rows; the
/// frontend exposes them only via [`list_trash`] (the trash view).
/// Switched from `get_block_inner` to [`get_active_block_inner`] so a
/// soft-deleted block returns `NotFound` to the IPC caller instead of an
/// apparently-live row with `deleted_at` set.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_block(pool: State<'_, ReadPool>, block_id: BlockId) -> Result<BlockRow, AppError> {
    get_active_block_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-resolve block metadata. Delegates to [`batch_resolve_inner`].
///
/// FEAT-3 Phase 7 — `space_id` is required so the resolve store cannot
/// surface foreign-space titles. The frontend always knows the current
/// space and threads it through `useResolveStore.preload(spaceId)`.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn batch_resolve(
    pool: State<'_, ReadPool>,
    ids: Vec<BlockId>,
    scope: SpaceScope,
) -> Result<Vec<ResolvedBlock>, AppError> {
    batch_resolve_inner(&pool.0, ids, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Batch-count cascade-deleted descendants per trash root.
///
/// Given a list of trash-root ids (as returned by [`list_trash`]),
/// return a map of `root_id -> descendant_count`. Descendants are blocks
/// sharing the root's `deleted_at` timestamp, excluding the root itself.
/// Roots with zero descendants are omitted — callers should default to
/// `0` for missing entries.
///
/// # Errors
///
/// - [`AppError::Json`] — failed to serialize `root_ids`.
/// - [`AppError::Database`] — propagated from sqlx.
#[instrument(skip(pool, root_ids), err)]
pub async fn trash_descendant_counts_inner(
    pool: &SqlitePool,
    root_ids: Vec<String>,
) -> Result<HashMap<String, u64>, AppError> {
    pagination::trash_descendant_counts(pool, &root_ids).await
}

/// Tauri command: batch-count cascade-deleted descendants per trash root.
/// Delegates to [`trash_descendant_counts_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn trash_descendant_counts(
    pool: State<'_, ReadPool>,
    root_ids: Vec<String>,
) -> Result<HashMap<String, u64>, AppError> {
    trash_descendant_counts_inner(&pool.0, root_ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Batch-fetch the first child of each parent block in a single query.
///
/// Returns a `HashMap<parent_id, BlockRow>` where the value is the first
/// child of `parent_id` ordered by `(position ASC, id ASC)` — the canonical
/// sibling-order used by every page renderer. Parents with no active
/// children are omitted; callers should treat missing keys as "no preview".
///
/// PEND-35 Tier 2.8 — the templates view used to fire one
/// `list_blocks({ parent_id, limit: 1 })` IPC per template just to
/// surface a one-line preview. This batch endpoint collapses that
/// N+1 into a single query using SQLite's `ROW_NUMBER()` window
/// function partitioned by `parent_id`.
///
/// Conflict copies  and soft-deleted rows
/// (`deleted_at IS NOT NULL`) are excluded inside the CTE so the
/// `rn = 1` row is always the first **active** sibling — matching the
/// shape of every other UI-facing read in this module.
///
/// Empty `block_ids` returns an empty map (not an error).
///
/// # Errors
///
/// - [`AppError::Json`] — failed to serialize `block_ids`.
/// - [`AppError::Database`] — propagated from sqlx.
#[instrument(skip(pool, block_ids), err)]
pub async fn first_child_for_blocks_inner(
    pool: &SqlitePool,
    block_ids: Vec<BlockId>,
) -> Result<HashMap<String, BlockRow>, AppError> {
    if block_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // #107: re-derive owned String form for the JSON membership probe below.
    let block_ids: Vec<String> = block_ids.into_iter().map(BlockId::into_string).collect();
    let ids_json = serde_json::to_string(&block_ids)?;

    // ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY position, id)
    // surfaces exactly one row per parent_id (the first child).
    // The CTE pre-filters `deleted_at IS NULL`
    // so the rn = 1 row is the first ACTIVE sibling — the same rows
    // `list_blocks({ parent_id })` would return.
    let sql = format!(
        "WITH ranked AS ( \
             SELECT {cols}, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY parent_id \
                        ORDER BY position ASC, id ASC \
                    ) AS rn \
             FROM blocks \
             WHERE parent_id IN (SELECT value FROM json_each(?1)) \
               AND deleted_at IS NULL \
         ) \
         SELECT {cols} FROM ranked WHERE rn = 1",
        cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT,
    );
    let rows = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(ids_json)
        .fetch_all(pool)
        .await?;

    let mut map: HashMap<String, BlockRow> = HashMap::with_capacity(rows.len());
    for row in rows {
        if let Some(parent) = row.parent_id.clone() {
            map.insert(parent.into_string(), row);
        }
    }
    Ok(map)
}

/// Tauri command: batch-fetch the first child per parent block. Delegates
/// to [`first_child_for_blocks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn first_child_for_blocks(
    pool: State<'_, ReadPool>,
    block_ids: Vec<BlockId>,
) -> Result<HashMap<String, BlockRow>, AppError> {
    first_child_for_blocks_inner(&pool.0, block_ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Batch-fetch full [`BlockRow`]s for a list of IDs in a single query.
///
/// Sibling of [`batch_resolve_inner`], differing in two ways:
///
///   1. Returns the full 12-column [`BlockRow`] (not just the lightweight
///      `id / title / block_type / deleted` projection). Consumers that
///      need `todo_state`, `priority`, `due_date`, `scheduled_date`,
///      `content`, `parent_id`, `position`, etc. get a single
///      round-trip instead of per-row `get_block` IPCs.
///   2. Does **not** filter `deleted_at IS NULL`. Soft-deleted rows are
///      included so the caller sees the full state for any consumer
///      that intentionally wants to surface tombstoned rows.
///
/// Empty input rejects with [`AppError::Validation`] (mirrors
/// [`batch_resolve_inner`]). Above [`crate::commands::properties::MAX_BATCH_BLOCK_IDS`]
/// entries rejects with [`AppError::Validation`] (mirrors every other
/// batch boundary in this surface).
///
/// IDs that don't exist in the database are silently omitted from the
/// response — callers must map by `id` and treat missing keys as
/// "unknown / lost". Returned rows are NOT guaranteed to be in input
/// order; let the FE map by `id` (the canonical batch shape).
///
/// # Errors
///
/// - [`AppError::Validation`] — `ids` is empty
/// - [`AppError::Validation`] — `ids.len()` >
///   [`crate::commands::properties::MAX_BATCH_BLOCK_IDS`]
#[instrument(skip(pool, ids), err)]
pub async fn get_blocks_inner(
    pool: &SqlitePool,
    ids: Vec<BlockId>,
) -> Result<Vec<BlockRow>, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation("ids list cannot be empty".into()));
    }
    if ids.len() > crate::commands::properties::MAX_BATCH_BLOCK_IDS {
        return Err(AppError::Validation(format!(
            "ids length {} exceeds maximum {}",
            ids.len(),
            crate::commands::properties::MAX_BATCH_BLOCK_IDS,
        )));
    }
    // #107: re-derive owned String form for the JSON membership probe below.
    let ids: Vec<String> = ids.into_iter().map(BlockId::into_string).collect();
    let ids_json = serde_json::to_string(&ids)?;

    // Runtime sqlx form: format! the canonical column const into the SELECT
    // (mirrors `first_child_for_blocks_inner` and the
    // `BLOCK_ROW_RUNTIME_SELECT` parity test in pagination/block_row_columns.rs).
    let sql = format!(
        "SELECT {} FROM blocks \
         WHERE id IN (SELECT value FROM json_each(?1))",
        crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT,
    );
    let rows = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(ids_json)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Tauri command: batch-fetch full block rows by id. Delegates to
/// [`get_blocks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_blocks(
    pool: State<'_, ReadPool>,
    ids: Vec<BlockId>,
) -> Result<Vec<BlockRow>, AppError> {
    get_blocks_inner(&pool.0, ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Count soft-deleted blocks scoped to a single space.
///
/// Used by the sidebar trash badge via `useItemCount`. Pushing the count
/// into SQL keeps the badge accurate regardless of trash size (the
/// paginated `listTrash` endpoint would silently clamp at the page
/// limit).
///
/// The space-filter shape mirrors `pagination::list_trash` (and the
/// canonical [`crate::space_filter_canonical::SPACE_FILTER_CANONICAL`]
/// fragment inlined across `pagination/{hierarchy,trash}.rs`):
/// `b.page_id IN (SELECT bp.block_id FROM
/// block_properties bp WHERE bp.key = 'space' AND bp.value_ref = ?1)`.
/// A soft-deleted block retains its `page_id` column value so the
/// filter applies identically to live and deleted blocks.
///
/// Returns the raw row count — descendants of a deleted root are
/// counted individually. The badge only needs a non-zero / count
/// summary; root-vs-descendant accounting is the trash view's job
/// (see `trash_descendant_counts_inner`).
///
/// # Errors
///
/// - [`AppError::Database`] — propagated from sqlx.
#[instrument(skip(pool), err)]
pub async fn count_trash_inner(pool: &SqlitePool, space_id: &str) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) FROM blocks b
           WHERE b.deleted_at IS NOT NULL
             AND b.space_id = ?1"#,
        space_id,
    )
    .fetch_one(pool)
    .await?;
    Ok(count)
}

/// Tauri command: count soft-deleted blocks in a space. Delegates to
/// [`count_trash_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn count_trash(pool: State<'_, ReadPool>, space_id: String) -> Result<i64, AppError> {
    count_trash_inner(&pool.0, &space_id)
        .await
        .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const SPACE_A_ID: &str = "SPACE_AA";
    const SPACE_B_ID: &str = "SPACE_BB";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a space block (page with `is_space = 'true'`). Mirrors the
    /// helper used by `pagination::tests` so the `block_properties.value_ref
    /// → blocks(id)` FK is satisfied for later `space` assignments.
    async fn insert_space_block(pool: &SqlitePool, id: &str, name: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, 1, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Assign a block to a space by stamping the denormalized
    /// `blocks.space_id` column directly. Bypasses the command layer.
    async fn assign_to_space(pool: &SqlitePool, block_id: &str, space_id: &str) {
        // #533: `blocks.space_id` is the sole source of truth these queries
        // filter on (every block whose owning page is `block_id`).
        sqlx::query("UPDATE blocks SET space_id = ? WHERE page_id = ?")
            .bind(space_id)
            .bind(block_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a live (non-deleted) page block at the top level (no parent).
    /// `page_id = id` matches the invariant migration 0066 backfilled and
    /// every production page-create path now upholds.
    async fn insert_live_page(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'live', NULL, 1, ?)",
        )
        .bind(id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a soft-deleted page block at the top level. `page_id = id`
    /// per the §5.3 backfill in migration 0066.
    async fn insert_deleted_page(pool: &SqlitePool, id: &str, deleted_at: i64) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at, page_id) \
             VALUES (?, 'page', 'trash', NULL, 1, ?, ?)",
        )
        .bind(id)
        .bind(deleted_at)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn count_trash_returns_count_of_soft_deleted_blocks_in_space() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;

        // 3 soft-deleted blocks in SPACE_A.
        for (i, id) in ["TRSH_A1", "TRSH_A2", "TRSH_A3"].iter().enumerate() {
            insert_deleted_page(
                &pool,
                id,
                1_738_368_000_000 + i64::try_from(i).unwrap() * 86_400_000,
            )
            .await;
            assign_to_space(&pool, id, SPACE_A_ID).await;
        }

        // 2 live (non-deleted) blocks in SPACE_A — must not be counted.
        for id in ["LIVE_A1", "LIVE_A2"] {
            insert_live_page(&pool, id).await;
            assign_to_space(&pool, id, SPACE_A_ID).await;
        }

        let count = count_trash_inner(&pool, SPACE_A_ID).await.unwrap();
        assert_eq!(
            count, 3,
            "count_trash must return exactly the soft-deleted blocks in the space \
             (live blocks excluded)"
        );
    }

    #[tokio::test]
    async fn count_trash_excludes_blocks_from_other_spaces() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;
        insert_space_block(&pool, SPACE_B_ID, "Work").await;

        // 2 soft-deleted blocks in SPACE_A.
        for (i, id) in ["TRSH_A1", "TRSH_A2"].iter().enumerate() {
            insert_deleted_page(
                &pool,
                id,
                1_738_368_000_000 + i64::try_from(i).unwrap() * 86_400_000,
            )
            .await;
            assign_to_space(&pool, id, SPACE_A_ID).await;
        }

        // 3 soft-deleted blocks in SPACE_B — must not appear when counting SPACE_A.
        for (i, id) in ["TRSH_B1", "TRSH_B2", "TRSH_B3"].iter().enumerate() {
            insert_deleted_page(
                &pool,
                id,
                1_740_787_200_000 + i64::try_from(i).unwrap() * 86_400_000,
            )
            .await;
            assign_to_space(&pool, id, SPACE_B_ID).await;
        }

        let count_a = count_trash_inner(&pool, SPACE_A_ID).await.unwrap();
        let count_b = count_trash_inner(&pool, SPACE_B_ID).await.unwrap();
        assert_eq!(
            count_a, 2,
            "SPACE_A trash count must exclude SPACE_B blocks; got {count_a}"
        );
        assert_eq!(
            count_b, 3,
            "SPACE_B trash count must exclude SPACE_A blocks; got {count_b}"
        );
    }
}
