# Session 2510 — Page mode shows and sets priorities and dates

Slice 3 of #5743, after slice 2's tasks (#5805). A page whose blocks hold a
priority, a due date or a scheduled date now opens in page mode.

**Design.**
- The same `pageBlock` node view (`src/editor/page-mode/page-tasks.ts`) now
  mounts a second piece of block mode's: `BlockMetadataRow`, the row block mode
  draws under a block's text, with the priority badge and the due and scheduled
  chips. The badge is not in `BlockInlineControls`, which holds only the
  checkbox, so the row is mounted under `.page-block-content`, non-editable,
  while the block holds any of the three. Both mounts are one small `Control`
  class around TipTap's `ReactRenderer`. Like the checkbox, the row reads by
  block id from the page store's `blocksById` and redraws only when those three
  values change, so typing, its save and a reload draw nothing.
- The badge cycles through `handleTogglePriority` (`useBlockProperties`). The
  priority keys (`priority1`–`priority3`, Ctrl+Shift+1–3) are bound through
  `tipTapShortcutMap`, as block mode's `PriorityShortcuts` binds them, because
  `matchesShortcutBinding` does not match a shifted digit. They set the
  priority through `setBlockPriority`, the body of block mode's handler for the
  same keys, now exported from `use-block-properties.ts` and called by both
  modes. Both changes run on the save chain after a save, as slice 2's cycle
  does (`afterSave`, with `keep` for a new empty block).
- A chip opens block mode's date picker, `BlockDatePicker`, through
  `useBlockDatePicker`'s `openDatePickerFor`. The pick is queued on the save
  chain. `openDatePicker` (Ctrl+Shift+D) opens the same picker in its `date`
  mode, which links the date's page at the caret, as in block mode. Due and
  scheduled dates have no other keyboard path that does not use the slash menu
  or the formatting toolbar.
- The picker's dialog already carries `data-editor-portal`. Page mode's blur
  saves and commits only blocks the caret has left, so opening the picker
  commits nothing in the caret's block. Radix returns focus to the element
  that was focused when the dialog opened, and that was the dialog's
  autofocused field, so focus ended up on `body`. Block mode's picker does the
  same. Page mode now focuses the document when the picker closes, so the
  caret is where it was.
- Repeating tasks stay blocked, under the `properties` kind, and its message
  now says so: "Page mode can’t show block properties or repeating tasks
  yet." The toggle would handle completing one: `handleToggleTodo` calls
  `reloadIfRepeating`, and the page store's reload brings the next occurrence
  in through the remote patch. But block mode draws the rule as a chip from the
  block's properties (`RepeatIndicator` in `BlockMetadataRow`), and page mode
  does not read properties. Showing the task without its rule would hide it.
  The mock also has no recurrence, so the reschedule could only be checked in
  the real-backend lane. This waits for the properties slice.
- Clearing a date: block mode's picker has no Clear. Block mode clears dates
  through the property drawer and the slash menu, which page mode does not
  have yet. A date cleared elsewhere removes its chip, and the row goes when
  nothing is left.
- The `priorities` and `dates` blockers are gone, with their strings.

**Tests, each shown red first by a one-command mutation (backup, trap, `! cmp -s`):**
- vitest `PageModeEditor.test.tsx`:
  - The badge and chips render under the text, with axe. Red: never mounting
    the row, "no priority-badge".
  - A badge click sets the priority in the backend, and a refusal toasts.
    Red: a no-op handler, `'1'` for `'2'`.
  - Ctrl+Shift+3 and Ctrl+Shift+1 set it, a new empty block included, and a
    refusal toasts. Red twice: the key not taken (`false`), and the set
    called off the save chain (the empty block never created).
  - A date chosen in the picker is read back. Red: a no-op pick.
  - A refused date keeps the backend's chip. Red: an optimistic write in
    `handleDueMode`, "Due Dec 24".
  - Opening the picker neither commits a typed `[ ] ` nor moves the caret, and
    focus comes back. Red twice: the blur closing (`'buy milk'`), and no
    refocus.
  - Ctrl+Shift+D links the date's page. Red: the key not taken.
  - A peer's priority, scheduled date and cleared due date show on reload,
    outside undo. Red twice: no subscription, and a cleared row left drawn.
  - Typing, its save and a reload draw nothing. Red: redrawing an unchanged
    row, 4 renders. Without the save and the reload, that mutation passed; the
    test now does both.
- `page-mode-fit.test.ts`: priorities and dates are let in, and a repeating
  task is kept out with its message. Red twice: the old blockers back, and
  `repeat` ignored (this one also reddens the editor's reload test).
- The fast-check property gained set-priority and set-date steps, clearing
  included. The backend holds each block's last priority and dates. Red: a mock
  `edit_block` that clears `due_date`, after 24 runs.
- Playwright `page-mode.spec.ts`:
  - A page with a priority, a due date and a scheduled date opens in page mode.
  - The row lines up with the text, and ArrowDown and ArrowUp step over it.
  - Ctrl+Shift+2, a badge click and the picker set the values.
  - Away, back and Page again, and the values are still there. Then axe.
  - Red: Ctrl+Shift+2 setting P3. Passed 20 of 20 at 8 workers.
  - `page-mode-setting.spec.ts` now blocks on a query block.
- e2e-tauri `page-mode-priority-dates.e2e.ts`:
  - A due date set through the real IPC opens in page mode.
  - Ctrl+Shift+1, the badge and the picker's "today" set the values.
  - A round trip, then today's Due panel, which reads `agenda_cache`.
  - Type-checked only; it runs in CI. Its helper and Playwright's `shown` now
    read `.page-block-content`, so a chip's text is not read as the block's.

**Measurement.** `AGARIC_PERF=1 e2e/perf.spec.ts -g 'page mode'` now seeds a
priority on every block and a due date, and a scheduled date on every third.
The run's sizes were held to 500, with 5 repeats, unthrottled, median and band.
The baseline is the same harness with the new seeding skipped, run in the same
session:

| Measure | Block mode | Page mode, tasks | Page mode, tasks, priorities and dates |
| --- | --- | --- | --- |
| Open | 63 [48–82] ms | 368 [354–369] ms | 377 [364–382] ms |
| Worst frame while opening | 90 [0–137] ms | 195 [165–212] ms | 444 [429–504] ms |
| Key to paint, p50 | 2.9 [2.8–3.1] ms | 5.6 [5.5–5.7] ms | 7.5 [7.3–7.7] ms |
| Key to paint, p95 | 8.8 [6.1–13] ms | 7.3 [6.9–9.6] ms | 11 [8.4–13] ms |

The tasks-only column matches slice 2's 193 ms. The opening frame grows by
about 250 ms, to 444 ms, as 500 rows of badges and chips mount with the 500
checkboxes. Typing makes no long frames and no control redraws. Key to paint
p50 is 1.9 ms higher, with no React work on a key: the document has a row of
chips per block to lay out. As slice 2 found, mounting the controls as they
scroll into view is the lever if the cap is raised. It is not trivial, so it is
not done here.

**Gates:** vitest over `src/editor src/stores src/components/pages
src/components/block-tree e2e-tauri`, `npm run typecheck`,
`npm run typecheck:e2e-tauri`, `npm run lint`, and the page-mode,
page-mode-setting and perf Playwright specs on a private port.
