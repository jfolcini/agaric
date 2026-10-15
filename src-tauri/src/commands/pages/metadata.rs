//! Pages-view metadata listing command handlers (#644 split).
//!
//! `list_pages_with_metadata` and its `*_inner` core,
//! the per-sort keyset descriptors, the compound-filter compiler, and the
//! cursor/sort helpers.

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::ReadPool;
use agaric_core::error::AppError;
use agaric_core::error::ValidationCode;
use agaric_core::ulid::{BlockId, PageId};
use agaric_store::filters::{FilterPrimitive, PagesProjection, Projection, WhereClause};
use agaric_store::pagination::{Cursor, PageRequest, PageResponse};

use super::super::*;

// ───────────────────────────────────────────────────────────────────────────
// List_pages_with_metadata
//
// Returns the same column shape as `BlockRow` PLUS four metadata columns:
//
//   - `last_modified_at`: `pages_cache.last_edited_ms`, the newest op on the
//     page or any block on it, else its ULID creation time (#5371).
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
// (the title key) or `seq` (i64 timestamps and counts), with `id` as the
// tiebreaker. No new field on the `Cursor` struct.
//
// Sort modes (#5371: every one orders the whole space; nothing re-sorts in JS):
//   - Alphabetical: keyset (`pc.title_sort_key`, id) ASC
//   - Created: keyset (id) DESC
//   - RecentlyModified: keyset (`pc.last_edited_ms` DESC, id ASC)
//   - LastOpened: keyset (`po.opened_ms` DESC, id DESC); never opened last
//   - MostLinked: keyset (`inbound_link_count` DESC, id ASC)
//   - MostContent: keyset (`child_block_count` DESC, id ASC)
// ───────────────────────────────────────────────────────────────────────────

/// Sort mode for [`list_pages_with_metadata_inner`]. Every mode orders all
/// pages in the space behind a keyset cursor.
#[derive(Debug, Clone, Copy, Default, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PageSort {
    /// Title ascending, accent- and case-insensitive (`pages_cache.title_sort_key`).
    #[default]
    Alphabetical,
    /// Newest page first (block id DESC).
    Created,
    /// Last edit to the page or any block on it, newest first.
    RecentlyModified,
    /// Last opened on this device, newest first; pages never opened here
    /// follow, newest page first.
    LastOpened,
    /// Inbound-link count DESC (page + descendant link targets).
    MostLinked,
    /// Descendant-block count DESC.
    MostContent,
}

/// Filter / sort bundle for [`list_pages_with_metadata`].
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListPagesWithMetadataFilter {
    #[serde(default)]
    pub sort: PageSort,
    pub space_id: String,
    /// Phase 3 — compound filter primitives applied server-side,
    /// AND-joined into the WHERE before the keyset/ORDER BY/LIMIT. Empty
    /// (the default) preserves the pre- "no filter" behaviour, so
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
    /// Epoch-ms of the newest op on the page or any block on it, else the
    /// page's ULID creation time; kept when compaction prunes the ops
    /// (#5286). None only while the page has no `pages_cache` row.
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

impl From<PageWithMetadataRow> for agaric_store::pagination::BlockRow {
    /// The page's plain block row, without the metadata columns.
    fn from(row: PageWithMetadataRow) -> Self {
        Self {
            id: row.id,
            block_type: row.block_type,
            content: row.content,
            parent_id: row.parent_id,
            position: row.position,
            deleted_at: row.deleted_at,
            todo_state: row.todo_state,
            priority: row.priority,
            due_date: row.due_date,
            scheduled_date: row.scheduled_date,
            page_id: row.page_id.map(BlockId::from),
        }
    }
}

/// Build the `position` slot's encoded sort-mode tag. Stamped into every
/// outgoing cursor and read back by `validate_pages_metadata_cursor`
/// to refuse a cursor whose sort-mode discriminator doesn't match the
/// request — the user-visible alternative is a silent "scrolled past
/// end" with no recovery, which Review Round 1 flagged across three
/// independent reviewers as a BLOCKER. Per-sort i64 stamped into the
/// already-unused `Cursor.position` slot.
pub fn sort_discriminator(sort: PageSort) -> i64 {
    // 5 was the retired `Default`; a cursor carrying it must never match.
    match sort {
        PageSort::Alphabetical => 1,
        PageSort::RecentlyModified => 2,
        PageSort::MostLinked => 3,
        PageSort::MostContent => 4,
        PageSort::Created => 6,
        PageSort::LastOpened => 7,
    }
}

/// Reject a cursor whose `position` slot doesn't match the requested
/// sort. Returns `AppError::Validation` with the structured
/// `ValidationCode::RequiresRefresh` code the frontend uses to retry once
/// without a cursor (acceptance criterion #3).
fn validate_pages_metadata_cursor(cursor: &Cursor, sort: PageSort) -> Result<(), AppError> {
    match cursor.position {
        Some(d) if d == sort_discriminator(sort) => Ok(()),
        Some(_) | None => Err(AppError::validation_coded(
            ValidationCode::RequiresRefresh,
            format!("cursor sort mismatch (expected {sort:?})"),
        )),
    }
}

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
    /// `total_count` COUNT query (D) reuses the same compiled
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
/// `list_pages_with_metadata_inner`: each arm of `keyset_for` is one of
/// these variants and the IPC consumes the descriptor via a single shared
/// `compose` method.
///
/// **Bind contract:** `?1 = filter.space_id` always. splices
/// compound-filter clauses (with their own `?` binds) into the WHERE
/// between space_id and the keyset; `SortKeyset::compose` therefore numbers
/// its placeholders from a runtime `base` offset (`1 + filter_bind_count`)
/// rather than the hardcoded `?2`. With no filters, `base = 1` reproduces
/// the original `?2 .. ?N` numbering.
///
/// Every sort reads its rows in order from an index (migration 0124): each
/// `key_expr` is the bare `pages_cache` column a `(space_id, key, page_id)`
/// index holds, in the sort's own direction.
enum SortKeyset {
    /// `(key_expr, id) ASC` keyset. Cursor stashes the last row's key
    /// in the `deleted_at` slot (string). Used by `Alphabetical`.
    StringAsc {
        /// SQL expression for the sort key, composed verbatim into the
        /// keyset predicate and ORDER BY.
        key_expr: &'static str,
    },
    /// `key_expr DESC, id ASC` over an i64 column. Cursor stashes the last
    /// row's key in the `seq` slot.
    I64Desc { key_expr: &'static str },
    /// `pc.page_id DESC` only. No extra sort-key slot. Used by `Created`.
    IdDesc,
    /// `opened_ms DESC, id DESC`, with a page never opened here at `-1`
    /// (see [`compose_last_opened_sql`]). Cursor stashes the key in `seq`.
    LastOpened,
}

/// Map a [`PageSort`] to its [`SortKeyset`] descriptor.
fn keyset_for(sort: PageSort) -> SortKeyset {
    match sort {
        PageSort::Alphabetical => SortKeyset::StringAsc {
            key_expr: "pc.title_sort_key",
        },
        PageSort::Created => SortKeyset::IdDesc,
        PageSort::RecentlyModified => SortKeyset::I64Desc {
            key_expr: "pc.last_edited_ms",
        },
        PageSort::LastOpened => SortKeyset::LastOpened,
        // Read from the materialised `pages_cache` column
        // instead of the per-row `COUNT(DISTINCT bl.source_id) FROM
        // block_links` correlated subquery. The materializer keeps
        // `pc.inbound_link_count` byte-identical to the canonical
        // SELECT on every block-lifecycle op; see
        // `pages_cache_count_parity` for the guarding test.
        PageSort::MostLinked => SortKeyset::I64Desc {
            key_expr: "pc.inbound_link_count",
        },
        // See above; reads `pc.child_block_count`.
        PageSort::MostContent => SortKeyset::I64Desc {
            key_expr: "pc.child_block_count",
        },
    }
}

impl SortKeyset {
    /// The fetch statement: the base SELECT, the compiled compound-filter
    /// fragment `filter_sql`, then the keyset predicate + ORDER BY + LIMIT;
    /// and the keyset binds in order.
    ///
    /// `cursor` is the decoded keyset position from the prior page (None
    /// for first-page requests). `limit_plus_one` is the LIMIT bind value
    /// (probe-for-more pattern).
    ///
    /// **`base` bind offset:** Phase 3 splices compound-filter clauses (each
    /// with its own `?` binds) into the WHERE *between* the space_id bind
    /// and the keyset. `base` is the highest placeholder position already
    /// consumed (`1` for space_id plus the filter-bind count); the keyset
    /// numbers its own placeholders from `base + 1` so SQLite's positional
    /// binding stays aligned regardless of how many filter binds preceded it.
    fn compose<'a>(
        self,
        filter_sql: &str,
        cursor: Option<&'a Cursor>,
        limit_plus_one: i64,
        base: usize,
    ) -> (String, Vec<SqlBind<'a>>) {
        let mut sql = format!("{PAGES_METADATA_COLUMNS}{PAGES_METADATA_FROM}{filter_sql}");
        let binds = match self {
            SortKeyset::StringAsc { key_expr } => {
                push_string_asc_keyset(&mut sql, key_expr, cursor, limit_plus_one, base)
            }
            SortKeyset::I64Desc { key_expr } => {
                push_i64_desc_keyset(&mut sql, key_expr, cursor, limit_plus_one, base)
            }
            SortKeyset::IdDesc => push_id_desc_keyset(&mut sql, cursor, limit_plus_one, base),
            SortKeyset::LastOpened => {
                return compose_last_opened_sql(sql, filter_sql, cursor, limit_plus_one, base);
            }
        };
        (sql, binds)
    }
}

/// `(key_expr, id) ASC` keyset for [`SortKeyset::StringAsc`]: appends the
/// predicate, ORDER BY and LIMIT to `sql` and returns the binds in
/// placeholder order. Placeholders are numbered from `base + 1` (see
/// [`SortKeyset::compose`] for the offset contract). The row-value comparison
/// is what lets the cursor page seek into the index rather than scan to it.
fn push_string_asc_keyset<'a>(
    sql: &mut String,
    key_expr: &str,
    cursor: Option<&'a Cursor>,
    limit_plus_one: i64,
    base: usize,
) -> Vec<SqlBind<'a>> {
    let (p1, p2, p3) = (base + 1, base + 2, base + 3);
    let mut binds: Vec<SqlBind<'a>> = Vec::new();
    if let Some(c) = cursor {
        let last_key = c.deleted_at.clone().unwrap_or_default();
        // Binds: last_key, last_id, limit.
        sql.push_str(&format!(
            " AND ({key_expr}, pc.page_id) > (?{p1}, ?{p2}) \
              ORDER BY {key_expr} ASC, pc.page_id ASC LIMIT ?{p3}"
        ));
        binds.push(SqlBind::OwnedStr(last_key));
        binds.push(SqlBind::Str(c.id.as_str()));
        binds.push(SqlBind::I64(limit_plus_one));
    } else {
        // Binds: limit.
        sql.push_str(&format!(
            " ORDER BY {key_expr} ASC, pc.page_id ASC LIMIT ?{p1}"
        ));
        binds.push(SqlBind::I64(limit_plus_one));
    }
    binds
}

/// `key_expr DESC, id ASC` keyset over an i64 column, for
/// [`SortKeyset::I64Desc`]. The cursor carries the last row's key in its
/// `seq` slot. The key and the id run in opposite directions, so no row value
/// spans both; the leading `key_expr <= last_key` is the term the index seeks
/// on, so a cursor page also steps over the pages that share `last_key` and
/// sort before the cursor's id.
fn push_i64_desc_keyset<'a>(
    sql: &mut String,
    key_expr: &str,
    cursor: Option<&'a Cursor>,
    limit_plus_one: i64,
    base: usize,
) -> Vec<SqlBind<'a>> {
    let (p1, p2, p3) = (base + 1, base + 2, base + 3);
    let mut binds: Vec<SqlBind<'a>> = Vec::new();
    if let Some(c) = cursor {
        let last_key = c.seq.unwrap_or(0);
        // Binds: last_key, last_id, limit.
        sql.push_str(&format!(
            " AND {key_expr} <= ?{p1} \
              AND ({key_expr} < ?{p1} OR pc.page_id > ?{p2}) \
              ORDER BY {key_expr} DESC, pc.page_id ASC LIMIT ?{p3}"
        ));
        binds.push(SqlBind::I64(last_key));
        binds.push(SqlBind::Str(c.id.as_str()));
        binds.push(SqlBind::I64(limit_plus_one));
    } else {
        // Binds: limit.
        sql.push_str(&format!(
            " ORDER BY {key_expr} DESC, pc.page_id ASC LIMIT ?{p1}"
        ));
        binds.push(SqlBind::I64(limit_plus_one));
    }
    binds
}

/// `pc.page_id DESC` keyset for [`SortKeyset::IdDesc`] (the `Created` sort):
/// no sort-key slot, just the id.
fn push_id_desc_keyset<'a>(
    sql: &mut String,
    cursor: Option<&'a Cursor>,
    limit_plus_one: i64,
    base: usize,
) -> Vec<SqlBind<'a>> {
    let (p1, p2) = (base + 1, base + 2);
    let mut binds: Vec<SqlBind<'a>> = Vec::new();
    if let Some(c) = cursor {
        // Binds: last_id, limit.
        sql.push_str(&format!(
            " AND pc.page_id < ?{p1} ORDER BY pc.page_id DESC LIMIT ?{p2}"
        ));
        binds.push(SqlBind::Str(c.id.as_str()));
        binds.push(SqlBind::I64(limit_plus_one));
    } else {
        // Binds: limit.
        sql.push_str(&format!(" ORDER BY pc.page_id DESC LIMIT ?{p1}"));
        binds.push(SqlBind::I64(limit_plus_one));
    }
    binds
}

/// [`SortKeyset::LastOpened`] from two indexes instead of a sort of the
/// space: the pages opened here, newest open first (`idx_page_opens_opened`),
/// then the pages never opened here, newest first
/// (`idx_pages_cache_space_created`). Every open sorts above every
/// never-opened page, so a cursor in that tail (`seq` is `-1`) reads its arm
/// alone; otherwise the outer ORDER BY merges two `LIMIT`s of rows. The
/// opened arm walks every space's opens, as `page_opens` has no space.
///
/// `never_opened` is the base SELECT with `filter_sql` already appended.
fn compose_last_opened_sql<'a>(
    mut never_opened: String,
    filter_sql: &str,
    cursor: Option<&'a Cursor>,
    limit_plus_one: i64,
    base: usize,
) -> (String, Vec<SqlBind<'a>>) {
    let (p1, p2, p3) = (base + 1, base + 2, base + 3);
    never_opened.push_str(" AND po.page_id IS NULL");
    if let Some(c) = cursor.filter(|c| c.seq.unwrap_or(0) < 0) {
        // Binds: last_id, limit.
        never_opened.push_str(&format!(
            " AND pc.page_id < ?{p1} ORDER BY pc.page_id DESC LIMIT ?{p2}"
        ));
        return (
            never_opened,
            vec![SqlBind::Str(c.id.as_str()), SqlBind::I64(limit_plus_one)],
        );
    }
    let mut opened = format!("{PAGES_METADATA_COLUMNS}{PAGES_METADATA_FROM_OPENS}{filter_sql}");
    let mut binds: Vec<SqlBind<'a>> = Vec::new();
    let limit = if let Some(c) = cursor {
        // Binds: last_key, last_id, limit.
        opened.push_str(&format!(" AND (po.opened_ms, po.page_id) < (?{p1}, ?{p2})"));
        binds.push(SqlBind::I64(c.seq.unwrap_or(0)));
        binds.push(SqlBind::Str(c.id.as_str()));
        p3
    } else {
        p1
    };
    binds.push(SqlBind::I64(limit_plus_one));
    let sql = format!(
        "SELECT * FROM ({opened} ORDER BY po.opened_ms DESC, po.page_id DESC LIMIT ?{limit}) \
         UNION ALL SELECT * FROM ({never_opened} ORDER BY pc.page_id DESC LIMIT ?{limit}) \
         ORDER BY opened_ms DESC, id DESC LIMIT ?{limit}"
    );
    (sql, binds)
}

/// Phase 3 — compile the compound-filter primitives for the Pages
/// surface into a single AND-joined SQL fragment plus its ordered binds.
///
/// Returns `(sql_fragment, binds)` where `sql_fragment` is either empty
/// (no filters) or a leading-` AND (...)`-style string ready to splice
/// after the base WHERE and `binds` are the bind values in the SAME
/// left-to-right order their `?` placeholders appear in the fragment.
///
/// Steps:
///
/// 1. **Allowed-keys gate** — reject any primitive whose token is not in
///    [`PagesProjection::allowed_keys`] with [`AppError::Validation`]
///    (`ValidationCode::InvalidFilter`). Defence-in-depth: the frontend never
///    sends Search-only primitives, but the backend must not trust that.
/// 2. **Date validation** — `LastEdited::Range` bounds are
///    validated against the legacy Search date contract (`InvalidDateFilter`
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

    validate_pages_filters(filters)?;

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
        let wc = if let FilterPrimitive::PathGlob { pattern, exclude } = prim {
            match compile_path_glob_clause(&proj, std::slice::from_ref(pattern), *exclude)? {
                Some(wc) => wc,
                // Whitespace-only / fully-stripped pattern → no rows to
                // constrain; emit NO clause for this primitive (skip).
                None => continue,
            }
        } else {
            proj.compile(prim)
        };
        // The allowed-keys gate above admits only Pages-surface tokens, but
        // a primitive could still compile to `unsupported()` via the
        // cross-surface default trait methods if a future variant lands on
        // The wrong surface (after + D26, `HasProperty` itself
        // never returns `unsupported()` — every predicate × value combo
        // compiles, and invalid combos are unrepresentable). In release
        // builds a bare `debug_assert!` would be compiled out and the
        // splice would emit a silent `1=0`, returning zero rows for what is
        // really an invalid filter shape. Reject it loudly in **all** build
        // Profiles instead (A). `is_unsupported()` reads the
        // Explicit boolean flag on `WhereClause`, not a SQL
        // substring.
        if wc.is_unsupported() {
            return Err(AppError::validation_coded(
                ValidationCode::InvalidFilter,
                format!("filter shape is not supported on the Pages surface: {prim:?}"),
            ));
        }
        // Compose the fragment via a structured `SqlFragment` (#2255): its bare
        // `?` placeholders are numbered `?{next_pos}` in a single arithmetic
        // pass and a `?`/bind-count drift is a release-active hard error,
        // replacing the former char-by-char scan.
        let fragment = agaric_store::filters::SqlFragment::from_where_clause(wc);
        let sql = fragment.render(&mut next_pos);
        clauses.push(format!("({sql})"));
        for b in fragment.into_binds() {
            binds.push(match b {
                agaric_store::filters::primitive::Bind::Text(s) => SqlBind::OwnedStr(s),
                agaric_store::filters::primitive::Bind::Int(i) => SqlBind::I64(i),
                agaric_store::filters::primitive::Bind::Real(f) => SqlBind::F64(f),
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

/// Steps 1-2 of [`compile_pages_filters`] — everything that rejects a
/// primitive before anything compiles. The allowed-keys gate is
/// defence-in-depth against a non-Pages token arriving on the wire; the
/// `LastEdited::Range` bounds are checked here because the compiler panics on
/// a malformed bound (#383).
fn validate_pages_filters(filters: &[FilterPrimitive]) -> Result<(), AppError> {
    let allowed = PagesProjection::allowed_keys();
    for prim in filters {
        let key = prim.allowed_key();
        if !allowed.contains(key) {
            return Err(AppError::validation_coded(
                ValidationCode::InvalidFilter,
                format!("`{key}` is not a valid filter on the Pages surface"),
            ));
        }
    }
    for prim in filters {
        if let FilterPrimitive::LastEdited { spec } = prim {
            spec.validate()?;
        }
    }
    Ok(())
}

/// Compile ONE `PathGlob` primitive into a single multi-`?` fragment.
///
/// #1320-A — `PathGlob` no longer compiles via `proj.compile`: the
/// Pages surface now uses the SAME `LOWER(title) GLOB ?` dialect as
/// Search (`GLOB` + brace + `[class]`), so the raw user pattern must
/// first be run through `prepare_globs` (brace-expanded,
/// substring-wrapped, ASCII-lowercased — the SAME preprocessing the
/// Search path does upstream). One raw pattern can expand into MANY
/// prepared patterns (`{a,b}/*` → two), so we build ONE fragment that
/// OR-joins (include) / AND-joins (exclude) a per-pattern
/// `PagesProjection::compile_path_glob` sub-select. The SELECT body is
/// single-sourced through that method so the two surfaces stay in
/// lockstep on the GLOB; Pages differs by the `b.id` alias and its
/// title-range narrowing (#5426).
///
/// `None` means the raw pattern reduced to zero prepared globs
/// (whitespace-only / fully stripped), so it constrains no rows and
/// contributes no clause.
fn compile_path_glob_clause(
    proj: &PagesProjection,
    raw_patterns: &[String],
    exclude: bool,
) -> Result<Option<WhereClause>, AppError> {
    let prepared = agaric_store::fts::glob_filter::prepare_globs(raw_patterns)?;
    if prepared.is_empty() {
        return Ok(None);
    }
    // Join op between per-pattern fragments: include = OR (set
    // union — a page matches if its title matches ANY pattern);
    // exclude = AND (set difference — the page must fall outside
    // EVERY per-pattern set, i.e. match NONE).
    let joiner = if exclude { " AND " } else { " OR " };
    let mut frag = String::new();
    let mut frag_binds: Vec<agaric_store::filters::primitive::Bind> = Vec::new();
    frag.push('(');
    for (i, pat) in prepared.iter().enumerate() {
        if i > 0 {
            frag.push_str(joiner);
        }
        let inner = proj.compile_path_glob(
            pat,
            exclude,
            agaric_store::filters::primitive::DEFAULT_ROW_ALIAS,
        );
        frag.push_str(&inner.sql);
        frag_binds.extend(inner.binds);
    }
    frag.push(')');
    Ok(Some(WhereClause::new(frag, frag_binds)))
}

/// The SELECT list for `list_pages_with_metadata_inner`. With
/// [`PAGES_METADATA_FROM`] it is the base statement every sort composes
/// onto (then the compound-filter fragment, the keyset, the ORDER BY and the
/// LIMIT); consts so the test-only [`compose_list_pages_with_metadata_sql`]
/// accessor composes the SAME real SQL the IPC emits rather than a
/// hand-rebuilt copy — a plan regression in the IPC's actual query is then
/// caught by the EXPLAIN tests.
///
/// `title_sort_key` and `opened_ms` are the Alphabetical and LastOpened
/// keys, read back only to mint the next cursor ([`KeyedPageRow`]).
const PAGES_METADATA_COLUMNS: &str = r"SELECT
               b.id, b.block_type, b.content, b.parent_id, b.position,
               b.deleted_at, b.todo_state, b.priority, b.due_date,
               b.scheduled_date, b.page_id,
               pc.last_edited_ms AS last_modified_at,
               pc.inbound_link_count,
               pc.child_block_count,
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
                         AND descendant.due_date IS NOT NULL) AS has_due,
               pc.title_sort_key,
               COALESCE(po.opened_ms, -1) AS opened_ms";

/// The rows a Pages request reads. `?1` is the space_id bind; the
/// compound-filter fragment (its `?` binds renumbered from `?2`) is appended
/// after this, then the keyset / ORDER BY / LIMIT.
///
/// # One index range per sort (#5371, migration 0124)
///
/// The query drives from `pages_cache`, which carries its page's `space_id`,
/// and each sort orders by an index whose prefix is `space_id`. So the plan
/// reads the space's rows in the requested order and stops after `LIMIT`:
/// the `blocks` row and the four `has_*` EXISTS probes run for those rows
/// only, and a cursor page seeks into the index at its key. `CROSS JOIN`
/// pins `pages_cache` as the outer loop: with `blocks` free to go first the
/// planner drives from every live page in the vault.
///
/// The join to `blocks` is inner: a page lists only once its cache row
/// exists, and `b.deleted_at` hides a page the rebuild has not yet swept.
/// Why the count columns stay materialised: the KEEP rationale on
/// `cache::pages::recompute_all_pages_cache_counts`.
const PAGES_METADATA_FROM: &str = r"
           FROM pages_cache pc
           CROSS JOIN blocks b ON b.id = pc.page_id
           LEFT JOIN page_opens po ON po.page_id = pc.page_id
           WHERE pc.space_id = ?1
             AND b.block_type = 'page'
             AND b.deleted_at IS NULL";

/// [`PAGES_METADATA_FROM`] for the opened arm of
/// [`compose_last_opened_sql`]: driven from `page_opens` in open order.
const PAGES_METADATA_FROM_OPENS: &str = r"
           FROM page_opens po
           CROSS JOIN pages_cache pc ON pc.page_id = po.page_id
           CROSS JOIN blocks b ON b.id = pc.page_id
           WHERE pc.space_id = ?1
             AND b.block_type = 'page'
             AND b.deleted_at IS NULL";

/// A fetched page row plus the two sort keys the wire row does not carry,
/// so the next cursor holds exactly the key the keyset compared.
#[derive(sqlx::FromRow)]
struct KeyedPageRow {
    #[sqlx(flatten)]
    row: PageWithMetadataRow,
    title_sort_key: String,
    opened_ms: i64,
}

/// Test-only accessor that composes the **real** first-page
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
// #4499 phase 0d: its only caller, `list_pages_with_metadata_tests`, is now an
// integration-test binary, which links this crate without `cfg(test)`.
#[cfg(any(test, feature = "test-util"))]
pub fn compose_list_pages_with_metadata_sql(
    filter: &ListPagesWithMetadataFilter,
    limit_plus_one: i64,
) -> Result<String, AppError> {
    let (filter_sql, filter_binds) = compile_pages_filters(&filter.filters)?;
    let base = 1 + filter_binds.len();
    // First page: no cursor. The returned binds are discarded — the test
    // only needs the SQL string for EXPLAIN QUERY PLAN.
    let (sql, _) = keyset_for(filter.sort).compose(&filter_sql, None, limit_plus_one, base);
    Ok(sql)
}

/// Inner implementation of `list_pages_with_metadata`. Cursor-paginated
/// page enumeration with metadata columns; sort mode chosen via
/// [`PageSort`].
///
/// **Cursor semantics:** the cursor carries the LAST row's sort-key
/// value (in `deleted_at` for the string sort; in `seq` for the i64
/// sorts), the last row's `id` as the tiebreaker, and
/// a sort-mode discriminator in `position` (Review Round 1 — protects
/// against cross-sort / cross-IPC cursor reuse). First-page requests
/// pass `cursor = None`. A stale cursor (e.g. from `list_blocks`) is
/// rejected with a `ValidationCode::RequiresRefresh` validation error so the
/// frontend can render a "Sort changed — refresh to continue" toast
/// (acceptance criterion #3).
///
/// **materialised keys (#5371):** `title_sort_key` and `last_edited_ms`
/// are read from `pages_cache` the same way, and `opened_ms` from the
/// device-local `page_opens`.
///
/// **materialised counts:** `inbound_link_count` and
/// `child_block_count` are read from `pages_cache.{inbound_link_count,
/// child_block_count}`, NOT computed per-row via the
/// `COUNT(DISTINCT …) FROM block_links` / `COUNT(*) FROM blocks`
/// correlated subqueries the prior implementation used. The
/// materializer keeps `pages_cache` rows byte-identical to the
/// canonical SELECT on every CreateBlock / EditBlock / DeleteBlock /
/// RestoreBlock / PurgeBlock op; see `materializer::tests::
/// pages_cache_count_parity` for the guarding integration test.
///
/// **Rows come from `pages_cache`:** a page is listed in the space its cache
/// row names. The page-create INSERT births the row, a `space` op moves it,
/// and a restore gives a restored page its row back, each in the writing
/// transaction; a page whose row is missing (between a reset wiping the
/// cache and its rebuild) is absent until `RebuildPagesCache` lands, and the
/// reconciliation oracle reports it (`pages_cache.row`).
#[instrument(skip(pool), err)]
pub async fn list_pages_with_metadata_inner(
    pool: &SqlitePool,
    filter: ListPagesWithMetadataFilter,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PageWithMetadataRow>, AppError> {
    // Rejected, not clamped (AGENTS.md invariant 10).
    if let Some(l) = limit
        && !(1..=MCP_PAGE_LIMIT_CAP).contains(&l)
    {
        return Err(AppError::validation(format!(
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

    // SELECT shape — every sort key and count is a read from `pages_cache`
    // or `page_opens`. The `has_*` flags stay 4 EXISTS short-circuits over
    // the `idx_blocks_page_id` + `idx_block_tags_block_id` indexes.
    //
    // The SQL is hand-written rather than `sqlx::query_as!` because
    // the ORDER BY / WHERE keyset depends on the runtime sort mode;
    // the compile-time macro would force six near-identical query
    // bodies.
    //
    // Splice the compound-filter WHERE clauses BEFORE the
    // keyset/ORDER BY/LIMIT. Their `?` placeholders land at positions
    // `?2 .. ?{1 + filter_bind_count}` (right after `?1 = space_id`); the
    // keyset then numbers its own placeholders from `base` so SQLite's
    // positional binding stays aligned. Gate + cost-order + AND-join all
    // happen in `compile_pages_filters`.
    let (filter_sql, filter_binds) = compile_pages_filters(&filter.filters)?;
    let base = 1 + filter_binds.len();

    // -D — compute a real `total_count` so the "X of Y"
    // header chip survives the `densityV1` default-on flip (the prior
    // `total_count: None` silently dropped it for every user). The COUNT
    // reuses the SAME space-membership predicate + compiled compound-filter
    // WHERE clause as the fetch, but DROPS the keyset/cursor terms, the
    // `page_opens` join and the per-row metadata subqueries (has_*) — so
    // the count stays index-served and behind the same predicates, keeping
    // the 20k-page perf gate (`most_linked_perf_gate_20k_pages`) green. It
    // counts the rows the fetch can return: `pages_cache` rows of the space
    // whose page is live.
    //
    // The COUNT only runs on the FIRST page (`req.after`
    // is None). The total of the filtered set does not change as the user
    // loads more pages with the same filters, so recomputing it on every
    // cursor page is wasted work (the COUNT scans the whole filtered set
    // each time). Subsequent (cursor) pages return `total_count = None`;
    // the frontend retains the first page's total.
    let total_count: Option<i64> = if req.after.is_none() {
        let count_sql = format!(
            "SELECT COUNT(*) FROM pages_cache pc \
             CROSS JOIN blocks b ON b.id = pc.page_id \
             WHERE pc.space_id = ?1 \
               AND b.block_type = 'page' \
               AND b.deleted_at IS NULL{filter_sql}"
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
    // composition stays in one place.
    let (sql, keyset_binds) =
        keyset_for(filter.sort).compose(&filter_sql, req.after.as_ref(), limit_plus_one, base);

    // Bind order: ?1 = space_id, then the filter binds (?2 ..), then the
    // keyset binds (?{base+1} ..) — the `?N` numbers in the composed SQL.
    let mut query =
        sqlx::query_as::<_, KeyedPageRow>(sqlx::AssertSqlSafe(sql.as_str())).bind(&filter.space_id);
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
    mut rows: Vec<KeyedPageRow>,
    limit: i64,
    sort: PageSort,
    total_count: Option<i64>,
) -> Result<PageResponse<PageWithMetadataRow>, AppError> {
    let limit_us = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > limit_us;
    if has_more {
        rows.truncate(limit_us);
    }
    let next_cursor = match rows.last() {
        Some(last) if has_more => {
            // The key the keyset compared: a string in `deleted_at`, an i64
            // in `seq`, nothing for the id-only sort.
            let (deleted_at, seq) = match sort {
                PageSort::Alphabetical => (Some(last.title_sort_key.clone()), None),
                PageSort::Created => (None, None),
                PageSort::RecentlyModified => (None, Some(last.row.last_modified_at.unwrap_or(0))),
                PageSort::LastOpened => (None, Some(last.opened_ms)),
                PageSort::MostLinked => (None, Some(last.row.inbound_link_count)),
                PageSort::MostContent => (None, Some(last.row.child_block_count)),
            };
            // Tagged with the sort discriminator (Review Round 1) so
            // `validate_pages_metadata_cursor` can reject cross-sort reuse.
            let cursor = Cursor {
                id: last.row.id.clone().into_string(),
                position: Some(sort_discriminator(sort)),
                deleted_at,
                seq,
                rank: None,
            };
            Some(cursor.encode()?)
        }
        _ => None,
    };
    Ok(PageResponse {
        items: rows.into_iter().map(|keyed| keyed.row).collect(),
        next_cursor,
        has_more,
        // -D / the COUNT over the same space +
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
