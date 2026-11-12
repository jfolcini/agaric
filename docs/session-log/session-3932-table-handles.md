# Session 3932 — Tables: handles to add, delete, move and sort rows and columns (#6607)

**Goal.** Put row and column controls on a Markdown table itself, in block mode and page mode: add and delete from handles, move a row or column by drag (mouse and finger) and from the keyboard, and sort the body rows by a column. No schema, op type, store or IPC: every edit rewrites the table node, which the block saves as its `|` rows.

**What changed.**

- `src/lib/table-sort.ts`: the sort order. Numbers as numbers, then ISO dates as dates, when every non-empty cell is one; otherwise `Intl.Collator` with `numeric: true`. Empty cells last in both directions; ties stable.
- `src/editor/table-edit.ts`: `tableCaret`, `moveTableRowTo`, `moveTableColumnTo`, `sortTableByColumn`, `addTableRowAtEnd`, `addTableColumnAtEnd`, and `TableMoveKeys` (Alt+Shift+arrows through `matchesShortcutBinding`, so rebindable). Each edit is one transaction with `closeHistory`, so one undo takes back one edit; the caret lands in the moved or added cell. Wired into `contentExtensions().blocks`, which both editors use.
- `TableOpsSelector` gained move and sort entries, disabled where there is nowhere to go, and a `scope` (`row` / `column` / `table`). The handles show their scope; the toolbar menu and the page-mode bubble show all of it, which is the keyboard path.
- `src/components/editor-toolbar/TableHandles.tsx`: fixed-position handles in a body portal (`data-editor-portal`), mounted by `EditorSurface` (block mode) and `PageBubbleMenus` (page mode). Pointer events on the handle: under 6 px of travel is a press (menu), more is a drag with a drop line. `touch-none` and pointer capture make finger drags work.
- Four catalog shortcuts (`moveTableRowUp` and siblings, condition `inTable`); `page-mode-surface-parity.test.tsx` now asks those chords with the caret in a table cell.
- Docs: `docs/features/editor.md`, `docs/features/keyboard.md`, `docs/FEATURE-MAP.md`, and `COMPARISON-OBSIDIAN.md` (Tables row now Done, scorecard and item 14 updated).

**Decisions and traps.**

- The installed `moveTableRow` / `moveTableColumn` from prosemirror-tables (the issue's experiment) work in one transaction but throw `RangeError: Invalid content for node tableCell` on our tables: the parser makes an empty Markdown cell a `tableCell` with no paragraph, and those commands rebuild each cell with `createChecked`. The move and the sort are therefore a rebuild of the table node from its rows (`replaceRows`), which also keeps each column's `align` attr on its cells. `addRow` / `addColumn` from prosemirror-tables are used as they are.
- The header row never moves and is never sorted (`moveTableRowTo` refuses row 0 and index 0).
- Review: the parser keeps a row written with fewer cells than the header short, so a column move first fills it out, or its cells would slide under the wrong headers. A date-only cell sorts as local midnight, as a zoneless date-time does; `Date.parse` reads the date alone as UTC, which put `2026-01-15` after `2026-01-15T08:00` east of UTC.
- React bubbles a portal's events to the block row it is rendered from; `SortableBlock` reads touch on that row as a swipe or a block drag. The handles' portal stops those events. Removing that made the e2e finger drag of a column fail (the column did not move).
- A Radix popover or tooltip still closing takes an Escape for itself, so the e2e spec waits for both to be gone before Escape leaves the editor. In the touch emulation, a cell tap straight after a CDP finger drag produced no click; the touch case avoids tapping a cell after a drag.

**Checks run.** Vitest on the new and touched test files (table-sort, table-edit, TableOpsSelector, TableHandles, page-mode-surface-parity, keyboard-config drift and catalog tests, PageBubbleMenus, RefsAndBlocksGroup); `npm run typecheck`; `e2e/table-handles.spec.ts` (block and page mode, a touch phone case) and the existing table specs (`table-ops-toolbar`, `page-mode-bubbles`, `slash-table-grid`, `table-editor-styling`, `table-cell-link-backlink`, `toolbar-controls`, `html-paste-1439`). Each new test was shown red by a mutation of the code it covers.
