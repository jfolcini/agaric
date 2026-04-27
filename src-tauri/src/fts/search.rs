//! FTS5 search and query processing.
//!
//! Contains the `search_fts` function for paginated FTS5 MATCH queries and
//! the `sanitize_fts_query` helper for safe query construction.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::pagination::{BlockRow, Cursor, PageRequest, PageResponse};

// ---------------------------------------------------------------------------
// FTS5 search
// ---------------------------------------------------------------------------

/// Maximum number of results returned from a single search query, regardless
/// of the client-supplied page limit.  Prevents unbounded result sets.
const MAX_SEARCH_RESULTS: i64 = 100;

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

/// Row from the FTS5 search query (private; mapped to BlockRow for response).
#[derive(Debug, sqlx::FromRow)]
struct FtsSearchRow {
    // Block fields
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<String>,
    is_conflict: bool,
    conflict_type: Option<String>,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    page_id: Option<String>,
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
pub async fn search_fts(
    pool: &SqlitePool,
    query: &str,
    page: &PageRequest,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
) -> Result<PageResponse<BlockRow>, AppError> {
    // Guard: empty/whitespace queries would cause an FTS5 syntax error.
    if query.trim().is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
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

    // Build dynamic SQL with optional filter clauses.
    // Base parameters: ?1=query, ?2=cursor_flag, ?3=cursor_rank, ?4=cursor_id, ?5=limit
    // Additional parameters are appended after ?5 for parent_id, tag_ids,
    // and (FEAT-3 Phase 2) space_id.
    let mut sql = String::from(
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict, b.conflict_type,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id,
                fts.rank as search_rank
         FROM fts_blocks fts
         JOIN blocks b ON b.id = fts.block_id
         WHERE fts_blocks MATCH ?1
           AND b.deleted_at IS NULL AND b.is_conflict = 0
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
    // to their owning page via `COALESCE(b.page_id, b.id)` and intersects
    // against `block_properties(key = 'space').value_ref`. Mirrors the
    // `crate::space_filter_clause!` macro used by the pagination helpers
    // — kept inline here because the dynamic-SQL shape of this query
    // (varying param indices for parent / tag / space filters) prevents
    // the compile-time sqlx macro from being applied.
    let space_param_idx = if space_id.is_some() {
        let idx = next_param;
        sql.push_str(&format!(
            "\n           AND COALESCE(b.page_id, b.id) IN (\
             SELECT bp.block_id FROM block_properties bp \
             WHERE bp.key = 'space' AND bp.value_ref = ?{idx})"
        ));
        next_param += 1;
        Some(idx)
    } else {
        None
    };

    // Suppress unused variable warnings — these indices are used only when
    // the corresponding filter is active, but the compiler cannot see that
    // through the dynamic query-building logic.
    let _ = (
        parent_param_idx,
        tag_param_start,
        tag_count_param_idx,
        space_param_idx,
        next_param,
    );

    sql.push_str("\n         ORDER BY fts.rank, b.id");
    sql.push_str("\n         LIMIT ?5");

    // Build and bind the query dynamically.
    let mut db_query = sqlx::query_as::<_, FtsSearchRow>(&sql)
        .bind(&sanitized) // ?1
        .bind(cursor_flag) // ?2
        .bind(cursor_rank) // ?3
        .bind(&cursor_id) // ?4
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

    let rows = db_query.fetch_all(pool).await.map_err(|e| {
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
    })?;

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
    let mut block_rows: Vec<BlockRow> = rows
        .into_iter()
        .map(|r| BlockRow {
            id: r.id,
            block_type: r.block_type,
            content: r.content,
            parent_id: r.parent_id,
            position: r.position,
            deleted_at: r.deleted_at,
            is_conflict: r.is_conflict,
            conflict_type: r.conflict_type,
            todo_state: r.todo_state,
            priority: r.priority,
            due_date: r.due_date,
            scheduled_date: r.scheduled_date,
            page_id: r.page_id,
        })
        .collect();

    if has_more {
        block_rows.truncate(limit_usize);
    }

    let next_cursor = if has_more {
        let (cursor_id, cursor_rank) = cursor_data.unwrap();
        Some(
            Cursor {
                id: cursor_id,
                position: None,
                deleted_at: None,
                seq: None,
                rank: Some(cursor_rank),
            }
            .encode()?,
        )
    } else {
        None
    };

    Ok(PageResponse {
        items: block_rows,
        next_cursor,
        has_more,
    })
}
