//! PEND-58 — `FilterPrimitive` enum + `Projection` trait.
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum FilterPrimitive {
    /// Shared — block carries this tag id directly.
    Tag { tag: String },
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
    /// Shared — block's `priority` matches this value.
    Priority { priority: String },
    // ── Pages-only ────────────────────────────────────────────────
    /// Pages-only — page has no inbound links AND no outbound links.
    /// (`HasNoInboundLinks` is the looser inbound-only sibling.)
    Orphan,
    /// Pages-only — page has zero non-title descendants. Per PEND-58
    /// (pending/PEND-58-pages-view-compound-filters.md:142): "Page
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
}

/// The right-hand-side value type for `HasProperty`.
///
/// Internally-tagged on `"type"` (PascalCase) so the TS union reads
/// `{ type: "Text", value } | { type: "Ref", value }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum PropertyValue {
    Text {
        value: String,
    },
    /// References another block via `block_properties.value_ref`.
    Ref {
        value: String,
    },
}

/// `last-edited:` time-window spec.
///
/// Internally-tagged on `"type"` (PascalCase) so the TS union reads
/// `{ type: "Rolling", days } | { type: "Range", start, end }
/// | { type: "OlderThan", days }`.
///
/// PEND-58 Phase 2 review — the existing variants already cover the
/// plan's full bucket vocabulary (pending/PEND-58-pages-view-compound-
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
    /// `Rolling`). Used by PEND-58's `last-edited:older` chip.
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

/// Bind shape for `WhereClause::binds`. Two scalars cover every
/// primitive we currently emit; future primitives can extend.
#[derive(Debug, Clone, PartialEq)]
pub enum Bind {
    Text(String),
    Int(i64),
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
    fn compile_path_glob(&self, pattern: &str, exclude: bool) -> WhereClause;
    fn compile_has_property(&self, key: &str, predicate: &PropertyPredicate) -> WhereClause;
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause;
    fn compile_space(&self, space_id: &str) -> WhereClause;
    fn compile_priority(&self, priority: &str) -> WhereClause;

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
            FilterPrimitive::PathGlob { pattern, exclude } => {
                self.compile_path_glob(pattern, *exclude)
            }
            FilterPrimitive::HasProperty { key, predicate } => {
                self.compile_has_property(key, predicate)
            }
            FilterPrimitive::LastEdited { spec } => self.compile_last_edited(spec),
            FilterPrimitive::Space { space_id } => self.compile_space(space_id),
            FilterPrimitive::Priority { priority } => self.compile_priority(priority),
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
    /// PEND-58 §Performance — relative SQL-plan cost, used to order the
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
    /// - **2 (full scan, LIKE):** `PathGlob`, always. It compiles to
    ///   `title COLLATE NOCASE LIKE ? ESCAPE '\'` (see `glob_to_like`).
    ///   SQLite (measured on 3.50.6, the family sqlx bundles) does **not**
    ///   apply its LIKE-index optimization to a *case-insensitive* `LIKE`
    ///   — neither a `COLLATE NOCASE` column/index nor a `LOWER(title)`
    ///   expression index is used; only an explicit `COLLATE NOCASE >= p
    ///   AND < p++` range hits `idx_pages_cache_title_nocase`. So every
    ///   `PathGlob` is a true `pages_cache.title` scan regardless of
    ///   anchoring. That scan is cheap in practice — `pages_cache` holds
    ///   one row per page (hundreds–low thousands), so a NOCASE prefix
    ///   range (Unicode-fiddly to build by hand) isn't worth it; `PathGlob`
    ///   is simply ranked last among the SQL primitives so it never runs
    ///   before a SARGable clause.
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
    ///   pre-narrow the page set (PEND-58e E11; matches the cost-ordering
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
            | FilterPrimitive::HasProperty { .. }
            | FilterPrimitive::Space { .. }
            | FilterPrimitive::Stub
            | FilterPrimitive::HasNoInboundLinks => 0,
            // `Priority` is a per-row equality; `LastEdited` is a
            // per-row correlated `MAX()` subquery (served via
            // `idx_op_log_block_id`) — both rank above a full LIKE scan.
            FilterPrimitive::Priority { .. } | FilterPrimitive::LastEdited { .. } => 1,
            // `PathGlob` is always a full `pages_cache.title` scan: SQLite
            // won't use a NOCASE index for a case-insensitive `LIKE` (only
            // an explicit NOCASE range would), so anchoring buys nothing.
            // Ranked highest among the SQL primitives.
            FilterPrimitive::PathGlob { .. } => 2,
            // `Orphan`'s outbound half is a 3-table correlated subquery with
            // no materialised counterpart (PEND-58e E11) — expensive tier,
            // emitted after any index-backed clause that can pre-narrow.
            FilterPrimitive::Orphan
            | FilterPrimitive::Regex { .. }
            | FilterPrimitive::CaseSensitive { .. }
            | FilterPrimitive::WholeWord { .. }
            | FilterPrimitive::Snippet { .. } => 3,
        }
    }

    /// PEND-58 — the allowed-keys token for this primitive, used by the
    /// per-surface allow-list gate. Mirrors the `&'static str` keys in
    /// [`PAGES_ALLOWED_KEYS`] / [`SEARCH_ALLOWED_KEYS`].
    #[must_use]
    pub fn allowed_key(&self) -> &'static str {
        match self {
            FilterPrimitive::Tag { .. } => "tag",
            FilterPrimitive::PathGlob { .. } => "path",
            FilterPrimitive::HasProperty { .. } => "has-property",
            FilterPrimitive::LastEdited { .. } => "last-edited",
            FilterPrimitive::Space { .. } => "space",
            FilterPrimitive::Priority { .. } => "priority",
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

/// Translate the documented Page-path glob mini-language into a SQLite
/// `LIKE` pattern for use with ``ESCAPE '\'`` against a `COLLATE NOCASE`
/// column (so the `idx_pages_cache_title_nocase` prefix index can serve
/// anchored patterns).
///
/// Mapping (see `docs/PAGES.md` "Page path"):
/// - `*` → `%` (any run of characters),
/// - `?` → `_` (exactly one character),
/// - any other char is a literal — `%`, `_`, `\` are escaped (a `\` is
///   pushed before them) so they match themselves; everything else
///   (including `[`, which LIKE has no character-class meaning for) is
///   passed through verbatim.
///
/// If the ORIGINAL pattern contained neither `*` nor `?` (a bare word),
/// the result is wrapped in leading + trailing `%` so it becomes a
/// substring match (`Alpha` → `%Alpha%`). Otherwise the translated
/// pattern is returned as-is, so anchored prefixes stay index-usable
/// (`Projects/*` → `Projects/%`) and leading wildcards stay full scans
/// (`*foo` → `%foo`).
fn glob_to_like(pattern: &str) -> String {
    let has_wildcard = pattern.contains(['*', '?']);
    let mut out = String::with_capacity(pattern.len() + 2);
    for ch in pattern.chars() {
        match ch {
            '*' => out.push('%'),
            '?' => out.push('_'),
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    if has_wildcard {
        out
    } else {
        format!("%{out}%")
    }
}

// ── Property-value column mapping ─────────────────────────────────────────

/// D26 — map a [`PropertyValue`] to the `block_properties` column it
/// compares against (`value_text` for `Text`, `value_ref` for `Ref`) plus
/// the bound operand. Both `Eq` and `Ne` share this mapping; only the
/// `EXISTS` vs `NOT EXISTS` wrapper differs.
fn property_value_column(value: &PropertyValue) -> (&'static str, String) {
    match value {
        PropertyValue::Text { value } => ("value_text", value.clone()),
        PropertyValue::Ref { value } => ("value_ref", value.clone()),
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
    fn compile_path_glob(&self, pattern: &str, exclude: bool) -> WhereClause {
        // Pages: case-insensitive LIKE on pages_cache.title, matching the
        // documented glob contract (anchored `Projects/*` → `Projects/%`;
        // bare words → substring `%word%`; see `glob_to_like`). NOTE: this
        // is a `pages_cache.title` scan — SQLite won't use the NOCASE index
        // for a case-insensitive LIKE (only an explicit NOCASE range
        // would). That's fine: `pages_cache` is one row per page, so the
        // scan is cheap. The win here is correctness (the old `LOWER(title)
        // GLOB ?` inverted the bare-word semantics) + dropping per-row
        // `LOWER()`.
        let op = if exclude { "NOT IN" } else { "IN" };
        WhereClause::new(
            format!(
                "b.id {op} (SELECT page_id FROM pages_cache \
                 WHERE title COLLATE NOCASE LIKE ? ESCAPE '\\')"
            ),
            vec![Bind::Text(glob_to_like(pattern))],
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
                    vec![Bind::Text(key.to_string()), Bind::Text(v)],
                )
            }
            PropertyPredicate::Ne { value } => {
                let (col, v) = property_value_column(value);
                WhereClause::new(
                    format!(
                        "NOT EXISTS (SELECT 1 FROM block_properties \
                         WHERE block_id = b.id AND key = ? AND {col} = ?)"
                    ),
                    vec![Bind::Text(key.to_string()), Bind::Text(v)],
                )
            }
        }
    }
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause {
        // Uses op_log's last-modified-at expression for the page itself
        // (`MAX(op_log.created_at)`). A future phase may swap to a
        // materialised `pages_cache.last_edited_at` column.
        //
        // **No-op-log ⇒ epoch rule (PEND-58d D7):** a page with no `op_log`
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
        // are validated upstream (PEND-58d D15) in
        // `commands::pages::compile_pages_filters`.
        //
        // **End-of-day inclusivity (PEND-58e E3):** the Range `end` bound is
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
            parsed.map(|d| d.timestamp_millis()).unwrap_or(0)
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
                // (PEND-58e E3). A bare-date `start` is anchored at midnight.
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
    fn compile_priority(&self, priority: &str) -> WhereClause {
        WhereClause::new("b.priority = ?", vec![Bind::Text(priority.to_string())])
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
        // **Page-wide outbound semantic** (PEND-58 Phase-2 / PEND-56b
        // alignment): `block_links.source_id` is the *content* block that
        // authored the link, not the page block. Links normally live in the
        // body, so the outbound `NOT EXISTS` MUST cover every non-deleted
        // block on the page (`src.page_id = b.id`), mirroring the page-wide
        // inbound semantic below — not just edges typed on the page's title
        // row (`source_id = b.id`). Spec
        // `pending/PEND-58-pages-view-compound-filters.md:141` requires
        // `source_id IN (SELECT id FROM blocks WHERE page_id = …)`.
        //
        // **Inbound semantic** (PEND-58 Phase-2 alignment with PEND-56b;
        // refined by PEND-58d D2 / migration 0070 to exclude same-page,
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
        // **Outbound target filtering (PEND-58d D19):** the outbound `NOT
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
        // non-title descendants. Matches the PEND-58 vocabulary spec
        // verbatim ("Page whose only block is its own title row (zero
        // non-title descendants)", pending/PEND-58-pages-view-compound-
        // filters.md:142). The prior `< 3` threshold was a Phase-1
        // placeholder. The new comparison is served by the materialised
        // `pc.child_block_count` column.
        WhereClause::new("COALESCE(pc.child_block_count, 0) = 0", Vec::new())
    }
    fn compile_has_no_inbound_links(&self) -> WhereClause {
        // Looser companion to Orphan: zero inbound block-link edges,
        // outbound side ignored. Same materialised column — and same
        // "page OR any non-deleted descendant" semantic, with same-page /
        // self / deleted sources excluded (PEND-58d D2) — as the inbound
        // half of Orphan; see that fn's doc comment for the
        // PEND-58 / PEND-56b alignment rationale.
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
    fn compile_path_glob(&self, pattern: &str, exclude: bool) -> WhereClause {
        // Search: same case-insensitive LIKE on pages_cache.title as the
        // Pages surface (a scan — see the Pages `compile_path_glob` note on
        // why the NOCASE index isn't used), but keyed by `b.page_id` (block
        // rows). Anchored patterns and bare-word substrings per
        // `glob_to_like`.
        let op = if exclude { "NOT IN" } else { "IN" };
        WhereClause::new(
            format!(
                "b.page_id {op} (SELECT page_id FROM pages_cache \
                 WHERE title COLLATE NOCASE LIKE ? ESCAPE '\\')"
            ),
            vec![Bind::Text(glob_to_like(pattern))],
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
    fn compile_priority(&self, priority: &str) -> WhereClause {
        WhereClause::new("b.priority = ?", vec![Bind::Text(priority.to_string())])
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

    /// PEND-58b P2-C — exhaustive consistency check across the three
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
                priority: "A".into(),
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
                | FilterPrimitive::PathGlob { .. }
                | FilterPrimitive::HasProperty { .. }
                | FilterPrimitive::LastEdited { .. }
                | FilterPrimitive::Space { .. }
                | FilterPrimitive::Priority { .. }
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
                PAGES_ALLOWED_KEYS.contains(key) || SEARCH_ALLOWED_KEYS.contains(key),
                "`{key}` (allowed_key of {prim:?}) is in neither \
                 PAGES_ALLOWED_KEYS nor SEARCH_ALLOWED_KEYS"
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
            priority: "A".into(),
        });
        assert_eq!(where_priority.sql, "b.priority = ?");

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

    /// PEND-58 Phase 2 — snapshot the exact SQL fragments emitted by
    /// the three Pages-only grooming primitives. These reference the
    /// materialised `pages_cache` columns (PEND-56b), not the
    /// pre-PEND-56b correlated subqueries. The composition site MUST
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
             and filter the target (PEND-58d D19): live target + not same-page"
        );
        assert!(orphan.binds.is_empty(), "Orphan takes no binds");

        let stub = p.compile(&FilterPrimitive::Stub);
        assert_eq!(
            stub.sql, "COALESCE(pc.child_block_count, 0) = 0",
            "Stub must compare child_block_count == 0 (PEND-58 \"zero non-title descendants\")"
        );
        assert!(stub.binds.is_empty(), "Stub takes no binds");

        let hnil = p.compile(&FilterPrimitive::HasNoInboundLinks);
        assert_eq!(
            hnil.sql, "COALESCE(pc.inbound_link_count, 0) = 0",
            "HasNoInboundLinks must read the materialised inbound count from pages_cache"
        );
        assert!(hnil.binds.is_empty(), "HasNoInboundLinks takes no binds");

        // Regression guard — the pre-PEND-56b shapes must NOT reappear.
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

    /// PEND-58 Phase 2 — confirms the LastEditedSpec variants already
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
        assert!(older.sql.contains("<"), "OlderThan must use `<` comparator");
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
        assert!(older.sql.contains("<"));
        // Both bind a "-7 days" sentinel.
        assert_eq!(rolling.binds, vec![Bind::Text("-7 days".to_string())]);
        assert_eq!(older.binds, vec![Bind::Text("-7 days".to_string())]);
    }

    #[test]
    fn last_edited_range_extends_bare_end_date_to_end_of_day() {
        // PEND-58e E3 — a bare `YYYY-MM-DD` `end` is extended to the last
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
        // PEND-58d D7 — the "no op-log ⇒ epoch" rule must be uniform: ALL
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
                priority: "A".into()
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
        // (PEND-58e E11; matches docs/architecture/filters.md). It must
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
    fn glob_to_like_translates_documented_mini_language() {
        // Bare word (no wildcard) → substring match.
        assert_eq!(glob_to_like("word"), "%word%");
        // Anchored prefix → prefix LIKE (index-usable).
        assert_eq!(glob_to_like("Projects/*"), "Projects/%");
        // Leading + trailing `*` → substring with no extra wrap.
        assert_eq!(glob_to_like("*x*"), "%x%");
        // `?` → single-char `_`; presence of a wildcard suppresses the
        // substring wrap.
        assert_eq!(glob_to_like("a?b"), "a_b");
        // Literal LIKE metacharacters in a bare word are escaped, then
        // wrapped for the substring match.
        assert_eq!(glob_to_like("50%_off"), r"%50\%\_off%");
        // A literal `%`/`_` alongside a glob wildcard is escaped without
        // the substring wrap.
        assert_eq!(glob_to_like("a%*"), r"a\%%");
        // `[` is a literal — LIKE has no character classes.
        assert_eq!(glob_to_like("[draft]"), "%[draft]%");
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
}

// ── EXPLAIN QUERY PLAN tests (async, real DB) ────────────────────────────
//
// PEND-58 Phase 2 — assert each Pages-only grooming primitive composes
// into a query plan that hits an indexed `pages_cache` row read rather
// than the pre-PEND-56b correlated-subquery shape. Mirrors the
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
            .bind(i as i64)
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
        eprintln!("[PEND-58 EXPLAIN Orphan]\n{plan}");
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "Orphan plan must reference pages_cache; got:\n{plan}"
        );
        // Orphan's outbound term is a page-wide `NOT EXISTS` over
        // `block_links bl JOIN blocks src ON bl.source_id = src.id JOIN
        // blocks tgt ON bl.target_id = tgt.id WHERE src.page_id = b.id` —
        // that subquery IS allowed to touch block_links (it drives from
        // `source_id` via the PK autoindex on (source_id, target_id),
        // then joins the target block by integer PK). The PEND-58d D19 `tgt` join filters
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
        eprintln!("[PEND-58 EXPLAIN Stub]\n{plan}");
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "Stub plan must reference pages_cache; got:\n{plan}"
        );
        // The pre-PEND-56b shape `(SELECT COUNT(*) FROM blocks d WHERE
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
        eprintln!("[PEND-58 EXPLAIN HasNoInboundLinks]\n{plan}");
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
        eprintln!("[PEND-58 EXPLAIN composite]\n{plan}");
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "composite plan must reference pages_cache; got:\n{plan}"
        );
        // Orphan's page-wide outbound `NOT EXISTS (... src.page_id =
        // b.id)` is the only allowed block_links access; its PEND-58d D19
        // `tgt` join reaches the target block by integer PK, not by driving
        // from the `target_id` index. The plan must not regress to an
        // inbound `target_id` index scan (inbound is the materialised count).
        assert!(
            !plan.to_lowercase().contains("target_id"),
            "composite plan must not scan block_links by target_id; got:\n{plan}"
        );
    }

    /// PEND-58d D1 — `PathGlob` must compile to a case-insensitive
    /// `title COLLATE NOCASE LIKE ? ESCAPE '\'` (matching the documented
    /// substring/glob contract in `docs/PAGES.md`), NOT the old
    /// `LOWER(title) GLOB ?`. The old shape wrapped the column in `LOWER()`
    /// and used GLOB's BINARY collation, so it could never use the
    /// `idx_pages_cache_title_nocase` index AND it inverted the documented
    /// "bare word = substring" semantics.
    ///
    /// On the plan: SQLite does NOT apply its LIKE-index optimization to a
    /// case-insensitive `LIKE` (verified empirically — only an explicit
    /// `COLLATE NOCASE >= p AND < p++` range hits the index), so this is a
    /// `pages_cache.title` scan. That is acceptable: `pages_cache` is one
    /// row per page, so the scan is sub-millisecond at realistic scale.
    /// This test pins the *compiled shape* (the load-bearing fix) and
    /// confirms the plan stays on `pages_cache` without the `LOWER()`
    /// wrapper.
    #[tokio::test]
    async fn path_glob_compiles_to_collate_nocase_like_not_glob() {
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;
        seed_pages(&pool, 16).await;
        let frag = PagesProjection
            .compile(&FilterPrimitive::PathGlob {
                pattern: "page*".into(),
                exclude: false,
            })
            .sql;
        // Compiled-shape regression guard (deterministic, the real fix).
        assert!(
            frag.contains("COLLATE NOCASE LIKE") && frag.contains("ESCAPE"),
            "PathGlob must compile to `COLLATE NOCASE LIKE ? ESCAPE`; got: {frag}"
        );
        assert!(
            !frag.contains("GLOB") && !frag.to_uppercase().contains("LOWER("),
            "PathGlob must not use the old LOWER()/GLOB shape; got: {frag}"
        );
        let plan = explain_for(&pool, &frag).await;
        eprintln!("[PEND-58 EXPLAIN PathGlob page*]\n{plan}");
        // The plan stays on pages_cache (a scan is fine for the small,
        // one-row-per-page table). The point is it no longer wraps the
        // column in LOWER().
        assert!(
            plan.to_lowercase().contains("pages_cache"),
            "PathGlob plan must reference pages_cache; got:\n{plan}"
        );
    }
}
