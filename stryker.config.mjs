import { MODULES } from './stryker.modules.mjs'

// #886 — nightly-only, non-gating mutation testing scoped to a handful of
// pure/deterministic frontend libs (never components or Tauri IPC). Full
// recipe + evaluation numbers: issue #886. Always run through
// `npm run mutation` (or `scripts/run-mutation.mjs` directly), never
// `npx stryker run` bare — this config mutates exactly one module per run,
// selected via `STRYKER_MODULE`, because Stryker can't vary its test scope
// per mutated file within a single run.
const moduleName = process.env.STRYKER_MODULE
const mod = moduleName ? MODULES[moduleName] : undefined

// Don't throw here: this file is imported (not just read) by tooling other
// than Stryker itself — notably `knip`'s built-in Stryker plugin, which
// resolves `testRunner`/`vitest` into a `@stryker-mutator/vitest-runner`
// dependency reference by importing this config with no `STRYKER_MODULE` set
// at all. A hard crash on import would break `npx knip` (pre-push hook +
// `_validate.yml` CI). Instead: warn loudly and mutate nothing, so a real
// bare `npx stryker run` (never the supported entry point — use
// `npm run mutation`) fails Stryker's own "no files to mutate" check with
// this warning already printed above it, rather than crashing at import.
if (!mod) {
  console.error(
    `stryker.config.mjs: STRYKER_MODULE should be one of: ${Object.keys(MODULES).join(', ')} ` +
      `(got ${JSON.stringify(moduleName)}). Use \`npm run mutation\` (all modules) or ` +
      `\`npm run mutation -- <name>\` (one module) — not \`stryker run\` directly.`,
  )
}

export default {
  mutate: mod ? [mod.src] : [],

  testRunner: 'vitest',
  vitest: {
    configFile: 'stryker.vitest.config.mjs',
    // Stryker's default vitest-runner scoping ("related" = dependency-graph
    // test selection) is NOT the same as "scoped": it still resolves through
    // barrel re-exports (`search-query/index.ts`) and pulled in 271+
    // unrelated component tests during evaluation, ~14x slower. Scoping is
    // instead enforced by `stryker.vitest.config.mjs`'s per-module
    // `test.include` (see `stryker.modules.mjs`); disable `related` so
    // Stryker never re-widens that set on its own.
    related: false,
  },

  // #886 blocker 1 — this repo's `typescript@^7.0.2` is the native-port
  // package; `ts.parseConfigFileTextToJson` (which Stryker's built-in
  // tsconfig-rewrite step calls) doesn't exist on it, so the rewrite
  // crashes. Vitest doesn't type-check to run tests, so the rewrite buys
  // nothing here — pointing `tsconfigFile` at a path that does not exist
  // makes Stryker skip the rewrite instead of crashing. Do NOT create this
  // file.
  tsconfigFile: '.stryker-tsconfig-intentionally-missing.json',

  // #886 blocker 2 — default sandboxing copies the whole repo (3500+ files
  // incl. the Rust backend under `src-tauri/`) into a tmp dir per run and
  // chokes on it. Scope the copy to what these pure-lib vitest runs
  // actually need. (`node_modules`, `.git`, `/reports`, `.stryker-tmp` are
  // always ignored by Stryker regardless of this list.)
  ignorePatterns: [
    'src-tauri',
    'e2e',
    'target',
    'coverage',
    'coverage-shard-*',
    'coverage-merged',
    'dist',
    'playwright-report',
    'test-results',
    'blob-report',
    '.serena',
    '.code-review-graph',
    'worktrees',
    'public',
    'packaging',
    // A local Python venv (used by prek's python-based hooks) with
    // symlinked `lib64 -> lib`; Node's sandbox-copy chokes on it with
    // `EISDIR` the same way it chokes on `src-tauri`'s size. Not needed to
    // run vitest against a pure TS/JS lib either way.
    '.venv',
  ],

  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: {
    fileName: `reports/mutation/${moduleName ?? 'unscoped'}/mutation.html`,
  },
  jsonReporter: {
    fileName: `reports/mutation/${moduleName ?? 'unscoped'}/mutation.json`,
  },

  concurrency: 4,
  // No `thresholds.break` — mutation score never fails a run (nightly,
  // non-gating; see .github/workflows/scheduled-deep-checks.yml's
  // `mutants-frontend` job). Surviving mutants are triage signal, not
  // failures.
}
