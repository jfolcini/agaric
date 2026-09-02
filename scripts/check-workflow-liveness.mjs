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
// ─── Why `--event schedule`, with one exception ──────────────────────────────
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
// The exception, and the reason the second clause above does not cover it:
// `ci.yml`'s POST-MERGE run on `main`. The PR's checks all went green before
// the merge, so nobody looks again, and there is no PR left to show the merge
// commit's own red. That lane is therefore watched on `--event push --branch
// main`, for the CONCLUSION question only — it has no cron, so the liveness
// question (and with it staleness and never-ran) does not apply to it.
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
//                                     instead of calling `gh`; REQUIRES
//                                     --states-json-file alongside it)
//        [--states-json-file <path>] (TEST-ONLY, REQUIRED with
//                                     --runs-json-file: `{ "<file>.yml":
//                                     {"state": "active"} | {"error": "…"} }`,
//                                     the workflow-state read #4478 added)
//
// Exit codes: 0 = every watched workflow classified and `--out` written;
//             1 = a real error (bad args, `gh` failure, unwatched scheduled
//                 workflow, unparseable timestamps).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
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
 * quietly leaving it unobserved. Plus the one PUSH-watched entry below, which
 * has no cron and therefore sits outside that equality (see its comment).
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
 * The property that makes those numbers meaningful: every window is strictly
 * under two nominal periods, so a check that never fires within two cycles is
 * impossible to configure here by accident.
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
    // The one PUSH-watched lane, and the only entry here judged on its
    // conclusion alone. `ci.yml`'s post-merge run on `main` is where a merge
    // that breaks main first shows up, and nothing reports it: the PR's own
    // checks went green before the merge, and this is not a scheduled run, so
    // no cron window applies — neither staleness nor never-ran means anything
    // for a lane that only runs when someone merges.
    workflow: 'ci.yml',
    event: 'push',
    branch: 'main',
    why: 'post-merge run on main; a red main is reported nowhere else',
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
  event = 'schedule',
}) {
  const considered = orderedRuns({ runs, workflow, excludeRunId })

  // Both rules below answer "has the CRON stopped firing", so neither applies
  // to a push-watched lane: it runs when someone merges, and no merges is not
  // a defect. Such a lane is judged on its newest completed run's conclusion.
  // (An EMPTY push list falls through to `no-completed-run` below; that needs
  // no push run inside GitHub's 90-day run retention, i.e. no merge to `main`
  // in three months, which is worth a red row.)
  if (event === 'schedule' && considered.length === 0) {
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
    // It is a verdict rather than a THROW — the posture `fetchWorkflowRuns`
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

  if (event === 'schedule') {
    const ageHours = (nowMs - considered[0].startedAtMs) / HOUR_MS
    if (ageHours > maxAgeHours) {
      return `stale (newest scheduled run started ${formatAge(ageHours)} ago; window is ${maxAgeHours}h)`
    }
  }

  const completed = considered.find((r) => r.status === 'completed')
  if (!completed) {
    return `no-completed-run (newest ${event} run is \`${considered[0]?.status ?? 'none at all'}\` and none of the last ${considered.length} has completed)`
  }
  if (completed.conclusion === 'success') return 'success'
  return `failure (newest completed ${event} run concluded \`${completed.conclusion ?? 'unknown'}\`)`
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
 * Keep this in sync with `classifyWorkflow`'s returns, so drift fails closed
 * here.
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
 * are the two acceptance arms of #4478.
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
      event: entry.event,
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
 * True when a workflow file declares a cron trigger. Text-based, like the
 * other workflow guards and for the same reason: the repo's scripts carry no
 * YAML runtime dependency. Comment lines are dropped first so
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
  // The invariant is over the CRON-watched entries only. A push-watched entry
  // has no cron, so it is neither a phantom nor a licence: were `ci.yml` to
  // grow one, it would be absent from this set and reported as unwatched,
  // which is what forces a proper windowed entry for it.
  const watchedNames = new Set(watched.filter((w) => w.event !== 'push').map((w) => w.workflow))
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
 * Text assertions, with the limits every textual workflow guard here has: a
 * layout change the patterns do not anticipate reads as a violation, not a
 * pass.
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
 * The last few runs of one workflow on the watched event (and branch, when the
 * entry names one — `ci.yml` is watched on `main` alone).
 *
 * Ten, not one: the newest run may be in progress, and the conclusion question
 * needs the newest COMPLETED run behind it. Any failure here — `gh` missing,
 * `gh` exiting non-zero (rate limit, auth, API 5xx), output that is not JSON —
 * propagates as a throw. There is no fallback value, because every possible
 * fallback would be a claim about health that this process cannot substantiate.
 */
export function fetchWorkflowRuns(repo, workflow, { event = 'schedule', branch } = {}) {
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
        event,
        ...(branch === undefined ? [] : ['--branch', branch]),
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
    // `--states-json-file` is REQUIRED alongside it (review of #4562, note
    // 5): omitting it used to silently default `statesByWorkflow` to `{}`,
    // which reads as "no state was fetched" for every lane and turns every
    // empty-run-list lane into `schedule-state-unknown` — a real verdict,
    // just the wrong one, chosen by a missing flag instead of by data. Every
    // in-tree fixture already passes both flags, so this is inert today; it
    // exists so a FUTURE fixture that forgets the flag fails loudly here
    // instead of quietly mis-verdicting.
    if (args.statesJsonFile === undefined) {
      throw new Error(
        '--states-json-file is required when --runs-json-file is given: omitting it silently defaults statesByWorkflow to {}, which reads as schedule-state-unknown for every empty-run-list lane',
      )
    }
    runsByWorkflow = JSON.parse(readFileSync(args.runsJsonFile, 'utf8'))
    statesByWorkflow = JSON.parse(readFileSync(args.statesJsonFile, 'utf8'))
  } else {
    const repo = args.repo ?? process.env.GITHUB_REPOSITORY
    if (!repo) throw new Error('--repo (or $GITHUB_REPOSITORY) is required outside fixture mode')
    runsByWorkflow = {}
    statesByWorkflow = {}
    for (const entry of WATCHED) {
      runsByWorkflow[entry.workflow] = fetchWorkflowRuns(repo, entry.workflow, entry)
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

// Entry-point detection in the one sanctioned form (#3373): both sides
// realpath'd, so a symlinked scripts/ directory or repo root cannot make this
// comparison false and turn the whole guard into a silent no-op.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    main()
  } catch (err) {
    console.error(`check-workflow-liveness: ${err.message}`)
    process.exit(1)
  }
}
