//! FTS5 search and query processing.
//!
//! Contains the `search_fts` function for paginated FTS5 MATCH queries and
//! the `sanitize_fts_query` helper for safe query construction.

use sqlx::SqlitePool;
use std::time::{Duration, Instant};

use crate::cancellation::CancellationToken;
use crate::db::search_pool_acquire_logged;
use crate::domain::search_types::SearchBlockRow;
use crate::error::AppError;
use crate::pagination::{Cursor, PageRequest, PageResponse};

use super::metadata_filter::MetadataPredicates;

// ---------------------------------------------------------------------------
// #828 — FTS5 snippet() highlight sentinels
// ---------------------------------------------------------------------------

/// #828 — FTS5 snippet() highlight sentinels. PUA codepoints that cannot
/// occur in user content, so a literal "<mark>" typed into a block is never
/// mistaken for a highlight boundary. The web UI parser (parseSnippet in
/// src/components/search/SnippetHighlight.tsx) reads these directly; the MCP
/// search tool converts them back to <mark>/</mark> so the agent-facing
/// contract is unchanged.
pub(crate) const SNIPPET_HL_OPEN: char = '\u{E000}';
pub(crate) const SNIPPET_HL_CLOSE: char = '\u{E001}';
/// The `snippet(...)` SQL projection, shared by the production query and the
/// test mirror so the two never drift. Keep the inline sentinels in sync
/// with SNIPPET_HL_OPEN / SNIPPET_HL_CLOSE above.
pub(crate) const SNIPPET_SQL_PROJECTION: &str =
    "snippet(fts_blocks, 1, '\u{E000}', '\u{E001}', '…', 32) as snippet";

// ---------------------------------------------------------------------------
// PEND-70 — per-FTS-query timing thresholds
// ---------------------------------------------------------------------------

/// Per-FTS-query wall-time threshold at which [`fts_fetch_rows`] emits
/// an `info!` breadcrumb. 200 ms is a **round design figure** chosen to
/// sit comfortably above a warm-cache FTS5 trigram scan yet well below
/// the 1 s `warn!` budget — it surfaces "the cache is cold and the query
/// is doing real work" without spamming on every keystroke. It is a
/// log-only breadcrumb, not a budget the code enforces. SQL-7 (PEND-58f):
/// this is a design figure, not a benchmarked value; see
/// `benches/fts_bench.rs` if you want to derive a measured floor.
pub(crate) const FTS_QUERY_INFO_MS: u128 = 200;

/// Per-FTS-query wall-time threshold at which [`fts_fetch_rows`] emits
/// a `warn!`. SQL-7 (PEND-58f) — 1 s is a **round design figure**
/// (the PEND-70 design's recommended ceiling), NOT a benchmarked value;
/// the earlier "measured starting point" wording overstated its
/// provenance. It is log-only — nothing aborts at this threshold. If CI
/// runners observe legitimate cold-cache scans crossing this floor on the
/// 10k-block bench fixture (`benches/fts_bench.rs::bench_search_fts` at
/// `count=10_000`), derive the new value from the observed worst-case +
/// 3× headroom and document the bump here.
pub(crate) const FTS_QUERY_WARN_MS: u128 = 1_000;

// ---------------------------------------------------------------------------
// FTS5 search
// ---------------------------------------------------------------------------

/// Maximum number of results returned from a single search query, regardless
/// of the client-supplied page limit.  Prevents unbounded result sets.
///
/// PEND-61 Phase 1 — also used by [`search_fts_partitioned`] as the
/// ceiling on the combined `page_limit + block_limit` fetch.
///
/// PEND-58f BE-2 — re-exported via `crate::fts` so the partitioned IPC
/// command can validate `page_limit` / `block_limit` against the same
/// ceiling and **reject** (not silently cap) an over-limit request,
/// matching the cursor path's `PageRequest::new` contract.
pub(crate) const MAX_SEARCH_RESULTS: i64 = 100;

/// SQL-4 (PEND-58f) — maximum byte length of a raw FTS query string.
///
/// The regex-mode path already rejects patterns over [`MAX_PATTERN_LEN`]
/// (1 KiB) up front via `build_regex`; the FTS path had no equivalent
/// guard, so a pathological multi-megabyte query string was tokenised,
/// NFC-normalised, sanitised, and bound into a MATCH expression before
/// SQLite rejected it (wasting CPU on the normalise/tokenise walk and
/// risking a confusing low-level FTS5 error). 4 KiB is comfortably above
/// any realistic hand-typed or paste-built query (the longest structured
/// query the search-query DSL emits is a few hundred bytes) while keeping
/// the up-front work bounded. Measured in bytes (`str::len`) to bound the
/// allocation work, not in scalar count.
pub(crate) const MAX_QUERY_LEN: usize = 4 * 1024;

/// Token types produced by [`tokenize_query`].
enum QueryToken {
    /// A double-quoted phrase (content between matched quotes, without the
    /// surrounding quote characters).
    QuotedPhrase(String),
    /// A single unquoted word (whitespace-delimited).
    Word(String),
}

/// Tokenize a raw query string, respecting double-quoted phrases.
///
/// A `"` that appears at the start of a new token (i.e. after whitespace or at
/// the beginning of the string) opens a quoted phrase that extends until the
/// next `"`.  If no closing quote is found, the content is split on whitespace
/// and emitted as individual [`QueryToken::Word`] tokens (graceful fallback for
/// unmatched quotes).
///
/// Quotes that appear *inside* an unquoted word (e.g. `say"hello`) are kept as
/// part of the word — they do **not** start a new quoted phrase.
fn tokenize_query(input: &str) -> Vec<QueryToken> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
            continue;
        }

        if ch == '"' {
            // Opening quote at token boundary — start a quoted phrase.
            chars.next(); // consume opening "
            let mut phrase = String::new();
            let mut found_close = false;

            while let Some(&inner) = chars.peek() {
                if inner == '"' {
                    chars.next(); // consume closing "
                    found_close = true;
                    break;
                }
                phrase.push(inner);
                chars.next();
            }

            if found_close {
                tokens.push(QueryToken::QuotedPhrase(phrase));
            } else {
                // Unmatched quote — treat contents as individual words.
                for word in phrase.split_whitespace() {
                    tokens.push(QueryToken::Word(word.to_string()));
                }
            }
        } else {
            // Unquoted word — read until whitespace.
            let mut word = String::new();
            while let Some(&wch) = chars.peek() {
                if wch.is_whitespace() {
                    break;
                }
                word.push(wch);
                chars.next();
            }
            if !word.is_empty() {
                tokens.push(QueryToken::Word(word));
            }
        }
    }

    tokens
}

/// Sanitize a raw user query for safe use in an FTS5 MATCH expression.
///
/// Supports a subset of FTS5 search operators so that users can write
/// queries like `"exact phrase"`, `cats NOT dogs`, or `cats OR dogs`.
///
/// ## Rules
///
/// 1. **Quoted phrases** — matched `"..."` in the input are kept as a single
///    FTS5 phrase token (internal `"` escaped by doubling). Quoted phrases
///    are *not* subject to the trigram length filter — the user explicitly
///    asked for them.
/// 2. **`NOT` operator** — preserved as the bare keyword when followed by at
///    least one more token. FTS5 `NOT` is a *binary* operator (`A NOT B`):
///    a standalone leading `NOT term` (no left operand) is an FTS5 syntax
///    error, surfaced as `AppError::Validation` by [`search_fts`]. We do not
///    rewrite it — `NOT` is meaningful only between two operands.
/// 3. **`OR` / `AND` operators** — preserved as bare keywords when they appear
///    between two other tokens.
/// 4. **Trigram length filter (I-Search-2)** — non-operator word tokens
///    shorter than 3 characters are dropped. The FTS5 table uses the
///    trigram tokenizer (migration `0006_fts5_trigram.sql`,
///    `tokenize = 'trigram case_sensitive 0'`); tokens with fewer than 3
///    characters cannot match anything in the index, so retaining them
///    would only AND-collapse the whole query to zero hits. The
///    operator-keyword whitelist below is the single exception.
/// 5. **Everything else** — wrapped in `"..."` with internal `"` escaped.
///
/// Operator detection is case-insensitive (`not` → `NOT`, `or` → `OR`).
///
/// ## Trigram-filter operator whitelist
///
/// `OR` (2 chars) and `AND` / `NOT` (3 chars) bypass the length filter
/// when they appear in a valid operator position. They are FTS5 syntax,
/// not search terms, so the trigram minimum does not apply. Outside an
/// operator position the same tokens are treated as ordinary words and
/// `OR` is dropped (2 chars), while `AND` / `NOT` survive on length
/// alone.
///
/// ## Safety
///
/// Every non-operator token is always double-quoted, preventing injection of
/// FTS5 syntax such as `NEAR`, `*`, column filters (`col:`), or grouping
/// parentheses.
#[must_use]
pub(crate) fn sanitize_fts_query(query: &str) -> String {
    /// Trigram tokenizer minimum match length — see migration
    /// `0006_fts5_trigram.sql` (`tokenize = 'trigram case_sensitive 0'`).
    const TRIGRAM_MIN_LEN: usize = 3;
    // PEND-73 B3 — NFC-normalise the query before tokenisation so an
    // NFC query reaches the NFC-normalised FTS index emitted by
    // `strip_for_fts_with_maps`. Without this, NFD content (macOS
    // pastes, NFD-encoded filenames embedded in titles) becomes
    // invisible to NFC queries.
    let normalised = super::strip::nfc_normalise(query);
    let tokens = tokenize_query(&normalised);
    let len = tokens.len();
    let mut output_parts: Vec<String> = Vec::new();

    for (i, token) in tokens.iter().enumerate() {
        match token {
            QueryToken::QuotedPhrase(phrase) => {
                // User-quoted phrases bypass the trigram length filter —
                // the explicit quoting signals intent.
                // Skip empty or whitespace-only phrases: `""` would pass
                // the post-loop `sanitized.is_empty()` guard unchanged but
                // is a syntax error in FTS5 MATCH.
                let trimmed = phrase.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // #673 — a quoted phrase shorter than a trigram ("ab") emits
                // ZERO trigram tokens, so its `MATCH` clause returns no rows
                // and AND-collapses the whole query to nothing — the exact
                // silent failure the bare-word length filter exists to
                // prevent. The explicit-quoting "intent" bypass does not
                // rescue a phrase the index physically cannot represent, so
                // we drop it (with a warning) rather than letting it zero out
                // the query. `chars().count()` counts unicode scalars so a
                // 2-char CJK phrase is measured as 2.
                if trimmed.chars().count() < TRIGRAM_MIN_LEN {
                    tracing::warn!(
                        phrase = %trimmed,
                        "fts: dropping sub-trigram quoted phrase (< {TRIGRAM_MIN_LEN} chars); \
                         the trigram index cannot match it"
                    );
                    continue;
                }
                let escaped = phrase.replace('"', "\"\"");
                output_parts.push(format!("\"{escaped}\""));
            }
            QueryToken::Word(word) => {
                let upper = word.to_uppercase();
                let is_operator = match upper.as_str() {
                    // NOT requires a following token.
                    "NOT" => i + 1 < len,
                    // OR / AND require a preceding output and a following token.
                    "OR" | "AND" => !output_parts.is_empty() && i + 1 < len,
                    _ => false,
                };

                if is_operator {
                    // Whitelisted operator — bypass the trigram length filter.
                    output_parts.push(upper);
                } else {
                    // I-Search-2: drop sub-trigram tokens. `word.chars().count()`
                    // counts unicode scalars (so a 2-character CJK token is
                    // measured as 2, not by byte length).
                    if word.chars().count() < TRIGRAM_MIN_LEN {
                        continue;
                    }
                    let escaped = word.replace('"', "\"\"");
                    output_parts.push(format!("\"{escaped}\""));
                }
            }
        }
    }

    // R5 (#347) — second pass: drop dangling boolean operators.
    //
    // The first pass decides operator-vs-literal from *token positions*
    // (`NOT` is an operator when a token follows it). But the operand it
    // was counting on may then be dropped by the trigram length filter:
    // e.g. `cats NOT ab` → `cats` is kept, `NOT` passes its position
    // check (a token follows), then `ab` (2 chars) is dropped — leaving
    // `"cats" NOT`, a bare trailing operator that FTS5 rejects with a
    // syntax error on otherwise-benign input.
    //
    // A bare operator is an emitted part equal exactly to `OR` / `AND` /
    // `NOT` (a quoted literal like `"NOT"` is a search term, not an
    // operator, and must be preserved). We drop any bare operator left
    // without the right-hand operand it requires:
    //   * a trailing bare operator (`cats NOT ab` → `"cats" NOT`), and
    //   * a bare operator immediately followed by another bare operator
    //     (`cats OR ab NOT dogs` → `"cats" OR NOT "dogs"`): the first of
    //     the adjacent pair has no operand on its right, so it is the one
    //     dropped, leaving the trailing operator's operand intact.
    // We do NOT drop a *leading* bare operator: the first pass only ever
    // emits a leading bare `NOT` (OR/AND require a preceding emitted
    // operand to be promoted). #669 — this leading `NOT term` is NOT a
    // valid form: FTS5 `NOT` is binary (`A NOT B`), so a leading bare
    // `NOT` produces an FTS5 syntax error that `search_fts` maps to
    // `AppError::Validation` (pinned by `fts/tests.rs`). We deliberately
    // preserve it rather than silently dropping the `NOT` (which would
    // invert the user's intent — searching FOR `term` they asked to
    // exclude) or quoting it (which would search for the literal word
    // "not"). Surfacing a clear validation error is the contract.
    // Iterate to a fixpoint so a run collapses fully.
    let is_bare_op = |s: &str| matches!(s, "OR" | "AND" | "NOT");
    loop {
        let before = output_parts.len();
        // Drop trailing bare operators (no right operand).
        while output_parts.last().is_some_and(|s| is_bare_op(s)) {
            output_parts.pop();
        }
        // Drop the earlier of an adjacent bare-operator pair — it is the
        // one missing its right operand. Removing the earlier element
        // lets the survivor re-check its new neighbour next pass.
        if let Some(idx) = output_parts
            .windows(2)
            .position(|w| is_bare_op(&w[0]) && is_bare_op(&w[1]))
        {
            output_parts.remove(idx);
        }
        if output_parts.len() == before {
            break;
        }
    }

    output_parts.join(" ")
}

/// Row from the FTS5 search query (private; mapped to `ActiveBlockRow` for
/// response — the SQL filters deleted_at IS NULL`).
#[derive(Debug, sqlx::FromRow)]
struct FtsSearchRow {
    // Block fields
    id: crate::ulid::BlockId,
    block_type: String,
    content: Option<String>,
    parent_id: Option<crate::ulid::BlockId>,
    position: Option<i64>,
    // #109 Phase 2 — blocks.deleted_at is INTEGER epoch-ms (migration 0080).
    // The FTS SQL filters `deleted_at IS NULL`, so this is always None here,
    // but the type tracks the column to stay consistent with the cluster.
    deleted_at: Option<i64>,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    page_id: Option<String>,
    // PEND-50 Phase 1 — FTS5 `snippet()` window with #828 PUA sentinel
    // boundaries (U+E000 open / U+E001 close). May be `NULL` from SQLite
    // when the matched row has `content IS NULL` (page-title hits etc.).
    snippet: Option<String>,
    // FTS ranking field (for cursor)
    search_rank: f64,
}

/// Search blocks via FTS5 MATCH with cursor-based pagination.
///
/// Results are ordered by FTS5 rank (best match first) with `block_id` as
/// tiebreaker.  The cursor is a composite `(rank, id)` pair.  Rank comparison
/// uses an epsilon of 1e-9 (`ABS(rank - cursor_rank) < 1e-9`) instead of exact
/// float equality, which avoids potential duplicate or missing results caused by
/// floating-point precision drift between cursor serialization and SQLite
/// re-computation of the FTS5 rank.
///
/// Empty/whitespace queries return an empty response (no error).
///
/// The search limit is capped at [`MAX_SEARCH_RESULTS`] (100) per page,
/// regardless of the client-supplied limit.
///
/// ## Query sanitization
///
/// User input is sanitized via [`sanitize_fts_query`] before passing to FTS5
/// MATCH.  Quoted phrases, `NOT`, `OR`, and `AND` operators are preserved;
/// all other tokens are individually double-quoted to prevent injection of
/// arbitrary FTS5 syntax.
///
/// ## Tokenization
///
/// The FTS5 table uses the `trigram` tokenizer (`tokenize = 'trigram
/// case_sensitive 0'`, see migration `0006_fts5_trigram.sql`).  Trigrams
/// give substring search across all scripts including CJK, at the cost
/// of increased index size and a 3-character minimum match length —
/// queries shorter than 3 characters return no results.  Earlier
/// versions of this module used the default `unicode61` tokenizer, which
/// split CJK incorrectly; the trigram switch is what fixes that.
#[allow(clippy::too_many_arguments)] // PEND-54 added include/exclude path glob params; refactor to a struct lives in PEND-58.
pub async fn search_fts(
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
    // P4 (#346) — `Some(n)` truncates `content` at the DB (codepoint-safe
    // `substr`); `None` returns full content. The FE/IPC path passes
    // `None`; the MCP `search` tool passes `Some(SEARCH_SNIPPET_CAP)`.
    snippet_len: Option<usize>,
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    // Guard: empty/whitespace queries would cause an FTS5 syntax error.
    if query.trim().is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: None,
        });
    }

    // SQL-4 (PEND-58f) — reject over-long queries up front, before the
    // NFC-normalise + tokenise walk. Mirrors the regex path's
    // `MAX_PATTERN_LEN` guard.
    if query.len() > MAX_QUERY_LEN {
        return Err(AppError::Validation(format!(
            "search query is too long ({} bytes); maximum is {MAX_QUERY_LEN} bytes",
            query.len()
        )));
    }

    // Sanitize user input for safe FTS5 MATCH (F01: prevent operator injection).
    let sanitized = sanitize_fts_query(query);

    // Guard: I-Search-2 — `sanitize_fts_query` now drops sub-trigram
    // tokens (≤ 2 chars) and a non-operator-position `OR`. A query that
    // is exclusively those tokens (e.g. `"OR"`, `"a b"`, `"*"`) sanitises
    // to an empty string, which would otherwise be passed to FTS5 MATCH
    // and produce a syntax error. Mirror the raw-empty short-circuit
    // above so empty post-sanitisation also yields an empty page.
    if sanitized.is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: None,
        });
    }

    // Cap page limit to MAX_SEARCH_RESULTS
    let effective_limit = page.limit.min(MAX_SEARCH_RESULTS);
    let fetch_limit = effective_limit + 1;

    // Composite cursor: (rank, block_id).  Block ID is a deterministic
    // tiebreaker that avoids reliance on exact float equality for rank.
    let (cursor_flag, cursor_rank, cursor_id): (Option<i64>, f64, String) =
        match page.after.as_ref() {
            Some(c) => (Some(1), c.rank.unwrap_or(0.0), c.id.clone()),
            None => (None, 0.0, String::new()),
        };

    let rows = fts_fetch_rows(
        pool,
        &sanitized,
        cursor_flag,
        cursor_rank,
        &cursor_id,
        fetch_limit,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        block_type_filter,
        metadata,
        true, // `search_fts` always emits snippets — its caller has no
        // post-filter that would clobber them.
        // P4 (#346) — propagate the DB-side content truncation choice.
        snippet_len,
        // PEND-70 — the non-partitioned `search_fts` path is the
        // cursor-paginated `search_blocks` IPC; it is not subject to
        // the palette's keystroke-burst pattern (the panel paginates
        // explicitly via Load More). No cancellation token is wired
        // here today.
        None,
    )
    .await?;

    // effective_limit is a validated positive i64; safe to convert
    let limit_usize = usize::try_from(effective_limit).unwrap_or(usize::MAX);
    // rows.len() and limit_usize are both usize; direct comparison avoids cast
    let has_more = rows.len() > limit_usize;
    let cursor_data = if has_more {
        let last = &rows[limit_usize - 1];
        Some((last.id.as_str().to_string(), last.search_rank))
    } else {
        None
    };
    // PEND-50 Phase 1 — emit `SearchBlockRow` (= `ActiveBlockRow` +
    // `snippet`). The `snippet` column from FTS5 carries #828 PUA sentinel
    // boundaries (U+E000 / U+E001); the frontend parses them as
    // React nodes — never as raw HTML.
    let mut block_rows: Vec<SearchBlockRow> = rows.into_iter().map(fts_row_to_block_row).collect();

    if has_more {
        block_rows.truncate(limit_usize);
    }

    let next_cursor = if has_more {
        let (cursor_id, cursor_rank) = cursor_data.unwrap();
        Some(Cursor::for_id_and_rank(cursor_id, cursor_rank).encode()?)
    } else {
        None
    };

    Ok(PageResponse {
        items: block_rows,
        next_cursor,
        has_more,
        total_count: None,
    })
}

// ---------------------------------------------------------------------------
// SQL-A3 / BE-A1 (PEND-58f) — filter-aware cursor pagination
// ---------------------------------------------------------------------------

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
#[allow(clippy::too_many_arguments)]
pub(super) async fn fts_fetch_post_filtered_page<F>(
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

// ---------------------------------------------------------------------------
// Shared SQL builder + row fetcher
// ---------------------------------------------------------------------------

/// P4 (#346) — build the `content` SELECT expression for the search SQL.
///
/// - `None` → `b.content` (full column, unchanged behaviour; the FE/IPC
///   path always passes `None`).
/// - `Some(n)` → `substr(b.content, 1, n) AS content` — DB-side truncation
///   to the first `n` codepoints. `substr` on a TEXT column counts
///   codepoints (not bytes), so the cut never splits a multi-byte
///   character; the result is always valid UTF-8. Used by the MCP `search`
///   tool so it no longer ships up to 50 full block bodies just to
///   `.chars().take(512)` them in Rust.
///
/// `n` is a server-controlled `usize` (never user input), so formatting it
/// straight into the SQL text carries no injection risk. The `AS content`
/// alias keeps the column name stable for `FromRow`/positional decoding.
pub(super) fn content_select_expr(snippet_len: Option<usize>) -> String {
    match snippet_len {
        Some(n) => format!("substr(b.content, 1, {n}) AS content"),
        None => "b.content".to_string(),
    }
}

/// Build the dynamic FTS5 MATCH SQL and execute it, returning the raw
/// rows in rank order. Reused by both [`search_fts`] (cursor-paginated,
/// single-partition) and [`search_fts_partitioned`] (PEND-61 Phase 1,
/// no-cursor, two-partition).
///
/// Callers control:
/// - `sanitized` — already-[`sanitize_fts_query`]'d MATCH expression.
///   Caller must short-circuit on empty.
/// - `cursor_flag` / `cursor_rank` / `cursor_id` — composite (rank, id)
///   cursor. Pass `(None, 0.0, "")` to disable cursor filtering.
/// - `fetch_limit` — the `LIMIT` value bound at `?5`. Caller is
///   responsible for capping against [`MAX_SEARCH_RESULTS`].
/// - The remaining args are the structural filters threaded into
///   [`search_fts`] today; the partitioned caller passes
///   `block_type_filter = None` to fetch the unrestricted candidate
///   set and partitions in Rust.
/// - `with_snippet` — PEND-69 F5. `false` omits the FTS5
///   `snippet(...)` call from the SELECT (projects `NULL` instead) so
///   we don't re-tokenize once per row when the downstream pipeline
///   will overwrite `row.snippet = None` anyway (regex / non-regex
///   toggle post-filter paths). Saves a per-row tokenizer walk; the
///   FTS5 `snippet()` cost compounds on cold cache.
///
/// PEND-70 — `cancel` is an optional cancellation token. When `Some`,
/// the SQL `fetch_all` is raced against the cancel signal via
/// `tokio::select!`; if the signal fires, the SQL future is dropped
/// cleanly and the call returns [`AppError::Cancelled`]. Passing
/// `None` (or [`CancellationToken::never_cancelled`]) preserves the
/// pre-PEND-70 behaviour.
#[allow(clippy::too_many_arguments)]
async fn fts_fetch_rows(
    pool: &SqlitePool,
    sanitized: &str,
    cursor_flag: Option<i64>,
    cursor_rank: f64,
    cursor_id: &str,
    fetch_limit: i64,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    block_type_filter: Option<&str>,
    metadata: &MetadataPredicates,
    with_snippet: bool,
    // P4 (#346) — `Some(n)` truncates `content` to the first `n` codepoints
    // via `substr(b.content, 1, n)` in SQL; `None` selects the full column.
    snippet_len: Option<usize>,
    cancel: Option<CancellationToken>,
) -> Result<Vec<FtsSearchRow>, AppError> {
    // PEND-70 — early-cancel before we even touch the read pool.
    // The next-keystroke palette pattern fires fresh IPCs faster than
    // SQLite can deliver a connection, so checking here catches the
    // burst before we waste a pool slot.
    if let Some(ref token) = cancel
        && token.is_cancelled()
    {
        return Err(AppError::Cancelled);
    }
    // Build dynamic SQL with optional filter clauses.
    // Base parameters: ?1=query, ?2=cursor_flag, ?3=cursor_rank, ?4=cursor_id, ?5=limit
    // Additional parameters are appended after ?5 for parent_id, tag_ids,
    // and (FEAT-3 Phase 2) space_id.
    // PEND-50 Phase 1 — `snippet()` carries #828 PUA sentinel boundaries
    // (U+E000 open / U+E001 close, see SNIPPET_SQL_PROJECTION) around each
    // match span. Column index 1 = the `stripped`
    // column of `fts_blocks` (migration `0006_fts5_trigram.sql:13`).
    // Window width is `32` trigrams (≈ a few words); the constant is
    // documented in PEND-50's "Edge cases" as tunable. The leading /
    // trailing `…` flag truncation. The result is rendered as React
    // nodes by the frontend; NEVER `dangerouslySetInnerHTML`.
    //
    // PEND-69 F5 — when the downstream pipeline will clear
    // `row.snippet` (toggle post-filter paths), project `NULL` instead
    // of calling `snippet()` so we don't pay the per-row tokenizer
    // walk just to throw the result away.
    let snippet_select = if with_snippet {
        SNIPPET_SQL_PROJECTION
    } else {
        "NULL as snippet"
    };
    // SQL-9 (PEND-58f) — the cursor tiebreak uses an EPSILON of `1e-9`:
    // `ABS(fts.rank - ?3) < 1e-9` treats two ranks within 1e-9 of each
    // other as "equal" and falls back to the `b.id` tiebreaker. This
    // couples pagination correctness to bm25's numeric scale. The
    // assumption is that genuinely-distinct adjacent ranks differ by far
    // more than 1e-9 (bm25 scores are O(1)–O(10) for typical corpora), so
    // 1e-9 only ever absorbs float-precision drift between the cursor's
    // serialized rank and SQLite's recomputation — never two legitimately
    // different ranks. If a future ranking function emits scores whose
    // meaningful resolution is finer than 1e-9, this epsilon would merge
    // distinct ranks and skip/duplicate rows at the page boundary; revisit
    // it together with the cursor `rank` field then.
    //
    // #671 — the strict-greater arm must clear the epsilon band, i.e.
    // `fts.rank > ?3 + 1e-9`, NOT `fts.rank > ?3`. The boundary row's
    // recomputed rank can drift UPWARD into `(?3, ?3 + 1e-9)`; with a bare
    // `> ?3` that row satisfies the first disjunct and is re-emitted on the
    // next page (the `ABS(...) < 1e-9 AND id > ?4` tiebreak never gets to
    // exclude it). Adding `+ 1e-9` makes the predicate symmetric: anything
    // inside the epsilon band falls through to the id tiebreak, only a
    // genuinely-greater rank advances past it.
    // P4 (#346) — when the caller (the MCP `search` tool) supplies a
    // `snippet_len`, truncate `content` at the DB with `substr(b.content,
    // 1, N)` instead of shipping the full column up to Rust to be
    // truncated. `substr` on TEXT counts codepoints, so the cut is always
    // on a char boundary (valid UTF-8). `N` is a server-controlled
    // `usize` (never user input), so inlining it into the SQL text is
    // injection-safe and avoids juggling another bound `?N` index through
    // the dynamic filter builder.
    let content_select = content_select_expr(snippet_len);
    let mut sql = format!(
        r#"SELECT b.id, b.block_type, {content_select}, b.parent_id, b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id,
                {snippet_select},
                fts.rank as search_rank
         FROM fts_blocks fts
         JOIN blocks b ON b.id = fts.block_id
         WHERE fts_blocks MATCH ?1
           AND b.deleted_at IS NULL
           AND (?2 IS NULL OR fts.rank > ?3 + 1e-9
                OR (ABS(fts.rank - ?3) < 1e-9 AND b.id > ?4))"#,
    );

    // M2 (#348) — `StructuralFilterBuilder` owns the dynamic fragment,
    // the running `?N` index, and the ordered bind sequence atomically,
    // so the SQL-append order and the `.bind()` order cannot drift. The
    // first 5 placeholders (`?1..?5`) are this builder's fixed base
    // params, so dynamic filters start at `?6`. The 11-space `AND `
    // prefix preserves the exact pre-M2 SQL byte sequence.
    const PREFIX: &str = "\n           AND ";
    let mut fb = super::filter_builder::StructuralFilterBuilder::new(6);

    // Optional parent_id filter.
    fb.add_parent(PREFIX, parent_id);

    // Optional tag_ids filter (ALL semantics).
    //
    // SQL-1 (PEND-58f) — dedupe the caller's `tag_ids` before binding.
    // The "ALL tags" clause compares `COUNT(DISTINCT bt.tag_id)` against
    // the bound list length; a duplicate tag id (e.g. the same chip added
    // twice, or two FE code paths appending the same id) would make the
    // raw `len()` exceed the achievable distinct count, so the predicate
    // could never be satisfied and the query silently returned zero rows.
    // De-duplicating here makes the bound count match the `DISTINCT`
    // semantics. Order is preserved so the placeholder/bind indices stay
    // deterministic.
    //
    // SQL-A6 (PEND-58f) — normalise each id to its canonical UPPERCASE
    // ULID form BEFORE the dedup set (and bind the normalised form).
    // `block_tags.tag_id` stores the canonical uppercase Crockford-base32
    // ULID (`BlockId`/`ActiveBlockId` both normalise via
    // `to_ascii_uppercase`), so a mixed-case duplicate would survive
    // byte-exact dedup, inflate the bound count past the achievable
    // `COUNT(DISTINCT)`, and silently zero out the ALL-tags predicate.
    let active_tag_ids: Vec<String> = match tag_ids {
        Some(ids) if !ids.is_empty() => {
            let mut seen = std::collections::HashSet::new();
            ids.iter()
                .map(|id| id.to_ascii_uppercase())
                .filter(|id| seen.insert(id.clone()))
                .collect()
        }
        _ => Vec::new(),
    };
    // #1320 PR-1 — the ALL-tags filter is now compiled through
    // `SearchProjection` (the cross-surface filter compiler) rather than
    // the inline `COUNT(DISTINCT)` fragment. `add_tags_via_projection`
    // emits one per-tag `b.id IN (SELECT block_id FROM block_tags WHERE
    // tag_id = ?N)` sub-select, AND-joined under `PREFIX`. A block in
    // EVERY per-tag set carries every requested tag, so this is
    // result-equivalent to the legacy `COUNT(DISTINCT bt.tag_id) = N`
    // ALL-semantics (the SQL shape differs; equivalence is proved by the
    // `tags_via_projection_matches_legacy_*` DB tests in `filter_builder`).
    // Follows the `Space` cutover (PR-0). As of #1320 PR-3 the legacy
    // `add_tags_all` builder is retired — every search path (this one plus
    // the toggle-filter `regex_mode_query` / `filter_only_scan` builders) now
    // routes tags through `add_tags_via_projection`.
    fb.add_tags_via_projection(PREFIX, &active_tag_ids);

    // FEAT-3 Phase 2 — optional space-id filter. Filters on the
    // first-class `b.space_id` column directly (#533, migration 0086 — the
    // former `b.page_id IN (SELECT … block_properties WHERE key = 'space')`
    // sub-select is gone). Appends the bare `b.space_id = ?N` form (no
    // `?N IS NULL OR` guard — this fragment is only appended when a space
    // is active, so the NULL short-circuit of the pagination helpers'
    // `crate::space_filter_canonical::SPACE_FILTER_CANONICAL` is
    // unnecessary here). Kept inline (via the builder) because the
    // dynamic-SQL shape of this query (varying param indices for parent /
    // tag / space filters) prevents the compile-time sqlx macro from being
    // applied.
    //
    // #1320 PR-0 — the space-id fragment is now compiled through
    // `SearchProjection` (the cross-surface filter compiler) rather than
    // inline. `compile_space` emits the identical `b.space_id = ?` shape
    // with one text bind, so the net SQL + binds are byte-identical to the
    // former `fb.add_space(...)` call (proved by the `projection_space_parity`
    // test). This is the projection's first production call site. Only
    // `Space` is routed — Tag (`COUNT(DISTINCT)` ALL-semantics) and property
    // (`prop:` four-column OR) diverge from the projection and stay legacy.
    fb.add_space_via_projection(PREFIX, space_id);

    // PEND-54 — page-name glob include / exclude filters. Each entry
    // has already been brace-expanded, lowercased and substring-
    // wrapped by `prepare_globs`; the shared P2 (#346) helper binds one
    // parameter per pattern and OR-joins inside each `IN (...)`
    // sub-select. `LOWER(title)` is applied SQL-side (cheap on the small
    // `pages_cache` table).
    //
    // SQL-2 (PEND-58f) — that `LOWER(pc.title) GLOB ?` clause is a
    // `pages_cache` SCAN; it does NOT use `idx_pages_cache_title_nocase`.
    // See `glob_filter::append_page_glob_subselect` and migration
    // `0068_pages_cache_title_index.sql` for the full rationale.
    fb.add_page_globs_via_projection(PREFIX, false, include_page_globs);
    fb.add_page_globs_via_projection(PREFIX, true, exclude_page_globs);

    // PEND-51 — optional `block_type` equality filter. The palette
    // fires a page-only query (`block_type_filter = Some("page")`)
    // alongside the unrestricted blocks query so the FE only has to
    // merge by `page_id`. `None` preserves today's no-filter behaviour.
    // PEND-61 Phase 1 — the partitioned caller passes `None` here and
    // partitions in Rust instead.
    // #1280 B2 — routed through `SearchProjection::compile_block_type`
    // (canonical A2 SQL). Result-equivalent to the legacy `b.block_type = ?`
    // fragment for the single-value FTS filter (the projection emits
    // `b.block_type IN (?)`); `None` stays a no-op.
    fb.add_block_type_via_projection(PREFIX, block_type_filter);

    // PEND-53 — priority / property metadata predicates (legacy path), plus
    // state / due / scheduled routed through `SearchProjection` (#1280 B2),
    // spliced (with their ordered binds) into the builder.
    fb.add_metadata(metadata, "b");

    sql.push_str(fb.sql());
    sql.push_str("\n         ORDER BY fts.rank, b.id");
    sql.push_str("\n         LIMIT ?5");

    // Build and bind the query dynamically. Base params `?1..?5` first,
    // then the builder replays its ordered dynamic binds.
    let db_query = sqlx::query_as::<_, FtsSearchRow>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(sanitized) // ?1
        .bind(cursor_flag) // ?2
        .bind(cursor_rank) // ?3
        .bind(cursor_id) // ?4
        .bind(fetch_limit); // ?5
    let db_query = fb.apply(db_query);

    // PEND-70 — acquire a read-pool connection via the slow-acquire
    // logger so saturation under bursty typing surfaces in the log.
    let mut conn = search_pool_acquire_logged(pool, "fts_fetch_rows")
        .await
        .map_err(AppError::Database)?;

    // PEND-70 — measure the per-query wall time so pathological scans
    // surface in the log. The timer starts after the pool acquire
    // because the acquire wait is already logged by
    // `search_pool_acquire_logged`.
    let query_start = Instant::now();

    // PEND-70 — race the SQL fetch against the cancellation signal so
    // the in-flight Rust future drops cleanly when the client
    // unsubscribed. Dropping the `fetch_all` future cancels the
    // underlying SQLite statement at the next yield point — typical
    // cancellation latency is one row-batch boundary (≤ 50 ms),
    // worst-case is the SQLite step granularity (≤ 200 ms).
    let fetch_future = db_query.fetch_all(&mut *conn);
    let result = match cancel {
        Some(mut token) => {
            tokio::select! {
                biased;
                // Check cancel first each poll so a fast-fire from the
                // palette's next keystroke wins the race against an
                // already-ready SQL result.
                () = token.cancelled() => {
                    return Err(AppError::Cancelled);
                }
                res = fetch_future => res,
            }
        }
        None => fetch_future.await,
    };

    let elapsed = query_start.elapsed();
    if elapsed >= Duration::from_millis(u64::try_from(FTS_QUERY_WARN_MS).unwrap_or(u64::MAX)) {
        tracing::warn!(
            elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
            fetch_limit,
            "slow FTS query"
        );
    } else if elapsed >= Duration::from_millis(u64::try_from(FTS_QUERY_INFO_MS).unwrap_or(u64::MAX))
    {
        tracing::info!(
            elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
            fetch_limit,
            "FTS query crossed info threshold"
        );
    }

    result.map_err(|e| {
        // PEND-73 Phase 1.B5 — robust FTS5 parse-error mapping.
        //
        // We want to translate FTS5 MATCH-syntax errors into a
        // user-facing validation error, but every other SQLite error
        // (constraint violation, busy timeout, IO) must keep its
        // `AppError::Database` discriminant. The original implementation
        // substring-matched on the message text ("fts5:" / "parse
        // error") — fragile against translation, future libsqlite
        // wording, and false positives when those tokens appear in
        // bound parameter values.
        //
        // Replacement check:
        //   * the error originates from the database driver, AND
        //   * its code is the generic SQLITE_ERROR (sqlx surfaces "1"),
        //     AND
        //   * the message starts with the canonical `fts5: ` prefix
        //     that SQLite's FTS5 module emits.
        // The starts_with on the canonical prefix is the durable
        // signal; the code check is the redundant guard. Defence in
        // depth — both have to align.
        let is_fts5_parse_error = matches!(&e, sqlx::Error::Database(db) if {
            let code_match = matches!(db.code().as_deref(), Some("1") | Some("SQLITE_ERROR"));
            let prefix_match = db.message().starts_with("fts5: ");
            code_match && prefix_match
        });
        if is_fts5_parse_error {
            AppError::Validation(format!(
                "Invalid search query: check for unmatched quotes or special characters. \
                     Details: {e}"
            ))
        } else {
            AppError::Database(e)
        }
    })
}

/// Map a raw [`FtsSearchRow`] into the IPC wire shape [`SearchBlockRow`].
///
/// The FTS path emits no `match_offsets` — those are the toggle
/// pipeline's responsibility (see `super::toggle_filter`).
fn fts_row_to_block_row(r: FtsSearchRow) -> SearchBlockRow {
    SearchBlockRow {
        // MAINT-113 M1.5 — boundary cast: the FTS SQL filters
        // `deleted_at IS NULL`, so every surviving row is active.
        // `from_trusted_active` records the claim in the type system
        // without re-running the predicate.
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
        snippet: r.snippet,
        match_offsets: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// PEND-61 Phase 1 — partitioned FTS scan
// ---------------------------------------------------------------------------

/// Outcome of [`search_fts_partitioned`] — two pre-partitioned candidate
/// sets (page-only + unrestricted), each with its own `has_more` flag
/// derived from a `limit + 1` probe.
///
/// PEND-69 F1 — the previous one-scan-then-partition shape could drop
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
    /// probe approach (resolves PEND-69 Open Q3). Lets the caller
    /// signal accurate per-partition pagination instead of inferring
    /// from the global ceiling.
    pub pages_has_more: bool,
    /// `true` iff the blocks scan returned `block_limit + 1` rows.
    /// Same probe semantics as `pages_has_more`.
    pub blocks_has_more: bool,
}

/// PEND-61 Phase 1 / PEND-69 F1 — two parallel FTS scans for the
/// palette's two-partition view. Each scan reuses the same SQL builder
/// as [`search_fts`]; the pages scan adds `block_type = 'page'` to the
/// WHERE clause and uses `with_snippet = with_snippet_pages`, the
/// blocks scan adds no `block_type` filter.
///
/// Both scans use a `limit + 1` probe so the caller can signal accurate
/// per-partition `has_more` (resolves PEND-69 Open Q3).
///
/// All other filters — `parent_id`, `tag_ids`, `space_id`, page-name
/// globs, metadata predicates — are honoured identically on both
/// scans.
///
/// Concurrency: both scans run via [`tokio::try_join!`] on the shared
/// read pool. With `max_connections(4)` we afford two reads per IPC.
/// Fail-fast semantics (PEND-69 Open Q2) — if either scan errors, the
/// other is dropped and the error propagates without a partial
/// response.
///
/// Empty / whitespace queries short-circuit to two empty partitions,
/// mirroring [`search_fts`].
///
/// PEND-70 — `cancel` is an optional cancellation token threaded
/// through both partition scans into [`fts_fetch_rows`]. The Tauri
/// command wrapper (`search_blocks_partitioned`) stores a
/// [`CancellationGuard`] in the [`crate::cancellation::CancellationRegistry`]
/// and spawns the inner search via `tokio::spawn`; when the wrapper
/// future drops, the guard fires and both scans bail on their next
/// `tokio::select!` boundary.
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

    // SQL-4 (PEND-58f) — same up-front length cap as `search_fts`.
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

    // PEND-69 F1 — each scan independently caps at `MAX_SEARCH_RESULTS`
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
        Some("page"), // PEND-69 F1: page-only pre-filter at SQL
        metadata,
        with_snippet,
        // P4 (#346) — the partitioned (palette) path always returns full
        // content; only the MCP cursor path opts into DB-side truncation.
        None,
        // PEND-70 — clone the cancel token so both partition scans
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

    // SQL-3 (PEND-58f) — clamp the comparison limit to the same
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
/// SQL-3 (PEND-58f) — the previous implementation computed
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

// ---------------------------------------------------------------------------
// PEND-69 — test-only SQL builder accessor
// ---------------------------------------------------------------------------

/// Test-only: expose the FTS5 SELECT prefix the runtime would emit for
/// a given `with_snippet` choice. Used to assert that `snippet(` is
/// absent when the downstream pipeline will clear `row.snippet`.
///
/// Returns just the first `format!` shape — the dynamic per-filter
/// `AND` clauses are appended after this prefix and don't change the
/// `snippet(` presence question.
#[cfg(test)]
pub(crate) fn fts_select_prefix_for_test(with_snippet: bool) -> String {
    let snippet_select = if with_snippet {
        SNIPPET_SQL_PROJECTION
    } else {
        "NULL as snippet"
    };
    format!(
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id,
                {snippet_select},
                fts.rank as search_rank
         FROM fts_blocks fts
         JOIN blocks b ON b.id = fts.block_id
         WHERE fts_blocks MATCH ?1
           AND b.deleted_at IS NULL
           AND (?2 IS NULL OR fts.rank > ?3 + 1e-9
                OR (ABS(fts.rank - ?3) < 1e-9 AND b.id > ?4))"#,
    )
}
