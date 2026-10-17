# Session 2390 — Page mode: one WYSIWYG document per page, saved per block

#5691, built to the design the maintainer approved on 2026-10-17. Page mode is a per-device setting (Settings › Editor › *Edit pages as*, default Blocks). The page header has a Blocks | Page switch and `Ctrl+Shift+M`. It is hidden on touch.

**Model.** The page is one flat document of `pageBlock(blockId, depth)` nodes over block mode's own extensions (`contentExtensions`, factored out of `use-roving-editor.ts`). The id rules are the source buffer's, moved to `src/editor/token-ids.ts` and shared by both:
- the id stays with the text where its block starts;
- a paste brings new ids, unless it is a cut and paste within the page, which is a move;
- duplicates are dropped.

**Save.** It runs on idle (700 ms), on blur, on a mode switch, on leaving the page, when the app is hidden and before export. Only the blocks that changed since their last save are written, through the existing commands, in the order creates, moves, edits, deletes. A block's saved state advances only when its write succeeds. A refused write re-reads the page and saves once more. Three premises of the design were wrong:
- `create_blocks_batch` takes no client ids;
- `move_blocks_batch` moves one contiguous run;
- `restore_block` also restores deleted ancestors, so the save re-reads the tree.

**Remote changes** are patched in by id, outside undo: text, creates, moves and deletes. A block with unsaved local text keeps it, and one deleted elsewhere while edited here keeps its text as a new block, with a notice.

**What keeps a page in block mode** (`page-mode-fit.ts`): tasks, priorities, dates, properties, attachments, queries, embeds, or more than 500 blocks. The switch says why, and #5743 tracks lifting each one. #5743 also holds block mode's blur conversions that page mode lacks: a typed `#name`, `key:: value` line or `TODO` marker.

**Review** found and fixed six defects, each pinned by a test shown red:
- a peer moving a child out of a block it deleted was read as a local move and reverted by the next save;
- several colliding ids were repaired one per save;
- a blocker once found kept the switch disabled after it was gone;
- page mode ignored the "Tab indents blocks" opt-out;
- the switch's selected item was never highlighted;
- the rebase had moved `MarkdownReveal` in block mode's extension order.

The review also deleted a custom incremental code highlighter. It was built for a 1,000-block cap that was measured only on Chromium, and the cap is back at 500 until #5743 measures WebKitGTK.

**Measured** with `AGARIC_PERF=1 npx playwright test e2e/perf.spec.ts -g 'page mode'`: Chromium against the mock, medians of 3 with their bands. At 500 blocks, typing INP and long frames sit inside block mode's noise on the same page, unthrottled and at `AGARIC_PERF_CPU=4`.

**Mutation testing** (`node scripts/run-mutation.mjs`): `page-save` 84.5%, `page-block-ids` 76.5%, `token-ids` 89.7%, with the survivors triaged.

Gates:
- vitest over the whole tree: 21,730 passed;
- typecheck, lint, knip, the bundle budget and `typecheck:e2e-tauri`;
- Playwright with the setting on Blocks and on Page.

The four `e2e-tauri` page-mode specs (restart, sync peer, `((ref))`, deleted elsewhere) run in CI only.
