# Session 2016 — e2e: the console-error gate runs for every spec

Found while chasing a flake on #5511: `properties-table-and-refusals.spec.ts` failed `expectLoggedThenClear` whenever it was not the first spec file a Playwright worker loaded, and passed on retry. `e2e/helpers.ts` registered its console-error watcher and its no-errors assertion with module-level `test.beforeEach` / `test.afterEach`; a worker loads that module once, so the hooks attached only to the first file and every later file in the worker ran ungated. Reproduced on `main` by running `paste-task-over-content-1514` and the properties spec in one worker.

What shipped: the watcher and the teardown assertion are an auto fixture, `consoleErrorGate`, on the exported `test`, so they run for every test in every file. The module-level mock reset is gone rather than moved: each test gets a fresh page, so it always ran on `about:blank` and did nothing; `__resetTauriMock__` went with it. Fourteen specs that imported `test` straight from `@playwright/test`, and so were never gated, now import it from `./helpers`; `palette-desktop` drops its hand-rolled copy of the gate.

Neither full-suite run surfaced a console error the gate had been missing. Failures that reproduce on `main` in this sandbox and are unrelated: the pdf.js specs (the sandbox's Chromium 141 predates pdf.js 6.x's `getOrInsertComputed`, and the shared `node_modules` was behind the lockfile) and a mobile line-break count.

Ran: the repro red then green, the whole Playwright suite twice (once in five shards), each moved spec on its own, the mock's vitest suites, `npm run typecheck`, oxlint and oxfmt.
