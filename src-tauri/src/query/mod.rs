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
//! ## Scope (structural + full-text)
//!
//! The C1 engine was structural-only; later fast-follows added **full-text
//! composition** and now **grouping**. Per-group aggregation remains a
//! FAST-FOLLOW (C4), NOT implemented here. The wire shapes reserve
//! forward-compat slots so adding it later is non-breaking:
//!
//! * [`QueryResultRow::score`] — the ranking channel. `Some(bm25)` when the
//!   request carried a `fulltext` term; `None` for purely structural
//!   queries. A future vector pass may also fill it.
//! * [`SortSource`] — a tagged enum with `Column` and `Relevance` variants.
//!   `Aggregate` / `VectorScore` are reserved for the aggregate / vector
//!   PRs and are intentionally NOT added yet (there is no aggregate or
//!   vector channel to sort on).
//! * [`AdvancedQueryRequest`] carries `fulltext` AND now `group_by` (this
//!   fast-follow). When `group_by` is `Some`, the response's `groups` field
//!   carries per-bucket counts + a bounded member preview and `rows` is
//!   empty; when `None`, the engine is byte-for-byte the flat C1+FTS engine
//!   (`groups` empty). Per-group `aggregates` land with C4.
//!
//! ## Grouping (this fast-follow)
//!
//! A [`GroupSpec`] picks ONE dimension ([`GroupKey`]) to bucket the matched
//! rows by — tag, page, state, block-type, priority, a typed property, or a
//! date bucket. The engine runs a `GROUP BY <key-expr>` over the SAME
//! predicate as the flat path (structural + optional FTS `MATCH`), returns
//! the buckets ordered by descending count (then key) with group-level
//! keyset pagination, and attaches a bounded per-group member PREVIEW (the
//! first N members in the default sort, via a `ROW_NUMBER()` window) so a
//! huge bucket cannot blow the payload. The full member list of one bucket
//! is a follow-up "expand group" flat query scoped to that key.
//!
//! **Tag multiplicity (documented):** grouping by [`GroupKey::Tag`] joins
//! `block_tags`, so a block with K tags appears in K tag groups and is
//! counted once per group. Every other key is single-valued (one bucket per
//! block).

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
    /// Optional full-text term. When `Some(q)`, the query composes an FTS5
    /// `MATCH` over `fts_blocks` (sanitised via the shared FTS sanitiser)
    /// INTERSECTED with the structural `filter`, exposes the per-row `bm25`
    /// relevance via [`QueryResultRow::score`], and defaults the sort to
    /// [`SortSource::Relevance`] (best-first) when no explicit `sort` is
    /// given. When `None`, the query is purely structural (full backward
    /// compat with the C1 engine) and [`SortSource::Relevance`] is rejected.
    #[serde(default)]
    pub fulltext: Option<String>,
    /// Optional grouping. When `Some`, the engine runs the GROUPED path:
    /// it buckets the matched rows by the [`GroupSpec`]'s dimension and
    /// returns [`AdvancedQueryResponse::groups`] (per-bucket count + a
    /// bounded member preview) with group-level keyset pagination, leaving
    /// [`AdvancedQueryResponse::rows`] empty. When `None` (the default), the
    /// engine runs the FLAT path exactly as before (full backward compat).
    #[serde(default)]
    pub group_by: Option<GroupSpec>,
}

/// The default `filter` — `And { children: [] }` is the TRUE expression
/// (`compile_expr` yields `1=1` for an empty AND).
fn default_filter() -> FilterExpr {
    FilterExpr::And {
        children: Vec::new(),
    }
}

/// A grouping directive: bucket the matched rows by ONE dimension.
///
/// C4 will extend this with per-group aggregates; for now it carries only
/// the [`GroupKey`].
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupSpec {
    /// The dimension to bucket by.
    pub key: GroupKey,
}

/// The dimension an advanced query groups by. Internally-tagged on `"type"`.
///
/// Every variant resolves to a fixed SQL group-key expression built from
/// STATIC column literals; the only user-controlled inputs are bound as `?`
/// parameters ([`GroupKey::Property`]'s `key`, [`GroupKey::DateBucket`]'s
/// `source`/`unit` — and `unit` maps to a literal `strftime` format, never
/// interpolated). No user string is ever spliced in as an identifier, so
/// grouping cannot inject SQL.
///
/// **Multiplicity:** [`GroupKey::Tag`] is the only MULTI-valued key — a
/// block with K tags lands in K groups. All others are single-valued.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum GroupKey {
    /// Group by tag (`block_tags.tag_id`). Joins `block_tags`, so a block
    /// appears once per tag it carries (documented multiplicity).
    Tag,
    /// Group by owning page (`b.page_id`). Blocks with no page bucket under
    /// the rendered key `"none"`.
    Page,
    /// Group by todo state (`b.todo_state`); NULL state → the `"none"`
    /// bucket.
    State,
    /// Group by block type (`b.block_type`), always non-NULL.
    BlockType,
    /// Group by priority (`b.priority`); NULL → the `"none"` bucket.
    Priority,
    /// Group by a typed property's `value_text` (correlated lookup on
    /// `block_properties` keyed by `key`); blocks lacking the property →
    /// the `"none"` bucket. `key` is BOUND as a `?` parameter.
    Property {
        /// The property key to read `value_text` for.
        key: String,
    },
    /// Group by a calendar bucket over a date column. `source` selects the
    /// column / op-log timestamp; `unit` selects the `strftime` granularity.
    /// Blocks with no date in the source → the `"none"` bucket.
    DateBucket {
        /// Which date the bucket is computed over.
        source: DateField,
        /// The calendar granularity (day / ISO-week / month).
        unit: DateBucketUnit,
    },
}

/// The date column / timestamp a [`GroupKey::DateBucket`] buckets over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DateField {
    /// `b.due_date` (TEXT ISO `YYYY-MM-DD`).
    Due,
    /// `b.scheduled_date` (TEXT ISO `YYYY-MM-DD`).
    Scheduled,
    /// Creation time. Derived from the EARLIEST `op_log.created_at`
    /// (epoch-ms) for the block; blocks with no op-log row have no created
    /// date → the `"none"` bucket.
    Created,
    /// Last-edited time. Derived from the LATEST `op_log.created_at`
    /// (epoch-ms) for the block; same no-op-log rule as `Created`.
    LastEdited,
}

/// The calendar granularity of a [`GroupKey::DateBucket`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DateBucketUnit {
    /// One bucket per calendar day, rendered `YYYY-MM-DD`.
    Day,
    /// One bucket per ISO-ish week, rendered `YYYY-Www` (`strftime('%Y-W%W')`).
    Week,
    /// One bucket per calendar month, rendered `YYYY-MM`.
    Month,
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
/// Internally-tagged on `"type"`. `Column` sorts on a fixed block column.
/// `Relevance` sorts on the full-text `bm25` rank and is ONLY valid when the
/// request carries a `fulltext` term — the engine rejects it otherwise
/// (there is no rank channel to sort on). `Aggregate` (group-by aggregate)
/// and `VectorScore` (vector similarity) remain RESERVED for later
/// fast-follows.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum SortSource {
    /// Sort by a fixed, closed-set block column. The column name is NEVER a
    /// user-supplied string — it is a [`SortColumn`] enum the engine maps to
    /// a literal SQL column, so SQL injection through a sort key is
    /// impossible by construction.
    Column { name: SortColumn },
    /// Sort by full-text relevance (`fts.rank`, a `bm25` score — lower is
    /// better). Only valid when the request carries a `fulltext` term;
    /// otherwise the engine rejects it with a validation error.
    Relevance,
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
    /// The ranking channel. `Some(bm25)` when the request carried a
    /// `fulltext` term (lower is a better match); `None` for purely
    /// structural queries. A future vector pass may also fill it.
    #[serde(default)]
    pub score: Option<f64>,
}

/// One group bucket of a grouped advanced query.
///
/// `key` is the RENDERED group key — a tag id, page id, todo state /
/// priority string, block type, date-bucket label (`YYYY-MM-DD` /
/// `YYYY-Www` / `YYYY-MM`), or the literal `"none"` for the NULL/absent
/// bucket. `count` is the FULL bucket size (every matched row in the group,
/// not just the previewed members). `members` is a BOUNDED preview — the
/// first N members in the engine's default sort — so a huge bucket cannot
/// blow the payload; the full member list of one bucket is a follow-up
/// "expand group" flat query scoped to that key.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryGroup {
    /// The rendered group key (or `"none"` for the NULL/absent bucket).
    pub key: String,
    /// The full size of this bucket (independent of the member preview cap).
    pub count: i64,
    /// A bounded preview of this bucket's member rows (at most
    /// [`engine::GROUP_MEMBER_PREVIEW`]).
    pub members: Vec<QueryResultRow>,
}

/// The paginated result of an advanced query.
///
/// In FLAT mode (`group_by` absent) `rows` carries the page and `groups` is
/// empty. In GROUPED mode (`group_by` present) `groups` carries the bucket
/// page and `rows` is empty. `next_cursor` / `has_more` / `total_count`
/// describe whichever axis is paged (rows in flat mode, groups in grouped
/// mode — `total_count` is the total GROUP count in grouped mode).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedQueryResponse {
    /// The page of matched rows (FLAT mode). Empty in grouped mode.
    pub rows: Vec<QueryResultRow>,
    /// The page of group buckets (GROUPED mode). Empty in flat mode.
    #[serde(default)]
    pub groups: Vec<QueryGroup>,
    /// Opaque cursor for the next page, or `None` at the end. In grouped
    /// mode this is the GROUP-level keyset cursor.
    pub next_cursor: Option<String>,
    /// `true` when a further page exists.
    pub has_more: bool,
    /// Total matching rows ignoring the cursor/limit, computed on the FIRST
    /// page only; `None` on cursor pages. In grouped mode this is the total
    /// number of GROUPS over the same predicate.
    pub total_count: Option<i64>,
}
