#!/usr/bin/env node
// #3330 — drift guard for `stryker.modules.mjs`.
//
// `stryker.modules.mjs` is the single source of truth the StrykerJS mutation
// lane reads: `MODULES[<name>].src` is the file to mutate and
// `MODULES[<name>].tests[]` is the exact test set to scope the run to. Both
// are plain strings, and NOTHING checked that they still point at files that
// exist. Two failure modes, both silent:
//
//   * A moved/renamed `src` path makes Stryker fail its own "no files to
//     mutate" check for that module. The lane's step summary renders
//     `| <mod> | _no report_ | | | | | |` and (before #3330's liveness
//     guard) the job stayed green — the module simply stopped being
//     mutation-tested and nobody was told.
//   * A missing/never-wired `tests` entry means the scoped run does not
//     execute the tests that kill those mutants, so the lane keeps
//     re-reporting already-fixed mutants as survivors. This is not
//     hypothetical: `stryker.modules.mjs:77-83` records exactly that, four
//     `tree-utils.mutants-*.test.ts` files added under #3142 that were never
//     added to the scoping list, which inflated the tracked tree-utils
//     survivor count from 22 to 78.
//
// This guard is a pure filesystem existence check — cheap enough to run on
// every commit that touches the config or the frontend libs it names, and it
// catches a file move at the moment it happens instead of the following
// Monday's scheduled run.
//
// Usage:
//   node scripts/check-stryker-modules.mjs
//   node scripts/check-stryker-modules.mjs --self-test
//
// Exit: 0 = every path resolves, 1 = at least one dangling path,
//       2 = bad usage / self-test failure.

import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { MODULES } from '../stryker.modules.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..')

/**
 * Pure analysis: returns every declared path that does not exist under
 * `root`, tagged with the module and role it came from.
 */
export function analyzeModulePaths({ root, modules }) {
  const missing = []
  let checked = 0
  for (const [name, mod] of Object.entries(modules)) {
    const entries = [
      { role: 'src', path: mod.src },
      ...(mod.tests ?? []).map((t) => ({ role: 'tests', path: t })),
    ]
    if (mod.src === undefined) {
      missing.push({ module: name, role: 'src', path: '<undeclared>' })
    }
    if (!Array.isArray(mod.tests) || mod.tests.length === 0) {
      // A module with no test files would run Stryker against an empty test
      // set: every mutant "survives" and the survivor list becomes noise.
      missing.push({ module: name, role: 'tests', path: '<empty test list>' })
    }
    for (const entry of entries) {
      if (entry.path === undefined) continue
      checked++
      if (!existsSync(join(root, entry.path))) {
        missing.push({ module: name, role: entry.role, path: entry.path })
      }
    }
  }
  return { missing, checked }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(root = REPO_ROOT) {
  const { missing, checked } = analyzeModulePaths({ root, modules: MODULES })
  if (missing.length > 0) {
    for (const m of missing) {
      console.error(
        `✗ stryker.modules.mjs: module '${m.module}' declares a ${m.role} path that does not exist: ${m.path}`,
      )
    }
    console.error(
      `\n${missing.length} dangling path(s) in stryker.modules.mjs. A dangling \`src\` silently drops the module from the mutation lane; a dangling/missing \`tests\` entry makes the scoped run keep re-reporting already-killed mutants as survivors (#3330, and the #3142 tree-utils incident). Update stryker.modules.mjs to match the files on disk.`,
    )
    process.exit(1)
  }
  console.log(
    `stryker.modules.mjs OK: ${checked} declared path(s) across ${Object.keys(MODULES).length} module(s) all exist`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'stryker-modules-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  const touch = (rel) => {
    mkdirSync(join(tmp, dirname(rel)), { recursive: true })
    writeFileSync(join(tmp, rel), '', 'utf8')
  }

  try {
    touch('src/lib/good.ts')
    touch('src/lib/__tests__/good.test.ts')

    // 1. Every path resolves → clean.
    const r1 = analyzeModulePaths({
      root: tmp,
      modules: { good: { src: 'src/lib/good.ts', tests: ['src/lib/__tests__/good.test.ts'] } },
    })
    if (r1.missing.length === 0 && r1.checked === 2) ok('all-present config passes')
    else fail('all-present config passes', JSON.stringify(r1))

    // 2. A moved `src` → flagged (the `_no report_` row case).
    const r2 = analyzeModulePaths({
      root: tmp,
      modules: { good: { src: 'src/lib/moved.ts', tests: ['src/lib/__tests__/good.test.ts'] } },
    })
    if (r2.missing.some((m) => m.role === 'src' && m.path === 'src/lib/moved.ts'))
      ok('dangling src path is flagged')
    else fail('dangling src path is flagged', JSON.stringify(r2.missing))

    // 3. A test file that was never wired / was renamed → flagged. This is
    //    the #3142 tree-utils shape.
    const r3 = analyzeModulePaths({
      root: tmp,
      modules: {
        good: {
          src: 'src/lib/good.ts',
          tests: ['src/lib/__tests__/good.test.ts', 'src/lib/__tests__/never-written.test.ts'],
        },
      },
    })
    if (r3.missing.some((m) => m.role === 'tests' && m.path.endsWith('never-written.test.ts')))
      ok('dangling test path is flagged')
    else fail('dangling test path is flagged', JSON.stringify(r3.missing))

    // 4. A module with an empty test list → flagged (Stryker would run
    //    against no tests and report every mutant as a survivor).
    const r4 = analyzeModulePaths({
      root: tmp,
      modules: { good: { src: 'src/lib/good.ts', tests: [] } },
    })
    if (r4.missing.some((m) => m.role === 'tests' && m.path === '<empty test list>'))
      ok('empty test list is flagged')
    else fail('empty test list is flagged', JSON.stringify(r4.missing))

    // 5. A module with no `src` key at all → flagged. Without this branch
    //    nothing would report it: the `entries` loop skips an undefined
    //    path, so the module would silently contribute zero checks and pass.
    const r5 = analyzeModulePaths({
      root: tmp,
      modules: { good: { tests: ['src/lib/__tests__/good.test.ts'] } },
    })
    if (r5.missing.some((m) => m.role === 'src' && m.path === '<undeclared>'))
      ok('module with no src key is flagged')
    else fail('module with no src key is flagged', JSON.stringify(r5.missing))

    // 6. The REAL config must be clean — this is the assertion that actually
    //    protects the lane, and the reason this guard is not vacuous.
    const real = analyzeModulePaths({ root: REPO_ROOT, modules: MODULES })
    if (real.missing.length === 0 && real.checked > 0)
      ok(`the real stryker.modules.mjs resolves all ${real.checked} path(s)`)
    else fail('the real stryker.modules.mjs resolves all paths', JSON.stringify(real.missing))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Only run the CLI when invoked directly. Tests import this module for
// `analyzeModulePaths`, and a bare top-level dispatch would `process.exit()`
// out of the importer.
// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    runSelfTest()
  } else if (argv[0] === '--root' && argv.length === 2) {
    // Resolve the declared paths against a different root. Exists so the
    // gating vitest test can assert the NON-ZERO exit end-to-end (a guard
    // whose failure path is never executed is not a guard).
    main(argv[1])
  } else if (argv.length > 0) {
    console.error(`unknown argument: ${argv[0]}`)
    process.exit(2)
  } else {
    main()
  }
}
