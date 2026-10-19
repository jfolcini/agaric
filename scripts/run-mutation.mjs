/**
 * #886 — driver for Stryker mutation testing.
 *
 * Stryker mutates exactly one module per run (see `stryker.config.mjs` /
 * `stryker.vitest.config.mjs`), because per-module test scoping — running
 * ONLY the mutated module's own test file(s), never vitest's dependency-graph
 * "related" mode which drags in unrelated suites through barrel re-exports —
 * requires a fixed `test.include` per run. This script loops `stryker run`
 * over `stryker.modules.mjs`'s module list (or a caller-supplied subset),
 * setting `STRYKER_MODULE` for each.
 *
 * Usage:
 *   node scripts/run-mutation.mjs                    # every target module
 *   node scripts/run-mutation.mjs tokenize model      # only named modules
 *   node scripts/run-mutation.mjs --group 2/4         # one slice of every module
 *   npm run mutation                                  # same as no args
 *   npm run mutation -- tokenize filters-model         # same as named args
 *
 * `--group k/n` runs the modules whose index in `MODULE_NAMES` is k-1 modulo
 * n, so the n groups partition the list and a new module joins one without
 * anyone editing the partition (#5915). The weekly lane passes its matrix leg
 * and `strategy.job-total`.
 *
 * Nightly-only, non-gating (#886): no `thresholds.break` is set in
 * `stryker.config.mjs`, so a low mutation score never fails a run — only an
 * actual Stryker crash (bad config, sandbox failure, …) does, and that's
 * what this script's exit code reflects. The scheduled CI lane
 * (`.github/workflows/scheduled-deep-checks.yml`'s `mutants-frontend` job)
 * additionally wraps the whole run in `|| true`.
 */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'

import { MODULE_NAMES, MODULES } from '../stryker.modules.mjs'

/** The modules of group `k` of `n` (1-based), from a `k/n` spec. */
export function groupModules(spec, names = MODULE_NAMES) {
  const match = /^(\d+)\/(\d+)$/.exec(spec)
  const k = Number(match?.[1])
  const n = Number(match?.[2])
  if (!match || n < 1 || k < 1 || k > n) {
    throw new Error(`--group needs k/n with 1 <= k <= n, got ${JSON.stringify(spec)}`)
  }
  return names.filter((_, index) => index % n === k - 1)
}

function main(argv) {
  let names = argv.length > 0 ? argv : MODULE_NAMES
  if (argv[0] === '--group') {
    try {
      names = groupModules(argv[1])
    } catch (err) {
      console.error(err.message)
      process.exit(2)
    }
  }

  const unknown = names.filter((name) => !MODULES[name])
  if (unknown.length > 0) {
    console.error(`Unknown mutation module(s): ${unknown.join(', ')}`)
    console.error(`Known modules: ${MODULE_NAMES.join(', ')}`)
    process.exit(1)
  }

  const results = []
  for (const name of names) {
    console.log(`\n=== stryker: ${name} (${MODULES[name].src}) ===`)
    const result = spawnSync('npx', ['stryker', 'run'], {
      stdio: 'inherit',
      env: { ...process.env, STRYKER_MODULE: name },
    })
    results.push({ name, ok: result.status === 0, status: result.status })
  }

  console.log('\n=== mutation run summary ===')
  for (const { name, ok, status } of results) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ` (stryker exit ${status})`}`)
  }

  const failed = results.filter((r) => !r.ok)
  process.exit(failed.length > 0 ? 1 : 0)
}

// Entry-point check (#3373): realpath BOTH sides, so a symlinked invocation
// still runs and a test can import `groupModules` without running Stryker.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2))
}
