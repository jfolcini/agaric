# Session 3892 — Ctrl+Z in a block with nothing left to undo runs the page's undo

#6556, its one checkbox. In a focused block of the page editor, Ctrl+Z (Ctrl+Y / Ctrl+Shift+Z) did nothing once the editor's own history was empty: the history resets on every mount, and `useUndoShortcuts` steps aside while any block has focus. Escape then Ctrl+Z worked, which nobody could guess.

## What changed

- `use-block-keyboard.ts`: two rules ahead of the chord rules. `undoLastPageOp` / `redoLastUndoneOp` match only when `editor.can()` says the history cannot take the press (`ctx.canHistory`, a call so only those chords pay for it), and hand it to the new `onPageHistory(direction)` callback, which says whether it took it. When it declines the key goes on to ProseMirror as before.
- `use-block-page-history.ts` (new, wired in `BlockTree`): unmounts the editor and flushes through `runUnmountFlush`, awaiting the save, so the page undo never runs under unsaved text. Clears focus before the undo, since `load()` keeps a focused block's old text, and registers the block in `preserveEmptyBlockIds` so the empty-block cleanup does not delete an Enter stub in that window (without it the cleanup's delete races the undo's). After `performPageUndo` / `performPageRedo` it mounts the editor on the same block with its reloaded text, or on the row above when the undo removed the block. Declines outside the `page-editor` view: the journal is a later stage of the undo sequence.
- `useUndoShortcuts.ts`: `runBlockPageHistory` runs the block's chain and drops a press while one runs; the global listener also stands aside meanwhile, since focus is cleared for the reload and a key repeat landing during the flush would otherwise run a second page undo (found in review, pinned by its own spec test). `performPageRedo` extracted as the twin of `performPageUndo` (the keyboard redo branch now calls it); header and the focused-block comment describe the chain.
- Docs: `docs/features/editor.md` § Pitfalls, `docs/features/keyboard.md`.

## Decisions and traps

- Page mode (`PageModeEditor`) and *Edit as Markdown* are separate editors and untouched; the issue scopes the page editor's block mode.
- Typing the debounce already saved shares the block's `edit:<id>` undo entry with its later saves, including the save of the editor's own undo. So after Ctrl+Z has taken the typing back in the editor, the next press undoes that entry: the text stays as it is and the toast shows. Pinned by the last spec test.
- The hook's ref param is named `preserveEmptyBlockIdsRef`: the React Compiler lint only treats `*Ref` names as refs inside `useCallback`.

## Checks run

- `e2e/block-undo-chains-page-undo.spec.ts` (9 tests): the first four red on main at the first post-Ctrl+Z assertion; the in-flight-press test red with the listener's guard removed, the rest with the `onPageHistory` wiring removed. Flush, `canHistory`, the row-above fallback and the empty-block preservation each falsified.
- vitest: `use-block-keyboard.test.ts` (new #6556 block), `use-block-page-history.test.ts` (new), `useUndoShortcuts.test.ts`, BlockTree reload / a11y / focus-renders / import-graph. `npm run typecheck` clean; oxlint clean on the touched files.
- Playwright: `undo-redo-blocks`, `kind-change-undo`, `editor-keyboard-chords`, `reload-keeps-editor`, `keyboard-customization` and the new spec, 40 passed. `just e2e-related` selects 250 specs; CI runs the rest.
