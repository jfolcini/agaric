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

use super::filters::resolve_filter_with_candidates;
use super::sort::sort_ids;
use super::types::*;
use super::SMALL_IN_LIMIT;
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
/// `eval_backlink_query_grouped`. (L-95)
///
/// `space_id` (FEAT-3p4) — when `Some`, the base-set query restricts
/// source blocks to those whose owning page (`b.page_id`)
/// carries `space = ?space_id`. Applying the filter at the base-set
/// step means `total_count` and `filtered_count` reflect the
/// post-space-filter universe. `None` is the unscoped (pre-FEAT-3)
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
    let total_count_i64: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ?1 AND bl.source_id != ?1 \
           AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR b.page_id IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?2))",
    )
    .bind(block_id)
    .bind(space_id)
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

    // 2. Resolve filters (if any). The candidate-aware leaves do not
    //    receive a base candidate set — feeding them one would require
    //    materialising the full base set, which is exactly what H1
    //    eliminates. Leaf SQL still filters `deleted_at IS NULL`; the
    //    base-set predicates (target match, self-exclusion, space) are
    //    re-applied at the page query below so the final intersection is
    //    correct.
    let filtered_ids_opt: Option<FxHashSet<String>> = match filters.as_ref() {
        Some(filter_list) if !filter_list.is_empty() => {
            let futures = filter_list
                .iter()
                .map(|f| resolve_filter_with_candidates(pool, f, 0, None));
            let results = try_join_all(futures).await?;
            let mut iter = results.into_iter();
            let mut acc = iter.next().unwrap_or_default();
            for set in iter {
                acc.retain(|id| set.contains(id));
            }
            Some(acc)
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
                filtered_ids_opt.as_ref(),
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
                filtered_ids_opt,
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
    filtered_ids: Option<&FxHashSet<String>>,
    total_count: usize,
) -> Result<BacklinkQueryResponse, AppError> {
    // When filters resolved to an empty set, short-circuit.
    if let Some(set) = filtered_ids {
        if set.is_empty() {
            return Ok(BacklinkQueryResponse {
                items: vec![],
                next_cursor: None,
                has_more: false,
                total_count,
                filtered_count: 0,
            });
        }
    }

    // `filtered_count` = base predicates ∩ filter set. The pre-H1
    // implementation intersected the resolved filter set with the
    // backlink base set before measuring. Filters like
    // `SourcePage` resolve to "all blocks not under page X" — millions
    // of ids that are NOT backlinks to the target. Using
    // `filtered_ids.len()` would over-count badly. Run the count in SQL
    // so the intersection happens server-side.
    let filtered_count = match filtered_ids {
        None => total_count,
        Some(set) => {
            let json = serde_json::to_string(&set.iter().collect::<Vec<_>>())?;
            let count_i64: i64 = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM block_links bl \
                 JOIN blocks b ON b.id = bl.source_id \
                 WHERE bl.target_id = ?1 AND bl.source_id != ?1 \
                   AND b.deleted_at IS NULL \
                   AND (?2 IS NULL OR b.page_id IN ( \
                        SELECT bp.block_id FROM block_properties bp \
                        WHERE bp.key = 'space' AND bp.value_ref = ?2)) \
                   AND b.id IN (SELECT value FROM json_each(?3))",
            )
            .bind(block_id)
            .bind(space_id)
            .bind(&json)
            .fetch_one(pool)
            .await?;
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
    // Reserved bind slots:
    //   ?1  block_id (target_id + self-exclusion sentinel)
    //   ?2  space_id (Option<&str>; NULL ⇒ unscoped)
    //   ?3  cursor_flag (Option<i64>; NULL ⇒ no cursor)
    //   ?4  cursor_id (String; only consulted when ?3 IS NOT NULL)
    //   ?5  fetch_limit (i64; page.limit + 1)
    //   ?6  filter_json (Option<String>; NULL ⇒ no filter set bound)
    //
    // Cursor direction encoded in the comparison operator at compose time:
    //   Asc  → `b.id > ?4`
    //   Desc → `b.id < ?4`
    let cursor_cmp = match dir {
        SortDir::Asc => ">",
        SortDir::Desc => "<",
    };
    let order_dir = match dir {
        SortDir::Asc => "ASC",
        SortDir::Desc => "DESC",
    };
    let sql = format!(
        "SELECT {cols} \
         FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ?1 AND bl.source_id != ?1 \
           AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR b.page_id IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?2)) \
           AND (?3 IS NULL OR b.id {cursor_cmp} ?4) \
           AND (?6 IS NULL OR b.id IN (SELECT value FROM json_each(?6))) \
         ORDER BY b.id {order_dir} LIMIT ?5",
        cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT,
        cursor_cmp = cursor_cmp,
        order_dir = order_dir,
    );

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.as_str()),
        None => (None, ""),
    };
    let fetch_limit: i64 = page.limit.saturating_add(1);
    let filter_json: Option<String> = match filtered_ids {
        Some(set) => Some(serde_json::to_string(&set.iter().collect::<Vec<_>>())?),
        None => None,
    };

    let rows: Vec<BlockRow> = sqlx::query_as::<_, BlockRow>(&sql)
        .bind(block_id) // ?1
        .bind(space_id) // ?2
        .bind(cursor_flag) // ?3
        .bind(cursor_id) // ?4
        .bind(fetch_limit) // ?5
        .bind(filter_json.as_deref()) // ?6
        .fetch_all(pool)
        .await?;

    // Slice to honour `limit`; detect `has_more` from the +1 row.
    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit_usize;
    let mut rows = rows;
    if has_more {
        rows.truncate(limit_usize);
    }

    let next_cursor = if has_more {
        let last = rows.last().expect("has_more implies non-empty");
        Some(Cursor::for_id(last.id.clone()).encode()?)
    } else {
        None
    };

    // MAINT-113 M2 — the SQL filters `deleted_at IS NULL`, so the rows
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
    filtered_ids_in: Option<FxHashSet<String>>,
    total_count: usize,
) -> Result<BacklinkQueryResponse, AppError> {
    // Build the post-filter id set. When filters were supplied we just
    // intersect with the SQL-resolved backlink set; otherwise we resolve
    // the full backlink set (intrinsic for property sort — values must
    // be visited to know the page boundary).
    let filter_json: Option<String> = match filtered_ids_in.as_ref() {
        Some(set) if set.is_empty() => {
            return Ok(BacklinkQueryResponse {
                items: vec![],
                next_cursor: None,
                has_more: false,
                total_count,
                filtered_count: 0,
            });
        }
        Some(set) => Some(serde_json::to_string(&set.iter().collect::<Vec<_>>())?),
        None => None,
    };

    let filtered_ids: FxHashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT bl.source_id FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ?1 AND bl.source_id != ?1 \
           AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR b.page_id IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?2)) \
           AND (?3 IS NULL OR b.id IN (SELECT value FROM json_each(?3)))",
    )
    .bind(block_id)
    .bind(space_id)
    .bind(filter_json.as_deref())
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

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
/// L-5 (PEND-25): FxHashMap is used for return / construction so the
/// post-resolve `.get(&id)` lookups in the grouping pass run on the
/// faster Fx hash. Callers were already on Fx-flavoured sets, so this
/// keeps the family aligned.
pub(super) async fn resolve_root_pages(
    pool: &SqlitePool,
    block_ids: &FxHashSet<String>,
) -> Result<FxHashMap<String, (String, Option<String>)>, AppError> {
    if block_ids.is_empty() {
        return Ok(FxHashMap::default());
    }

    let placeholders = block_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT b.id as block_id, b.page_id as root_id, p.content as root_title \
         FROM blocks b \
         JOIN blocks p ON p.id = b.page_id \
         WHERE b.id IN ({placeholders})"
    );

    #[derive(sqlx::FromRow)]
    struct RootPageRow {
        block_id: String,
        root_id: String,
        root_title: Option<String>,
    }

    let mut query = sqlx::query_as::<_, RootPageRow>(&sql);
    for id in block_ids {
        query = query.bind(id.as_str());
    }
    let rows = query.fetch_all(pool).await?;

    let mut map: FxHashMap<String, (String, Option<String>)> = FxHashMap::default();
    for row in rows {
        map.insert(row.block_id, (row.root_id, row.root_title));
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
/// themselves if a specific order is required. (L-82, L-83)
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
        let mut query = sqlx::query_as::<_, BlockRow>(&sql);
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
        let rows = sqlx::query_as::<_, BlockRow>(&sql)
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
    // on corrupted parent_id chains (AGENTS.md invariant #9). (M-60)
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
        block_id: String,
        root_id: String,
        root_title: Option<String>,
    }

    let mut query = sqlx::query_as::<_, RootPageRow>(&sql);
    for id in block_ids {
        query = query.bind(id.as_str());
    }
    let rows = query.fetch_all(pool).await?;

    let mut map: FxHashMap<String, (String, Option<String>)> = FxHashMap::default();
    for row in rows {
        map.insert(row.block_id, (row.root_id, row.root_title));
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Public: list_property_keys
// ---------------------------------------------------------------------------

/// List all distinct property keys currently in use across all blocks.
///
/// The `LIMIT 1000` cap is practical insurance against a runaway schema:
/// real workloads carry on the order of tens of distinct property keys,
/// and 1000 is well beyond any realistic UI render budget (key pickers,
/// filter dropdowns). Callers that need the full universe (admin /
/// migration paths) should query `block_properties` directly.
pub async fn list_property_keys(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT key FROM block_properties ORDER BY key LIMIT 1000",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Localized regression tests that need not depend on the broader
    //! `super::tests` fixture surface. Specifically guards the L-95 fix
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

    /// L-95: a block linking to itself must NOT appear as its own
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

    /// L-95 negative-side guard: ensure the new self-reference filter
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
}
