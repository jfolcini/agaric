# Session 4172 — a query table cell edits its block (#6743)

Set out to make the cells of a `{{query … table:true}}` table editable: a property cell and the task-state cell open the Properties table's control for the key's type, and committing is one write with the board's Undo toast.

## What shipped

- `QueryTableCell` (`src/components/query/`): a button showing the value; a click or Enter swaps it for `EditorSlot`, the typed editor `PropertyRowEditor` already dispatches on, now exported. Escape closes it and writes nothing; a text field that loses focus closes too.
- The write goes through `usePropertySave` (`set_property`, or `delete_property` for an emptied value), which gained `onWritten` so a caller hears the appended ops. The task-state cell goes through `set_todo_state`, which stamps and recurs.
- `board-move.ts` is lifted, not copied: `recordBlockWrite` (undo stack, refetch, Undo toast) and `writeBlockValue` are what `moveCard` now calls, and the refetch covers inline queries as well as board columns.
- `QueryResult` keeps the batch's property rows beside the display map, since a cell edits the stored row, not its display string.
- `StaticQueryBlock`'s click capture yields to an `input`, or a click in an open field put the block into edit mode.

## Decisions and traps

- **A cell is a span until the space's definitions are read.** The editor is chosen from the definition, and an unread one would offer a text field for a select.
- **Keys the app manages are not editable**, the ones `buildCustomPropsMap` already hides: a `columns:created_at` query would otherwise write bookkeeping.
- **Enter in a field is prevented.** The editors commit by blurring, the close hands focus back to the cell's button, and the same key press then pressed that button and reopened the cell. Seen red in vitest before the fix; the e2e spec pins it in Chromium.
- **`SelectEditor` takes `onClose`**: given, its list starts open and reports closing, so a select cell is one click and never an idle trigger.
- **The table has no arrow-key row navigation**, before or after; the issue's "arrow keys still move between rows" is pinned as "a closed cell leaves the arrow keys alone".
- A ref cell shows the target's id, as the column did before; resolving it to a title is not part of this change.

## Verified

`npm run typecheck`; vitest for `src/components/query`, `AdvancedQuery`, `properties`, the property drawer and table, `usePropertySave` and `property-save-utils`; `e2e/query-table-cell-edit.spec.ts` and the specs `just e2e-related` selects. Each new vitest case and the e2e spec were shown red by a mutation of the code they cover.
