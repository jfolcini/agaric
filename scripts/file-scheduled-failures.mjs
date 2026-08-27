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
//     [--self-test]                 (run the fixture suite; no `gh`, no I/O)
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
// no unbounded list to render. The self-test pins that bound so a future
// change that starts embedding logs here fails loudly instead of 422ing
// `gh issue edit`.
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
 * and a couple dozen pre-#4400 self-tests — wants exactly the job id and
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
 * `migrated` is the third state, and it is load-bearing rather than
 * decorative. Two DIFFERENT priors both have no run identity, and the body
 * still distinguishes them even though `{ count, runId }` alone does not:
 *
 *   - a BARE line: some run was observed and counted, and the old format had
 *     nowhere to write down which one;
 *   - a post-#4400 `job|1|` line: this script recorded the lane while there
 *     was no completed run to name at all (`never-ran`/`stale` — see
 *     `newestCompletedRunId`), so nothing has been counted against a run yet.
 *
 * Collapsing the two is a real over-count. The first post-merge poll of a
 * migrated lane sees a real run id, which differs from `null`, and would
 * advance the counter to 2 with no new run having happened — the same
 * already-counted run counted twice, i.e. precisely the "a REPEATED
 * observation must not be misread as a NEW one" defect `advanceStreaks`
 * exists to refuse, reintroduced through the migration door. So the flag is
 * carried here, where the distinction is still visible in the text, and
 * `advanceStreaks` holds that first poll instead (see its `migrated` branch).
 * The flag never round-trips: the moment that poll adopts an identity, the
 * line is rewritten as `job|count|runId` and parses as an ordinary entry.
 *
 * The `|` split is UNGUARDED against a job id that itself contains a `|`
 * (here and in `parseKnownLanes`), and deliberately so — the invariant is
 * enforced where the ids are MINTED, not defended against where they are
 * read, because a parser cannot tell a corrupt line from an exotic one:
 *   - watchdog profile: the id is a watched workflow FILENAME, allow-listed
 *     to `[A-Za-z0-9._-]` by an assertion over `WATCHED` in
 *     `check-workflow-liveness.mjs`'s self-test;
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
 *   - `undefined` (the caller's payload never had the key — the deep-checks
 *     reporter's `toJSON(needs)` never does): falls back to `fallbackRunId`,
 *     this script INVOCATION's own identity. Correct there specifically
 *     because that reporter runs from inside the very workflow it watches —
 *     one invocation of this script already IS one real occurrence, so
 *     "new invocation" and "new run" already coincide and nothing is lost by
 *     treating them as the same signal.
 *   - `null` (the key IS present but the caller could not name a run — e.g.
 *     `newestCompletedRunId` reporting `never-ran`/`stale`/no completed run
 *     at all): the identity is unknowable, so the counter HOLDS — it neither
 *     advances nor resets. Falling back to the invocation id here would
 *     advance once per DAILY tick against a workflow that has simply never
 *     run, which is the bug relocated rather than fixed.
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
 * A MIGRATED prior (`prior.migrated` — a pre-#4400 bare marker line, see
 * `parseKnownStreaks`) is the one case where a real, comparable identity does
 * NOT advance the counter. Its `count: 1` already stands for a run that was
 * observed and counted under the old format, which simply had nowhere to
 * record WHICH run; on the first poll after this ships, the run this lane is
 * failing on is overwhelmingly likely to be that same one (the watchdog polls
 * daily, the lane it is migrating runs weekly). Advancing would count it
 * twice. So this poll ADOPTS the observed id as the identity of the failure
 * already counted, holds the count, and reports the lane in `advanced` — not
 * because it advanced, but because the adoption has to reach the issue body:
 * `advanced` is what earns a `'sync'` verdict, and a `'noop'` would leave the
 * line bare, re-adopt next poll, and stall the counter at 1 forever.
 *
 * The alternative — let the migration over-count by one — was considered and
 * rejected. It is tempting because the lane that motivated #4400 (#3388) has
 * already burned three weeks, so escalating a week early looks like a favour.
 * But the favour is worth exactly one week, once, on one lane, and the price
 * is a permanent one: the rendered body would say "2 in a row" about one run,
 * which is a false statement in reader-facing prose, and the counter's whole
 * contract — a count is a count of DISTINCT observed runs — would have an
 * unwritten exception in it. Escalating early also fails in the expensive
 * direction: `escalationThreshold`'s own doc prices a week of extra silence
 * as much cheaper than a comment that teaches readers to expect noise.
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

    // A pre-#4400 bare line: adopt this run as the identity of the failure
    // its `count: 1` already stands for, and hold. See the doc comment above
    // — the adoption is pushed to `advanced` so that it is PERSISTED, not
    // because the count moved.
    if (prior.migrated) {
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
 *                threshold — it observed a new distinct run, or (once, on the
 *                first poll after #4400 shipped) a migrated lane adopted a
 *                run identity for its already-counted failure: rewrite the
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
  // of this function (and there are dozens, across this file's own
  // self-tests) that never heard of streaks keeps producing byte-identical
  // marker blocks. Only `main()` passes the real thing.
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
  out.push(
    `The one exception (#4400) is escalation: a ${profile.unit} still failing on its **Nth consecutive OBSERVED run** earns exactly one further comment. N is three for a weekly ${profile.unit} — one this reporter polls far more often than it actually runs, so three observations really are three weeks unfixed — and one for everything else, which is another way of saying those get only their first-failure comment. Escalation fires once; afterwards the ${profile.unit} goes back to being tracked in silence until it recovers, so a persistent failure still cannot spam this thread.`,
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
      `${streaking.length} ${streaking.length === 1 ? profile.unit : profile.units} failing across multiple consecutive OBSERVED runs (#4400 — a run that did not happen does not count): ${streaking
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
  // block whose prose above calls itself machine-readable. Behaviour there is
  // unchanged (`parseKnownLanes` takes field 0, and a daily lane's threshold
  // of 1 means the count never moves off 1), but the body a reader sees does
  // change, which is why it is called out here rather than left to be
  // rediscovered from a diff.
  out.push(
    ...all.map((j) => {
      const s = streaks.get(j)
      return s ? `${j}|${s.count}|${s.runId ?? ''}` : j
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
  const named = escalatedOnes
    .map((j) => `\`${j}\` (${streaks.get(j)?.count ?? '?'} consecutive observed failures)`)
    .join(', ')
  lines.push(
    `**Still red, not new — escalating:** ${named}. This ${profile.unit}${
      escalatedOnes.length === 1 ? ' has' : 's have'
    } now failed that many DISTINCT observed runs in a row without this thread saying so again (#4400) — this is the one follow-up comment that changes, not a new lane appearing.`,
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
 * cannot silently escape the gate: `checkReporterAuthority` flips each
 * declared input in turn and requires the run to stop being authoritative.
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
 * the step cannot possibly gate on, and `checkReporterAuthority` says so.
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
 * rename must fail loud, not pass vacuously (same rule as
 * `findLastResortNoticeCondition`).
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

/**
 * Bash arrays declared EMPTY and then expanded as `"${name[@]}"`.
 *
 * On bash < 4.4 — stock `/bin/bash` on macOS, a platform this repo supports
 * (`scripts/setup-hooks.sh` keeps its own tables bash-3.2-compatible on
 * purpose) — expanding an empty array under `set -u` is an UNBOUND VARIABLE
 * error, not an empty expansion. In the workflow that aborts the step; in
 * this file's self-test, which executes the step for real, it aborted the
 * pre-commit hook with a raw shell error for those developers only, because
 * CI and this dev box both run bash 5.
 *
 * The invariant is "the array is never empty at the point of expansion", so
 * either seeding the array (what the workflow now does — the arguments that
 * are always passed live in it from the start) or the `${a[@]+"${a[@]}"}`
 * guard satisfies it. Returns the offending array names; `[]` is healthy.
 */
export function findUnportableEmptyArrayExpansions(script) {
  const declaredEmpty = [...script.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=\(\s*\)\s*$/gm)].map(
    (m) => m[1],
  )
  return [...new Set(declaredEmpty)].filter((name) => {
    const guarded = new RegExp(`\\$\\{${name}\\[@\\]\\+"\\$\\{${name}\\[@\\]\\}"\\}`, 'g')
    return script.replace(guarded, '').includes(`\${${name}[@]}`)
  })
}

/**
 * The invariant the guard above exists for, in every direction:
 *
 *   * the cron run, and a dispatch that reproduces it, are AUTHORITATIVE —
 *     no `--dry-run`, or an off-cycle answer is computed and thrown away and
 *     the issue keeps advertising a stale, sometimes inverted, set for up to
 *     a week (#3716);
 *   * a dispatch on ANY other ref is not — the tracking issue is repo-wide,
 *     so writing there publishes one branch's lane results as the
 *     repository's health (#3960, third pass);
 *   * and neither is a dispatch that CHANGED WHAT THE LANES TEST. Ref
 *     equality was mistaken for cron-equivalence: `fuzz_seconds=10` on the
 *     cron ref makes a still-broken lane report `success`, which the diff
 *     reads as a recovery and can close the issue over (#3960, fourth pass).
 *     Every declared input is flipped in turn, so an input added later
 *     without being gated reddens this guard rather than shipping.
 *
 * Pinning only one direction is how this defect has already been shipped
 * three times, so all of them are asserted here, plus the `--skipped-ok`
 * pairing that only makes sense off the schedule.
 *
 * Returns `{ problems, cases }`; an empty `problems` means healthy.
 */
export function checkReporterAuthority(
  workflowText,
  { cronRef = CRON_REF, otherRef = 'refs/heads/fix/mutants', stepName = REPORTER_STEP_NAME } = {},
) {
  const tagRef = `refs/tags/${cronRef.replace(/^refs\/heads\//, '')}`
  const at = (eventName, ref, inputs = {}) =>
    resolveReporterInvocation(workflowText, { eventName, ref, inputs, stepName }).args
  const cases = {
    schedule: at('schedule', cronRef),
    dispatchOnCronRef: at('workflow_dispatch', cronRef),
    dispatchOnOtherRef: at('workflow_dispatch', otherRef),
    dispatchOnTagOfCronRef: at('workflow_dispatch', tagRef),
  }
  const problems = []

  // The input dimension, one input at a time.
  const declaredDefaults = findDispatchInputDefaults(workflowText)
  const envMapping = findDispatchInputEnvMapping(workflowText, stepName)
  for (const [name, declaredDefault] of Object.entries(declaredDefaults)) {
    if (declaredDefault === null) {
      problems.push(
        `the dispatch input \`${name}\` declares no \`default:\`, so there is no value the step can compare against to recognise a cron-equivalent run — give it a default, or gate on its presence explicitly (#3960)`,
      )
      continue
    }
    if (!envMapping[name]) {
      problems.push(
        `the dispatch input \`${name}\` is not mapped into the deciding step's \`env:\`, so the step cannot tell a run that changed it from a cron-equivalent one (#3960)`,
      )
      continue
    }
    const changed = flipDispatchInputDefault(declaredDefault)
    const args = at('workflow_dispatch', cronRef, { [name]: changed })
    cases[`dispatchWith_${name}`] = args
    if (!args.includes('--dry-run')) {
      problems.push(
        `a workflow_dispatch on ${cronRef} with \`${name}=${changed}\` (declared default \`${declaredDefault}\`) still WRITES — a non-default input changes what the lanes TEST, so a lane that only "passed" at a shortened budget would be published as recovered and could close the issue (#3960)`,
      )
    }
  }

  const unportable = findUnportableEmptyArrayExpansions(
    findReporterRunScript(workflowText, stepName),
  )
  if (unportable.length > 0) {
    problems.push(
      `the step expands the possibly-empty array(s) ${unportable.map((n) => `\`${n}\``).join(', ')} under \`set -u\` — an unbound-variable abort on bash < 4.4 (stock /bin/bash on macOS). Seed the array, or expand it as \`\${name[@]+"\${name[@]}"}\``,
    )
  }
  if (cases.schedule.includes('--dry-run')) {
    problems.push('the scheduled run passes `--dry-run` — the weekly report writes nothing at all')
  }
  if (cases.schedule.includes('--skipped-ok')) {
    problems.push(
      'the scheduled run passes `--skipped-ok` — on the cron every lane runs, so a `skipped` lane is a real failure and must read as one',
    )
  }
  if (cases.dispatchOnCronRef.includes('--dry-run')) {
    problems.push(
      `a workflow_dispatch on ${cronRef} passes \`--dry-run\` — the one way to get an off-cycle answer computes it and discards it, leaving the issue advertising a stale set for up to a week (#3716)`,
    )
  }
  if (!cases.dispatchOnCronRef.includes('--skipped-ok')) {
    problems.push(
      'a workflow_dispatch does not pass `--skipped-ok` — the schedule-only filer lane reports `skipped` off the cron, which would read as a lane failure',
    )
  }
  if (!cases.dispatchOnOtherRef.includes('--dry-run')) {
    problems.push(
      `a workflow_dispatch on ${otherRef} WRITES for real — that branch's lane results would be published as the repo-wide tracking issue's answer, closing an issue whose subject (${cronRef}) is still red (#3960)`,
    )
  }
  if (!cases.dispatchOnTagOfCronRef.includes('--dry-run')) {
    problems.push(
      `a workflow_dispatch on ${tagRef} writes for real — a TAG is not the branch the cron runs, so the ref test must compare the full ref, not the short name`,
    )
  }
  return { problems, cases }
}

/**
 * #3960 — the `if:` expression of the last-resort "the reporter itself broke"
 * bash step, as written in the workflow.
 *
 * That step is the only thing that reports a crash of THIS script, and it was
 * gated on `github.event_name == 'schedule'` back when a dispatch ran the
 * reporter with `--dry-run` and therefore could not damage anything by
 * crashing. #3716 removed the `--dry-run`; a dispatch now issues real
 * `gh issue edit`/`comment`/`close` calls, so a crash between them leaves the
 * tracking issue half-rewritten — exactly the state that most needs
 * announcing. Re-adding an event gate here would restore that silence, so
 * the condition is pinned by the self-test.
 *
 * Throws rather than returning a default when the step (or its `if:`) cannot
 * be found: a rename must fail loud, not pass vacuously.
 */
export function findLastResortNoticeCondition(workflowText) {
  const lines = workflowText.split('\n')
  const idx = lines.findIndex((l) => /^\s*-\s*name:\s*Last-resort notice/.test(l))
  if (idx === -1) {
    throw new Error('no `Last-resort notice` step found — did it get renamed or deleted?')
  }
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s*-\s*name:\s/.test(lines[i])) break
    const m = /^\s*if:\s*(.+?)\s*$/.exec(lines[i])
    if (m) return m[1]
  }
  throw new Error('the `Last-resort notice` step has no `if:` condition at all')
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

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
//
// Fixture suite for the invariants this reporter exists to hold. Wired as the
// `scheduled-failure-reporter-selftest` prek hook.
/**
 * 10. What `main()` ACTUALLY writes, driven end to end against a stub `gh`
 *     placed first on `$PATH`.
 *
 * Every other assertion in this file is a pure-function assertion: they pin
 * what a body/comment SHOULD contain, never that the writing path emits it.
 * That gap is not hypothetical — deleting the `gh issue edit` from the close
 * path below leaves all 32 of them green while re-introducing exactly the bug
 * the close path exists to prevent (the tracked set is never cleared, so the
 * same lane failing again next week diffs to zero new lanes and is silent
 * forever). A guard that cannot fail is worse than no guard, so the call
 * SEQUENCE and the bytes handed to `--body-file` are pinned here directly.
 *
 * Split out of `runSelfTest` to keep its cyclomatic complexity under the repo
 * lint budget, same as `file-mutation-survivors.mjs` does.
 */
function selfTestGhCallSequence({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-failures-gh-'))
  const log = join(dir, 'gh.log')
  const stub = join(dir, 'gh')
  // Extensionless and CommonJS on purpose: `execFileSync('gh', …)` resolves
  // the name verbatim through `$PATH`, and an extensionless file under
  // `tmpdir()` has no `package.json` above it, so Node parses it as CJS.
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const a = process.argv.slice(2)',
      "const i = a.indexOf('--body-file')",
      "const t = a.indexOf('--title')",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({`,
      '  sub: a[1],',
      "  title: t === -1 ? '' : a[t + 1],",
      "  body: i === -1 ? '' : fs.readFileSync(a[i + 1], 'utf8'),",
      "}) + '\\n')",
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(stub, 0o755)

  const needsFile = join(dir, 'needs.json')
  const bodyFile = join(dir, 'known-body.md')

  // An EMPTY `--known-body-file` is how `main()` spells "no existing issue",
  // so no file removal is needed between drives.
  // What `main()` printed during the last `drive()` — the run summary is a
  // claim about lane health like any other, so it is asserted rather than
  // discarded with the rest of the noise.
  let lastLogs = []
  const drive = (needs, knownBody, knownState, profileArgs = []) => {
    writeFileSync(needsFile, JSON.stringify(needs), 'utf8')
    writeFileSync(bodyFile, knownBody, 'utf8')
    writeFileSync(log, '', 'utf8')
    const prevPath = process.env.PATH
    const prevLog = console.log
    process.env.PATH = `${dir}:${prevPath}`
    lastLogs = []
    console.log = (...parts) => lastLogs.push(parts.join(' '))
    let threw = null
    try {
      main([
        '--needs-json-file',
        needsFile,
        '--known-body-file',
        bodyFile,
        '--known-state',
        knownState,
        '--repo',
        'owner/repo',
        '--run-url',
        'https://example/run',
        ...profileArgs,
      ])
    } catch (err) {
      // Surface as a failed assertion below rather than a raw stack: the one
      // environmental way this can throw is a `noexec` $TMPDIR, which would
      // otherwise look like a mysterious reporter bug.
      threw = err
    } finally {
      console.log = prevLog
      process.env.PATH = prevPath
    }
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    if (threw) calls.push({ sub: `THREW(${threw.message})`, body: '' })
    return calls
  }

  const redLanes = { mutants: { result: 'failure' }, fuzz: { result: 'success' } }
  const greenLanes = { mutants: { result: 'success' }, fuzz: { result: 'success' } }
  const trackingBody = buildIssueBody({
    all: ['mutants'],
    lanes: [
      { job: 'fuzz', result: 'success' },
      { job: 'mutants', result: 'failure' },
    ],
    runUrl: undefined,
  })

  // The close path is the one this exists for: it must REWRITE THE BODY
  // before closing, not just comment and close.
  const closeCalls = drive(greenLanes, trackingBody, 'OPEN')
  const closeSeq = closeCalls.map((c) => c.sub).join(',')
  check(
    closeSeq === 'edit,comment,close',
    'main() really issues edit → comment → close on the close path',
    `gh sequence was: ${closeSeq || '(no gh calls at all)'}`,
  )
  const writtenOnClose = closeCalls.find((c) => c.sub === 'edit')?.body ?? ''
  check(
    writtenOnClose.includes(MARKER_START) && parseKnownLanes(writtenOnClose).size === 0,
    'the body main() hands to `gh issue edit` before closing has an EMPTY tracked set',
    `marker present=${writtenOnClose.includes(MARKER_START)} tracked=[${[...parseKnownLanes(writtenOnClose)].join(',')}]`,
  )

  // A relapse against that cleared, CLOSED issue must reopen and comment.
  const relapseSeq = drive(
    redLanes,
    buildIssueBody({ all: [], lanes: [], runUrl: undefined }),
    'CLOSED',
  )
    .map((c) => c.sub)
    .join(',')
  check(
    relapseSeq === 'reopen,edit,comment',
    'main() really reopens, updates and comments when a lane relapses',
    `gh sequence was: ${relapseSeq || '(no gh calls at all)'}`,
  )

  // …and an unchanged failure must touch GitHub not at all (no weekly spam).
  const noopSeq = drive(redLanes, trackingBody, 'OPEN').map((c) => c.sub)
  check(
    noopSeq.length === 0,
    'an unchanged failure issues no `gh` write at all',
    `gh sequence was: ${noopSeq.join(',')}`,
  )

  // #3716: a dispatched run must report the CURRENT failing set, not
  // discard it and leave a stale (here, disjoint — the sharpest form of
  // "inverted") one standing. Same fixture driven twice: once the OLD way
  // (this script's own `--dry-run` flag, still legitimate on its own — see
  // the checks above — but never meant to reach here from a dispatch) to
  // reproduce the bug as RED, then the FIXED way (no `--dry-run`) as GREEN.
  // The workflow-level guard (§12 in `runSelfTest`, `checkReporterAuthority`)
  // is what decides WHICH runs reach this path with the flag and which reach
  // it without; this pins what happens on either side of that decision.
  {
    const staleBody = buildIssueBody({
      all: ['full-suite'],
      lanes: [
        { job: 'full-suite', result: 'failure' },
        { job: 'prek-all-files', result: 'success' },
      ],
      runUrl: undefined,
    })
    // The dispatch's TRUE current state: `full-suite` recovered,
    // `prek-all-files` is the one actually failing now — disjoint from what
    // the stale issue body above still advertises.
    const nowFailing = {
      'full-suite': { result: 'success' },
      'prek-all-files': { result: 'failure' },
    }

    const redCalls = drive(nowFailing, staleBody, 'OPEN', ['--dry-run', '--skipped-ok'])
    const redSeq = redCalls.map((c) => c.sub).join(',')
    check(
      redSeq === '',
      '#3716 RED (pre-fix dispatch shape): `--dry-run` computes the true set and writes NOTHING — the stale/inverted issue body stands unchanged',
      `gh sequence was: ${redSeq || '(no gh calls — reproduces the bug: nothing was written)'}`,
    )

    const greenCalls = drive(nowFailing, staleBody, 'OPEN', ['--skipped-ok'])
    const greenSeq = greenCalls.map((c) => c.sub).join(',')
    const written = greenCalls.find((c) => c.sub === 'edit')?.body ?? ''
    const trackedAfter = parseKnownLanes(written)
    check(
      greenSeq !== '' && trackedAfter.has('prek-all-files') && !trackedAfter.has('full-suite'),
      '#3716 GREEN (fixed dispatch shape): the identical fixture, without `--dry-run`, writes the CURRENT set (prek-all-files) and drops the stale one (full-suite) — not its inverse',
      `gh sequence was: ${greenSeq || '(no gh calls)'}; tracked after=[${[...trackedAfter].join(',')}]`,
    )
  }

  // #3960 — the call site for the carry-over rule above, split out to keep
  // this function under the repo's cyclomatic-complexity budget (same reason
  // `selfTestGhCallSequence` itself was split out of `runSelfTest`).
  selfTestSkippedCarryOverGhCalls({ check, drive, logs: () => lastLogs })

  // …and `--profile workflow-watchdog` really files under the WATCHDOG title.
  // Asserting `PROFILES` holds two distinct titles proves nothing about which
  // one `gh issue create` is handed: a `main()` that still passed
  // `TRACKING_ISSUE_TITLE` would keep every pure assertion green while
  // silently overwriting the deep-checks issue.
  {
    const created = drive({ 'codeql.yml': { result: 'stale (…)' } }, '', 'OPEN', [
      '--profile',
      'workflow-watchdog',
    ])
    const create = created.find((c) => c.sub === 'create')
    check(
      create !== undefined && create.title === PROFILES['workflow-watchdog'].title,
      'main() --profile workflow-watchdog files under the watchdog title, not the deep-checks one',
      `sub sequence=${created.map((c) => c.sub).join(',')} title=${create?.title}`,
    )
    check(
      create !== undefined && parseKnownLanes(create.body).has('codeql.yml'),
      'the watchdog issue main() creates tracks the workflow filename',
      `tracked=[${create ? [...parseKnownLanes(create.body)].join(',') : ''}]`,
    )
  }
}

/**
 * #3960 — the CALL SITE for the `--skipped-ok` carry-over rule. #3716 removed
 * `--dry-run` from the dispatch branch but left `--skipped-ok`, and those two
 * were only safe TOGETHER: with real writes turned on, a lane that was tracked
 * and then merely `skipped` (which is what the schedule-only
 * `file-fuzz-findings` does on every dispatch) diffed as recovered. The
 * pure-function half is § 2b in `runSelfTest`; this is what `main()` actually
 * hands `gh`, which is the half that reaches production — plus what it PRINTS,
 * since the run summary made the same claim the issue body did.
 */
function selfTestSkippedCarryOverGhCalls({ check, drive, logs }) {
  const fuzzFilerTracked = buildIssueBody({
    all: ['file-fuzz-findings'],
    lanes: [
      { job: 'file-fuzz-findings', result: 'failure' },
      { job: 'fuzz', result: 'success' },
    ],
    runUrl: undefined,
  })
  // A dispatch: `file-fuzz-findings` is `if: github.event_name ==
  // 'schedule'`, so GitHub reports it `skipped`.
  const dispatchLanes = {
    fuzz: { result: 'success' },
    'file-fuzz-findings': { result: 'skipped' },
  }
  const skippedCalls = drive(dispatchLanes, fuzzFilerTracked, 'OPEN', ['--skipped-ok'])
  const skippedSeq = skippedCalls.map((c) => c.sub).join(',')
  check(
    skippedSeq === '',
    'a dispatch does NOT close the issue over a tracked lane that merely skipped — no edit, no "recovered" comment, no close',
    `gh sequence was: ${skippedSeq || '(none)'}${
      skippedSeq.includes('close')
        ? ' — the lane was reported recovered on the strength of never having run'
        : ''
    }`,
  )
  // That run is the `noop` path, and its SUMMARY made the same claim the
  // issue body used to: `all` includes the carried lane, so the log said
  // "still failing: file-fuzz-findings" about a lane that only skipped.
  const noopSummary = logs().find((l) => l.includes('no-op')) ?? ''
  check(
    /still failing: none/.test(noopSummary) &&
      /carried over, did not run: file-fuzz-findings/.test(noopSummary),
    'the no-op run summary separates lanes that FAILED from lanes that never ran (the body’s distinction, in the run log)',
    noopSummary || `(no no-op line printed; logs were: ${logs().join(' / ')})`,
  )

  // The quieter variant of the same bug: with another lane genuinely red
  // the action is `notify`, which DOES rewrite the body — so the skipped
  // lane has to survive that rewrite rather than being dropped in silence.
  const mixedCalls = drive(
    { mutants: { result: 'failure' }, 'file-fuzz-findings': { result: 'skipped' } },
    fuzzFilerTracked,
    'OPEN',
    ['--skipped-ok'],
  )
  const mixedSeq = mixedCalls.map((c) => c.sub).join(',')
  const mixedBody = mixedCalls.find((c) => c.sub === 'edit')?.body ?? ''
  const mixedTracked = parseKnownLanes(mixedBody)
  check(
    mixedSeq === 'edit,comment' &&
      mixedTracked.has('file-fuzz-findings') &&
      mixedTracked.has('mutants'),
    'the body rewritten alongside a NEW failure still tracks the skipped lane (it is not silently dropped)',
    `gh sequence was: ${mixedSeq || '(none)'}; tracked after=[${[...mixedTracked].join(',')}]`,
  )
  // …and `main()` really hands the renderer the carry-over set, so the
  // body GitHub receives distinguishes "failing" from "did not run".
  // Asserting the pure renderer proves nothing about the write path: the
  // pre-fix `main()` rendered the identical `all` with no carry-over
  // argument at all, and the body then called a `skipped` lane failing
  // three lines above a table reporting it `skipped`.
  check(
    /Failing as of this run: `mutants`\./.test(mixedBody) &&
      /Carried over — did NOT run this run \(`file-fuzz-findings`\)/.test(mixedBody),
    'the body main() writes names the carried lane as carried, not as failing this run',
    mixedBody,
  )

  // #3987 — the same mixed fixture, driven with `--dry-run`, exercises the
  // OTHER stream that made the "carried-over lane counts as failing" claim:
  // the `[dry-run] … still failing: N` summary printed instead of writing.
  // Two lanes are tracked (`all.length` === 2) but only `mutants` is
  // genuinely red — `file-fuzz-findings` only skipped.
  const dryRunCalls = drive(
    { mutants: { result: 'failure' }, 'file-fuzz-findings': { result: 'skipped' } },
    fuzzFilerTracked,
    'OPEN',
    ['--skipped-ok', '--dry-run'],
  )
  check(
    dryRunCalls.length === 0,
    'sanity: --dry-run really calls `gh` zero times, so only the printed summary is under test below',
    `gh sequence was: ${dryRunCalls.map((c) => c.sub).join(',') || '(none)'}`,
  )
  const dryRunSummary = logs().find((l) => l.startsWith('[dry-run] newly failing')) ?? ''
  check(
    /still failing: 1\b/.test(dryRunSummary) && !/still failing: 2\b/.test(dryRunSummary),
    'the dry-run summary counts only the lane ACTUALLY still failing (mutants) — not the carried-over skip (file-fuzz-findings) that only skipped',
    dryRunSummary || `(no dry-run summary line printed; logs were: ${logs().join(' / ')})`,
  )

  // …and the SYNC path's log line: a partial recovery (mutants goes green)
  // alongside a carried-over skip (file-fuzz-findings never ran) must not
  // count the skip as "still failing" either — nothing observed this run
  // is actually red.
  const twoTrackedBody = buildIssueBody({
    all: ['file-fuzz-findings', 'mutants'],
    lanes: [
      { job: 'file-fuzz-findings', result: 'failure' },
      { job: 'mutants', result: 'failure' },
    ],
    runUrl: undefined,
  })
  const syncCalls = drive(
    { mutants: { result: 'success' }, 'file-fuzz-findings': { result: 'skipped' } },
    twoTrackedBody,
    'OPEN',
    ['--skipped-ok'],
  )
  const syncSeq = syncCalls.map((c) => c.sub).join(',')
  check(
    syncSeq === 'edit',
    'a partial recovery alongside a carried-over skip takes the sync path (edit only — no comment, no close)',
    `gh sequence was: ${syncSeq || '(none)'}`,
  )
  const syncSummary = logs().find((l) => l.startsWith('synced tracking issue')) ?? ''
  check(
    /0 still failing/.test(syncSummary),
    'the sync summary does not count the carried-over skip (file-fuzz-findings) as "still failing" — only mutants recovered, and nothing observed this run is red',
    syncSummary || `(no sync summary line printed; logs were: ${logs().join(' / ')})`,
  )

  // The close path must still work when the lane REALLY recovered — i.e.
  // the fix suppresses the recovery reading only for lanes that did not
  // run, not for green ones. Without this pair, carrying everything over
  // forever would pass the two checks above.
  const reallyGreen = drive(
    { fuzz: { result: 'success' }, 'file-fuzz-findings': { result: 'success' } },
    fuzzFilerTracked,
    'OPEN',
    ['--skipped-ok'],
  )
  const greenSeq = reallyGreen.map((c) => c.sub).join(',')
  check(
    greenSeq === 'edit,comment,close',
    'a lane that actually RAN and passed still closes the issue under --skipped-ok',
    `gh sequence was: ${greenSeq || '(none)'}`,
  )
}

/**
 * #3960 — `--skipped-ok` is a statement about what the run could OBSERVE, so
 * it must suppress the RECOVERY reading exactly as it suppresses the failure
 * reading. The pure-function half; `selfTestGhCallSequence` covers the call
 * site, which is where the false close actually reached GitHub.
 */
function selfTestSkippedCarryOver({ check, lanesOf }) {
  const lanes = lanesOf({ 'file-fuzz-findings': 'skipped', fuzz: 'success' })
  const opts = { skippedOk: true }
  const current = failingJobs(lanes, opts)
  const carryOver = carriedOverJobs(lanes, opts)

  // Tracked, then skipped: carried, not resolved — and the state machine
  // must therefore do NOTHING rather than close.
  const tracked = diffLanes(current, new Set(['file-fuzz-findings']), { carryOver })
  check(
    tracked.resolvedOnes.length === 0 &&
      tracked.all.join(',') === 'file-fuzz-findings' &&
      tracked.carriedOver.join(',') === 'file-fuzz-findings' &&
      decideAction({ ...tracked, existingIssue: { number: 1, state: 'OPEN' } }) === 'noop',
    'a TRACKED lane that only skipped is carried over, not reported recovered (no close)',
    `resolved=${JSON.stringify(tracked.resolvedOnes)} all=${JSON.stringify(tracked.all)} action=${decideAction({ ...tracked, existingIssue: { number: 1, state: 'OPEN' } })}`,
  )

  // …and the converse, which is what stops the carry-over from becoming a
  // second false-positive: a lane nobody was tracking must not become
  // tracked just because it did not run.
  const untracked = diffLanes(current, new Set(), { carryOver })
  check(
    untracked.all.length === 0 && untracked.carriedOver.length === 0,
    'an UNTRACKED lane that skipped is not added to the tracked set (skipping is not evidence of breakage either)',
    `all=${JSON.stringify(untracked.all)} carried=${JSON.stringify(untracked.carriedOver)}`,
  )

  // Without `--skipped-ok` (the schedule shape) nothing is carried: a
  // skipped lane there is a genuine failure and must read as one.
  check(
    carriedOverJobs(lanes, { skippedOk: false }).length === 0 &&
      failingJobs(lanes).includes('file-fuzz-findings'),
    'without --skipped-ok a skipped lane is failing, and nothing is carried over',
    JSON.stringify(carriedOverJobs(lanes, { skippedOk: false })),
  )

  // …and the RENDERING half (#3960, second review pass). A carried lane
  // belongs in the marker block — it is still tracked — but must not be
  // prose-asserted as failing: the status table directly below reports it
  // `skipped`, so the body used to contradict itself on one screen.
  {
    const rendered = buildIssueBody({
      all: ['file-fuzz-findings', 'mutants'],
      carriedOver: ['file-fuzz-findings'],
      lanes: lanesOf({ 'file-fuzz-findings': 'skipped', mutants: 'failure' }),
      runUrl: undefined,
    })
    check(
      /Failing as of this run: `mutants`\./.test(rendered) &&
        /Carried over — did NOT run this run \(`file-fuzz-findings`\)/.test(rendered) &&
        !/Currently-failing/.test(rendered) &&
        parseKnownLanes(rendered).has('file-fuzz-findings'),
      'a carried-over lane renders as carried, never as "currently failing", and stays in the tracked set',
      rendered,
    )
    // The converse: a body with nothing carried must not grow carry-over
    // prose either — that would be the same unobserved claim, inverted.
    const plain = buildIssueBody({
      all: ['mutants'],
      lanes: lanesOf({ mutants: 'failure' }),
      runUrl: undefined,
    })
    check(
      !/[Cc]arried over/.test(plain) && parseKnownLanes(plain).has('mutants'),
      'a body with nothing carried over says nothing about carry-over',
      plain,
    )
  }

  // A lane that is genuinely failing NOW is not "carried" past the diff —
  // carry-over must never mask a real red into a silent no-op.
  const stillRed = lanesOf({ 'file-fuzz-findings': 'failure' })
  const redDiff = diffLanes(failingJobs(stillRed, opts), new Set(), {
    carryOver: carriedOverJobs(stillRed, opts),
  })
  check(
    redDiff.newOnes.join(',') === 'file-fuzz-findings' && redDiff.carriedOver.length === 0,
    'a lane that actually FAILED is still newly-failing under --skipped-ok (carry-over does not swallow reds)',
    JSON.stringify(redDiff),
  )
}

/**
 * #3960 — the wiring half of the last-resort notice. That step is the only
 * thing that reports a crash of THIS script, and re-gating it on an event
 * would silently un-cover the dispatch path, which now writes for real.
 */
function selfTestLastResortNoticeCondition({ check, fail }) {
  const stepFixture = (ifLine) =>
    ['    steps:', '      - name: Last-resort notice (the reporter itself broke)', ifLine].join(
      '\n',
    )
  check(
    findLastResortNoticeCondition(stepFixture('        if: failure()')) === 'failure()',
    'the last-resort-notice condition is read back verbatim',
    '',
  )
  check(
    findLastResortNoticeCondition(
      stepFixture("        if: failure() && github.event_name == 'schedule'"),
    ).includes('github.event_name'),
    'the guard can SEE an event gate on the last-resort notice (it is able to fail)',
    '',
  )
  for (const [label, text] of [
    ['a renamed step', '    steps:\n      - name: Something else\n        if: failure()'],
    ['a step with no `if:`', stepFixture('        run: echo hi')],
  ]) {
    let threw = null
    try {
      findLastResortNoticeCondition(text)
    } catch (err) {
      threw = err
    }
    check(threw !== null, `the guard throws on ${label} instead of passing vacuously`, '')
  }

  const workflowPath = new URL('../.github/workflows/scheduled-deep-checks.yml', import.meta.url)
    .pathname
  if (existsSync(workflowPath)) {
    const condition = findLastResortNoticeCondition(readFileSync(workflowPath, 'utf8'))
    // Every run that CAN write, and no run that cannot. The un-gate was
    // justified by "a dispatch writes for real" — true of every dispatch
    // when it was written, true of a cron-ref dispatch only once #3960's
    // third pass restored `--dry-run` elsewhere. So the condition tracks the
    // ref too, or it reopens the repo-wide "the reporter is broken" issue for
    // a branch run that could not have left anything half-written.
    //
    // It deliberately does NOT also track the dispatch inputs: a cron-ref
    // dispatch with a shortened budget writes nothing, and this notice still
    // firing for it is an over-approximation in the LOUD direction — the only
    // direction a last-resort notice may err in. Over-firing costs a comment
    // on an issue; under-firing is the silence this whole job exists to end.
    const expected = `failure() && (github.event_name == 'schedule' || github.ref == '${CRON_REF}')`
    check(
      condition === expected,
      'the real last-resort notice fires for exactly the runs that can write: the cron, and a dispatch on the cron ref (#3960)',
      `if: ${condition}\nwant: ${expected}`,
    )
    check(
      condition.includes(CRON_REF),
      `the notice's condition names the same cron ref (${CRON_REF}) the authority gate compares against — one place changing without the other is the drift this pins`,
      `if: ${condition}`,
    )
  } else {
    fail('the real workflow file is readable', `not found at ${workflowPath}`)
  }
}

/**
 * #3716 + #3960 — which runs of the reporting job are AUTHORITATIVE.
 *
 * The two halves are one property and must be pinned as a pair:
 *   * a dispatch on the ref the cron uses must WRITE (else the only
 *     off-cycle answer is computed and thrown away — #3716), and
 *   * a dispatch on any other ref must NOT (else a branch's lane results are
 *     published as the repo-wide issue's answer — #3960).
 *
 * Pinning one and leaving the other open is exactly how this defect shipped
 * twice. Every fixture drives the real bash through
 * `resolveReporterInvocation`, so a shape that only LOOKS right (a ref test
 * on `GITHUB_REF_NAME`, say, which cannot tell the branch `main` from a tag
 * named `main`) fails here rather than in production.
 */
function selfTestReporterAuthority({ check, fail }) {
  // A miniature of the real workflow: two dispatch inputs with declared
  // defaults, both mapped into the deciding step's `env:` the way the real
  // step maps them, and a seeded `extra` array (bash 3.2 cannot expand an
  // empty one under `set -u`).
  const fixture = (branchBody, { mapInputs = true, extraInputWithoutDefault = null } = {}) =>
    [
      'on:',
      '  schedule:',
      "    - cron: '17 4 * * 1'",
      '  workflow_dispatch:',
      '    inputs:',
      '      fuzz_seconds:',
      "        description: 'Per-target fuzz time budget (seconds)'",
      '        required: false',
      "        default: '120'",
      '      slo_include_problem:',
      "        description: 'Also run the probes'",
      '        required: false',
      '        type: boolean',
      '        default: false',
      // A `required: true` input with no `default:` — legal, and equally
      // capable of changing what the lanes test.
      ...(extraInputWithoutDefault
        ? [
            `      ${extraInputWithoutDefault}:`,
            "        description: 'Something with no default at all'",
            '        required: true',
          ]
        : []),
      '',
      'jobs:',
      '  alpha:',
      '    runs-on: ubuntu-24.04',
      '  report-scheduled-failures:',
      '    steps:',
      `      - name: ${REPORTER_STEP_NAME}`,
      '        env:',
      '          EVENT_NAME: ${{ github.event_name }}',
      ...(mapInputs
        ? [
            "          FUZZ_SECONDS_INPUT: ${{ github.event.inputs.fuzz_seconds || '120' }}",
            "          SLO_INCLUDE_PROBLEM_INPUT: ${{ github.event.inputs.slo_include_problem || 'false' }}",
          ]
        : []),
      '        run: |',
      '          set -euo pipefail',
      `          printf '%s' "$NEEDS_JSON" > needs.json`,
      '          extra=(--needs-json-file needs.json)',
      '          if [ "$EVENT_NAME" != "schedule" ]; then',
      ...branchBody.map((l) => `            ${l}`),
      '          fi',
      '          node scripts/file-scheduled-failures.mjs "${extra[@]}"',
      '  another-job:',
      '    runs-on: ubuntu-24.04',
    ].join('\n')

  // The ref half only — what the third pass shipped, and what the fourth
  // review found insufficient.
  const REF_GUARDED = [
    'extra+=(--skipped-ok)',
    'if [ "$GITHUB_REF" != "refs/heads/main" ]; then',
    '  extra+=(--dry-run)',
    'fi',
  ]
  // The ref half AND the input half: a dispatch is cron-EQUIVALENT only when
  // it ran the same lanes, on the same ref, with the same budgets.
  const REF_AND_INPUTS_GUARDED = [
    'extra+=(--skipped-ok)',
    'if [ "$GITHUB_REF" != "refs/heads/main" ] ||',
    '   [ "$FUZZ_SECONDS_INPUT" != "120" ] ||',
    '   [ "$SLO_INCLUDE_PROBLEM_INPUT" != "false" ]; then',
    '  extra+=(--dry-run)',
    'fi',
  ]

  {
    const { problems } = checkReporterAuthority(fixture(REF_AND_INPUTS_GUARDED))
    check(
      problems.length === 0,
      'authority guard passes the fixed shape: the cron and a DEFAULT-INPUT dispatch on the cron ref write; every other ref, and every changed input, dry-runs',
      JSON.stringify(problems),
    )
  }

  // …and the arm that makes the pass above mean something: with the inputs
  // at their defaults the cron-ref dispatch must still WRITE. A gate that
  // dry-ran every dispatch would satisfy the input arm and re-break #3716.
  {
    const args = resolveReporterInvocation(fixture(REF_AND_INPUTS_GUARDED), {
      eventName: 'workflow_dispatch',
      ref: CRON_REF,
    }).args
    check(
      !args.includes('--dry-run') && args.includes('--skipped-ok'),
      'the fixed shape still WRITES for a default-input dispatch on the cron ref (the input gate did not swallow #3716)',
      JSON.stringify(args),
    )
  }

  // v3 of this defect (#3960, review pass four): the ref is guarded, the
  // inputs are not. `fuzz_seconds=10` on the cron ref writes authoritatively
  // over lanes that were never tested at their real budget.
  {
    const { problems } = checkReporterAuthority(fixture(REF_GUARDED))
    check(
      problems.some((p) => p.includes('fuzz_seconds=10') && p.includes('still WRITES')),
      'authority guard catches a REF-ONLY gate: a non-default input on the cron ref still writing (#3960, fourth pass)',
      JSON.stringify(problems),
    )
  }

  // An input the deciding step never sees cannot be gated on, whatever the
  // bash says — so a new input added to `on:` without an `env:` mapping is a
  // problem in its own right.
  {
    const { problems } = checkReporterAuthority(fixture(REF_GUARDED, { mapInputs: false }))
    check(
      problems.some((p) => p.includes('is not mapped into the deciding step')),
      'authority guard catches a dispatch input the deciding step never receives',
      JSON.stringify(problems),
    )
  }

  // v1 of this defect (#3716): every off-schedule run discarded. The
  // cron-ref dispatch arm is the one that must catch it.
  {
    const { problems } = checkReporterAuthority(fixture(['extra+=(--dry-run --skipped-ok)']))
    check(
      problems.some((p) => p.includes('#3716')),
      'authority guard catches an UNCONDITIONAL `--dry-run` restored on the dispatch branch (a cron-equivalent dispatch silently discarded)',
      JSON.stringify(problems),
    )
  }

  // v2 of this defect (#3960, this review): every off-schedule run
  // authoritative, on whatever ref it was dispatched from. The other-ref arm
  // is the one that must catch it — and it is the arm the old token guard
  // did not have.
  {
    const { problems } = checkReporterAuthority(fixture(['extra+=(--skipped-ok)']))
    check(
      problems.some((p) => p.includes('refs/heads/fix/mutants') && p.includes('WRITES for real')),
      'authority guard catches an UNGUARDED write (a dispatch on a feature branch publishing that branch as the repo’s health)',
      JSON.stringify(problems),
    )
  }

  // The ref test must compare the FULL ref. `GITHUB_REF_NAME` is `main` both
  // for the branch and for a tag named `main`, and a tag is a legal dispatch
  // target — so this near-miss shape has to be red, not green.
  {
    const { problems } = checkReporterAuthority(
      fixture([
        'extra+=(--skipped-ok)',
        'if [ "$GITHUB_REF_NAME" != "main" ]; then',
        '  extra+=(--dry-run)',
        'fi',
      ]),
    )
    check(
      problems.some((p) => p.includes('refs/tags/main')),
      'authority guard catches a short-name ref test, which cannot tell the branch `main` from a TAG named `main`',
      JSON.stringify(problems),
    )
  }

  // Prose is inert: the guard executes the block, so bash decides what a `#`
  // means. The old token guard tripped over a trailing comment that merely
  // MENTIONED the flag, and this job documents `--dry-run` at length.
  {
    const { problems } = checkReporterAuthority(
      fixture([
        '# deliberately NOT --dry-run on the cron ref (#3716)',
        'extra+=(--skipped-ok)  # not --dry-run',
        'if [ "$GITHUB_REF" != "refs/heads/main" ] ||',
        '   [ "$FUZZ_SECONDS_INPUT" != "120" ] ||',
        '   [ "$SLO_INCLUDE_PROBLEM_INPUT" != "false" ]; then',
        '  extra+=(--dry-run)',
        'fi',
      ]),
    )
    check(
      problems.length === 0,
      'authority guard is not fooled by comments discussing `--dry-run`, on their own line or trailing (bash already knows what `#` means)',
      JSON.stringify(problems),
    )
  }

  // An input the guard CANNOT compare must fail the guard, not be skipped.
  // Every input does not have to declare a `default:` — a `required: true`
  // string, or a `choice` leaning on `options[0]`, is legal — and such an
  // input changes what the lanes test exactly like the three that do. Reading
  // only the ones with a `default:` made the generality claim above false: an
  // input added without one escaped the gate entirely.
  {
    const { problems } = checkReporterAuthority(
      fixture(REF_AND_INPUTS_GUARDED, { extraInputWithoutDefault: 'target_crate' }),
    )
    check(
      problems.some((p) => p.includes('target_crate') && p.includes('no `default:`')),
      'authority guard catches a dispatch input declared WITHOUT a `default:` (it cannot be compared, so it must not be skipped)',
      JSON.stringify(problems),
    )
  }

  // …and the parse behind that claim must be all-or-loud. A comment or a
  // stray line inside `inputs:` used to end the scan early, and a PARTIAL
  // result was indistinguishable from a complete one — the same fail-open
  // this batch has now fixed three times in two files.
  {
    const withComment = fixture(REF_AND_INPUTS_GUARDED).replace(
      '      slo_include_problem:',
      '# a banner comment at column 0, e.g. a commented-out input above it\n      slo_include_problem:',
    )
    const parsed = findDispatchInputDefaults(withComment)
    check(
      Object.keys(parsed).join(',') === 'fuzz_seconds,slo_include_problem',
      'a column-0 comment inside the `inputs:` block does not truncate the input scan',
      JSON.stringify(parsed),
    )
    // A stray line at the `inputs:` block's own indent DOES end the inner
    // scan — and the second, differently-terminated scan notices that the two
    // disagree and throws instead of returning the half it managed to read.
    let threw = null
    try {
      findDispatchInputDefaults(
        fixture(REF_AND_INPUTS_GUARDED).replace(
          '      slo_include_problem:',
          '    unexpected_key: value\n      slo_include_problem:',
        ),
      )
    } catch (err) {
      threw = err
    }
    check(
      threw !== null && /parsed only/.test(threw.message),
      'a PARTIAL parse of the `inputs:` block throws instead of silently gating on the half it read',
      threw ? threw.message : 'no throw — a partial input list read as the whole list',
    )
  }

  // The bash-3.2 portability rule, on synthetic scripts first.
  {
    const tail = 'node scripts/file-scheduled-failures.mjs "${extra[@]}"'
    check(
      findUnportableEmptyArrayExpansions(['extra=()', tail].join('\n')).join(',') === 'extra',
      'the portability guard catches an EMPTY array declaration expanded plainly (the bash < 4.4 unbound-variable abort)',
      '',
    )
    check(
      findUnportableEmptyArrayExpansions(
        ['extra=()', 'node scripts/x.mjs ${extra[@]+"${extra[@]}"}'].join('\n'),
      ).length === 0,
      'the portability guard accepts the `${a[@]+"${a[@]}"}` guard on an empty array',
      '',
    )
    check(
      findUnportableEmptyArrayExpansions(['extra=(--needs-json-file needs.json)', tail].join('\n'))
        .length === 0,
      'the portability guard accepts a SEEDED array — it is never empty at the point of expansion',
      '',
    )
  }

  // Extraction failures must be loud, not vacuous passes.
  for (const [label, text] of [
    [
      'a renamed step',
      ['    steps:', '      - name: Something else', '        run: |', '          echo hi'].join(
        '\n',
      ),
    ],
    [
      'a step with no block-scalar `run:`',
      ['    steps:', `      - name: ${REPORTER_STEP_NAME}`, '        uses: some/action@abc'].join(
        '\n',
      ),
    ],
  ]) {
    let threw = null
    try {
      findReporterRunScript(text)
    } catch (err) {
      threw = err
    }
    check(threw !== null, `the run-script extractor throws on ${label}`, '')
  }

  // …then the real workflow, both arms named individually so a failure says
  // which direction broke.
  const workflowPath = new URL('../.github/workflows/scheduled-deep-checks.yml', import.meta.url)
    .pathname
  if (!existsSync(workflowPath)) {
    fail('the real workflow file is readable', `not found at ${workflowPath}`)
    return
  }
  const workflowText = readFileSync(workflowPath, 'utf8')
  const scheduled = resolveReporterInvocation(workflowText, {
    eventName: 'schedule',
    ref: CRON_REF,
  }).args
  check(
    !scheduled.includes('--dry-run') && !scheduled.includes('--skipped-ok'),
    'the real workflow: the weekly cron run is authoritative and treats a skipped lane as a failure',
    JSON.stringify(scheduled),
  )
  const onCronRef = resolveReporterInvocation(workflowText, {
    eventName: 'workflow_dispatch',
    ref: CRON_REF,
  }).args
  check(
    !onCronRef.includes('--dry-run') && onCronRef.includes('--skipped-ok'),
    `the real workflow: a dispatch on ${CRON_REF} WRITES — the off-cycle answer is not silently discarded (#3716)`,
    JSON.stringify(onCronRef),
  )
  const onOtherRef = resolveReporterInvocation(workflowText, {
    eventName: 'workflow_dispatch',
    ref: 'refs/heads/fix/mutants',
  }).args
  check(
    onOtherRef.includes('--dry-run'),
    'the real workflow: a dispatch on a NON-default ref dry-runs — one branch’s lanes never become the repo-wide issue’s answer (#3960)',
    JSON.stringify(onOtherRef),
  )
  // The fourth dimension, on the real file, input by input.
  const realDefaults = findDispatchInputDefaults(workflowText)
  for (const [name, declaredDefault] of Object.entries(realDefaults)) {
    const changed = flipDispatchInputDefault(declaredDefault)
    const args = resolveReporterInvocation(workflowText, {
      eventName: 'workflow_dispatch',
      ref: CRON_REF,
      inputs: { [name]: changed },
    }).args
    check(
      args.includes('--dry-run'),
      `the real workflow: a dispatch on ${CRON_REF} with \`${name}=${changed}\` (default \`${declaredDefault}\`) dry-runs — it changed what the lanes TEST, so it is not the cron's answer (#3960)`,
      JSON.stringify(args),
    )
  }
  // …and the portability of the block this guard executes for real. On bash
  // < 4.4 an empty array under `set -u` is an unbound-variable abort, so this
  // is both a real bug in the shipped workflow and the reason the pre-commit
  // hook died on macOS.
  for (const [label, path] of [
    ['the reporter step', workflowPath],
    [
      'the watchdog step',
      new URL('../.github/workflows/workflow-watchdog.yml', import.meta.url).pathname,
    ],
  ]) {
    if (!existsSync(path)) {
      fail(`${label}'s workflow file is readable`, `not found at ${path}`)
      continue
    }
    const stepName =
      path === workflowPath
        ? REPORTER_STEP_NAME
        : 'File, update or close the watchdog tracking issue'
    const offenders = findUnportableEmptyArrayExpansions(
      findReporterRunScript(readFileSync(path, 'utf8'), stepName),
    )
    check(
      offenders.length === 0,
      `${label} never expands a possibly-empty array under \`set -u\` (bash 3.2 / stock macOS /bin/bash aborts on that)`,
      `unportable arrays: ${offenders.join(', ')}`,
    )
  }
  const { problems } = checkReporterAuthority(workflowText)
  check(
    problems.length === 0,
    'the real workflow satisfies every authority rule at once',
    problems.join(' | '),
  )
}

/**
 * #4400 — end to end, chained across simulated weeks, against a stub `gh` on
 * `$PATH` (same technique as `selfTestGhCallSequence`, in its own function
 * for the same cyclomatic-complexity reason). Each `drive()` call feeds the
 * PREVIOUS call's written body back in as `--known-body-file`, exactly as
 * production does via `gh issue list` — so this is the only place any of
 * these assertions could pass because `advanceStreaks` escalates on every
 * run, or because the marker block silently fails to round-trip the counter:
 * either bug would surface here as the wrong `gh` call sequence or the wrong
 * stored count, not as a hand-computed number matching itself.
 *
 * Every run id below is a NUMBER, because that is what production hands this
 * profile: `check-workflow-liveness.mjs` reports `gh run list`'s `databaseId`
 * and the watchdog passes it straight through its `needs` JSON. The first
 * version of this suite used string ids ('run1', 'run2', …), which round-trip
 * through the marker block to themselves and therefore compare equal — 112
 * assertions and two negative controls all passed over a comparison that
 * could never hold in production, where a number is compared against the
 * string the issue body gave back. Fixtures whose TYPES differ from
 * production's are how that happened, so the types are matched here rather
 * than a numeric case being bolted on beside the string ones. The string
 * identity production really does produce — the deep-checks profile's
 * `fallbackRunId`, a run URL — is covered directly in `selfTestStreakTypes`.
 */
function selfTestEscalation({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-failures-escalate-'))
  const log = join(dir, 'gh.log')
  const stub = join(dir, 'gh')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const a = process.argv.slice(2)',
      "const i = a.indexOf('--body-file')",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({`,
      '  sub: a[1],',
      "  body: i === -1 ? '' : fs.readFileSync(a[i + 1], 'utf8'),",
      "}) + '\\n')",
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(stub, 0o755)

  const needsFile = join(dir, 'needs.json')
  const bodyFile = join(dir, 'known-body.md')
  const lane = 'e2e-tauri-weekly.yml'
  // Weekly cadence (periodHours: 168) → escalationThreshold === 3.
  const failing = (runId) => ({ [lane]: { result: 'failure (x)', runId, periodHours: 168 } })

  const drive = (needs, knownBody, knownState) => {
    writeFileSync(needsFile, JSON.stringify(needs), 'utf8')
    writeFileSync(bodyFile, knownBody ?? '', 'utf8')
    writeFileSync(log, '', 'utf8')
    const prevPath = process.env.PATH
    process.env.PATH = `${dir}:${prevPath}`
    let threw = null
    try {
      main([
        '--needs-json-file',
        needsFile,
        '--known-body-file',
        bodyFile,
        '--known-state',
        knownState,
        '--repo',
        'owner/repo',
        '--run-url',
        'https://example/watchdog-run',
        '--profile',
        'workflow-watchdog',
      ])
    } catch (err) {
      threw = err
    } finally {
      process.env.PATH = prevPath
    }
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    if (threw) calls.push({ sub: `THREW(${threw.message})`, body: '' })
    return calls
  }
  const seqOf = (calls) => calls.map((c) => c.sub).join(',')
  const writtenBody = (calls, fallback) =>
    calls.find((c) => c.sub === 'edit' || c.sub === 'create')?.body ?? fallback

  // Week 1 — the FIRST failure. Files the issue; not an escalation.
  let calls = drive(failing(17654321), '', 'OPEN')
  check(seqOf(calls) === 'create', 'week 1 (first failure): files the tracking issue', seqOf(calls))
  let body = writtenBody(calls, '')
  const allText = (cs) => cs.map((c) => c.body).join('\n')
  // The negative controls below match the escalation ANNOUNCEMENT, not the
  // word "escalat". Every issue body now carries a standing paragraph
  // explaining the escalation policy (that is deliberate — the body is the
  // reader's contract for when this thread makes noise), so a bare
  // /escalat/i over the written text is true on run one and proves nothing.
  // These two patterns are `buildEscalationComment`'s own: its lead-in, and
  // the parenthesised per-lane count that only it renders (the body's
  // streaking line says "(N in a row)" instead).
  const announcesEscalation = (t) =>
    /Still red, not new/.test(t) || /consecutive observed failures\)/.test(t)
  check(
    !announcesEscalation(allText(calls)),
    'negative control: the FIRST failure never announces an escalation',
    allText(calls),
  )
  check(
    parseKnownStreaks(body).get(lane)?.count === 1,
    'week 1: the persisted streak count is 1',
    JSON.stringify([...parseKnownStreaks(body)]),
  )

  // A poll that observes NO NEW run (the weekly workflow has not run again —
  // `newestCompletedRunId` still reports `17654321`) must not silently advance
  // the counter. This is requirement #1: an absent/unchanged observation is
  // neither a new failure nor a recovery.
  calls = drive(failing(17654321), body, 'OPEN')
  check(
    calls.length === 0 && parseKnownStreaks(body).get(lane)?.count === 1,
    'a poll that observes no NEW run (same underlying run) neither increments nor resets the counter',
    JSON.stringify(calls),
  )

  // Week 2 — SECOND consecutive observed failure (a genuinely new completed
  // run, `17654322`). Below the N=3 threshold: silently persists the counter
  // (`edit`) but must not comment.
  calls = drive(failing(17654322), body, 'OPEN')
  check(
    seqOf(calls) === 'edit',
    'week 2 (second consecutive failure): silently syncs the counter, no comment',
    seqOf(calls),
  )
  body = writtenBody(calls, body)
  check(
    parseKnownStreaks(body).get(lane)?.count === 2,
    'week 2: the persisted streak count advances to 2',
    JSON.stringify([...parseKnownStreaks(body)]),
  )
  check(
    !announcesEscalation(allText(calls)),
    'negative control: the SECOND consecutive failure does not escalate either',
    allText(calls),
  )

  // Week 3 — THIRD consecutive observed failure (`17654323`). This is the one
  // that must produce the one extra comment.
  calls = drive(failing(17654323), body, 'OPEN')
  check(
    seqOf(calls) === 'edit,comment',
    'week 3 (Nth=3rd consecutive failure): escalates — edit AND comment',
    seqOf(calls),
  )
  const escalationComment = calls.find((c) => c.sub === 'comment')?.body ?? ''
  check(
    /escalat/i.test(escalationComment) && /3 consecutive observed failures/.test(escalationComment),
    'the escalation comment says how many consecutive observed failures',
    escalationComment,
  )
  body = writtenBody(calls, body)
  check(
    parseKnownStreaks(body).get(lane)?.count === 3,
    'week 3: the persisted streak count reaches 3',
    JSON.stringify([...parseKnownStreaks(body)]),
  )

  // A re-run that observes the SAME run that just triggered the escalation
  // (`17654323` again) must not double-escalate.
  calls = drive(failing(17654323), body, 'OPEN')
  check(
    calls.length === 0,
    'a re-run observing the SAME run right after escalation issues no `gh` write at all (no double-escalate)',
    JSON.stringify(calls),
  )

  // Week 4 — a FOURTH genuinely new run (`17654324`). Escalation is a single
  // bounded event, not a recurring alarm: once said, this lane goes back to
  // being silently tracked, exactly like a still-failing lane pre-#4400.
  calls = drive(failing(17654324), body, 'OPEN')
  check(
    calls.length === 0,
    'week 4: a lane past its threshold stays silent on a further new run (no re-escalation)',
    JSON.stringify(calls),
  )

  // The watched workflow having NO completed run to point at at all
  // (`runId: null` — `never-ran`/`stale`/`no-completed-run`) must behave
  // exactly like the "no new run" case above, including across repeats —
  // the other half of requirement #1, and the specific case
  // `newestCompletedRunId` was built to report honestly rather than fall
  // back to "assume it is the same as last time" or "assume it is new".
  {
    const neverRan = { [lane]: { result: 'never-ran (…)', runId: null, periodHours: 168 } }
    const created = drive(neverRan, '', 'OPEN')
    const b = writtenBody(created, '')
    check(
      parseKnownStreaks(b).get(lane)?.count === 1,
      'a lane with no completed run to point at (`runId: null`) still notifies once, at count 1',
      JSON.stringify([...parseKnownStreaks(b)]),
    )
    const repeat = drive(neverRan, b, 'OPEN')
    check(
      repeat.length === 0 && parseKnownStreaks(b).get(lane)?.count === 1,
      'repeated `runId: null` observations never advance the counter, even though the poll keeps happening',
      JSON.stringify(repeat),
    )
  }

  // MIGRATION — the one path production takes exactly once, on the first poll
  // after this ships. Split out for the same cyclomatic-complexity reason as
  // `selfTestSkippedCarryOverGhCalls` above, and handed this function's own
  // stub-`gh` driver so it exercises the identical end-to-end path rather
  // than a second, subtly different harness.
  selfTestMigration({
    check,
    drive,
    seqOf,
    writtenBody,
    allText,
    announcesEscalation,
    lane,
    failing,
  })

  // A full recovery clears the tracked streak state, not just the tracked
  // lane set — and a LATER relapse starts the counter over at 1, never
  // continuing from wherever it left off before recovering.
  {
    const closeCalls = drive({ [lane]: { result: 'success' } }, body, 'OPEN')
    check(
      seqOf(closeCalls) === 'edit,comment,close',
      'a full recovery closes the issue (edit, comment, close)',
      seqOf(closeCalls),
    )
    const closedBody = writtenBody(closeCalls, body)
    check(
      parseKnownStreaks(closedBody).size === 0,
      'a full recovery clears the persisted streak state entirely',
      JSON.stringify([...parseKnownStreaks(closedBody)]),
    )
    const relapseCalls = drive(failing(17999001), closedBody, 'CLOSED')
    check(
      seqOf(relapseCalls) === 'reopen,edit,comment',
      'a relapse after full recovery reopens, updates and comments like any first failure',
      seqOf(relapseCalls),
    )
    const relapseBody = writtenBody(relapseCalls, closedBody)
    check(
      parseKnownStreaks(relapseBody).get(lane)?.count === 1,
      'a relapse after full recovery restarts the counter at 1, not at 4',
      JSON.stringify([...parseKnownStreaks(relapseBody)]),
    )
  }

  // A daily-cadence lane (no `periodHours`, e.g. `branch-protection-assert`,
  // or any deep-checks lane) keeps EXACTLY pre-#4400 behaviour: threshold is
  // 1, so it notifies once on the very first failure and then holds silent
  // on every subsequent still-failing run — this is the "1 keeps today's
  // behaviour for daily ones" half of `escalationThreshold`.
  {
    const dailyLane = 'branch-protection-assert.yml'
    const dailyFailing = (runId) => ({ [dailyLane]: { result: 'failure (x)', runId } })
    const created = drive(dailyFailing(20000001), '', 'OPEN')
    check(
      seqOf(created) === 'create',
      'a daily lane’s first failure files the issue',
      seqOf(created),
    )
    const b1 = writtenBody(created, '')
    check(
      parseKnownStreaks(b1).get(dailyLane)?.count === 1,
      'a daily lane reaches its threshold (1) on the very first failure',
      JSON.stringify([...parseKnownStreaks(b1)]),
    )
    const nextDay = drive(dailyFailing(20000002), b1, 'OPEN')
    check(
      nextDay.length === 0,
      'a daily lane observing a genuinely NEW run the next day still issues no further `gh` write — it already hit its N=1 threshold',
      JSON.stringify(nextDay),
    )
  }

  // An escalation that loses the race to a NEWLY-failing lane in the same run
  // is DEFERRED, not discarded (see `rollBackSuppressedEscalations`). The
  // failure this pins is silent and permanent: persist the crossing advance
  // while the comment names only the new lane, and `advanceStreaks` skips the
  // crossed lane forever after (`prior.count >= threshold`), so its one
  // follow-up comment is never emitted at all.
  {
    const other = 'codeql.yml'
    const both = (runIdA, runIdB) => ({
      [lane]: { result: 'failure (x)', runId: runIdA, periodHours: 168 },
      [other]: { result: 'failure (x)', runId: runIdB, periodHours: 168 },
    })
    let b = writtenBody(drive(failing(31000001), '', 'OPEN'), '')
    b = writtenBody(drive(failing(31000002), b, 'OPEN'), b)
    check(
      parseKnownStreaks(b).get(lane)?.count === 2,
      'deferral setup: the weekly lane is one observed run below its threshold',
      JSON.stringify([...parseKnownStreaks(b)]),
    )
    // The crossing run — and, in the same run, a brand-new failing lane.
    const collided = drive(both(31000003, 31000003), b, 'OPEN')
    check(
      seqOf(collided) === 'edit,comment',
      'a crossing that collides with a new lane still writes the new lane’s notification',
      seqOf(collided),
    )
    const collidedComment = collided.find((c) => c.sub === 'comment')?.body ?? ''
    check(
      collidedComment.includes(other) && !/escalat/i.test(collidedComment),
      'negative control: that comment is the NEW-lane notification, not an escalation',
      collidedComment,
    )
    const collidedBody = writtenBody(collided, b)
    check(
      parseKnownStreaks(collidedBody).get(lane)?.count === 2,
      'the suppressed crossing is ROLLED BACK, not persisted at the threshold (else it can never be said)',
      JSON.stringify([...parseKnownStreaks(collidedBody)]),
    )
    // Next run: same two runs observed, nothing newly failing — the deferred
    // escalation now gets its comment.
    const nextRun = drive(both(31000003, 31000003), collidedBody, 'OPEN')
    check(
      seqOf(nextRun) === 'edit,comment',
      'the deferred escalation fires on the very next run, once no new lane outranks it',
      seqOf(nextRun),
    )
    const deferredComment = nextRun.find((c) => c.sub === 'comment')?.body ?? ''
    check(
      /escalat/i.test(deferredComment) &&
        deferredComment.includes(lane) &&
        /3 consecutive observed failures/.test(deferredComment),
      'the deferred escalation names the right lane at the right count',
      deferredComment,
    )
  }
}

/**
 * #4400 — the MIGRATION poll: a rolling issue whose marker block was written
 * by the pre-#4400 code, i.e. BARE job ids with no `|count|runId`.
 *
 * Driven through `selfTestEscalation`'s stub-`gh` harness (passed in, same
 * shape as `selfTestSkippedCarryOverGhCalls`) rather than against a
 * hand-built prior, because half of what is under test is that the fixture is
 * genuinely old-format — a prior built by hand would be whatever shape the
 * test author believed `parseKnownStreaks` returns.
 */
function selfTestMigration({
  check,
  drive,
  seqOf,
  writtenBody,
  allText,
  announcesEscalation,
  lane,
  failing,
}) {
  // MIGRATION — a body written by the pre-#4400 code, whose marker line is a
  // BARE job id with no `|count|runId`. This is the one path production takes
  // exactly once, on the first poll after this PR merges, and it is the path
  // that is easiest to get wrong in the direction nobody notices: the lane's
  // already-reported run id differs from the migrated prior's `null`, so a
  // naive compare advances the counter to 2 with no new run having happened
  // and a #3388-shaped lane escalates a week early. Pinned end to end,
  // through the real bare-format body rather than a hand-built prior, because
  // the fixture being genuinely old-format is half of what is under test.
  const bare = buildIssueBody({ all: [lane], lanes: [], runUrl: '' })
  check(
    !bare.includes(`${lane}|`) && parseKnownStreaks(bare).get(lane)?.migrated === true,
    'migration fixture: the pre-#4400 body really is a BARE marker line, read back as migrated',
    JSON.stringify([...parseKnownStreaks(bare)]),
  )
  // Poll 1 after the merge: the lane is red on the same run the old format
  // already counted. Adopt that identity, HOLD the count.
  const first = drive(failing(41000001), bare, 'OPEN')
  check(
    seqOf(first) === 'edit',
    'the first post-migration poll syncs the adopted run id into the body, and does not comment',
    seqOf(first),
  )
  check(
    !announcesEscalation(allText(first)),
    'negative control: the migration poll does not escalate (this is where the over-count would show)',
    allText(first),
  )
  let migrated = writtenBody(first, bare)
  const after = parseKnownStreaks(migrated).get(lane)
  check(
    after?.count === 1 && after?.runId === '41000001' && after?.migrated === undefined,
    'migration HOLDS at count 1, adopts the observed run id, and stops being migrated',
    JSON.stringify(after),
  )
  // …and the adoption really is persisted: a repeat poll of the same run is
  // now an ordinary no-op rather than a second adoption, which is what
  // proves the counter is not stalled at 1 forever.
  const sameRunAgain = drive(failing(41000001), migrated, 'OPEN')
  check(
    sameRunAgain.length === 0,
    'a repeat poll after the migration adoption writes nothing at all (the adoption stuck)',
    seqOf(sameRunAgain),
  )
  // The genuinely NEXT distinct run is the one that advances to 2 — the
  // guarantee `advanceStreaks`' doc states.
  const second = drive(failing(41000002), migrated, 'OPEN')
  check(
    seqOf(second) === 'edit' && !announcesEscalation(allText(second)),
    'the first DISTINCT run after migration advances the migrated lane without escalating it',
    `${seqOf(second)} :: ${allText(second)}`,
  )
  migrated = writtenBody(second, migrated)
  check(
    parseKnownStreaks(migrated).get(lane)?.count === 2,
    'that distinct run takes the migrated lane to 2, not 3',
    JSON.stringify([...parseKnownStreaks(migrated)]),
  )
  // So a migrated lane escalates on its THIRD distinct observed run, not
  // its second: three real weeks after the migration poll, exactly like a
  // lane that had been tracked under the new format all along.
  const third = drive(failing(41000003), migrated, 'OPEN')
  const thirdComment = third.find((c) => c.sub === 'comment')?.body ?? ''
  check(
    seqOf(third) === 'edit,comment' && /3 consecutive observed failures/.test(thirdComment),
    'a migrated lane escalates on its third DISTINCT observed run — no earlier',
    `${seqOf(third)} :: ${thirdComment}`,
  )
}

/**
 * #4400 — the run-identity comparison, pinned directly at the TYPES it faces
 * in production rather than only through the end-to-end chain above.
 *
 * The defect this exists for: `runId` reaches `advanceStreaks` as a NUMBER
 * (the watchdog's `databaseId`) but `prior.runId` always comes back from
 * `parseKnownStreaks` as a STRING, because the marker block is text. An
 * uncoerced `===` is therefore never equal, every daily poll looks like a new
 * run, and a WEEKLY lane escalates in three DAYS. These assertions feed
 * `advanceStreaks` a `known` map built by `parseKnownStreaks` from a body
 * rendered by `buildIssueBody`, so the round trip is the real one — a fixture
 * that hand-built `{ count, runId }` with a number in it would compare
 * number-to-number and prove nothing.
 */
function selfTestStreakTypes({ check }) {
  const lane = 'e2e-tauri-weekly.yml'
  const priorFrom = (count, runId) =>
    parseKnownStreaks(
      buildIssueBody({
        all: [lane],
        lanes: [],
        runUrl: '',
        streaks: new Map([[lane, { count, runId }]]),
      }),
    )
  const advance = (known, runId) =>
    advanceStreaks({
      currentFailing: [lane],
      laneById: new Map([[lane, { job: lane, runId, periodHours: 168 }]]),
      known,
      fallbackRunId: 'https://example/watchdog-run',
    })

  const known = priorFrom(2, 17654321)
  check(
    typeof known.get(lane).runId === 'string',
    'the marker block hands the run id back as a STRING, whatever type went in',
    `${typeof known.get(lane).runId}`,
  )
  const same = advance(known, 17654321)
  check(
    same.advanced.length === 0 && same.escalated.length === 0 && same.streaks.get(lane).count === 2,
    'a NUMERIC run id equal to the persisted STRING one holds the counter (the number-vs-string round trip)',
    JSON.stringify([...same.streaks]),
  )
  const next = advance(known, 17654322)
  check(
    next.advanced.length === 1 && next.escalated.length === 1,
    'a genuinely different numeric run id still advances and crosses',
    JSON.stringify([...next.streaks]),
  )
  // The `null` check must stay AHEAD of the coercion: `String(null)` is
  // `'null'`, which equals no real persisted id, so folding the two together
  // would send an UNKNOWABLE identity down the advance branch and tick the
  // counter once per daily poll on a workflow that has never run.
  const unknowable = advance(known, null)
  check(
    unknowable.advanced.length === 0 && unknowable.streaks.get(lane).count === 2,
    '`runId: null` still HOLDS after the coercion (the null check is not folded into it)',
    JSON.stringify([...unknowable.streaks]),
  )
  const wasNull = advance(priorFrom(2, null), null)
  check(
    wasNull.advanced.length === 0 && wasNull.streaks.get(lane).count === 2,
    'a null id against a null-persisted prior holds too, rather than comparing `"null"` to `""`',
    JSON.stringify([...wasNull.streaks]),
  )
  // The other identity production really produces: the deep-checks profile
  // supplies no per-lane `runId` at all, so `fallbackRunId` — this run's URL,
  // a STRING — is what round-trips. Same guard, other type.
  const urlKnown = priorFrom(2, 'https://example/watchdog-run')
  const urlSame = advanceStreaks({
    currentFailing: [lane],
    laneById: new Map([[lane, { job: lane, periodHours: 168 }]]),
    known: urlKnown,
    fallbackRunId: 'https://example/watchdog-run',
  })
  check(
    urlSame.advanced.length === 0 && urlSame.streaks.get(lane).count === 2,
    'the string `fallbackRunId` identity (deep-checks) holds against its own persisted form',
    JSON.stringify([...urlSame.streaks]),
  )
}

function selfTestBodySize({ check, lanesOf }) {
  // 7. The body stays small. There is no unbounded list here (one line per
  //    job), so a body that grows past this bound means someone started
  //    embedding logs — which is how the sibling filers hit GitHub's 65536
  //    422 and wedged their weekly job red (#3257).
  //
  //    #4400 — measured against the SHIPPED shapes, `streaks` and all. Passing
  //    no `streaks` renders the pre-#4400 bare-job-id block, so the bound
  //    would be a bound on a body this script does not write any more: the
  //    marker line now carries `|count|runId`, and a count above 1 also puts
  //    the lane in the `streaking` prose enumeration above the block — a
  //    SECOND O(lanes) growth. A guard that measures a format other than the
  //    one that runs reports a property of the wrong thing, which is the
  //    defect class this file's review history is made of.
  //
  //    The two growths are pinned as the two shapes that actually ship, not
  //    summed into one fixture, because no profile produces both at once:
  //      - deep-checks supplies no per-lane `runId`, so every line carries
  //        `fallbackRunId` (a full run URL — the longest identity rendered
  //        here), while its lanes carry no `periodHours`, so
  //        `escalationThreshold` is 1, counts never leave 1, and the
  //        `streaking` line never appears;
  //      - the watchdog is the profile whose counts leave 1, and it always
  //        supplies its own `runId` — `gh`'s numeric `databaseId`, or null.
  //    Summed, 40 lanes render 9076 chars, over this cap: if a profile ever
  //    starts producing BOTH (a deep-checks lane gaining a `periodHours`
  //    decoration is all it would take), this cap is what has to move, and
  //    this comment is the measurement to move it against. Nothing shipping
  //    today is close — 40 lanes is already ~3.6x the largest real profile
  //    (11 deep-checks jobs, 6 watched workflows).
  //
  //    Measured at 40 lanes: 7134 (deep-checks shape) and 7356 (watchdog
  //    shape) against the 8000 cap; the pre-#4400 bare block this used to
  //    measure was 4854, i.e. the old guard bounded a body ~2.5k smaller than
  //    the one that ships. The thing near the cap is the FIXTURE, not any
  //    real profile, so if a future paragraph of body prose tips this red,
  //    shrink the fixture back toward the real lane counts rather than
  //    raising the cap: the cap is a tripwire for someone embedding logs
  //    here, not a capacity budget, and raising it is permanent.
  const many = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`some-rather-long-lane-name-${i}`, 'failure']),
  )
  const lanes = lanesOf(many)
  const all = failingJobs(lanes)
  // Deep-checks shape: a full run URL on every marker line, count 1.
  const runUrl = 'https://github.com/owner/repo/actions/runs/17654321012'
  const urlBody = buildIssueBody({
    all,
    lanes,
    runUrl: 'https://example/run',
    streaks: new Map(all.map((j) => [j, { count: 1, runId: runUrl }])),
  })
  check(
    urlBody.length <= MAX_BODY_CHARS && urlBody.includes(`|1|${runUrl}`),
    'an all-lanes-red body in the deep-checks shipped format (full run URL per line) stays under the issue-body limit',
    `len=${urlBody.length} cap=${MAX_BODY_CHARS} hasUrlLine=${urlBody.includes(`|1|${runUrl}`)}`,
  )
  // Watchdog shape: numeric run ids, counts above 1, so every lane also
  // lands in the `streaking` enumeration.
  const streakBody = buildIssueBody({
    all,
    lanes,
    runUrl: 'https://example/run',
    streaks: new Map(all.map((j, i) => [j, { count: 3, runId: 17654321012 + i }])),
  })
  check(
    streakBody.length <= MAX_BODY_CHARS &&
      streakBody.includes('|3|17654321012') &&
      streakBody.includes('(3 in a row)'),
    'an all-lanes-red body in the watchdog shipped format (counts plus the streaking enumeration) stays under the issue-body limit',
    `len=${streakBody.length} cap=${MAX_BODY_CHARS} hasMarker=${streakBody.includes('|3|17654321012')} hasStreaking=${streakBody.includes('(3 in a row)')}`,
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

  const lanesOf = (map) => Object.entries(map).map(([job, result]) => ({ job, result }))

  // 1. An absent `needs` payload is a hard error, never "zero lanes failed".
  //    This is the reporter's own false-green, and it would CLOSE the issue.
  for (const [label, input] of [
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   \n '],
    ['not JSON', '{oops'],
    ['a JSON array', '[]'],
    ['an empty object', '{}'],
  ]) {
    let threw = null
    try {
      parseNeeds(input)
    } catch (err) {
      threw = err
    }
    check(threw !== null, `parseNeeds rejects ${label}`, 'no throw — would report zero failures')
  }

  // …and a well-formed payload parses.
  {
    const lanes = parseNeeds('{"b":{"result":"failure"},"a":{"result":"success"}}')
    check(
      lanes.length === 2 && lanes[0].job === 'a' && lanes[1].result === 'failure',
      'parseNeeds reads job results, sorted by job id',
      JSON.stringify(lanes),
    )
  }

  // A job whose `result` is missing is reported as `unknown`, not assumed
  // green — same reason as the throws above, one level down.
  {
    const lanes = parseNeeds('{"a":{"outputs":{}}}')
    check(
      lanes[0].result === 'unknown' && isFailing('unknown'),
      'a job with no `result` counts as failing, not green',
      JSON.stringify(lanes),
    )
  }

  // 2. Classification. `cancelled` and `skipped` are NOT successes: a lane
  //    that never ran did not do its job, which is the #3359 failure mode.
  check(!isFailing('success'), 'success is not a failure', '')
  check(isFailing('failure'), 'failure is a failure', '')
  check(isFailing('cancelled'), 'cancelled is a failure', '')
  check(isFailing('skipped'), 'skipped is a failure on the schedule event', '')
  check(
    !isFailing('skipped', { skippedOk: true }),
    '--skipped-ok stops `skipped` reading as a lane FAILURE (the off-schedule shape, where the schedule-only filer really is skipped)',
    '',
  )

  // 2b. #3960 — the other half of that same fact. `--skipped-ok` is a
  //     statement about what the run could OBSERVE, so it must suppress the
  //     recovery reading exactly as it suppresses the failure reading. When
  //     only the failure half existed, a dispatch closed the tracking issue
  //     because a lane it never executed was "no longer in `current`".
  selfTestSkippedCarryOver({ check, lanesOf })

  // 3. Dedup keys on the job id, so a lane that stays broken but changes
  //    HOW it breaks (failure -> cancelled) does not re-notify as new.
  {
    const known = new Set(['mutants'])
    const week1 = failingJobs(lanesOf({ mutants: 'failure', fuzz: 'success' }))
    const week2 = failingJobs(lanesOf({ mutants: 'cancelled', fuzz: 'success' }))
    const d1 = diffLanes(week1, known)
    const d2 = diffLanes(week2, known)
    check(
      d1.newOnes.length === 0 && d2.newOnes.length === 0,
      'a still-broken lane does not re-notify when its result kind changes',
      `${JSON.stringify(d1.newOnes)} / ${JSON.stringify(d2.newOnes)}`,
    )
  }

  // 4. The state machine, which is the whole design.
  {
    const cases = [
      // [name, current, knownSet, existingIssue, expected]
      ['first failure files', ['mutants'], [], null, 'create'],
      [
        'a newly-failing lane notifies',
        ['mutants', 'fuzz'],
        ['mutants'],
        { number: 1, state: 'OPEN' },
        'notify',
      ],
      [
        'an unchanged failure is a no-op (no weekly spam)',
        ['mutants'],
        ['mutants'],
        { number: 1, state: 'OPEN' },
        'noop',
      ],
      [
        'a partial recovery syncs the body without commenting',
        ['mutants'],
        ['mutants', 'fuzz'],
        { number: 1, state: 'OPEN' },
        'sync',
      ],
      [
        'full recovery closes the rolling issue',
        [],
        ['mutants'],
        { number: 1, state: 'OPEN' },
        'close',
      ],
      ['green with no issue is a no-op', [], [], null, 'noop'],
      [
        'green with an already-closed issue is a no-op',
        [],
        ['mutants'],
        { number: 1, state: 'CLOSED' },
        'noop',
      ],
      [
        'a new failure reopens a closed issue',
        ['mutants'],
        [],
        { number: 1, state: 'CLOSED' },
        'notify',
      ],
    ]
    for (const [name, current, knownArr, existingIssue, expected] of cases) {
      const { newOnes, resolvedOnes, all } = diffLanes(current, new Set(knownArr))
      const action = decideAction({ newOnes, resolvedOnes, all, existingIssue })
      check(action === expected, `state machine: ${name}`, `got "${action}", want "${expected}"`)
    }
  }

  // 5. Marker-block round-trip: the body's tracked set must survive being
  //    re-read next week, or every lane re-notifies forever.
  {
    const all = ['bench-slo', 'fuzz', 'mutants']
    const body = buildIssueBody({
      all,
      lanes: lanesOf({ 'bench-slo': 'failure', fuzz: 'cancelled', mutants: 'failure' }),
      runUrl: 'https://example/run',
    })
    const reparsed = parseKnownLanes(body)
    check(
      reparsed.size === 3 && all.every((j) => reparsed.has(j)),
      'issue body round-trips through parseKnownLanes',
      `size=${reparsed.size}`,
    )
    // The status table renders results OUTSIDE the block, so it can never
    // leak a result string into the tracked set.
    check(
      !reparsed.has('| `fuzz` | ⚠️ cancelled |') && body.includes('⚠️ cancelled'),
      'the status table sits outside the marker block',
      [...reparsed].join(','),
    )
  }

  // 6. A green lane must never end up inside the marker block — that would
  //    keep a recovered lane "failing" forever and block the close path.
  {
    const lanes = lanesOf({ mutants: 'failure', fuzz: 'success' })
    const body = buildIssueBody({ all: failingJobs(lanes), lanes, runUrl: undefined })
    const reparsed = parseKnownLanes(body)
    check(
      reparsed.has('mutants') && !reparsed.has('fuzz'),
      'a passing lane is listed in the table but not in the tracked set',
      [...reparsed].join(','),
    )
  }

  // 7. The body-size bound, split into its own function to keep this one
  //    under the repo's cyclomatic-complexity budget (same reason
  //    `selfTestGhCallSequence` was split out).
  selfTestBodySize({ check, lanesOf })

  // 7b. The body's standing prose is a CONTRACT with the reader, and it sits
  //     in the very issue the escalation comments on. Pinned because it has
  //     already drifted once: before #4400 the paragraph truthfully said a
  //     still-red lane is never re-commented, the escalation feature made that
  //     false for weekly lanes, and nothing failed — prose is the one part of
  //     this body no other assertion reads.
  {
    const lanes = lanesOf({ mutants: 'failure' })
    const body = buildIssueBody({ all: failingJobs(lanes), lanes, runUrl: undefined })
    check(
      /Nth consecutive OBSERVED run/.test(body) &&
        !/only a newly-failing .* produces a comment/.test(body),
      'the body prose describes escalation, and no longer claims a still-red lane is never re-commented',
      body.slice(0, 800),
    )
  }

  // 8. The comment names the newly-failing lanes (it is the notification).
  {
    const lanes = lanesOf({ mutants: 'failure', fuzz: 'success' })
    const comment = buildFailureComment({
      newOnes: ['mutants'],
      lanes,
      runUrl: 'https://example/run',
    })
    check(
      comment.includes('`mutants`') && comment.includes('https://example/run'),
      'the failure comment names the lane and links the run',
      comment,
    )
  }
  {
    const comment = buildRecoveryComment({
      resolvedOnes: ['mutants'],
      runUrl: 'https://example/run',
    })
    check(
      comment.includes('`mutants`') && /green again/.test(comment),
      'the recovery comment names what recovered',
      comment,
    )
  }

  // 8b. Closing must CLEAR the tracked set. If the body still listed the
  //     recovered lane, the same lane failing again next week would diff to
  //     zero new lanes — a no-op against a CLOSED issue, i.e. total silence,
  //     which is the exact bug class this job exists to remove.
  {
    const lanes = lanesOf({ mutants: 'success', fuzz: 'success' })
    const closedBody = buildIssueBody({ all: [], lanes, runUrl: 'https://example/run' })
    const knownAfterClose = parseKnownLanes(closedBody)
    const relapse = diffLanes(['mutants'], knownAfterClose)
    const action = decideAction({ ...relapse, existingIssue: { number: 1, state: 'CLOSED' } })
    check(
      knownAfterClose.size === 0 && action === 'notify',
      'the body written on close clears the tracked set, so a relapse reopens',
      `known=${knownAfterClose.size} action=${action}`,
    )
  }

  // 9. Wiring: the reporting job must depend on EVERY other job in the
  //    workflow, or the lane it forgot goes red into the void again.
  {
    // Synthetic fixtures first, so this assertion is demonstrably able to
    // fail rather than just agreeing with whatever the real file says.
    const fixture = (needsList) =>
      [
        'jobs:',
        '  alpha:',
        '    runs-on: ubuntu-24.04',
        '  beta:',
        '    runs-on: ubuntu-24.04',
        '  report-scheduled-failures:',
        '    needs:',
        ...needsList.map((n) => `      - ${n}`),
        '    if: always()',
      ].join('\n')
    check(
      findUncoveredLanes(fixture(['alpha', 'beta'])).length === 0,
      'wiring guard passes when every lane is in `needs`',
      JSON.stringify(findUncoveredLanes(fixture(['alpha', 'beta']))),
    )
    const missed = findUncoveredLanes(fixture(['alpha']))
    check(
      missed.length === 1 && missed[0] === 'beta',
      'wiring guard catches a lane missing from `needs`',
      JSON.stringify(missed),
    )

    // …then the real workflow.
    const workflowPath = new URL('../.github/workflows/scheduled-deep-checks.yml', import.meta.url)
      .pathname
    if (existsSync(workflowPath)) {
      const uncovered = findUncoveredLanes(readFileSync(workflowPath, 'utf8'))
      check(
        uncovered.length === 0,
        'every scheduled-deep-checks lane is in the reporter’s `needs`',
        `not covered: ${uncovered.join(', ')}`,
      )
    } else {
      fail('the real workflow file is readable', `not found at ${workflowPath}`)
    }
  }

  // 10. What `main()` actually WRITES, end to end against a stub `gh`.
  //     Fixtures live in `selfTestGhCallSequence` above.
  selfTestGhCallSequence({ check })

  // 11. Profiles (#3374). The watchdog reuses this whole pipeline, so the one
  //     thing that must never drift is the pair of tracking-issue TITLES: the
  //     find-or-file logic matches on the title verbatim, so two profiles
  //     sharing one would make the watchdog rewrite the deep-checks issue's
  //     marker block — silently un-tracking every red lane.
  {
    const titles = Object.values(PROFILES).map((p) => p.title)
    check(
      new Set(titles).size === titles.length && titles.length >= 2,
      'every profile has a DISTINCT tracking-issue title (they cannot hijack each other)',
      titles.join(' | '),
    )
    check(
      Object.values(PROFILES).every(
        (p) => p.title && p.unit && p.units && p.what && p.why && p.headline && p.recovery,
      ),
      'every profile fills in every rendered field (no `undefined` in an issue body)',
      JSON.stringify(Object.keys(PROFILES)),
    )
    let threw = null
    try {
      resolveProfile('no-such-profile')
    } catch (err) {
      threw = err
    }
    check(
      threw !== null,
      'an unknown --profile throws instead of silently defaulting to deep-checks',
      'no throw — the watchdog would file into the deep-checks issue on a typo',
    )

    // The watchdog's "lane" ids are workflow FILENAMES, and its results are
    // free-form strings (`stale (…)`, `failure (…)`). Both must survive the
    // marker-block round trip, or every watched workflow re-notifies forever.
    const watchdog = resolveProfile('workflow-watchdog')
    const lanes = [
      {
        job: 'branch-protection-assert.yml',
        result: 'stale (newest scheduled run started 2.3d ago; window is 40h)',
      },
      { job: 'codeql.yml', result: 'success' },
    ]
    const body = buildIssueBody({
      all: failingJobs(lanes),
      lanes,
      runUrl: 'https://example/run',
      profile: watchdog,
    })
    const reparsed = parseKnownLanes(body)
    check(
      reparsed.size === 1 &&
        reparsed.has('branch-protection-assert.yml') &&
        body.includes('window is 40h') &&
        !body.includes('undefined'),
      'a watchdog body tracks the workflow filename and renders the free-form result',
      `${[...reparsed].join(',')}`,
    )
    check(
      buildFailureComment({
        newOnes: ['branch-protection-assert.yml'],
        lanes,
        runUrl: 'https://example/run',
        profile: watchdog,
      }).includes('scheduled workflow newly failing'),
      'the watchdog failure comment names WHAT kind of thing failed',
      buildFailureComment({ newOnes: ['x'], lanes: [], profile: watchdog }),
    )
  }

  // 12. #3716 + #3960 — WHICH runs of the reporting job are authoritative.
  //     Both arms, because this defect has now shipped twice with one arm
  //     pinned and the other open: v2 kept a dispatch from being discarded
  //     and said nothing about the ref it ran on. Driven by executing the
  //     step's own bash (`resolveReporterInvocation`), so what is asserted is
  //     the argv the runner would really produce, not a token search.
  selfTestReporterAuthority({ check, fail })

  // 13. #3960 — the wiring half of the watchdog decision. The last-resort
  //     bash notice is the ONLY thing that reports a crash of this script,
  //     and it must fire on every event now that a dispatch writes for real:
  //     a crash between `gh issue edit` and `gh issue close` leaves the
  //     tracking issue half-rewritten, and an event gate would keep that
  //     quiet. This is the same class of stale justification that produced
  //     the `--skipped-ok` bug, so it gets a guard rather than a comment.
  selfTestLastResortNoticeCondition({ check, fail })

  // 14. #4400 — a weekly lane that stays red must escalate on the Nth
  //     consecutive OBSERVED failure, exactly once, without the watchdog's
  //     daily poll cadence ever being mistaken for the watched workflow's
  //     own (weekly) one. See `selfTestEscalation` for the full chained
  //     end-to-end sequence.
  selfTestEscalation({ check })

  // 15. #4400 — and the same guard at the TYPE boundary the end-to-end chain
  //     can only exercise implicitly: a numeric `databaseId` compared against
  //     the string the marker block gives back.
  selfTestStreakTypes({ check })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
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
  if (process.argv.slice(2).includes('--self-test')) {
    // Wrapped exactly like `main()` below. Several assertions now execute a
    // workflow's own bash and parse a workflow's own YAML, so a renamed step
    // — or a shell that cannot run the block at all — throws mid-suite. An
    // uncaught throw exits 1 with a raw stack trace, which reads as "the tool
    // is broken" rather than "an assertion did not hold"; exit 2 with one
    // legible line is what the hook and its reader expect.
    try {
      runSelfTest()
    } catch (err) {
      console.error(`  FAIL - the self-test could not run to completion: ${err.message}`)
      console.error('\nself-test: aborted before every assertion was evaluated')
      process.exit(2)
    }
  } else {
    try {
      main()
    } catch (err) {
      console.error(`file-scheduled-failures: ${err.message}`)
      process.exit(1)
    }
  }
}
