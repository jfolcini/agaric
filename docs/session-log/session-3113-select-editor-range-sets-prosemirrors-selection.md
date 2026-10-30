# Session 3113 — selectEditorRange sets ProseMirror's selection

**The flake.** `e2e/kind-change-undo.spec.ts`'s "block mode: Ctrl+Z in the editor after a typed `# ` brings the bullet back" failed on CI (on #6197, which does not touch it).
- The test focuses the block, places the caret at offset 0 with `selectEditorRange`, then types `# `.
- The text came out as `alpha#`, with the bullet kept: the keys landed at the end of the block.

**Cause.** `selectEditorRange` set the DOM selection and dispatched `selectionchange`, but ProseMirror never adopted it. There are two ways it refuses:
- Offset 0 landed inside the list marker, a widget span. The helper's text walk meets the marker's text node first, and ProseMirror ignores a caret in a widget.
- Just after a focus, ProseMirror takes a caret at the document's start for Chrome's focus reset, and puts its own selection back.

Either way its selection stayed at the end, where the click had put it, and its next transaction drew that back over the DOM. A real user does not hit this: a click inside the editor or a keypress ends the focus-reset window, and a click on the marker glyph is ignored without moving the caret.

**Fix.** The helper maps its DOM points with `view.posAtDOM(node, offset, 1)`, the bias ProseMirror uses to read a selection, and sets the selection through the editor's `setTextSelection`. This changes the test helper only; every spec that calls it gets the fix.

**Red first.**
- **Forced:** the first bullet-marker push after a mount was made to land late, between the helper and the typing. The old helper failed 5 of 5 on the `alpha#` assertion, and the fixed one passed 10 of 10. The reviewer re-ran it: 3 of 3 each way.
- **Under load:** 3 CPU burners. The old helper failed 14 of 40 at that assertion; the fixed one failed 0 of 40.

**Suites:** every spec that calls `selectEditorRange` (14 files, Playwright), plus typecheck and lint.
