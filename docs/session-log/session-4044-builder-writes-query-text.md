# Session 4044 — the query builder writes search-syntax text; the differential fuzz runs on every PR

`Closes #6628` (checkbox 3). `Refs #6567` (the fixed-seed fuzz; the stale-cache experiment was
not run).

**The builder writes text (#6628).** `filterToQueryText` (`src/lib/query-text.ts`) writes a
root `And` of leaves as search-syntax words and keeps them only when the block's own reader
compiles them back to the same leaves and the older-text classifier does not claim them. That one
check replaces a table of "expressible" rules: text `5` (the reader types it as a number), a value
holding a Markdown escape or a legacy key, two `State` leaves (the text would merge them) and a
tag that is not an id all fall back to `v2:` without a rule each. Leaf order is not compared, so
a filter built in any order is text; the builder reopens it in the reader's order.

- A tag is written as its `#[ULID]` chip, not `tag:#name`: it follows a rename as the payload's
  id did, and needs no tag lookup, so the writer is synchronous and the modal can preview the text.
- A negated leaf stays `v2:`. `Not(State)` and `State{exclude}` were not shown equal on null
  rows, so the builder's NOT toggle is not rewritten as `not-state:`; the State editor's own
  exclude switch is.
- `compileQueryText` was split into a synchronous core taking the tag list
  (`compileQueryTextWithTags`); the async wrapper lists tags only when the text names one.
- The modal opens a search-syntax block in advanced mode. A block with a token the engine cannot
  run (a relative date, free text, `under:`) is not opened and Save is disabled, since the form
  would overwrite it.
- A stored `v2:` block changes only when it is saved from the builder.

**The fixed-seed fuzz (#6567).** `conformance_fuzz.rs` keeps its body in one function; the
weekly random-seed test and a new ordinary test over a constant seed and 64 chains both call it.
The fixed run took about 10 s here and reached every command the weekly floor names; it went red
when the mock's `delete_block` returned one more `descendants_affected`.
A PR touching only `src/lib/tauri-mock/` does not run it: `scripts/classify-changes.sh` routes the
mock to the frontend lanes, so `cargo-tests` is skipped. Routing the mock to the Rust tests too
would put that lane on every mock PR; that trade is left on #6567.

**Not run: the stale-cache experiment (#6567).** The scenario as written cannot be driven through
the UI: Linked References leaves out blocks on the target page itself
(`b.page_id != tgt.page_id` in `backlink/grouped.rs`), so a panel for B and an editor writing a
link to B are never mounted together. The mechanism is as the issue describes: a local edit bumps
the graph counter, the panel refetches 150 ms later, and `ReindexBlockLinks` is a materializer
task. `references-filters.e2e.ts` and `table-cell-link-backlink.e2e.ts` already reopen the page
until the panel lists its sources. The box stays open.

Ran: the full vitest suite, typecheck, lint, the query Playwright specs (`query-block-text`,
`query-blocks`, `query-table-columns`), clippy, the full nextest workspace in two halves and the
offline sqlx check. A test-only Rust change, so no `.sqlx` or bindings regeneration. The rest of
the Playwright selection and the WebdriverIO lane were left to CI.
