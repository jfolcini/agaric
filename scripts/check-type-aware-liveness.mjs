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
// it holds here too: `--summary` catches everything and always exits 0, over
// malformed, empty, and absent reports alike.
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
//
// Exit codes: 0 = the lane ran; 2 = the lane did NOT run; 3 = UNVERIFIABLE,
// the guard could not reach a verdict.
// 1 is deliberately unused so node's own exit-1-on-crash cannot be mistaken
// for a verdict — the same discipline as scripts/check-tsgolint-version-pin.mjs.
// `--summary` always exits 0.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

// `maxBuffer` defaults to the real threshold above; the override exists so a
// caller can shrink it (#4477 note 6) without depending on whatever
// `OXLINT_PROBE_MAX_BUFFER` happens to be set to.
export function defaultRunOxlint({ binary, cwd, args, maxBuffer = OXLINT_PROBE_MAX_BUFFER }) {
  try {
    return execFileSync(binary, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer,
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
        `a probe invocation's output exceeded the ${maxBuffer}-byte buffer and ` +
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
  const args = { report: null, exitCode: null, summary: false, unknown: [] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--summary') args.summary = true
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
    // Never fails, by design — malformed, empty and absent reports all
    // render; see the header.
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

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  process.exit(main(process.argv.slice(2)))
}
