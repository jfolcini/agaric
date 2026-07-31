import path from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
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
      // thresholds. The CI vitest job (`.github/workflows/_validate.yml`)
      // runs the full suite with coverage and NO threshold override, so
      // these values actually gate there; the prior contradictory `=0`
      // override and the `>=80%/>=75%` step-summary string were removed.
      //
      // Design principle: gates sit a deliberate margin below the last
      // full-suite measurement so an unrelated PR that adds a moderately
      // sized, lightly tested file cannot flip a green gate red (the whole
      // point of a non-flaky gate) — but they're not so far below observed
      // coverage that a real regression goes unnoticed. Raise a gate as
      // observed coverage rises; do not lower one without surfacing a
      // deliberate decision. Branches (>=80% is the explicit OSPS Silver
      // floor; this repo currently gates it higher, at 82%).
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
        lines: 91,
        functions: 90,
        branches: 82,
        statements: 89,
      },
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
