# Session 2525 — Advanced Query saved views kept per space on the device (#5738)

**The bug:** a saved Advanced Query view never listed on the real backend,
and it never had, since #1940.
- It was saved as a parentless content block, which never gets a
  `space_id`.
- `query_by_property` filters on `space_id`, so the list never found it.
- The mock behaved the same, so only the real lane showed it.

**Fix, as the maintainer chose** (option 1 on #5738): views live per space
in localStorage, the way Pages saved views do.
- `PREFERENCES.savedQueryViews` (scope `space`) holds an array of
  `{ id, name, spec }`. `spec` is the query's JSON, checked by
  `parseQuerySpec` on load.
  - It is a string because `lib/` may not import a store.
- `src/lib/saved-query-views.ts` saves, renames and deletes. Each is one
  read and one write through the registry, which broadcasts the change.
- `SavedViews.tsx` reads the list with `usePreference`.
- Deleted: the block-backed save, list, rename and delete, the marker
  constants, the loading and error states that synchronous storage cannot
  reach, the refresh prop, and four i18n keys nothing reads.

**Not migrated:** views saved under the old code. They never recorded a
space, so they stay invisible, as they always were.

**Specs:**
- `saved-query-views.test.ts`: order, per-space keys, rename and delete by
  id, and corrupt storage.
- `SavedViews.test.tsx` and `AdvancedQueryView.test.tsx`: the list survives
  a remount; another space lists none; saving without a space is refused;
  load, rename and delete stick; axe.
- `e2e/advanced-query-saved-views.spec.ts`: save, leave, come back; load
  restores the tree and results; rename; per space; delete.
- `e2e-tauri/advanced-query-saved-views.e2e.ts`: the same round trip on the
  real backend. It was red on `main`.

**Shown red:**
- save dropping the view;
- the preference scoped to the device instead of the space;
- rename and delete made no-ops;
- load into the wrong space;
- the no-space refusal removed.

Each turned red only the tests that cover it.

**Left:** the backend's `list_blocks` clause that drops `view_type =
'query-view'` blocks is now dead. It is Rust, and goes to the follow-up.

**Ran:**
- the whole vitest suite in two shards;
- typecheck, `typecheck:e2e`, `typecheck:e2e-tauri`, lint and knip;
- the layering and import-cycle guards;
- the new mock spec three times, and every Advanced Query mock spec once.
