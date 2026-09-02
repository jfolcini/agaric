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
//
// Exit: 0 = lane alive, 1 = lane dead (loud `::error::` annotations),
//       2 = bad usage.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
 * CLI turns them into `::error::` annotations and an exit code.
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

// Only run the CLI when invoked directly, so a test can import
// `analyzeReports` without the module `process.exit()`ing out of it.
// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2))
}
