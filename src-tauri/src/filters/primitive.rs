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
    /// (`Stub` is similar but excludes the AND-no-outbound clause.)
    Orphan,
    /// Pages-only — page has fewer than a "stub" threshold of descendants.
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
    /// - **0 (index-backed):** `Tag`, `HasProperty`, `Space`,
    ///   `LastEdited`, `Orphan`, `Stub`, `HasNoInboundLinks` — each hits
    ///   an existing index (`idx_block_props_key`, `idx_op_log_created`,
    ///   `idx_block_links_target/source`, `idx_blocks_page_id`).
    /// - **1 (full scan, cheap):** `Priority` — no dedicated index, but a
    ///   single equality scan over `blocks.priority`; cheap at vault
    ///   scale.
    /// - **2 (full scan, GLOB):** `PathGlob` when the pattern has no
    ///   leading anchor (a true table scan of `pages_cache.title`). An
    ///   anchored prefix glob (`foo*`) is range-scannable, so it ranks as
    ///   index-backed (0).
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
            | FilterPrimitive::LastEdited { .. }
            | FilterPrimitive::Orphan
            | FilterPrimitive::Stub
            | FilterPrimitive::HasNoInboundLinks => 0,
            FilterPrimitive::Priority { .. } => 1,
            // Anchored prefix globs (`foo*`, no leading `*`/`?`/`[`) are
            // range-scannable → index-backed cost. A leading wildcard
            // forces a full scan → ranked highest among SQL primitives.
            FilterPrimitive::PathGlob { pattern, .. } => {
                if pattern.starts_with(['*', '?', '[']) {
                    2
                } else {
                    0
                }
            }
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
        // Pages-only — no inbound AND no outbound links.
        WhereClause::new(
            "NOT EXISTS (SELECT 1 FROM block_links WHERE target_id = b.id) \
             AND NOT EXISTS (SELECT 1 FROM block_links WHERE source_id = b.id)",
            Vec::new(),
        )
    }
    fn compile_stub(&self) -> WhereClause {
        // Stub: page has fewer than 3 descendants. Threshold is the
        // industry-conventional one for "needs more content"; tunable
        // per PEND-58 follow-up if user feedback wants it.
        WhereClause::new(
            "(SELECT COUNT(*) FROM blocks d \
              WHERE d.page_id = b.id AND d.deleted_at IS NULL AND d.id != b.id) < 3",
            Vec::new(),
        )
    }
    fn compile_has_no_inbound_links(&self) -> WhereClause {
        WhereClause::new(
            "NOT EXISTS (SELECT 1 FROM block_links WHERE target_id = b.id)",
            Vec::new(),
        )
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
        assert_eq!(
            FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Rolling { days: 7 }
            }
            .cost_hint(),
            0
        );
        // Priority — full scan but cheap (1).
        assert_eq!(
            FilterPrimitive::Priority {
                priority: "A".into()
            }
            .cost_hint(),
            1
        );
        // Anchored glob is range-scannable (0); leading-wildcard glob is
        // a full scan (2).
        assert_eq!(
            FilterPrimitive::PathGlob {
                pattern: "foo*".into(),
                exclude: false
            }
            .cost_hint(),
            0
        );
        assert_eq!(
            FilterPrimitive::PathGlob {
                pattern: "*foo*".into(),
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
