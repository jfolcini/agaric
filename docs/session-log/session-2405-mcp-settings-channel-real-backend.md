# Session 2405 — The Settings MCP switch, the activity feed and Revert session, on the real backend

#5740's three Agent access items, part of the #5726 sweep. They share one
app boot in `e2e-tauri/mcp-settings-channel.e2e.ts`.

**Setup.** A `before` turns read-write MCP on through the Settings switch
and waits for the socket at the path the tab shows. Each `it` then opens
its own MCP connection, so each is its own feed session.

**The three cases:**
- **The switch.** An `append_block` lands on the page open in the UI. The
  switch and the exact feed row survive leaving Settings, and the block
  survives a page round-trip.
- **The feed.** A freshly mounted feed lists the write by tool and id
  prefix, and no row carries the written text.
- **Revert session.** It removes both agent blocks and keeps the user's.
  History's Revert selected on the revert's two `delete_block` rows brings
  them back.

**Premise corrected.**
- The issue says the revert is "itself undoable". It is, but not through
  Ctrl+Z.
  - The revert's reverse ops are written as undo ops (`is_undo = 1`), and
    page-level undo enumerates only `is_undo = 0`.
  - The feed's success toast has no Undo action.
- The only UI path is History's Revert selected.
  `docs/features/agent-access.md` now says so.

**Shown red on the real binary:**
- the Settings toggle not starting the read-write listener (fails in
  `before`);
- the summary leaking the content;
- `revert_ops_inner` reverting nothing;
- History's Revert selected sending no ops (the undo-the-revert half).

**Helpers.** `McpClient` (from `mcp-write-burst-responsive.e2e.ts`) and
`openEditHistory` (from `history-redo-revert-restore.e2e.ts`) moved into
`e2e-tauri/helpers.ts`, since two specs now use each.

**Ran:** on a binary rebuilt from main after #5728, the new spec, both
donor specs and `trash-page-cascade.e2e.ts`. Also
`npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, oxlint and
oxfmt.
