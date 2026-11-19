# Session 4415 — loading or saving a query view raises no toast over its controls

**Ask.** Root-cause the open flake in `advanced-query-saved-views.spec.ts` (#6910's run 44306809918), where the Rename dialog never opened, and delete its diagnostic.

**Cause.** The failure's snapshot held the Rename button focused, no dialog, and two toasts, "Loaded view" and "Saved view". Load raised a toast that slides into the bottom right, where the Saved views controls sit. Under the pointer at Rename's centre the hit target was Rename at once and the sliding toast 50 ms later, so the press focused Rename and the release landed on the toast: no click, no dialog. A user who loads a view and goes for Rename meets the same toast.

**Change.** Load and Save no longer raise a success toast: the builder shows the loaded query and the new row shows the save, as Rename already relies on its row. Their two strings go from every locale. The spec's pointer and dialog trace goes.

**Shown.** A probe hovered Rename's centre the way a click does just after Load: the hit target was Rename at 0 ms and the incoming toast at 50 ms. The unit tests now assert no success toast after a load and after a save; each goes red with its toast restored. Not shown red end to end: slowing the toast's slide or shortening the viewport did not make the click lose the race here, since Playwright waits while a settled toast covers the button. On the bridge, the advanced-query saved-views, board and happy-paths specs pass ×3 with the change.

**Ran:** `npx vitest run src/components/AdvancedQuery`, `npm run typecheck`, the three advanced-query specs on the bridge.
