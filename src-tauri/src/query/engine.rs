//! #1280 — the advanced-query engine: compile a [`FilterExpr`] tree into a
//! keyset-paginated `SELECT … FROM blocks b` and run it.
//!
//! ## Pipeline
//!
//! 1. **Depth gate** — [`FilterExpr::validate_depth`] rejects pathological
//!    nesting BEFORE the unbounded `compile_expr` recursion (#1396).
//! 2. **Allow-list gate** — every leaf key in the tree must be in
//!    [`QUERY_ALLOWED_KEYS`]; an unsupported key (e.g. `orphan`) is rejected
//!    with [`AppError::Validation`] before compilation.
//! 3. **Compile** — [`QueryProjection::compile_expr`] folds the tree into one
//!    [`WhereClause`]; an `unsupported()` result is rejected (defence in
//!    depth — the gate already caught it).
//! 4. **Assemble** — `FROM blocks b WHERE b.space_id = ? AND
//!    b.deleted_at IS NULL AND (<compiled>)`, with the anonymous `?`
//!    placeholders renumbered to explicit `?N` so the space bind + filter
//!    binds + keyset binds never collide (mirrors
//!    `commands::pages::compile_pages_filters`). When the request carries a
//!    `fulltext` term the FROM becomes `fts_blocks fts JOIN blocks b ON
//!    b.id = fts.block_id` and `fts_blocks MATCH ?1` (the sanitised query)
//!    is AND-composed in front of the structural predicate — the MATCH ∩
//!    the structural WHERE. The MATCH takes the `?1` slot and the space +
//!    filter binds shift one slot right.
//! 5. **Sort + keyset** — the default keyset is `b.id DESC` (or, with a
//!    `fulltext` term, `fts.rank ASC` relevance-first) terminating in
//!    `b.id`; each requested [`SortKey`] maps to a literal column / the
//!    `bm25` rank and always terminates in `b.id`. The cursor encodes the
//!    full sort tuple of the last row.
//! 6. **Count** — the FIRST page (no cursor) computes `total_count` via a
//!    `COUNT(*)` over the same predicate + binds; cursor pages skip it.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::filters::primitive::Bind;
use crate::filters::{CompileExpr, FilterExpr};
use crate::fts::sanitize_fts_query;
use crate::pagination::ActiveBlockRow;

use super::projection::{QUERY_ALLOWED_KEYS, QueryProjection};
use super::{
    AdvancedQueryRequest, AdvancedQueryResponse, AggOp, AggregateColumn, AggregateResult,
    AggregateSpec, AggregateTarget, DateBucketUnit, DateField, GroupKey, GroupSpec, QueryGroup,
    QueryResultRow, SortColumn, SortKey, SortSource,
};

/// Default page size when the request leaves `limit` unset.
pub const DEFAULT_LIMIT: i64 = 50;

/// Maximum page size a request may ask for.
pub const MAX_LIMIT: i64 = 200;

/// Per-group member-preview cap in the GROUPED path. Each bucket on the page
/// carries at most this many member rows (the first N in the default sort,
/// selected via a `ROW_NUMBER()` window) so a single huge bucket cannot blow
/// the response payload. The full member list of one bucket is a follow-up
/// "expand group" flat query scoped to that bucket's key.
pub const GROUP_MEMBER_PREVIEW: i64 = 10;

/// Cursor schema version. Bump when the encoded cursor's field layout or
/// keyset semantics change so stale cursors are rejected on decode.
const CURSOR_VERSION: u8 = 1;

// ───────────────────────────────────────────────────────────────────────────
// Sort exprs
// ───────────────────────────────────────────────────────────────────────────

/// A resolved sort term: the literal SQL expression to ORDER BY, its
/// direction, and how to read its value off a fetched row for the cursor.
struct SortTerm {
    /// The literal SQL expression (NEVER a user string).
    expr: &'static str,
    /// `true` for DESC.
    desc: bool,
    /// Which column this term sorts on (drives cursor value extraction).
    column: CursorKind,
}

/// How a [`SortTerm`]'s cursor value is typed / extracted.
#[derive(Clone, Copy)]
enum CursorKind {
    /// `b.id` — a TEXT ULID.
    Id,
    /// `last_edited` epoch-ms (always non-NULL after COALESCE).
    LastEditedMs,
    /// `b.position` — nullable INTEGER.
    Position,
    /// `b.priority` — nullable TEXT.
    Priority,
    /// page title — nullable TEXT.
    Title,
    /// `fts.rank` — the `bm25` relevance score (a REAL). Only present on the
    /// full-text path; lower is a better match. Carried as a float cursor
    /// value (reusing the existing float handling + `b.id` tiebreak).
    Rank,
}

/// One component of an encoded keyset cursor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
enum CursorValue {
    Text(String),
    Int(i64),
    /// A REAL — the full-text `bm25` rank. Compared with an epsilon band
    /// (see [`strict_clause`] / [`eq_clause`]) so float-precision drift
    /// between the serialised cursor rank and SQLite's recomputation does
    /// not skip or duplicate a row at the page boundary.
    Real(f64),
    Null,
}

/// Epsilon band for the full-text `bm25` rank keyset comparison. Mirrors the
/// `1e-9` band in `fts::search::fts_fetch_rows`: two ranks within this
/// tolerance are treated as equal and fall through to the `b.id` tiebreak,
/// so float-precision drift between the serialised cursor rank and SQLite's
/// recomputation cannot re-emit or skip the boundary row. bm25 scores are
/// O(1)–O(10) for typical corpora, far coarser than `1e-9`, so the band only
/// ever absorbs precision drift — never two legitimately-different ranks.
const RANK_EPSILON: f64 = 1e-9;

/// The decoded keyset cursor: the sort-tuple values of the last row of the
/// previous page, in ORDER BY order. `id` is always the final element (the
/// tiebreaker), but it is included in `values` like any other term.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct QueryCursor {
    version: u8,
    /// One value per [`SortTerm`], in the same order as the resolved ORDER
    /// BY. Used to rebuild the keyset predicate.
    values: Vec<CursorValue>,
}

impl QueryCursor {
    fn encode(&self) -> Result<String, AppError> {
        let json = serde_json::to_string(self)?;
        Ok(URL_SAFE_NO_PAD.encode(json.as_bytes()))
    }

    fn decode(s: &str) -> Result<Self, AppError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|e| AppError::Validation(format!("invalid cursor: {e}")))?;
        let json = String::from_utf8(bytes)
            .map_err(|e| AppError::Validation(format!("invalid cursor UTF-8: {e}")))?;
        let cursor: QueryCursor = serde_json::from_str(&json)
            .map_err(|e| AppError::Validation(format!("invalid cursor JSON: {e}")))?;
        if cursor.version != CURSOR_VERSION {
            return Err(AppError::Validation(format!(
                "cursor: unsupported version {} (expected {CURSOR_VERSION})",
                cursor.version
            )));
        }
        Ok(cursor)
    }
}

/// Resolve the request's [`SortKey`]s into ordered [`SortTerm`]s, ALWAYS
/// terminating in the `b.id` tiebreaker so the keyset is total.
///
/// Defaults:
/// * `sort` empty + `has_fulltext` → relevance-first (`fts.rank ASC`,
///   lower=better), then `b.id`.
/// * `sort` empty + no full-text → the recency keyset (`b.id DESC`).
///
/// Rejects [`SortSource::Relevance`] when `has_fulltext` is `false` — there
/// is no rank column to sort on without a `MATCH`.
fn resolve_sort(sort: &[SortKey], has_fulltext: bool) -> Result<Vec<SortTerm>, AppError> {
    let mut terms: Vec<SortTerm> = Vec::with_capacity(sort.len() + 1);
    let mut has_id = false;
    for key in sort {
        let (expr, desc, column) = match &key.source {
            SortSource::Column { name } => {
                let (expr, column) = match name {
                    // ULID id == creation order.
                    SortColumn::Created => ("b.id", CursorKind::Id),
                    SortColumn::LastEdited => (
                        "COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), 0)",
                        CursorKind::LastEditedMs,
                    ),
                    SortColumn::Position => ("b.position", CursorKind::Position),
                    SortColumn::Priority => ("b.priority", CursorKind::Priority),
                    SortColumn::Title => (
                        "(SELECT title FROM pages_cache WHERE page_id = b.id)",
                        CursorKind::Title,
                    ),
                };
                (expr, key.desc, column)
            }
            SortSource::Relevance => {
                if !has_fulltext {
                    return Err(AppError::Validation(
                        "InvalidSort: `Relevance` requires a `fulltext` term to rank on"
                            .to_string(),
                    ));
                }
                // bm25: lower is a better match, so the user-facing default
                // (`desc = false`) means best-first. `desc` still inverts.
                ("fts.rank", key.desc, CursorKind::Rank)
            }
        };
        if matches!(column, CursorKind::Id) {
            has_id = true;
        }
        terms.push(SortTerm { expr, desc, column });
    }
    // Default sort when the request gave none.
    if terms.is_empty() && has_fulltext {
        // Relevance-first (lower bm25 = better → ASC), tiebroken by `b.id`.
        terms.push(SortTerm {
            expr: "fts.rank",
            desc: false,
            column: CursorKind::Rank,
        });
    }
    if !has_id {
        // Final tiebreaker. DESC by default so the bare "no sort" case is
        // newest-first (ULID order); a relevance default appends an ASC-less
        // `b.id` that just needs to be deterministic.
        terms.push(SortTerm {
            expr: "b.id",
            desc: true,
            column: CursorKind::Id,
        });
    }
    Ok(terms)
}

// ───────────────────────────────────────────────────────────────────────────
// Row fetch
// ───────────────────────────────────────────────────────────────────────────

/// Fetched row: the [`ActiveBlockRow`] plus the two sort exprs that are NOT
/// `ActiveBlockRow` fields (`last_edited`, `title`), selected as fixed
/// trailing columns so the cursor can read any sort term's value without a
/// dynamic column count.
#[derive(sqlx::FromRow)]
struct EngineRow {
    #[sqlx(flatten)]
    block: ActiveBlockRow,
    #[sqlx(rename = "__last_edited")]
    last_edited: i64,
    #[sqlx(rename = "__title")]
    title: Option<String>,
    /// `fts.rank` (`bm25`) on the full-text path; `NULL` (→ `None`) on the
    /// structural path. Drives both the relevance keyset cursor value and
    /// the per-row [`QueryResultRow::score`].
    #[sqlx(rename = "__rank")]
    rank: Option<f64>,
}

impl EngineRow {
    /// Read this row's value for `term` as a [`CursorValue`].
    fn cursor_value(&self, term: &SortTerm) -> CursorValue {
        match term.column {
            CursorKind::Id => CursorValue::Text(self.block.id.as_str().to_string()),
            CursorKind::LastEditedMs => CursorValue::Int(self.last_edited),
            CursorKind::Position => self
                .block
                .position
                .map_or(CursorValue::Null, CursorValue::Int),
            CursorKind::Priority => self
                .block
                .priority
                .clone()
                .map_or(CursorValue::Null, CursorValue::Text),
            CursorKind::Title => self
                .title
                .clone()
                .map_or(CursorValue::Null, CursorValue::Text),
            // `fts.rank` is non-NULL on every full-text row (the MATCH is
            // always present when a Rank term is in play); guard with `None`
            // → `Null` for total safety.
            CursorKind::Rank => self.rank.map_or(CursorValue::Null, CursorValue::Real),
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Engine
// ───────────────────────────────────────────────────────────────────────────

/// Recursively gate every leaf key in `expr` against [`QUERY_ALLOWED_KEYS`],
/// rejecting the first unsupported leaf with [`AppError::Validation`].
fn gate_leaf_keys(expr: &FilterExpr) -> Result<(), AppError> {
    match expr {
        FilterExpr::Leaf { primitive } => {
            let key = primitive.allowed_key();
            if !QUERY_ALLOWED_KEYS.contains(key) {
                return Err(AppError::Validation(format!(
                    "InvalidFilter: `{key}` is not a valid filter on the advanced-query surface"
                )));
            }
            // #1455 — `has-parent-matching` carries a nested FilterExpr (the
            // parent matcher); its leaves must be gated too, or an unsupported
            // key could slip in via the sub-expression.
            if let crate::filters::primitive::FilterPrimitive::HasParentMatching { matcher } =
                primitive
            {
                gate_leaf_keys(matcher)?;
            }
            Ok(())
        }
        FilterExpr::And { children } | FilterExpr::Or { children } => {
            for child in children {
                gate_leaf_keys(child)?;
            }
            Ok(())
        }
        FilterExpr::Not { child } => gate_leaf_keys(child),
    }
}

/// Renumber the anonymous `?` placeholders in `sql` to explicit `?N`,
/// starting at `next_pos`. Returns the rewritten SQL and the next free
/// position. Mirrors `compile_pages_filters`'s renumbering so the space
/// bind, filter binds, and keyset binds occupy unambiguous, non-colliding
/// positional slots.
fn renumber(sql: &str, next_pos: &mut usize) -> String {
    let mut out = String::with_capacity(sql.len());
    for ch in sql.chars() {
        if ch == '?' {
            out.push('?');
            out.push_str(&next_pos.to_string());
            *next_pos += 1;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Bind a single [`Bind`] onto a `query_as` chain.
fn bind_as<'q, O>(
    q: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    bind: &Bind,
) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
    match bind {
        Bind::Text(s) => q.bind(s.clone()),
        Bind::Int(i) => q.bind(*i),
        Bind::Real(r) => q.bind(*r),
    }
}

/// Bind a single [`Bind`] onto a `query_scalar` chain (the COUNT query).
fn bind_scalar<'q, O>(
    q: sqlx::query::QueryScalar<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    bind: &Bind,
) -> sqlx::query::QueryScalar<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
    match bind {
        Bind::Text(s) => q.bind(s.clone()),
        Bind::Int(i) => q.bind(*i),
        Bind::Real(r) => q.bind(*r),
    }
}

// (helpers above bind owned values, so the `'q` lifetime on the arguments is
// satisfied without borrowing from `bind`.)

/// Build the keyset WHERE fragment for a cursor over the resolved sort
/// terms, expanding the lexicographic row comparison into OR-of-AND form
/// (the standard keyset technique). Each `?` is renumbered from `next_pos`
/// and its bind appended to `binds`.
///
/// For terms `t0, t1, … tn` with directions and cursor values `v0 … vn`, a
/// row is "after" the cursor iff:
///
/// ```text
///   (t0 ▷ v0)
///   OR (t0 = v0 AND t1 ▷ v1)
///   OR (t0 = v0 AND t1 = v1 AND t2 ▷ v2)
///   …
/// ```
///
/// where `▷` is `>` for ASC and `<` for DESC. NULLs sort LAST (`NULLS LAST`
/// emulation): the `=` comparison uses `IS` semantics so a NULL prior term
/// still threads to the next term, and the strict comparison treats NULL as
/// the greatest value.
fn keyset_predicate(
    terms: &[SortTerm],
    cursor: &QueryCursor,
    next_pos: &mut usize,
) -> (String, Vec<Bind>) {
    let mut binds: Vec<Bind> = Vec::new();
    let mut ors: Vec<String> = Vec::new();

    for i in 0..terms.len() {
        let mut and_clauses: Vec<String> = Vec::new();
        // Equality prefix for terms 0..i.
        for (j, term) in terms.iter().enumerate().take(i) {
            let val = &cursor.values[j];
            and_clauses.push(eq_clause(term.expr, val, next_pos, &mut binds));
        }
        // Strict comparison on term i.
        let term = &terms[i];
        let val = &cursor.values[i];
        and_clauses.push(strict_clause(
            term.expr, term.desc, val, next_pos, &mut binds,
        ));
        ors.push(format!("({})", and_clauses.join(" AND ")));
    }

    (format!("({})", ors.join(" OR ")), binds)
}

/// `expr IS NOT DISTINCT FROM ?` — NULL-safe equality so a NULL prior term
/// still matches (SQLite spells it `expr IS ?`).
///
/// For the full-text `bm25` rank ([`CursorValue::Real`]) the equality is an
/// epsilon band (`ABS(expr - ?) < RANK_EPSILON`) rather than exact `IS`, so
/// a boundary rank that drifts by float precision still threads to the
/// `b.id` tiebreak instead of being skipped (mirrors the `fts::search`
/// cursor's epsilon tiebreak).
fn eq_clause(expr: &str, val: &CursorValue, next_pos: &mut usize, binds: &mut Vec<Bind>) -> String {
    match val {
        CursorValue::Null => format!("{expr} IS NULL"),
        CursorValue::Text(s) => {
            let p = *next_pos;
            *next_pos += 1;
            binds.push(Bind::Text(s.clone()));
            format!("{expr} IS ?{p}")
        }
        CursorValue::Int(i) => {
            let p = *next_pos;
            *next_pos += 1;
            binds.push(Bind::Int(*i));
            format!("{expr} IS ?{p}")
        }
        CursorValue::Real(r) => {
            let p = *next_pos;
            *next_pos += 1;
            binds.push(Bind::Real(*r));
            format!("ABS({expr} - ?{p}) < {RANK_EPSILON:e}")
        }
    }
}

/// Strict keyset comparison on one term, consistent with `NULLS LAST`
/// ordering in BOTH directions (the ORDER BY emits `… NULLS LAST`):
///
/// * ASC, value non-NULL: `(expr > ? OR expr IS NULL)` — larger real values,
///   then the NULL tail, are all "after".
/// * DESC, value non-NULL: `(expr < ? OR expr IS NULL)` — smaller real
///   values, then the NULL tail, are all "after".
/// * value NULL (either direction): the cursor sits in the NULL tail, which
///   is the LAST slot, so no row is strictly after it on this term → `1=0`.
///   (The tie at NULL still threads to the next term via the `eq_clause`
///   `IS NULL` equality in the OR-of-AND expansion.)
fn strict_clause(
    expr: &str,
    desc: bool,
    val: &CursorValue,
    next_pos: &mut usize,
    binds: &mut Vec<Bind>,
) -> String {
    match val {
        CursorValue::Null => "1=0".to_string(),
        // #671 — the `bm25` rank's strict comparison must CLEAR the epsilon
        // band, not just beat the bare value: a boundary rank that drifts
        // into the band must fall through to the `b.id` tiebreak (via
        // `eq_clause`) rather than satisfy this strict arm and re-emit. So
        // ASC requires `rank > ? + eps` and DESC `rank < ? - eps`. Rank is
        // never NULL on the full-text path, so no `IS NULL` tail.
        CursorValue::Real(r) => {
            let p = *next_pos;
            *next_pos += 1;
            binds.push(Bind::Real(*r));
            if desc {
                format!("{expr} < ?{p} - {RANK_EPSILON:e}")
            } else {
                format!("{expr} > ?{p} + {RANK_EPSILON:e}")
            }
        }
        v => {
            let p = push_bind(v, next_pos, binds);
            let op = if desc { "<" } else { ">" };
            format!("({expr} {op} ?{p} OR {expr} IS NULL)")
        }
    }
}

/// Push a non-NULL cursor value as a bind and return its `?N` position.
fn push_bind(val: &CursorValue, next_pos: &mut usize, binds: &mut Vec<Bind>) -> usize {
    let p = *next_pos;
    *next_pos += 1;
    match val {
        CursorValue::Text(s) => binds.push(Bind::Text(s.clone())),
        CursorValue::Int(i) => binds.push(Bind::Int(*i)),
        // Real (the bm25 rank) is bound inline by `strict_clause`/`eq_clause`
        // because it needs the epsilon band, so it never reaches here.
        CursorValue::Real(_) => unreachable!("push_bind called with Real"),
        CursorValue::Null => unreachable!("push_bind called with Null"),
    }
    p
}

/// Map a SQLite error to [`AppError`], translating an FTS5 `MATCH`-syntax
/// parse error into [`AppError::Validation`] (a user-facing "bad query")
/// while every other database error keeps its [`AppError::Database`]
/// discriminant. Mirrors the canonical check in `fts::search::fts_fetch_rows`
/// (PEND-73 Phase 1.B5): the error must originate from the driver, carry the
/// generic `SQLITE_ERROR` code, AND start with FTS5's canonical `fts5: `
/// message prefix. Used only on the full-text path's queries.
fn map_fts_error(e: sqlx::Error) -> AppError {
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
}

/// Compile and run an advanced query.
pub async fn compile_and_run(
    pool: &SqlitePool,
    request: AdvancedQueryRequest,
) -> Result<AdvancedQueryResponse, AppError> {
    // 1. Depth gate — bound the unbounded compile recursion.
    request.filter.validate_depth()?;

    // 2. Allow-list gate — reject unsupported leaf keys before compiling.
    gate_leaf_keys(&request.filter)?;

    // Validate limit (mirror PageRequest::new's policy).
    let limit = match request.limit {
        Some(l) if (1..=MAX_LIMIT).contains(&l) => l,
        Some(l) => {
            return Err(AppError::Validation(format!(
                "advanced query limit must be in [1, {MAX_LIMIT}]; got {l}"
            )));
        }
        None => DEFAULT_LIMIT,
    };

    // 3. Compile the boolean tree to one WhereClause.
    let where_clause = QueryProjection.compile_expr(&request.filter);
    if where_clause.is_unsupported() {
        // Defence in depth — the gate already rejected unsupported keys.
        return Err(AppError::Validation(
            "InvalidFilter: filter shape is not supported on the advanced-query surface"
                .to_string(),
        ));
    }

    // 3b. Full-text composition. When `fulltext` is `Some`, the query
    //     INTERSECTS an FTS5 `MATCH` with the structural predicate: the base
    //     FROM becomes `fts_blocks fts JOIN blocks b ON b.id = fts.block_id`
    //     and `fts_blocks MATCH ?1` is AND-composed in front of the
    //     structural WHERE. The MATCH bind is the SANITISED query (an FTS5
    //     parse error surfaces as `AppError::Validation`). The `bm25` rank
    //     (`fts.rank`) becomes the per-row `score` and the relevance sort
    //     source.
    let match_sanitized: Option<String> = match request.fulltext.as_deref() {
        Some(raw) => {
            let sanitized = sanitize_fts_query(raw);
            if sanitized.is_empty() {
                // After trigram/operator filtering nothing remains to match
                // (e.g. a query of only sub-trigram tokens). Reject rather
                // than silently returning the whole structural set.
                return Err(AppError::Validation(
                    "Invalid search query: no searchable terms (each term must be \
                     at least 3 characters)"
                        .to_string(),
                ));
            }
            Some(sanitized)
        }
        None => None,
    };
    let has_fulltext = match_sanitized.is_some();

    // 4. Renumber the compiled `?` placeholders to explicit `?N`. With
    //    full-text, `?1` is the MATCH expr and `?2` is the space_id, so the
    //    filter's binds start at `?3`; without it `?1` is the space_id and
    //    the filter binds start at `?2`.
    let space_pos = if has_fulltext { 2 } else { 1 };
    let mut next_pos = space_pos + 1; // first free slot after the space bind
    let filter_sql = renumber(&where_clause.sql, &mut next_pos);
    let filter_binds = where_clause.binds;

    // FROM clause + structural predicate. On the full-text path the FROM
    // joins `fts_blocks` and the predicate is prefixed with the MATCH;
    // otherwise it is the plain `blocks b` scan. The `?N` of the space bind
    // tracks `space_pos`. The same predicate + binds drive BOTH the flat and
    // the grouped paths.
    let from_clause = if has_fulltext {
        "fts_blocks fts JOIN blocks b ON b.id = fts.block_id"
    } else {
        "blocks b"
    };
    let match_prefix = if has_fulltext {
        "fts_blocks MATCH ?1 AND "
    } else {
        ""
    };
    let predicate = format!(
        "{match_prefix}b.space_id = ?{space_pos} AND b.deleted_at IS NULL AND ({filter_sql})"
    );

    // 4b. GROUPED dispatch. When the request carries a `group_by`, the engine
    //     buckets the matched rows by the spec's dimension and returns the
    //     grouped page (group-level keyset pagination + a bounded per-group
    //     member preview); `rows` stays empty. The grouped path reuses the
    //     SAME predicate / binds / FROM / FTS MATCH, so grouping composes with
    //     both structural filters and full-text. The flat path below is
    //     UNCHANGED (full backward compat) when `group_by` is `None`.
    if let Some(spec) = request.group_by.as_ref() {
        let ctx = GroupCtx {
            from_clause,
            predicate: &predicate,
            space_id: &request.space_id,
            space_pos,
            next_pos,
            match_sanitized: match_sanitized.as_deref(),
            has_fulltext,
            filter_binds: &filter_binds,
        };
        return run_grouped(pool, spec, &request, ctx, limit).await;
    }

    // Decode the cursor (if any) and resolve the sort terms. (Flat path only;
    // the grouped path above decodes its own group-level cursor.)
    let cursor = match request.cursor.as_deref() {
        Some(s) => Some(QueryCursor::decode(s)?),
        None => None,
    };
    let terms = resolve_sort(&request.sort, has_fulltext)?;
    if let Some(c) = cursor.as_ref()
        && c.values.len() != terms.len()
    {
        return Err(AppError::Validation(
            "cursor: sort-key count does not match this request's sort".to_string(),
        ));
    }

    // 5. total_count on the FIRST page only (no cursor). Same predicate +
    //    binds as the fetch, minus the keyset / ORDER BY / LIMIT.
    let total_count: Option<i64> = if cursor.is_none() {
        let count_sql = format!("SELECT COUNT(*) FROM {from_clause} WHERE {predicate}");
        // dynamic-sql: WHERE is the runtime-compiled FilterExpr tree + optional FTS5 MATCH (macro form cannot express it); all values are bound params.
        let mut q = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql.as_str()));
        if let Some(m) = match_sanitized.as_ref() {
            q = q.bind(m.clone()); // ?1 = MATCH
        }
        q = q.bind(&request.space_id); // ?space_pos
        for b in &filter_binds {
            q = bind_scalar(q, b);
        }
        // On the full-text path an FTS5 MATCH-syntax error must surface as
        // Validation, not Database.
        let count = if has_fulltext {
            q.fetch_one(pool).await.map_err(map_fts_error)?
        } else {
            q.fetch_one(pool).await?
        };
        Some(count)
    } else {
        None
    };

    // 5b. GLOBAL aggregates on the FIRST page only — over the SAME predicate +
    //     binds as the count, un-limited. Aggregates over the full match set are
    //     invariant across cursor pages, so they reuse the `total_count`
    //     first-page guard. The aggregate query is a SEPARATE statement with its
    //     OWN bind numbering, so its property-key binds start in the slot right
    //     after the space + filter binds; resolve them against a LOCAL position
    //     counter so the flat fetch's keyset numbering (which shares `next_pos`)
    //     is untouched.
    let aggregates: Vec<AggregateResult> = if cursor.is_none() && !request.aggregates.is_empty() {
        let mut agg_pos = next_pos;
        let (agg_terms, agg_binds) = resolve_aggregates(&request.aggregates, &mut agg_pos);
        run_aggregate_query(
            pool,
            from_clause,
            &predicate,
            &request.space_id,
            match_sanitized.as_deref(),
            has_fulltext,
            &filter_binds,
            &agg_terms,
            &agg_binds,
        )
        .await?
    } else {
        Vec::new()
    };

    // 6. Keyset predicate (if resuming) + ORDER BY + LIMIT.
    let keyset_sql;
    let keyset_binds: Vec<Bind>;
    if let Some(c) = cursor.as_ref() {
        let (sql, binds) = keyset_predicate(&terms, c, &mut next_pos);
        keyset_sql = format!(" AND {sql}");
        keyset_binds = binds;
    } else {
        keyset_sql = String::new();
        keyset_binds = Vec::new();
    }

    // `NULLS LAST` in both directions so the ORDER BY matches the keyset
    // predicate's NULL handling (SQLite's default is NULLS FIRST for ASC,
    // which would disagree with `strict_clause`).
    let order_by = terms
        .iter()
        .map(|t| {
            format!(
                "{} {} NULLS LAST",
                t.expr,
                if t.desc { "DESC" } else { "ASC" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    let limit_pos = next_pos; // LIMIT ?N
    let limit_plus_one = limit + 1; // probe-for-more

    // `__rank` carries `fts.rank` (bm25) on the full-text path and `NULL` on
    // the structural path — selected unconditionally so `EngineRow` has a
    // stable column count. `CAST(NULL AS REAL)` keeps the column's declared
    // type REAL so sqlx decodes it as `Option<f64>` either way.
    let rank_select = if has_fulltext {
        "fts.rank"
    } else {
        "CAST(NULL AS REAL)"
    };

    let fetch_sql = format!(
        "SELECT {cols}, \
           COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), 0) AS __last_edited, \
           (SELECT title FROM pages_cache WHERE page_id = b.id) AS __title, \
           {rank_select} AS __rank \
         FROM {from_clause} \
         WHERE {predicate}{keyset_sql} \
         ORDER BY {order_by} \
         LIMIT ?{limit_pos}",
        cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS,
    );

    // dynamic-sql: keyset body varies with the runtime sort mode + compiled FilterExpr tree + optional FTS5 MATCH (macro form cannot express it); all values are bound params.
    let mut q = sqlx::query_as::<_, EngineRow>(sqlx::AssertSqlSafe(fetch_sql.as_str()));
    if let Some(m) = match_sanitized.as_ref() {
        q = q.bind(m.clone()); // ?1 = MATCH
    }
    q = q.bind(&request.space_id); // ?space_pos
    for b in &filter_binds {
        q = bind_as(q, b);
    }
    for b in &keyset_binds {
        q = bind_as(q, b);
    }
    q = q.bind(limit_plus_one);

    // On the full-text path an FTS5 MATCH-syntax error must surface as
    // Validation, not Database. (On the first page the COUNT above already
    // catches it, but cursor pages skip the COUNT, so map here too.)
    let mut rows: Vec<EngineRow> = if has_fulltext {
        q.fetch_all(pool).await.map_err(map_fts_error)?
    } else {
        q.fetch_all(pool).await?
    };

    // Probe-for-more: trim the extra row, build the next cursor from the
    // last kept row's sort tuple.
    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit_usize;
    if has_more {
        rows.truncate(limit_usize);
    }
    let next_cursor = if has_more {
        let last = rows.last().expect("has_more implies non-empty");
        let values = terms.iter().map(|t| last.cursor_value(t)).collect();
        Some(
            QueryCursor {
                version: CURSOR_VERSION,
                values,
            }
            .encode()?,
        )
    } else {
        None
    };

    let result_rows = rows
        .into_iter()
        .map(|r| QueryResultRow {
            score: r.rank, // bm25 on the full-text path; `None` structurally.
            block: r.block,
        })
        .collect();

    Ok(AdvancedQueryResponse {
        rows: result_rows,
        groups: Vec::new(), // flat mode — no group buckets.
        next_cursor,
        has_more,
        total_count,
        aggregates,
    })
}

// ───────────────────────────────────────────────────────────────────────────
// Aggregation (#1280 C4)
// ───────────────────────────────────────────────────────────────────────────

/// The numeric-skip GLOB guard. A `value_text` / TEXT column is treated as
/// NUMERIC iff it contains at least one digit AND contains no character
/// outside the digit / `.` / `-` class:
///
/// * `<v> GLOB '*[0-9]*'` — has at least one digit (rejects `""`, `"."`,
///   `"-"`).
/// * `<v> NOT GLOB '*[^0-9.-]*'` — has NO character outside `[0-9.-]`
///   (rejects `"big"`, `"A"`, `"12px"`, `"1,2"`).
///
/// Together they accept integers (`"3"`), decimals (`"3.5"`), and a leading
/// minus (`"-2"`, `"-2.5"`), and SKIP non-numeric labels. A pathological value
/// like `"1.2.3"` or `"1-2"` would slip through the class check and SQLite's
/// `CAST(... AS REAL)` would then take its leading numeric prefix — an
/// accepted, documented limitation (real property/priority values are clean
/// numbers or clean labels). When the guard fails the `CASE` yields NULL,
/// which SQLite's `SUM`/`AVG`/`MIN`/`MAX` SKIP and `COUNT(expr)` does not
/// count — so a fold over an all-non-numeric set is NULL → `value: None`, and
/// `AVG` divides by the numeric count, not the row count.
///
/// `{v}` is substituted with a STATIC SQL sub-expression (a literal column
/// reference or a correlated `block_properties` lookup whose only user input is
/// a bound `?N`), never a user string — so the guard cannot inject SQL.
fn numeric_coerce(v: &str) -> String {
    format!("CASE WHEN {v} GLOB '*[0-9]*' AND {v} NOT GLOB '*[^0-9.-]*' THEN CAST({v} AS REAL) END")
}

/// A resolved aggregate: the SQL expression to place in a SELECT list and the
/// operator it computes (drives result decoding). The property-key bind (if
/// any) is threaded separately by the caller.
struct AggTerm {
    /// The literal SQL aggregate expression (e.g. `COUNT(*)`, `SUM(<coerced>)`).
    expr: String,
    /// The operator (so the decoded scalar lands in `value` vs `count`).
    op: AggOp,
}

/// The numeric sub-expression an [`AggregateTarget`] folds over, plus the
/// optional property-key bind it needs.
///
/// * [`AggregateColumn::Priority`] → `b.priority` (TEXT) numeric-coerced.
/// * [`AggregateColumn::Position`] → `b.position` (INTEGER) numeric-coerced
///   (harmless for an already-numeric column; keeps one code path).
/// * [`AggregateTarget::Property`] → the correlated `value_text` lookup keyed
///   by the BOUND `?{pos}`, numeric-coerced.
fn agg_target_expr(target: &AggregateTarget, pos: usize) -> (String, Option<Bind>) {
    match target {
        AggregateTarget::Column { name } => {
            let col = match name {
                AggregateColumn::Priority => "b.priority",
                AggregateColumn::Position => "b.position",
            };
            (numeric_coerce(col), None)
        }
        AggregateTarget::Property { key } => {
            let lookup = format!(
                "(SELECT value_text FROM block_properties WHERE block_id = b.id AND key = ?{pos})"
            );
            (numeric_coerce(&lookup), Some(Bind::Text(key.clone())))
        }
    }
}

/// Resolve the request's [`AggregateSpec`]s into ordered SQL [`AggTerm`]s plus
/// the property-key binds (in expression order), starting bind numbering at
/// `next_pos` (advanced past each property bind consumed).
///
/// SQL shapes:
/// * `Count` no target → `COUNT(*)`.
/// * `Count` w/ target → `COUNT(<numeric-coerced>)` — counts the rows whose
///   target is numeric (the coercion NULLs the rest).
/// * `Sum`/`Avg`/`Min`/`Max` w/ target → `SUM(<coerced>)` etc.
/// * `Sum`/`Avg`/`Min`/`Max` with NO target → `NULL` (nothing to fold) → the
///   decoded `value` is `None`.
fn resolve_aggregates(specs: &[AggregateSpec], next_pos: &mut usize) -> (Vec<AggTerm>, Vec<Bind>) {
    let mut terms: Vec<AggTerm> = Vec::with_capacity(specs.len());
    let mut binds: Vec<Bind> = Vec::new();
    for spec in specs {
        let expr = match (&spec.op, spec.target.as_ref()) {
            (AggOp::Count, None) => "COUNT(*)".to_string(),
            (AggOp::Count, Some(t)) => {
                let (e, b) = agg_target_expr(t, *next_pos);
                if let Some(b) = b {
                    *next_pos += 1;
                    binds.push(b);
                }
                format!("COUNT({e})")
            }
            (op, Some(t)) => {
                let (e, b) = agg_target_expr(t, *next_pos);
                if let Some(b) = b {
                    *next_pos += 1;
                    binds.push(b);
                }
                let f = match op {
                    AggOp::Sum => "SUM",
                    AggOp::Avg => "AVG",
                    AggOp::Min => "MIN",
                    AggOp::Max => "MAX",
                    AggOp::Count => unreachable!("Count handled above"),
                };
                format!("{f}({e})")
            }
            // A fold operator with no target has nothing to fold → NULL → None.
            (_, None) => "NULL".to_string(),
        };
        terms.push(AggTerm { expr, op: spec.op });
    }
    (terms, binds)
}

/// One row of decoded aggregate scalars — a flat list of nullable text cells,
/// one per [`AggTerm`], read positionally (the column count is dynamic, so we
/// decode each as a nullable string and parse per the term's operator). Each
/// aggregate column is aliased `a0`, `a1`, … in SELECT order.
fn agg_alias(i: usize) -> String {
    format!("a{i}")
}

/// Bind a single [`Bind`] onto an untyped `query` chain (the aggregate query
/// reads a dynamic column count, so it uses the untyped `sqlx::query`).
fn bind_raw<'q>(
    q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments>,
    bind: &Bind,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    match bind {
        Bind::Text(s) => q.bind(s.clone()),
        Bind::Int(i) => q.bind(*i),
        Bind::Real(r) => q.bind(*r),
    }
}

/// Run the GLOBAL aggregate query over the SAME predicate + binds as the flat
/// fetch (un-limited, no keyset / ORDER BY / LIMIT): `SELECT <agg exprs…> FROM
/// <from> WHERE <predicate>`. The aggregate property-key binds (`agg_binds`)
/// follow the space + filter binds, exactly as their `?N` slots were numbered
/// in [`resolve_aggregates`]. Returns the decoded results in request order.
///
/// Empty `terms` → an empty result (the SELECT would be invalid), short-circuited
/// by the caller; this fn assumes `terms` is non-empty.
#[allow(clippy::too_many_arguments)]
async fn run_aggregate_query(
    pool: &SqlitePool,
    from_clause: &str,
    predicate: &str,
    space_id: &str,
    match_sanitized: Option<&str>,
    has_fulltext: bool,
    filter_binds: &[Bind],
    terms: &[AggTerm],
    agg_binds: &[Bind],
) -> Result<Vec<AggregateResult>, AppError> {
    use sqlx::Row as _;
    // `CAST(… AS REAL)` so EVERY aggregate column decodes uniformly as a
    // nullable f64 — `COUNT(*)` is otherwise an INTEGER column and sqlx's
    // strict decoder refuses to read it as `Option<f64>`. `CAST(NULL AS REAL)`
    // stays NULL, so the all-non-numeric / empty-set folds keep their `None`.
    let select_list = terms
        .iter()
        .enumerate()
        .map(|(i, t)| format!("CAST({} AS REAL) AS {}", t.expr, agg_alias(i)))
        .collect::<Vec<_>>()
        .join(", ");
    let agg_sql = format!("SELECT {select_list} FROM {from_clause} WHERE {predicate}");
    // dynamic-sql: aggregate SELECT list is the runtime AggregateSpec set over the compiled FilterExpr tree + optional FTS5 MATCH (macro form cannot express it); all values are bound params.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(agg_sql.as_str()));
    if let Some(m) = match_sanitized {
        q = q.bind(m.to_string()); // ?1 = MATCH
    }
    q = q.bind(space_id.to_string()); // ?space_pos
    for b in filter_binds {
        q = bind_raw(q, b);
    }
    for b in agg_binds {
        q = bind_raw(q, b);
    }
    let row = if has_fulltext {
        q.fetch_one(pool).await.map_err(map_fts_error)?
    } else {
        q.fetch_one(pool).await?
    };
    let cells: Vec<Option<f64>> = (0..terms.len())
        .map(|i| row.try_get::<Option<f64>, _>(i))
        .collect::<Result<_, _>>()?;
    Ok(decode_aggregates(terms, &cells))
}

/// Decode one fetched aggregate row (the dynamic `a0…aN` columns, each pulled
/// as `Option<f64>`) into [`AggregateResult`]s, mapping `Count` → `count`
/// (rounded to `i64`) and the fold operators → `value`.
fn decode_aggregates(terms: &[AggTerm], cells: &[Option<f64>]) -> Vec<AggregateResult> {
    terms
        .iter()
        .zip(cells)
        .map(|(t, cell)| match t.op {
            AggOp::Count => AggregateResult {
                op: t.op,
                value: None,
                // COUNT is a non-negative integer; SQLite returns it as such,
                // decoded here through f64 then rounded back (always exact for
                // counts well under 2^53). The explicit clamp keeps the cast
                // total (clippy `cast_possible_truncation`); real counts never
                // approach the bound.
                #[allow(clippy::cast_possible_truncation)]
                count: Some(cell.map_or(0, |v| {
                    v.round().clamp(i64::MIN as f64, i64::MAX as f64) as i64
                })),
            },
            _ => AggregateResult {
                op: t.op,
                value: *cell,
                count: None,
            },
        })
        .collect()
}

// ───────────────────────────────────────────────────────────────────────────
// Grouped path (#1280 grouping fast-follow)
// ───────────────────────────────────────────────────────────────────────────

/// The shared predicate/bind context threaded from [`compile_and_run`] into
/// the grouped path so grouping reuses the EXACT same structural + FTS
/// predicate as the flat path.
struct GroupCtx<'a> {
    /// `blocks b` or the `fts_blocks fts JOIN blocks b …` full-text FROM.
    from_clause: &'a str,
    /// The assembled `… WHERE` predicate (`?N` numbered, sans the group key
    /// bind / keyset / LIMIT).
    predicate: &'a str,
    /// The space id (bound at `?space_pos`).
    space_id: &'a str,
    /// The `?N` slot the space id occupies.
    space_pos: usize,
    /// The first FREE `?N` slot after the space + filter binds — where the
    /// group-key bind (property key) and the keyset/LIMIT binds begin.
    next_pos: usize,
    /// The sanitised FTS `MATCH` query (bound at `?1`) on the full-text path.
    match_sanitized: Option<&'a str>,
    /// Whether the full-text path is active (drives the `?1` MATCH bind + the
    /// FTS5 error mapping).
    has_fulltext: bool,
    /// The compiled filter binds (bound in order after the space bind).
    filter_binds: &'a [Bind],
}

/// The literal `strftime` format for a [`DateBucketUnit`]. A closed mapping
/// to a STATIC format string — never an interpolated user value.
fn date_bucket_format(unit: DateBucketUnit) -> &'static str {
    match unit {
        DateBucketUnit::Day => "%Y-%m-%d",
        DateBucketUnit::Week => "%Y-W%W",
        DateBucketUnit::Month => "%Y-%m",
    }
}

/// Resolve a [`GroupKey`] into its SQL group-key expression, an optional
/// `JOIN` clause, and an optional bound parameter.
///
/// The returned `key_expr` is the RAW key SQL (callers wrap it in
/// `COALESCE(<expr>, 'none')` so a NULL/absent key renders as the `"none"`
/// bucket). It is built ENTIRELY from static column literals + literal
/// `strftime` formats; the ONLY user-controlled input ([`GroupKey::Property`]'s
/// `key`) is returned as a [`Bind`] and placed at the explicit `?{pos}`
/// slot — never interpolated as an identifier. So grouping cannot inject SQL.
///
/// `pos` is the `?N` slot the property-key bind (if any) occupies; it is the
/// SAME slot every time the expression appears in one statement (SELECT /
/// GROUP BY / PARTITION BY), so a single bind feeds all occurrences.
fn group_key_expr(key: &GroupKey, pos: usize) -> (String, &'static str, Option<Bind>) {
    match key {
        GroupKey::Tag => (
            "bt.tag_id".to_string(),
            " JOIN block_tags bt ON bt.block_id = b.id",
            None,
        ),
        GroupKey::Page => ("b.page_id".to_string(), "", None),
        GroupKey::State => ("b.todo_state".to_string(), "", None),
        GroupKey::BlockType => ("b.block_type".to_string(), "", None),
        GroupKey::Priority => ("b.priority".to_string(), "", None),
        GroupKey::Property { key } => (
            // Correlated single-value lookup; the key is a BOUND `?{pos}`.
            format!(
                "(SELECT value_text FROM block_properties WHERE block_id = b.id AND key = ?{pos})"
            ),
            "",
            Some(Bind::Text(key.clone())),
        ),
        GroupKey::DateBucket { source, unit } => {
            let fmt = date_bucket_format(*unit);
            let expr = match source {
                DateField::Due => format!("strftime('{fmt}', b.due_date)"),
                DateField::Scheduled => format!("strftime('{fmt}', b.scheduled_date)"),
                // op_log.created_at is epoch-ms; bucket the earliest (Created)
                // / latest (LastEdited) op as a calendar date.
                DateField::Created => format!(
                    "strftime('{fmt}', (SELECT MIN(created_at) FROM op_log WHERE block_id = b.id) / 1000, 'unixepoch')"
                ),
                DateField::LastEdited => format!(
                    "strftime('{fmt}', (SELECT MAX(created_at) FROM op_log WHERE block_id = b.id) / 1000, 'unixepoch')"
                ),
            };
            (expr, "", None)
        }
    }
}

/// One decoded group-level keyset cursor: the `(count, key)` of the last
/// group on the previous page, in the `gcount DESC, gkey ASC` order.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct GroupCursor {
    version: u8,
    /// The last group's full bucket count.
    count: i64,
    /// The last group's rendered key.
    key: String,
}

impl GroupCursor {
    fn encode(&self) -> Result<String, AppError> {
        let json = serde_json::to_string(self)?;
        Ok(URL_SAFE_NO_PAD.encode(json.as_bytes()))
    }

    fn decode(s: &str) -> Result<Self, AppError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|e| AppError::Validation(format!("invalid group cursor: {e}")))?;
        let json = String::from_utf8(bytes)
            .map_err(|e| AppError::Validation(format!("invalid group cursor UTF-8: {e}")))?;
        let cursor: GroupCursor = serde_json::from_str(&json)
            .map_err(|e| AppError::Validation(format!("invalid group cursor JSON: {e}")))?;
        if cursor.version != CURSOR_VERSION {
            return Err(AppError::Validation(format!(
                "group cursor: unsupported version {} (expected {CURSOR_VERSION})",
                cursor.version
            )));
        }
        Ok(cursor)
    }
}

/// One group bucket fetched from the GROUP BY query: the rendered key, its
/// full count, and its per-group aggregate results (decoded from the dynamic
/// `a0…aN` columns; empty when no aggregates were requested).
struct GroupBucketRow {
    gkey: String,
    gcount: i64,
    aggregates: Vec<AggregateResult>,
}

/// One previewed member row: an [`EngineRow`] plus the rendered group key it
/// belongs to (so members distribute back into their buckets).
#[derive(sqlx::FromRow)]
struct GroupMemberRow {
    #[sqlx(flatten)]
    inner: EngineRow,
    gkey: String,
}

/// Run the grouped path: bucket the matched rows by `spec`'s dimension,
/// paginate over GROUPS (keyset on `gcount DESC, gkey ASC`), and attach a
/// bounded per-group member preview.
async fn run_grouped(
    pool: &SqlitePool,
    spec: &GroupSpec,
    request: &AdvancedQueryRequest,
    ctx: GroupCtx<'_>,
    limit: i64,
) -> Result<AdvancedQueryResponse, AppError> {
    // The group-key property bind (if any) occupies the first free slot after
    // the space + filter binds; every subsequent bind follows it.
    let key_pos = ctx.next_pos;
    let (raw_key_expr, join, key_bind) = group_key_expr(&spec.key, key_pos);
    let mut next_pos = key_pos + usize::from(key_bind.is_some());
    // The rendered key: NULL/absent → the `"none"` bucket. Reused verbatim in
    // SELECT / GROUP BY / HAVING / PARTITION BY / IN so a single key bind (if
    // any) feeds every occurrence.
    let gkey_expr = format!("COALESCE({raw_key_expr}, 'none')");

    let group_cursor = match request.cursor.as_deref() {
        Some(s) => Some(GroupCursor::decode(s)?),
        None => None,
    };
    let _ = ctx.space_pos; // documented in `predicate`; bound positionally.

    // ── per-group aggregate exprs ─────────────────────────────────────────
    // Resolved against the group-page query's bind numbering: their
    // property-key binds occupy the slots RIGHT AFTER the group-key bind
    // (advancing `next_pos`), so the HAVING / LIMIT slots that follow are
    // numbered past them. The aggregate exprs are added to the GROUP BY
    // SELECT (computed PER bucket) aliased `a0…aN`. Empty → no extra columns.
    let (agg_terms, agg_binds) = resolve_aggregates(&request.aggregates, &mut next_pos);
    // `CAST(… AS REAL)` so each per-group aggregate column decodes uniformly as
    // a nullable f64 (see the global query for the COUNT-is-INTEGER rationale).
    let agg_select: String = agg_terms
        .iter()
        .enumerate()
        .map(|(i, t)| format!(", CAST({} AS REAL) AS {}", t.expr, agg_alias(i)))
        .collect();

    // ── total_count = total #groups, FIRST page only ──────────────────────
    let total_count: Option<i64> = if group_cursor.is_none() {
        let count_sql = format!(
            "SELECT COUNT(*) FROM (SELECT {gkey_expr} AS gkey FROM {from}{join} \
             WHERE {pred} GROUP BY gkey)",
            from = ctx.from_clause,
            pred = ctx.predicate,
        );
        // dynamic-sql: GROUP-BY key + WHERE are the runtime GroupKey + compiled FilterExpr tree + optional FTS5 MATCH (macro form cannot express it); all values are bound params.
        let mut q = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql.as_str()));
        if let Some(m) = ctx.match_sanitized {
            q = q.bind(m.to_string()); // ?1 = MATCH
        }
        q = q.bind(ctx.space_id.to_string()); // ?space_pos
        for b in ctx.filter_binds {
            q = bind_scalar(q, b);
        }
        if let Some(b) = key_bind.as_ref() {
            q = bind_scalar(q, b);
        }
        let c = if ctx.has_fulltext {
            q.fetch_one(pool).await.map_err(map_fts_error)?
        } else {
            q.fetch_one(pool).await?
        };
        Some(c)
    } else {
        None
    };

    // ── GLOBAL aggregates (grouped mode), FIRST page only ─────────────────
    // Computed over the SAME match set as the flat path — the un-grouped
    // predicate / FROM (NO group-key join), so a multi-valued tag key does not
    // double-count the global fold. A SEPARATE statement with its OWN bind
    // numbering, so the property-key binds start right after the space +
    // filter binds (a LOCAL position counter; the group-page numbering above
    // is untouched).
    let global_aggregates: Vec<AggregateResult> =
        if group_cursor.is_none() && !request.aggregates.is_empty() {
            let mut agg_pos = ctx.next_pos;
            let (gterms, gbinds) = resolve_aggregates(&request.aggregates, &mut agg_pos);
            run_aggregate_query(
                pool,
                ctx.from_clause,
                ctx.predicate,
                ctx.space_id,
                ctx.match_sanitized,
                ctx.has_fulltext,
                ctx.filter_binds,
                &gterms,
                &gbinds,
            )
            .await?
        } else {
            Vec::new()
        };

    // ── group page: keyset over `gcount DESC, gkey ASC` ───────────────────
    // Resume predicate (HAVING, since it filters the GROUPED rows): a group is
    // strictly AFTER the cursor iff its count is smaller, or equal-count with a
    // strictly-greater key. NULL never occurs (gkey is COALESCE'd).
    let having = if group_cursor.is_some() {
        let p_count = next_pos;
        let p_count2 = next_pos + 1;
        let p_key = next_pos + 2;
        next_pos += 3;
        format!(" HAVING (gcount < ?{p_count} OR (gcount = ?{p_count2} AND gkey > ?{p_key}))")
    } else {
        String::new()
    };
    let limit_pos = next_pos;
    let limit_plus_one = limit + 1;

    let group_sql = format!(
        "SELECT {gkey_expr} AS gkey, COUNT(*) AS gcount{agg_select} FROM {from}{join} \
         WHERE {pred} GROUP BY gkey{having} \
         ORDER BY gcount DESC, gkey ASC LIMIT ?{limit_pos}",
        from = ctx.from_clause,
        pred = ctx.predicate,
    );
    // dynamic-sql: GROUP-BY key + per-group aggregate SELECT + WHERE + keyset HAVING are the runtime GroupKey + AggregateSpec set + compiled FilterExpr tree + optional FTS5 MATCH (macro form cannot express it); all values are bound params.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(group_sql.as_str()));
    if let Some(m) = ctx.match_sanitized {
        q = q.bind(m.to_string()); // ?1 = MATCH
    }
    q = q.bind(ctx.space_id.to_string()); // ?space_pos
    for b in ctx.filter_binds {
        q = bind_raw(q, b);
    }
    if let Some(b) = key_bind.as_ref() {
        q = bind_raw(q, b);
    }
    // Per-group aggregate property-key binds follow the group-key bind, in the
    // slots `resolve_aggregates` numbered (before the HAVING / LIMIT binds).
    for b in &agg_binds {
        q = bind_raw(q, b);
    }
    if let Some(c) = group_cursor.as_ref() {
        q = q.bind(c.count).bind(c.count).bind(c.key.clone());
    }
    q = q.bind(limit_plus_one);
    let bucket_rows: Vec<sqlx::sqlite::SqliteRow> = if ctx.has_fulltext {
        q.fetch_all(pool).await.map_err(map_fts_error)?
    } else {
        q.fetch_all(pool).await?
    };
    // Decode each bucket: `gkey`, `gcount`, then the dynamic `a0…aN` aggregate
    // columns parsed into per-group [`AggregateResult`]s (empty when no
    // aggregates were requested).
    use sqlx::Row as _;
    let mut buckets: Vec<GroupBucketRow> = Vec::with_capacity(bucket_rows.len());
    for row in &bucket_rows {
        let gkey: String = row.try_get("gkey")?;
        let gcount: i64 = row.try_get("gcount")?;
        let cells: Vec<Option<f64>> = (0..agg_terms.len())
            .map(|i| row.try_get::<Option<f64>, _>(agg_alias(i).as_str()))
            .collect::<Result<_, _>>()?;
        buckets.push(GroupBucketRow {
            gkey,
            gcount,
            aggregates: decode_aggregates(&agg_terms, &cells),
        });
    }

    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = buckets.len() > limit_usize;
    if has_more {
        buckets.truncate(limit_usize);
    }

    if buckets.is_empty() {
        return Ok(AdvancedQueryResponse {
            rows: Vec::new(),
            groups: Vec::new(),
            next_cursor: None,
            has_more: false,
            total_count,
            aggregates: global_aggregates,
        });
    }

    // ── bounded member preview: the first N members per bucket on this page ─
    // ONE windowed query scoped to the page's group keys, capped per group by
    // a `ROW_NUMBER()` window so a huge bucket cannot blow the payload.
    let page_keys: Vec<String> = buckets.iter().map(|b| b.gkey.clone()).collect();
    // Default sort for the preview: relevance-first on the full-text path,
    // else the recency keyset (`b.id DESC`). The window orders members by it.
    let preview_terms = resolve_sort(&[], ctx.has_fulltext)?;
    let preview_order = preview_terms
        .iter()
        .map(|t| {
            format!(
                "{} {} NULLS LAST",
                t.expr,
                if t.desc { "DESC" } else { "ASC" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    // `IN (?,?,…)` over the page's group keys; binds follow the per-statement
    // prefix (+ key bind).
    let in_start = ctx.next_pos + usize::from(key_bind.is_some());
    let in_placeholders = (0..page_keys.len())
        .map(|i| format!("?{}", in_start + i))
        .collect::<Vec<_>>()
        .join(", ");
    let rn_pos = in_start + page_keys.len();

    let rank_select = if ctx.has_fulltext {
        "fts.rank"
    } else {
        "CAST(NULL AS REAL)"
    };
    let member_sql = format!(
        "SELECT * FROM ( \
           SELECT {cols}, \
             COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), 0) AS __last_edited, \
             (SELECT title FROM pages_cache WHERE page_id = b.id) AS __title, \
             {rank_select} AS __rank, \
             {gkey_expr} AS gkey, \
             ROW_NUMBER() OVER (PARTITION BY {gkey_expr} ORDER BY {preview_order}) AS __rn \
           FROM {from}{join} \
           WHERE {pred} AND {gkey_expr} IN ({in_placeholders}) \
         ) WHERE __rn <= ?{rn_pos}",
        cols = crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS,
        from = ctx.from_clause,
        pred = ctx.predicate,
    );
    // dynamic-sql: windowed member preview over the runtime GroupKey + compiled FilterExpr tree + optional FTS5 MATCH (macro form cannot express it); all values are bound params.
    let mut mq = sqlx::query_as::<_, GroupMemberRow>(sqlx::AssertSqlSafe(member_sql.as_str()));
    if let Some(m) = ctx.match_sanitized {
        mq = mq.bind(m.to_string()); // ?1 = MATCH
    }
    mq = mq.bind(ctx.space_id.to_string()); // ?space_pos
    for b in ctx.filter_binds {
        mq = bind_as(mq, b);
    }
    if let Some(b) = key_bind.as_ref() {
        mq = bind_as(mq, b);
    }
    for k in &page_keys {
        mq = mq.bind(k.clone());
    }
    mq = mq.bind(GROUP_MEMBER_PREVIEW);
    let member_rows: Vec<GroupMemberRow> = if ctx.has_fulltext {
        mq.fetch_all(pool).await.map_err(map_fts_error)?
    } else {
        mq.fetch_all(pool).await?
    };

    // Distribute members back into their buckets, preserving the group order
    // (the `buckets` page order is the `gcount DESC, gkey ASC` order). The
    // member query returns rows window-ordered within each partition, but the
    // overall row order across partitions is unspecified, so bucket by key.
    use std::collections::HashMap;
    let mut by_key: HashMap<String, Vec<QueryResultRow>> = HashMap::new();
    for m in member_rows {
        by_key.entry(m.gkey).or_default().push(QueryResultRow {
            score: m.inner.rank,
            block: m.inner.block,
        });
    }

    let groups: Vec<QueryGroup> = buckets
        .iter()
        .map(|b| QueryGroup {
            key: b.gkey.clone(),
            count: b.gcount,
            members: by_key.remove(&b.gkey).unwrap_or_default(),
            aggregates: b.aggregates.clone(),
        })
        .collect();

    let next_cursor = if has_more {
        let last = buckets.last().expect("has_more implies non-empty");
        Some(
            GroupCursor {
                version: CURSOR_VERSION,
                count: last.gcount,
                key: last.gkey.clone(),
            }
            .encode()?,
        )
    } else {
        None
    };

    Ok(AdvancedQueryResponse {
        rows: Vec::new(),
        groups,
        next_cursor,
        has_more,
        total_count,
        aggregates: global_aggregates,
    })
}
