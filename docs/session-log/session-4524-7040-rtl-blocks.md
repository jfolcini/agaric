# Session 4524 — a right-to-left block mirrors, and its arrows walk its markers

Part of the #7040 UI review, coverage item C3: the block's own direction and the arrows across revealed markers, after #7144 (maintainer decisions 33 and 38).

**What shipped**

- **A block's content takes its direction from its first strong letter.** `dir="auto"` sits on the content root of the static render, an embedded block's row, the block's editor and each page-mode block's text.
- **Block content mirrors through logical properties.** In an Arabic or Hebrew block, list markers, quote and callout bars, chips' icons and a table's column order, borders and corners sit on the right. Code stays left to right, and the task checkbox, chips' order and gutter stay outside the text.
- **A table's handles** read the table's computed direction: the row handle and Add column sit at its start and end, and `Alt+Shift+←/→` moves a column the way the arrow points.
- **The arrows across revealed Markdown markers** walk right-to-left text the way they point, in block and page mode. Page mode's editor runs left to right, so the reveal steps through right-to-left text itself, one whole character at a time, so an emoji is never split.
- A callout's revealed marker and the app's own words around the text carry their own `dir`, so they never decide the block's direction (decision 38).
- `docs/UX.md`, `docs/features/appearance.md`, `editor.md` and FEATURE-MAP say what mirrors and what stays left to right.

**Left as they are**

- The static table scrolls in a plain `overflow-x-auto` box: Radix's `ScrollArea` root forces left to right and cannot take `dir="auto"`. The editor's own table wrapper is a plain scroller too.
- At rest the static render runs a block's paragraphs on one line, so an Arabic and an English paragraph in one block share its direction there; while edited, each sits on its side. This predates the change.
- English blocks are unchanged by construction: with the direction left to right, the arrows take the old paths.

**Tests**

- **e2e (mock lane):** `rtl-text` gains the mirrored block, list, quote, callout and table with code left to right; an English block unchanged; an embedded block's direction; an Arabic table's handles and column move; a click beside a closing marker in Hebrew; the arrows across bold, links and chips in block and page mode; and an emoji beside a marker stepped whole. Each was red on the old code.
- `text-direction.test`, `StaticBlock.test` and `RichContentRenderer.test` pin the direction and the logical classes.
- A separate session reviewed it, merged `main`, and fixed the split emoji and the embedded row's missing direction.
