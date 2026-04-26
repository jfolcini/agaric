//! Grouped backlink queries and unlinked reference detection.

use futures_util::future::try_join_all;
use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::filters::resolve_filter;
use super::query::resolve_root_pages;
use super::sort::sort_ids;
use super::types::*;
use crate::error::AppError;
use crate::fts::sanitize_fts_query;
use crate::pagination::{BlockRow, Cursor, PageRequest};

// ---------------------------------------------------------------------------
// Public: eval_backlink_query_grouped
// ---------------------------------------------------------------------------

/// Evaluate a grouped backlink query — backlinks organized by source page.
///
/// ## Algorithm
///
/// 1. Get base backlink set.
/// 2. Apply filters.
/// 3. Resolve root pages for all filtered IDs.
/// 4. Group blocks by root page.
/// 5. Sort groups alphabetically by page title.
/// 6. Apply cursor pagination on groups.
/// 7. Sort blocks within each group, fetch full BlockRow data.
/// 8. Return `GroupedBacklinkResponse`.
pub async fn eval_backlink_query_grouped(
    pool: &SqlitePool,
    block_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    page: &PageRequest,
) -> Result<GroupedBacklinkResponse, AppError> {
    // 1. Get base backlink set.
    //    Exclude `source_id == block_id` self-links at the SQL layer so
    //    they never enter the count or grouping pipeline (H-11). Sources
    //    that happen to live on the *same* root page as the target are
    //    treated separately below — they are still backlinks, but for the
    //    grouped view we drop them so the user does not see "their own
    //    page" listed as a source group, mirroring the convention used by
    //    `eval_unlinked_references`.
    let base_ids: FxHashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT bl.source_id FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ?1 \
           AND bl.source_id != ?1 \
           AND b.deleted_at IS NULL AND b.is_conflict = 0",
    )
    .bind(block_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    if base_ids.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
            truncated: false,
        });
    }

    // 1a. Resolve the target's own root page once so we can drop
    //     same-page self-references below. If the target has no
    //     resolvable root page (orphan target), nothing matches the
    //     self-reference predicate and we behave as before.
    let target_root_page_id: Option<String> = {
        let mut target_set = FxHashSet::default();
        target_set.insert(block_id.to_string());
        let target_map = resolve_root_pages(pool, &target_set).await?;
        target_map.get(block_id).map(|(pid, _)| pid.clone())
    };

    // 1b. Resolve root pages for the entire base set up front.
    //     Orphan source blocks (no resolvable root page) and
    //     same-page self-references must be filtered out *before*
    //     `total_count` / `filtered_count` are computed — otherwise the
    //     UI badge reports more items than we actually render
    //     (AGENTS.md "Backend Patterns" #4: post-filter count is
    //     mandatory). Reusing this `root_map` downstream also avoids a
    //     second pass over the database.
    let root_map = resolve_root_pages(pool, &base_ids).await?;
    let base_ids: FxHashSet<String> = base_ids
        .into_iter()
        .filter(|id| match root_map.get(id) {
            // Orphan: no resolvable root page → drop.
            None => false,
            // Self-reference: source's root page == target's root page → drop.
            Some((page_id, _)) => target_root_page_id.as_deref() != Some(page_id.as_str()),
        })
        .collect();

    let total_count = base_ids.len();

    if base_ids.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
            truncated: false,
        });
    }

    // 2. Apply filters (AND semantics at top level)
    let filtered_ids = if let Some(ref filter_list) = filters {
        if filter_list.is_empty() {
            base_ids
        } else {
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

    let filtered_count = filtered_ids.len();

    if filtered_count == 0 {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count: 0,
            truncated: false,
        });
    }

    // 3. (Root pages already resolved in step 1b — `root_map` covers
    //     `base_ids ⊇ filtered_ids`, so every entry in `filtered_ids` has
    //     a corresponding root-page mapping.)

    // 4. Group blocks by root page. After step 1b every survivor has a
    //    valid root-page entry, so the `if let Some(...)` here is now
    //    purely defensive against a race between resolve and group.
    let mut page_groups: std::collections::HashMap<String, (Option<String>, Vec<String>)> =
        std::collections::HashMap::new();
    for block_id_item in &filtered_ids {
        if let Some((page_id, page_title)) = root_map.get(block_id_item) {
            page_groups
                .entry(page_id.clone())
                .or_insert_with(|| (page_title.clone(), Vec::new()))
                .1
                .push(block_id_item.clone());
        }
    }

    // 5. Sort groups alphabetically by page_title (None sorts last)
    let mut group_list: Vec<(String, Option<String>, Vec<String>)> = page_groups
        .into_iter()
        .map(|(pid, (title, blocks))| (pid, title, blocks))
        .collect();
    group_list.sort_by(|a, b| {
        let ta = a.1.as_deref();
        let tb = b.1.as_deref();
        match (ta, tb) {
            (Some(a_title), Some(b_title)) => a_title.cmp(b_title).then_with(|| a.0.cmp(&b.0)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.0.cmp(&b.0),
        }
    });

    // 6. Apply cursor pagination on groups
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    let groups_after_cursor: Vec<&(String, Option<String>, Vec<String>)> =
        if let Some(after_id) = start_after {
            group_list
                .iter()
                .skip_while(|(pid, _, _)| pid.as_str() != after_id)
                .skip(1)
                .collect()
        } else {
            group_list.iter().collect()
        };

    // page.limit is a validated positive pagination bound; safe to convert
    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    let fetch_limit = limit_usize.saturating_add(1);
    let page_groups_slice: Vec<&(String, Option<String>, Vec<String>)> =
        groups_after_cursor.into_iter().take(fetch_limit).collect();
    let has_more = page_groups_slice.len() > limit_usize;
    let actual_groups: Vec<&(String, Option<String>, Vec<String>)> = if has_more {
        page_groups_slice[..limit_usize].to_vec()
    } else {
        page_groups_slice
    };

    if actual_groups.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count,
            truncated: false,
        });
    }

    // 7. Sort all block IDs across groups by the user-specified sort, then distribute
    let sort = sort.unwrap_or(BacklinkSort::Created { dir: SortDir::Asc });
    let all_block_ids: FxHashSet<String> = actual_groups
        .iter()
        .flat_map(|(_, _, block_ids_in_group)| block_ids_in_group.iter().cloned())
        .collect();
    let sorted_all = sort_ids(pool, &all_block_ids, &sort).await?;

    // 8. Fetch full BlockRow data for all blocks in one batch
    let all_ids_vec: Vec<&str> = sorted_all.iter().map(String::as_str).collect();
    let fetched_rows = if all_ids_vec.is_empty() {
        vec![]
    } else {
        let placeholders = all_ids_vec
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let query_str = format!(
            "SELECT id, block_type, content, parent_id, position, \
             deleted_at, is_conflict, conflict_type, \
             todo_state, priority, due_date, scheduled_date, page_id \
             FROM blocks WHERE id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, BlockRow>(&query_str);
        for id in &all_ids_vec {
            query = query.bind(*id);
        }
        query.fetch_all(pool).await?
    };

    // Build a lookup map from id -> BlockRow
    let row_map: std::collections::HashMap<&str, &BlockRow> =
        fetched_rows.iter().map(|r| (r.id.as_str(), r)).collect();

    // Build a position map from sorted order
    let sort_order: std::collections::HashMap<&str, usize> = sorted_all
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    // 9. Distribute fetched rows back into groups, maintaining sort order
    let mut groups: Vec<BacklinkGroup> = Vec::with_capacity(actual_groups.len());
    for (page_id, page_title, block_ids_in_group) in &actual_groups {
        let mut blocks: Vec<(&str, usize)> = block_ids_in_group
            .iter()
            .filter_map(|bid| sort_order.get(bid.as_str()).map(|&pos| (bid.as_str(), pos)))
            .collect();
        blocks.sort_by_key(|&(_, pos)| pos);

        let block_rows: Vec<BlockRow> = blocks
            .iter()
            .filter_map(|&(bid, _)| row_map.get(bid).map(|r| (*r).clone()))
            .collect();

        groups.push(BacklinkGroup {
            page_id: page_id.clone(),
            page_title: page_title.clone(),
            blocks: block_rows,
        });
    }

    // 10. Build cursor from last group's page_id if has_more
    let next_cursor = if has_more {
        let last = actual_groups.last().expect("has_more implies non-empty");
        Some(
            Cursor {
                id: last.0.clone(),
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

    Ok(GroupedBacklinkResponse {
        groups,
        next_cursor,
        has_more,
        total_count,
        filtered_count,
        truncated: false,
    })
}

// ---------------------------------------------------------------------------
// Public: eval_unlinked_references
// ---------------------------------------------------------------------------

/// Find blocks that mention a page's title text without having a `[[link]]`
/// to it. Powers the "Unlinked References" UI feature.
///
/// ## Algorithm
///
/// 1. Fetch the page title.
/// 2. Sanitize title for FTS5.
/// 3. FTS5 query to find blocks mentioning the title, excluding blocks
///    that have a `block_links` row with `target_id = page_id`.
/// 4. Apply `filters` (if any) to the FTS match set using the shared
///    filter resolver — AND semantics at the top level.
/// 5. Resolve root pages for all matching blocks.
/// 6. Exclude blocks whose root page is the target page itself.
/// 7. Apply `sort` (if any) across the filtered block IDs using the shared
///    sort helper. Defaults to `Created { Asc }` (ULID order).
/// 8. Group by source page, sort groups alphabetically by `page_title`.
/// 9. Apply cursor pagination on groups.
/// 10. Fetch full `BlockRow` data for the paginated groups.
/// 11. Return `GroupedBacklinkResponse`. `total_count` and `filtered_count`
///     reflect the post-filter (self-reference-excluded) block count, per
///     the `total_count` contract in AGENTS.md (backend pattern #4).
pub async fn eval_unlinked_references(
    pool: &SqlitePool,
    page_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    page: &PageRequest,
) -> Result<GroupedBacklinkResponse, AppError> {
    // 1. Fetch the page title.
    //    Filter `is_conflict = 0` so a conflict-copy page id never resolves to a
    //    title that drives the unlinked-references search (mirrors the sister
    //    `resolve_root_pages` helper). (L-81)
    let title: Option<String> = sqlx::query_scalar(
        "SELECT content FROM blocks WHERE id = ?1 AND block_type = 'page' AND deleted_at IS NULL AND is_conflict = 0",
    )
    .bind(page_id)
    .fetch_optional(pool)
    .await?;

    let title = match title {
        Some(ref t) if !t.is_empty() => t.clone(),
        _ => String::new(),
    };

    // 1b. Fetch page aliases
    let aliases: Vec<String> =
        sqlx::query_scalar("SELECT alias FROM page_aliases WHERE page_id = ?1")
            .bind(page_id)
            .fetch_all(pool)
            .await?;

    // 2. Build combined FTS5 query from title + aliases
    let mut terms: Vec<String> = Vec::new();
    let title_sanitized = sanitize_fts_query(&title);
    if !title_sanitized.is_empty() {
        terms.push(title_sanitized);
    }
    for alias in &aliases {
        let alias_trimmed = alias.trim();
        if !alias_trimmed.is_empty() {
            let sanitized = sanitize_fts_query(alias_trimmed);
            if !sanitized.is_empty() {
                terms.push(sanitized);
            }
        }
    }

    if terms.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
            truncated: false,
        });
    }

    // FTS5 OR query: matches blocks containing ANY of the terms
    let fts_query = if terms.len() == 1 {
        terms.into_iter().next().unwrap_or_default()
    } else {
        // Wrap each term group in parentheses and join with OR
        terms
            .into_iter()
            .map(|t| format!("({t})"))
            .collect::<Vec<_>>()
            .join(" OR ")
    };

    // 3. FTS5 query to find blocks mentioning the title, excluding linked blocks.
    //    Cap at FTS_ROW_CAP + 1 rows so we can detect truncation (return at most
    //    FTS_ROW_CAP). The `+ 1` literal is derived from the constant via
    //    `format!` so the SQL stays in sync if the constant changes (I-Search-3).
    //    `ORDER BY fb.block_id` makes the truncation boundary deterministic
    //    across calls (M-62) — without it SQLite is free to return a different
    //    10 001 rows on the next request, which breaks cursor pagination
    //    (the cursor encodes a page_id from the truncated set; if the next
    //    truncation drops it, `skip_while` consumes everything and pagination
    //    terminates early or loops). See I-Search-13 for the cursor-side
    //    cross-reference.
    const FTS_ROW_CAP: usize = 10_000;
    let fts_sql = format!(
        "SELECT fb.block_id \
         FROM fts_blocks fb \
         JOIN blocks b ON b.id = fb.block_id \
         WHERE fts_blocks MATCH ?1 \
           AND b.deleted_at IS NULL \
           AND b.is_conflict = 0 \
           AND fb.block_id NOT IN ( \
             SELECT source_id FROM block_links WHERE target_id = ?2 \
           ) \
         ORDER BY fb.block_id \
         LIMIT {}",
        FTS_ROW_CAP + 1
    );
    let fts_rows: Vec<String> = sqlx::query_scalar::<_, String>(&fts_sql)
        .bind(&fts_query)
        .bind(page_id)
        .fetch_all(pool)
        .await?;

    let truncated = fts_rows.len() > FTS_ROW_CAP;
    let matching_ids: FxHashSet<String> = if truncated {
        fts_rows.into_iter().take(FTS_ROW_CAP).collect()
    } else {
        fts_rows.into_iter().collect()
    };

    if matching_ids.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
            truncated,
        });
    }

    // 4. Apply filters (AND semantics at top level) — mirrors
    //    eval_backlink_query_grouped step #2. Filters are resolved
    //    concurrently and intersected with the FTS match set.
    let filtered_matching: FxHashSet<String> = if let Some(ref filter_list) = filters {
        if filter_list.is_empty() {
            matching_ids
        } else {
            let futures = filter_list.iter().map(|f| resolve_filter(pool, f, 0));
            let results = try_join_all(futures).await?;
            let mut result = matching_ids;
            for set in results {
                result.retain(|id| set.contains(id));
            }
            result
        }
    } else {
        matching_ids
    };

    if filtered_matching.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
            truncated,
        });
    }

    // 5. Resolve root pages for all filtered IDs
    let root_map = resolve_root_pages(pool, &filtered_matching).await?;

    // 6. Group blocks by root page, excluding blocks whose root page is the target page
    let mut page_groups: std::collections::HashMap<String, (Option<String>, Vec<String>)> =
        std::collections::HashMap::new();
    for block_id_item in &filtered_matching {
        if let Some((root_page_id, page_title)) = root_map.get(block_id_item) {
            // Exclude self-references
            if root_page_id == page_id {
                continue;
            }
            page_groups
                .entry(root_page_id.clone())
                .or_insert_with(|| (page_title.clone(), Vec::new()))
                .1
                .push(block_id_item.clone());
        }
    }

    // `total_count` and `filtered_count` reflect the post-filter,
    // post-self-reference-exclusion count (AGENTS.md "Backend Patterns" #4).
    let filtered_count = page_groups.values().map(|(_, blocks)| blocks.len()).sum();
    let total_count = filtered_count;

    // 7. Sort groups alphabetically by page_title (None sorts last)
    let mut group_list: Vec<(String, Option<String>, Vec<String>)> = page_groups
        .into_iter()
        .map(|(pid, (title, blocks))| (pid, title, blocks))
        .collect();
    group_list.sort_by(|a, b| {
        let ta = a.1.as_deref();
        let tb = b.1.as_deref();
        match (ta, tb) {
            (Some(a_title), Some(b_title)) => a_title.cmp(b_title).then_with(|| a.0.cmp(&b.0)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.0.cmp(&b.0),
        }
    });

    // 8. Apply cursor pagination on groups
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    let groups_after_cursor: Vec<&(String, Option<String>, Vec<String>)> =
        if let Some(after_id) = start_after {
            group_list
                .iter()
                .skip_while(|(pid, _, _)| pid.as_str() != after_id)
                .skip(1)
                .collect()
        } else {
            group_list.iter().collect()
        };

    // page.limit is a validated positive pagination bound; safe to convert
    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    let fetch_limit = limit_usize.saturating_add(1);
    let page_groups_slice: Vec<&(String, Option<String>, Vec<String>)> =
        groups_after_cursor.into_iter().take(fetch_limit).collect();
    let has_more = page_groups_slice.len() > limit_usize;
    let actual_groups: Vec<&(String, Option<String>, Vec<String>)> = if has_more {
        page_groups_slice[..limit_usize].to_vec()
    } else {
        page_groups_slice
    };

    if actual_groups.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count,
            truncated,
        });
    }

    // 9. Sort all block IDs across groups by the user-specified sort, then distribute.
    //    Mirrors eval_backlink_query_grouped step #7 — default to Created Asc (ULID order).
    let sort = sort.unwrap_or(BacklinkSort::Created { dir: SortDir::Asc });
    let all_block_ids_set: FxHashSet<String> = actual_groups
        .iter()
        .flat_map(|(_, _, block_ids_in_group)| block_ids_in_group.iter().cloned())
        .collect();
    let sorted_all = sort_ids(pool, &all_block_ids_set, &sort).await?;

    // 10. Fetch full BlockRow data for all blocks in one batch
    let all_ids_vec: Vec<&str> = sorted_all.iter().map(String::as_str).collect();
    let fetched_rows = if all_ids_vec.is_empty() {
        vec![]
    } else {
        let placeholders = all_ids_vec
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let query_str = format!(
            "SELECT id, block_type, content, parent_id, position, \
             deleted_at, is_conflict, conflict_type, \
             todo_state, priority, due_date, scheduled_date, page_id \
             FROM blocks WHERE id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, BlockRow>(&query_str);
        for id in &all_ids_vec {
            query = query.bind(*id);
        }
        query.fetch_all(pool).await?
    };

    // Build a lookup map from id -> BlockRow
    let row_map: std::collections::HashMap<&str, &BlockRow> =
        fetched_rows.iter().map(|r| (r.id.as_str(), r)).collect();

    // Build a position map from sorted order
    let sort_order: std::collections::HashMap<&str, usize> = sorted_all
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    // 11. Distribute fetched rows back into groups, maintaining sort order
    let mut groups: Vec<BacklinkGroup> = Vec::with_capacity(actual_groups.len());
    for (group_page_id, page_title, block_ids_in_group) in &actual_groups {
        let mut blocks: Vec<(&str, usize)> = block_ids_in_group
            .iter()
            .filter_map(|bid| sort_order.get(bid.as_str()).map(|&pos| (bid.as_str(), pos)))
            .collect();
        blocks.sort_by_key(|&(_, pos)| pos);

        let block_rows: Vec<BlockRow> = blocks
            .iter()
            .filter_map(|&(bid, _)| row_map.get(bid).map(|r| (*r).clone()))
            .collect();

        groups.push(BacklinkGroup {
            page_id: group_page_id.clone(),
            page_title: page_title.clone(),
            blocks: block_rows,
        });
    }

    // 12. Build cursor from last group's page_id if has_more
    let next_cursor = if has_more {
        let last = actual_groups.last().expect("has_more implies non-empty");
        Some(
            Cursor {
                id: last.0.clone(),
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

    Ok(GroupedBacklinkResponse {
        groups,
        next_cursor,
        has_more,
        total_count,
        filtered_count,
        truncated,
    })
}
