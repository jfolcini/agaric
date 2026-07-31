#!/usr/bin/env node
// #3374 — the watchdog for the SCHEDULED WORKFLOWS THEMSELVES.
//
// ─── What this closes ────────────────────────────────────────────────────────
//
// #3359 wired a `report-scheduled-failures` job into `scheduled-deep-checks.yml`
// so a red lane there files a tracking issue. It closed one workflow's gap and
// documented, in `scripts/file-scheduled-failures.mjs`, the one hole it could
// not close from inside a workflow:
//
//     "if the reporting JOB never starts (invalid workflow file, runner-pool
//      outage, whole-run cancellation before it is scheduled) nothing reports."
//
// Every in-workflow reporter has that hole, by construction: a workflow cannot
// report its own non-existence. And four more scheduled workflows had no
// reporter at all — `e2e-tauri-weekly`, `codeql`, `scorecard` and
// `branch-protection-assert`, the last of which guards the control that keeps
// unreviewed code off `main`.
//
// This script is the out-of-band observer. It runs from a SEPARATE workflow on
// a SEPARATE cron and asks GitHub's own runs API, per watched workflow:
//
//   1. LIVENESS — did a `schedule`-event run of this workflow start within the
//      window its cron implies? ("the checking machinery did not run")
//   2. CONCLUSION — did the most recent COMPLETED scheduled run succeed?
//      ("the checking machinery ran and said no")
//
// Both questions are answered from outside every watched workflow, so a
// workflow that is invalid, disabled, starved of runners, or cancelled before
// its reporter job is scheduled is still reported. That is the whole point:
// nothing here depends on the thing being watched.
//
// ─── Why `--event schedule` only ─────────────────────────────────────────────
//
// `codeql` and `scorecard` also run on `push`/`pull_request`. Those runs are
// NOT considered here, deliberately, in both directions:
//
//   * For liveness, counting a push run would make the check vacuous on an
//     active repo — the cron could be dead for months while pushes keep the
//     "last run" fresh. Asking specifically "did the CRON fire" is the whole
//     question. (It also catches GitHub disabling a repo's schedules after 60
//     days of inactivity, which is otherwise entirely silent.)
//   * For failures, a push/PR run's red is already surfaced — commit status,
//     PR checks, the Security tab. It is precisely the SCHEDULED run whose
//     failure is surfaced nowhere. `workflow_dispatch` runs are excluded for
//     the same reason: a human is watching the run they triggered.
//
// ─── Why the conclusion comes from the newest COMPLETED run ──────────────────
//
// The watchdog can overlap a watched run (`e2e-tauri-weekly` takes ~17 min and
// can be delayed into any hour). The newest scheduled run may therefore be
// `in_progress`, with `conclusion: null`. Treating that as a failure would red
// the watchdog on healthy overlap; treating it as success would let a genuine
// failure be masked by a later queued run. So the two questions read different
// runs: liveness from the newest scheduled run of ANY status (an in-progress
// run proves the cron fired), the conclusion from the newest COMPLETED one.
//
// ─── Why this cannot silently pass ───────────────────────────────────────────
//
// Every path that cannot answer the question THROWS rather than returning
// "healthy": a `gh` invocation that fails or is missing, output that is not
// JSON, a runs payload that is not an array, a run with a missing or
// unparseable `createdAt`. `--out` is written only after every watched
// workflow has been classified, so a partial fetch never produces a file the
// filer would read as "all green". This mirrors the `parseNeeds` throw in
// `file-scheduled-failures.mjs` and exists for the same reason: reporting
// health from absent data is the exact false-green class this work stream is
// about.
//
// ─── Output ──────────────────────────────────────────────────────────────────
//
// `--out` receives the same shape `${{ toJSON(needs) }}` has — an object keyed
// by name whose values carry a `result` — so `file-scheduled-failures.mjs`
// consumes it unchanged via `--needs-json-file`. The watchdog invents no
// second issue-filing mechanism; it reuses the #3359 state machine (rolling
// issue, comment only on a NEWLY failing entry, self-closing on full recovery)
// under a separate `--profile`.
//
// Usage:
//   node scripts/check-workflow-liveness.mjs --out <path> [--repo owner/repo]
//        [--exclude-run-id <id>]     (this run's id; see § self-watch below)
//        [--now <iso8601>]           (TEST-ONLY: pin "now")
//        [--runs-json-file <path>]   (TEST-ONLY: `{ "<file>.yml": [run…] }`
//                                     instead of calling `gh`)
//   node scripts/check-workflow-liveness.mjs --self-test
//
// Exit codes: 0 = every watched workflow classified and `--out` written;
//             1 = a real error (bad args, `gh` failure, unwatched scheduled
//                 workflow, unparseable timestamps); 2 = self-test failure.

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORKFLOWS_DIR = join(import.meta.dirname, '..', '.github', 'workflows')

const HOUR_MS = 3600 * 1000

// ---------------------------------------------------------------------------
// The watched set
// ---------------------------------------------------------------------------

/**
 * Every workflow in this repo with an `on: schedule:` trigger, plus the window
 * its cron implies. `findUnwatchedWorkflows` asserts this list and the
 * `.github/workflows` directory agree in BOTH directions, so adding a cron to
 * a new workflow (or deleting a watched one) fails the prek hook rather than
 * quietly leaving it unobserved.
 *
 * How `maxAgeHours` was derived — the watchdog itself runs DAILY at 19:37 UTC,
 * and "age" is measured at a watchdog run against the newest scheduled run.
 *
 * The numbers below are MEASURED, not inferred from the cron expressions.
 * GitHub does not deliver a cron on time, and in this repo it is never even
 * close; over the runs the API still holds (2026-07-31, `gh run list --event
 * schedule`), delivery lag from the nominal minute was:
 *
 *     branch-protection-assert  n=20  min 1.00h  median 1.44h  MAX 2.30h
 *     codeql                    n=11  min 1.85h  median 3.49h  MAX 4.99h
 *     scorecard                 n=11  min 2.67h  median 3.93h  MAX 5.77h
 *     scheduled-deep-checks     n= 7  min 3.15h  median 4.38h  MAX 6.25h
 *     e2e-tauri-weekly          n= 1                           MAX 5.22h
 *
 * So a window must clear ~6.5h of lag on the WATCHED run and however much the
 * watchdog's own tick is late (bounded by its own 44h self-watch below).
 *
 *   * `branch-protection-assert` (daily 12:00, observed 13:00–14:18): healthy
 *     age at the 19:37 tick is 5.3–6.6h, and at most ~12.6h once the
 *     watchdog's own lag is added. One skipped day reads 30.6–36.6h. 30h
 *     therefore fires on a SINGLE skipped day while still leaving ~17h of
 *     headroom over the worst healthy age — against a worst measured lag of
 *     6.25h. It was 40h, which needed TWO consecutive skips: for the one
 *     watched workflow that guards the ruleset keeping unreviewed code off
 *     `main`, that made this the LEAST sensitive daily check in the set,
 *     strictly less sensitive than the watchdog's own 44h self-watch (which
 *     fires on one skip, because its baseline is the 24h-old PREVIOUS run
 *     rather than a ~6h-old newest run). Tightened during review of #3374.
 *   * The weekly lanes (Mon 02:43 / Mon 04:17 / Mon 06:00 / Tue 06:00):
 *     healthy age peaks at ~161h on the Sunday tick before the next run, ~167h
 *     with the watchdog's own lag. One skipped week reads ~185h at the Monday
 *     tick and ~209h at the Tuesday one, so 200h trips one day after a missed
 *     week and keeps ~33h of headroom. A day of extra latency on a weekly job
 *     is worth more than the margin tightening to 180h would cost.
 *   * The watchdog itself (daily, self-excluded — see below): the PREVIOUS run
 *     is normally 24h old — measured lag DIFFERENCE between consecutive daily
 *     runs is ≤1.3h, so 22.7–25.3h — and 48h after one skipped day. 44h fires
 *     on a single skip with ~19h of headroom.
 *
 * The self-test pins the property that makes those numbers meaningful: every
 * window is strictly under two nominal periods, so a check that never fires
 * within two cycles is impossible to configure here by accident.
 */
export const WATCHED = Object.freeze([
  Object.freeze({
    workflow: 'branch-protection-assert.yml',
    periodHours: 24,
    // 30h, not 40h: fires on ONE skipped day. See the measured derivation above.
    maxAgeHours: 30,
    why: 'daily 12:00 UTC; guards the ruleset that keeps unreviewed code off main',
  }),
  Object.freeze({
    workflow: 'codeql.yml',
    periodHours: 168,
    maxAgeHours: 200,
    why: 'weekly Tue 06:00 UTC',
  }),
  Object.freeze({
    workflow: 'e2e-tauri-weekly.yml',
    periodHours: 168,
    maxAgeHours: 200,
    why: 'weekly Mon 02:43 UTC',
  }),
  Object.freeze({
    workflow: 'scheduled-deep-checks.yml',
    periodHours: 168,
    maxAgeHours: 200,
    why: 'weekly Mon 04:17 UTC; its own in-workflow reporter cannot report a run that never started (#3359)',
  }),
  Object.freeze({
    workflow: 'scorecard.yml',
    periodHours: 168,
    maxAgeHours: 200,
    why: 'weekly Mon 06:00 UTC',
  }),
  Object.freeze({
    // The watchdog watches itself. Not vacuous, because the run doing the
    // watching excludes its own id (`--exclude-run-id`) and therefore judges
    // the PREVIOUS scheduled run — a skipped day reads as stale, and a
    // previous run that failed reads as a failure. What this does NOT cover is
    // stated honestly in the workflow header: if the watchdog stops running
    // permanently, nothing reports, here or anywhere.
    workflow: 'workflow-watchdog.yml',
    periodHours: 24,
    maxAgeHours: 44,
    selfExcluded: true,
    why: 'daily 19:37 UTC; judged against its PREVIOUS scheduled run',
  }),
])

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function formatAge(hours) {
  if (!Number.isFinite(hours)) return 'unknown'
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

/**
 * `createdAt` → epoch ms, throwing on anything unusable.
 *
 * An unparseable timestamp must NOT read as "recent": `new Date('nonsense')`
 * yields NaN, and every `NaN > limit` comparison is false, so a silent parse
 * failure would classify a workflow that has not run in a year as healthy.
 */
export function runStartedAt(run, workflow) {
  const raw = run?.createdAt ?? run?.created_at
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${workflow}: a run has no \`createdAt\` — cannot judge liveness from it`)
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    throw new Error(`${workflow}: a run has an unparseable \`createdAt\` (${raw})`)
  }
  return ms
}

/**
 * Classifies one watched workflow from its `schedule`-event run list.
 *
 * Returns a `result` string consumed by `file-scheduled-failures.mjs`, where
 * ONLY the literal `'success'` counts as healthy (`isFailing` there). Every
 * other string is a failure and is rendered verbatim in the tracking issue's
 * status table, so the detail (age, conclusion) travels with the signal while
 * dedup still keys on the workflow name alone.
 */
export function classifyWorkflow({ runs, nowMs, workflow, maxAgeHours, excludeRunId }) {
  if (!Array.isArray(runs)) {
    throw new Error(
      `${workflow}: the run list is not a JSON array — refusing to assume it is healthy`,
    )
  }
  const considered = runs
    .filter(
      (r) => excludeRunId === undefined || String(r?.databaseId ?? '') !== String(excludeRunId),
    )
    .map((r) => ({
      status: r?.status,
      conclusion: r?.conclusion,
      startedAtMs: runStartedAt(r, workflow),
    }))
    .toSorted((a, b) => b.startedAtMs - a.startedAtMs)

  if (considered.length === 0) {
    return `never-ran (no \`schedule\` run of ${workflow} found at all)`
  }

  const ageHours = (nowMs - considered[0].startedAtMs) / HOUR_MS
  if (ageHours > maxAgeHours) {
    return `stale (newest scheduled run started ${formatAge(ageHours)} ago; window is ${maxAgeHours}h)`
  }

  const completed = considered.find((r) => r.status === 'completed')
  if (!completed) {
    return `no-completed-run (newest scheduled run is \`${considered[0].status ?? 'unknown'}\` and none of the last ${considered.length} has completed)`
  }
  if (completed.conclusion === 'success') return 'success'
  return `failure (newest completed scheduled run concluded \`${completed.conclusion ?? 'unknown'}\`)`
}

/** Classifies every watched workflow into the `${{ toJSON(needs) }}` shape. */
export function buildResults({ runsByWorkflow, nowMs, excludeRunId, watched = WATCHED }) {
  const out = {}
  for (const entry of watched) {
    const runs = runsByWorkflow[entry.workflow]
    if (runs === undefined) {
      throw new Error(`${entry.workflow}: no run list was fetched — health is UNKNOWN, not green`)
    }
    out[entry.workflow] = {
      result: classifyWorkflow({
        runs,
        nowMs,
        workflow: entry.workflow,
        maxAgeHours: entry.maxAgeHours,
        excludeRunId: entry.selfExcluded ? excludeRunId : undefined,
      }),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Wiring guard: WATCHED must equal the set of scheduled workflows on disk
// ---------------------------------------------------------------------------

/**
 * Comments removed — both YAML comments and, inside a `run:` block, shell ones,
 * whether they occupy the whole line or trail live content on it.
 *
 * Every text assertion below MUST scan through this. Found the hard way while
 * mutation-testing this file: `findWatchdogWiringProblems` originally searched
 * the raw text for `--exclude-run-id`, and deleting that flag from the actual
 * `node …` invocation left the guard green — because the workflow's own header
 * comment EXPLAINS the flag by name. A guard satisfied by the prose describing
 * the thing it guards is exactly the vacuous check this whole work stream is
 * about.
 *
 * That first fix dropped only WHOLE-LINE comments, which left the identical
 * hole one column over: `- name: Classify  # passes --exclude-run-id` does not
 * start with `#`, so it survived stripping and satisfied the guard on its own.
 * Found by desyncing this function during review of #3374 — the same class of
 * textual-scanner desync this work stream keeps producing. So the cut is now at
 * the first `#` on every line, not at the first column.
 *
 * Deliberately NOT a YAML/shell quoting parser: `#` inside a quoted string
 * (this repo's workflow bodies say "(#3374)") is cut too. That loses nothing
 * for the three assertions below — none of the things they look for can
 * legitimately sit after a `#` — and it errs toward REPORTING a problem, which
 * is the only safe direction for a guard.
 */
export function stripComments(text) {
  return text
    .split('\n')
    .map((l) => l.split('#')[0])
    .join('\n')
}

/**
 * True when a workflow file declares a cron trigger. Text-based, like
 * `findUncoveredLanes` in the sibling filer and for the same reason: the repo's
 * scripts carry no YAML runtime dependency. Comment lines are dropped first so
 * a documented-but-disabled `# - cron:` does not read as a live schedule.
 */
export function hasCronTrigger(workflowText) {
  return stripComments(workflowText)
    .split('\n')
    .some((l) => /^\s*-\s*cron:/.test(l))
}

/**
 * Both directions of the WATCHED-vs-disk diff. A workflow that grows a cron
 * and is not added here would be unobserved — the exact bug this file exists
 * to close, reintroduced by the next PR. A WATCHED entry whose file is gone or
 * no longer scheduled is equally bad: `gh run list` on it returns an empty
 * list, which classifies as `never-ran` and would wedge the tracking issue
 * permanently open on a workflow nobody can fix.
 */
export function findUnwatchedWorkflows(files, watched = WATCHED) {
  const scheduled = new Set(files.filter((f) => hasCronTrigger(f.text)).map((f) => f.name))
  const watchedNames = new Set(watched.map((w) => w.workflow))
  return {
    unwatched: [...scheduled].filter((n) => !watchedNames.has(n)).toSorted(),
    phantom: [...watchedNames].filter((n) => !scheduled.has(n)).toSorted(),
  }
}

/**
 * The watchdog workflow's own invocation contract.
 *
 * Three things live in the YAML rather than in this file, and each of them can
 * be deleted without any assertion here noticing — which would make the
 * watchdog a check that cannot fail:
 *
 *   * `--exclude-run-id`: without it the self-watch grades the run that is
 *     currently executing, which is by definition alive. Vacuous.
 *   * a DAILY cron: every window in WATCHED is derived from the watchdog
 *     ticking once a day. On a weekly cron the 30h/44h windows would report
 *     `stale` on every run, and the resulting permanently-open issue is the
 *     notification fatigue this work stream is trying to avoid.
 *   * `--profile workflow-watchdog`: without it the filer defaults to
 *     `deep-checks` and the watchdog would overwrite THAT issue's marker
 *     block, silently un-tracking every red lane.
 *
 * Text assertions, in the same spirit (and with the same limits) as
 * `findUncoveredLanes` in the sibling filer.
 */
export function findWatchdogWiringProblems(rawWorkflowText) {
  // Comments stripped FIRST — see `stripComments`. The header comment of
  // `workflow-watchdog.yml` names all three of these things.
  const workflowText = stripComments(rawWorkflowText)
  const problems = []
  if (!workflowText.includes('--exclude-run-id')) {
    problems.push(
      'the watchdog does not pass `--exclude-run-id`, so its self-watch would grade its own in-flight run and could never fail',
    )
  }
  if (!/--profile\s+workflow-watchdog/.test(workflowText)) {
    problems.push(
      'the watchdog does not pass `--profile workflow-watchdog` to the filer, so it would write into the deep-checks tracking issue',
    )
  }
  const crons = [...workflowText.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1])
  if (crons.length !== 1 || !/^\S+ \S+ \* \* \*$/.test(crons[0])) {
    problems.push(
      `the watchdog must run on exactly one DAILY cron (the WATCHED windows are derived from that); found: ${crons.length === 0 ? 'none' : crons.join(', ')}`,
    )
  }
  return problems
}

export function readWorkflowFiles(dir = WORKFLOWS_DIR) {
  if (!existsSync(dir)) throw new Error(`no workflow directory at ${dir}`)
  return readdirSync(dir)
    .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

/** Throws with both diff directions spelled out, or returns silently. */
export function assertWatchedSetMatchesDisk(dir = WORKFLOWS_DIR) {
  const { unwatched, phantom } = findUnwatchedWorkflows(readWorkflowFiles(dir))
  const problems = []
  if (unwatched.length > 0) {
    problems.push(
      `these workflows have a cron trigger but are NOT in WATCHED (they would run unobserved): ${unwatched.join(', ')}`,
    )
  }
  if (phantom.length > 0) {
    problems.push(
      `these WATCHED entries have no scheduled workflow on disk (they would report \`never-ran\` forever): ${phantom.join(', ')}`,
    )
  }
  const self = watchedEntry('workflow-watchdog.yml')
  const selfPath = join(dir, self.workflow)
  if (!existsSync(selfPath)) {
    problems.push(`the watchdog workflow itself is missing from ${dir}`)
  } else {
    problems.push(...findWatchdogWiringProblems(readFileSync(selfPath, 'utf8')))
  }
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-workflow-liveness.mjs is out of step with .github/workflows:\n  - ${problems.join('\n  - ')}`,
    )
  }
}

function watchedEntry(name) {
  const entry = WATCHED.find((w) => w.workflow === name)
  if (!entry) throw new Error(`${name} is not in WATCHED — the watchdog must watch itself`)
  return entry
}

// ---------------------------------------------------------------------------
// `gh` plumbing
// ---------------------------------------------------------------------------

/**
 * The last few `schedule`-event runs of one workflow.
 *
 * Ten, not one: the newest run may be in progress, and the conclusion question
 * needs the newest COMPLETED run behind it. Any failure here — `gh` missing,
 * `gh` exiting non-zero (rate limit, auth, API 5xx), output that is not JSON —
 * propagates as a throw. There is no fallback value, because every possible
 * fallback would be a claim about health that this process cannot substantiate.
 */
export function fetchScheduleRuns(repo, workflow) {
  let raw
  try {
    raw = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--repo',
        repo,
        '--workflow',
        workflow,
        '--event',
        'schedule',
        '--limit',
        '10',
        '--json',
        'databaseId,status,conclusion,createdAt,url',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    )
  } catch (err) {
    throw new Error(`${workflow}: \`gh run list\` failed (${err.message.split('\n')[0]})`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`${workflow}: \`gh run list\` did not return JSON (${err.message})`)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--out': {
        args.out = argv[++i]
        break
      }
      case '--repo': {
        args.repo = argv[++i]
        break
      }
      case '--exclude-run-id': {
        args.excludeRunId = argv[++i]
        break
      }
      case '--now': {
        args.now = argv[++i]
        break
      }
      case '--runs-json-file': {
        args.runsJsonFile = argv[++i]
        break
      }
      case '--self-test': {
        args.selfTest = true
        break
      }
      default: {
        throw new Error(`unrecognized argument: ${a}`)
      }
    }
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (!args.out) throw new Error('--out is required')

  const nowMs = args.now === undefined ? Date.now() : Date.parse(args.now)
  if (!Number.isFinite(nowMs)) throw new Error(`--now is not a parseable timestamp: ${args.now}`)

  // Run the wiring guard before touching the network: a WATCHED set that no
  // longer matches the repo makes every classification below meaningless, and
  // failing here is what routes the problem to the last-resort notice.
  assertWatchedSetMatchesDisk()

  // `--runs-json-file` is the TEST-ONLY substitute for `gh`, so the
  // classification can be driven against fixtures with no network and no auth.
  let runsByWorkflow
  if (args.runsJsonFile !== undefined) {
    runsByWorkflow = JSON.parse(readFileSync(args.runsJsonFile, 'utf8'))
  } else {
    const repo = args.repo ?? process.env.GITHUB_REPOSITORY
    if (!repo) throw new Error('--repo (or $GITHUB_REPOSITORY) is required outside fixture mode')
    runsByWorkflow = {}
    for (const entry of WATCHED) {
      runsByWorkflow[entry.workflow] = fetchScheduleRuns(repo, entry.workflow)
    }
  }

  const results = buildResults({ runsByWorkflow, nowMs, excludeRunId: args.excludeRunId })

  for (const [workflow, { result }] of Object.entries(results)) {
    console.log(`${result === 'success' ? 'OK  ' : 'RED '} ${workflow}: ${result}`)
  }

  // Written LAST, and only once every workflow above has been classified — a
  // half-written file would be read by the filer as a smaller, healthier world
  // than the real one.
  writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  const red = Object.values(results).filter((r) => r.result !== 'success').length
  console.log(`wrote ${args.out}: ${Object.keys(results).length} watched, ${red} unhealthy`)
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
//
// Wired as the `workflow-watchdog-selftest` prek hook, keyed to this file AND
// to `.github/workflows/**` so a new cron anywhere trips the wiring guard.

const ISO = (ms) => new Date(ms).toISOString()

function selfTestClassification({ check }) {
  const now = Date.parse('2026-07-31T19:37:00Z')
  const run = (agoHours, status, conclusion, databaseId = 1) => ({
    databaseId,
    status,
    conclusion,
    createdAt: ISO(now - agoHours * HOUR_MS),
  })
  const classify = (runs, extra = {}) =>
    classifyWorkflow({ runs, nowMs: now, workflow: 'w.yml', maxAgeHours: 40, ...extra })

  check(
    classify([run(7.6, 'completed', 'success')]) === 'success',
    'a fresh, successful scheduled run is healthy',
    classify([run(7.6, 'completed', 'success')]),
  )

  // The liveness half. This is the assertion the whole workflow exists for, so
  // it is pinned in both directions around the boundary.
  check(
    classify([run(55.6, 'completed', 'success')]).startsWith('stale '),
    'a run older than the window is STALE even though it SUCCEEDED',
    classify([run(55.6, 'completed', 'success')]),
  )
  check(
    classify([run(39.9, 'completed', 'success')]) === 'success' &&
      classify([run(40.1, 'completed', 'success')]).startsWith('stale '),
    'the staleness window is the boundary it claims to be (39.9h ok, 40.1h stale)',
    `${classify([run(39.9, 'completed', 'success')])} / ${classify([run(40.1, 'completed', 'success')])}`,
  )
  check(
    classify([run(55.6, 'completed', 'success')]).includes('2.3d'),
    'the stale result carries the observed age, not just a flag',
    classify([run(55.6, 'completed', 'success')]),
  )

  check(
    classify([]).startsWith('never-ran '),
    'a workflow with no scheduled run at all is never-ran, not healthy',
    classify([]),
  )

  // The conclusion half, for each conclusion GitHub can report.
  for (const conclusion of [
    'failure',
    'cancelled',
    'timed_out',
    'startup_failure',
    'action_required',
    'skipped',
    'neutral',
    'stale',
    null,
  ]) {
    const got = classify([run(2, 'completed', conclusion)])
    check(
      got !== 'success' && got.startsWith('failure ('),
      `a completed run concluding \`${conclusion}\` is a failure`,
      got,
    )
  }

  // Overlap: an in-progress newest run proves liveness; the conclusion comes
  // from the newest COMPLETED run behind it.
  check(
    classify([run(0.2, 'in_progress', null, 9), run(168, 'completed', 'success', 8)], {
      maxAgeHours: 200,
    }) === 'success',
    'an in-progress newest run satisfies liveness and defers to the last completed run',
    classify([run(0.2, 'in_progress', null, 9), run(168, 'completed', 'success', 8)], {
      maxAgeHours: 200,
    }),
  )
  check(
    classify([run(0.2, 'in_progress', null, 9), run(168, 'completed', 'failure', 8)], {
      maxAgeHours: 200,
    }).startsWith('failure ('),
    'an in-progress run does NOT mask the last completed run having failed',
    classify([run(0.2, 'in_progress', null, 9), run(168, 'completed', 'failure', 8)], {
      maxAgeHours: 200,
    }),
  )
  check(
    classify([run(0.2, 'queued', null, 9)]).startsWith('no-completed-run '),
    'a queued run with nothing completed behind it is not healthy',
    classify([run(0.2, 'queued', null, 9)]),
  )

  // Order-independence. `gh run list` happens to return newest-first, but
  // nothing here may DEPEND on that: `.toSorted()` is what makes
  // `considered[0]` the newest, and reversing its comparator leaves every
  // single-element assertion above green while measuring liveness from the
  // OLDEST of the last ten runs — which reports a perfectly healthy weekly
  // workflow as permanently stale. (Found by mutation-testing this file.)
  for (const [label, runs] of [
    ['newest-first', [run(1, 'completed', 'success', 2), run(200, 'completed', 'success', 1)]],
    ['oldest-first', [run(200, 'completed', 'success', 1), run(1, 'completed', 'success', 2)]],
  ]) {
    check(
      classify(runs) === 'success',
      `liveness is measured from the NEWEST run, whatever order gh returns them (${label})`,
      classify(runs),
    )
  }
  for (const [label, runs] of [
    ['newest-first', [run(1, 'completed', 'failure', 2), run(20, 'completed', 'success', 1)]],
    ['oldest-first', [run(20, 'completed', 'success', 1), run(1, 'completed', 'failure', 2)]],
  ]) {
    check(
      classify(runs).startsWith('failure ('),
      `the conclusion comes from the NEWEST completed run, not the oldest (${label})`,
      classify(runs),
    )
  }

  // Self-watch. Without the exclusion the watchdog would grade its own
  // in-flight run and could never fail — a check that cannot fail.
  {
    const runs = [run(0.01, 'in_progress', null, 4242)]
    const withoutExclusion = classify(runs)
    const withExclusion = classify(runs, { excludeRunId: '4242' })
    check(
      withoutExclusion !== withExclusion && withExclusion.startsWith('never-ran '),
      'excluding the current run id makes the self-watch non-vacuous',
      `without=${withoutExclusion} with=${withExclusion}`,
    )
  }
  {
    // …and with the exclusion in place, a skipped day of the watchdog reads
    // as stale rather than as "I am running, therefore I am fine".
    const runs = [run(0.01, 'in_progress', null, 4242), run(48, 'completed', 'success', 4241)]
    check(
      classify(runs, { excludeRunId: '4242', maxAgeHours: 44 }).startsWith('stale '),
      'the watchdog reports its OWN skipped day as stale',
      classify(runs, { excludeRunId: '4242', maxAgeHours: 44 }),
    )
  }

  // …and `buildResults` must actually FORWARD the exclusion for the
  // self-excluded entry. Asserting it inside `classifyWorkflow` proves nothing
  // about the caller: dropping the `entry.selfExcluded ? … : undefined` ternary
  // leaves every classification assertion above green while making the
  // self-watch permanently healthy. (Found by mutation-testing this file.)
  {
    const onlyThisRun = {
      [WATCHED.find((w) => w.selfExcluded).workflow]: [run(0.01, 'in_progress', null, 4242)],
    }
    const others = Object.fromEntries(
      WATCHED.filter((w) => !w.selfExcluded).map((w) => [
        w.workflow,
        [run(1, 'completed', 'success')],
      ]),
    )
    const results = buildResults({
      runsByWorkflow: { ...others, ...onlyThisRun },
      nowMs: now,
      excludeRunId: '4242',
    })
    const self = results[WATCHED.find((w) => w.selfExcluded).workflow].result
    check(
      self.startsWith('never-ran '),
      'buildResults forwards --exclude-run-id to the self-watched entry',
      `self result was "${self}" — the watchdog graded its own in-flight run`,
    )
  }

  // A watched workflow with no fetched run list is UNKNOWN, not green.
  {
    let threw = null
    try {
      buildResults({ runsByWorkflow: {}, nowMs: now })
    } catch (err) {
      threw = err
    }
    check(threw !== null, 'a missing run list throws rather than reading as healthy', 'no throw')
  }

  // Unusable data throws; it never reads as fresh. `Date.parse('nonsense')` is
  // NaN and every `NaN > limit` is false, so a swallowed parse error here
  // would classify a year-dead cron as healthy.
  for (const [label, runs] of [
    ['a run with no createdAt', [{ databaseId: 1, status: 'completed', conclusion: 'success' }]],
    [
      'a run with an unparseable createdAt',
      [{ databaseId: 1, status: 'completed', conclusion: 'success', createdAt: 'nonsense' }],
    ],
    ['a runs payload that is not an array', { oops: true }],
    ['a null runs payload', null],
  ]) {
    let threw = null
    try {
      classify(runs)
    } catch (err) {
      threw = err
    }
    check(threw !== null, `classification rejects ${label}`, 'no throw — would read as healthy')
  }
}

function selfTestWiringGuard({ check, fail }) {
  const wf = (cron) =>
    ['name: X', 'on:', ...(cron ? ['  schedule:', `    - cron: '${cron}'`] : []), 'jobs: {}'].join(
      '\n',
    )

  // Synthetic fixtures first, so the guard is demonstrably able to fail
  // instead of merely agreeing with whatever is on disk today.
  const watched = [{ workflow: 'a.yml', periodHours: 24, maxAgeHours: 40 }]
  check(
    hasCronTrigger(wf('0 6 * * 1')) && !hasCronTrigger(wf(null)),
    'cron detection distinguishes a scheduled workflow from an unscheduled one',
    '',
  )
  check(
    !hasCronTrigger("name: X\non:\n  schedule:\n    # - cron: '0 6 * * 1'\njobs: {}"),
    'a commented-out cron is not a live schedule',
    '',
  )
  check(
    hasCronTrigger("name: X\non:\n  schedule:\n    - cron: '0 6 * * 1'  # weekly\njobs: {}"),
    'a cron with a TRAILING comment is still a live schedule',
    '',
  )
  check(
    !stripComments('  - name: x  # --exclude-run-id').includes('--exclude-run-id') &&
      !stripComments('    node x.mjs  # --profile workflow-watchdog').includes('--profile'),
    'stripComments cuts TRAILING comments, not just whole-line ones',
    JSON.stringify(stripComments('  - name: x  # --exclude-run-id')),
  )
  {
    const clean = findUnwatchedWorkflows(
      [
        { name: 'a.yml', text: wf('0 6 * * 1') },
        { name: 'b.yml', text: wf(null) },
      ],
      watched,
    )
    check(
      clean.unwatched.length === 0 && clean.phantom.length === 0,
      'wiring guard passes when WATCHED matches the scheduled workflows',
      JSON.stringify(clean),
    )
  }
  {
    const missed = findUnwatchedWorkflows(
      [
        { name: 'a.yml', text: wf('0 6 * * 1') },
        { name: 'b.yml', text: wf('0 7 * * 1') },
      ],
      watched,
    )
    check(
      missed.unwatched.length === 1 && missed.unwatched[0] === 'b.yml',
      'wiring guard catches a NEW scheduled workflow nobody watches',
      JSON.stringify(missed),
    )
  }
  {
    const gone = findUnwatchedWorkflows([{ name: 'a.yml', text: wf(null) }], watched)
    check(
      gone.phantom.length === 1 && gone.phantom[0] === 'a.yml',
      'wiring guard catches a WATCHED entry that is no longer scheduled',
      JSON.stringify(gone),
    )
  }

  // The watchdog's own invocation contract, again fixtures first.
  {
    const good = [
      "    - cron: '37 19 * * *'",
      '        run: |',
      '          node scripts/check-workflow-liveness.mjs --exclude-run-id "$CURRENT_RUN_ID" --out w.json',
      '          node scripts/file-scheduled-failures.mjs --profile workflow-watchdog',
    ].join('\n')
    const gutted = good
      .replace(' --exclude-run-id "$CURRENT_RUN_ID"', '')
      .replace(' --profile workflow-watchdog', '')
    check(
      findWatchdogWiringProblems(good).length === 0,
      'watchdog wiring guard passes on a correctly wired workflow',
      JSON.stringify(findWatchdogWiringProblems(good)),
    )
    check(
      findWatchdogWiringProblems(gutted).length === 2,
      'the gutted fixture really is missing BOTH flags (else the cases below are vacuous)',
      JSON.stringify(findWatchdogWiringProblems(gutted)),
    )
    for (const [label, broken] of [
      [
        'the self-watch exclusion is deleted',
        good.replace(' --exclude-run-id "$CURRENT_RUN_ID"', ''),
      ],
      ['the --profile flag is deleted', good.replace(' --profile workflow-watchdog', '')],
      ['the cron is downgraded to weekly', good.replace("'37 19 * * *'", "'37 19 * * 1'")],
      // The bug this guard actually had: a header comment MENTIONING the flag
      // satisfied a raw `.includes()`, so deleting the real invocation stayed
      // green. Prose about a check must never stand in for the check.
      [
        'the flag survives only in a comment that explains it',
        `# the watchdog passes --exclude-run-id and --profile workflow-watchdog\n${gutted}`,
      ],
      // …and the same hole one column over. Dropping only WHOLE-LINE comments
      // left a trailing comment — YAML or shell — able to satisfy the guard on
      // its own, with neither flag present in any real invocation. Found by
      // desyncing `stripComments` during review.
      [
        'the flags survive only in a TRAILING yaml comment on a live line',
        `      - name: Classify  # passes --exclude-run-id and --profile workflow-watchdog\n${gutted}`,
      ],
      [
        'the flags survive only in a TRAILING shell comment inside `run:`',
        gutted.replace(
          '--out w.json',
          '--out w.json  # --exclude-run-id and --profile workflow-watchdog dropped for now',
        ),
      ],
    ]) {
      const problems = findWatchdogWiringProblems(broken)
      check(
        problems.length > 0,
        `watchdog wiring guard catches it when ${label}`,
        JSON.stringify(problems),
      )
    }
  }

  // …then the real directory.
  try {
    assertWatchedSetMatchesDisk()
    check(true, 'WATCHED and the watchdog workflow match this repo’s scheduled workflows', '')
  } catch (err) {
    fail('WATCHED and the watchdog workflow match this repo’s scheduled workflows', err.message)
  }
}

function selfTestWindows({ check }) {
  for (const entry of WATCHED) {
    check(
      Number.isFinite(entry.maxAgeHours) &&
        entry.maxAgeHours > entry.periodHours &&
        entry.maxAgeHours < 2 * entry.periodHours,
      `${entry.workflow}: the window can actually fire (period < window < 2×period)`,
      `period=${entry.periodHours}h window=${entry.maxAgeHours}h`,
    )
  }
  check(
    WATCHED.some((w) => w.selfExcluded === true),
    'the watchdog is in its own watched set',
    '',
  )

  // `period < window < 2×period` above is only the coarse sanity bound: it
  // admits 47h for a daily workflow, which quietly needs TWO consecutive
  // misses before it says anything. So the MEASURED derivation in the WATCHED
  // docstring is pinned here too, per period class. (Widening
  // `branch-protection-assert` from 30h to 47h was a live mutant that survived
  // the coarse bound.)
  const bp = WATCHED.find((w) => w.workflow === 'branch-protection-assert.yml')
  check(
    bp.maxAgeHours > 13 && bp.maxAgeHours < 30.6,
    'branch-protection-assert fires on ONE skipped day (window between the 12.6h worst healthy age and the 30.6h one-skip age)',
    `window=${bp.maxAgeHours}h`,
  )
  const self = WATCHED.find((w) => w.selfExcluded)
  check(
    // Upper bound is 46.7h, not 48h: the one-skip age is 48h MINUS the lag
    // differential between the two surviving runs (measured ≤1.3h for a daily
    // cron), so a 47h window would sit inside the noise and could miss a real
    // skipped day.
    self.maxAgeHours > 25.3 && self.maxAgeHours < 46.7,
    'the self-watch fires on ONE skipped day (baseline is the 24h-old PREVIOUS run, so the one-skip age is 48h less ≤1.3h of lag jitter)',
    `window=${self.maxAgeHours}h`,
  )
  for (const w of WATCHED.filter((e) => e.periodHours === 168)) {
    check(
      w.maxAgeHours > 167 && w.maxAgeHours < 209,
      `${w.workflow}: the weekly window clears the 167h worst healthy age and still trips within a day of a missed week`,
      `window=${w.maxAgeHours}h`,
    )
  }
}

/**
 * The argv `fetchScheduleRuns` actually hands to `gh`.
 *
 * Every assertion in `selfTestClassification` feeds `classifyWorkflow` a run
 * list directly, so nothing above pins the QUERY that produces that list — and
 * four of its arguments are load-bearing in a way that fails SILENTLY. Each of
 * these was a live mutant that survived the whole of the rest of this suite:
 *
 *   * `--event schedule`: without it a `push` run counts as liveness. On a repo
 *     that merges to `main` all day, `codeql` and `scorecard` would then read
 *     fresh forever while their crons were dead for months — the § Why
 *     `--event schedule` only rationale at the top of this file, deleted, with
 *     every assertion still green. That is a check that cannot fail.
 *   * `--workflow <name>`: without it every watched entry is classified from
 *     one repo-wide run list, so a single live workflow makes all six healthy.
 *   * `databaseId` in `--json`: without it `r.databaseId` is `undefined`, the
 *     `--exclude-run-id` filter matches nothing, and the self-watch is back to
 *     grading its own in-flight run — vacuous, and invisible.
 *   * `--limit` > 1: the conclusion question needs a COMPLETED run BEHIND a
 *     possibly in-flight newest one. At `--limit 1` an overlapping watched run
 *     reports `no-completed-run` every time, which is the false alarm that gets
 *     a watchdog muted.
 */
function selfTestGhInvocation({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-liveness-argv-'))
  const argvFile = join(dir, 'argv.txt')
  const stub = join(dir, 'gh')
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\nprintf '[]'\n`,
    'utf8',
  )
  chmodSync(stub, 0o755)

  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  try {
    fetchScheduleRuns('owner/repo', 'codeql.yml')
  } finally {
    process.env.PATH = prevPath
  }

  const argv = readFileSync(argvFile, 'utf8')
    .split('\n')
    .filter((s) => s.length > 0)
  const seen = argv.join(' ')
  const valueOf = (flag) => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  const fields = (valueOf('--json') ?? '').split(',')

  check(
    valueOf('--event') === 'schedule',
    '`gh run list` asks for `schedule` runs ONLY — a push run must never prove liveness',
    seen,
  )
  check(
    valueOf('--workflow') === 'codeql.yml',
    '`gh run list` is scoped to the ONE workflow being classified',
    seen,
  )
  check(valueOf('--repo') === 'owner/repo', '`gh run list` is scoped to the repo asked about', seen)
  check(
    fields.includes('databaseId'),
    '`--json` requests `databaseId`, without which `--exclude-run-id` silently matches nothing',
    seen,
  )
  check(
    ['status', 'conclusion', 'createdAt'].every((f) => fields.includes(f)),
    '`--json` requests every field the classifier reads',
    seen,
  )
  check(
    Number(valueOf('--limit')) > 1,
    '`--limit` fetches more than one run, so the conclusion can look BEHIND an in-flight newest run',
    seen,
  )
}

/**
 * `main()` end to end against a stub `gh` on `$PATH`.
 *
 * The pure-function assertions above pin what classification SHOULD say; none
 * of them pins that a `gh` failure reaches the exit code. That gap is the one
 * that matters most here: a watchdog that swallows a rate-limited `gh` and
 * writes an empty-but-well-formed results file hands the filer a world in
 * which nothing is failing, and closes the tracking issue. So the three ways
 * `gh` can betray this script are driven for real.
 */
function selfTestGhFailureModes({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-liveness-'))
  const out = join(dir, 'out.json')
  const stub = join(dir, 'gh')

  const drive = (script) => {
    writeFileSync(stub, script, 'utf8')
    chmodSync(stub, 0o755)
    const prevPath = process.env.PATH
    const prevLog = console.log
    process.env.PATH = `${dir}:${prevPath}`
    console.log = () => {}
    let threw = null
    try {
      main(['--repo', 'owner/repo', '--out', out])
    } catch (err) {
      threw = err
    } finally {
      console.log = prevLog
      process.env.PATH = prevPath
    }
    return { threw, wrote: existsSync(out) }
  }

  const cases = [
    [
      '`gh` exits non-zero (rate limit / auth / API 5xx)',
      // stderr is intentionally inherited by `fetchScheduleRuns`, so `gh`'s
      // real diagnostics land in the workflow log. The line below is that
      // pass-through firing; it is expected self-test output, not a failure.
      '#!/bin/sh\necho "[self-test stub] simulated gh failure" >&2\nexit 1\n',
    ],
    ['`gh` prints non-JSON (an HTML error page, a warning banner)', '#!/bin/sh\necho "<html>"\n'],
    ['`gh` prints nothing at all', '#!/bin/sh\n'],
  ]
  for (const [label, script] of cases) {
    const { threw, wrote } = drive(script)
    check(
      threw !== null && !wrote,
      `${label} → throws AND writes no results file`,
      `threw=${threw?.message} wrote=${wrote}`,
    )
  }

  // `gh` missing entirely: point $PATH at a directory that has no `gh`.
  {
    const empty = mkdtempSync(join(tmpdir(), 'workflow-liveness-nopath-'))
    const prevPath = process.env.PATH
    const prevLog = console.log
    process.env.PATH = empty
    console.log = () => {}
    let threw = null
    try {
      main(['--repo', 'owner/repo', '--out', out])
    } catch (err) {
      threw = err
    } finally {
      console.log = prevLog
      process.env.PATH = prevPath
    }
    check(
      threw !== null && !existsSync(out),
      'a missing `gh` binary → throws AND writes no results file',
      `threw=${threw?.message} wrote=${existsSync(out)}`,
    )
  }

  // The happy path really does write a file the filer can read, and a stale
  // entry in it really does survive into that file (not silently dropped).
  {
    const runsFile = join(dir, 'runs.json')
    const now = '2026-07-31T19:37:00Z'
    const fresh = (h) => [
      {
        databaseId: 1,
        status: 'completed',
        conclusion: 'success',
        createdAt: ISO(Date.parse(now) - h * HOUR_MS),
      },
    ]
    const fixture = Object.fromEntries(
      WATCHED.map((w) => [w.workflow, w.workflow === 'codeql.yml' ? fresh(400) : fresh(1)]),
    )
    writeFileSync(runsFile, JSON.stringify(fixture), 'utf8')
    const prevLog = console.log
    console.log = () => {}
    try {
      main(['--out', out, '--now', now, '--runs-json-file', runsFile])
    } finally {
      console.log = prevLog
    }
    const written = JSON.parse(readFileSync(out, 'utf8'))
    const reds = Object.entries(written).filter(([, v]) => v.result !== 'success')
    check(
      Object.keys(written).length === WATCHED.length &&
        reds.length === 1 &&
        reds[0][0] === 'codeql.yml' &&
        reds[0][1].result.startsWith('stale '),
      'the written file has one entry per watched workflow and preserves the unhealthy one',
      JSON.stringify(written),
    )
  }
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok  - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const check = (cond, name, detail) => (cond ? ok(name) : fail(name, detail))

  selfTestClassification({ check })
  selfTestWiringGuard({ check, fail })
  selfTestWindows({ check })
  selfTestGhInvocation({ check })
  selfTestGhFailureModes({ check })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Entry-point detection in the one sanctioned form (#3373): both sides
// realpath'd, so a symlinked scripts/ directory or repo root cannot make this
// comparison false and turn the whole guard into a silent no-op.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.slice(2).includes('--self-test')) {
    runSelfTest()
  } else {
    try {
      main()
    } catch (err) {
      console.error(`check-workflow-liveness: ${err.message}`)
      process.exit(1)
    }
  }
}
