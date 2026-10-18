# Session 2569 — frontend dev loop: related-test selection and a Playwright port per worktree

**Gap (#5848, four items):** the related-test run before a push missed
changes CI would catch, Playwright's port was fixed so a second worktree
tested the first one's bundle, and CI's `webServer` type-checked a second
time.

**Related-test selection (`scripts/test-related-ts.sh`):** `*.mjs` joins the
pathspec, since tests import the `scripts/*.mjs` guards. A changed
`conformance/` file adds the tests that read it through `fs`; a changed
`src/lib/bindings.ts` (still kept out of the file list, because every IPC
wrapper imports it) adds the tests that read it the same way. The readers
are found by content (a test file naming the path and calling
`readFileSync` or `readdirSync`), so a new reader needs no edit here. The
issue named `src/lib/tauri-mock/conformance/` and `tauri-mock.test.ts`; the
fixtures live in the root `conformance/`, `tauri-mock.test.ts` reads neither
through `fs`, and the readers are spread over `src/lib`, `src/editor` and
`src/lib/search-query`, which is why the set is derived rather than listed.
`--dry` now lists the added test files; it still prints changed files, not
the tests vitest's graph walk adds.

**`forceRerunTriggers` (`vitest.config.ts`):** `vitest related`, `--changed`
and watch all honour it (`filterTestsBySource` returns every spec when a
related file matches), so the script benefits, not only watch mode. vitest
5.0.3 already appends `setupFiles` to the list, so `src/test-setup.ts`
already selected the whole suite; the issue's claim was false for that file.
The real holes were what `test-setup.ts` loads without an import edge: the
`sonner` and `ui-select` mocks (0 and 1 tests selected) and
`helpers/invoke.ts`, the strict global `invoke` (153 of 927). The triggers
are `src/__tests__/mocks/**` and `helpers/invoke.ts`, on top of
`configDefaults.forceRerunTriggers`. The other helpers are imported by the
tests that use them, so the graph is right and a glob over `helpers/**`
would only turn a one-test change into a full run.

**`PW_PORT` (`playwright.config.ts`):** `baseURL`, the `storageState`
origin and the `webServer` url and port read it, default 5173. The command
passes it as a second `--port` after `preview:e2e`'s own; vite's CLI takes
the last one (checked: only the last port listens).

**`webServer` command:** `VITE_E2E=1 vite build && npm run preview:e2e`,
without `tsc -b`. Nothing loses a check: the lint job's prek `tsc` hook runs
`npm run typecheck` (`tsc -b --noEmit`, `tsconfig.e2e.json` included)
whenever the diff has a frontend path, and the playwright job runs only when
it does too (`scripts/classify-changes.sh`: `playwright` is `frontend`).
Locally a type error in a spec now surfaces at commit or in `npm run
typecheck`, not as a failed server start. `build:e2e` keeps its `tsc -b`.

**Left out of #5848:** per-worktree `tsBuildInfoFile`, `incremental`,
`fsModuleCache`/pool measurements, the fourth Playwright shard, and the
`--changed` documentation decision.

**Ran:** `npm run typecheck`, `typecheck:e2e`, `lint`, prek on the four
changed files, the script on a fixture-plus-bindings range (16 files, 2622
tests passed), `e2e/closed-task-contrast.spec.ts` with `PW_PORT=5557`.
