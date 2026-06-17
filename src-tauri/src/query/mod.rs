//! #1280 — the advanced-query engine: a composable boolean-tree query over
//! all structural filter dimensions, compiled via the shared
//! [`crate::filters`] vocabulary and returned as a cursor-paginated page of
//! blocks.
//!
//! This is the **first end-to-end** advanced query: it takes a
//! [`FilterExpr`] boolean tree (AND / OR / NOT across every shared +
//! metadata leaf), compiles it through [`projection::QueryProjection`]
//! (which delegates each leaf to [`crate::filters::PagesProjection`] so the
//! SQL is byte-shape-identical to the Pages surface), and runs a keyset-
//! paginated `SELECT … FROM blocks b`.
//!
//! ## Scope (structural-only)
//!
//! This module is deliberately STRUCTURAL-ONLY. Full-text ranking,
//! `GROUP BY` grouping, and aggregation are FAST-FOLLOWS, NOT implemented
//! here. The wire shapes reserve forward-compat slots so adding them later
//! is non-breaking:
//!
//! * [`QueryResultRow::score`] — the ranking channel. Always `None` in this
//!   PR; a future full-text / vector pass fills it. Kept so the wire shape
//!   is stable.
//! * [`SortSource`] — a tagged enum with a single `Column` variant today.
//!   `Relevance` / `Aggregate` / `VectorScore` are reserved for the
//!   full-text / aggregate PRs and are intentionally NOT added yet (there is
//!   no relevance or aggregate to sort on).
//! * [`AdvancedQueryRequest`] carries NO `fulltext` / `group_by` /
//!   `aggregates` fields — those land with their respective fast-follows.

pub mod engine;
pub mod projection;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

use crate::filters::FilterExpr;
use crate::pagination::ActiveBlockRow;

pub use engine::compile_and_run;
pub use projection::{QUERY_ALLOWED_KEYS, QueryProjection};

/// A composable advanced query: a boolean [`FilterExpr`] tree over the
/// structural filter dimensions, scoped to one space, with an optional
/// multi-key sort and keyset cursor.
///
/// The `filter` defaults to `And { children: [] }` — the TRUE expression
/// (`1=1`), i.e. "every block in the space". `sort` defaults to empty (the
/// engine applies its default keyset on `b.id DESC`). `limit` defaults to
/// the engine's [`engine::DEFAULT_LIMIT`].
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedQueryRequest {
    /// The space the query is scoped to. Always applied as
    /// `b.space_id = ?` regardless of any `Space` leaf in `filter`.
    pub space_id: String,
    /// The boolean filter tree. Defaults to the TRUE expression
    /// (`And { children: [] }`) so an omitted filter returns every block in
    /// the space.
    #[serde(default = "default_filter")]
    pub filter: FilterExpr,
    /// Ordered sort keys. Each key terminates in the `b.id` tiebreaker so
    /// the keyset is always stable. Empty → the engine's default keyset.
    #[serde(default)]
    pub sort: Vec<SortKey>,
    /// Opaque keyset cursor from a prior page's `next_cursor`. `None` =
    /// first page.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Page size. `None` → [`engine::DEFAULT_LIMIT`]; bounded by
    /// [`engine::MAX_LIMIT`].
    #[serde(default)]
    pub limit: Option<i64>,
}

/// The default `filter` — `And { children: [] }` is the TRUE expression
/// (`compile_expr` yields `1=1` for an empty AND).
fn default_filter() -> FilterExpr {
    FilterExpr::And {
        children: Vec::new(),
    }
}

/// One sort key: a source plus a direction. Keys are applied
/// left-to-right; the engine always appends `b.id` as the final
/// tiebreaker so the resulting keyset is total.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    /// What to sort by.
    pub source: SortSource,
    /// Descending when `true` (default ascending).
    #[serde(default)]
    pub desc: bool,
}

/// The thing a [`SortKey`] orders by.
///
/// Internally-tagged on `"type"`. Only `Column` exists in this
/// structural-only PR. `Relevance` (full-text rank), `Aggregate`
/// (group-by aggregate), and `VectorScore` (vector similarity) are RESERVED
/// for the fast-follow PRs — they are NOT added here because there is no
/// relevance / aggregate / vector channel to sort on yet.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum SortSource {
    /// Sort by a fixed, closed-set block column. The column name is NEVER a
    /// user-supplied string — it is a [`SortColumn`] enum the engine maps to
    /// a literal SQL column, so SQL injection through a sort key is
    /// impossible by construction.
    Column { name: SortColumn },
}

/// The closed set of columns an advanced query may sort on. Closed (rather
/// than a free `String`) so a sort column can NEVER be a user-controlled
/// string spliced into SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SortColumn {
    /// Creation order. The block `id` is a ULID, whose lexical order is
    /// creation order, so `Created` maps to `b.id`.
    Created,
    /// Last-edited time: `MAX(op_log.created_at)` over the block, `COALESCE`d
    /// to the epoch sentinel for blocks with no op-log row (matching
    /// `PagesProjection::compile_last_edited`'s no-op-log rule).
    LastEdited,
    /// Sibling position (`b.position`). NULL positions sort last.
    Position,
    /// `b.priority`. NULL priorities sort last.
    Priority,
    /// Page title (`pages_cache.title`) of the block's owning page.
    Title,
}

/// One row of an advanced-query page: a block plus its forward-compat
/// ranking score.
///
/// `block` is flattened so the wire shape is `{ ...ActiveBlockRow, score }`
/// — a stable superset of [`ActiveBlockRow`].
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultRow {
    /// The matched block.
    #[serde(flatten)]
    pub block: ActiveBlockRow,
    /// The ranking channel. ALWAYS `None` in this structural-only PR; a
    /// future full-text / vector pass fills it. Kept so the wire shape is
    /// stable across the fast-follows.
    #[serde(default)]
    pub score: Option<f64>,
}

/// The paginated result of an advanced query.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedQueryResponse {
    /// The page of matched rows.
    pub rows: Vec<QueryResultRow>,
    /// Opaque cursor for the next page, or `None` at the end.
    pub next_cursor: Option<String>,
    /// `true` when a further page exists.
    pub has_more: bool,
    /// Total matching rows ignoring the cursor/limit. Computed on the FIRST
    /// page only (a `COUNT(*)` over the same predicate); `None` on cursor
    /// pages (the total does not change as the same filter is paged).
    pub total_count: Option<i64>,
}
