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

// #5101 — `@stryker-mutator/vitest-runner@10.0.0` selects the tests to run
// per mutant with a `testNamePattern` regex built from suite and test names
// joined by ' ', but vitest 5 matches that regex against names joined by
// ' > ' (upstream stryker-js#6210). Every test was skipped and each mutant
// was reported survived. Vitest calls this hook after `project.config` is
// created and before Stryker assigns the pattern, so the setter widens each
// space to accept either joiner (a superset of the covering tests, never a
// subset). Delete once the Stryker pin moves past stryker-js#6214.
const widenTestNamePattern = {
  name: 'stryker-vitest5-test-name-pattern',
  configureVitest({ project }) {
    let pattern = project.config.testNamePattern
    Object.defineProperty(project.config, 'testNamePattern', {
      enumerable: true,
      configurable: true,
      get: () => pattern,
      set: (value) => {
        pattern =
          value instanceof RegExp
            ? new RegExp(value.source.replaceAll(' ', '(?: > | )'), value.flags)
            : value
      },
    })
  },
}

export default defineConfig({
  plugins: [widenTestNamePattern],
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

    // #3350 — opt-in, per module. The original module set was pure libs
    // whose tests touch nothing global, so the default here is still "no
    // setup file": that keeps the cheap modules cheap. But the modules
    // worth widening to (the ones where a survivor means a real defect —
    // store reducers, IPC-shaped query builders, importers) are tested
    // through `src/test-setup.ts`'s global `@tauri-apps/api/core` mock and
    // fail at `mockedInvoke.mockResolvedValue is not a function` without
    // it. `setup: true` in `stryker.modules.mjs` opts a module in; the
    // `sequence.hooks: 'stack'` ordering below is copied verbatim from
    // `vitest.config.ts` because `src/test-setup.ts` depends on it (its
    // strict-IPC `afterEach` must run LAST, see #3225) and a setup file
    // loaded under different hook ordering is a different setup file.
    ...(mod.setup
      ? { setupFiles: ['./src/test-setup.ts'], sequence: { hooks: 'stack' }, testTimeout: 20_000 }
      : {}),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
