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
use crate::ulid::{BlockId, PageId};

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
    block_id: BlockId,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_backlinks(pool, block_id.as_str(), &page, scope.as_filter_param()).await
}

/// Return current materializer queue metrics and system status.
#[instrument(skip(materializer, scheduler))]
pub async fn get_status_inner(
    materializer: &Materializer,
    scheduler: Option<&SyncScheduler>,
) -> StatusInfo {
    materializer.status_with_scheduler(scheduler).await
}

// ---------------------------------------------------------------------------
// PEND-50 Phase 0 — `search_blocks` IPC struct migration
// ---------------------------------------------------------------------------
//
// #642: the shared search row / filter types (`SearchBlockRow`,
// `SearchFilter`, `MatchOffset`, `NamedDateRange`, `SearchPropertyFilter`
// and the `DateFilter` / `DateOp` types `SearchFilter` embeds) moved to the
// neutral `crate::domain::search_types` layer so `crate::fts` (which
// consumes them for SQL composition) can depend *down* on `domain` instead
// of *up* on `commands`, breaking the `commands ⇄ fts` cycle. They are
// re-exported here verbatim so every command-internal caller and the
// `tauri-specta` binding collection keep using the `commands::queries`
// path unchanged.
pub use crate::domain::search_types::{
    DateFilter, DateOp, MatchOffset, NamedDateRange, SearchBlockRow, SearchFilter,
    SearchPropertyFilter,
};

/// BE-3 (PEND-58f) — marshalled filter parts shared by the cursor
/// (`search_blocks_inner`) and partitioned (`search_blocks_partitioned_inner`)
/// search paths.
///
/// Both inner functions previously open-coded the identical filter
/// marshalling (brace-expand + validate page-name globs, bundle the three
/// toggle flags, resolve metadata predicates) — duplicated bug-for-bug.
/// This struct + [`prepare_search_filter`] centralise it so a fix lands
/// once on both surfaces.
///
/// The `tag_ids` borrow stays at each call site (it is a trivial slice
/// borrow of `filter.tag_ids` whose lifetime is tied to the caller's
/// `filter`).
struct PreparedSearchFilter {
    include_globs: Vec<String>,
    exclude_globs: Vec<String>,
    toggles: fts::SearchToggles,
    metadata: fts::metadata_filter::MetadataPredicates,
}

/// BE-3 (PEND-58f) — marshal the shared filter fields once.
///
/// - PEND-54 — brace-expand and validate page-name globs in Rust so we
///   surface `InvalidGlob:` typed errors at the IPC boundary.
/// - PEND-55 — bundle the three toggle flags into a single value threaded
///   through the FTS / regex-mode pipelines. The default (all-off) value
///   reproduces the pre-PEND-55 FTS-only behaviour.
/// - PEND-53 — resolve state / priority / due / scheduled / property
///   metadata against today's date. Invalid dates / unknown bucket
///   keywords surface as `AppError::Validation` with the
///   `InvalidDateFilter:` prefix the frontend keys on.
fn prepare_search_filter(filter: &SearchFilter) -> Result<PreparedSearchFilter, AppError> {
    let include_globs = fts::glob_filter::prepare_globs(&filter.include_page_globs)?;
    let exclude_globs = fts::glob_filter::prepare_globs(&filter.exclude_page_globs)?;
    let toggles = fts::SearchToggles {
        case_sensitive: filter.case_sensitive,
        whole_word: filter.whole_word,
        is_regex: filter.is_regex,
    };
    let metadata = fts::metadata_filter::prepare_metadata(filter)?;
    Ok(PreparedSearchFilter {
        include_globs,
        exclude_globs,
        toggles,
        metadata,
    })
}

/// Full-text search across block content using FTS5.
///
/// Returns an empty page if the query is blank. Otherwise delegates to
/// [`fts::search_fts`] with cursor pagination.
///
/// PEND-50 Phase 0 — the previous positional `parent_id` / `tag_ids` /
/// `space_id` args are bundled into [`SearchFilter`]. A
/// default-constructed `SearchFilter` reproduces the pre-PEND-50
/// "no filter" behaviour (apart from `space_id`, which the FEAT-3p4
/// path still requires the caller to supply).
///
/// FEAT-3 Phase 4 — `filter.space_id` is required (not optional). The
/// filter is threaded through `fts::search_fts` so the FTS5 hits are
/// restricted to blocks whose owning page carries `space =
/// ?space_id`. The MCP path (`mcp::tools_ro::handle_search`) requires
/// the agent to thread its active space too — see the `search` tool's
/// input schema.
/// P4 (#346) — `snippet_len`: when `Some(n)`, each returned row's
/// `content` is truncated to the first `n` codepoints at the DATABASE
/// (`substr(b.content, 1, n)` on the non-matching paths; after regex
/// matching on the toggle/regex paths so matches and offsets stay
/// correct). `None` returns full `content` — the byte-identical
/// behaviour every FE/IPC caller relies on. The MCP `search` tool passes
/// `Some(SEARCH_SNIPPET_CAP)` so it no longer fetches up to 50 full block
/// bodies just to `.chars().take(512)` them in Rust.
#[instrument(skip(pool, filter), err)]
pub async fn search_blocks_inner(
    pool: &SqlitePool,
    query: String,
    cursor: Option<String>,
    limit: Option<i64>,
    filter: SearchFilter,
    snippet_len: Option<usize>,
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    // PEND-58g NEW-3 — the empty-query decision now lives in
    // `fts::search_with_toggles`: a blank query with at least one
    // structural filter returns the filtered set (recency-ordered),
    // while a blank query with no filter returns empty. Let the empty
    // query flow through instead of short-circuiting here.
    let page = pagination::PageRequest::new(cursor, limit)?;

    // SQL-A1 (PEND-58f) — align the over-cap contract with the
    // partitioned path (BE-2). `PageRequest::new` accepts `1..=200`, but
    // the FTS scan ceiling is `MAX_SEARCH_RESULTS` (100); without this
    // check a cursor caller passing 101–200 would have been silently
    // capped by `search_fts`'s `min(limit, MAX_SEARCH_RESULTS)` while the
    // partitioned command REJECTS the same over-limit ask. Reject here so
    // both surfaces agree (the `min` in `search_fts` stays as
    // defence-in-depth). Mirrors the BE-2 `AppError::Validation` shape in
    // `search_blocks_partitioned_inner`.
    let max_results = fts::MAX_SEARCH_RESULTS;
    if page.limit > max_results {
        return Err(AppError::Validation(format!(
            "search limit must be in [1, {max_results}]; got {}",
            page.limit
        )));
    }

    let tag_ids_slice: Option<&[String]> = if filter.tag_ids.is_empty() {
        None
    } else {
        Some(filter.tag_ids.as_slice())
    };
    // BE-3 (PEND-58f) — marshal globs / toggles / metadata via the
    // shared helper so the cursor and partitioned paths stay in lockstep.
    let prepared = prepare_search_filter(&filter)?;

    fts::search_with_toggles(
        pool,
        &query,
        &page,
        filter.parent_id.as_deref(),
        tag_ids_slice,
        filter.space_id.as_deref(),
        &prepared.include_globs,
        &prepared.exclude_globs,
        prepared.toggles,
        filter.block_type_filter.as_deref(),
        &prepared.metadata,
        snippet_len,
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
    block_id: BlockId,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<BacklinkQueryResponse, AppError> {
    if block_id.as_str().trim().is_empty() {
        return Err(AppError::Validation("block_id must not be empty".into()));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    backlink::eval_backlink_query(
        pool,
        block_id.as_str(),
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
    block_id: BlockId,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<GroupedBacklinkResponse, AppError> {
    if block_id.as_str().trim().is_empty() {
        return Err(AppError::Validation("block_id must not be empty".into()));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    backlink::eval_backlink_query_grouped(
        pool,
        block_id.as_str(),
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
    page_id: &PageId,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<GroupedBacklinkResponse, AppError> {
    if page_id.as_str().trim().is_empty() {
        return Err(AppError::Validation("page_id must not be empty".into()));
    }
    let page = pagination::PageRequest::new(cursor, limit)?;
    backlink::eval_unlinked_references(
        pool,
        page_id.as_str(),
        filters,
        sort,
        &page,
        scope.as_filter_param(),
    )
    .await
}

/// Count backlinks per target page for a batch of page IDs in a single query.
///
/// Returns a `HashMap<page_id, count>` for pages that have at least one
/// incoming link whose source block is not soft-deleted and is not a conflict.
///
/// `scope` (PEND-35 Tier 1.6) — [`SpaceScope::Active`] restricts the
/// counted source blocks to those whose owning page carries
/// `space = ?space_id`. Mirrors the `(?N IS NULL OR b.page_id IN (...))`
/// clause used by every sibling backlink query (see
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
    page_ids: Vec<PageId>,
    scope: &SpaceScope,
) -> Result<HashMap<String, usize>, AppError> {
    if page_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // `json_each(?1)` binds a JSON array of the canonical id strings.
    let id_strings: Vec<&str> = page_ids.iter().map(PageId::as_str).collect();
    let ids_json = serde_json::to_string(&id_strings)?;
    // PEND-35 Tier 1.6 — `?2` carries the active space id (or NULL for
    // [`SpaceScope::Global`]). The shape mirrors
    // `crate::backlink::query::eval_backlink_query`:
    //   `(?N IS NULL OR b.space_id = ?N)`
    // (#533, migration 0086 — `space_id` is a first-class column)
    // — applied to the SOURCE block (`b`) so a backlink whose source
    // page lives outside the active space is excluded from the count.
    let sql = "SELECT bl.target_id, COUNT(*) as cnt \
         FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id IN (SELECT value FROM json_each(?1)) \
           AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR b.space_id = ?2) \
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
    block_id: BlockId,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    get_backlinks_inner(&pool.0, block_id, cursor, limit, &scope)
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
///
/// PEND-50 Phase 0 — `parent_id` / `tag_ids` / `space_id` are bundled
/// into [`SearchFilter`] so the wrapper stays well under the
/// `tauri-specta` 10-arg ceiling as follow-up plans append filter
/// fields (`#[serde(default)]` keeps wire compat). The hand-written
/// TS wrapper in `src/lib/tauri.ts` keeps the public API at
/// `searchBlocks({ parentId, tagIds, spaceId, ... })` and marshals
/// into the struct only at the IPC boundary, mirroring the
/// [`ExtraQueryFilters`] precedent on [`query_by_property`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn search_blocks(
    pool: State<'_, ReadPool>,
    query: String,
    cursor: Option<String>,
    limit: Option<i64>,
    filter: SearchFilter,
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    // P4 (#346) — the FE/IPC path always wants full block content
    // (`snippet_len = None`); only the MCP `search` tool opts into DB-side
    // truncation.
    search_blocks_inner(&pool.0, query, cursor, limit, filter, None)
        .await
        .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// PEND-61 Phase 1 — `search_blocks_partitioned` IPC
// ---------------------------------------------------------------------------

/// Response envelope for [`search_blocks_partitioned`].
///
/// Carries two partitions of the same FTS scan in one IPC round-trip:
///
/// - `pages` — rows where `block_type == "page"`, capped at the
///   caller's `page_limit`.
/// - `blocks` — the **unrestricted** rank-ordered set (may include
///   page-typed rows alongside content), capped at the caller's
///   `block_limit`. The palette intentionally shows both together in
///   this partition; the dedicated `pages` partition is for the
///   page-group rendering.
///
/// Neither partition emits a cursor (the palette doesn't paginate) and
/// `total_count` is always `None`. The `has_more` flag is set per
/// partition — see [`search_blocks_partitioned`] for the exact
/// semantics.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartitionedSearchResponse {
    /// Rows with `block_type = 'page'`, capped at `page_limit`.
    pub pages: PageResponse<SearchBlockRow>,
    /// Unrestricted rank-ordered rows (any `block_type`), capped at
    /// `block_limit`. May overlap with [`Self::pages`] — the palette
    /// merges them client-side.
    pub blocks: PageResponse<SearchBlockRow>,
}

/// PEND-61 Phase 1 / PEND-69 F1 — partitioned search inner.
///
/// Two parallel FTS5 scans, two partitions:
///
/// 1. **`pages`** — rows where `block_type == "page"`, capped at
///    `page_limit`. SQL pushes the `block_type = 'page'` predicate
///    so a content-heavy DB can't crowd pages out of the result set.
/// 2. **`blocks`** — ALL rows in rank order (no `block_type` filter),
///    capped at `block_limit`.
///
/// Both partitions preserve rank order within themselves; the same row
/// may appear in both partitions (a page-typed hit is in `pages` AND
/// in `blocks`). The palette merges them client-side.
///
/// `filter.block_type_filter` is **ignored** — partitioning by
/// `block_type` IS what this function does. The field is left on the
/// wire for `SearchFilter` compat and is silently dropped. **BE-4
/// (PEND-58f) per-endpoint contract:** this is the one search endpoint
/// that drops `block_type_filter`; the cursor [`search_blocks_inner`]
/// path honours it. Both share the [`SearchFilter`] wire type, so the
/// divergence is intentional and surface-specific — do not "fix" it by
/// threading the field here, that would defeat the partition split.
///
/// All other `SearchFilter` fields are honoured exactly as
/// [`search_blocks_inner`] honours them.
///
/// ## Limit validation (BE-2, PEND-58f)
///
/// `page_limit` / `block_limit` must each be in `[0, MAX_SEARCH_RESULTS]`
/// (100). An over-limit request is **rejected** with
/// [`AppError::Validation`], matching the cursor path's
/// `PageRequest::new` "reject, don't silently truncate" contract. The
/// per-partition scan ceiling is `MAX_SEARCH_RESULTS` regardless, so a
/// silent cap would have hidden the discrepancy from the caller.
///
/// ## `has_more` semantics
///
/// PEND-69 F1 — `has_more` is derived from a `limit + 1` probe on
/// each scan independently. Either partition is `true` iff its scan
/// returned more rows than its cap (resolves Open Q3 — probe approach).
/// SQL-3 (PEND-58f) — the probe fetches `min(limit, MAX_SEARCH_RESULTS)
/// + 1`, so `has_more` is now correct even at exactly the cap.
///
/// - `next_cursor = None` for both (palette doesn't paginate).
/// - `total_count = None` for both.
///
/// Empty / whitespace queries short-circuit to two empty partitions —
/// mirrors the [`search_blocks_inner`] short-circuit.
///
/// ## Failure semantics
///
/// Resolves PEND-69 Open Q2 — fail-fast. The two parallel scans run
/// under `tokio::try_join!`; if either errors, the other is dropped
/// and the error propagates without a partial response.
///
/// ## Cancellation
///
/// PEND-70 — `cancel` is an optional cancellation token threaded into
/// the FTS path. The Tauri command wrapper stores a
/// [`crate::cancellation::CancellationGuard`] in the
/// [`crate::cancellation::CancellationRegistry`] extension state and
/// spawns this inner via `tokio::spawn`, so the guard outlives the
/// wrapper future. When the wrapper future drops (or `cancel_search`
/// fires it externally), the guard's `Drop` signals the spawned task,
/// which surfaces [`AppError::Cancelled`] at the next row-batch
/// boundary (≤ 50 ms typical, ≤ 200 ms worst case).
//
// `err(level = "info")` keeps `AppError::Cancelled` (the expected
// case under burst-typing) out of ERROR-level logs. Real failures
// still surface via the wrapper's `sanitize_internal_error` warn.
#[instrument(skip(pool, filter, cancel), err(level = "info"))]
pub async fn search_blocks_partitioned_inner(
    pool: &SqlitePool,
    query: String,
    page_limit: u32,
    block_limit: u32,
    filter: SearchFilter,
    cancel: Option<crate::cancellation::CancellationToken>,
) -> Result<PartitionedSearchResponse, AppError> {
    // PEND-58g NEW-3 — the empty-query decision now lives in
    // `fts::search_with_toggles_partitioned`: a blank query with at
    // least one structural filter returns the filtered partitions
    // (recency-ordered), while a blank query with no filter returns two
    // empty partitions. Let the empty query flow through instead of
    // short-circuiting here.

    // BE-2 (PEND-58f) — reject an over-limit request instead of silently
    // capping it. The per-partition scan ceiling is `MAX_SEARCH_RESULTS`
    // (100); a caller asking for more would have had its request quietly
    // clamped, so the response cardinality / `has_more` would not match
    // what was asked. Mirror the cursor path's `PageRequest::new`
    // "reject, don't truncate" contract. The public command signature is
    // unchanged — this returns the existing `AppError::Validation`.
    let max_results = u32::try_from(fts::MAX_SEARCH_RESULTS).unwrap_or(u32::MAX);
    if page_limit > max_results || block_limit > max_results {
        return Err(AppError::Validation(format!(
            "partitioned search limits must each be in [0, {max_results}]; \
             got page_limit={page_limit}, block_limit={block_limit}"
        )));
    }

    let tag_ids_slice: Option<&[String]> = if filter.tag_ids.is_empty() {
        None
    } else {
        Some(filter.tag_ids.as_slice())
    };

    // BE-3 (PEND-58f) — marshal globs / toggles / metadata via the shared
    // helper (same path the cursor `search_blocks_inner` uses).
    let prepared = prepare_search_filter(&filter)?;

    // PEND-69 F1 — `search_with_toggles_partitioned` runs the two
    // scans in parallel under `tokio::try_join!` and returns each
    // partition's `has_more` from a `limit + 1` probe. No further
    // partitioning needed in this caller.
    let scan = fts::search_with_toggles_partitioned(
        pool,
        &query,
        page_limit,
        block_limit,
        filter.parent_id.as_deref(),
        tag_ids_slice,
        filter.space_id.as_deref(),
        &prepared.include_globs,
        &prepared.exclude_globs,
        prepared.toggles,
        &prepared.metadata,
        cancel,
    )
    .await?;

    Ok(PartitionedSearchResponse {
        pages: PageResponse {
            items: scan.pages,
            next_cursor: None,
            has_more: scan.pages_has_more,
            total_count: None,
        },
        blocks: PageResponse {
            items: scan.blocks,
            next_cursor: None,
            has_more: scan.blocks_has_more,
            total_count: None,
        },
    })
}

/// Tauri command: PEND-61 partitioned full-text search. Returns two
/// partitions of the same FTS scan (pages-only + unrestricted) in a
/// single round-trip, replacing the palette's two parallel
/// [`search_blocks`] calls.
///
/// `filter.block_type_filter` is **ignored** by this command — the
/// partitioning IS the block-type split. The field stays on the wire
/// for [`SearchFilter`] compat.
///
/// See [`search_blocks_partitioned_inner`] for the partition + `has_more`
/// contract, and the cancellation contract (PEND-70).
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn search_blocks_partitioned(
    pool: State<'_, ReadPool>,
    registry: State<'_, crate::cancellation::CancellationRegistry>,
    query: String,
    page_limit: u32,
    block_limit: u32,
    filter: SearchFilter,
) -> Result<PartitionedSearchResponse, AppError> {
    // PEND-70 P1-A — extension-state guard architecture.
    //
    // The guard lives in the [`CancellationRegistry`] keyed by a
    // server-generated `request_id`. The actual search work runs in a
    // `tokio::spawn`ed task so its lifetime is independent of this
    // wrapper future. When the wrapper future is dropped (window
    // close, panic unwind, future `cancel_search` IPC), the
    // [`CancelOnDrop`] guard fires `registry.cancel(request_id)`,
    // which signals the spawned task via its token and the task
    // bails with [`AppError::Cancelled`] at the next row-batch
    // boundary.
    let registry: crate::cancellation::CancellationRegistry = (*registry).clone();
    let request_id = ulid::Ulid::new().to_string();
    let guard = std::sync::Arc::new(crate::cancellation::CancellationGuard::new());
    let token = guard.token();
    registry.insert(request_id.clone(), std::sync::Arc::clone(&guard));
    let _defer = crate::cancellation::CancelOnDrop::new(registry, request_id);

    let pool_clone = pool.0.clone();
    // Spawn the inner search so its lifetime is independent of the
    // wrapper future. Awaiting the JoinHandle: if the wrapper future
    // is dropped, the handle is dropped (spawned task continues
    // running independently); `_defer`'s Drop then fires the cancel
    // signal and the spawned task observes it on its next
    // `tokio::select!` boundary.
    let join: tokio::task::JoinHandle<Result<PartitionedSearchResponse, AppError>> =
        tokio::spawn(async move {
            search_blocks_partitioned_inner(
                &pool_clone,
                query,
                page_limit,
                block_limit,
                filter,
                Some(token),
            )
            .await
        });

    let result = match join.await {
        Ok(inner) => inner,
        Err(join_err) if join_err.is_cancelled() => Err(AppError::Cancelled),
        // Task panicked. Route through `AppError::Channel` so
        // `sanitize_internal_error` collapses it to InvalidOperation
        // on the wire while the real cause is logged via the warn
        // path. (No `Internal` variant in this codebase; see
        // `error.rs`.)
        Err(join_err) => Err(AppError::Channel(format!(
            "search task join failed: {join_err}"
        ))),
    };
    result.map_err(sanitize_internal_error)
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
    block_id: BlockId,
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
    block_id: BlockId,
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
    page_id: PageId,
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
    page_ids: Vec<PageId>,
    scope: SpaceScope,
) -> Result<HashMap<String, usize>, AppError> {
    count_backlinks_batch_inner(&read_pool.0, page_ids, &scope)
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
                b.deleted_at, \
                b.todo_state, b.priority, b.due_date, b.scheduled_date, \
                b.page_id \
         FROM blocks b \
         WHERE b.deleted_at IS NULL \
           AND (?1 IS NULL OR b.id > ?2) \
           AND (?4 IS NULL OR b.space_id = ?4) \
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
    if let Some(tf) = &tag_filters
        && (!tf.tag_ids.is_empty() || !tf.prefixes.is_empty())
    {
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

    sql.push_str(" ORDER BY b.id ASC LIMIT ?3");

    // M3 (#348) — drift guard: the running `?N` placeholder index must
    // stay in lockstep with the dynamic bind sequence. `next_param`
    // started at 6 (placeholders `?1..?5` are the five fixed binds
    // below; `?3` is reused for LIMIT), so every increment past 6 must
    // correspond to exactly one pushed value across `prop_binds` +
    // `tag_binds`. An off-by-one in the hand-tracked index would
    // silently misbind; this assert turns that into a debug-build panic
    // (no production cost — values are bound, never interpolated).
    debug_assert_eq!(
        next_param - 6,
        prop_binds.len() + tag_binds.len(),
        "filtered_blocks_query placeholder index ({next_param}) drifted \
         from the dynamic bind count (prop={}, tag={}); the `?N` numbering \
         and the bind sequence are out of sync",
        prop_binds.len(),
        tag_binds.len(),
    );

    // ----- Bind in declared param order (?1..?N) -----------------------------
    let mut q = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
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

    pagination::build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.clone().into_string())
    })
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
