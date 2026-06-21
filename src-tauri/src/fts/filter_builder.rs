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

use super::metadata_filter::{
    DatePredicate as MetaDatePredicate, MetaBind, MetadataPredicates, untyped_property_clause,
};
use crate::domain::search_types::{DateOp, SearchFilter, SearchPropertyFilter};
use crate::filters::primitive::{
    Bind, DatePredicate, FilterPrimitive, LastEditedSpec, Projection, SearchProjection,
};

/// #1280 B2 — bridge the search-side resolved [`MetaDatePredicate`]
/// (`IsNull` / `Range` / `Op{DateOp}`) onto the cross-surface
/// [`DatePredicate`] the projection compiles. The resolver oracle treats the
/// `due_date` / `scheduled_date` columns as DATE-exact, so `Op{Eq}` maps to
/// `On` (the projection's exact `= ?` form, NOT the half-open day expansion)
/// and `Range` maps to the inclusive `Between` — keeping the compiled SQL
/// result-equivalent to the legacy `append_date_predicate` fragment.
fn meta_date_to_primitive(pred: &MetaDatePredicate) -> DatePredicate {
    match pred {
        MetaDatePredicate::IsNull => DatePredicate::IsNull,
        MetaDatePredicate::Range { from, to } => DatePredicate::Between {
            from: from.clone(),
            to: to.clone(),
        },
        MetaDatePredicate::Op { op, date } => {
            let date = date.clone();
            match op {
                DateOp::Lt => DatePredicate::Before { date },
                DateOp::Lte => DatePredicate::OnOrBefore { date },
                DateOp::Eq => DatePredicate::On { date },
                DateOp::Gte => DatePredicate::OnOrAfter { date },
                DateOp::Gt => DatePredicate::After { date },
            }
        }
    }
}

/// #1320-C / #1280 B2 — `AND ` glue prefix for the projection-routed
/// metadata clauses (`last-edited:`, and now `state:` / `due-date:` /
/// `scheduled:`). Matches the 11-space indentation `append_metadata_sql`
/// uses for its sibling metadata fragments, so the spliced clauses line up
/// byte-for-byte with the legacy fragments in the generated SQL.
const LAST_EDITED_PREFIX: &str = "\n           AND ";

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
    /// #1280 — a real (`f64`) value. Reachable-but-unused on the FTS side
    /// for now (the routed search primitives emit only `Text`/`Int`); added
    /// so the [`Bind`] → `ScalarBind` mapping stays exhaustive after the
    /// `Bind::Real` variant landed for `BacklinkProjection`.
    F64(f64),
    /// A metadata predicate bind produced by the search property leaf
    /// (`untyped_property_clause`); carries its own affinity dispatch via
    /// [`MetaBind::bind`] (text / nullable-text / nullable-f64).
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

    /// #1320 append a pre-compiled [`crate::filters::primitive::WhereClause`]
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
                Bind::Real(n) => ScalarBind::F64(*n),
            });
        }
    }

    /// P3.2 — splice a bare-`?` fragment whose binds are [`MetaBind`]s
    /// (the search property leaf, which needs the nullable `value_num` /
    /// `value_date` / `value_ref` bind variants that the cross-surface
    /// [`Bind`] enum deliberately does not carry — see
    /// [`untyped_property_clause`]). Mirrors
    /// [`add_projection_clause`](Self::add_projection_clause) exactly: it
    /// renumbers each bare `?` to the running `?N` index left-to-right and
    /// records the matching [`ScalarBind::Meta`] binds in declaration order,
    /// so the placeholder/bind invariant the builder guarantees still holds.
    fn add_meta_projection_clause(&mut self, prefix: &str, sql: &str, binds: Vec<MetaBind>) {
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
            "property fragment `?` count must equal bind count"
        );
        self.sql.push_str(prefix);
        self.sql.push_str(&renumbered);
        for b in binds {
            self.binds.push(ScalarBind::Meta(b));
        }
    }

    /// P3.2 — `prop:KEY[=VALUE]` (include) filter routed through the
    /// search-surface untyped property leaf
    /// ([`untyped_property_clause`]). Replaces the legacy
    /// `append_metadata_sql` four-column-OR emission. This is the search
    /// property leaf's sole splice point; it preserves the untyped
    /// four-column (`value_text` / `value_num` / `value_date` /
    /// `value_ref`) match VERBATIM (see [`untyped_property_clause`] for why
    /// it does NOT route through the typed
    /// [`crate::filters::primitive::Projection::compile_has_property`]).
    pub(super) fn add_property_via_projection(&mut self, prefix: &str, pf: &SearchPropertyFilter) {
        let (sql, binds) = untyped_property_clause(pf, false);
        self.add_meta_projection_clause(prefix, &sql, binds);
    }

    /// P3.2 — `prop:KEY[=VALUE]` (exclude) filter — the `NOT EXISTS`
    /// sibling of [`add_property_via_projection`](Self::add_property_via_projection).
    pub(super) fn add_excluded_property_via_projection(
        &mut self,
        prefix: &str,
        pf: &SearchPropertyFilter,
    ) {
        let (sql, binds) = untyped_property_clause(pf, true);
        self.add_meta_projection_clause(prefix, &sql, binds);
    }

    /// #1320 space-id filter routed through [`SearchProjection`]
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

    /// #1320-C — `last-edited:` window filter routed through
    /// [`SearchProjection`] (`compile_last_edited`, which delegates to
    /// `PagesProjection`). The projection emits a
    /// `COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id),
    /// 0) <op> ?` comparison against the block's last-edit epoch-ms — so it
    /// references the block table via the hardcoded `b.` alias the three FTS
    /// builders use. Mirrors [`add_space_via_projection`]: build one
    /// [`FilterPrimitive::LastEdited`], compile it, and splice the
    /// bare-`?` fragment + ordered binds through
    /// [`add_projection_clause`](Self::add_projection_clause). The caller
    /// only invokes this when the spec is present (see
    /// [`add_metadata`](Self::add_metadata)).
    pub(super) fn add_last_edited_via_projection(&mut self, prefix: &str, spec: &LastEditedSpec) {
        let prim = FilterPrimitive::LastEdited { spec: spec.clone() };
        let wc = SearchProjection.compile(&prim);
        self.add_projection_clause(prefix, &wc.sql, &wc.binds);
    }

    /// #1280 B2 — `state:` membership filter routed through
    /// [`SearchProjection`] (`compile_state`, which delegates to the canonical
    /// A2 `PagesProjection` SQL). Replaces the legacy `append_metadata_sql`
    /// emission of the `b.todo_state IN (…) / IS NULL` include clause and the
    /// `b.todo_state IS NULL OR … NOT IN (…)` exclude clause. The A2 SQL is
    /// byte-shape-identical to the legacy `append_text_in_or_null` /
    /// `append_text_not_in_or_not_null` oracle, so this is a zero-behaviour-
    /// change cutover at the result level.
    ///
    /// Legacy state carries BOTH an include set (`state_values`/`state_is_null`)
    /// and an exclude set (`excluded_state_values`/`excluded_state_not_null`).
    /// The caller emits TWO primitives — an include `State { exclude: false }`
    /// and an exclude `State { exclude: true }` — feeding each here. Each
    /// emits its own AND-joined fragment under `prefix`, matching the legacy
    /// two-clause shape. An empty include (no values, not is_null) compiles to
    /// the no-op `1=1`, matching the legacy helper's early return; we splice it
    /// regardless (a `1=1` AND-clause is inert), keeping the call unconditional.
    pub(super) fn add_state_via_projection(
        &mut self,
        prefix: &str,
        values: &[String],
        is_null: bool,
        exclude: bool,
    ) {
        // Mirror the legacy helpers' early return: emit nothing when there is
        // no predicate at all (empty values AND no null/not-null flag), so the
        // generated SQL stays byte-identical to the legacy no-clause case.
        if values.is_empty() && !is_null {
            return;
        }
        let prim = FilterPrimitive::State {
            values: values.to_vec(),
            is_null,
            exclude,
        };
        let wc = SearchProjection.compile(&prim);
        self.add_projection_clause(prefix, &wc.sql, &wc.binds);
    }

    /// `priority:` membership filter routed through [`SearchProjection`]
    /// (`compile_priority`, which delegates to the canonical A2
    /// `PagesProjection` SQL over `b.priority`). Replaces the legacy
    /// `append_metadata_sql` emission of the `b.priority IN (…) / IS NULL`
    /// include clause and the `b.priority IS NULL OR … NOT IN (…)` exclude
    /// clause. The A2 SQL is byte-shape-identical to the legacy
    /// `append_text_in_or_null` / `append_text_not_in_or_not_null` oracle, so
    /// this is a zero-behaviour-change cutover at the result level.
    ///
    /// Exactly mirrors [`add_state_via_projection`](Self::add_state_via_projection):
    /// legacy priority carries BOTH an include set (`priority_values` /
    /// `priority_is_null`) and an exclude set (`excluded_priority_values` /
    /// `excluded_priority_not_null`); the caller emits TWO primitives — an
    /// include `Priority { exclude: false }` and an exclude
    /// `Priority { exclude: true }`, feeding each here. An empty include (no
    /// values, not is_null) is a no-op, matching the legacy helper's early
    /// return.
    pub(super) fn add_priority_via_projection(
        &mut self,
        prefix: &str,
        values: &[String],
        is_null: bool,
        exclude: bool,
    ) {
        // Mirror the legacy helpers' early return: emit nothing when there is
        // no predicate at all (empty values AND no null/not-null flag), so the
        // generated SQL stays byte-identical to the legacy no-clause case.
        if values.is_empty() && !is_null {
            return;
        }
        let prim = FilterPrimitive::Priority {
            values: values.to_vec(),
            is_null,
            exclude,
        };
        let wc = SearchProjection.compile(&prim);
        self.add_projection_clause(prefix, &wc.sql, &wc.binds);
    }

    /// #1280 B2 — `block-type:` equality filter routed through
    /// [`SearchProjection`] (`compile_block_type` → canonical A2
    /// `PagesProjection` SQL). Replaces the legacy inline `add_block_type`
    /// fragment (`b.block_type = ?N`). The routed SQL SHAPE differs
    /// (`b.block_type IN (?)` vs `b.block_type = ?`) but is RESULT-EQUIVALENT
    /// for the single-value filter the FTS surface passes. `None` is a no-op
    /// (mirrors `add_block_type`); the projection's empty-include `1=0` is
    /// never reached because we only compile a primitive when a value is
    /// present.
    pub(super) fn add_block_type_via_projection(&mut self, prefix: &str, block_type: Option<&str>) {
        let Some(bt) = block_type else { return };
        let prim = FilterPrimitive::BlockType {
            values: vec![bt.to_string()],
            exclude: false,
        };
        let wc = SearchProjection.compile(&prim);
        self.add_projection_clause(prefix, &wc.sql, &wc.binds);
    }

    /// #1280 B2 — `due-date:` predicate routed through [`SearchProjection`]
    /// (`compile_due_date` → canonical A2 `PagesProjection` SQL over
    /// `b.due_date`). Replaces the legacy `append_metadata_sql` emission of the
    /// `b.due_date <pred>` clause. The A2 SQL is byte-shape-identical to the
    /// legacy `append_date_predicate` oracle (guarded `IS NOT NULL`, exact `=`
    /// for `On`). Only invoked when the predicate is present (see
    /// [`add_metadata`](Self::add_metadata)).
    pub(super) fn add_due_date_via_projection(
        &mut self,
        prefix: &str,
        predicate: &MetaDatePredicate,
    ) {
        let prim = FilterPrimitive::DueDate {
            predicate: meta_date_to_primitive(predicate),
        };
        let wc = SearchProjection.compile(&prim);
        self.add_projection_clause(prefix, &wc.sql, &wc.binds);
    }

    /// #1280 B2 — `scheduled:` predicate routed through [`SearchProjection`]
    /// (`compile_scheduled` → canonical A2 `PagesProjection` SQL over
    /// `b.scheduled_date`). Replaces the legacy `append_metadata_sql` emission
    /// of the `b.scheduled_date <pred>` clause. Same byte-shape contract as
    /// [`add_due_date_via_projection`].
    pub(super) fn add_scheduled_via_projection(
        &mut self,
        prefix: &str,
        predicate: &MetaDatePredicate,
    ) {
        let prim = FilterPrimitive::Scheduled {
            predicate: meta_date_to_primitive(predicate),
        };
        let wc = SearchProjection.compile(&prim);
        self.add_projection_clause(prefix, &wc.sql, &wc.binds);
    }

    /// #1320 ALL-tags filter routed through [`SearchProjection`]
    /// instead of the inline `add_tags_all` `COUNT(DISTINCT)` fragment
    /// (#1320 retired that legacy method; this is now the sole path).
    /// For each requested tag, compiles a
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
    /// (/ SQL-A6) — dedup is now a correctness-neutral nicety rather
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

    /// #1320 page-name-glob filter routed through [`SearchProjection`].
    /// (#1320 retired the former inline `add_page_globs` /
    /// `append_page_glob_subselect` fragment; this is now the sole path.)
    /// Preserves the LEGACY
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
    ///
    /// #1280 B2 — production callers were cut over to
    /// [`add_block_type_via_projection`](Self::add_block_type_via_projection)
    /// (canonical A2 `SearchProjection` SQL). This legacy single-value `= ?`
    /// fragment is retained for the byte-shape snapshot tests that pin it as
    /// the result-equivalence oracle; it has no non-test callers.
    #[cfg_attr(not(test), allow(dead_code))]
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

    /// Splice the metadata predicates into the fragment via the
    /// shared [`append_metadata_sql`], recording each returned bind in
    /// declaration order. The relative position of this call vs
    /// [`add_block_type`](Self::add_block_type) differs between the FTS
    /// and the toggle builders — the caller drives that order.
    pub(super) fn add_metadata(&mut self, metadata: &MetadataPredicates, alias: &str) {
        // #1280 B2 / P3.x — EVERY metadata leaf is now routed through a
        // `_via_projection` splice: `state:` / `priority:` / `due-date:` /
        // `scheduled:` / `last-edited:` (canonical `SearchProjection` SQL) and,
        // as of P3.2, `prop:` (the search-surface untyped four-column leaf
        // `untyped_property_clause`). `append_metadata_sql` has been removed —
        // there is no remaining legacy SQL emission. Every routed fragment
        // references a hardcoded `b.` alias, so the metadata block alias MUST be
        // `b` (all three FTS builders splice metadata with `"b"`).
        debug_assert_eq!(
            alias, "b",
            "all metadata projections (state/priority/due/scheduled/last_edited/\
             property) emit a hardcoded `b.` alias; the metadata block alias must \
             be `b`"
        );

        // INCLUDE state (`state_values` / `state_is_null`) and the symmetric
        // EXCLUDE state (`excluded_state_values` / `excluded_state_not_null`)
        // are TWO separate legacy clauses → two primitives. Each splice is a
        // no-op when its set is empty (mirrors the legacy helpers' early
        // return), so the generated SQL stays byte-identical to the legacy
        // no-clause cases.
        self.add_state_via_projection(
            LAST_EDITED_PREFIX,
            &metadata.state_values,
            metadata.state_is_null,
            false,
        );
        self.add_state_via_projection(
            LAST_EDITED_PREFIX,
            &metadata.excluded_state_values,
            metadata.excluded_state_not_null,
            true,
        );

        // INCLUDE priority (`priority_values` / `priority_is_null`) and the
        // symmetric EXCLUDE priority (`excluded_priority_values` /
        // `excluded_priority_not_null`) mirror the state two-clause shape. Each
        // splice is a no-op when its set is empty (mirrors the legacy helpers'
        // early return).
        self.add_priority_via_projection(
            LAST_EDITED_PREFIX,
            &metadata.priority_values,
            metadata.priority_is_null,
            false,
        );
        self.add_priority_via_projection(
            LAST_EDITED_PREFIX,
            &metadata.excluded_priority_values,
            metadata.excluded_priority_not_null,
            true,
        );

        // P3.2 — property includes / excludes routed through the search-surface
        // untyped property leaf (`untyped_property_clause`), replacing the
        // legacy `append_metadata_sql` four-column-OR emission. The leaf's
        // untyped four-column (`value_text/num/date/ref`) OR is preserved
        // verbatim — it deliberately does NOT route through the typed
        // `Projection::compile_has_property` (which would change search results;
        // see `untyped_property_clause`). Ordering (includes then excludes) and
        // the bare-`?`→`?N` renumbering match the legacy emission exactly.
        for pf in &metadata.property_includes {
            self.add_property_via_projection(LAST_EDITED_PREFIX, pf);
        }
        for pf in &metadata.property_excludes {
            self.add_excluded_property_via_projection(LAST_EDITED_PREFIX, pf);
        }

        // due_date / scheduled_date predicates routed through the projection.
        if let Some(pred) = &metadata.due {
            self.add_due_date_via_projection(LAST_EDITED_PREFIX, pred);
        }
        if let Some(pred) = &metadata.scheduled {
            self.add_scheduled_via_projection(LAST_EDITED_PREFIX, pred);
        }

        // #1320-C — the `last-edited:` window is also compiled through
        // `SearchProjection::compile_last_edited` (hardcoded `b.` alias).
        if let Some(spec) = &metadata.last_edited {
            self.add_last_edited_via_projection(LAST_EDITED_PREFIX, spec);
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
                ScalarBind::F64(n) => query.bind(n),
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

/// #1320 lift the genuinely-shared filter subset (`Tag`,
/// `HasProperty`, `Space`) from the flat [`SearchFilter`] into
/// [`FilterPrimitive`]s, so they can be compiled through
/// [`SearchProjection`] (the cross-surface filter compiler) instead of the
/// bespoke inline FTS fragments.
///
/// **Scope (zero-behaviour-change contract):** this lifts ONLY the shared
/// subset. Path globs, metadata (state / priority / due / scheduled),
/// `block_type`, the toggle filters, and the FTS `MATCH` query itself are
/// left entirely on the legacy path — they diverge from the projection and
/// Are out of scope for.
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
    fn space_fragment_matches_canonical_inner() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_space(FTS_PREFIX, Some("space1"));
        assert_eq!(fb.sql(), "\n           AND b.space_id = ?6");
        assert_eq!(fb.next_param(), 7);
    }

    // ── #1320 SearchProjection cutover parity ──────────────────
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

    /// #1320 Tag is now ROUTED through `SearchProjection` in
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

        // #1320 the legacy `add_tags_allCOUNT(DISTINCT)` fragment
        // has been retired, so there is no live legacy builder to diff
        // against. We still document the shape divergence intent: the routed
        // path uses per-tag `IN`-subselects, NOT the former single
        // `COUNT(DISTINCT bt.tag_id) = N` form (the two are result-equivalent,
        // proved by the `tags_via_projection_matches_*` DB equivalence tests).
        assert!(
            !routed.sql().contains("COUNT(DISTINCT"),
            "routed Tag is per-tag IN-subselects, not the legacy COUNT(DISTINCT) form"
        );
    }

    /// P3.2 — the search property leaf (`untyped_property_clause`) is the
    /// UNTYPED four-column OR, and is INTENTIONALLY distinct from the typed
    /// `Projection::compile_has_property` (`Eq { Text }` compares
    /// `value_text` only). Routing search through the typed projection would
    /// CHANGE match results — e.g. `prop:n=1` legacy matches a `value_num =
    /// 1.0` row via the numeric branch, but typed `Eq { Text }` only compares
    /// `value_text` and would NOT. This test pins the divergence so a future
    /// "just unify onto `compile_has_property`" refactor fails loudly.
    #[test]
    fn search_property_leaf_is_untyped_not_typed_projection() {
        use crate::filters::primitive::{FilterPrimitive, PropertyPredicate, PropertyValue};

        // --- Exists (key-presence only) ---
        let (untyped_exists, _) = untyped_property_clause(
            &SearchPropertyFilter {
                key: "kind".into(),
                value: String::new(),
            },
            false,
        );
        let proj_exists = SearchProjection.compile(&FilterPrimitive::HasProperty {
            key: "kind".into(),
            predicate: PropertyPredicate::Exists,
        });
        assert!(
            untyped_exists.contains("block_properties bp") && untyped_exists.contains("bp.key = ?"),
            "search property leaf uses a `bp.`-aliased sub-select"
        );
        assert!(
            !proj_exists.sql.contains("bp."),
            "typed projection property is un-aliased"
        );
        assert_ne!(
            untyped_exists, proj_exists.sql,
            "Exists fragments diverge — search property MUST stay untyped"
        );

        // --- value match: untyped is a four-column OR; typed Eq{Text} is
        //     value_text only (the result-changing divergence). ---
        let (untyped_eq, _) = untyped_property_clause(
            &SearchPropertyFilter {
                key: "kind".into(),
                value: "note".into(),
            },
            false,
        );
        let proj_eq = SearchProjection.compile(&FilterPrimitive::HasProperty {
            key: "kind".into(),
            predicate: PropertyPredicate::Eq {
                value: PropertyValue::Text {
                    value: "note".into(),
                },
            },
        });
        assert!(
            untyped_eq.contains("value_num") && untyped_eq.contains("value_ref"),
            "search `prop:KEY=VALUE` is a four-column OR"
        );
        assert!(
            !proj_eq.sql.contains("value_num"),
            "typed projection Eq-text compares value_text only"
        );
        assert_ne!(
            untyped_eq, proj_eq.sql,
            "value fragments diverge — search property MUST stay untyped"
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
    fn block_type_and_after_id_fragments() {
        let mut fb = StructuralFilterBuilder::new(3);
        fb.add_block_type(TOGGLE_PREFIX, Some("page"));
        assert_eq!(fb.sql(), "\n             AND b.block_type = ?3");
        fb.add_after_id(TOGGLE_PREFIX, Some("cursor"));
        assert!(fb.sql().ends_with("\n             AND b.id < ?4"));
        assert_eq!(fb.next_param(), 5);
        assert_eq!(fb.bind_count(), 2);
    }

    // ── #1280 B2 — metadata splices (state / block_type / due / scheduled) ──

    /// State INCLUDE compiles to the canonical `(b.todo_state IN (…) OR
    /// b.todo_state IS NULL)` shape spliced under the metadata prefix, with
    /// renumbered placeholders and one bind per value.
    #[test]
    fn state_include_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_state_via_projection(FTS_PREFIX, &["TODO".to_string()], true, false);
        assert_eq!(
            fb.sql(),
            "\n           AND (b.todo_state IN (?6) OR b.todo_state IS NULL)"
        );
        assert_eq!(fb.next_param(), 7);
        assert_eq!(fb.bind_count(), 1);
    }

    /// State EXCLUDE compiles to the NULL-inclusive inversion `(b.todo_state
    /// IS NULL OR b.todo_state NOT IN (…))` — the `IS NULL` branch OUTSIDE
    /// the `NOT IN` list (3-valued trap guard); `is_null=true` adds the
    /// `IS NOT NULL` branch (the `not-state:none` sentinel).
    #[test]
    fn state_exclude_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_state_via_projection(FTS_PREFIX, &["DONE".to_string()], true, true);
        assert_eq!(
            fb.sql(),
            "\n           AND (b.todo_state IS NULL OR b.todo_state NOT IN (?6) OR b.todo_state IS NOT NULL)"
        );
        assert_eq!(fb.next_param(), 7);
        assert_eq!(fb.bind_count(), 1);
    }

    /// An empty, null-less state include is a no-op (mirrors the legacy
    /// helper's early return) — no clause, no placeholder consumed.
    #[test]
    fn state_empty_via_projection_is_noop() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_state_via_projection(FTS_PREFIX, &[], false, false);
        assert_eq!(fb.sql(), "");
        assert_eq!(fb.next_param(), 6);
        assert_eq!(fb.bind_count(), 0);
    }

    // ── priority via projection — parity with the legacy `b.priority` oracle ──
    //
    // The projection-built priority SQL must be byte-shape-identical to the
    // legacy `append_text_in_or_null` / `append_text_not_in_or_not_null`
    // fragments over `b.priority` (the fragments `append_metadata_sql` used to
    // emit before the multi-value `Priority` cutover). These mirror the
    // `state_*_via_projection_*` snapshots above, on the `b.priority` column.

    /// Single value: priority INCLUDE compiles to the canonical
    /// `(b.priority IN (?))` shape, one bind, one placeholder consumed —
    /// result-equivalent to the legacy single-value `b.priority = ?` emission.
    #[test]
    fn priority_single_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_priority_via_projection(FTS_PREFIX, &["A".to_string()], false, false);
        assert_eq!(fb.sql(), "\n           AND (b.priority IN (?6))");
        assert_eq!(fb.next_param(), 7);
        assert_eq!(fb.bind_count(), 1);
        assert!(matches!(fb.binds.first(), Some(ScalarBind::Str(s)) if s == "A"));
    }

    /// Multi value: priority INCLUDE compiles to `(b.priority IN (?,?))` with
    /// one bind per value and contiguous renumbered placeholders — byte-shape
    /// identical to the legacy `append_text_in_or_null` multi-value fragment.
    #[test]
    fn priority_multi_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_priority_via_projection(
            FTS_PREFIX,
            &["A".to_string(), "B".to_string()],
            false,
            false,
        );
        assert_eq!(fb.sql(), "\n           AND (b.priority IN (?6, ?7))");
        assert_eq!(fb.next_param(), 8);
        assert_eq!(fb.bind_count(), 2);
        assert!(matches!(fb.binds.first(), Some(ScalarBind::Str(s)) if s == "A"));
    }

    /// `priority:none` (IS NULL, no values) compiles to the bare
    /// `(b.priority IS NULL)` — no placeholder consumed, matching the legacy
    /// `append_text_in_or_null` is_null branch.
    #[test]
    fn priority_none_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_priority_via_projection(FTS_PREFIX, &[], true, false);
        assert_eq!(fb.sql(), "\n           AND (b.priority IS NULL)");
        assert_eq!(fb.next_param(), 6);
        assert_eq!(fb.bind_count(), 0);
    }

    /// EXCLUDE compiles to the NULL-inclusive inversion
    /// `(b.priority IS NULL OR b.priority NOT IN (…))` — the `IS NULL` branch
    /// OUTSIDE the `NOT IN` list (3-valued trap guard); `is_null=true` adds the
    /// `IS NOT NULL` branch (the `not-priority:none` sentinel). Byte-shape
    /// identical to the legacy `append_text_not_in_or_not_null` fragment.
    #[test]
    fn priority_exclude_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_priority_via_projection(FTS_PREFIX, &["A".to_string()], true, true);
        assert_eq!(
            fb.sql(),
            "\n           AND (b.priority IS NULL OR b.priority NOT IN (?6) OR b.priority IS NOT NULL)"
        );
        assert_eq!(fb.next_param(), 7);
        assert_eq!(fb.bind_count(), 1);
    }

    /// An empty, null-less priority include is a no-op (mirrors the legacy
    /// helper's early return) — no clause, no placeholder consumed.
    #[test]
    fn priority_empty_via_projection_is_noop() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_priority_via_projection(FTS_PREFIX, &[], false, false);
        assert_eq!(fb.sql(), "");
        assert_eq!(fb.next_param(), 6);
        assert_eq!(fb.bind_count(), 0);
    }

    /// block_type routes to `b.block_type IN (?)` (result-equivalent to the
    /// legacy `b.block_type = ?`); `None` is a no-op.
    #[test]
    fn block_type_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_block_type_via_projection(FTS_PREFIX, Some("page"));
        assert_eq!(fb.sql(), "\n           AND b.block_type IN (?6)");
        assert_eq!(fb.bind_count(), 1);

        let mut none = StructuralFilterBuilder::new(6);
        none.add_block_type_via_projection(FTS_PREFIX, None);
        assert_eq!(none.sql(), "");
        assert_eq!(none.next_param(), 6);
    }

    /// due / scheduled date predicates compile to the guarded canonical
    /// fragment over the right column. `On{Eq}` is the exact `= ?` form;
    /// `IsNull` is the bare `IS NULL`.
    #[test]
    fn due_scheduled_via_projection_snapshot() {
        use crate::fts::metadata_filter::DatePredicate;

        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_due_date_via_projection(
            FTS_PREFIX,
            &DatePredicate::Op {
                op: crate::domain::search_types::DateOp::Eq,
                date: "2026-05-18".into(),
            },
        );
        assert_eq!(
            fb.sql(),
            "\n           AND (b.due_date IS NOT NULL AND b.due_date = ?6)"
        );
        assert_eq!(fb.bind_count(), 1);

        let mut sched = StructuralFilterBuilder::new(6);
        sched.add_scheduled_via_projection(FTS_PREFIX, &DatePredicate::IsNull);
        assert_eq!(sched.sql(), "\n           AND b.scheduled_date IS NULL");
        assert_eq!(sched.bind_count(), 0, "IsNull binds nothing");
    }

    // ── P3.2 — property via projection: parity with the legacy untyped
    //    four-column oracle (`untyped_property_clause`) ──────────────────
    //
    // The search property leaf preserves the UNTYPED four-column OR
    // (`value_text/num/date/ref`) verbatim — it does NOT route through the
    // typed `Projection::compile_has_property`. These snapshots pin the
    // exact SQL + bind shape the builder splices, and prove it is byte-shape
    // identical (modulo `?`→`?N` renumbering) to the
    // `untyped_property_clause` oracle.

    /// A non-empty-value include compiles to the four-column OR
    /// `[NOT ]EXISTS` sub-select with renumbered placeholders: 1 key bind +
    /// 4 typed value binds (text verbatim, then num / date / ref coerced to
    /// NULL when the value doesn't parse).
    #[test]
    fn property_include_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_property_via_projection(
            FTS_PREFIX,
            &SearchPropertyFilter {
                key: "status".into(),
                value: "draft".into(),
            },
        );
        assert_eq!(
            fb.sql(),
            "\n           AND EXISTS (SELECT 1 FROM block_properties bp \
              WHERE bp.block_id = b.id \
            AND bp.key = ?6 \
            AND ( \
                 (bp.value_text IS NOT NULL AND bp.value_text = ?7) \
              OR (bp.value_num  IS NOT NULL AND bp.value_num  = ?8) \
              OR (bp.value_date IS NOT NULL AND bp.value_date = ?9) \
              OR (bp.value_ref  IS NOT NULL AND bp.value_ref  = ?10) \
            ))",
            "include property must splice the four-column OR with ?6..?10"
        );
        assert_eq!(fb.next_param(), 11, "1 key + 4 typed value placeholders");
        assert_eq!(fb.bind_count(), 5);
        // key bind, then verbatim text, then num/date/ref all NULL ("draft").
        assert!(
            matches!(fb.binds.first(), Some(ScalarBind::Meta(MetaBind::Str(s))) if s == "status")
        );
    }

    /// An empty-value include is the key-presence-only shape: a single
    /// `EXISTS (… bp.key = ?)` sub-select with exactly one (key) bind.
    #[test]
    fn property_key_presence_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_property_via_projection(
            FTS_PREFIX,
            &SearchPropertyFilter {
                key: "notes".into(),
                value: String::new(),
            },
        );
        assert_eq!(
            fb.sql(),
            "\n           AND EXISTS (SELECT 1 FROM block_properties bp \
              WHERE bp.block_id = b.id AND bp.key = ?6)",
            "empty-value property is key-presence-only"
        );
        assert_eq!(fb.next_param(), 7);
        assert_eq!(fb.bind_count(), 1);
    }

    /// An exclude compiles to the `NOT EXISTS` sibling with the SAME
    /// four-column OR body and bind shape.
    #[test]
    fn property_exclude_via_projection_snapshot() {
        let mut fb = StructuralFilterBuilder::new(6);
        fb.add_excluded_property_via_projection(
            FTS_PREFIX,
            &SearchPropertyFilter {
                key: "archived".into(),
                value: "true".into(),
            },
        );
        assert!(
            fb.sql()
                .starts_with("\n           AND NOT EXISTS (SELECT 1 FROM block_properties bp"),
            "exclude must emit NOT EXISTS, got: {}",
            fb.sql()
        );
        assert!(
            fb.sql()
                .contains("bp.value_num  IS NOT NULL AND bp.value_num  = ?8")
        );
        assert_eq!(fb.next_param(), 11);
        assert_eq!(fb.bind_count(), 5);
    }

    /// The spliced builder SQL is byte-shape identical (modulo `?`→`?N`
    /// renumbering) to the `untyped_property_clause` oracle, for every search
    /// property case: text value, numeric value, ISO-date value, ULID value,
    /// key-presence, and exclude. This is the load-bearing parity proof that
    /// routing search property through the splice does not change match
    /// results.
    #[test]
    fn property_via_projection_matches_untyped_oracle_for_all_cases() {
        let cases: &[(SearchPropertyFilter, bool)] = &[
            (
                SearchPropertyFilter {
                    key: "status".into(),
                    value: "draft".into(),
                },
                false,
            ),
            (
                SearchPropertyFilter {
                    key: "n".into(),
                    value: "1".into(),
                },
                false,
            ),
            (
                SearchPropertyFilter {
                    key: "d".into(),
                    value: "2026-05-17".into(),
                },
                false,
            ),
            (
                SearchPropertyFilter {
                    key: "author".into(),
                    value: "01hkq2rwwwgm34rtgfe9xcryz4".into(),
                },
                false,
            ),
            (
                SearchPropertyFilter {
                    key: "notes".into(),
                    value: String::new(),
                },
                true,
            ),
            (
                SearchPropertyFilter {
                    key: "archived".into(),
                    value: "true".into(),
                },
                true,
            ),
        ];

        for (pf, exclude) in cases {
            // Oracle: the legacy untyped fragment with bare `?`, manually
            // renumbered starting at 6 to mirror the builder's `?N` slots.
            let (oracle_sql, oracle_binds) = untyped_property_clause(pf, *exclude);
            let mut renumbered = String::new();
            let mut n = 6usize;
            for ch in oracle_sql.chars() {
                if ch == '?' {
                    renumbered.push('?');
                    renumbered.push_str(&n.to_string());
                    n += 1;
                } else {
                    renumbered.push(ch);
                }
            }
            let expected_sql = format!("{FTS_PREFIX}{renumbered}");

            let mut fb = StructuralFilterBuilder::new(6);
            if *exclude {
                fb.add_excluded_property_via_projection(FTS_PREFIX, pf);
            } else {
                fb.add_property_via_projection(FTS_PREFIX, pf);
            }
            assert_eq!(
                fb.sql(),
                expected_sql,
                "spliced SQL must equal the renumbered oracle for {pf:?} (exclude={exclude})"
            );
            assert_eq!(
                fb.bind_count(),
                oracle_binds.len(),
                "bind count must equal the oracle for {pf:?}"
            );
            assert_eq!(
                fb.next_param(),
                6 + oracle_binds.len(),
                "placeholders consumed must equal the oracle bind count for {pf:?}"
            );
        }
    }

    #[test]
    fn call_order_drives_placeholder_order() {
        // Mirrors the regex builder's order (metadata omitted): parent,
        // tags, space, globs, block_type. Indices must increase
        // monotonically with no gaps or reuse.
        //
        // #1320 routed through the `_via_projection` tag + glob
        // variants (the legacy `add_tags_all` / `add_page_globs` were
        // retired). `add_tags_via_projection` consumes ONE placeholder per
        // tag (no trailing `COUNT(DISTINCT)` count bind), so the indices are
        // now contiguous: parent ?1, tag ?2, space ?3, glob ?4, block_type ?5.
        let mut fb = StructuralFilterBuilder::new(1);
        fb.add_parent(TOGGLE_PREFIX, Some("p")); // ?1
        fb.add_tags_via_projection(TOGGLE_PREFIX, &["T".to_string()]); // ?2
        fb.add_space(TOGGLE_PREFIX, Some("s")); // ?3
        fb.add_page_globs_via_projection(TOGGLE_PREFIX, false, &["*g*".to_string()]); // ?4
        fb.add_block_type(TOGGLE_PREFIX, Some("page")); // ?5
        assert_eq!(fb.next_param(), 6);
        // parent(1) + tags_via_projection(1 tag) + space(1) + glob(1)
        // + block_type(1) = 5 recorded binds.
        assert_eq!(fb.bind_count(), 5);
        // Placeholders appear in ascending order in the SQL.
        let sql = fb.sql();
        let p1 = sql.find("?1").unwrap();
        let p3 = sql.find("?3").unwrap();
        let p5 = sql.find("?5").unwrap();
        assert!(p1 < p3 && p3 < p5, "placeholders must be in source order");
    }
}
