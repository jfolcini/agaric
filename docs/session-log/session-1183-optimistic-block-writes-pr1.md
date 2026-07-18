# Session 1183 — optimistic remove + structural moves, #2849 PR1

## Scope

Extend the editor's optimistic-write path so block **delete** and the keyboard
**structural moves** (`reorder`, `indent`, `dedent`, `moveUp`, `moveDown`) apply their tree
splice **before** the IPC round-trip, reconciling or rolling back on settle — matching the
existing optimistic discipline already used by `edit` / todo / priority. Frontend-only
(Zustand store); `queryClient` (read-path-only) untouched.

This is **PR1 of #2849**. It does NOT fully close the issue — `createBelow` (PR2, needs a
maintainer-approved backend client-ULID change), `moveToParent` / `moveBlocks` /
`pasteBlocks`, and the cross-parent `moveUp`/`moveDown` pop-out branches remain follow-ups.

## Mechanism (new shared core in `page-blocks-move.ts`)

- `applyProvisionalMove` — synchronous pre-await splice + a snapshot handle (pre-op
  `blocks`/`blocksById` + the moved block's `provIndex`/`provParent`) for exact rollback.
- `reconcileProvisionalMoveSuccess` — 3-branch settle: **still-in-place** (ref-equal or the
  block is still at `provIndex`+`provParent`) → heal `position` to the backend rank at the
  verified index (array order stays authoritative — no re-sort); a **disruptive concurrent
  write** (block no longer where the splice put it) or a **vanished** block → fall back to
  `load()`.
- `rollbackProvisionalMove` — error path: exact snapshot restore when
  `state.blocks === provBlocks` (nothing landed since), else `load()` so a concurrent write
  isn't clobbered — the same "still matches what I wrote" guard `edit` uses.

`remove` splices `block + descendants` pre-await with a snapshot; success re-confirms at
commit time with a **fresh** descendant recompute (guarded by `!blocksById.has(blockId)`,
preserving #2543 so a concurrently-dedented-out child survives); error restores or reloads.
`notifyUndoNewAction` stays on the resolve path (needs `resp.op_refs`). `enqueueMove`
already serializes the whole `run`, so the provisional apply is covered against rapid
double-presses.

## Correctness traps (all covered by tests)

1. Double-apply — the still-in-place / `has()` guards make a concurrent-sync `load()`
   re-confirm a no-op rather than re-splice.
2. Ordering vs settle — `enqueueMove` serialization spans the provisional window
   (rapid-double-`moveUp` test).
3. Focus/selection (#773/#798) — the load-START `preLoadBlocksById` guards are logically
   unchanged; an optimistically removed/moved block is handled by the existing snapshot
   discipline.
4. Undo-before-settle — undo registration is resolve-path only; no half-applied action can
   replay.

## Open decisions

- **Provisional `position` is safe.** `buildFlatTree` sorts by `.position` only at load
  time; while `blocks` is live, array order is authoritative. Every other `.position`
  reader (`reconcileBatchMove`, `dedent`) treats array order as authoritative and heals
  stale ranks, so a provisional position reconciled on resolve can't reorder.
- **Delete rollback: always snapshot** the full removed subtree (existing object refs — no
  deep copy) for an exact-reference restore.

## Review

Adversarial review found no correctness defects and added 5 interleaving tests empirically
confirming: a racing `load()` that reverts an indent → reload (no stale provisional kept);
a rollback that preserves a concurrent write; delete-subtree fresh-descendant recompute
(child-dedented-out survives); and position-heal touching only the moved block. It verified
the `blocks`⟺`blocksById` ref-invariant (so an exact `blocks` restore can never reinstate a
stale `blocksById`) and the `queryClient` guardrail.

## Verification

231 store tests (20 new across build + review) + 2227 hook tests + `tsc -b` clean +
`oxlint` clean + 21 Playwright e2e (`block-keyboard-move`, `undo-redo-blocks`,
`block-dnd-mouse`) green.
