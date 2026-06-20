//! Phase 1 — partitioned FTS scan for the palette's two-partition
//! (pages + blocks) view. Runs two parallel FTS scans and packages each
//! candidate set with its own probe-derived `has_more` flag.

use sqlx::SqlitePool;

use crate::cancellation::CancellationToken;
use crate::domain::search_types::SearchBlockRow;
use crate::error::AppError;

use super::super::metadata_filter::MetadataPredicates;
use super::constants::{MAX_QUERY_LEN, MAX_SEARCH_RESULTS};
use super::fetch::fts_fetch_rows;
use super::row::fts_row_to_block_row;
use super::sanitizer::sanitize_fts_query;

/// Outcome of [`search_fts_partitioned`] — two pre-partitioned candidate
/// sets (page-only + unrestricted), each with its own `has_more` flag
/// derived from a `limit + 1` probe.
///
/// The previous one-scan-then-partition shape could drop
/// the pages partition entirely when 49 content blocks ranked above
/// the only page hit. The two-scan shape guarantees the pages
/// partition reflects matching pages regardless of content rank.
///
/// The same row may appear in both partitions (a page-typed row is in
/// `pages` AND in `blocks`); the palette merges by `page_id`.
pub(crate) struct FtsPartitionedScan {
    /// Page-only partition (`block_type = 'page'`) in rank order,
    /// capped at the caller's `page_limit`.
    pub pages: Vec<SearchBlockRow>,
    /// Unrestricted partition (any `block_type`) in rank order, capped
    /// at the caller's `block_limit`.
    pub blocks: Vec<SearchBlockRow>,
    /// `true` iff the pages scan returned `page_limit + 1` rows — the
    /// Probe approach (resolves Open Q3). Lets the caller
    /// signal accurate per-partition pagination instead of inferring
    /// from the global ceiling.
    pub pages_has_more: bool,
    /// `true` iff the blocks scan returned `block_limit + 1` rows.
    /// Same probe semantics as `pages_has_more`.
    pub blocks_has_more: bool,
}

/// Phase 1 / two parallel FTS scans for the
/// palette's two-partition view. Each scan reuses the same SQL builder
/// as [`search_fts`]; the pages scan adds `block_type = 'page'` to the
/// WHERE clause and uses `with_snippet = with_snippet_pages`, the
/// blocks scan adds no `block_type` filter.
///
/// Both scans use a `limit + 1` probe so the caller can signal accurate
/// Per-partition `has_more` (resolves Open Q3).
///
/// All other filters — `parent_id`, `tag_ids`, `space_id`, page-name
/// globs, metadata predicates — are honoured identically on both
/// scans.
///
/// Concurrency: both scans run via [`tokio::try_join!`] on the shared
/// read pool. With `max_connections(4)` we afford two reads per IPC.
/// Fail-fast semantics (Open Q2) — if either scan errors, the
/// other is dropped and the error propagates without a partial
/// response.
///
/// Empty / whitespace queries short-circuit to two empty partitions,
/// mirroring [`search_fts`].
///
/// `cancel` is an optional cancellation token threaded
/// through both partition scans into [`fts_fetch_rows`]. The Tauri
/// command wrapper (`search_blocks_partitioned`) stores a
/// [`CancellationGuard`] in the [`crate::cancellation::CancellationRegistry`]
/// and spawns the inner search via `tokio::spawn`; when the wrapper
/// future drops, the guard fires and both scans bail on their next
/// `tokio::select!` boundary.
///
/// [`search_fts`]: super::cursor::search_fts
/// [`fts_fetch_rows`]: super::fetch::fts_fetch_rows
/// [`CancellationGuard`]: crate::cancellation::CancellationGuard
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_fts_partitioned(
    pool: &SqlitePool,
    query: &str,
    page_limit: u32,
    block_limit: u32,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    metadata: &MetadataPredicates,
    with_snippet: bool,
    cancel: Option<CancellationToken>,
) -> Result<FtsPartitionedScan, AppError> {
    // Guard: empty/whitespace queries would cause an FTS5 syntax error.
    if query.trim().is_empty() {
        return Ok(FtsPartitionedScan {
            pages: Vec::new(),
            blocks: Vec::new(),
            pages_has_more: false,
            blocks_has_more: false,
        });
    }

    // Same up-front length cap as `search_fts`.
    if query.len() > MAX_QUERY_LEN {
        return Err(AppError::Validation(format!(
            "search query is too long ({} bytes); maximum is {MAX_QUERY_LEN} bytes",
            query.len()
        )));
    }

    let sanitized = sanitize_fts_query(query);

    // Guard: post-sanitisation may yield empty (e.g. all sub-trigram
    // tokens) — same short-circuit as `search_fts`.
    if sanitized.is_empty() {
        return Ok(FtsPartitionedScan {
            pages: Vec::new(),
            blocks: Vec::new(),
            pages_has_more: false,
            blocks_has_more: false,
        });
    }

    // Each scan independently caps at `MAX_SEARCH_RESULTS`
    // and asks for `limit + 1` to probe for overflow. `u64` math
    // protects against pathological `u32::MAX + 1` before the i64 cast.
    let pages_fetch_limit = limit_plus_one_capped(page_limit);
    let blocks_fetch_limit = limit_plus_one_capped(block_limit);

    // Run both scans concurrently. `try_join!` fails fast on the first
    // error — no partial response.
    let pages_future = fts_fetch_rows(
        pool,
        &sanitized,
        None, // no cursor — palette doesn't paginate
        0.0,
        "",
        pages_fetch_limit,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        Some("page"), // page-only pre-filter at SQL
        metadata,
        with_snippet,
        // P4 (#346) — the partitioned (palette) path always returns full
        // content; only the MCP cursor path opts into DB-side truncation.
        None,
        // Clone the cancel token so both partition scans
        // observe the same signal. `CancellationToken: Clone` is a
        // cheap watch::Receiver refcount bump.
        cancel.clone(),
    );
    let blocks_future = fts_fetch_rows(
        pool,
        &sanitized,
        None,
        0.0,
        "",
        blocks_fetch_limit,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        None, // unrestricted
        metadata,
        with_snippet,
        // P4 (#346) — see the pages partition above; full content here too.
        None,
        cancel,
    );
    let (pages_rows, blocks_rows) = tokio::try_join!(pages_future, blocks_future)?;

    // Clamp the comparison limit to the same
    // `MAX_SEARCH_RESULTS` ceiling the fetch was clamped to. The fetch
    // probes `min(limit, MAX_SEARCH_RESULTS) + 1` rows, so `has_more`
    // must be measured against the *clamped* limit; otherwise an
    // over-cap `limit` (e.g. 200) would compare a ≤ 101-row result
    // against 200 and never report `has_more`. The command layer
    // (`search_blocks_partitioned_inner`, BE-2) now rejects over-cap
    // limits up front, but this helper is also called directly in tests,
    // so the clamp keeps the probe self-consistent.
    let max_results_usize = usize::try_from(MAX_SEARCH_RESULTS).unwrap_or(usize::MAX);
    let page_limit_usize = usize::try_from(page_limit)
        .unwrap_or(usize::MAX)
        .min(max_results_usize);
    let block_limit_usize = usize::try_from(block_limit)
        .unwrap_or(usize::MAX)
        .min(max_results_usize);
    // `limit == 0` is a degenerate ask — the caller doesn't want any
    // rows from this partition, so there's nothing to "have more" of.
    // Without this guard the `limit + 1 = 1` probe would set
    // `has_more = true` against an empty result slice (existing
    // `partitioned_zero_limits_yield_empty_partitions_and_no_has_more`
    // contract).
    let pages_has_more = page_limit_usize > 0 && pages_rows.len() > page_limit_usize;
    let blocks_has_more = block_limit_usize > 0 && blocks_rows.len() > block_limit_usize;

    let pages: Vec<SearchBlockRow> = pages_rows
        .into_iter()
        .take(page_limit_usize)
        .map(fts_row_to_block_row)
        .collect();
    let blocks: Vec<SearchBlockRow> = blocks_rows
        .into_iter()
        .take(block_limit_usize)
        .map(fts_row_to_block_row)
        .collect();

    Ok(FtsPartitionedScan {
        pages,
        blocks,
        pages_has_more,
        blocks_has_more,
    })
}

/// Compute the per-partition fetch `LIMIT`: the effective page limit
/// (capped at [`MAX_SEARCH_RESULTS`]) **plus one**, so the caller can
/// detect overflow against its own (also-capped) limit.
///
/// The previous implementation computed
/// `min(limit + 1, MAX_SEARCH_RESULTS)`, which at the boundary
/// (`limit == 100`) collapsed to `min(101, 100) = 100`. With a fetch
/// limit equal to the cap, `rows.len() > limit` could never be true, so
/// `has_more` was *always false* at exactly the cap (the single-partition
/// `search_fts` path adds the +1 *after* capping and so was already
/// correct — the two disagreed). The fix caps the limit first and adds
/// the probe row afterwards: `min(limit, MAX_SEARCH_RESULTS) + 1`, which
/// yields `101` at the cap and lets the probe see one extra row.
fn limit_plus_one_capped(limit: u32) -> i64 {
    let max_results_u64 = u64::try_from(MAX_SEARCH_RESULTS).unwrap_or(u64::MAX);
    let capped_limit = u64::from(limit).min(max_results_u64);
    let probe = capped_limit.saturating_add(1);
    i64::try_from(probe).unwrap_or(MAX_SEARCH_RESULTS)
}
