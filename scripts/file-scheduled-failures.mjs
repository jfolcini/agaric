#!/usr/bin/env node
// #3359 — the notification path for `scheduled-deep-checks.yml`.
//
// Every lane in that workflow is non-blocking triage signal, and #3365 spent
// its whole diff making three of them *capable* of going red at all (the
// `mutants-frontend` liveness guard, the bench lanes' `|| true` removal). But
// a guard that goes red into the void is barely better than the swallowed
// `|| true` it replaced: nothing in this repo notified anyone that a weekly
// lane had failed. The lane's own history is the proof — the #3163 fuzz
// compile break landed 2026-07-24 and survived five days, visible only to
// whoever happened to open the Actions tab.
//
// This script is the workflow's own `file-*-findings` sibling, one level up:
// where `file-mutation-survivors.mjs` and `file-fuzz-findings.mjs` triage a
// lane's CONTENT, this one triages lane HEALTH. It reads the `needs` context
// (i.e. every lane's job `result`), diffs the set of currently-failing lanes
// against a SINGLE rolling tracking issue's last-known set (encoded in a
// marked block in the issue body), and:
//
//   * files/reopens + comments only when a lane is NEWLY failing,
//   * files/reopens + comments again — without adding a new lane — when an
//     ALREADY-tracked lane crosses its Nth-consecutive-OBSERVED-failure
//     threshold (#4400: a weekly lane's Nth distinct red run is real news
//     that "no new lane" would otherwise discard forever),
//   * silently syncs the body when a lane recovers, when a still-failing lane
//     advances toward that threshold without crossing it, or (once, on the
//     first poll after #4400) when a lane tracked under the pre-#4400 format
//     adopts a run identity for the failure already counted against it,
//   * CLOSES the issue when every lane is green again,
//   * does nothing at all when nothing changed — including a poll that
//     observed no NEW run of an already-tracked failing lane.
//
// Rolling issue, not one per lane (#3359 left this open):
//   - The unit a maintainer acts on is "this week's deep checks are red", and
//     the lanes are heavily correlated (a toolchain bump reds four at once).
//     Nine per-lane issues for one root cause is exactly the notification
//     fatigue that trains people to mute the repo.
//   - Per-lane ownership is not actually lost: the marker block IS the
//     per-lane list, and the rendered status table names every lane and its
//     result, so "who owns this" is one glance away inside the one issue.
//   - It also matches the two sibling filers, which both keep exactly one
//     rolling issue. A third convention here would be gratuitous.
//
// The failure path must not depend on the thing that broke (#3359):
//   - This script reads ONLY the `needs` context — GitHub's own job-result
//     data. It downloads no artifact, parses no lane output, and shares no
//     code with the two content filers. A lane that dies during `apt-get`,
//     before it could upload anything, still has `result: failure`.
//   - The reporting job `needs:` the two content filers as well, so when a
//     filer is itself the thing that failed (which #3365 and #3364 make
//     possible on purpose), that failure is reported here.
//   - The one dependency that remains is this script itself. That is covered
//     OUTSIDE this file, by a deliberately minimal `if: failure()` bash step
//     in the same job that files a separate "reporter is broken" notice with
//     nothing but `gh` — no Node, no parsing, no marker blocks. See
//     `.github/workflows/scheduled-deep-checks.yml`.
//   - What remained irreducible in #3359: if the reporting JOB never starts
//     (invalid workflow file, runner-pool outage, whole-run cancellation
//     before it is scheduled) nothing reports. That is now covered from
//     OUTSIDE by `.github/workflows/workflow-watchdog.yml` +
//     `scripts/check-workflow-liveness.mjs` (#3374), which asks GitHub's runs
//     API whether each scheduled workflow ran at all — and which reuses this
//     script, via `--profile workflow-watchdog`, rather than growing a second
//     issue-filing mechanism. See § Profiles below.
//
// A MISSING `needs` payload is a hard error, not an empty one: reporting
// "zero lanes failed" because the context was absent would be the exact
// false-green class of bug this workflow keeps producing.
//
// State lives in the tracking issue's body, not a committed baseline file —
// the job needs `issues: write` only, never `contents: write`.
//
// Profiles (#3374):
//   The diff/dedup/state-machine/render pipeline above is about "a set of
//   named things, each with a pass/fail result, tracked by one rolling issue".
//   That description fits the deep-check LANES and, unchanged, the scheduled
//   WORKFLOWS the #3374 watchdog observes — the watchdog synthesises the same
//   `{ name: { result } }` shape from `gh run list` and feeds it in here. A
//   profile carries only what differs between the two callers: the tracking
//   issue's title and labels, and the nouns in the rendered prose. Everything
//   that could get a notification wrong — the throw on absent input, the
//   job-id dedup, the close path clearing the tracked set — stays single-copy.
//
// Usage (from the repo root or anywhere — paths are resolved as given):
//   node scripts/file-scheduled-failures.mjs \
//     --needs-json-file <path to a file holding `${{ toJSON(needs) }}`> \
//     [--profile deep-checks|workflow-watchdog]   (default: deep-checks)
//     [--skipped-ok]                (a `skipped` lane is neither failing NOR
//                                    recovered: it is carried over from the
//                                    tracked set untouched. Only correct off
//                                    the `schedule` event, where the
//                                    schedule-only filer really is skipped.
//                                    See `carriedOverJobs` — #3960)
//     [--repo owner/repo]           (default: $GITHUB_REPOSITORY)
//     [--run-url <url>]             (default: derived from $GITHUB_SERVER_URL
//                                    /$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID)
//     [--dry-run]                   (compute + print; never write via `gh`)
//     [--known-body-file <path>]    (TEST-ONLY: use this file's content as the
//                                    existing tracking issue's body instead of
//                                    calling `gh issue list`; a missing/empty
//                                    file means "no existing issue")
//     [--known-state OPEN|CLOSED]   (TEST-ONLY: state of the above stub issue)
//
// Exit codes: 0 on success (including every no-op case), 1 on a real error
// (bad args, absent/unparseable `needs` payload, a `gh` call failing).

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Stable titles: the ONLY thing the find-or-file logic matches on. Never
// rename an existing issue with one of these titles — the script would stop
// finding it and would file a duplicate.
//
// One rolling issue PER PROFILE, not per lane and not per watched workflow:
//   - deep-checks: the lanes are heavily correlated (a toolchain bump reds
//     four at once), and the unit a maintainer acts on is "this week's deep
//     checks are red". See the § Rolling issue note in the header.
//   - workflow-watchdog: there is ONE observer job looking at every scheduled
//     workflow in a single pass, exactly as `report-scheduled-failures` looks
//     at every lane in a single pass — structurally the same situation, so
//     the same answer. Per-workflow issues would be the right shape if each
//     workflow filed its own report from inside itself; #3374 chose the
//     out-of-band watchdog instead, so there is one reporter and one issue.
//     Per-workflow ownership is not lost: the NOTIFICATION is the comment,
//     and the comment names the specific workflow and how it failed, while
//     the marker block and status table carry the per-workflow breakdown.
export const PROFILES = Object.freeze({
  'deep-checks': Object.freeze({
    title: 'Scheduled deep checks: failing lanes (auto-filed, do not rename)',
    labels: Object.freeze(['github-actions', 'testing']),
    unit: 'lane',
    units: 'lanes',
    // First body paragraph after the boilerplate — the "why you are reading
    // this" line, which differs completely between the two callers.
    what: 'This issue tracks lanes of `.github/workflows/scheduled-deep-checks.yml` that are currently FAILING (#3359).',
    why: 'Every lane in that workflow is non-blocking triage signal, so a red lane is visible only to whoever opens the Actions tab — the #3163 fuzz compile break survived five days that way. This issue is the push notification that closes that gap.',
    headline: 'scheduled-deep-checks lane',
    recovery: 'All scheduled-deep-checks lanes are green again',
    // #4456 review of #4440 — FALSE. This profile's `toJSON(needs)` payload
    // never carries `periodHours` (its lanes are JOBS inside one weekly run,
    // not workflows with their own polling cadence — see `parseNeeds`), so
    // `escalationThreshold` is 1 for every lane this profile ever renders,
    // no matter how weekly the containing workflow is. The standing prose in
    // `buildIssueBody` must not promise an N=3 this profile can never reach.
    weeklyEscalation: false,
    // #4481 review note 3 — the "why N stays 1" clause used to be hard-coded
    // inside `buildIssueBody`'s `weeklyEscalation: false` branch, keyed off
    // this boolean rather than off THIS profile: a future profile that also
    // sets `weeklyEscalation: false` for an unrelated reason (e.g. a
    // daily-cadence workflow profile, where lanes really are workflows with
    // their own polling cadence) would silently inherit deep-checks' "jobs
    // inside a single scheduled run" claim and render a false explanation.
    // Owning the sentence here makes a new false-profile author write their
    // OWN reason instead of getting this one for free.
    escalationCeilingReason:
      'its lanes are jobs inside a single scheduled run, not workflows with their own polling cadence, so there is nothing to count past the first observed failure',
  }),
  'workflow-watchdog': Object.freeze({
    title:
      'Scheduled workflow watchdog: workflows not running, or failing (auto-filed, do not rename)',
    labels: Object.freeze(['github-actions', 'testing']),
    unit: 'workflow',
    units: 'workflows',
    what: "This issue tracks scheduled workflows that either did NOT RUN inside the window their cron implies, or whose newest completed scheduled run FAILED (#3374). It is filed by `.github/workflows/workflow-watchdog.yml`, which observes them from outside via GitHub's runs API.",
    why: 'Every other notification path in this repo lives inside the workflow it reports on, so a workflow that never starts — invalid file, runner-pool outage, cancelled before its reporter is scheduled, schedules disabled for inactivity — reports nothing. And four scheduled workflows (`e2e-tauri-weekly`, `codeql`, `scorecard`, `branch-protection-assert`) had no failure notification at all. This issue is that notification.',
    headline: 'scheduled workflow',
    recovery: 'Every scheduled workflow is running on time and green again',
    // #4456 — TRUE, and reachable by every one of this profile's weekly
    // lanes now, not just the ones that fail outright: `check-workflow-
    // liveness.mjs`'s `WATCHED` decorates every lane with `periodHours`, and
    // a `stale` lane (the dead-cron case — see `buildResults` there) now
    // advances its streak on consecutive watchdog POLLS instead of holding
    // forever on a frozen run id, so it really can reach the threshold 3
    // `escalationThreshold(168)` sets.
    weeklyEscalation: true,
  }),
})

export const DEFAULT_PROFILE = 'deep-checks'

export function resolveProfile(name = DEFAULT_PROFILE) {
  const profile = PROFILES[name]
  if (!profile) {
    throw new Error(`unknown --profile "${name}" (known: ${Object.keys(PROFILES).join(', ')})`)
  }
  return profile
}

// Back-compat aliases: `deep-checks` was the only behaviour before #3374 and
// these two names are referenced from its tests and prose.
export const TRACKING_ISSUE_TITLE = PROFILES['deep-checks'].title
export const TRACKING_ISSUE_LABELS = [...PROFILES['deep-checks'].labels]

const MARKER_START = '<!-- scheduled-failures:begin -->'
const MARKER_END = '<!-- scheduled-failures:end -->'

// The body is bounded by the number of jobs in one workflow (~12 short
// lines), so unlike the two content filers this one needs no clamp — there is
// no unbounded list to render. A future change that starts embedding logs
// here must keep that bound rather than 422ing `gh issue edit`.
export const MAX_BODY_CHARS = 8000

// GitHub job results, in the order a triager cares about them.
const RESULT_LABEL = {
  failure: '❌ failure',
  cancelled: '⚠️ cancelled',
  skipped: '⚠️ skipped',
  success: '✅ success',
}

// ---------------------------------------------------------------------------
// Reading the `needs` context
// ---------------------------------------------------------------------------

/**
 * Parses `${{ toJSON(needs) }}` — an object keyed by job id whose values carry
 * a `result` — into a sorted `[{ job, result }]` list.
 *
 * Throws on absent/blank/unparseable/empty input rather than returning `[]`.
 * An empty list here would render as "every lane is green" and CLOSE the
 * tracking issue, i.e. the reporter's own false-green. A missing input must
 * stay distinguishable from an empty one (the same principle #3364 applies to
 * the mutation filer's artifacts).
 */
export function parseNeeds(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(
      'the `needs` payload is empty — refusing to report "no lanes failed" from absent data',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`the \`needs\` payload is not valid JSON (${err.message})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the `needs` payload is not a JSON object keyed by job id')
  }
  const jobs = Object.keys(parsed).toSorted()
  if (jobs.length === 0) {
    throw new Error(
      'the `needs` payload contains zero jobs — the reporting job is not wired to any lane',
    )
  }
  return jobs.map((job) => {
    const entry = parsed[job]
    const result = entry?.result
    // An unknown/absent `result` is reported as such rather than assumed
    // green: same reason as the empty-payload throw above, one job down.
    const out = { job, result: typeof result === 'string' && result ? result : 'unknown' }
    // #4400 — optional, caller-supplied extras for the consecutive-failure
    // counter. Left OFF `out` entirely when the caller's payload doesn't have
    // the key (the deep-checks reporter's `toJSON(needs)` never does — GitHub
    // jobs in one `needs` map share a single run, so there is nothing to
    // name), which `advanceStreaks` reads as "fall back to this invocation's
    // own run identity". A `runId` the caller DOES supply, including an
    // explicit `null` (check-workflow-liveness.mjs's way of saying "no
    // completed run exists to point at"), is kept as-is — collapsing that to
    // the same fallback would make an unrun weekly workflow advance once per
    // DAILY watchdog poll, which is the exact bug #4400 exists to fix.
    if (entry && typeof entry === 'object' && 'runId' in entry) out.runId = entry.runId
    if (entry && typeof entry === 'object' && typeof entry.periodHours === 'number') {
      out.periodHours = entry.periodHours
    }
    return out
  })
}

/** True when a lane's job result means "this lane did not do its job". */
export function isFailing(result, { skippedOk = false } = {}) {
  if (result === 'success') return false
  if (result === 'skipped' && skippedOk) return false
  return true
}

/**
 * The currently-failing lanes' job ids — the machine-readable set the marker
 * block stores and dedups on.
 *
 * Dedup keys on the JOB ID, not on `job+result`: a lane that stays broken but
 * flips `failure` → `cancelled` (a job-level timeout after a runner change,
 * say) has not recovered, and must not re-notify as if it were new. The
 * current result is still rendered — outside the block, in the status table.
 */
export function failingJobs(lanes, options) {
  return lanes.filter((l) => isFailing(l.result, options)).map((l) => l.job)
}

/**
 * #3960 — the lanes a `--skipped-ok` run must CARRY OVER rather than judge.
 *
 * `--skipped-ok` answers "did this lane fail?" with "it never ran, so no".
 * The identical fact answers "did this lane recover?" with "it never ran, so
 * no" — and only the first half used to be encoded. `isFailing` dropped an
 * exempted-`skipped` lane out of `current`, `diffLanes` then read its absence
 * from `current` as a RECOVERY, and `decideAction` closed the issue. So a
 * `workflow_dispatch` reported `file-fuzz-findings` (the one reporter
 * dependency still gated `github.event_name == 'schedule'`, hence `skipped`
 * off the cron) recovered ON THE STRENGTH OF IT NOT HAVING BEEN EXECUTED,
 * and cleared it from the tracked set — reading green until the next Monday.
 *
 * That was harmless only while the dispatch ALSO passed `--dry-run` and wrote
 * nothing; #3716 removed the `--dry-run` and left `--skipped-ok` standing,
 * which is what made the latent half live.
 *
 * So: an exempted-`skipped` lane is neither failing nor recovered. It is
 * carried over from the tracked set unchanged — but only if it was ALREADY
 * tracked (see `diffLanes`): "it did not run" is no more evidence that a lane
 * is broken than that it is fixed, so this must never ADD a lane to the set.
 *
 * Mirrors `isFailing`'s exemption exactly — one result, `skipped`, and only
 * under `skippedOk`. If that exemption ever grows, both must grow together.
 */
export function carriedOverJobs(lanes, { skippedOk = false } = {}) {
  if (!skippedOk) return []
  return lanes.filter((l) => l.result === 'skipped').map((l) => l.job)
}

// ---------------------------------------------------------------------------
// Diffing against the tracking issue's known state
// ---------------------------------------------------------------------------

/**
 * The raw, trimmed, non-fence lines of the marker block — the one place both
 * `parseKnownLanes` and `parseKnownStreaks` (#4400) read from, so the two can
 * never disagree about which lines in the body carry state.
 */
function markerBlockLines(body) {
  if (!body) return []
  const start = body.indexOf(MARKER_START)
  const end = body.indexOf(MARKER_END)
  if (start === -1 || end === -1 || end < start) return []
  const block = body.slice(start + MARKER_START.length, end)
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '```')
}

/**
 * Extracts the tracked job ids from a tracking-issue body (or `''`/undefined).
 *
 * #4400 widened each line from a bare job id to `job|count|runId` so the
 * consecutive-failure counter survives a re-read, but every OTHER consumer of
 * this function — `diffLanes`, `carriedOverJobs`'s caller, the close path,
 * and a couple dozen pre-#4400 callers — wants exactly the job id and
 * nothing else. Splitting on `|` and taking the first field reads both the
 * new format and a pre-#4400 bare line identically (a bare line has no `|`,
 * so splitting on it is a no-op), which is what keeps this function's
 * contract — and everything built on top of it — unchanged by the format
 * change.
 */
export function parseKnownLanes(body) {
  return new Set(markerBlockLines(body).map((l) => l.split('|')[0]))
}

/**
 * #4400 — the per-lane consecutive-observed-failure state: `count` (how many
 * DISTINCT observed runs this lane has failed back to back) and `runId` (the
 * last one counted), keyed by job id. This is the only durable state this
 * script has — there is no database — so it has to live in the same marker
 * block `parseKnownLanes` reads, which is why the two share `markerBlockLines`
 * rather than parsing the block twice with two chances to disagree.
 *
 * A pre-#4400 bare line (no `|`) is a lane that WAS tracked under the old
 * format, with no recorded count or run identity. It is read as `{ count: 1,
 * runId: null, migrated: true }` — "failing at least once, identity unknown,
 * and unknown because this line predates the format that records it" — rather
 * than dropped: dropping it would re-report an already-known lane as brand new
 * on the first run after this ships, which is exactly the false alarm the
 * `parseKnownLanes` migration note (see the file header, "Why this was not
 * bundled into #4393") warned a naive migration would cause. It also does not
 * assume the lane was already at 2 or 3 (data this format change cannot
 * recover) or reset it to "first failure" (data the pre-existing tracked set
 * already refutes).
 *
 * `migrated` is the third state. It records WHICH of two identity-less priors
 * a line is — a distinction the body makes and `{ count, runId }` alone does
 * not:
 *
 *   - a BARE line: some run was observed and counted, and the old format had
 *     nowhere to write down which one;
 *   - a post-#4400 `job|1|` line: this script recorded the lane while there
 *     was no completed run to name at all (`never-ran`/`no-completed-run` —
 *     see `newestCompletedRunId`), so nothing has been counted against a run
 *     yet.
 *
 * Both must HOLD rather than advance when a real run id first shows up, and
 * `advanceStreaks` treats them as one rule for that reason (see its
 * identity-less branch): advancing either counts a failure that was never
 * observed — for the bare line the same already-counted run counted twice,
 * for the `job|1|` line a first observation counted as a second. That is the
 * "a REPEATED observation must not be misread as a NEW one" defect
 * `advanceStreaks` exists to refuse, reached through the migration door and
 * through the never-ran door respectively.
 *
 * So the flag does NOT steer that decision — the null `runId` does — and it
 * is deliberately kept anyway, for two reasons. It keeps the body honest
 * about provenance: a bare line is one this script did not write, and
 * `buildIssueBody` renders a held migrated entry back BARE so an unrelated
 * lane's body rewrite cannot silently relabel it as this script's own
 * output. And it keeps the two priors SEPARABLE: if the rule for one is ever
 * re-litigated, the other does not change with it by accident. The flag
 * stops appearing the moment the lane adopts an identity — the line is then
 * rewritten as `job|count|runId` and parses as an ordinary entry — but until
 * then it round-trips as itself.
 *
 * The `|` split is UNGUARDED against a job id that itself contains a `|`
 * (here and in `parseKnownLanes`), and deliberately so — the invariant is
 * enforced where the ids are MINTED, not defended against where they are
 * read, because a parser cannot tell a corrupt line from an exotic one:
 *   - watchdog profile: the id is a watched workflow FILENAME, and every
 *     entry in `check-workflow-liveness.mjs`'s `WATCHED` stays within
 *     `[A-Za-z0-9._-]`;
 *   - deep-checks profile: the id is a GitHub job id, which GitHub's own
 *     workflow schema restricts to alphanumerics, `-` and `_` (the same
 *     charset `findUncoveredLanes`' scanner matches).
 * So this is latent, not live. If a profile ever mints ids from something
 * looser (a matrix leg's display name, say), fix it there or change the
 * delimiter — do not make these two splits cleverer.
 */
export function parseKnownStreaks(body) {
  const map = new Map()
  for (const line of markerBlockLines(body)) {
    const [job, countStr, runIdRaw] = line.split('|')
    if (countStr === undefined) {
      map.set(job, { count: 1, runId: null, migrated: true })
      continue
    }
    const count = Number.parseInt(countStr, 10)
    map.set(job, {
      count: Number.isFinite(count) && count > 0 ? count : 1,
      runId: runIdRaw === undefined || runIdRaw === '' ? null : runIdRaw,
    })
  }
  return map
}

/**
 * Diffs the currently-failing set against the tracked one.
 *
 * `carryOver` (from `carriedOverJobs`) names lanes whose result says nothing
 * either way — they did not run. They are subtracted from `resolvedOnes` and
 * added back into `all`, so the tracked set survives a run that could not
 * observe them. Only lanes ALREADY in `known` are carried: a skipped lane
 * nobody was tracking stays untracked.
 */
export function diffLanes(current, known, { carryOver = [] } = {}) {
  const currentSet = new Set(current)
  const carried = new Set(carryOver.filter((j) => known.has(j) && !currentSet.has(j)))
  const newOnes = [...currentSet].filter((j) => !known.has(j)).toSorted()
  const resolvedOnes = [...known].filter((j) => !currentSet.has(j) && !carried.has(j)).toSorted()
  return {
    newOnes,
    resolvedOnes,
    all: [...new Set([...currentSet, ...carried])].toSorted(),
    carriedOver: [...carried].toSorted(),
  }
}

/**
 * #4400 — how many DISTINCT observed failures in a row a lane must rack up
 * before it gets a second comment. Derived from the lane's own polling
 * cadence (`periodHours`, threaded through from `WATCHED` in
 * `check-workflow-liveness.mjs`) rather than a flat constant or a per-profile
 * one, because a single profile (`workflow-watchdog`) watches lanes of BOTH
 * cadences at once — `branch-protection-assert.yml` daily alongside
 * `e2e-tauri-weekly.yml` weekly — and a profile-wide threshold would either
 * escalate the daily lane late or the weekly one early.
 *
 * N = 1 (undecorated lanes, and anything with a sub-weekly period): identical
 * to pre-#4400 behaviour — notify once, on the very first failure, then hold
 * silent until recovery. A lane observed at its own true cadence (the
 * deep-checks reporter runs FROM WITHIN the workflow it watches, so one
 * script invocation already IS one real occurrence) has nothing to fix: the
 * mismatch this ticket is about — many polls per real event — cannot arise.
 *
 * N = 3 for periodHours >= 168 (weekly or slower): three CONSECUTIVE
 * DISTINCT observed runs is three real weeks of an unfixed lane — the exact
 * #3388 case (2026-08-10 / 08-17 / 08-24). N = 2 would escalate after a
 * single skipped week, and two failures a week apart can still plausibly be
 * one incident resurfacing before a fix lands rather than a pattern; three,
 * a week apart each, cannot be read that way. The cost of picking 3 over 2 is
 * one more week of silence on a genuine repeat offender — against a weekly
 * cadence, that is a much cheaper mistake than escalating (and thereby
 * training readers to expect noise) on what might still be a single stuck
 * incident.
 */
export function escalationThreshold(periodHours) {
  if (typeof periodHours === 'number' && periodHours >= 168) return 3
  return 1
}

/**
 * #4400 — advances each currently-failing, already-tracked lane's
 * consecutive-observed-failure counter, and reports which lanes just crossed
 * their escalation threshold.
 *
 * The advance is keyed on RUN IDENTITY, never on invocation count:
 * `workflow-watchdog` polls daily against workflows that run weekly, so most
 * polls see the exact same newest-completed run. Counting invocations would
 * hit N=3 in three DAYS against a WEEKLY lane and reintroduce the very spam
 * this ticket exists to remove — the "an absent check is not a passing check"
 * trap, inverted: here a REPEATED observation must not be misread as a NEW
 * one.
 *
 * Per lane, `runId` (from the needs payload — see `parseNeeds`) means:
 *   - `undefined` (the key is simply absent from the lane's entry): falls
 *     back to `fallbackRunId`, this script INVOCATION's own identity. Two
 *     callers land here, for two different reasons that both resolve to the
 *     same fallback:
 *       - the deep-checks reporter's `toJSON(needs)` never has a `runId` key
 *         for ANY lane — correct there specifically because that reporter
 *         runs from inside the very workflow it watches, so one invocation
 *         of this script already IS one real occurrence, and "new
 *         invocation" and "new run" already coincide;
 *       - `buildResults` (`check-workflow-liveness.mjs`) omits the key
 *         deliberately for the verdicts with no run to name: a `stale` one
 *         (#4456), and — #4478 — a `schedule-disabled` one (GitHub reports
 *         the watched workflow's state as non-`active`, e.g.
 *         `disabled_inactivity`, so its schedule is off and no run will
 *         arrive) or a `schedule-state-unknown` one (that state could not be
 *         read at all). In each, the watched workflow's schedule is not
 *         producing runs, so this script's own poll becomes the
 *         distinguishing occurrence instead: three DIFFERENT `fallbackRunId`
 *         values are three distinct daily polls that still observe the lane
 *         dead, standing in for the three distinct runs a genuinely failing
 *         weekly lane would need to escalate. (A plain `never-ran` — the same
 *         empty run list, but with GitHub reporting the workflow `active` —
 *         deliberately stays on the `null` HOLD below: a workflow that is
 *         merely young must not escalate.)
 *   - `null` (the key IS present but the caller could not name a run — e.g.
 *     `newestCompletedRunId` reporting `never-ran`/`no-completed-run`): the
 *     identity is unknowable, so the counter HOLDS — it neither advances nor
 *     resets. Falling back to the invocation id here would advance once per
 *     DAILY tick against a workflow that has simply never run, which is the
 *     bug relocated rather than fixed. `stale` used to be identified by
 *     `newestCompletedRunId`'s answer too (usually a real, frozen, NON-null
 *     id — the last completed run before the schedule died); #4456 moved it
 *     to the key-absent branch above instead of leaving it here — the
 *     omission is deliberate: `check-workflow-liveness.mjs` OMITS `runId`
 *     entirely for a dead cron — not the frozen completed run id, and not an
 *     explicit `null` — which is what lets the escalation below fire.
 *     A `null` hold would have been just as wrong for a dead cron as
 *     the frozen id it replaced — see `buildResults`' own comment.
 *   - anything else: a real, comparable identity (a run's numeric database
 *     id from `check-workflow-liveness.mjs`, or this script's own run URL).
 *
 * A lane whose count has already reached its threshold is left ALONE —
 * skipped before any of the above is even evaluated — rather than advanced
 * past it. That is what makes escalation a single, bounded event rather than
 * a recurring alarm: once said, the lane goes back to being silently tracked
 * exactly like a pre-#4400 still-failing lane, until it recovers (which
 * drops it from the tracked set entirely — see `diffLanes` — so a later
 * relapse starts this counter over at 1, not wherever it left off). It is
 * also what keeps two runs that observe the SAME crossing run from
 * double-escalating: the first run's advance already pushed `count` to the
 * threshold and persisted the new `runId`, so the second run's `prior.count
 * >= threshold` check fires before its `runId` is even compared.
 *
 * A brand-new lane (no PRIOR entry at all) always starts at `count: 1` and is
 * never added to `escalated`, even when its threshold is 1 — that case is
 * already the existing `newOnes`/`'notify'` verdict in `decideAction`, and
 * duplicating it here would either double-comment or need the two paths
 * reconciled for no benefit.
 *
 * An IDENTITY-LESS prior — one whose `runId` is null, i.e. whose `count`
 * stands for a failure no run id was ever written down for — is the one case
 * where a real, comparable identity does NOT advance the counter. It ADOPTS
 * the observed id as the identity of the failure already counted, holds the
 * count, and reports the lane in `advanced` — not because it advanced, but
 * because the adoption has to reach the issue body: `advanced` is what earns
 * a `'sync'` verdict, and a `'noop'` would leave the line identity-less,
 * re-adopt next poll, and stall the counter forever.
 *
 * Two priors are identity-less, and the rule is the same for both because the
 * fact is the same for both — nothing has been counted against a nameable run:
 *
 *   - a pre-#4400 BARE marker line (`prior.migrated`, see
 *     `parseKnownStreaks`): its `count: 1` stands for a run that was observed
 *     and counted under the old format, which simply had nowhere to record
 *     WHICH run; on the first poll after this ships, the run this lane is
 *     failing on is overwhelmingly likely to be that same one (the watchdog
 *     polls daily, the lane it is migrating runs weekly), so advancing would
 *     count it twice;
 *   - a `job|N|` line THIS script wrote while the lane had no completed run
 *     to point at at all (`never-ran`/`no-completed-run` — see
 *     `newestCompletedRunId` in `check-workflow-liveness.mjs`, which reports
 *     null rather than guessing). Its count was recorded against no run, so
 *     the first genuinely observed failing run is the FIRST counted one, not
 *     the second.
 *
 * The second case is the one this rule was widened to cover (#4440 review):
 * advancing there makes a weekly lane that was `never-ran` when first tracked
 * escalate after TWO observed failing runs, a week earlier than the N=3 the
 * rendered body promises its reader, and — worse than the week — the count
 * stops meaning "distinct observed failing runs" for precisely the lanes this
 * watchdog exists for (#3388 was `never-ran` when it was first tracked).
 *
 * The alternative — let an identity-less prior over-count by one — was
 * considered and rejected. It is tempting because the lane that motivated
 * #4400 (#3388) has already burned three weeks, so escalating a week early
 * looks like a favour. But the favour is worth exactly one week, once, and
 * the price is a permanent one: the rendered body would say "2 in a row"
 * about one run, which is a false statement in reader-facing prose, and the
 * counter's whole contract — a count is a count of DISTINCT observed runs —
 * would have an unwritten exception in it. Escalating early also fails in the
 * expensive direction: `escalationThreshold`'s own doc prices a week of extra
 * silence as much cheaper than a comment that teaches readers to expect noise.
 */
export function advanceStreaks({ currentFailing, laneById, known, fallbackRunId }) {
  const streaks = new Map(known)
  const advanced = []
  const escalated = []
  for (const job of currentFailing) {
    const lane = laneById.get(job)
    const threshold = escalationThreshold(lane?.periodHours)
    const prior = known.get(job)

    if (!prior) {
      const runId = lane?.runId === undefined ? fallbackRunId : lane.runId
      streaks.set(job, { count: 1, runId })
      continue
    }

    if (prior.count >= threshold) continue

    const runId = lane?.runId === undefined ? fallbackRunId : lane.runId
    // Unknowable, or the same run again — hold.
    //
    // Both sides are coerced because they do not arrive with the same TYPE.
    // `runId` is whatever the caller's JSON payload held: a NUMBER for the
    // watchdog profile (`newestCompletedRunId` returns `gh run list`'s
    // `databaseId`), a string for the deep-checks `fallbackRunId` (a run
    // URL). `prior.runId` always comes back as TEXT — `buildIssueBody`
    // renders `job|count|runId` into the marker block and `parseKnownStreaks`
    // splits that line back out — so `17654321 === '17654321'` is `false` and
    // an uncoerced compare would never hold. The counter would then advance
    // once per DAILY poll against a WEEKLY lane, which is precisely the bug
    // this function's doc comment says it exists to prevent. Same coercion
    // for the same round-trip reason as `--exclude-run-id`'s filter in
    // `check-workflow-liveness.mjs`'s `orderedRuns`.
    //
    // The `null` check stays AHEAD of the compare and must not be folded into
    // it: `String(null)` is `'null'`, which does NOT equal a real persisted
    // id, so an unknowable identity would fall through to the advance branch
    // and tick once per daily poll on a workflow that has never run at all —
    // the fail-open this whole guard is here to refuse.
    if (runId === null || String(runId) === String(prior.runId)) continue

    // An IDENTITY-LESS prior — a pre-#4400 bare line, or a `job|N|` line this
    // script wrote while the lane had no completed run to name. Adopt this run
    // as the identity of the failure its count already stands for, and HOLD.
    // See the doc comment above for why both cases are the same rule; the
    // adoption is pushed to `advanced` so that it is PERSISTED, not because
    // the count moved.
    //
    // `== null` (permitted by this repo's `eqeqeq` config, which ignores
    // null) rather than `=== null`: an entry built by a caller that simply
    // omitted `runId` is identity-less in exactly the same way, and the
    // alternative is that it falls through to the advance branch — where
    // `String(undefined)` matches no persisted id and the counter ticks once
    // per poll. Identity-less is classified POSITIVELY here for that reason;
    // the advance below runs only on a prior that really does name a run.
    if (prior.runId == null) {
      streaks.set(job, { count: prior.count, runId })
      advanced.push(job)
      continue
    }

    const count = prior.count + 1
    streaks.set(job, { count, runId })
    advanced.push(job)
    if (count >= threshold) escalated.push(job)
  }
  return { streaks, advanced, escalated }
}

/**
 * #4400 — un-does the threshold-crossing advance for lanes whose escalation
 * comment this run is NOT going to send.
 *
 * `decideAction` ranks `'notify'` above `'escalate'`: when lane A crosses its
 * threshold in the same run that lane B newly fails, the comment names B and
 * only B. Persisting A's crossing advance anyway would discard A's escalation
 * PERMANENTLY, not defer it — `advanceStreaks` skips a lane whose count has
 * already reached its threshold before it compares anything, so A would sit
 * at N forever and the one follow-up comment it earned would never be said
 * (until it recovers and the counter resets, which is exactly the "still red,
 * nobody was told" silence #4400 exists to end). The body's `streaking` line
 * would still show the count, so the loss is confined to the notification
 * channel — but that channel is the entire point of the feature.
 *
 * Rolling the advance back to what the issue body already held converts that
 * permanent loss into a one-run deferral: the next poll re-observes the same
 * crossing run against the un-advanced prior, re-crosses, and — with no new
 * lane outranking it — escalates. It costs one poll of delay (a day for the
 * watchdog) and one body that briefly under-reports A's count by one, which
 * is strictly better than a comment that is never emitted.
 *
 * Deliberately applied ONLY to the crossing lanes, never to a below-threshold
 * `advanced` lane: an advance that crosses nothing is not news, nothing is
 * suppressed by the `'notify'` verdict, and rolling it back WOULD lose real
 * progress (the lane would re-count the same run next poll and stall).
 */
export function rollBackSuppressedEscalations(streaks, known, suppressed) {
  if (suppressed.length === 0) return streaks
  const out = new Map(streaks)
  for (const job of suppressed) {
    const prior = known.get(job)
    if (prior) out.set(job, prior)
    else out.delete(job)
  }
  return out
}

/**
 * The rolling issue's open/close state machine. Split out as a pure function
 * precisely because it is the part with real branches worth pinning:
 *
 *   'create'   — first failure ever; no issue exists yet.
 *   'notify'   — a lane is NEWLY failing: reopen if closed, rewrite body, and
 *                COMMENT (the comment is the notification channel; body
 *                edits are state and notify nobody).
 *   'escalate' — no lane is newly failing, but an already-tracked lane's
 *                consecutive-observed-failure count just crossed its
 *                threshold (#4400 — see `advanceStreaks`): reopen if closed,
 *                rewrite body, and COMMENT, same as 'notify' — this IS a new
 *                data point, just not a new lane. Checked after 'notify' so
 *                the two never fire for the same run; a genuinely new lane
 *                is already the loudest thing that happened this run. The
 *                crossing that loses that race is DEFERRED, not dropped —
 *                `main()` rolls its advance back so the next run re-crosses
 *                and says it (see `rollBackSuppressedEscalations`).
 *   'sync'     — either some lane recovered, or a still-failing lane's
 *                persisted streak state changed without crossing its
 *                threshold — it observed a new distinct run, or an
 *                identity-less lane (a pre-#4400 bare line, or one first
 *                tracked while it had no completed run to name) adopted a run
 *                identity for the failure its count already stands for and
 *                HELD, rather than advancing: rewrite the
 *                body (so a recovered lane stops being named, or so the
 *                counter — crossed-but-not-yet-there, or merely identified —
 *                is actually persisted for next time; see `advanceStreaks`),
 *                but do not comment. Neither a partial recovery nor an
 *                unescalated repeat is news.
 *   'close'    — everything is green again and the issue tracked something.
 *                A permanently-open "the workflow is red" issue is a lie that
 *                trains people to ignore it, which is the whole failure mode
 *                #3359 is about.
 *   'noop'     — nothing changed at all: the same lanes are still red AND (if
 *                any) still on the same observed run, or everything is green
 *                and there is nothing open. A weekly job that re-fires on an
 *                unchanged failure must not spam, and two runs that observe
 *                the identical underlying run must not double-count it.
 */
export function decideAction({
  newOnes,
  resolvedOnes,
  all,
  existingIssue,
  escalatedOnes = [],
  advancedOnes = [],
}) {
  if (all.length === 0) {
    if (existingIssue && existingIssue.state === 'OPEN' && resolvedOnes.length > 0) return 'close'
    return 'noop'
  }
  if (!existingIssue) return 'create'
  if (newOnes.length > 0) return 'notify'
  if (escalatedOnes.length > 0) return 'escalate'
  if (resolvedOnes.length > 0 || advancedOnes.length > 0) return 'sync'
  return 'noop'
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Every lane and its result, including the passing ones — so a reader never
 * has to infer whether an unlisted lane was green or simply never reported.
 * Sits OUTSIDE the marker block, so it can never affect dedup.
 */
export function buildStatusTable(lanes, profile = PROFILES[DEFAULT_PROFILE]) {
  const lines = [`| ${profile.unit} | result |`, '| --- | --- |']
  for (const l of lanes) {
    lines.push(`| \`${l.job}\` | ${RESULT_LABEL[l.result] ?? l.result} |`)
  }
  return lines
}

/**
 * `carriedOver` (#3960) — the tracked ${units} this run could NOT observe.
 *
 * They belong in the marker block (they are still tracked; "it never ran" is
 * not evidence of recovery) but NOT in a sentence that calls them failing:
 * the status table two lines below reports them `skipped`, so a body that
 * listed them under "currently failing" contradicted itself on one screen and
 * asserted a failure nobody observed. The tracked set is unchanged by this —
 * only the prose around it.
 */
export function buildIssueBody({
  all,
  carriedOver = [],
  lanes,
  runUrl,
  profile = PROFILES[DEFAULT_PROFILE],
  // #4400 — per-lane { count, runId }. Defaults to an empty map, which
  // renders every line in the OLD bare-job-id format: every pre-#4400 caller
  // of this function (and there are dozens) that never heard of streaks keeps
  // producing byte-identical marker blocks. Only `main()` passes the real
  // thing.
  streaks = new Map(),
}) {
  const carried = all.filter((j) => carriedOver.includes(j))
  const observedFailing = all.filter((j) => !carriedOver.includes(j))
  const list = (jobs) => jobs.map((j) => `\`${j}\``).join(', ')
  // Lanes with more than one consecutive OBSERVED failure recorded — worth a
  // line even below the escalation threshold, since "how far along" is
  // exactly the fact #3388 had no way to show a reader (its body never
  // changed after the first comment, so every subsequent week looked
  // identical to the first). Filtered on `all` rather than `streaks.keys()`
  // directly so a stale streaks entry for a since-recovered lane (there
  // should not be one, but see `main()`'s own defensiveness elsewhere in this
  // file) can never leak into the rendered body.
  const streaking = all.filter((j) => (streaks.get(j)?.count ?? 1) > 1)
  const out = []
  out.push(
    `${profile.what} It is filed, updated and closed automatically by \`scripts/file-scheduled-failures.mjs\` — **do not rename the title**, the filing script matches on it verbatim to find this issue instead of opening a new one.`,
  )
  out.push('')
  out.push(
    `${profile.why} It is a rolling issue: it reopens when a ${profile.unit} newly fails and closes itself once every ${profile.unit} is healthy again.`,
  )
  out.push('')
  // #4400 — this paragraph is the reader-facing contract for when this thread
  // makes noise, and it sits inside the very issue the escalation comments on,
  // so it has to describe the escalation path too. Before #4400 it truthfully
  // said a still-red ${unit} is never re-commented; that sentence survived the
  // feature that made it false for weekly lanes, which is exactly the drift
  // this comment exists to make expensive to repeat.
  out.push(
    `A ${profile.unit} that stays red is NOT re-commented run after run: a comment is sent when a ${profile.unit} newly fails, and the runs in between only update this issue's body — silently, with no notification.`,
  )
  out.push('')
  // #4456 review of #4440 — this paragraph used to say "N is three for a
  // weekly ${unit}" unconditionally, which reads as a promise on EVERY
  // profile rendering it, but `escalationThreshold` only ever returns 3 for
  // a lane whose `periodHours` is >= 168, and the deep-checks profile's lanes
  // (jobs inside one scheduled run) never carry `periodHours` at all — see
  // `PROFILES['deep-checks'].weeklyEscalation`'s doc. So the deep-checks body
  // was stating a guarantee none of its own lanes could ever satisfy: the
  // exact "the rendered body says something untrue" defect #4440 fixed twice
  // already (see the comment above `advanceStreaks`'s identity-less-prior
  // handling), surviving in a third place. Conditioned on the PROFILE, not on
  // the lanes actually failing this run, because the promise is about what
  // this profile's escalation contract CAN ever do, not about today's set.
  //
  // #4481 review note 1 — the `weeklyEscalation: true` branch used to close
  // with "three observations really are three weeks unfixed", true only
  // while a genuine weekly `failure (…)` run was the sole way to reach a
  // streak of 3. This PR made a `stale` lane advance its streak on
  // consecutive DAILY watchdog polls (see `buildResults` in
  // `check-workflow-liveness.mjs` and the `streaking` comment just below),
  // so within this SAME profile three observations can now be three days,
  // not three weeks. Worded so it holds for both lane shapes at once rather
  // than naming a unit the paragraph cannot always deliver.
  out.push(
    profile.weeklyEscalation
      ? `The one exception (#4400) is escalation: a ${profile.unit} still failing on its **Nth consecutive OBSERVED run** earns exactly one further comment. N is three for a weekly ${profile.unit} — one this reporter polls far more often than it actually runs, so three observations are three of whatever is actually happening: three of the ${profile.unit}'s own weekly runs for a lane genuinely running and failing (three weeks unfixed), or three of this reporter's own daily polls for a lane that has gone stale and never ran at all (three days unfixed) — and one for everything else, which is another way of saying those get only their first-failure comment. Escalation fires once; afterwards the ${profile.unit} goes back to being tracked in silence until it recovers, so a persistent failure still cannot spam this thread.`
      : `The one exception (#4400) is escalation: a ${profile.unit} still failing on its **Nth consecutive OBSERVED run** earns exactly one further comment. N is one for every ${profile.unit} this profile tracks — ${profile.escalationCeilingReason} — so escalation here is just that first-failure comment, never a repeat. Escalation fires once; afterwards the ${profile.unit} goes back to being tracked in silence until it recovers, so a persistent failure still cannot spam this thread.`,
  )
  out.push('')
  out.push(`### Tracked failing ${profile.units} (${all.length})`)
  if (carried.length > 0) {
    out.push('')
    out.push(
      `Failing as of this run: ${observedFailing.length > 0 ? list(observedFailing) : `_none_`}.`,
    )
    out.push('')
    out.push(
      `Carried over — did NOT run this run (${list(carried)}), so neither failing nor recovered. A ${profile.unit} that never executed stays tracked until a run can actually observe it; the status table below shows what it really did.`,
    )
  }
  if (streaking.length > 0) {
    out.push('')
    out.push(
      // #4456 review — "a run that did not happen does not count" was true
      // while every counted observation WAS a completed run of the watched
      // thing. It stopped being true the moment a `stale` lane started
      // counting watchdog POLLS: for a dead cron the count is made entirely
      // of runs that did not happen, which is the point. Reworded to the
      // statement that holds for all three shipped identities (a completed
      // run's id, this reporter's own run, a poll observing a dead cron)
      // rather than left as reader-facing prose this change made false —
      // that being the defect #4456 note 3 filed, and the one it would be
      // absurd to fix in one paragraph and introduce in another.
      `${streaking.length} ${streaking.length === 1 ? profile.unit : profile.units} failing across multiple consecutive DISTINCT observations (#4400 — never once per invocation of this reporter: a distinct completed run wherever there is one to name, and otherwise a distinct run of this reporter observing the same thing again): ${streaking
        .map((j) => `\`${j}\` (${streaks.get(j).count} in a row)`)
        .join(', ')}.`,
    )
  }
  out.push('')
  out.push(
    `_Machine-readable — do not hand-edit the marker lines below. Removing a ${profile.unit} here just means the next run will report it as new again._`,
  )
  out.push(MARKER_START)
  out.push('```')
  // #4400 — `job|count|runId`. Note this format change lands on BOTH rolling
  // issues, not just the watchdog's: the deep-checks profile's lanes carry no
  // per-lane `runId` (its `toJSON(needs)` payload has no such key), so
  // `advanceStreaks` falls back to this invocation's own identity and these
  // lines read `job|1|https://github.com/…/runs/NNN` — a full run URL inside a
  // block whose prose above calls itself machine-readable. For deep-checks
  // that count never moves off 1 (a daily lane's threshold IS 1), but
  // `advanceStreaks` falls back to the same run-URL identity for a
  // watchdog-only case #4481 added: a `stale` lane (dead cron) has no
  // completed run to name either, so it ALSO renders a run URL here — except
  // its threshold is 3 (weekly, `periodHours: 168`), so this same
  // `job|count|runId` shape can carry counts up to 3, not just 1. Behaviour
  // is otherwise unchanged (`parseKnownLanes` takes field 0 regardless), but
  // the body a reader sees does change, which is why it is called out here
  // rather than left to be rediscovered from a diff.
  out.push(
    ...all.map((j) => {
      const s = streaks.get(j)
      if (!s) return j
      // A MIGRATED entry is written back BARE — the format it came in as.
      //
      // `parseKnownStreaks` mints `migrated` for a line with NO `|` at all,
      // so rendering one as `job|1|` reads back as an ordinary identity-less
      // entry and the flag is gone. That erasure needs no poll of its own to
      // happen: any OTHER lane advancing rewrites the whole body, and this
      // lane's provenance is destroyed as a side effect of someone else's
      // news (#4440 review — two weekly lanes, one held with no run to adopt,
      // one adopting, verdict `'sync'`, body rewritten).
      //
      // Bare is a LOSSLESS round trip and the `|` form is not: a migrated
      // entry is minted in exactly one place, with `count: 1` and
      // `runId: null`, and `advanceStreaks` either holds it unchanged or
      // replaces it with an ordinary adopted entry — so `job` re-reads as
      // the identical `{ count: 1, runId: null, migrated: true }`.
      //
      // A lane can stay bare across many polls (a daily one is past its N=1
      // threshold, so `advanceStreaks` skips it before it can adopt). That
      // costs nothing: its count can never move either way, and a lane whose
      // count CAN move rewrites the line the first poll it sees a run id.
      if (s.migrated) return j
      return `${j}|${s.count}|${s.runId ?? ''}`
    }),
  )
  out.push('```')
  out.push(MARKER_END)
  if (lanes.length > 0) {
    out.push('')
    out.push(`### All ${profile.units}, last run`)
    out.push('')
    out.push(...buildStatusTable(lanes, profile))
  }
  if (runUrl) {
    out.push('')
    out.push(`_Last updated by [this run](${runUrl})._`)
  }
  return out.join('\n')
}

/**
 * The line a no-op run prints — the run log's version of the issue body.
 *
 * `all` includes the carried-over lanes, which is right for the TRACKED set
 * and wrong for the word "failing": those lanes only skipped. The body stopped
 * claiming that (see `buildIssueBody`); this is the same claim in the summary,
 * and it gets the same split rather than leaving the `carried over (…)` line
 * printed above to soften a sentence that is still wrong.
 */
export function buildNoopSummary({ all, carriedOver = [], profile = PROFILES[DEFAULT_PROFILE] }) {
  if (all.length === 0) {
    return `all ${profile.headline}s healthy — no-op (nothing open that tracks a failing ${profile.unit})`
  }
  const observedFailing = all.filter((j) => !carriedOver.includes(j))
  const stillFailing = observedFailing.length > 0 ? observedFailing.join(', ') : 'none'
  const carriedNote =
    carriedOver.length > 0 ? `; carried over, did not run: ${carriedOver.join(', ')}` : ''
  return `no newly-failing ${profile.unit} — no-op (still failing: ${stillFailing}${carriedNote}; tracking issue left untouched)`
}

export function buildFailureComment({
  newOnes,
  lanes,
  runUrl,
  profile = PROFILES[DEFAULT_PROFILE],
}) {
  const lines = []
  lines.push(
    `**${newOnes.length} ${profile.headline}${newOnes.length === 1 ? '' : 's'} newly failing this run:** ${newOnes.map((j) => `\`${j}\``).join(', ')}`,
  )
  lines.push('')
  if (lanes.length > 0) {
    lines.push(...buildStatusTable(lanes, profile))
    lines.push('')
  }
  if (runUrl) lines.push(`Run: ${runUrl}`)
  return lines.join('\n')
}

/**
 * #4400 — the ONE extra comment a still-red lane earns when its consecutive
 * observed-failure count crosses its threshold. Deliberately NOT worded like
 * `buildFailureComment` ("newly failing this run") — it is not newly failing,
 * that is the whole point being fixed: it has been failing for
 * `escalationThreshold` distinct runs running, and this is the run that made
 * that fact visible instead of silent.
 */
export function buildEscalationComment({
  escalatedOnes,
  streaks,
  lanes,
  runUrl,
  profile = PROFILES[DEFAULT_PROFILE],
}) {
  const lines = []
  // #4456 review — "failed that many DISTINCT observed runs" is exactly the
  // wrong sentence for the lane this ticket taught the counter to escalate:
  // a `stale` workflow has not failed N runs, it has failed to RUN, and its
  // count is N watchdog polls that each saw it still not running. Saying
  // "observations" instead is true of every shipped identity at once, and
  // keeps this comment from being the fourth place the body promises the
  // reader something the code does not do.
  const named = escalatedOnes
    .map((j) => `\`${j}\` (${streaks.get(j)?.count ?? '?'} consecutive observations)`)
    .join(', ')
  lines.push(
    `**Still red, not new — escalating:** ${named}. This ${profile.unit}${
      escalatedOnes.length === 1 ? ' has' : 's have'
    } been in that state across that many DISTINCT consecutive observations without this thread saying so again (#4400) — a distinct completed run each time where there was one to name, and otherwise a distinct run of this reporter finding it unchanged. This is the one follow-up comment that changes, not a new lane appearing.`,
  )
  lines.push('')
  if (lanes.length > 0) {
    lines.push(...buildStatusTable(lanes, profile))
    lines.push('')
  }
  if (runUrl) lines.push(`Run: ${runUrl}`)
  return lines.join('\n')
}

export function buildRecoveryComment({
  resolvedOnes,
  runUrl,
  profile = PROFILES[DEFAULT_PROFILE],
}) {
  const lines = []
  lines.push(
    `${profile.recovery} — closing. Recovered since the last update: ${resolvedOnes.map((j) => `\`${j}\``).join(', ')}.`,
  )
  if (runUrl) lines.push('', `Run: ${runUrl}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Wiring guard: every lane must be in the reporter's `needs`
// ---------------------------------------------------------------------------

/**
 * A reporter that only `needs:` nine of ten jobs silently stops reporting the
 * tenth — the exact class of "capable of failing but nobody is told" bug this
 * script exists to close, reintroduced by a future PR that adds a lane and
 * forgets this list. This walks `scheduled-deep-checks.yml` textually (no YAML
 * dependency; the file's layout is uniform) and returns the jobs the reporting
 * job does not depend on.
 *
 * Text-based on purpose: the alternative is adding a `yaml` runtime dependency
 * to a repo whose scripts have none.
 */
export function findUncoveredLanes(workflowText, reporterJob = 'report-scheduled-failures') {
  const lines = workflowText.split('\n')
  const jobsIdx = lines.findIndex((l) => l === 'jobs:')
  if (jobsIdx === -1) throw new Error('no top-level `jobs:` key found in the workflow')

  const jobs = []
  for (const line of lines.slice(jobsIdx + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (m) jobs.push(m[1])
  }
  if (jobs.length === 0) throw new Error('no jobs found under `jobs:`')
  if (!jobs.includes(reporterJob)) {
    throw new Error(`the reporting job \`${reporterJob}\` is not defined in the workflow`)
  }

  const reporterIdx = lines.indexOf(`  ${reporterJob}:`)
  const needsIdx = lines.indexOf('    needs:', reporterIdx)
  if (needsIdx === -1 || needsIdx > reporterIdx + 12) {
    throw new Error(`\`${reporterJob}\` has no block-style \`needs:\` list`)
  }
  const needs = []
  for (const line of lines.slice(needsIdx + 1)) {
    const m = /^ {6}- ([A-Za-z0-9_-]+)\s*$/.exec(line)
    if (!m) break
    needs.push(m[1])
  }

  return jobs.filter((j) => j !== reporterJob && !needs.includes(j))
}

// The step whose `run:` block decides — per event AND per ref — whether this
// script's answer is authoritative. Matched by name, so a rename fails loud.
export const REPORTER_STEP_NAME =
  'File, update or close the single scheduled-failure tracking issue'

// The ref the cron itself runs on: GitHub schedules a workflow against the
// default branch's HEAD. A dispatch on any OTHER ref is a branch's answer to
// a repo-wide question, which is the case #3960 exists to keep out of the
// issue. Note that ref equality is NECESSARY for a dispatch to be
// cron-equivalent and NOT sufficient — see `findDispatchInputDefaults`.
export const CRON_REF = 'refs/heads/main'

/**
 * The `workflow_dispatch` inputs and their declared defaults, read from the
 * workflow's own `on:` block.
 *
 * The fourth iteration of this PR's one defect (review pass four): the ref
 * guard treated "same ref as the cron" as "same run as the cron", but this
 * workflow's dispatch inputs CHANGE WHAT THE LANES TEST. `fuzz_seconds=10` on
 * `refs/heads/main` passes the ref test and writes authoritatively, while a
 * still-broken `fuzz` lane reports `success` at a budget it was never meant
 * to pass at — so the lane lands in `resolvedOnes` and, if it was the last
 * tracked one, closes the issue over a lane never tested at its real budget.
 *
 * Read from the `on:` block rather than hardcoded so that ADDING an input
 * cannot silently escape the gate.
 *
 * Returns EVERY declared input, mapped to its declared default or to `null`
 * when it declares none. A `required: true` string, or a `choice` leaning on
 * `options[0]`, is a legal input with no `default:`, and it changes what the
 * lanes test exactly like the ones that have one — but recording only the
 * inputs with a `default:` silently dropped it from the gate, which made the
 * generality claim above false. An input this cannot compare is reported to
 * the caller as a problem, never skipped.
 *
 * Throws when the block cannot be found, when it is empty, or when the two
 * scans below disagree. The scans terminate on DIFFERENT rules — one at the
 * `on:` mapping's indent, one at the `inputs:` mapping's — so a stray line
 * that ends one but not the other is a partial parse, and a partial parse
 * gating a write must be loud: reading half the input list and gating on it
 * is the same fail-open as reading none and calling it healthy.
 */
export function findDispatchInputDefaults(workflowText) {
  const lines = workflowText.split('\n')
  const dispatchIdx = lines.findIndex((l) => /^ {2}workflow_dispatch:\s*$/.test(l))
  if (dispatchIdx === -1) throw new Error('no `workflow_dispatch:` trigger found in the workflow')
  const inputsIdx = lines.findIndex(
    (l, i) => i > dispatchIdx && /^ {4}inputs:\s*$/.test(l) && i < dispatchIdx + 4,
  )
  if (inputsIdx === -1) throw new Error('`workflow_dispatch:` declares no `inputs:` block')
  // Neither blank lines nor comments carry structure, so neither ends a
  // block. A `#` at column 0 used to end both scans below.
  const isStructural = (line) => line.trim() !== '' && !line.trim().startsWith('#')
  const inputKeyOf = (line) => /^ {6}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1]

  // (a) The permissive scan: every input key anywhere in the `on:` block's
  //     `workflow_dispatch:` span. Ends only at the trigger level.
  const declared = []
  for (let i = inputsIdx + 1; i < lines.length; i++) {
    if (!isStructural(lines[i])) continue
    if (lines[i].match(/^(\s*)/)[1].length <= 2) break
    const key = inputKeyOf(lines[i])
    if (key) declared.push(key)
  }

  // (b) The scan that reads the defaults, ending at the `inputs:` level.
  const defaults = {}
  let current = null
  for (let i = inputsIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!isStructural(line)) continue
    if (line.match(/^(\s*)/)[1].length <= 4) break
    const key = inputKeyOf(line)
    if (key) {
      current = key
      // Declared first, defaulted only if a `default:` shows up below it —
      // so an input with none is present and `null`, not absent.
      defaults[key] = null
      continue
    }
    const def = /^ {8}default:\s*(.+?)\s*$/.exec(line)
    if (def && current) defaults[current] = def[1].replace(/^['"]|['"]$/g, '')
  }

  if (declared.length === 0) {
    throw new Error('no `workflow_dispatch` inputs found — the input gate would be vacuous')
  }
  const missed = declared.filter((name) => !(name in defaults))
  if (missed.length > 0) {
    throw new Error(
      `the \`workflow_dispatch\` inputs block parsed only ${Object.keys(defaults).length} of ${declared.length} declared inputs (missed: ${missed.join(', ')}) — a partial input list must not be gated on as if it were the whole one`,
    )
  }
  return defaults
}

/**
 * Which env var of the reporting step carries which dispatch input, read out
 * of the step's own `env:` block (`FOO_INPUT: ${{ github.event.inputs.foo …`).
 *
 * Read rather than assumed, so the naming convention is not a second thing
 * that can drift: an input the step never maps into its environment is one
 * the step cannot possibly gate on.
 */
export function findDispatchInputEnvMapping(workflowText, stepName = REPORTER_STEP_NAME) {
  const lines = workflowText.split('\n')
  const nameRe = new RegExp(
    `^\\s*-\\s*name:\\s*${stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
  )
  const stepIdx = lines.findIndex((l) => nameRe.test(l))
  if (stepIdx === -1) throw new Error(`no \`${stepName}\` step found — renamed or deleted?`)
  const mapping = {}
  for (let i = stepIdx + 1; i < lines.length; i++) {
    if (/^\s*-\s*name:\s/.test(lines[i])) break
    const m = /^\s*([A-Z0-9_]+):\s*\$\{\{\s*(?:github\.event\.)?inputs\.([A-Za-z0-9_-]+)/.exec(
      lines[i],
    )
    if (m) mapping[m[2]] = m[1]
  }
  return mapping
}

/**
 * The reporting step's `run:` script, dedented, exactly as the runner would
 * execute it. Throws when the step or its block scalar cannot be found: a
 * rename must fail loud, not pass vacuously.
 */
export function findReporterRunScript(workflowText, stepName = REPORTER_STEP_NAME) {
  const lines = workflowText.split('\n')
  const nameRe = new RegExp(
    `^\\s*-\\s*name:\\s*${stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
  )
  const stepIdx = lines.findIndex((l) => nameRe.test(l))
  if (stepIdx === -1) {
    throw new Error(`no \`${stepName}\` step found — did it get renamed or deleted?`)
  }
  let runIdx = -1
  for (let i = stepIdx + 1; i < lines.length; i++) {
    if (/^\s*-\s*name:\s/.test(lines[i])) break
    if (/^\s*run:\s*\|\s*$/.test(lines[i])) {
      runIdx = i
      break
    }
  }
  if (runIdx === -1) throw new Error(`the \`${stepName}\` step has no block-scalar \`run: |\``)
  const runIndent = lines[runIdx].match(/^(\s*)/)[1].length
  const body = []
  for (let i = runIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      body.push('')
      continue
    }
    if (lines[i].match(/^(\s*)/)[1].length <= runIndent) break
    body.push(lines[i])
  }
  const populated = body.filter((l) => l.trim() !== '')
  if (populated.length === 0) throw new Error(`the \`${stepName}\` step's \`run:\` block is empty`)
  const dedent = Math.min(...populated.map((l) => l.match(/^(\s*)/)[1].length))
  return body.map((l) => l.slice(dedent)).join('\n')
}

/**
 * #3716/#3960 — what the reporting step ACTUALLY hands this script for a
 * given event and ref, obtained by running the step's own bash against a
 * stub `node` first on `$PATH`.
 *
 * This replaces a text guard that searched the job block for the `--dry-run`
 * token. That guard pinned the wrong invariant twice over. It could not tell
 * a conditional `--dry-run` (the fix) from an unconditional one (the bug),
 * so it rejected the fix; and it read prose, so a trailing comment merely
 * MENTIONING the flag tripped it while the actual semantics — under which
 * event, on which ref, does this job write to a repo-wide issue — were never
 * examined at all. Executing the block answers the real question and is
 * immune to comments by construction: bash already knows what a `#` means.
 *
 * The step is this repo's own file and runs with a stubbed `node`, so nothing
 * it can do reaches GitHub.
 */
export function resolveReporterInvocation(
  workflowText,
  { eventName = 'schedule', ref = CRON_REF, inputs = {}, stepName = REPORTER_STEP_NAME } = {},
) {
  const script = findReporterRunScript(workflowText, stepName)
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-failures-step-'))
  const log = join(dir, 'argv.log')
  const stub = join(dir, 'node')
  // Shebang is the ABSOLUTE path of the real node, never `/usr/bin/env node`:
  // this stub IS named `node` and sits first on `$PATH`, so `env node` would
  // re-exec the stub forever.
  writeFileSync(
    stub,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs')",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(stub, 0o755)
  writeFileSync(log, '', 'utf8')
  const stepFile = join(dir, 'step.sh')
  writeFileSync(stepFile, script, 'utf8')
  // The dispatch inputs, as the runner would present them: every input the
  // step maps into its `env:` is set, defaulted from the workflow's own `on:`
  // block and overridden by `inputs`. The step's `${{ … || 'default' }}` idiom
  // means the env var is never empty, on any event, so `set -u` is safe.
  const declaredDefaults = findDispatchInputDefaults(workflowText)
  const envMapping = findDispatchInputEnvMapping(workflowText, stepName)
  const inputEnv = {}
  for (const [name, envVar] of Object.entries(envMapping)) {
    inputEnv[envVar] = String(inputs[name] ?? declaredDefaults[name] ?? '')
  }
  execFileSync('bash', [stepFile], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...inputEnv,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      EVENT_NAME: eventName,
      GITHUB_REF: ref,
      GITHUB_REF_NAME: ref.replace(/^refs\/(?:heads|tags)\//, ''),
      NEEDS_JSON: '{"some-lane":{"result":"success"}}',
      GH_TOKEN: 'stub-token',
    },
  })
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
  if (calls.length !== 1) {
    throw new Error(
      `the reporting step invoked \`node\` ${calls.length} time(s); expected exactly one call to the reporter`,
    )
  }
  const [entry, ...args] = calls[0]
  if (!String(entry).endsWith('file-scheduled-failures.mjs')) {
    throw new Error(`the reporting step ran \`node ${entry}\`, not the reporter script`)
  }
  return { entry, args }
}

/**
 * A value that is definitely NOT a dispatch input's declared default, in the
 * same shape as the default (so the step's own `[ "$X" != "120" ]` test sees
 * a realistic value rather than a type it would never receive).
 */
export function flipDispatchInputDefault(value) {
  // An input with no declared default has nothing to differ FROM; any value
  // at all is "not the cron's". The caller reports that as a problem in its
  // own right — this only keeps the flip total.
  if (value === null || value === undefined) return 'any-value-at-all'
  if (value === 'false') return 'true'
  if (value === 'true') return 'false'
  if (/^\d+$/.test(value)) return value === '10' ? '11' : '10'
  return `${value}-changed`
}

// ---------------------------------------------------------------------------
// `gh` plumbing
// ---------------------------------------------------------------------------

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8' })
  return JSON.parse(out)
}

/** Finds the single tracking issue by exact title, preferring an OPEN match. */
function findTrackingIssue(repo, title) {
  const results = ghJson([
    'issue',
    'list',
    '--repo',
    repo,
    '--search',
    `in:title "${title}"`,
    '--state',
    'all',
    '--json',
    'number,title,body,state',
    '--limit',
    '20',
  ])
  const exact = results.filter((i) => i.title === title)
  if (exact.length === 0) return null
  const open = exact.find((i) => i.state === 'OPEN')
  if (open) return open
  return exact.toSorted((a, b) => b.number - a.number)[0]
}

/**
 * The comment body for whichever action turns out to need one ('close',
 * 'notify', 'escalate' — 'create'/'sync'/'noop' never reach here). Pulled out
 * of `main()` as its own three-way switch rather than a nested ternary there,
 * to keep `main()` itself under the repo's cyclomatic-complexity lint budget.
 */
function buildCommentFor(
  action,
  { resolvedOnes, newOnes, escalated, streaks, lanes, runUrl, profile },
) {
  switch (action) {
    case 'close': {
      return buildRecoveryComment({ resolvedOnes, runUrl, profile })
    }
    case 'escalate': {
      return buildEscalationComment({ escalatedOnes: escalated, streaks, lanes, runUrl, profile })
    }
    default: {
      return buildFailureComment({ newOnes, lanes, runUrl, profile })
    }
  }
}

/**
 * Two independent, optional run-log lines: which lanes only SKIPPED this run
 * (#3960) and which lanes just crossed their escalation threshold (#4400).
 * Neither depends on the other, and folding them into one function (instead
 * of two `if` blocks inline in `main()`) is purely to keep `main()` itself
 * under the repo's cyclomatic-complexity lint budget.
 */
function logCarriedOverAndEscalated({ carriedOver, escalated, deferred = [], streaks, profile }) {
  if (carriedOver.length > 0) {
    console.log(
      `carried over (${profile.unit}s that only SKIPPED — neither failing nor recovered, so they stay tracked): ${carriedOver.join(', ')}`,
    )
  }
  if (escalated.length > 0) {
    console.log(
      `escalating (#4400 — Nth consecutive OBSERVED failure): ${escalated
        .map((j) => `${j} (${streaks.get(j)?.count})`)
        .join(', ')}`,
    )
  }
  if (deferred.length > 0) {
    console.log(
      `escalation DEFERRED to the next run (#4400 — a newly-failing ${profile.unit} outranks it this run, so the advance is rolled back rather than persisted and lost): ${deferred
        .map((j) => `${j} (would have been ${streaks.get(j)?.count})`)
        .join(', ')}`,
    )
  }
}

function withTempFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-failures-'))
  const file = join(dir, 'body.md')
  writeFileSync(file, content, 'utf8')
  fn(file)
}

function gh(args) {
  execFileSync('gh', args, { stdio: 'inherit' })
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, skippedOk: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--needs-json-file': {
        args.needsJsonFile = argv[++i]
        break
      }
      case '--profile': {
        args.profile = argv[++i]
        break
      }
      case '--skipped-ok': {
        args.skippedOk = true
        break
      }
      case '--repo': {
        args.repo = argv[++i]
        break
      }
      case '--run-url': {
        args.runUrl = argv[++i]
        break
      }
      case '--dry-run': {
        args.dryRun = true
        break
      }
      case '--known-body-file': {
        args.knownBodyFile = argv[++i]
        break
      }
      case '--known-state': {
        args.knownState = argv[++i]
        break
      }
      default: {
        throw new Error(`unrecognized argument: ${a}`)
      }
    }
  }
  return args
}

function defaultRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
  }
  return undefined
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const profile = resolveProfile(args.profile)
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY
  const runUrl = args.runUrl ?? defaultRunUrl()

  if (!args.needsJsonFile) throw new Error('--needs-json-file is required')
  if (!existsSync(args.needsJsonFile)) {
    throw new Error(
      `--needs-json-file ${args.needsJsonFile} does not exist — the \`needs\` context was never written, so lane health is UNKNOWN, not green`,
    )
  }
  const lanes = parseNeeds(readFileSync(args.needsJsonFile, 'utf8'))
  const current = failingJobs(lanes, { skippedOk: args.skippedOk })
  const carryOver = carriedOverJobs(lanes, { skippedOk: args.skippedOk })

  console.log(
    `${profile.headline}s: ${lanes.length} total, ${current.length} failing${
      current.length > 0 ? ` (${current.join(', ')})` : ''
    }`,
  )

  // --known-body-file is a TEST-ONLY escape hatch substituting for the
  // `gh issue list` lookup, so the diff/decide/render logic can be exercised
  // against sample data without touching real GitHub state.
  let existingIssue = null
  if (args.knownBodyFile !== undefined) {
    const body = existsSync(args.knownBodyFile) ? readFileSync(args.knownBodyFile, 'utf8') : ''
    existingIssue = body ? { number: 0, state: args.knownState ?? 'OPEN', body } : null
  } else {
    if (!repo)
      throw new Error(
        '--repo (or $GITHUB_REPOSITORY) is required outside of --known-body-file test mode',
      )
    existingIssue = findTrackingIssue(repo, profile.title)
  }

  const known = parseKnownLanes(existingIssue?.body)
  const { newOnes, resolvedOnes, all, carriedOver } = diffLanes(current, known, { carryOver })
  // #4400 — the consecutive-observed-failure counter. Fed `current`, not
  // `all`: a carried-over (skipped) lane must not advance, and it is already
  // excluded from `current` by `failingJobs`/`isFailing`, so it is left
  // exactly as `known` had it (see `advanceStreaks`'s `streaks = new
  // Map(known)` seed). `fallbackRunId` only matters for a caller that never
  // supplies its own `runId` per lane (deep-checks) — see the function's own
  // doc comment for why that is safe.
  const laneById = new Map(lanes.map((l) => [l.job, l]))
  const knownStreaks = parseKnownStreaks(existingIssue?.body)
  const { streaks, advanced, escalated } = advanceStreaks({
    currentFailing: current,
    laneById,
    known: knownStreaks,
    fallbackRunId: runUrl ?? '(unknown run — no $GITHUB_RUN_ID or --run-url)',
  })
  const action = decideAction({
    newOnes,
    resolvedOnes,
    all,
    existingIssue,
    escalatedOnes: escalated,
    advancedOnes: advanced,
  })
  // #3987 — `all` is the TRACKED set, which includes lanes that only
  // SKIPPED and were carried over (see `buildIssueBody`/`buildNoopSummary`
  // above, #3960). A sentence that calls `all.length` "still failing"
  // therefore claims a failure nobody observed for those lanes too; the two
  // run-log streams below made that claim after the issue body itself
  // stopped making it. `observedFailing` is the same split, used here for
  // the same reason.
  const observedFailing = all.filter((j) => !carriedOver.includes(j))

  // #4400 — a crossing that this run's verdict will not announce is DEFERRED,
  // not discarded: see `rollBackSuppressedEscalations`. `'notify'` is the only
  // verdict that outranks a crossing ('create' has no prior state to advance
  // from, 'close' clears the whole tracked set, and 'sync'/'noop' cannot be
  // reached with a non-empty `escalated`).
  const deferred = action === 'notify' ? escalated : []
  const persistedStreaks = rollBackSuppressedEscalations(streaks, knownStreaks, deferred)

  logCarriedOverAndEscalated({
    carriedOver,
    escalated: deferred.length > 0 ? [] : escalated,
    deferred,
    streaks,
    profile,
  })

  if (action === 'noop') {
    console.log(buildNoopSummary({ all, carriedOver, profile }))
    return
  }

  const body = buildIssueBody({
    all,
    carriedOver,
    lanes,
    runUrl,
    profile,
    streaks: persistedStreaks,
  })
  const comment = buildCommentFor(action, {
    resolvedOnes,
    newOnes,
    escalated,
    // Identical to `streaks` on the one path that reads it ('escalate', where
    // nothing is deferred by definition); passed as the same object the body
    // is rendered from so the comment can never quote a count the issue body
    // does not show.
    streaks: persistedStreaks,
    lanes,
    runUrl,
    profile,
  })

  if (args.dryRun) {
    // Compare against null explicitly — the `--known-body-file` stub uses
    // issue number 0, which is falsy, so a truthiness check on `.number`
    // would misreport an existing issue as "not found".
    const where =
      existingIssue === null
        ? `a new issue titled "${profile.title}"`
        : `issue #${existingIssue.number} (${existingIssue.state})`
    console.log(`[dry-run] action=${action} target=${where}`)
    console.log(
      `[dry-run] newly failing: ${newOnes.length}, recovered: ${resolvedOnes.length}, still failing: ${observedFailing.length}`,
    )
    console.log('[dry-run] --- issue body ---')
    console.log(body)
    console.log('[dry-run] --- comment ---')
    console.log(comment)
    return
  }

  if (!repo) throw new Error('--repo (or $GITHUB_REPOSITORY) is required to file/update an issue')

  if (action === 'create') {
    withTempFile(body, (bodyFile) => {
      const labelArgs = profile.labels.flatMap((l) => ['--label', l])
      gh([
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        profile.title,
        '--body-file',
        bodyFile,
        ...labelArgs,
      ])
    })
    console.log(`filed a new tracking issue (${all.length} failing ${profile.unit}(s))`)
    return
  }

  const number = String(existingIssue.number)

  if (action === 'close') {
    // Rewrite the body BEFORE closing. `all` is empty on this path, so the
    // marker block ends up EMPTY — which is the point: closing without
    // clearing it would leave the recovered lanes in the tracked set, and the
    // very next week the SAME lane failing again would diff to zero new lanes
    // — a no-op against a closed issue, i.e. total silence. That is precisely
    // the bug class this whole job exists to remove.
    withTempFile(body, (f) => {
      gh(['issue', 'edit', number, '--repo', repo, '--body-file', f])
    })
    withTempFile(comment, (f) => {
      gh(['issue', 'comment', number, '--repo', repo, '--body-file', f])
    })
    gh(['issue', 'close', number, '--repo', repo])
    console.log(
      `closed tracking issue #${number} (all ${profile.units} healthy again; tracked set cleared)`,
    )
    return
  }

  // 'notify' (a genuinely new failure) and 'escalate' (#4400 — an
  // already-tracked lane's Nth consecutive OBSERVED failure) are otherwise
  // identical from here: both reopen a closed issue and both comment. Only
  // 'sync' (a partial recovery, or a still-below-threshold repeat) differs —
  // body only, no comment. Split out so `main()` itself stays under the
  // complexity budget; see `writeNotifyOrSync`'s own doc comment for why the
  // two are handled together rather than as three separate branches here.
  writeNotifyOrSync({
    action,
    number,
    repo,
    body,
    comment,
    existingIssue,
    newOnes,
    resolvedOnes,
    observedFailing,
    escalated,
    profile,
  })
}

/**
 * #4400 — the shared tail of 'notify' and 'escalate': both reopen a closed
 * issue and both comment, and only the log line and which lanes get named in
 * it differ. Written as one function with an internal branch, rather than
 * inlined twice in `main()`, specifically to keep `main()`'s own cyclomatic
 * complexity under the repo's lint budget — the two actions are semantically
 * "the notification channel fired", and separating the two identical
 * `gh issue edit`/reopen/comment sequences into copy-pasted call sites would
 * be the kind of duplication `main()`'s own history already avoids elsewhere
 * (see the shared `withTempFile` helper).
 */
function writeNotifyOrSync({
  action,
  number,
  repo,
  body,
  comment,
  existingIssue,
  newOnes,
  resolvedOnes,
  observedFailing,
  escalated,
  profile,
}) {
  const isNotifyClass = action === 'notify' || action === 'escalate'
  // Reopening is a notification-class action, so only a genuinely NEW failure
  // or an escalation does it. A 'sync' (partial recovery, or an unescalated
  // repeat) against an issue a maintainer chose to close while lanes were
  // still red just updates the body — consistent with the 'noop' branch in
  // `main()`, which also leaves such an issue closed.
  //
  // #4400 — an escalating lane really can find the issue closed, and this is
  // the branch that decides what happens then. The 'sync' case immediately
  // above is not hypothetical: every below-threshold advance takes it, so a
  // weekly lane that a maintainer closed the issue on keeps silently editing
  // that closed issue, week after week, until its Nth consecutive observed
  // failure — at which point this line REOPENS it. State the consequence
  // rather than lean on an invariant: a manual close does not stick for a
  // weekly lane. That is deliberate. Escalation is notification-class for the
  // same reason 'notify' is — it is a data point the reader has not been told,
  // and a closed issue tells them nothing — so the alternative would be to
  // comment into a closed issue nobody is subscribed to reading, which is the
  // silence this feature exists to end. A maintainer who wants a lane to stop
  // reporting has to fix it, drop its `periodHours` decoration, or stop
  // watching it; closing the issue only silences the below-threshold syncs.
  if (isNotifyClass && existingIssue.state === 'CLOSED') {
    gh(['issue', 'reopen', number, '--repo', repo])
  }
  withTempFile(body, (f) => {
    gh(['issue', 'edit', number, '--repo', repo, '--body-file', f])
  })
  if (!isNotifyClass) {
    console.log(
      `synced tracking issue #${number} body (${resolvedOnes.length} recovered, ${observedFailing.length} still failing; no comment — a partial recovery or an unescalated repeat is not news)`,
    )
    return
  }
  withTempFile(comment, (f) => {
    gh(['issue', 'comment', number, '--repo', repo, '--body-file', f])
  })
  console.log(
    action === 'notify'
      ? `updated tracking issue #${number} (${newOnes.length} newly-failing ${profile.unit}(s))`
      : `updated tracking issue #${number} (escalated ${escalated.length} still-failing ${profile.unit}(s) past their Nth-consecutive-observed-failure threshold — #4400)`,
  )
}

// Entry-point detection in the one sanctioned form (#3373): both sides
// realpath'd. The banned `file://` template form was live here when #3374's
// watchdog was verified against a checkout whose `scripts/` was a symlink —
// this script exited 0 having filed nothing, silently, the exact bug class the
// reporter exists to remove. #3376 landed the same fix on `main` first, so
// this note is all that remains of it here.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    main()
  } catch (err) {
    console.error(`file-scheduled-failures: ${err.message}`)
    process.exit(1)
  }
}
