## Session 947 — Multi-delete undo-reassurance toast (#217 C4 NEEDS-CHECK) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (partial; #217 stays open) |
| **Items modified** | #217 (C4 — NEEDS-CHECK resolved + shipped) |
| **Tests added** | +3, +1 modified (frontend) |
| **Files touched** | 3 |

**Summary:** Resolved the C4 "NEEDS-CHECK" item on #217 and shipped it. Frontend-only,
disjoint from the concurrent #138 Settings slice and the #325 page-title/tag-emoji work
(no `db.rs`, no `migrations/`, no page-title/tag/`PageHeader`/`EmojiPicker`/Settings files,
no `BlockTree.tsx`).

**The NEEDS-CHECK verdict (the gate the maintainer set):** "first verify batch-delete
actually registers an undo op (it may not call `onNewAction`); only add the reassurance if
undo genuinely works, else skip."

- **Frontend:** `handleBatchDelete` in `useBlockMultiSelect.ts` did NOT call
  `useUndoStore.getState().onNewAction(...)`, whereas `handleBatchSetTodo` did. So the
  maintainer's suspicion was literally correct at the JS layer.
- **But `onNewAction` is not what enables undo.** Read of `src/stores/undo.ts`: `onNewAction`
  only *resets* the per-page redo stack + `undoDepth` to a clean slate. The actual undo
  capability is backend-driven — `undo(pageId)` calls `undo_page_op({pageId, undoDepth})`,
  which reverses the most recent op in the page op-log.
- **Backend confirms batch-delete is genuinely undoable.** `delete_blocks_by_ids_inner`
  (`src-tauri/src/commands/blocks/crud.rs:836-849`) appends one `DeleteBlock` op per root to
  the op-log, with an explicit comment: *"so revert / undo replay against the same rows
  behaves identically regardless of whether they were deleted via the single or batch path."*
  The cascade is captured by the recursive `UPDATE`, and `reverse_delete_block` matches
  `op_record.created_at` against `blocks.deleted_at`. Test
  `delete_blocks_by_ids_writes_one_op_per_root_in_one_tx` already asserts the op-log shape.

**Conclusion: undo works → C4 is in scope.** Shipped:

- **C4 — multi-delete undo reassurance.** `handleBatchDelete` now (a) calls
  `useUndoStore.getState().onNewAction(rootParentId)` on success — mirroring the todo-batch
  path so the advertised undo lands on a clean redo slate, not a stale one — and (b) shows a
  new toast key `blockTree.deletedMessageUndo` ("Deleted {{count}} block(s) — Ctrl+Z to undo")
  instead of the bare `blockTree.deletedMessage`. The now-orphaned `deletedMessage` key
  (no remaining consumers) was removed.

**Files touched (this session):**
- `src/hooks/useBlockMultiSelect.ts` (+9/-1 — `onNewAction` on batch-delete success + undo
  toast key; `rootParentId` added to the `useCallback` deps)
- `src/lib/i18n/block.ts` (+5/-1 — new `blockTree.deletedMessageUndo`, removed orphaned
  `blockTree.deletedMessage`)
- `src/hooks/__tests__/useBlockMultiSelect.test.ts` (+3 tests: `onNewAction` fires on success,
  not when `rootParentId` is null, not on failure; +1 modified: success toast now asserts the
  `deletedMessageUndo` key)

**Verification:**
- `npx vitest run src/hooks/__tests__/useBlockMultiSelect.test.ts` — 29 passed.
- `npx vitest run src/components/__tests__/BlockTree.test.tsx -t "batch delete"` — 2 passed.
- `tsc -b` — no errors.

**Process notes:** Isolated worktree off `origin/main`
(`/home/javier/dev/agaric-wt-217c`, branch `fix/217-c4-undo-toast`), `node_modules` symlinked
before first edit (no `.env` in the main tree). #217 was CLOSED at session start (manually, no
closing commit); reopened with a claim comment per the maintainer's "keep #217 open"
instruction, since the medium items B1/B3/D1 remain. PR opened, not merged.
