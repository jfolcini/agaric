# Session 4448 — a page undo or redo pressed while another runs is queued

#7023: Ctrl+Z pressed several times quickly on a page dropped every press that came in before the previous undo's answer. Undo and redo now share one queue per page in `src/stores/undo.ts`, so N presses take N steps in press order. This replaces `undoInProgress`, `redoInProgress` and their skip branches.

**The three decisions the issue asked for:**
- **Interleaved undo and redo run in press order.** Each run reads the stacks the previous one left.
- **A press still queued when its page is cleared (left) is dropped.** The cleared page has no stacks, so the press would fall to the positional undo at depth 0. That targets the op the previous press may just have reverted, because the backend's group walk skips undo ops, not forward ops already reverted. Dropping the press loses no edit; running it could misapply one. `reanchorAfterRemoteOps` does not drop queued presses, because the in-flight result still applies there. A press made after coming back still runs.
- **A press that finds nothing, or that the backend refuses, settles like any other.** The runs catch their IPC errors, and the chain continues on both arms, so even a run that throws lets the next press run.

**Kept:** `undoInProgressEntry` and `topIsInFlightUndo`. `onNewAction` (a blur commit, say) does not go through the queue, so it can still land mid-undo. Forcing the check to `false` turns the mid-undo coalesce test red. The map moved to module scope so `latestUndoEntry` can read it.

**Review fixes:**
- **Toast Undo during a Ctrl+Z.** With the queue, the four toasts' "still the latest entry" check (broken-link removal, paste take-back, page-source save, board move) passed while a Ctrl+Z was reverting that same entry. Their Undo then queued behind it and took the step below. `latestUndoEntry` now returns `undefined` for an entry an undo is reverting, so those toasts see it as stale, as the old drop effectively did.
  - board-move's stale path calls `undo_ops` on refs the Ctrl+Z is reverting. `verify_undo_targets_in_tx` refuses an already-reversed target (#2468), so nothing is reverted twice.
- **Tests added:**
  - The rewritten concurrent-redo test now fails on the old code.
  - A run that throws, pinning the chain's rejection arm.
  - A press made after leaving and coming back.

**Edited assertions (the old ones pinned the drop):**
- "rejects concurrent undo…" became "runs a concurrent undo on the same page after the first, at the depth it left".
- "rejects concurrent redo…" became "a concurrent redo runs after the first and replays the next group".
- "clears the re-entrancy guard…" became "a second undo after the first settles works".
- Two e2e comments that described the drop are deleted.

**Not changed:** presses inside a focused block whose editor history is used up are still dropped while `runBlockPageHistory` runs (flush, page undo, reload). That drop is pinned on purpose by `e2e/block-undo-chains-page-undo.spec.ts` (#6556), so changing it is a maintainer decision.

**Ran:**
- Vitest over `src/stores/__tests__/`, the toast callers' tests and every other file that references the undo store: 103 files, 3,709 passed.
- `npm run typecheck`, oxlint and oxfmt.
- Each new test was shown red: on `origin/main`'s `undo.ts`, or for the queue internals under its own mutation.
- On the bridge: `undo-redo-blocks`, `journal-undo`, `reload-keeps-editor` and `block-undo-chains-page-undo`, 38 passed. The new three-press e2e test fails on the old `undo.ts` at `storedTodo` (`Received: "TODO"`).
