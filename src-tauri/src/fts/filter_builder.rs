//! M2 (#348) — `StructuralFilterBuilder`: atomic SQL-fragment +
//! placeholder-index + ordered-bind construction for the three FTS
//! structural-filter query builders.
//!
//! ## The drift hazard this removes
//!
//! `fts::search::fts_fetch_rows`, `fts::toggle_filter::regex_mode_query`,
//! and `fts::toggle_filter::filter_only_scan` each built their dynamic
//! `WHERE` SQL in one pass (hand-incrementing a `next_param` index per
//! `?N` placeholder) and then re-emitted the matching `.bind(...)` calls
//! in a *second, physically separate* pass. The two passes had to be
//! kept in lockstep by hand; an off-by-one between them would not be a
//! SQL-injection (every value is bound, never interpolated) but WOULD
//! silently misbind a value into the wrong placeholder slot.
//!
//! This builder couples the two: every `add_*` call appends the SQL
//! fragment AND records its bind value(s) into a single ordered vector
//! in the same call, so append-order and bind-order cannot diverge.
//! The caller still controls the *call order* (the three builders emit
//! their filters in slightly different orders — notably metadata vs
//! `block_type`), but within a single call the fragment and its binds
//! are atomic.
//!
//! The generated SQL is byte-identical to the pre-M2 hand-built strings
//! (verified by the existing `fts` test suite); the indentation/`AND `
//! glue prefix is passed in by each caller because it differs between
//! the `search_fts` builder (11-space indent) and the toggle builders
//! (13-space indent).

use super::metadata_filter::{MetaBind, MetadataPredicates, append_metadata_sql};
use crate::domain::search_types::SearchFilter;
use crate::filters::primitive::{Bind, FilterPrimitive, Projection, SearchProjection};

/// One bound value, tagged with its SQLite affinity. Recorded in
/// declaration order alongside the SQL fragment that references it, so
/// [`StructuralFilterBuilder::apply`] can replay the binds in the exact
/// order the placeholders were appended.
pub(super) enum ScalarBind {
    /// A text value (`parent_id`, tag id, `space_id`, glob pattern,
    /// `block_type`, `after_id`).
    Str(String),
    /// An integer value (the `COUNT(DISTINCT)` ALL-tags target, or a
    /// `LIMIT` cap).
    I64(i64),
    /// A metadata predicate bind produced by [`append_metadata_sql`];
    /// carries its own affinity dispatch via [`MetaBind::bind`].
    Meta(MetaBind),
}

/// Owns the dynamic `WHERE`-clause fragment, the running 1-based `?N`
/// placeholder index, and the ordered bind sequence as a single unit.
///
/// Construct with [`new`](Self::new) seeded at the first dynamic
/// placeholder index (the three builders reserve a different number of
/// leading base params: `search_fts` reserves `?1..?5`, the toggle
/// builders reserve none and start at `?1`). Append filters with the
/// `add_*` methods, splice the resulting `sql` into the query string,
/// then [`apply`](Self::apply) the recorded binds onto the prepared
/// query AFTER its base binds.
pub(super) struct StructuralFilterBuilder {
    /// The accumulated dynamic SQL fragment (each fragment begins with
    /// the caller-supplied `prefix`, e.g. `"\n           AND "`).
    sql: String,
    /// Next free 1-based placeholder index.
    next_param: usize,
    /// Bind values in placeholder-declaration order.
    binds: Vec<ScalarBind>,
}

impl StructuralFilterBuilder {
    /// Create a builder whose next placeholder is `first_param`.
    pub(super) fn new(first_param: usize) -> Self {
        Self {
            sql: String::new(),
            next_param: first_param,
            binds: Vec::new(),
        }
    }

    /// The accumulated dynamic SQL fragment, ready to splice into the
    /// query string after the static `WHERE` prefix.
    pub(super) fn sql(&self) -> &str {
        &self.sql
    }

    /// The next free placeholder index. The regex/filter-only builders
    /// read this to bind their trailing `LIMIT ?N` cap, whose index
    /// must follow every dynamic filter placeholder.
    pub(super) fn next_param(&self) -> usize {
        self.next_param
    }

    /// `AND b.parent_id = ?N` when `parent_id` is `Some`.
    pub(super) fn add_parent(&mut self, prefix: &str, parent_id: Option<&str>) {
        if let Some(pid) = parent_id {
            let i = self.next_param;
            self.sql.push_str(&format!("{prefix}b.parent_id = ?{i}"));
            self.next_param += 1;
            self.binds.push(ScalarBind::Str(pid.to_string()));
        }
    }

    /// ALL-tags predicate:
    /// `AND (SELECT COUNT(DISTINCT bt.tag_id) FROM block_tags bt WHERE
    ///       bt.block_id = b.id AND bt.tag_id IN (?,…)) = ?count`.
    ///
    /// `tags` must already be deduped + UPPERCASE-normalised by the
    /// caller (SQL-1 / SQL-A6) so the bound list length is achievable by
    /// `COUNT(DISTINCT)`. No-op on an empty slice. One placeholder per
    /// tag id (bound in order) plus one trailing count placeholder.
    pub(super) fn add_tags_all(&mut self, prefix: &str, tags: &[String]) {
        if tags.is_empty() {
            return;
        }
        let start = self.next_param;
        let placeholders: Vec<String> =
            (0..tags.len()).map(|i| format!("?{}", start + i)).collect();
        self.next_param += tags.len();
        let count_idx = self.next_param;
        self.next_param += 1;
        self.sql.push_str(&format!(
            "{prefix}(SELECT COUNT(DISTINCT bt.tag_id) FROM block_tags bt WHERE bt.block_id = b.id AND bt.tag_id IN ({})) = ?{count_idx}",
            placeholders.join(", ")
        ));
        for t in tags {
            self.binds.push(ScalarBind::Str(t.clone()));
        }
        // Count target — must equal the achievable DISTINCT count.
        let count: i64 = i64::try_from(tags.len()).unwrap_or(i64::MAX);
        self.binds.push(ScalarBind::I64(count));
    }

    /// `AND b.space_id = ?N` when `Some`.
    ///
    /// The fragment is identical across all three builders; only the
    /// leading `prefix` glue differs by builder indentation.
    pub(super) fn add_space(&mut self, prefix: &str, space_id: Option<&str>) {
        if let Some(sid) = space_id {
            let i = self.next_param;
            self.sql.push_str(&format!("{prefix}b.space_id = ?{i}"));
            self.next_param += 1;
            self.binds.push(ScalarBind::Str(sid.to_string()));
        }
    }

    /// #1320 PR-0 — append a pre-compiled [`crate::filters::primitive::WhereClause`]
    /// fragment (bare `?` placeholders, ordered [`Bind`]s) into this builder,
    /// renumbering each `?` to the running `?N` index in left-to-right order
    /// and recording the matching scalar binds in declaration order.
    ///
    /// This is the single splice point through which the
    /// [`SearchProjection`]-routed subset (currently `Space` only — see
    /// [`search_filter_to_primitives`] / `fts_fetch_rows`) enters the
    /// dynamic FTS WHERE clause. The projection emits bare `?`; this method
    /// is the only place that maps them onto the builder's `?N` slots, so
    /// the placeholder/bind invariant the builder guarantees still holds.
    ///
    /// Pre-condition: the fragment's `?` count MUST equal its `binds.len()`
    /// (every primitive `SearchProjection` compiles satisfies this). The
    /// renumber is a straight left-to-right substitution; the fragment must
    /// not contain a literal `?` outside a placeholder (none of the routed
    /// primitives do).
    fn add_projection_clause(&mut self, prefix: &str, sql: &str, binds: &[Bind]) {
        // Renumber bare `?` → `?{next}` left-to-right.
        let mut renumbered = String::with_capacity(sql.len() + binds.len() * 2);
        for ch in sql.chars() {
            if ch == '?' {
                let i = self.next_param;
                self.next_param += 1;
                renumbered.push('?');
                renumbered.push_str(&i.to_string());
            } else {
                renumbered.push(ch);
            }
        }
        debug_assert_eq!(
            renumbered.matches('?').count(),
            binds.len(),
            "projection fragment `?` count must equal bind count"
        );
        self.sql.push_str(prefix);
        self.sql.push_str(&renumbered);
        for b in binds {
            self.binds.push(match b {
                Bind::Text(s) => ScalarBind::Str(s.clone()),
                Bind::Int(n) => ScalarBind::I64(*n),
            });
        }
    }

    /// #1320 PR-0 — space-id filter routed through [`SearchProjection`]
    /// instead of the inline [`add_space`](Self::add_space) fragment. The
    /// projection's `compile_space` emits `b.space_id = ?` with one text
    /// bind — byte-identical (modulo placeholder numbering) to the legacy
    /// `add_space` fragment, so this is a zero-behaviour-change cutover and
    /// gives `SearchProjection` its first production call site. No-op when
    /// `space_id` is `None` (mirrors `add_space`).
    ///
    /// Only `Space` is routed here: the legacy Tag (`COUNT(DISTINCT)`
    /// ALL-semantics) and property (`prop:` four-column OR) fragments are
    /// NOT byte-identical to their `SearchProjection` counterparts and stay
    /// on the legacy path — see `search_filter_to_primitives` and the
    /// `projection_space_parity` test for the proof.
    pub(super) fn add_space_via_projection(&mut self, prefix: &str, space_id: Option<&str>) {
        let Some(sid) = space_id else { return };
        let prims = vec![FilterPrimitive::Space {
            space_id: sid.to_string(),
        }];
        for prim in &prims {
            let wc = SearchProjection.compile(prim);
            self.add_projection_clause(prefix, &wc.sql, &wc.binds);
        }
    }

    /// #1320 PR-1 — ALL-tags filter routed through [`SearchProjection`]
    /// instead of the inline [`add_tags_all`](Self::add_tags_all)
    /// `COUNT(DISTINCT)` fragment. For each requested tag, compiles a
    /// [`FilterPrimitive::Tag`] (which `SearchProjection::compile_tag`
    /// emits as `b.id IN (SELECT block_id FROM block_tags WHERE tag_id =
    /// ?)`) and splices it through [`add_projection_clause`] under the same
    /// `prefix`. Because every per-tag fragment is AND-joined with the same
    /// `AND ` glue prefix, a block must sit in EVERY per-tag set — i.e. it
    /// must carry every requested tag. That is RESULT-EQUIVALENT to the
    /// legacy `COUNT(DISTINCT bt.tag_id) = N` ALL-semantics (proved by the
    /// `tags_via_projection_matches_legacy_*` DB equivalence tests), though
    /// the emitted SQL SHAPE differs (N IN-subselects vs one
    /// `COUNT(DISTINCT)` sub-select).
    ///
    /// `tags` must already be deduped + UPPERCASE-normalised by the caller
    /// (SQL-1 / SQL-A6) — dedup is now a correctness-neutral nicety rather
    /// than a hard requirement (a duplicated tag id only emits a redundant
    /// identical IN-subselect), but the caller keeps deduping for SQL
    /// economy. No-op on an empty slice (mirrors `add_tags_all`). The
    /// loop calls `add_projection_clause` once per tag, each consuming one
    /// `?N` placeholder, so `next_param` advances by exactly `tags.len()`.
    pub(super) fn add_tags_via_projection(&mut self, prefix: &str, tags: &[String]) {
        if tags.is_empty() {
            return;
        }
        for tag in tags {
            let prim = FilterPrimitive::Tag { tag: tag.clone() };
            let wc = SearchProjection.compile(&prim);
            self.add_projection_clause(prefix, &wc.sql, &wc.binds);
        }
    }

    /// `AND b.page_id [NOT ]IN (SELECT pc.page_id FROM pages_cache pc
    ///   WHERE LOWER(pc.title) GLOB ?N OR …)` — delegates the fragment
    /// to the shared [`super::glob_filter::append_page_glob_subselect`]
    /// helper (P2 #346) and records the bind for each pattern in order.
    pub(super) fn add_page_globs(&mut self, prefix: &str, negate: bool, globs: &[String]) {
        if super::glob_filter::append_page_glob_subselect(
            &mut self.sql,
            prefix,
            negate,
            &mut self.next_param,
            globs,
        )
        .is_some()
        {
            for g in globs {
                self.binds.push(ScalarBind::Str(g.clone()));
            }
        }
    }

    /// #1320 PR-2 — page-name-glob filter routed through [`SearchProjection`]
    /// instead of the inline [`add_page_globs`](Self::add_page_globs)
    /// `append_page_glob_subselect` fragment, preserving the LEGACY
    /// `LOWER(title) GLOB ?` dialect byte-for-byte at the result level
    /// (zero behaviour change — search users keep `GLOB` + brace +
    /// `[class]` semantics).
    ///
    /// `prepared_globs` are the patterns the caller already ran through
    /// [`super::glob_filter::prepare_globs`] (brace-expanded,
    /// substring-wrapped, ASCII-lowercased) — IDENTICAL input contract to
    /// the legacy `add_page_globs`, so the `fts_fetch_rows` swap is a pure
    /// drop-in (the prepare happens once upstream in
    /// `commands::queries::prepare_search_filter`; re-preprocessing here
    /// would double-wrap). Each pattern compiles to one
    /// `SearchProjection::compile_path_glob` fragment:
    ///   `b.page_id [NOT ]IN (SELECT page_id FROM pages_cache
    ///                        WHERE LOWER(title) GLOB ?)`.
    ///
    /// ## Multiplicity (the load-bearing join semantics)
    ///
    /// The legacy helper folds ALL patterns into ONE sub-select whose
    /// inner `GLOB` terms are OR-joined, so a page matches if its title
    /// matches ANY pattern:
    ///   `b.page_id IN  (… GLOB ?a OR GLOB ?b)`  (include = set union)
    ///   `b.page_id NOT IN (… GLOB ?a OR GLOB ?b)` (exclude = set diff)
    ///
    /// Routed per-pattern, that becomes:
    /// - INCLUDE (`negate == false`): the per-pattern `IN`-fragments are
    ///   **OR-joined** and wrapped in parens —
    ///   `(b.page_id IN (?a) OR b.page_id IN (?b))` ≡ `IN (… ?a OR ?b)`.
    ///   The parens keep the OR-group atomic against the surrounding
    ///   AND-joined builder clauses.
    /// - EXCLUDE (`negate == true`): the per-pattern `NOT IN`-fragments are
    ///   **AND-joined** (each via [`add_projection_clause`] under `prefix`)
    ///   — `b.page_id NOT IN (?a) AND b.page_id NOT IN (?b)` ≡ NONE match ≡
    ///   `NOT IN (… ?a OR ?b)`.
    ///
    /// No-op on an empty slice (mirrors `add_page_globs`). Each compiled
    /// fragment carries one `?` placeholder; `add_projection_clause`
    /// advances `next_param` by one per call, so the running index stays
    /// consistent regardless of the OR/AND branch.
    pub(super) fn add_page_globs_via_projection(
        &mut self,
        prefix: &str,
        negate: bool,
        prepared_globs: &[String],
    ) {
        if prepared_globs.is_empty() {
            return;
        }
        if negate {
            // EXCLUDE: AND-join each `NOT IN` fragment under `prefix`, so a
            // page must fall outside EVERY per-pattern set.
            for pat in prepared_globs {
                let wc = SearchProjection.compile(&FilterPrimitive::PathGlob {
                    pattern: pat.clone(),
                    exclude: true,
                });
                self.add_projection_clause(prefix, &wc.sql, &wc.binds);
            }
        } else {
            // INCLUDE: OR-join the per-pattern `IN` fragments inside one
            // paren-wrapped group spliced under a single `prefix`, so a page
            // matches if its title matches ANY pattern (set union).
            self.sql.push_str(prefix);
            self.sql.push('(');
            for (i, pat) in prepared_globs.iter().enumerate() {
                if i > 0 {
                    self.sql.push_str(" OR ");
                }
                let wc = SearchProjection.compile(&FilterPrimitive::PathGlob {
                    pattern: pat.clone(),
                    exclude: false,
                });
                // Renumber the fragment's single bare `?` to the running
                // `?N` slot and record its bind (same contract as
                // `add_projection_clause`, but with empty glue so the OR is
                // the only separator and the paren group stays intact).
                self.add_projection_clause("", &wc.sql, &wc.binds);
            }
            self.sql.push(')');
        }
    }

    /// `AND b.block_type = ?N` when `Some`.
    pub(super) fn add_block_type(&mut self, prefix: &str, block_type: Option<&str>) {
        if let Some(bt) = block_type {
            let i = self.next_param;
            self.sql.push_str(&format!("{prefix}b.block_type = ?{i}"));
            self.next_param += 1;
            self.binds.push(ScalarBind::Str(bt.to_string()));
        }
    }

    /// `AND b.id < ?N` keyset cursor predicate when `Some`.
    pub(super) fn add_after_id(&mut self, prefix: &str, after_id: Option<&str>) {
        if let Some(aid) = after_id {
            let i = self.next_param;
            self.sql.push_str(&format!("{prefix}b.id < ?{i}"));
            self.next_param += 1;
            self.binds.push(ScalarBind::Str(aid.to_string()));
        }
    }

    /// Splice the PEND-53 metadata predicates into the fragment via the
    /// shared [`append_metadata_sql`], recording each returned bind in
    /// declaration order. The relative position of this call vs
    /// [`add_block_type`](Self::add_block_type) differs between the FTS
    /// and the toggle builders — the caller drives that order.
    pub(super) fn add_metadata(&mut self, metadata: &MetadataPredicates, alias: &str) {
        let meta_binds = append_metadata_sql(&mut self.sql, &mut self.next_param, metadata, alias);
        for mb in meta_binds {
            self.binds.push(ScalarBind::Meta(mb));
        }
    }

    /// Replay the recorded binds onto `query`, in declaration order.
    /// Call AFTER binding the query's fixed base parameters and BEFORE
    /// binding any trailing param (e.g. a `LIMIT` cap) whose placeholder
    /// index the builder reserved last via [`next_param`](Self::next_param).
    pub(super) fn apply<'q, O>(
        &'q self,
        mut query: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    ) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
        for bind in &self.binds {
            query = match bind {
                ScalarBind::Str(s) => query.bind(s),
                ScalarBind::I64(n) => query.bind(n),
                ScalarBind::Meta(mb) => mb.bind(query),
            };
        }
        query
    }

    /// Number of recorded scalar binds (test-only invariant check).
    #[cfg(test)]
    pub(super) fn bind_count(&self) -> usize {
        self.binds.len()
    }
}

/// #1320 PR-0 — lift the genuinely-shared filter subset (`Tag`,
/// `HasProperty`, `Space`) from the flat [`SearchFilter`] into
/// [`FilterPrimitive`]s, so they can be compiled through
/// [`SearchProjection`] (the cross-surface filter compiler) instead of the
/// bespoke inline FTS fragments.
///
/// **Scope (zero-behaviour-change contract):** this lifts ONLY the shared
/// subset. Path globs, metadata (state / priority / due / scheduled),
/// `block_type`, the toggle filters, and the FTS `MATCH` query itself are
/// left entirely on the legacy path — they diverge from the projection and
/// are out of scope for PR-0.
///
/// **Mapping:**
/// - `tag_ids` → one [`FilterPrimitive::Tag`] per tag (ALL/AND semantics:
///   the caller AND-joins, so every tag must be present).
/// - `property_filters` (includes) with a non-empty `value` →
///   [`FilterPrimitive::HasProperty`] with `Eq { Text }`; with an empty
///   `value` → `Exists` (key-presence-only).
/// - `space_id` (non-empty) → [`FilterPrimitive::Space`].
///
/// **Production routing note:** only the `Space` primitive is actually
/// routed through `SearchProjection` in `fts_fetch_rows` today (see
/// [`StructuralFilterBuilder::add_space_via_projection`]). The `Tag` and
/// `HasProperty` primitives this adapter produces are NOT yet routed: their
/// `SearchProjection` SQL is not byte-identical to the legacy fragments
/// (Tag = `COUNT(DISTINCT)` ALL-semantics; property = `prop:` four-column
/// OR with a `bp.` alias), so cutting them over would change behaviour. The
/// adapter emits them anyway so the full shared lift is available for the
/// follow-up PR and so the parity test can assert the divergence explicitly.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn search_filter_to_primitives(filter: &SearchFilter) -> Vec<FilterPrimitive> {
    use crate::filters::primitive::{PropertyPredicate, PropertyValue};

    let mut out = Vec::new();

    // Tags — one primitive per tag (ALL / AND semantics on AND-join).
    for tag in &filter.tag_ids {
        out.push(FilterPrimitive::Tag { tag: tag.clone() });
    }

    // Property includes — text-eq, or key-presence (Exists) when empty.
    for pf in &filter.property_filters {
        let predicate = if pf.value.is_empty() {
            PropertyPredicate::Exists
        } else {
            PropertyPredicate::Eq {
                value: PropertyValue::Text {
                    value: pf.value.clone(),
                },
            }
        };
        out.push(FilterPrimitive::HasProperty {
            key: pf.key.clone(),
            predicate,
        });
    }

    // Space — only when a non-empty space id is present.
    if let Some(sid) = filter.space_id.as_deref()
        && !sid.is_empty()
    {
        out.push(FilterPrimitive::Space {
            space_id: sid.to_string(),
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FTS_PREFIX: &str = "\n           AND ";
    const TOGGLE_PREFIX: &str = "\n             AND ";

    #[test]
    fn parent_fragment_is_byte_identical() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_parent(FTS_PREFIX, Some("blk"));
        assert_eq!(fb.sql(), "\n           AND b.parent_id = ?6");
        assert_eq!(fb.next_param(), 7);
        assert_eq!(fb.bind_count(), 1);
    }

    #[test]
    fn parent_none_is_noop() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_parent(FTS_PREFIX, None);
        assert_eq!(fb.sql(), "");
        assert_eq!(fb.next_param(), 6);
        assert_eq!(fb.bind_count(), 0);
    }

    #[test]
    fn tags_all_fragment_matches_legacy_shape() {
        let mut fb = StructuralFilterBuilder::new(6);
        let tags = vec!["A".to_string(), "B".to_string()];
        fb.add_tags_all(FTS_PREFIX, &tags);
        assert_eq!(
            fb.sql(),
            "\n           AND (SELECT COUNT(DISTINCT bt.tag_id) FROM block_tags bt WHERE bt.block_id = b.id AND bt.tag_id IN (?6, ?7)) = ?8"
        );
        // 2 tag binds + 1 count bind, count placeholder is ?8.
        assert_eq!(fb.next_param(), 9);
        assert_eq!(fb.bind_count(), 3);
    }

    #[test]
    fn tags_all_empty_is_noop() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_tags_all(FTS_PREFIX, &[]);
        assert_eq!(fb.sql(), "");
        assert_eq!(fb.next_param(), 6);
    }

    #[test]
    fn space_fragment_matches_canonical_inner() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_space(FTS_PREFIX, Some("space1"));
        assert_eq!(fb.sql(), "\n           AND b.space_id = ?6");
        assert_eq!(fb.next_param(), 7);
    }

    // ── #1320 PR-0 — SearchProjection cutover parity ──────────────────
    //
    // The zero-behaviour-change contract: routing the shared subset through
    // `SearchProjection` must emit byte-identical SQL + binds to the legacy
    // inline fragment, OR the predicate stays on the legacy path. These
    // tests prove which predicates are byte-identical (cut over) and which
    // are NOT (excluded, kept legacy). Modeled on `backlink/tests::parity_p1`.

    /// Space IS byte-identical between the legacy `add_space` fragment and
    /// the `SearchProjection`-routed `add_space_via_projection` — so it is
    /// the predicate we cut over in `fts_fetch_rows`. SQL string + bind
    /// sequence (and the consumed placeholder index) must match exactly.
    #[test]
    fn projection_space_parity() {
        // Legacy path.
        let mut legacy = StructuralFilterBuilder::new(6);
        legacy.add_space(FTS_PREFIX, Some("01SPACE0001"));

        // Projection-routed path (the production cutover).
        let mut routed = StructuralFilterBuilder::new(6);
        routed.add_space_via_projection(FTS_PREFIX, Some("01SPACE0001"));

        assert_eq!(
            routed.sql(),
            legacy.sql(),
            "Space fragment must be byte-identical via SearchProjection"
        );
        assert_eq!(
            routed.sql(),
            "\n           AND b.space_id = ?6",
            "Space fragment snapshot"
        );
        assert_eq!(
            routed.next_param(),
            legacy.next_param(),
            "Space must consume the same number of placeholders"
        );
        assert_eq!(routed.next_param(), 7);
        assert_eq!(
            routed.bind_count(),
            legacy.bind_count(),
            "Space must record the same bind count"
        );
        assert_eq!(routed.bind_count(), 1);
        // Bind value parity.
        assert!(matches!(
            routed.binds.first(),
            Some(ScalarBind::Str(s)) if s == "01SPACE0001"
        ));
    }

    /// `add_space_via_projection(None)` is a no-op, mirroring `add_space`.
    #[test]
    fn projection_space_none_is_noop() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_space_via_projection(FTS_PREFIX, None);
        assert_eq!(fb.sql(), "");
        assert_eq!(fb.next_param(), 6);
        assert_eq!(fb.bind_count(), 0);
    }

    /// #1320 PR-1 — Tag is now ROUTED through `SearchProjection` in
    /// `fts_fetch_rows` (`add_tags_via_projection`), replacing the legacy
    /// inline `COUNT(DISTINCT)` ALL-semantics fragment (`add_tags_all`).
    ///
    /// The two SQL SHAPES still differ — that divergence is real and
    /// intentional: the legacy fragment is a single `COUNT(DISTINCT
    /// bt.tag_id) = N` sub-select, while the routed path emits N per-tag
    /// `b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?N)`
    /// sub-selects AND-joined under the same prefix. They are
    /// RESULT-EQUIVALENT (a block in every per-tag set has all N tags),
    /// proved at the DB level by the `tags_via_projection_matches_legacy_*`
    /// equivalence tests below.
    ///
    /// This test (formerly `projection_tag_diverges_from_legacy_kept_legacy`)
    /// is repurposed to PIN the routed behaviour: it asserts the exact SQL
    /// `add_tags_via_projection` now emits, that it AND-joins per tag with
    /// correct placeholder renumbering, and documents (via the still-present
    /// shape divergence assertion) that the SQL differs from the legacy
    /// `COUNT(DISTINCT)` form even though the result set is identical.
    #[test]
    fn tags_via_projection_routes_and_documents_shape_cutover() {
        // Routed path (the production cutover) — two tags, ALL-semantics.
        let mut routed = StructuralFilterBuilder::new(6);
        routed.add_tags_via_projection(
            FTS_PREFIX,
            &[
                "01TAG0000000000000000000A".to_string(),
                "01TAG0000000000000000000B".to_string(),
            ],
        );

        // Exact SQL snapshot: two per-tag IN-subselects, AND-joined, with
        // renumbered `?6` / `?7` placeholders (one bind each).
        assert_eq!(
            routed.sql(),
            "\n           AND b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?6)\
             \n           AND b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?7)",
            "routed Tag emits N AND-joined per-tag IN sub-selects"
        );
        assert_eq!(routed.next_param(), 8, "two tags consume ?6 and ?7");
        assert_eq!(routed.bind_count(), 2, "one bind per tag, no count bind");
        assert!(
            matches!(routed.binds.first(), Some(ScalarBind::Str(s)) if s == "01TAG0000000000000000000A")
        );

        // Shape divergence from the legacy COUNT(DISTINCT) fragment is
        // intentional and documented — the result sets are equivalent
        // (see the DB equivalence tests), only the SQL shape differs.
        let mut legacy = StructuralFilterBuilder::new(6);
        legacy.add_tags_all(
            FTS_PREFIX,
            &[
                "01TAG0000000000000000000A".to_string(),
                "01TAG0000000000000000000B".to_string(),
            ],
        );
        assert!(
            legacy.sql().contains("COUNT(DISTINCT bt.tag_id)"),
            "legacy Tag uses COUNT(DISTINCT) ALL-semantics"
        );
        assert_ne!(
            legacy.sql(),
            routed.sql(),
            "routed Tag SQL shape differs from legacy (result-equivalent, not byte-identical)"
        );
    }

    /// HasProperty (both Exists and Eq-text) does NOT compile
    /// byte-identically: the legacy `prop:` fragment uses a `bp.`-aliased
    /// sub-select and (for a value) a four-column OR across
    /// `value_text` / `value_num` / `value_date` / `value_ref`;
    /// `SearchProjection` emits an un-aliased `value_text`-only sub-select.
    /// This is WHY HasProperty is excluded from the PR-0 cutover.
    #[test]
    fn projection_has_property_diverges_from_legacy_kept_legacy() {
        use crate::domain::search_types::SearchPropertyFilter;
        use crate::filters::primitive::{FilterPrimitive, PropertyPredicate, PropertyValue};
        use crate::fts::metadata_filter::{MetadataPredicates, append_metadata_sql};

        // --- Exists (key-presence only) ---
        let mut legacy_exists = String::new();
        let mut np = 6;
        let meta_exists = MetadataPredicates {
            property_includes: vec![SearchPropertyFilter {
                key: "kind".into(),
                value: String::new(),
            }],
            ..Default::default()
        };
        append_metadata_sql(&mut legacy_exists, &mut np, &meta_exists, "b");
        let proj_exists = SearchProjection.compile(&FilterPrimitive::HasProperty {
            key: "kind".into(),
            predicate: PropertyPredicate::Exists,
        });
        assert!(
            legacy_exists.contains("block_properties bp") && legacy_exists.contains("bp.key = ?"),
            "legacy property uses a `bp.`-aliased sub-select"
        );
        assert!(
            !proj_exists.sql.contains("bp."),
            "projection property is un-aliased"
        );
        assert_ne!(
            legacy_exists.trim_start().trim_start_matches("AND "),
            proj_exists.sql,
            "Exists fragments diverge — HasProperty MUST stay legacy"
        );

        // --- Eq { Text } ---
        let mut legacy_eq = String::new();
        let mut np2 = 6;
        let meta_eq = MetadataPredicates {
            property_includes: vec![SearchPropertyFilter {
                key: "kind".into(),
                value: "note".into(),
            }],
            ..Default::default()
        };
        append_metadata_sql(&mut legacy_eq, &mut np2, &meta_eq, "b");
        let proj_eq = SearchProjection.compile(&FilterPrimitive::HasProperty {
            key: "kind".into(),
            predicate: PropertyPredicate::Eq {
                value: PropertyValue::Text {
                    value: "note".into(),
                },
            },
        });
        assert!(
            legacy_eq.contains("value_num") && legacy_eq.contains("value_ref"),
            "legacy `prop:KEY=VALUE` is a four-column OR"
        );
        assert!(
            !proj_eq.sql.contains("value_num"),
            "projection Eq-text compares value_text only"
        );
        assert_ne!(
            legacy_eq.trim_start().trim_start_matches("AND "),
            proj_eq.sql,
            "Eq-text fragments diverge — HasProperty MUST stay legacy"
        );
    }

    /// The adapter lifts ONLY the shared subset (Tag / HasProperty / Space)
    /// and nothing else (globs, metadata, toggles, block_type, the MATCH
    /// query). Order: tags, then property includes, then space.
    #[test]
    fn adapter_lifts_only_shared_subset() {
        use crate::domain::search_types::{SearchFilter, SearchPropertyFilter};
        use crate::filters::primitive::{FilterPrimitive, PropertyPredicate, PropertyValue};

        let filter = SearchFilter {
            tag_ids: vec!["TAGA".into(), "TAGB".into()],
            space_id: Some("01SPACE0001".into()),
            property_filters: vec![
                SearchPropertyFilter {
                    key: "kind".into(),
                    value: "note".into(),
                },
                SearchPropertyFilter {
                    key: "archived".into(),
                    value: String::new(),
                },
            ],
            // Everything below must be IGNORED by the adapter.
            include_page_globs: vec!["Proj/*".into()],
            exclude_page_globs: vec!["Trash/*".into()],
            state_filter: vec!["DONE".into()],
            priority_filter: vec!["A".into()],
            block_type_filter: Some("page".into()),
            is_regex: true,
            case_sensitive: true,
            whole_word: true,
            parent_id: Some("blk".into()),
            ..Default::default()
        };

        let prims = search_filter_to_primitives(&filter);
        assert_eq!(
            prims,
            vec![
                FilterPrimitive::Tag { tag: "TAGA".into() },
                FilterPrimitive::Tag { tag: "TAGB".into() },
                FilterPrimitive::HasProperty {
                    key: "kind".into(),
                    predicate: PropertyPredicate::Eq {
                        value: PropertyValue::Text {
                            value: "note".into()
                        },
                    },
                },
                FilterPrimitive::HasProperty {
                    key: "archived".into(),
                    predicate: PropertyPredicate::Exists,
                },
                FilterPrimitive::Space {
                    space_id: "01SPACE0001".into(),
                },
            ],
            "adapter must lift exactly the shared subset, in order, and nothing else"
        );
    }

    /// An empty / `None` space id produces no `Space` primitive (matches the
    /// SQL path's "empty string ⇒ no space primitive" treatment).
    #[test]
    fn adapter_skips_empty_space() {
        use crate::domain::search_types::SearchFilter;

        let none = SearchFilter::default();
        assert!(search_filter_to_primitives(&none).is_empty());

        let empty = SearchFilter {
            space_id: Some(String::new()),
            ..Default::default()
        };
        assert!(
            search_filter_to_primitives(&empty).is_empty(),
            "empty space id must not yield a Space primitive"
        );
    }

    #[test]
    fn space_inner_is_indent_independent() {
        // Both builders must produce the SAME sub-select body — only the
        // leading prefix differs. (The pre-M2 `\`-continuation source
        // strings collapsed inter-line indent to a single space.)
        let mut a = StructuralFilterBuilder::new(2);
        a.add_space(FTS_PREFIX, Some("s"));
        let mut b = StructuralFilterBuilder::new(2);
        b.add_space(TOGGLE_PREFIX, Some("s"));
        let strip_prefix = |s: &str| s.trim_start().to_string();
        assert_eq!(strip_prefix(a.sql()), strip_prefix(b.sql()));
    }

    #[test]
    fn page_globs_include_and_exclude_advance_index() {
        let mut fb = StructuralFilterBuilder::new(6);
        let globs = vec!["*foo*".to_string()];
        fb.add_page_globs(FTS_PREFIX, false, &globs);
        assert_eq!(
            fb.sql(),
            "\n           AND b.page_id IN (SELECT pc.page_id FROM pages_cache pc WHERE LOWER(pc.title) GLOB ?6)"
        );
        fb.add_page_globs(FTS_PREFIX, true, &globs);
        assert!(fb.sql().contains("b.page_id NOT IN"));
        assert!(fb.sql().contains("GLOB ?7"));
        assert_eq!(fb.next_param(), 8);
        assert_eq!(fb.bind_count(), 2);
    }

    #[test]
    fn block_type_and_after_id_fragments() {
        let mut fb = StructuralFilterBuilder::new(3);
        fb.add_block_type(TOGGLE_PREFIX, Some("page"));
        assert_eq!(fb.sql(), "\n             AND b.block_type = ?3");
        fb.add_after_id(TOGGLE_PREFIX, Some("cursor"));
        assert!(fb.sql().ends_with("\n             AND b.id < ?4"));
        assert_eq!(fb.next_param(), 5);
        assert_eq!(fb.bind_count(), 2);
    }

    #[test]
    fn call_order_drives_placeholder_order() {
        // Mirrors the regex builder's order (metadata omitted): parent,
        // tags, space, globs, block_type. Indices must increase
        // monotonically with no gaps or reuse.
        let mut fb = StructuralFilterBuilder::new(1);
        fb.add_parent(TOGGLE_PREFIX, Some("p")); // ?1
        fb.add_tags_all(TOGGLE_PREFIX, &["T".to_string()]); // ?2 (tag) ?3 (count)
        fb.add_space(TOGGLE_PREFIX, Some("s")); // ?4
        fb.add_page_globs(TOGGLE_PREFIX, false, &["*g*".to_string()]); // ?5
        fb.add_block_type(TOGGLE_PREFIX, Some("page")); // ?6
        assert_eq!(fb.next_param(), 7);
        // parent(1) + tags_all(1 tag + 1 count = 2) + space(1) + glob(1)
        // + block_type(1) = 6 recorded binds.
        assert_eq!(fb.bind_count(), 6);
        // Placeholders appear in ascending order in the SQL.
        let sql = fb.sql();
        let p1 = sql.find("?1").unwrap();
        let p4 = sql.find("?4").unwrap();
        let p6 = sql.find("?6").unwrap();
        assert!(p1 < p4 && p4 < p6, "placeholders must be in source order");
    }
}
