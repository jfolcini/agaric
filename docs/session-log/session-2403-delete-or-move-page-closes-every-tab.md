# Session 2403 — Deleting or moving a page closes it in every tab

Writing #5737's real-lane spec for the kebab's Delete page found this bug.
A page open in two tabs stayed open in the second one after a delete.

**The bug.**
- `PageHeader`'s delete called `onBack` → `goBack`. That closed the active
  tab and switched to the other one, which held the same page id.
- `PageEditor` got identical props, so nothing reloaded and the
  `not_found` heal in `page-blocks.ts` never ran.
- The deleted page stayed on screen, and its id stayed in `agaric:tabs`.
- The Pages-list row delete and batch Trash left background tabs on the
  deleted page. Those healed on click, with a "page is in the trash" toast.
- The review reproduced the same bug for Move to space, through the same
  `onBack` call.

**The fix.**
- A new tab-store action, `removePages`, drops the pages from every tab of
  the active space. It closes the tabs that empty, and keeps the active
  tab or activates the next one.
- When no page is left, it lands where `goBack`'s last-tab branch lands:
  `exitViewForTab`, the view the page was opened from (#4287).
- These call it: `usePageDeleteAction` (the kebab, the Pages row and the
  journal day), `PageBrowserBatchToolbar`'s Trash, and Move to space.
- The `onBack` prop chain through `ViewDispatcher` and `PageEditor` is then
  unused and goes.

**Not wired, by design.** In these paths the background tab heals with a
notice when clicked, and the active editor is never stale:
- the batch Move to space;
- block-tree deletes that cascade nested pages.

**Ran:**
- vitest on the stores, the page components and `usePageDeleteAction`:
  77 files, 2018 tests;
- `npm run typecheck`;
- Playwright: `delete-page-tabs`, `trashed-page-recents`,
  `spaces-management`, `background-tabs`, `keyboard-tabs-drawers` and
  `page-kebab`.

Each new test was shown red with `removePages` as a no-op, and the two-tab
unit test also with `onBack` restored.
