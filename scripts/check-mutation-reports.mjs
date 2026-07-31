#!/usr/bin/env node
// #3330 — liveness guard for the `mutants-frontend` (StrykerJS) lane in
// `.github/workflows/scheduled-deep-checks.yml`.
//
// The lane deliberately runs `npm run mutation || true`: surviving mutants
// are triage signal, never a merge blocker, and no `thresholds.break` is
// configured. But the `|| true` also swallowed a total StrykerJS CRASH, and
// the `Mutation summary` step that follows it pushes
// `_No reports produced …_` and `process.exit(0)` when `reports/mutation`
// is absent, renders `| <mod> | _no report_ | … |` for a module whose
// `mutation.json` never appeared, and the artifact upload uses
// `if-no-files-found: ignore`. Nothing anywhere read a mutant count, so the
// job was STRUCTURALLY INCAPABLE of failing: a crashed run and a perfect
// run produced the same green tick.
//
// That also silently defeated the downstream triage loop.
// `scripts/file-mutation-survivors.mjs` treats a missing frontend report
// dir as "zero survivors" on the explicit premise that lane failure "is
// already visible via the lane's own job status" — a premise the `|| true`
// made false for exactly this lane.
//
// This guard is the frontend analogue of the Rust lane's
// `Zero-coverage guard (#3057)` step: it runs OUTSIDE the `|| true` and
// fails ONLY on lane liveness, never on mutation SCORE. Specifically it
// fails when:
//
//   (a) the reports root does not exist at all (Stryker crashed before
//       writing any JSON),
//   (b) any module in `stryker.modules.mjs`'s MODULE_NAMES produced no
//       `mutation.json`, or produced one that is not valid JSON (the
//       "a module silently dropped out" case), or
//   (c) the total mutant count (Killed + Timeout + Survived + NoCoverage)
//       across all reports is zero (the direct analogue of the Rust lane's
//       `total_mutants == 0` check).
//
// Usage:
//   node scripts/check-mutation-reports.mjs [--reports-dir reports/mutation]
//   node scripts/check-mutation-reports.mjs --self-test
//
// Exit: 0 = lane alive, 1 = lane dead (loud `::error::` annotations),
//       2 = bad usage / self-test failure.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { MODULE_NAMES } from '../stryker.modules.mjs'

export const DEFAULT_REPORTS_DIR = 'reports/mutation'

// Mutant statuses that mean "Stryker actually produced a verdict for this
// mutant". `CompileError` / `RuntimeError` are deliberately EXCLUDED: a run
// where every mutant failed to compile has produced no mutation coverage at
// all, and must not be able to satisfy the non-zero check below.
const COUNTED_STATUSES = new Set(['Killed', 'Timeout', 'Survived', 'NoCoverage'])

/**
 * Pure analysis of a Stryker reports tree. Returns the problems found; the
 * CLI turns them into `::error::` annotations and an exit code, and the
 * self-test asserts on them directly.
 */
export function analyzeReports({ reportsDir, moduleNames }) {
  const problems = []
  const perModule = []
  let totalMutants = 0

  if (!existsSync(reportsDir)) {
    problems.push(
      `StrykerJS produced no reports directory at \`${reportsDir}\` — the run crashed or aborted before writing any JSON. The lane's \`npm run mutation || true\` would otherwise report this as job success with ZERO mutation coverage (#3330).`,
    )
    return { problems, perModule, totalMutants }
  }

  for (const mod of moduleNames) {
    const jsonPath = join(reportsDir, mod, 'mutation.json')
    if (!existsSync(jsonPath)) {
      problems.push(
        `module \`${mod}\` produced no \`${jsonPath}\` — it silently dropped out of the run (a moved/renamed source or test path in \`stryker.modules.mjs\` makes Stryker fail its own "no files to mutate" check). The step summary would show it as \`_no report_\` and the job would still be green (#3330).`,
      )
      perModule.push({ module: mod, mutants: 0, ok: false })
      continue
    }
    let report
    try {
      report = JSON.parse(readFileSync(jsonPath, 'utf8'))
    } catch (err) {
      problems.push(
        `module \`${mod}\`'s \`${jsonPath}\` is not valid JSON (${err.message}) — a partial/truncated report is a crashed run, not zero survivors (#3330).`,
      )
      perModule.push({ module: mod, mutants: 0, ok: false })
      continue
    }
    let counted = 0
    for (const entry of Object.values(report.files ?? {})) {
      for (const mutant of entry.mutants ?? []) {
        if (COUNTED_STATUSES.has(mutant.status)) counted++
      }
    }
    totalMutants += counted
    perModule.push({ module: mod, mutants: counted, ok: true })
  }

  if (totalMutants === 0 && problems.length === 0) {
    problems.push(
      `every module reported, but the total mutant count across all reports is ZERO (Killed + Timeout + Survived + NoCoverage). This is the frontend analogue of the Rust lane's \`total_mutants == 0\` #3057 false-green: reports exist, the job is green, and nothing was actually mutation-tested (#3330).`,
    )
  }

  return { problems, perModule, totalMutants }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  let reportsDir = DEFAULT_REPORTS_DIR
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reports-dir') {
      reportsDir = argv[++i]
      if (reportsDir === undefined) {
        console.error('--reports-dir needs a value')
        process.exit(2)
      }
    } else {
      console.error(`unknown argument: ${argv[i]}`)
      process.exit(2)
    }
  }

  const { problems, perModule, totalMutants } = analyzeReports({
    reportsDir,
    moduleNames: MODULE_NAMES,
  })

  for (const p of problems) console.error(`::error::mutation lane liveness: ${p}`)

  if (problems.length > 0) {
    console.error(
      `\nmutation-lane liveness guard FAILED (${problems.length} problem(s)). Surviving mutants are triage signal and never gate this job — a DEAD lane does.`,
    )
    process.exit(1)
  }

  const detail = perModule.map((m) => `${m.module}=${m.mutants}`).join(' ')
  console.log(
    `mutation-lane liveness OK: ${totalMutants} mutant(s) tested across ${perModule.length} module(s) [${detail}] (survivors, if any, are triage signal — see the summary step — and never gate this job)`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
//
// Drives analyzeReports() against synthetic report trees in a temp dir so we
// can assert the exit behavior #3330 demands: a healthy run PASSES, and each
// of the three false-green shapes (missing root, a module with no report, a
// zero-mutant run) FAILS.
function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'mutation-liveness-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  const MODS = ['alpha', 'beta']
  const report = (statuses) => ({
    files: {
      'src/lib/x.ts': {
        mutants: statuses.map((status, i) => ({
          id: String(i),
          status,
          mutatorName: 'ConditionalExpression',
          location: { start: { line: i + 1 } },
        })),
      },
    },
  })
  const writeReport = (root, mod, statuses) => {
    mkdirSync(join(root, mod), { recursive: true })
    writeFileSync(join(root, mod, 'mutation.json'), JSON.stringify(report(statuses)), 'utf8')
  }

  try {
    // 1. Healthy run: every module reported, mutants were tested → PASS.
    const healthy = join(tmp, 'healthy')
    writeReport(healthy, 'alpha', ['Killed', 'Survived'])
    writeReport(healthy, 'beta', ['Killed', 'NoCoverage'])
    const r1 = analyzeReports({ reportsDir: healthy, moduleNames: MODS })
    if (r1.problems.length === 0 && r1.totalMutants === 4) ok('healthy run passes')
    else
      fail('healthy run passes', `problems=${JSON.stringify(r1.problems)} total=${r1.totalMutants}`)

    // 2. Reports root absent (Stryker crashed before writing JSON) → FAIL.
    const r2 = analyzeReports({ reportsDir: join(tmp, 'does-not-exist'), moduleNames: MODS })
    if (r2.problems.length === 1 && /no reports directory/.test(r2.problems[0]))
      ok('missing reports root fails')
    else fail('missing reports root fails', JSON.stringify(r2.problems))

    // 3. One module silently dropped out (no mutation.json) → FAIL, even
    //    though the other module reported plenty of mutants. This is the
    //    `| <mod> | _no report_ |` row the summary step renders as green.
    const dropped = join(tmp, 'dropped')
    writeReport(dropped, 'alpha', ['Killed', 'Survived'])
    const r3 = analyzeReports({ reportsDir: dropped, moduleNames: MODS })
    if (r3.problems.some((p) => p.includes('`beta`') && p.includes('no `')))
      ok('module with no mutation.json fails')
    else fail('module with no mutation.json fails', JSON.stringify(r3.problems))

    // 4. A module's report is truncated/invalid JSON → FAIL (a partial
    //    report is a crashed run, not "zero survivors").
    const broken = join(tmp, 'broken')
    writeReport(broken, 'alpha', ['Killed'])
    mkdirSync(join(broken, 'beta'), { recursive: true })
    writeFileSync(join(broken, 'beta', 'mutation.json'), '{"files": {', 'utf8')
    const r4 = analyzeReports({ reportsDir: broken, moduleNames: MODS })
    if (r4.problems.some((p) => p.includes('not valid JSON'))) ok('invalid JSON report fails')
    else fail('invalid JSON report fails', JSON.stringify(r4.problems))

    // 5. Every module reported but ZERO mutants were tested → FAIL. This is
    //    the direct analogue of the Rust lane's `total_mutants == 0` check.
    const empty = join(tmp, 'empty')
    writeReport(empty, 'alpha', [])
    writeReport(empty, 'beta', [])
    const r5 = analyzeReports({ reportsDir: empty, moduleNames: MODS })
    if (r5.problems.some((p) => p.includes('ZERO'))) ok('zero-mutant run fails')
    else fail('zero-mutant run fails', JSON.stringify(r5.problems))

    // 6. Only compile/runtime errors → still ZERO mutation coverage → FAIL.
    //    A run where every mutant failed to compile must not be able to
    //    satisfy the non-zero check by counting its own errors.
    const errored = join(tmp, 'errored')
    writeReport(errored, 'alpha', ['CompileError', 'RuntimeError'])
    writeReport(errored, 'beta', ['CompileError'])
    const r6 = analyzeReports({ reportsDir: errored, moduleNames: MODS })
    if (r6.totalMutants === 0 && r6.problems.some((p) => p.includes('ZERO')))
      ok('all-CompileError run fails (errors are not coverage)')
    else
      fail(
        'all-CompileError run fails (errors are not coverage)',
        `total=${r6.totalMutants} problems=${JSON.stringify(r6.problems)}`,
      )

    // 7. The real module list is what the workflow checks — assert the guard
    //    is actually wired to `stryker.modules.mjs` and not an empty list
    //    (an empty MODULE_NAMES would make the per-module loop vacuous).
    if (MODULE_NAMES.length > 0) ok(`guard is wired to ${MODULE_NAMES.length} real module(s)`)
    else fail('guard is wired to real modules', 'MODULE_NAMES is empty')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Only run the CLI when invoked directly, so a test can import
// `analyzeReports` without the module `process.exit()`ing out of it.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    runSelfTest()
  } else {
    main(argv)
  }
}
