# Session 1192 — Serialize TODO/priority toggles (enqueueMove contract)

**Date:** 2026-07-22
**Branch:** `fix/todo-priority-toggle-serialize`
**Closes:** #2922

## Summary

Fix a last-writer-wins race + a revert-clobber bug in the block TODO/priority
toggle handlers. Files: `src/hooks/useBlockProperties.ts` (+ test).

## The bug

`handleToggleTodo` / `handleTogglePriority` computed the next cycle state from a
snapshot taken at call time and dispatched the IPC immediately, with no
serialization. Rapid double-presses fired concurrent IPCs whose backend apply
order was not guaranteed (last-writer-wins), and the failure path reverted
*unconditionally* to the pre-call value — so a failed IPC could clobber a newer
toggle that had already superseded it during the await.

## The fix

Mirror the established `enqueueMove` per-block promise-chain serializer from
`src/stores/page-blocks.ts` (the #774 contract):

- Add a `useToggleQueue()` hook building the same `Map<blockId, Promise>` chain
  (`prev ? prev.then(run, run) : run()`, error-tolerant so a rejected predecessor
  still lets the successor run) with `.finally()` cleanup gated on
  `queue.get(blockId) === next` (never deletes a newer link).
- Two independent queue instances — one for todo, one for priority — since the
  two fields don't need to serialize against each other.
- The `current`/`nextState` snapshot is captured **inside** the queued `run`, so a
  queued second press cycles from whatever state the first press settled to, and
  the second IPC isn't dispatched until the first's round-trip resolves.
- Guarded revert: each catch reads the **live** store state and only reverts if it
  still equals the value this call wrote (nothing newer has landed).

## Tests

`src/hooks/__tests__/useBlockProperties.test.ts` — 40 pass. New tests cover rapid
double-toggle serialization (second IPC reads settled predecessor state; todo +
priority), failure-revert guard (no clobber of a superseding state; todo +
priority + toast-still-fires), a normal unsuperseded single-toggle revert, and
cross-block independence. Reverting the hook to the pre-fix logic fails exactly 4
of these (non-tautological); `tsc -b --noEmit` + `oxlint` clean.
