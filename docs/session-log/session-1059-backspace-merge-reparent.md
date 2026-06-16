# Session 1059 — #1342: Backspace-merge reparents children instead of soft-deleting the subtree

2026-06-16. From the 2026-06 round-2 Opus audit (ux/high). `/loop /batch-issues` run.

## Problem
Backspace at the start of a non-empty block **with children** ran the standard merge-into-previous
op: text merged onto the previous block, then `delete_block` cascade-soft-deleted the whole subtree.
Children were never reparented — a routine keystroke silently trashed them (recoverable via undo, but
reads as data loss). Logseq/Workflowy reparent; Notion blocks the merge.

## Fix
In the merge path (`useBlockKeyboardHandlers.ts`): when the source block has children, reparent its
**direct** children onto the merge target before removing the source, reusing the existing
`moveBlocks(ids, newParentId, newIndex)` store action (the same one multi-select drag uses — no new
op type). `newIndex` = the target's current direct-child count, so children append after any existing
ones, order preserved; grandchildren ride along with each moved subtree. Runs AFTER the content `edit`
commits, BEFORE `remove`. Childless merges are byte-for-byte unchanged.

## Critical bug caught in review (and fixed)
`moveBlocks` swallows its own errors (logs + `notify.error` + reload, never rethrows — "atomic from the
user's view"), so the intended abort-on-failure path was **dead code**: a partial/total reparent
failure would still let `remove`→`delete_block` cascade-delete the un-moved children — the original
#1342 data loss, narrowed to the un-moved tail. Fixed by wrapping the `moveBlocks` handed to the hook
(`BlockTree.tsx`) in a verifying callback that re-reads the reloaded tree and **throws** if any
requested child is missing or not under the new parent — making the revert-edit/skip-remove path
actually fire. On partial failure the result is now a valid non-lossy state (merge aborts, nothing
deleted).

## Verification
`useBlockKeyboardHandlers.test.ts` 70/0; two new real-store integration tests in `BlockTree.test.tsx`
(happy path: edit + move + delete; failure path: move rejects → edit reverted, `delete_block` NOT
called). Full frontend suite **12786 passed / 0 failed**; tsc clean. Builder + independent adversarial
reviewer (verdict FIXED-1).

## Follow-up (non-blocking, safe as-is)
Merging into a deeper previous block deepens reparented children and could hit backend `MAX_BLOCK_DEPTH`
— now surfaces as a `move_block` rejection that correctly aborts the merge (no data loss). File an issue
if that UX matters.
