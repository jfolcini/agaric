# Session 2659 — on a phone a task row is 54 px, the list ends at its last block, and an empty day is one line

#5928, measured at 390 × 844 with touch.

- **Chip tap areas without layout height:** `PriorityBadge` used the
  `touch-target` utility, which made its chips row 44 px tall. A new
  `touch-hit-area` utility (`src/index.css`) puts an invisible 44 × 44 area
  behind a chip on coarse pointers instead; the priority, due, scheduled and
  attachment chips use it, and the priority badge drops its extra padding to
  the date chips' 18 px.
- **Grouping:** on touch a task's text box kept its 44 px minimum with the text
  at the top, which pushed the chips 20 px below their own title and 6 px
  above the next one. In a row with chips, the text box now drops its bottom
  padding and its touch minimum, and the chips row gets 6 px below it: 4 px
  from its title, 12 px to the next. Plain blocks are unchanged at 44 px.
  Page mode's reservation for a chips row that has not loaded yet follows the
  new badge height at every width.
- **End-of-list drop zone:** its 60 px renders only while a drag is active;
  dnd-kit re-measures droppables just after a drag starts, so a drop below
  the last block still lands there.
- **Empty day:** in Week and Stream an empty day is its date heading with a
  trailing "+" (Add block); the "No blocks for {date}." sentence stays for
  screen readers. Day view keeps its `EmptyState`, being a single list.

Results: task row 90 → 54 px, last block to *Add block* 64 → 4 px, empty
Week day 148 → 44 px. Found, not fixed: the block rows' `m-0` overrides
`--block-row-gap` in every block list, so that gap is 0 everywhere.

Tests: vitest for the drop zone (absent at rest, present mid-drag) and the
empty-day row; `e2e/phone-block-lists.spec.ts` for row height, chip hit areas
20 px off-centre, chips nearer their own title than the next, empty-day height,
and a drag to the end that lands last after a round trip. Each was red with
its fix reverted.

Ran: 27 affected Playwright specs including `page-mode` (193), vitest over the
journal, block-tree and editor folders (6439), `npm run typecheck`,
`oxlint src e2e`.
