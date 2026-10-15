# Session 2075 — Escape right after Enter no longer leaves a blank block

On the real backend, Escape can land while Enter's `create_block` is in flight. It
acts on the source block (its editor already flushed and emptied) and clears focus;
the create then answered and `handleEnterSave` focused the new blank block anyway,
so the editor came back after Escape and no later focus change ever left that block
for the empty-block cleanup. `dropBlankIfFocusLeft` in
`use-block-action-orchestration.ts` reads the live focus once the create answers:
when it has left the source and is not in the new block, the new block is removed
the way the cleanup removes one (`undoable: false`) instead of being focused.

The e2e-tauri controls waited on the wrong block for the same reason: while the
create is in flight, the source block's emptied editor already reads as blank.
`focusedBlankBlockId` became `enterBlankSibling`, which presses End and Enter and
waits for a blank editor in a block other than the one it left.

Specs: `e2e/escape-right-after-enter-cleans-blank.spec.ts` holds the create until
Escape has landed (10/10 red with the fix disabled on a copy, at the no-editor
assertion; 10/10 green with it); three orchestration unit tests (drop, keep when
focus is in the new block, log a failed remove), each shown red.
`e2e/journal-add-block-while-editing.spec.ts` relied on this bug to reach its
state; it now gets there with a plain Enter and still fails with its own guard
removed. Suites run: the orchestration, cleanup and BlockTree vitest files,
`npm run typecheck`, `tsc -p tsconfig.wdio.json`, oxlint, oxfmt.
