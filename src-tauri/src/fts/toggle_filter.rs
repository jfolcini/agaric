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
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    if toggles.is_regex {
        // Regex-mode bypasses FTS entirely — empty query short-circuits
        // here to avoid compiling an empty pattern (which would match
        // every row).
        if query.trim().is_empty() {
            return Ok(PageResponse {
                items: vec![],
                next_cursor: None,
                has_more: false,
                total_count: None,
            });
        }
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
        )
        .await?;
        return Ok(response);
    }

    // FTS5 candidate set (today's path).
    let mut response = super::search::search_fts(
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
    )
    .await?;

    if !toggles.any() {
        // All toggles off → return the FTS path verbatim (zero overhead).
        return Ok(response);
    }

    // `case_sensitive` and/or `whole_word` on → compile a post-filter
    // regex from the literal query and narrow the FTS candidate set.
    let pattern = compose_literal_pattern(query, toggles);
    let re = build_regex(&pattern)?;
    apply_post_filter(&mut response.items, &re);
    Ok(response)
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
    if toggles.is_regex {
        // Regex-mode bypasses FTS entirely — empty query short-circuits
        // here to avoid compiling an empty pattern (which would match
        // every row).
        if query.trim().is_empty() {
            return Ok(super::search::FtsPartitionedScan {
                pages: Vec::new(),
                blocks: Vec::new(),
                pages_has_more: false,
                blocks_has_more: false,
            });
        }
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

    // PEND-69 F5 — when the toggle bundle will trigger the post-filter
    // sweep, the snippets emitted by `snippet(fts_blocks, …)` are
    // clobbered to `None` by `apply_post_filter`. Omit the SQL
    // function call entirely in that case so SQLite skips the per-row
    // tokenizer walk.
    let with_snippet = !toggles.any();

    // FTS5 candidate set — two parallel scans (page-only + unrestricted).
    let mut scan = super::search::search_fts_partitioned(
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
        with_snippet,
        cancel,
    )
    .await?;

    if !toggles.any() {
        // All toggles off → return the FTS path verbatim (zero overhead).
        return Ok(scan);
    }

    // `case_sensitive` and/or `whole_word` on → compile a post-filter
    // regex from the literal query and narrow each partition's
    // candidate set.
    let pattern = compose_literal_pattern(query, toggles);
    let re = build_regex(&pattern)?;
    apply_post_filter(&mut scan.pages, &re);
    apply_post_filter(&mut scan.blocks, &re);
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
    rows.retain_mut(|row| {
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
    });
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
    let limit = page.limit.clamp(1, 100);

    let mut sql = String::from(
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                  b.deleted_at, b.todo_state, b.priority, b.due_date,
                  b.scheduled_date, b.page_id
           FROM blocks b
           WHERE b.deleted_at IS NULL
             AND b.content IS NOT NULL"#,
    );

    let mut next_param = 1;
    let parent_idx = parent_id.map(|_| {
        let i = next_param;
        sql.push_str(&format!("\n             AND b.parent_id = ?{i}"));
        next_param += 1;
        i
    });

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
    let tag_start = if !tag_ids_active.is_empty() {
        let start = next_param;
        let placeholders: Vec<String> = (0..tag_ids_active.len())
            .map(|i| format!("?{}", start + i))
            .collect();
        next_param += tag_ids_active.len();
        let count_idx = next_param;
        next_param += 1;
        sql.push_str(&format!(
            "\n             AND (SELECT COUNT(DISTINCT bt.tag_id) FROM block_tags bt WHERE bt.block_id = b.id AND bt.tag_id IN ({})) = ?{count_idx}",
            placeholders.join(", ")
        ));
        Some((start, count_idx))
    } else {
        None
    };

    let space_idx = space_id.map(|_| {
        let i = next_param;
        sql.push_str(&format!(
            "\n             AND b.page_id IN (\
              SELECT bp.block_id FROM block_properties bp \
              WHERE bp.key = 'space' AND bp.value_ref = ?{i})"
        ));
        next_param += 1;
        i
    });

    let include_start = if !include_page_globs.is_empty() {
        let start = next_param;
        let placeholders: Vec<String> = (0..include_page_globs.len())
            .map(|i| format!("LOWER(pc.title) GLOB ?{}", start + i))
            .collect();
        sql.push_str(&format!(
            "\n             AND b.page_id IN (SELECT pc.page_id FROM pages_cache pc WHERE {})",
            placeholders.join(" OR ")
        ));
        next_param += include_page_globs.len();
        Some(start)
    } else {
        None
    };

    let exclude_start = if !exclude_page_globs.is_empty() {
        let start = next_param;
        let placeholders: Vec<String> = (0..exclude_page_globs.len())
            .map(|i| format!("LOWER(pc.title) GLOB ?{}", start + i))
            .collect();
        sql.push_str(&format!(
            "\n             AND b.page_id NOT IN (SELECT pc.page_id FROM pages_cache pc WHERE {})",
            placeholders.join(" OR ")
        ));
        next_param += exclude_page_globs.len();
        Some(start)
    } else {
        None
    };

    // PEND-53 — metadata predicates (same shape as `search_fts`).
    let metadata_binds =
        super::metadata_filter::append_metadata_sql(&mut sql, &mut next_param, metadata, "b");

    // PEND-69 F2 — push `block_type` into SQL instead of post-fetch
    // `Vec::retain()`. Eliminates the 1000-row drag for page-only
    // regex queries where matching pages live beyond the pre-filter
    // cap.
    let block_type_idx = if block_type_filter.is_some() {
        let i = next_param;
        sql.push_str(&format!("\n             AND b.block_type = ?{i}"));
        next_param += 1;
        Some(i)
    } else {
        None
    };

    let cap_idx = next_param;
    // PEND-55 — ULID prefixes are monotonically time-sortable, so
    // `ORDER BY b.id DESC` yields most-recent-first without a
    // dedicated `created_at` column (the `blocks` table doesn't carry
    // one — see migration `0001_initial.sql`). Document this in
    // `docs/SEARCH.md`'s regex-mode trade-off section.
    sql.push_str(&format!(
        "\n           ORDER BY b.id DESC\n           LIMIT ?{cap_idx}"
    ));

    let _ = (
        parent_idx,
        tag_start,
        space_idx,
        include_start,
        exclude_start,
        block_type_idx,
    );

    let mut db_query = sqlx::query_as::<_, RegexScanRow>(&sql);
    if let Some(pid) = parent_id {
        db_query = db_query.bind(pid);
    }
    for tid in &tag_ids_active {
        db_query = db_query.bind(tid);
    }
    if !tag_ids_active.is_empty() {
        let count: i64 = i64::try_from(tag_ids_active.len()).unwrap_or(i64::MAX);
        db_query = db_query.bind(count);
    }
    if let Some(sid) = space_id {
        db_query = db_query.bind(sid);
    }
    for pat in include_page_globs {
        db_query = db_query.bind(pat);
    }
    for pat in exclude_page_globs {
        db_query = db_query.bind(pat);
    }
    // PEND-53 / PEND-64 — bind metadata values in declaration order;
    // PEND-64 widened the bind type to `MetaBind` to carry nullable
    // number / date / ref variants for `prop:` four-column matching.
    for v in &metadata_binds {
        db_query = v.bind(db_query);
    }
    // PEND-69 F2 — bind `block_type` value in the same order the SQL
    // builder declared it (after metadata, before the LIMIT cap).
    if let Some(bt) = block_type_filter {
        db_query = db_query.bind(bt);
    }
    db_query = db_query.bind(REGEX_PRE_FILTER_CAP);

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
        out.push(SearchBlockRow {
            id: crate::ulid::ActiveBlockId::from_trusted_active(&r.id),
            block_type: r.block_type,
            content: r.content,
            parent_id: r.parent_id,
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
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<String>,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    page_id: Option<String>,
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
