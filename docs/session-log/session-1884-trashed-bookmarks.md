# Session 1884 — trashed pages in sidebar Bookmarks (#5293), and #5306's review notes

This is the next batch of the session that logged 1873 and 1882.

## Board

- **#5306 (#5302).** It merged once `validate-all` and `dco` passed and
  the reviewer had approved. Its three non-blocking notes are applied here
  as their own commit.
- **#5307.** Open, from another session. Its session log also uses 1882,
  which is already on `main` from #5306, so this log takes 1884 and leaves
  1883 for that renumber.

## #5306's notes

- **The scroll effect in `useKeyboardNavigableList` was dead.** Its only
  consumers are Due and Done, whose rows rove focus through
  `useRovingRowFocus`. Since #5306 that hook scrolls the row it focuses, in
  the child effect that runs first, so the parent's scroll always found the
  row already in view. The effect is deleted, together with the
  `itemSelector` and `scrollBehavior` options it alone read (no caller
  passed either) and its seven tests.
  - The rest of the scroll path keeps two red-capable tests: removing the
    roving row's `scrollIntoView` fails the hook test and the Due panel's
    "End scrolls the projected entry into view" test.
- **`row.scrollIntoView?.(...)` drops its `?.`.** `src/test-setup.ts`
  already polyfills it for jsdom.
- **The range extractor's comment** now says the previously focused row
  stays mounted until the next scroll: one extra row, not a leak.

## #5293

- **The bug.** `BookmarksSection` listed every starred id the resolve cache
  had resolved, and never read `resolveStatus`. `markDeleted` keeps
  `resolved: true`. After a restart, the section's own `batchResolve` writes
  soft-deleted rows with `deleted: true`. Either way, a trashed bookmark
  stayed listed, and every click toasted "This page is in the trash".
- **The fix.** A resolved id is listed only while `resolveStatus(id)` is
  `'active'`. The star is kept, so a restore (`refreshDeleted` from the
  Trash view or Undo) lists it again.
- **Coverage.** The reviewer traced every trash and restore path. Header
  delete and undo, Pages batch delete and undo, block-tree deletes, the
  Trash view, and synced deletes that carry `changed_page_ids` all update
  the sidebar live. A peer delete without `changed_page_ids` stays listed
  until a restart. That is the existing merge-only `preload` behaviour and
  is not a regression.

## Verified

- **New tests and mutations.** Each of the three new BookmarksSection
  tests went red with the condition replaced by `true`. The reviewer also
  ran two more mutants: dropping `resolveVersion` from the memo deps, and
  sending deleted ids to `pending`.
- **Full vitest (reviewer, on the #5293 change before rebasing onto
  #5306):** 866 files, 20,404 tests passed (51 skipped, 1 expected fail).
- **On the combined branch:** vitest over `src/hooks`,
  `src/components/agenda`, `src/components/layout`,
  `src/components/journal`, `BlockListItem` and the resolve store passes
  (170 files, 2,856 tests), and `npm run typecheck` exits 0.
