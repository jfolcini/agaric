# Session 2950 — a new page's first block closed the menu opened over it

`e2e/history-revert.spec.ts`, "reverting a delete onto a taken title says so and restores nothing", failed on #6136, a PR that changed only page-tasks tests. The click on the Page actions menu's "Delete page" item timed out: the item was detached from the DOM partway through the click. The failure's snapshot shows the new page's block editor focused, `New page created` announced, and no menu open. The maintainer asked for every flake to be fixed rather than re-run.

**Cause:** creating a page seeds a first block and focuses it for typing. That focus goes through the roving editor (`src/editor/use-roving-editor.ts`), which lands a frame or more after the seed `create_block` answers. On the mock, the title showed first, and the editor took focus 70–106 ms later. `createPageFromPagesView` returned as soon as the title showed, so the spec could open Page actions before the focus landed. On desktop, Page actions is a non-modal Radix `Popover`, and focus moving outside it dismisses it.

**Fix:** `createPageFromPagesView` returns only once the first block is focused. The late focus is what the app means to do, and no user beats a 0.1 s window between creating a page and opening its menu, so the helper waits instead of the product changing. Every one of the helper's eleven calling specs creates a page that seeds that block, so the wait holds for all of them. On a phone the seed block takes focus the same way: an iPhone 13 probe confirmed it.

**Shown red:** a throwaway probe held the seed `create_block` until the Page actions menu opened. With the old helper the late focus closed the menu, and the click on "Delete page" timed out, matching CI's snapshot. With the fixed helper the same probe passed. Run unchanged, the spec passed thirty times in thirty locally both before and after the fix, so only the held reply shows the race.

**Suites:**
- the eleven specs that call `createPageFromPagesView` (96 of 96);
- `history-revert.spec.ts` with `--repeat-each=30`;
- `npm run typecheck` and `npm run lint`.
