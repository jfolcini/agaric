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

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { MODULES } from '../stryker.modules.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// #3350 — the per-PR diff-scoped lane only runs when the PR touches a path in
// this workflow's `on.pull_request.paths` filter.
export const PR_WORKFLOW = '.github/workflows/mutation-pr.yml'

// #3350 — the complete set of keys a module entry may declare. A key outside
// this set is almost always a typo of one that IS in it, and every such typo
// fails OPEN: `stryker.vitest.config.mjs` reads `mod.setup` with a plain
// truthy check, so `setUp: true` / `setupFiles: true` / `setup_: true` all
// read as `undefined`, the setup file is silently not loaded, and the
// module's tests die in Stryker's initial run. That surfaces a week later as
// a lane-liveness failure whose message ("module produced no mutation.json")
// points nowhere near the typo. Cheap to catch here instead.
const KNOWN_MODULE_KEYS = new Set(['src', 'tests', 'setup'])

/**
 * Pure analysis: returns every declared path that does not exist under
 * `root`, tagged with the module and role it came from, plus every module
 * entry that declares a key this config does not understand.
 */
export function analyzeModulePaths({ root, modules }) {
  const missing = []
  let checked = 0
  for (const [name, mod] of Object.entries(modules)) {
    for (const key of Object.keys(mod)) {
      if (!KNOWN_MODULE_KEYS.has(key)) {
        missing.push({ module: name, role: 'key', path: `<unknown key '${key}'>` })
      }
    }
    if (mod.setup !== undefined && typeof mod.setup !== 'boolean') {
      missing.push({
        module: name,
        role: 'key',
        path: `<'setup' must be a boolean, got ${typeof mod.setup}>`,
      })
    }
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
// #3350 — the per-PR lane's path filter must cover every enrolled module
// ---------------------------------------------------------------------------
//
// `mutation-pr.yml` only starts when the PR touches a path in its
// `on.pull_request.paths` list. That list is a SECOND place the module set is
// encoded, and the two drift silently in the worst direction: enrol a module
// under a tree the filter does not mention and the diff-scoped lane simply
// never fires for it. No error, no empty report — the workflow is not
// dispatched at all, so there is nothing anywhere to notice.
//
// This is not hypothetical; #3350 hit it on its own first module. Enrolling
// `src/stores/page-blocks-move.ts` needed `src/stores/**` added to the filter
// (and to the `stryker-modules-paths` prek hook's own `files` regex, which is
// a third copy of the same idea). Path-keyed guards only guard the paths they
// name.

/** Minimal glob → RegExp for the `**`/`*` subset GitHub Actions path filters use. */
function pathFilterToRegExp(pattern) {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
  const body = escaped
    .replaceAll('**/', '\u0000SLASHSTAR\u0000')
    .replaceAll('**', '\u0000DOUBLESTAR\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000SLASHSTAR\u0000', '(?:.*/)?')
    .replaceAll('\u0000DOUBLESTAR\u0000', '.*')
  return new RegExp(`^${body}$`)
}

/**
 * Reads the `on.pull_request.paths` list out of the workflow WITHOUT a YAML
 * dependency (this repo's guards are dependency-free node), then checks every
 * declared module path against it.
 *
 * Returns `{ uncovered, patterns }`. A workflow file that is absent or has no
 * `paths:` list yields `patterns: null`, which callers treat as "cannot
 * check" and report — never as "everything is covered".
 */
export function analyzeWorkflowPathCoverage({ root, modules, workflowPath = PR_WORKFLOW }) {
  const full = join(root, workflowPath)
  if (!existsSync(full)) return { uncovered: [], patterns: null, reason: 'workflow file missing' }

  const text = readFileSync(full, 'utf8')
  const marker = text.indexOf('paths:')
  if (marker === -1) return { uncovered: [], patterns: null, reason: 'no `paths:` list' }

  // Everything from `paths:` up to the first line that is not a comment, a
  // blank line or a `- '…'` list item.
  const patterns = []
  for (const line of text.slice(marker).split('\n').slice(1)) {
    const item = /^\s*-\s*'([^']+)'\s*$/.exec(line) ?? /^\s*-\s*"([^"]+)"\s*$/.exec(line)
    if (item) {
      patterns.push(item[1])
      continue
    }
    if (/^\s*(#.*)?$/.test(line)) continue
    break
  }
  if (patterns.length === 0) return { uncovered: [], patterns: null, reason: 'empty `paths:` list' }

  const regexps = patterns.map(pathFilterToRegExp)
  const uncovered = []
  for (const [name, mod] of Object.entries(modules)) {
    for (const p of [mod.src, ...(mod.tests ?? [])]) {
      if (p === undefined) continue
      if (!regexps.some((re) => re.test(p))) uncovered.push({ module: name, path: p })
    }
  }
  return { uncovered, patterns, reason: null }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(root = REPO_ROOT) {
  const { missing, checked } = analyzeModulePaths({ root, modules: MODULES })
  if (missing.length > 0) {
    for (const m of missing) {
      console.error(
        m.role === 'key'
          ? `✗ stryker.modules.mjs: module '${m.module}' ${m.path} — allowed keys are: ${[...KNOWN_MODULE_KEYS].join(', ')} (#3350)`
          : `✗ stryker.modules.mjs: module '${m.module}' declares a ${m.role} path that does not exist: ${m.path}`,
      )
    }
    console.error(
      `\n${missing.length} problem(s) in stryker.modules.mjs. A dangling \`src\` silently drops the module from the mutation lane; a dangling/missing \`tests\` entry makes the scoped run keep re-reporting already-killed mutants as survivors (#3330, and the #3142 tree-utils incident); an unknown key fails open, so a misspelled \`setup\` reads as "no setup file" and only shows up as next week's lane-liveness failure (#3350). Update stryker.modules.mjs to match the files on disk.`,
    )
    process.exit(1)
  }
  const coverage = analyzeWorkflowPathCoverage({ root, modules: MODULES })
  if (coverage.patterns === null) {
    console.error(
      `✗ ${PR_WORKFLOW}: ${coverage.reason} — the diff-scoped mutation lane's path filter could not be read, so it cannot be checked against stryker.modules.mjs (#3350).`,
    )
    process.exit(1)
  }
  if (coverage.uncovered.length > 0) {
    for (const u of coverage.uncovered) {
      console.error(
        `✗ ${PR_WORKFLOW}: no \`paths:\` pattern matches '${u.path}' (module '${u.module}') — a PR touching it would never start the diff-scoped mutation lane (#3350).`,
      )
    }
    console.error(
      `\nAdd a matching pattern to ${PR_WORKFLOW}'s \`on.pull_request.paths\`. Current patterns: ${coverage.patterns.join(', ')}`,
    )
    process.exit(1)
  }

  console.log(
    `stryker.modules.mjs OK: ${checked} declared path(s) across ${Object.keys(MODULES).length} module(s) all exist, and all are covered by ${PR_WORKFLOW}'s ${coverage.patterns.length} path filter(s)`,
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

    // 6. #3350 — a misspelled key is flagged. `setUp` fails OPEN in
    //    `stryker.vitest.config.mjs` (plain truthy read of `mod.setup`), so
    //    without this check the module just quietly runs without its setup
    //    file and dies in Stryker's initial test run a week later.
    const r6 = analyzeModulePaths({
      root: tmp,
      modules: {
        good: {
          src: 'src/lib/good.ts',
          tests: ['src/lib/__tests__/good.test.ts'],
          setUp: true,
        },
      },
    })
    if (r6.missing.some((m) => m.role === 'key' && m.path.includes("unknown key 'setUp'")))
      ok('a misspelled module key is flagged (#3350)')
    else fail('a misspelled module key is flagged (#3350)', JSON.stringify(r6.missing))

    // 7. …and a non-boolean `setup` too: `setup: 'true'` is truthy, so it
    //    would work by accident today and break the day the read becomes
    //    `mod.setup === true`.
    const r7 = analyzeModulePaths({
      root: tmp,
      modules: {
        good: {
          src: 'src/lib/good.ts',
          tests: ['src/lib/__tests__/good.test.ts'],
          setup: 'true',
        },
      },
    })
    if (r7.missing.some((m) => m.role === 'key' && m.path.includes('must be a boolean')))
      ok('a non-boolean `setup` value is flagged (#3350)')
    else fail('a non-boolean `setup` value is flagged (#3350)', JSON.stringify(r7.missing))

    // 8. Complement: a correctly spelled `setup: true` must NOT be flagged,
    //    or the guard is just a permanent red hook.
    const r8 = analyzeModulePaths({
      root: tmp,
      modules: {
        good: { src: 'src/lib/good.ts', tests: ['src/lib/__tests__/good.test.ts'], setup: true },
      },
    })
    if (r8.missing.length === 0) ok('a valid `setup: true` module passes (#3350)')
    else fail('a valid `setup: true` module passes (#3350)', JSON.stringify(r8.missing))

    // 9. #3350 — a module under a tree the PR lane's `paths:` filter does not
    //    mention is INVISIBLE to that lane: the workflow is never dispatched,
    //    so there is no failing job, no empty report, nothing to notice. This
    //    fixture is the exact shape that was live during #3350's own work,
    //    when `src/stores/page-blocks-move.ts` was enrolled before
    //    `src/stores/**` was added to the filter.
    writeFileSync(
      join(tmp, 'wf.yml'),
      ['on:', '  pull_request:', '    paths:', "      - 'src/lib/**'", 'jobs: {}'].join('\n'),
      'utf8',
    )
    const covered = analyzeWorkflowPathCoverage({
      root: tmp,
      workflowPath: 'wf.yml',
      modules: { good: { src: 'src/lib/good.ts', tests: ['src/lib/__tests__/good.test.ts'] } },
    })
    const notCovered = analyzeWorkflowPathCoverage({
      root: tmp,
      workflowPath: 'wf.yml',
      modules: { store: { src: 'src/stores/thing.ts', tests: ['src/lib/__tests__/good.test.ts'] } },
    })
    if (
      covered.uncovered.length === 0 &&
      notCovered.uncovered.some((u) => u.path === 'src/stores/thing.ts')
    )
      ok("a module outside the PR lane's `paths:` filter is flagged (#3350)")
    else
      fail(
        "a module outside the PR lane's `paths:` filter is flagged (#3350)",
        `covered=${JSON.stringify(covered.uncovered)} notCovered=${JSON.stringify(notCovered.uncovered)}`,
      )

    // 10. …and an unreadable filter is reported as "cannot check", never as
    //     "everything is covered" — the false-green shape this repo keeps
    //     finding in its own guards.
    writeFileSync(join(tmp, 'nopaths.yml'), 'on:\n  pull_request:\njobs: {}\n', 'utf8')
    const unreadable = analyzeWorkflowPathCoverage({
      root: tmp,
      workflowPath: 'nopaths.yml',
      modules: { store: { src: 'src/stores/thing.ts', tests: [] } },
    })
    const absent = analyzeWorkflowPathCoverage({
      root: tmp,
      workflowPath: 'no-such-file.yml',
      modules: { store: { src: 'src/stores/thing.ts', tests: [] } },
    })
    if (unreadable.patterns === null && absent.patterns === null)
      ok('an unreadable or absent path filter reports "cannot check", not "covered" (#3350)')
    else
      fail(
        'an unreadable or absent path filter reports "cannot check", not "covered" (#3350)',
        `unreadable=${JSON.stringify(unreadable)} absent=${JSON.stringify(absent)}`,
      )

    // 11. The REAL config must be clean — this is the assertion that actually
    //    protects the lane, and the reason this guard is not vacuous.
    const real = analyzeModulePaths({ root: REPO_ROOT, modules: MODULES })
    if (real.missing.length === 0 && real.checked > 0)
      ok(`the real stryker.modules.mjs resolves all ${real.checked} path(s)`)
    else fail('the real stryker.modules.mjs resolves all paths', JSON.stringify(real.missing))

    const realCoverage = analyzeWorkflowPathCoverage({ root: REPO_ROOT, modules: MODULES })
    if (realCoverage.patterns !== null && realCoverage.uncovered.length === 0)
      ok(`the real config is fully covered by ${PR_WORKFLOW}'s path filter`)
    else
      fail(
        `the real config is fully covered by ${PR_WORKFLOW}'s path filter`,
        JSON.stringify(realCoverage),
      )
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
