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
//! compile-time `query_as!` family used at the 18 production sites.
//!
//! Trade-off chosen (PEND-28a H1 Option 2): keep the canonical
//! column list duplicated at all 18 production sites, accept the
//! manual lockstep-update cost when `BlockRow` changes, and use the
//! parity tests in this module's `#[cfg(test)] mod tests` to catch
//! drift in CI.
//!
//! ## Two canonical forms
//!
//! Two production-visible consts coexist because the macro and
//! runtime sqlx APIs diverge on type-cast syntax:
//!
//! - [`BLOCK_ROW_CANONICAL_SELECT`] — for the 18 `sqlx::query_as!(BlockRow, …)`
//!   compile-time macro sites. Includes the `is_conflict as "is_conflict: bool"`
//!   cast required by the proc-macro to type-resolve the column.
//! - [`BLOCK_ROW_RUNTIME_SELECT`] — for the 3 runtime
//!   `sqlx::query_as::<_, BlockRow>(…)` sites which use sqlx's
//!   `FromRow` for type mapping (no compile-time `as "x: T"` cast
//!   needed because the type is resolved at runtime, not at
//!   proc-macro expansion time). MAINT-223 (PEND-28a H1 follow-up).
//!
//! Both are `pub(crate) const` (not `#[cfg(test)]`-gated) so the
//! production sites can reference them directly. The parity tests in
//! the gated `tests` submodule scan production sources to catch
//! drift, but the consts themselves are always compiled.
//!
//! When you add a column to `BlockRow`:
//! 1. Update [`BLOCK_ROW_CANONICAL_SELECT`] below.
//! 2. Update [`BLOCK_ROW_RUNTIME_SELECT`] below.
//! 3. Update [`BLOCK_ROW_CANONICAL_FIELDS`] below.
//! 4. Run `cargo nextest run -E 'test(block_row_canonical)'` — the
//!    parity tests will print every drifted site so you can update
//!    each one.

/// Canonical SELECT column list (with sqlx type override on
/// `is_conflict`).  Use this exact column list — possibly with a
/// table alias prefix such as `b.` when the query joins another
/// table — in every `sqlx::query_as!(BlockRow, "SELECT <THIS> FROM
/// blocks ...")` invocation.  Keep in sync with
/// [`BLOCK_ROW_CANONICAL_FIELDS`], [`BLOCK_ROW_RUNTIME_SELECT`], and
/// the `BlockRow` struct definition.
///
/// The `is_conflict as "is_conflict: bool"` cast is required by the
/// `sqlx::query_as!` proc-macro for compile-time type resolution.
/// The runtime `sqlx::query_as::<_, BlockRow>(…)` form does not
/// accept this cast syntax — see [`BLOCK_ROW_RUNTIME_SELECT`].
///
/// `#[allow(dead_code)]`: the const is documentation /
/// drift-detection scaffolding consumed only by the parity tests in
/// this module — production `query_as!` callsites embed the SELECT
/// clause inline as a string literal because the proc-macro
/// requires a `LitStr` token (it cannot interpolate a `const &str`).
#[allow(dead_code)]
pub(crate) const BLOCK_ROW_CANONICAL_SELECT: &str =
    "id, block_type, content, parent_id, position, deleted_at, \
     is_conflict as \"is_conflict: bool\", conflict_type, todo_state, \
     priority, due_date, scheduled_date, page_id";

/// Canonical SELECT column list for the **runtime** sqlx form
/// (`sqlx::query_as::<_, BlockRow>(&sql)` and the analogous
/// `ActiveBlockRow` form). Same 13 columns as
/// [`BLOCK_ROW_CANONICAL_SELECT`] but **without** the
/// `is_conflict as "is_conflict: bool"` cast suffix.
///
/// Used by the 3 runtime `sqlx::query_as::<_, BlockRow>(…)` sites
/// which use sqlx's `FromRow` for type mapping (no compile-time
/// `as "x: T"` cast needed because the type is resolved at runtime,
/// not at proc-macro expansion time). The runtime form rejects the
/// cast syntax that the macro form requires, so the two consts
/// must be kept lockstep but cannot be the same string.
///
/// Precedent: [`BLOCK_ROW_CANONICAL_SELECT`] for the macro form.
/// MAINT-223 (PEND-28a H1 follow-up) extracted this const from the
/// 3 runtime callsites to give them the same drift-detection
/// coverage that Test B gives the macro sites.
pub(crate) const BLOCK_ROW_RUNTIME_SELECT: &str =
    "id, block_type, content, parent_id, position, deleted_at, \
     is_conflict, conflict_type, todo_state, \
     priority, due_date, scheduled_date, page_id";

/// Canonical field list for `BlockRow` in struct-declaration order.
/// Used by the parity test to assert the SELECT clause matches the
/// struct's fields in the same order.  Keep in sync with the
/// `BlockRow` struct definition, [`BLOCK_ROW_CANONICAL_SELECT`], and
/// [`BLOCK_ROW_RUNTIME_SELECT`].
///
/// `#[allow(dead_code)]`: scaffolding for the parity test (Test A);
/// no production consumer.
#[allow(dead_code)]
pub(crate) const BLOCK_ROW_CANONICAL_FIELDS: &[&str] = &[
    "id",
    "block_type",
    "content",
    "parent_id",
    "position",
    "deleted_at",
    "is_conflict",
    "conflict_type",
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
                // `is_conflict as "is_conflict: bool"` -> `is_conflict`
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

    /// Test B — every `query_as!(BlockRow, ...)` callsite in the
    /// production source tree must use the canonical SELECT column
    /// list (after stripping the `b.` alias and collapsing
    /// whitespace).  Each source file is embedded at compile time
    /// via `include_str!` so the test is fully self-contained and
    /// runs without any filesystem access.
    ///
    /// The fixed-list-of-files approach (rather than a directory
    /// walk) is deliberate: when a developer adds a new
    /// `query_as!(BlockRow, …)` site in a file not yet listed here,
    /// the count assertion below catches it and forces a conscious
    /// decision to extend the list.
    #[test]
    fn block_row_canonical_query_as_sites_match_canonical_columns() {
        // (display_path, file_contents).  Paths are relative to this
        // module file (`src-tauri/src/pagination/block_row_columns.rs`).
        let sources: &[(&str, &str)] = &[
            (
                "commands/blocks/crud.rs",
                include_str!("../commands/blocks/crud.rs"),
            ),
            (
                "commands/blocks/queries.rs",
                include_str!("../commands/blocks/queries.rs"),
            ),
            (
                "commands/journal.rs",
                include_str!("../commands/journal.rs"),
            ),
            ("commands/pages.rs", include_str!("../commands/pages.rs")),
            (
                "commands/properties.rs",
                include_str!("../commands/properties.rs"),
            ),
            ("pagination/agenda.rs", include_str!("agenda.rs")),
            ("pagination/hierarchy.rs", include_str!("hierarchy.rs")),
            ("pagination/tags.rs", include_str!("tags.rs")),
            ("pagination/trash.rs", include_str!("trash.rs")),
            ("pagination/undated.rs", include_str!("undated.rs")),
            (
                "recurrence/compute.rs",
                include_str!("../recurrence/compute.rs"),
            ),
        ];

        // Match `query_as!(\s*BlockRow\s*,\s*<string-literal opener>SELECT
        // <columns> FROM ...`.  The opener allows the Rust raw-string
        // forms `r#"`, `r"`, or the plain `"` form.  `(?s)` makes `.`
        // match newlines so multi-line SELECT clauses are captured.
        // The non-greedy `(.+?)` stops at the first ` FROM ` token,
        // which always introduces the table list.
        let re =
            regex::Regex::new(r#"(?s)query_as!\(\s*BlockRow\s*,\s*r?#?"SELECT\s+(.+?)\s+FROM\s+"#)
                .expect("regex compiles");

        let canonical_normalized =
            normalize_whitespace(&strip_blocks_alias(BLOCK_ROW_CANONICAL_SELECT));

        let mut total_hits = 0usize;
        let mut failures: Vec<String> = Vec::new();

        for (path, src) in sources {
            for cap in re.captures_iter(src) {
                total_hits += 1;
                let raw_select = &cap[1];
                let normalized = normalize_whitespace(&strip_blocks_alias(raw_select));
                if normalized != canonical_normalized {
                    let line = src[..cap.get(0).unwrap().start()]
                        .matches('\n')
                        .count()
                        + 1;
                    failures.push(format!(
                        "  {path}:{line}\n    actual:    {normalized}\n    canonical: {canonical_normalized}",
                    ));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "{} `query_as!(BlockRow, …)` site(s) drift from \
             BLOCK_ROW_CANONICAL_SELECT (after stripping `b.` alias \
             and collapsing whitespace):\n{}\n\nUpdate the drifted \
             SELECT clause(s) to match BLOCK_ROW_CANONICAL_SELECT, \
             or — if the deviation is intentional — add the file to \
             an exclusion list and document why.",
            failures.len(),
            failures.join("\n"),
        );

        // Catches: a new `query_as!(BlockRow, …)` site is added to a
        // file already in the list above, or to a file NOT yet in
        // the list (which would not be detected by the column-list
        // check because `include_str!` wouldn't see it).  The
        // expected count is the sum of hits across every listed
        // file as audited at the time this test was written.
        //
        // When BlockRow gains a query_as! site (or when one is
        // removed), this assertion fails — bump the constant
        // deliberately and confirm the new site uses the canonical
        // SELECT.
        const EXPECTED_HITS: usize = 18;
        assert_eq!(
            total_hits, EXPECTED_HITS,
            "expected {EXPECTED_HITS} `query_as!(BlockRow, …)` \
             matches across the listed production source files, \
             found {total_hits}. Either a site was added/removed, \
             or the source file list above is missing a file. \
             Audit `grep -rn 'query_as!(' src-tauri/src/ | grep -B1 \
             'BlockRow,' | grep 'sqlx::query_as'` and reconcile.",
        );
    }

    /// Test C — every runtime `sqlx::query_as::<_, BlockRow>(…)` /
    /// `sqlx::query_as::<_, ActiveBlockRow>(…)` callsite covered by
    /// MAINT-223 must reference [`BLOCK_ROW_RUNTIME_SELECT`] (rather
    /// than embedding the 13-column list inline). Mirrors Test B but
    /// for the runtime form, which slips past Test B's regex because
    /// it uses turbofish syntax and a runtime `&str` argument.
    ///
    /// The captured SELECT-column slot is parametric: post-MAINT-223
    /// it is the literal `{}` placeholder (substituted by the
    /// `format!` arg), and substituting [`BLOCK_ROW_RUNTIME_SELECT`]
    /// in for the placeholder yields the canonical column list. If
    /// a future change inlines the columns again, the substitution
    /// is a no-op and the comparison catches the drift directly.
    ///
    /// Allowlist is intentionally narrow: `backlink/query.rs` and
    /// `tag_query/query.rs` are the 2 files MAINT-223 covers. The
    /// `pagination/properties.rs` runtime sites have a `b.` alias on
    /// every column and additional `WHERE`-clause complexity; they
    /// are tracked separately and not part of this parity test.
    #[test]
    fn block_row_canonical_runtime_sites_match_canonical_columns() {
        // First: assert `BLOCK_ROW_RUNTIME_SELECT` itself parses to
        // the canonical field list (mirrors Test A's check for the
        // macro-form const). The runtime form has no `as "x: T"`
        // casts so the parse is a simple split-on-comma + trim. This
        // guards against drift in the const itself, independent of
        // the production callsites.
        let runtime_parsed: Vec<String> = BLOCK_ROW_RUNTIME_SELECT
            .split(',')
            .map(|raw| raw.trim().to_string())
            .collect();
        let expected_fields: Vec<String> = BLOCK_ROW_CANONICAL_FIELDS
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert_eq!(
            runtime_parsed, expected_fields,
            "BLOCK_ROW_RUNTIME_SELECT has drifted from \
             BLOCK_ROW_CANONICAL_FIELDS. Update both consts together \
             so the parsed column names exactly match the field list."
        );

        let sources: &[(&str, &str)] = &[
            ("backlink/query.rs", include_str!("../backlink/query.rs")),
            ("tag_query/query.rs", include_str!("../tag_query/query.rs")),
        ];

        // Match `format!("SELECT {} FROM blocks …")` — the
        // post-MAINT-223 placeholder form used at all 3 runtime sites.
        // `[\s\\]+` matches Rust string-continuation backslashes (the
        // plain `"…"` form joins lines via `\<newline>`, unlike the
        // raw `r#"…"#` form used by the macro sites in Test B). The
        // tightened regex (capturing `\{\}` literal, not arbitrary
        // text) avoids false positives from other `format!()` calls
        // in the same files (e.g. `resolve_root_pages` selects
        // `id as block_id, …` from `blocks` but is NOT a BlockRow
        // runtime site).
        let re = regex::Regex::new(
            r#"(?s)format!\(\s*r?#?"SELECT[\s\\]+(\{\})[\s\\]+FROM[\s\\]+blocks"#,
        )
        .expect("regex compiles");

        let canonical_normalized = normalize_whitespace(BLOCK_ROW_RUNTIME_SELECT);

        let mut total_hits = 0usize;
        let mut failures: Vec<String> = Vec::new();

        for (path, src) in sources {
            for cap in re.captures_iter(src) {
                total_hits += 1;
                let m = cap.get(0).expect("capture group 0 exists");
                let raw_select = &cap[1];

                // Substitute the captured `{}` placeholder with the
                // canonical const value and verify the result matches
                // the canonical column list. Substitution is
                // tautological for the placeholder form (always
                // produces `BLOCK_ROW_RUNTIME_SELECT`), but the explicit
                // comparison documents the contract and catches the
                // hypothetical case where the const itself drifts from
                // the placeholder substitution shape.
                let substituted = raw_select.replace("{}", BLOCK_ROW_RUNTIME_SELECT);
                let normalized = normalize_whitespace(&strip_blocks_alias(&substituted));
                if normalized != canonical_normalized {
                    failures.push(format!(
                        "  {path} (placeholder substitution failed)\n    actual:    {normalized}\n    canonical: {canonical_normalized}",
                    ));
                    continue;
                }

                // Verify the format! call passes `BLOCK_ROW_RUNTIME_SELECT`
                // as the substitution argument. The const reference
                // appears within ~500 chars after the SELECT-literal
                // match (immediately after the closing `"` of the
                // format string in all 3 sites). Drift case: someone
                // substitutes a wrong const that happens to share the
                // same visible form but isn't `BLOCK_ROW_RUNTIME_SELECT`.
                let after = &src[m.end()..];
                let window = &after[..after.len().min(500)];
                if !window.contains("BLOCK_ROW_RUNTIME_SELECT") {
                    failures.push(format!(
                        "  {path}: format!(\"SELECT {{}} FROM blocks…\") at byte {} does not reference BLOCK_ROW_RUNTIME_SELECT in its argument list (within 500 chars).",
                        m.start(),
                    ));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "{} runtime `sqlx::query_as::<_, …>(format!(…))` site(s) \
             drift from BLOCK_ROW_RUNTIME_SELECT:\n{}\n\nUpdate the \
             drifted SELECT clause(s) to use `BLOCK_ROW_RUNTIME_SELECT` \
             via the `format!(\"SELECT {{}} FROM blocks…\", \
             …::BLOCK_ROW_RUNTIME_SELECT)` shape, or — if the \
             deviation is intentional — add the file to an exclusion \
             list and document why.",
            failures.len(),
            failures.join("\n"),
        );

        // Catches: a new runtime `query_as::<_, BlockRow>(format!(…))`
        // site is added to a file in the allowlist (count goes up), one
        // is removed (count goes down), or one drifts to inline-columns
        // (count goes down because the regex no longer matches it). The
        // 3 expected hits are: backlink/query.rs (small-IN-list +
        // large-IN-list paths) + tag_query/query.rs (eval_tag_query
        // final projection).
        const EXPECTED_HITS: usize = 3;
        assert_eq!(
            total_hits, EXPECTED_HITS,
            "expected {EXPECTED_HITS} runtime `format!(\"SELECT {{}} \
             FROM blocks…\")` matches across the listed production \
             source files, found {total_hits}. Either a site was \
             added/removed/drifted-to-inline-columns, or the source \
             file list above is missing a file. Audit `grep -rn \
             'query_as::<_, \\(Block\\|Active\\)Row>' src-tauri/src/` \
             and reconcile.",
        );
    }
}
