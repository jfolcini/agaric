# Session 4452 — #6926's last two gaps

These are the two gaps the 2026-11-19 status comment left open on #6926. Closing them finishes the issue.

**`spaces.e2e.ts`, deleted with no port.** Its last test, "deletes an empty space after confirming, and refuses one that holds a page", is already a bridge test: `e2e/spaces-management.spec.ts` › "delete is blocked for a space holding pages and for the sole space, and deletes an empty one", which is on `REAL_BACKEND_SPECS`.
- Personal holds the seeded pages, so its Delete is disabled. The empty Work space is deleted after the confirm, and the rows are re-read after navigating to the Journal and back.
- The "2-space rework" the plan asked for was already done: both the mock seed and the real vault have Personal and Work.
- Shown red on the bridge:
  - An emptiness probe that calls every space empty fails at `toBeDisabled()`.
  - Removing the `deleteBlock` call fails at `toHaveCount(1)`.
- The WDIO file's helpers that lost their only caller are deleted from `e2e-tauri/helpers.ts`: `switchToSpace`, `openSpacesSettings`, `spaceRows`, `waitForSpaceRows`, `createSpace` and their selectors. knip does not scan `e2e-tauri/`, so nothing would have flagged them.
- The one WDIO assertion that goes: the space switcher no longer offering the deleted space. The re-read Settings rows cover what is stored.

**`settings-tasks-reminders`, on the bridge.**
- The spec no longer installs `page.clock`, which moved only the browser while the backend's `query_by_property` answered by the real date. It seeds its two tasks with `seedSearchBlocks`, which dates `due` from the real today.
- It is added to `REAL_BACKEND_SPECS`. Neither test drives a mock hook, so none is `@mock-only`.
- The Due panel computes its window in the browser, and the backend only filters by the dates it is given. So the two clocks cannot disagree. Midnight passing between the seed and an assertion is the same small risk the other date-seeded bridge specs take.
- Shown red on the bridge:
  - A window fixed at 7 days fails the window test: four rows instead of two.
  - Dropping the clamp fails the limit test with `Received: 200`.

**Ran:**
- `settings-tasks-reminders` with `--repeat-each=3`: 6 of 6 on the bridge, and 6 of 6 on the mock lane, run before the file was listed.
- `spaces-management` on the bridge: 11 of 11.
- `npm run typecheck:e2e`, `npm run typecheck:e2e-tauri`, oxlint, oxfmt, `node --test scripts/e2e-related.test.mjs` and `npx vitest run e2e-tauri`.
