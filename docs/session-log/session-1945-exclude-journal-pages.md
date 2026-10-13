# Session 1945 — Pages and Graph hide journal pages by default (#5370)

Journal days crowded the Pages list and the Graph. Maintainer decision: a
removable "Exclude journal pages" filter, on by default in both views.

What shipped:

- Pages: a space with no stored filter slice reads as the journal chip, a
  `PathGlob` exclude on `JOURNAL_PAGE_GLOB` (`src/lib/date-utils.ts`). A
  stored `[]` means the user removed it and survives a restart; saved views
  apply exactly their own chips. The glob contains `[`, so the backend matches
  whole titles, not substrings; no backend change was needed (`path` is
  already allowed on Pages).
- The journal chip alone does not count as filtering, so an empty space still
  shows the create-first empty state and namespace folders still collapse.
- Graph: a new `excludeJournal` filter with an `is_journal` flag per node,
  on by default. `GraphFilterBar` hydrates any stored value, including `[]`,
  which makes the two #3889 self-heal writes redundant; they are deleted and
  the #3889 tests still pass.
- Reveal in Pages view on a journal title drops the space's journal chip
  first.
- `conformance/pages-metadata/path-glob.vectors.json` gains journal-titled
  rows and a journal scenario.

Verified: builder and reviewer falsified every new path on copies (all red,
restored and `cmp`-checked). Full vitest in three shards exit 0;
typecheck clean; Playwright 66/66 on pages-view, graph-view,
spaces-management, spaces-coverage and link-chip-lifecycle, and 104 passed
plus one known flake (editor-lifecycle, passed on retry) on 13 other specs
that open Pages or Graph. The Rust glob conformance test runs locally
before merge, since CI's backend filter does not cover `conformance/`.
