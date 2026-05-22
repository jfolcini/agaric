import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    // PEND-41 R25 — emit a warning when a single test exceeds 2 seconds.
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
    coverage: {
      provider: 'v8',
      // `json-summary` writes `coverage/coverage-summary.json` (aggregated
      // totals), which `_validate.yml`'s coverage step (PEND-41 R17)
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
      // PEND-44 — OpenSSF Best Practices Silver tier coverage gates.
      //
      // Measurement-derived headroom from CI run 25985548538 (post-PEND-39
      // 3-shard merge): lines 91.91% / functions 91.17% / statements 90.17%
      // / branches 81.81%. Gates set ~2pp below observed to absorb shard-
      // merge variance (run-to-run ~0.3% normal) while keeping the OSPS
      // Silver claim (≥90% statements, ≥80% branches) honest in the
      // step-summary output. Raise gates as observed coverage rises;
      // do not lower them without surfacing a deliberate decision.
      thresholds: {
        lines: 90,
        functions: 89,
        branches: 80,
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
