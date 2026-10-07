# Session 1919 — touch hold gesture, reading width (#5332 items 9 and 10)

Set out to build items 9 (task metadata on the text line) and 10 (drop the touch
drag lane) of the #5332 design plan, after the maintainer agreed to both.

Corrected on the way: the issue said the touch lane costs "about 70pt". Measured
on an iPhone 13 viewport it is 48px (text box at 92px from the screen edge, 44px
without the lane). Recorded on the issue.

Item 9 changed course. The first build put the chips in a right-hand column
level with the first text line from `md` up. Rendered at full width the chips
sat far from short titles; the maintainer compared four options on screenshots
(that column, the same inside a 46rem column, chips right after the text, chips
under the text as before) and chose to keep the chips under the text at every
width. What shipped from item 9:

- The desktop control lane and the task checkbox sit on the first line of a
  wrapped block (`items-start` + `min-h-8`, one text line box) instead of
  centring on the whole block.
- A `--container-reading: 46rem` token (`max-w-reading`) caps the page editor
  and the journal's day, week, stream and agenda views; the month grid keeps
  the full width. Left-aligned so the column lines up with the page title,
  which renders outside it in the view-header outlet. No full-width toggle.

Item 10 shipped as agreed: touch rows have no leading lane and no leaf drag
bullet. A 400 ms hold anywhere on the row (outside the focused editor's text)
lifts it through dnd-kit's `TouchSensor`; moving then drags, letting go without
moving opens the block menu on release. A parent's collapse chevron moved to the
right end of its first line on touch. The hold hook and the sensor share one
delay, one tolerance and dnd-kit's per-axis drift measure (`exceedsThreshold`).
A still touch drop skips the pre-drag focus restore so the editor does not
remount under the menu. Android's native `contextmenu`, which can fire inside the
hold, opens nothing while a touch press is pending.

Item 9's reading width moved click targets: `focusBlock` / `focusBlockById` in
`e2e/helpers.ts` clicked the centre of a block, which on a wrapped block at
46rem can be a tag chip; they now click the block's bottom-right padding.
`e2e/page-outline.spec.ts` waited on the 11th hydrated row, which no longer fits
the viewport; it now waits on its heading row.

Two container restarts interrupted builders mid-verification; each time the
working tree was checked against the builders' backups (no test mutation left
in place) before a continuation picked up.

Verified (the full-suite numbers are from the reviewer subagent's run on the
final tree): `npm run typecheck` clean; full vitest 870 files, 20 535 passed,
1 expected fail, 51 skipped. Playwright: the targeted touch, layout, drag,
keyboard and journal specs green, then the whole e2e suite in four chunks —
892 passed, 5 skipped, 4 failed, all reproducing on the pristine HEAD sources or
the container's older headless Chromium (`block-line-break` iPhone tap,
`pdfjs-v6-smoke`, `pdf-annotation-1452` ×2). Every new assertion was shown red
against a mutated copy and restored.

Not testable headlessly, left for a device check: Android `contextmenu` timing
against the 400 ms hold; iOS WKWebView scroll versus hold at the 5px tolerance
(no `touch-action` on the row; dnd-kit's non-passive `touchmove` prevents the
scroll only after activation); a long press inside the focused editor still
reaching the row's `contextmenu` handler on Android, as before this change.
