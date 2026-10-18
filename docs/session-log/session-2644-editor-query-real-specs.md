# Session 2644 — real-backend specs for page mode's slash menu, the Enter split-off commit, and the backlinks query

Three #5887 items, each a second case in the real-lane spec of its area.

- **Page mode's slash menu (#5866)**, `page-mode-tasks.e2e.ts`: a block added
  in page mode gets `/todo` and `/due` today; after leaving and coming back,
  the checkbox reads TODO, the due chip shows, `get_block` holds both, and the
  Agenda lists the task.
- **Enter split-off commits on one leave (#5834, #5851, 8431489)**,
  `block-line-break-persist.e2e.ts`: a block stored as intro, a
  `- [ ] <task> #<tag>` line and a `status:: done` line is split at the second
  line with Enter and left once; exactly one block holds the task, with its
  tag and property chips, and the tag's page lists it. The issue's `TODO call
  mom #errands` typed live is not this path: `TODO ` is plain text, `[ ] `
  sets the state as it is typed, and a `#name` becomes a chip on space, so the
  spec stores the text through `edit_block` as Edit as Markdown or an import
  would.
- **Backlinks query (#5815)**, `advanced-query-group-by.e2e.ts`:
  `{{query type:backlinks target:A}}` on page C lists only B's linking block,
  never A's child, before and after a round trip.

Each `before` hook now waits for the app, so no case depends on the first one
booting it.

Shown red in one rebuild: the slash command run on the first block instead of
the caret's, `readSplitOffAsTyped` returning early, and the #5815 fix reverted
(`LinksTo` back to `ChildOf`) each failed at its predicted assertion.

Ran: `just e2e-real` for each spec (55 s, 38 s, 61 s), `tsc -p
tsconfig.wdio.json`, `oxlint e2e-tauri`, `vitest run e2e-tauri` (46),
`node --test scripts/e2e-related.test.mjs` (10).
