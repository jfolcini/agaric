# Session 3135 — Task-state changes are undone by their refs

The last part of #6156. Every frontend path that sets or clears a task state now records an undo entry that holds the refs of its writes: the state, its stamps, the list-style clear that comes with it, and a repeating task's next occurrence. Undo reverses exactly those writes, not the latest ops by position, so a priority written afterwards survives the undo.

**What changed**
- **Backend:** `set_todo_state` returns `WithOps<BlockRow>` and `set_todo_state_batch` returns `WithOps<TodoStateBatch>`, both through `capture_op_refs`.
  - The single-row command keeps its `Box::pin`. Without it, the recurrence future trips `clippy::large_futures` in the wrapper.
- **Frontend callers:**
  - multi-select and page mode (`setTodoStateOnBlocks`);
  - the slash command (`handleTodoState`);
  - the checkbox cycle (`useBlockProperties`);
  - typed `[ ]` (`useCheckboxSyntax`);
  - the left-in-text marker (`commitCheckboxState`).
  - Each one records the state's refs plus the refs `clearListStyles` now returns, as one entry.
  - Page mode's own list-style clear joins that entry through `notifyUndoNewAction`, so the entry stays ref-addressed.
- **`clearTaskStates`** (page mode's bullet-over-task) is one `setTodoStateBatch(ids, null)` call again, instead of one `delete_property` per task. The batch records each block's prior state, so the undo restores the state and its `created_at` and `completed_at`.
- **The mock** returns the same refs as the backend. Conformance drops `op_refs`, so vitest pins the refs instead (`undo-op-refs.test.ts`).
- **Review fix:** clearing tasks through the batch made every clear of a repeating task log the "batch skips recurrence" warning. A clear rolls nothing forward on the single-row path either, so the batch now warns only when it sets a state.

**Traps**
- **The supersede bail in `commitCheckboxState`** records no entry, as on main. The newer flush records its own.
- **An undo entry is capped at `MAX_REVERT_OPS`.** A multi-select of several hundred tasks would exceed it, and the undo store drops that entry. That is unchanged in kind from the positional path, and nobody is near it in practice.
- **A falsification script with a relative `trap` path** left a mutation in place once. It was restored from its backup, and the path made absolute. Use absolute paths in the trap.

**Red first**
- **Rust:**
  - hiding the stamps' refs reddens every #6156 undo test;
  - hiding the recurrence ops reddens the repeating-task test;
  - removing the clear guard reddens `set_todo_state_batch_warns_on_a_set_not_on_a_clear_6156`, and so does inverting it.
- **vitest:** for each caller, one mutation records a ref-less entry and another drops the clear's refs. Each reddens that caller's own tests and `kind-change-undo.test.ts`.
- **e2e-tauri:** `kind-change-undo.e2e.ts` reddens on both of these:
  - `set_todo_state` returning no refs (the `/todo` case);
  - `set_todo_state_batch` returning no refs (the `/bullet-list`-on-a-task and toolbar cases).

**Suites**
- **Rust:**
  - nextest `todo_state | undo | mcp | conformance_fixtures_match_backend | ts_bindings_up_to_date` (714 tests);
  - `--test commands --test command_integration` (1638 tests);
  - clippy, `SQLX_OFFLINE` check and fmt.
- **Frontend:**
  - the full vitest suite;
  - typecheck, including e2e-tauri;
  - lint, knip and the manual-stage hooks.
- **Playwright:** the task, undo, slash, checkbox and multi-select specs, plus page mode.
- **WebdriverIO, natively:** `kind-change-undo`, `undo-todo-state` and `page-mode-tasks`.
