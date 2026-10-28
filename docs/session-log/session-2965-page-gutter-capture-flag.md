# Session 2965 — the last page-gutter mutant: a lane press is no click

#6108 had one mutant left after #6127 (session 2917): the capture flag on the gutter lane's mousedown listener (`page-gutter.ts`, `addEventListener('mousedown', this.pressLane, true)`). It is not equivalent, and a test now kills it.

**Why the flag matters:**
- ProseMirror registers its own mousedown on `view.dom` in the bubble phase. It skips a press whose `defaultPrevented` is set (`eventBelongsToView`). Otherwise it records the press, and the release then reaches every plugin's `handleClick` (`handleSingleClick`).
- With the lane listener in the capture phase, the lane prevents the press first, so a press in the gutter lane is no click for the editor.
- In the bubble phase, ProseMirror runs first and a lane press counts as a click in the text.

**The test** registers a plugin with a `handleClick` spy and stubs `document.caretPositionFromPoint` / `elementFromPoint`, which jsdom lacks, so ProseMirror can place a press:
- a press in the lane must not call the spy;
- a press in the block must call it once. That half makes the first non-vacuous.

The stubs are removed in `finally`.

**Red:** flipping only the `addEventListener` line's `true` to `false` fails the spy assertion ("expected not to be called, called 1 times").

**Counts** (split Stryker run at the blank line before `move`):
- before: 231 killed and 14 survived;
- after: 231 killed, 1 timeout and 13 survived.

The 13 survivors are exactly the page-gutter lines already in `mutation-accepted.tsv`. The timeout is the `lucide-…` class string, killed in the before run and timed out on the loaded box; Stryker counts a timeout as detected. A filer dry run reports 13 suppressed and 0 reportable.

**Suites:**
- `src/editor/page-mode` vitest: 757 passed;
- the gutter file under `--sequence.shuffle` with two seeds;
- typecheck, oxlint and oxfmt.

The reviewer checked the ProseMirror lines in the installed `prosemirror-view` 1.42.6.
