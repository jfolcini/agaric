# Session 1893 — inline queries refresh while their page stays open (#5298)

This is another `/batch-issues` batch from the session that logged 1877. It was
built while #5313 (#5297) waited on CI.

## #5298

- **The bug.** A `{{query}}` block stays mounted through the optimistic store
  updates: a tick, a priority cycle, an edit or a delete. Its TanStack query was
  keyed on the space and expression only, and nothing invalidated it. Results
  went stale until the page was reloaded.
  - In table mode, the custom-property columns were fetched only when the
    result ids changed. A property edit leaves the ids alone, so even a refetch
    would not have refreshed those columns.
- **The fix.**
  - `useQueryExecution` invalidates its key prefix on the graph-structure
    counter and the block-property counter, as `useBacklinkGroups` does. The
    refetch runs in place, without a skeleton.
  - `QueryResult` re-reads the custom properties on every fetch. The hook
    exposes the fetch time as `resultsUpdatedAt`.
  - The effect keeps its `react-hooks/exhaustive-deps` suppression. Dropping
    it would expose a `set-state-in-effect` finding the suppression masks. It
    would also let the React Compiler compile `QueryResult`, which it skips
    today. That is a behaviour change this fix does not need.

## Verified

- `useQueryExecution.test.ts` (42 tests) and `QueryResult.test.tsx` (92 tests)
  pass. New tests:
  - The query re-runs in place when the structure counter moves, and when the
    property counter moves.
  - A table column shows a custom property's new value after only that
    property changed.
- Three mutations were run against a copy, then restored:
  - Dropping the structure invalidation turns the structure test red.
  - Dropping the property invalidation turns the property test and the table
    test red.
  - Keying the property effect on the result ids again turns the table test
    red.
- `vitest related` over the two changed modules: 42 files, 1625 tests pass.
- `npm run typecheck` and type-aware oxlint pass.
