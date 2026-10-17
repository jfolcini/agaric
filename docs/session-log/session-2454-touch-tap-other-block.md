# Session 2454 — A tap on the block or chip below the edited one lands

#5723 reported two misses on touch, under Playwright's Pixel 7 emulation.
Both were reproduced against the mock before any change.

**Mechanism.** On a coarse pointer the static block has a 2.75rem minimum
height for its tap target, but the editor's `.ProseMirror` had only the
desktop 1.75rem. A one-line block measured 44 px static and 32 px while
edited. A press that blurred the editor grew the block back, and the rows
below moved down under the finger. Chromium sends a tap's compat
`mousedown`, `mouseup` and `click` in separate tasks, hit-testing each, so
the release landed on another element.

- **A text tap on another block.** #5722's `keepEditorUntilClick` already
  covers it on touch: the compat `mousedown` reaches it, and the press no
  longer blurs. No text tap missed on main. With that guard neutralised, the
  logged tap had its `mousedown` on the lower block and its `mouseup` on the
  edited one, 32 px higher, and the `click` went to the list.
- **A tap on a chip in the block below.** A chip press still blurs, so the
  chip moved 12 px down between the press and the release. A tap on its
  upper part released on the block's text, and the editor opened there
  instead of following the link (3 of 3).

**Fix.** `.ProseMirror` takes the static block's coarse-pointer minimum height
(`src/index.css`), so a blur no longer resizes the block on touch. Page mode
keeps its own `min-height: 0`, which is more specific.

**Specs** (`editor-lifecycle.spec.ts`, "Editor lifecycle on touch", Pixel 7):
a tap on the top edge of the block below moves the editor, saves, and takes
typing; a tap on the upper part of the link chip below opens Quick Notes.

**Shown red:**
- the chip spec without the fix, 3 of 3;
- the block spec with both the fix and #5722's `preventDefault` removed,
  3 of 3; either one alone keeps it green.

No handler changed, so no unit test was added; jsdom has no layout to show
the resize. The e2e-tauri lane cannot emulate touch, so it has no twin, and
the issue's Android emulator pass was not run.

**Ran:** the two specs `--repeat-each=5`; all 29 touch, mobile and editor
specs (242 passed); vitest on `EditableBlock`, `StaticBlock`, the long-press
and swipe hooks and `useEditorBlur` (319 passed); `npm run typecheck`;
`npm run lint`; `oxfmt --check`.
