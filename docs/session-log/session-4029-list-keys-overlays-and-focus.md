# Session 4029 — list keys stay in an open overlay; focus returns to the list when its batch toolbar empties the selection

Finished the `claude/list-keys-overlays-and-focus` branch from the overnight handover (#6667), a follow-up to #6654 and #6658. The builder had written the specs red first and was cut off before any implementation; this session built it.

What it changes:

- `pressesFocusedControl` (`src/hooks/useListKeyboardNavigation.ts`) answers true for every key pressed inside an open dialog, alert dialog or Radix popper (a select's listbox). Pages, Trash and History already gate their document listeners through it, so Escape in a confirm dialog closes the dialog and keeps the selection, and the arrows in an open select no longer move the list's cursor. Pages' Escape and Ctrl+A listener did not go through the gate and now does. A guard for a list rendered inside a dialog was written and removed: the three lists only render in the main view.
- `BatchActionToolbar` takes the list's ref. When one of its own buttons empties the selection (Deselect all, Clear selection, Restore selected), its layout cleanup, which runs before the node is removed, moves focus to the list's Tab stop: the list itself (Pages, Trash) or its cursor row (History). A selection emptied from elsewhere leaves focus alone. The ref is read at unmount because the list renders after the toolbar and its ref is still empty at mount.
- `BatchActionToolbar.test.tsx`, `HistorySelectionToolbar.test.tsx` and `PageBrowserBatchToolbar.test.tsx` pass the new required prop; no assertion changed.

Ran: the full vitest suite, `npm run typecheck`, `npm run lint`, and Playwright `list-keys-overlays-focus` with the Trash, History and Pages keyboard and Trash bulk specs (33 pass). All nine new e2e cases were shown red with both fixes disabled, each on the assertion it names.
