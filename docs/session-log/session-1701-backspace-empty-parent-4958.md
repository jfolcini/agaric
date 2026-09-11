# Session 1701 — Backspace on a blank parent kept its subtree (#4958)

Clearing a parent block's text and pressing Backspace once more removed the
whole outline under it. The keymap rule matches on `ctx.isEmpty`
(`src/editor/use-block-keyboard.ts:460` and the `deleteContentBackward`
branch at :637), and the roving editor holds only the focused block's own
text — so a blank *parent* reads as empty and routes to `handleDeleteBlock`,
which called `remove(focusedBlockId)` with no child check. The store filters
the block plus every descendant out optimistically and the backend
`delete_block` cascade soft-deletes them for real. The collapsed case was the
bad one: nothing on screen said more than one row was going.

## The shape chosen

Re-parent, matching the merge path, per the issue's own reading (both sibling
paths already guard this and this one never did). `handleDeleteBlock` now
calls the same `planChildReparent(blocks, focusedBlockId, prevBlock.id)`
`handleMergeWithPrev` and `handleMergeById` call, and awaits `moveBlocks(...)` before
`remove(...)` — the same before-the-remove ordering `mergeBlocksAndHandle`
enforces for #1342, for the same reason. No new helper, and the merge
handlers were not touched.

Three details of the lift:

- **Not verbatim from `mergeBlocksAndHandle`.** That block's surrounding
  machinery (revert-the-edit, remount-on-failure) belongs to a merge; the
  delete path has no edit to revert. What is shared is the plan call and the
  ordering, which is the part that carries the bug.
- **The delete stays synchronous.** `handleDeleteBlock` is
  `(opts?) => void` and moves focus synchronously; the reparent is chained
  into the existing fire-and-forget promise (`moveBlocks(...).then(() =>
  remove(...))`) rather than making the handler async. The existing
  `.catch`/`.finally` (warn, clear `deleteInProgress`) now covers both steps.
  The chain is also what makes a failed reparent safe: the store's
  `moveBlocks` swallows its own errors, but `BlockTree` hands the hook a
  wrapper that re-reads the tree and throws when a child is not under the
  new parent, so the `.then` never reaches `remove` and the subtree stays.
- **No previous row means the delete does not proceed.** `prevBlock` is
  `collapsedVisible[idx - 1]`, so at `idx === 0` there is nothing to adopt
  the children — the handler returns without removing anything, mirroring
  the merge handlers' `idx <= 0` bail and Guard 3 in
  `src/lib/empty-block-cleanup.ts`. Silent, like Guard 3; the childless
  first-block delete is unchanged.

The reparent target is the previous *visible* row, not the previous sibling —
whatever `collapsedVisible[idx - 1]` is, exactly as the merge path picks it.
That is the consistency the issue asked for, including the case where the
previous visible row is the block's own parent (children land after the
block's slot, then the block goes).

## Verified

- `use-block-action-orchestration.test.ts`: 114 passed. Five new cases in the
  `handleDeleteBlock` describe, driving a small mutable model of the store
  (`remove` takes the transitive `parent_id` closure the backend cascade
  takes; `moveBlocks` rewrites `parent_id`) so the assertions read
  re-queried tree state, not a spy: the collapsed blank parent, the expanded
  one, the no-row-above refusal, the reparent-failure abort, and the
  childless delete that must *not* reparent.
- Neighbours re-run for the changed call shape: `BlockTree.test.tsx`,
  `use-block-keyboard.test.ts`,
  `use-block-action-orchestration.enter-split-race.test.ts` — 363 passed.
- `npm run typecheck`: exit 0.
- Falsified against a `cp` copy of `use-block-action-orchestration.ts`:
  reverted only the new pre-`remove` block (guard, plan, chained
  `moveBlocks`). Three went red, the childless one stayed green.
  The collapsed case's red line:
  `AssertionError: expected [ 'A' ] to deeply equal [ 'A', 'B1', 'B2' ]` —
  the store lost the parent *and* both hidden children. Restored from the
  backup, `cmp`-clean, re-run green.
  The 109 pre-existing cases — the last-block guard, the #4552 list-style
  step-down, the #1342 merge reparenting — were green in both directions.
  The reparent-failure case was falsified separately, against its own copy:
  swallowing the `moveBlocks` rejection before the `.then` reds it with
  `expected [ 'A' ] to deeply equal [ 'A', 'B', 'B1', 'B2' ]`.

## Not done

No e2e spec. The gesture is a single keystroke on a collapsed row and the
per-PR lane runs against the mock backend, whose delete handler is a second
implementation of the cascade; the hook test with a modelled store pins the
same state transition without that middleman. `e2e-tauri/` (the real-backend
lane) is the place this would earn its keep, and per the testing invariants
that lane is `schedule`-only until #4671, so it would not guard the PR that
reintroduces this.

`docs/FEATURE-MAP.md` untouched: it carries one line per feature area and
documents no Backspace behaviour to correct.
