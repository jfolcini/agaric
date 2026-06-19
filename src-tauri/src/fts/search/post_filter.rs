//! SQL-A3 / BE-A1 (PEND-58f) — filter-aware cursor pagination for the
//! non-regex toggle (case-sensitive / whole-word) path. Scans candidate
//! windows, applies the caller's per-row `keep` predicate, and advances
//! the FTS cursor so dropped candidates are never re-scanned.

use sqlx::SqlitePool;

use crate::domain::search_types::SearchBlockRow;
use crate::error::AppError;
use crate::pagination::{Cursor, PageRequest, PageResponse};

use super::super::metadata_filter::MetadataPredicates;
use super::constants::{MAX_QUERY_LEN, MAX_SEARCH_RESULTS};
use super::fetch::fts_fetch_rows;
use super::row::fts_row_to_block_row;
use super::sanitizer::sanitize_fts_query;

/// Window size (candidate FTS rows fetched per loop iteration) for the
/// post-filter cursor pagination in [`fts_fetch_post_filtered_page`].
///
/// SQL-A3 (PEND-58f) — the post-filter (case/word toggle) path narrows an
/// FTS candidate window after the FTS scan. To return a FULL page of
/// `limit` survivors we may have to scan several windows when the filter
/// is selective. Each window asks the FTS scan for [`MAX_SEARCH_RESULTS`]
/// candidates (one page's worth) — large enough that a typical filter
/// fills a page in one or two windows, small enough that we never fetch a
/// huge slab when the very first window already has enough survivors.
const POST_FILTER_WINDOW: i64 = MAX_SEARCH_RESULTS;

/// Maximum number of candidate windows scanned per page request in
/// [`fts_fetch_post_filtered_page`].
///
/// SQL-A3 (PEND-58f) — bounds the total work a pathologically selective
/// post-filter can trigger. With [`POST_FILTER_WINDOW`] = 100 the ceiling
/// is `100 * 10 = 1000` FTS candidates scanned per page — the same
/// order-of-magnitude bound the regex-mode path uses
/// (`REGEX_PRE_FILTER_CAP` = 1000). If a filter is so selective that it
/// drops > 1000 candidates without filling a page, we stop scanning and
/// report `has_more = false` (best-effort: matches beyond the window are
/// not surfaced, mirroring the regex-mode contract). 10 windows is a
/// round design figure, not a benchmarked value.
const POST_FILTER_MAX_WINDOWS: usize = 10;

/// SQL-A3 / BE-A1 (PEND-58f) — filter-aware cursor pagination for the
/// non-regex toggle (case-sensitive / whole-word) path.
///
/// ## Why this exists
///
/// The naive composition — call [`search_fts`] (which computes
/// `has_more` / `next_cursor` on a `limit + 1` candidate window) and THEN
/// drop non-matching rows — is broken two ways:
///
///   1. **Under-fill.** The page renders sparse/empty with
///      `has_more = true` because the post-filter shrank the candidate
///      window below `limit`.
///   2. **Unrecoverable drops.** Rows dropped *within* the window are
///      skipped by the next page's cursor (it points past the pre-filter
///      window), so those survivors are permanently lost.
///
/// ## What this does
///
/// Fetches candidate windows via [`fts_fetch_rows`] directly, applies the
/// caller's per-row `keep` predicate (which also attaches match offsets /
/// clears the FTS snippet), accumulates survivors, and advances the FTS
/// cursor by the **last candidate** of each window (so dropped candidates
/// are never re-scanned). It loops until it has `limit + 1` survivors OR
/// the FTS scan is exhausted (a window returns fewer rows than requested)
/// OR the [`POST_FILTER_MAX_WINDOWS`] bound is hit.
///
/// Then:
/// - `has_more = survivors > limit` (truncated to `limit`).
/// - `next_cursor` = the `(rank, id)` of the **last RETURNED survivor**.
///   This resumes the next page strictly after that survivor; the dropped
///   candidates sit *before* it in rank order and are not re-scanned —
///   verified correct because the FTS keyset is `(rank ASC, id ASC)` and
///   every survivor we returned ranks at or before the last one.
///
/// The `keep` predicate is `FnMut(&mut SearchBlockRow) -> bool`: it
/// returns `true` to retain the row (after mutating its `match_offsets` /
/// `snippet`) and `false` to drop it.
///
/// [`search_fts`]: super::cursor::search_fts
/// [`fts_fetch_rows`]: super::fetch::fts_fetch_rows
#[allow(clippy::too_many_arguments)]
pub(in crate::fts) async fn fts_fetch_post_filtered_page<F>(
    pool: &SqlitePool,
    query: &str,
    page: &PageRequest,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    block_type_filter: Option<&str>,
    metadata: &MetadataPredicates,
    mut keep: F,
) -> Result<PageResponse<SearchBlockRow>, AppError>
where
    F: FnMut(&mut SearchBlockRow) -> bool,
{
    // Mirror `search_fts`'s up-front guards so this path observes the
    // exact same empty / over-long / empty-after-sanitise semantics.
    if query.trim().is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: None,
        });
    }
    if query.len() > MAX_QUERY_LEN {
        return Err(AppError::Validation(format!(
            "search query is too long ({} bytes); maximum is {MAX_QUERY_LEN} bytes",
            query.len()
        )));
    }
    let sanitized = sanitize_fts_query(query);
    if sanitized.is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: None,
        });
    }

    let effective_limit = page.limit.min(MAX_SEARCH_RESULTS);
    let limit_usize = usize::try_from(effective_limit).unwrap_or(usize::MAX);
    // We want `limit + 1` survivors so the extra one signals `has_more`.
    let target = limit_usize.saturating_add(1);

    // Seed the FTS cursor from the incoming page cursor (same shape as
    // `search_fts`). Subsequent windows advance this by the LAST CANDIDATE
    // of each fetched window so dropped rows are never re-scanned.
    let (mut cursor_flag, mut cursor_rank, mut cursor_id): (Option<i64>, f64, String) =
        match page.after.as_ref() {
            Some(c) => (Some(1), c.rank.unwrap_or(0.0), c.id.clone()),
            None => (None, 0.0, String::new()),
        };

    let window_usize = usize::try_from(POST_FILTER_WINDOW).unwrap_or(usize::MAX);
    // `(SearchBlockRow, rank)` survivors. The rank rides alongside each
    // survivor so the final `next_cursor` can be built from the last
    // RETURNED survivor (which `SearchBlockRow` alone cannot carry — it
    // has no rank field).
    let mut survivors: Vec<(SearchBlockRow, f64)> = Vec::with_capacity(target);

    for _ in 0..POST_FILTER_MAX_WINDOWS {
        if survivors.len() >= target {
            break;
        }
        let rows = fts_fetch_rows(
            pool,
            &sanitized,
            cursor_flag,
            cursor_rank,
            &cursor_id,
            POST_FILTER_WINDOW,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            block_type_filter,
            metadata,
            // The toggle post-filter clears `row.snippet` anyway (it
            // prefers offsets), so skip the per-row `snippet()` walk.
            false,
            // P4 (#346) — full content here: the caller's `keep` predicate
            // runs the toggle regex against `content`, so truncating it at
            // the DB would change which rows match / where offsets land.
            // Any output truncation for this path happens after matching
            // (see `search_with_toggles`).
            None,
            None,
        )
        .await?;

        let fetched = rows.len();
        if fetched == 0 {
            break;
        }

        for r in rows {
            let rank = r.search_rank;
            let id_clone = r.id.as_str().to_string();
            let mut block_row = fts_row_to_block_row(r);
            // Advance the FTS cursor by EVERY candidate (the last candidate
            // of the window wins) so dropped rows are never re-scanned by a
            // later window — including an all-drop window, which still makes
            // forward progress instead of looping on the same rows.
            cursor_flag = Some(1);
            cursor_rank = rank;
            cursor_id = id_clone;
            if keep(&mut block_row) {
                survivors.push((block_row, rank));
                if survivors.len() >= target {
                    break;
                }
            }
        }

        // FTS exhausted — a window returned fewer rows than requested, so
        // there is nothing left to scan. Stop regardless of survivor count.
        if fetched < window_usize {
            break;
        }
    }

    let has_more = survivors.len() > limit_usize;
    if has_more {
        survivors.truncate(limit_usize);
    }

    let next_cursor = if has_more {
        // `next_cursor` = (rank, id) of the LAST RETURNED survivor.
        let (last_row, last_rank) = survivors
            .last()
            .expect("has_more implies at least `limit` survivors (limit >= 1)");
        Some(Cursor::for_id_and_rank(last_row.id.as_str().to_string(), *last_rank).encode()?)
    } else {
        None
    };

    let items: Vec<SearchBlockRow> = survivors.into_iter().map(|(row, _rank)| row).collect();

    Ok(PageResponse {
        items,
        next_cursor,
        has_more,
        total_count: None,
    })
}
