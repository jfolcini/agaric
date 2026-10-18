# Session 2533 — review notes from the real-lane sweep (#5816, #5819, #5824, #5828)

The sweep's non-blocking review notes, collected in one PR.

**Done (#5816):**
- `reopen(title, task)` was copied in `agenda-projected-repeat.e2e.ts` and
  `slash-repeat-remove.e2e.ts`. It is now `reopenPageHolding(title, marker)`
  in `e2e-tauri/helpers.ts`.
- The first `agenda-projected-repeat` spec's own copy (`reopenTheNewPage`
  and `TASK_ROW`, which reopened "Untitled") now opens a titled page and
  uses the shared helper.
- `slash-repeat-remove.e2e.ts` had its own `openNewPageTitled`; it now calls
  the shared `openNewPage(title)`.

**Kept, with reasons:**
- **#5816, the `localDay` wrapper.** The suggested destructuring of
  `localDays` gives `string | undefined` and needs the same guard that the
  wrapper already holds.
- **#5819, "the session log names no PR for the two bugs".** A merged log
  is immutable. The fixes' own logs cite them: 2514 for the tag chip, 2523
  for the integrity check.
- **#5824, "raise `CREATED_PAGES` if the stamp guard ever flakes".** That is
  advice for a flake that has not happened. Nothing to change.
- **#5828, "the backend's `query-view` clause is dead".** It is not.
  `list_by_type` and `count_blocks_by_type` exclude `view_type =
  'query-view'` blocks, which keeps the views saved under the old code
  hidden from content-block lists and counts. Those are parentless content
  blocks. Deleting the clause would surface them.

**Ran:**
- `agenda-projected-repeat.e2e.ts` (4 passing) and
  `slash-repeat-remove.e2e.ts` (2 passing) on the real binary;
- `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, oxlint and
  oxfmt.
