# Session 4389 — page mode's Ctrl+Enter task is one undo step on a slow backend

Fixes #6997. In page mode, Ctrl+Enter on a bulleted block cycles it into a task through block mode's `handleToggleTodo`, whose `clearLists` was page mode's `setListStyle(id, 'none')`. That queued the clear behind the running chain step and handed back no refs, so the clear recorded its own undo entry after the task write's and joined it only through the 500 ms `UNDO_GROUP_WINDOW_MS` window. A backend slower than that split the change into two Ctrl+Z.

Both callers of `clearLists` (the cycle and the block menu's bulk task state) already run after the save, so page mode's `clearLists` now writes the clears at once, through its `lists` as `setListStyle` does, and resolves their refs. The task write's `onNewAction` carries both, as block mode's `clearListStyles` does.

## What ran

- New `@mock-only` test in `e2e/kind-change-undo.spec.ts`: 300 ms mock latency on the Ctrl+Enter write. Without the fix it fails after one Ctrl+Z with `{listStyle: 'bullet', todo: 'TODO'}`; with it the whole spec passes (12).
- `npm run typecheck`, `npx vitest run src/editor/page-mode src/components/block-tree` (2311 pass), oxlint and oxfmt on the changed files.
