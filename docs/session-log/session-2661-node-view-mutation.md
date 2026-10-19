# Session 2661 — page mode's node-view modules join the weekly mutation run, and two arrow and embed differences from block mode are fixed

#5915: `page-tasks`, `page-lists`, `page-rendered` and `page-attachments`
were deferred from the Stryker sweep because each mutant ran all of
`PageModeEditor.test.tsx`. Each now has a focused test file, and the four are
enrolled.

- **Focused tests** drive the node view through `FakeTasks`, an in-memory page
  store, and assert what the view draws; the rejection paths go through the
  tauri mock. They also close #5743's remaining rejection gaps: a refused list
  style, attachment open, read, width, alignment and caption, and a page embed
  whose read fails. Fixtures wait a fixed number of render turns instead of
  `waitFor`, so a broken mutant fails at once rather than holding the 8 s async
  timeout Stryker counts as a timeout.
- **Two survivors were not equivalent:** `renderedText` must trim the start, as
  block mode does, so a block written `  {{embed ((X))}}` draws as an embed;
  and the arrow search over rendered blocks no longer starts inside the current
  block, which made Down above a `---` rule jump past it into the query or
  embed below (Up likewise). Both are pinned.
- **Deleted, unreachable:** the `tasks`/`source === null` guards (both
  extensions are only configured with a source) and `pasteBlockId`'s fallback.
  Enter's branch for a refused split is reachable (Enter in a code block in a
  bullet) and gets a test.
- **#5912's note:** `commitPageTyped` moves from `page-tags.ts` to
  `page-commit.ts`, so `page-tags` no longer imports the task and property
  modules. `PageModeEditor.test.tsx` uses the shared node-view fixtures instead
  of its own copies.
- The `stryker.modules.mjs` and `stryker.config.mjs` headers, `docs/BUILD.md`
  and the weekly workflow's comments no longer say the sweep covers pure libs
  only.

Remaining survivors are recorded as equivalent in each test file's header.
Stryker after the review: page-tags 94.12, page-rendered 91.36, page-lists
88.60, page-tasks (the changed range) 97.83. Whether the weekly lane still fits
its 60-minute timeout is settled by the `lanes=mutants-frontend` dispatch #5915
calls for once this and #5933 merge.

Ran: `vitest run src/editor/page-mode` (346), `npm run typecheck`,
`npm run lint`, `node scripts/check-stryker-modules.mjs`, and the page-mode
Playwright specs.
