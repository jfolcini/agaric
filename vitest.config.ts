import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    // PEND-41 R25 — emit a warning when a single test exceeds 2 seconds.
    // Catches regressions cheaply without altering test outcomes.
    slowTestThreshold: 2000,
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
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
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
