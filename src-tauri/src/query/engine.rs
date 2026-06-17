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
    AdvancedQueryRequest, AdvancedQueryResponse, QueryResultRow, SortColumn, SortKey, SortSource,
};

/// Default page size when the request leaves `limit` unset.
pub const DEFAULT_LIMIT: i64 = 50;

/// Maximum page size a request may ask for.
pub const MAX_LIMIT: i64 = 200;

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

    // Decode the cursor (if any) and resolve the sort terms.
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

    // FROM clause + structural predicate. On the full-text path the FROM
    // joins `fts_blocks` and the predicate is prefixed with the MATCH;
    // otherwise it is the plain `blocks b` scan. The `?N` of the space bind
    // tracks `space_pos`.
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
        next_cursor,
        has_more,
        total_count,
    })
}
