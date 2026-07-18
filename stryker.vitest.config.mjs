import path from 'node:path'

import { defineConfig } from 'vitest/config'

import { MODULES } from './stryker.modules.mjs'

// #886 — this vitest config is used ONLY by Stryker mutation runs
// (`stryker.config.mjs` points `vitest.configFile` at this file), never by
// `npm test` / CI's real suite (that's `vitest.config.ts`). It exists
// because Stryker's own vitest-runner "related" mode (dependency-graph test
// selection) is not "scoped": mutating a `search-query/` module pulls in
// 271+ unrelated component tests through the `search-query/index.ts` barrel
// re-export. Each mutation run sets `STRYKER_MODULE` (see
// `scripts/run-mutation.mjs`); this config narrows `test.include` to just
// that module's own test file(s) from `stryker.modules.mjs`, and
// `stryker.config.mjs` additionally disables `vitest.related` so Stryker
// never re-widens the set itself.
const moduleName = process.env.STRYKER_MODULE
const mod = moduleName ? MODULES[moduleName] : undefined

if (!mod) {
  throw new Error(
    `stryker.vitest.config.mjs: STRYKER_MODULE must be one of: ${Object.keys(MODULES).join(', ')} ` +
      `(got ${JSON.stringify(moduleName)}). Run mutation testing via \`npm run mutation\`, not vitest/stryker directly.`,
  )
}

export default defineConfig({
  test: {
    // Pure, deterministic libs only (see `stryker.modules.mjs`) — none of
    // them render components or talk Tauri IPC, so skip
    // `src/test-setup.ts`'s heavier RTL/i18n/Radix mocks (not needed here)
    // to keep per-module wall-clock low. `date-utils.test.ts` does read/write
    // `localStorage` (week-start preference) though, so the environment
    // still has to be a DOM one — `happy-dom`, matching the real suite,
    // rather than `node`.
    environment: 'happy-dom',
    include: mod.tests,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
