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

use super::metadata_filter::{append_metadata_sql, MetaBind, MetadataPredicates};

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

    /// `AND b.page_id IN (SELECT bp.block_id FROM block_properties bp
    /// WHERE bp.key = 'space' AND bp.value_ref = ?N)` when `Some`.
    ///
    /// The sub-select body is single-spaced and identical across all
    /// three builders (the original `\`-continuation source strings
    /// collapse the inter-line indentation to a single space); only the
    /// leading `prefix` glue differs by builder indentation.
    pub(super) fn add_space(&mut self, prefix: &str, space_id: Option<&str>) {
        if let Some(sid) = space_id {
            let i = self.next_param;
            self.sql.push_str(&format!(
                "{prefix}b.page_id IN (SELECT bp.block_id FROM block_properties bp WHERE bp.key = 'space' AND bp.value_ref = ?{i})"
            ));
            self.next_param += 1;
            self.binds.push(ScalarBind::Str(sid.to_string()));
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
        assert_eq!(
            fb.sql(),
            "\n           AND b.page_id IN (SELECT bp.block_id FROM block_properties bp WHERE bp.key = 'space' AND bp.value_ref = ?6)"
        );
        assert_eq!(fb.next_param(), 7);
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
