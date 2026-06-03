//! PEND-55 — toggle row pipeline for `Aa` / `Ab|` / `.*` search modes.
//!
//! Sits between [`crate::commands::search_blocks_inner`] and the two
//! candidate-set sources (FTS5 for the literal/whole-word/case-sensitive
//! path; recency-ordered SQL scan for the regex path). The default
//! (all-toggles-off) value short-circuits to today's
//! [`super::search::search_fts`] result — zero overhead.
//!
//! ## Pipeline shape
//!
//! ```text
//!                    ┌────────────────────────────────────┐
//!                    │ search_blocks_inner (queries.rs)   │
//!                    └─────────────┬──────────────────────┘
//!                                  │ SearchToggles
//!                       ┌──────────┴──────────────┐
//!                       │ search_with_toggles     │
//!                       └──┬───────────────────┬──┘
//!                          │                   │
//!                  off ────┘                   └──── any toggle on
//!                          │                   │
//!                          ▼                   ▼
//!                  search_fts (FTS5)   compose_post_filter
//!                          │                   │
//!                          └────────┬──────────┘
//!                                   ▼
//!                          post_filter_results
//!                          (offsets + caps)
//! ```
//!
//! ## Caps (all locked-in via constants)
//!
//! - [`MAX_PATTERN_LEN`] — reject patterns > 1 KiB up front before
//!   handing the string to `regex::RegexBuilder` so a degenerate
//!   client can't trigger megabyte-scale parser work.
//! - [`REGEX_SIZE_LIMIT_BYTES`] — handed to
//!   `RegexBuilder::size_limit`; matches the plan's
//!   `10 * 1024 * 1024` recommendation and bounds compiled-DFA memory.
//! - [`REGEX_DFA_SIZE_LIMIT_BYTES`] — bounds the lazy-DFA cache.
//! - [`MAX_OFFSETS_PER_BLOCK`] — caps the per-row offset vector so
//!   `.` against a long block doesn't balloon the IPC payload.
//! - [`REGEX_PRE_FILTER_CAP`] — bounds the regex-mode pre-filter
//!   row count so a worst-case scan stays sub-second on personal-
//!   notes-scale corpora.
//!
//! ## UTF-16 offset emission
//!
//! Rust string slicing uses byte indices; JavaScript indexes UTF-16
//! code units. Emit UTF-16 offsets so the frontend can splice
//! `row.content.substring(start, end)` against the same string it
//! rendered. See [`byte_to_utf16_offsets`].

use crate::commands::{MatchOffset, SearchBlockRow};
use crate::error::AppError;
use crate::pagination::{PageRequest, PageResponse};
use regex::{Regex, RegexBuilder};
use sqlx::SqlitePool;

use super::metadata_filter::MetadataPredicates;

/// Bundle of the three PEND-55 search toggles.
///
/// The all-false value reproduces the pre-PEND-55 FTS-only behaviour
/// (zero overhead — `search_with_toggles` short-circuits before
/// invoking the post-filter).
#[derive(Debug, Clone, Copy, Default)]
pub struct SearchToggles {
    /// PEND-55 — case-sensitive post-filter (FTS5 trigram tokenizer is
    /// `case_sensitive 0`, so this always forces the regex pass).
    pub case_sensitive: bool,
    /// PEND-55 — ASCII whole-word boundary via `(?-u:\b)`. CJK runs
    /// don't match `\b`; documented as v1 behaviour.
    pub whole_word: bool,
    /// PEND-55 — regex-mode. FTS5 MATCH is bypassed; candidates come
    /// from a recency-ordered SQL scan capped at
    /// [`REGEX_PRE_FILTER_CAP`].
    pub is_regex: bool,
}

impl SearchToggles {
    /// `true` iff any toggle is on. Used to gate the post-filter cost.
    #[must_use]
    pub fn any(&self) -> bool {
        self.case_sensitive || self.whole_word || self.is_regex
    }
}

/// Maximum length of the user-supplied regex pattern (in bytes).
///
/// Rejected up-front before invoking `RegexBuilder` so a pathological
/// client cannot force the parser to walk a megabyte-scale input. 1 KiB
/// is well above realistic hand-written patterns (the longest VS Code
/// preset regex is < 200 bytes).
pub const MAX_PATTERN_LEN: usize = 1024;

/// `RegexBuilder::size_limit` cap. Plan recommendation: `10 * 1024 *
/// 1024`. Caps the compiled regex's in-memory representation so a
/// repetition like `(a|b|c|...){200}` fails compilation instead of
/// allocating gigabytes.
pub const REGEX_SIZE_LIMIT_BYTES: usize = 10 * 1024 * 1024;

/// `RegexBuilder::dfa_size_limit` cap. Matches `size_limit`; the
/// lazy-DFA cache occupies a comparable budget at runtime.
pub const REGEX_DFA_SIZE_LIMIT_BYTES: usize = 10 * 1024 * 1024;

/// Maximum number of per-row match offsets emitted on the wire.
///
/// Prevents `.` against a long block from emitting thousands of
/// offsets and ballooning the IPC payload. Trailing matches are
/// dropped; the frontend documents this as "highlights truncated".
pub const MAX_OFFSETS_PER_BLOCK: usize = 50;

/// Pre-filter cap for the regex-mode SQL scan. Bounds the worst-case
/// wall-time of a regex that doesn't have a literal seed.
///
/// `10 * MAX_SEARCH_RESULTS` so the post-cap can still fill a page of
/// 100 results from a dense match. Document in `docs/SEARCH.md`.
pub const REGEX_PRE_FILTER_CAP: i64 = 1000;

/// Public entry-point. Dispatches between the FTS5 path
/// (`super::search::search_fts`) and the regex-mode path
/// ([`regex_mode_query`]) based on `toggles.is_regex`, then applies
/// the post-FTS filter when any non-regex toggle is on.
#[allow(clippy::too_many_arguments)]
pub async fn search_with_toggles(
    pool: &SqlitePool,
    query: &str,
    page: &PageRequest,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    toggles: SearchToggles,
    block_type_filter: Option<&str>,
    metadata: &MetadataPredicates,
    // P4 (#346) — `Some(n)` truncates each result's `content` to the first
    // `n` codepoints. The plain-FTS / filter-only / regex paths push the
    // `substr(b.content, 1, n)` into SQL; the toggle post-filter path keeps
    // full content for regex matching and truncates survivors afterwards
    // (see the post-filter branch). The FE/IPC path passes `None`
    // (full content); the MCP `search` tool passes `Some(SEARCH_SNIPPET_CAP)`.
    snippet_len: Option<usize>,
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    // PEND-58g NEW-3 — a blank free-text query has nothing for FTS5
    // MATCH (cannot express "match all") or the regex engine (an empty
    // pattern matches everything) to act on, so dispatch BEFORE the
    // mode branch: with at least one STRUCTURAL filter, return the
    // structurally-filtered blocks recency-ordered (mode-independent);
    // with NO filter, preserve the prior behaviour of returning empty
    // (never the whole DB). `space_id` is always supplied (FEAT-3p4) so
    // it is NOT a user filter and is excluded from `has_filters`.
    if query.trim().is_empty() {
        let has_filters = parent_id.is_some()
            || tag_ids.is_some_and(|t| !t.is_empty())
            || !include_page_globs.is_empty()
            || !exclude_page_globs.is_empty()
            || block_type_filter.is_some()
            || !metadata.is_empty();
        if !has_filters {
            return Ok(PageResponse {
                items: vec![],
                next_cursor: None,
                has_more: false,
                total_count: None,
            });
        }
        return fts_fetch_filter_only_page(
            pool,
            page,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            block_type_filter,
            metadata,
            snippet_len,
        )
        .await;
    }

    if toggles.is_regex {
        // PEND-69 F2 — `block_type_filter` is now pushed into the
        // regex SQL builder so we don't drag the full 1000-row
        // pre-filter window through Rust just to discard non-matching
        // types. Removes the post-fetch `Vec::retain()` that lived
        // here previously.
        let response = regex_mode_query(
            pool,
            query,
            page,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            toggles,
            block_type_filter,
            metadata,
            snippet_len,
        )
        .await?;
        return Ok(response);
    }

    if !toggles.any() {
        // All toggles off → straight FTS path verbatim (zero overhead).
        return super::search::search_fts(
            pool,
            query,
            page,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            block_type_filter,
            metadata,
            snippet_len,
        )
        .await;
    }

    // SQL-A3 / BE-A1 (PEND-58f) — `case_sensitive` and/or `whole_word`
    // on. The previous shape called `search_fts` (which fixed
    // `has_more` / `next_cursor` on a `limit + 1` candidate window) and
    // THEN dropped non-matching rows, which under-filled the page and
    // permanently lost survivors dropped inside the window (the next
    // page's cursor pointed past them). Instead use
    // `fts_fetch_post_filtered_page`, which walks candidate windows,
    // applies the post-filter per row, and computes `has_more` /
    // `next_cursor` from the SURVIVOR set so the page is full up to
    // `limit` and no survivor is skipped across pages.
    let pattern = compose_literal_pattern(query, toggles);
    let re = build_regex(&pattern)?;
    let mut response = super::search::fts_fetch_post_filtered_page(
        pool,
        query,
        page,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        block_type_filter,
        metadata,
        |row| post_filter_row(row, &re),
    )
    .await?;
    // P4 (#346) — the post-filter regex matched against FULL content (so
    // matches / offsets beyond `snippet_len` are correct), but the MCP
    // caller still wants the shipped `content` truncated. Apply the cut in
    // Rust here (codepoint-safe, same `substr(content, 1, n)` semantics as
    // the SQL paths) only for the survivors that survived the post-filter.
    truncate_row_content(&mut response.items, snippet_len);
    Ok(response)
}

/// P4 (#346) — codepoint-safe content truncation applied in Rust for the
/// toggle post-filter path (the only `search_with_toggles` branch that must
/// match its regex against full content before truncating output).
///
/// Mirrors the SQL `substr(content, 1, n)` semantics: keep the first `n`
/// Unicode scalar values of each row's `content`. `None` is a no-op (full
/// content). Rows with `content == None` are left untouched.
fn truncate_row_content(rows: &mut [SearchBlockRow], snippet_len: Option<usize>) {
    let Some(n) = snippet_len else { return };
    for row in rows.iter_mut() {
        if let Some(ref content) = row.content {
            // Only reallocate when the content actually exceeds `n`
            // codepoints; `chars().count()` short-circuits on the common
            // already-short case via the take/collect below.
            if content.chars().count() > n {
                row.content = Some(content.chars().take(n).collect());
            }
        }
    }
}

/// PEND-61 Phase 1 / PEND-69 F1 — partitioned sibling of
/// [`search_with_toggles`].
///
/// Returns two pre-partitioned candidate sets (pages-only +
/// unrestricted) via two parallel scans. Each partition's `has_more`
/// is derived from a `limit + 1` probe (PEND-69 Open Q3) so the
/// frontend can paginate accurately without inferring from the global
/// SQL ceiling.
///
/// Toggle dispatch mirrors [`search_with_toggles`]:
///
/// - `is_regex` → two parallel [`regex_mode_query`] scans; the pages
///   scan pushes `block_type = 'page'` into SQL (PEND-69 F2) instead
///   of post-fetch `Vec::retain()`. Each scan asks for `limit + 1`.
/// - `case_sensitive` / `whole_word` → FTS5 candidate set narrowed by
///   the post-filter regex pass. Snippets are omitted at SQL build
///   time (PEND-69 F5) because `apply_post_filter` clears them anyway.
/// - All toggles off → straight FTS5 partitioned scan, snippets kept.
///
/// Returns a [`FtsPartitionedScan`] with per-partition `has_more`.
///
/// PEND-70 — `cancel` is an optional cancellation token threaded into
/// the FTS path. BE-A4 (PEND-58f) — the regex-mode branch now honours
/// the same token: it checks `is_cancelled()` up front (mirroring
/// `fts_fetch_rows`' early-cancel) and races the two parallel regex
/// scans against `cancel.cancelled()` via a `biased` `tokio::select!`,
/// returning [`AppError::Cancelled`] when the signal fires — the exact
/// outcome the FTS path returns.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_with_toggles_partitioned(
    pool: &SqlitePool,
    query: &str,
    page_limit: u32,
    block_limit: u32,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    toggles: SearchToggles,
    metadata: &MetadataPredicates,
    cancel: Option<crate::cancellation::CancellationToken>,
) -> Result<super::search::FtsPartitionedScan, AppError> {
    // PEND-58g NEW-3 — blank free-text query dispatch (mode-independent),
    // mirroring `search_with_toggles`. This path has NO `block_type_filter`
    // param (partitioning handles block_type), so it is excluded from
    // `has_filters`; `space_id` is always supplied (FEAT-3p4) and excluded
    // too. With NO user filter, preserve the prior empty-partitions
    // behaviour; with at least one filter, return the structurally-
    // filtered partitions recency-ordered.
    if query.trim().is_empty() {
        let has_filters = parent_id.is_some()
            || tag_ids.is_some_and(|t| !t.is_empty())
            || !include_page_globs.is_empty()
            || !exclude_page_globs.is_empty()
            || !metadata.is_empty();
        if !has_filters {
            return Ok(super::search::FtsPartitionedScan {
                pages: Vec::new(),
                blocks: Vec::new(),
                pages_has_more: false,
                blocks_has_more: false,
            });
        }
        if let Some(ref token) = cancel {
            if token.is_cancelled() {
                return Err(AppError::Cancelled);
            }
        }
        return fts_fetch_filter_only_partitioned(
            pool,
            page_limit,
            block_limit,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            metadata,
        )
        .await;
    }

    if toggles.is_regex {
        // BE-A4 (PEND-58f) — early-cancel before launching the scans,
        // mirroring `fts_fetch_rows`' up-front `is_cancelled()` check.
        // The palette's next-keystroke pattern fires fresh IPCs faster
        // than the scans can start, so bail before doing any work.
        if let Some(ref token) = cancel {
            if token.is_cancelled() {
                return Err(AppError::Cancelled);
            }
        }
        // PEND-69 F1 — two parallel regex scans, each with a
        // `limit + 1` probe. The pages scan pushes
        // `block_type = 'page'` into SQL (PEND-69 F2). `REGEX_PRE_FILTER_CAP`
        // still bounds each scan's worst-case row count.
        let pages_page = PageRequest::new(None, Some(probe_limit_i64(page_limit)))?;
        let blocks_page = PageRequest::new(None, Some(probe_limit_i64(block_limit)))?;
        let pages_future = regex_mode_query(
            pool,
            query,
            &pages_page,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            toggles,
            Some("page"),
            metadata,
            // P4 (#346) — partitioned (palette) path always returns full content.
            None,
        );
        let blocks_future = regex_mode_query(
            pool,
            query,
            &blocks_page,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            toggles,
            None,
            metadata,
            // P4 (#346) — partitioned (palette) path always returns full content.
            None,
        );
        // BE-A4 (PEND-58f) — race the two parallel scans against the
        // cancel signal so an in-flight regex burst bails the same way
        // the FTS path does (`fts_fetch_rows` uses the identical
        // `biased` `tokio::select!` shape). The `try_join!` is kept as a
        // *future* (not awaited yet) so the scans run concurrently with
        // the cancel watcher; `biased;` polls the cancel arm first each
        // tick so a fast-fire from the next keystroke wins against an
        // already-ready join. When the cancel arm fires, the joined
        // future is dropped, cancelling both underlying SQL statements
        // at their next yield point, and we return
        // [`AppError::Cancelled`] — the exact outcome the FTS path
        // returns. When `cancel` is `None` we preserve the pre-BE-A4
        // behaviour (plain `try_join!`).
        let join_future = async { tokio::try_join!(pages_future, blocks_future) };
        let (pages_resp, blocks_resp) = match cancel {
            Some(mut token) => {
                tokio::select! {
                    biased;
                    () = token.cancelled() => {
                        return Err(AppError::Cancelled);
                    }
                    res = join_future => res?,
                }
            }
            None => join_future.await?,
        };

        let page_limit_usize = usize::try_from(page_limit).unwrap_or(usize::MAX);
        let block_limit_usize = usize::try_from(block_limit).unwrap_or(usize::MAX);
        // `limit == 0` — same degenerate-ask guard as the FTS path;
        // the caller asked for nothing, so don't claim there's more.
        let pages_has_more = page_limit_usize > 0 && pages_resp.items.len() > page_limit_usize;
        let blocks_has_more = block_limit_usize > 0 && blocks_resp.items.len() > block_limit_usize;

        let mut pages = pages_resp.items;
        pages.truncate(page_limit_usize);
        let mut blocks = blocks_resp.items;
        blocks.truncate(block_limit_usize);
        return Ok(super::search::FtsPartitionedScan {
            pages,
            blocks,
            pages_has_more,
            blocks_has_more,
        });
    }

    if !toggles.any() {
        // All toggles off → straight FTS partitioned scan, snippets kept
        // (zero overhead).
        return super::search::search_fts_partitioned(
            pool,
            query,
            page_limit,
            block_limit,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            metadata,
            true,
            cancel,
        )
        .await;
    }

    // SQL-A3 / BE-A1 (PEND-58f) — `case_sensitive` and/or `whole_word`
    // on. This path has NO cursor (the palette doesn't paginate), so it
    // cannot fetch successive windows like the cursor path. The previous
    // shape fetched only `limit + 1` candidates per partition and then
    // dropped non-matching rows, which under-filled each partition AND
    // derived `has_more` from the pre-filter count (so a partition could
    // report `has_more = true` while rendering far fewer than `limit`
    // survivors). Instead OVER-FETCH up to the `MAX_SEARCH_RESULTS`
    // ceiling per partition BEFORE the post-filter, then truncate to the
    // partition limit and derive `has_more` from the SURVIVOR count.
    //
    // This is best-effort within the over-fetch ceiling: lacking a
    // cursor, if a partition's survivors are sparser than `limit` within
    // the newest `MAX_SEARCH_RESULTS` candidates, matches beyond that
    // ceiling are not surfaced (documented trade-off, same spirit as the
    // regex-mode `REGEX_PRE_FILTER_CAP`).
    let overfetch = u32::try_from(super::search::MAX_SEARCH_RESULTS).unwrap_or(u32::MAX);

    // PEND-69 F5 — snippets are clobbered to `None` by the post-filter,
    // so omit the SQL `snippet()` call (skips the per-row tokenizer walk).
    let mut scan = super::search::search_fts_partitioned(
        pool,
        query,
        overfetch,
        overfetch,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        metadata,
        false,
        cancel,
    )
    .await?;

    let pattern = compose_literal_pattern(query, toggles);
    let re = build_regex(&pattern)?;
    apply_post_filter(&mut scan.pages, &re);
    apply_post_filter(&mut scan.blocks, &re);

    // Derive `has_more` from the SURVIVOR count against the caller's real
    // per-partition limit, then truncate to that limit. `limit == 0` is a
    // degenerate ask (mirrors the FTS path's guard) — nothing to "have
    // more" of.
    let page_limit_usize = usize::try_from(page_limit).unwrap_or(usize::MAX);
    let block_limit_usize = usize::try_from(block_limit).unwrap_or(usize::MAX);
    let pages_has_more = page_limit_usize > 0 && scan.pages.len() > page_limit_usize;
    let blocks_has_more = block_limit_usize > 0 && scan.blocks.len() > block_limit_usize;
    scan.pages.truncate(page_limit_usize);
    scan.blocks.truncate(block_limit_usize);
    scan.pages_has_more = pages_has_more;
    scan.blocks_has_more = blocks_has_more;
    Ok(scan)
}

/// PEND-69 F1 — compute the `limit + 1` probe value for a regex-mode
/// pre-filter scan as an `i64` clamped to fit
/// [`PageRequest::new`]'s domain.
fn probe_limit_i64(limit: u32) -> i64 {
    let raw: u64 = u64::from(limit).saturating_add(1);
    i64::try_from(raw).unwrap_or(i64::MAX)
}

/// Compose the post-FTS regex pattern for the **non-regex** toggle
/// combinations (i.e. one or both of `case_sensitive` / `whole_word`).
///
/// The user input is escaped via [`regex::escape`] so the FTS-mode
/// path never interprets metacharacters; only the regex-mode path
/// accepts metacharacters verbatim.
///
/// SQL-5 (PEND-58f) — the input is NFC-normalised before escaping so a
/// pasted NFD literal matches the same way the FTS path's NFC query
/// would (the post-filter still runs against the raw FTS row content;
/// see the contract note in [`regex_mode_query`]).
fn compose_literal_pattern(query: &str, toggles: SearchToggles) -> String {
    let normalised = super::strip::nfc_normalise(query);
    let escaped = regex::escape(&normalised);
    let prefix = if toggles.case_sensitive {
        "(?-i)"
    } else {
        "(?i)"
    };
    if toggles.whole_word {
        // `(?-u:\b)` — explicit ASCII word boundary. CJK content does
        // NOT match (documented v1 limitation).
        format!("{prefix}(?-u:\\b){escaped}(?-u:\\b)")
    } else {
        format!("{prefix}{escaped}")
    }
}

/// Compile a user-supplied regex pattern through the capped
/// [`RegexBuilder`] and map errors onto
/// [`AppError::Validation`] with the typed `InvalidRegex:` prefix.
pub(crate) fn build_regex(pattern: &str) -> Result<Regex, AppError> {
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(AppError::Validation(format!(
            "InvalidRegex: pattern length {} exceeds cap {MAX_PATTERN_LEN}",
            pattern.len()
        )));
    }
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT_BYTES)
        .dfa_size_limit(REGEX_DFA_SIZE_LIMIT_BYTES)
        .build()
        .map_err(|e| AppError::Validation(format!("InvalidRegex: {e}")))
}

/// Apply a compiled regex to the rows in-place — narrows the candidate
/// set to only those rows whose `content` matches, and attaches
/// UTF-16 match offsets.
fn apply_post_filter(rows: &mut Vec<SearchBlockRow>, re: &Regex) {
    rows.retain_mut(|row| post_filter_row(row, re));
}

/// SQL-A3 / BE-A1 (PEND-58f) — per-row post-filter predicate, extracted
/// from [`apply_post_filter`] so the filter-aware cursor pagination loop
/// ([`super::search::fts_fetch_post_filtered_page`]) can apply the same
/// logic one row at a time while tracking each survivor's rank.
///
/// Returns `true` to KEEP the row (after mutating its `match_offsets` and
/// clearing `snippet`) and `false` to DROP it (no content, or no
/// non-zero-width match).
fn post_filter_row(row: &mut SearchBlockRow, re: &Regex) -> bool {
    let Some(content) = row.content.as_deref() else {
        // No content → cannot match a post-filter regex. Drop.
        return false;
    };
    let byte_matches: Vec<(usize, usize)> = re
        .find_iter(content)
        // Drop zero-width matches — they don't produce a
        // meaningful highlight (locked in by the plan).
        .filter(|m| m.end() > m.start())
        .take(MAX_OFFSETS_PER_BLOCK)
        .map(|m| (m.start(), m.end()))
        .collect();
    if byte_matches.is_empty() {
        return false;
    }
    let utf16 = byte_to_utf16_offsets(content, &byte_matches);
    row.match_offsets = utf16;
    // Clear the FTS snippet — the frontend prefers offsets when
    // present, but clearing the snippet means a pre-PEND-55
    // frontend bundle won't double-render the highlight via two
    // paths.
    row.snippet = None;
    true
}

/// Convert `(byte_start, byte_end)` pairs into UTF-16 code-unit offsets.
///
/// Walks the string once via `char_indices`, building a byte-to-UTF-16
/// table on the fly. ASCII-only content is a no-op (`len_utf16 == 1`,
/// `byte == utf16_index`).
pub(crate) fn byte_to_utf16_offsets(
    text: &str,
    byte_matches: &[(usize, usize)],
) -> Vec<MatchOffset> {
    if byte_matches.is_empty() {
        return Vec::new();
    }
    // Build a `byte_index → utf16_index` map. Sized for the full
    // string length + 1 (end sentinel) so callers can index past the
    // last byte for end positions.
    let mut byte_to_u16: Vec<u32> = Vec::with_capacity(text.len() + 1);
    let mut u16_pos: u32 = 0;
    for (b_idx, c) in text.char_indices() {
        while byte_to_u16.len() <= b_idx {
            byte_to_u16.push(u16_pos);
        }
        // `c.len_utf16()` returns 1 (BMP) or 2 (surrogate pair) — always fits a u32.
        u16_pos = u16_pos.saturating_add(u32::try_from(c.len_utf16()).unwrap_or(0));
    }
    // Final sentinel — end-of-string maps to the total UTF-16 length.
    while byte_to_u16.len() <= text.len() {
        byte_to_u16.push(u16_pos);
    }

    byte_matches
        .iter()
        .map(|&(s, e)| MatchOffset {
            start: byte_to_u16.get(s).copied().unwrap_or(u16_pos),
            end: byte_to_u16.get(e).copied().unwrap_or(u16_pos),
        })
        .collect()
}

/// PEND-55 — regex-mode query path. **Bypasses FTS5 entirely**: FTS5
/// MATCH cannot accept a regex, so we run a recency-ordered SQL scan
/// over the structurally-filtered block set and apply the user's
/// regex post-hoc.
///
/// Wall-time scales with the structurally-filtered block count, not
/// the FTS candidate count. The pre-filter cap
/// ([`REGEX_PRE_FILTER_CAP`]) bounds the worst case.
///
/// PEND-69 F2 — `block_type_filter` is pushed into the SQL WHERE
/// clause so a page-only regex query doesn't waste the 1000-row
/// pre-filter budget on content blocks that would be dropped client-
/// side. The caller passes `Some("page")` for the pages partition,
/// `None` for the unrestricted set.
#[allow(clippy::too_many_arguments)]
async fn regex_mode_query(
    pool: &SqlitePool,
    query: &str,
    page: &PageRequest,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    toggles: SearchToggles,
    block_type_filter: Option<&str>,
    metadata: &MetadataPredicates,
    // P4 (#346) — `Some(n)` truncates each emitted row's `content` to the
    // first `n` codepoints. The regex matches against FULL `blocks.content`
    // (so matches / offsets are correct), then the truncation is applied
    // when the output row is built — NOT pushed into the SQL `SELECT`,
    // which would let the regex see only the truncated prefix.
    snippet_len: Option<usize>,
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    // SQL-5 (PEND-58f) — **contract**: regex mode runs the user's
    // pattern against the **raw `blocks.content`** column, NOT against
    // the stripped / reference-resolved / NFC-normalised text that the
    // FTS5 index (`fts_blocks.stripped`, written by
    // `strip_for_fts_with_maps`) matches. The two search modes therefore
    // see DIFFERENT text for the same block, with three concrete
    // consequences the caller must understand:
    //
    //   1. **Reference tokens are visible to regex, invisible to FTS.**
    //      A `#[ULID]` tag/page reference is left verbatim in
    //      `blocks.content` but resolved to its target name in the FTS
    //      index. A regex on a tag/page *name* will MISS a block that
    //      only references that name via `#[ULID]`; FTS would match it.
    //   2. **Raw markdown is matchable by regex only.** Markup the FTS
    //      strip pass removes (link syntax, formatting markers) is still
    //      present in `blocks.content`, so a regex can match it.
    //   3. **NFC/NFD.** `blocks.content` is stored as the user typed it
    //      (may be NFD, e.g. a macOS paste); the FTS index is NFC. We
    //      NFC-normalise the *pattern* below (cheap, safe) so an
    //      NFC-typed pattern reaches NFC content consistently, but we do
    //      NOT normalise the stored content on this path — a regex
    //      against NFD-stored content can still diverge from FTS.
    //
    // Changing the column scanned (stripped vs raw) is a behaviour change
    // deliberately out of scope here; this comment is the documented
    // contract. See `docs/SEARCH.md`'s regex-mode section.

    // SQL-A4 (PEND-58f) — reject an over-long RAW pattern up front,
    // BEFORE the NFC-normalise + regex-compile walk. Mirrors the FTS
    // path's `MAX_QUERY_LEN` guard (`search_fts` / `search_fts_partitioned`)
    // so a pathological multi-megabyte raw input is rejected before we
    // pay to normalise it. `build_regex` already caps the *composed*
    // pattern at `MAX_PATTERN_LEN`, but that check runs only after
    // normalisation; this up-front guard bounds the normalise work too.
    // Same byte-length basis and error shape as the FTS path.
    if query.len() > super::search::MAX_QUERY_LEN {
        return Err(AppError::Validation(format!(
            "search query is too long ({} bytes); maximum is {} bytes",
            query.len(),
            super::search::MAX_QUERY_LEN
        )));
    }

    // NFC-normalise the user pattern so a composed pattern (e.g. a paste
    // containing NFD diacritics) is canonical before regex compilation.
    let query_nfc = super::strip::nfc_normalise(query);
    let query: &str = &query_nfc;

    // Compose the final regex. `case_sensitive` flips the (?i) flag;
    // `whole_word` wraps in `(?-u:\b)`. The user's input is the regex
    // pattern verbatim (NOT escaped).
    let mut pattern = String::with_capacity(query.len() + 16);
    if toggles.case_sensitive {
        pattern.push_str("(?-i)");
    } else {
        pattern.push_str("(?i)");
    }
    if toggles.whole_word {
        pattern.push_str("(?-u:\\b)(?:");
        pattern.push_str(query);
        pattern.push_str(")(?-u:\\b)");
    } else {
        // PEND-73 Phase 1.B7 — wrap the user pattern in a non-capturing
        // group so a leading inline flag in the user's input (e.g.
        // `(?i)foo|bar`) cannot rebind the case flag we just emitted
        // and bleed precedence across the top-level `|`. Symmetric with
        // the whole-word branch above.
        pattern.push_str("(?:");
        pattern.push_str(query);
        pattern.push(')');
    }
    let re = build_regex(&pattern)?;

    // Build a recency-ordered SQL scan with the structural filters
    // applied. We do not use cursor pagination on this path (the
    // candidate set is bounded by `REGEX_PRE_FILTER_CAP`); the
    // `next_cursor` field returns `None`.
    //
    // SQL-A2 (PEND-58f) — the upper clamp is `MAX_SEARCH_RESULTS + 1`,
    // NOT `MAX_SEARCH_RESULTS`. The partitioned regex caller
    // (`search_with_toggles_partitioned`) passes a `limit + 1` PROBE
    // (`probe_limit_i64`) so it can detect overflow against its own
    // per-partition cap. With the previous `clamp(1, 100)` that probe
    // collapsed back to 100 at the cap, so a partition could return at
    // most 100 survivors and `items.len() > page_limit` (100 > 100) was
    // never true — `has_more` was dead at exactly `MAX_SEARCH_RESULTS`.
    // Allowing one extra row through lets the probe see the (cap+1)th
    // match. The cursor regex path (via `search_with_toggles`) is still
    // capped at `MAX_SEARCH_RESULTS`: its `page.limit` is the validated
    // user limit, which SQL-A1 rejects above 100, so the clamp never
    // lifts it past the cap there.
    let limit = page.limit.clamp(1, super::search::MAX_SEARCH_RESULTS + 1);

    let mut sql = String::from(
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                  b.deleted_at, b.todo_state, b.priority, b.due_date,
                  b.scheduled_date, b.page_id
           FROM blocks b
           WHERE b.deleted_at IS NULL
             AND b.content IS NOT NULL"#,
    );

    // M2 (#348) — `StructuralFilterBuilder` owns the dynamic fragment,
    // the running `?N` index, and the ordered binds atomically (no
    // separate hand-tracked bind pass to drift out of sync). This
    // builder has no fixed base params, so dynamic filters start at
    // `?1`; the 13-space `AND ` prefix preserves the exact pre-M2 SQL.
    const PREFIX: &str = "\n             AND ";
    let mut fb = super::filter_builder::StructuralFilterBuilder::new(1);

    fb.add_parent(PREFIX, parent_id);

    // SQL-1 (PEND-58f) — dedupe `tag_ids` before binding, mirroring the
    // FTS path in `fts::search::fts_fetch_rows`. The "ALL tags" predicate
    // compares `COUNT(DISTINCT bt.tag_id)` against the bound list length;
    // a duplicate id makes that length unachievable and the regex scan
    // silently returns zero rows. Order is preserved for deterministic
    // placeholder/bind indices.
    //
    // SQL-A6 (PEND-58f) — normalise each id to its canonical UPPERCASE
    // ULID form BEFORE inserting into the dedup set (and bind the
    // normalised form). `block_tags.tag_id` stores the canonical
    // uppercase Crockford-base32 ULID (`BlockId`/`ActiveBlockId` both
    // normalise via `to_ascii_uppercase`), so a mixed-case duplicate
    // (e.g. the same id arriving lower- and upper-case from two FE code
    // paths) would otherwise survive byte-exact dedup, inflate the bound
    // list length past the achievable `COUNT(DISTINCT)`, and silently
    // zero out the ALL-tags predicate. Uppercasing collapses the
    // duplicate AND aligns the bound `IN (...)` values with the stored
    // canonical form.
    let tag_ids_active: Vec<String> = match tag_ids.filter(|t| !t.is_empty()) {
        Some(ids) => {
            let mut seen = std::collections::HashSet::new();
            ids.iter()
                .map(|id| id.to_ascii_uppercase())
                .filter(|id| seen.insert(id.clone()))
                .collect()
        }
        None => Vec::new(),
    };
    fb.add_tags_all(PREFIX, &tag_ids_active);

    fb.add_space(PREFIX, space_id);

    // P2 (#346) — shared page-glob sub-select helper (via the builder).
    fb.add_page_globs(PREFIX, false, include_page_globs);
    fb.add_page_globs(PREFIX, true, exclude_page_globs);

    // PEND-53 — metadata predicates (same shape as `search_fts`).
    fb.add_metadata(metadata, "b");

    // PEND-69 F2 — push `block_type` into SQL instead of post-fetch
    // `Vec::retain()`. Eliminates the 1000-row drag for page-only
    // regex queries where matching pages live beyond the pre-filter
    // cap. NOTE: emitted AFTER metadata in this builder (the FTS builder
    // emits it before) — the builder records each fragment's binds in
    // call order, so this ordering difference stays self-consistent.
    fb.add_block_type(PREFIX, block_type_filter);

    sql.push_str(fb.sql());

    let cap_idx = fb.next_param();
    // PEND-55 — ULID prefixes are monotonically time-sortable, so
    // `ORDER BY b.id DESC` yields most-recent-first without a
    // dedicated `created_at` column (the `blocks` table doesn't carry
    // one — see migration `0001_initial.sql`). Document this in
    // `docs/SEARCH.md`'s regex-mode trade-off section.
    //
    // IX3 (#347) — EQP verified on a 6k-row seed (5k alive+content):
    // this scan already runs `SCAN … USING INDEX sqlite_autoindex_blocks_1`
    // (the `id` PK) with NO temp B-tree — the PK walk satisfies
    // `ORDER BY b.id DESC` directly. A partial `idx_blocks_alive_content
    // ON blocks(id) WHERE deleted_at IS NULL AND content IS NOT NULL`
    // *is* picked by the planner and removes residual-predicate
    // rejection, but only helps measurably when a large fraction of the
    // highest-id blocks are soft-deleted / content-less; in the common
    // high-alive case the PK scan reaches the 1000-row cap almost
    // immediately. Marginal + write-amplifying — left as a low-priority
    // follow-up, NOT added here (no migration in this group).
    sql.push_str(&format!(
        "\n           ORDER BY b.id DESC\n           LIMIT ?{cap_idx}"
    ));

    // M2 (#348) — base query has no fixed params; the builder replays
    // every dynamic filter bind in declaration order, then the trailing
    // `LIMIT ?cap_idx` cap is bound last (its placeholder index was
    // reserved last via `fb.next_param()`).
    let db_query = sqlx::query_as::<_, RegexScanRow>(sqlx::AssertSqlSafe(sql.as_str()));
    let db_query = fb.apply(db_query);
    let db_query = db_query.bind(REGEX_PRE_FILTER_CAP);

    let rows = db_query.fetch_all(pool).await.map_err(AppError::Database)?;

    // SQL-8 (PEND-58f) — the SQL scan returns at most the newest
    // `REGEX_PRE_FILTER_CAP` (1000) structurally-filtered rows, ordered
    // `b.id DESC` (recency). If the scan returns *exactly* the cap, there
    // were at least that many candidate rows and OLDER matches beyond the
    // window are silently invisible — yet this path always reports
    // `has_more: false` (it emits no cursor; the candidate set is
    // intentionally bounded). We cannot surface a richer truncation
    // signal without changing the `PageResponse` wire type (which would
    // force a `bindings.ts` regen, out of scope here), so for now we emit
    // a `warn!` breadcrumb when the window is saturated. Wiring a typed
    // truncation flag onto the wire is DEFERRED to a follow-up that
    // touches the IPC surface.
    let prefilter_cap_usize = usize::try_from(REGEX_PRE_FILTER_CAP).unwrap_or(usize::MAX);
    if rows.len() >= prefilter_cap_usize {
        tracing::warn!(
            prefilter_cap = REGEX_PRE_FILTER_CAP,
            "regex-mode pre-filter window saturated — matches older than the \
             newest {REGEX_PRE_FILTER_CAP} structurally-filtered blocks are not \
             scanned (has_more reported false; no truncation signal on the wire)"
        );
    }

    // Run the regex post-filter. Trim to `limit` survivors.
    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    let mut out: Vec<SearchBlockRow> = Vec::new();
    for r in rows {
        if out.len() >= limit_usize {
            break;
        }
        let Some(ref content) = r.content else {
            continue;
        };
        let byte_matches: Vec<(usize, usize)> = re
            .find_iter(content)
            .filter(|m| m.end() > m.start())
            .take(MAX_OFFSETS_PER_BLOCK)
            .map(|m| (m.start(), m.end()))
            .collect();
        if byte_matches.is_empty() {
            continue;
        }
        let offsets = byte_to_utf16_offsets(content, &byte_matches);
        // P4 (#346) — matching is done; truncate the SHIPPED content to
        // `snippet_len` codepoints (codepoint-safe, same as SQL `substr`).
        let content_out = match snippet_len {
            Some(n) => r.content.map(|c| {
                if c.chars().count() > n {
                    c.chars().take(n).collect()
                } else {
                    c
                }
            }),
            None => r.content,
        };
        out.push(SearchBlockRow {
            id: crate::ulid::ActiveBlockId::from_trusted_active(r.id.as_str()),
            block_type: r.block_type,
            content: content_out,
            parent_id: r.parent_id.map(crate::ulid::BlockId::into_string),
            position: r.position,
            deleted_at: r.deleted_at,
            todo_state: r.todo_state,
            priority: r.priority,
            due_date: r.due_date,
            scheduled_date: r.scheduled_date,
            page_id: r.page_id,
            snippet: None,
            match_offsets: offsets,
        });
    }

    // Regex-mode never emits a cursor — the candidate set is bounded
    // by `REGEX_PRE_FILTER_CAP`. Document the trade-off in
    // `docs/SEARCH.md`.
    Ok(PageResponse {
        items: out,
        next_cursor: None,
        has_more: false,
        total_count: None,
    })
}

/// Row from the regex-mode SQL scan. No `search_rank` because FTS is
/// bypassed; recency ordering is used instead.
#[derive(Debug, sqlx::FromRow)]
struct RegexScanRow {
    id: crate::ulid::BlockId,
    block_type: String,
    content: Option<String>,
    parent_id: Option<crate::ulid::BlockId>,
    position: Option<i64>,
    // #109 Phase 2 — blocks.deleted_at is INTEGER epoch-ms (migration 0080);
    // the scan SQL filters `deleted_at IS NULL`, so always None here.
    deleted_at: Option<i64>,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    page_id: Option<String>,
}

/// PEND-58g NEW-3 — filter-only structural scan (NO free-text pattern).
///
/// A blank query has nothing for FTS5 MATCH (which cannot express
/// "match all") or the regex engine (an empty pattern matches every
/// row) to act on. When the caller still supplies at least one
/// STRUCTURAL filter (`tag:`, `parent_id`, page globs, `block_type`, a
/// metadata predicate), the intent is "give me the blocks that match
/// those filters", recency-ordered. This helper builds the SAME
/// structural-filter SQL as [`regex_mode_query`] (deduped/UPPERCASE tag
/// ids with the `COUNT(DISTINCT)` ALL-tags predicate, space_id,
/// include/exclude page globs, [`append_metadata_sql`], optional
/// `block_type`) but:
///
///   * compiles NO regex and applies NO post-filter — every
///     structurally-matching row is returned;
///   * supports id-DESC cursor pagination via `after_id` (`AND b.id < ?`);
///     ULIDs sort lexicographically by recency, so `id DESC` is
///     recency-descending.
///   * emits `snippet: None` / `match_offsets: vec![]` (no pattern → no
///     highlight offsets).
///
/// The `fetch_limit` cap is bound to the `LIMIT` placeholder; callers
/// pass `effective_limit + 1` so a one-row overflow probe can drive
/// `has_more`.
#[allow(clippy::too_many_arguments)]
async fn filter_only_scan(
    pool: &SqlitePool,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    block_type_filter: Option<&str>,
    metadata: &MetadataPredicates,
    after_id: Option<&str>,
    fetch_limit: i64,
    // P4 (#346) — `Some(n)` truncates `content` at the DB via
    // `substr(b.content, 1, n)`. This path does NO content matching (no
    // free-text pattern), so DB-side truncation is fully equivalent to the
    // old Rust-side `.chars().take(n)` — push it down.
    snippet_len: Option<usize>,
) -> Result<Vec<SearchBlockRow>, AppError> {
    let content_select = super::search::content_select_expr(snippet_len);
    let mut sql = format!(
        r#"SELECT b.id, b.block_type, {content_select}, b.parent_id, b.position,
                  b.deleted_at, b.todo_state, b.priority, b.due_date,
                  b.scheduled_date, b.page_id
           FROM blocks b
           WHERE b.deleted_at IS NULL
             AND b.content IS NOT NULL"#,
    );

    // M2 (#348) — same `StructuralFilterBuilder` as `regex_mode_query`,
    // with the extra `after_id` keyset predicate. No fixed base params;
    // dynamic filters start at `?1`, 13-space `AND ` prefix.
    const PREFIX: &str = "\n             AND ";
    let mut fb = super::filter_builder::StructuralFilterBuilder::new(1);

    fb.add_parent(PREFIX, parent_id);

    // SQL-1 / SQL-A6 (PEND-58f) — dedupe + UPPERCASE-normalise tag ids
    // before binding, exactly as `regex_mode_query` does, so the
    // `COUNT(DISTINCT)` ALL-tags predicate is achievable and a
    // mixed-case duplicate can't silently zero the scan.
    let tag_ids_active: Vec<String> = match tag_ids.filter(|t| !t.is_empty()) {
        Some(ids) => {
            let mut seen = std::collections::HashSet::new();
            ids.iter()
                .map(|id| id.to_ascii_uppercase())
                .filter(|id| seen.insert(id.clone()))
                .collect()
        }
        None => Vec::new(),
    };
    fb.add_tags_all(PREFIX, &tag_ids_active);

    fb.add_space(PREFIX, space_id);

    // P2 (#346) — shared page-glob sub-select helper (via the builder).
    fb.add_page_globs(PREFIX, false, include_page_globs);
    fb.add_page_globs(PREFIX, true, exclude_page_globs);

    // PEND-53 — metadata predicates (same shape as `regex_mode_query`).
    fb.add_metadata(metadata, "b");

    fb.add_block_type(PREFIX, block_type_filter);

    // id-DESC cursor pagination — ULID prefixes sort lexicographically by
    // recency, so `b.id < ?` resumes strictly after the previous page's
    // last (oldest) returned row.
    fb.add_after_id(PREFIX, after_id);

    sql.push_str(fb.sql());

    let cap_idx = fb.next_param();
    sql.push_str(&format!(
        "\n           ORDER BY b.id DESC\n           LIMIT ?{cap_idx}"
    ));

    // M2 — builder replays every dynamic bind in declaration order, then
    // the trailing `LIMIT ?cap_idx` (reserved last) is bound last.
    let db_query = sqlx::query_as::<_, RegexScanRow>(sqlx::AssertSqlSafe(sql.as_str()));
    let db_query = fb.apply(db_query);
    let db_query = db_query.bind(fetch_limit);

    let rows = db_query.fetch_all(pool).await.map_err(AppError::Database)?;

    let out: Vec<SearchBlockRow> = rows
        .into_iter()
        .map(|r| SearchBlockRow {
            id: crate::ulid::ActiveBlockId::from_trusted_active(r.id.as_str()),
            block_type: r.block_type,
            content: r.content,
            parent_id: r.parent_id.map(crate::ulid::BlockId::into_string),
            position: r.position,
            deleted_at: r.deleted_at,
            todo_state: r.todo_state,
            priority: r.priority,
            due_date: r.due_date,
            scheduled_date: r.scheduled_date,
            page_id: r.page_id,
            snippet: None,
            match_offsets: vec![],
        })
        .collect();

    Ok(out)
}

/// PEND-58g NEW-3 — cursor-paginated filter-only page (mode-independent;
/// no free-text pattern). Drives [`filter_only_scan`] with a `limit + 1`
/// overflow probe and emits an id-DESC `next_cursor` so the palette /
/// search view can page through the structurally-filtered set without
/// dropping or duplicating a row.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fts_fetch_filter_only_page(
    pool: &SqlitePool,
    page: &PageRequest,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    block_type_filter: Option<&str>,
    metadata: &MetadataPredicates,
    // P4 (#346) — propagated to the SQL `substr(b.content, 1, n)` truncation.
    snippet_len: Option<usize>,
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    let effective_limit = page.limit.min(super::search::MAX_SEARCH_RESULTS);
    let fetch_limit = effective_limit + 1;
    let after_id = page.after.as_ref().map(|c| c.id.as_str());

    let mut rows = filter_only_scan(
        pool,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        block_type_filter,
        metadata,
        after_id,
        fetch_limit,
        snippet_len,
    )
    .await?;

    let effective_limit_usize = usize::try_from(effective_limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > effective_limit_usize;
    rows.truncate(effective_limit_usize);

    let next_cursor = if has_more {
        // `next_cursor` keys on the LAST RETURNED (post-truncate) row's id;
        // the next page resumes with `b.id < that_id`. The cursor stores
        // the raw String id, matching `SearchBlockRow.id` (an
        // `ActiveBlockId` whose `as_str()` is the canonical ULID).
        let last = rows
            .last()
            .expect("has_more implies at least `limit` rows (limit >= 1)");
        Some(crate::pagination::Cursor::for_id(last.id.as_str().to_string()).encode()?)
    } else {
        None
    };

    Ok(PageResponse {
        items: rows,
        next_cursor,
        has_more,
        total_count: None,
    })
}

/// PEND-58g NEW-3 — partitioned filter-only scan (mode-independent; no
/// free-text pattern). Mirrors [`search_with_toggles_partitioned`]'s two
/// partitions: a pages partition (`block_type = 'page'`) and an
/// unrestricted blocks partition, each with a `limit + 1` overflow probe
/// driving its `has_more`. No cursor — the palette doesn't paginate.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fts_fetch_filter_only_partitioned(
    pool: &SqlitePool,
    page_limit: u32,
    block_limit: u32,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    metadata: &MetadataPredicates,
) -> Result<super::search::FtsPartitionedScan, AppError> {
    let mut pages = filter_only_scan(
        pool,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        Some("page"),
        metadata,
        None,
        i64::from(page_limit) + 1,
        // P4 (#346) — partitioned (palette) path always returns full content.
        None,
    )
    .await?;
    let mut blocks = filter_only_scan(
        pool,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        None,
        metadata,
        None,
        i64::from(block_limit) + 1,
        // P4 (#346) — see the pages partition above; full content here too.
        None,
    )
    .await?;

    let page_limit_usize = usize::try_from(page_limit).unwrap_or(usize::MAX);
    let block_limit_usize = usize::try_from(block_limit).unwrap_or(usize::MAX);
    // `limit == 0` — same degenerate-ask guard as the FTS / regex paths;
    // the caller asked for nothing, so don't claim there's more.
    let pages_has_more = page_limit_usize > 0 && pages.len() > page_limit_usize;
    let blocks_has_more = block_limit_usize > 0 && blocks.len() > block_limit_usize;
    pages.truncate(page_limit_usize);
    blocks.truncate(block_limit_usize);

    Ok(super::search::FtsPartitionedScan {
        pages,
        blocks,
        pages_has_more,
        blocks_has_more,
    })
}

// ---------------------------------------------------------------------------
// Unit tests — pure functions (regex compose, UTF-16 conversion)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn toggles_default_is_all_off() {
        let t = SearchToggles::default();
        assert!(!t.any(), "default toggles must report any()==false");
        assert!(!t.case_sensitive);
        assert!(!t.whole_word);
        assert!(!t.is_regex);
    }

    #[test]
    fn compose_literal_pattern_case_sensitive_off_is_case_insensitive_flag() {
        let pat = compose_literal_pattern(
            "Alpha",
            SearchToggles {
                case_sensitive: false,
                whole_word: false,
                is_regex: false,
            },
        );
        assert!(pat.starts_with("(?i)"), "expected (?i) prefix: {pat}");
        assert!(pat.contains("Alpha"));
    }

    #[test]
    fn compose_literal_pattern_case_sensitive_on_emits_negative_flag() {
        let pat = compose_literal_pattern(
            "Alpha",
            SearchToggles {
                case_sensitive: true,
                whole_word: false,
                is_regex: false,
            },
        );
        assert!(pat.starts_with("(?-i)"), "expected (?-i) prefix: {pat}");
    }

    #[test]
    fn compose_literal_pattern_whole_word_wraps_in_ascii_boundary() {
        let pat = compose_literal_pattern(
            "cat",
            SearchToggles {
                case_sensitive: false,
                whole_word: true,
                is_regex: false,
            },
        );
        // ASCII-only boundary via `(?-u:\b)` — documented in the plan.
        assert!(pat.contains("(?-u:\\b)cat(?-u:\\b)"), "got: {pat}");
    }

    #[test]
    fn compose_literal_pattern_escapes_user_regex_metacharacters() {
        // Literal mode must escape `.`, `*`, `[`, etc. — those only
        // become metacharacters when `is_regex=true`.
        let pat = compose_literal_pattern(
            "a.b*c",
            SearchToggles {
                case_sensitive: false,
                whole_word: false,
                is_regex: false,
            },
        );
        assert!(
            pat.contains("a\\.b\\*c"),
            "expected escaped metachars: {pat}"
        );
    }

    #[test]
    fn build_regex_rejects_oversized_pattern() {
        let big = "a".repeat(MAX_PATTERN_LEN + 1);
        match build_regex(&big) {
            Err(AppError::Validation(msg)) => {
                assert!(msg.starts_with("InvalidRegex:"), "msg: {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn build_regex_surfaces_compile_error_with_prefix() {
        // `*` at the start is invalid in Rust regex.
        match build_regex("*") {
            Err(AppError::Validation(msg)) => {
                assert!(
                    msg.starts_with("InvalidRegex:"),
                    "expected InvalidRegex prefix, got: {msg}"
                );
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn byte_to_utf16_offsets_ascii_passthrough() {
        let text = "hello world";
        let offsets = byte_to_utf16_offsets(text, &[(0, 5), (6, 11)]);
        assert_eq!(
            offsets,
            vec![
                MatchOffset { start: 0, end: 5 },
                MatchOffset { start: 6, end: 11 }
            ]
        );
    }

    #[test]
    fn byte_to_utf16_offsets_cjk_single_units() {
        // `日本語` — three CJK chars, each 3 bytes UTF-8 / 1 UTF-16 unit.
        let text = "日本語";
        // Byte offsets for `本`: starts at byte 3, ends at byte 6.
        let offsets = byte_to_utf16_offsets(text, &[(3, 6)]);
        assert_eq!(offsets, vec![MatchOffset { start: 1, end: 2 }]);
    }

    #[test]
    fn byte_to_utf16_offsets_emoji_surrogate_pair() {
        // `🌟` = 4 bytes UTF-8 / 2 UTF-16 code units (surrogate pair).
        // `Hello` starts at byte 4, runs to byte 9.
        let text = "🌟Hello";
        let offsets = byte_to_utf16_offsets(text, &[(4, 9)]);
        assert_eq!(offsets, vec![MatchOffset { start: 2, end: 7 }]);
    }

    #[test]
    fn byte_to_utf16_offsets_mid_emoji_match() {
        // PEND-73 Phase 5.T1b — the existing test above covers a leading
        // emoji + trailing ASCII; this one matches the emoji itself
        // when it sits between ASCII runs. `🌟` = 4 bytes UTF-8 / 2
        // UTF-16 code units. `abc` = bytes 0-3 / units 0-3; `🌟` =
        // bytes 3-7 / units 3-5; `def` = bytes 7-10 / units 5-8.
        let text = "abc🌟def";
        let offsets = byte_to_utf16_offsets(text, &[(3, 7)]);
        assert_eq!(
            offsets,
            vec![MatchOffset { start: 3, end: 5 }],
            "the emoji match spans one code point but two UTF-16 units"
        );
    }

    #[test]
    fn apply_post_filter_caps_offsets_at_max() {
        // Build a row with `'a' * 100` content; regex `.` matches every
        // char; expect exactly `MAX_OFFSETS_PER_BLOCK` offsets.
        use crate::ulid::ActiveBlockId;
        let mut rows = vec![SearchBlockRow {
            id: ActiveBlockId::from_trusted_active("01HQBLKA00000000000000BKA1"),
            block_type: "content".into(),
            content: Some("a".repeat(100)),
            parent_id: None,
            position: None,
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: None,
            snippet: Some("dropped".into()),
            match_offsets: vec![],
        }];
        let re = build_regex("a").unwrap();
        apply_post_filter(&mut rows, &re);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].match_offsets.len(),
            MAX_OFFSETS_PER_BLOCK,
            "offsets must be capped at MAX_OFFSETS_PER_BLOCK"
        );
        assert!(
            rows[0].snippet.is_none(),
            "snippet must be cleared when offsets are emitted"
        );
    }

    #[test]
    fn apply_post_filter_drops_rows_with_no_match() {
        use crate::ulid::ActiveBlockId;
        let mut rows = vec![SearchBlockRow {
            id: ActiveBlockId::from_trusted_active("01HQBLKA00000000000000BKA1"),
            block_type: "content".into(),
            content: Some("xyz".into()),
            parent_id: None,
            position: None,
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: None,
            snippet: Some("xyz".into()),
            match_offsets: vec![],
        }];
        let re = build_regex("notpresent").unwrap();
        apply_post_filter(&mut rows, &re);
        assert!(rows.is_empty(), "non-matching rows must be dropped");
    }

    #[test]
    fn apply_post_filter_drops_rows_with_null_content() {
        use crate::ulid::ActiveBlockId;
        let mut rows = vec![SearchBlockRow {
            id: ActiveBlockId::from_trusted_active("01HQBLKA00000000000000BKA1"),
            block_type: "content".into(),
            content: None,
            parent_id: None,
            position: None,
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: None,
            snippet: None,
            match_offsets: vec![],
        }];
        let re = build_regex("anything").unwrap();
        apply_post_filter(&mut rows, &re);
        assert!(rows.is_empty(), "rows with NULL content cannot match");
    }

    #[test]
    fn whole_word_does_not_match_cjk_runs() {
        // Documented v1 limitation: `(?-u:\b)` is ASCII-only. CJK
        // characters aren't ASCII word characters, so `\b会議\b`
        // never asserts a boundary inside a CJK run.
        let pat = compose_literal_pattern(
            "会議",
            SearchToggles {
                case_sensitive: false,
                whole_word: true,
                is_regex: false,
            },
        );
        let re = build_regex(&pat).unwrap();
        // `会議に行く` — no ASCII boundary anywhere; expect zero matches.
        assert!(
            re.find("会議に行く").is_none(),
            "ASCII \\b cannot match inside CJK"
        );
    }
}
