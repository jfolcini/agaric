//! PEND-58 Phase 1 — `FilterPrimitive` enum + `Projection` trait.
//!
//! See `crate::filters` module docs for the broader rationale. This file
//! defines the types; per-surface implementations live in their own
//! `impl Projection for PagesProjection` / `SearchProjection` blocks.
//!
//! **Wire format:** these types are NOT exposed on the IPC boundary in
//! Phase 1 — they live entirely backend-side. PEND-58 Phase 3 wires
//! a frontend-facing version once the chip-row UI lands.

use std::collections::HashSet;

// ── Primitive enum ────────────────────────────────────────────────────────

/// One filter atom in a compound-filter expression. Variants are tagged
/// so the cross-surface SQL composer can dispatch via match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterPrimitive {
    /// Shared — block carries this tag id directly.
    Tag(String),
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
    LastEdited(LastEditedSpec),
    /// Shared — block's owning page lives in this space.
    Space(String),
    /// Shared — block's `priority` matches this value.
    Priority(String),
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
    Regex(String),
    /// Search-only — case-sensitive match toggle (post-FTS filter).
    CaseSensitive(bool),
    /// Search-only — whole-word match toggle (ASCII `\b` semantics).
    WholeWord(bool),
    /// Search-only — FTS5 `snippet()` window spec.
    Snippet(SnippetSpec),
}

/// Predicate operator on a `has-property:` primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropertyValue {
    Text(String),
    /// References another block via `block_properties.value_ref`.
    Ref(String),
}

/// `last-edited:` time-window spec. Phase 1 defines the shape; Phase 2
/// implements the SQL bucket math against `pages_cache.last_edited_at`
/// (or the future equivalent column).
///
/// PEND-58 Phase 2 review — the existing variants already cover the
/// plan's full bucket vocabulary (pending/PEND-58-pages-view-compound-
/// filters.md:144, lines 308-310):
///
/// | Chip token            | Variant          |
/// |-----------------------|------------------|
/// | `last-edited:today`        | `Rolling(1)`   |
/// | `last-edited:this-week`    | `Rolling(7)`   |
/// | `last-edited:this-month`   | `Rolling(30)`  |
/// | `last-edited:older`        | `OlderThan(30)`|
/// | `last-edited:>=YYYY-MM-DD` | `Range { .. }` |
///
/// No `LastEditedBucket` variant is needed — the parser maps each
/// chip token to one of the variants above.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LastEditedSpec {
    /// Rolling N-days window. `Today`, `ThisWeek`, `ThisMonth` map to
    /// 1 / 7 / 30. Custom values are accepted but documented as
    /// "rolling, not calendar".
    Rolling(u32),
    /// Absolute date range (ISO 8601 dates, inclusive on both ends).
    Range { start: String, end: String },
    /// Older than the given rolling N-days window (the inverse of
    /// `Rolling`). Used by PEND-58's `last-edited:older` chip.
    OlderThan(u32),
}

/// Snippet-rendering parameters threaded through to the FTS5 `snippet()`
/// builtin. Phase 1 defines the shape; the SQL composition lives in
/// `fts::search`.
#[derive(Debug, Clone, PartialEq, Eq)]
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
            FilterPrimitive::Tag(t) => self.compile_tag(t),
            FilterPrimitive::PathGlob { pattern, exclude } => {
                self.compile_path_glob(pattern, *exclude)
            }
            FilterPrimitive::HasProperty { key, op, value } => {
                self.compile_has_property(key, *op, value.as_ref())
            }
            FilterPrimitive::LastEdited(spec) => self.compile_last_edited(spec),
            FilterPrimitive::Space(s) => self.compile_space(s),
            FilterPrimitive::Priority(p) => self.compile_priority(p),
            FilterPrimitive::Orphan => self.compile_orphan(),
            FilterPrimitive::Stub => self.compile_stub(),
            FilterPrimitive::HasNoInboundLinks => self.compile_has_no_inbound_links(),
            FilterPrimitive::Regex(p) => self.compile_regex(p),
            FilterPrimitive::CaseSensitive(b) => self.compile_case_sensitive(*b),
            FilterPrimitive::WholeWord(b) => self.compile_whole_word(*b),
            FilterPrimitive::Snippet(s) => self.compile_snippet(s),
        }
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
        // Pages: GLOB on pages_cache.title (LOWER for case-insensitive).
        let op = if exclude { "NOT IN" } else { "IN" };
        WhereClause::new(
            format!("b.id {op} (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)",),
            vec![Bind::Text(pattern.to_lowercase())],
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
            (PropertyOp::Eq, Some(PropertyValue::Text(v))) => WhereClause::new(
                "EXISTS (SELECT 1 FROM block_properties \
                 WHERE block_id = b.id AND key = ? AND value_text = ?)",
                vec![Bind::Text(key.to_string()), Bind::Text(v.clone())],
            ),
            (PropertyOp::Ne, Some(PropertyValue::Text(v))) => WhereClause::new(
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
            LastEditedSpec::Rolling(days) => WhereClause::new(
                "(SELECT MAX(created_at) FROM op_log WHERE block_id = b.id) \
                 >= datetime('now', ?)",
                vec![Bind::Text(format!("-{days} days"))],
            ),
            LastEditedSpec::OlderThan(days) => WhereClause::new(
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
    // ── Pages-only grooming primitives ─────────────────────────────
    //
    // PEND-58 Phase 2 — the three fragments below reference the
    // materialised columns shipped by PEND-56b
    // (`pages_cache.inbound_link_count`, `pages_cache.child_block_count`)
    // rather than the pre-PEND-56b correlated subqueries that hit the
    // 20k-page latency cliff measured during the materialisation review.
    //
    // Composition contract: the caller MUST splice these fragments into
    // a SELECT that already `LEFT JOIN pages_cache pc ON pc.page_id = b.id`.
    // The canonical example is the live IPC SELECT in
    // `commands::pages::list_pages_with_metadata_inner`
    // (`src-tauri/src/commands/pages.rs:1941-1942`). PEND-58 Phase 3 will
    // wire the Pages IPC to consume `Vec<FilterPrimitive>` and reuse that
    // exact JOIN; until then these fragments are SQL-level snapshots
    // that compile but only execute against a `pc`-bearing context.
    //
    // `COALESCE(pc.<col>, 0)` defends against the no-`pages_cache`-row
    // case the materializer's contract guarantees won't happen (every
    // page gets a row on create per the materializer's lifecycle
    // handlers + the migration 0069 backfill). If a future Pages-only
    // primitive needs a count, materialise it on `pages_cache` via the
    // PEND-56b pattern rather than introducing a new correlated
    // subquery on the read path.
    fn compile_orphan(&self) -> WhereClause {
        // Orphan := no inbound block-link edges AND no outbound block-link
        // edges. The inbound side is index-served via the materialised
        // `pc.inbound_link_count`. The outbound side has no materialised
        // counterpart yet (the materializer maintains the page-level
        // inbound aggregate only) — keep the `NOT EXISTS` here, and
        // file a follow-up to materialise an `outbound_link_count` if
        // measurement shows this term dominating.
        //
        // **Inbound semantic** (PEND-58 Phase-2 alignment with PEND-56b):
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
             AND NOT EXISTS (SELECT 1 FROM block_links WHERE source_id = b.id)",
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
        // "page OR any non-deleted descendant" semantic — as the
        // inbound half of Orphan; see that fn's doc comment for the
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
        let op = if exclude { "NOT IN" } else { "IN" };
        WhereClause::new(
            format!("b.page_id {op} (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)",),
            vec![Bind::Text(pattern.to_lowercase())],
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

    #[test]
    fn pages_projection_compiles_shared_primitives() {
        let p = PagesProjection;
        let where_tag = p.compile(&FilterPrimitive::Tag("01TAG000000000000000000T1".into()));
        assert!(where_tag.sql.contains("block_tags"));
        assert_eq!(where_tag.binds.len(), 1);

        let where_priority = p.compile(&FilterPrimitive::Priority("A".into()));
        assert_eq!(where_priority.sql, "b.priority = ?");

        let where_space = p.compile(&FilterPrimitive::Space("01SPACE0001".into()));
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
             AND NOT EXISTS (SELECT 1 FROM block_links WHERE source_id = b.id)",
            "Orphan must read the materialised inbound count from pages_cache"
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
        // `today` → Rolling(1)
        let today = p.compile(&FilterPrimitive::LastEdited(LastEditedSpec::Rolling(1)));
        assert_eq!(today.binds, vec![Bind::Text("-1 days".to_string())]);
        // `this-week` → Rolling(7)
        let week = p.compile(&FilterPrimitive::LastEdited(LastEditedSpec::Rolling(7)));
        assert_eq!(week.binds, vec![Bind::Text("-7 days".to_string())]);
        // `this-month` → Rolling(30)
        let month = p.compile(&FilterPrimitive::LastEdited(LastEditedSpec::Rolling(30)));
        assert_eq!(month.binds, vec![Bind::Text("-30 days".to_string())]);
        // `older` → OlderThan(30)
        let older = p.compile(&FilterPrimitive::LastEdited(LastEditedSpec::OlderThan(30)));
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
            FilterPrimitive::Regex("foo".into()),
            FilterPrimitive::CaseSensitive(true),
            FilterPrimitive::WholeWord(true),
            FilterPrimitive::Snippet(SnippetSpec {
                max_tokens: 5,
                left_marker: "<".into(),
                right_marker: ">".into(),
            }),
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
            value: Some(PropertyValue::Text("note".into())),
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
            value: Some(PropertyValue::Text("draft".into())),
        };
        let w = p.compile(&ne);
        assert!(w.sql.contains("NOT EXISTS"));
    }

    #[test]
    fn last_edited_rolling_vs_older_than_compile_different_clauses() {
        let p = PagesProjection;
        let rolling = p.compile(&FilterPrimitive::LastEdited(LastEditedSpec::Rolling(7)));
        let older = p.compile(&FilterPrimitive::LastEdited(LastEditedSpec::OlderThan(7)));
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
        let tag = FilterPrimitive::Tag("01TAG".into());
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
        // Orphan's outbound term is `NOT EXISTS (SELECT 1 FROM block_links
        // WHERE source_id = b.id)` — that subquery IS allowed to touch
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
        // Orphan's outbound `NOT EXISTS (... source_id = b.id)` is the
        // only allowed block_links access. The plan must not regress
        // to an inbound `target_id` scan.
        assert!(
            !plan.to_lowercase().contains("target_id"),
            "composite plan must not scan block_links by target_id; got:\n{plan}"
        );
    }
}
