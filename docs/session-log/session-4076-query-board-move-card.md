# Session 4076 — Query board, moving a card (#6542)

Slice 2 of plan #6542: a card moves between columns from a *Move to…* menu. The maintainer's three decisions of 2026-11-13 are a comment on the issue: a visible button on the card (so the column stops being a listbox), undo from the toast and from the page's own undo stack, and the card lands where the query's sort puts it.

## Decisions

- **The card is two buttons in a list item**: one opens the page, one opens the menu. Enter and Space are the buttons' own, so the column handles only the arrow keys, Home, End and the page keys, and `pressesFocusedControl` keeps a key pressed in the open menu out of them. Each column has two Tab stops, the cursor card and its move button.
- **The menu is the existing `Popover` + `PopoverMenuItem` pair**, as the journal's mode menu is. There is no dropdown-menu primitive in `src/components/ui/`, and this did not need one.
- **`BoardColumn` carries `propertyKey`**, so the write is decided by the column a card goes to and the view passes nothing extra. Task state: `set_todo_state`. Select: `set_property`, or `delete_property` for *No value*.
- **The page-stack half of undo needed nothing new.** The write's op refs go to `useUndoStore.onNewAction(pageId, refs, undefined, { merge: false })`; the entry waits there until the page is opened, where `Ctrl+Z` reverts it by ref. The toast's Undo runs `performPageUndo` while the move is still the page's latest entry, and otherwise reverts the move's own refs with `undo_ops` and re-anchors that page's stack, as any write outside a page's editor does.
- **Focus goes to the column the card left** at the pick, before the write: the card's buttons unmount when the columns refetch. Out of *Other values* it goes to the target column, because that column disappears with its last card.
- **Refresh is one `invalidateQueries(['advancedQuery'])`**: every column re-reads, since counts and summaries change in two of them.

## Traps

- A guard that stopped Radix handing focus back to the move button on close looked necessary in happy-dom. In Chromium, focus stayed on the column with the guard removed, so it was deleted.
- `QueryResultList` lost the `cards` layout and `ariaLabel` it gained in session 4063; the board no longer uses it, and the file is back to what it was before that session.
- The undo toast for a task-state op reads "Undone": there is no `undo.op.setTodoState` string.

## Shipped

One PR for #6542: `board-move.ts`, the card list and menu in `QueryBoard.tsx`, `propertyKey` on `BoardColumn`, three strings, `docs/FEATURE-MAP.md` and `docs/features/views.md`.

Existing assertions edited, all because a card stopped being a listbox option:

- `QueryBoard.test.tsx`: cards are found by `query-board-card`, not `role="option"`; the keyboard test tabs to the cursor card instead of focusing a `listbox`.
- `AdvancedQueryView.test.tsx`: the same lookup, twice.
- `board-columns.test.ts`: the select columns now carry `propertyKey: 'stage'`.
- `e2e/advanced-query-board.spec.ts`: the same lookup; the keyboard step focuses the cursor card instead of the listbox and no longer reads `aria-selected`.

## What ran

Full vitest, `npm run typecheck`, `npm run lint`, the manual prek stage, `check-set-property-args` and knip. Playwright on the mock: `advanced-query-board.spec.ts` (a move, the card in its new column after leaving the view and coming back, the toast's Undo, and `Ctrl+Z` on the card's page) and the specs `just e2e-related` selects.

Vitest falsifications, each one command that restored on exit, each red on the predicted assertion: no stack registration, no by-ref undo, the stack path skipped, *Other values* offered as a target, the menu guard removed, no focus handoff, *No value* losing its property key, no refetch.

Not run: the WebdriverIO lane (no `cargo-tauri` in the container). Nothing was checked on a real touch device; in Chromium's iPhone 13 emulation the move button measured 44 px square.
