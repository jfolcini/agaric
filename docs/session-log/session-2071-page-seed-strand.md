# Session 2071 — Page editor "Add block" no longer strands a fresh page's empty block

The page-editor twin of session 2066. A fresh page holds one empty block (BlockTree's
`autoCreateFirstBlock`). Once the caret had left it, `PageEditor.handleAddBlock` always
called `createBelow`, stranding the seed above the new block: the blur cleanup kept it as
the page's only block and never revisits it. `unfocusedBlankTail` moved from
`useJournalBlockCreation.ts` to `src/stores/empty-block-cleanup.ts`, next to the cleanup's
own guards, and takes the flat tree as an argument; both "Add block" paths call it and
focus the blank tail instead of creating another block.

Specs: `e2e/page-add-block-reuses-empty.spec.ts` (red on the old code on the editor's
`data-block-id`), two PageEditor tests (reuse; focused blank tail still creates). The
existing text-tail test covers the third case. Each clause was shown red on a copy: the
reuse branch, the focus clause and the blank-content clause. Suites run: PageEditor,
useJournalBlockCreation and empty-block-cleanup vitest files; every Playwright spec that
clicks the page editor's "Add block"; `npm run typecheck`; oxlint and oxfmt.
