# Session 1618 — the restructure shortcuts discarded an uncommitted edit

Reported from the running app: type into a block, press Ctrl+Shift+Right or
Ctrl+Shift+Left, and the text you just typed is gone. It reproduces on all
four restructure chords, and on Tab / Shift+Tab where they are enabled.

## Root cause

Two flushes, in the wrong order.

`use-block-keyboard.ts` ran `cb.onFlush()` before `cb.onIndent()`. But the
handler behind `onIndent` — `handleIndent` in `use-block-action-orchestration.ts`,
and its dedent / move-up / move-down siblings — is already a complete
operation: it reads the editor's markdown, flushes, performs the move, then
remounts the editor on the same block with what it read.

`unmount()` ends with `replaceDocSilently(editor, <empty paragraph>)`. So by
the time the handler read the doc, the key rule's flush had already emptied
it. `getMarkdown()` returned `''`, and the block was remounted blank. The
first flush did persist the text, so the store was briefly correct while the
editor showed nothing — and the next commit from that blank editor wrote the
emptiness back.

The rule's flush was pure redundancy. Removing it from the four chord rules
and the two Tab rules is the whole fix. The boundary-arrow rules that follow
keep theirs: `handleFocusPrev` / `handleFocusNext` do not flush on their own.

## Verification

Reproduced first. Four new cases in `e2e/block-keyboard-move.spec.ts` type
into a block, press each chord, then assert the text is still in the editor
and — after navigating away and re-opening the page, so the assertion is on
re-queried state rather than on what the frontend asked for — still on the
block. All four failed before the change, one of them showing the editor
holding `PP` where the typed sentence should have been. All eleven tests in
that spec pass after it.

Six unit tests in `use-block-keyboard.test.ts` pinned the old contract by
name (`calls onFlush + onIndent`). They were asserting the defect, so they
are renamed and flipped to require that no flush happens, with the reason on
the describe block. 103 pass in that file; 4835 across the editor,
`components/editor` and `block-tree` suites.
