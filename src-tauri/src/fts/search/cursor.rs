//! Cursor-based pagination engine: the public `search_fts` entry point
//! used by the `search_blocks` IPC command.

use sqlx::SqlitePool;

use crate::domain::search_types::SearchBlockRow;
use crate::error::AppError;
use crate::pagination::{Cursor, PageRequest, PageResponse};

use super::super::metadata_filter::MetadataPredicates;
use super::constants::{MAX_QUERY_LEN, MAX_SEARCH_RESULTS};
use super::fetch::fts_fetch_rows;
use super::row::fts_row_to_block_row;
use super::sanitizer::sanitize_fts_query;

/// Search blocks via FTS5 MATCH with cursor-based pagination.
///
/// Results are ordered by FTS5 rank (best match first) with `block_id` as
/// tiebreaker.  The cursor is a composite `(rank, id)` pair.  Rank comparison
/// uses a *relative* epsilon — `ABS(rank - cursor_rank) <= 1e-9 * MAX(1, ABS(cursor_rank))`
/// (#1598) — instead of a fixed absolute band, so the tolerance scales with the
/// rank's magnitude.  This absorbs floating-point precision drift between cursor
/// serialization and SQLite's re-computation of the FTS5 rank without coupling
/// pagination correctness to bm25's numeric scale (equal-rank rows are always
/// disambiguated by the unique `block_id`).
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
