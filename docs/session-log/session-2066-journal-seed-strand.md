# Session 2066 — Journal "Add block" no longer strands a fresh day's empty block

A fresh journal day holds one empty block (BlockTree's `autoCreateFirstBlock`).
Once the caret had left it, "Add block" created a second empty block, and
nothing removed the first: the blur cleanup (`empty-block-cleanup.ts`) only
looks at the block focus leaves, and kept this one at the time because it was
the day's only block. `useJournalBlockCreation`'s existing-page branch now puts
the caret in the day's last block when that block is blank, childless,
metadata-free and not the focused one (`unfocusedBlankTail`), instead of
creating another. A focused blank tail still gets a new block; the cleanup
drops the old one when focus moves, and `journal-add-block-while-editing.spec.ts`
keeps covering that path.

The real-backend lane showed the strand on every virgin vault for a second
reason: its window had no focus, so the cleanup never ran there and
`openJournalBlockEditor`'s "Add block" click stranded the focused seed too.
#5543 gave the lane focus, so that cause is gone; this change leaves it.

Specs: `e2e/journal-add-block-reuses-empty.spec.ts` (red before the fix on the
editor's `data-block-id`: a new block took the caret), its real-backend twin
`e2e-tauri/journal-add-block-reuses-seed.e2e.ts` (typechecked only; the lane
cannot run locally), and three hook tests, each shown red with its clause
removed on a copy. Suites run: the hook, JournalPage, journal component and
cleanup vitest files; twelve Playwright specs that click "Add block";
`npm run typecheck`; `tsc -p tsconfig.wdio.json`; oxlint and oxfmt.
