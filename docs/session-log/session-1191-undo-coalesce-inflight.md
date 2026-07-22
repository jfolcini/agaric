# Session 1191 — Undo: prevent coalescing into an in-flight-undo entry

**Date:** 2026-07-22
**Branch:** `fix/undo-coalesce-inflight`
**Closes:** #2912

## Summary

Fix a subtle undo-correctness bug (#2912) that could permanently jam Ctrl+Z on a
page. Files: `src/stores/undo.ts` (+ test).

## The bug

`useEditorBlur` calls `setFocused(null)` synchronously while a debounced blur
edit-commit IPC is still in flight, so `useUndoShortcuts`' focus gate opens
mid-undo. The sequence:

1. Ctrl+Z snapshots the top `UndoStackEntry` `E` and starts `undoByRefs(E)` (IPC in flight).
2. The prior debounced blur-commit resolves and calls `onNewAction` with the same
   `coalesceKey` (`edit:<blockId>`), which coalesces — building a **new** merged
   object `E' = {refs:[r1, r2], …}` that **replaces** `E` at stack index 0.
3. The in-flight undo's reconcile (`withoutEntry(E)`) removes entries by object
   **identity** — it can no longer find `E` (the stack now holds `E'`), so `E'`
   survives still carrying the already-reversed ref `r1`.
4. The next Ctrl+Z submits `undoOps([r2, r1])`; the backend's atomic batch aborts
   on the already-reversed `r1` (`undo.batchUnavailable`). Undo is dead for the
   page until navigation/sync resets the stack.

## The fix

Prevent coalescing into an entry whose undo is in flight (chosen over ref-value
reconciliation because it's local to the two spots that already share the store
closure and leaves every reconcile path byte-for-byte unchanged):

- Add `undoInProgressEntry: Map<pageId, UndoStackEntry>` alongside the existing
  `undoInProgress` guard set.
- `undo()` records the snapshotted top entry (`undoInProgressEntry.set(pageId, top)`)
  after snapshotting, and clears it in the `finally` (both success and failure).
- `onNewAction()` computes `topIsInFlightUndo = top !== undefined &&
  undoInProgressEntry.get(pageId) === top` and gates **both** the same-`coalesceKey`
  and within-window merges on `!topIsInFlightUndo`, so when the top IS the reverting
  object a fresh entry is pushed above it. The in-flight undo's identity reconcile
  then removes the original cleanly.

Per-page keyed, so concurrent undos on different pages don't interfere. Normal
coalescing (no undo in flight), window logic, `reanchorAfterRemoteOps`, and the
undoOps-failure "entry stays on stack" contract are unchanged.

## Tests

`src/stores/__tests__/undo.test.ts` — 3 new tests (70 total pass): the precise
regression (fresh entry pushed, `E` unmutated by identity, follow-up Ctrl+Z reverts
only `r2` and never resubmits `r1`), guard-clears-on-settle (coalescing resumes
after the undo settles), and normal same-key coalescing preserved when no undo is
in flight. Neutralizing the guard fails the two guard-dependent regression tests
(non-tautological); `tsc -b --noEmit` clean.
