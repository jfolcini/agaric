# Session 4033 — a query block written in the search syntax runs and stays text

`Refs #6628` (checkbox 2; checkbox 1 is the design note on the issue; checkbox 3, the builder
writing text, is not built).

A query block's text is now the search syntax, read by the search box's own parser, compiled to
the builder's `And` of leaves in `src/lib/query-text.ts`, and run on `run_advanced_query`. The
block keeps the text as typed.

Decisions and traps:

- `tag:` means a name prefix, attached or inline, OR'd in the older query text, and the exact tag,
  attached, AND'd in the search syntax. `isLegacyQueryText` keeps every stored block on the older
  path: a block is legacy when it uses a legacy-only key, or holds nothing but `tag:` words
  without `#`. A copy of the pre-change resolver is the request oracle, with fast-check over
  generated legacy text and every query text found in the repo pinned.
- `table:` and `columns:` are blanked, not cut, so an error's column matches the text the editor
  shows.
- `under:`, `path:` and `not-path:` cannot run on the query engine; relative dates other than
  `none` and free text come in a later slice. Each shows an error naming the token and its
  column, never an empty result. A block holding only `table:true` is an "empty query" error
  instead of every block in the space.
- Values follow the parser: `state:todo` is invalid and says so; the issue's own example was
  wrong.
- A `#name` typed in the block becomes a `#[ULID]` chip on save and is read by its id.
- Rule (4) taken literally read `tag:work hello` as search syntax: it used to show prefix results
  with the extra word ignored, and would have shown an error. The older text skips any word
  without a key, so the classifier now judges only keyed words, and such a block stays on the
  older path with its old results; the request oracle covers it.

Ran: the full vitest suite, typecheck, lint, the manual-stage hooks, and the query and search
Playwright specs. The rest of the Playwright selection (223 specs tagged `@editor @search`) and
the WebdriverIO specs were left to CI.
