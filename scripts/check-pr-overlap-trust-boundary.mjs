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
// contents: read` — NO write scope of any kind — and never sees `GH_TOKEN`;
// the job that holds `pull-requests: write` (`post`) never checks out
// PR-authored code. (`contents: read` rather than `{}` because
// `actions/checkout` authenticates its clone with `github.token` regardless
// of the `permissions:` block, so `{}` 403s the checkout on a private repo;
// `pr-overlap.yml`'s `compute` job carries that reasoning in full. What
// matters to this guard is the absence of a WRITE scope, which both spellings
// have.) That split is a structural
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
//      "Not vacuous" has to be asserted, not assumed: this check shipped
//      once seeing ZERO checkout steps in `pr-overlap.yml`, because it
//      required `- uses: actions/checkout@` on ONE line while the real
//      file's only write-scoped checkout opens with `- name:`. So the
//      self-test also pins that condition 3 REACHES a checkout step in the
//      real file, and carries fixtures in that same `- name:`-first shape
//      — see `findCheckoutSteps` and the last self-test block.
//   4. Independent of both the trigger AND the `permissions:` block: does any
//      job holding a checkout that is NOT base-pinned (the same "untrusted
//      content" predicate condition 3 uses) reference `secrets.` anywhere —
//      in an `env:`, a `with:`, a `run:`, anywhere? Conditions 1–3 read
//      `permissions:` and nothing else, which leaves the OTHER half of this
//      header's own thesis uncovered: it names a PAT alongside the trigger
//      flip as the way the GitHub fork-downgrade mitigation dies, and a PAT
//      is not a `permissions:` scope. `GH_TOKEN: ${{ secrets.A_PAT }}` added
//      to `compute` reinstates the #3967 arrangement exactly — a
//      write-capable credential sitting in the job that runs fork-authored
//      code — while `compute`'s `permissions: contents: read` stays
//      untouched and conditions 1–3 stay green on it.
//      `secrets.GITHUB_TOKEN` is NOT exempted: under `pull_request` from a
//      fork it is read-only only because of the very GitHub default #3967
//      stopped relying on, and the structural answer (`post` holds the
//      token, `compute` holds the untrusted checkout) needs no token in
//      `compute` at all. A workflow-level `env:` counts too — it is
//      inherited by every job, so a secret declared once above `jobs:` lands
//      in the untrusted job just the same.
//      What this does NOT cover: a secret reaching the untrusted job by a
//      route with no `secrets.` token in this file — a `with:` input on a
//      third-party action that fetches its own credential, an OIDC exchange,
//      a value carried in from a reusable workflow's `secrets: inherit`.
//      Those need a different check; this one closes the one-line edit.
//
// (1 AND 2) is one failure mode; 3 and 4 are two more, independent of it and
// of each other. Any of them firing is a violation.
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

// Any reference to the `secrets` context: `secrets.GITHUB_TOKEN`,
// `secrets.A_PAT`, or the index form `secrets['A_PAT']`. Condition 4 (below)
// rejects all of them inside a job holding a non-base-pinned checkout — see
// this file's header for why `GITHUB_TOKEN` is not carved out.
const SECRET_REFERENCE = /\bsecrets\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_-]*|\[)/

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
 * COMMENT LINES ARE NOT JOB HEADERS, for the same reason `extractOnBlock`
 * drops comments before matching a trigger name. `pr-overlap.yml` separates
 * its jobs with two-space-indented prose banners, and one of those ending in
 * a colon (`  # …what follows is a note about its contract:`) matched the
 * header regex — inventing a PHANTOM job that owns the rest of the REAL
 * job's body. The phantom declares no `permissions:` of its own, so it
 * inherits the workflow-level block (`contents: read`), so condition 3 skips
 * it — and the real job, now truncated to whatever preceded the comment,
 * has no checkout steps left to inspect. A write-scoped job checking out
 * fork content would pass silently. The body lines are still pushed to the
 * job they were already in, so every `headerLine + offset` line number
 * stays exact.
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
    const header = isCommentLine(line) ? null : /^ {2}(\S[^:]*):\s*$/.exec(line)
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
 * COMMENTS ARE STRIPPED FIRST. A `permissions:` block routinely explains
 * itself — including by naming the scope it deliberately does NOT ask for
 * ("dropped `pull-requests: write` here", the shape `pr-overlap.yml`'s own
 * `compute` job comments about) — and reading that as a live write scope
 * fails safe but produces a red nobody can explain from the file.
 *
 * @param {string[]} jobBody
 */
export function jobDeclaresWriteScope(jobBody) {
  const idx = jobBody.findIndex((l) => /^ {4}permissions:/.test(l))
  if (idx === -1) return null
  const inline = /^ {4}permissions:\s*(\S.*)$/.exec(stripComment(jobBody[idx]))
  if (inline) return /write/.test(inline[1])
  for (let i = idx + 1; i < jobBody.length; i++) {
    if (/^ {0,4}\S/.test(jobBody[i])) break // dedented back out of the permissions block
    if (declaresWrite(jobBody[i])) return true
  }
  return false
}

/**
 * `line` with any trailing `#` comment removed, and `''` for a whole-line
 * comment. Deliberately naive about a `#` inside a quoted scalar: no
 * `permissions:` or `ref:` value in a workflow carries one, and the failure
 * direction of getting it wrong here is a value that reads as SHORTER, never
 * as a write scope that is not there.
 *
 * @param {string} line
 */
function stripComment(line) {
  const hash = line.indexOf('#')
  return hash === -1 ? line : line.slice(0, hash)
}

/**
 * Whether one line of a `permissions:` mapping grants a write scope
 * (`contents: write`, `pull-requests: write`, …), ignoring comments.
 *
 * @param {string} line
 */
function declaresWrite(line) {
  return /:\s*write\b/.test(stripComment(line))
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
 * deeper than that `-`. The step is a checkout if `uses: actions/checkout@`
 * appears ANYWHERE in that block — NOT only on the introducing line. That
 * distinction is the whole reason this function exists in this shape: the
 * earlier version required `- uses: actions/checkout@` on one line, and
 * `pr-overlap.yml`'s own `post` job writes its checkout as `- name: …` with
 * `uses:` seventeen lines further down, so the only write-scoped job in the
 * file was invisible to condition 3 and the check asserted nothing. See the
 * `NAME_FIRST_HEAD_REF_CHECKOUT` fixture, which mirrors that step shape
 * deliberately, and the self-test block that pins condition 3 as reaching a
 * checkout step in the real file at all.
 *
 * The `ref:` is read only from the step's own `with:` MAPPING, and only as a
 * DIRECT child of it — not "the first `ref:` at any depth in the step". A
 * `ref:` nested under some other `with:` key (a future option carrying its
 * own mapping) is a different value entirely, and reading it as the
 * checkout's ref would let a base-pinned nested value launder a ref-less —
 * i.e. fork-content — checkout past condition 3.
 *
 * @param {string[]} jobBody
 */
export function findCheckoutSteps(jobBody) {
  const steps = []
  for (let i = 0; i < jobBody.length; i++) {
    if (isCommentLine(jobBody[i])) continue
    const m = /^(\s*)-\s/.exec(jobBody[i])
    if (!m) continue
    const indent = m[1].length

    // The step's block: the introducing `- …` line plus every following line
    // indented deeper than the `-`.
    let end = jobBody.length
    for (let j = i + 1; j < jobBody.length; j++) {
      if (jobBody[j].trim() === '') continue
      if (indentOf(jobBody[j]) <= indent) {
        end = j
        break
      }
    }
    const block = jobBody.slice(i, end)

    const isCheckout = block.some(
      (line) => !isCommentLine(line) && /(?:^|\s)uses:\s*actions\/checkout@/.test(line),
    )
    if (!isCheckout) continue

    // `refLine` is relative to the job body, like `stepLine`, and is `null`
    // when the step declares no `ref:` — it exists because a `- name:`-first
    // step's `ref:` can sit many lines below the line that introduces it, and
    // a failure message naming only the step line points at a line that does
    // not contain the value it quotes.
    const { ref, refLine } = refFromWithMapping(block, indent)
    steps.push({ stepLine: i, ref, refLine: refLine === null ? null : i + refLine })
  }
  return steps
}

/** Indentation width of `line`, in characters. @param {string} line */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/** Whether `line` is a whole-line YAML comment. @param {string} line */
function isCommentLine(line) {
  return line.trim().startsWith('#')
}

/**
 * The `ref:` value declared as a DIRECT child of a step's `with:` mapping,
 * with its offset from the step's introducing line. Both are `null` if the
 * step has no `with:` block or no `ref:` directly under it. See
 * `findCheckoutSteps`' docstring for why "direct child" rather than "anywhere
 * in the step".
 *
 * THE VALUE IS COMMENT-STRIPPED, like every other value this guard reads
 * (`jobDeclaresWriteScope`, `declaresWrite`). Condition 3 accepts a checkout
 * whose `ref:` merely CONTAINS `pull_request.base.…` — a substring test, not
 * an equality one, because the real value is an interpolation with
 * surrounding `${{ }}` — so an unstripped trailing comment is a free pass:
 * `ref: ${{ github.event.pull_request.head.sha }}  # unlike base.sha, this
 * is head` reads as base-pinned and walks past the check while checking out
 * fork content. A `ref:` line whose value is ENTIRELY a comment is treated
 * as no `ref:` at all — no override means the event's default ref, which is
 * the fail-closed reading.
 *
 * @param {string[]} block  the step's lines, starting at its `- …` line
 * @param {number} stepIndent  indentation of that leading `-`
 * @returns {{ ref: string | null, refLine: number | null }}
 */
function refFromWithMapping(block, stepIndent) {
  const withIdx = block.findIndex(
    (line) => !isCommentLine(line) && indentOf(line) > stepIndent && /^\s*with:\s*$/.test(line),
  )
  if (withIdx === -1) return { ref: null, refLine: null }
  const withIndent = indentOf(block[withIdx])
  let childIndent = null
  for (let j = withIdx + 1; j < block.length; j++) {
    const line = block[j]
    if (line.trim() === '' || isCommentLine(line)) continue
    const lineIndent = indentOf(line)
    if (lineIndent <= withIndent) break // dedented back out of the with: mapping
    if (childIndent === null) childIndent = lineIndent
    if (lineIndent !== childIndent) continue // nested under some other with: key
    const refMatch = /^\s*ref:\s*(.*)$/.exec(stripComment(line))
    if (refMatch) {
      const value = refMatch[1].trim()
      return value === '' ? { ref: null, refLine: null } : { ref: value, refLine: j }
    }
  }
  return { ref: null, refLine: null }
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
    // Comments stripped for the same reason as in `jobDeclaresWriteScope`.
    const inline = /^permissions:\s*(\S.*)$/.exec(stripComment(lines[idx]))
    if (inline) return /write/.test(inline[1])
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break
      if (declaresWrite(lines[i])) return true
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
      if (isBasePinned(step.ref)) continue
      hits.push({
        job: jobName,
        line: headerLine + step.stepLine + 1,
        refLine: step.refLine === null ? null : headerLine + step.refLine + 1,
        ref: step.ref,
      })
    }
  }
  return hits
}

/**
 * Whether a checkout `ref:` value (as `findCheckoutSteps` returns it, `null`
 * for a step with no `ref:` of its own) pins the checkout to the PR's BASE —
 * a commit in this repo's own history, never a fork's. `null` is NOT base
 * pinned: no override means the triggering event's default ref, which under
 * `pull_request` is `refs/pull/N/merge`, i.e. fork-controlled content.
 *
 * Shared by conditions 3 and 4 so "the untrusted job" means the identical
 * thing in both — a job that already passes condition 3 by pinning its
 * checkout is not the job a secret must be kept out of.
 *
 * @param {string | null} ref
 */
function isBasePinned(ref) {
  return ref !== null && BASE_REF_PATTERNS.some((re) => re.test(ref))
}

/**
 * Every `secrets.` reference, with its 1-based line number, in `lines`.
 * Comments are stripped first: this file's own prose (and `pr-overlap.yml`'s)
 * discusses tokens at length, and a comment SAYING `secrets.GITHUB_TOKEN` is
 * not a job holding one.
 *
 * @param {string[]} lines
 * @returns {{ offset: number, text: string }[]}  offset is 0-based into `lines`
 */
function findSecretReferences(lines) {
  const hits = []
  lines.forEach((line, i) => {
    const bare = stripComment(line)
    if (SECRET_REFERENCE.test(bare)) hits.push({ offset: i, text: bare.trim() })
  })
  return hits
}

/**
 * Condition 4 (see this file's header): every `secrets.` reference sitting in
 * a job that holds a checkout which is not base-pinned — the job running
 * fork-authored content. Independent of `permissions:` entirely, which is the
 * point: a PAT is a credential the `permissions:` block never mentions, so
 * conditions 1–3 cannot see the PAT half of the hazard this guard's header
 * names.
 *
 * A `secrets.` reference in the workflow PREAMBLE (anything above `jobs:` —
 * in practice a workflow-level `env:`) is inherited by every job, so it is
 * reported against each untrusted job with `scope: 'workflow'`, quoting the
 * preamble line it actually lives on.
 *
 * @param {string} src
 */
export function findSecretsInUntrustedJobs(src) {
  const jobs = splitJobs(src) // throws on a file with no `jobs:` — a wiring failure
  const lines = src.split('\n')
  const jobsStart = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  const preambleHits = findSecretReferences(lines.slice(0, jobsStart))

  const hits = []
  for (const [jobName, { body, headerLine }] of Object.entries(jobs)) {
    const untrusted = findCheckoutSteps(body).some((step) => !isBasePinned(step.ref))
    if (!untrusted) continue
    for (const hit of findSecretReferences(body)) {
      hits.push({ job: jobName, line: headerLine + hit.offset + 1, text: hit.text, scope: 'job' })
    }
    for (const hit of preambleHits) {
      hits.push({ job: jobName, line: hit.offset + 1, text: hit.text, scope: 'workflow' })
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
  const secretsInUntrustedJobs = findSecretsInUntrustedJobs(src)
  return {
    dangerous,
    headRefs,
    unsafeWriteCheckouts,
    secretsInUntrustedJobs,
    violation:
      (dangerous && headRefs.length > 0) ||
      unsafeWriteCheckouts.length > 0 ||
      secretsInUntrustedJobs.length > 0,
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
      // The step's own line and the `ref:`'s line are quoted separately: a
      // `- name:`-first checkout step declares its `ref:` well below the line
      // that introduces the step, so one number cannot honestly stand for both.
      const where = hit.refLine === null ? '(none)' : `${hit.ref} (line ${hit.refLine})`
      lines.push(`  job \`${hit.job}\`, checkout step at line ${hit.line}: ref: ${where}`)
    }
    lines.push(
      "\nEither drop the write permission from that job, or pin its checkout's `ref:` to",
      '`github.event.pull_request.base.sha` and move any PR-specific data through an artifact',
      'from a job with no write scope — see the `compute`/`post` split this file uses today.',
    )
  }
  if (result.secretsInUntrustedJobs.length > 0) {
    lines.push(
      'ERROR: a job whose checkout is NOT pinned to the PR base ref — i.e. a job running',
      'fork-authored content — references the `secrets` context. That is the #3967 hazard by',
      'its other route: a credential in the same job as untrusted code. `permissions:` says',
      'nothing about it, so conditions 1-3 above stay green while the mitigation is gone.',
      '`secrets.GITHUB_TOKEN` counts: it is read-only on a fork PR only because of the GitHub',
      'default #3967 deliberately stopped depending on. Offending job / reference:',
    )
    for (const hit of result.secretsInUntrustedJobs) {
      const where = hit.scope === 'workflow' ? ' (workflow-level, inherited by every job)' : ''
      lines.push(`  job \`${hit.job}\`, line ${hit.line}${where}: ${hit.text}`)
    }
    lines.push(
      '\nMove whatever needs the secret into a job that does NOT check out PR content (pin that',
      "job's checkout to `github.event.pull_request.base.sha`) and pass results between the two",
      'as an artifact — see the `compute`/`post` split this file uses today.',
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

// THE SHAPE OF THE FILE UNDER GUARD. `pr-overlap.yml`'s `post` job does not
// write its checkout as `- uses: actions/checkout@…` on one line: it opens
// with `- name: Checkout the TRUSTED script source`, spends seventeen lines
// of comment on why the ordering is load-bearing, and only then reaches
// `uses:` and `with:`. An earlier revision of \`findCheckoutSteps\` required
// the `-` and the `uses:` on the SAME line, so it saw ZERO checkout steps in
// \`post\` — the only write-scoped job in the file — and condition 3 asserted
// nothing at all, while every fixture above (all `- uses:`-first) stayed
// green and assertion 5 passed because the hazard was INVISIBLE rather than
// absent. This fixture reproduces the real step shape and carries the
// one-line head-ref edit that reinstates the #3967 arrangement; condition 3
// must catch it.
const NAME_FIRST_HEAD_REF_CHECKOUT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        # A long comment between the step's \`- name:\` line and its \`uses:\`
        # line, exactly as the real file has — this is the gap the old
        # same-line regex fell into.
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false
`

// The \`ref:\` this guard reads must be the checkout's OWN — a direct child of
// the step's \`with:\` mapping — not merely the first \`ref:\` at any depth
// inside the step block. Here the step declares NO checkout ref (so under
// \`pull_request\` it takes the fork-controlled \`refs/pull/N/merge\` default,
// the #3967 shape) while a DIFFERENT, base-pinned \`ref:\` sits nested under
// another \`with:\` key. Reading that nested value as the checkout's ref would
// launder this step past condition 3.
const NESTED_REF_IS_NOT_THE_CHECKOUT_REF = `name: Open-PR file overlap (informational)

on:
  pull_request:
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
      - name: Checkout the TRUSTED script source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          # A hypothetical future option carrying its own mapping, whose
          # \`ref:\` is NOT this checkout's ref.
          fallback:
            ref: \${{ github.event.pull_request.base.sha }}
`

// A `permissions:` block that NAMES a write scope in a comment while granting
// none. `pr-overlap.yml`'s `compute` job comments about exactly this — why it
// holds no write scope — and reading the comment as a live grant would make
// condition 3 flag the untrusted job for the permission it deliberately does
// not have. Fails safe, but produces a red no one can explain from the file.
const COMMENT_IN_PERMISSIONS_IS_NOT_A_WRITE_SCOPE = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      # #3967 dropped \`pull-requests: write\` from this job — it runs
      # fork-authored code and must hold nothing worth stealing.
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// CONDITION 4's FALSIFICATION. `pr-overlap.yml`'s `compute` job, unchanged
// except for the one edit this file's header calls the OTHER way the fork
// downgrade dies: a PAT handed to the job that runs fork-authored code. The
// `permissions:` block still says `contents: read`; the trigger is still
// plain `pull_request`; conditions 1, 2 and 3 all see a clean file. Only a
// check that reads `secrets.` catches this.
const SECRET_PAT_IN_UNTRUSTED_JOB = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Post the table from here, it is simpler
        env:
          GH_TOKEN: \${{ secrets.A_PAT_WITH_WRITE }}
        run: gh pr comment "$PR_NUMBER" --body-file table.md
`

// The SIBLING ACCEPTANCE for condition 4: `pr-overlap.yml`'s real `post` job
// holds \`secrets.GITHUB_TOKEN\` and must keep holding it. It is allowed to,
// because its checkout is pinned to the PR BASE — it is the TRUSTED half of
// the split. Condition 4 must not flag it, or the guard forbids the very
// arrangement #3967 introduced.
const SECRET_IN_BASE_PINNED_JOB_IS_FINE = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the TRUSTED script source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Post the table
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: gh pr comment "$PR_NUMBER" --body-file table.md
`

// A secret named only in a COMMENT inside the untrusted job — the shape
// `pr-overlap.yml`'s `compute` job actually carries, which explains at length
// which token it does NOT hold. Reading that as a live reference fails safe
// but produces a red nobody can explain from the file, the same objection
// `COMMENT_IN_PERMISSIONS_IS_NOT_A_WRITE_SCOPE` pins for condition 3.
const SECRET_NAMED_ONLY_IN_A_COMMENT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      # No \`GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\` anywhere in this job —
      # #3967 moved everything that needs a token into \`post\`.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// The same hazard declared one level up: a workflow-level \`env:\` is inherited
// by EVERY job, so a secret placed there reaches the untrusted checkout
// without appearing anywhere inside the job's own body.
const WORKFLOW_LEVEL_SECRET_ENV = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

env:
  GH_TOKEN: \${{ secrets.A_PAT_WITH_WRITE }}

jobs:
  compute:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
`

// COMMENT EVASION ON THE \`ref:\` VALUE. Condition 3 accepts a \`ref:\` that
// CONTAINS \`pull_request.base.sha\` — a substring test, because the real value
// is an interpolation. Without comment-stripping, a trailing comment MENTIONING
// the base ref makes a head checkout read as base-pinned: the write-scoped job
// checks out fork content and the guard prints OK. Every other value this
// guard reads already routes through \`stripComment\`; this one did not.
const HEAD_REF_LAUNDERED_BY_A_TRAILING_COMMENT = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the PR's own content
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }} # not github.event.pull_request.base.sha, we need the real diff
          persist-credentials: false
`

// A TWO-SPACE-INDENTED COMMENT ENDING IN A COLON is not a job header.
// \`pr-overlap.yml\` separates its jobs with exactly this kind of prose banner,
// so this line is in the file's own idiom. Read as a header, it invents a
// phantom job that inherits the workflow-level \`contents: read\` (it declares
// no \`permissions:\` of its own) and swallows the rest of \`post\`'s body — so
// the write-scoped job below has no checkout left to inspect and its
// unpinned checkout belongs to a job condition 3 skips. Silent false
// negative: this fixture is a REAL violation that a phantom-job split
// reports as clean.
const COMMENT_LINE_IS_NOT_A_JOB_HEADER = `name: Open-PR file overlap (informational)

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  post:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
  # A banner comment in this file's own prose idiom, ending in a colon —
  # about \`post\` above and what follows, not a new job. On its contract:
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

    // …and the same, on the step shape the REAL file actually uses: a
    // `- name:`-first checkout whose `uses:` and `ref:` are many lines below
    // the line introducing the step. Every fixture above is `- uses:`-first,
    // which is precisely how condition 3 shipped vacuous once already — the
    // fixtures did not mirror the file under guard.
    const nameFirst = checkTrustBoundary(NAME_FIRST_HEAD_REF_CHECKOUT)
    expect(
      'a `- name:`-first checkout step (the shape the real file uses) is SEEN by condition 3',
      nameFirst.violation === true &&
        nameFirst.dangerous === false &&
        nameFirst.unsafeWriteCheckouts.length === 1,
      JSON.stringify(nameFirst),
    )
    expect(
      'its head ref is read from the `with:` block several lines below that `- name:` line',
      /pull_request\.head\.sha/.test(nameFirst.unsafeWriteCheckouts[0]?.ref ?? ''),
      JSON.stringify(nameFirst.unsafeWriteCheckouts),
    )

    // The `ref:` must come from the step's own `with:` mapping, not from any
    // deeper nesting under some other key.
    const nested = checkTrustBoundary(NESTED_REF_IS_NOT_THE_CHECKOUT_REF)
    expect(
      'a base-pinned `ref:` nested under another `with:` key does not count as the checkout ref',
      nested.violation === true &&
        nested.unsafeWriteCheckouts.length === 1 &&
        nested.unsafeWriteCheckouts[0]?.ref === null,
      JSON.stringify(nested),
    )
  }

  // 8. A write scope named only in a COMMENT inside a `permissions:` block is
  //    not a granted scope — the same discipline assertion 6 applies to the
  //    `on:` block, applied to the input condition 3 gates on.
  {
    const r = checkTrustBoundary(COMMENT_IN_PERMISSIONS_IS_NOT_A_WRITE_SCOPE)
    expect(
      'a comment naming `pull-requests: write` inside `permissions:` is not a write scope',
      r.violation === false && r.unsafeWriteCheckouts.length === 0,
      JSON.stringify(r),
    )
  }

  // 9. THE WIRING PIN behind assertion 5: assertion 5 says the real file
  //    PASSES, and a check that inspects nothing passes too. So assert that
  //    condition 3 actually reaches a checkout step in this file — at least
  //    one write-scoped job, and at least one checkout step inside it. This
  //    is the assertion that would have failed on the revision where
  //    `findCheckoutSteps` could not see `post`'s `- name:`-first step.
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const jobs = splitJobs(src)
    const writeScoped = Object.entries(jobs).filter(([, { body }]) => jobDeclaresWriteScope(body))
    const inspected = writeScoped.flatMap(([name, { body }]) =>
      findCheckoutSteps(body).map((step) => ({ job: name, ref: step.ref })),
    )
    expect(
      'condition 3 inspects at least one checkout step in a write-scoped job of pr-overlap.yml',
      writeScoped.length > 0 && inspected.length > 0,
      `write-scoped jobs: ${JSON.stringify(writeScoped.map(([n]) => n))}, checkout steps inspected: ${inspected.length}`,
    )
    expect(
      'and every one of those it inspects is pinned to the PR base ref',
      inspected.every((s) => s.ref !== null && BASE_REF_PATTERNS.some((re) => re.test(s.ref))),
      JSON.stringify(inspected),
    )
  }

  // 10. CONDITION 4 IS NOT VACUOUS: a PAT added to the untrusted job. Every
  //     other condition stays green on this fixture — the `permissions:`
  //     block is untouched `contents: read` and the trigger is plain
  //     `pull_request` — which is the whole point: before condition 4, this
  //     edit reinstated the #3967 arrangement with zero reaction from this
  //     guard.
  {
    const r = checkTrustBoundary(SECRET_PAT_IN_UNTRUSTED_JOB)
    expect(
      'a PAT in the job holding the unpinned (fork-content) checkout IS flagged',
      r.violation === true && r.secretsInUntrustedJobs.length === 1,
      JSON.stringify(r),
    )
    expect(
      'and it is flagged by condition 4 ALONE — trigger and permissions are untouched',
      r.dangerous === false && r.headRefs.length === 0 && r.unsafeWriteCheckouts.length === 0,
      JSON.stringify(r),
    )
    expect(
      'the offending job, line and text are named',
      r.secretsInUntrustedJobs[0]?.job === 'compute' &&
        r.secretsInUntrustedJobs[0]?.scope === 'job' &&
        /secrets\.A_PAT_WITH_WRITE/.test(r.secretsInUntrustedJobs[0]?.text ?? '') &&
        SECRET_PAT_IN_UNTRUSTED_JOB.split('\n')[r.secretsInUntrustedJobs[0].line - 1]?.includes(
          'A_PAT_WITH_WRITE',
        ),
      JSON.stringify(r.secretsInUntrustedJobs),
    )
    const rendered = renderVerdict(r)
    expect(
      'main()-style output for the PAT fixture is non-zero and names the job',
      rendered.exitCode === 1 && rendered.lines.some((l) => l.includes('`compute`')),
      JSON.stringify(rendered),
    )

    // The same secret one level up, in a workflow-level `env:` inherited by
    // every job — invisible to a scan of the job body alone.
    const wf = checkTrustBoundary(WORKFLOW_LEVEL_SECRET_ENV)
    expect(
      'a workflow-level `env:` secret is charged to the untrusted job that inherits it',
      wf.violation === true &&
        wf.secretsInUntrustedJobs.length === 1 &&
        wf.secretsInUntrustedJobs[0]?.job === 'compute' &&
        wf.secretsInUntrustedJobs[0]?.scope === 'workflow',
      JSON.stringify(wf),
    )
  }

  // 11. CONDITION 4's TWO ACCEPTANCES, so it does not simply ban the word
  //     `secrets`: the TRUSTED half of the split (base-pinned checkout) may
  //     hold `secrets.GITHUB_TOKEN` — that is the arrangement #3967 built —
  //     and a secret NAMED IN A COMMENT is not a secret held.
  {
    const trusted = checkTrustBoundary(SECRET_IN_BASE_PINNED_JOB_IS_FINE)
    expect(
      '`secrets.GITHUB_TOKEN` in a job whose checkout is base-pinned is NOT a violation',
      trusted.violation === false && trusted.secretsInUntrustedJobs.length === 0,
      JSON.stringify(trusted),
    )
    const commented = checkTrustBoundary(SECRET_NAMED_ONLY_IN_A_COMMENT)
    expect(
      'a `secrets.` reference inside a COMMENT in the untrusted job is not a secret held',
      commented.violation === false && commented.secretsInUntrustedJobs.length === 0,
      JSON.stringify(commented),
    )
  }

  // 12. THE `ref:` COMMENT EVASION: a head checkout whose trailing comment
  //     mentions the base ref must not read as base-pinned. Before
  //     `refFromWithMapping` stripped comments, `BASE_REF_PATTERNS`
  //     substring-matched the comment and condition 3 waved the step through.
  {
    const r = checkTrustBoundary(HEAD_REF_LAUNDERED_BY_A_TRAILING_COMMENT)
    expect(
      'a head `ref:` with a trailing comment mentioning the base ref is still flagged',
      r.violation === true && r.unsafeWriteCheckouts.length === 1,
      JSON.stringify(r),
    )
    expect(
      "the reported ref is the comment-stripped value, so the failure message quotes what's live",
      r.unsafeWriteCheckouts[0]?.ref === '${{ github.event.pull_request.head.sha }}',
      JSON.stringify(r.unsafeWriteCheckouts),
    )
  }

  // 13. A TWO-SPACE COMMENT ENDING IN `:` IS NOT A JOB HEADER. Two
  //     assertions, because the second one alone would not say WHY: first
  //     that `splitJobs` reports exactly the one real job, then that the
  //     violation this fixture actually contains is still seen. Read as a
  //     header, the comment forks a phantom job that inherits `contents:
  //     read`, owns the checkout, and is skipped by condition 3 — so the
  //     fixture reports clean.
  {
    const jobs = splitJobs(COMMENT_LINE_IS_NOT_A_JOB_HEADER)
    expect(
      'a 2-space-indented comment ending in `:` does not become a phantom job',
      JSON.stringify(Object.keys(jobs)) === JSON.stringify(['post']),
      JSON.stringify(Object.keys(jobs)),
    )
    const r = checkTrustBoundary(COMMENT_LINE_IS_NOT_A_JOB_HEADER)
    expect(
      'and the write-scoped job below that comment keeps its unpinned checkout, and is flagged',
      r.violation === true &&
        r.unsafeWriteCheckouts.length === 1 &&
        r.unsafeWriteCheckouts[0]?.job === 'post' &&
        r.unsafeWriteCheckouts[0]?.ref === null,
      JSON.stringify(r),
    )
  }

  // 14. THE WIRING PIN behind condition 4 on the REAL file, the same
  //     discipline assertion 9 applies to condition 3: "no secrets found" is
  //     also what a check that classifies NO job as untrusted would report.
  //     So assert that `pr-overlap.yml` really does contain a job condition 4
  //     considers untrusted (it does: `compute`, whose ref-less checkout is
  //     the fork-content one by design), and that the file's real
  //     `secrets.GITHUB_TOKEN` uses live in a job that is NOT one of those.
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const jobs = splitJobs(src)
    const untrusted = Object.entries(jobs)
      .filter(([, { body }]) => findCheckoutSteps(body).some((step) => !isBasePinned(step.ref)))
      .map(([name]) => name)
    expect(
      'condition 4 classifies at least one job of pr-overlap.yml as holding untrusted content',
      untrusted.length > 0,
      `untrusted jobs: ${JSON.stringify(untrusted)}`,
    )
    const secretsAnywhere = findSecretReferences(src.split('\n'))
    expect(
      'and the file does carry real `secrets.` references — in the trusted job only',
      secretsAnywhere.length > 0 && findSecretsInUntrustedJobs(src).length === 0,
      `secret lines: ${JSON.stringify(secretsAnywhere.map((h) => h.offset + 1))}`,
    )
  }

  // 15. THE ONE LINE-NUMBER CITATION `pr-overlap.yml` MAKES ABOUT ITSELF.
  //     `merge-result`'s fetch step justifies its `|| true` by pointing at
  //     "the tolerant equivalent above in `compute` (line N)". That number
  //     was written before #3967 split the job in two and pointed, after the
  //     split, at a COMMENT line in `compute`'s banner — a citation that
  //     reads as precise and is not. `check-doc-code-paths.mjs` polices
  //     backticked PATH citations in `.md`/`.ts`/`.tsx`, and none of that
  //     reaches a bare `(line N)` inside a `.yml` comment, so this file's
  //     one self-citation is pinned here: the cited line must actually be
  //     the tolerant `git fetch … || true`, and must actually be inside
  //     `compute`. Same argument as the rest of this guard — the #3672 issue
  //     it descends from is about a comment that went stale unnoticed.
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const lines = src.split('\n')
    const anchor = lines.findIndex((l) => /tolerant equivalent above in `compute`/.test(l))
    const citation =
      anchor === -1 ? null : /\(line (\d+)\)/.exec(lines.slice(anchor, anchor + 3).join('\n'))
    const citedLine = citation === null ? null : lines[Number(citation[1]) - 1]
    const compute = splitJobs(src).compute
    const inCompute =
      citation !== null &&
      compute !== undefined &&
      Number(citation[1]) > compute.headerLine &&
      Number(citation[1]) <= compute.headerLine + compute.body.length
    expect(
      "pr-overlap.yml's `(line N)` self-citation points at `compute`'s tolerant `git fetch … || true`",
      citedLine !== null && inCompute && /git fetch .*\|\| true/.test(citedLine),
      `anchor line ${anchor + 1}, citation ${citation?.[1] ?? '(none)'}, cited text: ${JSON.stringify(citedLine)}`,
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
