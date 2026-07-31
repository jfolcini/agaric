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
//   - What remains irreducible: if the reporting JOB never starts (invalid
//     workflow file, runner-pool outage, whole-run cancellation before it is
//     scheduled) nothing reports. That needs an out-of-band watchdog and is
//     out of scope; `actionlint` in prek covers the invalid-workflow half.
//
// A MISSING `needs` payload is a hard error, not an empty one: reporting
// "zero lanes failed" because the context was absent would be the exact
// false-green class of bug this workflow keeps producing.
//
// State lives in the tracking issue's body, not a committed baseline file —
// the job needs `issues: write` only, never `contents: write`.
//
// Usage (from the repo root or anywhere — paths are resolved as given):
//   node scripts/file-scheduled-failures.mjs \
//     --needs-json-file <path to a file holding `${{ toJSON(needs) }}`> \
//     [--skipped-ok]                (treat `skipped` as OK; only correct off
//                                    the `schedule` event, where the two
//                                    scheduled-only filers really are skipped)
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

// Stable title: the ONLY thing the find-or-file logic matches on. Never
// rename an existing issue with this title — the script would stop finding it
// and would file a duplicate.
export const TRACKING_ISSUE_TITLE =
  'Scheduled deep checks: failing lanes (auto-filed, do not rename)'
export const TRACKING_ISSUE_LABELS = ['github-actions', 'testing']

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

export function diffLanes(current, known) {
  const currentSet = new Set(current)
  const newOnes = [...currentSet].filter((j) => !known.has(j)).toSorted()
  const resolvedOnes = [...known].filter((j) => !currentSet.has(j)).toSorted()
  return { newOnes, resolvedOnes, all: [...currentSet].toSorted() }
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
export function buildStatusTable(lanes) {
  const lines = ['| lane | result |', '| --- | --- |']
  for (const l of lanes) {
    lines.push(`| \`${l.job}\` | ${RESULT_LABEL[l.result] ?? l.result} |`)
  }
  return lines
}

export function buildIssueBody({ all, lanes, runUrl }) {
  const out = []
  out.push(
    'This issue tracks lanes of `.github/workflows/scheduled-deep-checks.yml` that are currently FAILING (#3359). It is filed, updated and closed automatically by `scripts/file-scheduled-failures.mjs` — **do not rename the title**, the filing script matches on it verbatim to find this issue instead of opening a new one.',
  )
  out.push('')
  out.push(
    'Every lane in that workflow is non-blocking triage signal, so a red lane is visible only to whoever opens the Actions tab — the #3163 fuzz compile break survived five days that way. This issue is the push notification that closes that gap. It is a rolling issue: it reopens when a lane newly fails and closes itself once every lane is green again.',
  )
  out.push('')
  out.push(
    'A lane that stays red across runs is NOT re-commented — only a newly-failing lane produces a comment, so a persistent failure never spams this thread.',
  )
  out.push('')
  out.push(`### Currently-failing lanes (${all.length})`)
  out.push(
    '_Machine-readable — do not hand-edit the marker lines below. Removing a lane here just means the next run will report it as new again._',
  )
  out.push(MARKER_START)
  out.push('```')
  out.push(...all)
  out.push('```')
  out.push(MARKER_END)
  if (lanes.length > 0) {
    out.push('')
    out.push('### All lanes, last run')
    out.push('')
    out.push(...buildStatusTable(lanes))
  }
  if (runUrl) {
    out.push('')
    out.push(`_Last updated by [this run](${runUrl})._`)
  }
  return out.join('\n')
}

export function buildFailureComment({ newOnes, lanes, runUrl }) {
  const lines = []
  lines.push(
    `**${newOnes.length} scheduled-deep-checks lane${newOnes.length === 1 ? '' : 's'} newly failing this run:** ${newOnes.map((j) => `\`${j}\``).join(', ')}`,
  )
  lines.push('')
  if (lanes.length > 0) {
    lines.push(...buildStatusTable(lanes))
    lines.push('')
  }
  if (runUrl) lines.push(`Run: ${runUrl}`)
  return lines.join('\n')
}

export function buildRecoveryComment({ resolvedOnes, runUrl }) {
  const lines = []
  lines.push(
    `All scheduled-deep-checks lanes are green again — closing. Recovered since the last update: ${resolvedOnes.map((j) => `\`${j}\``).join(', ')}.`,
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

// ---------------------------------------------------------------------------
// `gh` plumbing
// ---------------------------------------------------------------------------

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8' })
  return JSON.parse(out)
}

/** Finds the single tracking issue by exact title, preferring an OPEN match. */
function findTrackingIssue(repo) {
  const results = ghJson([
    'issue',
    'list',
    '--repo',
    repo,
    '--search',
    `in:title "${TRACKING_ISSUE_TITLE}"`,
    '--state',
    'all',
    '--json',
    'number,title,body,state',
    '--limit',
    '20',
  ])
  const exact = results.filter((i) => i.title === TRACKING_ISSUE_TITLE)
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

  console.log(
    `scheduled-deep-checks lanes: ${lanes.length} total, ${current.length} failing${
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
    existingIssue = findTrackingIssue(repo)
  }

  const known = parseKnownLanes(existingIssue?.body)
  const { newOnes, resolvedOnes, all } = diffLanes(current, known)
  const action = decideAction({ newOnes, resolvedOnes, all, existingIssue })

  if (action === 'noop') {
    console.log(
      all.length === 0
        ? 'all scheduled-deep-checks lanes green — no-op (nothing open that tracks a failing lane)'
        : `no newly-failing lane — no-op (still failing: ${all.join(', ')}; tracking issue left untouched)`,
    )
    return
  }

  const body = buildIssueBody({ all, lanes, runUrl })
  const comment =
    action === 'close'
      ? buildRecoveryComment({ resolvedOnes, runUrl })
      : buildFailureComment({ newOnes, lanes, runUrl })

  if (args.dryRun) {
    // Compare against null explicitly — the `--known-body-file` stub uses
    // issue number 0, which is falsy, so a truthiness check on `.number`
    // would misreport an existing issue as "not found".
    const where =
      existingIssue === null
        ? `a new issue titled "${TRACKING_ISSUE_TITLE}"`
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
      const labelArgs = TRACKING_ISSUE_LABELS.flatMap((l) => ['--label', l])
      gh([
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        TRACKING_ISSUE_TITLE,
        '--body-file',
        bodyFile,
        ...labelArgs,
      ])
    })
    console.log(`filed a new tracking issue (${all.length} failing lane(s))`)
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
    console.log(`closed tracking issue #${number} (all lanes green again; tracked set cleared)`)
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
    console.log(`updated tracking issue #${number} (${newOnes.length} newly-failing lane(s))`)
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

  // An EMPTY `--known-body-file` is how `main()` spells "no existing issue",
  // so no file removal is needed between drives.
  const drive = (needs, knownBody, knownState) => {
    writeFileSync(needsFile, JSON.stringify(needs), 'utf8')
    writeFileSync(bodyFile, knownBody, 'utf8')
    writeFileSync(log, '', 'utf8')
    const prevPath = process.env.PATH
    const prevLog = console.log
    process.env.PATH = `${dir}:${prevPath}`
    console.log = () => {}
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
    '--skipped-ok exempts skipped (dispatch dry-run only)',
    '',
  )

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

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.slice(2).includes('--self-test')) {
    runSelfTest()
  } else {
    try {
      main()
    } catch (err) {
      console.error(`file-scheduled-failures: ${err.message}`)
      process.exit(1)
    }
  }
}
