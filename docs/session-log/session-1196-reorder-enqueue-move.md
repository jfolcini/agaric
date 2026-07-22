# Session 1196 — Serialize reorder through enqueueMove (#774 contract)

**Date:** 2026-07-23
**Branch:** `fix/reorder-enqueue-move`
**Closes:** #2916

## Summary

The #774 per-block mover serialization queue's contract (`page-blocks.ts`) names
`moveUp`/`moveDown`/`indent`/`dedent`/`reorder` as the serialized sibling-slot movers, but
`reorder` was defined WITHOUT the `enqueueMove` wrapper — so a DnD reorder could interleave
with a queued keyboard mover on the same block. The provisional-move guards degraded this
to a full reconciling `load()` rather than corruption, but the documented invariant did not
hold.

## The fix

Wrap `reorder`'s body in `enqueueMove(blockId, async () => { … })`, structurally identical
to `indent`/`dedent`/`moveUp`/`moveDown`. The splice/reconcile/rollback logic inside is
byte-for-byte the original body (only the wrapper + reindent changed).

**Uncontended case is identical:** `enqueueMove` runs `run()` synchronously when the
block's queue is empty (`prev ? prev.then(run, run) : run()`), and `reorder`'s optimistic
`applyProvisionalMove` splice runs before its first `await`, so a lone reorder still
splices in the same tick — no added microtask, no DnD-feel regression. `moveToParent` and
`moveBlocks` stay unwrapped (the #774 contract covers only sibling-slot movers).

## Tests

`page-blocks.test.ts` — new `#2916` test fires `moveUp('B')` then `reorder('B', 3)`
back-to-back without awaiting the first (controllable-resolver mock): asserts only one
`move_block` IPC fires until `moveUp` settles, then `reorder`'s fires against the
post-`moveUp` state, final order `['A','C','D','B']`. Non-tautological: reverting to the
unwrapped form fails it (both IPCs fire in the same turn). 250 (store file) + 100
(DnD/reorder suites) vitest pass; tsc + oxlint clean.
