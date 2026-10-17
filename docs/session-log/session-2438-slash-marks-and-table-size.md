# Session 2438 — Slash marks format, `/table4x6` works, `/table-no-header` goes

#5734's slash-command specs found the first two of these. The maintainer
decided the third.

**Fixed:**
- **`/bold`, `/italic`, `/code-mark`, `/strike` and `/highlight` now format
  the text typed next.**
  - The slash menu opens only at a collapsed caret, so the handler's
    selection branch could not be reached.
  - At the caret, the handler inserted the Markdown delimiter pair as text,
    and the saved block showed `**world**` literally.
  - It now calls the shared mark toggle, which sets a stored mark at the
    caret. The picker deletes its query before the handler runs, so nothing
    clears that mark before the next keystroke.
- **The size suffix can be typed.** The slash suggestion ends its query at a
  space, so `/table 4x6` closed the menu. The size now follows `table`
  directly (`/table4x6`), and the label and docs show that form.

**Removed:** `/table-no-header`. A GFM table always has a header row, so the
setting was lost on the first save.
- The removal covers the command, its handler and the `withHeaderRow`
  parameter.
- It also covers the command's tests and its mentions in
  `docs/features/pickers-and-slash.md` and `COMPARISON.md`.

**Also corrected:**
- `COMPARISON.md` carried a hand-kept slash-command count in two places,
  already wrong. Both copies are gone.
- `e2e/table-view-render.spec.ts` said Escape discards an edit. It saves,
  through `handleEscapeSave` → `handleFlush`.

**Specs:**
- **`e2e/slash-marks.spec.ts`** runs each of the five commands. It checks the
  mark in the live editor and again after a reopen, with no delimiters left
  in the text.
- **`e2e/slash-table-size.spec.ts`**: `/table4x6` inserts a table of 4 rows
  (the header row included) by 6 columns, and it survives a reopen.
- **Shown red:** both specs and their unit tests, against the old handler and
  the old size regex.

**Ran:**
- the two new specs with `slash-commands`, `slash-commands-coverage`,
  `table-view-render` and `toolbar-structural-inserts`;
- the new specs with `--repeat-each=3`;
- vitest on `src/components/block-tree` and the slash catalog;
- `npm run typecheck`.
