#!/usr/bin/env node
// #3350 — renders a StrykerJS mutation report tree as Markdown.
//
// ─── Why this is a script and not a heredoc ──────────────────────────────
//
// This logic lived inline in `scheduled-deep-checks.yml`'s `Mutation summary`
// step as a `node - <<'NODE'` block. That was tolerable while it had exactly
// one caller and one rendering rule. It now has two callers — the weekly lane
// and the per-PR diff-scoped lane (`mutation-pr.yml`), which must show the
// author the SAME shape they will later see in the tracking issue — and its
// rendering rules are the substance of #3350 rather than incidental
// formatting. A heredoc cannot be unit-tested, cannot be imported, and
// silently forks the moment someone edits one copy.
//
// ─── What it renders, and why in that order ──────────────────────────────
//
// The pre-#3350 summary was a table in `readdir` (alphabetical) order with
// one flat, undifferentiated block of survivor lines underneath. At ten
// modules that is merely unhelpful; at twenty it is unreadable — the module
// worth looking at is buried between modules that are fine, and each survivor
// line carries its module only as a prefix you have to scan for.
//
// So: rows and survivor groups are ordered by RISK. Modules with no or
// unreadable reports first (no data outranks any survivor count — and the
// lane-liveness guard has already failed the job for them), then most
// survivors, ties broken by worst covered score, then name for determinism.
// Survivors are grouped under a per-module heading and collapsed, so a
// 200-survivor run does not push everything else off the page.
//
// ─── This must never be the thing that fails ─────────────────────────────
//
// `scripts/check-mutation-reports.mjs` is the ONLY component allowed to fail
// the mutation lane. A summary is a DIAGNOSIS of a failure, not another
// casualty of it (#3360): a truncated `mutation.json` — precisely what the
// liveness guard exists to catch — used to throw out of `JSON.parse` here and
// replace the whole table with a second stack trace. Every report is parsed
// defensively, a bad one becomes a row plus a quoted parse error, and any
// unexpected throw still flushes whatever the table had. `main()` exits 0
// unconditionally.
//
// Usage:
//   node scripts/render-mutation-summary.mjs [--reports-dir <dir>] [--title <md>]
//
// Exit: 0 always (see above), except 2 for bad usage.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

export const DEFAULT_REPORTS_DIR = 'reports/mutation'
const DEFAULT_TITLE = '## StrykerJS mutation testing (frontend, #886)'

/**
 * Reads one module's `mutation.json` into counts plus a survivor list.
 * Returns a row whose `state` is `'ok'`, `'no report'` or `'unreadable'`.
 */
function readModule(reportsDir, mod) {
  const jsonPath = join(reportsDir, mod, 'mutation.json')
  if (!existsSync(jsonPath)) return { mod, state: 'no report', survivors: [] }

  let report
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch (err) {
    return { mod, state: 'unreadable', survivors: [], error: err.message }
  }

  const counts = { killed: 0, timeout: 0, survived: 0, noCov: 0, errors: 0 }
  const survivors = []
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const mutant of entry?.mutants ?? []) {
      switch (mutant.status) {
        case 'Killed': {
          counts.killed++
          break
        }
        case 'Timeout': {
          counts.timeout++
          break
        }
        case 'Survived': {
          counts.survived++
          // Optional-chained: a report can be valid JSON and still be missing
          // `location`, which used to be a TypeError that took the whole
          // summary down (#3360).
          survivors.push({
            file,
            line: mutant.location?.start?.line ?? '?',
            mutator: mutant.mutatorName ?? 'unknown',
          })
          break
        }
        case 'NoCoverage': {
          counts.noCov++
          break
        }
        case 'CompileError':
        case 'RuntimeError': {
          counts.errors++
          break
        }
        default: {
          break
        }
      }
    }
  }
  const scored = counts.killed + counts.timeout + counts.survived
  const score = scored > 0 ? ((counts.killed + counts.timeout) / scored) * 100 : 0
  return { mod, state: 'ok', counts, score, survivors }
}

/**
 * Pure analysis: every module directory under `reportsDir`, in risk order.
 * Exported so the ordering rule — the substance of #3350's readability half —
 * can be asserted on directly instead of by grepping rendered Markdown.
 */
export function analyzeReportTree(reportsDir) {
  if (!existsSync(reportsDir)) return null
  const rows = readdirSync(reportsDir)
    .toSorted()
    .map((mod) => readModule(reportsDir, mod))

  // "No data" outranks any survivor count.
  const rank = (r) => (r.state === 'ok' ? 1 : 0)
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.survivors.length - a.survivors.length ||
      (a.score ?? 0) - (b.score ?? 0) ||
      a.mod.localeCompare(b.mod),
  )
  for (const r of rows) {
    r.survivors.sort((a, b) => a.file.localeCompare(b.file) || Number(a.line) - Number(b.line))
  }
  return rows
}

export function renderMutationSummary({
  reportsDir = DEFAULT_REPORTS_DIR,
  title = DEFAULT_TITLE,
} = {}) {
  const lines = [title, '']
  const unreadable = []

  const render = () => {
    const rows = analyzeReportTree(reportsDir)
    if (rows === null) {
      lines.push('_No reports produced (Stryker crashed before writing JSON) — see the job log._')
      return
    }

    // "Score" is Stryker's "covered" mutation score — (killed + timeout) /
    // (killed + timeout + survived) — i.e. excluding no-coverage mutants from
    // the denominator, same as the "covered" column Stryker prints to the log.
    lines.push('| Module | Score (covered) | Killed | Timeout | Survived | No cov | Errors |')
    lines.push('|---|--:|--:|--:|--:|--:|--:|')

    const totals = { killed: 0, timeout: 0, survived: 0, noCov: 0, errors: 0 }
    for (const r of rows) {
      if (r.state !== 'ok') {
        lines.push(`| ${r.mod} | _${r.state}_ | | | | | |`)
        if (r.error) unreadable.push(`${r.mod}: ${r.error}`)
        continue
      }
      lines.push(
        `| ${r.mod} | ${r.score.toFixed(1)}% | ${r.counts.killed} | ${r.counts.timeout} | ${r.counts.survived} | ${r.counts.noCov} | ${r.counts.errors} |`,
      )
      for (const k of Object.keys(totals)) totals[k] += r.counts[k]
    }

    const totalScored = totals.killed + totals.timeout + totals.survived
    const totalScore = totalScored > 0 ? ((totals.killed + totals.timeout) / totalScored) * 100 : 0
    // "All MUTATED modules", not "All modules" (#3691). The row totals the
    // rows above it and nothing else — in the diff-scoped lane those are the
    // enrolled modules this PR happened to touch, typically one. Labelled
    // "All modules" it read as a statement about the whole diff, so a PR that
    // added ~46 lines of unenrolled logic plus a two-line constant carried a
    // bold **100%** under "All modules" with "No surviving mutants" (#3685).
    // The label is the cheap half of the fix; `select-mutation-modules.mjs`
    // renders the fraction of the diff that drew no mutation signal in the
    // paragraph directly above this table.
    lines.push(
      `| **All mutated modules** | **${totalScore.toFixed(1)}%** | ${totals.killed} | ${totals.timeout} | ${totals.survived} | ${totals.noCov} | ${totals.errors} |`,
    )

    const withSurvivors = rows.filter((r) => r.survivors.length > 0)
    if (withSurvivors.length === 0) {
      lines.push('', '_No surviving mutants._')
      return
    }

    lines.push(
      '',
      '### Surviving mutants — triage into test gaps',
      '',
      `_${totals.survived} survivor(s) across ${withSurvivors.length} of ${rows.length} module(s), worst first. Survivors are triage signal and never gate anything; only the lane-liveness guard (\`scripts/check-mutation-reports.mjs\`) can fail a mutation job._`,
      '',
    )
    for (const r of withSurvivors) {
      lines.push(
        '<details>',
        `<summary><strong>${r.mod}</strong> — ${r.survivors.length} survivor(s), ${r.score.toFixed(1)}% covered score</summary>`,
        '',
        '```',
        ...r.survivors.map((s) => `${s.file}:${s.line} [${s.mutator}]`),
        '```',
        '',
        '</details>',
        '',
      )
    }
  }

  try {
    render()
  } catch (err) {
    // Last resort: emit what the table already had rather than dying and
    // leaving the run with no summary at all.
    lines.push(
      '',
      `_Summary rendering aborted: ${err && err.message}. The lane-liveness guard step is the authoritative signal._`,
    )
  }

  if (unreadable.length > 0) {
    lines.push(
      '',
      `### ${unreadable.length} unreadable report(s)`,
      '',
      '_Invalid or truncated `mutation.json` — the lane-liveness guard fails the job for this; these are the details._',
      '```',
      ...unreadable,
      '```',
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  let reportsDir = DEFAULT_REPORTS_DIR
  let title = DEFAULT_TITLE
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reports-dir') reportsDir = argv[++i]
    else if (argv[i] === '--title') title = argv[++i]
    else {
      console.error(`unknown argument: ${argv[i]}`)
      process.exit(2)
    }
    if (argv[i] === undefined) {
      console.error('missing value for the last argument')
      process.exit(2)
    }
  }
  console.log(renderMutationSummary({ reportsDir, title }))
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is a
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run
// nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2))
}
