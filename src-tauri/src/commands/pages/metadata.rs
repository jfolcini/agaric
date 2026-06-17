//! Pages-view metadata listing command handlers (#644 split).
//!
//! PEND-56 / PEND-58 — `list_pages_with_metadata` and its `*_inner` core,
//! the per-sort keyset descriptors, the compound-filter compiler, and the
//! cursor/sort helpers.

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::ReadPool;
use crate::error::AppError;
use crate::error::validation_code::{INVALID_DATE_FILTER, prefixed};
use crate::filters::{FilterPrimitive, PagesProjection, Projection, WhereClause};
use crate::pagination::{Cursor, PageRequest, PageResponse};
use crate::ulid::{BlockId, PageId};

use super::super::*;

// ───────────────────────────────────────────────────────────────────────────
// PEND-56 — list_pages_with_metadata
//
// Sibling IPC to `list_pages_inner`. Returns the same column shape as
// `BlockRow` PLUS four metadata columns:
//
//   - `last_modified_at`: max(`op_log.created_at`) over the page itself.
//     Page-only (not subtree-aware) per PEND-56 open-question 1 — the
//     recursive-CTE variant is deferred until a benchmark says it's
//     worth the cost.
//   - `inbound_link_count`: COUNT of distinct source blocks linking to
//     this page OR any of its descendants, EXCLUDING same-page/self links
//     (a source on this same page) and deleted/orphan sources — matching
//     the canonical backlink count in `backlink/grouped.rs`. Read straight
//     from the materializer-maintained `pages_cache.inbound_link_count`
//     column (recomputed by `recompute_pages_cache_counts_for_pages` and
//     backfilled by migration 0070), not computed here.
//   - `child_block_count`: COUNT non-deleted blocks whose `page_id`
//     matches AND id != page_id (descendants only).
//   - `has_property_flags`: 4-bit bitmask. Initial allowlist per the
//     plan:
//       bit 0 (1): page has tags applied directly
//       bit 1 (2): page has any descendant with a `todo_state`
//       bit 2 (4): page has any descendant with a `scheduled_date`
//       bit 3 (8): page has any descendant with a `due_date`
//     Adding new flags is an additive bit; the frontend renders the
//     first matched flag as a chip at "regular" density.
//
// Cursor strategy reuses the existing `Cursor` slots per the doc
// comment's "composite overload" guidance (see `pagination/mod.rs:285`):
// each sort mode encodes its sort-key value into either `deleted_at`
// (strings / ISO timestamps) or `seq` (i64 counts), with `id` as the
// tiebreaker. No new field on the `Cursor` struct.
//
// Sort modes:
//   - Alphabetical: keyset (`COALESCE(content,'')` COLLATE NOCASE, id)
//   - RecentlyModified: keyset (`last_modified_at`, id) DESC NULLS LAST
//   - MostLinked: keyset (`inbound_link_count` DESC, id ASC)
//   - MostContent: keyset (`child_block_count` DESC, id ASC)
//   - Default: keyset (id) ASC — power-user / debug
// ───────────────────────────────────────────────────────────────────────────

/// Sort mode for [`list_pages_with_metadata_inner`].
///
/// These are the server-derived sort modes the IPC exposes. The
/// frontend may layer two additional sorts that don't go over the wire:
///
///   - `recent` — per-device visit history (sourced from `getRecentPages()`).
///   - `created` — ULID DESC (just `Default` reversed in JS).
///
/// Both reuse the `Default` SQL ordering and re-sort the loaded page
/// client-side.
#[derive(Debug, Clone, Copy, Default, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PageSort {
    /// Title ascending, case-insensitive. Default for "browse my pages".
    #[default]
    Alphabetical,
    // Perf ceiling (PEND-58d D5): unlike `MostLinked` / `MostContent`
    // (which read materialised `pages_cache` columns), `RecentlyModified`
    // computes `MAX(op_log.created_at)` per page via a correlated subquery
    // across the space *before* the LIMIT — it is NOT materialised. The
    // `idx_op_log_block_id` index (migration 0030) serves each subquery,
    // but the per-row aggregate still dominates at scale. The
    // `recently_modified_perf_gate_20k_pages` `#[ignore]`-d test gates the
    // first-page latency at 20k pages. Materialising a
    // `pages_cache.last_edited_at` column (kept fresh by the materializer on
    // every op) is the heavier alternative — DEFERRED, not done here; it
    // would let this sort read a column like the other count sorts. Revisit
    // if the perf gate trips. (Intentionally a non-doc `//` comment: the
    // doc comment below is specta-exposed, so keeping the ceiling text out
    // of it avoids drifting the committed `src/lib/bindings.ts`.)
    //
    /// Last-modified timestamp (max op_log.created_at) DESC.
    RecentlyModified,
    /// Inbound-link count DESC (page + descendant link targets).
    MostLinked,
    /// Descendant-block count DESC.
    MostContent,
    /// Default backend ordering — block id ASC. Useful for debugging
    /// and as the wire shape for the frontend-only `recent` / `created`
    /// sorts that re-sort client-side.
    #[serde(rename = "default")]
    Default,
}

/// Filter / sort bundle for [`list_pages_with_metadata`].
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListPagesWithMetadataFilter {
    #[serde(default)]
    pub sort: PageSort,
    pub space_id: String,
    /// PEND-58 Phase 3 — compound filter primitives applied server-side,
    /// AND-joined into the WHERE before the keyset/ORDER BY/LIMIT. Empty
    /// (the default) preserves the pre-PEND-58 "no filter" behaviour, so
    /// existing callers and the flag-off path are unaffected. Each
    /// primitive is gated against [`PagesProjection::allowed_keys`] and
    /// rejected with [`AppError::Validation`] if it is not a Pages-surface
    /// token (defence-in-depth — the frontend never sends Search-only
    /// primitives, but the backend must not trust that).
    #[serde(default)]
    pub filters: Vec<FilterPrimitive>,
}

/// Boolean facts about a page's contents (Review Round 1: replaces a
/// `has_property_flags: i64` bitmask). Each field maps 1:1 to an
/// `EXISTS` subquery in the metadata SELECT. Adding a new flag is
/// purely additive — new `bool` column, no consumer surprises.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, Type)]
#[serde(rename_all = "camelCase")]
pub struct PagePropertyFlags {
    /// Page itself carries a `block_tags` row.
    pub has_tags: bool,
    /// At least one descendant has a non-NULL `todo_state`.
    pub has_todo: bool,
    /// At least one descendant has a non-NULL `scheduled_date`.
    pub has_scheduled: bool,
    /// At least one descendant has a non-NULL `due_date`.
    pub has_due: bool,
}

/// Row returned by [`list_pages_with_metadata_inner`].
///
/// Carries every `BlockRow` column verbatim so the frontend can read
/// `id`, `content`, etc. via the same accessors. Four extra metadata
/// columns drive the new sort modes + density badges.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageWithMetadataRow {
    pub id: BlockId,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<BlockId>,
    pub position: Option<i64>,
    pub deleted_at: Option<i64>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
    pub page_id: Option<PageId>,
    /// max(`op_log.created_at`) over the page itself, as INTEGER
    /// epoch-milliseconds (#109 Phase 2). None if the page has no op-log
    /// entries (which should never happen — every active page has at
    /// least its own creation row — but the column is `Option` to absorb
    /// edge cases like manually-imported rows without a synthesised
    /// op-log entry).
    pub last_modified_at: Option<i64>,
    /// COUNT of `block_links` targeting this page or any of its
    /// descendants. Always emitted (zero for un-linked pages).
    pub inbound_link_count: i64,
    /// COUNT of non-deleted descendants (blocks where `page_id = id`,
    /// excluding the page itself). Always emitted.
    pub child_block_count: i64,
    /// Typed flag struct (Review Round 1: replaces the prior
    /// `has_property_flags: i64` bitmask — see [`PagePropertyFlags`]).
    #[sqlx(flatten)]
    pub flags: PagePropertyFlags,
}

/// Build the `position` slot's encoded sort-mode tag. Used by
/// [`encode_pages_metadata_cursor`] / [`validate_pages_metadata_cursor`]
/// to refuse a cursor whose sort-mode discriminator doesn't match the
/// request — the user-visible alternative is a silent "scrolled past
/// end" with no recovery, which Review Round 1 flagged across three
/// independent reviewers as a BLOCKER. Per-sort i64 stamped into the
/// already-unused `Cursor.position` slot.
fn sort_discriminator(sort: PageSort) -> i64 {
    match sort {
        PageSort::Alphabetical => 1,
        PageSort::RecentlyModified => 2,
        PageSort::MostLinked => 3,
        PageSort::MostContent => 4,
        PageSort::Default => 5,
    }
}

/// Reject a cursor whose `position` slot doesn't match the requested
/// sort. Returns `AppError::Validation` with the `RequiresRefresh:`
/// prefix the frontend uses to render a "Sort changed — refresh to
/// continue" toast (PEND-56 acceptance criterion #3).
fn validate_pages_metadata_cursor(cursor: &Cursor, sort: PageSort) -> Result<(), AppError> {
    match cursor.position {
        Some(d) if d == sort_discriminator(sort) => Ok(()),
        Some(_) | None => Err(AppError::Validation(format!(
            "RequiresRefresh: cursor sort mismatch (expected {sort:?})"
        ))),
    }
}

/// Sentinel substituted for NULL `last_modified_at` in the
/// `RecentlyModified` keyset (Review Round 1 HIGH #2 fix). #109 Phase 2:
/// `last_modified_at` is INTEGER epoch-ms, so the sentinel is `0` — it
/// sorts BEFORE any plausible timestamp in DESC order, so the keyset
/// comparison works uniformly for NULL and non-NULL rows (sorted last in
/// DESC).
const LAST_MOD_NULL_SENTINEL: i64 = 0;

/// Heterogeneous bind value for the runtime-composed
/// `list_pages_with_metadata_inner` query. The IPC composes the SQL
/// per sort mode and binds parameters in order; this enum exists so
/// the per-mode bind list can mix `&str` (space_id, content cursor)
/// and `i64` (counts, limits) without per-arm `.bind()` chains.
#[derive(Clone)]
enum SqlBind<'a> {
    Str(&'a str),
    OwnedStr(String),
    I64(i64),
    /// #1280 — a real (`f64`) value, emitted by a `has-property` predicate
    /// over a numeric `PropertyValue::Num` operand.
    F64(f64),
}

impl<'a> SqlBind<'a> {
    /// Bind this value onto a `sqlx::query_as::<…>` chain. Helper to
    /// keep the binding loop in `list_pages_with_metadata_inner` a
    /// one-liner per parameter.
    fn bind_to<'q, O>(
        self,
        q: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    ) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>
    where
        'a: 'q,
    {
        match self {
            SqlBind::Str(s) => q.bind(s),
            SqlBind::OwnedStr(s) => q.bind(s),
            SqlBind::I64(i) => q.bind(i),
            SqlBind::F64(f) => q.bind(f),
        }
    }

    /// Bind this value onto a `sqlx::query_scalar::<…>` chain. The
    /// `total_count` COUNT query (PEND-58b P1-D) reuses the same compiled
    /// filter binds as the fetch but returns a single scalar, so it needs
    /// a `QueryScalar`-shaped sibling of [`Self::bind_to`].
    fn bind_to_scalar<'q, O>(
        self,
        q: sqlx::query::QueryScalar<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    ) -> sqlx::query::QueryScalar<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>
    where
        'a: 'q,
    {
        match self {
            SqlBind::Str(s) => q.bind(s),
            SqlBind::OwnedStr(s) => q.bind(s),
            SqlBind::I64(i) => q.bind(i),
            SqlBind::F64(f) => q.bind(f),
        }
    }
}

/// Per-sort descriptor extracted from the body of
/// `list_pages_with_metadata_inner`. Collapses what used to be a
/// 5-arm match with ~250 lines of near-duplicate SQL composition into
/// a small lookup table; each arm of `keyset_for` is one of these
/// variants and the IPC consumes the descriptor via a single shared
/// `apply` method.
///
/// **Bind contract:** `?1 = filter.space_id` always. PEND-58 splices
/// compound-filter clauses (with their own `?` binds) into the WHERE
/// between space_id and the keyset; `SortKeyset::apply` therefore numbers
/// its placeholders from a runtime `base` offset (`1 + filter_bind_count`)
/// rather than the hardcoded `?2`. With no filters, `base = 1` reproduces
/// the original `?2 .. ?N` numbering.
///
/// **Why an enum rather than a `struct` with fn pointers / closures?**
/// The five sort modes have three distinct keyset shapes (string-ASC,
/// string-DESC-with-null-sentinel, i64-DESC) plus a degenerate "id
/// only" mode. A flat struct couldn't model the `RecentlyModified`
/// null-sentinel slot without optional fields that the other variants
/// would have to leave `None`; modelling each shape explicitly keeps
/// the bind-position arithmetic readable and the exhaustiveness check
/// honest.
enum SortKeyset {
    /// `(key_expr, id) ASC` keyset. Cursor stashes the last row's key
    /// in the `deleted_at` slot (string). Used by `Alphabetical`.
    StringAsc {
        /// SQL expression for the sort key (e.g.
        /// `COALESCE(b.content,'') COLLATE NOCASE`). Composed verbatim
        /// into the keyset predicate and ORDER BY.
        key_expr: &'static str,
    },
    /// `(key_expr, id) DESC` keyset where `key_expr` references a
    /// trailing NULL-sentinel bind slot (`?S`). The composer
    /// substitutes the runtime bind position into the placeholder.
    /// Used by `RecentlyModified`.
    StringDescNullCoalesced {
        /// SQL template with `{S}` as the sentinel bind placeholder.
        /// E.g. `COALESCE((SELECT MAX(created_at) FROM op_log WHERE
        /// block_id = b.id), ?{S})`. The composer substitutes `{S}`
        /// with the actual bind position.
        key_expr_template: &'static str,
        /// INTEGER epoch-ms written to the sentinel slot at runtime
        /// (#109 Phase 2; `last_modified_at` is now INTEGER).
        null_sentinel: i64,
    },
    /// `(key_expr, id) DESC` keyset over an i64-typed column. Cursor
    /// stashes the last row's count in the `seq` slot. Used by
    /// `MostLinked` and `MostContent` — both now read from
    /// `pages_cache` (materialised by the materializer) so the
    /// expression is a column reference, not a subquery.
    I64Desc {
        /// SQL expression for the sort key. After PEND-56b this is
        /// `pc.inbound_link_count` or `pc.child_block_count` — a
        /// materialised column reached via the LEFT JOIN to
        /// `pages_cache pc`.
        key_expr: &'static str,
    },
    /// `b.id ASC` only. No extra sort-key slot. Used by `Default`.
    IdOnly,
}

/// Map a [`PageSort`] to its [`SortKeyset`] descriptor.
fn keyset_for(sort: PageSort) -> SortKeyset {
    match sort {
        PageSort::Alphabetical => SortKeyset::StringAsc {
            key_expr: "COALESCE(b.content,'') COLLATE NOCASE",
        },
        // PEND-58d D5 perf ceiling: this key is the UN-materialised
        // `MAX(op_log.created_at)` correlated subquery (served by
        // `idx_op_log_block_id`), evaluated per page before the LIMIT — the
        // heaviest sort key. Gated by `recently_modified_perf_gate_20k_pages`
        // (`#[ignore]`'d). Materialising `pages_cache.last_edited_at` is the
        // deferred remedy (see the `PageSort::RecentlyModified` comment).
        PageSort::RecentlyModified => SortKeyset::StringDescNullCoalesced {
            key_expr_template: "COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), ?{S})",
            null_sentinel: LAST_MOD_NULL_SENTINEL,
        },
        // PEND-56b: read from the materialised `pages_cache` column
        // instead of the per-row `COUNT(DISTINCT bl.source_id) FROM
        // block_links` correlated subquery. The materializer keeps
        // `pc.inbound_link_count` byte-identical to the canonical
        // SELECT on every block-lifecycle op; see
        // `pages_cache_count_parity` for the guarding test.
        PageSort::MostLinked => SortKeyset::I64Desc {
            key_expr: "COALESCE(pc.inbound_link_count, 0)",
        },
        // PEND-56b: see above; reads `pc.child_block_count` via the
        // same LEFT JOIN.
        PageSort::MostContent => SortKeyset::I64Desc {
            key_expr: "COALESCE(pc.child_block_count, 0)",
        },
        PageSort::Default => SortKeyset::IdOnly,
    }
}

/// Append the keyset WHERE clause and ORDER BY for this descriptor.
/// Returns the bind values (in order) that the caller must append to
/// the `query_as` chain after the leading `?1 = space_id`.
///
/// `cursor` is the decoded keyset position from the prior page (None
/// for first-page requests). `limit_plus_one` is the LIMIT bind value
/// (probe-for-more pattern).
///
/// **Bind position arithmetic:** the leading bind is `?1` (space_id),
/// and this function appends binds at positions `?2 .. ?N` in the
/// order returned. Each variant computes the LIMIT placeholder
/// position from the trailing bind count so the SQL stays
/// self-consistent.
impl SortKeyset {
    /// Append the keyset predicate + ORDER BY + LIMIT and return the
    /// keyset binds in order.
    ///
    /// **PEND-58 — `base` bind offset:** the keyset's placeholders used to
    /// be hardcoded `?2 .. ?5` on the assumption that `?1 = space_id` was
    /// the only bind before them. Phase 3 splices compound-filter clauses
    /// (each with its own `?` binds) into the WHERE *between* the space_id
    /// bind and the keyset. `base` is the highest placeholder position
    /// already consumed (`1` for space_id plus the filter-bind count); the
    /// keyset numbers its own placeholders from `base + 1` so SQLite's
    /// positional binding stays aligned regardless of how many filter
    /// binds preceded it. With no filters, `base = 1` reproduces the old
    /// `?2 ..` numbering exactly.
    fn apply<'a>(
        self,
        sql: &mut String,
        cursor: Option<&'a Cursor>,
        limit_plus_one: i64,
        base: usize,
    ) -> Vec<SqlBind<'a>> {
        let mut binds: Vec<SqlBind<'a>> = Vec::new();
        // Placeholder positions, computed from the running `base`. Named
        // for readability so the SQL templates read like the originals.
        let p1 = base + 1;
        let p2 = base + 2;
        let p3 = base + 3;
        let p4 = base + 4;
        match (self, cursor) {
            // ── StringAsc: (key, id) ASC ──────────────────────────
            (SortKeyset::StringAsc { key_expr }, Some(c)) => {
                let last_key = c.deleted_at.clone().unwrap_or_default();
                // Binds: last_key, last_id, limit.
                sql.push_str(&format!(
                    " AND ( {key_expr} > ?{p1} \
                            OR ({key_expr} = ?{p1} AND b.id > ?{p2}) ) \
                       ORDER BY {key_expr} ASC, b.id ASC \
                       LIMIT ?{p3}"
                ));
                binds.push(SqlBind::OwnedStr(last_key));
                binds.push(SqlBind::Str(c.id.as_str()));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            (SortKeyset::StringAsc { key_expr }, None) => {
                // Binds: limit.
                sql.push_str(&format!(" ORDER BY {key_expr} ASC, b.id ASC LIMIT ?{p1}"));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            // ── StringDescNullCoalesced: (key, id) DESC + sentinel ─
            (
                SortKeyset::StringDescNullCoalesced {
                    key_expr_template,
                    null_sentinel,
                },
                Some(c),
            ) => {
                // #109 Phase 2: the keyset value is INTEGER epoch-ms. The
                // cursor stashes it in the `deleted_at` string slot (opaque
                // wire format), so parse it back to i64, defaulting to the
                // integer null sentinel for a NULL/legacy cursor value.
                let last_key = c
                    .deleted_at
                    .as_deref()
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(null_sentinel);
                // Sentinel lives at p4; cursor binds are p1=last_key,
                // p2=last_id, p3=limit. The template references the
                // sentinel via `{S}` so we substitute the literal
                // bind position before pushing.
                let key_expr = key_expr_template.replace("{S}", &p4.to_string());
                sql.push_str(&format!(
                    " AND ( {key_expr} < ?{p1} \
                            OR ({key_expr} = ?{p1} AND b.id > ?{p2}) ) \
                       ORDER BY {key_expr} DESC, b.id ASC \
                       LIMIT ?{p3}"
                ));
                binds.push(SqlBind::I64(last_key));
                binds.push(SqlBind::Str(c.id.as_str()));
                binds.push(SqlBind::I64(limit_plus_one));
                binds.push(SqlBind::I64(null_sentinel));
            }
            (
                SortKeyset::StringDescNullCoalesced {
                    key_expr_template,
                    null_sentinel,
                },
                None,
            ) => {
                // Sentinel at p1; limit at p2.
                let key_expr = key_expr_template.replace("{S}", &p1.to_string());
                sql.push_str(&format!(" ORDER BY {key_expr} DESC, b.id ASC LIMIT ?{p2}"));
                binds.push(SqlBind::I64(null_sentinel));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            // ── I64Desc: (key, id) DESC over an i64 column ────────
            (SortKeyset::I64Desc { key_expr }, Some(c)) => {
                let last_count = c.seq.unwrap_or(0);
                // Binds: last_count, last_id, limit.
                sql.push_str(&format!(
                    " AND ( {key_expr} < ?{p1} \
                            OR ({key_expr} = ?{p1} AND b.id > ?{p2}) ) \
                       ORDER BY {key_expr} DESC, b.id ASC LIMIT ?{p3}"
                ));
                binds.push(SqlBind::I64(last_count));
                binds.push(SqlBind::Str(c.id.as_str()));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            (SortKeyset::I64Desc { key_expr }, None) => {
                // Binds: limit.
                sql.push_str(&format!(" ORDER BY {key_expr} DESC, b.id ASC LIMIT ?{p1}"));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            // ── IdOnly: id ASC only (Default sort) ────────────────
            (SortKeyset::IdOnly, Some(c)) => {
                // Binds: last_id, limit.
                sql.push_str(&format!(" AND b.id > ?{p1} ORDER BY b.id ASC LIMIT ?{p2}"));
                binds.push(SqlBind::Str(c.id.as_str()));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            (SortKeyset::IdOnly, None) => {
                // Binds: limit.
                sql.push_str(&format!(" ORDER BY b.id ASC LIMIT ?{p1}"));
                binds.push(SqlBind::I64(limit_plus_one));
            }
        }
        binds
    }
}

/// PEND-58d D15 — validate a `LastEdited` `Range` date bound, matching the
/// legacy Search date contract (`fts::metadata_filter::resolve_date_filter`,
/// `InvalidDateFilter:` prefix the frontend keys on).
///
/// Pages compares the bound string against `op_log.created_at` (full ISO
/// timestamps), so we accept either a bare calendar date (`YYYY-MM-DD`) OR
/// a full RFC 3339 timestamp (`YYYY-MM-DDTHH:MM:SSZ`). An empty string or
/// an otherwise-unparseable value is rejected — an unvalidated malformed
/// date would otherwise compare-fail every row and silently return zero
/// results (the bug D15 closes).
fn validate_last_edited_date(label: &str, value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::Validation(prefixed(
            INVALID_DATE_FILTER,
            &format!("{label} must not be empty"),
        )));
    }
    // Accept a bare calendar date first, then a full RFC 3339 timestamp.
    if chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
        || chrono::DateTime::parse_from_rfc3339(value).is_ok()
    {
        return Ok(());
    }
    Err(AppError::Validation(prefixed(
        INVALID_DATE_FILTER,
        &format!("{label} expected YYYY-MM-DD or RFC 3339, got '{value}'"),
    )))
}

/// PEND-58 Phase 3 — compile the compound-filter primitives for the Pages
/// surface into a single AND-joined SQL fragment plus its ordered binds.
///
/// Returns `(sql_fragment, binds)` where `sql_fragment` is either empty
/// (no filters) or a leading-` AND (...)`-style string ready to splice
/// after the base WHERE and `binds` are the bind values in the SAME
/// left-to-right order their `?` placeholders appear in the fragment.
///
/// Steps (mirrors PEND-58 §"Filter primitive contract" / §Performance):
///
/// 1. **Allowed-keys gate** — reject any primitive whose token is not in
///    [`PagesProjection::allowed_keys`] with [`AppError::Validation`]
///    (`InvalidFilter:` prefix). Defence-in-depth: the frontend never
///    sends Search-only primitives, but the backend must not trust that.
/// 2. **Date validation (PEND-58d D15)** — `LastEdited::Range` bounds are
///    validated against the legacy Search date contract (`InvalidDateFilter:`
///    prefix); empty or malformed dates are rejected here rather than
///    silently returning zero rows.
/// 3. **Cost-order** — sort by [`FilterPrimitive::cost_hint`] (stable, so
///    equal-cost primitives keep their request order) so index-backed
///    clauses run before full-scan ones, letting SQLite narrow the row
///    set with the cheap clause's index first.
/// 4. **Compile + AND-join** — each clause is `PagesProjection.compile`d
///    into a `WhereClause`; the SQL fragments are AND-joined and the binds
///    concatenated in the same order. `PathGlob` is special-cased
///    (#1320-A): its raw pattern is run through `prepare_globs` (brace
///    expansion / substring wrap / ASCII-lowercase, the SAME preprocessing
///    Search does) and the resulting patterns are OR-joined (include) /
///    AND-joined (exclude) into ONE multi-`?` fragment built from
///    per-pattern `PagesProjection::compile_path_glob` sub-selects, so the
///    Pages surface now shares Search's `LOWER(title) GLOB ?` dialect.
fn compile_pages_filters(
    filters: &[FilterPrimitive],
) -> Result<(String, Vec<SqlBind<'static>>), AppError> {
    if filters.is_empty() {
        return Ok((String::new(), Vec::new()));
    }

    let allowed = PagesProjection::allowed_keys();
    // Allowed-keys gate first — fail loudly before compiling anything.
    for prim in filters {
        let key = prim.allowed_key();
        if !allowed.contains(key) {
            return Err(AppError::Validation(format!(
                "InvalidFilter: `{key}` is not a valid filter on the Pages surface"
            )));
        }
    }

    // PEND-58d D15 — validate `LastEdited::Range` date bounds before they
    // reach SQL. A malformed bound silently compare-fails every row
    // (zero results); reject it loudly with the `InvalidDateFilter:` prefix.
    for prim in filters {
        if let FilterPrimitive::LastEdited {
            spec: crate::filters::LastEditedSpec::Range { start, end },
        } = prim
        {
            validate_last_edited_date("range start", start)?;
            validate_last_edited_date("range end", end)?;
        }
    }

    // Cost-order: stable sort by cost_hint keeps equal-cost primitives in
    // their request order while floating index-backed clauses first.
    let mut ordered: Vec<&FilterPrimitive> = filters.iter().collect();
    ordered.sort_by_key(|p| p.cost_hint());

    let proj = PagesProjection;
    let mut clauses: Vec<String> = Vec::with_capacity(ordered.len());
    let mut binds: Vec<SqlBind<'static>> = Vec::new();
    // The projection emits anonymous `?` placeholders. The base SELECT
    // already uses an explicit `?1` (space_id) and the keyset uses explicit
    // `?N` numbers downstream — mixing explicit and anonymous placeholders
    // makes SQLite's positional numbering ambiguous (a bare `?` is numbered
    // relative to the largest number seen so far, which is brittle across
    // the spliced statement). We therefore renumber each fragment's `?` to
    // explicit positions starting at `?2` (right after `?1 = space_id`) so
    // the placeholder numbers are unambiguous regardless of compose order.
    let mut next_pos = 2; // ?1 is space_id
    for prim in ordered {
        // #1320-A — `PathGlob` no longer compiles via `proj.compile`: the
        // Pages surface now uses the SAME `LOWER(title) GLOB ?` dialect as
        // Search (`GLOB` + brace + `[class]`), so the raw user pattern must
        // first be run through `prepare_globs` (brace-expanded,
        // substring-wrapped, ASCII-lowercased — the SAME preprocessing the
        // Search path does upstream). One raw pattern can expand into MANY
        // prepared patterns (`{a,b}/*` → two), so we build ONE fragment that
        // OR-joins (include) / AND-joins (exclude) a per-pattern
        // `PagesProjection::compile_path_glob` sub-select. The SELECT body is
        // single-sourced through that method so the two surfaces stay in
        // lockstep on everything but the `b.id` vs `b.page_id` alias.
        let wc = if let FilterPrimitive::PathGlob { pattern, exclude } = prim {
            let prepared = crate::fts::glob_filter::prepare_globs(std::slice::from_ref(pattern))?;
            if prepared.is_empty() {
                // Whitespace-only / fully-stripped pattern → no rows to
                // constrain; emit NO clause for this primitive (skip).
                continue;
            }
            // Join op between per-pattern fragments: include = OR (set
            // union — a page matches if its title matches ANY pattern);
            // exclude = AND (set difference — the page must fall outside
            // EVERY per-pattern set, i.e. match NONE).
            let joiner = if *exclude { " AND " } else { " OR " };
            let mut frag = String::new();
            let mut frag_binds: Vec<crate::filters::primitive::Bind> = Vec::new();
            frag.push('(');
            for (i, pat) in prepared.iter().enumerate() {
                if i > 0 {
                    frag.push_str(joiner);
                }
                let inner = proj.compile_path_glob(pat, *exclude);
                frag.push_str(&inner.sql);
                frag_binds.extend(inner.binds);
            }
            frag.push(')');
            WhereClause::new(frag, frag_binds)
        } else {
            proj.compile(prim)
        };
        // The allowed-keys gate above admits only Pages-surface tokens, but
        // a primitive could still compile to `unsupported()` via the
        // cross-surface default trait methods if a future variant lands on
        // the wrong surface (after PEND-58d D8 + D26, `HasProperty` itself
        // never returns `unsupported()` — every predicate × value combo
        // compiles, and invalid combos are unrepresentable). In release
        // builds a bare `debug_assert!` would be compiled out and the
        // splice would emit a silent `1=0`, returning zero rows for what is
        // really an invalid filter shape. Reject it loudly in **all** build
        // profiles instead (PEND-58b P2-A). `is_unsupported()` reads the
        // explicit boolean flag on `WhereClause` (PEND-58d D18), not a SQL
        // substring.
        if wc.is_unsupported() {
            return Err(AppError::Validation(format!(
                "InvalidFilter: filter shape is not supported on the Pages surface: {prim:?}"
            )));
        }
        // Substitute each anonymous `?` left-to-right with `?{next_pos}`.
        let mut sql = String::with_capacity(wc.sql.len());
        for ch in wc.sql.chars() {
            if ch == '?' {
                sql.push('?');
                sql.push_str(&next_pos.to_string());
                next_pos += 1;
            } else {
                sql.push(ch);
            }
        }
        clauses.push(format!("({sql})"));
        for b in wc.binds {
            binds.push(match b {
                crate::filters::primitive::Bind::Text(s) => SqlBind::OwnedStr(s),
                crate::filters::primitive::Bind::Int(i) => SqlBind::I64(i),
                crate::filters::primitive::Bind::Real(f) => SqlBind::F64(f),
            });
        }
    }

    // Every primitive may legitimately emit NO clause (a `PathGlob` whose
    // pattern reduces to zero prepared globs is `continue`d above, #1320-A).
    // If that leaves `clauses` empty while `filters` was non-empty, joining
    // would yield a dangling ` AND ` and SQLite would reject the spliced
    // statement ("incomplete input"). Emit an empty fragment instead.
    if clauses.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    let fragment = format!(" AND {}", clauses.join(" AND "));
    Ok((fragment, binds))
}

/// The base SELECT for `list_pages_with_metadata_inner` (everything up to
/// but NOT including the compound-filter fragment, the keyset, the ORDER BY,
/// and the LIMIT). Hoisted to a `const` so the test-only
/// [`compose_list_pages_with_metadata_sql`] accessor (PEND-58e E9) composes
/// the SAME real SQL the IPC emits rather than a hand-rebuilt copy — a plan
/// regression in the IPC's actual query is then caught by the EXPLAIN tests.
///
/// `?1` is the space_id bind. The compound-filter fragment (its `?` binds
/// renumbered from `?2`) is appended after this, then the keyset / ORDER BY
/// / LIMIT.
///
/// # #424 — temp-B-tree + per-row subqueries on every sort mode (measured)
///
/// The space-filter IN-subquery makes the planner drive off the
/// space-membership set, so output order never matches the requested
/// ORDER BY: every sort mode (incl. `Default`/`Alphabetical`) gets
/// `USE TEMP B-TREE FOR ORDER BY`, the LIMIT cannot short-circuit, and
/// the per-row `has_*` EXISTS + `MAX(op_log.created_at)` subqueries are
/// evaluated across the whole filtered set first. The remedy (a
/// materialised per-page `space` column / folding `has_*` into
/// `pages_cache`) is a **schema promotion gated by AGENTS.md
/// "Architectural Stability"** and was deferred pending a measurement.
/// MEASURED 2026-06-05 at 20k pages: `Default` ~38 ms, `Alphabetical`
/// ~67 ms first-page — comfortably within budget, so the promotion is
/// not justified at this scale and stays deferred behind the
/// `default_and_alphabetical_sort_perf_gate_20k_pages` gate (alongside
/// the MostLinked / RecentlyModified / filtered gates).
///
/// # #433 — migration-0069 header claim is stale; THIS is the real shape
///
/// Migration `0069`'s header still states the `MostLinked` / `MostContent`
/// first page is a "full scan into a quick-sort top-K heap (no temp B-tree)".
/// That is **false** and cannot be corrected in place (migrations are
/// append-only / checksummed), so the correction lives here, where the query
/// actually is. The sort key is `COALESCE(pc.inbound_link_count, 0)` — an
/// expression over a LEFT JOIN keyed on `b.id`, NOT indexable — so
/// `EXPLAIN QUERY PLAN` shows `USE TEMP B-TREE FOR ORDER BY`: SQLite
/// materialises the whole filtered page set (not a `LIMIT`-50 top-K heap) and
/// evaluates the surviving per-row subqueries (`MAX(op_log.created_at)`,
/// `has_tags` / `has_todo` / `has_scheduled` / `has_due`) across every row
/// before the sort — `O(N)`, not top-K. What migration `0069` genuinely fixed
/// — and what the `most_linked_query_plan_uses_pages_cache_not_block_links`
/// test pins — is that the expensive `COUNT(DISTINCT)` over `block_links` is
/// gone (replaced by the materialised `pages_cache` count columns); the five
/// residual subqueries are cheap single-index probes. Severity is low at
/// present scale (the 20k gate passes < 100 ms). Killing the temp B-tree
/// outright (a `(inbound_link_count DESC)`-style materialised sort column) is
/// the same gated schema promotion deferred above — revisit only if a future
/// workload regresses past budget at 100k+ pages.
const PAGES_METADATA_BASE_SELECT: &str = r#"SELECT
               b.id, b.block_type, b.content, b.parent_id, b.position,
               b.deleted_at, b.todo_state, b.priority, b.due_date,
               b.scheduled_date, b.page_id,
               (SELECT MAX(created_at) FROM op_log WHERE block_id = b.id)
                   AS last_modified_at,
               COALESCE(pc.inbound_link_count, 0) AS inbound_link_count,
               COALESCE(pc.child_block_count, 0) AS child_block_count,
               EXISTS(SELECT 1 FROM block_tags WHERE block_id = b.id) AS has_tags,
               EXISTS(SELECT 1 FROM blocks descendant
                       WHERE descendant.page_id = b.id
                         AND descendant.deleted_at IS NULL
                         AND descendant.todo_state IS NOT NULL) AS has_todo,
               EXISTS(SELECT 1 FROM blocks descendant
                       WHERE descendant.page_id = b.id
                         AND descendant.deleted_at IS NULL
                         AND descendant.scheduled_date IS NOT NULL) AS has_scheduled,
               EXISTS(SELECT 1 FROM blocks descendant
                       WHERE descendant.page_id = b.id
                         AND descendant.deleted_at IS NULL
                         AND descendant.due_date IS NOT NULL) AS has_due
           FROM blocks b
           LEFT JOIN pages_cache pc ON pc.page_id = b.id
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.space_id = ?1
        "#;

/// PEND-58e E9 — test-only accessor that composes the **real** first-page
/// (no cursor) SQL `list_pages_with_metadata_inner` emits for the given
/// `filter`, so EXPLAIN-plan tests run against the IPC's actual statement
/// instead of a hand-rebuilt copy that could silently drift from it.
///
/// Mirrors the compose sequence in `list_pages_with_metadata_inner`:
/// base SELECT (`?1` = space_id) → compiled compound-filter fragment
/// (`?2 ..`) → keyset / ORDER BY / LIMIT (first page, `cursor = None`).
/// The error path (invalid filter / date) surfaces verbatim so a test can
/// also assert rejection. The space_id, filter binds, and `limit` are
/// supplied by the caller via the bound `?N` placeholders at execution.
#[cfg(test)]
pub(crate) fn compose_list_pages_with_metadata_sql(
    filter: &ListPagesWithMetadataFilter,
    limit_plus_one: i64,
) -> Result<String, AppError> {
    let mut sql = String::from(PAGES_METADATA_BASE_SELECT);
    let (filter_sql, filter_binds) = compile_pages_filters(&filter.filters)?;
    sql.push_str(&filter_sql);
    let base = 1 + filter_binds.len();
    let keyset = keyset_for(filter.sort);
    // First page: no cursor. The returned binds are discarded — the test
    // only needs the SQL string for EXPLAIN QUERY PLAN.
    let _ = keyset.apply(&mut sql, None, limit_plus_one, base);
    Ok(sql)
}

/// Inner implementation of `list_pages_with_metadata`. Cursor-paginated
/// page enumeration with metadata columns; sort mode chosen via
/// [`PageSort`].
///
/// **Cursor semantics:** the cursor carries the LAST row's sort-key
/// value (in `deleted_at` for string / ISO-timestamp sorts; in `seq`
/// for i64-count sorts), the last row's `id` as the tiebreaker, and
/// a sort-mode discriminator in `position` (Review Round 1 — protects
/// against cross-sort / cross-IPC cursor reuse). First-page requests
/// pass `cursor = None`. A stale cursor (e.g. from `list_blocks`) is
/// rejected with `AppError::Validation("RequiresRefresh: …")` so the
/// frontend can render a "Sort changed — refresh to continue" toast
/// (PEND-56 acceptance criterion #3).
///
/// **PEND-56b — materialised counts:** `inbound_link_count` and
/// `child_block_count` are read from `pages_cache.{inbound_link_count,
/// child_block_count}` via a LEFT JOIN, NOT computed per-row via the
/// `COUNT(DISTINCT …) FROM block_links` / `COUNT(*) FROM blocks`
/// correlated subqueries the prior implementation used. The
/// materializer keeps `pages_cache` rows byte-identical to the
/// canonical SELECT on every CreateBlock / EditBlock / DeleteBlock /
/// RestoreBlock / PurgeBlock op; see `materializer::tests::
/// pages_cache_count_parity` for the guarding integration test.
///
/// **Defensive contract:** the JOIN is LEFT and the columns are
/// COALESCE'd to 0. The materializer guarantees a `pages_cache` row
/// for every live page (`apply_create_block_via_loro` for block_type
/// = 'page' INSERTs the row), so a missing row indicates a
/// materializer bug. The COALESCE keeps the IPC alive while the bug
/// is investigated — the parity tests should catch the underlying
/// drift before users see a stale `0`.
#[instrument(skip(pool), err)]
pub async fn list_pages_with_metadata_inner(
    pool: &SqlitePool,
    filter: ListPagesWithMetadataFilter,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PageWithMetadataRow>, AppError> {
    // Mirror the limit-clamp policy from `list_pages_inner`.
    if let Some(l) = limit
        && !(1..=MCP_PAGE_LIMIT_CAP).contains(&l)
    {
        return Err(AppError::Validation(format!(
            "list_pages_with_metadata limit must be in [1, {MCP_PAGE_LIMIT_CAP}]; got {l}"
        )));
    }
    let req = PageRequest::new(cursor, limit)?;
    // Reject any cursor whose sort-mode discriminator doesn't match the
    // requested sort. This is the BLOCKER fix from Review Round 1.
    if let Some(c) = req.after.as_ref() {
        validate_pages_metadata_cursor(c, filter.sort)?;
    }
    let limit_plus_one = req.limit + 1; // probe-for-more pattern

    // SELECT shape — the two count aggregates (inbound_link_count,
    // child_block_count) are now reads from the materialised
    // `pages_cache` columns (PEND-56b). The remaining metadata
    // aggregates stay as correlated subqueries — out of scope for this
    // refactor:
    //   - last_modified_at via `idx_op_log_block_id` (migration 0030)
    //   - has_property_flags: 4 EXISTS short-circuits over the
    //     `idx_blocks_page_id` + `idx_block_tags_block_id` indexes.
    //
    // The SQL is hand-written rather than `sqlx::query_as!` because
    // the ORDER BY / WHERE keyset depends on the runtime sort mode;
    // the compile-time macro would force four near-identical query
    // bodies.
    let mut sql = String::from(PAGES_METADATA_BASE_SELECT);

    // PEND-58 — splice the compound-filter WHERE clauses BEFORE the
    // keyset/ORDER BY/LIMIT. Their `?` placeholders land at positions
    // `?2 .. ?{1 + filter_bind_count}` (right after `?1 = space_id`); the
    // keyset then numbers its own placeholders from `base` so SQLite's
    // positional binding stays aligned. Gate + cost-order + AND-join all
    // happen in `compile_pages_filters`.
    let (filter_sql, filter_binds) = compile_pages_filters(&filter.filters)?;
    sql.push_str(&filter_sql);
    let base = 1 + filter_binds.len();

    // PEND-58b P1-D — compute a real `total_count` so the "X of Y"
    // header chip survives the `densityV1` default-on flip (the prior
    // `total_count: None` silently dropped it for every user). The COUNT
    // reuses the SAME space-membership predicate + compiled compound-filter
    // WHERE clause as the fetch, but DROPS the keyset/cursor terms and the
    // per-row metadata aggregate subqueries (last_modified_at, has_*) — so
    // the count stays index-served and behind the same predicates, keeping
    // the 20k-page perf gate (`most_linked_perf_gate_20k_pages`) green.
    // The `LEFT JOIN pages_cache pc` is retained because the Pages-only
    // filter fragments (Orphan / Stub / HasNoInboundLinks) read `pc.*`.
    //
    // PEND-58d D6 — the COUNT only runs on the FIRST page (`req.after`
    // is None). The total of the filtered set does not change as the user
    // loads more pages with the same filters, so recomputing it on every
    // cursor page is wasted work (the COUNT scans the whole filtered set
    // each time). Subsequent (cursor) pages return `total_count = None`;
    // the frontend retains the first page's total.
    let total_count: Option<i64> = if req.after.is_none() {
        let count_sql = format!(
            "SELECT COUNT(*) FROM blocks b \
             LEFT JOIN pages_cache pc ON pc.page_id = b.id \
             WHERE b.block_type = 'page' \
               AND b.deleted_at IS NULL \
               AND b.space_id = ?1{filter_sql}"
        );
        let mut count_query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql.as_str()))
            .bind(&filter.space_id);
        for bind in filter_binds.clone() {
            count_query = bind.bind_to_scalar(count_query);
        }
        Some(count_query.fetch_one(pool).await?)
    } else {
        None
    };

    // Per-sort keyset + ORDER BY. The `SortKeyset` descriptor encodes
    // the SQL fragment, ORDER BY, and the per-mode bind list so the
    // composition stays in one place rather than the 5 inline arms
    // the prior implementation duplicated.
    let keyset = keyset_for(filter.sort);
    let cursor_ref = req.after.as_ref();
    let keyset_binds = keyset.apply(&mut sql, cursor_ref, limit_plus_one, base);

    // Bind order: ?1 = space_id, then the filter binds (?2 ..), then the
    // keyset binds (?{base+1} ..) — exactly matching the `?` appearance
    // order in the composed SQL.
    let mut query = sqlx::query_as::<_, PageWithMetadataRow>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(&filter.space_id);
    for bind in filter_binds {
        query = bind.bind_to(query);
    }
    for bind in keyset_binds {
        query = bind.bind_to(query);
    }
    let rows = query.fetch_all(pool).await?;
    build_metadata_response(rows, req.limit, filter.sort, total_count)
}

/// Pack the fetched rows into a `PageResponse` with `has_more` + the
/// next-page cursor. Encodes the last-row's sort-key value into the
/// appropriate `Cursor` slot per sort mode.
fn build_metadata_response(
    mut rows: Vec<PageWithMetadataRow>,
    limit: i64,
    sort: PageSort,
    total_count: Option<i64>,
) -> Result<PageResponse<PageWithMetadataRow>, AppError> {
    let limit_us = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > limit_us;
    if has_more {
        rows.truncate(limit_us);
    }
    // Tag every cursor with the sort discriminator (Review Round 1) so
    // `validate_pages_metadata_cursor` can reject cross-sort reuse.
    let disc = Some(sort_discriminator(sort));
    let next_cursor = if has_more {
        rows.last().map(|last| -> Result<String, AppError> {
            let cursor = match sort {
                PageSort::Alphabetical => Cursor {
                    id: last.id.clone().into_string(),
                    position: disc,
                    deleted_at: last.content.clone(),
                    seq: None,
                    rank: None,
                },
                PageSort::RecentlyModified => Cursor {
                    id: last.id.clone().into_string(),
                    position: disc,
                    // RecentlyModified always stashes the COALESCE'd
                    // value (real epoch-ms OR `LAST_MOD_NULL_SENTINEL`)
                    // so the keyset works uniformly for NULL and
                    // non-NULL rows — Review Round 1 HIGH #2 fix. #109
                    // Phase 2: the value is INTEGER epoch-ms, serialised
                    // to the opaque `deleted_at` cursor slot as a decimal
                    // string and parsed back to i64 in the keyset.
                    deleted_at: Some(
                        last.last_modified_at
                            .unwrap_or(LAST_MOD_NULL_SENTINEL)
                            .to_string(),
                    ),
                    seq: None,
                    rank: None,
                },
                PageSort::MostLinked => Cursor {
                    id: last.id.clone().into_string(),
                    position: disc,
                    deleted_at: None,
                    seq: Some(last.inbound_link_count),
                    rank: None,
                },
                PageSort::MostContent => Cursor {
                    id: last.id.clone().into_string(),
                    position: disc,
                    deleted_at: None,
                    seq: Some(last.child_block_count),
                    rank: None,
                },
                PageSort::Default => Cursor {
                    id: last.id.clone().into_string(),
                    position: disc,
                    deleted_at: None,
                    seq: None,
                    rank: None,
                },
            };
            cursor.encode()
        })
    } else {
        None
    }
    .transpose()?;
    Ok(PageResponse {
        items: rows,
        next_cursor,
        has_more,
        // PEND-58b P1-D / PEND-58d D6 — the COUNT over the same space +
        // compiled filter predicates (computed in
        // `list_pages_with_metadata_inner`) so the FE "X of Y" header chip
        // renders on the metadata path. `Some(n)` on the first page;
        // `None` on cursor (load-more) pages, where the COUNT is gated off
        // and the FE retains the first page's total.
        total_count,
    })
}

/// Tauri command: paginated page list with per-page metadata columns
/// (last-modified timestamp, inbound link count, descendant count,
/// has-property bitmask) and a richer sort taxonomy than `list_pages`.
///
/// Frontend wires this from `PageBrowser` when the `densityV1` flag is
/// on; the flag-off path continues to use `list_blocks(blockType='page')`.
#[tauri::command]
#[specta::specta]
pub async fn list_pages_with_metadata(
    pool: State<'_, ReadPool>,
    filter: ListPagesWithMetadataFilter,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PageWithMetadataRow>, AppError> {
    list_pages_with_metadata_inner(&pool.0, filter, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}
