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
 *
 * Entry shape:
 *   <name>: {
 *     src:   'path/to/module.ts',        // the ONE file Stryker mutates
 *     tests: ['path/to/its.test.ts'],    // the ONLY tests that run
 *     setup: true,                       // optional, #3350 — see below
 *   }
 *
 * `setup: true` (#3350) makes `stryker.vitest.config.mjs` load
 * `src/test-setup.ts` for that module. The #886 seed set did not need it
 * (pure libs, no globals) and still does not — leaving it off is what keeps
 * those modules cheap. But the modules worth widening to are tested through
 * that file's global `@tauri-apps/api/core` mock and fail immediately
 * without it (`mockedInvoke.mockResolvedValue is not a function`). Opt in
 * per module, never globally: the flag roughly 4x's the per-mutant test-run
 * cost, which is why the deferred list at the bottom of this file is as long
 * as it is.
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
      // #3142 — these four were added to kill specific surviving mutants but
      // never wired into this scoping list, so the Stryker-scoped run never
      // saw them and kept reporting already-fixed mutants as survivors.
      'src/lib/__tests__/tree-utils.mutants-build.test.ts',
      'src/lib/__tests__/tree-utils.mutants-depth.test.ts',
      'src/lib/__tests__/tree-utils.mutants-drop.test.ts',
      'src/lib/__tests__/tree-utils.mutants-simulate.test.ts',
    ],
  },

  // ───────────────────────────────────────────────────────────────────────
  // #3350 — second enrolment wave.
  //
  // The set above is the #886 seed: search-query's pure parsing helpers plus
  // four standalone libs. It measures assertion strength on ~1.8K mutants of
  // a ~209K-line product, which is a narrow enough slice that "the lane is
  // green" says almost nothing about the code where a defect would actually
  // hurt. The modules below were chosen by RISK, not by convenience: each
  // one either reorders/renumbers user data, parses untrusted input, or
  // rewrites text — the shapes where a surviving mutant means a real hole,
  // not a cosmetic one.
  //
  // Every candidate was measured before enrolment (mutant count from
  // `stryker run --dryRunOnly`, wall-clock and survivor count from a real
  // single-module run) rather than estimated. Modules deliberately NOT
  // enrolled, and why, are listed under "Measured but deferred" below —
  // that list is the honest half of this decision and should be read before
  // anyone adds "just one more".
  // ───────────────────────────────────────────────────────────────────────

  'block-tree-ops': {
    src: 'src/lib/block-tree-ops.ts',
    tests: ['src/lib/__tests__/block-tree-ops.test.ts'],
  },
  'graph-neighborhood': {
    src: 'src/lib/graph-neighborhood.ts',
    tests: ['src/lib/__tests__/graph-neighborhood.test.ts'],
  },
  'history-utils': {
    src: 'src/lib/history-utils.ts',
    tests: ['src/lib/__tests__/history-utils.test.ts'],
  },
  'inline-property-parse': {
    src: 'src/lib/inline-property-parse.ts',
    tests: ['src/lib/__tests__/inline-property-parse.test.ts'],
  },
  // Text search over block content: an off-by-one or a dropped anchor here
  // silently returns the wrong range, and the in-page-find replace path acts
  // on that range.
  'in-page-find-matcher': {
    src: 'src/lib/in-page-find/matcher.ts',
    tests: ['src/lib/in-page-find/__tests__/matcher.test.ts'],
  },
  'query-utils': {
    src: 'src/lib/query-utils.ts',
    tests: ['src/lib/__tests__/query-utils.test.ts'],
  },
  'tag-expr': {
    src: 'src/lib/tagExpr.ts',
    tests: ['src/lib/__tests__/tagExpr.test.ts'],
  },
  // Importer: parses a foreign vault into blocks. Untrusted input, and the
  // result is written to the user's database.
  'vault-import': {
    src: 'src/lib/vault-import.ts',
    tests: ['src/lib/vault-import.test.ts'],
  },
  // Exporter: the inverse. A survivor here is a lossy backup.
  'export-graph': {
    setup: true,
    src: 'src/lib/export-graph.ts',
    tests: ['src/lib/__tests__/export-graph.test.ts'],
  },
  // The single highest-value target in this wave, and the reason `setup`
  // exists: `reconcileBatchMove` renumbers siblings after a batch move, and
  // the defect class it guards against is silent ORDER SCRAMBLING of the
  // user's outline — invisible until someone notices their blocks moved.
  'page-blocks-move': {
    setup: true,
    src: 'src/stores/page-blocks-move.ts',
    tests: [
      'src/stores/__tests__/page-blocks.reorder.test.ts',
      'src/stores/__tests__/page-blocks.move-reparent.test.ts',
    ],
  },
}

/**
 * Measured but deferred (#3350) — do not re-litigate these without numbers.
 *
 * All figures below are single-module `npx stryker run` measurements on one
 * developer machine; the scheduled runner is roughly 1.5–1.8x slower, so
 * treat them as ratios against the pre-#3350 set (1799 mutants, 229s on the
 * same machine), not as absolutes.
 *
 * - `agenda-filters` (426 mutants, 145s, 40 survivors) and `template-utils`
 *   (317 mutants, 107s, 70 survivors). Together they cost more wall-clock
 *   than the ENTIRE pre-#3350 lane and return the worst signal-per-second
 *   ratio measured. Both are `setup: true` shapes whose per-mutant test run
 *   is dominated by `src/test-setup.ts`.
 *
 * - `jex-import` (514 mutants, 150 survivors) and `enex-import` (459
 *   mutants, 93 survivors). These are the strongest *signal* of anything
 *   measured — a 71% covered score on `jex-import` is exactly the
 *   "line-covering, not invariant-pinning" finding #3350 is about — but
 *   enrolling both would add 243 survivors in a single week on top of this
 *   wave's ~222. `scripts/file-mutation-survivors.mjs` clamps the tracking
 *   issue body at MAX_BODY_CHARS (60_000) and THROWS when the
 *   machine-readable state block alone will not fit; at ~95 characters per
 *   survivor line that ceiling is ~630 survivors, and the throw wedges the
 *   weekly filer job red with no self-healing path. Enrol these once this
 *   wave has been triaged down, not before.
 *
 * - `jaro-winkler` (100 mutants, 32 survivors, 16s). Cheap, but it ranks
 *   fuzzy-search suggestions; a survivor means "results ordered slightly
 *   differently", which is not the defect class this lane is for.
 */

export const MODULE_NAMES = Object.keys(MODULES)
