//! Server-side filtered backlink queries with compound filters, sorting,
//! and cursor-based pagination.
//!
//! Provides a `BacklinkFilter` tree for composing boolean filter queries
//! on backlinks and evaluating them against the database.
//!
//! ## Evaluation strategy
//!
//! 1. **Base set** — collect all `source_id`s from `block_links` where
//!    `target_id = ?` and the source block is not deleted/conflict.
//! 2. **Filter** — each `BacklinkFilter` resolves to a `FxHashSet<String>`
//!    of block_ids; filters are AND-ed together and intersected with the
//!    base set.
//! 3. **Sort** — sort the filtered set (Created = ULID order; property
//!    sorts fetch values and sort by them).
//! 4. **Paginate** — keyset cursor pagination on the sorted list.
//! 5. **Fetch** — load full `BlockRow` data for the page.

use futures_util::future::try_join_all;
use rustc_hash::FxHashSet;
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
/// ## Algorithm
///
/// 1. Get base backlink set (source_ids linking to `block_id`,
///    excluding self-references).
/// 2. If filters provided, resolve each to a set, AND them all together,
///    then intersect with the base set.
/// 3. Sort the result set.
/// 4. Apply keyset cursor pagination.
/// 5. Fetch full `BlockRow` data for the page.
/// 6. Return `BacklinkQueryResponse` with `total_count`.
pub async fn eval_backlink_query(
    pool: &SqlitePool,
    block_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    page: &PageRequest,
) -> Result<BacklinkQueryResponse, AppError> {
    // 1. Get base backlink set
    //    `bl.source_id != ?1` excludes self-references so a block linking
    //    to itself does not inflate `total_count` or surface as its own
    //    backlink. The `?1` parameter is reused (no extra bind needed).
    //    Mirrors `eval_unlinked_references` / `eval_backlink_query_grouped`.
    //    (L-95)
    let base_ids: FxHashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT bl.source_id FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ?1 AND bl.source_id != ?1 \
           AND b.deleted_at IS NULL AND b.is_conflict = 0",
    )
    .bind(block_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let total_count = base_ids.len();

    if base_ids.is_empty() {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
        });
    }

    // 2. Apply filters (AND semantics at top level)
    let filtered_ids = if let Some(ref filter_list) = filters {
        if filter_list.is_empty() {
            base_ids
        } else {
            // Resolve all top-level filters concurrently (#319).
            // Pass `base_ids` as candidates (I-Search-9) so leaf arms
            // that support a candidate-scoped path (BlockType,
            // PropertyIsEmpty) can push the IN-set into SQL instead of
            // materialising every active block first.
            let futures = filter_list
                .iter()
                .map(|f| resolve_filter_with_candidates(pool, f, 0, Some(&base_ids)));
            let results = try_join_all(futures).await?;
            let mut result = base_ids;
            for set in results {
                result.retain(|id| set.contains(id));
            }
            result
        }
    } else {
        base_ids
    };

    // 3. Compute filtered_count before pagination
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

    // 4. Sort
    let sort = sort.unwrap_or(BacklinkSort::Created { dir: SortDir::Asc });
    let sorted_ids = sort_ids(pool, &filtered_ids, &sort).await?;

    // 5. Apply cursor pagination
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    let start_idx = if let Some(after_id) = start_after {
        match sort {
            // Created sort uses ULID order which is lexicographic. Use
            // `partition_point` so the predicate respects the slice
            // direction — `binary_search_by` with the natural `cmp` on a
            // descending slice returns `Err(0)` for any cursor target
            // greater than the first element, silently emptying every
            // page past page 1 in `Created { Desc }` mode (H-10).
            //
            // For Asc: predicate `s <= after_id` partitions the sorted
            // slice into [≤ after_id | > after_id], and the partition
            // index is the first position strictly greater than the
            // cursor — i.e. the next item to return.
            //
            // For Desc: the slice is sorted high-to-low, so the
            // predicate inverts to `s >= after_id`, and the partition
            // index is the first position strictly less than the
            // cursor — same semantics on the inverted ordering.
            BacklinkSort::Created { dir: SortDir::Asc } => {
                sorted_ids.partition_point(|s| s.as_str() <= after_id)
            }
            BacklinkSort::Created { dir: SortDir::Desc } => {
                sorted_ids.partition_point(|s| s.as_str() >= after_id)
            }
            _ => {
                // Property sorts are ordered by property value, not by ID, so
                // binary search on ID is invalid. Fall back to O(n) position scan.
                sorted_ids
                    .iter()
                    .position(|s| s.as_str() == after_id)
                    .map(|i| i + 1)
                    .unwrap_or(sorted_ids.len())
            }
        }
    } else {
        0
    };
    let filtered: Vec<&str> = sorted_ids[start_idx..].iter().map(String::as_str).collect();

    // page.limit is a validated positive pagination bound; safe to convert
    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    let fetch_limit = limit_usize.saturating_add(1);
    let page_ids: Vec<&str> = filtered.into_iter().take(fetch_limit).collect();
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

    // 6. Fetch full BlockRows
    let fetched: Vec<BlockRow> = fetch_block_rows_by_ids(pool, &actual_ids).await?;

    // Reorder fetched rows to match the sorted order
    let id_order: std::collections::HashMap<&str, usize> = actual_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();
    let mut items = fetched;
    items.sort_by_key(|row| id_order.get(row.id.as_str()).copied().unwrap_or(usize::MAX));

    // 7. Build cursor
    let next_cursor = if has_more {
        let last = items.last().expect("has_more implies non-empty");
        Some(Cursor::for_id(last.id.clone()).encode()?)
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
/// Returns HashMap<block_id, (root_page_id, root_page_title)>.
/// Blocks whose `page_id` is NULL (orphans / tags) are omitted.
pub(super) async fn resolve_root_pages(
    pool: &SqlitePool,
    block_ids: &FxHashSet<String>,
) -> Result<std::collections::HashMap<String, (String, Option<String>)>, AppError> {
    if block_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let placeholders = block_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    // Filter `p.is_conflict = 0` on the page row — conflict copies of pages
    // must never be reported as a block's root page. Defensive consistency
    // with the recursive-CTE oracle used in tests (invariant #9).
    let sql = format!(
        "SELECT b.id as block_id, b.page_id as root_id, p.content as root_title \
         FROM blocks b \
         JOIN blocks p ON p.id = b.page_id \
         WHERE b.id IN ({placeholders}) AND p.is_conflict = 0"
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

    let mut map = std::collections::HashMap::new();
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
            "SELECT id, block_type, content, parent_id, position, \
             deleted_at, is_conflict, conflict_type, \
             todo_state, priority, due_date, scheduled_date, page_id \
             FROM blocks WHERE id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, BlockRow>(&sql);
        for id in ids {
            query = query.bind(*id);
        }
        Ok(query.fetch_all(pool).await?)
    } else {
        let json_ids = serde_json::to_string(&ids)?;
        let rows = sqlx::query_as::<_, BlockRow>(
            "SELECT id, block_type, content, parent_id, position, \
             deleted_at, is_conflict, conflict_type, \
             todo_state, priority, due_date, scheduled_date, page_id \
             FROM blocks WHERE id IN (SELECT value FROM json_each(?))",
        )
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
) -> Result<std::collections::HashMap<String, (String, Option<String>)>, AppError> {
    if block_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let placeholders = block_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    // Bound `depth < 100` on the recursive member to prevent runaway recursion
    // on corrupted parent_id chains (AGENTS.md invariant #9), filter
    // `b.is_conflict = 0` on the recursive walk so conflict-copy ancestors do
    // not redirect a block's root, and re-apply `b.is_conflict = 0` on the
    // final projection so prod (`resolve_root_pages` filtering `p.is_conflict = 0`)
    // and oracle agree on the same root-page universe. (M-60)
    let sql = format!(
        "WITH RECURSIVE walk(block_id, current_id, depth) AS ( \
            SELECT id, id, 0 FROM blocks WHERE id IN ({placeholders}) \
            UNION ALL \
            SELECT w.block_id, b.parent_id, w.depth + 1 \
            FROM walk w \
            JOIN blocks b ON b.id = w.current_id \
            WHERE b.parent_id IS NOT NULL AND b.is_conflict = 0 AND w.depth < 100 \
        ) \
        SELECT w.block_id, w.current_id as root_id, b.content as root_title \
        FROM walk w \
        JOIN blocks b ON b.id = w.current_id \
        WHERE b.parent_id IS NULL AND b.block_type = 'page' AND b.is_conflict = 0"
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

    let mut map = std::collections::HashMap::new();
    for row in rows {
        map.insert(row.block_id, (row.root_id, row.root_title));
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Public: list_property_keys
// ---------------------------------------------------------------------------

/// List all distinct property keys currently in use across all blocks.
pub async fn list_property_keys(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let rows =
        sqlx::query_scalar::<_, String>("SELECT DISTINCT key FROM block_properties ORDER BY key")
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

        let resp = eval_backlink_query(&pool, "BLK", None, None, &default_page())
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

        let resp = eval_backlink_query(&pool, "BLK_B", None, None, &default_page())
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
