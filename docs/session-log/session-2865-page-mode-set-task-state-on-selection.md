# Session 2865 — page mode sets one task state on a selection across blocks

This closes the remaining half of #5691's item "Actions on selections that span several blocks". #5981 already gave the page-mode block menu a bulk form with cycle rows. Block mode's batch toolbar (`BlockBatchActionMenu.tsx`) could set one task state on the whole selection, and page mode had no counterpart.

**Premise.** The toolbar's set-one-value actions are Clear / TODO / DOING / DONE, through one `setTodoStateBatch`. It has no set-priority action; priority only cycles, as in page mode. Due date and tags are not in the toolbar.

**Change:**
- **Menu rows.** The bulk form of page mode's block menu gets four rows, *Set task state to TODO / DOING / DONE* and *Clear task state*. They sit between *Cycle task state* and *Cycle priority*, and show only when the selection spans blocks.
- **Shared write.** The toolbar's write is extracted as `setTodoStateOnBlocks()` (`use-block-multi-select.ts`). Both modes call it, and block mode's menu is unchanged.
- **Save first.** Page mode's `afterSave` becomes `afterSaveAll(ids, change)`, so a save in flight lands first for every selected block. `afterSave` is now its one-id wrapper and behaves as before.
- **Refused writes.** A refused write shows the toolbar's toast and reads the page again.
- **Undo.** One undo entry per action.

Rows were chosen over a floating toolbar because `BlockBatchActionMenu` needs block mode's selection state. Touch parity does not apply: page mode is never offered on touch (`use-page-mode.ts`).

**The mock's undo of `set_todo_state_batch`, done at the maintainer's request.**
- **The bug:** the mock recorded the batch's ops with no prior value. Its revert only touched the properties map, while `todo_state` lives on the block row, so undo changed nothing.
- **The fix:** the op now records `prior`, as `set_property_in_tx` does on the backend. The revert puts a block-row column back from it. The reverse of a held prior is `set_property`, and the reverse of an empty prior is `delete_property` carrying the undone value as its own prior, as `reverse_set_property` does. So undo, redo and undo again all hold.
- **Pending:** no conformance fixture pins this command's undo yet. A backend-authored one is drafted for the next follow-up PR, which has a Rust build.

**Shown red:**
- writing to every page block;
- the `isBulk` guard removed;
- the first selected block skipped (Playwright);
- for the mock undo: the handler at HEAD, the revert arm disabled, the prior check removed, the redo value dropped, and the `delete_property` arm dropped.

**Suites run:**
- vitest over page mode, block-tree, editor, pages, `src/__tests__`, i18n, the tauri mock and stores;
- typecheck and lint;
- the import-cycle check;
- Playwright over the page-mode, batch and undo specs: 117 passed.

Not done: a selection dragged across a collapsed block also sets the hidden blocks, as page mode's cycle rows have since #5981.
