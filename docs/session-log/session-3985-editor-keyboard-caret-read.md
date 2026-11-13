# Session 3985 — the editor-keyboard spec reads the caret after the browser reports it

Two tests in `e2e/editor-keyboard-6537.spec.ts` failed on PR CI (seen on #6648): "Shift+ArrowDown
past the end of block 2 selects blocks 2 and 3" and "ArrowUp from the second visual line of a
wrapped block stays in the block". One cause. Arrow keys inside a paragraph are handled by the
browser; ProseMirror learns where the caret went on the next `selectionchange`, which Chrome can
fire after the spec's next read. The spec's `caret()` helper read `editor.state` too early.

- In the first test a stale "not at end" read sent one Shift+ArrowDown too many. That press
  became block selection, which removes the editor, and the next read waited for an editor that
  was gone.
- In the second the read returned the offset from before the ArrowUp.

`caret()` now dispatches `selectionchange` before reading, as `selectEditorRange` in
`e2e/helpers.ts` does. No assertion changed and the product is unchanged: a person's next key
always comes after the event.

Traps:

- #6635 fixed the same mechanism in `block-keyboard-fundamentals.spec.ts`, not in this file.
- To reproduce, hold each real `selectionchange` until the next keydown or 300 ms: both tests
  then fail every run without the fix.
- A helper that reads `editor.state` straight after an arrow key is racy even with no further
  keys; sync first, or poll.

Ran: the file ten times at four and at eight workers under load, and `typecheck:e2e`.
