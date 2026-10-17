# Session 2292 — A tag's page lists the pages and blocks tagged with it

The maintainer: the Tags view did not show the blocks or pages tagged with a
tag. Tracked as #5679, with their definition:
- one panel for pages tagged with the tag;
- one for blocks tagged directly, not through their page or an ancestor
  block;
- inline `#tag` counts as direct;
- blocks grouped by page, newest first;
- a link to search everything under the tag.

**Premise.** Clicking a tag opens the tag's own page, which since #4725 shows
no editor and listed nothing tagged.

**Data.** `run_advanced_query` with `TagOrRef(tag)` plus `BlockType`, newest
first, cursor-paginated in the active space. `TagOrRef` reads `block_tags`
(attached) ∪ `block_tag_refs` (inline `#tag`) and never
`block_tag_inherited`, which is exactly the direct definition. The Tags list
counts the same union, so the two panels add up to the tag's count. A
backend-authored fixture pins 3 = 1 page + 2 blocks. No Rust and no new IPC
were needed.

**UI.** A `TaggedItemsSection` on the tag page:
- a compact Pages list;
- Blocks grouped by page with the Linked references renderer, which gained
  an optional `listAriaLabel`;
- for each panel: an empty state, a first-load skeleton, an error card with
  Retry that logs, Load more by cursor, and keyboard navigation.

Both refresh on `invalidateNameCaches` and on mount. At phone width nothing
overflows and rows meet 44 px.

**The mock.** It ignored inline `#[ULID]` refs, which the backend indexes. It
now indexes them, so the seed counts in `query-blocks.spec.ts` moved
(`work` 3 to 4, `personal` 1 to 2). `query_tag_inline_refs.json` pins it.

**Not done:**
- **The search-everything link.** Search's `tag:#` filter matches attached
  tags only, and the inherited variant (`tags_match_inline_and_inherited`)
  exists only on MCP. It needs that field over IPC.
- **Expanding a block to show its children.** The Linked references renderer
  collapses page groups only.

Both stay on #5679.

**Tests.** Each was red at the predicted assertion:
- `Tag` instead of `TagOrRef` drops the inline block;
- letting pages into the blocks panel adds a row;
- counting ancestors' tags adds the two inherited blocks;
- removing the mock's inline indexing fails the fixture;
- seven component mutations each go red.

**Flake noticed.** pages-filter's "clears the saved scroll offset" failed
once with 4 workers, then passed three times alone. It goes on the flake
list.

Gates: full vitest (899 files, 21,378), `npm run typecheck`, oxlint, oxfmt,
the new spec plus the six tags specs (96/96), and query-blocks (28/28).
