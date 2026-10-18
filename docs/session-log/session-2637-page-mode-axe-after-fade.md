# Session 2637 — page mode's axe checks wait for the opened page to finish fading in

Three `e2e/page-mode.spec.ts` flakes from #5908.

- **The query-and-embed test's `color-contrast` (fixed):** opening a page hides
  the content pane and fades it back in (`view-transition-wrapper`,
  `App.tsx`). `openViaPalette` returned once the title matched, and
  Playwright counts a half-transparent element as visible, so axe could run
  mid-fade, blend the pane's opacity into the text colour, and report a
  contrast below 4.5:1 that a person never sees. `openViaPalette` now waits
  for the wrapper's opacity to reach 1. The same wait covers the spec's other
  axe calls after an open, including the reduced-motion ones that could run
  while the pane was still fully transparent and so checked no text at all.
- **Priorities and dates, and arrows across blocks:** already fixed by
  a3f3de603. Both CI failures ran on older commits, when an arrow key could
  land before ProseMirror's post-focus selection write and be undone by it;
  `caret()` now waits that timer out.

Shown red the way CI failed: with the fade slowed to 3 s, the old spec reported
`color-contrast` and the new one passed; holding ProseMirror's focus timer
until the second key reproduced both caret messages on the pre-a3f3de603
`caret()` and passed on the current one.

Ran: `e2e/page-mode.spec.ts` (31), and each of the three tests with
`--repeat-each=20`.
