//! Grouped backlink queries and unlinked reference detection.

use futures_util::future::try_join_all;
use rustc_hash::{FxHashMap, FxHashSet};
use sqlx::SqlitePool;

use super::filters::resolve_filter_with_candidates;
use super::query::{fetch_block_rows_by_ids, resolve_root_pages};
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
/// 1. Compute `total_count` via a SQL `COUNT(*)` (self/orphan/same-page blocks
///    excluded in the predicate — never materialises the full base set).
/// 2. Resolve each active filter to an intersected `FxHashSet` of matching IDs.
/// 3. Materialise the post-filter + base-predicate block-id set in a single SQL
///    pass (same `b.page_id IS NOT NULL`, `b.page_id != tgt.page_id` exclusions).
/// 4. Resolve root pages for all filtered IDs.
/// 5. Bucket into groups keyed by root page; sort alphabetically by page title.
/// 6. Apply cursor pagination on groups.
/// 7. Sort blocks within each group, fetch full `BlockRow` data, cap per group.
/// 8. Return `GroupedBacklinkResponse`.
///
/// ## Sort asymmetry (deliberate)
///
/// Groups are **always** sorted alphabetically by `page_title` regardless
/// of the user-supplied `BacklinkSort`. The user's sort applies only
/// **within** each group (block ordering inside the group). This is a
/// deliberate design choice — alphabetical group ordering keeps the
/// source-page list stable and predictable for navigation, so users can
/// scan for a known page by name regardless of which sort they picked
/// for blocks. See I-Search-12: option (a) (sort groups
/// by the latest member's sort key) was considered and rejected because
/// it makes the group list reshuffle on every edit and defeats muscle
/// memory. The frontend mirrors this contract in
/// `BacklinkGroupRenderer.tsx`.
pub async fn eval_backlink_query_grouped(
    pool: &SqlitePool,
    block_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<GroupedBacklinkResponse, AppError> {
    // 1. `total_count` via SQL — never materialises the full base id set.
    //    The COUNT(*) subquery applies the same predicates as the pre-H1
    //    base-set fetch (target match, self-exclusion, deleted_at, space
    //    scope) AND filters out same-root-page self-references and
    //    orphans (sources whose `page_id` doesn't resolve). The grouped
    //    variant treats source blocks that live on the *same* root page
    //    as the target as self-references because the UI never shows
    //    "your own page" as a source group.
    let total_count_i64: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         JOIN blocks tgt ON tgt.id = ?1 \
         WHERE bl.target_id = ?1 \
           AND bl.source_id != ?1 \
           AND b.deleted_at IS NULL \
           AND b.page_id IS NOT NULL \
           AND b.page_id != COALESCE(tgt.page_id, tgt.id) \
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
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
            truncated: false,
        });
    }

    // 2. Resolve filters (if any) — same shape as `eval_backlink_query`.
    //    No candidate set is fed in; the base predicates (target match,
    //    self-exclusion, same-page exclusion, space) are re-applied at
    //    the page-id materialise step below.
    let filter_json: Option<String> = match filters.as_ref() {
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
            if acc.is_empty() {
                return Ok(GroupedBacklinkResponse {
                    groups: vec![],
                    next_cursor: None,
                    has_more: false,
                    total_count,
                    filtered_count: 0,
                    truncated: false,
                });
            }
            Some(serde_json::to_string(&acc.iter().collect::<Vec<_>>())?)
        }
        _ => None,
    };

    // Materialise the post-filter, post-base-predicate id set. SQL
    // applies the same predicates as the COUNT above plus the
    // optional filter intersection. We can't avoid materialising
    // because the grouped path needs to bucket by root page.
    let filtered_ids: FxHashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT bl.source_id FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         JOIN blocks tgt ON tgt.id = ?1 \
         WHERE bl.target_id = ?1 \
           AND bl.source_id != ?1 \
           AND b.deleted_at IS NULL \
           AND b.page_id IS NOT NULL \
           AND b.page_id != COALESCE(tgt.page_id, tgt.id) \
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
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count: 0,
            truncated: false,
        });
    }

    // Resolve root pages for the materialised, post-filter id set so we
    // can bucket downstream. Every entry in `filtered_ids` has a
    // corresponding root-page mapping because the SQL above filters
    // `b.page_id IS NOT NULL` and `b.page_id != target_root` — so
    // orphans and same-page self-references are already excluded.
    let root_map = resolve_root_pages(pool, &filtered_ids).await?;

    // Group blocks by root page. The `if let Some(...)` here is purely
    // defensive against a race between resolve and group.
    // L-5 (PEND-25): `FxHashMap` for the by-page bucket — keys are
    // owned `String` page-ids; the FNV hash matters here because this
    // map is built per query.
    let mut page_groups: FxHashMap<String, (Option<String>, Vec<String>)> = FxHashMap::default();
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

    // 7. Sort all block IDs across groups by the user-specified sort, then
    //    distribute. Sorting only orders ids (cheap); the expensive
    //    `fetch_block_rows_by_ids` below runs AFTER the per-group cap so we
    //    never load full rows for blocks the response will discard (#380).
    let sort = sort.unwrap_or(BacklinkSort::Created { dir: SortDir::Asc });
    let all_block_ids: FxHashSet<String> = actual_groups
        .iter()
        .flat_map(|(_, _, block_ids_in_group)| block_ids_in_group.iter().cloned())
        .collect();
    let sorted_all = sort_ids(pool, &all_block_ids, &sort).await?;

    // Build a position map from sorted order.
    let sort_order: FxHashMap<&str, usize> = sorted_all
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    // 8. Build each group's sorted, capped id list FIRST, recording
    //    truncation. `filtered_count` was summed from the untruncated group
    //    sizes above, so the badge stays accurate (#380); only the
    //    materialised slice is bounded. The cap is applied AFTER sorting so
    //    the visible window is the first `MAX_BLOCKS_PER_GROUP` ids in the
    //    user's sort order, deterministically.
    let mut capped_groups: Vec<(&String, &Option<String>, Vec<&str>, bool)> =
        Vec::with_capacity(actual_groups.len());
    for (page_id, page_title, block_ids_in_group) in &actual_groups {
        let mut blocks: Vec<(&str, usize)> = block_ids_in_group
            .iter()
            .filter_map(|bid| sort_order.get(bid.as_str()).map(|&pos| (bid.as_str(), pos)))
            .collect();
        blocks.sort_by_key(|&(_, pos)| pos);

        let group_truncated = blocks.len() > super::MAX_BLOCKS_PER_GROUP;
        if group_truncated {
            blocks.truncate(super::MAX_BLOCKS_PER_GROUP);
        }
        let ids: Vec<&str> = blocks.into_iter().map(|(bid, _)| bid).collect();
        capped_groups.push((page_id, page_title, ids, group_truncated));
    }

    // 9. Fetch full BlockRow data for ONLY the capped, post-truncation id
    //    set — one batch, bounded by `#groups * MAX_BLOCKS_PER_GROUP`.
    let fetch_ids: Vec<&str> = capped_groups
        .iter()
        .flat_map(|(_, _, ids, _)| ids.iter().copied())
        .collect();
    let fetched_rows = fetch_block_rows_by_ids(pool, &fetch_ids).await?;

    // Build a lookup map from id -> BlockRow.
    // L-5 (PEND-25): short-lived per-query map keyed on borrowed `&str`s —
    // `FxHashMap` skips SipHash setup with no behavioural change.
    let row_map: FxHashMap<&str, &BlockRow> =
        fetched_rows.iter().map(|r| (r.id.as_str(), r)).collect();

    // 10. Distribute fetched rows back into groups (already in sort order).
    //     MAINT-113 M2 — `all_block_ids` traces back to active candidates
    //     (the grouped query's base set filters `deleted_at IS NULL`), so
    //     the per-group rows are also active. The boundary cast records
    //     that claim in the type system.
    let mut groups: Vec<BacklinkGroup> = Vec::with_capacity(capped_groups.len());
    for (page_id, page_title, ids, group_truncated) in capped_groups {
        let block_rows: Vec<crate::pagination::ActiveBlockRow> = ids
            .iter()
            .filter_map(|&bid| row_map.get(bid).map(|r| (*r).clone()))
            .map(crate::pagination::ActiveBlockRow::from_block_row_unchecked)
            .collect();

        groups.push(BacklinkGroup {
            page_id: page_id.clone(),
            page_title: page_title.clone(),
            blocks: block_rows,
            truncated: group_truncated,
        });
    }

    // 11. Build cursor from last group's page_id if has_more
    let next_cursor = if has_more {
        let last = actual_groups.last().expect("has_more implies non-empty");
        Some(Cursor::for_id(last.0.clone()).encode()?)
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
/// 4. Resolve root pages for the entire FTS match set (used both for
///    the pre-filter `total_count` and the post-filter grouping step).
/// 5. Capture `total_count` from the FTS match set after dropping
///    orphans and self-references — mirrors
///    `eval_backlink_query_grouped:128`.
/// 6. Apply `filters` (if any) to the FTS match set using the shared
///    filter resolver — AND semantics at the top level.
/// 7. Group by source page, sort groups alphabetically by `page_title`.
/// 8. Apply cursor pagination on groups.
/// 9. Apply `sort` (if any) across the filtered block IDs using the shared
///    sort helper. Defaults to `Created { Asc }` (ULID order).
/// 10. Fetch full `BlockRow` data for the paginated groups.
/// 11. Return `GroupedBacklinkResponse`. `total_count` is the pre-filter,
///     post-self-reference-exclusion count (parity with
///     `eval_backlink_query_grouped:128`); `filtered_count` is the
///     post-filter, post-grouping sum.
pub async fn eval_unlinked_references(
    pool: &SqlitePool,
    page_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<GroupedBacklinkResponse, AppError> {
    // 1. Fetch the page title.
    //    Filter  so a conflict-copy page id never resolves to a
    //    title that drives the unlinked-references search (mirrors the sister
    //    `resolve_root_pages` helper). (L-81)
    let title: Option<String> = sqlx::query_scalar(
        "SELECT content FROM blocks WHERE id = ?1 AND block_type = 'page' AND deleted_at IS NULL",
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
    //
    //    FEAT-3p4 — the `(?3 IS NULL OR COALESCE(...))` clause mirrors
    //    `crate::space_filter_clause!`. Resolves the FTS-matched block
    //    to its owning page via `b.page_id` and
    //    intersects against `block_properties(key = 'space').value_ref`
    //    when `space_id` is `Some`. Kept inline (not via the macro)
    //    because the FTS SQL is built with `format!` to splice in
    //    `FTS_ROW_CAP + 1`, which precludes the `query_scalar!` macro.
    //    Applied at the base-set step so `total_count` /
    //    `filtered_count` reflect the post-space-filter universe.
    //
    //    PEND-83 Bug 2 — drop title-block hits (`block_type = 'page'`)
    //    from the unlinked-refs base set. The trigram FTS tokenizer is
    //    substring-based, so a child page like `Notes/2026` (whose
    //    title block has `content = 'Notes/2026'`) matches the
    //    unlinked-refs query for the parent page `Notes` via the
    //    trigrams `Not`, `ote`, `tes`. Title blocks are not useful
    //    matches in the refs panel — that panel surfaces body matches,
    //    not title matches — so we filter them out globally rather
    //    than scoping to descendants of the current page. Applied at
    //    the base-set step so pagination + `total_count` /
    //    `filtered_count` all see the post-filter universe.
    const FTS_ROW_CAP: usize = 10_000;
    let fts_sql = format!(
        "SELECT fb.block_id \
         FROM fts_blocks fb \
         JOIN blocks b ON b.id = fb.block_id \
         WHERE fts_blocks MATCH ?1 \
           AND b.deleted_at IS NULL \
           AND b.block_type != 'page' \
           AND fb.block_id NOT IN ( \
             SELECT source_id FROM block_links WHERE target_id = ?2 \
           ) \
           AND (?3 IS NULL OR b.page_id IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?3)) \
         ORDER BY fb.block_id \
         LIMIT {}",
        FTS_ROW_CAP + 1
    );
    let fts_rows: Vec<String> =
        sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(fts_sql.as_str()))
            .bind(&fts_query)
            .bind(page_id)
            .bind(space_id)
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

    // 4. Resolve root pages for the entire FTS match set up front so we
    //    can capture `total_count` *before* user filters apply. This
    //    mirrors `eval_backlink_query_grouped` (see line 128 in this
    //    file): both functions expose a pre-filter,
    //    post-self-reference-exclusion `total_count`, so the UI badge
    //    reports the same base regardless of the active filter
    //    expression. The cost is bounded — `matching_ids` is capped at
    //    `FTS_ROW_CAP` rows above. Reusing this `root_map` downstream
    //    also avoids a second pass over the database during grouping.
    let root_map = resolve_root_pages(pool, &matching_ids).await?;

    // 5. Capture `total_count` = matches whose root page resolves and is
    //    *not* the target page. Orphans (no resolvable root page) and
    //    self-references (root page == target) are dropped here so the
    //    count matches what the grouping step at #7 would produce on the
    //    unfiltered set.
    let total_count: usize = matching_ids
        .iter()
        .filter(|bid| match root_map.get(bid.as_str()) {
            Some((root_page_id, _)) => root_page_id != page_id,
            None => false,
        })
        .count();

    // 6. Apply filters (AND semantics at top level) — mirrors
    //    eval_backlink_query_grouped step #2. Filters are resolved
    //    concurrently and intersected with the FTS match set.
    let filtered_matching: FxHashSet<String> = if let Some(ref filter_list) = filters {
        if filter_list.is_empty() {
            matching_ids
        } else {
            // I-Search-9: scope leaf filters to the FTS-match set
            // via the candidate-aware resolver.
            let futures = filter_list
                .iter()
                .map(|f| resolve_filter_with_candidates(pool, f, 0, Some(&matching_ids)));
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
            total_count,
            filtered_count: 0,
            truncated,
        });
    }

    // 7a. Group filtered blocks by root page, excluding blocks whose root
    //     page is the target page. `root_map` covers `matching_ids ⊇
    //     filtered_matching` from step #4, so no second resolve is needed.
    // L-5 (PEND-25): mirror the `eval_backlink_query_grouped` flavour
    // and use `FxHashMap` for the by-page bucket.
    let mut page_groups: FxHashMap<String, (Option<String>, Vec<String>)> = FxHashMap::default();
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

    // `total_count` was captured pre-filter at step #5 (parity with
    // `eval_backlink_query_grouped:128`). `filtered_count` is the
    // post-filter, post-self-reference, post-grouping sum — i.e. the
    // number of blocks the user actually sees after their filter
    // expression has been applied.
    let filtered_count = page_groups.values().map(|(_, blocks)| blocks.len()).sum();

    // 7b. Sort groups alphabetically by page_title (None sorts last)
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

    // 9. Sort all block IDs across groups by the user-specified sort, then
    //    distribute. Mirrors eval_backlink_query_grouped step #7 — default
    //    to Created Asc (ULID order). The expensive
    //    `fetch_block_rows_by_ids` runs AFTER the per-group cap (#380).
    let sort = sort.unwrap_or(BacklinkSort::Created { dir: SortDir::Asc });
    let all_block_ids_set: FxHashSet<String> = actual_groups
        .iter()
        .flat_map(|(_, _, block_ids_in_group)| block_ids_in_group.iter().cloned())
        .collect();
    let sorted_all = sort_ids(pool, &all_block_ids_set, &sort).await?;

    // Build a position map from sorted order.
    let sort_order: FxHashMap<&str, usize> = sorted_all
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    // 10. Build each group's sorted, capped id list FIRST, recording
    //     truncation (#380). `filtered_count` (step #7) reflects the
    //     untruncated sizes, so the badge stays accurate; only the
    //     materialised slice is bounded to `MAX_BLOCKS_PER_GROUP`.
    let mut capped_groups: Vec<(&String, &Option<String>, Vec<&str>, bool)> =
        Vec::with_capacity(actual_groups.len());
    for (group_page_id, page_title, block_ids_in_group) in &actual_groups {
        let mut blocks: Vec<(&str, usize)> = block_ids_in_group
            .iter()
            .filter_map(|bid| sort_order.get(bid.as_str()).map(|&pos| (bid.as_str(), pos)))
            .collect();
        blocks.sort_by_key(|&(_, pos)| pos);

        let group_truncated = blocks.len() > super::MAX_BLOCKS_PER_GROUP;
        if group_truncated {
            blocks.truncate(super::MAX_BLOCKS_PER_GROUP);
        }
        let ids: Vec<&str> = blocks.into_iter().map(|(bid, _)| bid).collect();
        capped_groups.push((group_page_id, page_title, ids, group_truncated));
    }

    // 11. Fetch full BlockRow data for ONLY the capped, post-truncation id
    //     set — one batch, bounded by `#groups * MAX_BLOCKS_PER_GROUP`.
    let fetch_ids: Vec<&str> = capped_groups
        .iter()
        .flat_map(|(_, _, ids, _)| ids.iter().copied())
        .collect();
    let fetched_rows = fetch_block_rows_by_ids(pool, &fetch_ids).await?;

    // Build a lookup map from id -> BlockRow.
    // L-5 (PEND-25): same `FxHashMap` swap as the sister
    // `eval_backlink_query_grouped` block-row lookup.
    let row_map: FxHashMap<&str, &BlockRow> =
        fetched_rows.iter().map(|r| (r.id.as_str(), r)).collect();

    // 12. Distribute fetched rows back into groups (already in sort order).
    //     MAINT-113 M2 — same active-only invariant as above; the
    //     unlinked-references query path also filters
    //     deleted_at IS NULL` upstream.
    let mut groups: Vec<BacklinkGroup> = Vec::with_capacity(capped_groups.len());
    for (group_page_id, page_title, ids, group_truncated) in capped_groups {
        let block_rows: Vec<crate::pagination::ActiveBlockRow> = ids
            .iter()
            .filter_map(|&bid| row_map.get(bid).map(|r| (*r).clone()))
            .map(crate::pagination::ActiveBlockRow::from_block_row_unchecked)
            .collect();

        groups.push(BacklinkGroup {
            page_id: group_page_id.clone(),
            page_title: page_title.clone(),
            blocks: block_rows,
            truncated: group_truncated,
        });
    }

    // 13. Build cursor from last group's page_id if has_more
    let next_cursor = if has_more {
        let last = actual_groups.last().expect("has_more implies non-empty");
        Some(Cursor::for_id(last.0.clone()).encode()?)
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
