//! Drift-detection parity test for the space-filter SQL fragment.
//!
//! ## #533 — fragment collapsed to a native column
//!
//! Space membership is now a first-class `blocks.space_id` column
//! (migration 0086), so the read filter is the trivial
//! `(?N IS NULL OR b.space_id = ?N)` — see [`SPACE_FILTER_CANONICAL`].
//! The elaborate `block_properties` sub-select that the
//! history below was written to police no longer exists, which also
//! makes the sqlx-codegen rejection moot (there is nothing left to
//! compose). The fragment is still inlined at ~30 sites, so this parity
//! guard is retained against drift in the new shape; the historical
//! notes are kept for context.
//!
//! ## closure (session 680)
//!
//! (`build.rs` codegen via `OUT_DIR` files + `include_str!`
//! composition with `sqlx::query!` / `sqlx::query_as!`) was rejected
//! session 679 because sqlx 0.8.6 parses the macro's first argument
//! as a `syn::LitStr` token (`sqlx-macros-core-0.8.6/src/query/input.rs:55,61`)
//! — `include_str!(concat!(env!("OUT_DIR"), …))` is a macro-invocation
//! token tree that fails parser validation before any expansion
//! happens. `query_file!` is also blocked by the same `LitStr`
//! constraint plus `OUT_DIR`-path resolution rejection. Upstream
//! tracking: [sqlx#3388](https://github.com/launchbadge/sqlx/issues/3388)
//! (open, no PR linked, no ETA).
//!
//! As an alternative drift-mitigation, this module pins the canonical
//! shape of the space-filter SQL fragment and asserts every production
//! site matches it after normalisation. Mirrors the
//! [`crate::pagination::block_row_columns`] precedent (
//! Option 2, session 677).
//!
//! The canonical is `#[cfg(test)]` only — production code continues
//! to inline the fragment at every call site. When the fragment
//! changes (e.g., to add a `OR space_id IS NULL` clause for
//! pre- compat), update [`SPACE_FILTER_CANONICAL`] here, run
//! the parity test, and update each drifted site the test names.
//!
//! ## What's NOT in scope
//!
//! Some space-scoped queries in the source tree intentionally use
//! a *different* SQL shape and therefore are NOT canonical-fragment
//! sites. The parity test ([`tests::space_filter_production_sites_match_canonical`])
//! walks `src/**/*.rs` at test time and asserts the canonical shape
//! on every regex match, so structurally-different sites are simply
//! not matched by the canonical regex and need no allowlisting:
//!
//! | File | Why structurally different |
//! |---|---|
//! | `pagination/history.rs` (op-log filter) | `ol.block_id IN (SELECT id FROM blocks WHERE space_id = ?N)` — operates on op-log rows, resolving each to its `blocks` row via a sub-select; the bare `space_id` (no `b.` alias) is structurally distinct from the canonical `b.space_id`. |
//! | `fts/search.rs` / `fts/toggle_filter.rs` (dynamic SQL) | Bare `b.space_id = ?N` with no `?N IS NULL OR` guard — the filter is conditionally appended only when `space_id.is_some()`, so the inline shape is fundamentally different. |
//!
//! All production space filters read the first-class `blocks.space_id`
//! column (#533, migration 0086); the structurally-different sites above
//! differ only in their surrounding clause (sub-select vs. guard-less
//! append), not in the underlying column. The canonical-shape regex below
//! does not (and should not) match them. If the canonical fragment ever
//! changes shape, those sites will need separate review.

/// Canonical inline form of the space-filter SQL fragment with `?N`
/// standing in for the bind index (which varies from `?2` to `?8`
/// across production sites). After whitespace + bind-index +
/// `bp`-alias normalisation (see [`tests::normalize`]), every
/// production occurrence equals this string exactly.
///
/// Keep in sync with the inlined copy at every call site flagged by
/// [`tests::space_filter_production_sites_match_canonical`].
///
/// `#[cfg(test)]`-gated for the same reason as the precedent in
/// [`crate::pagination::block_row_columns::BLOCK_ROW_CANONICAL_SELECT`]:
/// the const is documentation / drift-detection scaffolding consumed
/// only by the parity tests in this module — production callsites
/// embed the fragment inline as a string literal because
/// `sqlx::query!` / `sqlx::query_as!` reject `concat!()` /
/// `include_str!()` composition (see the module doc above).
#[cfg(test)]
pub(crate) const SPACE_FILTER_CANONICAL: &str = "(?N IS NULL OR b.space_id = ?N)";

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use regex::Regex;

    /// Render every space-filter occurrence into a comparable canonical
    /// form by:
    ///
    /// 1. Replacing each `?<digits>` (e.g. `?2`, `?7`) with `?N` —
    ///    the bind index varies from site to site (`?2` … `?8`).
    /// 2. Replacing bare `?` placeholders (used at one dynamic-SQL
    ///    site, `tag_query/query.rs`) with `?N` so they normalise the
    ///    same as numbered ones.
    /// 3. Aliasing `bp_sp.` (used at two sites where the outer query
    ///    already takes the `bp` alias — `pagination/properties.rs`
    ///    line 162 and `commands/agenda.rs` line 425) back to `bp.`
    ///    so the column-reference alias matches the canonical.
    /// 4. Collapsing every run of ASCII whitespace (incl. backslash-
    ///    continuation newlines from `\` in raw-string SQL) into a
    ///    single space.
    /// 5. Removing whitespace immediately adjacent to `(` or `)` so
    ///    the variant at `commands/blocks/queries.rs` (which has
    ///    `?2\n            ))` rather than `?2))`) collapses to the
    ///    same shape as every other site.
    fn normalize(s: &str) -> String {
        // Numbered (`?2`) parameter placeholders -> `?N`. Pass 1.
        let numbered_re = Regex::new(r"\?\d+").expect("numbered placeholder regex compiles");
        let s = numbered_re.replace_all(s, "?N");
        // Bare (`?`) parameter placeholders -> `?N`. Pass 2.
        // The trailing-char capture group `(\W|$)` is preserved in the
        // replacement (`$1`) so we only consume the `?` itself. Because
        // the regex crate does not support lookaround, the bare-`?`
        // pattern necessarily *includes* the next char in the match —
        // we put it back via the capture. This is also what keeps the
        // canonical's literal `?N` safe: in `?N` the char after `?` is
        // `N` (a word char), which doesn't match `\W`, so the bare arm
        // declines and the literal stays untouched.
        let bare_re = Regex::new(r"\?(\W|$)").expect("bare placeholder regex compiles");
        let s = bare_re.replace_all(&s, "?N$1").to_string();
        // Alias `bp_sp` -> `bp`. Word-boundaried so a hypothetical
        // future identifier such as `bp_special` would not be
        // mangled.
        let alias_re = Regex::new(r"\bbp_sp\b").expect("alias regex compiles");
        let s = alias_re.replace_all(&s, "bp").to_string();
        // Whitespace + `\` line-continuation runs -> single space.
        // (Plain Rust string literals use `\<newline>` to fold lines;
        // `include_str!` returns the literal `\` byte, which `\s` does
        // not match. Treat it as part of inter-token whitespace.)
        let ws_re = Regex::new(r"[\s\\]+").expect("whitespace regex compiles");
        let s = ws_re.replace_all(&s, " ").to_string();
        // Strip whitespace immediately adjacent to parens.
        let paren_open_re = Regex::new(r"\(\s+").expect("paren-open regex compiles");
        let s = paren_open_re.replace_all(&s, "(").to_string();
        let paren_close_re = Regex::new(r"\s+\)").expect("paren-close regex compiles");
        let s = paren_close_re.replace_all(&s, ")").to_string();
        s.trim().to_string()
    }

    /// Test A — sanity check that the canonical const itself
    /// normalises to a stable form. A hand-written single-line
    /// equivalent (with `?2` instead of `?N`, no line breaks) must
    /// produce the same normalised string. Catches typos / pasted
    /// nbsp / smart-quote disasters in [`SPACE_FILTER_CANONICAL`].
    #[test]
    fn space_filter_canonical_normalises_to_self() {
        let canonical_norm = normalize(SPACE_FILTER_CANONICAL);
        let alternate = "(?2 IS NULL OR b.space_id = ?2)";
        assert_eq!(
            canonical_norm,
            normalize(alternate),
            "SPACE_FILTER_CANONICAL must normalise to the same value as a \
             hand-written single-line equivalent. If this fails, check \
             the const for stray invisible characters."
        );
    }

    /// Recursively collect every `*.rs` file under `dir`, returning
    /// `(display_path_relative_to_src, contents)` pairs. `std::fs`
    /// is fine in a test; this runs from the crate root (cargo sets
    /// the cwd to the package manifest dir for tests).
    fn collect_rs_files(
        dir: &std::path::Path,
        src_root: &std::path::Path,
    ) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let entries = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("read_dir {} failed: {e}", dir.display()));
        for entry in entries {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.is_dir() {
                out.extend(collect_rs_files(&path, src_root));
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                let rel = path
                    .strip_prefix(src_root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let contents = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("read {} failed: {e}", path.display()));
                out.push((rel, contents));
            }
        }
        out
    }

    /// Test B — every canonical-shape space-filter occurrence found by
    /// a recursive `src/**/*.rs` walk, after normalisation, equals
    /// [`SPACE_FILTER_CANONICAL`]. The walk (rather than a hand-
    /// maintained `include_str!` allowlist) means a new call site in
    /// *any* file is automatically asserted — there is no allowlist to
    /// fall out of sync with, and no magic expected-count to bump.
    ///
    /// Structurally-different sites (see the module-level "What's NOT
    /// in scope" doc) are excluded by `DENY_FILES` below. Note that
    /// the canonical regex only matches the `(?N IS NULL OR b.page_id
    /// IN (SELECT bp.block_id …))` shape, so files using `b.id IN`,
    /// `json_extract(...)`, or the guard-less dynamic-SQL form are not
    /// matched regardless — `DENY_FILES` is a belt-and-suspenders
    /// guard for files that happen to contain a canonical-looking
    /// fragment we deliberately do not want policed (e.g. this module
    /// itself, which holds the canonical const + the alternate string
    /// in test A).
    #[test]
    fn space_filter_production_sites_match_canonical() {
        // Files excluded from the parity walk. Paths are relative to
        // `src-tauri/src/`. Each entry must document why.
        const DENY_FILES: &[&str] = &[
            // This module holds SPACE_FILTER_CANONICAL itself plus the
            // hand-written single-line `alternate` in test A — both are
            // canonical by construction and policing them here would be
            // circular.
            "space_filter_canonical.rs",
        ];

        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let sites = collect_rs_files(&src_root, &src_root);

        // Permissive regex that locates every canonical-shape space-
        // filter occurrence. `(?s)` enables dot-matches-newline so
        // multi-line raw-string SQL is captured; `bp\w*` accepts
        // both the `bp` and `bp_sp` aliases; `\?\d*` accepts both
        // numbered (`?2`) and bare (`?`) parameter placeholders;
        // `[\s\\]+` between tokens absorbs the `\` line-
        // continuations used in plain (non-raw) Rust string-literal
        // SQL (e.g. `commands/agenda.rs:119` style: `… bp \⏎     WHERE …`).
        let pattern_re = Regex::new(
            r"(?s)\(\s*\?\d*[\s\\]+IS[\s\\]+NULL[\s\\]+OR[\s\\]+b\.space_id[\s\\]*=[\s\\]*\?\d*[\s\\]*\)"
        ).expect("space-filter pattern regex must compile");

        let canonical_norm = normalize(SPACE_FILTER_CANONICAL);
        let mut total_hits = 0usize;
        let mut failures: Vec<String> = Vec::new();

        for (path, content) in &sites {
            if DENY_FILES.contains(&path.as_str()) {
                continue;
            }
            for m in pattern_re.find_iter(content) {
                total_hits += 1;
                let site_norm = normalize(m.as_str());
                if site_norm != canonical_norm {
                    failures.push(format!(
                        "  {path}\n    actual:    {site_norm}\n    canonical: {canonical_norm}",
                    ));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "{} space-filter site(s) drifted from SPACE_FILTER_CANONICAL \
             (after bind-index, bp-alias, and whitespace \
             normalisation):\n{}\n\nUpdate the drifted SQL fragment(s) \
             to match SPACE_FILTER_CANONICAL, or — if the deviation is \
             intentional — extend `normalize` to absorb the new variant \
             and document why.",
            failures.len(),
            failures.join("\n"),
        );

        // The recursive walk should always find at least the known
        // production sites; a zero count means the regex or the walk
        // broke (e.g. the canonical fragment was reshaped without
        // updating the pattern), which would silently disable the
        // drift guard. No exact count is asserted — adding/removing a
        // canonical-shape call site no longer requires touching this
        // test, since every match is checked for shape conformance.
        assert!(
            total_hits > 0,
            "the src/**/*.rs walk found zero canonical-shape space-filter \
             sites; the pattern regex or SPACE_FILTER_CANONICAL shape \
             likely changed and silently disabled this drift guard. \
             Audit `grep -rn \"b.space_id = ?\" src-tauri/src/`.",
        );
    }

    proptest! {
        /// `normalize` is idempotent — re-normalizing a canonical
        /// form is a no-op. Tokens are space-joined so `?` placeholders are
        /// always separated (matching real bound SQL; `??`-style adjacency
        /// never occurs in the production filter strings this guards).
        #[test]
        fn normalize_is_idempotent(
            toks in prop::collection::vec(
                prop::sample::select(vec![
                    "?", "?2", "?7", "bp.", "bp_sp.", "(", ")", "foo", "block_id", "AND", "OR",
                    "IS", "NULL", "IN", "SELECT",
                ]),
                0..20,
            ),
        ) {
            let s = toks.join(" ");
            let once = normalize(&s);
            let twice = normalize(&once);
            prop_assert_eq!(once, twice);
        }

        /// Two strings differing only in inter-token whitespace (spaces, tabs,
        /// newlines, `\`-continuations) normalize to the same canonical form.
        #[test]
        fn normalize_collapses_whitespace_runs(
            tokens in prop::collection::vec("[a-zA-Z0-9_]{1,6}", 1..8),
            ws in prop::collection::vec(
                prop::sample::select(vec![" ", "  ", "   ", "\n", "\t", " \\\n"]),
                1..8,
            ),
        ) {
            let single = tokens.join(" ");
            let mut varied = String::new();
            for (i, tok) in tokens.iter().enumerate() {
                if i > 0 {
                    varied.push_str(ws[(i - 1) % ws.len()]);
                }
                varied.push_str(tok);
            }
            prop_assert_eq!(normalize(&single), normalize(&varied));
        }
    }
}
