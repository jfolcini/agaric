# Session 3555: a closed sheet takes no taps (#6347)

## What changed

- `src/components/ui/sheet.tsx`: a closed sheet takes no pointer events (`data-[state=closed]:pointer-events-none` on `SHEET_CONTENT_BASE`).
- `src/components/ui/dialog-shared.ts`: a closed scrim takes none either (`data-[state=closed]:!pointer-events-none` on `OVERLAY_SCRIM_CLASS`). The `!` is needed because Radix sets `pointer-events: auto` on the overlay inline.
- `e2e/page-source-edit.spec.ts`: a new 390 px test. It freezes animations through CDP, closes the page menu with Edit as Markdown, checks that the closed menu's Insert emoji row lies over the Welcome line, and taps there with `page.mouse.click`. The caret must land in the line.

## Why

The phone page menu is a Radix bottom sheet. After it closes, it stays hit-testable until React unmounts it, for two reasons. On a busy main thread its exit animation starts late, so it still sits where it was open. And once the exit ends, Radix drops the forwards fill before the unmount, so the sheet springs back to its open position.

At 390 px the closed Insert emoji row covers the Welcome line's centre. Playwright checks the hit target only on the first press of a click, so the third press of `selectLine`'s triple-click opened the emoji dialog. `moveSelection` then timed out, and the CI snapshot showed that dialog open. A real finger hits the same row, so the fix is in the primitive, not in the test.

## Checks

- New test: green with the fix. With both classes reverted it was red at the caret assertion every time, and reverting either class alone was enough to turn it red.
- The phone describe ×15 and the whole spec ×4, with several workers under CPU load: all green.
- vitest for the sheet, menu sheet, dialog and alert dialog suites: green. `npm run typecheck` and `npm run lint`: clean.
- Not explained: CI-like shard 3 runs stayed green locally on main and on #6371.
