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
//
// Both conditions together are the failure. Either alone is ordinary — see
// the issue's own "either half alone is fine" framing.
//
// Usage:
//   node scripts/check-pr-overlap-trust-boundary.mjs
//   node scripts/check-pr-overlap-trust-boundary.mjs --self-test
//
// Exit: 0 = safe (or the hazard's precondition is absent); 1 = the hazard
// shape is present; 2 = the file could not be parsed at all (a wiring
// failure — the guard could not answer, not an answer of "safe") or a
// self-test assertion failed.

import { readFileSync } from 'node:fs'
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
 * `pull_request_target` as a trigger — either mapping style
 * (`pull_request_target:`) or flow-list style (`on: [pull_request_target]`,
 * folded into the block by `extractOnBlock` as a bare line).
 *
 * @param {string} onBlock
 */
export function declaresDangerousTrigger(onBlock) {
  const re = new RegExp(`(^|[\\s,[])${DANGEROUS_TRIGGER}(\\s*:|[\\s,\\]]|$)`, 'm')
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
  return { dangerous, headRefs, violation: dangerous && headRefs.length > 0 }
}

function main() {
  const src = readFileSync(WORKFLOW_PATH, 'utf8')
  const result = checkTrustBoundary(src)
  if (!result.violation) {
    console.log(
      result.dangerous
        ? 'OK: pr-overlap.yml triggers on pull_request_target, but no step checks out PR head content'
        : 'OK: pr-overlap.yml does not trigger on pull_request_target',
    )
    return 0
  }
  console.error(
    'ERROR: pr-overlap.yml triggers on `pull_request_target` AND checks out PR head content —',
  )
  console.error(
    'that is the exact combination #3967 removed: a `pull_request_target` run gets a token',
  )
  console.error(
    'scoped by the `permissions:` block AS WRITTEN, with none of the fork read-only downgrade',
  )
  console.error(
    '`pull_request` gets, so a job holding write and checking out PR-authored code can leak it.',
  )
  console.error('Offending `ref:` line(s):')
  for (const hit of result.headRefs) console.error(`  line ${hit.line}: ${hit.text}`)
  console.error(
    '\nEither drop `pull_request_target`, or make the checkout use the default (base-branch) ref',
    'and get any PR-specific data from the job that already runs the untrusted checkout, via an',
    'artifact — see the `compute`/`post` split this file uses today.',
  )
  return 1
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

# NOTE for a reader: pull_request_target is mentioned right here in a
# comment, not as a real trigger key — this fixture pins that a comment
# mention must not be mistaken for the trigger being declared.

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
      # No \`ref:\` override at all — pull_request_target defaults to the
      # BASE branch, which is the actual GitHub-recommended mitigation.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          fetch-depth: 1
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
  //    flag every legitimate use of the trigger, and a comment mentioning
  //    the trigger name must not itself be read as declaring it.
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
  {
    const src = readFileSync(WORKFLOW_PATH, 'utf8')
    const r = checkTrustBoundary(src)
    expect(
      'pr-overlap.yml itself passes today (the #3967 split holds)',
      r.violation === false,
      JSON.stringify(r),
    )
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    return 2
  }
  console.log('self-test: all assertions passed')
  return 0
}

process.exit(process.argv.includes('--self-test') ? runSelfTest() : main())
