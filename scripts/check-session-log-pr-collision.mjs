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
// ─── Exit codes, and why "collision" is NOT 1 (#4431) ─────────────────────
//
// The first version of this script used 1 for "a collision was found". That
// aliases onto the exit code the NODE RUNTIME ITSELF produces for any
// uncaught failure — a missing module, a syntax error, a thrown exception,
// an OOM — none of which this script's own code ever chooses. It bit
// immediately, on this script's own PR: the CI job checks out the merge
// target (`base.sha`, deliberately — see `pr-overlap.yml`), the script did
// not exist on that base yet, node printed `MODULE_NOT_FOUND` and exited 1,
// and the workflow reported `a session-log number is claimed by more than
// one open PR`. A guard that had never executed a single line reported a
// confident, false finding. That is the same fail-open class #3933 is
// about, pointed the other way: a crash reported as evidence.
//
// So the codes are chosen to be DISJOINT from the runtime's own. Node
// reserves 1–14 for itself (1 uncaught fatal exception, 2 unused/reserved
// by bash, 3–10 internal parse/eval/runtime failures, 12–14) and 128+N for
// signal deaths; POSIX shells add 126 (found but not executable) and 127
// (not found). `EXIT_COLLISION = 20` sits outside every one of those
// ranges, so no runtime, kernel or shell failure can synthesize it — only
// the one `process.exit(EXIT_COLLISION)` below can.
//
//   0  EXIT_VERIFIED_CLEAN    verified, and no number is doubly claimed
//   20 EXIT_COLLISION         verified, and a real collision was found
//   2  EXIT_COULD_NOT_VERIFY  this script decided it cannot vouch for the
//                             answer (bad usage, malformed payload,
//                             truncated files list or PR page, self-PR
//                             missing from the fetched list, an unexpected
//                             throw) — or a `--self-test` failure
//   anything else             NOT this script's doing: node crashed, the
//                             file was missing, a signal killed it. The
//                             caller must classify it as "could not
//                             verify", never as a finding.
//
// ─── The verdict line — a second, independent channel ─────────────────────
//
// An exit code is one integer travelling through a pipeline, a `tee`, a
// `PIPESTATUS` read and a shell `if`; the first version of the CI step
// already lost it once to a trailing `|| true` overwriting `PIPESTATUS`.
// So every terminal path also writes a machine-readable verdict as its LAST
// output, with `writeSync` (synchronous on every platform, unlike a piped
// `console.log`, so the bytes are on the wire before `process.exit`):
//
//   SESSION_LOG_PR_COLLISION_VERDICT=CLEAN
//   SESSION_LOG_PR_COLLISION_VERDICT=COLLISION
//   SESSION_LOG_PR_COLLISION_VERDICT=UNVERIFIED
//
// The caller must require the exit code and the verdict line to AGREE
// before believing either (`pr-overlap.yml`'s step does). A crash produces
// no verdict line at all, so it can never be mistaken for a finding even if
// its exit code somehow arrived as 20; and a verdict line without the
// matching code is equally distrusted. Both channels have to be right, and
// only the two anticipated pairs — (0, CLEAN) and (20, COLLISION) — are
// believed. Everything else is "could not verify", by construction rather
// than by enumeration.

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

export const LOG_DIR = 'docs/session-log'
// `[^/\n]+` rather than `[^/]+`: a JS character class DOES match `\n`, and a
// git path may legally contain one. A path carrying an embedded newline
// would otherwise be echoed into the collision report as two lines, one of
// which an author controls — and the verdict channel below is line-oriented.
// Excluding it here means no path this script ever prints can forge a line.
const SESSION_FILE_RE = /^docs\/session-log\/session-(\d+)-[^/\n]+\.md$/

/** See the exit-code table in this file's header (#4431). */
export const EXIT_VERIFIED_CLEAN = 0
export const EXIT_COULD_NOT_VERIFY = 2
export const EXIT_COLLISION = 20

export const VERDICT_PREFIX = 'SESSION_LOG_PR_COLLISION_VERDICT='

/**
 * Write the machine-readable verdict as the process's last output and exit.
 * `writeSync(1, …)` rather than `console.log`: writes to a PIPE are
 * asynchronous on some platforms, and `process.exit` does not flush them —
 * the one line the caller keys its whole decision on must not be the line
 * that gets dropped. Every terminal path in `main()` goes through here, so
 * "no verdict line" means precisely "this script did not reach a verdict",
 * which is exactly what a crash is.
 *
 * @param {'CLEAN'|'COLLISION'|'UNVERIFIED'} verdict
 * @param {number} code
 * @returns {never}
 */
function finish(verdict, code) {
  writeSync(1, `${VERDICT_PREFIX}${verdict}\n`)
  process.exit(code)
}

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
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
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
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
  }

  let mergedNums
  try {
    mergedNums = readMergedNums(args.mergedNums)
  } catch (err) {
    console.error(
      `::error::check-session-log-pr-collision: could not read --merged-nums ${args.mergedNums}: ${err.message}`,
    )
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
  }

  const result = analyze({ prs, selfPr: args.selfPr, mergedNums, prLimit: args.prLimit })

  if (!result.verified) {
    console.error(`::error::check-session-log-pr-collision: could not verify — ${result.reason}`)
    console.error(
      'An unverifiable open-PR dataset is a FAILURE here, not a pass (#3933): an empty or ' +
        'malformed result is absence of evidence, never evidence of safety.',
    )
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
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
    finish('COLLISION', EXIT_COLLISION)
  }

  console.log(
    `check-session-log-pr-collision: OK — ${prs.length} open PR(s) checked, no session-log ` +
      `number is claimed by more than one; next free number is session-${result.suggestion}.`,
  )
  finish('CLEAN', EXIT_VERIFIED_CLEAN)
}

/**
 * `main()` under a catch-all, so an unanticipated throw leaves the SAME
 * unambiguous trace as every other refusal — `UNVERIFIED` plus exit 2 —
 * instead of node's bare exit 1 with no verdict. This is a courtesy to the
 * reader, NOT the mechanism: the caller's rule (exit code and verdict line
 * must agree, and only two pairs are believed) already classifies a bare
 * crash as "could not verify" whether or not this handler ever runs, which
 * is what keeps a crash INSIDE this handler from mattering either.
 *
 * @param {string[]} argv
 */
function mainGuarded(argv) {
  try {
    main(argv)
  } catch (err) {
    console.error(
      `::error::check-session-log-pr-collision: unexpected internal failure — ${err?.stack ?? err}`,
    )
    console.error(
      'A crash is a failure to verify, never a finding: this run checked nothing (#4431).',
    )
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
  }
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

// ---------------------------------------------------------------------------
// self-test, part 2: the PROCESS and the literal CI step shell (#4431)
// ---------------------------------------------------------------------------
//
// Everything above tests `analyze()`, a pure function. #4431 was not in
// `analyze()`: it was in the mapping from process outcome to CI verdict, and
// it survived review because the review traced the script's three INTENTIONAL
// exits and never considered the runtime's own. Reading the workflow YAML is
// what allowed that. So this half runs the real thing — `node` on the real
// script, then the workflow step's bytes extracted verbatim from
// `pr-overlap.yml` — once per outcome, asserting the outcomes stay DISTINCT:
// a real collision, a clean board, a refusal to verify, a crash, and the
// guard being absent (introduced vs. deleted). Still no network: the only
// subprocesses are `node` and `bash` against fixtures in a temp directory.

const STEP_BEGIN = '# --- BEGIN session-log-pr-collision step shell'
const STEP_END = '# --- END session-log-pr-collision step shell'

/**
 * The workflow step's shell, lifted out of `pr-overlap.yml` between its
 * marker comments and de-indented back to column 0. Marker comments rather
 * than a YAML parse: the markers live INSIDE the block scalar, so this
 * survives any amount of restructuring around the step, and there is no
 * second copy of the shell to drift from the one CI actually runs.
 *
 * @param {string} workflowPath
 */
export function extractStepShell(workflowPath) {
  const lines = readFileSync(workflowPath, 'utf8').split('\n')
  const begin = lines.findIndex((l) => l.includes(STEP_BEGIN))
  const end = lines.findIndex((l) => l.includes(STEP_END))
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error(
      `could not extract the step shell from ${workflowPath}: BEGIN at ${begin}, END at ${end}. ` +
        'The marker comments in the run: block are what makes the CI step testable — restore them.',
    )
  }
  const body = lines.slice(begin + 1, end)
  const indents = body.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
  const strip = indents.length > 0 ? Math.min(...indents) : 0
  return body.map((l) => l.slice(strip)).join('\n')
}

/** @param {string[]} names */
const jsonPrs = (...entries) => JSON.stringify(entries)

/**
 * Every process-level fixture the cases below share. Each returns the
 * `prs.json` payload for one scenario; `SELF_PR` is 101 throughout.
 */
const SELF_PR = 101
const GUARD_PATH_IN_PRS = 'scripts/check-session-log-pr-collision.mjs'
const PAYLOADS = {
  collision: jsonPrs(
    pr(SELF_PR, ['docs/session-log/session-1319-tooling.md']),
    pr(102, ['docs/session-log/session-1319-pairing.md']),
  ),
  clean: jsonPrs(
    pr(SELF_PR, ['docs/session-log/session-1319-tooling.md']),
    pr(102, ['docs/session-log/session-1320-pairing.md']),
  ),
  // The self PR is missing from the list — the guard's own refusal path.
  unverifiable: jsonPrs(pr(102, ['docs/session-log/session-1320-pairing.md'])),
  // Absence discriminator fixtures: this PR adds the guard / does not / its
  // own file list is truncated / it is not in the payload at all.
  selfAddsGuard: jsonPrs(pr(SELF_PR, [GUARD_PATH_IN_PRS, 'prek.toml'])),
  selfLacksGuard: jsonPrs(pr(SELF_PR, ['src/lib/search.ts'])),
  selfTruncated: jsonPrs(pr(SELF_PR, [GUARD_PATH_IN_PRS], 250)),
  selfAbsent: jsonPrs(pr(102, ['src/lib/search.ts'])),
}

/**
 * Run the real guard as a subprocess and report `(code, verdictLine)`.
 *
 * @param {string} dir
 * @param {string} guardPath
 */
function runGuard(dir, guardPath) {
  const r = spawnSync(
    process.execPath,
    [
      guardPath,
      '--prs',
      'prs.json',
      '--self-pr',
      String(SELF_PR),
      '--merged-nums',
      'merged-nums.txt',
      '--pr-limit',
      '100',
    ],
    { cwd: dir, encoding: 'utf8' },
  )
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const verdicts = (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith(VERDICT_PREFIX))
    .map((l) => l.slice(VERDICT_PREFIX.length))
  return { code: r.status, verdict: verdicts.at(-1) ?? null, out }
}

/**
 * Run the extracted CI step shell exactly as GitHub Actions would
 * (`bash -e <file>`, which is the default `shell:` for a `run:` block).
 *
 * @param {string} dir
 * @param {string} stepPath
 * @param {string} guardScript
 */
function runStep(dir, stepPath, guardScript) {
  const r = spawnSync('bash', ['-e', stepPath], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PR_NUMBER: String(SELF_PR),
      PR_LIST_LIMIT: '100',
      GUARD_SCRIPT: guardScript,
      PRS_JSON: 'prs.json',
      MERGED_NUMS: 'merged-nums.txt',
      GITHUB_STEP_SUMMARY: `${dir}/summary.md`,
    },
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * The process/step half of the self-test.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runProcessCases(ok, fail) {
  const dir = mkdtempSync(join(tmpdir(), 'session-log-pr-collision-'))
  try {
    runProcessCasesIn(dir, ok, fail)
  } catch (err) {
    // A throw here (most likely: the step-shell markers went missing from
    // `pr-overlap.yml`) is a self-test FAILURE, not a crash — otherwise the
    // half of this suite that tests the CI step could silently stop running.
    fail('the CI step shell could be extracted and exercised', String(err?.message ?? err))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * @param {string} dir
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runProcessCasesIn(dir, ok, fail) {
  const check = (name, actual, predicate) => {
    if (predicate(actual)) ok(name)
    else fail(name, JSON.stringify(actual))
  }

  const selfPath = realpathSync(import.meta.filename)
  const repoRoot = dirname(dirname(selfPath))
  const workflow = join(repoRoot, '.github', 'workflows', 'pr-overlap.yml')

  const stepPath = join(dir, 'step.sh')
  writeFileSync(stepPath, extractStepShell(workflow))
  writeFileSync(join(dir, 'merged-nums.txt'), '1318\n')

  // The guard under test is a COPY, never the checked-in file: one of the
  // cases below deliberately breaks it, and mutating the real file would
  // leave a window in which the tree holds a sabotaged guard.
  const guard = join(dir, 'guard.mjs')
  copyFileSync(selfPath, guard)
  const brokenGuard = join(dir, 'broken-guard.mjs')
  writeFileSync(brokenGuard, `${readFileSync(selfPath, 'utf8')}\nthis is not ( valid javascript\n`)

  const payload = (which) => writeFileSync(join(dir, 'prs.json'), PAYLOADS[which])

  // ── Outcome 1: a real collision. Exit 20 AND the COLLISION verdict, and
  // the step reports a collision. This is the ONLY input allowed to make the
  // step say the words "claimed by more than one open PR".
  payload('collision')
  check(
    'process: a real collision exits 20 with a COLLISION verdict',
    runGuard(dir, guard),
    (r) => r.code === EXIT_COLLISION && r.verdict === 'COLLISION',
  )
  check(
    'step: a real collision fails the job AND is reported as a collision',
    runStep(dir, stepPath, guard),
    (r) => r.code === 1 && /claimed by more than one open PR/.test(r.out),
  )

  // ── Outcome 2: a clean board. Exit 0 AND the CLEAN verdict.
  payload('clean')
  check(
    'process: a clean board exits 0 with a CLEAN verdict',
    runGuard(dir, guard),
    (r) => r.code === EXIT_VERIFIED_CLEAN && r.verdict === 'CLEAN',
  )
  check(
    'step: a clean board passes the job and reports "verified"',
    runStep(dir, stepPath, guard),
    (r) => r.code === 0 && /verified — no open PR shares/.test(r.out),
  )

  // ── Outcome 3: the guard RAN and refused to vouch for its input. Exit 2,
  // UNVERIFIED verdict, step fails — but as "could not verify", never as a
  // collision. Distinct from outcome 4: the guard reached a verdict here.
  payload('unverifiable')
  check(
    'process: a payload the guard will not vouch for exits 2 with an UNVERIFIED verdict',
    runGuard(dir, guard),
    (r) => r.code === EXIT_COULD_NOT_VERIFY && r.verdict === 'UNVERIFIED',
  )
  check(
    'step: an unverifiable payload fails as "could not verify", NOT as a collision',
    runStep(dir, stepPath, guard),
    (r) =>
      r.code === 1 && /could not verify/.test(r.out) && !/claimed by more than one/.test(r.out),
  )

  // ── Outcome 4: THE #4431 REGRESSION. A guard that cannot even parse exits
  // 1 — node's own code for every uncaught failure — and emits NO verdict.
  // Under the old scheme 1 meant "collision" and this crash was announced as
  // a confirmed finding. The payload here is deliberately the CLEAN one, so
  // nothing about the data could justify a collision report.
  payload('clean')
  check(
    'process: a guard with a syntax error exits 1 and emits NO verdict line',
    runGuard(dir, brokenGuard),
    (r) => r.code === 1 && r.verdict === null,
  )
  check(
    'step: a crashed guard is reported as "could not verify", NEVER as a collision (#4431)',
    runStep(dir, stepPath, brokenGuard),
    (r) =>
      r.code === 1 &&
      /could not verify \(exit=1, verdict=<none>\)/.test(r.out) &&
      !/claimed by more than one/.test(r.out),
  )

  // ── Outcome 5: the two channels must AGREE. A stub that prints the CLEAN
  // verdict but exits non-zero, and one that exits 0 with no verdict at all,
  // are both "could not verify" — neither half is trusted alone.
  const liar = join(dir, 'liar.mjs')
  writeFileSync(liar, `console.log('${VERDICT_PREFIX}CLEAN')\nprocess.exit(7)\n`)
  check(
    'step: a CLEAN verdict with a non-zero exit is distrusted, not read as clean',
    runStep(dir, stepPath, liar),
    (r) => r.code === 1 && /could not verify \(exit=7, verdict=CLEAN\)/.test(r.out),
  )
  const mute = join(dir, 'mute.mjs')
  writeFileSync(mute, "console.log('nothing to see here')\n")
  check(
    'step: exit 0 with no verdict line is distrusted, not read as clean',
    runStep(dir, stepPath, mute),
    (r) => r.code === 1 && /could not verify \(exit=0, verdict=<none>\)/.test(r.out),
  )

  // ── Outcome 6: the guard is ABSENT from the (base-branch) checkout, and
  // THIS PR is the one adding it. Warn and pass — and say "not run", never
  // "verified", so the summary cannot be mistaken for a check that happened.
  const missing = join(dir, 'does-not-exist.mjs')
  payload('selfAddsGuard')
  check(
    'step: guard absent + this PR adds it → passes with an explicit "NOT RUN" warning',
    runStep(dir, stepPath, GUARD_PATH_IN_PRS),
    (r) =>
      r.code === 0 &&
      /::warning::.*NOT RUN/.test(r.out) &&
      !/verified — no open PR shares/.test(r.out) &&
      !/claimed by more than one/.test(r.out),
  )

  // ── Outcome 7: absent, and this PR does NOT add it — someone deleted or
  // moved the guard. That is the fail-open #3933 is about: it must fail.
  payload('selfLacksGuard')
  check(
    'step: guard absent + this PR does not add it → fails (a deleted guard is not a pass)',
    runStep(dir, stepPath, GUARD_PATH_IN_PRS),
    (r) =>
      r.code === 1 && /missing from the base-branch checkout/.test(r.out) && /: NO\b/.test(r.out),
  )

  // ── Outcome 8: absent, and this PR's own file list is truncated by gh's
  // 100-file cap — the guard's path could be past the cutoff, so "this PR
  // adds it" is unknowable. Positive classification: unknowable fails.
  payload('selfTruncated')
  check(
    "step: guard absent + this PR's file list truncated → fails, not assumed to be the introducer",
    runStep(dir, stepPath, GUARD_PATH_IN_PRS),
    (r) => r.code === 1 && /TRUNCATED/.test(r.out),
  )

  // ── Outcome 9: absent, and this PR is not in the payload at all (a stale
  // or truncated `gh pr list`). Also unknowable, also fails.
  payload('selfAbsent')
  check(
    'step: guard absent + this PR missing from the payload → fails as UNKNOWN',
    runStep(dir, stepPath, GUARD_PATH_IN_PRS),
    (r) => r.code === 1 && /UNKNOWN/.test(r.out),
  )

  // ── Outcome 10: absent, and there is no payload to consult at all.
  rmSync(join(dir, 'prs.json'))
  check(
    'step: guard absent + no open-PR payload at all → fails as UNKNOWN',
    runStep(dir, stepPath, missing),
    (r) => r.code === 1 && /UNKNOWN/.test(r.out),
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
  runProcessCases(ok, fail)

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    // Deliberately NO verdict line: the verdict channel belongs to the check
    // mode. A caller that wired `--self-test` in by mistake sees a missing
    // verdict and classifies it as "could not verify" — fail-closed.
    process.exit(EXIT_COULD_NOT_VERIFY)
  }
  console.log('self-test: all assertions passed')
}

// Entry-point check (#3373): realpath BOTH sides.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) runSelfTest()
  else mainGuarded(argv)
}
