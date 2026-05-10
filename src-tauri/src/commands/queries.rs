//! Queries command handlers.

use std::collections::HashMap;

use serde::Deserialize;
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
use crate::pagination::{self, ActiveBlockRow, BlockRow, Cursor, PageRequest, PageResponse};
use crate::space::SpaceScope;
use crate::sync_scheduler::SyncScheduler;

use super::*;

// ---------------------------------------------------------------------------
// PEND-35 Tier 2.10b — `filtered_blocks_query` input shapes
// ---------------------------------------------------------------------------

/// One property predicate for [`filtered_blocks_query_inner`].
///
/// Mirrors the per-call shape of [`query_by_property_inner`] so a caller
/// migrating from the JS-side AND-intersection (`Promise.all` over N
/// `query_by_property` IPCs) can replay each sub-filter unchanged. Each
/// instance becomes ONE `EXISTS (SELECT 1 FROM block_properties bp …)`
/// subquery in the composed SQL — the AND-intersection is the
/// structural conjunction of the EXISTS clauses (no JS post-filter, no
/// silent row cap).
///
/// At most one of `value_text` / `value_text_in` / `value_date` /
/// `value_date_range` should be supplied per filter; mixing them is
/// rejected with [`AppError::Validation`] at the boundary (mirrors the
/// `query_by_property` contract).
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyFilter {
    /// Property key — `block_properties.key` or a reserved column name
    /// (`todo_state`, `priority`, `due_date`, `scheduled_date`).
    pub key: String,
    /// Single text-value equality / comparison. Mutually exclusive with
    /// `value_text_in`.
    pub value_text: Option<String>,
    /// Set-membership over text values, bound as a JSON array via
    /// `json_each(?N)`. Empty = treated as `None`.
    #[serde(default)]
    pub value_text_in: Vec<String>,
    /// Single date-value equality / comparison.
    pub value_date: Option<String>,
    /// Half-open `[from, to)` date range.
    pub value_date_range: Option<(String, String)>,
    /// Comparison operator — `"eq"`, `"neq"`, `"lt"`, `"gt"`, `"lte"`,
    /// `"gte"`. Defaults to `"eq"` for any unrecognised value.
    #[serde(default)]
    pub operator: String,
}

/// Tag predicate for [`filtered_blocks_query_inner`].
///
/// Mirrors the [`query_by_tags_inner`] arg shape. When `mode = "and"`
/// every supplied tag (id or prefix) must match; `"or"` (default) is
/// the union. The predicate is composed into ONE `AND EXISTS (…)`
/// subquery in the parent SQL — the JS-side AND-intersection between
/// property and tag sub-results disappears.
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagFilterExpr {
    /// Explicit tag-block ULIDs.
    #[serde(default)]
    pub tag_ids: Vec<String>,
    /// Tag-name prefixes (resolved via `tags_cache.name LIKE ?`).
    #[serde(default)]
    pub prefixes: Vec<String>,
    /// `"and"` for intersection across all tag matches, anything else
    /// (default `"or"`) for union.
    #[serde(default)]
    pub mode: String,
    /// Whether to include inherited tags (`block_tag_inherited`) in
    /// addition to direct (`block_tags`) and inline-ref
    /// (`block_tag_refs`) associations. Defaults to `false`.
    #[serde(default)]
    pub include_inherited: bool,
}

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
/// PEND-09 Phase 4 dropped the `blocks.is_conflict` column. The
/// conflict-copy creation path was made unreachable in Phase 3, so this
/// counter can never be non-zero — it is preserved as a vacuous Tauri
/// surface so the IPC contract stays stable.
///
/// # Errors
///
/// - Database errors propagated from sqlx (none are issued, but the
///   signature is preserved).
#[instrument(skip(_pool), err)]
pub async fn count_conflicts_inner(
    _pool: &SqlitePool,
    _scope: &SpaceScope,
) -> Result<i64, AppError> {
    Ok(0)
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

// ---------------------------------------------------------------------------
// PEND-35 Tier 2.10b — `filtered_blocks_query`
// ---------------------------------------------------------------------------
//
// AND-intersection of property + tag predicates resolved entirely in
// SQL via composed `EXISTS` subqueries. Replaces the FE `useQueryExecution.
// fetchFilteredQuery` shape that issued one IPC per sub-filter (each
// capped at `FILTERED_SUBQUERY_LIMIT = 200`) and intersected the result
// IDs in JS — silently dropping any AND-set member outside the top-200
// of any one sub-query. The new shape pushes the entire predicate to
// SQLite so the SQL planner walks the full universe and the result set
// has no implicit row cap beyond the requested page limit.
//
// The AND between sub-filters is structural: every property filter
// becomes one `AND EXISTS (SELECT 1 FROM block_properties bp WHERE
// bp.block_id = b.id AND bp.key = ? AND <value predicate>)`, every tag
// filter becomes one `AND EXISTS (SELECT 1 FROM block_tags bt …)`. The
// SQL composition pattern mirrors `BacklinkFilter::And` in
// `backlink/filters.rs`, the audit-cited "working template" — except
// instead of materialising candidate sets per leaf and intersecting in
// Rust, we let SQLite do the join.

/// Build the value-predicate SQL fragment for one property filter.
///
/// Returns `(fragment, binds)` where `fragment` is the SQL clause to
/// AND into the parent EXISTS subquery (empty string if no value
/// predicate is supplied — the EXISTS is then satisfied by mere key
/// presence) and `binds` is the ordered list of values to bind into
/// the next free placeholder slots (the caller substitutes `?N`
/// numbering at composition time).
///
/// L-23 mirror: at most one of `value_text` / `value_text_in` /
/// `value_date` / `value_date_range` may be set per filter. Mixing
/// returns [`AppError::Validation`] so the SQL contract stays
/// single-shape per branch.
fn property_value_predicate_sql(
    pf: &PropertyFilter,
    bp_alias: &str,
    next_param: &mut usize,
    binds: &mut Vec<String>,
) -> Result<String, AppError> {
    // Reject mutually-exclusive value specifiers (mirrors the L-23
    // contract on `query_by_property_inner`).
    let n_text = i32::from(pf.value_text.is_some());
    let n_text_in = i32::from(!pf.value_text_in.is_empty());
    let n_date = i32::from(pf.value_date.is_some());
    let n_range = i32::from(pf.value_date_range.is_some());
    if n_text + n_text_in + n_date + n_range > 1 {
        return Err(AppError::Validation(
            "filtered_blocks_query: at most one of value_text, value_text_in, value_date, value_date_range may be supplied per filter".into(),
        ));
    }

    let sql_op = match pf.operator.as_str() {
        "neq" => "!=",
        "lt" => "<",
        "gt" => ">",
        "lte" => "<=",
        "gte" => ">=",
        _ => "=",
    };

    if let Some(v) = &pf.value_text {
        let p = *next_param;
        *next_param += 1;
        binds.push(v.clone());
        return Ok(format!(" AND {bp_alias}.value_text {sql_op} ?{p}"));
    }
    if !pf.value_text_in.is_empty() {
        let p = *next_param;
        *next_param += 1;
        // JSON array bind via `json_each` — mirrors the Tier 3.4 path
        // in `pagination/properties.rs::query_by_property`.
        let json = serde_json::to_string(&pf.value_text_in)?;
        binds.push(json);
        return Ok(format!(
            " AND {bp_alias}.value_text IN (SELECT value FROM json_each(?{p}))"
        ));
    }
    if let Some(v) = &pf.value_date {
        let p = *next_param;
        *next_param += 1;
        binds.push(v.clone());
        return Ok(format!(" AND {bp_alias}.value_date {sql_op} ?{p}"));
    }
    if let Some((from, to)) = &pf.value_date_range {
        let p_from = *next_param;
        *next_param += 1;
        binds.push(from.clone());
        let p_to = *next_param;
        *next_param += 1;
        binds.push(to.clone());
        return Ok(format!(
            " AND {bp_alias}.value_date >= ?{p_from} AND {bp_alias}.value_date < ?{p_to}"
        ));
    }
    // No value predicate — EXISTS just checks key presence.
    Ok(String::new())
}

/// AND-intersect property + tag predicates entirely in SQL.
///
/// Returns a [`PageResponse<BlockRow>`] over blocks satisfying every
/// supplied property filter AND every supplied tag predicate AND
/// (optionally) `block_type = ?`. At least one filter must be supplied —
/// callers that genuinely want "all blocks" should use `list_blocks` /
/// `query_by_property` directly. Empty inputs are rejected with
/// [`AppError::Validation`] so a misconfigured FE caller surfaces
/// loudly rather than silently materialising the entire `blocks` table.
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts the result set
/// to blocks whose owning page carries `space = ?space_id`. Mirrors
/// every sibling space-scoped read.
///
/// `cursor` / `limit` — keyset pagination on `b.id ASC` (PEND-35
/// invariant #3 / AGENTS.md cursor pagination).
#[instrument(skip(pool, property_filters, tag_filters), err)]
#[allow(clippy::too_many_arguments)]
pub async fn filtered_blocks_query_inner(
    pool: &SqlitePool,
    property_filters: Vec<PropertyFilter>,
    tag_filters: Option<TagFilterExpr>,
    block_type: Option<String>,
    scope: &SpaceScope,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    // Reject empty-filter calls. The IPC's purpose is the AND-intersection
    // of pushed-down predicates — without any predicate the call is
    // ambiguous (caller probably meant `list_blocks` / a typed list). A
    // loud rejection beats silently scanning every active block.
    let has_tag_filter = tag_filters
        .as_ref()
        .is_some_and(|t| !t.tag_ids.is_empty() || !t.prefixes.is_empty());
    if property_filters.is_empty() && !has_tag_filter && block_type.is_none() {
        return Err(AppError::Validation(
            "filtered_blocks_query: at least one of property_filters / tag_filters / block_type must be supplied".into(),
        ));
    }

    let page = PageRequest::new(cursor, limit)?;
    let fetch_limit = page.limit + 1;
    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.as_str()),
        None => (None, ""),
    };

    // ----- Compose dynamic SQL ------------------------------------------------
    //
    // Reserved bind slots:
    //   ?1  cursor_flag      (Option<i64>; NULL ⇒ no cursor)
    //   ?2  cursor_id        (String; only consulted when ?1 IS NOT NULL)
    //   ?3  fetch_limit      (i64; page.limit + 1)
    //   ?4  space_id         (Option<&str>; NULL ⇒ unscoped)
    //   ?5  block_type       (Option<String>; NULL ⇒ unfiltered)
    //
    // EXISTS-subquery slots are appended starting at ?6.
    let mut sql = String::from(
        "SELECT b.id, b.block_type, b.content, b.parent_id, b.position, \
                b.deleted_at, b.conflict_type, \
                b.todo_state, b.priority, b.due_date, b.scheduled_date, \
                b.page_id \
         FROM blocks b \
         WHERE b.deleted_at IS NULL \
           AND (?1 IS NULL OR b.id > ?2) \
           AND (?4 IS NULL OR COALESCE(b.page_id, b.id) IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?4)) \
           AND (?5 IS NULL OR b.block_type = ?5)",
    );

    let mut next_param: usize = 6;
    let mut prop_binds: Vec<String> = Vec::new();

    // One EXISTS per property filter. AND between filters is the
    // structural conjunction of the EXISTS clauses.
    for pf in &property_filters {
        if pf.key.trim().is_empty() {
            return Err(AppError::Validation(
                "filtered_blocks_query: property filter key must not be empty".into(),
            ));
        }
        // Reserved keys live as columns on `blocks`, not in
        // `block_properties` — collapse the EXISTS into a direct column
        // predicate on `b.<col>` so `priority:1` style filters resolve
        // without a subquery.
        let reserved_col = if is_reserved_property_key(&pf.key) {
            match pf.key.as_str() {
                "todo_state" => Some("todo_state"),
                "priority" => Some("priority"),
                "due_date" => Some("due_date"),
                "scheduled_date" => Some("scheduled_date"),
                _ => {
                    return Err(AppError::Validation(format!(
                        "filtered_blocks_query: reserved key '{}' has no column routing",
                        pf.key
                    )));
                }
            }
        } else {
            None
        };

        if let Some(col) = reserved_col {
            // Direct column predicate. value_text / value_date /
            // value_text_in / value_date_range all bind to the same
            // column; we re-use the helper but rebase the alias so the
            // emitted fragment reads `b.{col}` instead of `bp.value_*`.
            let n_text = i32::from(pf.value_text.is_some());
            let n_text_in = i32::from(!pf.value_text_in.is_empty());
            let n_date = i32::from(pf.value_date.is_some());
            let n_range = i32::from(pf.value_date_range.is_some());
            if n_text + n_text_in + n_date + n_range > 1 {
                return Err(AppError::Validation(
                    "filtered_blocks_query: at most one of value_text, value_text_in, value_date, value_date_range may be supplied per filter".into(),
                ));
            }
            let sql_op = match pf.operator.as_str() {
                "neq" => "!=",
                "lt" => "<",
                "gt" => ">",
                "lte" => "<=",
                "gte" => ">=",
                _ => "=",
            };
            sql.push_str(&format!(" AND b.{col} IS NOT NULL"));
            if let Some(v) = &pf.value_text {
                let p = next_param;
                next_param += 1;
                prop_binds.push(v.clone());
                sql.push_str(&format!(" AND b.{col} {sql_op} ?{p}"));
            } else if !pf.value_text_in.is_empty() {
                let p = next_param;
                next_param += 1;
                prop_binds.push(serde_json::to_string(&pf.value_text_in)?);
                sql.push_str(&format!(
                    " AND b.{col} IN (SELECT value FROM json_each(?{p}))"
                ));
            } else if let Some(v) = &pf.value_date {
                let p = next_param;
                next_param += 1;
                prop_binds.push(v.clone());
                sql.push_str(&format!(" AND b.{col} {sql_op} ?{p}"));
            } else if let Some((from, to)) = &pf.value_date_range {
                let p_from = next_param;
                next_param += 1;
                prop_binds.push(from.clone());
                let p_to = next_param;
                next_param += 1;
                prop_binds.push(to.clone());
                sql.push_str(&format!(" AND b.{col} >= ?{p_from} AND b.{col} < ?{p_to}"));
            }
            continue;
        }

        // Non-reserved: one `AND EXISTS (SELECT 1 FROM block_properties
        // bp WHERE bp.block_id = b.id AND bp.key = ?N <value preds>)`.
        let key_param = next_param;
        next_param += 1;
        prop_binds.push(pf.key.clone());

        let value_pred = property_value_predicate_sql(pf, "bp", &mut next_param, &mut prop_binds)?;

        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM block_properties bp \
                          WHERE bp.block_id = b.id \
                            AND bp.key = ?{key_param}{value_pred})",
        ));
    }

    // Tag filter — one `AND EXISTS (…)` chain. The inner SQL UNIONs
    // `block_tags`, `block_tag_refs` (always), and `block_tag_inherited`
    // (when `include_inherited`) — same UX-250 union semantics as
    // `tag_query::resolve_tag_leaves`.
    let mut tag_binds: Vec<String> = Vec::new();
    if let Some(tf) = &tag_filters {
        if !tf.tag_ids.is_empty() || !tf.prefixes.is_empty() {
            let mode = tf.mode.to_lowercase();
            let conjunction = if mode == "and" { " AND " } else { " OR " };

            // Build per-tag/per-prefix subquery fragments.
            let mut clauses: Vec<String> = Vec::new();
            for tag_id in &tf.tag_ids {
                let p = next_param;
                next_param += 1;
                tag_binds.push(tag_id.clone());
                let mut union_arms = vec![
                    format!(
                        "SELECT 1 FROM block_tags bt WHERE bt.block_id = b.id AND bt.tag_id = ?{p}"
                    ),
                    format!(
                        "SELECT 1 FROM block_tag_refs btr WHERE btr.source_id = b.id AND btr.tag_id = ?{p}"
                    ),
                ];
                if tf.include_inherited {
                    union_arms.push(format!(
                        "SELECT 1 FROM block_tag_inherited bti WHERE bti.block_id = b.id AND bti.tag_id = ?{p}"
                    ));
                }
                clauses.push(format!("EXISTS ({})", union_arms.join(" UNION ALL ")));
            }
            for prefix in &tf.prefixes {
                let p = next_param;
                next_param += 1;
                // LIKE-escape the user-supplied prefix and append `%` —
                // mirrors `tag_query::resolve_tag_prefix_leaves`.
                let escaped = format!("{}%", crate::sql_utils::escape_like(prefix));
                tag_binds.push(escaped);
                let mut union_arms = vec![
                    format!(
                        "SELECT 1 FROM tags_cache tc \
                         JOIN block_tags bt ON bt.tag_id = tc.tag_id \
                         WHERE bt.block_id = b.id AND tc.name LIKE ?{p} ESCAPE '\\'"
                    ),
                    format!(
                        "SELECT 1 FROM tags_cache tc \
                         JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
                         WHERE btr.source_id = b.id AND tc.name LIKE ?{p} ESCAPE '\\'"
                    ),
                ];
                if tf.include_inherited {
                    union_arms.push(format!(
                        "SELECT 1 FROM tags_cache tc \
                         JOIN block_tag_inherited bti ON bti.tag_id = tc.tag_id \
                         WHERE bti.block_id = b.id AND tc.name LIKE ?{p} ESCAPE '\\'"
                    ));
                }
                clauses.push(format!("EXISTS ({})", union_arms.join(" UNION ALL ")));
            }
            sql.push_str(&format!(" AND ({})", clauses.join(conjunction)));
        }
    }

    sql.push_str(" ORDER BY b.id ASC LIMIT ?3");

    // ----- Bind in declared param order (?1..?N) -----------------------------
    let mut q = sqlx::query_as::<_, BlockRow>(&sql)
        .bind(cursor_flag) // ?1
        .bind(cursor_id) // ?2
        .bind(fetch_limit) // ?3
        .bind(scope.as_filter_param()) // ?4
        .bind(block_type.as_deref()); // ?5
    for v in &prop_binds {
        q = q.bind(v);
    }
    for v in &tag_binds {
        q = q.bind(v);
    }
    let rows = q.fetch_all(pool).await?;

    pagination::build_page_response(rows, page.limit, |last| Cursor::for_id(last.id.clone()))
}

/// Tauri command: AND-intersect property + tag predicates in SQL.
/// Delegates to [`filtered_blocks_query_inner`].
///
/// Replaces the FE pattern of fan-out IPCs (one `query_by_property` /
/// `query_by_tags` per sub-filter, each capped at 200 rows) followed by
/// JS-side intersection capped at 50 rows. The composed-EXISTS shape
/// fixes the silent-cap regression where any AND-set member outside
/// the top-200 of any one sub-query was dropped before the
/// intersection ran.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn filtered_blocks_query(
    pool: State<'_, ReadPool>,
    property_filters: Vec<PropertyFilter>,
    tag_filters: Option<TagFilterExpr>,
    block_type: Option<String>,
    scope: SpaceScope,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    filtered_blocks_query_inner(
        &pool.0,
        property_filters,
        tag_filters,
        block_type,
        &scope,
        cursor,
        limit,
    )
    .await
    .map_err(sanitize_internal_error)
}
