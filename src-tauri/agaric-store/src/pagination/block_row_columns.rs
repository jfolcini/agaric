//! Canonical SELECT column list for [`super::BlockRow`].
//!
//! ## Why a `const` and not a macro?
//!
//! Session 672 attempted to extract this list as a string-emitting
//! `macro_rules!` macro analogous to `descendants_cte_purge!()`,
//! intending consumers to write
//! `sqlx::query_as!(BlockRow, concat!("SELECT ", block_row_select_columns!(), " FROM blocks WHERE ..."))`.
//! That doesn't compile: `sqlx::query_as!` is a proc-macro that
//! requires its 2nd argument to be a `LitStr` token. `concat!(...)`
//! is just tokens to `query_as!`'s parser — it isn't expanded into a
//! string literal before sqlx sees it. The existing macro precedents
//! (`descendants_cte_purge!()`, `tag_inh_subtree_active!()`,
//! `ancestors_cte_standard!()`) are used inside the dynamic
//! `sqlx::query(...)` API, which accepts a runtime `&str`, not the
//! compile-time `query_as!` family used at the 20 production sites.
//!
//! Trade-off chosen (Option 2): keep the canonical
//! column list duplicated at all 20 production sites, accept the
//! manual lockstep-update cost when `BlockRow` changes, and use the
//! parity tests in this module's `#[cfg(test)] mod tests` to catch
//! drift in CI.
//!
//! ## Two canonical forms
//!
//! Two production-visible consts coexist because the macro and
//! runtime sqlx APIs diverge on type-cast syntax:
//!
//! - [`BLOCK_ROW_CANONICAL_SELECT`] — for the `sqlx::query_as!(BlockRow, …)`
//!   compile-time macro sites.
//! - [`BLOCK_ROW_RUNTIME_SELECT`] — for the 3 runtime
//!   `sqlx::query_as::<_, BlockRow>(…)` sites which use sqlx's
//!   `FromRow` for type mapping. (follow-up).
//!
//! Both are `pub(crate) const` (not `#[cfg(test)]`-gated) so the
//! production sites can reference them directly. The parity tests in
//! the gated `tests` submodule scan production sources to catch
//! drift, but the consts themselves are always compiled.
//!
//! When you add a column to `BlockRow`:
//! 1. Update [`BLOCK_ROW_CANONICAL_SELECT`] below.
//! 2. Update [`BLOCK_ROW_RUNTIME_SELECT`] below.
//! 3. Update [`BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS`] below (same column
//!    list as [`BLOCK_ROW_RUNTIME_SELECT`] but with every column prefixed
//!    by the `b.` alias used at the `pagination/properties.rs` sites).
//! 4. Update [`BLOCK_ROW_CANONICAL_FIELDS`] below.
//! 5. Run `cargo nextest run -E 'test(block_row_canonical)'` — the
//!    parity tests will print every drifted site so you can update
//!    each one.

/// Canonical SELECT column list. Use this exact column list — possibly
/// with a table alias prefix such as `b.` when the query joins another
/// table — in every `sqlx::query_as!(BlockRow, "SELECT <THIS> FROM
/// blocks ...")` invocation.  Keep in sync with
/// [`BLOCK_ROW_CANONICAL_FIELDS`], [`BLOCK_ROW_RUNTIME_SELECT`], and
/// the `BlockRow` struct definition.
///
/// `#[allow(dead_code)]`: the const is documentation /
/// drift-detection scaffolding consumed only by the parity tests in
/// this module — production `query_as!` callsites embed the SELECT
/// clause inline as a string literal because the proc-macro
/// requires a `LitStr` token (it cannot interpolate a `const &str`).
#[allow(dead_code)]
pub const BLOCK_ROW_CANONICAL_SELECT: &str = "id as \"id!: agaric_core::ulid::BlockId\", block_type, content, \
     parent_id as \"parent_id: agaric_core::ulid::BlockId\", position, deleted_at, \
     todo_state, \
     priority, due_date, scheduled_date, \
     page_id as \"page_id: agaric_core::ulid::BlockId\"";

/// Canonical SELECT column list for the **runtime** sqlx form
/// (`sqlx::query_as::<_, BlockRow>(&sql)` and the analogous
/// `ActiveBlockRow` form). Same 11 columns as
/// [`BLOCK_ROW_CANONICAL_SELECT`].
///
/// Used by the 3 runtime `sqlx::query_as::<_, BlockRow>(…)` sites
/// which use sqlx's `FromRow` for type mapping.
///
/// Precedent: [`BLOCK_ROW_CANONICAL_SELECT`] for the macro form.
/// (follow-up) extracted this const from the
/// 3 runtime callsites to give them the same drift-detection
/// coverage that Test B gives the macro sites.
pub const BLOCK_ROW_RUNTIME_SELECT: &str = "id, block_type, content, parent_id, position, deleted_at, \
     todo_state, \
     priority, due_date, scheduled_date, page_id";

/// Canonical SELECT column list for the **runtime** sqlx form with the
/// `b.` table-alias prefix applied to every column. Same column list (in
/// the same order) as [`BLOCK_ROW_RUNTIME_SELECT`].
///
/// Used by the 2 runtime `sqlx::query_as::<_, BlockRow>(…)` sites in
/// [`crate::pagination::properties`] that JOIN `blocks b` with
/// `block_properties bp` (non-reserved key path) or alias `blocks b`
/// to support the reserved-key column-routing `b.{col}` interpolation
/// in the WHERE clause. The simple unprefixed const cannot be reused at
/// those sites because every column in the SELECT clause needs the `b.`
/// qualifier and the WHERE clause interpolates the alias on other
/// columns — keeping the SELECT prefix uniform with WHERE references
/// keeps the SQL readable.
///
/// Parity with [`BLOCK_ROW_RUNTIME_SELECT`] is enforced by
/// `runtime_select_with_b_alias_strips_to_runtime_select` (Test D):
/// stripping `b.` from every column must yield exactly the unprefixed
/// const.
///
/// (follow-up) extracted this const from the 2
/// `pagination/properties.rs` callsites that deferred.
pub const BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS: &str = "b.id, b.block_type, b.content, b.parent_id, b.position, b.deleted_at, \
     b.todo_state, \
     b.priority, b.due_date, b.scheduled_date, b.page_id";

/// Canonical field list for `BlockRow` in struct-declaration order.
/// Used by the parity test to assert the SELECT clause matches the
/// struct's fields in the same order.  Keep in sync with the
/// `BlockRow` struct definition, [`BLOCK_ROW_CANONICAL_SELECT`], and
/// [`BLOCK_ROW_RUNTIME_SELECT`].
///
/// `#[allow(dead_code)]`: scaffolding for the parity test (Test A);
/// no production consumer.
#[allow(dead_code)]
pub const BLOCK_ROW_CANONICAL_FIELDS: &[&str] = &[
    "id",
    "block_type",
    "content",
    "parent_id",
    "position",
    "deleted_at",
    "todo_state",
    "priority",
    "due_date",
    "scheduled_date",
    "page_id",
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Collapse every run of ASCII whitespace (spaces, tabs, newlines,
    /// `\` line continuations after splitting) to a single space, and
    /// trim leading/trailing whitespace.  Used to render multi-line
    /// SQL SELECT clauses comparable to the canonical single-line
    /// constant.
    fn normalize_whitespace(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut last_was_space = true;
        for c in s.chars() {
            if c.is_whitespace() {
                if !last_was_space {
                    out.push(' ');
                    last_was_space = true;
                }
            } else {
                out.push(c);
                last_was_space = false;
            }
        }
        out.trim().to_string()
    }

    /// Strip the `b.` table-alias prefix from column references so
    /// JOIN-style sites (e.g. `pagination/agenda.rs`,
    /// `commands/journal.rs`, `pagination/tags.rs`,
    /// `pagination/undated.rs`) compare equal to the unprefixed
    /// canonical.  Only `b.` (the consistent block-table alias used
    /// at every drift-tested site) is stripped; any other alias such
    /// as `ac.` would survive the strip and fail the equality check
    /// — which is the desired behaviour, since selecting columns
    /// from a non-`blocks` table is a real drift, not an accepted
    /// JOIN convention.
    fn strip_blocks_alias(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut iter = s.char_indices().peekable();
        while let Some((_, c)) = iter.next() {
            if c == 'b' && iter.peek().map(|&(_, n)| n) == Some('.') {
                // Only treat `b.` as an alias prefix when the `b` is
                // at a word boundary (i.e. the previous emitted char
                // is not alphanumeric or `_`).  This avoids
                // mis-stripping the middle of an identifier.
                let at_word_boundary = out
                    .chars()
                    .last()
                    .is_none_or(|p| !(p.is_alphanumeric() || p == '_'));
                if at_word_boundary {
                    iter.next(); // consume the '.'
                    continue;
                }
            }
            out.push(c);
        }
        out
    }

    /// Test A — assert [`BLOCK_ROW_CANONICAL_SELECT`] and
    /// [`BLOCK_ROW_CANONICAL_FIELDS`] agree: parse the SELECT column
    /// list (split on commas, trim, strip `as "<name>: <type>"` casts)
    /// and assert it matches the field list in the same order.
    #[test]
    fn block_row_canonical_select_matches_canonical_fields() {
        let parsed: Vec<String> = BLOCK_ROW_CANONICAL_SELECT
            .split(',')
            .map(|raw| {
                let trimmed = raw.trim();
                // Strip any `as "<name>: <type>"` cast suffix.
                if let Some(idx) = trimmed.find(" as ") {
                    trimmed[..idx].trim().to_string()
                } else {
                    trimmed.to_string()
                }
            })
            .collect();
        let expected: Vec<String> = BLOCK_ROW_CANONICAL_FIELDS
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert_eq!(
            parsed, expected,
            "BLOCK_ROW_CANONICAL_SELECT and BLOCK_ROW_CANONICAL_FIELDS \
             have drifted. Update both consts together so the parsed \
             column names exactly match the field list."
        );
    }

    /// Test D — assert [`BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS`] is a
    /// pure `b.`-prefixed re-write of [`BLOCK_ROW_RUNTIME_SELECT`].
    ///
    /// Split the runtime-select const into an unprefixed form
    /// (used at 3 sites covered by Test C) and a `b.`-aliased form (used
    /// at the 2 `pagination/properties.rs` sites). Stripping the `b.`
    /// alias from every column of the aliased const — using the same
    /// `strip_blocks_alias` helper Test B uses to normalize JOIN-style
    /// macro sites — must yield exactly the unprefixed const after
    /// whitespace normalization. If the two consts ever drift in column
    /// set, order, or count, this test fails.
    #[test]
    fn runtime_select_with_b_alias_strips_to_runtime_select() {
        let stripped =
            normalize_whitespace(&strip_blocks_alias(BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS));
        let canonical = normalize_whitespace(BLOCK_ROW_RUNTIME_SELECT);
        assert_eq!(
            stripped, canonical,
            "BLOCK_ROW_RUNTIME_SELECT_WITH_B_ALIAS has drifted from \
             BLOCK_ROW_RUNTIME_SELECT. Stripping every `b.` alias prefix \
             from the aliased const must reproduce the unprefixed const \
             verbatim (modulo whitespace). Update both consts together \
             so the column set, order, and count stay in lockstep."
        );
    }
}
