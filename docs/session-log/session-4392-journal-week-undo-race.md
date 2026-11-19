# Session 4392 — the week-view undo spec waits for the undo it pressed before pressing again

The per-PR bridge lane (#6996) failed `e2e/journal-undo.spec.ts` › "Ctrl+Z and Ctrl+Y act on the later day's edit, and a press past it stays on that day" on #6999. On a bridge built from `origin/main` it failed about 1 run in 4 to 1 in 10 with or without that PR's change: the `undo_page_group` poll never saw `[TODAY_PAGE]`.

**Cause.** Instrumented, the failing run recorded no `undo_page_group` call. It recorded one `log_frontend`: `[UndoStore] undo already in progress, skipping {"pageId":"…PAGE03"}`. The spec's previous Ctrl+Z was gated only on the backend's `get_block` returning the undone text. That is true once the backend commits, before the frontend's `useUndoStore.undo` has received its answer and released its per-page guard (`undoInProgress`). The next press landed in that gap and was dropped by design. The row's text changes only after the guard is released (`performPageUndo` reloads the page store after `undo` resolves), so a user who waits for the undo to show cannot press into the gap.

**Fix.** That step now waits for the row to show the undone text, as the spec's other steps already do, before installing the recorder and pressing again. No product change: dropping a press while that page's undo is in flight is the store's guard working, and nothing a user sees has happened yet when it drops one.

## What ran

- The test on the bridge, instrumented with a console capture: failed 1 of 4, with the warning above and no `undo_page_group` call.
- With the fix, the test on the bridge with `--repeat-each=30`: 30 pass. The whole spec with `--repeat-each=3`: 9 pass.
