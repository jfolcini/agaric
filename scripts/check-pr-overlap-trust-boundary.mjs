#!/usr/bin/env node
// #3967 — pin the trust boundary `pr-overlap.yml` depends on, mechanically.
//
// ─── Why ─────────────────────────────────────────────────────────────────
//
// The #3672 adversarial review found `pr-overlap.yml`'s (former) `overlap`
// job holding `pull-requests: write` in the SAME job that checked out
// PR-authored code (a `pull_request` checkout is `refs/pull/N/merge`, which
// for a fork PR is code the fork author controls). That combination was safe
// today only because GitHub silently downgrades `GITHUB_TOKEN` to read-only
// for a `pull_request` run from a fork, REGARDLESS of the `permissions:`
// block asking for more — a mitigation that lives entirely in GitHub's
// defaults, not in this file, and evaporates the moment someone flips the
// trigger to `pull_request_target` (which does NOT get that downgrade) while
// keeping a checkout of PR content, e.g. because they still want the PR's
// actual diff and reach for `ref: ${{ github.event.pull_request.head.sha }}`
// to get it. That edit is exactly the shape GitHub's own security
// documentation and `pull_request_target` incident writeups describe as
// arbitrary-code-execution-with-a-privileged-token, and it is one line.
//
// #3967 split the job in two instead of relying on the default: the job that
// checks out PR-authored code (`compute`, below) now declares `permissions:
// {}` and never sees `GH_TOKEN`; the job that holds `pull-requests: write`
// (`post`) never checks out PR-authored code. That split is a structural
// fact about THIS file today. Nothing stops it rotting the way the #3672
// issue itself warned a PROSE note would: "a comment cannot enforce that,
// and comments going stale is the failure mode that caused a separate
// blocking bug in this same batch." So the invariant is checked here instead
// — the same shape as `check-android-trigger.mjs` pinning a regex against
// the paths it names, rather than trusting the regex was written correctly
// once and stays that way.
//
// ─── What this checks ──────────────────────────────────────────────────────
//
// Mechanically, on `pr-overlap.yml` only (this is not a general-purpose
// `pull_request_target` linter — zizmor already runs one over every workflow
// via the `zizmor` prek hook; this is insurance specific to the one file
// #3967 is about, same scoping choice `check-android-trigger.mjs` makes for
// `ci.yml`'s `android_re`):
//
//   1. Does the file's `on:` block name `pull_request_target` as a trigger?
//      `pull_request_target` gets a token scoped by the `permissions:` block
//      as written — no fork downgrade — which is the precondition for the
//      whole hazard.
//   2. If so, does ANY step in the file check out the PR's head content —
//      a `ref:` resolving to `github.event.pull_request.head.*`,
//      `github.head_ref`, or a literal `refs/pull/<n>/(merge|head)`?
//      A `pull_request_target` checkout with NO ref override checks out the
//      BASE branch by default — that is the actual mitigation GitHub
//      recommends, and this guard must not flag it, or it flags every safe
//      use of the trigger and nobody reads its output. It is specifically an
//      EXPLICIT head ref alongside `pull_request_target` that reintroduces
//      the #3967 hazard.
//   3. Independent of the trigger: does any JOB that declares a write
//      permission scope (`<scope>: write` or `write-all`, at the job level
//      or inherited from the top-level `permissions:` block) contain an
//      `actions/checkout` step whose `ref:` is not pinned to the PR's BASE
//      (`github.event.pull_request.base.*`)? A checkout with no `ref:` at
//      all is included — under TODAY's `pull_request` trigger that defaults
//      to `refs/pull/N/merge` (fork-controlled content), which is exactly
//      the #3967 shape even though condition 1 is false. Checks 1+2 above
//      only fire after a hypothetical trigger flip to
//      `pull_request_target`; this check fires on the file AS IT STANDS,
//      which is the only way to prove it is not vacuous — see the
//      self-test fixture that reverts this file's `compute`/`post` split
//      back to one job and confirms THIS check (not 1+2) catches it.
//
// (1 AND 2) is one failure mode; 3 is a second, independent one. Either
// firing is a violation.
//
// Usage:
//   node scripts/check-pr-overlap-trust-boundary.mjs
//   node scripts/check-pr-overlap-trust-boundary.mjs --self-test
//
// Exit: 0 = safe (or the hazard's precondition is absent); 1 = the hazard
// shape is present; 2 = the file could not be parsed at all (a wiring
// failure — the guard could not answer, not an answer of "safe") or a
// self-test assertion failed.

import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/pr-overlap.yml')

const DANGEROUS_TRIGGER = 'pull_request_target'

// Any of these resolving inside a `ref:` value means "PR head content",
// independent of which job or step it appears in.
const HEAD_REF_PATTERNS = [
  /pull_request\.head\.(?:sha|ref)/,
  /\bhead_ref\b/, // github.head_ref
  /refs\/pull\/[^/]+\/(?:merge|head)/,
]

// A `ref:` value resolving to one of these is pinned to the PR's BASE
// branch — a commit in this repo's own history, never a fork's — which is
// the one shape of checkout condition 3 (below) accepts inside a
// write-scoped job.
const BASE_REF_PATTERNS = [/pull_request\.base\.(?:sha|ref)/]

/**
 * Extract the top-level `on:` block's raw text (from the `on:` line up to,
 * but not including, the next line that starts at column 0). Comment lines
 * inside it are dropped before the caller matches against it, so a
 * DOCUMENTATION mention of the trigger name (this very file's own header,
 * for instance) cannot be mistaken for the trigger actually being declared.
 *
 * Throws — not a violation, a WIRING failure — if the file carries no `on:`
 * block at all, which means this guard is looking at the wrong shape of
 * file and must not silently report "safe".
 *
 * @param {string} src
 */
export function extractOnBlock(src) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => /^on:\s*$/.test(l))
  if (start === -1) {
    throw new Error(
      `could not find a top-level \`on:\` block in ${WORKFLOW_PATH} — did the trigger get restructured onto one line?`,
    )
  }
  const block = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break // next top-level key
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('#')) continue
    block.push(lines[i])
  }
  return block.join('\n')
}

/**
 * Whether `onBlock` (the raw text `extractOnBlock` returned) declares
 * `pull_request_target` as a trigger, mapping style (`pull_request_target:`).
 *
 * Flow-list style (`on: [pull_request_target]`) is NOT handled here, and
 * there is no dead branch in this regex pretending otherwise: that form
 * never reaches this function in the first place. `extractOnBlock` only
 * recognises a top-level `on:` line with nothing after the colon
 * (`/^on:\s*$/`); a flow-list `on:` fails that match and `extractOnBlock`
 * throws before `declaresDangerousTrigger` is ever called — `main()` has no
 * try/catch around that call, so it fails CLOSED (exit 2; see `main`'s own
 * comment), just not via this function. If this file's trigger is ever
 * restructured onto one line, fix `extractOnBlock`, not this function.
 *
 * @param {string} onBlock
 */
export function declaresDangerousTrigger(onBlock) {
  const re = new RegExp(`(^|\\s)${DANGEROUS_TRIGGER}(\\s*:|\\s|$)`, 'm')
  return re.test(onBlock)
}

/**
 * Every line across the whole file whose `ref:` value resolves to PR head
 * content, with the 1-based line number for the failure message.
 *
 * @param {string} src
 */
export function findHeadCheckoutRefs(src) {
  const lines = src.split('\n')
  const hits = []
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) return
    if (!trimmed.startsWith('ref:')) return
    if (HEAD_REF_PATTERNS.some((re) => re.test(trimmed))) {
      hits.push({ line: i + 1, text: trimmed })
    }
  })
  return hits
}

/**
 * Split the `jobs:` block into per-job source slices, keyed by job name.
 * Same line-scanning approach as `extractOnBlock`: a job header is a line
 * indented exactly two spaces and ending in `:` (`  compute:`), and its body
 * is every line after that up to the next such header, or a line that
 * dedents back to column 0 (the next top-level workflow key).
 *
 * Throws — a wiring failure, not a violation — if the file has no top-level
 * `jobs:` block, same discipline as `extractOnBlock`.
 *
 * @param {string} src
 * @returns {Record<string, { body: string[], headerLine: number }>}
 */
export function splitJobs(src) {
  const lines = src.split('\n')
  const jobsStart = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsStart === -1) {
    throw new Error(`could not find a top-level \`jobs:\` block in ${WORKFLOW_PATH}`)
  }
  /** @type {Record<string, { body: string[], headerLine: number }>} */
  const jobs = {}
  let name = null
  let body = []
  let headerLine = 0
  const flush = () => {
    if (name !== null) jobs[name] = { body, headerLine }
  }
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line)) break // dedented back to a top-level key; jobs: block is over
    const header = /^ {2}(\S[^:]*):\s*$/.exec(line)
    if (header) {
      flush()
      name = header[1]
      body = []
      headerLine = i + 1
      continue
    }
    if (name !== null) body.push(line)
  }
  flush()
  return jobs
}

/**
 * Whether a job body declares a write permission scope: `permissions:
 * write-all` (inline), or a mapping with any `<scope>: write` entry —
 * `pull-requests: write`, `contents: write`, etc. `permissions: {}` and
 * `permissions:\n  contents: read` are both "no".
 *
 * Returns `null` if the job has no `permissions:` key of its own at all, so
 * the caller can fall back to the workflow-level block (a job with no
 * override inherits it).
 *
 * @param {string[]} jobBody
 */
export function jobDeclaresWriteScope(jobBody) {
  const idx = jobBody.findIndex((l) => /^ {4}permissions:/.test(l))
  if (idx === -1) return null
  const inline = /^ {4}permissions:\s*(\S.*)$/.exec(jobBody[idx])
  if (inline) return /write/.test(inline[1])
  for (let i = idx + 1; i < jobBody.length; i++) {
    if (/^ {0,4}\S/.test(jobBody[i])) break // dedented back out of the permissions block
    if (/:\s*write\b/.test(jobBody[i])) return true
  }
  return false
}

/**
 * Every `actions/checkout` step inside a job body, with the `ref:` value
 * found inside that step's own `with:` block (`null` if the step has no
 * `ref:` at all — the triggering event's default checkout applies, which for
 * `pull_request` IS PR head content).
 *
 * Step boundaries are found by indentation, not by a step counter: a step is
 * introduced by a line whose trimmed text starts with `- ` (a YAML sequence
 * item); the step's content ends at the next line whose indentation is no
 * deeper than that `-`.
 *
 * @param {string[]} jobBody
 */
export function findCheckoutSteps(jobBody) {
  const steps = []
  for (let i = 0; i < jobBody.length; i++) {
    const m = /^(\s*)-\s*uses:\s*actions\/checkout@/.exec(jobBody[i])
    if (!m) continue
    const indent = m[1].length
    let ref = null
    for (let j = i + 1; j < jobBody.length; j++) {
      const line = jobBody[j]
      if (line.trim() === '') continue
      const lineIndent = line.length - line.trimStart().length
      if (lineIndent <= indent) break // next step, or end of this job's steps
      const refMatch = /^\s*ref:\s*(.+)$/.exec(line)
      if (refMatch) {
        ref = refMatch[1].trim()
        break
      }
    }
    steps.push({ stepLine: i, ref })
  }
  return steps
}

/**
 * Condition 3 (see this file's header): every `actions/checkout` step, in
 * every job that declares (or inherits) a write permission scope, whose
 * `ref:` is not pinned to `pull_request.base.*`. Checked on EVERY run,
 * independent of what the file's `on:` block says — unlike conditions 1+2,
 * which only fire after `pull_request_target` is added, this is what
 * catches reverting the `compute`/`post` split back to one job under
 * TODAY's plain `pull_request` trigger, where a ref-less checkout already
 * defaults to fork-controlled content.
 *
 * @param {string} src
 */
export function findWriteScopedUnsafeCheckouts(src) {
  const lines = src.split('\n')
  const workflowPermissions = (() => {
    const idx = lines.findIndex((l) => l.startsWith('permissions:'))
    if (idx === -1) return false
    const inline = /^permissions:\s*(\S.*)$/.exec(lines[idx])
    if (inline) return /write/.test(inline[1])
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break
      if (/:\s*write\b/.test(lines[i])) return true
    }
    return false
  })()

  const jobs = splitJobs(src)
  const hits = []
  for (const [jobName, { body, headerLine }] of Object.entries(jobs)) {
    const own = jobDeclaresWriteScope(body)
    const writeScoped = own === null ? workflowPermissions : own
    if (!writeScoped) continue
    for (const step of findCheckoutSteps(body)) {
      const basePinned = step.ref !== null && BASE_REF_PATTERNS.some((re) => re.test(step.ref))
      if (basePinned) continue
      hits.push({
        job: jobName,
        line: headerLine + step.stepLine + 1,
        ref: step.ref,
      })
    }
  }
  return hits
}

/**
 * The full verdict for one workflow source string. Pulled out of `main` so
 * the self-test can exercise it against synthetic fixtures without touching
 * the real file.
 *
 * @param {string} src
 */
export function checkTrustBoundary(src) {
  const onBlock = extractOnBlock(src)
  const dangerous = declaresDangerousTrigger(onBlock)
  const headRefs = dangerous ? findHeadCheckoutRefs(src) : []
  const unsafeWriteCheckouts = findWriteScopedUnsafeCheckouts(src)
  return {
    dangerous,
    headRefs,
    unsafeWriteCheckouts,
    violation: (dangerous && headRefs.length > 0) || unsafeWriteCheckouts.length > 0,
  }
}

/**
 * Render a `checkTrustBoundary` verdict as the lines `main` prints — pulled
 * out so a one-off check against a synthetic fixture (proving condition 3 is
 * not vacuous — see this file's header) can produce the exact same text
 * `main` would, without reading `WORKFLOW_PATH`.
 *
 * @param {ReturnType<typeof checkTrustBoundary>} result
 */
export function renderVerdict(result) {
  const lines = []
  if (!result.violation) {
    lines.push(
      result.dangerous
        ? 'OK: pr-overlap.yml triggers on pull_request_target, but no step checks out PR head content'
        : 'OK: pr-overlap.yml does not trigger on pull_request_target',
    )
    return { lines, exitCode: 0 }
  }
  if (result.dangerous && result.headRefs.length > 0) {
    lines.push(
      'ERROR: pr-overlap.yml triggers on `pull_request_target` AND checks out PR head content —',
      'that is the exact combination #3967 removed: a `pull_request_target` run gets a token',
      'scoped by the `permissions:` block AS WRITTEN, with none of the fork read-only downgrade',
      '`pull_request` gets, so a job holding write and checking out PR-authored code can leak it.',
      'Offending `ref:` line(s):',
    )
    for (const hit of result.headRefs) lines.push(`  line ${hit.line}: ${hit.text}`)
    lines.push(
      '\nEither drop `pull_request_target`, or make the checkout use the default (base-branch) ref',
      'and get any PR-specific data from the job that already runs the untrusted checkout, via an',
      'artifact — see the `compute`/`post` split this file uses today.',
    )
  }
  if (result.unsafeWriteCheckouts.length > 0) {
    lines.push(
      'ERROR: a job declaring a write permission scope checks out code without a checkout',
      "pinned to the PR's BASE ref (`github.event.pull_request.base.sha` or `.base.ref`) —",
      "that is the #3967 shape regardless of what this file's `on:` trigger says today: a",
      "ref-less checkout under `pull_request` already defaults to the PR's own (fork-controlled",
      'for a fork PR) content, and a write-scoped job running that content can leak its token.',
      'Offending job / checkout:',
    )
    for (const hit of result.unsafeWriteCheckouts) {
      lines.push(`  job \`${hit.job}\`, line ${hit.line}: ref: ${hit.ref ?? '(none)'}`)
    }
    lines.push(
      "\nEither drop the write permission from that job, or pin its checkout's `ref:` to",
      '`github.event.pull_request.base.sha` and move any PR-specific data through an artifact',
      'from a job with no write scope — see the `compute`/`post` split this file uses today.',
    )
  }
  return { lines, exitCode: 1 }
}

function main() {
  let result
  try {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    result = checkTrustBoundary(src)
  } catch (err) {
    console.error(`ERROR: could not evaluate ${WORKFLOW_PATH}: ${err.message}`)
    return 2
  }
  const { lines, exitCode } = renderVerdict(result)
  for (const line of lines) (exitCode === 0 ? console.log : console.error)(line)
  return exitCode
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

const SAFE_PULL_REQUEST_ONLY = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions: {}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

const DANGEROUS_TARGET_WITH_HEAD_CHECKOUT = `name: Open-PR file overlap (informational)

on:
  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  overlap:
    runs-on: ubuntu-24.04
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
`

const SAFE_TARGET_NO_HEAD_CHECKOUT = `name: Open-PR file overlap (informational)

# NOTE for a reader: this fixture pins the SIBLING acceptance case —
# pull_request_target genuinely declared, paired with a checkout whose
# \`ref:\` is explicitly pinned to the BASE branch (not head). That is the
# actual GitHub-recommended mitigation, and the guard must not flag it, or
# it flags every legitimate use of the trigger.

on:
  pull_request_target:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      pull-requests: write
    steps:
      # ref: pinned to the BASE branch, not head — the actual
      # GitHub-recommended mitigation for pull_request_target.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          fetch-depth: 1
          persist-credentials: false
`

// A trigger name mentioned only in a COMMENT inside the `on:` block — never
// as a real key — must not be mistaken for the trigger being declared. This
// is the fixture that actually exercises `extractOnBlock`'s comment-drop
// (`SAFE_TARGET_NO_HEAD_CHECKOUT` above does not: it declares
// pull_request_target for real).
const COMMENT_MENTION_IS_NOT_A_TRIGGER = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
    # pull_request_target is mentioned right here, inside the on: block, as
    # a COMMENT — extractOnBlock must drop this line before
    # declaresDangerousTrigger ever sees it, or a comment mentioning the
    # trigger's name would be mistaken for declaring it.

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions: {}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// THE VACUOUSNESS PROOF for condition 3 (see this file's header): this is
// pr-overlap.yml's `compute`/`post` split COLLAPSED back into one job, under
// TODAY's actual `pull_request` trigger — no `pull_request_target` anywhere,
// so conditions 1+2 (and the OLD version of this guard, before condition 3
// existed) see nothing wrong. The job holds a write scope AND its checkout
// carries no \`ref:\` override at all, which under \`pull_request\` defaults to
// \`refs/pull/N/merge\` — fork-controlled content for a fork PR. That is
// exactly the #3967 shape. If this fixture does not turn condition 3 red,
// the guard is back to asserting nothing about the split it is named for.
const COLLAPSED_SINGLE_JOB_UNDER_PULL_REQUEST = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  overlap:
    runs-on: ubuntu-24.04
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

  // 1. THE FALSIFICATION: pull_request_target + an explicit head checkout
  //    must fail, and must name the offending line.
  {
    const r = checkTrustBoundary(DANGEROUS_TARGET_WITH_HEAD_CHECKOUT)
    expect(
      'pull_request_target + a head-ref checkout is flagged as a violation',
      r.violation === true && r.dangerous === true,
      JSON.stringify(r),
    )
    expect(
      'the offending ref line is the one naming pull_request.head.sha',
      r.headRefs.length === 1 && /pull_request\.head\.sha/.test(r.headRefs[0].text),
      JSON.stringify(r.headRefs),
    )
  }

  // 2. THE SIBLING ACCEPTANCE: pull_request_target alone, with a checkout
  //    that explicitly pins the BASE ref, is safe — the guard must not
  //    flag every legitimate use of the trigger.
  {
    const r = checkTrustBoundary(SAFE_TARGET_NO_HEAD_CHECKOUT)
    expect(
      'pull_request_target + a base-ref-only checkout is NOT a violation',
      r.violation === false && r.dangerous === true,
      JSON.stringify(r),
    )
  }

  // 3. today's actual trigger (no pull_request_target at all) is safe
  //    regardless of what any checkout step's ref looks like.
  {
    const r = checkTrustBoundary(SAFE_PULL_REQUEST_ONLY)
    expect(
      'a plain `pull_request` trigger is not dangerous, independent of checkout refs',
      r.violation === false && r.dangerous === false,
      JSON.stringify(r),
    )
  }

  // 4. A file with no `on:` block at all is a WIRING failure (throws), not
  //    a silent "safe" — same discipline check-android-trigger.mjs applies
  //    to a renamed `android_re='…'` variable.
  {
    let threw = false
    try {
      checkTrustBoundary('name: not a real workflow\njobs:\n  x:\n    runs-on: ubuntu-24.04\n')
    } catch {
      threw = true
    }
    expect('a file with no `on:` block throws rather than reporting "safe"', threw, 'did not throw')
  }

  // 5. THE ACTUAL FILE, today, must pass — the wiring check that this guard
  //    is still pointed at the file #3967 fixed and the fix still holds.
  //    This is meaningful, not vacuous, ONLY because of assertion 7 below:
  //    that assertion proves condition 3 turns red on the file this guard
  //    would pass if condition 3 did not exist.
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const r = checkTrustBoundary(src)
    expect(
      'pr-overlap.yml itself passes today (the #3967 split holds)',
      r.violation === false,
      JSON.stringify(r),
    )
  }

  // 6. A trigger name mentioned only in a COMMENT inside `on:` is not
  //    mistaken for the trigger being declared — the behaviour
  //    `extractOnBlock`'s own docstring claims, actually exercised.
  {
    const r = checkTrustBoundary(COMMENT_MENTION_IS_NOT_A_TRIGGER)
    expect(
      'a comment naming pull_request_target inside `on:` does not make `dangerous` true',
      r.dangerous === false && r.violation === false,
      JSON.stringify(r),
    )
  }

  // 7. CONDITION 3 IS NOT VACUOUS: collapse the compute/post split back into
  //    one write-scoped job that checks out PR code, under TODAY's plain
  //    `pull_request` trigger (no pull_request_target anywhere — conditions
  //    1+2 see nothing). This is the exact edit #3967 removed and the exact
  //    edit assertion 5 above would NOT catch without condition 3: revert
  //    this PR and the guard still prints OK on conditions 1+2 alone.
  {
    const r = checkTrustBoundary(COLLAPSED_SINGLE_JOB_UNDER_PULL_REQUEST)
    expect(
      'a reverted single write-scoped job with an unpinned checkout IS flagged, even though dangerous === false',
      r.violation === true && r.dangerous === false && r.unsafeWriteCheckouts.length === 1,
      JSON.stringify(r),
    )
    expect(
      'the offending job is named, and its checkout has no ref: at all',
      r.unsafeWriteCheckouts[0]?.job === 'overlap' && r.unsafeWriteCheckouts[0]?.ref === null,
      JSON.stringify(r.unsafeWriteCheckouts),
    )
    const rendered = renderVerdict(r)
    expect(
      'main()-style output for this fixture is non-zero and names the job',
      rendered.exitCode === 1 && rendered.lines.some((l) => l.includes('`overlap`')),
      JSON.stringify(rendered),
    )
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    return 2
  }
  console.log('self-test: all assertions passed')
  return 0
}

// Guarded so an external script can `import { checkTrustBoundary, renderVerdict, ... }`
// from this file (e.g. to run the guard against a one-off fixture and prove
// a new assertion is not vacuous) without this module's own CLI dispatch
// running — and `process.exit`-ing — as a side effect of the import.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  process.exit(process.argv.includes('--self-test') ? runSelfTest() : main())
}
