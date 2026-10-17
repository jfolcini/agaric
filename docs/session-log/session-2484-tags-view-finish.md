# Session 2484 — Tags view: search everything under a tag, and expand a tagged block

Finishes #5679 after session 2292 shipped the two panels.

**The three acceptance criteria already held.** `query_tag_inline_refs.json`
is backend-authored and drives the panels' own `run_advanced_query`
(`TagOrRef` + `BlockType`): the blocks step returns only the attached S4 and
the inline S6, never S2 under the tagged page or S5 under the tagged block,
and the pages step returns the tagged page S1. `e2e/tag-page-tagged-items.spec.ts`
asserts the same through the UI. Nothing changed for them.

**Search everything under #tag.**
- `SearchFilter::tags_match_inline_and_inherited` went from `#[serde(skip)]`
  to `#[serde(default)]`. That is the whole backend change: the flag already
  routed `tag_ids` through the tag query's leaf
  (`tag_leaf_subquery_body(true)`) on every search path, for MCP. No SQL
  changed.
- The query syntax gained `under:#tag`, which names a tag like `tag:#` and
  sets the flag. The flag covers every tag of the query at once, so a `tag:#`
  or bare `#name` beside an `under:` chip turns invalid rather than widening
  silently. `under:#` completes tag names as `tag:#` does.
- The tag page's link writes `under:#<name>` into the palette's handoff slot
  and opens Search, the path the palette's escalation already uses.
- The mock matches the widened set through its existing `refInclusiveTags`
  and `inheritedTagIds`. Two `search_blocks` steps on the fixture pin both
  modes: widened returns S7 S6 S5 S4 S2 S1, attached-only S4 S1.

**Expanding a tagged block.** The embed read path, minus the block's own row:
`TaggedBlockChildren` mounts the owning page's store, slices the subtree with
`selectEmbeddedRows`, and draws it with `EmbeddedBlockTree`, which mounts no
editor. `BacklinkGroupRenderer` takes an optional `blockChildren` and gives
each row a disclosure button; Linked references does not pass it.

**Tests, each red first at the predicted assertion:**
- Rust: the MCP search test now also drives the app's IPC filter. With
  `serde(skip)` the widened search returned only the attached block.
- Conformance: the mock returned S4 S1 for the widened step until it learned
  the flag.
- vitest: the projection, the classifier's `tag:` invalidation, the `under:`
  prefix, autocomplete, the params bundle, the IPC marshal, the link's query
  and view, and the expansion's slice, depth, empty state, and click and
  Enter not opening the block. Axe with a block expanded.
- Playwright: open a tag, expand a block, follow the link; the results hold
  the blocks under the tagged page and block. With the mock's widening off it
  got 2 rows, not 5.
- e2e-tauri `tag-search-under.e2e.ts`: a block written before its page is
  tagged comes back from the link. Run locally under xvfb: green, and red with
  `serde(skip)` restored (only the page came back).

**Measurement.** A new measurement-only `interactive_slo` probe,
`bench_search_blocks_under_tag`: 100 attached parents with 9 children each and
100 inline refs in 100K blocks, the link's filter-only query against
`tag:#` on the same fixture. Three local runs under `release-test` (no LTO):
under 0.90 to 1.19 ms, attached-only 0.19 to 0.20 ms, both far inside the
30 ms search budget. No budget until `bench-slo` measures it.

**Gates:** workspace nextest (3544 + 3536), clippy `-D warnings`,
`SQLX_OFFLINE` check, full vitest (921 files), both typechecks, lint, and 16
tag, search and reference Playwright specs (101 passed, 1 skipped).
