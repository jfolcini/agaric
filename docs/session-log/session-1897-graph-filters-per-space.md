# Session 1897 — graph filters and saved views stay in their space (#5294)

This is another `/batch-issues` batch from the session that logged 1877. It was
built while #5319 (#5286) waited on CI.

## #5294

- **The bug.** Two filter stores were global while the ids in them are not.
  - The Graph filter bar persisted to one key, `agaric:graph-filters`, and
    `GraphView` kept its filter state across a space switch. A tag filter set
    in one space showed an empty graph in the next, and clearing it there
    cleared it for the first.
  - Saved Pages views are one list for every space, so a view saved with a tag
    chip, applied in another space, showed a raw-id chip and no results.
- **The fix.**
  - The filter bar persists under `agaric:graph-filters:<space id>`, fixed for
    each mount. `ViewDispatcher` keys `GraphView` by the active space, so a
    switch remounts it and hydrates that space's own list.
  - Applying a saved view lists the active space's tags and drops tag chips
    whose tag is not among them (`dropOtherSpacesTagChips` in
    `saved-pages-views.ts`). If the list fails, the view applies as saved, as
    before.
- **Not changed.** Saved views stay one list. Partitioning them per space
  would move stored preferences, and the issue only asks that a view apply
  sensibly.

## Verified

- New tests, each turned red by a mutation run against a copy, then restored:
  - one graph filter list per space. A storage key without the space id turns
    it red.
  - the graph view remounts on a space switch. Dropping the key turns it red.
  - a saved view drops a tag chip from another space. Applying `view.filters`
    unchecked turns it red.
  - the view applies every chip when the tag list fails. A catch that drops
    everything turns it red.
  - the helper's own unit tests, the happy path and the rejection path. The
    same two mutations turn them red.
- `vitest related` over the three changed components: 23 files, 498 tests
  pass. `saved-pages-views.test.ts` and the PageBrowser suite pass after the
  helper moved, 40 tests.
- `npm run typecheck` and type-aware oxlint pass.
- CI's hand-stub ratchet failed the first push. The helper's rejection test
  handed `vi.mocked(invoke)` a literal. It now stubs through
  `mockInvokeCommands`. The ratchet passes, and the same mutation still turns
  the test red.
