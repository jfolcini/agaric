# Session 2475 — a date chip opens and writes its own block's date

The #5736 e2e sweep found that a block's due and scheduled chips acted on
the wrong block. Both chips opened the date picker through the focus-keyed
command bus, and the picker wrote the pick to the focused block. A chip
click keeps focus where it was, which caused two failures:
- **With no block being edited,** a click on a chip opened nothing.
- **While another block was being edited,** the picked date landed on the
  edited block.

**Changed:**
- **The chip calls `onOpenDatePicker(blockId, mode)`.** It is a new
  `BlockActions` entry, threaded through `SortableBlock` the way
  `onShowProperties` is.
- **`useBlockDatePicker` remembers the chip's block** for the pick. Its open
  setter forgets that block on every open and close, so the toolbar, the
  slash commands and the date shortcut still act on the focused block.
- **Deleted:**
  - The two `toolbar-controls.spec.ts` tests skipped under #1170, which the
    new spec covers. Their stated cause, the editor blurring before the
    click, was wrong; the bus was the cause.
  - The `dispatchBlockCommand` import the chips no longer use, and two test
    shims that re-dispatched bus commands nothing listened for.

**Spec:** `e2e/date-chip-target.spec.ts`, which covers the due and the
scheduled chip.
- With no block being edited, the chip opens the picker, and the picked date
  is on the chip's block after a reopen.
- While another block is being edited, the date lands on the chip's block
  and the edited block gets no date row.

**Shown red:**
- **All four tests,** against the unfixed code.
- **All four,** with the date IPCs dropped and the optimistic update kept:
  the reopen catches it.
- **The two edited-block tests,** when the pick also writes the focused
  block.
- **The hook tests,** with the pick writing the focused block, and with the
  close not forgetting the chip's block.
- **The component tests,** with the scheduled chip opening in due mode.

**Review** also probed the weekly view, where a chip on one day's tree is
clicked while a block on another day is being edited. The chip's own tree
took the date.

**Ran:**
- the new spec with `--repeat-each=3`;
- the date, toolbar, due-panel and property-badge specs;
- vitest on `src/components/editor` and `src/components/block-tree`;
- `npm run typecheck`, oxlint and oxfmt.
