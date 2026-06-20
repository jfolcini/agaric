//! Server-side filtered backlink queries with compound filters, sorting,
//! and cursor-based pagination.
//!
//! Provides a `BacklinkFilter` tree for composing boolean filter queries
//! on backlinks and evaluating them against the database.
//!
//! ## Evaluation strategy (H1: keyset + SQL COUNT)
//!
//! 1. **Counts** — `SELECT COUNT(*) FROM block_links bl JOIN blocks b …`
//!    yields `total_count` directly from SQL, without materialising the
//!    full base id set. When filters are present they resolve to a Rust
//!    `FxHashSet` whose size is `filtered_count`.
//! 2. **Page query (Created / default sort)** — single SQL with
//!    `(?N IS NULL OR b.id > ?N+1)` keyset clause, optional
//!    `b.id IN (SELECT value FROM json_each(?))` constraint when a
//!    filtered set is present, `ORDER BY b.id ASC/DESC LIMIT N+1`. The
//!    full `BlockRow` is projected directly — no separate fetch step.
//! 3. **Property sort** — falls back to "materialise filtered set, sort
//!    in Rust by property value, slice the page, batch-fetch rows" because
//!    property sorts can't be expressed as a keyset on `b.id` without
//!    encoding the value into the cursor. The full *unfiltered* base set
//!    is still never materialised; `total_count` comes from SQL COUNT
//!    and only `filtered_ids` is held in memory (small when filters are
//!    present; intrinsic for property sort).

use futures_util::future::try_join_all;
use rustc_hash::{FxHashMap, FxHashSet};
use sqlx::SqlitePool;

use super::SMALL_IN_LIMIT;
use super::filters::{CompiledFilter, FilterBind, compile_backlink_filter};
use super::sort::sort_ids;
use super::types::*;
use crate::error::AppError;
use crate::pagination::{BlockRow, Cursor, PageRequest};

// ---------------------------------------------------------------------------
// Public: eval_backlink_query (paginated + filtered)
// ---------------------------------------------------------------------------

/// Evaluate a filtered backlink query and return a paginated set of blocks.
///
/// Self-references are excluded from the base set (a block linking to
/// itself does not surface as its own backlink), matching the
/// convention used by `eval_unlinked_references` and
/// `eval_backlink_query_grouped`.
///
/// `space_id` — when `Some`, the base-set query restricts
/// source blocks to those whose owning page (`b.page_id`)
/// carries `space = ?space_id`. Applying the filter at the base-set
/// step means `total_count` and `filtered_count` reflect the
/// Post-space-filter universe. `None` is the unscoped (pre-)
/// behaviour.
///
/// ## Algorithm (H1)
///
/// 1. **`total_count`** — single `SELECT COUNT(*)` over `block_links` joined
///    against `blocks` with the base predicates (target match,
///    self-exclusion, deleted-at, space). The 50k base id set is never
///    materialised — we count rows in SQL.
/// 2. **Filters** — when supplied, resolve each branch to a Rust set via
///    `resolve_filter_with_candidates`. AND-intersected across top-level
///    filters. The resolved set is passed into the page query as a
///    `json_each` constraint; `filtered_count` comes from a second SQL
///    `COUNT(*)` so it correctly reflects the *intersection* with the
///    backlink base set (filters like `SourcePage` resolve to ids
///    outside the base set, so `filtered_ids.len()` would over-count).
/// 3. **Sort + page** — for `Created` sort we emit a single SQL with a
///    `(?N IS NULL OR b.id > ?N+1)` keyset clause and (when filtered) a
///    `b.id IN (SELECT value FROM json_each(?))` constraint, projecting
///    the full `BlockRow` columns directly. For property sorts we fall
///    back to the materialise-and-sort path on `filtered_ids` (intrinsic
///    to property sort).
pub async fn eval_backlink_query(
    pool: &SqlitePool,
    block_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<BacklinkQueryResponse, AppError> {
    // 1. `total_count` via SQL — never materialises the base id set.
    //    Mirrors the predicate shape (self-exclusion + deleted_at + space
    //    scope) that the pre-H1 implementation used to build base_ids.
    let total_count_i64: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ?1 AND bl.source_id != ?1 \
           AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR b.space_id = ?2)",
        block_id,
        space_id,
    )
    .fetch_one(pool)
    .await?;
    let total_count: usize = usize::try_from(total_count_i64).unwrap_or(0);

    if total_count == 0 {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
        });
    }

    // 2. Compile filters (if any) into a single correlated SQL WHERE
    //    fragment (#346 P1) instead of materialising each leaf to a Rust
    //    set and intersecting in memory. Top-level filters carry AND
    //    semantics, so each compiles independently and the fragments are
    //    AND-joined. The fragment is correlated on the outer source-block
    //    alias `b`; the hybrid leaves (`Contains`/`HasTag`/`HasTagPrefix`/
    //    `SourcePage`) pre-resolve their id sets ONCE and embed them as a
    //    `json_each` membership test. The base-set predicates (target
    //    match, self-exclusion, deleted_at, space) live in the surrounding
    //    queries; the fragment only adds the user filter.
    let compiled_filter: Option<CompiledFilter> = match filters.as_ref() {
        Some(filter_list) if !filter_list.is_empty() => {
            let compiled = try_join_all(
                filter_list
                    .iter()
                    .map(|f| compile_backlink_filter(pool, f, 0)),
            )
            .await?;
            let mut binds = Vec::new();
            let parts: Vec<String> = compiled
                .into_iter()
                .map(|c| {
                    binds.extend(c.binds);
                    c.sql
                })
                .collect();
            // Single fragment ⇒ use it directly; multiple ⇒ AND-join in a
            // parenthesised group so it nests safely under the base WHERE.
            let sql = if parts.len() == 1 {
                parts.into_iter().next().unwrap()
            } else {
                format!("({})", parts.join(" AND "))
            };
            Some(CompiledFilter { sql, binds })
        }
        _ => None,
    };

    // Resolve sort (default = Created Asc).
    let sort = sort.unwrap_or(BacklinkSort::Created { dir: SortDir::Asc });

    match sort {
        BacklinkSort::Created { dir } => {
            eval_created_sort_keyset(
                pool,
                block_id,
                space_id,
                page,
                dir,
                compiled_filter.as_ref(),
                total_count,
            )
            .await
        }
        BacklinkSort::PropertyText { .. }
        | BacklinkSort::PropertyNum { .. }
        | BacklinkSort::PropertyDate { .. } => {
            eval_property_sort_materialised(
                pool,
                block_id,
                space_id,
                page,
                &sort,
                compiled_filter.as_ref(),
                total_count,
            )
            .await
        }
    }
}

/// Created-sort path: single SQL with keyset on `b.id`, optional
/// `json_each` filter intersection, projects full BlockRow columns —
/// no separate fetch step.
async fn eval_created_sort_keyset(
    pool: &SqlitePool,
    block_id: &str,
    space_id: Option<&str>,
    page: &PageRequest,
    dir: SortDir,
    filter: Option<&CompiledFilter>,
    total_count: usize,
) -> Result<BacklinkQueryResponse, AppError> {
    // `filtered_count` = base predicates ∩ filter fragment. The fragment is
    // correlated on `b`, so SQLite intersects with the backlink base set
    // server-side — `SourcePage`-style "all blocks not under page X" leaves
    // can never over-count the way a naive Rust `set.len()` would.
    //
    // QueryBuilder is used so the fragment's positional binds interleave
    // after the base-query binds in declaration order. An empty filter
    // fragment compiles to `1=0`, which yields `filtered_count == 0` and the
    // empty-response short-circuit below — no separate empty-set check
    // needed.
    let filtered_count = match filter {
        None => total_count,
        Some(cf) => {
            // Raw-string compose: the fragment's bare `?` placeholders are
            // spliced inline, and binds are applied left-to-right so the
            // base-query binds and the fragment binds interleave correctly.
            // (sqlx binds positional `?` in `.bind()` call order.)
            let sql = format!(
                "SELECT COUNT(*) FROM block_links bl \
                 JOIN blocks b ON b.id = bl.source_id \
                 WHERE bl.target_id = ? AND bl.source_id != ? \
                   AND b.deleted_at IS NULL \
                   AND (? IS NULL OR b.space_id = ?) \
                   AND ({frag})",
                frag = cf.sql,
            );
            let mut q = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
                .bind(block_id)
                .bind(block_id)
                .bind(space_id)
                .bind(space_id);
            for b in &cf.binds {
                q = match b {
                    FilterBind::Text(s) => q.bind(s.clone()),
                    FilterBind::Num(n) => q.bind(*n),
                };
            }
            let count_i64: i64 = q.fetch_one(pool).await?;
            usize::try_from(count_i64).unwrap_or(0)
        }
    };

    if filtered_count == 0 {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count: 0,
        });
    }

    // ----- Compose page SQL -------------------------------------------------
    //
    // Raw-string compose with bare `?` placeholders bound left-to-right so
    // the optional filter fragment's binds interleave after the base/cursor
    // binds. Cursor direction is encoded in the comparison operator at
    // compose time: Asc → `b.id > ?`, Desc → `b.id < ?`.
    let cursor_cmp = match dir {
        SortDir::Asc => ">",
        SortDir::Desc => "<",
    };
    let order_dir = match dir {
        SortDir::Asc => "ASC",
        SortDir::Desc => "DESC",
    };
    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.as_str()),
        None => (None, ""),
    };
    let fetch_limit: i64 = page.limit.saturating_add(1);

    // The filter fragment (if any) is spliced before ORDER BY; its binds are
    // appended to the chain in declaration order.
    let filter_clause = match filter {
        Some(cf) => format!(" AND ({})", cf.sql),
        None => String::new(),
    };
    let sql = format!(
        "SELECT {cols} \
         FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ? AND bl.source_id != ? \
           AND b.deleted_at IS NULL \
           AND (? IS NULL OR b.space_id = ?) \
           AND (? IS NULL OR b.id {cursor_cmp} ?) \
           {filter_clause} \
         ORDER BY b.id {order_dir} LIMIT ?",
        cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT,
    );

    let mut q = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql))
        .bind(block_id) // bl.target_id
        .bind(block_id) // bl.source_id !=
        .bind(space_id) // ? IS NULL
        .bind(space_id) // value_ref
        .bind(cursor_flag) // ? IS NULL
        .bind(cursor_id); // b.id <cmp> ?
    if let Some(cf) = filter {
        for b in &cf.binds {
            q = match b {
                FilterBind::Text(s) => q.bind(s.clone()),
                FilterBind::Num(n) => q.bind(*n),
            };
        }
    }
    let rows: Vec<BlockRow> = q.bind(fetch_limit).fetch_all(pool).await?;

    // Slice to honour `limit`; detect `has_more` from the +1 row.
    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit_usize;
    let mut rows = rows;
    if has_more {
        rows.truncate(limit_usize);
    }

    let next_cursor = if has_more {
        let last = rows.last().expect("has_more implies non-empty");
        Some(Cursor::for_id(last.id.as_str().to_string()).encode()?)
    } else {
        None
    };

    // The SQL filters `deleted_at IS NULL`, so the rows
    // are active by construction. Boundary cast records that claim.
    let items: Vec<crate::pagination::ActiveBlockRow> = rows
        .into_iter()
        .map(crate::pagination::ActiveBlockRow::from_block_row_unchecked)
        .collect();

    Ok(BacklinkQueryResponse {
        items,
        next_cursor,
        has_more,
        total_count,
        filtered_count,
    })
}

/// Property-sort fallback: materialise the *filtered* (not base) id set
/// via SQL, sort by property value in Rust, paginate the sorted slice,
/// then batch-fetch BlockRows for the page.
///
/// The base id set is never materialised — `total_count` already comes
/// from SQL `COUNT(*)`. When filters are present we intersect against
/// the resolved filter set so only the post-filter ids are loaded.
async fn eval_property_sort_materialised(
    pool: &SqlitePool,
    block_id: &str,
    space_id: Option<&str>,
    page: &PageRequest,
    sort: &BacklinkSort,
    filter: Option<&CompiledFilter>,
    total_count: usize,
) -> Result<BacklinkQueryResponse, AppError> {
    // Resolve the post-filter id set in SQL (instead of in Rust): the
    // correlated filter fragment is spliced into a single
    // `SELECT bl.source_id … WHERE <base> AND (<fragment>)`. Property sort
    // still needs the full filtered id set in memory (values must be visited
    // to know the page boundary), but the *base set* is never materialised
    // and the negative/broad complement never leaves SQLite. An empty
    // fragment compiles to `1=0`, so `filtered_ids` is empty and the
    // short-circuit below fires.
    let filter_clause = match filter {
        Some(cf) => format!(" AND ({})", cf.sql),
        None => String::new(),
    };
    let sql = format!(
        "SELECT bl.source_id FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ? AND bl.source_id != ? \
           AND b.deleted_at IS NULL \
           AND (? IS NULL OR b.space_id = ?) \
           {filter_clause}"
    );
    let mut q = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql))
        .bind(block_id)
        .bind(block_id)
        .bind(space_id)
        .bind(space_id);
    if let Some(cf) = filter {
        for b in &cf.binds {
            q = match b {
                FilterBind::Text(s) => q.bind(s.clone()),
                FilterBind::Num(n) => q.bind(*n),
            };
        }
    }
    let filtered_ids: FxHashSet<String> = q.fetch_all(pool).await?.into_iter().collect();

    let filtered_count = filtered_ids.len();
    if filtered_count == 0 {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count: 0,
        });
    }

    // Sort by property value (Rust-side fetch + comparator).
    let sorted_ids = sort_ids(pool, &filtered_ids, sort).await?;

    // Cursor pagination: property sorts have no ULID-monotonic ordering,
    // so we fall back to an O(n) position scan, mirroring the pre-H1
    // path. Property pages are bounded by the filtered set size, which
    // in practice is small (filters present) or capped by the user's
    // sort key cardinality.
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    let start_idx = if let Some(after_id) = start_after {
        sorted_ids
            .iter()
            .position(|s| s.as_str() == after_id)
            .map(|i| i + 1)
            .unwrap_or(sorted_ids.len())
    } else {
        0
    };

    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    let fetch_limit = limit_usize.saturating_add(1);
    let page_ids: Vec<&str> = sorted_ids[start_idx..]
        .iter()
        .map(String::as_str)
        .take(fetch_limit)
        .collect();
    let has_more = page_ids.len() > limit_usize;
    let actual_ids: Vec<&str> = if has_more {
        page_ids[..limit_usize].to_vec()
    } else {
        page_ids
    };

    if actual_ids.is_empty() {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count,
        });
    }

    let fetched: Vec<BlockRow> = fetch_block_rows_by_ids(pool, &actual_ids).await?;
    let id_order: FxHashMap<&str, usize> = actual_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();
    let mut sorted_fetched = fetched;
    sorted_fetched.sort_by_key(|row| id_order.get(row.id.as_str()).copied().unwrap_or(usize::MAX));
    let items: Vec<crate::pagination::ActiveBlockRow> = sorted_fetched
        .into_iter()
        .map(crate::pagination::ActiveBlockRow::from_block_row_unchecked)
        .collect();

    let next_cursor = if has_more {
        let last = items.last().expect("has_more implies non-empty");
        Some(Cursor::for_id(last.id.as_str().to_string()).encode()?)
    } else {
        None
    };

    Ok(BacklinkQueryResponse {
        items,
        next_cursor,
        has_more,
        total_count,
        filtered_count,
    })
}

// ---------------------------------------------------------------------------
// resolve_root_pages (shared helper for grouped queries)
// ---------------------------------------------------------------------------

/// Resolve each block's root page using the denormalized `page_id` column.
///
/// Returns FxHashMap<block_id, (root_page_id, root_page_title)>.
/// Blocks whose `page_id` is NULL (orphans / tags) are omitted.
///
/// FxHashMap is used for return / construction so the
/// post-resolve `.get(&id)` lookups in the grouping pass run on the
/// faster Fx hash. Callers were already on Fx-flavoured sets, so this
/// keeps the family aligned.
///
/// C9 (#345) — invariant: the `JOIN blocks p ON p.id = b.page_id` is
/// deliberately *unguarded* (no `p.block_type = 'page'`, no
/// `p.deleted_at IS NULL`). It relies on the data invariant that a
/// block's `page_id` always points at a live `page` row:
///
/// * migration 0073's `page_id_self_for_pages` CHECK keeps every page
///   row's own `page_id` consistent, and
/// * the soft-delete path cascades to descendants, so a block's owning
///   page is alive whenever the block is.
///
/// The `#[cfg(test)]` CTE oracle adds those guards explicitly; the two
/// resolutions can therefore diverge ONLY on corrupted data (a `page_id`
/// pointing at a deleted or non-page row), which the normal write paths
/// never produce. No runtime guard is added here so the hot grouping
/// path keeps the single denormalised-column join.
///
/// ## SMALL_IN_LIMIT dual-branch
///
/// When `block_ids.len() <= SMALL_IN_LIMIT` (500), positional `IN (?,…)`
/// placeholders are used. Above that threshold a single
/// `IN (SELECT value FROM json_each(?))` bind is used instead to stay
/// below SQLite's `SQLITE_MAX_VARIABLE_NUMBER` ceiling (32766 in newer
/// builds, 999 in older ones). Both branches produce identical row sets.
pub(super) async fn resolve_root_pages(
    pool: &SqlitePool,
    block_ids: &FxHashSet<String>,
) -> Result<FxHashMap<String, (String, Option<String>)>, AppError> {
    if block_ids.is_empty() {
        return Ok(FxHashMap::default());
    }

    #[derive(sqlx::FromRow)]
    struct RootPageRow {
        block_id: crate::ulid::BlockId,
        root_id: crate::ulid::BlockId,
        root_title: Option<String>,
    }

    let rows: Vec<RootPageRow> = if block_ids.len() <= SMALL_IN_LIMIT {
        let placeholders = block_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT b.id as block_id, b.page_id as root_id, p.content as root_title \
             FROM blocks b \
             JOIN blocks p ON p.id = b.page_id \
             WHERE b.id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, RootPageRow>(sqlx::AssertSqlSafe(sql.as_str()));
        for id in block_ids {
            query = query.bind(id.as_str());
        }
        query.fetch_all(pool).await?
    } else {
        let ids_json = serde_json::to_string(&block_ids.iter().collect::<Vec<_>>())?;
        sqlx::query_as::<_, RootPageRow>(
            "SELECT b.id as block_id, b.page_id as root_id, p.content as root_title \
             FROM blocks b \
             JOIN blocks p ON p.id = b.page_id \
             WHERE b.id IN (SELECT value FROM json_each(?))",
        )
        .bind(&ids_json)
        .fetch_all(pool)
        .await?
    };

    let mut map: FxHashMap<String, (String, Option<String>)> = FxHashMap::default();
    for row in rows {
        map.insert(
            row.block_id.into_string(),
            (row.root_id.into_string(), row.root_title),
        );
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// fetch_block_rows_by_ids (shared batch fetch helper)
// ---------------------------------------------------------------------------

/// Batch-fetch full `BlockRow`s for a list of block IDs.
///
/// Uses a positional `IN (?,?,…)` clause when `ids.len() <= SMALL_IN_LIMIT`,
/// and falls back to `IN (SELECT value FROM json_each(?))` for larger sets to
/// avoid SQLite's variable-binding ceiling. Both branches return identical
/// row sets — the row order is unspecified, so callers must reorder
/// Themselves if a specific order is required.
pub(super) async fn fetch_block_rows_by_ids(
    pool: &SqlitePool,
    ids: &[&str],
) -> Result<Vec<BlockRow>, AppError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    if ids.len() <= SMALL_IN_LIMIT {
        let placeholders: String = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT {} FROM blocks WHERE id IN ({placeholders})",
            crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT,
        );
        let mut query = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()));
        for id in ids {
            query = query.bind(*id);
        }
        Ok(query.fetch_all(pool).await?)
    } else {
        let json_ids = serde_json::to_string(&ids)?;
        let sql = format!(
            "SELECT {} FROM blocks WHERE id IN (SELECT value FROM json_each(?))",
            crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT,
        );
        let rows = sqlx::query_as::<_, BlockRow>(sqlx::AssertSqlSafe(sql.as_str()))
            .bind(&json_ids)
            .fetch_all(pool)
            .await?;
        Ok(rows)
    }
}

// ---------------------------------------------------------------------------
// resolve_root_pages_cte (recursive CTE oracle — test only)
// ---------------------------------------------------------------------------

/// Original recursive CTE implementation of `resolve_root_pages`, preserved
/// as a test oracle per AGENTS.md "Performance Conventions".
#[cfg(test)]
pub(super) async fn resolve_root_pages_cte(
    pool: &SqlitePool,
    block_ids: &FxHashSet<String>,
) -> Result<FxHashMap<String, (String, Option<String>)>, AppError> {
    if block_ids.is_empty() {
        return Ok(FxHashMap::default());
    }

    let placeholders = block_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    // Bound `depth < 100` on the recursive member to prevent runaway recursion
    // On corrupted parent_id chains (AGENTS.md invariant #9).
    let sql = format!(
        "WITH RECURSIVE walk(block_id, current_id, depth) AS ( \
            SELECT id, id, 0 FROM blocks WHERE id IN ({placeholders}) \
            UNION ALL \
            SELECT w.block_id, b.parent_id, w.depth + 1 \
            FROM walk w \
            JOIN blocks b ON b.id = w.current_id \
            WHERE b.parent_id IS NOT NULL AND w.depth < 100 \
        ) \
        SELECT w.block_id, w.current_id as root_id, b.content as root_title \
        FROM walk w \
        JOIN blocks b ON b.id = w.current_id \
        WHERE b.parent_id IS NULL AND b.block_type = 'page'"
    );

    #[derive(sqlx::FromRow)]
    struct RootPageRow {
        block_id: crate::ulid::BlockId,
        root_id: crate::ulid::BlockId,
        root_title: Option<String>,
    }

    let mut query = sqlx::query_as::<_, RootPageRow>(sqlx::AssertSqlSafe(sql.as_str()));
    for id in block_ids {
        query = query.bind(id.as_str());
    }
    let rows = query.fetch_all(pool).await?;

    let mut map: FxHashMap<String, (String, Option<String>)> = FxHashMap::default();
    for row in rows {
        map.insert(
            row.block_id.into_string(),
            (row.root_id.into_string(), row.root_title),
        );
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Public: list_property_keys
// ---------------------------------------------------------------------------

/// List all distinct property keys currently in use across all blocks.
///
/// The cap (`PROPERTY_KEY_CAP`) is practical insurance against a runaway
/// schema: real workloads carry on the order of tens of distinct property
/// keys, and 1000 is well beyond any realistic UI render budget (key
/// pickers, filter dropdowns). Callers that need the full universe (admin /
/// migration paths) should query `block_properties` directly.
///
/// #347 (R5): the cap used to be silent. We now over-fetch by one row and
/// `warn!` when the result is actually truncated, so a vault that somehow
/// exceeds the cap surfaces in logs instead of silently dropping keys.
const PROPERTY_KEY_CAP: usize = 1000;

pub async fn list_property_keys(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    // #1424: order the `::` property-key picker by usage frequency
    // (most-used first) so the highest-signal keys surface at the top,
    // mirroring how the tag picker ranks by usage. `key ASC` is a stable
    // tiebreaker so equal-count keys have a deterministic order.
    let mut rows = sqlx::query_scalar!(
        "SELECT key FROM block_properties \
         GROUP BY key ORDER BY COUNT(*) DESC, key ASC LIMIT 1001",
    )
    .fetch_all(pool)
    .await?;
    if rows.len() > PROPERTY_KEY_CAP {
        tracing::warn!(
            target: "agaric::list_property_keys",
            cap = PROPERTY_KEY_CAP,
            "distinct property keys exceed the typeahead cap; result truncated"
        );
        rows.truncate(PROPERTY_KEY_CAP);
    }
    Ok(rows)
}

/// List the distinct text values currently in use for a single property
/// `key`, usage-ranked (most-used first) with `value ASC` as a stable
/// tiebreaker.
///
/// #1425: powers the property-VALUE autocomplete — the value side of a
/// `prop:key=value` editor — mirroring the usage-ranked ordering shipped
/// for keys in #1424. Only the text channel (`value_text`) is surfaced:
/// numeric / date / ref / bool channels are typed and don't benefit from
/// a free-text typeahead, and `value_text` is also the channel that
/// `select`-type definitions store their option values in.
///
/// The same `PROPERTY_KEY_CAP` insurance applies: a single key carrying
/// more than the cap distinct values is well beyond any realistic
/// typeahead render budget. We over-fetch by one row and `warn!` when
/// the result is actually truncated so a runaway cardinality surfaces in
/// logs rather than silently dropping values.
pub async fn list_property_values(pool: &SqlitePool, key: &str) -> Result<Vec<String>, AppError> {
    // Distinct non-NULL `value_text` for the given key, ranked by usage
    // (most-used first) with `value_text ASC` as a deterministic
    // tiebreaker for equal-count values. `value_text IS NOT NULL` filters
    // out rows whose value lives in a non-text channel.
    let mut rows = sqlx::query_scalar!(
        "SELECT value_text FROM block_properties \
         WHERE key = ?1 AND value_text IS NOT NULL \
         GROUP BY value_text ORDER BY COUNT(*) DESC, value_text ASC LIMIT 1001",
        key,
    )
    .fetch_all(pool)
    .await?;
    // `value_text` is nullable in the schema, so the scalar comes back as
    // `Option<String>`; the `IS NOT NULL` filter guarantees `Some`, but
    // flatten defensively rather than unwrap.
    let mut values: Vec<String> = rows.drain(..).flatten().collect();
    if values.len() > PROPERTY_KEY_CAP {
        tracing::warn!(
            target: "agaric::list_property_values",
            cap = PROPERTY_KEY_CAP,
            key = %key,
            "distinct property values for key exceed the typeahead cap; result truncated"
        );
        values.truncate(PROPERTY_KEY_CAP);
    }
    Ok(values)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Localized regression tests that need not depend on the broader
    //! `super::tests` fixture surface. Specifically guards the fix
    //! that excludes self-referencing links from `eval_backlink_query`'s
    //! base set, aligning the path with `eval_unlinked_references` /
    //! `eval_backlink_query_grouped`.
    use super::*;
    use crate::db::init_pool;
    use crate::pagination::PageRequest;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        let page_id: Option<&str> = if block_type == "page" { Some(id) } else { None };
        sqlx::query("INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .bind(page_id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_block_link(pool: &SqlitePool, source_id: &str, target_id: &str) {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(source_id)
            .bind(target_id)
            .execute(pool)
            .await
            .unwrap();
    }

    fn default_page() -> PageRequest {
        PageRequest::new(None, Some(50)).unwrap()
    }

    /// A block linking to itself must NOT appear as its own
    /// backlink and must NOT inflate `total_count`.
    #[tokio::test]
    async fn eval_backlink_query_excludes_self_references() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK", "page", "Self-linking block").await;
        // Direct insert of a self-link row — keeps the test self-contained
        // (no materializer dispatch) so it precisely exercises the SQL
        // base-set query.
        insert_block_link(&pool, "BLK", "BLK").await;

        let resp = eval_backlink_query(&pool, "BLK", None, None, &default_page(), None)
            .await
            .unwrap();

        assert_eq!(
            resp.total_count, 0,
            "self-link must not inflate total_count"
        );
        assert_eq!(
            resp.filtered_count, 0,
            "self-link must not appear in filtered set"
        );
        assert!(
            resp.items.is_empty(),
            "self-link must not surface as a backlink item"
        );
        assert!(!resp.has_more);
        assert!(resp.next_cursor.is_none());
    }

    /// Negative-side guard: ensure the new self-reference filter
    /// does not accidentally drop legitimate backlinks from OTHER
    /// blocks. With BLK_A → BLK_B and BLK_B → BLK_B (self), only BLK_A
    /// should surface in the response.
    #[tokio::test]
    async fn eval_backlink_query_returns_backlinks_from_other_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK_A", "content", "Source A").await;
        insert_block(&pool, "BLK_B", "page", "Target B").await;
        insert_block_link(&pool, "BLK_A", "BLK_B").await;
        insert_block_link(&pool, "BLK_B", "BLK_B").await;

        let resp = eval_backlink_query(&pool, "BLK_B", None, None, &default_page(), None)
            .await
            .unwrap();

        assert_eq!(
            resp.total_count, 1,
            "only BLK_A counts; BLK_B self-link excluded"
        );
        assert_eq!(resp.filtered_count, 1);
        assert_eq!(resp.items.len(), 1);
        assert_eq!(
            resp.items[0].id, "BLK_A",
            "the surviving backlink must be BLK_A"
        );
    }
    async fn insert_property(pool: &SqlitePool, block_id: &str, key: &str) {
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind(key)
            .bind("v")
            .execute(pool)
            .await
            .unwrap();
    }

    /// #1424: the `::` property-key picker must surface the most-used key
    /// first and fall back to `key ASC` as a stable tiebreaker for keys
    /// with equal usage counts.
    #[tokio::test]
    async fn list_property_keys_orders_by_usage_then_key() {
        let (pool, _dir) = test_pool().await;
        // Three blocks so we can vary usage counts. PK is (block_id, key),
        // so a key's usage count == number of distinct blocks carrying it.
        insert_block(&pool, "B1", "content", "one").await;
        insert_block(&pool, "B2", "content", "two").await;
        insert_block(&pool, "B3", "content", "three").await;

        // `status` used 3x (most), `zeta` and `alpha` used 1x each (tie).
        insert_property(&pool, "B1", "status").await;
        insert_property(&pool, "B2", "status").await;
        insert_property(&pool, "B3", "status").await;
        insert_property(&pool, "B1", "zeta").await;
        insert_property(&pool, "B2", "alpha").await;

        let keys = list_property_keys(&pool).await.unwrap();

        // Most-used first; ties broken by key ASC (alpha before zeta).
        assert_eq!(
            keys,
            vec![
                "status".to_string(),
                "alpha".to_string(),
                "zeta".to_string()
            ],
            "keys must order by usage DESC, then key ASC"
        );
    }

    /// #1424: empty vault yields no property keys.
    #[tokio::test]
    async fn list_property_keys_empty() {
        let (pool, _dir) = test_pool().await;
        let keys = list_property_keys(&pool).await.unwrap();
        assert!(keys.is_empty(), "no properties means no keys");
    }

    async fn insert_property_value(pool: &SqlitePool, block_id: &str, key: &str, value: &str) {
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind(key)
            .bind(value)
            .execute(pool)
            .await
            .unwrap();
    }

    /// #1425: the property-VALUE picker must surface the most-used value
    /// first and fall back to `value ASC` as a stable tiebreaker for
    /// values with equal usage counts, scoped to the requested key.
    #[tokio::test]
    async fn list_property_values_orders_by_usage_then_value() {
        let (pool, _dir) = test_pool().await;
        for id in ["B1", "B2", "B3", "B4"] {
            insert_block(&pool, id, "content", id).await;
        }
        // For key `status`: "done" used 3x (most), "todo"/"blocked" 1x
        // each (tie → value ASC: blocked before todo).
        insert_property_value(&pool, "B1", "status", "done").await;
        insert_property_value(&pool, "B2", "status", "done").await;
        insert_property_value(&pool, "B3", "status", "done").await;
        insert_property_value(&pool, "B4", "status", "todo").await;
        // `blocked` lives on a block that also carries `status=done`? No —
        // PK is (block_id, key), so put it on a distinct key-free block.
        insert_block(&pool, "B5", "content", "B5").await;
        insert_property_value(&pool, "B5", "status", "blocked").await;

        let values = list_property_values(&pool, "status").await.unwrap();
        assert_eq!(
            values,
            vec![
                "done".to_string(),
                "blocked".to_string(),
                "todo".to_string()
            ],
            "values must order by usage DESC, then value ASC"
        );
    }

    /// #1425: values are scoped to the requested key — a different key's
    /// values must not leak in.
    #[tokio::test]
    async fn list_property_values_scoped_to_key() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "B1", "content", "one").await;
        insert_block(&pool, "B2", "content", "two").await;
        // Same block can't carry two values for the same key (PK), so use
        // two distinct keys on two blocks.
        insert_property_value(&pool, "B1", "status", "done").await;
        insert_property_value(&pool, "B2", "category", "work").await;

        let status_values = list_property_values(&pool, "status").await.unwrap();
        assert_eq!(
            status_values,
            vec!["done".to_string()],
            "only `status` values returned, not `category`"
        );
        let category_values = list_property_values(&pool, "category").await.unwrap();
        assert_eq!(category_values, vec!["work".to_string()]);
    }

    /// #1425: a key with no recorded values (or an unknown key) yields an
    /// empty list rather than an error.
    #[tokio::test]
    async fn list_property_values_empty() {
        let (pool, _dir) = test_pool().await;
        let values = list_property_values(&pool, "nonexistent").await.unwrap();
        assert!(values.is_empty(), "unknown key means no values");
    }
}
