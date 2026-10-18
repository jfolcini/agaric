# Session 2522 — review notes from #5805 and #5814

One PR for the non-blocking review notes of page mode's slices 2 and 3.

**Fixed:**
- **Closed tasks in block mode (#5805):** a done or cancelled block was held at
  half opacity, which measured 3.4:1 against WCAG's 4.5:1. It now takes
  `text-muted-foreground`, as page mode's does: 5.3:1 to 7.4:1 against
  `--background` across the six themes. axe cannot measure text under
  `opacity` (it files it as incomplete rather than failing it), so
  `e2e/closed-task-contrast.spec.ts` asserts a measured pass for both blocks,
  where real colours exist.
- **Mock drift:** the tauri mock stamped `completed_at` on a `todo_state` write
  but never `created_at`. It now runs both halves of
  `write_todo_timestamp_transitions_in_tx` on every path that writes the state.
  `set_todo_state_completed_at` pins it, with a `query_by_property` step for
  `created_at`. `query_point_reads_properties` sets CANCELLED instead of TODO:
  a payload replay writes only the column, while the mock's handler stamps.
- **Stale comments:** `use-block-date-picker.ts` said the hook only ever runs
  inside a BlockTree. Page mode is a second caller and passes a fresh
  `{ editor }` each render.

**Left as it is:** `PageModeEditor`'s `onSelect` closes the date picker and
`handleDatePick` closes it again. Dropping the first would hold the picker open
until the pick runs, because page mode queues the pick behind the saves; the
hook's own call is the one block mode needs.
