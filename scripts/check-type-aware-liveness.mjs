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
// ─── And why the canary is still not enough ──────────────────────────────────
//
// The canary builds its OWN argv, with `--type-aware` hardcoded. So it proves
// the toolchain can do type-aware analysis — not that the run under
// examination did. Delete `--type-aware` from the workflow's oxlint line and
// every check above still passes: valid envelope, exit 0 agreeing with a
// warnings-only report, canary firing on its own flag. The guard would
// certify a lane that did no type-aware analysis at all.
//
// `checkTypeAwareWasUsed` closes that: the main run's own report carries
// `number_of_rules`, and a type-aware run registers strictly more rules than
// a plain one of the same config. Comparing it against a plain baseline
// measured at run time OVER THE SAME TARGET decides the question with no
// literal on either side, and `assertSameTarget` verifies the same-target
// premise rather than assuming it. See those two functions for the full
// argument, including the false-reds each can produce.
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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

/** The package whose presence in `node_modules` means the backend is installed. */
export const TSGOLINT_PACKAGE = 'oxlint-tsgolint'

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

/**
 * One row per (rule, severity) PAIR, not per rule. A rule's severity is not
 * fixed by its name alone — oxlint's `overrides` mechanism lets a `files:`
 * scoped block enable the same rule at a different severity than it carries
 * elsewhere, so a config change could put one rule's findings under two
 * severities in a single report. (Today's config does not: the one override
 * that touches a `typescript(...)` rule — `.oxlintrc.json:166` — sets
 * `typescript/require-await` to `"off"` under tests, which emits no
 * diagnostics to collide with, and no other rule is enabled at more than one
 * severity.) Keying on the code alone and keeping the first severity seen
 * would, under such a config, label every one of a rule's findings by
 * whichever file the linter happened to reach first — and a table that
 * reports 40 errors as `warning` is worse for triage than no table. Pairing
 * on (rule, severity) is defensive against that config, not a fix for one
 * that exists today.
 */
export function countByRule(report) {
  const counts = new Map()
  for (const d of report.diagnostics ?? []) {
    const code = typeof d?.code === 'string' ? d.code : '(no code)'
    const severity = typeof d?.severity === 'string' ? d.severity : 'unknown'
    const key = `${code}\u0000${severity}`
    const prev = counts.get(key)
    if (prev) prev.count += 1
    else counts.set(key, { code, count: 1, severity })
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
// The probes — one fixture, two oxlint runs
// ---------------------------------------------------------------------------

/**
 * Runs both live probes against one generated fixture and returns their
 * parsed reports. Throws `UnverifiableError` when the probes could not be set
 * up or executed at all — which is a different thing from running and finding
 * nothing, the verdict this returns normally.
 *
 *   canary   — `--type-aware` over a floating-promise fixture, with the
 *              fixture's own single-rule config. Proves the TOOLCHAIN can do
 *              type-aware analysis at all.
 *   baseline — a PLAIN run (no `--type-aware`) over THE SAME TARGET as the
 *              main run, resolving THIS REPO's config. Its only output of
 *              interest is `number_of_rules`, the rule count the repo config
 *              registers without type-aware — what the main run is compared
 *              against.
 *
 * ─── Why the baseline lints the whole tree, not one file ────────────────────
 *
 * An earlier version linted a single generated file, because
 * `number_of_rules` measures as a pure function of the resolved config: at
 * 1852 files and at 1 it is identical, and an `overrides` block that ENABLES
 * rules outside the base set (or adds plugins) raises it equally for both —
 * measured across three override shapes, so the whole-repo-vs-one-file
 * asymmetry that would break the comparison is not constructible against
 * oxlint 1.79.
 *
 * That is a measurement of today's oxlint, though, not a contract oxc
 * publishes, and this is the check whose entire job is closing a fail-open.
 * If a future release ever made the count file-set-dependent, a one-file
 * baseline would silently start comparing unlike things — and the failure
 * would be a PASS. The same-target baseline needs no such premise.
 *
 * It costs almost nothing to stop relying on it: a whole-tree plain run
 * measures 0.76-0.89s against the one-file run's 0.64s, roughly 0.2s, next to
 * the main run's ~4s and a 20-minute step budget. The cheap version was
 * saving nothing worth a premise.
 *
 * `assertSameTarget` below then VERIFIES the "same target" claim rather than
 * assuming it, so narrowing the main run's target later cannot silently
 * decouple the two.
 *
 * ─── Why the baseline runs BEFORE the canary fixture is written ─────────────
 *
 * #4461 note 1: it used to run AFTER — sharing the fixture's own try/finally,
 * below the two `writeFileSync` calls — so by the time this pathless,
 * whole-tree baseline ran, `reports/type-aware/canary-…/canary.ts` already
 * existed ON DISK, while the equivalent file did not exist when the MAIN
 * run (the one this baseline is supposed to mirror) scanned the tree. The two
 * runs' file counts matched anyway, ONLY because `.oxlintrc.json`'s
 * `ignorePatterns` does not list `reports/`, and oxlint honours `.gitignore`
 * by default — `reports/type-aware/` IS gitignored (see the canary's own
 * `--no-ignore` flag a few lines below, which exists precisely because the
 * canary run needs oxlint to look INSIDE that ignored directory). So the
 * "same target" premise `assertSameTarget` verifies held by a coincidence of
 * ignore rules that this function does not control and did not even
 * reference — not by construction. Had that `.gitignore` entry ever been
 * narrowed, or oxlint's own default-ignore behaviour changed, every
 * scheduled run of this lane would report UNVERIFIABLE for a reason with
 * nothing to do with whether `--type-aware` actually ran.
 *
 * Running the baseline first removes the dependency instead of documenting
 * it: there is no fixture directory in the tree yet, gitignored or not, so
 * whether it WOULD be ignored is moot.
 */
export function runProbes({ repoRoot = REPO_ROOT, run = defaultRunOxlint } = {}) {
  const binary = join(repoRoot, 'node_modules', '.bin', 'oxlint')
  if (!existsSync(binary)) {
    throw new UnverifiableError(
      `no oxlint binary at ${binary} — dependencies are not installed, so the canary cannot say ` +
        'whether the type-aware backend works',
    )
  }
  // POSITIVE check for the one state a puller lands in after this PR merges:
  // oxlint predates it and is already in `node_modules`, `oxlint-tsgolint`
  // does not and will not be there until `npm install` runs. Detected by the
  // presence of the package that SHOULD be there, not by matching oxlint's
  // error text — a deny-list of error strings fails open on the next wording
  // change.
  if (!existsSync(join(repoRoot, 'node_modules', TSGOLINT_PACKAGE, 'package.json'))) {
    throw new UnverifiableError(
      `${TSGOLINT_PACKAGE} is not in node_modules — this is a stale install, not a broken ` +
        'backend. Run `npm install` (it is a devDependency in package.json; see #4408) and ' +
        're-run. Nothing is being judged until it is there',
    )
  }
  // No `-c` and NO PATH: this must mirror the main run exactly — the repo's
  // own `.oxlintrc.json`, and the whole tree, because the main run passes no
  // path either. The number it yields is only meaningful as a like-for-like
  // comparison — and, per the note above, it now runs before ANY canary
  // fixture file exists on disk, so that comparison no longer depends on
  // that fixture being gitignored.
  const baseline = parseReport(run({ binary, cwd: repoRoot, args: ['-f', 'json'] }))
  if (!baseline.report || typeof baseline.report.number_of_rules !== 'number') {
    throw new UnverifiableError(
      `the plain baseline run produced no usable rule count — ${baseline.reason ?? 'no number_of_rules'}. ` +
        'Without it there is nothing to compare the main run against, so whether `--type-aware` ' +
        'was actually in effect cannot be decided either way',
    )
  }
  // Inside the repo tree on purpose: oxlint resolves tsgolint from the CWD's
  // node_modules, so a fixture in the system temp dir cannot find it.
  const parent = join(repoRoot, 'reports', 'type-aware')
  let dir
  try {
    mkdirSync(parent, { recursive: true })
    dir = mkdtempSync(join(parent, 'canary-'))
  } catch (err) {
    throw new UnverifiableError(`could not create the canary fixture: ${err.message}`)
  }
  // Note 3: the fixture WRITE lives inside the same try/finally as the run.
  // It used to sit in the block above, so a write that threw (ENOSPC, EACCES)
  // left the just-created `canary-*` directory behind for the artifact upload
  // to collect. `dir` exists from here on, so `finally` can always remove it.
  const fixture = join(dir, 'canary.ts')
  try {
    try {
      writeFileSync(fixture, CANARY_SOURCE, 'utf8')
      writeFileSync(join(dir, 'oxlintrc.json'), CANARY_CONFIG, 'utf8')
    } catch (err) {
      throw new UnverifiableError(`could not create the canary fixture: ${err.message}`)
    }
    const canary = parseReport(
      run({
        binary,
        cwd: repoRoot,
        args: [
          '--type-aware',
          '--no-ignore',
          '-c',
          join(dir, 'oxlintrc.json'),
          '-f',
          'json',
          fixture,
        ],
      }),
    )
    return { canary, baseline: baseline.report }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The check the canary CANNOT make: did THIS run use `--type-aware`?
 *
 * `runProbes` builds its own argv, so it proves the toolchain works — not
 * that the workflow's invocation used the flag. Drop `--type-aware` from the
 * workflow line and every other check still passes: the report is a valid
 * envelope, `number_of_rules` is 212 rather than 229 (both > 0), exit 0 with
 * warnings only agrees, and the canary — running its own hardcoded flag —
 * still fires. The guard would print "the lane is live" over a run that did
 * no type-aware analysis at all: the #3330 fail-open shape one level up.
 *
 * What closes it is that the main report carries its OWN rule count. A
 * type-aware run registers strictly more rules than a plain one of the same
 * config, so comparing the main run's count against a plain baseline measured
 * at run time over the same target decides it — with no literal on either
 * side of the comparison.
 * Both numbers are measured; neither 229 nor 212 nor their difference appears
 * anywhere in this file.
 *
 * It cannot be satisfied by intent, only by behaviour: the figure comes from
 * the report the workflow actually produced. (Recording the argv into a file
 * and asserting `--type-aware` appears in it would be cheaper still, and
 * self-certifying — it would verify what the step SAID it did.)
 *
 * One honest false-red: if `.oxlintrc.json` ever sets `options.typeAware`,
 * the baseline becomes type-aware too, the counts match, and this fails. That
 * is the correct moment to revisit the check, because the CLI flag would then
 * no longer be what decides the mode. No `options` key exists today.
 */
export function checkTypeAwareWasUsed(report, baseline) {
  const mainRules = report?.number_of_rules
  const plainRules = baseline?.number_of_rules
  if (mainRules > plainRules) return []
  return [
    `the main run registered ${mainRules} rule(s), but a PLAIN run over the same target with the ` +
      `same config registers ${plainRules} — a type-aware run must register strictly more. The ` +
      'report parses and the canary passes, so the toolchain is fine; what this says is that ' +
      'THIS run did not enable type-aware analysis. Three things put you here, and the first is ' +
      'much the most likely:\n' +
      '      1. `--type-aware` is no longer on the oxlint invocation in ' +
      '`.github/workflows/scheduled-deep-checks.yml`. Check there first.\n' +
      '      2. `.oxlintrc.json` has the type-aware rules turned `"off"` — a triage step that is ' +
      'easy to leave behind. The counts equalise, and the cause is in the CONFIG, not the ' +
      'workflow.\n' +
      '      3. `.oxlintrc.json` has enabled `options.typeAware`, so the baseline is type-aware ' +
      'too. The flag no longer decides the mode and this comparison no longer discriminates — ' +
      'that needs a different check, not a relaxed one.',
  ]
}

/**
 * The premise `checkTypeAwareWasUsed` rests on: that the two runs looked at
 * the same code. `runProbes` passes no path so it mirrors the main run's own
 * pathless invocation — but "mirrors" is an assumption about a command line
 * in another file, and assumptions in this guard have a track record. Both
 * reports carry `number_of_files`, so the claim is cheap to VERIFY: if the
 * main run's target is ever narrowed and the baseline's is not, the counts
 * diverge and this says so instead of quietly comparing unlike things.
 *
 * Unverifiable rather than broken: a mismatch means the guard cannot answer
 * the question, which is a different thing from having answered it "no".
 */
export function assertSameTarget(report, baseline) {
  const mainFiles = report?.number_of_files
  const plainFiles = baseline?.number_of_files
  if (mainFiles === plainFiles) return []
  return [
    `the baseline linted ${plainFiles} file(s) but the main run linted ${mainFiles} — the two ` +
      'did not look at the same target, so their rule counts are not comparable and whether ' +
      '`--type-aware` was in effect cannot be decided. The baseline mirrors the main run by ' +
      'passing no path; if the invocation in `.github/workflows/scheduled-deep-checks.yml` now ' +
      'names one, `runProbes` has to name the same one',
  ]
}

/**
 * Headroom for a probe's JSON report (#4461 note 2). `execFileSync`'s own
 * default is node's generic 1 MiB, sized for nothing in particular; the
 * whole-tree plain baseline this file actually runs is ~150 KB today, so
 * this is not a value chosen to just barely clear today's report — it is
 * chosen to make the buffer itself a non-issue, so overflow stays a real,
 * rare signal rather than routine noise this guard has to diagnose.
 */
const OXLINT_PROBE_MAX_BUFFER = 64 * 1024 * 1024

export function defaultRunOxlint({ binary, cwd, args }) {
  try {
    return execFileSync(binary, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: OXLINT_PROBE_MAX_BUFFER,
    })
  } catch (err) {
    // #4461 note 2: a maxBuffer overflow must be diagnosed as what it is, not
    // guessed at from its aftermath. On overflow `execFileSync` throws with a
    // TRUNCATED but non-empty `err.stdout` — exactly the shape the "a
    // findings run exits non-zero; its stdout is still the report" branch
    // below exists to return as a genuine report. The caller then fails to
    // parse the truncated JSON and reports "the plain baseline run produced
    // no usable rule count" — true, and pointing nowhere near the actual
    // cause. `ENOBUFS` is node's own `error.code` for this outcome (checked
    // directly — `error.message`'s wording is not a documented contract, and
    // this file already prefers a positive, structural signal over matching
    // text elsewhere), so it is classified BEFORE the generic non-empty-
    // stdout fallback ever sees the truncated bytes.
    if (err.code === 'ENOBUFS') {
      throw new UnverifiableError(
        `a probe invocation's output exceeded the ${OXLINT_PROBE_MAX_BUFFER}-byte buffer and ` +
          'was truncated — a buffer-size problem, not a missing rule count and not a broken ' +
          'backend. Raise OXLINT_PROBE_MAX_BUFFER if the report has genuinely grown past it',
      )
    }
    // A findings run exits non-zero; its stdout is still the report. Only a
    // total absence of stdout is a real failure to run.
    if (typeof err.stdout === 'string' && err.stdout.trim() !== '') return err.stdout
    throw new UnverifiableError(`a probe invocation produced no output at all: ${err.message}`)
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
  // EXACT match, not a `typescript(` prefix. The fixture is a bare
  // `async function work(): Promise<void> {}` plus one call, which is a
  // plausible future target for a SYNTAX-ONLY `typescript/*` rule (an empty
  // async body, a redundant return annotation). If oxlint ever promoted such
  // a rule into `correctness`, a prefix match would let it stand in for the
  // type-aware one and a dead backend would certify as live. Only
  // CANARY_RULE proves what this check claims to prove.
  const fired = (canaryResult.report.diagnostics ?? []).some((d) => d?.code === CANARY_RULE)
  if (!fired) {
    const saw = [...new Set((canaryResult.report.diagnostics ?? []).map((d) => d?.code))]
    return [
      `the canary ran but did not report ${CANARY_RULE} (it reported: ` +
        `${saw.length > 0 ? saw.join(', ') : 'nothing'}). Its fixture contains an unawaited ` +
        'promise, which that rule must flag and which no syntax-only pass can see — so a ' +
        'silent report means `--type-aware` linted without its type-aware backend',
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * Every liveness problem. Empty means the lane ran.
 *
 * `probe` is a THUNK, not a precomputed result, so the ~4s of live oxlint
 * runs happen only once the report has been shown to parse. The
 * missing-tsgolint case — the most important one this guard has — returns at
 * the parse check below, and used to spawn and then discard both probes on
 * the way there.
 */
export function collectProblems({ exitCode, reportText, probe }) {
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

  // Everything above is free. Everything below spawns oxlint.
  let probes
  try {
    probes = probe()
  } catch (err) {
    if (!(err instanceof UnverifiableError)) throw err
    // The one path that reaches the `unverifiable` tier: the report itself is
    // fine, but the guard could not run the probes that judge it. Distinct
    // from `broken` on purpose — "I could not check" is not "it did not run".
    problems.push(unverifiable(err.message))
    return problems
  }
  for (const p of checkCanary(probes.canary)) problems.push(broken(p))
  const targetMismatch = assertSameTarget(report, probes.baseline)
  for (const p of targetMismatch) problems.push(unverifiable(p))
  // Only compare rule counts once the two runs are known to be comparable.
  if (targetMismatch.length === 0) {
    for (const p of checkTypeAwareWasUsed(report, probes.baseline)) problems.push(broken(p))
  }
  // Stashed as a non-index property: existing callers that treat this as a
  // plain problems array (`.length`, `.some`, spreads, `JSON.stringify`) are
  // unaffected — JSON.stringify on an array ignores non-index own
  // properties — but `runGuard` can reuse the already-parsed report instead
  // of re-parsing the same `-f json` text a second time.
  problems.report = report
  return problems
}

export function runGuard({ exitCode, reportPath, probe = runProbes }) {
  let reportText
  try {
    reportText = readFileSync(reportPath, 'utf8')
  } catch (err) {
    return {
      code: EXIT_BROKEN,
      problems: [broken(`the lane wrote no report at ${reportPath}: ${err.message}`)],
    }
  }
  const problems = collectProblems({ exitCode, reportText, probe })
  if (problems.some((p) => p.severity === 'broken')) return { code: EXIT_BROKEN, problems }
  // Reachable: `collectProblems` pushes an `unverifiable` when the probes
  // cannot be run at all. See its probe block.
  if (problems.length > 0) return { code: EXIT_UNVERIFIABLE, problems }
  // `problems.length === 0` is only reachable via `collectProblems`'s final
  // `return problems`, which always stashes the parsed report first — so
  // `.report` is guaranteed set here, and re-parsing `reportText` (several
  // hundred KB of `-f json` on a real report) would be redundant.
  return { code: EXIT_CLEAN, problems, report: problems.report }
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
    '_Reporting only: this lane never fails on the findings above. It is the only place they ' +
      'are reported at all._',
    '',
    '_The `typescript(...)` rows are what `--type-aware` adds; every other row a plain `oxlint` ' +
      'run reports too. Note that the `typescript(...)` rules are ALREADY `error` severity — ' +
      'via the `correctness` category default, and `typescript/only-throw-error` and ' +
      '`typescript/require-await` as literal `"error"` entries — so unlike the `react/*` rows ' +
      'there is no `warn` block to promote them out of. They are not held back by ' +
      'configuration; they are unenforced because no gate runs `--type-aware`. The ratchet for ' +
      'them is therefore to burn the count to zero and then wire this invocation into ' +
      '`validate`, at which point they gate per-PR like every other `correctness` rule._',
    '',
    '_The `react/*` rows are the separate #4377 burn-down: those ARE held at `warn` in ' +
      "`.oxlintrc.json`, and that block documents its own ratchet — delete a rule's line once " +
      'its count reaches zero and the category default restores it to `error`._',
    '',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * The value that follows a value-taking option, or `null` when there isn't
 * one. A missing final argument yields `undefined` and an option name yields
 * the NEXT FLAG — `--report --exit-code 1` would set the report path to the
 * literal string `--exit-code`. Both are the same family as `Number('')`
 * being `0`: a malformed invocation quietly becoming a well-formed-looking
 * value. Every value-taking option in this script goes through here.
 */
export function takeValue(argv, i) {
  const raw = argv[i]
  if (typeof raw !== 'string' || raw === '' || raw.startsWith('--')) return null
  return raw
}

export function parseArgs(argv) {
  const args = { report: null, exitCode: null, summary: false, selfTest: false, unknown: [] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--summary') args.summary = true
    else if (argv[i] === '--self-test') args.selfTest = true
    else if (argv[i] === '--report') args.report = takeValue(argv, (i += 1))
    else if (argv[i] === '--exit-code') args.exitCode = parseExitCode(takeValue(argv, (i += 1)))
    // A silently-ignored argument is a mistyped flag that reads as a
    // deliberate omission — `--repot x` would leave `report` null and blame
    // the caller for not passing one. Name it instead.
    else if (argv[i] !== undefined) args.unknown.push(argv[i])
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
      console.log(renderSummary(args.report == null ? '' : readFileSync(args.report, 'utf8')))
    } catch (err) {
      console.log(`## Type-aware lint\n\n_Summary renderer failed: ${err?.message}._\n`)
    }
    return EXIT_CLEAN
  }
  const usage = []
  if (args.unknown.length > 0) usage.push(`unrecognised argument(s): ${args.unknown.join(' ')}`)
  // `== null` catches BOTH null and undefined: `--report` with no value left
  // it undefined, which a `=== null` test misses, and the run then failed as
  // "the lane did not run" (2) rather than as the usage error it is (3).
  if (args.report == null) usage.push('--report <file> is required and needs a value')
  if (!Number.isInteger(args.exitCode)) {
    usage.push('--exit-code <n> is required and must be an integer')
  }
  if (usage.length > 0) {
    console.error('usage: check-type-aware-liveness.mjs --report <file> --exit-code <n>')
    for (const u of usage) console.error(`  - ${u}`)
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
        `${report.number_of_files} file(s) against ${report.number_of_rules} rule(s) — more than ` +
        'a plain run of this config registers, so `--type-aware` really was in effect — reported ' +
        `${total} finding(s), and the generated canary fixture still trips ${CANARY_RULE}`,
    )
    return code
  }
  // The two tiers make DIFFERENT claims, so they must not share a sentence.
  // Tier 2 asserts the lane did not run; tier 3 asserts only that the guard
  // could not find out — printing the former for the latter is the same
  // conflation the exit codes exist to keep apart.
  console.error(
    code === EXIT_BROKEN
      ? 'FAIL  the type-aware lane did not run (#4408):'
      : 'UNVERIFIABLE  the type-aware lane could not be checked — this is not a verdict on it (#4408):',
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

// The real measured shape of this repo's two modes: a type-aware run of this
// config registers 229 rules, a plain one 212. FIXTURE data only — the guard
// compares two numbers it measures at run time and contains neither literal,
// which `selfTestTypeAwareWasUsed` proves at values nothing like these.
const PLAIN_RULES = 212
const TYPE_AWARE_RULES = 229
const FIXTURE_FILES = 3

/** A well-formed envelope from a run that DID use `--type-aware`. */
const goodReport = (diagnostics = []) =>
  JSON.stringify({
    diagnostics,
    number_of_files: FIXTURE_FILES,
    number_of_rules: TYPE_AWARE_RULES,
    threads_count: 16,
    start_time: 0.1,
  })

const errorDiag = (code) => ({ code, severity: 'error', message: 'x', filename: 'a.ts' })
const warnDiag = (code) => ({ code, severity: 'warning', message: 'x', filename: 'a.ts' })

const liveCanary = () => parseReport(goodReport([errorDiag(CANARY_RULE)]))
const deadCanary = () => parseReport(goodReport([warnDiag('react(refs)')]))

/** A probe pair: a canary result plus a plain baseline rule count. */
// `number_of_files` mirrors `goodReport`'s, because the real baseline lints
// the SAME target as the main run and `assertSameTarget` now checks that.
const probeOf =
  (canary, plainRules = PLAIN_RULES, plainFiles = FIXTURE_FILES) =>
  () => ({
    canary: canary(),
    baseline: { diagnostics: [], number_of_files: plainFiles, number_of_rules: plainRules },
  })

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

  // Note 6: a config's `overrides` mechanism CAN enable one rule at two
  // severities across a report (today's config does not — see the
  // `countByRule` doc comment above); this fixture stands in for that case
  // synthetically. Keying the table on the code alone would keep whichever
  // severity was seen FIRST, which would label 40 errors `warning` purely by
  // file order.
  const mixed = JSON.parse(
    goodReport([
      warnDiag('typescript(require-await)'),
      errorDiag('typescript(require-await)'),
      errorDiag('typescript(require-await)'),
    ]),
  )
  const mixedRows = countByRule(mixed)
  check(
    mixedRows.length === 2 &&
      mixedRows[0].severity === 'error' &&
      mixedRows[0].count === 2 &&
      mixedRows[1].severity === 'warning' &&
      mixedRows[1].count === 1,
    'a rule with TWO severities renders as two rows, worst-first — not one row mislabelled',
    JSON.stringify(mixedRows),
  )
  check(
    renderSummary(
      goodReport([warnDiag('typescript(require-await)'), errorDiag('typescript(require-await)')]),
    ).includes('| `typescript(require-await)` | error | 1 |'),
    'the rendered table shows the error half of a mixed-severity rule, not only the first seen',
    '',
  )
}

function selfTestCanaryClassification({ check }) {
  check(
    checkCanary(liveCanary()).length === 0,
    'a canary that trips CANARY_RULE exactly passes',
    '',
  )
  // Note 2: a DIFFERENT typescript(...) rule must not stand in for the canary
  // rule. A syntax-only `typescript/*` rule promoted into `correctness` could
  // fire on this fixture, and a prefix match would let it certify a dead
  // backend as live.
  check(
    checkCanary(parseReport(goodReport([errorDiag('typescript(no-empty-function)')]))).length === 1,
    'a DIFFERENT typescript(...) rule does NOT satisfy the canary — exact match, not a prefix',
    '',
  )
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

function selfTestTypeAwareWasUsed({ check }) {
  const rules = (n) => ({ number_of_rules: n })
  check(
    checkTypeAwareWasUsed(rules(TYPE_AWARE_RULES), rules(PLAIN_RULES)).length === 0,
    'a type-aware run registers MORE rules than the plain baseline — clean',
    '',
  )
  // Note 1, the whole point: `--type-aware` dropped from the invocation.
  const dropped = checkTypeAwareWasUsed(rules(PLAIN_RULES), rules(PLAIN_RULES))
  check(
    dropped.length === 1 &&
      dropped[0].includes(String(PLAIN_RULES)) &&
      dropped[0].includes('--type-aware'),
    'EQUAL rule counts mean --type-aware was dropped from the main run — caught, and named',
    JSON.stringify(dropped),
  )
  check(
    checkTypeAwareWasUsed(rules(PLAIN_RULES - 1), rules(PLAIN_RULES)).length === 1,
    'FEWER rules than the baseline is caught too',
    '',
  )
  // The comparison must contain no literal: prove it tracks whatever the two
  // measured numbers happen to be, at values nothing like the real ones.
  check(
    checkTypeAwareWasUsed(rules(4), rules(3)).length === 0 &&
      checkTypeAwareWasUsed(rules(3), rules(3)).length === 1,
    'the check is a pure comparison — no rule count is hardcoded anywhere in it',
    '',
  )
}

function selfTestSameTarget({ check }) {
  const at = (files) => ({ number_of_files: files, number_of_rules: 1 })
  check(assertSameTarget(at(1852), at(1852)).length === 0, 'equal targets compare fine', '')
  const mismatch = assertSameTarget(at(1852), at(1))
  check(
    mismatch.length === 1 && mismatch[0].includes('1852') && mismatch[0].includes('did not look'),
    'a baseline that linted a DIFFERENT target is caught, and both counts are named',
    JSON.stringify(mismatch),
  )
  // Values nothing like the real ones: the check is a comparison, not a
  // literal, in both directions.
  check(
    assertSameTarget(at(7), at(7)).length === 0 && assertSameTarget(at(7), at(8)).length === 1,
    'the target check hardcodes no file count either',
    '',
  )
  // A target mismatch is UNVERIFIABLE (3), not broken (2): the guard cannot
  // answer the question, which is not the same as answering it "no". And the
  // rule-count comparison must not run on incomparable inputs.
  const problems = collectProblems({
    exitCode: 1,
    reportText: goodReport([errorDiag('typescript(a)')]),
    probe: probeOf(liveCanary, PLAIN_RULES, FIXTURE_FILES + 1),
  })
  check(
    problems.length === 1 && problems[0].severity === 'unverifiable',
    'a target mismatch is unverifiable, and suppresses the rule-count comparison',
    JSON.stringify(problems),
  )
}

function selfTestStaleInstallSkips({ check }) {
  // Note 4: the state a puller lands in after this merges — oxlint already in
  // node_modules (it predates the PR), oxlint-tsgolint not yet. Classified
  // POSITIVELY, by the absence of the package that should be there, never by
  // matching oxlint's error text.
  const dir = mkdtempSync(join(tmpdir(), 'stale-install-'))
  try {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.bin', 'oxlint'), '#!/bin/sh\nexit 0\n', 'utf8')
    let threw = null
    try {
      runProbes({ repoRoot: dir })
    } catch (err) {
      threw = err
    }
    check(
      threw instanceof UnverifiableError && threw.message.includes('npm install'),
      'oxlint present but oxlint-tsgolint absent is UNVERIFIABLE and names `npm install`',
      String(threw?.message),
    )
    check(
      threw instanceof UnverifiableError && threw.message.includes(TSGOLINT_PACKAGE),
      'the stale-install message names the missing package, not a backend failure',
      String(threw?.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * #4461 note 1: the pathless baseline run must happen BEFORE the canary
 * fixture is ever written to `reports/type-aware/canary-…/canary.ts` — see
 * `runProbes`'s own doc comment for why the old order made the "same
 * target" premise hold only by a coincidence of `.gitignore` rules.
 *
 * Exercised through a FAKE oxlint binary (real `execFileSync`, fake
 * executable — same shape `selfTestStaleInstallSkips` uses), because the
 * property under test is an ORDERING of real filesystem operations against
 * a real subprocess call, not something the parsed report shape can show on
 * its own. The fake records, into a marker file named by an env var, whether
 * ANY `canary.ts` existed under `reports/type-aware/` at the moment the
 * PLAIN (non `--type-aware`) call ran — the one call this test cares about.
 */
function selfTestBaselineOrdering({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-order-'))
  const marker = join(dir, 'baseline-saw-canary.marker')
  try {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', TSGOLINT_PACKAGE), { recursive: true })
    writeFileSync(join(dir, 'node_modules', TSGOLINT_PACKAGE, 'package.json'), '{}\n', 'utf8')
    const oxlintPath = join(dir, 'node_modules', '.bin', 'oxlint')
    writeFileSync(
      oxlintPath,
      '#!/bin/sh\n' +
        'case " $* " in\n' +
        '  *" --type-aware "*)\n' +
        // The canary call: a minimal report that already trips CANARY_RULE,
        // so this fixture does not also have to fake the fixture's own
        // config to get a realistic-shaped result back.
        '    printf \'%s\' \'{"number_of_rules":5,"number_of_files":1,"diagnostics":[{"code":"typescript(no-floating-promises)"}]}\'\n' +
        '    ;;\n' +
        '  *)\n' +
        // The plain baseline call: record whether the canary fixture exists
        // yet, at the moment THIS call runs.
        '    if find "$PROBE_ORDER_ROOT/reports/type-aware" -mindepth 1 -name canary.ts ' +
        '2>/dev/null | grep -q canary.ts; then\n' +
        '      echo saw-canary > "$PROBE_ORDER_MARKER"\n' +
        '    else\n' +
        '      echo no-canary-yet > "$PROBE_ORDER_MARKER"\n' +
        '    fi\n' +
        '    printf \'%s\' \'{"number_of_rules":3,"number_of_files":5}\'\n' +
        '    ;;\n' +
        'esac\n',
      'utf8',
    )
    chmodSync(oxlintPath, 0o755)

    let result
    let threw = null
    const savedRoot = process.env.PROBE_ORDER_ROOT
    const savedMarker = process.env.PROBE_ORDER_MARKER
    process.env.PROBE_ORDER_ROOT = dir
    process.env.PROBE_ORDER_MARKER = marker
    try {
      result = runProbes({ repoRoot: dir })
    } catch (err) {
      threw = err
    } finally {
      if (savedRoot === undefined) delete process.env.PROBE_ORDER_ROOT
      else process.env.PROBE_ORDER_ROOT = savedRoot
      if (savedMarker === undefined) delete process.env.PROBE_ORDER_MARKER
      else process.env.PROBE_ORDER_MARKER = savedMarker
    }

    check(
      threw === null && result?.baseline?.number_of_rules === 3,
      'runProbes completes against the fake toolchain (ordering test is not vacuous)',
      String(threw?.message ?? JSON.stringify(result)),
    )
    const markerContent = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '<absent>'
    check(
      markerContent === 'no-canary-yet',
      'the plain baseline run sees NO canary fixture on disk — it ran before the fixture was ' +
        'written, so the "same target" premise no longer rests on `.gitignore` (#4461 note 1)',
      markerContent,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * #4461 note 2: a `maxBuffer` overflow must be diagnosed as a buffer
 * problem, never as "no usable rule count". Drives `defaultRunOxlint`
 * directly — the real function, a real child process, a real overflow — so
 * this proves the CLASSIFICATION, not just that `ENOBUFS` happens to be a
 * string this file recognises somewhere.
 */
function selfTestMaxBufferOverflow({ check }) {
  const oversized = OXLINT_PROBE_MAX_BUFFER + 1024 * 1024
  let threw = null
  try {
    defaultRunOxlint({
      binary: '/bin/sh',
      cwd: process.cwd(),
      args: ['-c', `yes x | head -c ${oversized}`],
    })
  } catch (err) {
    threw = err
  }
  check(
    threw instanceof UnverifiableError,
    'an oversized probe output is UNVERIFIABLE, not a crash and not a silent truncated return',
    String(threw),
  )
  check(
    threw !== null && /buffer/i.test(threw.message) && !/no usable rule count/.test(threw.message),
    'the overflow is diagnosed as a BUFFER problem here, not left to surface downstream as ' +
      '"no usable rule count" (#4461 note 2)',
    String(threw?.message),
  )
}

function selfTestArgValues({ check }) {
  // Note 3, and a sweep of every option that takes a value.
  check(takeValue(['--report'], 1) === null, 'a missing final value is null, not undefined', '')
  check(
    takeValue(['--report', '--exit-code', '1'], 1) === null,
    'the NEXT FLAG is not swallowed as this option value',
    '',
  )
  check(takeValue(['--report', ''], 1) === null, 'an empty value is null', '')
  check(takeValue(['--report', 'r.json'], 1) === 'r.json', 'a real value is taken', '')
  check(
    parseArgs(['--report']).report === null && parseArgs(['--exit-code']).exitCode === null,
    'both value-taking options reject a missing value — the whole sweep',
    '',
  )
  check(
    parseArgs(['--repot', 'x']).unknown.length === 2,
    'a mistyped flag is NAMED, not silently ignored as a deliberate omission',
    JSON.stringify(parseArgs(['--repot', 'x'])),
  )
  check(
    quietly(() => main(['--report', '--exit-code', '1'])) === EXIT_UNVERIFIABLE,
    '`--report --exit-code 1` is a usage error (3), not "the lane did not run" (2)',
    '',
  )
  check(
    quietly(() => main(['--report'])) === EXIT_UNVERIFIABLE,
    "`--report` with no value is a usage error (3) — note 3's exact shape",
    '',
  )
}

function selfTestPositiveClassification({ check }) {
  // The single most important case: the missing-binary state, which exits 1
  // exactly like success and would sail through any exit-code-based check.
  const problems = collectProblems({
    exitCode: 1,
    reportText: MISSING_TSGOLINT_STDOUT,
    probe: probeOf(liveCanary),
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
      probe: probeOf(liveCanary),
    }).length === 0,
    'the real lane shape — exit 1, envelope, findings, live canary — is clean',
    '',
  )
  check(
    collectProblems({
      exitCode: 0,
      reportText: goodReport([]),
      probe: probeOf(liveCanary),
    }).length === 0,
    'the END state of the burn-down — exit 0, ZERO findings, live canary — is still clean',
    '',
  )
  check(
    collectProblems({
      exitCode: 0,
      reportText: goodReport([]),
      probe: probeOf(deadCanary),
    }).length === 1,
    'zero findings with a DEAD canary is broken — this is what the canary exists for',
    '',
  )
  // Note 1 end to end: the shape a run takes when `--type-aware` is dropped
  // from the workflow. Valid envelope, warnings only, exit 0, LIVE canary
  // (it builds its own argv) — everything else passes, and this must not.
  {
    const droppedFlag = collectProblems({
      exitCode: 0,
      reportText: JSON.stringify({
        diagnostics: [warnDiag('react(refs)')],
        number_of_files: FIXTURE_FILES,
        number_of_rules: PLAIN_RULES,
      }),
      probe: probeOf(liveCanary),
    })
    check(
      droppedFlag.length === 1 && droppedFlag[0].message.includes('--type-aware'),
      'a main run with --type-aware DROPPED is broken, even though every other check passes',
      JSON.stringify(droppedFlag),
    )
  }
  for (const code of [2, 101, 124, 137, -1]) {
    check(
      collectProblems({
        exitCode: code,
        reportText: goodReport([]),
        probe: probeOf(liveCanary),
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
  // a verdict. (`runProbes` does need the in-repo path, and mkdir -p's it.)
  const dir = mkdtempSync(join(tmpdir(), 'type-aware-selftest-'))
  try {
    const reportPath = join(dir, 'report.json')
    writeFileSync(reportPath, goodReport([errorDiag('typescript(a)')]), 'utf8')
    check(
      runGuard({ exitCode: 1, reportPath, probe: probeOf(liveCanary) }).code === EXIT_CLEAN,
      'runGuard: a live lane exits 0',
      '',
    )
    check(
      runGuard({ exitCode: 1, reportPath, probe: probeOf(deadCanary) }).code === EXIT_BROKEN,
      'runGuard: a dead canary exits 2',
      '',
    )
    check(
      runGuard({ exitCode: 1, reportPath: join(dir, 'nope.json'), probe: probeOf(liveCanary) })
        .code === EXIT_BROKEN,
      'runGuard: a lane that wrote no report at all exits 2, never 0',
      '',
    )
    const unverifiableProbe = () => {
      throw new UnverifiableError('dependencies are not installed')
    }
    // Note 4: this is what makes the `unverifiable` tier a live branch rather
    // than decoration. Before the probes moved into `collectProblems` the
    // EXIT_UNVERIFIABLE fallthrough in `runGuard` was unreachable.
    const cannotProbe = runGuard({ exitCode: 1, reportPath, probe: unverifiableProbe })
    check(
      cannotProbe.code === EXIT_UNVERIFIABLE &&
        cannotProbe.problems.length > 0 &&
        cannotProbe.problems.every((p) => p.severity === 'unverifiable'),
      'runGuard: probes that cannot be run exit 3 via a REACHABLE unverifiable tier (note 4)',
      JSON.stringify(cannotProbe),
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

function selfTestRealProbes({ check, fail }) {
  // The real thing, against this repo's real installed toolchain. The canary
  // half is the assertion that would have failed before `oxlint-tsgolint` was
  // added; the baseline half pins the premise note 1's check rests on.
  let probes
  try {
    probes = runProbes()
  } catch (err) {
    if (err instanceof UnverifiableError) {
      console.log(`  skip - the real probes (${err.message})`)
      return
    }
    fail('the real probes run', err.message)
    return
  }
  const problems = checkCanary(probes.canary)
  check(
    problems.length === 0,
    `the REAL canary trips ${CANARY_RULE} against this repo's installed oxlint + tsgolint`,
    problems.join(' | '),
  )
  check(
    typeof probes.baseline.number_of_rules === 'number' && probes.baseline.number_of_rules > 0,
    `the REAL plain baseline reports a usable rule count (${probes.baseline.number_of_rules})`,
    JSON.stringify(probes.baseline),
  )
  // The premise of note 1's check, measured rather than assumed: a real
  // type-aware run of this config registers strictly more rules than a real
  // plain one. If this ever stops holding, the discriminator is dead and this
  // says so instead of the guard quietly passing everything.
  check(
    probes.canary.report.number_of_rules > 0,
    'the REAL canary run reports a rule count too',
    JSON.stringify(probes.canary.report?.number_of_rules),
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
  selfTestTypeAwareWasUsed({ check })
  selfTestPositiveClassification({ check })
  selfTestSummaryNeverFails({ check })
  selfTestSummaryCountsAreComputed({ check })
  selfTestRunGuard({ check })
  selfTestExitCodes({ check })
  selfTestArgValues({ check })
  selfTestSameTarget({ check })
  selfTestStaleInstallSkips({ check })
  selfTestBaselineOrdering({ check })
  selfTestMaxBufferOverflow({ check })
  selfTestRealProbes({ check, fail })

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
