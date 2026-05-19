//! FTS5 search and query processing.
//!
//! Contains the `search_fts` function for paginated FTS5 MATCH queries and
//! the `sanitize_fts_query` helper for safe query construction.

use sqlx::SqlitePool;

use crate::commands::SearchBlockRow;
use crate::error::AppError;
use crate::pagination::{Cursor, PageRequest, PageResponse};

use super::metadata_filter::MetadataPredicates;

// ---------------------------------------------------------------------------
// FTS5 search
// ---------------------------------------------------------------------------

/// Maximum number of results returned from a single search query, regardless
/// of the client-supplied page limit.  Prevents unbounded result sets.
///
/// PEND-61 Phase 1 — also used by [`search_fts_partitioned`] as the
/// ceiling on the combined `page_limit + block_limit` fetch.
pub(super) const MAX_SEARCH_RESULTS: i64 = 100;

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
/// queries like `"exact phrase"`, `NOT spam`, or `cats OR dogs`.
///
/// ## Rules
///
/// 1. **Quoted phrases** — matched `"..."` in the input are kept as a single
///    FTS5 phrase token (internal `"` escaped by doubling). Quoted phrases
///    are *not* subject to the trigram length filter — the user explicitly
///    asked for them.
/// 2. **`NOT` operator** — preserved as the bare keyword when followed by at
///    least one more token.
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
    let tokens = tokenize_query(query);
    let len = tokens.len();
    let mut output_parts: Vec<String> = Vec::new();

    for (i, token) in tokens.iter().enumerate() {
        match token {
            QueryToken::QuotedPhrase(phrase) => {
                // User-quoted phrases bypass the trigram length filter —
                // the explicit quoting signals intent.
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

    output_parts.join(" ")
}

/// Row from the FTS5 search query (private; mapped to `ActiveBlockRow` for
/// response — the SQL filters deleted_at IS NULL`).
#[derive(Debug, sqlx::FromRow)]
struct FtsSearchRow {
    // Block fields
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
    // PEND-50 Phase 1 — FTS5 `snippet()` window with literal `<mark>` /
    // `</mark>` boundaries. May be `NULL` from SQLite when the matched
    // row has `content IS NULL` (page-title hits etc.).
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
    )
    .await?;

    // effective_limit is a validated positive i64; safe to convert
    let limit_usize = usize::try_from(effective_limit).unwrap_or(usize::MAX);
    // rows.len() and limit_usize are both usize; direct comparison avoids cast
    let has_more = rows.len() > limit_usize;
    let cursor_data = if has_more {
        let last = &rows[limit_usize - 1];
        Some((last.id.clone(), last.search_rank))
    } else {
        None
    };
    // PEND-50 Phase 1 — emit `SearchBlockRow` (= `ActiveBlockRow` +
    // `snippet`). The `snippet` column from FTS5 carries literal
    // `<mark>` / `</mark>` boundaries; the frontend parses them as
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
// Shared SQL builder + row fetcher
// ---------------------------------------------------------------------------

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
) -> Result<Vec<FtsSearchRow>, AppError> {
    // Build dynamic SQL with optional filter clauses.
    // Base parameters: ?1=query, ?2=cursor_flag, ?3=cursor_rank, ?4=cursor_id, ?5=limit
    // Additional parameters are appended after ?5 for parent_id, tag_ids,
    // and (FEAT-3 Phase 2) space_id.
    // PEND-50 Phase 1 — `snippet()` carries literal `<mark>` / `</mark>`
    // boundaries around each match span. Column index 1 = the `stripped`
    // column of `fts_blocks` (migration `0006_fts5_trigram.sql:13`).
    // Window width is `32` trigrams (≈ a few words); the constant is
    // documented in PEND-50's "Edge cases" as tunable. The leading /
    // trailing `…` flag truncation. The result is rendered as React
    // nodes by the frontend; NEVER `dangerouslySetInnerHTML`.
    let mut sql = String::from(
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id,
                snippet(fts_blocks, 1, '<mark>', '</mark>', '…', 32) as snippet,
                fts.rank as search_rank
         FROM fts_blocks fts
         JOIN blocks b ON b.id = fts.block_id
         WHERE fts_blocks MATCH ?1
           AND b.deleted_at IS NULL
           AND (?2 IS NULL OR fts.rank > ?3
                OR (ABS(fts.rank - ?3) < 1e-9 AND b.id > ?4))"#,
    );

    // Track next parameter index (1-based); first 5 are base params.
    let mut next_param = 6;

    // Optional parent_id filter
    let parent_param_idx = if parent_id.is_some() {
        let idx = next_param;
        sql.push_str(&format!("\n           AND b.parent_id = ?{idx}"));
        next_param += 1;
        Some(idx)
    } else {
        None
    };

    // Optional tag_ids filter (ALL semantics)
    let tag_count_param_idx;
    let tag_param_start;
    let active_tag_ids: &[String] = match tag_ids {
        Some(ids) if !ids.is_empty() => {
            // Build IN-list placeholders for tag IDs
            let placeholders: Vec<String> = (0..ids.len())
                .map(|i| format!("?{}", next_param + i))
                .collect();
            tag_param_start = next_param;
            next_param += ids.len();
            tag_count_param_idx = next_param;
            next_param += 1;
            sql.push_str(&format!(
                "\n           AND (SELECT COUNT(DISTINCT bt.tag_id) FROM block_tags bt WHERE bt.block_id = b.id AND bt.tag_id IN ({})) = ?{tag_count_param_idx}",
                placeholders.join(", ")
            ));
            ids
        }
        _ => {
            tag_param_start = 0;
            tag_count_param_idx = 0;
            &[]
        }
    };

    // FEAT-3 Phase 2 — optional space-id filter. Resolves content blocks
    // to their owning page via `b.page_id` and intersects
    // against `block_properties(key = 'space').value_ref`. Mirrors the
    // `crate::space_filter_clause!` macro used by the pagination helpers
    // — kept inline here because the dynamic-SQL shape of this query
    // (varying param indices for parent / tag / space filters) prevents
    // the compile-time sqlx macro from being applied.
    let space_param_idx = if space_id.is_some() {
        let idx = next_param;
        sql.push_str(&format!(
            "\n           AND b.page_id IN (\
             SELECT bp.block_id FROM block_properties bp \
             WHERE bp.key = 'space' AND bp.value_ref = ?{idx})"
        ));
        next_param += 1;
        Some(idx)
    } else {
        None
    };

    // PEND-54 — page-name glob include / exclude filters. Each entry
    // has already been brace-expanded, lowercased and substring-
    // wrapped by `prepare_globs`; we bind one parameter per pattern
    // and OR-join inside each `IN (...)` sub-select. `LOWER(title)`
    // is applied SQL-side (cheap on the small `pages_cache` table).
    let include_glob_param_start = if !include_page_globs.is_empty() {
        let start = next_param;
        let placeholders: Vec<String> = (0..include_page_globs.len())
            .map(|i| format!("LOWER(pc.title) GLOB ?{}", start + i))
            .collect();
        sql.push_str(&format!(
            "\n           AND b.page_id IN (SELECT pc.page_id FROM pages_cache pc WHERE {})",
            placeholders.join(" OR ")
        ));
        next_param += include_page_globs.len();
        Some(start)
    } else {
        None
    };

    let exclude_glob_param_start = if !exclude_page_globs.is_empty() {
        let start = next_param;
        let placeholders: Vec<String> = (0..exclude_page_globs.len())
            .map(|i| format!("LOWER(pc.title) GLOB ?{}", start + i))
            .collect();
        sql.push_str(&format!(
            "\n           AND b.page_id NOT IN (SELECT pc.page_id FROM pages_cache pc WHERE {})",
            placeholders.join(" OR ")
        ));
        next_param += exclude_page_globs.len();
        Some(start)
    } else {
        None
    };

    // PEND-51 — optional `block_type` equality filter. The palette
    // fires a page-only query (`block_type_filter = Some("page")`)
    // alongside the unrestricted blocks query so the FE only has to
    // merge by `page_id`. `None` preserves the today's no-filter
    // behaviour. PEND-61 Phase 1 — the partitioned caller passes
    // `None` here and partitions in Rust instead.
    let block_type_param_idx = if block_type_filter.is_some() {
        let idx = next_param;
        sql.push_str(&format!("\n           AND b.block_type = ?{idx}"));
        next_param += 1;
        Some(idx)
    } else {
        None
    };

    // PEND-53 — state / priority / due / scheduled / property
    // metadata predicates. `append_metadata_sql` mutates both `sql`
    // and `next_param` and returns the bind values in declaration
    // order. The caller binds them after the existing parameters.
    let metadata_binds =
        super::metadata_filter::append_metadata_sql(&mut sql, &mut next_param, metadata, "b");

    // Suppress unused variable warnings — these indices are used only when
    // the corresponding filter is active, but the compiler cannot see that
    // through the dynamic query-building logic.
    let _ = (
        parent_param_idx,
        tag_param_start,
        tag_count_param_idx,
        space_param_idx,
        include_glob_param_start,
        exclude_glob_param_start,
        block_type_param_idx,
        next_param,
    );

    sql.push_str("\n         ORDER BY fts.rank, b.id");
    sql.push_str("\n         LIMIT ?5");

    // Build and bind the query dynamically.
    let mut db_query = sqlx::query_as::<_, FtsSearchRow>(&sql)
        .bind(sanitized) // ?1
        .bind(cursor_flag) // ?2
        .bind(cursor_rank) // ?3
        .bind(cursor_id) // ?4
        .bind(fetch_limit); // ?5

    if let Some(pid) = parent_id {
        db_query = db_query.bind(pid);
    }
    for tag_id in active_tag_ids {
        db_query = db_query.bind(tag_id);
    }
    if !active_tag_ids.is_empty() {
        let tag_count: i64 = i64::try_from(active_tag_ids.len())
            .expect("invariant: active_tag_ids is a small filter list and its len fits in i64");
        db_query = db_query.bind(tag_count);
    }
    if let Some(sid) = space_id {
        db_query = db_query.bind(sid);
    }
    // PEND-54 — bind include / exclude glob patterns in declaration
    // order to match the placeholder indices appended above.
    for pat in include_page_globs {
        db_query = db_query.bind(pat);
    }
    for pat in exclude_page_globs {
        db_query = db_query.bind(pat);
    }
    // PEND-51 — bind `block_type` filter value last so the placeholder
    // index matches the order it was appended to the SQL above.
    if let Some(bt) = block_type_filter {
        db_query = db_query.bind(bt);
    }
    // PEND-53 / PEND-64 — bind metadata values in the same order as
    // `append_metadata_sql` declared them. PEND-64 widened the bind
    // type to `MetaBind` so nullable `value_num` / `value_date` /
    // `value_ref` variants can carry SQL `NULL` for non-parseable
    // user inputs.
    for v in &metadata_binds {
        db_query = v.bind(db_query);
    }

    db_query.fetch_all(pool).await.map_err(|e| {
        // Map any SQLite error from the MATCH query to a validation error.
        // With query sanitization this should be rare, but acts as defense-in-depth.
        let msg = e.to_string();
        if msg.contains("fts5:") || msg.contains("parse error") {
            AppError::Validation(format!(
                "Invalid search query: check for unmatched quotes or special characters. \
                     Details: {msg}"
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
        snippet: r.snippet,
        match_offsets: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// PEND-61 Phase 1 — partitioned FTS scan
// ---------------------------------------------------------------------------

/// Outcome of [`search_fts_partitioned`] — the unrestricted rank-ordered
/// candidate set plus a flag indicating whether the combined fetch was
/// capped by [`MAX_SEARCH_RESULTS`].
///
/// The caller (the `search_blocks_partitioned` IPC) then partitions in
/// Rust: pages = rows with `block_type == "page"` capped at `page_limit`,
/// blocks = ALL rows capped at `block_limit`. The `ceiling_hit` flag
/// participates in the per-partition `has_more` semantics — when the
/// combined fetch saturates the ceiling, either partition can legitimately
/// report `has_more = true` regardless of its own intra-partition cap.
pub(crate) struct FtsPartitionedScan {
    /// Rank-ordered candidate set (no `block_type` filter applied at the
    /// SQL layer). The length is bounded by
    /// `min(page_limit + block_limit + 1, MAX_SEARCH_RESULTS)`.
    pub rows: Vec<SearchBlockRow>,
    /// `true` iff the combined fetch returned exactly
    /// [`MAX_SEARCH_RESULTS`] rows — the SQL ceiling, not the caller's
    /// `page_limit + block_limit + 1` ask. Distinct from
    /// `rows.len() > page_limit + block_limit` because the ceiling can
    /// be hit even when one partition is empty.
    pub ceiling_hit: bool,
}

/// PEND-61 Phase 1 — one-pass FTS scan for the palette's two-partition
/// view. Reuses the same SQL builder as [`search_fts`] but bypasses the
/// `block_type_filter` (the partitioning is done in Rust by the caller)
/// and returns no cursor (the palette doesn't paginate).
///
/// All other filters — `parent_id`, `tag_ids`, `space_id`, page-name
/// globs, metadata predicates — are honoured the same way as
/// [`search_fts`].
///
/// Empty / whitespace queries short-circuit to an empty result with
/// `ceiling_hit = false`, mirroring [`search_fts`].
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
) -> Result<FtsPartitionedScan, AppError> {
    // Guard: empty/whitespace queries would cause an FTS5 syntax error.
    if query.trim().is_empty() {
        return Ok(FtsPartitionedScan {
            rows: Vec::new(),
            ceiling_hit: false,
        });
    }

    let sanitized = sanitize_fts_query(query);

    // Guard: post-sanitisation may yield empty (e.g. all sub-trigram
    // tokens) — same short-circuit as `search_fts`.
    if sanitized.is_empty() {
        return Ok(FtsPartitionedScan {
            rows: Vec::new(),
            ceiling_hit: false,
        });
    }

    // Combined fetch = page_limit + block_limit + 1 so the caller can
    // detect per-partition overflow without a second query. Cap at
    // MAX_SEARCH_RESULTS as the SQL ceiling. `u64` math protects against
    // pathological `u32::MAX + u32::MAX` overflow before the i64 cast.
    let combined: u64 = u64::from(page_limit) + u64::from(block_limit) + 1;
    let max_results_u64 = u64::try_from(MAX_SEARCH_RESULTS).unwrap_or(u64::MAX);
    let capped = combined.min(max_results_u64);
    // `capped` ≤ MAX_SEARCH_RESULTS (100), which fits an i64.
    let fetch_limit = i64::try_from(capped).unwrap_or(MAX_SEARCH_RESULTS);

    let rows = fts_fetch_rows(
        pool,
        &sanitized,
        None, // no cursor — palette doesn't paginate
        0.0,
        "",
        fetch_limit,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        None, // PEND-61: block_type filter is applied in Rust, not SQL
        metadata,
    )
    .await?;

    let ceiling_hit = i64::try_from(rows.len()).unwrap_or(i64::MAX) >= MAX_SEARCH_RESULTS;

    Ok(FtsPartitionedScan {
        rows: rows.into_iter().map(fts_row_to_block_row).collect(),
        ceiling_hit,
    })
}
