# Session 3098 — Enter in Edit as Markdown keeps the block's level

**The decision.** After G3 (#6192), Enter in an indented plain paragraph of the Document buffer started a top-level block, because the moved text lost its leading blanks. The maintainer decided Enter makes a sibling at the same level, as page mode's Enter does (comment 6506141629 on #5691).

**Changed:**
- **`siblingHead`** (`source-buffer-blocks.ts`) gives the head the writer would write a sibling of the block at the cursor with. It builds that from the writer's own pieces, so there is no second placement rule.
  - The head is the block's indentation, plus `+ ` when its parent is a list block.
  - It also carries the block's own list marker, numbered on. Page mode's Enter carries the list style too (`PageListKeys`, `setStyle(made, shownStyleOf(id))`), and a task's sibling is plain in both modes.
- **`splitLine` puts that head in front of the moved text.** It adds a blank line only where the writer would. `listMarkerOf`, extracted from `writeBlocks`, is shared by both.
- **Enter with the caret before an indented line's text** keeps the text's indentation, where it used to move the block to depth 0. The reviewer found this in the same defect class.
- **The 8308809f6 blank line** above a list that follows is kept.

**A test re-premised.** "At the end of a list item's further line leaves a blank line" pinned the old top-level paragraph. A numbered item's further line now continues `2. x`. The blank-line check moved to a task's further line, where the new line is still a bare paragraph.

**Left as is:**
- `* a`'s further line gives a `- ` sibling, because the writer writes bullets as `-`. Its first line still continues `* `.
- Enter at column 0 of an indented line leaves the caret before the indent.
- Enter in the middle of a heading gives a plain paragraph for the moved text, while page mode makes two headings. This predates the change.

**Red first:**
- **The sibling head removed:** 8 tests read the new block at depth 0, not 1.
- **The blank-line rule inverted:** 17 tests fail.
- **The indentation kept before the text removed:** both of its tests fail.
- **`separateFromList` dropped:** the task further-line test fails.
- **The e2e case, against the indent mutation:** it reads `Sibling note` where `  Sibling note` was expected.

**Suites:**
- vitest over `src/editor`, `src/components/pages` and `src/stores` (6,047 tests);
- typecheck and lint;
- Playwright: page-source-edit, page-source-ulid-tokens and page-mode-markdown-switch (31 tests).
