import path from 'node:path'

import { configDefaults, defineConfig } from 'vitest/config'

// Paths resolve from `import.meta.dirname`, not `__dirname`: Vite 8's native config
// loader warns on the CommonJS global, and CI keeps warnings on its console.

// `e2e-tauri/**/*.test.ts` is NOT the WebdriverIO suite — `wdio.conf.ts`
// runs `./e2e-tauri/**/*.e2e.ts` and never sees a `.test.ts`. It is the
// unit tests for the pure helpers `wdio.conf.ts` exports (#4428), which
// have to live outside `src/**`: `wdio.conf.ts` type-checks only under
// `tsconfig.wdio.json` (it needs `@wdio/globals/types`), so importing it
// from `src/**` would drag it into `tsconfig.app.json` where those
// ambient types do not exist. Without this entry those tests would be a
// file nothing runs, which is the same as no test at all. `coverage.include`
// below stays `src/**` on purpose: this code is CI-harness code and must
// not move the app's coverage gates in either direction.
const TEST_FILES = ['src/**/*.{test,spec}.{ts,tsx}', 'e2e-tauri/**/*.test.ts']

const VM_INCOMPATIBLE = [
  // JSZip `generateAsync({ type: 'blob' })`: "blob is not supported by this platform".
  'src/lib/__tests__/export-graph.test.ts',
  'src/lib/__tests__/bug-report-zip.test.ts',
  'src/components/dialogs/__tests__/BugReportDialog.test.tsx',
  // Assert `toBeInstanceOf(Error)` / `expect.any(Error)` on a throwing `vi.doMock` factory.
  'src/editor/__tests__/emoji-data.test.ts',
  'src/editor/__tests__/emoji-picker.test.ts',
  // App boot effects log after the last test; a vm worker has closed that file's rpc by
  // then, so under CI's `--silent=passed-only` the run fails with "Closing rpc while
  // "onUserConsoleLog" was pending".
  'src/__tests__/viewTransition.test.tsx',
]

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // `vmForks` gives each test file its own module graph and happy-dom window in a
    // fresh `vm` context inside a reused worker, where `forks` spawned a process
    // per file and re-imported node_modules every time.
    // A file that fails only under `vmForks` goes in `VM_INCOMPATIBLE` with its reason.
    projects: [
      {
        extends: true,
        test: {
          name: 'vm',
          pool: 'vmForks',
          include: TEST_FILES,
          exclude: [...configDefaults.exclude, ...VM_INCOMPATIBLE],
        },
      },
      { extends: true, test: { name: 'forks', pool: 'forks', include: VM_INCOMPATIBLE } },
    ],
    // A vm worker keeps every file's context alive until it is recycled at this
    // heap size. The default (total memory / workers) can sit above V8's own heap
    // limit, and then workers abort out of memory instead.
    // Root-level only: vitest ignores it inside `projects`.
    vmMemoryLimit: '1GB',
    // Pre-bundled because the vm loader resolves one of mermaid's own relative
    // imports wrongly ("Cannot find module .../khroma/dist/channels/utils/index.js"),
    // which fails every file that loads the real mermaid, even through `React.lazy`.
    deps: { optimizer: { client: { enabled: true, include: ['mermaid'] } } },
    setupFiles: ['./src/test-setup.ts'],
    // A change to one of these reruns every test (`vitest related`, `--changed`
    // and watch all honour the list). vitest already adds `setupFiles`, but its
    // module graph does not walk what `test-setup.ts` loads through
    // `vi.mock(..., () => import(...))` or a dynamic `import()`: the `sonner` and
    // `ui-select` mocks select nothing and `helpers/invoke.ts` (the strict
    // global `invoke`) selects a fraction of the tests it affects. The other
    // mocks and helpers are imported by the tests that use them, so the graph
    // is right and they stay out. The files under `conformance/` and
    // `bindings.ts` reach their tests through `fs`, which the graph cannot see
    // either, so `vitest --changed` reruns everything when they change.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/src/__tests__/mocks/sonner.ts',
      '**/src/__tests__/mocks/ui-select.tsx',
      '**/src/__tests__/helpers/invoke.ts',
      '**/conformance/**',
      '**/src/lib/bindings.ts',
    ],
    // Emit a warning when a single test exceeds 2 seconds.
    // Catches regressions cheaply without altering test outcomes.
    slowTestThreshold: 2000,
    // The default 5s per-test timeout can be tripped by the longer
    // `asyncUtilTimeout` (8s, set in `src/test-setup.ts`) when `axe()` audits
    // run under the pre-push CPU contention (vitest + cargo nextest in
    // parallel). Give the per-test and per-hook budgets head-room so a slow
    // (but ultimately passing) async assertion isn't cut off mid-wait. This
    // raises only the ceiling for slow paths; fast tests are unaffected.
    testTimeout: 20000,
    hookTimeout: 20000,
    // #3225 — pinned, not incidental. `'stack'` runs a suite's `afterEach`
    // hooks in REVERSE registration order, and a hook that throws aborts the
    // rest of the chain. `src/test-setup.ts` relies on that to keep its
    // strict-IPC assertion registered FIRST (so it runs LAST) and therefore
    // unable to pre-empt RTL `cleanup()`, the query-cache clear, or the Radix
    // description guard. Under `'list'` the same hook would run FIRST and its
    // throw would skip `cleanup()`, leaking the rendered tree into the next
    // test and turning one honest failure into a cascade. This is vitest's
    // default today; stating it means a future default change cannot silently
    // invert the ordering that guard depends on.
    sequence: { hooks: 'stack' },
    coverage: {
      provider: 'v8',
      // `json-summary` writes `coverage/coverage-summary.json` (aggregated
      // Totals), which `_validate.yml`'s coverage step
      // parses to render the step-summary table.
      reporter: ['text', 'json', 'json-summary', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        'src/main.tsx',
        'src/test-setup.ts',
      ],
      // OpenSSF Best Practices Silver tier coverage gates.
      //
      // #749: THIS BLOCK IS THE SINGLE SOURCE OF TRUTH for the coverage
      // thresholds. They gate in CI's `vitest-coverage` job
      // (`.github/workflows/_validate.yml`), on the MERGED report from all
      // vitest shards. #4818 sharded the suite, so the shards themselves pass
      // `--coverage.thresholds.*=0`: a shard runs only part of the tests and would
      // fail these on arithmetic rather than on a regression. That is the one
      // legitimate `=0` override — the contradictory full-suite one #749
      // removed, and the `>=80%/>=75%` step-summary string, stay gone.
      //
      // Design principle: gates sit a deliberate margin below the last
      // full-suite measurement so an unrelated PR that adds a moderately
      // sized, lightly tested file cannot flip a green gate red (the whole
      // point of a non-flaky gate) — but they're not so far below observed
      // coverage that a real regression goes unnoticed. Raise a gate as
      // observed coverage rises; do not lower one without surfacing a
      // deliberate decision. Branches (>=80% is the explicit OSPS Silver
      // floor; this repo gates it higher).
      //
      // #3258: this comment previously hardcoded a specific measured
      // snapshot (exact percentages, "statements gated at 88") that drifted
      // from the `thresholds` block below it once the numbers changed and
      // nobody updated the prose copy. Don't reintroduce that: for current
      // measured-vs-gated numbers, read the "Coverage summary" step's
      // output on a recent CI run (`.github/workflows/_validate.yml`,
      // derived from this file via `scripts/print-coverage-thresholds.mjs`
      // so it can't go stale the same way) rather than a comment here.
      thresholds: {
        lines: 95,
        functions: 93,
        branches: 87,
        statements: 93,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
