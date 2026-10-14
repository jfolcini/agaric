# Session 2046 — Lib-layering violations burned down, baseline deleted

Closes #5469, after the strict-invoke (#5521) and `JSON.parse` cast (#5522)
burn-downs. The frontend tiers are lib < stores < hooks < components; the
twelve files that imported upward now sit in the tier their imports say they
belong to, or stop importing upward.

- Hooks only components used moved into components:
  `use-dialog-or-sheet`, `useLazyRovingEditor`, `usePageBrowserFilters`.
- `usePageDeleteAction` returns the confirm dialog's props instead of a
  rendered dialog; its three hosts render `ConfirmDialog` themselves.
- lib modules that read or write stores moved to `src/stores/`: active
  space, recent commands and searches, back handlers, the block command bus,
  the space subscriber, inline property commit with unmount flush and
  empty-block cleanup. `searchSlashCommands` takes the recents as an
  argument, and a `BlockTree` test pins that it passes them.
- `palette-commands` imports a hook, so it moved to `src/hooks/`.
- `useLocalStoragePreference` depends only on React, so it moved down to
  `src/lib/local-storage-preference.ts`.
- The debug flag became the `debugMode` device preference on the same key and
  the same persisted envelope, so a user's setting survives; the debug store
  and its persist helper are gone.
- `dispatchBlockEvent` was an alias in `lib/block-events.ts`, which can no
  longer import the bus; callers use `dispatchBlockCommand`, and the toolbar
  config that called it moved next to the toolbar.

With nothing left in the baseline, the baseline is deleted: the guard fails
on any upward import, naming file, line, tiers and specifier, and exits 2 on
a missing or empty tier.

A reviewer compared every moved file byte for byte against its original
(imports aside), ran the old debug store against the new preference both
ways, and ran the full vitest suite (875 files, 0 failed) plus the pages,
slash-command and settings Playwright specs.
