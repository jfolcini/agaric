#!/usr/bin/env node
// #3933 — two open, unmerged PRs can independently claim the same
// `docs/session-log/session-NNNN-*.md` number, and nothing catches it
// before merge.
//
// ─── Why `check-session-log-numbering.sh` cannot see this ─────────────────
//
// That guard's check 1 tests uniqueness against `HEAD ∪ origin/main ∪
// same-commit siblings` — every set that guard can reach at commit time. A
// sibling's OPEN, UNMERGED PR branch is in none of those sets: while both
// branches are open, `origin/main` has neither number yet, so each branch
// honestly computes the same "free" number and each guard run passes. The
// collision exists only in the union of the two PRs, which no local guard
// invocation — pre-commit, pre-push, or a PR's own CI checkout — can ever
// see, because neither branch's checkout contains the other's commits.
// This is the mechanism behind the two real duplicate `session-1281` files
// `check-session-log-numbering.sh`'s own header describes, and it happened
// again, live, while preparing #3932 (session-1319, caught by hand).
//
// So this has to run somewhere that can see every open PR at once: CI,
// against the GitHub API's own view of the open-PR board — not a git ref
// any single branch's checkout carries. It is deliberately NOT a prek /
// pre-commit hook: a hook that must reach the network to do its job is a bad
// hook (breaks an offline commit, and a flaky API call would then block
// EVERY commit rather than one CI run) — see #3933's own body and
// `pr-overlap.yml`'s `post` job, which makes exactly this call already for
// the (deliberately non-gating) file-overlap table.
//
// ─── Why this is a pure function of `gh pr list`'s own JSON, not a git diff ─
//
// `pr-file-overlap.mjs` already computes overlap between open PRs by
// intersecting CHANGED FILE PATHS. That catches nothing here: two PRs
// colliding on session-1319 add two DIFFERENT filenames
// (`session-1319-foo.md`, `session-1319-bar.md`) — no path is shared, so a
// path-intersection check reports them as disjoint, correctly and
// uselessly. The identity that collides is the NUMBER embedded in the
// filename, not the path itself, so this script parses that number out of
// every open PR's changed-file list and groups by it instead.
//
// ─── Fail-closed, not fail-open (the whole point of #3933) ────────────────
//
// A guard that reports "no collision" when the API call failed, the PR list
// came back empty, or a PR entry has a shape this script did not
// anticipate, is worse than no guard: it reports safety it never verified.
// So `analyze()` below CLASSIFIES POSITIVELY — it treats the input as
// verified ONLY when:
//   1. the payload is an array of objects, each with an integer `number`,
//      an integer `changedFiles` count, and a `files` array (`shapeProblem`
//      below) — not "parses as JSON", which `[]`, `{}`, and `null` all
//      satisfy trivially; and
//   2. no entry's `files` array is itself truncated — `gh`'s `files` field
//      is a GitHub API connection HARD-CAPPED at 100 entries per PR
//      regardless of `--limit`, silently, with no error and no flag in the
//      JSON it returns. `changedFiles` (the PR's true total file count,
//      requested alongside `files`) is what exposes this: if
//      `changedFiles > files.length`, some of that PR's changed files —
//      possibly including a `session-NNNN-*.md` this script would otherwise
//      never see — are missing from the payload, and that PR's claim (if
//      any) cannot be trusted either way; and
//   3. the fetched list itself isn't truncated at the CALLER'S OWN
//      `gh pr list --limit N` — a page exactly N entries long is
//      indistinguishable from a page cut off at N, so `--pr-limit N` (when
//      given) makes a list of length >= N unverified rather than read as
//      "that's just how many PRs happen to be open"; and
//   4. (when `--self-pr` is given, which the real CI invocation always
//      does) the PR running this check is ITSELF present in the fetched
//      list — the cheapest self-consistency check available: if `gh pr
//      list` silently returned an empty, truncated, or stale result, the
//      one PR guaranteed to be open (this one) will be missing from it,
//      and that is caught here before the empty/short list is ever read as
//      "no other PR is open".
// Anything outside that allow-list is `verified: false`, and `main()` exits
// 2 (a failure to verify) rather than 0 (verified clean) — see the exit-code
// table in the usage comment below. An unrecognised state is a failure to
// verify, never a pass.
//
// Usage:
//   node scripts/check-session-log-pr-collision.mjs \
//     --prs prs.json --self-pr <n> [--merged-nums merged.txt] [--pr-limit <n>]
//   node scripts/check-session-log-pr-collision.mjs --self-test
//
// `--prs` takes the body of
// `gh pr list --state open --json number,files,changedFiles` — every open
// PR, this one included (that is what `--self-pr` verifies).
//
// `--pr-limit` takes the SAME number passed to that `gh pr list --limit`
// invocation, so this script can tell a full page from a truncated one (see
// point 3 above). Omitted entirely, that specific check is skipped — the
// CI caller always passes it; it's optional here only so ad-hoc/self-test
// invocations aren't forced to fabricate a limit that means nothing to them.
//
// `--merged-nums` takes newline-separated integers: the session numbers
// already present in the merge target (`git ls-tree -r --name-only
// <base-sha> -- docs/session-log | grep -oP 'session-\K[0-9]+'`). Folded
// into the "next free number" suggestion so the guard's own remedy cannot
// recreate the collision it just found — omitted entirely, the suggestion
// is still safe against every OPEN claim, just not against merged history.
//
// Exit: 0 = verified, no collision. 1 = verified, a collision was found
// (real defect — fails the job). 2 = could not verify (bad usage, malformed
// payload, a truncated files list or PR page, self-PR missing from the
// fetched list) or self-test failure — treated as a failure to verify,
// never as a pass.

import { readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import process from 'node:process'

export const LOG_DIR = 'docs/session-log'
const SESSION_FILE_RE = /^docs\/session-log\/session-(\d+)-[^/]+\.md$/

/**
 * The session number embedded in a `docs/session-log/session-NNN-*.md`
 * path, or `null` if the path doesn't match that shape at all (a PR that
 * touches some OTHER file under `docs/session-log/`, or no session-log file
 * at all, contributes nothing here — that is a legitimate, unremarkable
 * outcome, not a problem).
 *
 * @param {string} path
 */
export function sessionNumberOf(path) {
  const m = SESSION_FILE_RE.exec(String(path))
  return m ? Number(m[1]) : null
}

/** The changed paths of one `gh pr list --json number,files` entry. */
function pathsOf(pr) {
  return (pr?.files ?? []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean)
}

/**
 * Structural validation of the `gh pr list` payload. Returns `null` when the
 * shape is trustworthy, or a diagnostic string naming the first problem
 * found. Deliberately stricter than "is valid JSON": `[]`, `{}`, `null`, and
 * `"oops"` all parse cleanly and must not be treated as a legitimate answer.
 *
 * @param {unknown} prs
 */
function shapeProblem(prs) {
  if (!Array.isArray(prs)) return `payload is not a JSON array (got ${typeof prs})`
  for (const [i, pr] of prs.entries()) {
    if (pr === null || typeof pr !== 'object') return `entry ${i} is not an object`
    if (!Number.isInteger(pr.number)) return `entry ${i} has no integer "number" field`
    if (!Array.isArray(pr.files)) return `entry ${i} (#${pr.number}) has no "files" array`
    if (!Number.isInteger(pr.changedFiles)) {
      return `entry ${i} (#${pr.number}) has no integer "changedFiles" field`
    }
  }
  return null
}

/**
 * PRs whose `files` array is shorter than their true `changedFiles` count —
 * `gh`'s `files` field on a PR is a GitHub API connection hard-capped at 100
 * entries, silently, no matter how many files the PR actually changed. A
 * cap this script did not ask for and `gh` does not flag is exactly the
 * kind of truncation #3933 is about: any file past the cutoff — including a
 * `session-NNNN-*.md` this script would otherwise catch — is invisible to
 * `pathsOf()` below.
 *
 * @param {{number:number, files:unknown[], changedFiles:number}[]} prs
 */
function truncatedFilesPrs(prs) {
  return prs.filter((pr) => pr.changedFiles > pr.files.length)
}

/**
 * The core analysis. Pure — no filesystem, no network — so the self-test
 * exercises exactly this and nothing about argument parsing or process
 * exit codes.
 *
 * @param {{prs: unknown, selfPr?: number|null, mergedNums?: number[], prLimit?: number|null}} opts
 */
export function analyze({ prs, selfPr = null, mergedNums = [], prLimit = null }) {
  const problem = shapeProblem(prs)
  if (problem) {
    return {
      verified: false,
      reason: `malformed open-PR payload: ${problem}`,
      collisions: [],
      suggestion: null,
    }
  }

  if (prLimit !== null && prs.length >= prLimit) {
    return {
      verified: false,
      reason:
        `the fetched open-PR list has ${prs.length} entr${prs.length === 1 ? 'y' : 'ies'}, which ` +
        `meets or exceeds the requested --pr-limit of ${prLimit}. A page exactly that long is ` +
        'indistinguishable from one GitHub cut off at that length — raise the limit and re-run ' +
        'rather than trust a full page as "that is just how many PRs are open".',
      collisions: [],
      suggestion: null,
    }
  }

  const truncated = truncatedFilesPrs(prs)
  if (truncated.length > 0) {
    return {
      verified: false,
      reason:
        `${truncated.length} open PR${truncated.length === 1 ? "'s" : "s'"} changed-file list is ` +
        `truncated by gh's 100-file cap ` +
        `(${truncated.map((pr) => `#${pr.number}: ${pr.files.length}/${pr.changedFiles} files`).join(', ')}) — ` +
        'a session-log claim past that cutoff would be invisible to this check, so a truncated ' +
        'PR can never be read as "contributes nothing".',
      collisions: [],
      suggestion: null,
    }
  }

  if (selfPr !== null && !prs.some((p) => Number(p.number) === Number(selfPr))) {
    return {
      verified: false,
      reason:
        `PR #${selfPr} (the one running this check) is not present in the fetched ` +
        `open-PR list (${prs.length} entr${prs.length === 1 ? 'y' : 'ies'} returned). ` +
        'A list that omits the PR that is guaranteed to be open is an incomplete or ' +
        'stale read, not evidence of "no other PR is open".',
      collisions: [],
      suggestion: null,
    }
  }

  /** @type {Map<number, {pr:number, file:string}[]>} */
  const claims = new Map()
  for (const pr of prs) {
    for (const file of pathsOf(pr)) {
      const n = sessionNumberOf(file)
      if (n === null) continue
      if (!claims.has(n)) claims.set(n, [])
      claims.get(n).push({ pr: Number(pr.number), file })
    }
  }

  const collisions = []
  for (const [number, entries] of claims) {
    const distinctPrs = new Set(entries.map((e) => e.pr))
    if (distinctPrs.size > 1) {
      collisions.push({
        number,
        claims: entries.toSorted((a, b) => a.pr - b.pr || a.file.localeCompare(b.file)),
      })
    }
  }
  collisions.sort((a, b) => a.number - b.number)

  // The next free number must be safe against BOTH merged history and every
  // open claim (including non-colliding ones) — otherwise the guard's own
  // remedy hands out a number some other open PR already holds, recreating
  // exactly the bug it just reported (#3933's own acceptance criterion).
  const allNums = [...mergedNums, ...claims.keys()].map(Number).filter((n) => Number.isInteger(n))
  const maxNum = allNums.length > 0 ? Math.max(...allNums) : 0

  return { verified: true, reason: null, collisions, suggestion: maxNum + 1 }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { prs: null, selfPr: null, mergedNums: null, prLimit: null }
  for (let i = 0; i < argv.length; i++) {
    const take = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`)
      return v
    }
    switch (argv[i]) {
      case '--prs': {
        args.prs = take()
        break
      }
      case '--self-pr': {
        const v = Number(take())
        if (!Number.isInteger(v) || v <= 0) throw new Error('--self-pr needs a PR number')
        args.selfPr = v
        break
      }
      case '--merged-nums': {
        args.mergedNums = take()
        break
      }
      case '--pr-limit': {
        const v = Number(take())
        if (!Number.isInteger(v) || v <= 0) throw new Error('--pr-limit needs a positive integer')
        args.prLimit = v
        break
      }
      default: {
        throw new Error(`unrecognized argument: ${argv[i]}`)
      }
    }
  }
  if (args.prs === null) throw new Error('--prs is required')
  if (args.selfPr === null) throw new Error('--self-pr is required')
  return args
}

function readMergedNums(path) {
  if (path === null) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger)
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`check-session-log-pr-collision: ${err.message}`)
    process.exit(2)
  }

  let prs
  try {
    prs = JSON.parse(readFileSync(args.prs, 'utf8'))
  } catch (err) {
    console.error(
      `::error::check-session-log-pr-collision: could not read/parse --prs ${args.prs}: ${err.message}`,
    )
    console.error(
      'Treated as UNVERIFIED, not as "no open PRs": an unreadable payload must never read as safety this check did not actually check (#3933).',
    )
    process.exit(2)
  }

  let mergedNums
  try {
    mergedNums = readMergedNums(args.mergedNums)
  } catch (err) {
    console.error(
      `::error::check-session-log-pr-collision: could not read --merged-nums ${args.mergedNums}: ${err.message}`,
    )
    process.exit(2)
  }

  const result = analyze({ prs, selfPr: args.selfPr, mergedNums, prLimit: args.prLimit })

  if (!result.verified) {
    console.error(`::error::check-session-log-pr-collision: could not verify — ${result.reason}`)
    console.error(
      'An unverifiable open-PR dataset is a FAILURE here, not a pass (#3933): an empty or ' +
        'malformed result is absence of evidence, never evidence of safety.',
    )
    process.exit(2)
  }

  if (result.collisions.length > 0) {
    console.error(
      `::error::check-session-log-pr-collision: ${result.collisions.length} session-log number(s) claimed by more than one open PR`,
    )
    for (const c of result.collisions) {
      const who = c.claims.map((cl) => `#${cl.pr} (\`${cl.file}\`)`).join(' and ')
      console.error(`  session-${c.number}: claimed by ${who}`)
    }
    console.error(
      `  One of these PRs must renumber. The next free number as of THIS run (considering ` +
        `merged history and every open PR's claim) is session-${result.suggestion} — rebase onto ` +
        'the freshest origin/main first, since another PR may claim it before you push.',
    )
    process.exit(1)
  }

  console.log(
    `check-session-log-pr-collision: OK — ${prs.length} open PR(s) checked, no session-log ` +
      `number is claimed by more than one; next free number is session-${result.suggestion}.`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
//
// Pure-function fixtures (no filesystem, no network) — the same shape as
// `check-mutation-reports.mjs`'s self-test. Wired as a prek hook keyed on
// this file and `pr-overlap.yml`, never as a pre-commit-gating invocation of
// `main()` itself: `main()` needs `gh pr list`, which is exactly the
// network dependency this guard must never impose on an offline commit.
const filesOf = (...names) => names.map((path) => ({ path }))

/**
 * One `gh pr list --json number,files,changedFiles` entry. `changedFiles`
 * defaults to `paths.length` — "no truncation" — so every EXISTING fixture
 * below stays a statement about collision logic, not about the truncation
 * guard; the truncation-specific cases pass an explicit, larger
 * `changedFiles` to simulate a `files` array `gh` cut short.
 *
 * @param {number} number
 * @param {string[]} paths
 * @param {number} [changedFiles]
 */
const pr = (number, paths, changedFiles = paths.length) => ({
  number,
  files: filesOf(...paths),
  changedFiles,
})

/**
 * The core collision/no-collision/suggestion fixtures (#3933's own shape,
 * and its immediate complements). Split out of `runSelfTest` purely to keep
 * that function's branching under the project's complexity ceiling — every
 * case here still runs unconditionally and reports through the same
 * `ok`/`fail` callbacks.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runCoreCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  // Case 1: the actual #3933 collision — two open PRs, two different
  // filenames, same embedded number.
  check(
    'the #3933 shape (two PRs, two filenames, one number) is caught',
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-tooling.md']),
        pr(102, ['docs/session-log/session-1319-pairing.md']),
      ],
      selfPr: 101,
      mergedNums: [1318],
    }),
    (r) =>
      r.verified &&
      r.collisions.length === 1 &&
      r.collisions[0].number === 1319 &&
      new Set(r.collisions[0].claims.map((c) => c.pr)).size === 2,
  )

  // Case 2: the same two PRs, but they picked DIFFERENT numbers — must
  // pass. The complement of case 1: proves the check does not fire on
  // ordinary parallel work, only on an actual shared number.
  check(
    'two PRs with distinct numbers pass, and the suggestion clears both',
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-tooling.md']),
        pr(102, ['docs/session-log/session-1320-pairing.md']),
      ],
      selfPr: 101,
      mergedNums: [1318],
    }),
    (r) => r.verified && r.collisions.length === 0 && r.suggestion === 1321,
  )

  // Case 3: a PR that adds no session-log file at all — must be a silent
  // no-op, not a distinct code path.
  check(
    'a PR touching no session-log file contributes nothing and does not break the check',
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-tooling.md']),
        pr(103, ['src/lib/search.ts', 'package.json']),
      ],
      selfPr: 101,
      mergedNums: [1318],
    }),
    (r) => r.verified && r.collisions.length === 0 && r.suggestion === 1320,
  )

  // Case 4: fail-closed — an EMPTY list must not read as "verified, no
  // collision" when a self-PR was expected in it. This is the exact "would
  // it pass if the API returned an empty list?" question #3933 asks.
  check(
    'an empty PR list fails verification when a self-PR is expected (not a silent pass)',
    analyze({ prs: [], selfPr: 101, mergedNums: [] }),
    (r) => !r.verified && /not present in the fetched/.test(r.reason),
  )

  // Case 4b: an empty list with NO self-PR expectation (a caller that
  // genuinely doesn't know its own PR number) is a DIFFERENT, legitimate
  // outcome — verified, trivially no collision. Distinct from 4 on purpose:
  // collapsing them would hide which guarantee is actually being relied on.
  check(
    'an empty PR list with no self-PR check is verified-empty, not a failure',
    analyze({ prs: [], selfPr: null, mergedNums: [42] }),
    (r) => r.verified && r.collisions.length === 0 && r.suggestion === 43,
  )

  // Case 6: one PR claiming two distinct numbers is not a cross-PR
  // collision — should not crash, should not falsely collide.
  check(
    'one PR claiming two distinct numbers is not a cross-PR collision',
    analyze({
      prs: [pr(101, ['docs/session-log/session-1319-a.md', 'docs/session-log/session-1320-b.md'])],
      selfPr: 101,
      mergedNums: [],
    }),
    (r) => r.verified && r.collisions.length === 0,
  )

  // Case 7: three-way collision — the guard must not stop after finding the
  // first pair.
  check(
    'a three-way collision on one number reports all three claimants',
    analyze({
      prs: [
        pr(1, ['docs/session-log/session-1400-a.md']),
        pr(2, ['docs/session-log/session-1400-b.md']),
        pr(3, ['docs/session-log/session-1400-c.md']),
      ],
      selfPr: 1,
      mergedNums: [],
    }),
    (r) => r.verified && r.collisions.length === 1 && r.collisions[0].claims.length === 3,
  )

  // Case 8: the suggestion must clear merged history even when no open PR
  // comes anywhere near it — the "considers merged history AND every open
  // claim" requirement, isolated from the collision logic itself.
  check(
    'the suggestion clears merged history even when no open claim is close to it',
    analyze({
      prs: [pr(1, ['docs/session-log/session-5-a.md'])],
      selfPr: 1,
      mergedNums: [1318, 1319],
    }),
    (r) => r.verified && r.suggestion === 1320,
  )
}

/**
 * Case 5: malformed payload shapes must all fail verification, never
 * silently coerce to "no PRs".
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runMalformedPayloadCases(ok, fail) {
  const shapes = [
    ['not an array', { oops: true }],
    ['null', null],
    ['a string', 'oops'],
    ['entry missing number', [{ files: [], changedFiles: 0 }]],
    ['entry missing files', [{ number: 1, changedFiles: 0 }]],
    ['entry with non-array files', [{ number: 1, files: 'not-an-array', changedFiles: 0 }]],
    ['entry missing changedFiles', [{ number: 1, files: [] }]],
    ['entry with non-integer changedFiles', [{ number: 1, files: [], changedFiles: '3' }]],
  ]
  for (const [name, bad] of shapes) {
    const r = analyze({ prs: bad, selfPr: null, mergedNums: [] })
    if (!r.verified) ok(`malformed payload (${name}) fails verification, not a silent pass`)
    else
      fail(`malformed payload (${name}) fails verification, not a silent pass`, JSON.stringify(r))
  }
}

/**
 * The 100-files-per-PR truncation guard (`gh`'s `files` connection is
 * hard-capped there, silently, no matter what `--limit` asks for). Exercises
 * `changedFiles > files.length` directly, isolated from the collision logic
 * — a `pr()`-shaped fixture with `changedFiles` overridden past what its
 * (short, deliberately non-colliding) `files` array actually lists.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runTruncationCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  // A PR whose true file count exceeds what `files` lists must fail
  // verification — even though the visible slice shows no collision at
  // all. This is the exact "a session-log claim past the 100-file cutoff
  // is invisible" scenario: nothing about the VISIBLE files is wrong, so
  // only the changedFiles cross-check can catch it.
  check(
    'a PR whose files list is shorter than its changedFiles count is unverified, not a silent pass',
    analyze({
      prs: [pr(101, ['docs/session-log/session-1319-tooling.md'], /* changedFiles */ 150)],
      selfPr: 101,
      mergedNums: [],
    }),
    (r) => !r.verified && /truncated by gh's 100-file cap/.test(r.reason) && /#101/.test(r.reason),
  )

  // The boundary: changedFiles EQUAL to files.length (the ordinary case
  // every other fixture relies on, made explicit here) must NOT be flagged
  // as truncated — only a strict shortfall is.
  check(
    'changedFiles equal to files.length is NOT flagged as truncated',
    analyze({
      prs: [pr(101, ['docs/session-log/session-1319-tooling.md'], 1)],
      selfPr: 101,
      mergedNums: [],
    }),
    (r) => r.verified && r.collisions.length === 0,
  )

  // A collision hiding behind ONE truncated sibling and one honest claimant
  // must still surface as unverified overall, not silently report only the
  // honest half.
  check(
    'a truncated PR is caught even when another PR in the same payload collides honestly',
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-a.md'], 200),
        pr(102, ['docs/session-log/session-1400-b.md']),
      ],
      selfPr: 101,
      mergedNums: [],
    }),
    (r) => !r.verified && /truncated by gh's 100-file cap/.test(r.reason),
  )
}

/**
 * The top-level `gh pr list --limit N` truncation guard: a page exactly N
 * entries long is indistinguishable from one GitHub cut off at N, so
 * `--pr-limit N` makes hitting (or exceeding) that count unverified rather
 * than a silent "that's just how many PRs are open".
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runPrLimitCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  const twoPrs = [
    pr(1, ['docs/session-log/session-1-a.md']),
    pr(2, ['docs/session-log/session-2-a.md']),
  ]

  check(
    'a fetched list exactly as long as --pr-limit is unverified, not read as "that many PRs exist"',
    analyze({ prs: twoPrs, selfPr: 1, mergedNums: [], prLimit: 2 }),
    (r) => !r.verified && /meets or exceeds the requested --pr-limit/.test(r.reason),
  )

  check(
    'a fetched list SHORTER than --pr-limit passes normally',
    analyze({ prs: twoPrs, selfPr: 1, mergedNums: [], prLimit: 50 }),
    (r) => r.verified && r.collisions.length === 0,
  )

  check(
    'no --pr-limit given (prLimit: null) skips the check entirely, whatever the list length',
    analyze({ prs: twoPrs, selfPr: 1, mergedNums: [], prLimit: null }),
    (r) => r.verified,
  )
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  runCoreCases(ok, fail)
  runMalformedPayloadCases(ok, fail)
  runTruncationCases(ok, fail)
  runPrLimitCases(ok, fail)

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Entry-point check (#3373): realpath BOTH sides.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) runSelfTest()
  else main(argv)
}
