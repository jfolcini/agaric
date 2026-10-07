# Session 1894 — property pickers learn keys that arrive without a property event (#5296)

This is another `/batch-issues` batch from the session that logged 1877. It was
built while #5316 (#5298) waited on CI.

## #5296

- **The bug.** The property key and value lists are TanStack entries with
  `staleTime: Infinity`. Only `block:properties-changed` invalidated them, and
  only the property commands and MCP `set_property` emit it.
  - Several writers change `block_properties` without that event: sync, MCP
    writes, import, page source mode, undo or redo, and History revert.
  - A key that arrived that way was missing from the Agenda and backlinks
    property `Select`s and the `::` picker for the rest of the session. An
    undone key stayed listed and matched nothing.
- **The fix.** `invalidatePropertyCaches()` marks both lists stale. It is
  called from each writer the issue names:
  - `reloadChangedPageStores`, which covers sync and MCP;
  - the import runner, after a run that imported at least one unit;
  - `applyPageSource`, after a successful save;
  - `refreshAfterUndoRedo` and `PageHeader`'s undo and redo buttons;
  - `HistoryView.reloadAfterMutation`.
- **Overlap with #5310.** #5310 routes History revert through
  `reloadChangedPageStores`. Once both land, a revert invalidates the lists
  twice, which costs nothing: invalidation only marks entries stale.

## Verified

- New tests: the helper, plus one test per call site, each asserting the
  key list is marked stale. The import test also pins the failure arm, which
  leaves the lists alone.
- Nine mutations were run against a copy, then restored. Each turned its test
  red:
  - dropping either line of the helper;
  - dropping the call at each of the six sites;
  - running the import call when every unit failed.
- `vitest related` over the seven changed modules: 136 files, 4585 tests pass.
- `npm run typecheck` and type-aware oxlint pass.
