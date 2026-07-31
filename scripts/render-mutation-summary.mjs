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
//   node scripts/render-mutation-summary.mjs --self-test
//
// Exit: 0 always (see above), except 2 for bad usage / self-test failure.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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
    lines.push(
      `| **All modules** | **${totalScore.toFixed(1)}%** | ${totals.killed} | ${totals.timeout} | ${totals.survived} | ${totals.noCov} | ${totals.errors} |`,
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

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'mutation-summary-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  const write = (root, mod, mutants) => {
    mkdirSync(join(root, mod), { recursive: true })
    writeFileSync(
      join(root, mod, 'mutation.json'),
      JSON.stringify({ files: { [`src/${mod}.ts`]: { mutants } } }),
      'utf8',
    )
  }
  const mutant = (status, line) => ({
    id: String(line),
    status,
    mutatorName: 'ConditionalExpression',
    location: { start: { line } },
  })

  try {
    // 1. RISK ORDER. The alphabetically-first module is the healthy one and
    //    the alphabetically-last is the worst; if the ordering regressed to
    //    readdir order this flips. This is the whole readability claim.
    const tree = join(tmp, 'ordered')
    write(tree, 'aaa-healthy', [mutant('Killed', 1), mutant('Killed', 2)])
    write(tree, 'mmm-mid', [mutant('Killed', 1), mutant('Survived', 2)])
    write(tree, 'zzz-worst', [mutant('Survived', 1), mutant('Survived', 2), mutant('Killed', 3)])
    const rows = analyzeReportTree(tree)
    if (rows.map((r) => r.mod).join(',') === 'zzz-worst,mmm-mid,aaa-healthy')
      ok('modules are ordered worst-first, not alphabetically (#3350)')
    else
      fail(
        'modules are ordered worst-first, not alphabetically (#3350)',
        rows.map((r) => r.mod).join(','),
      )

    // 2. NO-DATA FIRST. A module with no report outranks any survivor count:
    //    "we do not know" is worse news than "we know it is bad".
    const mixed = join(tmp, 'mixed')
    write(mixed, 'zzz-worst', [mutant('Survived', 1), mutant('Survived', 2)])
    mkdirSync(join(mixed, 'aaa-absent'), { recursive: true })
    const mixedRows = analyzeReportTree(mixed)
    if (mixedRows[0].mod === 'aaa-absent' && mixedRows[0].state === 'no report')
      ok('a module with no report is ranked above the worst-scoring one (#3350)')
    else
      fail(
        'a module with no report is ranked above the worst-scoring one (#3350)',
        JSON.stringify(mixedRows.map((r) => [r.mod, r.state])),
      )

    // 3. GROUPING. Each module's survivors appear under that module's own
    //    heading, and the module name is not repeated on every line.
    const md = renderMutationSummary({ reportsDir: tree })
    if (
      md.includes('<summary><strong>zzz-worst</strong> — 2 survivor(s)') &&
      md.includes('<summary><strong>mmm-mid</strong> — 1 survivor(s)') &&
      md.indexOf('zzz-worst</strong>') < md.indexOf('mmm-mid</strong>')
    )
      ok('survivors are grouped per module, worst group first (#3350)')
    else fail('survivors are grouped per module, worst group first (#3350)', md)

    // 4. CANNOT FAIL — truncated JSON. This is exactly the state the liveness
    //    guard exists to catch, and #3360's finding was that the summary died
    //    alongside it and took the diagnosis with it.
    const broken = join(tmp, 'broken')
    write(broken, 'good', [mutant('Killed', 1)])
    mkdirSync(join(broken, 'bad'), { recursive: true })
    writeFileSync(join(broken, 'bad', 'mutation.json'), '{"files": {', 'utf8')
    const brokenMd = renderMutationSummary({ reportsDir: broken })
    if (
      brokenMd.includes('| bad | _unreadable_ |') &&
      brokenMd.includes('| good |') &&
      brokenMd.includes('unreadable report(s)')
    )
      ok('a truncated report becomes a row plus a quoted error, not a crash (#3360)')
    else fail('a truncated report becomes a row plus a quoted error, not a crash (#3360)', brokenMd)

    // 5. CANNOT FAIL — structurally hostile but valid JSON. `files.x = null`
    //    is the shape that throws past every `?? {}` guard; the render must
    //    still return a string carrying the diagnosis.
    const hostile = join(tmp, 'hostile')
    mkdirSync(join(hostile, 'weird'), { recursive: true })
    writeFileSync(join(hostile, 'weird', 'mutation.json'), '{"files": {"a": 7}}', 'utf8')
    let hostileMd = null
    let threw = null
    try {
      hostileMd = renderMutationSummary({ reportsDir: hostile })
    } catch (err) {
      threw = err
    }
    if (!threw && typeof hostileMd === 'string' && hostileMd.length > 0)
      ok('a structurally hostile report does not throw out of the renderer (#3360)')
    else
      fail(
        'a structurally hostile report does not throw out of the renderer (#3360)',
        threw ? threw.message : String(hostileMd),
      )

    // 5b. …and the last-resort catch is genuinely reachable, not decorative.
    //     A reports "directory" that is actually a file makes `readdirSync`
    //     throw ENOTDIR from inside `render()`, past every data-shape guard.
    //     If this ever stops producing the aborted-rendering note, the catch
    //     has been optimised into a no-op.
    const notADir = join(tmp, 'not-a-dir')
    writeFileSync(notADir, 'x', 'utf8')
    let notADirMd = null
    let notADirThrew = null
    try {
      notADirMd = renderMutationSummary({ reportsDir: notADir })
    } catch (err) {
      notADirThrew = err
    }
    if (!notADirThrew && notADirMd.includes('Summary rendering aborted'))
      ok('an unexpected throw is caught and the partial table still flushes (#3360)')
    else
      fail(
        'an unexpected throw is caught and the partial table still flushes (#3360)',
        notADirThrew ? notADirThrew.message : String(notADirMd),
      )

    // 6. A missing reports root renders the crash note rather than an empty
    //    table that reads like a clean run.
    const absentMd = renderMutationSummary({ reportsDir: join(tmp, 'does-not-exist') })
    if (absentMd.includes('No reports produced')) ok('a missing reports root says so explicitly')
    else fail('a missing reports root says so explicitly', absentMd)

    // 7. A clean tree says "no surviving mutants" rather than rendering an
    //    empty survivors section that reads as truncation.
    const clean = join(tmp, 'clean')
    write(clean, 'good', [mutant('Killed', 1)])
    const cleanMd = renderMutationSummary({ reportsDir: clean })
    if (cleanMd.includes('_No surviving mutants._') && !cleanMd.includes('<details>'))
      ok('a clean run renders an explicit zero, not an empty section')
    else fail('a clean run renders an explicit zero, not an empty section', cleanMd)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is a
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run
// nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) runSelfTest()
  else main(argv)
}
