# Session 2580 — review notes from #5865 and #5837

**#5865 (Playwright's web server without `tsc`):** the server built with a
bare `vite build`, which resolves only when the caller put
`node_modules/.bin` on `PATH`. Run as `node_modules/.bin/playwright test`,
or from the VS Code Playwright extension, it failed with
`vite: not found` (webServer exit 127). It now runs `npx vite build`; no
npm script fits, because `build:e2e` also runs `tsc -b`. Shown with a
`PATH` without `node_modules/.bin`: exit 127 before, 1 passed after.

#5865's session log (`session-2569`) says the rerun triggers are
`src/__tests__/mocks/**`; the config names only `mocks/sonner.ts` and
`mocks/ui-select.tsx`, the two the setup file loads. That log is
immutable, so the correction is here; #5865's PR body is corrected too.

**#5837 (page mode over its cap):** `usePageMode` kept a blocker page
mode had found in `found` until `checkFit`, the switch's pointer-enter
and focus handler, cleared it. The only blocker is `overCap`, computed
from `truncatedTotal ?? blocks.length`, and both places page mode
reports one read that count from the page store itself, after a
`load()`. So the rows always held the same blocker, and `found` only
differed once they had dropped back under the cap: a stale "blocked".
`found`, `checkFit` and the switch's `onIntent` are deleted; the rows
are the one source. A page blocked while open now returns to page mode
as soon as it fits again, as a page blocked at open already did.
`onBlocked` keeps both toasts, and saves then reloads only when page
mode was open. The merged `PageEditor` test is red without the reload
and without the switched-to-blocks toast.

**Seen, not chased:** `e2e/page-mode.spec.ts` query-and-embed test failed
an axe `color-contrast` check once in a combined run, then passed 4 of 4
with `--repeat-each=4`. It goes to the flaky-test sweep.
