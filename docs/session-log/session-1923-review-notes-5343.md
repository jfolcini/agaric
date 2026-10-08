# Session 1923 — review notes from #5343

Follow-up to #5343 (session 1921, image resize). It fixes two more places
where a control inside one of the editor's node views lost out to the
block around it: Backspace in a math source field, and focus coming back
from an image's control, which the reviewer flagged.

## Backspace in a math source field

#5343's key guard covered `keydown` only. `use-block-keyboard` also
listens for `beforeinput` on the contenteditable, for Gboard, and that
handler read the editor's caret too. `MathNodeView` contains its source
field's keydowns but not its `beforeinput`. With math at the start of a
block and the editor's caret before it, Backspace in the source field
never reached the field: the block merged into the one above. Chromium
showed it with the field's caret at the end and at position 0. With the
editor's caret at the end of the block, the field lost its character as
it should. The `beforeinput` handler now ignores input whose target is
not the contenteditable, as `handleKeyDown` already did.

## Focus coming back from an image's control

#5343 tagged the image node view's wrapper with `data-editor-portal`, so
focus moving from the text onto the collapse toggle, "Load" or the resize
handle kept the editor mounted. Focus moving back did not. The control's
`focusout` bubbles to the editor `<section>`'s `onBlur`, and
`useEditorBlur` found its `relatedTarget`, the contenteditable, under no
`data-editor-portal`, so it saved the block and unmounted the editor. In
Chromium, with Tab-indent off, Tab to the toggle and then Shift+Tab left
focus on `<body>` with the editor gone, and a character typed next went
nowhere. A click on the text after the Tab did the same. The formatting
toolbar had the same hole, since Shift+Tab from the text reaches its tab
stop and Tab back unmounted the editor. Tab onto a rendered math formula
unmounted it on the way in, because the math wrapper carries no tag.

`useEditorBlur` now also returns when the editor `<section>` contains
`relatedTarget`. Everything focusable in there belongs to the editor: the
contenteditable, the toolbar's and the selection bubble's tab stops, the
image's toggle, "Load" and resize handle, the math formula button and its
source field, the Mermaid toggle, and a tag chip. Focus moving between
them never ends the edit. The check sits after step 3, so a new block's
early persist still runs on such a blur, as it does when focus moves into
a portal. After the fix all four round trips keep the same editor in
Chromium, the caret stays where it was, and typing lands in the block.

That check also covers focus moving from the text onto an image's
control, so the `data-editor-portal` tag #5343 put on the image node view
no longer did anything and is gone, with the unit test that pinned it.
The Tab e2e now passes on the containment check alone.

## Verified

- `npx vitest run src/editor src/hooks src/components/editor`: 249 files,
  6 238 passed. `npm run typecheck` is clean, as are oxlint and oxfmt on
  the changed files. `prek run --files` passes on all 7 changed and new
  files.
- `e2e/image-resize.spec.ts` and `e2e/math-katex.spec.ts` pass in
  Chromium, five runs of each test with no retries: 30 of 30.
- Falsified on copies (restored, checked with `cmp`):
  - Math: without the `beforeinput` guard, the guard-side unit test and
    the e2e go red. With a guard that ignores everything, the other unit
    test goes red, along with eight Gboard tests.
  - Focus: without the containment check, the new `useEditorBlur` unit
    test and the extended Tab e2e go red, the e2e at the Shift+Tab step
    with no editor left to focus. With a check that returns on any
    `relatedTarget`, the new unit test for focus leaving the wrapper goes
    red, along with the B-56 click-outside test.
