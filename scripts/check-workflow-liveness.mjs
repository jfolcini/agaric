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
// ─── Why an empty run list also reads the workflow's STATE (#4478) ───────────
//
// "No scheduled run at all" is three situations wearing one face: a workflow
// added last week whose cron has not come round yet, a workflow whose
// schedule GitHub has DISABLED (it does that to repositories with no recent
// activity), and a workflow this script could not ask about. The runs API
// cannot tell them apart — it returns the same empty list for all three — and
// the difference decides whether anyone should be woken up.
//
// So for that case, and only that case, this script also asks
// `GET /repos/{owner}/{repo}/actions/workflows/{id}`, which reports `state`
// directly. Reading the fact GitHub publishes beats approximating it with a
// clock: a duration threshold can only be tuned, never made correct, because
// one short enough to catch a dead lane quickly will eventually fire on a
// young one. The cost is one extra `gh api` call per watched workflow per
// daily tick.
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
//        [--states-json-file <path>] (TEST-ONLY: `{ "<file>.yml": {"state":
//                                     "active"} | {"error": "…"} }`, the
//                                     workflow-state read #4478 added)
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
 *   * `fuzz-corpus-refresh.yml` (Thu 16:17) does NOT fit that pattern and
 *     needs its own derivation (#4529 review) rather than inheriting the
 *     ~161h/~167h figures above. Its tick-to-cron offset — 19:37 minus 16:17
 *     = 3h20m — is SMALLER than this repo's measured weekly-cron delivery lag
 *     (3.15h–6.25h, borrowed from `scheduled-deep-checks` for the reason
 *     stated in this workflow's own header), unlike the Monday/Tuesday lanes
 *     whose 13–15h offsets clear that range comfortably. So the run's actual
 *     start (16:17 + lag = 19:26–22:32) is routinely AFTER the same-day 19:37
 *     tick, and that tick reads the PREVIOUS week's run instead — the
 *     ordinary healthy case for this lane looks like the Monday lanes'
 *     SKIPPED-week case, every week. Worst-case age there: one period plus
 *     the tick offset, less how early last week's own run posted — using
 *     this repo's smallest measured lag (3.15h) for that reference run:
 *     168h + 3h20m − 3.15h ≈ 168.2h. That clears 200h with ~31.8h of
 *     headroom, in the same neighbourhood as the Monday/Tuesday lanes' ~33h,
 *     so the shared 200h value already covers it — nothing here changes
 *     `maxAgeHours`; only the reasoning for why it still holds is new.
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
    workflow: 'fuzz-corpus-refresh.yml',
    periodHours: 168,
    maxAgeHours: 200,
    why: 'weekly Thu 16:17 UTC; refreshes the fuzz-corpus-* cache entry access timestamp midway between fuzz lane runs so the 7-day eviction margin does not depend on the fuzz lane alone (#4504)',
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
 * Filters, times and sorts one workflow's `schedule`-event runs newest-first —
 * the exact selection `classifyWorkflow` and `newestCompletedRunId` (#4400)
 * share. Kept as one function for that reason: two independent copies of
 * "which run is newest" are two copies that can drift, which is the same
 * class of scanner-desync `stripComments`'s docstring warns about, just
 * between functions instead of within one.
 *
 * Sharing the selection does NOT mean `newestCompletedRunId`'s return value
 * always names the run `classifyWorkflow`'s `result` string describes —
 * correction, #4456 review of #4440: that was claimed here before and it is
 * only true for a `result` of `failure (…)`. For every other verdict —
 * `stale` above all — the newest COMPLETED run (if there is even one) can be
 * an older, unrelated, successful run that has nothing to do with the
 * reported status: `stale` is decided from `considered[0]`, which may not
 * even be completed. `buildResults` (below) is written around exactly that
 * gap: it forwards `newestCompletedRunId`'s id only for `failure (…)`, and
 * leaves `stale` to be identified a different way entirely (see its doc).
 *
 * That is also why the corrupt-payload refusal lives HERE rather than in each
 * caller (#4440 review): `classifyWorkflow` threw on a non-array while
 * `newestCompletedRunId` returned `null` for the same payload, and null is
 * the "no run to point at" value the filer's `advanceStreaks` HOLDS on — so a
 * caller reading only the run id would have taken corrupt data for a quiet
 * week. Every reader of this selection now refuses the same input, which is
 * the posture the rest of this file takes: unknown is not green.
 */
function orderedRuns({ runs, workflow, excludeRunId }) {
  if (!Array.isArray(runs)) {
    throw new Error(
      `${workflow}: the run list is not a JSON array — refusing to assume it is healthy`,
    )
  }
  return runs
    .filter(
      (r) => excludeRunId === undefined || String(r?.databaseId ?? '') !== String(excludeRunId),
    )
    .map((r) => ({
      status: r?.status,
      conclusion: r?.conclusion,
      databaseId: r?.databaseId,
      startedAtMs: runStartedAt(r, workflow),
    }))
    .toSorted((a, b) => b.startedAtMs - a.startedAtMs)
}

/**
 * Classifies one watched workflow from its `schedule`-event run list.
 *
 * Returns a `result` string consumed by `file-scheduled-failures.mjs`, where
 * ONLY the literal `'success'` counts as healthy (`isFailing` there). Every
 * other string is a failure and is rendered verbatim in the tracking issue's
 * status table, so the detail (age, conclusion) travels with the signal while
 * dedup still keys on the workflow name alone.
 *
 * A payload that is not an array of runs THROWS (in `orderedRuns`) rather
 * than classifying: `Date.parse('nonsense')` is NaN and every `NaN > limit`
 * is false, so anything swallowed here reads as fresh and healthy.
 */
export function classifyWorkflow({
  runs,
  nowMs,
  workflow,
  maxAgeHours,
  excludeRunId,
  scheduleState,
}) {
  const considered = orderedRuns({ runs, workflow, excludeRunId })

  if (considered.length === 0) {
    // #4478 — an empty run list is THREE different situations, and they need
    // opposite handling. Which one it is cannot be read from the run list (it
    // is empty in all three), so it is read from the workflow's own `state`.
    //
    // ─── The defect ───────────────────────────────────────────────
    //
    // `stale` is decided from `considered[0]`, so a workflow that has never
    // produced one `schedule` run could not reach it however long it sat
    // here: it stayed `never-ran`, kept `runId: null`, and `advanceStreaks`
    // HELD its count at 1 forever. GitHub disables scheduled workflows in
    // repositories with no recent activity, and a disabled schedule produces
    // no runs at all — so the single event most worth noticing arrives here
    // and was the one thing this watchdog structurally could not report. That
    // is #4456's frozen-identity exemption, surviving in the one state #4456
    // deliberately did not reach.
    //
    // ─── Why the STATE, and not a clock ──────────────────────────────
    //
    // GitHub disabling a schedule for repository inactivity is a STATE, not a
    // duration, and `GET /repos/{owner}/{repo}/actions/workflows/{id}` reports
    // it directly as `disabled_inactivity`. The two rejected alternatives both
    // approximate that state with a clock instead — escalate once the WATCHED
    // entry has been tracked longer than its own period (which needs a
    // first-seen timestamp the state does not carry), or escalate on poll
    // identity immediately — and a clock can only ever be tuned, never made
    // correct: any threshold that escalates a dead lane fast enough will
    // eventually page someone about a young one, and any threshold that never
    // does will eventually sit on a dead one. Reading the fact GitHub already
    // publishes has no such dial (jfolcini, scoping #4478).
    //
    // The cost that made this look invasive is one `gh api` call per WATCHED
    // entry, ONCE PER WATCHDOG TICK — not per PR, and not per lane per poll.
    // At this set's size that is not a budget question.
    //
    // ─── An unreadable state is its OWN answer ────────────────────────
    //
    // The new failure mode the API read adds — the call itself failing — has
    // the answer the rest of this file already uses: report the uncertainty
    // rather than resolving it in either direction. So it is a THIRD verdict,
    // never folded into `never-ran` (which would silently assume "young", the
    // precise bug being fixed here, reachable by an API outage) and never
    // folded into `schedule-disabled` (which would assert a fact this process
    // does not have). A watchdog that says "I could not determine whether
    // this lane is disabled" is behaving correctly.
    //
    // It is a verdict rather than a THROW — the posture `fetchScheduleRuns`
    // takes — for one specific reason: this is a SECONDARY question. `--out`
    // is written only after every lane is classified, so throwing here would
    // discard every other lane's perfectly good answer over a refinement to
    // one lane's empty case. The run-list throw is not comparable: a failed
    // run fetch means that lane's health is entirely unknown.
    //
    // ─── RESIDUAL: this does not cover a malformed cron ───────────────
    //
    // Stated plainly because #4478 names it: a workflow GitHub reports as
    // `active` which is nevertheless never scheduled — a cron expression
    // malformed enough that no run is ever created — lands in the `never-ran`
    // branch below and is held at count 1 exactly as before. The state read
    // answers "did GitHub turn this off", which is the case #4478 evidences;
    // it does not answer "is this cron reachable". That second case is NOT
    // covered here and must not be read as covered.
    const state =
      typeof scheduleState?.state === 'string' && scheduleState.state.length > 0
        ? scheduleState.state
        : null

    if (state === null) {
      const why = scheduleState?.error ?? 'no workflow state was read for it at all'
      return `schedule-state-unknown (no \`schedule\` run of ${workflow} found at all, and whether GitHub has DISABLED its schedule could not be determined: ${why})`
    }

    // Classified POSITIVELY: `active` is the one state in which a schedule is
    // enabled, so every other value — `disabled_inactivity`,
    // `disabled_manually`, `disabled_fork`, and whatever GitHub adds next —
    // reads as "not running, and not because it is young". A deny-list of
    // known-bad states would wave through the next value nobody thought of,
    // which is the fail-open direction, in the one lane whose job is silence.
    if (state !== 'active') {
      return `schedule-disabled (no \`schedule\` run of ${workflow} found at all, and GitHub reports its state as \`${state}\` — a disabled schedule produces no runs, so this cannot resolve itself)`
    }

    return `never-ran (no \`schedule\` run of ${workflow} found at all, but GitHub reports the workflow \`active\` — a schedule that has not fired YET)`
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

/**
 * #4400 — the numeric id of the newest COMPLETED scheduled run, or `null`
 * when there isn't one (never-ran / stale-with-nothing-completed / every
 * candidate still in-progress — the same cases `classifyWorkflow` reports as
 * `never-ran`/`no-completed-run`, or as `stale` over a run that never
 * completed).
 *
 * This is the identity `file-scheduled-failures.mjs`'s consecutive-failure
 * counter keys on (see its `advanceStreaks`) for a GENUINE `failure (…)`
 * verdict: the watchdog polls DAILY but most of the workflows it watches run
 * WEEKLY, so "the same completed run observed again" and "a genuinely new
 * completed run" must be distinguishable from something sturdier than "the
 * poll happened" — a null here is the explicit "no run to point at", which
 * that counter must hold on rather than either advance or reset from, exactly
 * like `--skipped-ok`'s `carriedOverJobs` treats "it did not run" as neither a
 * failure nor a recovery.
 *
 * #4456 — `buildResults` deliberately does NOT forward this function's return
 * value at all when the verdict is `stale`, even though this function would
 * happily return a real, non-null id for it (the last completed run before
 * the schedule died). That id would be the WRONG identity for a dead cron:
 * it never changes, so keying the streak on it holds the lane at count 1
 * forever — the single failure mode this watchdog exists to catch, exempted
 * from ever escalating. See `buildResults`'s doc for what a `stale` lane is
 * identified by instead. This function's contract is unchanged; only one of
 * its two callers stopped trusting its answer for one specific verdict.
 *
 * Which is exactly why a corrupt payload must NOT come back as null here: a
 * null is a positive claim that there is no run to point at, and the counter
 * holds on it, so "the JSON was not a run list" would arrive as a quiet week
 * (#4440 review). `orderedRuns` throws on that input for every caller — this
 * function no longer has a return path for data it could not read.
 */
export function newestCompletedRunId({ runs, workflow, excludeRunId }) {
  const completed = orderedRuns({ runs, workflow, excludeRunId }).find(
    (r) => r.status === 'completed',
  )
  return completed?.databaseId ?? null
}

/**
 * #4456 — whether a `classifyWorkflow` verdict's lane should carry
 * `newestCompletedRunId`'s answer as its `runId`.
 *
 * An ALLOW-LIST over the verdicts `classifyWorkflow` actually mints, not a
 * deny-list on `stale (`, and the difference is the whole bug this ticket is
 * about. A deny-list answers "carry the frozen id" for every string it has
 * never heard of, so the next verdict anyone adds — a `schedule-disabled (…)`,
 * a reworded `stale`, anything — is born with #4456's exemption already in it:
 * a lane whose identity never changes, held at count 1, escalating never, and
 * looking exactly like a healthy lane while it does. That is this watchdog's
 * one failure mode (silence) reintroduced by omission, which is how it got
 * here the first time.
 *
 * Classified positively, an unrecognised verdict instead falls through to NO
 * `runId`, so `advanceStreaks` counts it per watchdog poll and it escalates
 * LOUDLY. That is the right default for a watchdog specifically: a new state
 * nobody has reasoned about yet is worth three days of polls and one comment,
 * whereas the silent direction costs an unbounded number of unreported weeks.
 * Keep this in sync with `classifyWorkflow`'s returns — the self-test pins
 * every one of them, plus an unknown string, so drift fails closed here.
 *
 * #4478 — the `schedule-disabled (…)` this doc named as a HYPOTHETICAL next
 * verdict is now a real one, and it arrived through exactly the door
 * described above: it is absent from the list below DELIBERATELY, and that
 * absence IS its escalation mechanism, not an oversight. Falling through to
 * no `runId` is what hands the streak to `advanceStreaks`' `fallbackRunId` —
 * the watchdog's own run URL — so one poll that still finds a disabled
 * schedule is one occurrence, the identical treatment #4456 gave `stale` for
 * the identical reason: there is no run to name. `schedule-state-unknown (…)`
 * is absent for the same reason; see `classifyWorkflow` for why an unreadable
 * state must not be resolved into either neighbour.
 *
 * `never-ran (` — now meaning ONLY "GitHub says `active`, it just has not
 * fired yet" — stays in the list, keeping its `runId: null` hold, because a
 * workflow that is merely young must not page anyone (#4440). Those two lines
 * are the two acceptance arms of #4478, and `selfTestNeverRanScheduleState`
 * pins them, plus the third.
 */
export function carriesRunId(result) {
  return (
    result === 'success' ||
    result.startsWith('failure (') ||
    result.startsWith('never-ran (') ||
    result.startsWith('no-completed-run (')
  )
}

/**
 * Classifies every watched workflow into the `${{ toJSON(needs) }}` shape.
 *
 * #4456 — `stale` deliberately gets NO `runId` key at all, never the newest
 * completed run's id. That id is the wrong identity for it: `stale` means the
 * watched workflow's SCHEDULE has stopped firing, so the newest completed run
 * (if there is even one) is frozen wherever it last was — often an old,
 * successful run with nothing to do with why the workflow is unhealthy now.
 * Handing that frozen id to `advanceStreaks` as `runId` made a dead cron
 * compare "equal to last time" on every single poll, forever: the counter
 * held at 1 and the worst failure mode this watchdog exists to catch — a
 * schedule that has stopped running at all — was structurally exempt from
 * ever escalating (jfolcini, review of #4440).
 *
 * Omitting the key (rather than writing an explicit `null`, which is
 * `never-ran`'s and `no-completed-run`'s "identity unknowable, HOLD" — see
 * `advanceStreaks`) makes `parseNeeds` never set `runId` on that lane, so
 * `advanceStreaks` falls back to `fallbackRunId`: THIS watchdog RUN's own
 * identity. That is exactly the mechanism the deep-checks profile already
 * relies on for every one of its own lanes ("one invocation of this script
 * already IS one real occurrence" — see `advanceStreaks`'s doc), applied here
 * for the same reason: a watchdog poll that observes "still not running" IS a
 * new, real, distinct observation of the dead cron, even though the cron
 * itself has produced nothing new to point at. A `stale` lane on a weekly
 * cadence (`periodHours: 168`, `escalationThreshold` 3) now escalates after
 * three DISTINCT daily polls that observe it still stale, instead of never.
 *
 * `never-ran` and `no-completed-run` keep the pre-#4456 null-hold behaviour
 * on purpose (`newestCompletedRunId` already answers `null` for both, so no
 * special case is needed for them here), and `carriesRunId` above says so
 * POSITIVELY rather than by exclusion — see its doc for why the shape of that
 * test is load-bearing.
 *
 * `no-completed-run` really is short-lived: `classifyWorkflow` reaches it only
 * when `considered[0]` is INSIDE the freshness window and merely
 * queued/in-progress, so the next poll either sees it complete (a real id,
 * adopted) or sees it age past `maxAgeHours` and reclassify as `stale`, at
 * which point THIS escalation path takes over.
 *
 * `never-ran` is NOT short-lived, and this is a stated RESIDUAL rather than a
 * claim that it resolves (review of #4456 — an earlier draft of this comment
 * asserted it "resolves into `stale` once `maxAgeHours` elapses", which is
 * false: `classifyWorkflow` returns `never-ran` from `considered.length === 0`
 * and reaches the `stale` branch only via `considered[0]`, so a workflow that
 * has never produced ONE `schedule` run — a cron that has never fired, a
 * schedule GitHub never enabled — stays `never-ran` for as long as that holds,
 * verified by classifying an empty run list at +1d/+30d/+365d). Such a lane
 * still gets exactly one first-failure comment and is then held at count 1
 * forever, i.e. the #4456 exemption survives in that one state. It is left
 * alone here deliberately: the null-hold for `never-ran` is the rule the #4440
 * review widened ON PURPOSE (see `advanceStreaks`'s identity-less-prior doc),
 * and reversing it is a second design decision, not a consequence of this one.
 *
 * #4478 IS that second decision, and it is now made. The paragraph above is
 * kept UNEDITED, because it is what made the gap findable and #4478 asks
 * explicitly that it not be deleted — but it is no longer true end to end,
 * and saying otherwise here would reproduce the exact defect #4454 names (a
 * caveat that enumerates one limitation and omits the larger one). One clause
 * of it is SUPERSEDED: "a schedule GitHub never enabled" no longer stays
 * `never-ran`, and the "held at count 1 forever" sentence no longer describes
 * that lane — moving precisely that lane out of the exemption is what this
 * change does. The rest still holds exactly as written: the `considered[0]`
 * control flow, the +1d/+30d/+365d verification, and the point that
 * `never-ran` is not short-lived the way `no-completed-run` is.
 *
 * What changed is which lanes the paragraph describes. An empty run list is no
 * longer one verdict but three, split on the workflow's own `state` as GitHub
 * reports it rather than on any clock:
 *
 *   * `never-ran (` — GitHub says `active`; the schedule simply has not fired
 *     yet. Still carries `runId: null`, and the held-at-1 behaviour described
 *     above is still exactly what happens, which is the POINT: a newly added
 *     workflow legitimately has no runs and must not page anyone.
 *   * `schedule-disabled (` — GitHub reports a non-`active` state, i.e. it
 *     turned the schedule off (`disabled_inactivity` is the case #4478
 *     evidences). Not named by `carriesRunId`, so it takes the same
 *     key-absent path `stale` takes above and escalates on distinct polls.
 *   * `schedule-state-unknown (` — the state could not be read. Also
 *     key-absent, so the unanswered question itself escalates rather than
 *     being quietly resolved into "young"; see `classifyWorkflow`.
 *
 * So the `never-ran`/`stale` asymmetry the paragraph above documents is still
 * real in `classifyWorkflow`'s control flow — a lane with no runs never
 * reaches the `stale` branch — but it no longer implies an escalation
 * exemption, because the states that mean "this will not fix itself" now take
 * `stale`'s own poll-identity path.
 */
export function buildResults({
  runsByWorkflow,
  statesByWorkflow = {},
  nowMs,
  excludeRunId,
  watched = WATCHED,
}) {
  const out = {}
  for (const entry of watched) {
    const runs = runsByWorkflow[entry.workflow]
    if (runs === undefined) {
      throw new Error(`${entry.workflow}: no run list was fetched — health is UNKNOWN, not green`)
    }
    const excl = entry.selfExcluded ? excludeRunId : undefined
    // #4478 — a MISSING state entry is not an error here, unlike a missing
    // run list above, and the asymmetry is deliberate: `classifyWorkflow`
    // consults the state only when the run list is EMPTY, so for every lane
    // that has runs an unread state changes nothing and must not take the
    // whole tick down. Where it IS consulted, absence is not silently benign
    // either — it becomes the visible `schedule-state-unknown` verdict.
    const result = classifyWorkflow({
      runs,
      nowMs,
      workflow: entry.workflow,
      maxAgeHours: entry.maxAgeHours,
      excludeRunId: excl,
      scheduleState: statesByWorkflow[entry.workflow],
    })
    const entryOut = { result, periodHours: entry.periodHours }
    // #4400 / #4456 / #4478 — carried through so `file-scheduled-failures.mjs`
    // can key its consecutive-failure counter on the actual watched run's
    // identity and pick the right escalation threshold for its cadence — but
    // only for the verdicts `carriesRunId` names, which `stale` (#4456),
    // `schedule-disabled` and `schedule-state-unknown` (#4478) are
    // deliberately not among: for those the key is left off entirely, so the
    // filer's own poll identity takes over instead of a frozen run id or an
    // unknowable-and-therefore-held `null`.
    if (carriesRunId(result)) {
      entryOut.runId = newestCompletedRunId({ runs, workflow: entry.workflow, excludeRunId: excl })
    }
    out[entry.workflow] = entryOut
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

/**
 * #4478 — whether GitHub has this workflow's schedule turned ON, from
 * `GET /repos/{owner}/{repo}/actions/workflows/{id}`, which reports `state`:
 * `active`, or one of the `disabled_*` values (`disabled_inactivity` being
 * the one this ticket exists for — GitHub disables scheduled workflows in
 * repositories with no recent activity, and a disabled schedule produces no
 * runs at all, which is indistinguishable from a young one in the runs API).
 *
 * The ONE function in this file that does not throw on failure, and the
 * exception is reasoned rather than convenient. Everything else here refuses
 * to answer from data it could not read because the alternative is reporting
 * health it cannot substantiate. This call is different in kind: it refines a
 * question already answered (the run list, which came back empty), and it is
 * consulted for one lane at a time while `--out` is written only after ALL of
 * them are classified. Throwing would therefore discard every other lane's
 * good answer over a refinement to one lane's edge case — trading a small
 * unknown for a total one.
 *
 * So the failure is CARRIED, in `error`, and becomes the visible
 * `schedule-state-unknown` verdict rather than either a silent "young" or an
 * asserted "disabled". `gh` missing or non-zero, output that is not JSON, an
 * empty read, and the literal `null`/`undefined` that `--jq` prints for a
 * missing key all land there, each carrying its own reason into the tracking
 * issue so the reader is told WHY the watchdog could not answer.
 *
 * Scope of that claim, stated precisely because the bug this guard closes was
 * a claim that outran its code: the unusable-payload rejection is an explicit
 * two-value check on `'null'` and `'undefined'`, NOT a general "anything
 * unusable". A `.state` that were `false` or numeric would stringify and read
 * as a state. That is theoretical while GitHub keeps `state` a string enum,
 * and it is named here rather than papered over with "every way".
 */
export function fetchWorkflowState(repo, workflow) {
  let raw
  try {
    raw = execFileSync(
      'gh',
      ['api', `repos/${repo}/actions/workflows/${workflow}`, '--jq', '.state'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    )
  } catch (err) {
    return { error: `\`gh api\` failed (${err.message.split('\n')[0]})` }
  }
  const state = raw.trim()
  if (state.length === 0) {
    return { error: '`gh api` returned no `state` field for this workflow' }
  }
  // `--jq '.state'` on a payload with NO `state` key prints the literal four
  // characters `null`, not an empty string — gojq marshals a missing key that
  // way. So the length check above passes and `state` becomes the STRING
  // "null", which is not `'active'` and would therefore be reported as
  // ``schedule-disabled (… state as `null` …)``: the watchdog asserting that
  // GitHub disabled a schedule, on evidence that GitHub said nothing at all.
  // That is the same overstates-the-evidence shape this file's #4478 work is
  // about, so it is rejected here rather than classified downstream.
  if (state === 'null' || state === 'undefined') {
    return {
      error: `\`gh api\` returned \`${state}\` for \`.state\` — the payload has no usable state field`,
    }
  }
  return { state }
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
      case '--states-json-file': {
        args.statesJsonFile = argv[++i]
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
  let statesByWorkflow
  if (args.runsJsonFile !== undefined) {
    runsByWorkflow = JSON.parse(readFileSync(args.runsJsonFile, 'utf8'))
    statesByWorkflow =
      args.statesJsonFile === undefined ? {} : JSON.parse(readFileSync(args.statesJsonFile, 'utf8'))
  } else {
    const repo = args.repo ?? process.env.GITHUB_REPOSITORY
    if (!repo) throw new Error('--repo (or $GITHUB_REPOSITORY) is required outside fixture mode')
    runsByWorkflow = {}
    statesByWorkflow = {}
    for (const entry of WATCHED) {
      runsByWorkflow[entry.workflow] = fetchScheduleRuns(repo, entry.workflow)
      // #4478 — unconditionally, one call per watched entry per tick, even
      // for lanes whose run list will turn out to be non-empty and whose
      // state is therefore never consulted. Fetching it lazily inside
      // `buildResults` would save those calls, at the price of putting a
      // network call inside the pure classifier the whole fixture suite is
      // built on. The cost being avoided is a handful of `gh api` calls once
      // a day; the cost being paid would be a classifier that cannot be
      // driven from a file.
      statesByWorkflow[entry.workflow] = fetchWorkflowState(repo, entry.workflow)
    }
  }

  const results = buildResults({
    runsByWorkflow,
    statesByWorkflow,
    nowMs,
    excludeRunId: args.excludeRunId,
  })

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
  // #4478 — the helper supplies `state: 'active'` by default so every
  // assertion below keeps asking the question it was written to ask (an
  // empty run list on a LIVE schedule is `never-ran`). The other two states,
  // and the absence of any state at all, are driven explicitly in
  // `selfTestNeverRanScheduleState`, which is where that three-way belongs.
  const classify = (runs, extra = {}) =>
    classifyWorkflow({
      runs,
      nowMs: now,
      workflow: 'w.yml',
      maxAgeHours: 40,
      scheduleState: { state: 'active' },
      ...extra,
    })

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
      statesByWorkflow: Object.fromEntries(WATCHED.map((w) => [w.workflow, { state: 'active' }])),
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
  //
  // Each case requires this file's OWN refusal — every guard here prefixes
  // the workflow name — not merely that something threw. Two of these
  // payloads make `runs.filter` raise a bare `TypeError` all by themselves,
  // so `threw !== null` is true whether the guard exists or not: deleting the
  // array check left this assertion green (found by mutation-testing it while
  // fixing #4440's note 4). An assertion satisfied by an accident of the
  // language is not coverage of a guard.
  const refusedBy = (err) => err !== null && err.message.startsWith('w.yml: ')
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
    check(
      refusedBy(threw),
      `classification rejects ${label}`,
      threw === null
        ? 'no throw — would read as healthy'
        : `not this file’s guard: ${threw.message}`,
    )

    // #4440 review — and so does the OTHER reader of the same selection.
    // `newestCompletedRunId` used to answer `null` for a payload
    // `classifyWorkflow` refused, and null is not "unreadable": it is the
    // explicit "no completed run to point at" that the filer's
    // `advanceStreaks` HOLDS on. A caller reading only the run id would have
    // taken corrupt data for a quiet week — the fail-open posture the rest of
    // this file rejects. Unreachable through `buildResults` today (the
    // `result` property is evaluated first and throws), which is precisely
    // why it needs an assertion of its own rather than the end-to-end one.
    let idThrew = null
    try {
      newestCompletedRunId({ runs, workflow: 'w.yml' })
    } catch (err) {
      idThrew = err
    }
    check(
      refusedBy(idThrew),
      `\`newestCompletedRunId\` rejects ${label} too, rather than answering "no run to point at"`,
      idThrew === null
        ? 'no throw — a corrupt payload would read as a held streak'
        : `not this file’s guard: ${idThrew.message}`,
    )
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
      w.maxAgeHours > 168.2 && w.maxAgeHours < 209,
      `${w.workflow}: the weekly window clears the ~168.2h worst healthy age (the Thursday lane's, per the WATCHED docstring) and still trips within a day of a missed week`,
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
 *     one repo-wide run list, so a single live workflow makes every watched
 *     entry read healthy.
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

  // #4478 — and the SECOND query, the one that tells a disabled schedule from
  // a young one. Same reasoning as the four above: nothing in
  // `selfTestNeverRanScheduleState` pins the request that produces the state
  // it classifies, and each part of it fails silently. A path missing the
  // workflow name lists every workflow in the repo (the first one's state
  // would then be reported for all of them); a path missing the repo asks
  // about the wrong repository; losing `.state` returns a JSON blob that is
  // not a state string, which reads as `schedule-state-unknown` on every lane
  // forever — a watchdog that has stopped being able to answer the question
  // while still filing an issue every day.
  {
    const stateDir = mkdtempSync(join(tmpdir(), 'workflow-liveness-state-argv-'))
    const stateArgvFile = join(stateDir, 'argv.txt')
    const stateStub = join(stateDir, 'gh')
    writeFileSync(
      stateStub,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(stateArgvFile)}\nprintf 'active'\n`,
      'utf8',
    )
    chmodSync(stateStub, 0o755)
    const prev = process.env.PATH
    process.env.PATH = `${stateDir}:${prev}`
    let got
    try {
      got = fetchWorkflowState('owner/repo', 'codeql.yml')
    } finally {
      process.env.PATH = prev
    }
    const stateArgv = readFileSync(stateArgvFile, 'utf8')
      .split('\n')
      .filter((x) => x.length > 0)
    const stateSeen = stateArgv.join(' ')
    check(
      stateArgv[0] === 'api' && stateArgv.includes('repos/owner/repo/actions/workflows/codeql.yml'),
      '#4478: the state read asks the workflows API for THE ONE workflow in THE asked-about repo, by path',
      stateSeen,
    )
    check(
      stateArgv.includes('--jq') && stateArgv[stateArgv.indexOf('--jq') + 1] === '.state',
      '#4478: the state read extracts `.state` — without it the payload is a JSON blob that is not a state, and every lane reads unknown forever',
      stateSeen,
    )
    check(
      got.state === 'active' && got.error === undefined,
      '#4478: a readable state comes back as a state, with no error alongside it',
      JSON.stringify(got),
    )
  }

  // …and every way the state read can fail comes back as an `error` the
  // classifier can report, never as a thrown tick and never as an invented
  // `state`. Driven for real against stub `gh`s, like the run-list failure
  // modes below.
  for (const [label, script] of [
    [
      '`gh api` exits non-zero (404, rate limit, auth)',
      '#!/bin/sh\necho "[self-test stub] simulated gh api failure" >&2\nexit 1\n',
    ],
    ['`gh api` prints nothing (no `state` field in the payload)', '#!/bin/sh\n'],
  ]) {
    const failDir = mkdtempSync(join(tmpdir(), 'workflow-liveness-state-fail-'))
    const failStub = join(failDir, 'gh')
    writeFileSync(failStub, script, 'utf8')
    chmodSync(failStub, 0o755)
    const prev = process.env.PATH
    process.env.PATH = `${failDir}:${prev}`
    let got = null
    let threw = null
    try {
      got = fetchWorkflowState('owner/repo', 'codeql.yml')
    } catch (err) {
      threw = err
    } finally {
      process.env.PATH = prev
    }
    check(
      threw === null && got?.state === undefined && typeof got?.error === 'string',
      `#4478: ${label} → carried as an \`error\`, not thrown and not guessed`,
      threw === null ? JSON.stringify(got) : `threw: ${threw.message}`,
    )
  }
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

  // A payload with NO `state` key: `--jq '.state'` prints the literal four
  // characters `null`, which clears the empty-string guard and would otherwise
  // become the STRING "null" — reported as ``schedule-disabled (… state as
  // `null` …)``, i.e. the watchdog asserting GitHub disabled a schedule on
  // evidence that GitHub said nothing. Driven against `fetchWorkflowState`
  // directly, because the point is which BRANCH the value lands in.
  for (const literal of ['null', 'undefined']) {
    writeFileSync(stub, `#!/bin/sh\necho ${literal}\n`, 'utf8')
    chmodSync(stub, 0o755)
    const prevPath = process.env.PATH
    process.env.PATH = `${dir}:${prevPath}`
    let got
    try {
      got = fetchWorkflowState('owner/repo', 'w.yml')
    } finally {
      process.env.PATH = prevPath
    }
    check(
      got.state === undefined && typeof got.error === 'string' && got.error.includes(literal),
      `#4478: \`.state\` printed as the literal \`${literal}\` is an ERROR, not a state — it must not read as \`schedule-disabled\``,
      JSON.stringify(got),
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
    // #4400 — the TYPE of `runId` in this file is load-bearing, not
    // incidental: `file-scheduled-failures.mjs` persists it into an issue
    // body as TEXT and reads it back as a string, so its `advanceStreaks`
    // has to coerce before comparing. A fixture that quietly used strings
    // here (or a future change that stringified `databaseId` on the way out)
    // would make the consumer's round trip look type-stable when production
    // is not. Pinned positively: every NON-STALE entry is a NUMBER, never
    // anything else.
    //
    // #4456 — the `stale` entry (`codeql.yml`) must have NO `runId` key at
    // all, not an explicit `null`. Checked by PRESENCE, not by value: a
    // `some(number) && every(null-or-number)` shape (the pre-#4456 form of
    // this assertion) stays green even if a regression quietly starts
    // writing `runId: null` back onto a `stale` entry — `null` is still
    // "null, not a number" either way, so that shape can never tell "omitted"
    // and "explicit null" apart, and the one bug this rewrite exists to catch
    // is exactly a `stale` entry regaining an identity that never changes.
    const nonStale = Object.entries(written).filter(([, v]) => !v.result.startsWith('stale ('))
    const staleEntries = Object.entries(written).filter(([, v]) => v.result.startsWith('stale ('))
    check(
      staleEntries.length === 1 &&
        staleEntries[0][0] === 'codeql.yml' &&
        !('runId' in staleEntries[0][1]) &&
        // `some` already implies non-empty, so an "at least one" guard would
        // be the useless length check oxlint's `no-useless-length-check`
        // rejects.
        nonStale.some(([, v]) => typeof v.runId === 'number') &&
        nonStale.every(([, v]) => typeof v.runId === 'number'),
      '`runId` is a NUMBER for every non-`stale` entry, and OMITTED ENTIRELY (not `null`) for the `stale` one (#4456)',
      JSON.stringify(
        Object.fromEntries(
          Object.entries(written).map(([k, v]) => [k, 'runId' in v ? typeof v.runId : 'ABSENT']),
        ),
      ),
    )
    // #4400, latent-hazard guard — the filer encodes one tracked lane per
    // marker line as `job|count|runId` and splits on `|`. A watched workflow
    // FILENAME is that `job` field, so a `|` in one would silently corrupt
    // both `parseKnownLanes` and `parseKnownStreaks`. Allow-listed rather
    // than deny-listed (a deny-list of "bad" characters fails open on the
    // next one nobody thought of), and asserted here, at the source of those
    // ids, rather than defended against in a parser that cannot tell a
    // corrupt line from an exotic one.
    const oddNames = WATCHED.map((w) => w.workflow).filter((n) => !/^[A-Za-z0-9._-]+$/.test(n))
    check(
      oddNames.length === 0,
      'every watched workflow filename is plain `[A-Za-z0-9._-]` — safe as a `|`-delimited marker-line field',
      oddNames.join(', '),
    )
  }
}

/**
 * #4456 — `buildResults`' runId-omission rule, pinned directly against every
 * classification it distinguishes, rather than only through the single
 * `codeql.yml` fixture inside `selfTestGhFailureModes`'s happy path above.
 *
 * The defect this exists for: `stale` used to carry `newestCompletedRunId`'s
 * answer just like every other verdict, and that answer is a REAL, NON-NULL,
 * NEVER-CHANGING id whenever the dead workflow had ever completed a run
 * before its schedule died. `advanceStreaks` then read "same id as last time"
 * on every single poll, forever, and the counter held at 1 — the worst
 * failure mode this watchdog exists to catch was structurally exempt from
 * ever escalating (jfolcini, review of #4440). The fix is a targeted
 * OMISSION, not a value change, so this test checks presence of the `runId`
 * key, not merely what it holds once present.
 */
function selfTestStaleRunIdOmission({ check }) {
  const now = Date.parse('2026-07-31T19:37:00Z')
  const run = (agoHours, status, conclusion, databaseId = 1) => ({
    databaseId,
    status,
    conclusion,
    createdAt: ISO(now - agoHours * HOUR_MS),
  })
  const watched = [{ workflow: 'w.yml', periodHours: 168, maxAgeHours: 40 }]
  const classify = (runsByWorkflow) =>
    buildResults({
      runsByWorkflow,
      // #4478 — `active`, so the empty-run-list case below stays the
      // `never-ran` it was written to be about. The disabled/unknown states
      // are `selfTestNeverRanScheduleState`'s subject.
      statesByWorkflow: { 'w.yml': { state: 'active' } },
      nowMs: now,
      watched,
    })['w.yml']

  const stale = classify({ 'w.yml': [run(55.6, 'completed', 'success')] })
  check(
    stale.result.startsWith('stale (') && !('runId' in stale),
    '#4456: a `stale` verdict OMITS `runId` entirely — not the frozen completed run id, and not an explicit `null`',
    JSON.stringify(stale),
  )

  const neverRan = classify({ 'w.yml': [] })
  check(
    neverRan.result.startsWith('never-ran (') && 'runId' in neverRan && neverRan.runId === null,
    'a `never-ran` verdict still writes an explicit `null` — unchanged by #4456 (its identity-less-prior adoption path in `advanceStreaks` already covers it)',
    JSON.stringify(neverRan),
  )

  const noCompleted = classify({ 'w.yml': [run(0.2, 'queued', null, 9)] })
  check(
    noCompleted.result.startsWith('no-completed-run (') &&
      'runId' in noCompleted &&
      noCompleted.runId === null,
    'a `no-completed-run` verdict still writes an explicit `null` — unchanged by #4456',
    JSON.stringify(noCompleted),
  )

  const failure = classify({ 'w.yml': [run(2, 'completed', 'failure', 555)] })
  check(
    failure.result.startsWith('failure (') && failure.runId === 555,
    'a genuine `failure` verdict still carries the real completed run id, unchanged by #4456',
    JSON.stringify(failure),
  )

  const success = classify({ 'w.yml': [run(2, 'completed', 'success', 777)] })
  check(
    success.result === 'success' && success.runId === 777,
    'a `success` verdict still carries a real run id too — harmless, since a healthy lane is never in `currentFailing`',
    JSON.stringify(success),
  )

  // The five above are every verdict `classifyWorkflow` mints today. This one
  // is the SIXTH case — the one nobody has written yet — and it is the whole
  // reason `carriesRunId` is an allow-list. Asserted through the predicate
  // itself rather than through `buildResults`, because there is no fixture
  // that makes `classifyWorkflow` return an unknown string: the point is what
  // happens the day someone adds one.
  check(
    carriesRunId('success') &&
      carriesRunId('failure (x)') &&
      carriesRunId('never-ran (x)') &&
      carriesRunId('no-completed-run (x)') &&
      !carriesRunId('stale (x)') &&
      // #4478 — the two verdicts that mean "this schedule is not going to
      // produce a run" are NOT in the allow-list, which is what makes them
      // escalate. Pinned here beside `stale` because the three now share one
      // mechanism, and an edit that "tidied" this predicate by collapsing the
      // `never-ran`/`schedule-*` prefixes would restore the exemption in
      // silence. `schedule-disabled` used to be this assertion's example of a
      // verdict that did not exist yet — hence the replacement below.
      !carriesRunId('schedule-disabled (x)') &&
      !carriesRunId('schedule-state-unknown (x)') &&
      !carriesRunId('schedule-drifted (a verdict that does not exist yet)') &&
      !carriesRunId('stale: reworded'),
    '#4456: `carriesRunId` is an ALLOW-LIST — an unrecognised verdict omits `runId` and escalates on polls, rather than silently inheriting the frozen-id exemption',
    JSON.stringify(
      [
        'success',
        'failure (x)',
        'never-ran (x)',
        'no-completed-run (x)',
        'stale (x)',
        'schedule-disabled (x)',
        'schedule-state-unknown (x)',
        'schedule-drifted (?)',
        'stale: reworded',
      ].map((r) => `${r}=${carriesRunId(r)}`),
    ),
  )
}

/**
 * #4478 — the three answers an EMPTY run list can have, pinned one by one.
 *
 * They have to be separate assertions, and the issue says why: the behaviour
 * that shipped before this change already satisfied the "a young lane does
 * not escalate" arm (nothing escalated) and nothing satisfied the other, so a
 * suite covering only one side would go green on a build with the fix
 * removed. Each arm below is falsifiable alone — forcing every state to read
 * as `active` reds ARM A and leaves ARM B green, forcing every state to read
 * as disabled reds ARM B and leaves ARM A green, and swapping the two reds
 * both while leaving ARM C untouched.
 *
 * `buildResults` is driven, not just `classifyWorkflow`: the escalation is
 * not the verdict string, it is the ABSENCE of the `runId` key, which is what
 * hands the streak to `advanceStreaks`' `fallbackRunId` (this watchdog run's
 * own URL). Asserting only the string would pass on a build where
 * `carriesRunId` still claimed the new verdicts — i.e. on a build where
 * nothing escalates.
 *
 * Every content assertion is paired with its verdict PREFIX, deliberately.
 * All three messages talk about the same workflow, the same emptiness and
 * (two of them) the word "disabled", so a content-only check can go green on
 * the wrong branch. That trap caught a first draft of this suite: an ARM A
 * assertion that checked only for the observed detail stayed green with ARM A
 * unreachable, because the other branch's message carried the same substring.
 */
function selfTestNeverRanScheduleState({ check }) {
  const now = Date.parse('2026-07-31T19:37:00Z')
  const watched = [{ workflow: 'w.yml', periodHours: 168, maxAgeHours: 200 }]
  // Empty run list throughout: that is the ONE case the state read refines,
  // and the case every arm here is about.
  const build = (statesByWorkflow) =>
    buildResults({ runsByWorkflow: { 'w.yml': [] }, statesByWorkflow, nowMs: now, watched })[
      'w.yml'
    ]

  // ─── ARM A: GitHub has DISABLED the schedule → escalates ──────────────────
  {
    const dead = build({ 'w.yml': { state: 'disabled_inactivity' } })
    check(
      dead.result.startsWith('schedule-disabled ('),
      '#4478 ARM A: a lane with no runs whose workflow GitHub reports `disabled_inactivity` is `schedule-disabled`, not `never-ran` — the case #4478 exists for',
      JSON.stringify(dead),
    )
    check(
      !('runId' in dead),
      '#4478 ARM A: that lane OMITS `runId` entirely, so `advanceStreaks` falls back to the watchdog run’s own identity and one poll is one occurrence — the #4456 mechanism, reached at last by a never-run lane',
      JSON.stringify(dead),
    )
    check(
      dead.result.startsWith('schedule-disabled (') && dead.result.includes('disabled_inactivity'),
      '#4478 ARM A: the verdict names the state GitHub actually reported, so the tracking issue says WHY it fired rather than just that it did',
      dead.result,
    )
    // Positive classification: `active` is the only state that means "live".
    // A deny-list would wave through the next value GitHub invents.
    for (const state of ['disabled_manually', 'disabled_fork', 'some_state_github_adds_in_2027']) {
      const e = build({ 'w.yml': { state } })
      check(
        e.result.startsWith('schedule-disabled (') && !('runId' in e),
        `#4478 ARM A: a non-\`active\` state (\`${state}\`) escalates too — the state test is an ALLOW-LIST on \`active\`, not a deny-list of known-bad values`,
        JSON.stringify(e),
      )
    }
  }

  // ─── ARM B: the workflow is ACTIVE and merely young → does NOT escalate ───
  {
    const young = build({ 'w.yml': { state: 'active' } })
    check(
      young.result.startsWith('never-ran ('),
      '#4478 ARM B: a lane with no runs whose workflow is `active` stays plain `never-ran` — a workflow that is merely young must not page anyone (#4440)',
      JSON.stringify(young),
    )
    check(
      'runId' in young && young.runId === null,
      '#4478 ARM B: that lane still writes an explicit `null` `runId`, the identity-unknowable HOLD — so its streak does not advance on watchdog polls',
      JSON.stringify(young),
    )
  }

  // ─── ARM C: the state could not be read → its OWN verdict ────────────────
  //
  // Not folded into either neighbour. Folding it into `never-ran` would make
  // an API outage silently assume "young", which is the exact bug being
  // fixed; folding it into `schedule-disabled` would assert a fact this
  // process does not have. Both directions are asserted NEGATIVELY here, not
  // merely the positive prefix, because "it is its own answer" is a claim
  // about what it is NOT.
  {
    const failed = build({ 'w.yml': { error: '`gh api` failed (HTTP 502)' } })
    check(
      failed.result.startsWith('schedule-state-unknown (') &&
        !failed.result.startsWith('never-ran (') &&
        !failed.result.startsWith('schedule-disabled ('),
      '#4478 ARM C: an unreadable workflow state is its OWN verdict — the uncertainty is reported, not resolved into "young" or into "disabled"',
      JSON.stringify(failed),
    )
    check(
      failed.result.startsWith('schedule-state-unknown (') && failed.result.includes('HTTP 502'),
      '#4478 ARM C: the verdict carries WHY the state could not be read, so the reader is told what failed rather than just that something did',
      failed.result,
    )
    check(
      !('runId' in failed),
      '#4478 ARM C: an unreadable state also omits `runId`, so a question this watchdog has been unable to answer for N polls escalates — the `null` HOLD would be the pre-#4478 silence, reachable by an API outage',
      JSON.stringify(failed),
    )
    // No state entry at all for the lane — the shape a caller produces by
    // simply not fetching. Must land in the same visible verdict, never in a
    // healthy or a young one.
    const absent = build({})
    check(
      absent.result.startsWith('schedule-state-unknown (') && !('runId' in absent),
      '#4478 ARM C: a lane with NO state entry fetched at all reads as unknown too — an unasked question is not an answer',
      JSON.stringify(absent),
    )
  }

  // End to end through `main()`, which is the only place the states actually
  // reach `buildResults` in production. A mutant that dropped the
  // `statesByWorkflow` argument from that call leaves every assertion above
  // green while turning every real never-run lane into `schedule-state-unknown`.
  {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-liveness-state-'))
    const out = join(dir, 'out.json')
    const runsFile = join(dir, 'runs.json')
    const statesFile = join(dir, 'states.json')
    const nowIso = '2026-07-31T19:37:00Z'
    const fresh = [
      {
        databaseId: 1,
        status: 'completed',
        conclusion: 'success',
        createdAt: ISO(Date.parse(nowIso) - HOUR_MS),
      },
    ]
    const dead = 'scorecard.yml'
    writeFileSync(
      runsFile,
      JSON.stringify(
        Object.fromEntries(WATCHED.map((w) => [w.workflow, w.workflow === dead ? [] : fresh])),
      ),
      'utf8',
    )
    writeFileSync(
      statesFile,
      JSON.stringify(
        Object.fromEntries(
          WATCHED.map((w) => [
            w.workflow,
            w.workflow === dead ? { state: 'disabled_inactivity' } : { state: 'active' },
          ]),
        ),
      ),
      'utf8',
    )
    const prevLog = console.log
    console.log = () => {}
    try {
      main([
        '--out',
        out,
        '--now',
        nowIso,
        '--runs-json-file',
        runsFile,
        '--states-json-file',
        statesFile,
      ])
    } finally {
      console.log = prevLog
    }
    const written = JSON.parse(readFileSync(out, 'utf8'))
    check(
      written[dead].result.startsWith('schedule-disabled (') &&
        !('runId' in written[dead]) &&
        Object.entries(written).every(([name, v]) => name === dead || v.result === 'success'),
      '#4478: end to end, `main()` threads the workflow states into the written file — the disabled lane is `schedule-disabled` with NO `runId`, and every other lane is untouched',
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
  selfTestStaleRunIdOmission({ check })
  selfTestNeverRanScheduleState({ check })

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
