# Session 2893 — Load more shows a block once when a later page repeats it

#5659: the search cursor is the bm25 rank plus the block id, and bm25 depends on whole-index statistics. A write between two "Load more" fetches therefore shifts every rank, so a later page can repeat a row an earlier page returned, or skip one. `useSearchResults` flattened the loaded pages without deduping, so a repeat showed twice.

**Maintainer decision (2026-10-23):** fix the visible half in the frontend.
- The skip stays possible; a backend snapshot of the results costs more than it buys for now.
- The MCP `search` tool is not changed.

**Change:**
- `useSearchResults` keeps the first occurrence of each block id when it flattens its pages.
- Everything downstream reads that list: the result count, the keyboard cursor and selection, grouping, and the cap and "Load more" gate. So none of them can disagree with what is shown.
- No other surface pages `search_blocks` with the cursor. The palette, the sheet and the tag modes make single calls or page other commands.

**Shown red:** `useSearchResults.dedupe.test.ts` drives the real hook through three pages, where page 2 repeats page 1's second row. With the dedupe off, it fails at `[A, B, C]`, receiving `[A, B, B, C]`. Page 3 answers only page 2's cursor, so the test also pins that the next fetch still uses that cursor.

**Not added:** a real-backend case in `search-load-more.e2e.ts`. The repeat needs an empty block's index row to land between the two fetches. The background materializer writes that row and gives no signal when it is done, so a spec would race the click.

**Suites:**
- vitest `src/components` (both shards) and `src/hooks`;
- typecheck and lint;
- the search, palette and header-search Playwright specs.
