# Session 4522 — a folded section unfolds for a move, and travels with a selection

Part of the #7040 UI review, item S5b's follow-up (maintainer decision 30) and the #7137 review notes.

**What shipped**

- **A block moved or dropped into a folded section unfolds it (decision 30a), as Enter does.** `unfoldedBy` (`src/lib/section-fold.ts`) unfolds each folded heading whose fold, after the move, holds a row that was shown before. Block folds never unfold, and rows the move carried in hidden stay hidden.
  - Block mode: BlockTree's `landing` wrapper runs it after `Ctrl+Shift+↑/↓`, the menu's moves, indent and outdent, and every drag.
  - Page mode: the move's own transaction carries the unfold, so it is saved like a chevron click and undone with the move.
- **A selection that includes a folded heading takes its hidden section (decision 30b).**
  - Block mode: batch delete, copy and cut (against each page's saved folds), and the bulk menu's moves, indent and outdent.
  - Page mode: the block menu's delete, indent and outdent.
  - A select-all bulk move or indent moves a carried row once, not twice.
- **The #7137 review notes.**
  - A failed move no longer announces "moved": the store's `moveBlocks` resolves true or false.
  - `foldsOver` takes the target's id and stops there, in one pass, for every caller.
  - A drop after the last shown sibling counts the hidden ones.

**For the maintainer, as built** (asked separately):

- Tab on one folded heading carries its section.
- Indent and outdent count as moves for the unfold.
- Page mode's native text copy, cut and Delete stay text editing.
- Copy and cut read the saved fold state.
- The delete toast counts the carried blocks.

**Left as they are**

Backspace on a blank block moves its children under the row above. If that row is a folded heading, they go into its fold and stay hidden until it unfolds; block folds already behave this way, and Undo brings them back.

**Tests**

- e2e (mock lane): `heading-folds` gains a block moved, dropped, absorbed into a section and indented into one, each unfolding it. Red on the old code: the block hid once focus left.
- e2e (bridge, on `REAL_BACKEND_SPECS`): new `heading-folds-selection`. Batch delete, cut and the bulk indent each take the section, checked against the stored order. Red on the old code.
- vitest: `unfoldedBy`, `withFoldedSections`, the page-mode move, drop, indent and delete, the multi-select delete, `foldedIndent`, and the failed-move announcement.
- Falsified one mutation at a time, thirteen by the builder and again by the reviewer.
- A separate session reviewed it and moved two comments back beside their code.
