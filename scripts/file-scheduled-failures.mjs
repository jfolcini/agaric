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
//   * silently syncs the body when a lane recovers but others are still red,
//   * CLOSES the issue when every lane is green again,
//   * does nothing at all when nothing changed.
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
    const result = parsed[job]?.result
    // An unknown/absent `result` is reported as such rather than assumed
    // green: same reason as the empty-payload throw above, one job down.
    return { job, result: typeof result === 'string' && result ? result : 'unknown' }
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

/** Extracts the tracked job ids from a tracking-issue body (or `''`/undefined). */
export function parseKnownLanes(body) {
  if (!body) return new Set()
  const start = body.indexOf(MARKER_START)
  const end = body.indexOf(MARKER_END)
  if (start === -1 || end === -1 || end < start) return new Set()
  const block = body.slice(start + MARKER_START.length, end)
  return new Set(
    block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== '```'),
  )
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
 * The rolling issue's open/close state machine. Split out as a pure function
 * precisely because it is the part with real branches worth pinning:
 *
 *   'create' — first failure ever; no issue exists yet.
 *   'notify' — a lane is NEWLY failing: reopen if closed, rewrite body, and
 *              COMMENT (the comment is the notification channel; body edits
 *              are state and notify nobody).
 *   'sync'   — some lane recovered, others are still red: rewrite the body so
 *              it stops naming a lane that is green, but do not comment. A
 *              partial recovery is not news.
 *   'close'  — everything is green again and the issue tracked something.
 *              A permanently-open "the workflow is red" issue is a lie that
 *              trains people to ignore it, which is the whole failure mode
 *              #3359 is about.
 *   'noop'   — nothing changed (the same lanes are still red), or everything
 *              is green and there is nothing open. A weekly job that re-fires
 *              on an unchanged failure must not spam.
 */
export function decideAction({ newOnes, resolvedOnes, all, existingIssue }) {
  if (all.length === 0) {
    if (existingIssue && existingIssue.state === 'OPEN' && resolvedOnes.length > 0) return 'close'
    return 'noop'
  }
  if (!existingIssue) return 'create'
  if (newOnes.length > 0) return 'notify'
  if (resolvedOnes.length > 0) return 'sync'
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
}) {
  const carried = all.filter((j) => carriedOver.includes(j))
  const observedFailing = all.filter((j) => !carriedOver.includes(j))
  const list = (jobs) => jobs.map((j) => `\`${j}\``).join(', ')
  const out = []
  out.push(
    `${profile.what} It is filed, updated and closed automatically by \`scripts/file-scheduled-failures.mjs\` — **do not rename the title**, the filing script matches on it verbatim to find this issue instead of opening a new one.`,
  )
  out.push('')
  out.push(
    `${profile.why} It is a rolling issue: it reopens when a ${profile.unit} newly fails and closes itself once every ${profile.unit} is healthy again.`,
  )
  out.push('')
  out.push(
    `A ${profile.unit} that stays red across runs is NOT re-commented — only a newly-failing ${profile.unit} produces a comment, so a persistent failure never spams this thread.`,
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
  out.push('')
  out.push(
    `_Machine-readable — do not hand-edit the marker lines below. Removing a ${profile.unit} here just means the next run will report it as new again._`,
  )
  out.push(MARKER_START)
  out.push('```')
  out.push(...all)
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
 * Throws when the block cannot be found or is empty — a dispatch-input list
 * that reads as `{}` would make every input assertion vacuous.
 */
export function findDispatchInputDefaults(workflowText) {
  const lines = workflowText.split('\n')
  const dispatchIdx = lines.findIndex((l) => /^ {2}workflow_dispatch:\s*$/.test(l))
  if (dispatchIdx === -1) throw new Error('no `workflow_dispatch:` trigger found in the workflow')
  const inputsIdx = lines.findIndex(
    (l, i) => i > dispatchIdx && /^ {4}inputs:\s*$/.test(l) && i < dispatchIdx + 4,
  )
  if (inputsIdx === -1) throw new Error('`workflow_dispatch:` declares no `inputs:` block')
  const defaults = {}
  let current = null
  for (let i = inputsIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.match(/^(\s*)/)[1].length
    if (indent <= 4) break
    const name = /^ {6}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (name) {
      current = name[1]
      continue
    }
    const def = /^ {8}default:\s*(.+?)\s*$/.exec(line)
    if (def && current) defaults[current] = def[1].replace(/^['"]|['"]$/g, '')
  }
  if (Object.keys(defaults).length === 0) {
    throw new Error('no `workflow_dispatch` input defaults found — the input gate would be vacuous')
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
  const action = decideAction({ newOnes, resolvedOnes, all, existingIssue })

  if (carriedOver.length > 0) {
    console.log(
      `carried over (${profile.unit}s that only SKIPPED — neither failing nor recovered, so they stay tracked): ${carriedOver.join(', ')}`,
    )
  }

  if (action === 'noop') {
    console.log(buildNoopSummary({ all, carriedOver, profile }))
    return
  }

  const body = buildIssueBody({ all, carriedOver, lanes, runUrl, profile })
  const comment =
    action === 'close'
      ? buildRecoveryComment({ resolvedOnes, runUrl, profile })
      : buildFailureComment({ newOnes, lanes, runUrl, profile })

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
      `[dry-run] newly failing: ${newOnes.length}, recovered: ${resolvedOnes.length}, still failing: ${all.length}`,
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

  // Reopening is a notification-class action, so only a genuinely NEW failure
  // does it. A 'sync' (partial recovery) against an issue a maintainer chose
  // to close while lanes were still red just updates the body — consistent
  // with the 'noop' branch above, which also leaves such an issue closed.
  if (action === 'notify' && existingIssue.state === 'CLOSED') {
    gh(['issue', 'reopen', number, '--repo', repo])
  }
  withTempFile(body, (f) => {
    gh(['issue', 'edit', number, '--repo', repo, '--body-file', f])
  })
  if (action === 'notify') {
    withTempFile(comment, (f) => {
      gh(['issue', 'comment', number, '--repo', repo, '--body-file', f])
    })
    console.log(
      `updated tracking issue #${number} (${newOnes.length} newly-failing ${profile.unit}(s))`,
    )
  } else {
    console.log(
      `synced tracking issue #${number} body (${resolvedOnes.length} recovered, ${all.length} still failing; no comment — a partial recovery is not news)`,
    )
  }
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
  const fixture = (branchBody, { mapInputs = true } = {}) =>
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

  // 7. The body stays small. There is no unbounded list here (one line per
  //    job), so a body that grows past this bound means someone started
  //    embedding logs — which is how the sibling filers hit GitHub's 65536
  //    422 and wedged their weekly job red (#3257).
  {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`some-rather-long-lane-name-${i}`, 'failure']),
    )
    const lanes = lanesOf(many)
    const body = buildIssueBody({ all: failingJobs(lanes), lanes, runUrl: 'https://example/run' })
    check(
      body.length <= MAX_BODY_CHARS,
      'an all-lanes-red body stays well under the issue-body limit',
      `len=${body.length} > ${MAX_BODY_CHARS}`,
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
