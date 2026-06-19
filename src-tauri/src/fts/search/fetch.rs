//! Shared SQL builder + row fetcher for the FTS5 search paths.
//!
//! Builds the dynamic FTS5 MATCH SQL, executes it (with optional
//! cancellation and slow-query logging), and maps FTS5 parse errors into
//! `AppError::Validation`. Reused by the cursor-paginated [`search_fts`],
//! the post-filter pagination path, and the partitioned scan.
//!
//! [`search_fts`]: super::cursor::search_fts

use sqlx::SqlitePool;
use std::time::{Duration, Instant};

use crate::cancellation::CancellationToken;
use crate::db::search_pool_acquire_logged;
use crate::error::AppError;

use super::super::metadata_filter::MetadataPredicates;
use super::constants::{FTS_QUERY_INFO_MS, FTS_QUERY_WARN_MS, SNIPPET_SQL_PROJECTION};
use super::row::{FtsSearchRow, content_select_expr};

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
///
/// [`search_fts`]: super::cursor::search_fts
/// [`search_fts_partitioned`]: super::partitioned::search_fts_partitioned
/// [`sanitize_fts_query`]: super::sanitizer::sanitize_fts_query
/// [`MAX_SEARCH_RESULTS`]: super::constants::MAX_SEARCH_RESULTS
#[allow(clippy::too_many_arguments)]
pub(super) async fn fts_fetch_rows(
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
    let mut fb = crate::fts::filter_builder::StructuralFilterBuilder::new(6);

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
