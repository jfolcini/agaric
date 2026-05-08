//! Queries command handlers.

use std::collections::HashMap;

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::backlink::{
    self, BacklinkFilter, BacklinkQueryResponse, BacklinkSort, GroupedBacklinkResponse,
};
use crate::db::ReadPool;
use crate::error::AppError;
use crate::fts;
use crate::materializer::Materializer;
use crate::materializer::StatusInfo;
use crate::pagination::{self, ActiveBlockRow, BlockRow, PageResponse};
use crate::space::SpaceScope;
use crate::sync_scheduler::SyncScheduler;

use super::*;

/// List blocks that link to the given block (backlinks), with cursor pagination.
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts the result set
/// to source blocks whose owning page carries `space = ?space_id`.
/// [`SpaceScope::Global`] is the unscoped (pre-FEAT-3) behaviour
/// preserved for callsites that span every space.
#[instrument(skip(pool), err)]
pub async fn get_backlinks_inner(
    pool: &SqlitePool,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_backlinks(pool, &block_id, &page, scope.as_filter_param()).await
}

/// List conflict-copy blocks (blocks with `is_conflict = true`), with cursor pagination.
///
/// PEND-35 Tier 1.4 — `conflict_type` and `id_min` push two FE-side
/// filters into SQL so cursor pagination remains consistent under
/// filtering. `id_min` is a ULID lower bound (date lower bound, since
/// ULIDs are time-ordered).
#[instrument(skip(pool), err)]
pub async fn get_conflicts_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
    conflict_type: Option<String>,
    id_min: Option<String>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_conflicts(pool, &page, conflict_type.as_deref(), id_min.as_deref()).await
}

/// Return current materializer queue metrics and system status.
#[instrument(skip(materializer, scheduler))]
pub async fn get_status_inner(
    materializer: &Materializer,
    scheduler: Option<&SyncScheduler>,
) -> StatusInfo {
    materializer.status_with_scheduler(scheduler).await
}

/// Full-text search across block content using FTS5.
///
/// Returns an empty page if the query is blank. Otherwise delegates to
/// [`fts::search_fts`] with cursor pagination.
///
/// FEAT-3 Phase 4 — `space_id` is required (not optional). The filter is
/// threaded through `fts::search_fts` so the FTS5 hits are restricted to
/// blocks whose owning page carries `space = ?space_id`. The MCP path
/// (`mcp::tools_ro::handle_search`) requires the agent to thread its
/// active space too — see the `search` tool's input schema.
#[instrument(skip(pool, tag_ids), err)]
pub async fn search_blocks_inner(
    pool: &SqlitePool,
    query: String,
    cursor: Option<String>,
    limit: Option<i64>,
    parent_id: Option<String>,
    tag_ids: Option<Vec<String>>,
    space_id: String,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    if query.trim().is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
        });
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    fts::search_fts(
        pool,
        &query,
        &page,
        parent_id.as_deref(),
        tag_ids.as_deref(),
        Some(space_id.as_str()),
    )
    .await
}

/// Query blocks by property key and optional value filter.
///
/// Returns a paginated list of blocks that have the specified property.
/// When `value_text` is provided, only blocks whose property value matches are returned.
/// Results are paginated using cursor-based pagination (by block_id).
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts the result set
/// to blocks whose owning page carries `space = ?space_id`.
/// [`SpaceScope::Global`] is the unscoped (pre-FEAT-3) behaviour
/// preserved for callsites that span every space.
///
/// `exclude_parent_id` / `content_non_empty` (PEND-35 Tier 1.5) push the
/// DonePanel's two post-filters down into SQL so cursor pagination,
/// `total_count`, and "Load more" reflect the visible set instead of
/// the unfiltered page. `None` / `false` preserves the legacy
/// behaviour (clauses short-circuit to no-ops).
///
/// `block_type` / `value_text_in` / `value_date_range` (PEND-35 Tier
/// 3.4) push three more filters into SQL: a `block_type` equality, a
/// JSON-array `value_text IN (...)`, and a half-open `[from, to)` date
/// range. `value_text_in` and `value_text` are mutually exclusive
/// (rejected with [`AppError::Validation`]).
///
/// # Errors
/// - [`AppError::Validation`] — `key` is empty
/// - [`AppError::Validation`] — both `value_text` and `value_text_in` supplied
/// - [`AppError::Validation`] — both `value_text` and `value_date` supplied
#[instrument(skip(pool, value_text_in), err)]
#[allow(clippy::too_many_arguments)]
pub async fn query_by_property_inner(
    pool: &SqlitePool,
    key: String,
    value_text: Option<String>,
    value_date: Option<String>,
    operator: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
    exclude_parent_id: Option<String>,
    content_non_empty: bool,
    block_type: Option<String>,
    value_text_in: Option<Vec<String>>,
    value_date_range: Option<(String, String)>,
) -> Result<PageResponse<BlockRow>, AppError> {
    if key.trim().is_empty() {
        return Err(AppError::Validation(
            "property key must not be empty".into(),
        ));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    let op = operator.as_deref().unwrap_or("eq");
    let value_text_in_slice: &[String] = value_text_in.as_deref().unwrap_or(&[]);
    let value_date_range_ref: Option<(&str, &str)> = value_date_range
        .as_ref()
        .map(|(from, to)| (from.as_str(), to.as_str()));
    pagination::query_by_property(
        pool,
        &key,
        value_text.as_deref(),
        value_date.as_deref(),
        op,
        &page,
        scope.as_filter_param(),
        exclude_parent_id.as_deref(),
        content_non_empty,
        block_type.as_deref(),
        value_text_in_slice,
        value_date_range_ref,
    )
    .await
}

/// List unfinished tasks before a given date.
///
/// Returns blocks where `todo_state IN ('TODO', 'DOING')` and
/// `(due_date < before_date OR scheduled_date < before_date)`.
/// Ordered by `COALESCE(due_date, scheduled_date) DESC, id DESC`.
#[instrument(skip(pool), err)]
pub async fn list_unfinished_tasks_inner(
    pool: &SqlitePool,
    before_date: String,
    todo_states: Vec<String>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<PageResponse<BlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_unfinished_tasks(
        pool,
        &before_date,
        &todo_states,
        &page,
        scope.as_filter_param(),
    )
    .await
}

/// Query backlinks for a block with optional filters, sorting, and pagination.
///
/// When no filters are supplied, returns all backlinks (backward compatible).
/// Filters use AND semantics at the top level; use `And`/`Or`/`Not` filter
/// variants for compound boolean logic.
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts the result set
/// to source blocks whose owning page carries `space = ?space_id`. The
/// filter is applied at the base-set step so `total_count` and
/// `filtered_count` reflect the post-space-filter universe.
/// [`SpaceScope::Global`] is the unscoped (pre-FEAT-3) behaviour.
///
/// # Errors
/// - [`AppError::Validation`] — `block_id` is empty
#[instrument(skip(pool, filters, sort), err)]
pub async fn query_backlinks_filtered_inner(
    pool: &SqlitePool,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<BacklinkQueryResponse, AppError> {
    if block_id.trim().is_empty() {
        return Err(AppError::Validation("block_id must not be empty".into()));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    backlink::eval_backlink_query(
        pool,
        &block_id,
        filters,
        sort,
        &page,
        scope.as_filter_param(),
    )
    .await
}

/// Query backlinks grouped by source page.
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts the result set
/// to source blocks whose owning page carries `space = ?space_id`. The
/// filter is applied at the base-set step so `total_count` and
/// `filtered_count` reflect the post-space-filter universe.
/// [`SpaceScope::Global`] is the unscoped (pre-FEAT-3) behaviour.
///
/// # Errors
/// - [`AppError::Validation`] — `block_id` is empty
#[instrument(skip(pool, filters, sort), err)]
pub async fn list_backlinks_grouped_inner(
    pool: &SqlitePool,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<GroupedBacklinkResponse, AppError> {
    if block_id.trim().is_empty() {
        return Err(AppError::Validation("block_id must not be empty".into()));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    backlink::eval_backlink_query_grouped(
        pool,
        &block_id,
        filters,
        sort,
        &page,
        scope.as_filter_param(),
    )
    .await
}

/// Query unlinked references for a page — blocks that mention the page's
/// title without having an explicit `[[link]]`.
///
/// When `filters` is provided, filters are applied to the FTS match set using
/// AND semantics at the top level (same resolver as [`list_backlinks_grouped_inner`]).
/// When `sort` is provided, blocks within the paginated groups are ordered
/// accordingly; the default is `Created { Asc }` (ULID order).
/// `total_count` and `filtered_count` both reflect the post-filter,
/// post-self-reference-exclusion block count (AGENTS.md pattern #4).
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts FTS-matched
/// blocks to those whose owning page carries `space = ?space_id`. The
/// filter is applied at the base-set step so `total_count` and
/// `filtered_count` reflect the post-space-filter universe.
/// [`SpaceScope::Global`] is the unscoped (pre-FEAT-3) behaviour.
///
/// # Errors
/// - [`AppError::Validation`] — `page_id` is empty
#[instrument(skip(pool, filters, sort), err)]
pub async fn list_unlinked_references_inner(
    pool: &SqlitePool,
    page_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<GroupedBacklinkResponse, AppError> {
    if page_id.trim().is_empty() {
        return Err(AppError::Validation("page_id must not be empty".into()));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    backlink::eval_unlinked_references(pool, page_id, filters, sort, &page, scope.as_filter_param())
        .await
}

/// Count active (non-deleted) conflict-copy blocks.
///
/// PEND-35 Tier 2.11 — replaces the FE pattern of paginating
/// [`get_conflicts_inner`] with `limit: 100` just to read
/// `data.items.length` for the conflicts-tab badge. Materialising up to
/// 100 full [`BlockRow`]s every 30 s for a single integer is wasteful;
/// worse, the count is silently capped at 100 since the badge cannot
/// see past the first page. This helper runs a single
/// `SELECT COUNT(*)` so the badge surfaces the true count regardless of
/// magnitude.
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts the count to
/// blocks whose owning page (resolved via `COALESCE(b.page_id, b.id)`)
/// carries `space = ?space_id`. The shape mirrors every sibling
/// space-scoped read (see `count_backlinks_batch_inner`,
/// `crate::backlink::query::eval_backlink_query`). [`SpaceScope::Global`]
/// preserves the cross-space count for legacy callers.
///
/// Uses the partial index `idx_blocks_conflict ON blocks(id) WHERE
/// is_conflict = 1 AND deleted_at IS NULL` (migration 0049, PEND-35
/// Tier 3.2). The unscoped path is index-served end-to-end; the
/// space-scoped path still benefits because the partial index narrows
/// the candidate set before the property-table subquery runs.
///
/// # Errors
///
/// - Database errors propagated from sqlx.
#[instrument(skip(pool), err)]
pub async fn count_conflicts_inner(pool: &SqlitePool, scope: &SpaceScope) -> Result<i64, AppError> {
    // FEAT-3p4 — `?1` carries the active space id (or NULL for
    // [`SpaceScope::Global`]). The clause shape mirrors
    // `crate::backlink::query::eval_backlink_query` and
    // `count_backlinks_batch_inner`:
    //   `(?N IS NULL OR COALESCE(b.page_id, b.id) IN (
    //        SELECT bp.block_id FROM block_properties bp
    //        WHERE bp.key = 'space' AND bp.value_ref = ?N))`
    // — applied to the conflict block (`b`) so a conflict whose owning
    // page lives outside the active space is excluded from the badge.
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) \
         FROM blocks b \
         WHERE b.is_conflict = 1 AND b.deleted_at IS NULL \
           AND (?1 IS NULL OR COALESCE(b.page_id, b.id) IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?1))",
    )
    .bind(scope.as_filter_param())
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// Count backlinks per target page for a batch of page IDs in a single query.
///
/// Returns a `HashMap<page_id, count>` for pages that have at least one
/// incoming link whose source block is not soft-deleted and is not a conflict.
///
/// `scope` (PEND-35 Tier 1.6) — [`SpaceScope::Active`] restricts the
/// counted source blocks to those whose owning page carries
/// `space = ?space_id`. Mirrors the `(?N IS NULL OR COALESCE(b.page_id,
/// b.id) IN (...))` clause used by every sibling backlink query (see
/// `crate::backlink::query::eval_backlink_query`). Without this clause
/// a page in space A could surface a non-zero badge count whose source
/// blocks live in space B — backlinks the user can't actually see.
/// [`SpaceScope::Global`] preserves the pre-PEND-35 unscoped count.
///
/// # Errors
///
/// - Database errors propagated from sqlx.
#[instrument(skip(pool, page_ids), err)]
pub async fn count_backlinks_batch_inner(
    pool: &SqlitePool,
    page_ids: Vec<String>,
    scope: &SpaceScope,
) -> Result<HashMap<String, usize>, AppError> {
    if page_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids_json = serde_json::to_string(&page_ids)?;
    // PEND-35 Tier 1.6 — `?2` carries the active space id (or NULL for
    // [`SpaceScope::Global`]). The shape mirrors
    // `crate::backlink::query::eval_backlink_query`:
    //   `(?N IS NULL OR COALESCE(b.page_id, b.id) IN (
    //        SELECT bp.block_id FROM block_properties bp
    //        WHERE bp.key = 'space' AND bp.value_ref = ?N))`
    // — applied to the SOURCE block (`b`) so a backlink whose source
    // page lives outside the active space is excluded from the count.
    let sql = "SELECT bl.target_id, COUNT(*) as cnt \
         FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id IN (SELECT value FROM json_each(?1)) \
           AND b.deleted_at IS NULL \
           AND b.is_conflict = 0 \
           AND (?2 IS NULL OR COALESCE(b.page_id, b.id) IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?2)) \
         GROUP BY bl.target_id";
    let rows = sqlx::query_as::<_, (String, i64)>(sql)
        .bind(ids_json)
        .bind(scope.as_filter_param())
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        // cnt is a non-negative count from SQL; safe to convert (I-CommandsCRUD-11)
        .map(|(id, cnt)| {
            (
                id,
                usize::try_from(cnt)
                    .expect("COUNT(*) is non-negative and fits in usize on 64-bit targets"),
            )
        })
        .collect())
}

/// Tauri command: list backlinks for a block. Delegates to [`get_backlinks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_backlinks(
    pool: State<'_, ReadPool>,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    get_backlinks_inner(&pool.0, block_id, cursor, limit, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list conflict-copy blocks. Delegates to [`get_conflicts_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_conflicts(
    pool: State<'_, ReadPool>,
    cursor: Option<String>,
    limit: Option<i64>,
    conflict_type: Option<String>,
    id_min: Option<String>,
) -> Result<PageResponse<BlockRow>, AppError> {
    get_conflicts_inner(&pool.0, cursor, limit, conflict_type, id_min)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get materializer queue status. Delegates to [`get_status_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_status(
    materializer: State<'_, Materializer>,
    scheduler: State<'_, std::sync::Arc<SyncScheduler>>,
) -> Result<StatusInfo, AppError> {
    Ok(get_status_inner(&materializer, Some(scheduler.as_ref())).await)
}

/// Tauri command: full-text search across blocks. Delegates to [`search_blocks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn search_blocks(
    pool: State<'_, ReadPool>,
    query: String,
    cursor: Option<String>,
    limit: Option<i64>,
    parent_id: Option<String>,
    tag_ids: Option<Vec<String>>,
    space_id: String,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    search_blocks_inner(&pool.0, query, cursor, limit, parent_id, tag_ids, space_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: query blocks by property key/value. Delegates to [`query_by_property_inner`].
///
/// All push-down filters (`exclude_parent_id`, `content_non_empty`,
/// `block_type`, `value_text_in`, `value_date_range`) are bundled
/// into [`ExtraQueryFilters`] to keep this wrapper under the
/// `tauri-specta` 10-arg limit. The hand-written TS wrapper in
/// `src/lib/tauri.ts` keeps the flat public API at
/// `queryByProperty({ blockType, valueTextIn, ... })` and marshals
/// into the struct only at the IPC boundary, mirroring the
/// [`AgendaQuery`] precedent on `list_blocks`.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn query_by_property(
    pool: State<'_, ReadPool>,
    key: String,
    value_text: Option<String>,
    value_date: Option<String>,
    operator: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
    extra_filters: Option<ExtraQueryFilters>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let (exclude_parent_id, content_non_empty, block_type, value_text_in, value_date_range) =
        match extra_filters {
            Some(f) => (
                f.exclude_parent_id,
                f.content_non_empty.unwrap_or(false),
                f.block_type,
                f.value_text_in,
                f.value_date_range,
            ),
            None => (None, false, None, None, None),
        };
    query_by_property_inner(
        &pool.0,
        key,
        value_text,
        value_date,
        operator,
        cursor,
        limit,
        &scope,
        exclude_parent_id,
        content_non_empty,
        block_type,
        value_text_in,
        value_date_range,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list unfinished tasks before a given date. Delegates to [`list_unfinished_tasks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_unfinished_tasks(
    pool: State<'_, ReadPool>,
    before_date: String,
    todo_states: Vec<String>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<PageResponse<BlockRow>, AppError> {
    list_unfinished_tasks_inner(&pool.0, before_date, todo_states, cursor, limit, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: filtered backlink query. Delegates to [`query_backlinks_filtered_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn query_backlinks_filtered(
    read_pool: State<'_, ReadPool>,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<BacklinkQueryResponse, AppError> {
    query_backlinks_filtered_inner(&read_pool.0, block_id, filters, sort, cursor, limit, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: grouped backlink query. Delegates to [`list_backlinks_grouped_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn list_backlinks_grouped(
    read_pool: State<'_, ReadPool>,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<GroupedBacklinkResponse, AppError> {
    list_backlinks_grouped_inner(&read_pool.0, block_id, filters, sort, cursor, limit, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: unlinked references query. Delegates to [`list_unlinked_references_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn list_unlinked_references(
    read_pool: State<'_, ReadPool>,
    page_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<GroupedBacklinkResponse, AppError> {
    list_unlinked_references_inner(&read_pool.0, &page_id, filters, sort, cursor, limit, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-count backlinks per target page. Delegates to [`count_backlinks_batch_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn count_backlinks_batch(
    read_pool: State<'_, ReadPool>,
    page_ids: Vec<String>,
    scope: SpaceScope,
) -> Result<HashMap<String, usize>, AppError> {
    count_backlinks_batch_inner(&read_pool.0, page_ids, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: count active conflict-copy blocks. Delegates to [`count_conflicts_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn count_conflicts(
    pool: State<'_, ReadPool>,
    scope: SpaceScope,
) -> Result<i64, AppError> {
    count_conflicts_inner(&pool.0, &scope)
        .await
        .map_err(sanitize_internal_error)
}
