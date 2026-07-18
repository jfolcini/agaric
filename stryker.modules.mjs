/**
 * #886 — registry of pure, deterministic frontend modules eligible for
 * Stryker mutation testing, and the ONLY test file(s) each one may run
 * against.
 *
 * This is the third blocker from the maintainer's evaluation (issue #886):
 * vitest's default "related" mode (dependency-graph test selection) is not
 * "scoped" — mutating `search-query/tokenize.ts` pulled in 271+ unrelated
 * component tests via the `search-query/index.ts` barrel re-export, ~14x
 * slower than running just `tokenize.test.ts`. A single Stryker run can't
 * vary its vitest `test.include` per mutated file, so `scripts/run-mutation.mjs`
 * invokes `stryker run` once per module with `STRYKER_MODULE=<name>` set;
 * `stryker.config.mjs` reads it to pick the `mutate` target and
 * `stryker.vitest.config.mjs` reads it to pick `test.include`. This file is
 * the single source of truth both configs (and the driver script) read from.
 *
 * Scope is intentionally narrow — pure, side-effect-free library code only,
 * never components or Tauri IPC. Notably excluded from `search-query/`:
 * `register.ts` / `registry.ts` (a module-level mutable `registrations`
 * array — `ensureRegistered()`'s `let registered = false` one-shot guard and
 * the shared array are exactly the kind of cross-test-file mutable state
 * that breaks deterministic per-module scoping) and `autocomplete.ts` (reads
 * that same registry). `is-iso-date.ts` is excluded too: it has no dedicated
 * test file of its own (only exercised indirectly via `SearchDateFilterForm.tsx`
 * and the `register.ts` pipeline), so there is no way to scope it to a single
 * test file without pulling in a component suite.
 */

export const MODULES = {
  tokenize: {
    src: 'src/lib/search-query/tokenize.ts',
    tests: ['src/lib/search-query/__tests__/tokenize.test.ts'],
  },
  classify: {
    src: 'src/lib/search-query/classify.ts',
    tests: ['src/lib/search-query/__tests__/classify.test.ts'],
  },
  serialize: {
    src: 'src/lib/search-query/serialize.ts',
    tests: ['src/lib/search-query/__tests__/serialize.test.ts'],
  },
  'to-search-filter': {
    src: 'src/lib/search-query/to-search-filter.ts',
    tests: ['src/lib/search-query/__tests__/to-search-filter.test.ts'],
  },
  'glob-validate': {
    src: 'src/lib/search-query/glob-validate.ts',
    tests: [
      'src/lib/search-query/__tests__/glob-validate.test.ts',
      'src/lib/search-query/__tests__/glob-conformance.test.ts',
    ],
  },
  'validation-codes': {
    src: 'src/lib/search-query/validation-codes.ts',
    tests: ['src/lib/search-query/__tests__/validation-codes.test.ts'],
  },
  'agenda-sort': {
    src: 'src/lib/agenda-sort.ts',
    tests: ['src/lib/__tests__/agenda-sort.test.ts'],
  },
  'filters-model': {
    src: 'src/lib/filters/model.ts',
    tests: ['src/lib/filters/__tests__/model.test.ts'],
  },
  'date-utils': {
    src: 'src/lib/date-utils.ts',
    tests: [
      'src/lib/__tests__/date-utils.test.ts',
      'src/lib/__tests__/date-utils.property.test.ts',
    ],
  },
  'tree-utils': {
    src: 'src/lib/tree-utils.ts',
    tests: [
      'src/lib/__tests__/tree-utils.test.ts',
      'src/lib/__tests__/tree-utils.property.test.ts',
    ],
  },
}

export const MODULE_NAMES = Object.keys(MODULES)
