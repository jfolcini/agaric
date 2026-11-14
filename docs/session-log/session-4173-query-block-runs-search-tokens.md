# Session 4173 — a query block runs every token the search box runs

`Refs #6742` (first item; OR between conditions is not in this PR).

A query block refused `under:`, `path:`, `not-path:`, a relative date and free text. It now
compiles each to what the query engine runs (`compileQueryText`, `src/lib/query-text.ts`), and
`conformance/fixtures/query_text_tokens_match_search.json` holds each to the rows `search_blocks`
returns for the same text.

- **Relative dates** are resolved in the frontend when the query runs, by `resolveNamedDate`
  (`src/lib/search-query/resolve-date.ts`). It is the port of `resolve_named_range` the mock's
  search already had, moved so both use one copy. The block stores `due:this-week`, never dates.
- **Free text** is the request's `fulltext`. A block of words alone runs over an empty `And`;
  only a block with neither a filter nor a word still refuses. Three texts the repository's tests
  held as errors (`todo`, a Logseq `(and …)` form) are searches now.
- **`path:` / `not-path:`**: the engine binds a `PathGlob` pattern as it stands, so the compiler
  runs `prepareGlobs` and writes one leaf per pattern, the names to keep in one `Or`.
  `QueryProjection::compile_path_glob` now delegates to `SearchProjection` (`b.page_id`) where it
  delegated to `PagesProjection` (`b.id`). **This changes the MCP `query` tool's `PathGlob`**: it
  matched page rows only and now matches every block on those pages; `And` it with
  `BlockType {values: [page]}` for the old rows. The builder has no path control, so no stored
  `v2:` block written by it holds one.
- **`under:`** needed a leaf that reads inherited tags. `FilterPrimitive::TagUnder` (key
  `tag-under`, advanced query only) wraps `tag_leaf_subquery_body(true)`, the SQL search runs for
  `under:`, so whatever that body matches the leaf matches. `tag:` is untouched.
- **The builder** does not open a text holding free text, `under:`, a page name or a relative
  date (`CompiledQueryText.textOnly`): its form has no control for them, and would save a relative
  date as today's dates.

Traps:

- `CONFORMANCE_UPDATE=1` rewrites every fixture in the harness's own JSON layout. Only the new
  file's `expected` is wanted: `git checkout -- conformance`, then `npx oxfmt --write` the new one.
- The parser already refuses `tag:` beside `under:`, so one `under:` token means every tag token
  is one.
- `prepareGlobs` caps the expansion over all its entries; the compiler prepares token by token to
  name the offending token, so a text whose `path:` tokens pass the cap only together runs here
  and is refused by search.
- The mock's shared `PathGlob` arm matched the row's own content. It now reads the title of the
  row's page, which for a page row is the same string, so the Pages surface is unchanged.

Ran: `npm run typecheck`; vitest over `src/lib`, `src/hooks` and the query components; the
`query-block-text` Playwright spec; clippy over the workspace; the full nextest workspace. Each new
test was shown red by breaking the line it covers, the two Rust changes through the fixture's
`block_path` and `block_under` steps. Bindings regenerated (`TagUnder`); no SQL changed.
