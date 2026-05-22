//! PEND-58 — `FilterPrimitive` enum + `Projection` trait.
//!
//! See `crate::filters` module docs for the broader rationale. This file
//! defines the types; per-surface implementations live in their own
//! `impl Projection for PagesProjection` / `SearchProjection` blocks.
//!
//! **Wire format:** Phase 3 exposes [`FilterPrimitive`] (and its value
//! sub-types [`PropertyOp`], [`PropertyValue`], [`LastEditedSpec`],
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
    HasProperty {
        key: String,
        op: PropertyOp,
        value: Option<PropertyValue>,
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

/// Predicate operator on a `has-property:` primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PropertyOp {
    /// `block_properties.value_text = ?`.
    Eq,
    /// `block_properties.value_text != ?`.
    Ne,
    /// Property key exists (no value comparison).
    Exists,
    /// Property key does NOT exist.
    NotExists,
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
}

impl WhereClause {
    pub fn new(sql: impl Into<String>, binds: Vec<Bind>) -> Self {
        Self {
            sql: sql.into(),
            binds,
        }
    }

    /// Sentinel value for "this projection does not support this
    /// primitive". Distinct from a true `WHERE 1=0` because callers
    /// should never emit this to SQL — the allow-list gate is the
    /// production-side protection.
    pub fn unsupported() -> Self {
        Self {
            sql: String::from("1=0 /* UNSUPPORTED */"),
            binds: Vec::new(),
        }
    }

    pub fn is_unsupported(&self) -> bool {
        self.sql.contains("/* UNSUPPORTED */")
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
    fn compile_has_property(
        &self,
        key: &str,
        op: PropertyOp,
        value: Option<&PropertyValue>,
    ) -> WhereClause;
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
            FilterPrimitive::HasProperty { key, op, value } => {
                self.compile_has_property(key, *op, value.as_ref())
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
    /// - **0 (index-backed):** `Tag`, `HasProperty`, `Space`, `Orphan`,
    ///   `Stub`, `HasNoInboundLinks` — each hits an existing index
    ///   (`idx_block_props_key`, `idx_block_links_target/source`,
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
    /// - **3 (post-filter / non-SQL):** the Search-only toggles
    ///   (`Regex`, `CaseSensitive`, `WholeWord`, `Snippet`) — never seen
    ///   on the Pages surface (allowed-keys gate rejects them), but
    ///   ranked last so they never precede a SARGable clause if a future
    ///   surface admits them.
    #[must_use]
    pub fn cost_hint(&self) -> u8 {
        match self {
            FilterPrimitive::Tag { .. }
            | FilterPrimitive::HasProperty { .. }
            | FilterPrimitive::Space { .. }
            | FilterPrimitive::Orphan
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
            FilterPrimitive::Regex { .. }
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
    fn compile_has_property(
        &self,
        key: &str,
        op: PropertyOp,
        value: Option<&PropertyValue>,
    ) -> WhereClause {
        // Phase 1 stub — Phase 2 fills in the EXISTS shape per (op, value).
        match (op, value) {
            (PropertyOp::Exists, _) => WhereClause::new(
                "EXISTS (SELECT 1 FROM block_properties WHERE block_id = b.id AND key = ?)",
                vec![Bind::Text(key.to_string())],
            ),
            (PropertyOp::NotExists, _) => WhereClause::new(
                "NOT EXISTS (SELECT 1 FROM block_properties WHERE block_id = b.id AND key = ?)",
                vec![Bind::Text(key.to_string())],
            ),
            (PropertyOp::Eq, Some(PropertyValue::Text { value: v })) => WhereClause::new(
                "EXISTS (SELECT 1 FROM block_properties \
                 WHERE block_id = b.id AND key = ? AND value_text = ?)",
                vec![Bind::Text(key.to_string()), Bind::Text(v.clone())],
            ),
            (PropertyOp::Ne, Some(PropertyValue::Text { value: v })) => WhereClause::new(
                "NOT EXISTS (SELECT 1 FROM block_properties \
                 WHERE block_id = b.id AND key = ? AND value_text = ?)",
                vec![Bind::Text(key.to_string()), Bind::Text(v.clone())],
            ),
            // Other shapes (Ref, no-value-on-eq) — Phase 2 work.
            _ => WhereClause::unsupported(),
        }
    }
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause {
        // Phase 1 stub uses op_log's last-modified-at expression for the
        // page itself. Phase 2 may swap to a materialised
        // `pages_cache.last_edited_at` column.
        match spec {
            LastEditedSpec::Rolling { days } => WhereClause::new(
                "(SELECT MAX(created_at) FROM op_log WHERE block_id = b.id) \
                 >= datetime('now', ?)",
                vec![Bind::Text(format!("-{days} days"))],
            ),
            LastEditedSpec::OlderThan { days } => WhereClause::new(
                "COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), '0001-01-01') \
                 < datetime('now', ?)",
                vec![Bind::Text(format!("-{days} days"))],
            ),
            LastEditedSpec::Range { start, end } => WhereClause::new(
                "(SELECT MAX(created_at) FROM op_log WHERE block_id = b.id) BETWEEN ? AND ?",
                vec![Bind::Text(start.clone()), Bind::Text(end.clone())],
            ),
        }
    }
    fn compile_space(&self, space_id: &str) -> WhereClause {
        WhereClause::new(
            "b.page_id IN (SELECT block_id FROM block_properties \
             WHERE key = 'space' AND value_ref = ?)",
            vec![Bind::Text(space_id.to_string())],
        )
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
        WhereClause::new(
            "COALESCE(pc.inbound_link_count, 0) = 0 \
             AND NOT EXISTS ( \
               SELECT 1 FROM block_links bl \
               JOIN blocks src ON bl.source_id = src.id \
               WHERE src.page_id = b.id AND src.deleted_at IS NULL \
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
    fn compile_has_property(
        &self,
        key: &str,
        op: PropertyOp,
        value: Option<&PropertyValue>,
    ) -> WhereClause {
        // Identical to PagesProjection for now — the value/op semantics
        // are shared. Per-surface column differences emerge later.
        PagesProjection.compile_has_property(key, op, value)
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
                op: PropertyOp::Exists,
                value: None,
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
        assert!(where_space.sql.contains("'space'"));
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
               WHERE src.page_id = b.id AND src.deleted_at IS NULL \
             )",
            "Orphan must read the materialised inbound count from pages_cache \
             and scope its outbound NOT EXISTS page-wide (every non-deleted block)"
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
    fn has_property_compiles_for_all_4_ops() {
        let p = PagesProjection;
        let prim = FilterPrimitive::HasProperty {
            key: "kind".into(),
            op: PropertyOp::Eq,
            value: Some(PropertyValue::Text {
                value: "note".into(),
            }),
        };
        let w = p.compile(&prim);
        assert!(w.sql.contains("EXISTS"));
        assert_eq!(w.binds.len(), 2);

        let exists = FilterPrimitive::HasProperty {
            key: "kind".into(),
            op: PropertyOp::Exists,
            value: None,
        };
        let w = p.compile(&exists);
        assert!(w.sql.contains("EXISTS"));
        assert_eq!(w.binds.len(), 1);

        let not_exists = FilterPrimitive::HasProperty {
            key: "kind".into(),
            op: PropertyOp::NotExists,
            value: None,
        };
        let w = p.compile(&not_exists);
        assert!(w.sql.contains("NOT EXISTS"));

        let ne = FilterPrimitive::HasProperty {
            key: "kind".into(),
            op: PropertyOp::Ne,
            value: Some(PropertyValue::Text {
                value: "draft".into(),
            }),
        };
        let w = p.compile(&ne);
        assert!(w.sql.contains("NOT EXISTS"));
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
        assert_eq!(FilterPrimitive::Orphan.cost_hint(), 0);
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
    use crate::commands::tests::common::{ensure_test_space, test_pool, TEST_SPACE_ID};
    use sqlx::SqlitePool;

    /// Seed enough page rows that SQLite picks a representative plan
    /// (it sometimes collapses on empty tables) and seed the
    /// `pages_cache` row the materializer would write in production.
    async fn seed_pages(pool: &SqlitePool, n: u32) {
        for i in 0..n {
            let id = format!("01PAGE000000000000000F{i:04}");
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'page', ?, NULL, ?, ?)",
            )
            .bind(&id)
            .bind(format!("p{i}"))
            .bind(i as i64)
            .bind(&id)
            .execute(pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT OR IGNORE INTO block_properties (block_id, key, value_ref) \
                 VALUES (?, 'space', ?)",
            )
            .bind(&id)
            .bind(TEST_SPACE_ID)
            .execute(pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT OR IGNORE INTO pages_cache \
                     (page_id, title, updated_at, inbound_link_count, child_block_count) \
                 VALUES (?, ?, '2025-01-01T00:00:00Z', 0, 0)",
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
               AND b.page_id IN ( \
                   SELECT bp.block_id FROM block_properties bp \
                   WHERE bp.key = 'space' AND bp.value_ref = ? \
               ) \
               AND {fragment}"
        );
        let rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(&sql)
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
        // `block_links bl JOIN blocks src ON bl.source_id = src.id WHERE
        // src.page_id = b.id` — that subquery IS allowed to touch
        // block_links (idx_block_links_source serves it). The previous
        // *inbound* `target_id` scan must NOT appear.
        assert!(
            !plan.to_lowercase().contains("target_id"),
            "Orphan plan must not scan block_links by target_id (use materialised inbound count); got:\n{plan}"
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
        // b.id)` is the only allowed block_links access. The plan must
        // not regress to an inbound `target_id` scan.
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
