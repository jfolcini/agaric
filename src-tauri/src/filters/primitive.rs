//! `FilterPrimitive` enum + `Projection` trait.
//!
//! See `crate::filters` module docs for the broader rationale. This file
//! defines the types; per-surface implementations live in their own
//! `impl Projection for PagesProjection` / `SearchProjection` blocks.
//!
//! **Wire format:** Phase 3 exposes [`FilterPrimitive`] (and its value
//! sub-types [`PropertyPredicate`], [`PropertyValue`], [`LastEditedSpec`],
//! [`SnippetSpec`]) on the IPC boundary via `serde` + `specta::Type`.
//! The enum is internally-tagged (`#[serde(tag = "type")]`, PascalCase
//! variant names) so the regenerated TS renders a clean discriminated
//! union — matching the `BacklinkFilter` convention in
//! `src-tauri/src/backlink/types.rs`. The compilation internals
//! ([`Bind`], [`WhereClause`], [`Projection`], the projection structs)
//! stay backend-only — they are NOT serde/specta.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// ── Primitive enum ────────────────────────────────────────────────────────

/// One filter atom in a compound-filter expression. Variants are tagged
/// so the cross-surface SQL composer can dispatch via match.
///
/// **Wire shape (Phase 3):** internally-tagged on `"type"` with
/// PascalCase variant names, matching `BacklinkFilter`. Every variant is
/// a struct variant (single-field where the prior backend-only shape used
/// a newtype) because `serde`'s internally-tagged representation does not
/// support newtype variants wrapping a primitive — and struct variants
/// give the frontend a self-describing field name (`{ type: "Tag", tag }`
/// rather than a bare positional value).
// NOTE: `Eq` is intentionally NOT derived — #1280 added the `Num { value: f64 }`
// property value (via `PropertyPredicate`), and `f64` is not `Eq`. `PartialEq`
// is sufficient for the tests / round-trip assertions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum FilterPrimitive {
    /// Shared — block carries this tag id directly.
    Tag { tag: String },
    /// Shared — block carries `tag` via an ATTACHED `block_tags` row OR an
    /// inline `block_tag_refs` reference (`source_id`). The ref-inclusive tag
    /// semantics the legacy `query_by_tags`/`filtered_blocks_query` paths use;
    /// `Tag` is attached-only.
    TagOrRef { tag: String },
    /// Shared — page name matches the GLOB pattern. `exclude=true`
    /// becomes a `NOT IN (...)` sub-select; otherwise an `IN (...)`.
    PathGlob { pattern: String, exclude: bool },
    /// Shared — block carries a property matching this predicate.
    ///
    /// D8 (make invalid states unrepresentable): the predicate is a
    /// single nested [`PropertyPredicate`] enum rather than a separate
    /// `op` + `Option<value>` pair. This guarantees by construction that
    /// `Eq`/`Ne` ALWAYS carry a value and `Exists`/`NotExists` NEVER do —
    /// the "partial" states (`Eq` with no value, `Exists` with a value)
    /// are simply not expressible, so `compile_has_property` no longer
    /// needs an `unsupported()` fallback.
    HasProperty {
        key: String,
        predicate: PropertyPredicate,
    },
    /// Shared — block's `last_modified_at` falls in this window.
    LastEdited { spec: LastEditedSpec },
    /// Shared — block's owning page lives in this space.
    Space { space_id: String },
    /// Shared — block's `priority` is in `values` (or IS NULL when
    /// `is_null`). `exclude=true` negates the membership test. Multi-value
    /// to support the chip vocabulary; the single-value backlink `Priority`
    /// leaf routes to `{ values: [priority], is_null: false, exclude: false }`.
    Priority {
        values: Vec<String>,
        #[serde(default)]
        is_null: bool,
        #[serde(default)]
        exclude: bool,
    },
    /// #1280 — block's `todo_state` is in `values` (or IS NULL when
    /// `is_null`). `exclude=true` negates the membership test. Multi-value
    /// to support the chip vocabulary; the single-value backlink `TodoState`
    /// leaf routes to `{ values: [state], is_null: false, exclude: false }`.
    State {
        values: Vec<String>,
        #[serde(default)]
        is_null: bool,
        #[serde(default)]
        exclude: bool,
    },
    /// #1280 — block's `block_type` is in `values`. `exclude=true` negates.
    /// The single-value backlink `BlockType` leaf routes to
    /// `{ values: [block_type], exclude: false }`.
    BlockType { values: Vec<String>, exclude: bool },
    /// #1280 — block's `due_date` matches the date predicate.
    DueDate { predicate: DatePredicate },
    /// #1280 — block's `scheduled_date` matches the date predicate.
    Scheduled { predicate: DatePredicate },
    /// #1280 — block was created (by ULID-prefix range) at or after `after`
    /// and before `before`. Bounds are ISO dates; the projection converts
    /// each to a ULID prefix and compares `b.id`. Routes the backlink
    /// `CreatedInRange` leaf.
    Created {
        after: Option<String>,
        before: Option<String>,
    },
    // ── #1455 relational / multi-hop predicates ───────────────────
    /// #1455 — block has an OUTBOUND link to the concrete `target` block id:
    /// `EXISTS (SELECT 1 FROM block_links l WHERE l.source_id = b.id AND
    /// l.target_id = ?)`. The richer "target is itself a `FilterExpr`" form
    /// is a deliberate follow-up; this leaf takes a concrete id.
    LinksTo { target: String },
    /// #1455 — block has an INBOUND link FROM the concrete `source` block id
    /// (inverse of [`LinksTo`]): `EXISTS (SELECT 1 FROM block_links l WHERE
    /// l.target_id = b.id AND l.source_id = ?)`. The richer FilterExpr-source
    /// form is a follow-up; this leaf takes a concrete id.
    LinkedFrom { source: String },
    /// #1455 — block's PARENT row satisfies the nested `matcher` expression:
    /// `EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND
    /// (<matcher compiled against the parent row `p`>))`. The boxed
    /// [`FilterExpr`] is compiled against the parent alias `p` rather than the
    /// outer `b`. Recursion (a `HasParentMatching` whose matcher itself
    /// contains another `HasParentMatching`) is bounded by
    /// [`FilterExpr::MAX_DEPTH`](crate::filters::FilterExpr::MAX_DEPTH): the
    /// depth gate descends into the boxed matcher (#1455), so the compile
    /// recursion cannot run away.
    HasParentMatching {
        matcher: Box<crate::filters::FilterExpr>,
    },
    // ── Pages-only ────────────────────────────────────────────────
    /// Pages-only — page has no inbound links AND no outbound links.
    /// (`HasNoInboundLinks` is the looser inbound-only sibling.)
    Orphan,
    /// Pages-only — page has zero non-title descendants. Per
    /// "Page
    /// whose only block is its own title row (zero non-title
    /// descendants)". Backed by `pages_cache.child_block_count == 0`.
    Stub,
    /// Pages-only — page has no inbound links (looser than `Orphan`).
    HasNoInboundLinks,
    // ── Search-only ───────────────────────────────────────────────
    /// Search-only — regex pattern over block content.
    Regex { pattern: String },
    /// Search-only — case-sensitive match toggle (post-FTS filter).
    CaseSensitive { enabled: bool },
    /// Search-only — whole-word match toggle (ASCII `\b` semantics).
    WholeWord { enabled: bool },
    /// Search-only — FTS5 `snippet()` window spec.
    Snippet { spec: SnippetSpec },
}

/// Predicate on a `has-property:` primitive.
///
/// D8 (make invalid states unrepresentable): a single internally-tagged
/// enum that fuses the operator with its operand. `Eq`/`Ne` carry a
/// mandatory [`PropertyValue`]; `Exists`/`NotExists` carry none. The
/// previous shape — `op: PropertyOp` plus `value: Option<PropertyValue>`
/// — admitted two nonsensical combinations (`Eq` with no value, `Exists`
/// with a value) that had to be rejected at compile time with an
/// `unsupported()` sentinel. Folding the operand into the operator
/// variant removes those states from the type entirely.
///
/// **Wire shape:** internally-tagged on `"type"` (PascalCase) so the TS
/// union reads `{ type: "Exists" } | { type: "NotExists" }
/// | { type: "Eq", value: PropertyValue } | { type: "Ne", value: PropertyValue }`.
// NOTE: `Eq` is intentionally NOT derived — see `FilterPrimitive` (the `Num`
// property value carries an `f64`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum PropertyPredicate {
    /// Property key exists (no value comparison).
    Exists,
    /// Property key does NOT exist.
    NotExists,
    /// Property value equals the given operand. `Text` compares
    /// `value_text`; `Ref` compares `value_ref`.
    Eq { value: PropertyValue },
    /// Property value does NOT equal the given operand (the block has no
    /// matching `(key, value)` row). `Text` compares `value_text`; `Ref`
    /// compares `value_ref`.
    Ne { value: PropertyValue },
    /// #1280 — property value is strictly less than the operand. The
    /// compared column is chosen from the [`PropertyValue`] variant (see
    /// [`property_value_column`]).
    Lt { value: PropertyValue },
    /// #1280 — property value is strictly greater than the operand.
    Gt { value: PropertyValue },
    /// #1280 — property value is less than or equal to the operand.
    Lte { value: PropertyValue },
    /// #1280 — property value is greater than or equal to the operand.
    Gte { value: PropertyValue },
    /// #1280 — property value contains the operand as a substring
    /// (`LIKE '%v%' ESCAPE '\'`). Meaningless on a `Num` value → `1=0`.
    Contains { value: PropertyValue },
    /// #1280 — property value starts with the operand (`LIKE 'v%' ESCAPE
    /// '\'`). Meaningless on a `Num` value → `1=0`.
    StartsWith { value: PropertyValue },
}

/// The right-hand-side value type for `HasProperty`.
///
/// Internally-tagged on `"type"` (PascalCase) so the TS union reads
/// `{ type: "Text", value } | { type: "Ref", value }`.
// NOTE: `Eq` is intentionally NOT derived — the `Num` variant carries an
// `f64` (#1280), and `f64` is not `Eq`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum PropertyValue {
    Text {
        value: String,
    },
    /// References another block via `block_properties.value_ref`.
    Ref {
        value: String,
    },
    /// #1280 — a numeric value compared against `block_properties.value_num`.
    /// Bound as [`Bind::Real`] so it keeps its native SQLite REAL affinity.
    Num {
        value: f64,
    },
    /// #1280 — an ISO-TEXT date value compared against
    /// `block_properties.value_date` (a TEXT column). Bound as
    /// [`Bind::Text`] — lexical ISO comparison, same as the backlink
    /// `PropertyDate` leaf.
    Date {
        value: String,
    },
}

/// #1280 — a predicate over a TEXT-ISO date column (`blocks.due_date`,
/// `blocks.scheduled_date`, or any `YYYY-MM-DD[...]` column). Comparisons
/// are **lexical**: ISO-8601 dates sort the same byte-wise as
/// chronologically, so `'2026-01-02' > '2026-01-01'` holds as a string
/// compare.
///
/// Internally-tagged on `"type"` (PascalCase). The TS union reads
/// `{ type: "IsNull" } | { type: "Before", date } | { type: "After", date }
/// | { type: "OnOrBefore", date } | { type: "OnOrAfter", date }
/// | { type: "On", date } | { type: "Between", from, to }`.
///
/// **`On` and the calendar-day rule:** `On YYYY-MM-DD` means "the whole
/// calendar day". When the underlying column is *pure* `YYYY-MM-DD` (no
/// time component) a lexical `= ?` already matches the whole day — that is
/// the form [`BacklinkProjection::compile_due_date`] /
/// [`compile_scheduled`](Projection::compile_scheduled) emit, byte-identical
/// to the legacy backlink `DueDate{Eq}` leaf (the resolver oracle treats the
/// column as DATE-exact). For a column that carries a *time* component the
/// generic [`DatePredicate::to_lexical_sql`] expands `On` to the half-open
/// day range `>= 'd' AND < 'd+1day'` so daytime values on the named day are
/// included (mirroring `compile_last_edited`'s end-of-day handling).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum DatePredicate {
    /// The column is NULL (unset).
    IsNull,
    /// Strictly before the given date (`< 'date'`).
    Before { date: String },
    /// Strictly after the given date (`> 'date'`).
    After { date: String },
    /// On or before the given date (`<= 'date'`).
    OnOrBefore { date: String },
    /// On or after the given date (`>= 'date'`).
    OnOrAfter { date: String },
    /// Exactly on the given calendar day. See the type-level doc for the
    /// day-expansion rule.
    On { date: String },
    /// Inclusive range `BETWEEN 'from' AND 'to'`.
    Between { from: String, to: String },
}

impl DatePredicate {
    /// #1280 — compile this predicate against a TEXT-ISO `column` for a
    /// surface whose column may carry a **time** component, expanding `On`
    /// to the half-open calendar-day range `>= 'd' AND < 'd+1day'` so
    /// daytime values on the named day are included. The non-`On` variants
    /// guard `column IS NOT NULL` (except `IsNull` itself). Returns the SQL
    /// fragment plus its ordered text binds.
    ///
    /// `compile_due_date`/`compile_scheduled` deliberately do NOT use this
    /// helper — the backlink columns are treated as DATE-exact to stay
    /// byte-identical with the resolver oracle. It exists for callers /
    /// surfaces that need true calendar-day semantics, and is unit-tested
    /// for the `On`-expands-to-day rule.
    #[must_use]
    pub fn to_lexical_sql(&self, column: &str) -> (String, Vec<Bind>) {
        match self {
            DatePredicate::IsNull => (format!("{column} IS NULL"), Vec::new()),
            DatePredicate::Before { date } => (
                format!("({column} IS NOT NULL AND {column} < ?)"),
                vec![Bind::Text(date.clone())],
            ),
            DatePredicate::After { date } => (
                format!("({column} IS NOT NULL AND {column} > ?)"),
                vec![Bind::Text(date.clone())],
            ),
            DatePredicate::OnOrBefore { date } => (
                format!("({column} IS NOT NULL AND {column} <= ?)"),
                vec![Bind::Text(date.clone())],
            ),
            DatePredicate::OnOrAfter { date } => (
                format!("({column} IS NOT NULL AND {column} >= ?)"),
                vec![Bind::Text(date.clone())],
            ),
            DatePredicate::On { date } => {
                // Expand the bare day to the half-open range
                // `>= 'd' AND < 'd+1'` so a column value like
                // `2026-03-01T14:00:00Z` on that day is INCLUDED.
                let next = next_day_iso(date);
                (
                    format!("({column} IS NOT NULL AND {column} >= ? AND {column} < ?)"),
                    vec![Bind::Text(date.clone()), Bind::Text(next)],
                )
            }
            DatePredicate::Between { from, to } => (
                format!("({column} IS NOT NULL AND {column} BETWEEN ? AND ?)"),
                vec![Bind::Text(from.clone()), Bind::Text(to.clone())],
            ),
        }
    }
}

/// #1280 — given a bare `YYYY-MM-DD` (or an ISO string whose date part is
/// the first 10 chars), return the next calendar day as `YYYY-MM-DD`. Used
/// by [`DatePredicate::to_lexical_sql`] to upper-bound an `On` day range.
/// A malformed input falls back to the input unchanged (the resulting
/// `>= d AND < d` range simply matches nothing — fail-closed).
fn next_day_iso(date: &str) -> String {
    let day = &date.get(..10).unwrap_or(date);
    match chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d") {
        Ok(d) => (d + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string(),
        Err(_) => date.to_string(),
    }
}

/// `last-edited:` time-window spec.
///
/// Internally-tagged on `"type"` (PascalCase) so the TS union reads
/// `{ type: "Rolling", days } | { type: "Range", start, end }
/// | { type: "OlderThan", days }`.
///
/// Phase 2 review — the existing variants already cover the
/// Plan's full bucket vocabulary (pending/-pages-view-compound-
/// filters.md:144, lines 308-310). No `LastEditedBucket` variant is
/// needed — the parser maps each chip token to one of these variants:
///
/// | Chip token                | Variant               |
/// |---------------------------|-----------------------|
/// | `last-edited:today`       | `Rolling { days: 1 }`  |
/// | `last-edited:this-week`   | `Rolling { days: 7 }`  |
/// | `last-edited:this-month`  | `Rolling { days: 30 }` |
/// | `last-edited:older`       | `OlderThan { days: 30 }` |
/// | `last-edited:>=YYYY-MM-DD` | `Range { .. }`        |
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum LastEditedSpec {
    /// Rolling N-days window. `Today`, `ThisWeek`, `ThisMonth` map to
    /// 1 / 7 / 30. Custom values are accepted but documented as
    /// "rolling, not calendar".
    Rolling { days: u32 },
    /// Absolute date range (ISO 8601 dates, inclusive on both ends).
    Range { start: String, end: String },
    /// Older than the given rolling N-days window (the inverse of
    /// `Rolling`). Used by `last-edited:older` chip.
    OlderThan { days: u32 },
}

/// Snippet-rendering parameters threaded through to the FTS5 `snippet()`
/// builtin. The SQL composition lives in `fts::search`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SnippetSpec {
    pub max_tokens: u32,
    pub left_marker: String,
    pub right_marker: String,
}

// ── Where-clause composition ──────────────────────────────────────────────

/// SQL fragment produced by a `Projection::compile_*` call. Always a
/// boolean-valued expression: the caller AND-joins multiple fragments.
///
/// `binds` holds the positional parameter values in left-to-right
/// order. The composer threads them into the final `sqlx::query_as`
/// via a single `bind` chain. An `Unsupported` clause is the projection's
/// way of saying "this primitive doesn't apply on my surface" — the
/// caller MUST filter these out at parse time (allow-list gate) so they
/// never reach SQL.
#[derive(Debug, Clone, PartialEq)]
pub struct WhereClause {
    pub sql: String,
    pub binds: Vec<Bind>,
    /// D18 — explicit "this projection does not support this primitive"
    /// flag. Replaces the previous substring sentinel (`is_unsupported`
    /// used to grep the `sql` string for a `/* UNSUPPORTED */` comment,
    /// which was brittle: any normal fragment containing that exact text
    /// would have been misread). `false` for every real fragment; only
    /// [`WhereClause::unsupported`] sets it `true`.
    pub unsupported: bool,
}

impl WhereClause {
    pub fn new(sql: impl Into<String>, binds: Vec<Bind>) -> Self {
        Self {
            sql: sql.into(),
            binds,
            unsupported: false,
        }
    }

    /// Sentinel value for "this projection does not support this
    /// primitive". Distinct from a true `WHERE 1=0` because callers
    /// should never emit this to SQL — the allow-list gate is the
    /// production-side protection. The cross-surface default `compile_*`
    /// methods (Pages-only on Search, Search-only on Pages) return this;
    /// after D8 + D26, `HasProperty` itself never does.
    pub fn unsupported() -> Self {
        Self {
            sql: String::from("1=0 /* UNSUPPORTED */"),
            binds: Vec::new(),
            unsupported: true,
        }
    }

    /// D18 — reads the explicit boolean flag instead of substring-matching
    /// the SQL text.
    pub fn is_unsupported(&self) -> bool {
        self.unsupported
    }
}

/// Bind shape for `WhereClause::binds`. Three scalars cover every
/// primitive we currently emit; future primitives can extend.
#[derive(Debug, Clone, PartialEq)]
pub enum Bind {
    Text(String),
    Int(i64),
    /// #1280 — a real (`f64`) value. Emitted by the property `Num`-valued
    /// predicates routed through [`BacklinkProjection`](crate::backlink::projection::BacklinkProjection)
    /// so a numeric property value keeps its native SQLite affinity rather
    /// than being stringified.
    Real(f64),
}

// ── Projection trait ─────────────────────────────────────────────────────

/// Per-surface compiler. Implementations decide which primitives are
/// supported and how each compiles to SQL on their schema.
pub trait Projection {
    /// Primitive keys this projection's parser accepts. Tokens outside
    /// this set are rejected at parse time with a typed error before
    /// they reach `compile_*`. The constant is also surfaced to the
    /// frontend (via the chip-row's Add-Filter popover allowlist).
    fn allowed_keys() -> &'static HashSet<&'static str>
    where
        Self: Sized;

    fn compile_tag(&self, tag: &str) -> WhereClause;
    fn compile_tag_or_ref(&self, tag: &str) -> WhereClause;
    fn compile_path_glob(&self, pattern: &str, exclude: bool) -> WhereClause;
    fn compile_has_property(&self, key: &str, predicate: &PropertyPredicate) -> WhereClause;
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause;
    fn compile_space(&self, space_id: &str) -> WhereClause;
    fn compile_priority(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause;

    // #1280 — shared metadata primitives; default to `unsupported` so a
    // projection only opts in by overriding (currently `BacklinkProjection`).
    fn compile_state(&self, _values: &[String], _is_null: bool, _exclude: bool) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_block_type(&self, _values: &[String], _exclude: bool) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_due_date(&self, _predicate: &DatePredicate) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_scheduled(&self, _predicate: &DatePredicate) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_created(&self, _after: Option<&str>, _before: Option<&str>) -> WhereClause {
        WhereClause::unsupported()
    }

    // #1455 relational predicates — default to `unsupported` so a projection
    // only opts in by overriding (currently `QueryProjection`).
    fn compile_links_to(&self, _target: &str) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_linked_from(&self, _source: &str) -> WhereClause {
        WhereClause::unsupported()
    }
    /// #1455 — compile `has-parent-matching`. The boxed sub-expression must be
    /// compiled against the PARENT row (alias `p`), not the outer `b`, so this
    /// needs `Self: Sized` to recurse through `compile_expr`. The default is
    /// `unsupported()`; only `QueryProjection` overrides it. The recursion is
    /// bounded by the caller's `FilterExpr::validate_depth` gate, which now
    /// descends into the boxed matcher (#1455).
    fn compile_has_parent_matching(&self, _matcher: &crate::filters::FilterExpr) -> WhereClause
    where
        Self: Sized,
    {
        WhereClause::unsupported()
    }

    // Pages-only — default to `unsupported`.
    fn compile_orphan(&self) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_stub(&self) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_has_no_inbound_links(&self) -> WhereClause {
        WhereClause::unsupported()
    }

    // Search-only — default to `unsupported`.
    fn compile_regex(&self, _pattern: &str) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_case_sensitive(&self, _enabled: bool) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_whole_word(&self, _enabled: bool) -> WhereClause {
        WhereClause::unsupported()
    }
    fn compile_snippet(&self, _spec: &SnippetSpec) -> WhereClause {
        WhereClause::unsupported()
    }

    /// Compile a single primitive via the appropriate `compile_*` method.
    /// Defaulted so per-surface impls just need the `compile_*` overrides.
    fn compile(&self, p: &FilterPrimitive) -> WhereClause
    where
        Self: Sized,
    {
        match p {
            FilterPrimitive::Tag { tag } => self.compile_tag(tag),
            FilterPrimitive::TagOrRef { tag } => self.compile_tag_or_ref(tag),
            FilterPrimitive::PathGlob { pattern, exclude } => {
                self.compile_path_glob(pattern, *exclude)
            }
            FilterPrimitive::HasProperty { key, predicate } => {
                self.compile_has_property(key, predicate)
            }
            FilterPrimitive::LastEdited { spec } => self.compile_last_edited(spec),
            FilterPrimitive::Space { space_id } => self.compile_space(space_id),
            FilterPrimitive::Priority {
                values,
                is_null,
                exclude,
            } => self.compile_priority(values, *is_null, *exclude),
            FilterPrimitive::State {
                values,
                is_null,
                exclude,
            } => self.compile_state(values, *is_null, *exclude),
            FilterPrimitive::BlockType { values, exclude } => {
                self.compile_block_type(values, *exclude)
            }
            FilterPrimitive::DueDate { predicate } => self.compile_due_date(predicate),
            FilterPrimitive::Scheduled { predicate } => self.compile_scheduled(predicate),
            FilterPrimitive::Created { after, before } => {
                self.compile_created(after.as_deref(), before.as_deref())
            }
            FilterPrimitive::LinksTo { target } => self.compile_links_to(target),
            FilterPrimitive::LinkedFrom { source } => self.compile_linked_from(source),
            FilterPrimitive::HasParentMatching { matcher } => {
                self.compile_has_parent_matching(matcher)
            }
            FilterPrimitive::Orphan => self.compile_orphan(),
            FilterPrimitive::Stub => self.compile_stub(),
            FilterPrimitive::HasNoInboundLinks => self.compile_has_no_inbound_links(),
            FilterPrimitive::Regex { pattern } => self.compile_regex(pattern),
            FilterPrimitive::CaseSensitive { enabled } => self.compile_case_sensitive(*enabled),
            FilterPrimitive::WholeWord { enabled } => self.compile_whole_word(*enabled),
            FilterPrimitive::Snippet { spec } => self.compile_snippet(spec),
        }
    }
}

impl FilterPrimitive {
    /// Relative SQL-plan cost, used to order the
    /// compiled WHERE fragments so the index-backed primitives narrow the
    /// row set before the full-scan ones run. Lower = cheaper = emitted
    /// first.
    ///
    /// The mapping mirrors the plan's "SARGable?" / "Index hit" table:
    ///
    /// - **0 (index-backed):** `Tag`, `HasProperty`, `Space`,
    ///   `Stub`, `HasNoInboundLinks` — each hits an existing index
    ///   (`idx_block_props_key`, `idx_block_links_target_source`,
    ///   `idx_blocks_page_id`) or reads a materialised `pages_cache`
    ///   column.
    /// - **1 (per-row, cheap):** `Priority` (a single equality scan over
    ///   `blocks.priority`, no dedicated index) and `LastEdited` (a
    ///   correlated `MAX(created_at)` subquery over `op_log`, served
    ///   per-row via `idx_op_log_block_id` — not an index anti-join, so it
    ///   ranks below the genuine index-backed primitives).
    /// - **2 (full scan, GLOB):** `PathGlob`, always. It compiles to
    ///   `LOWER(title) GLOB ?` (#1320-A — the SAME dialect as Search;
    ///   `GLOB` + brace + `[class]` semantics). SQLite's `GLOB` uses BINARY
    ///   collation against the `LOWER(title)` expression, so it cannot use
    ///   `idx_pages_cache_title_nocase` — every `PathGlob` is a true
    ///   `pages_cache.title` scan regardless of anchoring. That scan is
    ///   cheap in practice — `pages_cache` holds one row per page
    ///   (hundreds–low thousands) — so `PathGlob` is simply ranked last
    ///   among the SQL primitives so it never runs before a SARGable
    ///   clause.
    /// - **3 (post-filter / correlated-subquery / non-SQL):** `Orphan`
    ///   plus the Search-only toggles (`Regex`, `CaseSensitive`,
    ///   `WholeWord`, `Snippet`). `Orphan`'s *inbound* half reads the
    ///   materialised `pc.inbound_link_count` (cheap), but its *outbound*
    ///   half is a page-wide `NOT EXISTS` over a **3-table correlated
    ///   subquery** (`block_links` ⋈ `blocks src` ⋈ `blocks tgt`,
    ///   correlated on `src.page_id = b.id`) with **no materialised
    ///   counterpart yet** — see `compile_orphan`. That outbound term
    ///   dominates the clause, so `Orphan` ranks in the expensive tier and
    ///   is emitted *after* any genuinely index-backed clause that can
    ///   Pre-narrow the page set (; matches the cost-ordering
    ///   rationale in `docs/architecture/filters.md`). The Search-only
    ///   toggles are never seen on the Pages surface (allowed-keys gate
    ///   rejects them) but rank here too so they never precede a SARGable
    ///   clause if a future surface admits them. When an
    ///   `outbound_link_count` column is eventually materialised, `Orphan`
    ///   becomes a pure index read and can drop back to `0`.
    #[must_use]
    pub fn cost_hint(&self) -> u8 {
        match self {
            FilterPrimitive::Tag { .. }
            // `TagOrRef` is the ref-inclusive sibling of `Tag`: a UNION of two
            // index-backed sub-selects (`block_tags.tag_id` +
            // `idx_block_tag_refs_tag`) — same index-backed tier as `Tag`.
            | FilterPrimitive::TagOrRef { .. }
            | FilterPrimitive::HasProperty { .. }
            | FilterPrimitive::Space { .. }
            | FilterPrimitive::Stub
            | FilterPrimitive::HasNoInboundLinks
            // #1280 — `DueDate`/`Scheduled` hit the partial indexes
            // `idx_blocks_due` / `idx_blocks_scheduled`; `Created` is a
            // `b.id` (PK) range — all genuinely index-backed.
            | FilterPrimitive::DueDate { .. }
            | FilterPrimitive::Scheduled { .. }
            | FilterPrimitive::Created { .. } => 0,
            // `Priority` is a per-row equality; `LastEdited` is a
            // per-row correlated `MAX()` subquery (served via
            // `idx_op_log_block_id`) — both rank above a full LIKE scan.
            // #1280 — `State`/`BlockType` are per-row column membership
            // tests with no dedicated index, ranking with `Priority`.
            FilterPrimitive::Priority { .. }
            | FilterPrimitive::LastEdited { .. }
            | FilterPrimitive::State { .. }
            // #1455 — `LinksTo`/`LinkedFrom` are single-edge `EXISTS`
            // subqueries served by `idx_block_links_source` /
            // `idx_block_links_target`; cheap, but a correlated `EXISTS`
            // ranks just above a per-row column test.
            | FilterPrimitive::LinksTo { .. }
            | FilterPrimitive::LinkedFrom { .. }
            | FilterPrimitive::BlockType { .. } => 1,
            // `PathGlob` is always a full `pages_cache.title` scan:
            // `LOWER(title) GLOB ?` (#1320-A) uses BINARY collation against
            // an expression, so no index applies and anchoring buys
            // nothing. Ranked highest among the SQL primitives.
            FilterPrimitive::PathGlob { .. } => 2,
            // `Orphan`'s outbound half is a 3-table correlated subquery with
            // No materialised counterpart — expensive tier,
            // emitted after any index-backed clause that can pre-narrow.
            FilterPrimitive::Orphan
            // #1455 — `HasParentMatching` is a correlated `EXISTS` over a
            // re-scan of `blocks` whose body is itself an arbitrary compiled
            // sub-tree (potentially nested); emit it after any index-backed
            // clause that can pre-narrow the candidate rows.
            | FilterPrimitive::HasParentMatching { .. }
            | FilterPrimitive::Regex { .. }
            | FilterPrimitive::CaseSensitive { .. }
            | FilterPrimitive::WholeWord { .. }
            | FilterPrimitive::Snippet { .. } => 3,
        }
    }

    /// The allowed-keys token for this primitive, used by the
    /// per-surface allow-list gate. Mirrors the `&'static str` keys in
    /// [`PAGES_ALLOWED_KEYS`] / [`SEARCH_ALLOWED_KEYS`].
    #[must_use]
    pub fn allowed_key(&self) -> &'static str {
        match self {
            FilterPrimitive::Tag { .. } => "tag",
            // Ref-inclusive tag leaf — shares the `tag` allowed-key with `Tag`.
            FilterPrimitive::TagOrRef { .. } => "tag",
            FilterPrimitive::PathGlob { .. } => "path",
            FilterPrimitive::HasProperty { .. } => "has-property",
            FilterPrimitive::LastEdited { .. } => "last-edited",
            FilterPrimitive::Space { .. } => "space",
            FilterPrimitive::Priority { .. } => "priority",
            FilterPrimitive::State { .. } => "state",
            FilterPrimitive::BlockType { .. } => "block-type",
            FilterPrimitive::DueDate { .. } => "due-date",
            FilterPrimitive::Scheduled { .. } => "scheduled",
            FilterPrimitive::Created { .. } => "created",
            FilterPrimitive::LinksTo { .. } => "links-to",
            FilterPrimitive::LinkedFrom { .. } => "linked-from",
            FilterPrimitive::HasParentMatching { .. } => "has-parent-matching",
            FilterPrimitive::Orphan => "orphan",
            FilterPrimitive::Stub => "stub",
            FilterPrimitive::HasNoInboundLinks => "has-no-inbound-links",
            FilterPrimitive::Regex { .. } => "regex",
            FilterPrimitive::CaseSensitive { .. } => "case-sensitive",
            FilterPrimitive::WholeWord { .. } => "whole-word",
            FilterPrimitive::Snippet { .. } => "snippet",
        }
    }
}

// ── Glob → LIKE translation ──────────────────────────────────────────────

// ── Property-value column mapping ─────────────────────────────────────────

/// D26 / #1280 — map a [`PropertyValue`] to the `block_properties` column
/// it compares against plus the bound operand (carrying its native
/// affinity via [`Bind`]). The 4-column mapping:
///
/// | `PropertyValue` | column        | bind          |
/// |-----------------|---------------|---------------|
/// | `Text`          | `value_text`  | `Bind::Text`  |
/// | `Ref`           | `value_ref`   | `Bind::Text`  |
/// | `Num`           | `value_num`   | `Bind::Real`  |
/// | `Date`          | `value_date`  | `Bind::Text`  |
///
/// `Eq`/`Ne` and the `Lt`/`Gt`/`Lte`/`Gte` comparisons share this mapping;
/// only the surrounding `EXISTS`/`NOT EXISTS` wrapper + the SQL operator
/// differ. `Contains`/`StartsWith` build their own `LIKE` bind instead.
fn property_value_column(value: &PropertyValue) -> (&'static str, Bind) {
    match value {
        PropertyValue::Text { value } => ("value_text", Bind::Text(value.clone())),
        PropertyValue::Ref { value } => ("value_ref", Bind::Text(value.clone())),
        PropertyValue::Num { value } => ("value_num", Bind::Real(*value)),
        PropertyValue::Date { value } => ("value_date", Bind::Text(value.clone())),
    }
}

/// #1280 — compile an ordered comparison (`<`/`>`/`<=`/`>=`) over a single
/// property column, guarding the column `IS NOT NULL` so a row missing the
/// value never spuriously matches (mirrors the backlink `PropertyNum`/
/// `PropertyDate`/`PropertyText` resolver semantics, which only consider
/// rows whose value column is non-NULL).
fn compile_property_compare(key: &str, op: &str, value: &PropertyValue) -> WhereClause {
    let (col, bind) = property_value_column(value);
    WhereClause::new(
        format!(
            "EXISTS (SELECT 1 FROM block_properties \
             WHERE block_id = b.id AND key = ? \
               AND {col} IS NOT NULL AND {col} {op} ?)"
        ),
        vec![Bind::Text(key.to_string()), bind],
    )
}

/// #1280 — compile a substring (`Contains`) or prefix (`StartsWith`) match
/// as `LIKE ? ESCAPE '\'`. On a `Num` value the predicate is meaningless
/// (a numeric column has no substring), so it short-circuits to `1=0` —
/// exactly as the backlink `PropertyNum` resolver returns the empty set.
fn compile_property_like(key: &str, value: &PropertyValue, contains: bool) -> WhereClause {
    let (col, raw) = match value {
        PropertyValue::Text { value } => ("value_text", value.clone()),
        PropertyValue::Ref { value } => ("value_ref", value.clone()),
        PropertyValue::Date { value } => ("value_date", value.clone()),
        PropertyValue::Num { .. } => return WhereClause::new("1=0", Vec::new()),
    };
    let escaped = crate::sql_utils::escape_like(&raw);
    let pattern = if contains {
        format!("%{escaped}%")
    } else {
        format!("{escaped}%")
    };
    WhereClause::new(
        format!(
            "EXISTS (SELECT 1 FROM block_properties \
             WHERE block_id = b.id AND key = ? \
               AND {col} IS NOT NULL AND {col} LIKE ? ESCAPE '\\')"
        ),
        vec![Bind::Text(key.to_string()), Bind::Text(pattern)],
    )
}

/// #1280 — canonical Pages SQL for a multi-value text-membership leaf
/// (`state:` over `b.todo_state`), byte-shape identical to the legacy FTS
/// metadata oracle. INCLUDE mirrors
/// `fts::metadata_filter::append_text_in_or_null`; EXCLUDE mirrors
/// `append_text_not_in_or_not_null`. See the `compile_state` doc for the
/// per-branch rationale. An empty-and-null-less filter degenerates to the
/// no-op `1=1` (the legacy helpers emit no clause at all in that case).
fn in_or_null(column: &str, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
    if values.is_empty() && !is_null {
        // Legacy helpers return early (emit nothing) → no-op.
        return WhereClause::new("1=1", Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", values.len())
        .collect::<Vec<_>>()
        .join(", ");
    let mut parts: Vec<String> = Vec::new();
    if exclude {
        // `append_text_not_in_or_not_null`: NULL branch OUTSIDE the IN list.
        if !values.is_empty() {
            parts.push(format!(
                "{column} IS NULL OR {column} NOT IN ({placeholders})"
            ));
        }
        if is_null {
            parts.push(format!("{column} IS NOT NULL"));
        }
    } else {
        // `append_text_in_or_null`.
        if !values.is_empty() {
            parts.push(format!("{column} IN ({placeholders})"));
        }
        if is_null {
            parts.push(format!("{column} IS NULL"));
        }
    }
    WhereClause::new(
        format!("({})", parts.join(" OR ")),
        values.iter().cloned().map(Bind::Text).collect(),
    )
}

/// #1280 — canonical Pages SQL for a [`DatePredicate`] over a TEXT-ISO date
/// `column` (`b.due_date` / `b.scheduled_date`), byte-shape identical to the
/// legacy `fts::metadata_filter::append_date_predicate` oracle. Every
/// comparison (`On`/`Before`/`After`/`OnOrBefore`/`OnOrAfter`/`Between`)
/// guards `column IS NOT NULL` first; `On` is the legacy **exact** `= ?`
/// (DateOp::Eq) — NOT the half-open day expansion of
/// [`DatePredicate::to_lexical_sql`] (the Pages/FTS columns store pure
/// `YYYY-MM-DD`, so an exact compare already matches the whole day). This is
/// the one shape that DEVIATES from `BacklinkProjection::compile_due_date`'s
/// guard-less `b.col = ?`: the legacy FTS oracle guards `IS NOT NULL`, and
/// matching that oracle is the contract for the Search-path B2 cutover.
fn pages_date_predicate(predicate: &DatePredicate, column: &str) -> WhereClause {
    match predicate {
        DatePredicate::IsNull => WhereClause::new(format!("{column} IS NULL"), Vec::new()),
        DatePredicate::On { date } => WhereClause::new(
            format!("({column} IS NOT NULL AND {column} = ?)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::Before { date } => WhereClause::new(
            format!("({column} IS NOT NULL AND {column} < ?)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::After { date } => WhereClause::new(
            format!("({column} IS NOT NULL AND {column} > ?)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::OnOrBefore { date } => WhereClause::new(
            format!("({column} IS NOT NULL AND {column} <= ?)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::OnOrAfter { date } => WhereClause::new(
            format!("({column} IS NOT NULL AND {column} >= ?)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::Between { from, to } => WhereClause::new(
            format!("({column} IS NOT NULL AND {column} BETWEEN ? AND ?)"),
            vec![Bind::Text(from.clone()), Bind::Text(to.clone())],
        ),
    }
}

// ── Allowed-keys constants ───────────────────────────────────────────────

/// Pages-surface allowed tokens. Shared + Pages-only.
pub static PAGES_ALLOWED_KEYS: std::sync::LazyLock<HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        HashSet::from([
            "tag",
            "path",
            "has-property",
            "last-edited",
            "space",
            "priority",
            "orphan",
            "stub",
            "has-no-inbound-links",
        ])
    });

/// Search-surface allowed tokens. Shared + Search-only.
pub static SEARCH_ALLOWED_KEYS: std::sync::LazyLock<HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        HashSet::from([
            "tag",
            "path",
            "has-property",
            "last-edited",
            "space",
            "priority",
            "regex",
            "case-sensitive",
            "whole-word",
            "snippet",
        ])
    });

// ── Per-surface projection structs (Phase 1: stubs) ──────────────────────

/// Pages-surface projection. Phase 1 stubs the SQL compile sites —
/// Phase 2 fills them in with the actual SQL fragments.
#[derive(Debug, Clone, Copy, Default)]
pub struct PagesProjection;

impl Projection for PagesProjection {
    fn allowed_keys() -> &'static HashSet<&'static str> {
        &PAGES_ALLOWED_KEYS
    }
    fn compile_tag(&self, tag: &str) -> WhereClause {
        WhereClause::new(
            "b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?)",
            vec![Bind::Text(tag.to_string())],
        )
    }
    fn compile_tag_or_ref(&self, tag: &str) -> WhereClause {
        WhereClause::new(
            "b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ? \
             UNION SELECT source_id FROM block_tag_refs WHERE tag_id = ?)",
            vec![Bind::Text(tag.to_string()), Bind::Text(tag.to_string())],
        )
    }
    fn compile_path_glob(&self, pattern: &str, exclude: bool) -> WhereClause {
        // #1320-A — Pages now uses the SAME `LOWER(title) GLOB ?` dialect as
        // Search (after #1320), so both surfaces share `GLOB` + brace +
        // `[class]` semantics. This is the SINGLE-pattern fragment for ONE
        // already-prepared pattern: the caller (`compile_pages_filters`)
        // runs `prepare_globs` to brace-expand / substring-wrap /
        // ASCII-lowercase the raw pattern, then OR/AND-joins the per-pattern
        // fragments this method emits. The `pattern` is therefore bound
        // VERBATIM (`Bind::Text(pattern.to_string())`, NO `glob_to_like`).
        //
        // Pages keeps the `b.id` alias (Search uses `b.page_id`); only the
        // alias differs between the two surfaces.
        let op = if exclude { "NOT IN" } else { "IN" };
        WhereClause::new(
            format!("b.id {op} (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)"),
            vec![Bind::Text(pattern.to_string())],
        )
    }
    fn compile_has_property(&self, key: &str, predicate: &PropertyPredicate) -> WhereClause {
        // D26 — every valid predicate × value combo compiles; there is no
        // `unsupported()` fallback. Invalid states (Eq/Ne without a value,
        // Exists/NotExists with one) are unrepresentable after D8.
        //
        // - Exists / NotExists test the key alone.
        // - Eq / Ne over `Text` compare `block_properties.value_text`.
        // - Eq / Ne over `Ref` compare `block_properties.value_ref`
        //   (previously rejected — D26 wires it up; the `value_ref`
        //   column has existed since migration 0001 and is used by the
        //   `space` property).
        match predicate {
            PropertyPredicate::Exists => WhereClause::new(
                "EXISTS (SELECT 1 FROM block_properties WHERE block_id = b.id AND key = ?)",
                vec![Bind::Text(key.to_string())],
            ),
            PropertyPredicate::NotExists => WhereClause::new(
                "NOT EXISTS (SELECT 1 FROM block_properties WHERE block_id = b.id AND key = ?)",
                vec![Bind::Text(key.to_string())],
            ),
            PropertyPredicate::Eq { value } => {
                let (col, v) = property_value_column(value);
                WhereClause::new(
                    format!(
                        "EXISTS (SELECT 1 FROM block_properties \
                         WHERE block_id = b.id AND key = ? AND {col} = ?)"
                    ),
                    vec![Bind::Text(key.to_string()), v],
                )
            }
            PropertyPredicate::Ne { value } => {
                let (col, v) = property_value_column(value);
                WhereClause::new(
                    format!(
                        "NOT EXISTS (SELECT 1 FROM block_properties \
                         WHERE block_id = b.id AND key = ? AND {col} = ?)"
                    ),
                    vec![Bind::Text(key.to_string()), v],
                )
            }
            PropertyPredicate::Lt { value } => compile_property_compare(key, "<", value),
            PropertyPredicate::Gt { value } => compile_property_compare(key, ">", value),
            PropertyPredicate::Lte { value } => compile_property_compare(key, "<=", value),
            PropertyPredicate::Gte { value } => compile_property_compare(key, ">=", value),
            PropertyPredicate::Contains { value } => compile_property_like(key, value, true),
            PropertyPredicate::StartsWith { value } => compile_property_like(key, value, false),
        }
    }
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause {
        // Uses op_log's last-modified-at expression for the page itself
        // (`MAX(op_log.created_at)`). A future phase may swap to a
        // materialised `pages_cache.last_edited_at` column.
        //
        // **No-op-log ⇒ epoch rule:** a page with no `op_log`
        // row has a NULL `MAX(created_at)`. All three variants COALESCE that
        // NULL to a common epoch sentinel (`0`, i.e. 1970-01-01 in the
        // #109 Phase 2 INTEGER-epoch-ms scheme) so the
        // "no op-log ⇒ treated as edited at the epoch" rule is uniform:
        //   - Rolling{N}   — epoch is far in the past, so it is `< now-N`
        //                    and the page is EXCLUDED (it wasn't edited
        //                    recently).
        //   - OlderThan{N} — epoch is `< now-N`, so the page is INCLUDED
        //                    (it counts as "old").
        //   - Range{a,b}   — epoch is below any plausible `start`, so the
        //                    page is EXCLUDED (it falls outside the window).
        // Before this fix Rolling/Range silently dropped the no-op-log page
        // (NULL comparisons → NULL → false) while OlderThan included it via
        // a `'0001-01-01'` COALESCE — an asymmetry. The dates Range binds
        // Are validated upstream in
        // `commands::pages::compile_pages_filters`.
        //
        // **End-of-day inclusivity:** the Range `end` bound is
        // a *user-facing calendar window* — selecting `… AND 2026-03-01`
        // means "up to and including all of March 1st". `op_log.created_at`
        // is INTEGER epoch-ms (#109 Phase 2), so we convert each bound to an
        // epoch-ms integer: a bare (`YYYY-MM-DD`, no `T`) `end` is extended
        // to the last instant of that day (`T23:59:59.999Z`) before
        // conversion so the whole end day is included. A `start` bound needs
        // no such treatment: a bare `'2026-02-01'` converts to midnight,
        // already at/before any same-day edit, so `>= start_ms` correctly
        // admits the entire start day. An `end` that already carries a `T`
        // (full RFC 3339, also accepted by `validate_last_edited_date`) is
        // converted verbatim — the caller asked for an exact instant.
        //
        // The "now − N days" boundary is computed in SQLite as epoch-ms:
        // `CAST(strftime('%s','now',?) AS INTEGER) * 1000` (the `?` is the
        // `-N days` modifier), matching the column's units.
        const EPOCH: &str = "0"; // 1970-01-01T00:00:00Z in epoch-ms
        // Parse an RFC 3339 timestamp to epoch-ms. Bounds are pre-validated
        // by `validate_last_edited_date`; the fallback to `0` keeps a
        // malformed value from panicking (it would simply match nothing).
        fn to_ms(ts: &str) -> i64 {
            let parsed = chrono::DateTime::parse_from_rfc3339(ts);
            // #383: bounds are pre-validated by `validate_last_edited_date`, so
            // a parse failure here means a validation bypass. Fail loudly in
            // debug (mirrors the `none`-sentinel debug_assert! in
            // metadata_filter.rs) while keeping the `unwrap_or(0)` no-panic
            // fallback in release — an epoch-0 bound simply matches nothing.
            debug_assert!(
                parsed.is_ok(),
                "last_edited Range bound must be a valid RFC 3339 timestamp \
                 (pre-validated by validate_last_edited_date), got: '{ts}'"
            );
            parsed.map_or(0, |d| d.timestamp_millis())
        }
        match spec {
            LastEditedSpec::Rolling { days } => WhereClause::new(
                format!(
                    "COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), {EPOCH}) \
                     >= (CAST(strftime('%s', 'now', ?) AS INTEGER) * 1000)"
                ),
                vec![Bind::Text(format!("-{days} days"))],
            ),
            LastEditedSpec::OlderThan { days } => WhereClause::new(
                format!(
                    "COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), {EPOCH}) \
                     < (CAST(strftime('%s', 'now', ?) AS INTEGER) * 1000)"
                ),
                vec![Bind::Text(format!("-{days} days"))],
            ),
            LastEditedSpec::Range { start, end } => {
                // A bare-date `end` (no `T`) is extended to the end of that
                // calendar day so daytime edits on the end day are INCLUDED
                // A bare-date `start` is anchored at midnight.
                // Both are then converted to epoch-ms to match the column.
                let start_ms = to_ms(&if start.contains('T') {
                    start.clone()
                } else {
                    format!("{start}T00:00:00Z")
                });
                let end_ms = to_ms(&if end.contains('T') {
                    end.clone()
                } else {
                    format!("{end}T23:59:59.999Z")
                });
                WhereClause::new(
                    format!(
                        "COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), {EPOCH}) \
                         >= ? AND COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), {EPOCH}) \
                         <= ?"
                    ),
                    vec![Bind::Int(start_ms), Bind::Int(end_ms)],
                )
            }
        }
    }
    /// D17 — **intentionally redundant on the Pages surface.** The Pages
    /// IPC (`commands::pages::list_pages_with_metadata_inner`) is already
    /// space-scoped: its base SELECT filters `b.space_id = ?1` (#533,
    /// migration 0086 — `space_id` is a first-class column)
    /// against the request's `space_id` before any compiled filter runs.
    /// A `Space` primitive therefore re-applies the same predicate the
    /// request already enforces — a no-op for the request's own space, and
    /// (because a page lives in exactly one space) a guaranteed
    /// empty-result if a *different* space is named.
    ///
    /// It is kept rather than removed for **cross-surface / saved-view
    /// parity**: `Space` is a shared primitive that Search genuinely needs
    /// (Search is not pre-scoped the way Pages is), and a saved view built
    /// on one surface must round-trip to the other without dropping
    /// primitives. Compiling it here keeps the Pages projection a total
    /// implementation of the shared vocabulary. T-B3's `Space` test
    /// asserts this fragment is emitted (not `unsupported()`).
    fn compile_space(&self, space_id: &str) -> WhereClause {
        WhereClause::new("b.space_id = ?", vec![Bind::Text(space_id.to_string())])
    }
    fn compile_priority(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        // Canonical Pages SQL for the `priority:` leaf, byte-shape identical
        // to the LEGACY FTS metadata oracle (`append_text_in_or_null` /
        // `append_text_not_in_or_not_null`, column `b.priority`) so routing
        // the Search metadata path through this projection is a
        // zero-behaviour-change cutover. See `compile_state` for the
        // per-branch INCLUDE/EXCLUDE/is_null rationale (identical shape).
        in_or_null("b.priority", values, is_null, exclude)
    }
    fn compile_state(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        // #1280 — canonical Pages SQL for the `state:` leaf, byte-shape
        // identical to the LEGACY FTS metadata oracle
        // (`fts::metadata_filter::append_text_in_or_null` /
        // `append_text_not_in_or_not_null`, column `b.todo_state`) so
        // routing the Search metadata path through this projection (B2) is a
        // zero-behaviour-change cutover.
        //
        // INCLUDE (`!exclude`) — `append_text_in_or_null`:
        //   `(col IN (?,…) OR col IS NULL)`. Empty values + `!is_null` emits
        //   NO clause (a no-op `1=1`), exactly as the legacy helper returns
        //   early. With only `is_null` → `(col IS NULL)`; with only values →
        //   `(col IN (?,…))`.
        //
        // EXCLUDE — `append_text_not_in_or_not_null`:
        //   `(col IS NULL OR col NOT IN (?,…))` — the `IS NULL` branch lives
        //   OUTSIDE the `IN` list by design (NULL-state rows count as "not in
        //   the excluded set"), which also sidesteps the 3-valued
        //   `NOT IN (…, NULL)` trap. The `is_null` flag ADDS `OR col IS NOT
        //   NULL` (the legacy `not-state:none` sentinel → "exclude blocks
        //   with no state"). Empty values + `!is_null` emits a no-op `1=1`.
        in_or_null("b.todo_state", values, is_null, exclude)
    }
    fn compile_block_type(&self, values: &[String], exclude: bool) -> WhereClause {
        // #1280 — `b.block_type` is NOT NULL, so there is no `none`/NULL
        // sentinel. Empty `values` degenerates to the identity of the join:
        // an empty INCLUDE matches nothing (`1=0`), an empty EXCLUDE excludes
        // nothing (`1=1`) — mirroring `BacklinkProjection::compile_block_type`'s
        // empty-set short-circuit on the include side.
        if values.is_empty() {
            return WhereClause::new(if exclude { "1=1" } else { "1=0" }, Vec::new());
        }
        let placeholders = std::iter::repeat_n("?", values.len())
            .collect::<Vec<_>>()
            .join(", ");
        let op = if exclude { "NOT IN" } else { "IN" };
        WhereClause::new(
            format!("b.block_type {op} ({placeholders})"),
            values.iter().cloned().map(Bind::Text).collect(),
        )
    }
    fn compile_due_date(&self, predicate: &DatePredicate) -> WhereClause {
        pages_date_predicate(predicate, "b.due_date")
    }
    fn compile_scheduled(&self, predicate: &DatePredicate) -> WhereClause {
        pages_date_predicate(predicate, "b.scheduled_date")
    }
    fn compile_created(&self, after: Option<&str>, before: Option<&str>) -> WhereClause {
        // #1280 — ULID-prefix range over `b.id`, reusing the SAME
        // `parse_iso_to_ms` + `ms_to_ulid_prefix` conversion as
        // `BacklinkProjection::compile_created` so the two surfaces agree
        // byte-for-byte on the `Created` leaf. Each present bound becomes a
        // 10-char ULID prefix compared against the block id PK
        // (`b.id >= ?` for `after`, `b.id < ?` for `before`). Neither bound →
        // `1=1`. A malformed-but-present bound is treated as absent (the
        // `and_then` drops it); the Pages caller validates bounds loudly
        // upstream before routing, matching the BacklinkProjection contract.
        let after_prefix = after
            .and_then(crate::backlink::filters::parse_iso_to_ms)
            .map(crate::backlink::filters::ms_to_ulid_prefix);
        let before_prefix = before
            .and_then(crate::backlink::filters::parse_iso_to_ms)
            .map(crate::backlink::filters::ms_to_ulid_prefix);

        let mut clauses: Vec<&str> = Vec::new();
        let mut binds: Vec<Bind> = Vec::new();
        if let Some(lo) = after_prefix {
            clauses.push("b.id >= ?");
            binds.push(Bind::Text(lo));
        }
        if let Some(hi) = before_prefix {
            clauses.push("b.id < ?");
            binds.push(Bind::Text(hi));
        }
        let sql = if clauses.is_empty() {
            "1=1".to_string()
        } else {
            format!("({})", clauses.join(" AND "))
        };
        WhereClause::new(sql, binds)
    }
    fn compile_orphan(&self) -> WhereClause {
        // Orphan := no inbound block-link edges AND no outbound block-link
        // edges, both scoped page-wide. The inbound side is index-served
        // via the materialised `pc.inbound_link_count`. The outbound side
        // has no materialised counterpart yet (the materializer maintains
        // the page-level inbound aggregate only) — keep the `NOT EXISTS`
        // here, and file a follow-up to materialise an
        // `outbound_link_count` if measurement shows this term dominating.
        //
        // **Page-wide outbound semantic** (Phase-2 /
        // alignment): `block_links.source_id` is the *content* block that
        // authored the link, not the page block. Links normally live in the
        // body, so the outbound `NOT EXISTS` MUST cover every non-deleted
        // block on the page (`src.page_id = b.id`), mirroring the page-wide
        // inbound semantic below — not just edges typed on the page's title
        // row (`source_id = b.id`). Spec
        // Requires
        // `source_id IN (SELECT id FROM blocks WHERE page_id = …)`.
        //
        // **Inbound semantic** (Phase-2 alignment, refined by migration 0070
        // to exclude same-page,
        // self, and deleted-source edges — mirroring `backlink/grouped.rs`):
        // `pc.inbound_link_count` aggregates `block_links` edges whose
        // target is the page block *or any non-deleted descendant block*
        // (see migration 0069 lines 56-64 + the metadata IPC SELECT at
        // `commands/pages.rs:1660-1697`). This is broader than the
        // Phase-1 `target_id = b.id` placeholder — block-reference
        // `((ULID))` edges into a descendant content block now count as
        // inbound. The alignment is **intentional**: it makes the filter
        // match the inbound-link count rendered in `<DensityRow>` and
        // the `MostLinked` sort, so a user clicking `orphan:` after
        // seeing "0 ↗" on a row always agrees with the surfaced count.
        //
        // **Outbound target filtering:** the outbound `NOT
        // EXISTS` also joins the link's *target* block and requires
        // `tgt.deleted_at IS NULL` (a link into a soft-deleted target is
        // moot — the edge no longer reaches a live block) and excludes
        // same-page edges (`tgt.page_id != b.id` — a link from one block on
        // the page to another block on the same page is internal navigation,
        // not an outbound link to elsewhere). This mirrors the inbound D2
        // fix, which already excludes same-page / deleted-source edges from
        // `pc.inbound_link_count`. Purged targets need no handling: the
        // `block_links` FK cascades on delete, so an edge to a purged block
        // no longer exists.
        WhereClause::new(
            "COALESCE(pc.inbound_link_count, 0) = 0 \
             AND NOT EXISTS ( \
               SELECT 1 FROM block_links bl \
               JOIN blocks src ON bl.source_id = src.id \
               JOIN blocks tgt ON bl.target_id = tgt.id \
               WHERE src.page_id = b.id AND src.deleted_at IS NULL \
                 AND tgt.deleted_at IS NULL AND tgt.page_id != b.id \
             )",
            Vec::new(),
        )
    }
    fn compile_stub(&self) -> WhereClause {
        // Stub: a page whose only block is its own title row, i.e. zero
        // Non-title descendants. Matches the vocabulary spec
        // verbatim ("Page whose only block is its own title row (zero
        // Non-title descendants)", pending/-pages-view-compound-
        // filters.md:142). The prior `< 3` threshold was a Phase-1
        // placeholder. The new comparison is served by the materialised
        // `pc.child_block_count` column.
        WhereClause::new("COALESCE(pc.child_block_count, 0) = 0", Vec::new())
    }
    fn compile_has_no_inbound_links(&self) -> WhereClause {
        // Looser companion to Orphan: zero inbound block-link edges,
        // outbound side ignored. Same materialised column — and same
        // "page OR any non-deleted descendant" semantic, with same-page /
        // Self / deleted sources excluded — as the inbound
        // half of Orphan; see that fn's doc comment for the
        // Alignment rationale.
        WhereClause::new("COALESCE(pc.inbound_link_count, 0) = 0", Vec::new())
    }
}

/// Search-surface projection. Phase 1 stubs — Phase 2 wires them into
/// `fts::search` once the existing `SearchFilter` paths are reshaped.
#[derive(Debug, Clone, Copy, Default)]
pub struct SearchProjection;

impl Projection for SearchProjection {
    fn allowed_keys() -> &'static HashSet<&'static str> {
        &SEARCH_ALLOWED_KEYS
    }
    fn compile_tag(&self, tag: &str) -> WhereClause {
        WhereClause::new(
            "b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?)",
            vec![Bind::Text(tag.to_string())],
        )
    }
    fn compile_tag_or_ref(&self, tag: &str) -> WhereClause {
        // Mirrors `compile_tag`'s `b.id` alias (Search's tag leaf, like Pages,
        // keys on `b.id`); ref-inclusive UNION of attached + inline refs.
        WhereClause::new(
            "b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ? \
             UNION SELECT source_id FROM block_tag_refs WHERE tag_id = ?)",
            vec![Bind::Text(tag.to_string()), Bind::Text(tag.to_string())],
        )
    }
    fn compile_path_glob(&self, pattern: &str, exclude: bool) -> WhereClause {
        // #1320 Search keeps the LEGACY `LOWER(title) GLOB ?`
        // dialect verbatim (NOT the Pages `COLLATE NOCASE LIKE` form), so
        // routing the FTS path-glob filter through `SearchProjection` is a
        // ZERO-behaviour-change cutover: search users keep their current
        // `GLOB` + brace + `[class]` semantics. This emits the single-
        // pattern fragment matching one term of the legacy
        // `append_page_glob_subselect` OR-chain:
        //   `b.page_id [NOT ]IN (SELECT page_id FROM pages_cache
        //                        WHERE LOWER(title) GLOB ?)`
        // The `pattern` is ALREADY brace-expanded, substring-wrapped and
        // ASCII-lowercased by `prepare_globs` (the column-side `LOWER()`
        // folds ASCII only, so both sides agree per #381) — this method
        // does NOT itself preprocess. The caller
        // (`add_page_globs_via_projection`) OR-joins the include fragments
        // and AND-joins the exclude fragments to reproduce the legacy
        // set-union / set-difference semantics.
        //
        // Pages (`PagesProjection::compile_path_glob`) is INTENTIONALLY
        // different (`COLLATE NOCASE LIKE`) and is NOT touched here.
        let op = if exclude { "NOT IN" } else { "IN" };
        WhereClause::new(
            format!("b.page_id {op} (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)"),
            vec![Bind::Text(pattern.to_string())],
        )
    }
    fn compile_has_property(&self, key: &str, predicate: &PropertyPredicate) -> WhereClause {
        // Identical to PagesProjection for now — the value/op semantics
        // are shared. Per-surface column differences emerge later.
        PagesProjection.compile_has_property(key, predicate)
    }
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause {
        PagesProjection.compile_last_edited(spec)
    }
    fn compile_space(&self, space_id: &str) -> WhereClause {
        PagesProjection.compile_space(space_id)
    }
    fn compile_priority(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        PagesProjection.compile_priority(values, is_null, exclude)
    }
    // #1280 B2 — the search metadata leaves (`state:` / `block-type:` /
    // `due-date:` / `scheduled:`) DELEGATE to the canonical `PagesProjection`
    // SQL (merged in A2), exactly as `compile_space` / `compile_has_property`
    // already delegate. The A2 SQL was authored byte-shape-identical to the
    // legacy FTS metadata oracle (`fts::metadata_filter::append_text_in_or_null`
    // / `append_text_not_in_or_not_null` / `append_date_predicate`, column
    // alias `b`), so routing the FTS path through these is a zero-behaviour-
    // change cutover. Both projections use the `b` alias, so the fragment is
    // alias-compatible verbatim — no rewrite needed.
    fn compile_state(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        PagesProjection.compile_state(values, is_null, exclude)
    }
    fn compile_block_type(&self, values: &[String], exclude: bool) -> WhereClause {
        PagesProjection.compile_block_type(values, exclude)
    }
    fn compile_due_date(&self, predicate: &DatePredicate) -> WhereClause {
        PagesProjection.compile_due_date(predicate)
    }
    fn compile_scheduled(&self, predicate: &DatePredicate) -> WhereClause {
        PagesProjection.compile_scheduled(predicate)
    }
    fn compile_regex(&self, pattern: &str) -> WhereClause {
        // Search uses a post-FTS regex pass. Phase 2 wires this to the
        // existing `is_regex` path in `fts::search`.
        WhereClause::new(
            "1=1 /* REGEX: handled by post-filter */",
            vec![Bind::Text(pattern.to_string())],
        )
    }
    fn compile_case_sensitive(&self, enabled: bool) -> WhereClause {
        WhereClause::new(format!("1=1 /* CASE_SENSITIVE = {enabled} */"), Vec::new())
    }
    fn compile_whole_word(&self, enabled: bool) -> WhereClause {
        WhereClause::new(format!("1=1 /* WHOLE_WORD = {enabled} */"), Vec::new())
    }
    fn compile_snippet(&self, _spec: &SnippetSpec) -> WhereClause {
        WhereClause::new("1=1 /* SNIPPET */", Vec::new())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_projection_allows_shared_and_pages_keys_only() {
        let allowed = PagesProjection::allowed_keys();
        for k in [
            "tag",
            "path",
            "has-property",
            "last-edited",
            "space",
            "priority",
            "orphan",
            "stub",
            "has-no-inbound-links",
        ] {
            assert!(allowed.contains(k), "Pages must allow `{k}`");
        }
        for k in ["regex", "case-sensitive", "whole-word", "snippet"] {
            assert!(!allowed.contains(k), "Pages must NOT allow `{k}`");
        }
    }

    #[test]
    fn search_projection_allows_shared_and_search_keys_only() {
        let allowed = SearchProjection::allowed_keys();
        for k in [
            "tag",
            "path",
            "has-property",
            "last-edited",
            "space",
            "priority",
            "regex",
            "case-sensitive",
            "whole-word",
            "snippet",
        ] {
            assert!(allowed.contains(k), "Search must allow `{k}`");
        }
        for k in ["orphan", "stub", "has-no-inbound-links"] {
            assert!(!allowed.contains(k), "Search must NOT allow `{k}`");
        }
    }

    /// -C — exhaustive consistency check across the three
    /// hand-written allowed-key sites (`allowed_key()`,
    /// `PAGES_ALLOWED_KEYS`, `SEARCH_ALLOWED_KEYS`). Every
    /// `FilterPrimitive` variant's `allowed_key()` token MUST appear in at
    /// least one surface's static set — otherwise a typo would permanently
    /// mis-gate that primitive on every surface. The match below is
    /// exhaustive, so adding a variant without an `allowed_key()` arm (and
    /// a slot in this list) fails to compile.
    #[test]
    fn every_primitive_allowed_key_belongs_to_a_surface_set() {
        let all = [
            FilterPrimitive::Tag { tag: "t".into() },
            FilterPrimitive::TagOrRef { tag: "t".into() },
            FilterPrimitive::PathGlob {
                pattern: "p".into(),
                exclude: false,
            },
            FilterPrimitive::HasProperty {
                key: "k".into(),
                predicate: PropertyPredicate::Exists,
            },
            FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Rolling { days: 7 },
            },
            FilterPrimitive::Space {
                space_id: "s".into(),
            },
            FilterPrimitive::Priority {
                values: vec!["A".into()],
                is_null: false,
                exclude: false,
            },
            FilterPrimitive::State {
                values: vec!["TODO".into()],
                is_null: false,
                exclude: false,
            },
            FilterPrimitive::BlockType {
                values: vec!["task".into()],
                exclude: false,
            },
            FilterPrimitive::DueDate {
                predicate: DatePredicate::On {
                    date: "2026-01-01".into(),
                },
            },
            FilterPrimitive::Scheduled {
                predicate: DatePredicate::IsNull,
            },
            FilterPrimitive::Created {
                after: Some("2026-01-01".into()),
                before: None,
            },
            FilterPrimitive::LinksTo {
                target: "01TARGET00000000000000000T".into(),
            },
            FilterPrimitive::LinkedFrom {
                source: "01SOURCE00000000000000000S".into(),
            },
            FilterPrimitive::HasParentMatching {
                matcher: Box::new(crate::filters::FilterExpr::Leaf {
                    primitive: FilterPrimitive::State {
                        values: vec!["TODO".into()],
                        is_null: false,
                        exclude: false,
                    },
                }),
            },
            FilterPrimitive::Orphan,
            FilterPrimitive::Stub,
            FilterPrimitive::HasNoInboundLinks,
            FilterPrimitive::Regex {
                pattern: "x".into(),
            },
            FilterPrimitive::CaseSensitive { enabled: true },
            FilterPrimitive::WholeWord { enabled: true },
            FilterPrimitive::Snippet {
                spec: SnippetSpec {
                    max_tokens: 5,
                    left_marker: "<".into(),
                    right_marker: ">".into(),
                },
            },
        ];
        // Compile-time exhaustiveness guard — if a variant is added,
        // this match must gain an arm, forcing the author to extend
        // `all` above too.
        for prim in &all {
            #[allow(clippy::match_same_arms)]
            match prim {
                FilterPrimitive::Tag { .. }
                | FilterPrimitive::TagOrRef { .. }
                | FilterPrimitive::PathGlob { .. }
                | FilterPrimitive::HasProperty { .. }
                | FilterPrimitive::LastEdited { .. }
                | FilterPrimitive::Space { .. }
                | FilterPrimitive::Priority { .. }
                | FilterPrimitive::State { .. }
                | FilterPrimitive::BlockType { .. }
                | FilterPrimitive::DueDate { .. }
                | FilterPrimitive::Scheduled { .. }
                | FilterPrimitive::Created { .. }
                | FilterPrimitive::LinksTo { .. }
                | FilterPrimitive::LinkedFrom { .. }
                | FilterPrimitive::HasParentMatching { .. }
                | FilterPrimitive::Orphan
                | FilterPrimitive::Stub
                | FilterPrimitive::HasNoInboundLinks
                | FilterPrimitive::Regex { .. }
                | FilterPrimitive::CaseSensitive { .. }
                | FilterPrimitive::WholeWord { .. }
                | FilterPrimitive::Snippet { .. } => {}
            }
        }
        for prim in &all {
            let key = prim.allowed_key();
            assert!(
                PAGES_ALLOWED_KEYS.contains(key)
                    || SEARCH_ALLOWED_KEYS.contains(key)
                    || crate::backlink::projection::BACKLINK_ALLOWED_KEYS.contains(key)
                    // #1455 — the relational predicates (`links-to` /
                    // `linked-from` / `has-parent-matching`) live ONLY on the
                    // advanced-query surface (QUERY_ALLOWED_KEYS); they are not
                    // (yet) offered on Pages / Search / Backlink.
                    || crate::query::QUERY_ALLOWED_KEYS.contains(key),
                "`{key}` (allowed_key of {prim:?}) is in none of \
                 PAGES_ALLOWED_KEYS / SEARCH_ALLOWED_KEYS / BACKLINK_ALLOWED_KEYS / QUERY_ALLOWED_KEYS"
            );
        }
    }

    #[test]
    fn pages_projection_compiles_shared_primitives() {
        let p = PagesProjection;
        let where_tag = p.compile(&FilterPrimitive::Tag {
            tag: "01TAG000000000000000000T1".into(),
        });
        assert!(where_tag.sql.contains("block_tags"));
        assert_eq!(where_tag.binds.len(), 1);

        let where_priority = p.compile(&FilterPrimitive::Priority {
            values: vec!["A".into()],
            is_null: false,
            exclude: false,
        });
        assert_eq!(where_priority.sql, "(b.priority IN (?))");

        let where_space = p.compile(&FilterPrimitive::Space {
            space_id: "01SPACE0001".into(),
        });
        assert!(where_space.sql.contains("b.space_id = ?"));
    }

    #[test]
    fn pages_projection_supports_orphan_stub_and_has_no_inbound() {
        let p = PagesProjection;
        for prim in [
            FilterPrimitive::Orphan,
            FilterPrimitive::Stub,
            FilterPrimitive::HasNoInboundLinks,
        ] {
            let w = p.compile(&prim);
            assert!(
                !w.is_unsupported(),
                "Pages must support {prim:?} (got unsupported)"
            );
        }
    }

    /// Phase 2 — snapshot the exact SQL fragments emitted by
    /// the three Pages-only grooming primitives. These reference the
    /// Materialised `pages_cache` columns, not the
    /// Pre- correlated subqueries. The composition site MUST
    /// have `LEFT JOIN pages_cache pc ON pc.page_id = b.id` in scope.
    #[test]
    fn pages_only_primitives_emit_materialised_pages_cache_sql() {
        let p = PagesProjection;

        let orphan = p.compile(&FilterPrimitive::Orphan);
        assert_eq!(
            orphan.sql,
            "COALESCE(pc.inbound_link_count, 0) = 0 \
             AND NOT EXISTS ( \
               SELECT 1 FROM block_links bl \
               JOIN blocks src ON bl.source_id = src.id \
               JOIN blocks tgt ON bl.target_id = tgt.id \
               WHERE src.page_id = b.id AND src.deleted_at IS NULL \
                 AND tgt.deleted_at IS NULL AND tgt.page_id != b.id \
             )",
            "Orphan must read the materialised inbound count from pages_cache, \
             scope its outbound NOT EXISTS page-wide (every non-deleted block), \
             and filter the target: live target + not same-page"
        );
        assert!(orphan.binds.is_empty(), "Orphan takes no binds");

        let stub = p.compile(&FilterPrimitive::Stub);
        assert_eq!(
            stub.sql, "COALESCE(pc.child_block_count, 0) = 0",
            "Stub must compare child_block_count == 0 (\"zero non-title descendants\")"
        );
        assert!(stub.binds.is_empty(), "Stub takes no binds");

        let hnil = p.compile(&FilterPrimitive::HasNoInboundLinks);
        assert_eq!(
            hnil.sql, "COALESCE(pc.inbound_link_count, 0) = 0",
            "HasNoInboundLinks must read the materialised inbound count from pages_cache"
        );
        assert!(hnil.binds.is_empty(), "HasNoInboundLinks takes no binds");

        // Regression guard — the pre- shapes must NOT reappear.
        for w in [&orphan, &stub, &hnil] {
            assert!(
                !w.sql.contains("d.page_id = b.id"),
                "fragment must not regress to the COUNT(*) subquery shape: `{}`",
                w.sql
            );
        }
        assert!(
            !stub.sql.contains("block_links"),
            "Stub must not touch block_links: `{}`",
            stub.sql
        );
        assert!(
            !hnil.sql.contains("block_links"),
            "HasNoInboundLinks must not touch block_links: `{}`",
            hnil.sql
        );
    }

    /// Phase 2 — confirms the LastEditedSpec variants already
    /// cover the plan's bucket vocabulary so no new variant is needed.
    /// See the doc comment on `LastEditedSpec` for the chip-token map.
    #[test]
    fn last_edited_spec_covers_pend58_bucket_vocabulary() {
        let p = PagesProjection;
        // `today` → Rolling { days: 1 }
        let today = p.compile(&FilterPrimitive::LastEdited {
            spec: LastEditedSpec::Rolling { days: 1 },
        });
        assert_eq!(today.binds, vec![Bind::Text("-1 days".to_string())]);
        // `this-week` → Rolling { days: 7 }
        let week = p.compile(&FilterPrimitive::LastEdited {
            spec: LastEditedSpec::Rolling { days: 7 },
        });
        assert_eq!(week.binds, vec![Bind::Text("-7 days".to_string())]);
        // `this-month` → Rolling { days: 30 }
        let month = p.compile(&FilterPrimitive::LastEdited {
            spec: LastEditedSpec::Rolling { days: 30 },
        });
        assert_eq!(month.binds, vec![Bind::Text("-30 days".to_string())]);
        // `older` → OlderThan { days: 30 }
        let older = p.compile(&FilterPrimitive::LastEdited {
            spec: LastEditedSpec::OlderThan { days: 30 },
        });
        assert!(older.sql.contains('<'), "OlderThan must use `<` comparator");
        assert_eq!(older.binds, vec![Bind::Text("-30 days".to_string())]);
    }

    #[test]
    fn search_projection_rejects_pages_only_primitives_via_default_unsupported() {
        let p = SearchProjection;
        for prim in [
            FilterPrimitive::Orphan,
            FilterPrimitive::Stub,
            FilterPrimitive::HasNoInboundLinks,
        ] {
            let w = p.compile(&prim);
            assert!(
                w.is_unsupported(),
                "Search must NOT support {prim:?} (got `{}`)",
                w.sql
            );
        }
    }

    #[test]
    fn pages_projection_rejects_search_only_primitives_via_default_unsupported() {
        let p = PagesProjection;
        for prim in [
            FilterPrimitive::Regex {
                pattern: "foo".into(),
            },
            FilterPrimitive::CaseSensitive { enabled: true },
            FilterPrimitive::WholeWord { enabled: true },
            FilterPrimitive::Snippet {
                spec: SnippetSpec {
                    max_tokens: 5,
                    left_marker: "<".into(),
                    right_marker: ">".into(),
                },
            },
        ] {
            let w = p.compile(&prim);
            assert!(
                w.is_unsupported(),
                "Pages must NOT support {prim:?} (got `{}`)",
                w.sql
            );
        }
    }

    #[test]
    fn has_property_compiles_for_all_predicate_value_combos() {
        // D26 — every valid predicate × value combo compiles to real SQL;
        // none falls through to `unsupported()`. Covers the Ref/Ne case
        // that the pre-D8 shape rejected.
        let p = PagesProjection;

        let eq_text = FilterPrimitive::HasProperty {
            key: "kind".into(),
            predicate: PropertyPredicate::Eq {
                value: PropertyValue::Text {
                    value: "note".into(),
                },
            },
        };
        let w = p.compile(&eq_text);
        assert!(!w.is_unsupported());
        assert!(w.sql.contains("EXISTS") && w.sql.contains("value_text = ?"));
        assert_eq!(w.binds.len(), 2);

        let exists = FilterPrimitive::HasProperty {
            key: "kind".into(),
            predicate: PropertyPredicate::Exists,
        };
        let w = p.compile(&exists);
        assert!(!w.is_unsupported());
        assert!(w.sql.contains("EXISTS"));
        assert_eq!(w.binds.len(), 1);

        let not_exists = FilterPrimitive::HasProperty {
            key: "kind".into(),
            predicate: PropertyPredicate::NotExists,
        };
        let w = p.compile(&not_exists);
        assert!(!w.is_unsupported());
        assert!(w.sql.contains("NOT EXISTS"));

        let ne_text = FilterPrimitive::HasProperty {
            key: "kind".into(),
            predicate: PropertyPredicate::Ne {
                value: PropertyValue::Text {
                    value: "draft".into(),
                },
            },
        };
        let w = p.compile(&ne_text);
        assert!(!w.is_unsupported());
        assert!(w.sql.contains("NOT EXISTS") && w.sql.contains("value_text = ?"));

        // D26 — Eq/Ne over a `Ref` value compare `value_ref` (the
        // previously-rejected case).
        let eq_ref = FilterPrimitive::HasProperty {
            key: "parent".into(),
            predicate: PropertyPredicate::Eq {
                value: PropertyValue::Ref {
                    value: "01REF".into(),
                },
            },
        };
        let w = p.compile(&eq_ref);
        assert!(!w.is_unsupported());
        assert!(w.sql.contains("EXISTS") && w.sql.contains("value_ref = ?"));
        assert_eq!(w.binds.len(), 2);

        let ne_ref = FilterPrimitive::HasProperty {
            key: "parent".into(),
            predicate: PropertyPredicate::Ne {
                value: PropertyValue::Ref {
                    value: "01REF".into(),
                },
            },
        };
        let w = p.compile(&ne_ref);
        assert!(!w.is_unsupported());
        assert!(w.sql.contains("NOT EXISTS") && w.sql.contains("value_ref = ?"));
        assert_eq!(w.binds.len(), 2);
    }

    #[test]
    fn last_edited_rolling_vs_older_than_compile_different_clauses() {
        let p = PagesProjection;
        let rolling = p.compile(&FilterPrimitive::LastEdited {
            spec: LastEditedSpec::Rolling { days: 7 },
        });
        let older = p.compile(&FilterPrimitive::LastEdited {
            spec: LastEditedSpec::OlderThan { days: 7 },
        });
        assert!(rolling.sql.contains(">="));
        assert!(older.sql.contains('<'));
        // Both bind a "-7 days" sentinel.
        assert_eq!(rolling.binds, vec![Bind::Text("-7 days".to_string())]);
        assert_eq!(older.binds, vec![Bind::Text("-7 days".to_string())]);
    }

    #[test]
    fn last_edited_range_extends_bare_end_date_to_end_of_day() {
        // A bare `YYYY-MM-DDend` is extended to the last
        // instant of that day so daytime edits on the end day are INCLUDED.
        // #109 Phase 2: bounds are converted to INTEGER epoch-ms (matching
        // `op_log.created_at`); a bare `start` is anchored at midnight. The
        // clause is `>= start_ms AND <= end_ms`.
        let p = PagesProjection;
        let bare = p.compile(&FilterPrimitive::LastEdited {
            spec: LastEditedSpec::Range {
                start: "2026-02-01".into(),
                end: "2026-03-01".into(),
            },
        });
        assert!(
            bare.sql.contains(">= ?") && bare.sql.contains("<= ?"),
            "Range must compile to `>= ? AND <= ?` (not a verbatim BETWEEN); got: {}",
            bare.sql
        );
        assert_eq!(
            bare.binds,
            vec![
                Bind::Int(1_769_904_000_000), // 2026-02-01T00:00:00Z (midnight)
                Bind::Int(1_772_409_599_999), // 2026-03-01T23:59:59.999Z (end of day)
            ],
            "a bare-date end must be extended to end-of-day; bare start anchored at midnight"
        );

        // A full RFC 3339 `end` is converted verbatim — the caller asked for
        // an exact instant, no end-of-day extension.
        let rfc = p.compile(&FilterPrimitive::LastEdited {
            spec: LastEditedSpec::Range {
                start: "2026-02-01T00:00:00Z".into(),
                end: "2026-03-01T12:00:00Z".into(),
            },
        });
        assert_eq!(
            rfc.binds,
            vec![
                Bind::Int(1_769_904_000_000), // 2026-02-01T00:00:00Z
                Bind::Int(1_772_366_400_000), // 2026-03-01T12:00:00Z
            ],
            "an RFC 3339 end must be converted verbatim (no extension)"
        );
    }

    #[test]
    fn last_edited_all_variants_coalesce_no_op_log_to_common_epoch() {
        // The "no op-log ⇒ epoch" rule must be uniform: ALL
        // three variants COALESCE the page's last-edited expression to the
        // SAME epoch sentinel so a no-op-log page is handled consistently
        // (excluded by Rolling/Range, included by OlderThan). Before the fix
        // Rolling/Range omitted the COALESCE (NULL → dropped) while OlderThan
        // used a `'0001-01-01'` sentinel — the asymmetry D7 closes.
        // #109 Phase 2: the sentinel is now the INTEGER epoch-ms `0`.
        const EPOCH: &str = ", 0)"; // COALESCE(..., 0)
        let p = PagesProjection;
        for spec in [
            LastEditedSpec::Rolling { days: 7 },
            LastEditedSpec::OlderThan { days: 7 },
            LastEditedSpec::Range {
                start: "2026-01-01".into(),
                end: "2026-02-01".into(),
            },
        ] {
            let wc = p.compile(&FilterPrimitive::LastEdited { spec: spec.clone() });
            assert!(
                wc.sql.contains("COALESCE"),
                "{spec:?} must COALESCE the last-edited expression; got: {}",
                wc.sql
            );
            assert!(
                wc.sql.contains(EPOCH),
                "{spec:?} must COALESCE to the common epoch sentinel {EPOCH}; got: {}",
                wc.sql
            );
        }
    }

    #[test]
    fn cross_surface_compatibility_tag_compiles_identically() {
        // The `tag:` primitive is shared and MUST compile to the same
        // SQL fragment on both surfaces — this is the load-bearing
        // invariant for the saved-views round-trip (Pages → Search).
        let tag = FilterPrimitive::Tag {
            tag: "01TAG".into(),
        };
        let pages = PagesProjection.compile(&tag);
        let search = SearchProjection.compile(&tag);
        assert_eq!(pages.sql, search.sql);
        assert_eq!(pages.binds, search.binds);
    }

    #[test]
    fn tag_or_ref_emits_union_of_attached_and_inline_refs() {
        // `TagOrRef` is the ref-inclusive sibling of `Tag`: it must UNION the
        // attached `block_tags` rows with the inline `block_tag_refs`
        // (`source_id`) references, binding the tag id TWICE (once per
        // sub-select). `Tag` stays attached-only.
        let prim = FilterPrimitive::TagOrRef {
            tag: "01TAG000000000000000000T1".into(),
        };
        for proj_sql in [
            PagesProjection.compile(&prim),
            SearchProjection.compile(&prim),
            crate::query::QueryProjection.compile(&prim),
        ] {
            assert!(proj_sql.sql.contains("block_tags"));
            assert!(proj_sql.sql.contains("UNION"));
            assert!(proj_sql.sql.contains("block_tag_refs"));
            assert!(proj_sql.sql.contains("source_id"));
            assert_eq!(proj_sql.binds.len(), 2, "tag id bound once per sub-select");
            assert_eq!(
                proj_sql.binds,
                vec![
                    Bind::Text("01TAG000000000000000000T1".into()),
                    Bind::Text("01TAG000000000000000000T1".into()),
                ]
            );
        }

        // `TagOrRef` is ref-INCLUSIVE; plain `Tag` stays attached-only (no
        // UNION / no `block_tag_refs`).
        let attached_only = PagesProjection.compile(&FilterPrimitive::Tag {
            tag: "01TAG000000000000000000T1".into(),
        });
        assert!(!attached_only.sql.contains("UNION"));
        assert!(!attached_only.sql.contains("block_tag_refs"));
    }

    #[test]
    fn where_clause_unsupported_sentinel_is_detectable() {
        let unsup = WhereClause::unsupported();
        assert!(unsup.is_unsupported());
        let normal = WhereClause::new("1=1", Vec::new());
        assert!(!normal.is_unsupported());
    }

    #[test]
    fn cost_hint_orders_index_backed_before_full_scan() {
        // Index-backed primitives are cheapest (0).
        assert_eq!(FilterPrimitive::Tag { tag: "t".into() }.cost_hint(), 0);
        assert_eq!(FilterPrimitive::Stub.cost_hint(), 0);
        assert_eq!(FilterPrimitive::HasNoInboundLinks.cost_hint(), 0);
        assert_eq!(
            FilterPrimitive::Space {
                space_id: "s".into()
            }
            .cost_hint(),
            0
        );
        // Priority — per-row equality, cheap (1).
        assert_eq!(
            FilterPrimitive::Priority {
                values: vec!["A".into()],
                is_null: false,
                exclude: false,
            }
            .cost_hint(),
            1
        );
        // LastEdited — per-row correlated MAX() subquery (served via
        // idx_op_log_block_id), ranks with Priority above the true
        // index anti-joins (1), not at 0.
        assert_eq!(
            FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Rolling { days: 7 }
            }
            .cost_hint(),
            1
        );
        // Every `PathGlob` is a full `pages_cache.title` scan (2):
        // SQLite won't use a NOCASE index for a case-insensitive `LIKE`,
        // so anchoring (`foo*`), a leading wildcard (`*foo*`), and a bare
        // substring word (`alpha` → `%alpha%`) all rank the same.
        assert_eq!(
            FilterPrimitive::PathGlob {
                pattern: "foo*".into(),
                exclude: false
            }
            .cost_hint(),
            2
        );
        assert_eq!(
            FilterPrimitive::PathGlob {
                pattern: "*foo*".into(),
                exclude: false
            }
            .cost_hint(),
            2
        );
        assert_eq!(
            FilterPrimitive::PathGlob {
                pattern: "alpha".into(),
                exclude: false
            }
            .cost_hint(),
            2
        );
        // `Orphan` ranks in the expensive tier (3): its outbound half is a
        // 3-table correlated subquery with no materialised counterpart yet
        // (; matches docs/architecture/filters.md). It must
        // sort AFTER the genuinely index-backed clauses so they pre-narrow.
        assert_eq!(FilterPrimitive::Orphan.cost_hint(), 3);
        // Search-only post-filters are ranked last (3).
        assert_eq!(
            FilterPrimitive::Regex {
                pattern: "x".into()
            }
            .cost_hint(),
            3
        );
    }

    #[test]
    fn filter_primitive_serde_round_trip_is_internally_tagged() {
        // Struct variant with a single field → `{ "type": "Tag", "tag": … }`.
        let tag = FilterPrimitive::Tag {
            tag: "01TAG".into(),
        };
        let json = serde_json::to_string(&tag).unwrap();
        assert_eq!(json, r#"{"type":"Tag","tag":"01TAG"}"#);
        let back: FilterPrimitive = serde_json::from_str(&json).unwrap();
        assert_eq!(back, tag);

        // Unit variant → just the tag.
        let orphan = FilterPrimitive::Orphan;
        assert_eq!(
            serde_json::to_string(&orphan).unwrap(),
            r#"{"type":"Orphan"}"#
        );

        // Nested internally-tagged sub-type.
        let le = FilterPrimitive::LastEdited {
            spec: LastEditedSpec::Range {
                start: "2026-01-01".into(),
                end: "2026-02-01".into(),
            },
        };
        let json = serde_json::to_string(&le).unwrap();
        let back: FilterPrimitive = serde_json::from_str(&json).unwrap();
        assert_eq!(back, le);
    }

    #[test]
    fn allowed_key_matches_surface_static_sets() {
        // Every primitive's `allowed_key()` is present in at least one
        // surface's allow-list — the gate uses this token to admit/reject.
        for prim in [
            FilterPrimitive::Tag { tag: "t".into() },
            FilterPrimitive::Orphan,
            FilterPrimitive::Regex {
                pattern: "x".into(),
            },
        ] {
            let key = prim.allowed_key();
            assert!(
                PAGES_ALLOWED_KEYS.contains(key) || SEARCH_ALLOWED_KEYS.contains(key),
                "`{key}` must be in some surface allow-list"
            );
        }
        // Pages-only key is not in the Search set.
        assert!(PAGES_ALLOWED_KEYS.contains(FilterPrimitive::Orphan.allowed_key()));
        assert!(!SEARCH_ALLOWED_KEYS.contains(FilterPrimitive::Orphan.allowed_key()));
    }

    // ── #1280 A2 — canonical Pages SQL for the new metadata leaves ────────
    // Each test pins the emitted SQL + binds AND, where the canonical form
    // must equal the legacy `fts::metadata_filter` oracle, documents the
    // matching shape.

    #[test]
    fn pages_state_include_emits_in_or_null() {
        let p = PagesProjection;
        // Values only → `(col IN (?, ?))`, matching
        // `append_text_in_or_null` (no IS NULL part).
        let w = p.compile(&FilterPrimitive::State {
            values: vec!["TODO".into(), "DOING".into()],
            is_null: false,
            exclude: false,
        });
        assert_eq!(w.sql, "(b.todo_state IN (?, ?))");
        assert_eq!(
            w.binds,
            vec![Bind::Text("TODO".into()), Bind::Text("DOING".into())]
        );

        // Values + none-sentinel → `(col IN (?) OR col IS NULL)`.
        let w = p.compile(&FilterPrimitive::State {
            values: vec!["TODO".into()],
            is_null: true,
            exclude: false,
        });
        assert_eq!(w.sql, "(b.todo_state IN (?) OR b.todo_state IS NULL)");
        assert_eq!(w.binds, vec![Bind::Text("TODO".into())]);

        // none-sentinel only → `(col IS NULL)`.
        let w = p.compile(&FilterPrimitive::State {
            values: vec![],
            is_null: true,
            exclude: false,
        });
        assert_eq!(w.sql, "(b.todo_state IS NULL)");
        assert!(w.binds.is_empty());

        // Empty + no-null → no-op `1=1` (legacy helper emits no clause).
        let w = p.compile(&FilterPrimitive::State {
            values: vec![],
            is_null: false,
            exclude: false,
        });
        assert_eq!(w.sql, "1=1");
        assert!(w.binds.is_empty());
    }

    #[test]
    fn pages_state_exclude_keeps_null_outside_the_in_list() {
        let p = PagesProjection;
        // Exclude values → `(col IS NULL OR col NOT IN (?, ?))`. The IS NULL
        // Branch is OUTSIDE the IN list (legacy / 3-valued NOT IN trap
        // guard) so NULL-state rows are KEPT, not dropped.
        let w = p.compile(&FilterPrimitive::State {
            values: vec!["DONE".into(), "CANCELLED".into()],
            is_null: false,
            exclude: true,
        });
        assert_eq!(
            w.sql,
            "(b.todo_state IS NULL OR b.todo_state NOT IN (?, ?))"
        );
        assert_eq!(
            w.binds,
            vec![Bind::Text("DONE".into()), Bind::Text("CANCELLED".into())]
        );
        // The NULL element is never inside the IN list.
        assert!(!w.sql.contains("IN (?, ?, b.todo_state IS NULL)"));

        // Exclude values + none-sentinel → adds `OR col IS NOT NULL`
        // (`not-state:none` → "exclude blocks with no state").
        let w = p.compile(&FilterPrimitive::State {
            values: vec!["DONE".into()],
            is_null: true,
            exclude: true,
        });
        assert_eq!(
            w.sql,
            "(b.todo_state IS NULL OR b.todo_state NOT IN (?) OR b.todo_state IS NOT NULL)"
        );
        assert_eq!(w.binds, vec![Bind::Text("DONE".into())]);

        // Exclude none-sentinel only → `(col IS NOT NULL)`.
        let w = p.compile(&FilterPrimitive::State {
            values: vec![],
            is_null: true,
            exclude: true,
        });
        assert_eq!(w.sql, "(b.todo_state IS NOT NULL)");
        assert!(w.binds.is_empty());

        // Exclude empty + no-null → no-op `1=1`.
        let w = p.compile(&FilterPrimitive::State {
            values: vec![],
            is_null: false,
            exclude: true,
        });
        assert_eq!(w.sql, "1=1");
    }

    #[test]
    fn pages_state_matches_legacy_metadata_oracle_shape() {
        // The canonical Pages `state:` SQL must reproduce the legacy
        // `fts::metadata_filter::append_text_in_or_null` /
        // `append_text_not_in_or_not_null` boolean shape (the legacy helpers
        // are module-private, so — like the BacklinkProjection byte-identity
        // tests — the expected boolean is pasted verbatim from those helpers
        // with the positional `?N` collapsed to `?` and the leading
        // "\n           AND " stripped, since the projection emits a
        // self-contained fragment the Pages composer AND-joins).
        //
        // INCLUDE: `append_text_in_or_null` builds
        //   `({col} IN (?, ?) OR {col} IS NULL)` for values + is_null.
        let pages = PagesProjection.compile(&FilterPrimitive::State {
            values: vec!["TODO".into(), "DOING".into()],
            is_null: true,
            exclude: false,
        });
        assert_eq!(
            pages.sql,
            "(b.todo_state IN (?, ?) OR b.todo_state IS NULL)"
        );

        // EXCLUDE: `append_text_not_in_or_not_null` builds
        //   `({col} IS NULL OR {col} NOT IN (?))` — NULL OUTSIDE the IN list.
        let pages = PagesProjection.compile(&FilterPrimitive::State {
            values: vec!["DONE".into()],
            is_null: false,
            exclude: true,
        });
        assert_eq!(
            pages.sql,
            "(b.todo_state IS NULL OR b.todo_state NOT IN (?))"
        );
    }

    #[test]
    fn pages_block_type_include_and_exclude() {
        let p = PagesProjection;
        let inc = p.compile(&FilterPrimitive::BlockType {
            values: vec!["task".into(), "note".into()],
            exclude: false,
        });
        assert_eq!(inc.sql, "b.block_type IN (?, ?)");
        assert_eq!(
            inc.binds,
            vec![Bind::Text("task".into()), Bind::Text("note".into())]
        );

        let exc = p.compile(&FilterPrimitive::BlockType {
            values: vec!["task".into()],
            exclude: true,
        });
        assert_eq!(exc.sql, "b.block_type NOT IN (?)");
        assert_eq!(exc.binds, vec![Bind::Text("task".into())]);

        // block_type is NOT NULL → no `IS NULL` sentinel ever appears.
        assert!(!inc.sql.contains("IS NULL"));
        assert!(!exc.sql.contains("IS NULL"));

        // Empty include matches nothing; empty exclude excludes nothing.
        let inc_empty = p.compile(&FilterPrimitive::BlockType {
            values: vec![],
            exclude: false,
        });
        assert_eq!(inc_empty.sql, "1=0");
        let exc_empty = p.compile(&FilterPrimitive::BlockType {
            values: vec![],
            exclude: true,
        });
        assert_eq!(exc_empty.sql, "1=1");
    }

    #[test]
    fn pages_due_date_all_variants_guard_is_not_null() {
        let p = PagesProjection;
        let on = p.compile(&FilterPrimitive::DueDate {
            predicate: DatePredicate::On {
                date: "2026-03-01".into(),
            },
        });
        // Canonical Pages form: `On` is exact `=` WITH the legacy
        // `IS NOT NULL` guard — matching the FTS oracle (DateOp::Eq), and
        // DEVIATING from BacklinkProjection's guard-less `b.due_date = ?`.
        assert_eq!(on.sql, "(b.due_date IS NOT NULL AND b.due_date = ?)");
        assert_eq!(on.binds, vec![Bind::Text("2026-03-01".into())]);

        for (pred, op) in [
            (
                DatePredicate::Before {
                    date: "2026-03-01".into(),
                },
                "<",
            ),
            (
                DatePredicate::After {
                    date: "2026-03-01".into(),
                },
                ">",
            ),
            (
                DatePredicate::OnOrBefore {
                    date: "2026-03-01".into(),
                },
                "<=",
            ),
            (
                DatePredicate::OnOrAfter {
                    date: "2026-03-01".into(),
                },
                ">=",
            ),
        ] {
            let w = p.compile(&FilterPrimitive::DueDate { predicate: pred });
            assert_eq!(
                w.sql,
                format!("(b.due_date IS NOT NULL AND b.due_date {op} ?)")
            );
            assert_eq!(w.binds, vec![Bind::Text("2026-03-01".into())]);
        }

        let between = p.compile(&FilterPrimitive::DueDate {
            predicate: DatePredicate::Between {
                from: "2026-03-01".into(),
                to: "2026-03-31".into(),
            },
        });
        assert_eq!(
            between.sql,
            "(b.due_date IS NOT NULL AND b.due_date BETWEEN ? AND ?)"
        );
        assert_eq!(
            between.binds,
            vec![
                Bind::Text("2026-03-01".into()),
                Bind::Text("2026-03-31".into())
            ]
        );

        let is_null = p.compile(&FilterPrimitive::DueDate {
            predicate: DatePredicate::IsNull,
        });
        assert_eq!(is_null.sql, "b.due_date IS NULL");
        assert!(is_null.binds.is_empty());
    }

    #[test]
    fn pages_scheduled_uses_scheduled_date_column() {
        let p = PagesProjection;
        let w = p.compile(&FilterPrimitive::Scheduled {
            predicate: DatePredicate::OnOrAfter {
                date: "2026-04-01".into(),
            },
        });
        assert_eq!(
            w.sql,
            "(b.scheduled_date IS NOT NULL AND b.scheduled_date >= ?)"
        );
        assert_eq!(w.binds, vec![Bind::Text("2026-04-01".into())]);
        // Distinct column from due_date.
        assert!(!w.sql.contains("due_date"));
    }

    #[test]
    fn pages_due_date_matches_legacy_date_predicate_oracle() {
        // The Pages `due-date:`/`scheduled:` SQL must reproduce the legacy
        // `fts::metadata_filter::append_date_predicate` shape: the column is
        // guarded `IS NOT NULL` and `On` (legacy `Op{DateOp::Eq}`) is an
        // EXACT `=` — NOT the half-open day expansion. The legacy emitter is
        // module-private, so the expected boolean is pasted verbatim (the
        // legacy text minus its leading "\n           AND " and with the
        // positional `?1` collapsed to `?`), then wrapped in the parens the
        // projection adds.
        //
        // Legacy `Op` body: `{col} IS NOT NULL AND {col} = ?`.
        let pages = PagesProjection.compile(&FilterPrimitive::DueDate {
            predicate: DatePredicate::On {
                date: "2026-03-01".into(),
            },
        });
        assert_eq!(pages.sql, "(b.due_date IS NOT NULL AND b.due_date = ?)");

        // Legacy `Range` body: `{col} IS NOT NULL AND {col} BETWEEN ? AND ?`.
        let pages = PagesProjection.compile(&FilterPrimitive::DueDate {
            predicate: DatePredicate::Between {
                from: "2026-03-01".into(),
                to: "2026-03-31".into(),
            },
        });
        assert_eq!(
            pages.sql,
            "(b.due_date IS NOT NULL AND b.due_date BETWEEN ? AND ?)"
        );
    }

    #[test]
    fn pages_created_ulid_prefix_range_matches_backlink() {
        let p = PagesProjection;
        // Both bounds → `(b.id >= ? AND b.id < ?)` with the SAME ULID
        // prefixes the BacklinkProjection produces.
        let both = p.compile(&FilterPrimitive::Created {
            after: Some("2026-01-01".into()),
            before: Some("2026-02-01".into()),
        });
        assert_eq!(both.sql, "(b.id >= ? AND b.id < ?)");
        let lo = crate::backlink::filters::ms_to_ulid_prefix(
            crate::backlink::filters::parse_iso_to_ms("2026-01-01").unwrap(),
        );
        let hi = crate::backlink::filters::ms_to_ulid_prefix(
            crate::backlink::filters::parse_iso_to_ms("2026-02-01").unwrap(),
        );
        assert_eq!(both.binds, vec![Bind::Text(lo), Bind::Text(hi)]);

        // Only after → `(b.id >= ?)`.
        let after_only = p.compile(&FilterPrimitive::Created {
            after: Some("2026-01-01".into()),
            before: None,
        });
        assert_eq!(after_only.sql, "(b.id >= ?)");
        assert_eq!(after_only.binds.len(), 1);

        // Only before → `(b.id < ?)`.
        let before_only = p.compile(&FilterPrimitive::Created {
            after: None,
            before: Some("2026-02-01".into()),
        });
        assert_eq!(before_only.sql, "(b.id < ?)");
        assert_eq!(before_only.binds.len(), 1);

        // Neither → `1=1`.
        let none = p.compile(&FilterPrimitive::Created {
            after: None,
            before: None,
        });
        assert_eq!(none.sql, "1=1");
        assert!(none.binds.is_empty());

        // Malformed bound is treated as absent (drops to no-op for that side).
        let bad = p.compile(&FilterPrimitive::Created {
            after: Some("not-a-date".into()),
            before: None,
        });
        assert_eq!(bad.sql, "1=1");
        assert!(bad.binds.is_empty());
    }

    #[test]
    fn pages_typed_property_predicates_compile() {
        // #1280 — the typed comparisons (Lt/Gt/Lte/Gte) + Contains +
        // Num/Date values compile to real SQL on the Pages surface (the
        // shared `compile_property_compare` / `compile_property_like`
        // helpers, guarding `IS NOT NULL`).
        let p = PagesProjection;

        // Num ordered comparison → `value_num … < ?` with a Real bind.
        let lt_num = p.compile(&FilterPrimitive::HasProperty {
            key: "count".into(),
            predicate: PropertyPredicate::Lt {
                value: PropertyValue::Num { value: 3.5 },
            },
        });
        assert!(!lt_num.is_unsupported());
        assert!(
            lt_num
                .sql
                .contains("value_num IS NOT NULL AND value_num < ?")
        );
        assert_eq!(
            lt_num.binds,
            vec![Bind::Text("count".into()), Bind::Real(3.5)]
        );

        // Date ordered comparison → `value_date >= ?`.
        let gte_date = p.compile(&FilterPrimitive::HasProperty {
            key: "when".into(),
            predicate: PropertyPredicate::Gte {
                value: PropertyValue::Date {
                    value: "2026-01-01".into(),
                },
            },
        });
        assert!(
            gte_date
                .sql
                .contains("value_date IS NOT NULL AND value_date >= ?")
        );

        // Contains over Text → `LIKE ? ESCAPE '\'` with `%…%`.
        let contains = p.compile(&FilterPrimitive::HasProperty {
            key: "label".into(),
            predicate: PropertyPredicate::Contains {
                value: PropertyValue::Text {
                    value: "ab%c".into(),
                },
            },
        });
        assert!(contains.sql.contains("LIKE ? ESCAPE '\\'"));
        assert_eq!(
            contains.binds,
            vec![Bind::Text("label".into()), Bind::Text("%ab\\%c%".into())]
        );

        // StartsWith over Text → `v%`.
        let starts = p.compile(&FilterPrimitive::HasProperty {
            key: "label".into(),
            predicate: PropertyPredicate::StartsWith {
                value: PropertyValue::Text {
                    value: "pre".into(),
                },
            },
        });
        assert_eq!(starts.binds[1], Bind::Text("pre%".into()));

        // Contains over a Num value is meaningless → `1=0`.
        let contains_num = p.compile(&FilterPrimitive::HasProperty {
            key: "count".into(),
            predicate: PropertyPredicate::Contains {
                value: PropertyValue::Num { value: 3.0 },
            },
        });
        assert_eq!(contains_num.sql, "1=0");
        assert!(contains_num.binds.is_empty());
    }
}

// ── EXPLAIN QUERY PLAN tests (async, real DB) ────────────────────────────
//
// Phase 2 — assert each Pages-only grooming primitive composes
// into a query plan that hits an indexed `pages_cache` row read rather
// Than the pre- correlated-subquery shape. Mirrors the
// `most_linked_query_plan_uses_pages_cache_not_block_links` snapshot in
// `commands::tests::list_pages_with_metadata_tests`.
//
// We assert *presence* and *absence* of table-name tokens in the plan,
// not the full plan string — SQLite is allowed to reword
// "SCAN" vs "SEARCH USING INDEX" across patch versions, and the
// load-bearing contract is "uses pages_cache, not a block_links scan
// for the inbound side".
#[cfg(test)]
mod explain_query_plan_tests {
    use super::*;
    use crate::commands::tests::common::{TEST_SPACE_ID, ensure_test_space, test_pool};
    use sqlx::SqlitePool;

    /// Seed enough page rows that SQLite picks a representative plan
    /// (it sometimes collapses on empty tables) and seed the
    /// `pages_cache` row the materializer would write in production.
    async fn seed_pages(pool: &SqlitePool, n: u32) {
        for i in 0..n {
            let id = format!("01PAGE000000000000000F{i:04}");
            // Phase 2: space membership lives in `blocks.space_id` (the
            // column the query plans now filter on), not a
            // `block_properties(key='space')` row.
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?, 'page', ?, NULL, ?, ?, ?)",
            )
            .bind(&id)
            .bind(format!("p{i}"))
            .bind(i64::from(i))
            .bind(&id)
            .bind(TEST_SPACE_ID)
            .execute(pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT OR IGNORE INTO pages_cache \
                     (page_id, title, updated_at, inbound_link_count, child_block_count) \
                 VALUES (?, ?, 1735689600000, 0, 0)",
            )
            .bind(&id)
            .bind(format!("p{i}"))
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// Run `EXPLAIN QUERY PLAN` against a SELECT that composes the
    /// given `PagesProjection` primitive into the same JOIN shape the
    /// IPC uses (`commands::pages::list_pages_with_metadata_inner`)
    /// and return the plan as a single newline-joined string.
    async fn explain_for(pool: &SqlitePool, fragment: &str) -> String {
        let sql = format!(
            "EXPLAIN QUERY PLAN \
             SELECT b.id \
             FROM blocks b \
             LEFT JOIN pages_cache pc ON pc.page_id = b.id \
             WHERE b.block_type = 'page' AND b.deleted_at IS NULL \
               AND b.space_id = ? \
               AND {fragment}"
        );
        let rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()))
            .bind(TEST_SPACE_ID)
            .fetch_all(pool)
            .await
            .unwrap();
        rows.into_iter()
            .map(|(_, _, _, detail)| detail)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn orphan_primitive_plan_reads_pages_cache() {
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;
        seed_pages(&pool, 16).await;
        let frag = PagesProjection.compile(&FilterPrimitive::Orphan).sql;
        let plan = explain_for(&pool, &frag).await;
        eprintln!("[ EXPLAIN Orphan]\n{plan}");
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "Orphan plan must reference pages_cache; got:\n{plan}"
        );
        // Orphan's outbound term is a page-wide `NOT EXISTS` over
        // `block_links bl JOIN blocks src ON bl.source_id = src.id JOIN
        // blocks tgt ON bl.target_id = tgt.id WHERE src.page_id = b.id` —
        // that subquery IS allowed to touch block_links (it drives from
        // `source_id` via the PK autoindex on (source_id, target_id),
        // Then joins the target block by integer PK). The `tgt` join filters
        // deleted / same-page targets. The previous *inbound* `target_id`
        // index scan (driving the subquery from `block_links.target_id`)
        // must NOT appear — inbound is served by the materialised
        // `pc.inbound_link_count`, so the planner has no reason to drive
        // from the target index.
        assert!(
            !plan.to_lowercase().contains("target_id"),
            "Orphan plan must not scan block_links by target_id (inbound is the materialised count; the outbound tgt join drives from source_id + PK); got:\n{plan}"
        );
    }

    #[tokio::test]
    async fn stub_primitive_plan_reads_pages_cache_not_blocks_subquery() {
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;
        seed_pages(&pool, 16).await;
        let frag = PagesProjection.compile(&FilterPrimitive::Stub).sql;
        let plan = explain_for(&pool, &frag).await;
        eprintln!("[ EXPLAIN Stub]\n{plan}");
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "Stub plan must reference pages_cache; got:\n{plan}"
        );
        // The pre- shape `(SELECT COUNT(*) FROM blocks d WHERE
        // d.page_id = b.id ...) < 3` produced a `SCAN blocks AS d`
        // alias in the plan. The materialised shape never aliases
        // `blocks` as `d`.
        assert!(
            !plan.contains(" AS d") && !plan.contains(" d "),
            "Stub plan must not scan the `blocks d` correlated subquery; got:\n{plan}"
        );
        assert!(
            !plan.to_lowercase().contains("block_links"),
            "Stub plan must not touch block_links at all; got:\n{plan}"
        );
    }

    #[tokio::test]
    async fn has_no_inbound_links_primitive_plan_reads_pages_cache() {
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;
        seed_pages(&pool, 16).await;
        let frag = PagesProjection
            .compile(&FilterPrimitive::HasNoInboundLinks)
            .sql;
        let plan = explain_for(&pool, &frag).await;
        eprintln!("[ EXPLAIN HasNoInboundLinks]\n{plan}");
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "HasNoInboundLinks plan must reference pages_cache; got:\n{plan}"
        );
        assert!(
            !plan.to_lowercase().contains("block_links"),
            "HasNoInboundLinks plan must not scan block_links (use materialised inbound count); got:\n{plan}"
        );
    }

    /// Composite check — AND'ing all three Pages-only primitives must
    /// not degrade the plan (e.g. drop `pages_cache` for a temp-b-tree
    /// scan). The planner is allowed to re-order the terms, but it
    /// must still reach the `pages_cache` row.
    #[tokio::test]
    async fn composite_pages_only_primitives_keep_pages_cache_in_plan() {
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;
        seed_pages(&pool, 16).await;
        let p = PagesProjection;
        let frag = format!(
            "({}) AND ({}) AND ({})",
            p.compile(&FilterPrimitive::Orphan).sql,
            p.compile(&FilterPrimitive::Stub).sql,
            p.compile(&FilterPrimitive::HasNoInboundLinks).sql,
        );
        let plan = explain_for(&pool, &frag).await;
        eprintln!("[ EXPLAIN composite]\n{plan}");
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "composite plan must reference pages_cache; got:\n{plan}"
        );
        // Orphan's page-wide outbound `NOT EXISTS (... src.page_id =
        // B.id)` is the only allowed block_links access; its
        // `tgt` join reaches the target block by integer PK, not by driving
        // from the `target_id` index. The plan must not regress to an
        // inbound `target_id` index scan (inbound is the materialised count).
        assert!(
            !plan.to_lowercase().contains("target_id"),
            "composite plan must not scan block_links by target_id; got:\n{plan}"
        );
    }

    /// #1320-A — `PagesProjection::compile_path_glob` now pins the SAME
    /// `LOWER(title) GLOB ?` dialect as Search (after #1320), NOT the
    /// former `title COLLATE NOCASE LIKE ? ESCAPE '\'` form. This is a
    /// maintainer-authorised user-visible behaviour change: the Pages
    /// path-glob filter now supports `GLOB` + brace + `[class]` semantics
    /// instead of LIKE substring/`%`/`_` semantics. The `pattern` is bound
    /// VERBATIM (the caller `compile_pages_filters` runs `prepare_globs`),
    /// so this method does NOT preprocess. This test pins the compiled
    /// shape and confirms the plan stays on `pages_cache`. It mirrors
    /// `search_path_glob_compiles_to_glob` (which is left UNCHANGED, as it
    /// guards that Search is untouched — the two surfaces only differ by
    /// the `b.id` vs `b.page_id` alias).
    #[tokio::test]
    async fn pages_path_glob_compiles_to_glob_not_like() {
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;
        seed_pages(&pool, 16).await;

        // INCLUDE → `IN`, exact GLOB fragment + verbatim text bind.
        let inc = PagesProjection.compile(&FilterPrimitive::PathGlob {
            pattern: "*page*".into(),
            exclude: false,
        });
        assert_eq!(
            inc.sql,
            "b.id IN (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)",
        );
        assert_eq!(inc.binds, vec![Bind::Text("*page*".to_string())]);

        // EXCLUDE → `NOT IN`, same sub-select.
        let exc = PagesProjection.compile(&FilterPrimitive::PathGlob {
            pattern: "*draft*".into(),
            exclude: true,
        });
        assert_eq!(
            exc.sql,
            "b.id NOT IN (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)",
        );
        assert_eq!(exc.binds, vec![Bind::Text("*draft*".to_string())]);

        // It must be the GLOB dialect, never the old Pages LIKE form, and
        // must keep the Pages `b.id` alias (Search uses `b.page_id`).
        assert!(inc.sql.contains("LOWER(title) GLOB"));
        assert!(!inc.sql.contains("COLLATE NOCASE LIKE"));
        assert!(inc.sql.contains("b.id IN"));

        // The plan stays on pages_cache (a scan is fine for the small,
        // one-row-per-page table).
        let plan = explain_for(&pool, &inc.sql).await;
        eprintln!("[#1320-A EXPLAIN PathGlob *page*]\n{plan}");
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "PathGlob plan must reference pages_cache; got:\n{plan}"
        );
    }

    /// #1320 `SearchProjection::compile_path_glob` pins the LEGACY
    /// `LOWER(title) GLOB ?` dialect (NOT the Pages `COLLATE NOCASE LIKE`
    /// form), proving the FTS path-glob cutover is byte-for-byte the same
    /// SQL the legacy `append_page_glob_subselect` emits for one pattern.
    /// The pattern is bound verbatim as `Bind::Text` (already prepared by
    /// `prepare_globs` — this compile site does NOT preprocess). The Pages
    /// `path_glob_compiles_to_collate_nocase_like_not_glob` test above
    /// continues to assert the LIKE shape, so the two surfaces stay
    /// independent.
    #[test]
    fn search_path_glob_compiles_to_glob() {
        // INCLUDE → `IN`, exact legacy fragment + verbatim text bind.
        let inc = SearchProjection.compile(&FilterPrimitive::PathGlob {
            pattern: "*foo*".into(),
            exclude: false,
        });
        assert_eq!(
            inc.sql,
            "b.page_id IN (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)",
        );
        assert_eq!(inc.binds, vec![Bind::Text("*foo*".to_string())]);

        // EXCLUDE → `NOT IN`, same sub-select.
        let exc = SearchProjection.compile(&FilterPrimitive::PathGlob {
            pattern: "*bar*".into(),
            exclude: true,
        });
        assert_eq!(
            exc.sql,
            "b.page_id NOT IN (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)",
        );
        assert_eq!(exc.binds, vec![Bind::Text("*bar*".to_string())]);

        // It must be the GLOB dialect, never the Pages LIKE form.
        assert!(inc.sql.contains("LOWER(title) GLOB"));
        assert!(!inc.sql.contains("COLLATE NOCASE LIKE"));
    }
}
