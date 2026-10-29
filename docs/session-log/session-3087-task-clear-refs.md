# Session 3087 — A kind change's task clear is ref-addressed, and an undo's restore never clears a task

This is #6156 part 2B. Parts 1 and 2A (#6176, #6185) made a kind change and the list style it took off one undo step. That holds for the page-level undo and for Ctrl+Z inside the editor. Two gaps were left:
- The task clear that goes with a kind change recorded an undo entry with no refs. Merged into the kind change's entry, it degraded the whole entry to positional undo.
- A restore could clear a task set after the change.

**Changed:**
- **`clearTaskStates`** clears each task through `delete_property(todo_state)`. That records the prior state (#5918) and returns its op refs, which join the kind change's entry, so the entry stays ref-addressed.
- **The mock** records the same `prior` for a reserved column key, and returns every op it appends, including the stamp clears. A new backend-authored fixture, `undo_delete_todo_state.json`, pins the prior. A vitest pins the refs, because conformance drops `op_refs`.
- **The maintainer's decision (option A):** an in-editor undo that would bring back a list style skips a block that has since become a task, in both modes. The task is kept and no hidden style is stored.
- **Cleanup:**
  - `PageLists`' `isTask` is required.
  - The dead `onOrderedList` handler and the `INSERT_ORDERED_LIST` event are gone.
- **Real-backend spec:** `e2e-tauri/kind-change-undo.e2e.ts` has two cases.
  - A bullet made a heading, then a page-level undo.
  - A done task made bulleted, then undone. It gets its state and stamps back, and a priority written after the change is kept. That case is what tells ref-addressed undo from positional.

**Red first:**
- **A ref-less entry:** three tests fail with `[null]` against `[[SET, DELETE]]`.
- **The task skip removed:** page mode loses the task (`expected null to be 'TODO'`), and block mode writes a hidden bullet.
- **The mock returning one ref:** `length 1` against `3`.
- **The Rust test with one ref captured:** `1` against `3`.
- **The native case against a ref-less build:** the undo took back the later priority.

**Not changed:** making a bullet a task is still undone by position. `setTodoStateOnBlocks` uses `set_todo_state_batch`, which returns no refs, and `clearListStyles` drops the refs that `clearListStyle` returns. This needs a Rust change. It is left for #6156's next part.

**Suites:**
- nextest, the whole workspace (7,212 tests), and the conformance fuzz lane;
- clippy, the `SQLX_OFFLINE` check and fmt;
- vitest, the whole suite (23,907 tests);
- typecheck, the e2e-tauri typecheck, lint and knip;
- the manual-stage hooks;
- Playwright (241);
- the native spec.
