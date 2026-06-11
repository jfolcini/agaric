# Session 1005 — Multi-select block drag (#914)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#914 — multi-select drag.** `useBlockDnD.handleDragEnd` operated only on `active.id`, so
  dragging one block of a multi-selection moved just that block; the others were silently
  left behind, and the overlay badge showed the active block's *subtree* size, not the
  selection. Now, when the dragged block is part of a >1-block selection, the whole selection
  relocates to the projected drop slot, contiguous and order-preserving. Single-block drag,
  indent-on-drag, and drop-projection are unchanged.
  - `computeSelectionRoots(items, selectedIds)` (`tree-utils.ts`) — DFS ancestor-stack walk
    returning the selection "roots" in document order, dropping any selected block already
    nested inside another selected block (it travels inside its ancestor's subtree).
  - `moveBlocks(ids, newParentId, newIndex)` (`page-blocks.ts`) — orders the roots by current
    document position, issues one `move_block` per root at consecutive slots
    `newIndex + k` (sequential so each reads the prior commit; the backend slot excludes the
    moving block → contiguous run), reloads the tree, notifies undo; on partial failure it
    reloads to reconcile.
  - `useBlockDnD` accepts `selectedBlockIds` + `moveBlocks`, computes `dragRoots`/`isMultiDrag`,
    and branches to the multi-move only when the dragged block is itself a root and there is
    >1 root. `BlockTree` threads `selectedBlockIds`/`moveBlocks` in and the overlay badge now
    sums the selection-roots' subtrees.

## Tests

- `tree-utils.test.ts` (roots: empty/flat/doc-order/skip-nested/deep/independent/ghost),
  `page-blocks.test.ts` (`moveBlocks`: consecutive slots + reload + undo, doc-order from
  unordered input, new parent, boundary slot 0, empty no-op, drop-ghost-ids, failure
  reconcile), `useBlockDnD.test.ts` (multi-drag moves the selection; falls back when the
  dragged block isn't selected / only one selected / roots collapse to one; reparent; focus
  restore). 244 in the touched suites; full FE run 3429 passed; `tsc -b` clean.
- `e2e/block-dnd-multi-select.spec.ts` — 3 specs asserting the per-block `move_block`
  payloads; verified deterministic (9/9 with `--retries=0 --repeat-each=3`).

## Caveat

Like the existing single-block DnD specs, the e2e asserts the slots the UI *sends* (the
deterministic signal); the mock backend is more permissive than the real Rust backend, so
real-backend contiguity of the sequential consecutive-slot moves is worth a conformance check
if multi-drag ordering ever looks off on device.
