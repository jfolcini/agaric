# Session 3099 — Review notes from #6183, #6185, #6192 and #6193

The non-blocking notes from that sweep, batched in one PR.

**Fixed:**
- **Property value picker (#6183):** the trigger carried `block`, which overrode the trigger's `flex` and wrapped the chevron onto a line of its own under the box. The trigger drops it; `w-full` was already in `SelectTrigger`'s base classes. An e2e case checks the chevron's bottom is inside the trigger at 1280 and 768 px.
- **Page-mode redo of `/bullet-list` on a heading (#6185):** this predates #6185. On a heading, the command changes the text inside the editor's history but writes the style outside it. An undo now records the style it took off under the editor's redo depth (`leaveByUndo`), and the redo of that undo gives it back. Once a new change clears ProseMirror's redo history, the records are dropped (`forgetUndone`), so a later redo of another change brings back no stale bullet. Both guards are pinned.
- **Edit as Markdown Delete (G3):** a delete left two blank lines between plain neighbours. It now goes through `rewrite`, so the gap is what the writer writes, and deleting the first block leaves no leading blank line.
- **Enter at the start of a line's text (#6193):** the caret now lands after the moved line's indentation, its marker and a heading's `#` run, where page mode leaves it. Typing there no longer un-nests the block.
- **Enter in the middle of a heading (#6193):** it now gives two headings at the same level, as page mode's `splitPageBlock` does. At the end of a heading the new block is still a paragraph.
- **The `pageSource.hint` copy:** now reads "Deleting a block's lines deletes it".

**Dropped:**
- **The Data Import card at 1024 px:** an accepted trade-off.
- **`* a` continuing as `- `:** both are bullets, so nothing fails.
- **A heading inside a list item (`- # foo`):** splitting it gives a plain bullet, because the list branch comes first. Page mode does not make list-styled headings.

**A process slip:** one chained falsification copied a mutated `source-buffer-blocks.ts` over its own backup. The builder restored the line by hand, and the reviewer read every hunk of the commit and found no residual mutation.

**Red first:** each fix has a test shown red against the code it covers, through one command that backs up, traps a restore, mutates, checks `! cmp -s`, and runs. That covers the chevron geometry, the redo record and its clearing, the delete gap, the caret column and the heading split.

**Suites:**
- vitest over `src/editor`, `src/components/pages`, `src/components/properties` and `src/stores` (6,314 tests);
- typecheck, lint and oxfmt;
- Playwright: page-source-edit, agenda-filter-builder, mobile-overflow, list-style-keyboard, undo-redo-blocks, kind-change-undo, page-mode and page-mode-markdown-switch.
