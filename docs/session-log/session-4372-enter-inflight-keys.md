# Session 4372 — keys pressed while Enter's create is in flight (#6977)

A fast typist presses Enter, then Tab or Backspace, before `create_block` answers. On the real backend, Tab was sometimes dropped, and Backspace sometimes sent `delete_block` twice and showed a "Failed to delete block" toast. The mock answers in the same tick, so neither showed there.

**Tab.** `afterEnterSettles` queued the chord correctly, but it read its target from the focus *once the Enter settled*. By then a fast Escape had cleared the focus, so the chord ran on nothing. A second Enter had moved the focus to the next new block, so it indented the wrong one. `__setMockLatency(80)` reproduced it every time, and in-page tracing showed `chord run null`. The fix: the Enter's promise now settles to the block that Enter focused, or null if it failed, and the chord runs on that block. One trap appeared once the target was right. The by-id handlers flush the focused editor, which unmounts it. When a second Enter has already taken the editor to the next block, that flush lost the text the user was typing there. On the bridge, `after` disappeared and the cleanup deleted the empty block. So when the editor is on another block, the chord runs the bare store move. The editor saved the Enter's block when it left it. The context-menu by-id path is unchanged.

**Backspace.** The second `remove()` came from the focus-leave empty-block cleanup. `remove()` waits on the held create before it splices the row. Meanwhile Backspace has moved the focus to the previous block, so the cleanup still sees the row as a blank candidate. When its probes answer before the create does, both removes wake on the same promise. `handleDeleteBlock` now adds the block to `preserveEmptyBlockIds` before it moves the focus, so the cleanup leaves alone a block a delete already owns.

**Tests.** Every test was shown red with the fix removed:
- `enter-split-race.test.ts`: Tab, then Escape before the create lands. Red is the `waitFor` on the new block's parent.
- `use-block-action-orchestration.test.ts`: Enter, Tab, Enter. Red is `handleFlush` being called under the second block's editor.
- `BlockTree.test.tsx`: Backspace before a deferred create. Red is two `delete_block` calls.
- `e2e/enter-delete-new-user.spec.ts`: gains a no-wait Tab + Escape test, and the Backspace test now reads the toasts after a reopen. The spec joins `REAL_BACKEND_SPECS`.

On the bridge, the whole spec passed 45/45 (`--repeat-each 5`). With main's orchestration file, the Tab test failed 5/5 and the existing Enter/Tab/Enter "batch Undo" test failed 3/5. The Backspace e2e did not go red locally without the fix (20 runs), because the double delete needs a create slower than the cleanup's probes. The vitest pins that interleaving. Also run: `npm run typecheck`, and vitest over `src/components/block-tree`, `src/components/editor` and `src/stores`.
