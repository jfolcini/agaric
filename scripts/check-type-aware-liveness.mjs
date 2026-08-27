#!/usr/bin/env node
// #4408 — liveness guard + step-summary renderer for the `type-aware-lint`
// lane in `.github/workflows/scheduled-deep-checks.yml`.
//
// ─── Why this exists ─────────────────────────────────────────────────────────
//
// That lane is REPORTING-ONLY: `oxlint --type-aware` currently reports
// hundreds of pre-existing findings, and failing the job on them would make
// the lane permanently red and therefore ignored. But a step that cannot fail
// on its content is a step that can silently stop running altogether — the
// exact bug #3330 found in `mutants-frontend`, where a `|| true` ate a total
// StrykerJS crash and a crashed run rendered identically to a perfect one.
// This script is the direct analogue of that lane's fix
// (`scripts/check-mutation-reports.mjs`): it fails ONLY on lane liveness,
// never on how many findings the lint reported.
//
// ─── Why the exit code cannot be the signal (measured, not assumed) ──────────
//
// The obvious design is "exit 1 means it worked, since --type-aware exits 1
// when findings exist". That is wrong, and only measuring showed it. Every
// one of these exits 1, against oxlint 1.79.0:
//
//   * found error-severity findings          → 1   (the state we want)
//   * `oxlint-tsgolint` not installed        → 1   ("Failed to find tsgolint
//                                                    executable…")
//   * an unknown flag (e.g. a renamed one)   → 1
//   * a config the linter rejects            → 1
//   * a path that does not exist             → 1
//
// So the exit code carries almost no information beyond "not 0", and keying
// the lane's health on it would be a deny-list that fails OPEN: every future
// breakage lands in the same bucket as success.
//
// What DOES separate them is the report body. With `-f json` a run that
// reached the linting stage emits an envelope — `diagnostics`,
// `number_of_files`, `number_of_rules`, `start_time` — and every failure mode
// above emits a bare error line and no JSON at all. So this guard classifies
// POSITIVELY: it enumerates the states known to mean "the lane ran", and
// anything not on that list is broken. A deny-list of known failures would
// wave through the failure nobody has thought of yet.
//
// ─── The canary, and why a parseable envelope is not enough ──────────────────
//
// A valid envelope proves oxlint ran. It does not prove the TYPE-AWARE half
// ran: if `--type-aware` ever degrades to a no-op (flag renamed, backend
// silently skipped), oxlint still emits a perfectly well-formed syntax-only
// report and exits 0. That is the same silent-degradation shape as the
// missing binary, one level subtler.
//
// So the guard also runs a CANARY: a fixture generated at run time whose only
// content is a floating promise — a violation no syntax-only pass can see,
// because deciding it needs the type of the call's return value. If the
// type-aware backend is engaged, the canary reports
// `typescript(no-floating-promises)`; if it is not, the canary reports
// nothing and this guard fails.
//
// The canary is deliberately independent of the repo's own findings, so it
// keeps working all the way through the burn-down — including the end state
// where the repo reports zero type-aware findings and the envelope alone
// would be indistinguishable from a dead backend.
//
// NOTE the canary must run with the repo root as CWD. oxlint resolves the
// tsgolint binary from the working directory's `node_modules`, not from its
// own location: the identical invocation from a temp dir outside the repo
// fails with "Failed to find tsgolint executable" even when the binary is
// installed. Measured, not assumed. Hence the fixture is written INSIDE the
// repo tree (under the lane's gitignored `reports/type-aware/`) and removed
// afterwards.
//
// ─── Why the renderer lives here too ─────────────────────────────────────────
//
// The `mutants` lanes split guard (`check-mutation-reports.mjs`) from
// renderer (`render-mutation-summary.mjs`) because two workflows render the
// same shape and the renderer needed to be importable. This lane has ONE call
// site, so the split would buy nothing but another file and another hook.
// What the split actually protects — that the renderer is structurally
// incapable of failing — is a TESTED property in that lane too ("its
// 'cannot fail' property is pinned by that script's own fixture suite"), and
// it is tested here: `--summary` catches everything, always exits 0, and
// `selfTestSummaryNeverFails` drives it over malformed, empty, and absent
// reports.
//
// ─── No count is hardcoded ───────────────────────────────────────────────────
//
// Not the 397 findings this lane reports today, not a threshold, not an
// expected number. Every figure in the summary is computed from the report
// that was just produced. A number frozen into a workflow or a guard is a
// number that goes stale and then lies; the burn-down this lane feeds exists
// precisely to move it.
//
// Usage:
//   node scripts/check-type-aware-liveness.mjs --report <file> --exit-code <n>
//   node scripts/check-type-aware-liveness.mjs --summary --report <file>
//   node scripts/check-type-aware-liveness.mjs --self-test
//
// Exit codes: 0 = the lane ran; 2 = the lane did NOT run (or a --self-test
// assertion failed); 3 = UNVERIFIABLE, the guard could not reach a verdict.
// 1 is deliberately unused so node's own exit-1-on-crash cannot be mistaken
// for a verdict — the same discipline as scripts/check-tsgolint-version-pin.mjs.
// `--summary` always exits 0.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPTS_DIR = import.meta.dirname
const REPO_ROOT = join(SCRIPTS_DIR, '..')

export const EXIT_CLEAN = 0
export const EXIT_BROKEN = 2
export const EXIT_UNVERIFIABLE = 3

/** oxlint exit codes that mean "the linter reached the linting stage". */
export const ALLOWED_EXIT_CODES = [0, 1]

/** The canary's rule. Type-aware by construction: no syntax-only pass can
 *  decide it, because it needs the type of the callee's return value. */
export const CANARY_RULE = 'typescript(no-floating-promises)'

export const CANARY_SOURCE = [
  'async function work(): Promise<void> {}',
  'export function run(): void {',
  '  work()',
  '}',
  '',
].join('\n')

export const CANARY_CONFIG = JSON.stringify({
  plugins: ['typescript'],
  rules: { 'typescript/no-floating-promises': 'error' },
})

export class UnverifiableError extends Error {}

const broken = (message) => ({ severity: 'broken', message })
const unverifiable = (message) => ({ severity: 'unverifiable', message })

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

/**
 * The `-f json` envelope, or `null` with the reason why it is not one. Never
 * throws on bad input: "this is not a report" is the verdict, not an error.
 */
export function parseReport(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { report: null, reason: 'the report file is empty' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    const head = text.trim().split('\n')[0].slice(0, 200)
    return {
      report: null,
      reason:
        `the report is not JSON (${err.message}). First line: ${JSON.stringify(head)}. ` +
        'Every known oxlint failure mode — missing tsgolint binary, unknown flag, rejected ' +
        'config, absent path — prints a bare error line like this INSTEAD of a report, and ' +
        'exits 1 exactly as a successful findings run does',
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { report: null, reason: 'the report parsed as JSON but is not an object' }
  }
  return { report: parsed, reason: null }
}

/** The positive envelope shape: what a run that actually linted looks like. */
export function checkEnvelope(report) {
  const problems = []
  if (!Array.isArray(report.diagnostics)) {
    problems.push('`diagnostics` is missing or not an array')
  }
  for (const key of ['number_of_files', 'number_of_rules']) {
    const v = report[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      problems.push(
        `\`${key}\` is missing, not a finite number, or not > 0 (got ${JSON.stringify(v)})`,
      )
    }
  }
  return problems
}

export function countBySeverity(report) {
  const counts = {}
  for (const d of report.diagnostics ?? []) {
    const s = typeof d?.severity === 'string' ? d.severity : 'unknown'
    counts[s] = (counts[s] ?? 0) + 1
  }
  return counts
}

export function countByRule(report) {
  const counts = new Map()
  for (const d of report.diagnostics ?? []) {
    const code = typeof d?.code === 'string' ? d.code : '(no code)'
    const prev = counts.get(code)
    if (prev) prev.count += 1
    else counts.set(code, { code, count: 1, severity: d?.severity ?? 'unknown' })
  }
  // `toSorted`, not `sort`: `unicorn/no-array-sort` is an error in this repo,
  // and the spread-into-object form `.map(([k, v]) => ({ k, ...v }))` trips
  // `oxc/no-map-spread`. Both caught by the lane this very script guards.
  return [...counts.values()].toSorted((a, b) => b.count - a.count || a.code.localeCompare(b.code))
}

/**
 * oxlint exits 1 iff at least one ERROR-severity diagnostic was reported —
 * warnings alone leave it at 0 (that is why the plain, warning-only run of
 * this repo exits 0). So exit code and report body must agree; a run that
 * exits 1 while reporting no errors did not fail for the reason it claims.
 */
export function checkExitCodeAgrees(exitCode, report) {
  const errors = countBySeverity(report).error ?? 0
  if (exitCode === 1 && errors === 0) {
    return [
      'oxlint exited 1 but the report contains no error-severity diagnostic. ' +
        'Exit 1 means "at least one error was reported" — an exit 1 with an empty error set ' +
        'means the run failed for some OTHER reason while still emitting an envelope',
    ]
  }
  if (exitCode === 0 && errors > 0) {
    return [
      `oxlint exited 0 while reporting ${errors} error-severity diagnostic(s) — ` +
        'the exit code and the report disagree, so one of them is not describing this run',
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// The canary
// ---------------------------------------------------------------------------

/**
 * Runs `oxlint --type-aware` over a generated floating-promise fixture and
 * returns its parsed report. Throws `UnverifiableError` when the probe could
 * not be set up at all (as opposed to running and finding nothing, which is a
 * verdict this returns normally).
 */
export function runCanary({ repoRoot = REPO_ROOT, run = defaultRunOxlint } = {}) {
  const binary = join(repoRoot, 'node_modules', '.bin', 'oxlint')
  if (!existsSync(binary)) {
    throw new UnverifiableError(
      `no oxlint binary at ${binary} — dependencies are not installed, so the canary cannot say ` +
        'whether the type-aware backend works',
    )
  }
  // Inside the repo tree on purpose: oxlint resolves tsgolint from the CWD's
  // node_modules, so a fixture in the system temp dir cannot find it.
  const parent = join(repoRoot, 'reports', 'type-aware')
  let dir
  try {
    mkdirSync(parent, { recursive: true })
    dir = mkdtempSync(join(parent, 'canary-'))
    writeFileSync(join(dir, 'canary.ts'), CANARY_SOURCE, 'utf8')
    writeFileSync(join(dir, 'oxlintrc.json'), CANARY_CONFIG, 'utf8')
  } catch (err) {
    throw new UnverifiableError(`could not create the canary fixture: ${err.message}`)
  }
  try {
    const stdout = run({
      binary,
      cwd: repoRoot,
      args: [
        '--type-aware',
        '--no-ignore',
        '-c',
        join(dir, 'oxlintrc.json'),
        '-f',
        'json',
        join(dir, 'canary.ts'),
      ],
    })
    return parseReport(stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function defaultRunOxlint({ binary, cwd, args }) {
  try {
    return execFileSync(binary, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    // A findings run exits non-zero; its stdout is still the report. Only a
    // total absence of stdout is a real failure to run.
    if (typeof err.stdout === 'string' && err.stdout.trim() !== '') return err.stdout
    throw new UnverifiableError(`the canary invocation produced no output at all: ${err.message}`)
  }
}

/** `[]` when the canary proves the type-aware backend is live. */
export function checkCanary(canaryResult) {
  if (!canaryResult.report) {
    return [
      `the canary produced no parseable report — ${canaryResult.reason}. The canary is a ` +
        'generated floating-promise fixture; if the type-aware backend were live it would ' +
        `report ${CANARY_RULE}`,
    ]
  }
  const fired = (canaryResult.report.diagnostics ?? []).some(
    (d) => typeof d?.code === 'string' && d.code.startsWith('typescript('),
  )
  if (!fired) {
    return [
      `the canary ran but reported no \`typescript(...)\` rule. Its fixture contains an ` +
        `unawaited promise, which ${CANARY_RULE} must flag and which no syntax-only pass can ` +
        'see — so a silent report means `--type-aware` linted without its type-aware backend',
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/** Every liveness problem. Empty means the lane ran. */
export function collectProblems({ exitCode, reportText, canaryResult }) {
  const problems = []
  if (!ALLOWED_EXIT_CODES.includes(exitCode)) {
    problems.push(
      broken(
        `oxlint exited ${exitCode}, which is not one of the codes that mean it reached the ` +
          `linting stage (${ALLOWED_EXIT_CODES.join(', ')}). A crash, an OOM kill, or a step ` +
          'timeout lands here',
      ),
    )
  }
  const { report, reason } = parseReport(reportText)
  if (!report) {
    problems.push(broken(`no usable \`-f json\` report: ${reason}`))
    return problems
  }
  for (const p of checkEnvelope(report)) problems.push(broken(`the report envelope is wrong: ${p}`))
  for (const p of checkExitCodeAgrees(exitCode, report)) problems.push(broken(p))
  for (const p of checkCanary(canaryResult)) problems.push(broken(p))
  return problems
}

export function runGuard({ exitCode, reportPath, canary = runCanary }) {
  let reportText
  try {
    reportText = readFileSync(reportPath, 'utf8')
  } catch (err) {
    return {
      code: EXIT_BROKEN,
      problems: [broken(`the lane wrote no report at ${reportPath}: ${err.message}`)],
    }
  }
  let canaryResult
  try {
    canaryResult = canary()
  } catch (err) {
    if (err instanceof UnverifiableError) {
      return { code: EXIT_UNVERIFIABLE, problems: [unverifiable(err.message)] }
    }
    throw err
  }
  const problems = collectProblems({ exitCode, reportText, canaryResult })
  if (problems.some((p) => p.severity === 'broken')) return { code: EXIT_BROKEN, problems }
  if (problems.length > 0) return { code: EXIT_UNVERIFIABLE, problems }
  const { report } = parseReport(reportText)
  return { code: EXIT_CLEAN, problems, report }
}

// ---------------------------------------------------------------------------
// The summary renderer — structurally incapable of failing
// ---------------------------------------------------------------------------

export function renderSummary(reportText) {
  const lines = ['## Type-aware lint (`oxlint --type-aware`)', '']
  const { report, reason } = parseReport(reportText ?? '')
  if (!report) {
    lines.push(`_No readable report to summarise — ${reason}._`, '')
    lines.push('_The liveness guard step above is the authority on whether this lane ran._', '')
    return lines.join('\n')
  }
  const rules = countByRule(report)
  const total = (report.diagnostics ?? []).length
  lines.push(
    `Linted **${report.number_of_files ?? '?'}** file(s) against ` +
      `**${report.number_of_rules ?? '?'}** registered rule(s); ` +
      `**${total}** finding(s) in total.`,
    '',
  )
  if (rules.length === 0) {
    lines.push('_No findings._', '')
  } else {
    lines.push('| rule | severity | findings |', '|------|----------|---------:|')
    for (const r of rules) lines.push(`| \`${r.code}\` | ${r.severity} | ${r.count} |`)
    lines.push('')
  }
  lines.push(
    '_Reporting only — this lane never fails on the findings above. The `typescript(...)` ' +
      'rules are the ones `--type-aware` adds; the rest are reported by a plain `oxlint` run ' +
      'too. Burn a rule down to zero, then promote it out of the `warn` block in ' +
      '`.oxlintrc.json` so the `correctness` category default makes it an error again — the ' +
      'same ratchet that block already documents for the React Compiler rules._',
    '',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { report: null, exitCode: null, summary: false, selfTest: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--summary') args.summary = true
    else if (argv[i] === '--self-test') args.selfTest = true
    else if (argv[i] === '--report') args.report = argv[(i += 1)]
    else if (argv[i] === '--exit-code') args.exitCode = parseExitCode(argv[(i += 1)])
  }
  return args
}

/**
 * The raw string must LOOK like an integer. `Number('')` is 0, not NaN — so a
 * `--exit-code "$OXLINT_EXIT"` whose variable never got set would otherwise
 * arrive as a perfectly plausible "the linter exited 0, all clean". The
 * workflow reaches this exact shape whenever the analysis step dies between
 * writing its report and appending to `$GITHUB_ENV`, and the liveness step's
 * `if: always()` means it still runs. Fail-open by arithmetic coincidence is
 * precisely what this guard exists to prevent, so anything that is not an
 * integer literal returns null and is reported as unverifiable.
 */
export function parseExitCode(raw) {
  return typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : null
}

export function main(argv) {
  const args = parseArgs(argv)
  if (args.summary) {
    // Never fails, by design. Its own self-test drives it over malformed,
    // empty and absent reports; see the header.
    try {
      console.log(renderSummary(args.report ? readFileSync(args.report, 'utf8') : ''))
    } catch (err) {
      console.log(`## Type-aware lint\n\n_Summary renderer failed: ${err?.message}._\n`)
    }
    return EXIT_CLEAN
  }
  if (args.report === null || !Number.isInteger(args.exitCode)) {
    console.error('usage: check-type-aware-liveness.mjs --report <file> --exit-code <n>')
    return EXIT_UNVERIFIABLE
  }
  const { code, problems, report } = runGuard({
    exitCode: args.exitCode,
    reportPath: args.report,
  })
  if (code === EXIT_CLEAN) {
    const total = (report.diagnostics ?? []).length
    console.log(
      `OK  type-aware lane is live: oxlint exited ${args.exitCode}, linted ` +
        `${report.number_of_files} file(s) against ${report.number_of_rules} rule(s), reported ` +
        `${total} finding(s), and the generated canary fixture still trips its type-aware rule`,
    )
    return code
  }
  console.error(
    `${code === EXIT_BROKEN ? 'FAIL' : 'UNVERIFIABLE'}  the type-aware lane did not run (#4408):`,
  )
  for (const p of problems) console.error(`  - [${p.severity}] ${p.message}`)
  return code
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

// The VERBATIM stdout of `oxlint --type-aware` with `oxlint-tsgolint` absent,
// captured from oxlint 1.79.0. It exits 1 — the same code as a successful
// findings run — which is the whole reason this guard reads the body.
const MISSING_TSGOLINT_STDOUT =
  'Failed to find tsgolint executable. You may need to add the `oxlint-tsgolint` package to your project?\n'

const goodReport = (diagnostics = []) =>
  JSON.stringify({
    diagnostics,
    number_of_files: 3,
    number_of_rules: 84,
    threads_count: 16,
    start_time: 0.1,
  })

const errorDiag = (code) => ({ code, severity: 'error', message: 'x', filename: 'a.ts' })
const warnDiag = (code) => ({ code, severity: 'warning', message: 'x', filename: 'a.ts' })

const liveCanary = () => parseReport(goodReport([errorDiag(CANARY_RULE)]))
const deadCanary = () => parseReport(goodReport([warnDiag('react(refs)')]))

function selfTestParsing({ check }) {
  check(parseReport('').report === null, 'an empty report is not a report', '')
  check(parseReport('   \n').report === null, 'a whitespace-only report is not a report', '')
  const missing = parseReport(MISSING_TSGOLINT_STDOUT)
  check(
    missing.report === null && missing.reason.includes('Failed to find tsgolint'),
    'the VERBATIM missing-tsgolint stdout is rejected, and the reason quotes it back',
    JSON.stringify(missing),
  )
  check(parseReport('[1,2]').report === null, 'a JSON array is not an envelope', '')
  check(parseReport(goodReport()).report !== null, 'a real envelope parses', '')
}

function selfTestEnvelope({ check }) {
  check(checkEnvelope(JSON.parse(goodReport())).length === 0, 'a good envelope has no problems', '')
  check(
    checkEnvelope({ number_of_files: 3, number_of_rules: 84 }).length === 1,
    'a missing `diagnostics` array is caught',
    '',
  )
  check(
    checkEnvelope({ diagnostics: [], number_of_files: 0, number_of_rules: 84 }).length === 1,
    'zero files linted is caught — an empty run is not a passing run',
    '',
  )
  check(
    checkEnvelope({ diagnostics: [], number_of_files: 3, number_of_rules: 0 }).length === 1,
    'zero rules registered is caught',
    '',
  )
}

function selfTestExitCodeAgreement({ check }) {
  const withError = JSON.parse(goodReport([errorDiag('typescript(no-floating-promises)')]))
  const warningsOnly = JSON.parse(goodReport([warnDiag('react(refs)')]))
  check(checkExitCodeAgrees(1, withError).length === 0, 'exit 1 with an error agrees', '')
  check(checkExitCodeAgrees(0, warningsOnly).length === 0, 'exit 0 with warnings only agrees', '')
  check(
    checkExitCodeAgrees(1, warningsOnly).length === 1,
    'exit 1 with NO error-severity finding is caught — it failed for another reason',
    '',
  )
  check(
    checkExitCodeAgrees(0, withError).length === 1,
    'exit 0 while reporting errors is caught',
    '',
  )
}

function selfTestCounting({ check }) {
  const report = JSON.parse(
    goodReport([errorDiag('typescript(a)'), errorDiag('typescript(a)'), warnDiag('react(b)')]),
  )
  const byRule = countByRule(report)
  check(
    byRule[0].code === 'typescript(a)' && byRule[0].count === 2 && byRule[1].count === 1,
    'countByRule groups and sorts worst-first',
    JSON.stringify(byRule),
  )
  const bySeverity = countBySeverity(report)
  check(
    bySeverity.error === 2 && bySeverity.warning === 1,
    'countBySeverity splits error from warning',
    JSON.stringify(bySeverity),
  )
}

function selfTestCanaryClassification({ check }) {
  check(checkCanary(liveCanary()).length === 0, 'a canary that trips a typescript rule passes', '')
  check(
    checkCanary(deadCanary()).length === 1,
    'a canary that reports only NON-type-aware rules is caught — the backend degraded silently',
    '',
  )
  check(
    checkCanary(parseReport(goodReport([]))).length === 1,
    'a canary that reports nothing at all is caught, not read as clean',
    '',
  )
  check(
    checkCanary(parseReport(MISSING_TSGOLINT_STDOUT)).length === 1,
    'a canary whose invocation printed the missing-binary line is caught',
    '',
  )
}

function selfTestPositiveClassification({ check }) {
  // The single most important case: the missing-binary state, which exits 1
  // exactly like success and would sail through any exit-code-based check.
  const problems = collectProblems({
    exitCode: 1,
    reportText: MISSING_TSGOLINT_STDOUT,
    canaryResult: liveCanary(),
  })
  check(
    problems.length === 1 && problems[0].severity === 'broken',
    'exit code 1 + the missing-tsgolint stdout is BROKEN, though exit 1 also means success',
    JSON.stringify(problems),
  )
  check(
    collectProblems({
      exitCode: 1,
      reportText: goodReport([errorDiag('typescript(no-floating-promises)')]),
      canaryResult: liveCanary(),
    }).length === 0,
    'the real lane shape — exit 1, envelope, findings, live canary — is clean',
    '',
  )
  check(
    collectProblems({
      exitCode: 0,
      reportText: goodReport([]),
      canaryResult: liveCanary(),
    }).length === 0,
    'the END state of the burn-down — exit 0, ZERO findings, live canary — is still clean',
    '',
  )
  check(
    collectProblems({
      exitCode: 0,
      reportText: goodReport([]),
      canaryResult: deadCanary(),
    }).length === 1,
    'zero findings with a DEAD canary is broken — this is what the canary exists for',
    '',
  )
  for (const code of [2, 101, 124, 137, -1]) {
    check(
      collectProblems({
        exitCode: code,
        reportText: goodReport([]),
        canaryResult: liveCanary(),
      }).some((p) => p.message.includes(`exited ${code}`)),
      `exit code ${code} is not on the allow-list and is reported as broken`,
      '',
    )
  }
}

function selfTestSummaryNeverFails({ check }) {
  const inputs = [
    ['an absent report', undefined],
    ['an empty report', ''],
    ['the missing-binary stdout', MISSING_TSGOLINT_STDOUT],
    ['a JSON array', '[1,2,3]'],
    ['truncated JSON', '{"diagnostics": ['],
    ['an envelope with no diagnostics', goodReport([])],
    ['a real envelope', goodReport([errorDiag('typescript(a)'), warnDiag('react(b)')])],
  ]
  for (const [label, input] of inputs) {
    let threw = null
    let out = null
    try {
      out = renderSummary(input)
    } catch (err) {
      threw = err
    }
    check(
      threw === null && typeof out === 'string' && out.length > 0,
      `the summary renderer survives ${label} and still returns markdown`,
      String(threw),
    )
  }
}

function selfTestSummaryCountsAreComputed({ check }) {
  // #4408 explicitly forbids freezing a count into the lane. Prove the
  // rendered numbers track the report rather than a constant.
  const three = renderSummary(
    goodReport([errorDiag('typescript(a)'), errorDiag('typescript(a)'), warnDiag('react(b)')]),
  )
  check(three.includes('**3** finding(s)'), 'the total is computed from the report', three)
  check(
    three.includes('| `typescript(a)` | error | 2 |'),
    'per-rule counts are computed from the report',
    three,
  )
  const one = renderSummary(goodReport([errorDiag('typescript(a)')]))
  check(
    one.includes('**1** finding(s)') && !one.includes('**3** finding(s)'),
    'a DIFFERENT report renders a different total — no count is baked in',
    one,
  )
  check(
    renderSummary(goodReport([])).includes('_No findings._'),
    'an empty report renders as no findings, not as a failure',
    '',
  )
}

function selfTestRunGuard({ check }) {
  // The system temp dir, NOT `<repo>/reports/`: this case stubs the canary,
  // so it has no reason to live inside the repo — and `reports/` is generated,
  // absent on a fresh checkout and in CI. Assuming it existed made this
  // self-test crash with an uncaught ENOENT, which node reports as exit 1 —
  // the one code this script reserves precisely so a crash cannot be read as
  // a verdict. (`runCanary` does need the in-repo path, and mkdir -p's it.)
  const dir = mkdtempSync(join(tmpdir(), 'type-aware-selftest-'))
  try {
    const reportPath = join(dir, 'report.json')
    writeFileSync(reportPath, goodReport([errorDiag('typescript(a)')]), 'utf8')
    check(
      runGuard({ exitCode: 1, reportPath, canary: liveCanary }).code === EXIT_CLEAN,
      'runGuard: a live lane exits 0',
      '',
    )
    check(
      runGuard({ exitCode: 1, reportPath, canary: deadCanary }).code === EXIT_BROKEN,
      'runGuard: a dead canary exits 2',
      '',
    )
    check(
      runGuard({ exitCode: 1, reportPath: join(dir, 'nope.json'), canary: liveCanary }).code ===
        EXIT_BROKEN,
      'runGuard: a lane that wrote no report at all exits 2, never 0',
      '',
    )
    const unverifiableCanary = () => {
      throw new UnverifiableError('dependencies are not installed')
    }
    check(
      runGuard({ exitCode: 1, reportPath, canary: unverifiableCanary }).code === EXIT_UNVERIFIABLE,
      'runGuard: a canary that cannot be set up exits 3, distinct from both 0 and 2',
      '',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Runs `fn` with console output suppressed, and returns its value. */
function quietly(fn) {
  const { log, error } = console
  console.log = () => {}
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.log = log
    console.error = error
  }
}

function selfTestExitCodes({ check }) {
  check(
    EXIT_CLEAN === 0 && EXIT_BROKEN === 2 && EXIT_UNVERIFIABLE === 3,
    'exit codes are 0/2/3 — 1 stays reserved for an uncaught crash so the two cannot alias',
    '',
  )
  check(
    parseArgs(['--report', 'r.json', '--exit-code', '1']).exitCode === 1,
    'parseArgs reads --exit-code as a number',
    '',
  )
  check(parseArgs(['--summary']).summary === true, 'parseArgs reads --summary', '')
  for (const bad of ['', '   ', 'null', 'undefined', 'abc', '1.5', '0x1']) {
    check(
      parseExitCode(bad) === null,
      `--exit-code ${JSON.stringify(bad)} is rejected, not coerced (Number('') is 0, not NaN)`,
      String(parseExitCode(bad)),
    )
  }
  check(parseExitCode('0') === 0 && parseExitCode('137') === 137, 'a real exit code parses', '')
  check(
    quietly(() => main(['--report', join(REPO_ROOT, 'package.json'), '--exit-code', ''])) ===
      EXIT_UNVERIFIABLE,
    'an EMPTY --exit-code is unverifiable (3), never a silent "exited 0, all clean"',
    '',
  )
  // `main()` is the real entry point, so these two drive it rather than the
  // helpers underneath. Its own reporting is muted so a PASSING self-test does
  // not print a scary "the lane did not run" block a reader would misread.
  check(
    quietly(() =>
      main(['--report', join(REPO_ROOT, 'no-such-report.json'), '--exit-code', '1']),
    ) === EXIT_BROKEN,
    'main() over an absent report returns 2, not 0',
    '',
  )
  check(
    quietly(() => main(['--summary', '--report', join(REPO_ROOT, 'nope.json')])) === EXIT_CLEAN,
    'main() --summary over an absent report still returns 0',
    '',
  )
  check(
    quietly(() => main(['--report', join(REPO_ROOT, 'nope.json')])) === EXIT_UNVERIFIABLE,
    'main() with no --exit-code is a usage error, reported as unverifiable (3)',
    '',
  )
}

function selfTestRealCanary({ check, fail }) {
  // The real thing, against this repo's real installed toolchain. This is the
  // assertion that would have failed before `oxlint-tsgolint` was added.
  let result
  try {
    result = runCanary()
  } catch (err) {
    if (err instanceof UnverifiableError) {
      console.log(`  skip - the real canary (${err.message})`)
      return
    }
    fail('the real canary runs', err.message)
    return
  }
  const problems = checkCanary(result)
  check(
    problems.length === 0,
    `the REAL canary trips ${CANARY_RULE} against this repo's installed oxlint + tsgolint`,
    problems.join(' | '),
  )
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok  - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const check = (cond, name, detail) => (cond ? ok(name) : fail(name, detail))

  selfTestParsing({ check })
  selfTestEnvelope({ check })
  selfTestExitCodeAgreement({ check })
  selfTestCounting({ check })
  selfTestCanaryClassification({ check })
  selfTestPositiveClassification({ check })
  selfTestSummaryNeverFails({ check })
  selfTestSummaryCountsAreComputed({ check })
  selfTestRunGuard({ check })
  selfTestExitCodes({ check })
  selfTestRealCanary({ check, fail })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    return EXIT_BROKEN
  }
  console.log('self-test: all assertions passed')
  return EXIT_CLEAN
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  const argv = process.argv.slice(2)
  process.exit(argv.includes('--self-test') ? runSelfTest() : main(argv))
}
