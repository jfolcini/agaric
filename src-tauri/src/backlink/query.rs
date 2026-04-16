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

use super::filters::resolve_filter;
use super::sort::sort_ids;
use super::types::*;
use crate::error::AppError;
use crate::pagination::{BlockRow, Cursor, PageRequest};

// ---------------------------------------------------------------------------
// Public: eval_backlink_query (paginated + filtered)
// ---------------------------------------------------------------------------

/// Evaluate a filtered backlink query and return a paginated set of blocks.
///
/// ## Algorithm
///
/// 1. Get base backlink set (source_ids linking to `block_id`).
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
    let base_ids: FxHashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT bl.source_id FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0",
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
            // Resolve all top-level filters concurrently (#319)
            let futures = filter_list.iter().map(|f| resolve_filter(pool, f, 0));
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
        if matches!(sort, BacklinkSort::Created { .. }) {
            // Created sort uses ULID order which is lexicographic — binary
            // search is a valid O(log n) replacement for the linear scan.
            match sorted_ids.binary_search_by(|s| s.as_str().cmp(after_id)) {
                Ok(i) => i + 1, // found: start after it
                Err(i) => i,    // not found: start at insertion point
            }
        } else {
            // Property sorts are ordered by property value, not by ID, so
            // binary search on ID is invalid. Fall back to O(n) position scan.
            sorted_ids
                .iter()
                .position(|s| s.as_str() == after_id)
                .map(|i| i + 1)
                .unwrap_or(sorted_ids.len())
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
    let placeholders = actual_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query_str = format!(
        "SELECT id, block_type, content, parent_id, position, \
         deleted_at, is_conflict, conflict_type, \
         todo_state, priority, due_date, scheduled_date, page_id \
         FROM blocks WHERE id IN ({placeholders})"
    );

    let mut query = sqlx::query_as::<_, BlockRow>(&query_str);
    for id in &actual_ids {
        query = query.bind(*id);
    }
    let fetched: Vec<BlockRow> = query.fetch_all(pool).await?;

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
        Some(
            Cursor {
                id: last.id.clone(),
                position: None,
                deleted_at: None,
                seq: None,
                rank: None,
            }
            .encode()?,
        )
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

    let mut map = std::collections::HashMap::new();
    for row in rows {
        map.insert(row.block_id, (row.root_id, row.root_title));
    }
    Ok(map)
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
    let sql = format!(
        "WITH RECURSIVE walk(block_id, current_id) AS ( \
            SELECT id, id FROM blocks WHERE id IN ({placeholders}) \
            UNION ALL \
            SELECT w.block_id, b.parent_id \
            FROM walk w \
            JOIN blocks b ON b.id = w.current_id \
            WHERE b.parent_id IS NOT NULL \
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
