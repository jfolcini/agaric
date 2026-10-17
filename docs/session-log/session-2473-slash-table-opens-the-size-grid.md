# Session 2473 — `/table` opens the size grid at the caret

This was the maintainer's call on #5734. `/table` used to insert a fixed 3×3
table, and a size needed the typed suffix `/table4x6`, which only the menu
label advertised. `/table` now opens the toolbar's size grid, so there is one
way to pick a size and it can be seen.

**Changed:**
- **`BlockTablePicker`** hosts the existing `TablePicker` grid in a Radix
  Popover anchored at the caret.
  - It carries `data-editor-portal`, so the roving editor stays mounted for
    the insert.
  - The grid opens on 3×3, so `/table`, Enter, Enter still gives today's
    table.
  - Arrows resize, Enter inserts, and Escape closes and puts the caret back.
  - A click elsewhere keeps focus where it landed.
- **Open state** follows the template picker's pattern: `tablePickerOpen` in
  `useBlockSlashCommands` and `openTablePicker` on the context.
- **`TablePicker`** gains `initialRows` / `initialCols`. They default to 0,
  so the toolbar's picker is unchanged. Its size label is now a polite live
  region, so a screen reader hears the arrows resize it.
- **Deleted:** the size suffix, its parsing and its menu row, plus the
  suffix spec and tests. The docs now say `/table` opens a size grid.

**Review found two problems, both fixed with tests:**
- **Focus jumped back into the block.** The close handler always refocused
  the editor, so a click on the page title while the grid was open sent
  focus back into the block.
- **The size label was silent.** The grid keeps focus while the arrows
  resize it, so nothing was announced.

**Specs:** `e2e/slash-table-grid.spec.ts`.
- `/table`, Enter, then ArrowRight and ArrowDown from 3×3 give a 4×4 table
  that survives a reopen.
- `/table`, Enter, Enter gives 3×3.
- Escape inserts nothing and leaves the text as it was.
- A click on the page title closes the grid and keeps focus there.

**Shown red:**
- **The first test,** against the old direct insert.
- **Three tests, with `data-editor-portal` dropped:** the editor unmounted.
- **The title test,** against the refocus-always handler.
- **The live-region test,** with `aria-live` removed.

**Ran:**
- the new spec and the slash, table and toolbar specs;
- the new spec with `--repeat-each=3`;
- vitest on the block tree, the toolbar and the slash catalog;
- `npm run typecheck`.
