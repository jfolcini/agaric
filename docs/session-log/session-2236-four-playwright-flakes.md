# Session 2236 — Four flaky Playwright specs, one an app bug

A CI survey found Playwright specs whose first attempt failed and whose
retry passed, between 2026-10-01 and 10-16. Each was reproduced locally with
`--repeat-each` and retries off, except where noted.

- **`image-resize.spec.ts:22`, an app bug.** `ImageResizeHandle` started an
  arrow-key step or a drag from `range.width`. A `ResizeObserver` sets that
  state, and it renders a beat after the image resizes. A key pressed in that
  beat resized from the old width: the spec saw 190 where 210 was due. A
  user holding an arrow key, or pressing one right after a drag, loses a
  step. Both gestures now start from the image's laid-out width. A vitest in
  `ImageNodeView.test.tsx` goes red on each changed line. Runs: 1 of 30
  failed before, 0 of 90 after.
- **`page-source-edit.spec.ts:298`, a test race.** `openSourceMode` returned
  before the buffer focused itself, and ProseMirror writes its selection back
  over the DOM's shortly after a focus, which undid the test's caret move. It
  now waits for focus. Runs: 2 of 30 failed before, 0 of 60 after.
- **`nav-active-item.spec.ts:60`, a test race,** not reproduced locally
  (0 of 160). The tabs fade their fill, and a colour read mid-fade
  (`oklab(0 0 0 / 0)`) is unequal as a string to the resting
  `rgba(0, 0, 0, 0)`, so the comparisons passed or failed on the fade. The
  test turns transitions off, as the footer test in the same file does.
- **`mobile-overflow.spec.ts` "empty block placeholder", a test race.**
  `locator.fill` selects all natively, and ProseMirror reads that selection
  only later, so the text was appended or the block never emptied. A new
  `replaceEditorText` helper selects through the editor itself. Runs: 1 of
  120 failed before, 0 of 120 after. `block-keyboard-move` and
  `block-metadata-row-layout` used `fill` on an editor too and now use the
  helper.

**Checked, not changed:** `properties-table-and-refusals:122/152` flaked
until 10-14 and stopped with #5518, which attaches the console-error watcher
to every test instead of only to each worker's first spec file. That fixed
the cause.

`e2e/AGENTS.md` still shows `.fill(...)` on a block editor as its example
pattern. It needs maintainer approval to edit.
