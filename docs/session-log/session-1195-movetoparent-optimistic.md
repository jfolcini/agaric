# Session 1195 — Optimistic moveToParent reparent

**Date:** 2026-07-23
**Branch:** `perf/movetoparent-optimistic`
**Closes:** #2900

## Summary

`moveToParent` (the single-block DnD reparent drop path) awaited a full
`get().load()` of the entire page subtree on every success — the last unconditional
O(page) reload in the move family (`reorder` uses optimistic provisional splice #404/R5;
`moveBlocks` reconciles surgically #2274). This makes it optimistic too, completing the
#2849 optimistic-application migration.

## The change (`src/stores/page-blocks-reducers.ts`, `moveToParent` only)

Reuses the existing `#2849` machinery (`applyProvisionalMove` /
`reconcileProvisionalMoveSuccess` / `rollbackProvisionalMove`) — the shared helper file
`page-blocks-move.ts` needed **zero changes**; `moveToParent` slots into the same generic
cross-parent, depth-rewriting splice contract `dedent` already exercises.

- **`canSplice` guard:** moved block loaded locally; target parent is `null` (root) or a
  tracked block that is neither the moved block nor one of its descendants (rejects
  reparent-into-own-subtree — the DnD UI never offers it, but a direct caller could).
- **Provisional splice (commit-time #714 callback):** recompute descendants against live
  `state.blocks`; `newDepth = parent==null ? 0 : targetParent.depth+1`,
  `delta = newDepth - curBlock.depth`; rewrite the moved block's `depth`/`parent_id`
  unconditionally and descendants' `depth` by `+delta` only when `delta !== 0` (preserving
  object identity otherwise — the subtree-touch perf invariant); insertion slot via the
  same `#400` sibling-slot algorithm `reorder` uses, generalized to the target parent's
  children.
- **Reconcile:** on the `moveBlock` response, `!handle` → reload (unchanged); backend
  `new_parent_id` echo differs from requested → discard optimistic guess and `load()`;
  else `reconcileProvisionalMoveSuccess` with the authoritative `new_position`.
- **Failure:** `rollbackProvisionalMove` restores the exact pre-splice snapshot; error
  logging/notification unchanged.

## Tests

`page-blocks.test.ts` — the old `moveToParent` describe blocks were replaced/extended
(optimistic path with no full reload, parent-echo reconcile fallback, descendant movement,
IPC failure/rollback, no-splice fallback) plus reviewer-added cases: reparent with
`delta = +2` and `delta = -2` (asserting final flattened order + every depth),
`delta = 0` descendant object-identity, mid-list sibling insertion, and the
own-descendant `canSplice` guard. Non-tautological: neutering the parent-echo guard or
forcing `delta = 0` fails the targeted tests. 248 (full file) + 101 (DnD/outline suites)
vitest pass; tsc + oxlint clean. `reorder`/`indent`/`dedent`/`moveBlocks` byte-for-byte
untouched.
