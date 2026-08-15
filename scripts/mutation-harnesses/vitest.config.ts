import path from 'node:path'

import { defineConfig } from 'vitest/config'

// #3804 — standalone runner config for the mutation-equivalence sweep
// harnesses in this directory. Deliberately separate from the root
// `vitest.config.ts`: these are minutes-long differential sweeps with no
// gating value (see the module-level doc comment in each `*.harness.ts`),
// so they must never be picked up by the root config's
// `include: ['src/**/*.{test,spec}.{ts,tsx}']` (they live outside `src/`
// AND use a `.harness.ts` suffix — belt and braces) or run under coverage/CI.
//
// Invocation (from repo root): `npx vitest run --config
// scripts/mutation-harnesses/vitest.config.ts scripts/mutation-harnesses/<module>.harness.ts`
export default defineConfig({
  // #3907 review note: `include` was cwd-relative with no `root`, so the
  // documented invocation only worked from the repo root. Pinning `root`
  // here makes the config (and its `include` glob) location-independent.
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['*.harness.ts'],
    // These are exhaustive/near-exhaustive sweeps over tens of thousands of
    // generated inputs; give them room instead of tripping the suite's 20s
    // default.
    testTimeout: 300_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '../../src'),
    },
  },
})
