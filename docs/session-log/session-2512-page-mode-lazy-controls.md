# Session 2512 — Page mode mounts a block's controls as it nears the view

A performance slice of #5743, after slice 3's priorities and dates (#5814).
Page mode's `pageBlock` node view mounted block mode's checkbox and metadata
row for every decorated block as the page opened. It now mounts them as each
block nears the viewport.

**Design** (`src/editor/page-mode/page-tasks.ts`):
- `ControlsGate`, one per editor, holds one `IntersectionObserver` for all its
  blocks. The root is the scroller the page is in (`scrollParentY`, as block
  mode's `useViewportObserver` finds it), with a `rootMargin` of a screen
  (`100% 0px`). With the implicit viewport root, the `ScrollArea` clips each
  block before the margin applies, so a block mounted only once it was on
  screen. The observer is built at the first node view drawn once the editor
  is in the page: `EditorContent` draws the node views again when it attaches
  the editor (`createNodeViews`).
- A block's controls mount on its first intersection and then stay. Its id is
  remembered, so a node view drawn anew for a new depth (a Tab, a peer's move)
  mounts at once instead of blinking for a frame until the next report.
- The caret's block mounts at once, through a plugin view's `update` on the
  same plugin as the task keys. Ctrl+Enter, the priority keys and Ctrl+Shift+D
  never needed the controls: they act on the caret's block through the page's
  task actions. They now show what they changed where they were pressed. A
  block that becomes a task while its controls are mounted mounts its new
  checkbox at once.
- `beforeprint` mounts every block's controls. Export reads the backend, not
  the DOM. Find in page walks the DOM: the blocks' text is all there, as it was.
  A chip's text ("P1", "Oct 20") is found only once its row has mounted. Block
  mode's off-screen rows are empty placeholders, so its find already misses
  more than that.
- A runtime with no `IntersectionObserver` mounts everything at once. jsdom has
  the test setup's polyfill, which never reports, so the editor's tests stub
  `EnteringIntersectionObserver` (every block in view), as
  `AttachmentRenderer`'s tests do.
- Until a control mounts, its box is there, empty, with the same class. The
  checkbox's box is absolutely positioned in the slot page mode keeps left of
  the text, so it takes no room. The row's empty box keeps the row's height in
  CSS (`.page-block-metadata:empty`): its top margin, then a date chip's height
  (icon and padding), or, with `data-priority`, the badge's. The Playwright
  spec measures them equal to the pixel.

**Accessibility.** An unmounted checkbox's box is `role="img"` with block
mode's tooltip text, "TODO (Ctrl+Enter to cycle)", so assistive technology
does not lose a task's state. The text names the key that works on it in page
mode. Mounting removes both attributes, and the button's own label takes over.
axe passes over the page with boxes mounted and unmounted (vitest and
Playwright). The priority and dates are not named before their row mounts. Like
block mode's off-screen rows, they are read once the caret is in the block or
the block is within a screen.

**Tests, each shown red first by a one-command mutation (backup, trap, `! cmp -s`):**
- vitest `PageModeEditor.test.tsx`, with a `MockIntersectionObserver` driven
  by hand:
  - An off-screen task shows its state in an empty box and mounts once
    reported, then stays when reported out. It checks one observer, every
    block but the caret's observed, and the margin. Red twice: mounting at
    once (the marker found), and the report ignored (no marker).
  - The caret entering a block mounts its controls. Red: no reveal on the
    caret, no marker.
  - Ctrl+Enter makes an off-screen block a task, and its checkbox shows. Red:
    a new checkbox on a revealed block left unmounted.
  - A peer's state and priority on an unmounted block show once it mounts,
    and the empty box names the new state first. Red: `update` not keeping
    the props, so the mount drew TODO.
  - A mounted block drawn anew at a new depth keeps its controls. Red: the
    remembered ids ignored.
  - No `IntersectionObserver`: everything mounts. Red: nothing revealed there.
  - `beforeprint` mounts every block's controls. Red: no listener.
  - Leaving page mode leaves no portal, disconnects the observer and removes
    the print listener. Red twice: no `disconnect`, and the listener kept.
- Playwright `page-mode.spec.ts`, on a 200-block page where every block is a
  task, with a priority and a due date, a due date, a priority, or neither:
  - The bottom's controls are empty boxes, the checkbox's naming the state.
  - Scrolled to the bottom, they mount with the backend's values, twenty
    blocks up included, and a block in the middle stays unmounted.
  - The last twenty blocks' tops and heights match before and after.
  - axe passes over the page.
  - Red three times: the badge row's reservation removed (heights 52 to 56,
    each top after them moved), mounting at once (the bottom's marker there
    on open), and the viewport as root (twenty blocks up, above the view,
    not mounted). The spec passed 20 of 20 at 8 workers.

**Measurement.** `AGARIC_PERF=1 AGARIC_PERF_REPEATS=5 e2e/perf.spec.ts -g 'page
mode'`, sizes held to 500 (slice 3's seeding: every block a task with a
priority and a due date, every third a scheduled date), unthrottled, median and
band. The eager column is the same build with the gate revealing at `watch`,
run in the same session:

| Measure | Block mode | Page mode, eager | Page mode, lazy | Lazy, again |
| --- | --- | --- | --- | --- |
| Open | 57 [53–81] ms | 370 [359–394] ms | 371 [351–378] ms | 370 [365–372] ms |
| Worst frame while opening | 51 [0–148] ms | 441 [405–484] ms | 69 [68–79] ms | 67 [62–79] ms |
| Key to paint, p50 | 2.9 [2.8–3.2] ms | 8.0 [7.7–8.0] ms | 5.1 [5.1–5.3] ms | 5.2 [5.1–5.4] ms |
| Key to paint, p95 | 7.1 [3.6–11] ms | 10 [9–14] ms | 7.6 [6–11] ms | 7.4 [6–11] ms |
| INP while typing | 16 [16–16] ms | 16 [16–16] ms | 24 [16–24] ms | 16 [16–16] ms |

The eager column matches slice 3 (444 ms, 7.5 ms). The opening frame falls from
441 to 69 ms, with bands far apart. Key to paint p50 falls from 8.0 to 5.1 ms,
also clear of the band: a keystroke lays out a page without 500 rows of chips.
The open (to the 500th block) and p95 do not move beyond their bands. The first
lazy run's INP of 24 is one 8 ms step, and the second run gave 16 [16–16].

**Gates:** vitest over `src/editor src/stores src/components/pages`,
`npm run typecheck`, `npm run typecheck:e2e-tauri`, `npm run lint`, the
page-mode and page-mode-setting Playwright specs, and the perf spec above, on
a private port.
