# Session 4344 — page mode, part 2, on the bridge

Slice 8 of #6926: the rest of the page-mode specs move onto the headless bridge (#6529), and three WebdriverIO specs are ported or deleted. It goes after the #6935 fix (#6949): `page-mode-slash`'s `/callout-warning` test failed on the bridge without it (`> [!WARNING] buy milk  `, the same doubled space), and passed 65 of 65 over five repeats with it.

**Promoted to `REAL_BACKEND_SPECS`:** `page-mode-gutter`, `page-mode-input`, `page-mode-markdown-switch`, `page-mode-paste`, `page-mode-paste-html-list`, `page-mode-paste-names-6033`, `page-mode-slash`, `page-mode-text`, `page-mode-toolbar`. With the #6935 fix built in, all 48 of their tests passed on the bridge three times; none needed `@mock-only`.

**Ported into `page-mode.spec.ts`, then deleted from `e2e-tauri/`:**
- `page-mode-block-ref`: a `((ref))` to a block split at its start, typed into and indented in page mode still resolves to it, under its own id.
- `page-mode-derived-views`: a word typed in page mode is found by search and the word it replaced is not; a `[[link]]` typed in page mode lists its block under the linked page. Its undo-and-redo and paste tests are already on the bridge (`page-mode-durability`'s undo test and `page-mode-paste-names-6033`).
- `page-mode-attachments`: deleted as a duplicate. `page-mode.spec.ts`'s attachments test adds files through `add_attachment_with_bytes`, reads a dropped file's bytes back through its rendered body after a reopen, and lists the attachments, on the bridge since slice 7.

**One race the bridge showed, fixed in the new test:** after switching to Blocks, block mode puts its editor on the cursor's block a moment later, and the palette's Ctrl+K reached that editor; the test waits for the focus and leaves the editor first.

**Shown red on the bridge**, each at the predicted assertion: an `edit_block` that no longer reindexes the block's FTS row (the new word not found), `write_block_link_diff` inserting no links (no reference on the linked page), and ids mapped with left association in `idsAfter` (`token-ids.ts`), which leaves a split block's id on the empty half above (the target's id moved).

**Ran:**
- the nine files on the bridge with the #6935 fix built in, three repeats: 144 passed; the three new tests, eight repeats: 24 passed;
- the new tests on the mock, three repeats: 9 passed;
- `npm run typecheck`.
