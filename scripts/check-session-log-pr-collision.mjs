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
// ─── What counts as a CLAIM: a file that is NEW to the merge target ───────
//
// `gh pr list --json files` returns every changed file of a PR regardless of
// change type — ADDED, MODIFIED or deleted. The per-file objects it returns
// carry `path`, `additions` and `deletions` and no status field at all
// (checked against the live API, and `gh` offers no sub-field selection to
// ask for one), so "this PR touched a path carrying session number N" is
// not "this PR claims N" — and reading it as such is a false-positive
// machine on this repository specifically. `docs/session-log/` carries 15
// files numbered session-1000, 8 numbered session-1203 and 8 numbered
// session-1001 (the lexicographic-`ls` accident
// `check-session-log-numbering.sh`'s header describes), and 30 of the last
// 300 commits MODIFY an already-merged entry — a docs-lint sweep, a link
// fix, a correction, a stacked branch. Two of those open at once would have
// been reported here as `session-1000: claimed by #A and #B`, about a file
// that has been on `main` for months, that neither PR created, and that
// already shares its number with fourteen others.
// `check-session-log-numbering.sh` grandfathers exactly those ("only a
// STAGED addition can fail"); this guard has to draw the same line, and the
// line it draws is:
//
//   A CLAIM IS A SESSION-LOG PATH THAT IS NOT ALREADY ON THE MERGE TARGET.
//
// The merge target's own file list arrives via `--merged-paths` (below),
// listed from the base checkout — trusted data, not PR-controlled. A
// session-log path already on the base is being modified or deleted, never
// claimed; a path that is not is a new file, whatever else the PR does to
// it. That is an exact added-vs-modified discriminator, which is why it is
// used in preference to the per-file `additions`/`deletions` counts: a
// modification that only appends lines also has `deletions: 0`, so those
// counts cannot tell an addition from an edit.
//
// ─── A RENAME needs one extra fact, and `gh pr list` does not carry it ─────
//
// GitHub reports a rename as a SINGLE entry at the NEW path with no trace
// of the old one, and `gh pr list --json files` returns only `path`,
// `additions` and `deletions` per entry — no `status`, no previous name —
// with no sub-field selection available to ask for more. Verified against
// this repo's own PR #4416, which renames four files: `changedFiles` 16,
// `files` 16 entries, every one at its NEW path, not one old path among
// them. So on that payload alone `session-1000-typo.md` →
// `session-1000-fixed.md` is indistinguishable from a new file bearing an
// already-merged number, and lands as a hard STALE CLAIM whose remedy
// ("rebase and renumber") is wrong for it: nothing about the branch is
// stale and no number is actually duplicated (#4431 review note 1).
//
// An earlier version of this header called that shape unfixable and cited
// zero historical renames under `docs/session-log`. That count is right for
// `main` (squash merges flatten them) and WRONG for the repository: seven
// exist across all refs, and every one is a RENUMBER —
// `session-1314-tag-inheritance-convergence.md` →
// `session-1316-tag-inheritance-convergence.md` and friends — i.e. this
// guard's OWN prescribed remedy, performed on a file already on the merge
// target. So the shape is not hypothetical here.
//
// The REST endpoint does carry the missing fact: `gh api
// repos/<o>/<r>/pulls/<n>/files` returns `status: "renamed"` and
// `previous_filename` (same PR, same verification). `pr-overlap.yml`
// therefore re-fetches THIS PR's file list over REST on every run and
// splices `previousPath` in, and `claimsByNumber` below exempts an entry
// POSITIVELY — only when `previousPath` is a string, is itself already on
// the merge target, AND parses to the SAME session number. A renumber
// (`session-1314-x.md` → `session-1316-x.md`, all seven of the real ones)
// is still a claim on 1316, because it is one; a rename whose previous path
// is not on the merge target is still a claim, because this run cannot see
// what it came from.
//
// Scoped to the SELF PR, exactly like the truncation split below: another
// PR's rename is only a board warning here and is exempted on ITS OWN run,
// where its own re-fetch applies. If the re-fetch does not reach a run at
// all (rate limit, network, an older workflow replay), the entry keeps the
// `gh pr list` shape, `previousPath` is absent, and the behaviour is the
// pre-fix one — a false stale claim, never a false pass — with the finding's
// own text now naming the rename case instead of only "renumber".
//
// ─── Which guard owns which case ──────────────────────────────────────────
//
//   * A NEW number claimed by two open PRs — the #3933 shape. ONLY this
//     guard can see it: no branch's checkout contains a sibling PR's
//     commits. Reported below as a COLLISION.
//   * A new file whose number is ALREADY ON THE MERGE TARGET.
//     `check-session-log-numbering.sh` check 1 owns this at the moment the
//     file is committed, against `origin/main` as it stood THEN — and it
//     never re-checks, because it only ever examines STAGED ADDITIONS. Once
//     the adding commit is behind you, a sibling PR merging that number
//     under your still-open PR is invisible to it forever; that is exactly
//     the #3690 "two session-1281 files" shape, and the reason a green
//     local guard is not evidence for an open PR. This guard re-checks it
//     on every CI run against a base that is fresh at that moment, and
//     reports it below as a STALE CLAIM. The two overlap deliberately at
//     the addition commit; only this one covers everything after it.
//   * Anything about a file that ALREADY EXISTS on the merge target — an
//     inherited duplicate number, an edit, a deletion. NEITHER guard
//     reports it. History is history.
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
//   2. the fetched list doesn't EXCEED the caller's own `--pr-limit N` — the
//      intended cap on how many open PRs this check is willing to trust in
//      one run. An earlier version compared against the SAME number `gh pr
//      list --limit N` itself was called with, so a page exactly N long was
//      indistinguishable from one `gh` truncated at N and was refused
//      outright — which put the refusal exactly ON the cliff: at precisely N
//      open PRs, EVERY PR's run of this job refused, with no individual
//      author able to clear it (#4431 review note 4). The caller now asks
//      `gh` for `N+1` while still passing `--pr-limit N` here, so a genuine
//      page of N is fetched in full with no ambiguity, and only a list that
//      actually reaches N+1 — proof an (N+1)th PR exists beyond the intended
//      cap — is refused; and
//   3. (when `--self-pr` is given, which the real CI invocation always
//      does) the PR running this check is ITSELF present in the fetched
//      list — the cheapest self-consistency check available: if `gh pr
//      list` silently returned an empty, truncated, or stale result, the
//      one PR guaranteed to be open (this one) will be missing from it,
//      and that is caught here before the empty/short list is ever read as
//      "no other PR is open"; and
//   4. THIS PR's OWN `files` array is not itself truncated — `gh`'s `files`
//      field is a GitHub API connection HARD-CAPPED at 100 entries per PR
//      regardless of `--limit`, silently, with no error and no flag in the
//      JSON it returns. `changedFiles` (the PR's true total file count,
//      requested alongside `files`) is what exposes this: if
//      `changedFiles > files.length`, some of that PR's changed files —
//      possibly including a `session-NNNN-*.md` this script would otherwise
//      never see — are missing from the payload.
// Anything outside that allow-list is `verified: false`, and `main()` exits
// 2 (a failure to verify) rather than 0 (verified clean) — see the exit-code
// table in the usage comment below. An unrecognised state is a failure to
// verify, never a pass.
//
// ─── …and why ANOTHER PR's truncated file list is a WARNING, not a refusal ─
//
// Point 4 above is deliberately scoped to the SELF PR. The first version of
// this script refused to verify whenever ANY entry's file list was
// truncated, which means a single open 100+-file PR turns this job red on
// EVERY open PR until it lands — permanent, and unactionable for everyone
// reading it, since they cannot shrink somebody else's PR. That is precisely
// the "permanent unactionable red ... turns a gate into something people
// learn to bypass" `pr-overlap.yml`'s own header argues against, and a gate
// that is routinely bypassed protects nothing.
//
// Scoping it to the self PR keeps the fail-closed property exactly where it
// is actionable and loses no coverage: a truncated PR fails closed on ITS
// OWN run of this same job, where the author who can act on it is the one
// reading the failure. So the number hidden past #X's 100-file cutoff still
// blocks #X — it just no longer blocks #Y, #Z and everyone else. What the
// other PRs get instead is a `::warning::` naming #X and saying plainly
// that a collision WITH #X could not be ruled out, which is the truthful
// statement; silence would not be.
//
// Usage:
//   node scripts/check-session-log-pr-collision.mjs \
//     --prs prs.json --self-pr <n> --merged-paths merged-paths.txt \
//     [--pr-limit <n>]
//   node scripts/check-session-log-pr-collision.mjs --self-test
//
// `--prs` takes the body of
// `gh pr list --state open --json number,files,changedFiles` — every open
// PR, this one included (that is what `--self-pr` verifies).
//
// `--pr-limit` takes the INTENDED cap on open PRs (100) — ONE LESS than the
// `gh pr list --limit` the caller actually requests (#4431 review note 4:
// requesting the same number for both put every PR's run into permanent
// refusal at exactly 100 open PRs, with nobody able to clear it). Omitted
// entirely, that specific check is skipped — the CI caller always passes it;
// it's optional here only so ad-hoc/self-test invocations aren't forced to
// fabricate a limit that means nothing to them.
//
// `--merged-paths` takes the newline-separated file list of the merge
// target's `docs/session-log/` (`git ls-tree -r --name-only <base-sha> --
// docs/session-log`). It is REQUIRED, not optional: it is what separates a
// claim from an edit (above), so without it every touched session log would
// read as a new claim — the exact false positive this flag exists to
// prevent. It also feeds the "next free number" suggestion, so the guard's
// own remedy cannot recreate the collision it just reported.
//
// ─── The suggestion, and agreeing with the OTHER guard about "next free" ──
//
// The suggestion has to be a number `check-session-log-numbering.sh` would
// itself accept, or the guard's remedy fails the other guard. That one
// accepts `(max, max+GAP_BOUND]` (#3929's bounded window) where `max` is
// `existing_max`, taken over `HEAD ∪ origin/main` — the BRANCH as well as
// the merge target. Both halves of that matter, and an earlier version of
// this script got the second one wrong (#4431 review note 2):
//
//   * WIDTH. `max(everything) + 1` is not it: one open PR carrying a wild
//     number (`session-9999`) would poison the suggestion into a value that
//     guard's check 2 rejects on sight. Only numbers inside the window are
//     ever offered.
//   * ORIGIN. The window does not start at the MERGE TARGET's max; it
//     starts at the max of the merge target AND the branch. A branch that
//     has already committed a session number above the target's max — a
//     multi-entry PR, or one whose earlier entry is still unmerged, and
//     especially one with a gap (target max 1404, branch holding 1420) —
//     makes `mergedMax + 1` land BELOW that guard's `expected`, exactly
//     where its check 2 rejects it. So the origin used here is
//     `max(mergedMax, the SELF PR's own claimed numbers)`, which is this
//     script's view of the same union: the self PR's claims are precisely
//     the session numbers its branch carries that the merge target does
//     not. Other PRs' claims are deliberately NOT in the origin (they are
//     not in anyone else's `HEAD`) — they are only skipped over inside the
//     window, which is what keeps the `session-9999` case from poisoning it.
//
// The window is then `(origin, origin + GAP_BOUND]`, with `GAP_BOUND`
// mirrored from that script and pinned equal to it by this script's own
// self-test — which also re-implements that guard's `expected`/`max_allowed`
// arithmetic and asserts the suggestion lands inside it, so the ORIGIN is
// pinned now and not only the width. The first number in the window that no
// open PR has claimed is offered; if every number in it is claimed (more
// parallel session-log PRs than the window is wide), none is offered at all
// rather than one the other guard would reject.
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
 * The sibling guard whose notion of "next free number" this script's
 * `suggestion` must agree with, and the width of the window it accepts
 * (`(max, max+GAP_BOUND]`, #3929). Mirrored rather than imported — that
 * script is bash — and pinned equal to the value there by this script's own
 * self-test, so the two cannot silently drift into recommending numbers the
 * other rejects.
 */
export const NUMBERING_GUARD = 'scripts/check-session-log-numbering.sh'
export const GAP_BOUND = 10

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
 * Every byte this guard emits on a path that ends in `finish()`.
 *
 * `writeSync`, never `console.error`/`console.log` (#4452 item 3). Node's
 * writes to a PIPE are ASYNCHRONOUS and `process.exit` does not flush them,
 * and the CI step runs this guard under `2>&1 | tee collision.log` — so the
 * REASON text queued as async writes can be dropped while `finish()`'s own
 * synchronous verdict line survives. `reportFindings` was moved to
 * `writeSync` for exactly that hazard; the refusal, warning, OK and
 * crash-handler paths were left behind, which is how the step can print
 * "its own message is above" with nothing above it.
 *
 * One `writeSync` call per emission, not one per line: N async gaps would be
 * N truncation points instead of one, and this matches `finish()`'s own
 * single-syscall shape.
 *
 * Diagnostics only — the exit code and the verdict line are unaffected by
 * which mechanism writes these bytes. What is affected is whether a red job
 * carries the explanation for why it is red.
 *
 * @param {string} text
 */
function emitErr(text) {
  writeSync(2, `${text}\n`)
}

/** As `emitErr`, on stdout — where `finish()`'s verdict line also goes. */
function emitOut(text) {
  writeSync(1, `${text}\n`)
}

/**
 * The session number embedded in a `docs/session-log/session-NNN-*.md`
 * path, or `null` if the path doesn't match that shape at all (a PR that
 * touches some OTHER file under `docs/session-log/`, or no session-log file
 * at all, contributes nothing here — that is a legitimate, unremarkable
 * outcome, not a problem).
 *
 * `Number(m[1])` is a DELIBERATE identity choice, not an incidental one
 * (#4431 review note 6): it normalises zero-padding, so
 * `session-044-mobile-a11y-216.md` and a hypothetical `session-44-*.md`
 * parse to the same number and would be treated as one identity — a
 * collision, or one file "claiming" what the other already holds — rather
 * than as two distinct numbers that merely look similar. Harmless under
 * today's numbering (every filename in this repo's history is unpadded), and
 * intentionally left this way rather than keyed on the raw capture string:
 * `check-session-log-numbering.sh`'s own `taken` set is built with
 * `sort -n -u`, whose `-n` makes `-u`'s dedup NUMERIC too, so that guard
 * already treats "044" and "44" as one identity. Keying this script on the
 * unnormalised string instead would make the two guards disagree about what
 * a duplicate even is — worse than the harmless-today equivalence.
 *
 * @param {string} path
 */
export function sessionNumberOf(path) {
  const m = SESSION_FILE_RE.exec(String(path))
  return m ? Number(m[1]) : null
}

/**
 * The one shape a `gh pr list --json files` entry is allowed to take: a bare
 * string, or an object carrying a string `path` and, optionally, a string or
 * null `previousPath`. `fileEntriesOf()` and `shapeProblem()` both call this
 * — a SINGLE predicate, not two, because two independent notions of "a
 * usable file entry" is exactly how #4431 review round 4's note 1 happened:
 * the path reader's `.filter(Boolean)` quietly dropped a `path`-less entry
 * while `shapeProblem()` never looked inside `files` at all, so
 * `{additions: 3, deletions: 0}` passed validation and contributed zero paths
 * — a session-log claim made invisible rather than refused.
 *
 * `previousPath` is OPTIONAL: only `pr-overlap.yml`'s REST re-fetch supplies
 * it (`gh pr list --json files` has no such field — see this file's header).
 * When it IS present it must be a string or null, and that is checked here
 * rather than shrugged off, because a string value can turn a CLAIM into a
 * non-claim in `claimsByNumber()` below. An unrecognised shape reaching that
 * exemption would be a fail-OPEN, which is the one direction this script is
 * not allowed to fail in.
 *
 * @param {unknown} f
 */
function isUsableFileEntry(f) {
  if (typeof f === 'string') return true
  if (f === null || typeof f !== 'object') return false
  if (typeof f.path !== 'string') return false
  return (
    f.previousPath === undefined || f.previousPath === null || typeof f.previousPath === 'string'
  )
}

/**
 * The changed files of one `gh pr list --json number,files` entry,
 * normalised to `{path, previousPath}`. `previousPath` is `null` unless the
 * workflow's REST re-fetch supplied GitHub's own `previous_filename` for a
 * renamed entry (#4431 review note 1).
 *
 * @param {{files?: unknown[]}} pr
 */
function fileEntriesOf(pr) {
  return (pr?.files ?? []).map((f) =>
    typeof f === 'string'
      ? { path: f, previousPath: null }
      : {
          path: f?.path,
          previousPath: typeof f?.previousPath === 'string' ? f.previousPath : null,
        },
  )
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
    // #4431 review: an entry that IS an array can still hold a file object
    // with no usable path (e.g. `{additions, deletions}` with the `path`
    // field itself missing or non-string), or a `previousPath` of a type
    // this script did not anticipate — and `previousPath` is what the rename
    // exemption in `claimsByNumber()` keys on, so an unrecognised value
    // there could suppress a real claim. `fileEntriesOf()` reads exactly the
    // same predicate, so a shape it cannot turn into a usable entry is
    // refused here rather than silently contributing nothing to the
    // analysis.
    for (const [j, f] of pr.files.entries()) {
      if (!isUsableFileEntry(f)) {
        return (
          `entry ${i} (#${pr.number}) file ${j} has no usable "path" (or a "previousPath" ` +
          `that is neither a string nor null) (got ${JSON.stringify(f)})`
        )
      }
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
 * `pr-overlap.yml`'s own "List every open PR's changed files" step
 * (#4431 review round 4 notes 2/4) already tries to pre-empt this by
 * splicing in a `gh api .../pulls/<n>/files --paginate` re-fetch — the SAME
 * GitHub-computed list over the uncapped REST endpoint — for any entry it
 * finds truncated, BEFORE this script ever runs. That is best-effort: a
 * failed re-fetch (rate limit, network hiccup, a PR beyond even that
 * endpoint's own ceiling) leaves the entry exactly as truncated as `gh pr
 * list` returned it. This function, and the self/other split around it, is
 * what still catches that — the backstop the workflow's enhancement can
 * fall through to, not something the enhancement makes obsolete.
 *
 * @param {{number:number, files:unknown[], changedFiles:number}[]} prs
 */
function truncatedFilesPrs(prs) {
  return prs.filter((pr) => pr.changedFiles > pr.files.length)
}

/**
 * A `verified: false` result. Every refusal path returns the same shape, so
 * a caller reading `.collisions` / `.staleClaims` on an unverified result
 * sees empty findings rather than `undefined` — a refusal must never be
 * readable as a finding, in either direction.
 *
 * @param {string} reason
 */
function cannotVerify(reason) {
  return {
    verified: false,
    reason,
    warnings: [],
    collisions: [],
    staleClaims: [],
    suggestion: null,
  }
}

/**
 * The merge target's session-log files, indexed both ways: the exact path
 * set (what separates a modified file from a newly claimed one) and
 * number → the base paths already holding it (what makes a stale claim
 * reportable with the file it duplicates, rather than as a bare number).
 *
 * @param {string[]} mergedPaths
 */
function indexMergedPaths(mergedPaths) {
  const paths = new Set(mergedPaths.map(String))
  /** @type {Map<number, string[]>} */
  const byNumber = new Map()
  for (const path of paths) {
    const n = sessionNumberOf(path)
    if (n === null) continue
    if (!byNumber.has(n)) byNumber.set(n, [])
    byNumber.get(n).push(path)
  }
  return { paths, byNumber }
}

/**
 * number → every open-PR claim on it. A CLAIM is a session-log path that is
 * NOT already on the merge target: `gh` reports added, modified and deleted
 * files identically, so path presence on the base is what tells an addition
 * from an edit (see this file's header — without it, two PRs editing one of
 * the fifteen merged `session-1000-*.md` files read as a collision).
 *
 * Claims that name the EXACT SAME PATH collapse into one (#4431 review note
 * 2), regardless of how many PRs' `files` lists carry it. A PR stacked on
 * another open PR's branch (base = the sibling's branch, not yet retargeted
 * to `main`) contains the sibling's commits, so `gh pr list --json files`
 * reports the sibling's own new `session-NNNN-*.md` under BOTH PRs — not two
 * PRs independently choosing the same number, but one file seen twice
 * because one branch contains the other's history. Grouping by number alone
 * read that as a cross-PR collision and told the stacked author to
 * "renumber", which fixes nothing: the file is not duplicated, the
 * *ancestry* is. Two DIFFERENT paths sharing a number (the actual #3933
 * shape) still collide — only an identical path is folded away. The
 * representative `pr` recorded for a folded claim is the LOWEST PR number
 * that carries it, which is stable regardless of `gh pr list`'s own
 * ordering and — for the stacked case — is normally the sibling PR the file
 * actually belongs to.
 *
 * EVERY carrier is recorded too, in `prs` (#4431 review note 3), because the
 * representative alone loses the stacked CHILD. Folding to the lowest number
 * attributes the parent's file to the PARENT, so on the child's own run
 * `isSelfClaim()` said "not mine" about a genuine collision between that
 * file and a third PR's — downgrading it to a board warning and letting the
 * child go GREEN on a duplicate it would carry into the merge result. The
 * parent still failed closed, so nothing was silent; the child was simply
 * wrong. `prs` is what `isSelfClaim()` reads now, so any PR whose file list
 * carries the path owns the finding.
 *
 * An entry is also skipped when it is a same-number rename of a file already
 * on the merge target (`isSameNumberRename()` below, #4431 review note 1) —
 * that is a file MOVING, not a number being claimed.
 *
 * @param {{number:number, files:unknown[]}[]} prs
 * @param {Set<string>} mergedPathSet
 */
function claimsByNumber(prs, mergedPathSet) {
  /** @type {Map<number, Map<string, number[]>>} */
  const byNumberThenFile = new Map()
  for (const pr of prs) {
    for (const { path: file, previousPath } of fileEntriesOf(pr)) {
      const n = sessionNumberOf(file)
      if (n === null) continue
      if (mergedPathSet.has(file)) continue
      if (isSameNumberRename(n, previousPath, mergedPathSet)) continue
      if (!byNumberThenFile.has(n)) byNumberThenFile.set(n, new Map())
      const byFile = byNumberThenFile.get(n)
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file).push(Number(pr.number))
    }
  }
  /** @type {Map<number, {pr:number, prs:number[], file:string}[]>} */
  const claims = new Map()
  for (const [n, byFile] of byNumberThenFile) {
    claims.set(
      n,
      [...byFile.entries()].map(([file, prNumbers]) => {
        const carriers = [...new Set(prNumbers)].toSorted((a, b) => a - b)
        return { pr: carriers[0], prs: carriers, file }
      }),
    )
  }
  return claims
}

/**
 * Whether a changed file is a RENAME OF AN ALREADY-MERGED SESSION LOG THAT
 * KEEPS ITS NUMBER — the one shape that looks exactly like a new claim in
 * `gh pr list --json files` and is not one (#4431 review note 1; see this
 * file's header for why the payload cannot tell on its own, and where
 * `previousPath` comes from).
 *
 * Classified POSITIVELY, all three conditions required: the entry must
 * actually carry a string `previousPath` (absent means "this run does not
 * know", which stays a claim), that path must already be on the merge target
 * (a rename from somewhere this run cannot see stays a claim), and it must
 * parse to the SAME session number (a RENUMBER — `session-1314-x.md` →
 * `session-1316-x.md`, which is what all seven real renames under
 * `docs/session-log` in this repo's history are — genuinely claims the new
 * number, and must keep being reported as claiming it).
 *
 * @param {number} number
 * @param {string|null} previousPath
 * @param {Set<string>} mergedPathSet
 */
function isSameNumberRename(number, previousPath, mergedPathSet) {
  if (typeof previousPath !== 'string') return false
  if (!mergedPathSet.has(previousPath)) return false
  return sessionNumberOf(previousPath) === number
}

/**
 * One claim rendered for a human: the PR that represents the file, plus
 * every OTHER open PR whose `gh`-reported file list carries that exact path
 * (#4431 review note 3). A stacked child contains its parent's commits, so
 * both PRs report the parent's file and the two fold into one claim —
 * naming the carriers is what lets the child see why a finding it did not
 * author is nonetheless its problem: the child would carry the duplicate
 * into the merge result.
 *
 * @param {{pr:number, prs:number[], file:string}} claim
 */
function describeClaim(claim) {
  const others = claim.prs.filter((p) => p !== claim.pr)
  const also = others.length > 0 ? `, also carried by ${others.map((p) => `#${p}`).join(', ')}` : ''
  return `#${claim.pr} (\`${claim.file}\`${also})`
}

/**
 * The first number in `check-session-log-numbering.sh`'s OWN window that no
 * open PR has claimed, or `null` when every number in it is taken.
 *
 * The window is `(origin, origin + GAP_BOUND]`, and BOTH ends have to match
 * that guard (see this file's header). Its width is deliberately not
 * `max(everything) + 1`: that lets one open PR carrying `session-9999`
 * poison the suggestion into a number the other guard's check 2 rejects on
 * sight, so the guard's own remedy would fail the guard next to it. Its
 * ORIGIN is `max(the merge target's numbers, THE SELF PR'S OWN claimed
 * numbers)` and not the merge target's max alone (#4431 review note 2): that
 * guard computes `existing_max` over `HEAD ∪ origin/main`, so a branch
 * already carrying a number above the target's max — a multi-entry PR, or
 * one with a gap, say target max 1404 and branch holding 1420 — moves its
 * `expected` up with it, and a suggestion derived from the target alone
 * would land below `expected` and be rejected there. Other PRs' claims stay
 * OUT of the origin (they are in nobody else's `HEAD`); they are only
 * skipped over inside the window.
 *
 * @param {Map<number, unknown>} claims
 * @param {number[]} mergedNums
 * @param {number[]} selfClaimedNums
 */
function suggestNextFree(claims, mergedNums, selfClaimedNums = []) {
  const origin = Math.max(0, ...mergedNums, ...selfClaimedNums)
  for (let n = origin + 1; n <= origin + GAP_BOUND; n++) {
    if (!claims.has(n)) return n
  }
  return null
}

/**
 * The core analysis. Pure — no filesystem, no network — so the self-test
 * exercises exactly this and nothing about argument parsing or process
 * exit codes.
 *
 * @param {{prs: unknown, selfPr?: number|null, mergedPaths?: string[], prLimit?: number|null}} opts
 */
export function analyze({ prs, selfPr = null, mergedPaths = [], prLimit = null }) {
  const problem = shapeProblem(prs)
  if (problem) return cannotVerify(`malformed open-PR payload: ${problem}`)

  // `prLimit` is the INTENDED cap, and the caller fetches `prLimit + 1` (see
  // this file's header, point 2, #4431 review note 4) precisely so a genuine
  // page of exactly `prLimit` open PRs is fetched IN FULL and passes here —
  // the strict `>` is what keeps that page off the refusal, unlike the old
  // `>=` which fired on it every time. Only the (prLimit+1)th entry actually
  // arriving is proof there are more open PRs than this run is willing to
  // trust.
  //
  // This refusal IS the same "collective, unactionable red" shape as the
  // per-PR file cap below (#4431 review round 4, notes 2 and 4 together):
  // past the threshold, every open PR's run refuses at once, and no single
  // author can shrink the repo's total open-PR count. Deliberately left
  // as a refusal rather than raised or removed, for a reason distinct from
  // the file cap's: `PR_LIST_LIMIT` (100) is a SELF-IMPOSED defensive
  // ceiling, not a GitHub API limit — `gh pr list --limit N` paginates
  // internally for any N, so there is no hard wall here the way the
  // `files(first: 100)` connection is a wall. It is already 10x this
  // project's own stated open-PR pipeline cap (see `PR_LIST_LIMIT`'s own
  // comment in `pr-overlap.yml`), so clearing it needs an order-of-magnitude
  // surge past a limit this repo's own workflow already enforces elsewhere
  // — unlike the per-PR file cap, where a single 100+-file PR is "routine,
  // not exceptional" and has already happened (this file's header cites a
  // real 411-file one). Raising the number only moves the same cliff
  // further out without removing it; removing the check entirely
  // reintroduces the exact truncation-ambiguity #3933 is about, with no
  // signal left to tell "that's every open PR" from "that's the first N of
  // more". Kept as a refusal on that basis, not overlooked.
  //
  // What DID change (#4431 review note 5) is the message: the remedy it used
  // to offer ("raise the limit and re-run") is a repo edit, and the person
  // reading the failure is a PR author who cannot make it. It now says so —
  // whose action clears this, and that it is not specific to their PR — so
  // nobody spends a cycle looking for something to change on their branch.
  // The cliff itself is real and unaddressed here; it deserves a tracked
  // follow-up rather than living only in this comment.
  if (prLimit !== null && prs.length > prLimit) {
    return cannotVerify(
      `the fetched open-PR list has ${prs.length} entr${prs.length === 1 ? 'y' : 'ies'}, which ` +
        `exceeds the intended --pr-limit of ${prLimit}. That means there are MORE than ` +
        `${prLimit} open PRs right now, and a partial read of the board cannot be told apart ` +
        'from "that is just how many PRs are open", so it is refused rather than trusted. ' +
        // #4431 review note 5: the old wording ("raise the limit and re-run")
        // read as an instruction to the person seeing the failure, and it is
        // not one — the cap is a repo file, and past it EVERY open PR's run
        // refuses at once. Say plainly whose action clears it, so nobody
        // burns a cycle looking for something to change on their branch.
        'NOTHING ON THIS BRANCH CLEARS THIS, and it is not specific to this PR: past the cap ' +
        "every open PR's run of this check refuses. The cap is `PR_LIST_LIMIT` in " +
        '`.github/workflows/pr-overlap.yml`, so raising it — or bringing the open-PR count ' +
        'back under it — is a MAINTAINER action on the repository, not a change any single ' +
        'PR author can make. Report it rather than trying to fix it here.',
    )
  }

  if (selfPr !== null && !prs.some((p) => Number(p.number) === Number(selfPr))) {
    return cannotVerify(
      `PR #${selfPr} (the one running this check) is not present in the fetched ` +
        `open-PR list (${prs.length} entr${prs.length === 1 ? 'y' : 'ies'} returned). ` +
        'A list that omits the PR that is guaranteed to be open is an incomplete or ' +
        'stale read, not evidence of "no other PR is open".',
    )
  }

  // Truncation, split by WHOSE list it is (see this file's header): the self
  // PR's own truncated list is a refusal — the author reading this failure
  // is the one who can act on it — while another PR's is a warning naming
  // it, because failing here would make one oversized PR turn this job red
  // on every other open PR until it lands, and that PR fails closed on its
  // own run of this same job anyway.
  const truncated = truncatedFilesPrs(prs)
  const isSelf = (pr) => selfPr !== null && Number(pr.number) === Number(selfPr)
  if (truncated.some(isSelf)) {
    const self = truncated.find(isSelf)
    return cannotVerify(
      `this PR's own changed-file list (#${self.number}: ${self.files.length}/${self.changedFiles} ` +
        "files) is truncated by gh's 100-file cap — a session-log claim of its own past that " +
        'cutoff would be invisible to this check, so this PR cannot be read as "contributes ' +
        'nothing". This repo\'s large batch PRs make that cap routine, not exceptional, so ' +
        // #4431 review note 3: "split the PR" is not an offerable remedy here
        // — it is unactionable for the repo's dominant PR shape and was
        // never the point; the cap is on `gh pr list --json files`'s
        // `files(first: 100)` GraphQL connection specifically, not on the
        // PR's own diff. `gh api .../pulls/<n>/files --paginate` walks that
        // same data over REST pages instead and is not subject to the same
        // fixed cutoff, so it is the confirmation this message asks for
        // rather than a rewrite of this PR.
        'splitting it is not the fix. Confirm by hand instead: ' +
        `\`gh api repos/<owner>/<repo>/pulls/${self.number}/files --paginate --jq '.[].filename'\` ` +
        "walks gh's REST pagination rather than the capped GraphQL `files` field this check " +
        'reads, so it lists every changed path regardless of count; grep it for ' +
        `\`docs/session-log/\`, then re-run \`${NUMBERING_GUARD}\` locally to confirm the number ` +
        'is still free against the freshest origin/main.',
    )
  }
  const warnings = truncated.map(
    (pr) =>
      `open PR #${pr.number}'s changed-file list is truncated by gh's 100-file cap ` +
      `(${pr.files.length}/${pr.changedFiles} files), so a session-log claim of ITS OWN past ` +
      `that cutoff is invisible here: a collision with #${pr.number} could not be ruled out. ` +
      'Not a failure of this PR — #' +
      `${pr.number} fails closed on its own run of this check, where its author can act on it.`,
  )

  const merged = indexMergedPaths(mergedPaths)
  const claims = claimsByNumber(prs, merged.paths)

  const collisions = []
  const staleClaims = []
  for (const [number, entries] of claims) {
    const sorted = entries.toSorted((a, b) => a.pr - b.pr || a.file.localeCompare(b.file))
    if (new Set(entries.map((e) => e.pr)).size > 1) collisions.push({ number, claims: sorted })
    // A number already on the merge target, claimed by a NEW file: the
    // sibling-merged-under-you shape `check-session-log-numbering.sh` cannot
    // re-check once the adding commit is behind you (header, "Which guard
    // owns which case"). Independent of the collision above — a stale claim
    // needs only ONE open PR.
    const mergedHere = merged.byNumber.get(number)
    if (mergedHere) {
      staleClaims.push({ number, mergedPaths: mergedHere.toSorted(), claims: sorted })
    }
  }
  collisions.sort((a, b) => a.number - b.number)
  staleClaims.sort((a, b) => a.number - b.number)

  // #4431 review round 4, BLOCKING: a finding is only a FAILURE for the PR
  // running this check if that PR is one of the claimants. Before this
  // split, `main()` failed on `collisions.length + staleClaims.length > 0`
  // computed over the WHOLE board — so PR #A, a dependency bump touching no
  // session-log file at all, exited 20 (and printed "rebase onto
  // origin/main and renumber") whenever ANY two OTHER open PRs collided, or
  // even one OTHER PR held a stale claim. #A's author cannot rebase or
  // renumber a file that isn't theirs. This is the exact "a gate that is
  // routinely bypassed protects nothing" shape the header already argues
  // for the truncation case (`isSelf` above) — applied here one level up.
  //
  // With no `--self-pr` (an ad-hoc/self-test call, never the real CI
  // invocation — see `parseArgs`, which requires it), there is no "self" to
  // filter by, so nothing is downgraded: every finding stays a hard finding,
  // matching this function's behaviour before the split existed.
  // Reads `c.prs` — EVERY open PR whose file list carries that exact path —
  // not the folded representative `c.pr` (#4431 review note 3). A PR stacked
  // on another open PR's branch contains its commits, so the parent's
  // session-log file appears in the child's `gh`-reported file list too and
  // folds to the PARENT's (lower) number. Keying self-attribution on the
  // representative therefore told the CHILD "not your finding" about a
  // collision between the parent's file and a third PR's — a green check on
  // a duplicate the child would carry into the merge result. Keying it on
  // the carrier set makes it the finding of every PR that actually carries
  // the file, which for a stack is both of them.
  const isSelfClaim = (entries) =>
    selfPr !== null && entries.some((c) => c.prs.some((p) => Number(p) === Number(selfPr)))
  // The session numbers THIS PR's branch carries that the merge target does
  // not — this script's view of what `check-session-log-numbering.sh` sees
  // in `HEAD` but not in `origin/main`, and therefore the other half of the
  // suggestion window's origin (#4431 review note 2, `suggestNextFree`).
  const selfClaimedNums = [...claims.entries()]
    .filter(([, entries]) => isSelfClaim(entries))
    .map(([number]) => number)
  const selfCollisions =
    selfPr === null ? collisions : collisions.filter((c) => isSelfClaim(c.claims))
  const otherCollisions = selfPr === null ? [] : collisions.filter((c) => !isSelfClaim(c.claims))
  const selfStaleClaims =
    selfPr === null ? staleClaims : staleClaims.filter((s) => isSelfClaim(s.claims))
  const otherStaleClaims = selfPr === null ? [] : staleClaims.filter((s) => !isSelfClaim(s.claims))

  const boardWarnings = [
    ...otherCollisions.map((c) => {
      const who = c.claims.map(describeClaim).join(' and ')
      return (
        `session-${c.number} is claimed by more than one open PR, and THIS PR is not one of ` +
        `them — ${who}. Not a failure of this PR: each of those PRs fails closed on its own ` +
        'run of this check, where its author can act on it.'
      )
    }),
    ...otherStaleClaims.map((s) => {
      const who = s.claims.map(describeClaim).join(' and ')
      return (
        `session-${s.number} is already on the merge target and newly added by ${who}, none ` +
        'of which is this PR. Not a failure of this PR: each of those PRs fails closed on its ' +
        'own run of this check, where its author can act on it.'
      )
    }),
  ]

  return {
    verified: true,
    reason: null,
    warnings: [...warnings, ...boardWarnings],
    collisions: selfCollisions,
    staleClaims: selfStaleClaims,
    suggestion: suggestNextFree(claims, [...merged.byNumber.keys()], selfClaimedNums),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { prs: null, selfPr: null, mergedPaths: null, prLimit: null }
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
      case '--merged-paths': {
        args.mergedPaths = take()
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
  // Required, unlike the `--merged-nums` it replaces: the merge target's
  // file list is what separates a NEW session log from an edited one (see
  // this file's header). Missing, every touched session log would read as a
  // fresh claim and two PRs editing one of the fifteen merged
  // `session-1000-*.md` files would be reported as colliding — so its
  // absence cannot be allowed to degrade quietly into that behaviour.
  if (args.mergedPaths === null) throw new Error('--merged-paths is required')
  return args
}

/**
 * The merge target's `docs/session-log/` listing. Only the trailing newline
 * is stripped per line — a path is taken verbatim, because it has to match
 * the payload's own path byte for byte to be recognised as "already on the
 * base".
 *
 * @param {string} path
 */
function readMergedPaths(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((s) => s.replace(/\r$/, ''))
    .filter(Boolean)
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    emitErr(`check-session-log-pr-collision: ${err.message}`)
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
  }

  let prs
  try {
    prs = JSON.parse(readFileSync(args.prs, 'utf8'))
  } catch (err) {
    emitErr(
      `::error::check-session-log-pr-collision: could not read/parse --prs ${args.prs}: ${err.message}`,
    )
    emitErr(
      'Treated as UNVERIFIED, not as "no open PRs": an unreadable payload must never read as safety this check did not actually check (#3933).',
    )
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
  }

  let mergedPaths
  try {
    mergedPaths = readMergedPaths(args.mergedPaths)
  } catch (err) {
    emitErr(
      `::error::check-session-log-pr-collision: could not read --merged-paths ${args.mergedPaths}: ${err.message}`,
    )
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
  }

  const result = analyze({ prs, selfPr: args.selfPr, mergedPaths, prLimit: args.prLimit })

  if (!result.verified) {
    emitErr(`::error::check-session-log-pr-collision: could not verify — ${result.reason}`)
    emitErr(
      'An unverifiable open-PR dataset is a FAILURE here, not a pass (#3933): an empty or ' +
        'malformed result is absence of evidence, never evidence of safety.',
    )
    finish('UNVERIFIED', EXIT_COULD_NOT_VERIFY)
  }

  // Warnings are NOT findings and never change the verdict: they say what
  // this run could not see (another PR's truncated file list), which is a
  // different statement from "a number is doubly claimed".
  for (const w of result.warnings) {
    emitErr(`::warning::check-session-log-pr-collision: ${w}`)
  }

  if (result.collisions.length + result.staleClaims.length > 0) {
    reportFindings(result)
    finish('COLLISION', EXIT_COLLISION)
  }

  emitOut(
    `check-session-log-pr-collision: OK — ${prs.length} open PR(s) checked, no session-log ` +
      `number is newly claimed by more than one and none duplicates a number already on the ` +
      `merge target; ${nextFreeSentence(result.suggestion)}`,
  )
  finish('CLEAN', EXIT_VERIFIED_CLEAN)
}

/**
 * The remedy line, shared by every finding: a number the OTHER guard would
 * also accept, or an honest "none in the window" when parallel session-log
 * PRs have taken all of them (see `suggestNextFree`).
 *
 * @param {number|null} suggestion
 */
function nextFreeSentence(suggestion) {
  if (suggestion === null) {
    return (
      `no number in ${NUMBERING_GUARD}'s window (the ${GAP_BOUND} above the merge target's max) ` +
      'is free — every one is already claimed by an open PR, so rebase onto the freshest ' +
      'origin/main and re-derive it there rather than taking one from this run.'
    )
  }
  return `the next free number as of THIS run is session-${suggestion}.`
}

/**
 * The count of DISTINCT session-log numbers implicated by `result` — a
 * number that is both a cross-PR collision AND a stale claim (case 13:
 * two open PRs both add a file numbered session-1000, which is also already
 * on the merge target) is exactly ONE number, reported twice for two
 * different reasons, not two numbers. `result.collisions.length +
 * result.staleClaims.length` (#4431 review note 5) double-counts it — case
 * 13's own fixture printed "2 session-log number(s)" for the single number
 * 1000.
 *
 * @param {ReturnType<typeof analyze>} result
 */
export function duplicatedNumberCount(result) {
  return new Set([
    ...result.collisions.map((c) => c.number),
    ...result.staleClaims.map((s) => s.number),
  ]).size
}

/**
 * Print both finding kinds, each with the evidence for THAT kind — a
 * cross-PR collision names the other PR, a stale claim names the file
 * already on the merge target. Split out of `main()` so the two stay
 * distinct in the log: they have different causes and different fixes, and
 * a reader who cannot tell which one fired cannot act on either.
 *
 * @param {ReturnType<typeof analyze>} result
 */
function reportFindings(result) {
  const total = duplicatedNumberCount(result)
  const lines = [
    `::error::check-session-log-pr-collision: ${total} session-log number(s) would be duplicated in the merge result`,
  ]
  for (const c of result.collisions) {
    const who = c.claims.map(describeClaim).join(' and ')
    lines.push(`  session-${c.number}: claimed by more than one open PR — ${who}`)
    lines.push('    One of these PRs must renumber; neither branch can see the other.')
  }
  for (const s of result.staleClaims) {
    const who = s.claims.map(describeClaim).join(' and ')
    // Capped: a number can be held by many merged files (fifteen carry
    // session-1000), and a finding nobody reads to the end is a finding
    // nobody acts on. The count is kept, so the line never understates it.
    const shown = s.mergedPaths.slice(0, 3).map((p) => `\`${p}\``)
    const rest = s.mergedPaths.length - shown.length
    const where = rest > 0 ? `${shown.join(', ')} (and ${rest} more)` : shown.join(', ')
    lines.push(
      `  session-${s.number}: already on the merge target as ${where}, and newly added by ${who}`,
    )
    lines.push(
      '    Either YOUR BASE IS STALE — that number was free when the file was committed and a ' +
        'sibling PR has merged it since — or the number is simply wrong. Either way ' +
        `${NUMBERING_GUARD} will not catch it again, because it only ever inspects STAGED ` +
        'additions: rebase onto origin/main and renumber.',
    )
    // #4431 review note 1: "rebase and renumber" is the WRONG remedy for a
    // rename that keeps its number, and this run can only tell the two apart
    // when GitHub's `previous_filename` reached it. When it did, the rename
    // was exempted and this finding is not one; when it did not, the finding
    // above is what a rename looks like, and the author must not be told to
    // renumber a file that is only moving.
    lines.push(
      '    ...UNLESS this is a RENAME of a file already on the merge target that KEEPS its ' +
        'number. GitHub reports a rename as one entry at the NEW path, so this check needs ' +
        "GitHub's own `previous_filename` (re-fetched for THIS PR over `gh api " +
        '.../pulls/<n>/files`) to tell that apart from a fresh claim, and that re-fetch is ' +
        'best-effort. If that is what this is, the number is NOT duplicated and renumbering ' +
        'is the wrong fix: re-run this job, and if it still fires, say so on the PR.',
    )
  }
  lines.push(`  ${nextFreeSentence(result.suggestion)}`)
  lines.push(
    '  Rebase onto the freshest origin/main first, since another PR may claim it before you push.',
  )
  // `emitErr` (a single `writeSync`), not `console.error` (#4431 review
  // round 4 note 1): the CI step runs this guard under
  // `2>&1 | tee collision.log`, and a write to a PIPE is ASYNCHRONOUS in
  // node — the exact hazard `finish()`'s verdict line already guards against.
  // `console.error` here is the same hazard one level up: `main()` calls
  // `finish()` (which `process.exit`s) immediately after this function
  // returns, so a long finding list queued as async pipe writes can be
  // truncated while the SYNCHRONOUS verdict line still survives — a red job
  // carrying `COLLISION` with none of the explanation for which numbers
  // collided. Since #4452 item 3 the refusal, warning, OK and crash-handler
  // paths go through the same helper, so this is no longer the one careful
  // site among four careless siblings.
  emitErr(lines.join('\n'))
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
    emitErr(
      `::error::check-session-log-pr-collision: unexpected internal failure — ${err?.stack ?? err}`,
    )
    emitErr('A crash is a failure to verify, never a finding: this run checked nothing (#4431).')
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
 * The merge target's own `docs/session-log/` listing — what `--merged-paths`
 * carries in CI, and what tells a NEW session log from an edited one.
 * `mergedLogs(1318)` reads as "session-1318 is already on the base, as
 * `docs/session-log/session-1318-merged.md`". Fixtures that need a specific
 * merged FILENAME (the two-PRs-editing-one-merged-file cases) spell the
 * path out instead.
 */
const mergedLogs = (...numbers) => numbers.map((n) => `${LOG_DIR}/session-${n}-merged.md`)

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
      mergedPaths: mergedLogs(1318),
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
      mergedPaths: mergedLogs(1318),
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
      mergedPaths: mergedLogs(1318),
    }),
    (r) => r.verified && r.collisions.length === 0 && r.suggestion === 1320,
  )

  // Case 4: fail-closed — an EMPTY list must not read as "verified, no
  // collision" when a self-PR was expected in it. This is the exact "would
  // it pass if the API returned an empty list?" question #3933 asks.
  check(
    'an empty PR list fails verification when a self-PR is expected (not a silent pass)',
    analyze({ prs: [], selfPr: 101, mergedPaths: [] }),
    (r) => !r.verified && /not present in the fetched/.test(r.reason),
  )

  // Case 4b: an empty list with NO self-PR expectation (a caller that
  // genuinely doesn't know its own PR number) is a DIFFERENT, legitimate
  // outcome — verified, trivially no collision. Distinct from 4 on purpose:
  // collapsing them would hide which guarantee is actually being relied on.
  check(
    'an empty PR list with no self-PR check is verified-empty, not a failure',
    analyze({ prs: [], selfPr: null, mergedPaths: mergedLogs(42) }),
    (r) => r.verified && r.collisions.length === 0 && r.suggestion === 43,
  )

  // Case 6: one PR claiming two distinct numbers is not a cross-PR
  // collision — should not crash, should not falsely collide.
  check(
    'one PR claiming two distinct numbers is not a cross-PR collision',
    analyze({
      prs: [pr(101, ['docs/session-log/session-1319-a.md', 'docs/session-log/session-1320-b.md'])],
      selfPr: 101,
      mergedPaths: [],
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
      mergedPaths: [],
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
      mergedPaths: mergedLogs(1318, 1319),
    }),
    (r) => r.verified && r.suggestion === 1320,
  )
}

/**
 * What is, and is not, a CLAIM (#4431 review). `gh pr list --json files`
 * returns added, MODIFIED and deleted files alike, so every case here is a
 * PR that TOUCHES a session-log path; what separates them is whether that
 * path is already on the merge target. The first two are the false
 * positives the first version of this guard produced on this repository's
 * actual tree, where fifteen merged files carry session-1000.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runClaimSemanticsCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  // Two of the real fifteen, plus a recent entry so the merged max is
  // realistic rather than 1000.
  const MERGED_A = `${LOG_DIR}/session-1000-stricter-linters.md`
  const MERGED_B = `${LOG_DIR}/session-1000-ux-keyboard-fundamentals.md`
  const BASE = [MERGED_A, MERGED_B, ...mergedLogs(1404)]

  // Case 10: two PRs EDITING THE SAME merged session log — a docs-lint
  // sweep and a link fix, say. The blocking defect: this was reported as
  // "session-1000: claimed by #101 and #102", about a file on main since
  // long before either PR existed.
  check(
    'two PRs modifying the SAME already-merged session log is not a collision',
    analyze({
      prs: [pr(101, [MERGED_A, 'src/lib/search.ts']), pr(102, [MERGED_A])],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.collisions.length === 0 && r.staleClaims.length === 0,
  )

  // Case 11: the variant that shares no path at all — two DIFFERENT merged
  // files that happen to carry the same number (fifteen files do). A
  // path-intersection check calls these disjoint; only the number groups
  // them, which is precisely why this guard groups by number and precisely
  // why it must not treat an edit as a claim.
  check(
    'two PRs modifying DIFFERENT merged files that share a number is not a collision',
    analyze({
      prs: [pr(101, [MERGED_A]), pr(102, [MERGED_B])],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.collisions.length === 0 && r.staleClaims.length === 0,
  )

  // Case 12: the guard must still fire. Same two PRs, but the files are NEW
  // — neither path is on the base — and they share a number. This is the
  // #3933 shape stated against a realistic base, and it is the assertion
  // that keeps the fix above from being "report nothing, ever".
  check(
    'two PRs ADDING files with the same NEW number is still a collision',
    analyze({
      prs: [
        pr(101, [`${LOG_DIR}/session-1405-tooling.md`]),
        pr(102, [`${LOG_DIR}/session-1405-pairing.md`]),
      ],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.collisions.length === 1 && r.collisions[0].number === 1405,
  )

  // Case 13: two PRs each ADDING a file whose number is ALREADY MERGED.
  // Both findings fire, and that is the decision: the cross-PR collision is
  // this guard's alone, while the "already on the base" half is
  // check-session-log-numbering.sh's at the moment each file was committed
  // — and nobody's afterwards, since that guard only ever re-examines
  // STAGED additions. Reported here so a PR that was correct when written
  // and has gone stale since is still caught.
  check(
    'two PRs adding files with the same ALREADY-MERGED number is both a collision and a stale claim',
    analyze({
      prs: [
        pr(101, [`${LOG_DIR}/session-1000-mine.md`]),
        pr(102, [`${LOG_DIR}/session-1000-theirs.md`]),
      ],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) =>
      r.verified &&
      r.collisions.length === 1 &&
      r.collisions[0].number === 1000 &&
      r.staleClaims.length === 1 &&
      r.staleClaims[0].mergedPaths.includes(MERGED_A),
  )

  // Case 14: ONE open PR adding a file whose number is already on the base
  // — the #3690 "two session-1281 files" shape, and the mirror gap of the
  // blocking defect. No second open PR is involved, so nothing else in CI
  // looks at it after the adding commit.
  check(
    'a single PR adding a file with an already-merged number is a stale claim',
    analyze({
      prs: [pr(101, [`${LOG_DIR}/session-1404-mine.md`]), pr(102, ['src/lib/search.ts'])],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) =>
      r.verified &&
      r.collisions.length === 0 &&
      r.staleClaims.length === 1 &&
      r.staleClaims[0].number === 1404 &&
      r.staleClaims[0].claims[0].pr === 101,
  )

  // Case 15: deleting a merged session log is not claiming its number
  // either — `gh` reports a deletion as just another changed path, and the
  // path is on the base, so the same rule covers it.
  check(
    'a PR deleting a merged session log claims nothing',
    analyze({
      prs: [pr(101, [MERGED_A]), pr(102, [`${LOG_DIR}/session-1405-new.md`])],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.collisions.length === 0 && r.staleClaims.length === 0,
  )

  // Case 19 (#4431 review note 2): a PR stacked on another open PR's branch
  // — base = the sibling's branch, not yet retargeted to `main` — contains
  // the sibling's commits, so `gh pr list --json files` reports the
  // sibling's OWN new session-log path under BOTH PRs. That is one file seen
  // twice via ancestry, not two PRs independently choosing the same number,
  // and "one of these PRs must renumber" is simply wrong advice for it —
  // renumbering the file changes nothing about which branch contains which
  // commits. Falsify by reverting `claimsByNumber` to push one `{pr, file}`
  // entry per (pr, file) pair without collapsing by path: this goes from
  // `collisions.length === 0` to a reported collision between #101 and #102.
  check(
    'a PR stacked on a sibling’s branch reporting the SAME new path is not a collision',
    analyze({
      prs: [
        // #102 is the sibling that actually adds the file.
        pr(102, [`${LOG_DIR}/session-1405-feature.md`]),
        // #101 is stacked on #102's branch (contains its commits), so its
        // own `gh`-reported file list carries the identical path.
        pr(101, [`${LOG_DIR}/session-1405-feature.md`, 'src/lib/search.ts']),
      ],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.collisions.length === 0 && r.staleClaims.length === 0,
  )

  // Case 20 (#4431 review note 2, complement): the collapse is keyed on the
  // PATH, not the number — two stacked-looking PRs that in fact add
  // DIFFERENT filenames for the same number are still a real collision, so
  // the fix above must not have overcorrected into "one open claim per
  // number, ever".
  check(
    'two PRs adding DIFFERENT paths for the same number still collide despite the path-collapse fix',
    analyze({
      prs: [
        pr(101, [`${LOG_DIR}/session-1405-mine.md`]),
        pr(102, [`${LOG_DIR}/session-1405-theirs.md`]),
      ],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.collisions.length === 1 && r.collisions[0].number === 1405,
  )

  // Case 21 (#4431 review note 5): the number from case 13 is BOTH a
  // cross-PR collision and a stale claim — one number, reported for two
  // reasons. `duplicatedNumberCount` (what `reportFindings` prints the total
  // from) must count it once. Falsify by reverting `duplicatedNumberCount`
  // to `result.collisions.length + result.staleClaims.length`: this goes
  // from `1` to `2` for this exact input — case 13's own fixture, which is
  // what made the review's "self-test case 13 prints 2 ... for the single
  // number 1000" claim true before the fix.
  check(
    'a number that is both a collision and a stale claim counts as ONE duplicated number, not two',
    analyze({
      prs: [
        pr(101, [`${LOG_DIR}/session-1000-mine.md`]),
        pr(102, [`${LOG_DIR}/session-1000-theirs.md`]),
      ],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && duplicatedNumberCount(r) === 1,
  )
}

/**
 * #4431 review round 4, BLOCKING: a finding only fails THIS run when the
 * self PR is one of the claimants. Before this split, `main()` failed on
 * `collisions.length + staleClaims.length > 0` computed over the WHOLE
 * board, so a dependency-bump PR touching no session-log file at all exited
 * 20 (and was told to "rebase onto origin/main and renumber") whenever ANY
 * two OTHER open PRs collided, or even one OTHER PR held a stale claim —
 * remedy text aimed at an author who cannot act on it. These cases pin the
 * fix: an uninvolved self PR downgrades third-party findings to `warnings`
 * and reports `verified` with no collision/staleClaim; a self PR that IS a
 * claimant still gets the hard finding, per number, independent of any
 * OTHER number's third-party finding in the same run.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runSelfAttributionCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  // Case 22: the failure scenario verbatim — #B and #C collide on
  // session-1319, #A (self) is a dependency bump touching no session-log
  // file at all. Falsify by reverting the self/other split in `analyze()`
  // (stop filtering `collisions`/`staleClaims` by `isSelfClaim`): this goes
  // from `verified, no finding, one warning` to a hard collision reported
  // against #A, which is not a claimant of anything.
  check(
    'an uninvolved self PR sees a third-party collision as a warning, not a failure',
    analyze({
      prs: [
        pr(101, ['package.json', 'package-lock.json']),
        pr(102, ['docs/session-log/session-1319-tooling.md']),
        pr(103, ['docs/session-log/session-1319-pairing.md']),
      ],
      selfPr: 101,
      mergedPaths: [],
    }),
    (r) =>
      r.verified &&
      r.collisions.length === 0 &&
      r.staleClaims.length === 0 &&
      r.warnings.length === 1 &&
      /#102/.test(r.warnings[0]) &&
      /#103/.test(r.warnings[0]) &&
      /not one of them|not this PR|not a failure/i.test(r.warnings[0]),
  )

  // Case 23 (complement of 22): same shape, but self IS one of the two
  // claimants — must still be a hard finding. Proves the fix does not
  // overcorrect into "collisions never fail".
  check(
    'a self PR that IS a claimant still gets a hard collision finding',
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-tooling.md']),
        pr(102, ['docs/session-log/session-1319-pairing.md']),
      ],
      selfPr: 101,
      mergedPaths: [],
    }),
    (r) => r.verified && r.collisions.length === 1 && r.collisions[0].number === 1319,
  )

  // Case 24: the stale-claim half of the same bug — the reviewer's own
  // "needs only ONE other PR" variant. #102 alone adds a file numbered
  // session-1404, already on the merge target; #101 (self) touches nothing
  // under docs/session-log at all.
  check(
    'an uninvolved self PR sees a third-party stale claim as a warning, not a failure',
    analyze({
      prs: [pr(101, ['src/lib/search.ts']), pr(102, ['docs/session-log/session-1404-new.md'])],
      selfPr: 101,
      mergedPaths: ['docs/session-log/session-1404-original.md'],
    }),
    (r) =>
      r.verified &&
      r.collisions.length === 0 &&
      r.staleClaims.length === 0 &&
      r.warnings.length === 1 &&
      /#102/.test(r.warnings[0]),
  )

  // Case 25: independence per number. Self (#101) collides on session-1319
  // with #102, while an UNRELATED pair (#201/#202) collides on
  // session-1400 — self is not a claimant of THAT number. The self finding
  // must still fail; the other pair's must still be a warning, in the SAME
  // run. Proves the filter is per-finding, not "any self involvement anywhere
  // clears everything" or "any third-party finding anywhere suppresses self's
  // own".
  check(
    "self's own collision still fails even alongside an unrelated third-party collision",
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-tooling.md']),
        pr(102, ['docs/session-log/session-1319-pairing.md']),
        pr(201, ['docs/session-log/session-1400-a.md']),
        pr(202, ['docs/session-log/session-1400-b.md']),
      ],
      selfPr: 101,
      mergedPaths: [],
    }),
    (r) =>
      r.verified &&
      r.collisions.length === 1 &&
      r.collisions[0].number === 1319 &&
      r.warnings.length === 1 &&
      /1400/.test(r.warnings[0]) &&
      /#201/.test(r.warnings[0]) &&
      /#202/.test(r.warnings[0]),
  )

  // Case 26 (#4431 review note 3): the STACKED CHILD, where the two fixes
  // above meet and used to cancel each other out. The path-collapse fix
  // folds an identical path to the LOWEST PR carrying it — for a stack, the
  // PARENT — and the self-attribution fix then asked "is the self PR one of
  // the claimants?" of that folded representative alone. On the child's own
  // run the answer was "no" about a genuine collision between its parent's
  // file and a third PR's, so the child went GREEN on a duplicate its own
  // merge result would contain. The parent still failed closed, so nothing
  // was silent — the child was simply wrong. Falsify by reverting
  // `isSelfClaim` to `Number(c.pr) === Number(selfPr)`: this goes from one
  // hard collision to zero collisions and one warning.
  const STACK = [
    // #301 is unrelated and adds its own file with the same number.
    pr(301, [`${LOG_DIR}/session-1405-third-party.md`]),
    // #302 is the parent, and actually adds the file.
    pr(302, [`${LOG_DIR}/session-1405-parent.md`]),
    // #303 is stacked on #302's branch, so `gh` reports #302's file under it
    // too — one file seen twice through ancestry.
    pr(303, [`${LOG_DIR}/session-1405-parent.md`, 'src/lib/search.ts']),
  ]
  check(
    'a stacked child fails on a collision it carries through its parent’s file',
    analyze({ prs: STACK, selfPr: 303, mergedPaths: [] }),
    (r) =>
      r.verified &&
      r.collisions.length === 1 &&
      r.collisions[0].number === 1405 &&
      r.staleClaims.length === 0,
  )

  // Case 27 (complement): the PARENT still fails on the same board. The fix
  // must not have moved ownership from the parent to the child, only widened
  // it to both.
  check(
    'the parent of a stack still fails on the same collision',
    analyze({ prs: STACK, selfPr: 302, mergedPaths: [] }),
    (r) => r.verified && r.collisions.length === 1 && r.collisions[0].number === 1405,
  )

  // Case 28: and a genuinely uninvolved PR still gets a warning — with the
  // folded claim naming EVERY carrier, so the report says which PRs the file
  // is actually in rather than only the lowest-numbered one. Without the
  // carrier list, the stacked child reading its own hard failure would see a
  // finding that named two PRs, neither of them itself.
  check(
    'a folded claim names every PR that carries it, not just the representative',
    analyze({ prs: [...STACK, pr(304, ['package.json'])], selfPr: 304, mergedPaths: [] }),
    (r) =>
      r.verified &&
      r.collisions.length === 0 &&
      r.warnings.length === 1 &&
      /also carried by #303/.test(r.warnings[0]),
  )

  // Case 29: the collapse still holds — a stacked pair with NO third party
  // is not a collision with itself, which is what case 19 asserts from the
  // other direction. Restated here from the CHILD's side, because that is
  // the run the carrier-set change altered.
  check(
    'a stacked child with no third-party claimant is still not a collision',
    analyze({ prs: STACK.slice(1), selfPr: 303, mergedPaths: [] }),
    (r) => r.verified && r.collisions.length === 0 && r.staleClaims.length === 0,
  )
}

/**
 * The suggestion has to be a number the OTHER guard would accept (#4431
 * review note 3): `max(everything) + 1` is not, once any open PR carries a
 * number far above the merged max.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runSuggestionCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  // Case 16: ANOTHER open PR holding session-9999 must not push the
  // suggestion to 10000 — check-session-log-numbering.sh's check 2 rejects
  // anything above (max, max+GAP_BOUND], and that guard's max is taken over
  // HEAD ∪ origin/main, neither of which contains a SIBLING's commits. So
  // a sibling's wild number is not in the origin, only skipped inside the
  // window. #102 is the self PR here and claims nothing; case 16b below is
  // the deliberately-different case where the wild number is the self PR's
  // OWN, which its own HEAD does carry (#4431 review note 2).
  check(
    'another PR’s wildly high claim does not poison the suggestion past the other guard’s window',
    analyze({
      prs: [pr(101, [`${LOG_DIR}/session-9999-typo.md`]), pr(102, ['src/lib/search.ts'])],
      selfPr: 102,
      mergedPaths: mergedLogs(1404),
    }),
    (r) => r.verified && r.suggestion === 1405,
  )

  // Case 16b (#4431 review note 2): the SELF PR holding session-9999 is the
  // opposite answer, and 1405 would be the wrong one. That number is in the
  // author's own HEAD, so check-session-log-numbering.sh's `existing_max` is
  // 9999 and its check 2 accepts only [10000, 10009] on the very next
  // commit. Suggesting 1405 here would hand the author a number the guard
  // they are being told to satisfy rejects on sight. Falsify by reverting
  // `suggestNextFree`'s origin to `max(mergedNums)`: this returns 1405.
  check(
    'a wildly high claim made by the SELF PR moves the window, because that guard’s HEAD carries it',
    analyze({
      prs: [pr(101, [`${LOG_DIR}/session-9999-typo.md`])],
      selfPr: 101,
      mergedPaths: mergedLogs(1404),
    }),
    (r) => r.verified && r.suggestion === 10000,
  )

  // Case 17: the suggestion skips numbers OTHER open PRs already claim, so
  // the remedy cannot recreate the collision it is remedying.
  check(
    'the suggestion skips every number an open PR already claims',
    analyze({
      prs: [
        pr(101, [`${LOG_DIR}/session-1405-a.md`]),
        pr(102, [`${LOG_DIR}/session-1406-b.md`]),
        pr(103, [`${LOG_DIR}/session-1407-c.md`]),
      ],
      selfPr: 101,
      mergedPaths: mergedLogs(1404),
    }),
    (r) => r.verified && r.suggestion === 1408,
  )

  // Case 18: when the whole window is claimed, offer NOTHING rather than a
  // number the other guard would reject. More open session-log PRs than the
  // window is wide is itself the story; a fabricated next number would hide
  // it.
  const wholeWindow = Array.from({ length: GAP_BOUND }, (_, i) =>
    pr(200 + i, [`${LOG_DIR}/session-${1405 + i}-a.md`]),
  )
  // The self PR here (#300) deliberately claims NOTHING, so the window's
  // origin is the merge target's max and the fixture says what it means to
  // say: GAP_BOUND numbers claimed by GAP_BOUND other PRs fills the window.
  // Were the self PR one of the claimants, its own claim would move the
  // origin up (case 16b) and the window would no longer be full — which is
  // correct behaviour, and a different statement from this one.
  check(
    'a fully claimed window yields no suggestion at all, not one outside it',
    analyze({
      prs: [...wholeWindow, pr(300, ['src/lib/search.ts'])],
      selfPr: 300,
      mergedPaths: mergedLogs(1404),
    }),
    (r) => r.verified && r.suggestion === null,
  )

  // Case 18b (#4431 review note 2): the reviewer's exact shape — the branch
  // has already committed a session number ABOVE the merge target's max,
  // with a gap. `mergedMax + 1` is 1405; check-session-log-numbering.sh's
  // `existing_max` is 1420 (HEAD carries it), so its check 2 accepts only
  // [1421, 1430] and would reject 1405 outright. Falsify by reverting
  // `suggestNextFree`'s origin to `max(mergedNums)`: this returns 1405.
  check(
    'a self PR already carrying a number above the target’s max moves the window origin with it',
    analyze({
      prs: [pr(101, [`${LOG_DIR}/session-1420-earlier-entry.md`])],
      selfPr: 101,
      mergedPaths: mergedLogs(1404),
    }),
    (r) => r.verified && r.suggestion === 1421,
  )

  // Case 18c (#4431 review note 2): the ORIGIN pinned against the other
  // guard's OWN arithmetic rather than against a hand-computed constant.
  // `check-session-log-numbering.sh` computes `existing_max` over
  // `HEAD ∪ origin/main`, `expected = existing_max + 1` and
  // `max_allowed = expected + GAP_BOUND - 1`, then hard-fails any number
  // outside `[expected, max_allowed]`. This re-implements exactly that and
  // asserts the suggestion lands inside it for every shape of branch/target
  // relationship, which is the check the GAP_BOUND cross-guard assertion
  // could not make: that one pins the window's WIDTH, this one its ORIGIN.
  // Falsify by reverting `suggestNextFree`'s origin to `max(mergedNums)`:
  // the last two scenarios' suggestions fall below `expected`.
  const numberingWindow = (mergedNums, branchNums) => {
    const existingMax = Math.max(0, ...mergedNums, ...branchNums)
    return { expected: existingMax + 1, maxAllowed: existingMax + GAP_BOUND }
  }
  const originScenarios = [
    { what: 'branch adds nothing above the target', merged: [1404], own: [] },
    { what: 'branch sits one above the target', merged: [1404], own: [1405] },
    { what: 'branch sits above the target with a gap', merged: [1404], own: [1420] },
    { what: 'branch sits more than a window above the target', merged: [1404], own: [1425] },
  ]
  for (const sc of originScenarios) {
    const r = analyze({
      prs: [
        pr(
          101,
          sc.own.map((n) => `${LOG_DIR}/session-${n}-mine.md`),
        ),
      ],
      selfPr: 101,
      mergedPaths: sc.merged.map((n) => `${LOG_DIR}/session-${n}-merged.md`),
    })
    // HEAD carries the merge target's numbers AND the branch's own, which is
    // exactly `mergedNums ∪ own` here.
    const w = numberingWindow(sc.merged, sc.own)
    check(
      `cross-guard: the suggestion is inside ${NUMBERING_GUARD}'s own window (${sc.what})`,
      { suggestion: r.suggestion, ...w },
      (v) => v.suggestion !== null && v.suggestion >= v.expected && v.suggestion <= v.maxAllowed,
    )
  }
}

/**
 * A RENAME is the one shape `gh pr list --json files` cannot describe: it
 * reports a rename as a single entry at the NEW path, so a rename that keeps
 * its session number is indistinguishable from a fresh claim on an
 * already-merged number — a hard stale claim whose remedy ("rebase and
 * renumber") is wrong for it (#4431 review note 1). `pr-overlap.yml`
 * re-fetches THIS PR's file list over `gh api .../pulls/<n>/files`, which
 * does carry GitHub's `previous_filename`, and splices it in as
 * `previousPath`; these cases pin the exemption it enables and, just as
 * importantly, everything it must NOT exempt.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runRenameCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  const MERGED_TYPO = `${LOG_DIR}/session-1000-typo.md`
  const BASE = [MERGED_TYPO, ...mergedLogs(1404)]
  /** A `files` entry as the REST re-fetch supplies it. */
  const entry = (path, previousPath = null) => ({ path, previousPath })
  const prEntries = (number, files, changedFiles = files.length) => ({
    number,
    files,
    changedFiles,
  })

  // R1: the shape itself — `session-1000-typo.md` → `session-1000-fixed.md`,
  // the old path on the merge target, the number unchanged. Nothing is
  // claimed and nothing is duplicated: one file is moving. Falsify by
  // deleting the `isSameNumberRename` line from `claimsByNumber`: this goes
  // from no finding to a hard stale claim on session-1000.
  check(
    'a same-number rename of an already-merged log is not a claim when previousPath is supplied',
    analyze({
      prs: [prEntries(101, [entry(`${LOG_DIR}/session-1000-fixed.md`, MERGED_TYPO)])],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.staleClaims.length === 0 && r.collisions.length === 0,
  )

  // R2: a RENUMBER is not the same shape and must NOT be exempted — all
  // seven real renames under `docs/session-log` in this repo's history are
  // renumbers (`session-1314-x.md` → `session-1316-x.md`), i.e. this guard's
  // own prescribed remedy. Moving a file ONTO an already-merged number is a
  // genuine stale claim, rename or not.
  check(
    'a rename that CHANGES the number onto an already-merged one is still a stale claim',
    analyze({
      prs: [prEntries(101, [entry(`${LOG_DIR}/session-1404-fixed.md`, MERGED_TYPO)])],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.staleClaims.length === 1 && r.staleClaims[0].number === 1404,
  )

  // R3: positive classification — a previousPath this run cannot corroborate
  // (not on the merge target) exempts nothing. The exemption's whole
  // justification is "that file already exists over there under another
  // name"; if it does not, there is nothing to move.
  check(
    'a rename whose previous path is NOT on the merge target is still a claim',
    analyze({
      prs: [
        prEntries(101, [
          entry(`${LOG_DIR}/session-1404-mine.md`, `${LOG_DIR}/session-777-never-merged.md`),
        ]),
      ],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.staleClaims.length === 1 && r.staleClaims[0].number === 1404,
  )

  // R4: the fallback, stated as an assertion rather than left implicit. With
  // no `previousPath` at all — the plain `gh pr list --json files` shape,
  // which is what a run gets when the REST re-fetch did not land — the same
  // rename still reads as a stale claim. That is a FALSE POSITIVE and never
  // a false pass, which is the direction this guard is allowed to fail in;
  // the finding's own text names the rename case (asserted end to end in the
  // process cases below).
  check(
    'without previousPath the same rename still reads as a stale claim (false positive, never a false pass)',
    analyze({
      prs: [pr(101, [`${LOG_DIR}/session-1000-fixed.md`])],
      selfPr: 101,
      mergedPaths: BASE,
    }),
    (r) => r.verified && r.staleClaims.length === 1 && r.staleClaims[0].number === 1000,
  )

  // R5: the exemption is per ENTRY, not per number — #101 moving
  // `session-1000-typo.md` must not launder #102's genuine new claim on
  // session-1000 into silence. Run from #102's side, where it is a hard
  // finding.
  check(
    'exempting one PR’s rename does not exempt another PR’s real claim on the same number',
    analyze({
      prs: [
        prEntries(101, [entry(`${LOG_DIR}/session-1000-fixed.md`, MERGED_TYPO)]),
        pr(102, [`${LOG_DIR}/session-1000-brand-new.md`]),
      ],
      selfPr: 102,
      mergedPaths: BASE,
    }),
    (r) =>
      r.verified &&
      r.staleClaims.length === 1 &&
      r.staleClaims[0].number === 1000 &&
      r.staleClaims[0].claims.length === 1 &&
      r.staleClaims[0].claims[0].pr === 102,
  )
}

/**
 * The exit-code contract, asserted rather than only documented. The header's
 * table is load-bearing: `EXIT_COLLISION` has to stay outside every code a
 * runtime, kernel or shell can synthesize on its own, or #4431's original
 * defect comes straight back — a crashed guard reported as a confirmed
 * finding. A future exit path that reused 1, 126, 127 or 128+N would break
 * that silently, since every one of those is a perfectly ordinary integer.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runExitCodeCases(ok, fail) {
  // node reserves 1–14 for its own failures, POSIX shells add 126 (found but
  // not executable) and 127 (not found), and a signal death is 128+N.
  const SYNTHESIZABLE = new Set([...Array.from({ length: 14 }, (_, i) => i + 1), 126, 127])
  const distinct = new Set([EXIT_VERIFIED_CLEAN, EXIT_COULD_NOT_VERIFY, EXIT_COLLISION]).size === 3
  // Only the FINDING code must be disjoint. `EXIT_COULD_NOT_VERIFY` (2) is
  // deliberately inside the reserved range: "could not verify" is exactly
  // what a crash means, so aliasing there costs nothing.
  const collisionIsUnforgeable =
    !SYNTHESIZABLE.has(EXIT_COLLISION) && EXIT_COLLISION > 0 && EXIT_COLLISION < 128
  if (distinct && collisionIsUnforgeable) {
    ok('exit codes are mutually distinct, and the FINDING code cannot be synthesized by a crash')
  } else {
    fail(
      'exit codes are mutually distinct, and the FINDING code cannot be synthesized by a crash',
      JSON.stringify({ EXIT_VERIFIED_CLEAN, EXIT_COULD_NOT_VERIFY, EXIT_COLLISION }),
    )
  }
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
    // #4431 review note 1's own example: a `files` entry with no usable
    // `path` at all. Before the fix, `shapeProblem()` never looked inside
    // `files`, so this passed shape validation, passed the
    // `changedFiles === files.length` truncation cross-check, and
    // `pathsOf()`'s `.filter(Boolean)` silently dropped it — a session-log
    // claim made invisible rather than a refusal. Falsify by reverting
    // `isUsableFileEntry`'s use in `shapeProblem()` (put back a version of
    // `shapeProblem` that only checks `Array.isArray(pr.files)`): this case
    // goes from failing verification to `r.verified === true`.
    [
      'file entry with no usable "path"',
      [{ number: 7, changedFiles: 1, files: [{ additions: 3, deletions: 0 }] }],
    ],
    // #4431 review note 1: `previousPath` is optional, but a value of an
    // unanticipated TYPE must refuse rather than be coerced or ignored — it
    // is the field the rename exemption in `claimsByNumber` keys on, so
    // shrugging at it is the one failure direction that could suppress a
    // real claim. Falsify by deleting the `previousPath` clause from
    // `isUsableFileEntry`: this case goes from failing verification to
    // `r.verified === true`.
    [
      'file entry with a non-string, non-null "previousPath"',
      [
        {
          number: 7,
          changedFiles: 1,
          files: [{ path: 'docs/session-log/session-1-a.md', previousPath: 42 }],
        },
      ],
    ],
  ]
  for (const [name, bad] of shapes) {
    const r = analyze({ prs: bad, selfPr: null, mergedPaths: [] })
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
 * Whose list is truncated decides what happens (#4431 review note 2): THIS
 * PR's own is a refusal, anyone else's is a warning. The two are asserted
 * separately below, because collapsing them is exactly how a guard becomes
 * a permanent red on PRs whose authors cannot do anything about it.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runTruncationCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  // THIS PR's own file list is short of its changedFiles count: refuse —
  // even though the visible slice shows no collision at all. Nothing about
  // the VISIBLE files is wrong, so only the changedFiles cross-check can
  // catch it, and the author reading the failure is the one who can act.
  check(
    "this PR's own truncated files list is unverified, not a silent pass",
    analyze({
      prs: [pr(101, ['docs/session-log/session-1319-tooling.md'], /* changedFiles */ 150)],
      selfPr: 101,
      mergedPaths: [],
    }),
    (r) => !r.verified && /truncated by gh's 100-file cap/.test(r.reason) && /#101/.test(r.reason),
  )

  // ANOTHER PR's truncated list: verified, plus a warning naming it. The
  // 411-file PR in this repo's history would otherwise have turned this job
  // red on every other open PR for as long as it stayed open.
  check(
    "another PR's truncated files list warns naming it, and does not fail this PR",
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-tooling.md']),
        pr(102, ['src/lib/search.ts'], /* changedFiles */ 411),
      ],
      selfPr: 101,
      mergedPaths: [],
    }),
    (r) =>
      r.verified &&
      r.collisions.length === 0 &&
      r.warnings.length === 1 &&
      /#102/.test(r.warnings[0]) &&
      /could not be ruled out/.test(r.warnings[0]),
  )

  // …and the downgrade must not swallow a collision that IS visible: the
  // warning is additive, never a substitute for a finding.
  check(
    "a real collision is still reported alongside another PR's truncation warning",
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-tooling.md']),
        pr(102, ['docs/session-log/session-1319-pairing.md']),
        pr(103, ['src/lib/search.ts'], /* changedFiles */ 411),
      ],
      selfPr: 101,
      mergedPaths: [],
    }),
    (r) =>
      r.verified &&
      r.collisions.length === 1 &&
      r.collisions[0].number === 1319 &&
      r.warnings.length === 1 &&
      /#103/.test(r.warnings[0]),
  )

  // With no self-PR expectation there is no "own" list to refuse over, so
  // every truncation is somebody else's — warned, not fatal. (The CI caller
  // always passes --self-pr; this is the ad-hoc invocation.)
  check(
    'with no --self-pr, a truncated entry warns rather than refusing',
    analyze({
      prs: [pr(102, ['src/lib/search.ts'], 411)],
      selfPr: null,
      mergedPaths: [],
    }),
    (r) => r.verified && r.warnings.length === 1 && /#102/.test(r.warnings[0]),
  )

  // The boundary: changedFiles EQUAL to files.length (the ordinary case
  // every other fixture relies on, made explicit here) must NOT be flagged
  // as truncated — only a strict shortfall is.
  check(
    'changedFiles equal to files.length is NOT flagged as truncated',
    analyze({
      prs: [pr(101, ['docs/session-log/session-1319-tooling.md'], 1)],
      selfPr: 101,
      mergedPaths: [],
    }),
    (r) => r.verified && r.collisions.length === 0,
  )

  // THIS PR truncated while another PR in the same payload claims a number
  // honestly: the refusal still wins over the partial reading. What is
  // downgraded above is another PR's truncation, never this PR's, and never
  // into "verified" while this PR's own claim is unknown.
  check(
    "this PR's truncation still refuses even when the visible half reads cleanly",
    analyze({
      prs: [
        pr(101, ['docs/session-log/session-1319-a.md'], 200),
        pr(102, ['docs/session-log/session-1400-b.md']),
      ],
      selfPr: 101,
      mergedPaths: [],
    }),
    (r) => !r.verified && /truncated by gh's 100-file cap/.test(r.reason),
  )
}

/**
 * The top-level "more open PRs than this run is willing to trust" guard.
 * `prLimit` is the INTENDED cap; the CI caller fetches `prLimit + 1` from
 * `gh pr list` precisely so a genuine page of exactly `prLimit` PRs is
 * fetched IN FULL rather than looking identical to a page `gh` truncated at
 * that length (see this file's header, point 2). An earlier version
 * compared `prs.length` against the SAME number `gh` was asked for, so a
 * page exactly that long always refused — at precisely `prLimit` open PRs,
 * EVERY PR's run of this job refused with no individual author able to
 * clear it (#4431 review note 4). These cases pin the corrected boundary:
 * `prLimit` itself passes, `prLimit + 1` (the extra entry the caller's `+1`
 * fetch exists to surface) refuses.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runPrLimitCases(ok, fail) {
  const check = (name, r, predicate) => {
    if (predicate(r)) ok(name)
    else fail(name, JSON.stringify(r))
  }

  const nPrs = (n) =>
    Array.from({ length: n }, (_, i) => pr(i + 1, [`docs/session-log/session-${i + 1}-a.md`]))

  check(
    'a fetched list exactly as long as --pr-limit passes — no cliff at the intended cap',
    analyze({ prs: nPrs(2), selfPr: 1, mergedPaths: [], prLimit: 2 }),
    (r) => r.verified && r.collisions.length === 0,
  )

  check(
    'a fetched list ONE PAST --pr-limit is unverified — the extra entry the +1 fetch exists to catch',
    analyze({ prs: nPrs(3), selfPr: 1, mergedPaths: [], prLimit: 2 }),
    (r) => !r.verified && /exceeds the intended --pr-limit/.test(r.reason),
  )

  check(
    'a fetched list SHORTER than --pr-limit passes normally',
    analyze({ prs: nPrs(2), selfPr: 1, mergedPaths: [], prLimit: 50 }),
    (r) => r.verified && r.collisions.length === 0,
  )

  check(
    'no --pr-limit given (prLimit: null) skips the check entirely, whatever the list length',
    analyze({ prs: nPrs(2), selfPr: 1, mergedPaths: [], prLimit: null }),
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
/** The one session log the fixture `merged-paths.txt` puts on the base. */
const MERGED_LOG = mergedLogs(1318)[0]
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
  // A CLEAN board on which a SIBLING's changed-file list was truncated by
  // gh's 100-file cap. No collision is observed and the verdict is CLEAN —
  // but a session-log claim of #102's own, past the cutoff, was invisible to
  // this run, so it emits a `::warning::` and the step must not call the
  // result "verified" (#4452 item 5).
  cleanButTruncatedSibling: jsonPrs(
    pr(SELF_PR, ['docs/session-log/session-1319-tooling.md']),
    pr(102, ['src/lib/search.ts'], 250),
  ),
  // Two PRs EDITING the same session log that is already on the merge
  // target (`merged-paths.txt` below lists it) — the blocking false
  // positive of #4431's review, end to end rather than in `analyze()` alone.
  modification: jsonPrs(pr(SELF_PR, [MERGED_LOG]), pr(102, [MERGED_LOG, 'src/lib/search.ts'])),
  // One PR ADDING a new file whose number is already on the merge target.
  staleClaim: jsonPrs(pr(SELF_PR, [`${LOG_DIR}/session-1318-mine.md`])),
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
      '--merged-paths',
      'merged-paths.txt',
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
      MERGED_PATHS: 'merged-paths.txt',
      GITHUB_STEP_SUMMARY: `${dir}/summary.md`,
    },
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * Every function on a path that ends in `finish()` (i.e. in `process.exit`),
 * and therefore every function whose output must be SYNCHRONOUS.
 *
 * `emitErr`/`emitOut` are in the list as well as the functions that call
 * them: without them the property would be "these four call something named
 * emitErr", which a rename of that helper to a `console.error` wrapper would
 * satisfy while breaking the actual guarantee.
 */
const TERMINAL_OUTPUT_FUNCTIONS = [
  { name: 'main', signature: 'function main(argv) {', mustEmit: true },
  { name: 'mainGuarded', signature: 'function mainGuarded(argv) {', mustEmit: true },
  { name: 'reportFindings', signature: 'function reportFindings(result) {', mustEmit: true },
  { name: 'emitErr', signature: 'function emitErr(text) {', mustEmit: false },
  { name: 'emitOut', signature: 'function emitOut(text) {', mustEmit: false },
]

/**
 * #4431 review round 4 note 1, widened by #4452 item 3: EVERY function on a
 * terminal path must write with the same synchronous mechanism `finish()`
 * uses for the verdict line, not `console.error`/`console.log`.
 *
 * Node's writes to a PIPE are asynchronous, and `finish()` calls
 * `process.exit` without waiting for anything still in flight — so text
 * queued as async writes can be silently truncated under the CI step's
 * `2>&1 | tee collision.log` while the SYNCHRONOUS verdict line still
 * survives. #4431 fixed `reportFindings` and this check pinned that ONE
 * function; the refusal, warning, OK and crash-handler paths kept
 * `console.error`/`console.log`, so the step could print "its own message is
 * above" with nothing above it. Checking a list rather than a single
 * function is the difference between pinning the fix and pinning the class.
 *
 * The actual OS-level race (a pipe whose reader is slow enough to leave bytes
 * queued when the writer exits) is not something a fast, deterministic
 * self-test can reliably force — `spawnSync`'s own pipe draining hides it —
 * so this checks the SOURCE mechanically instead: the same shape
 * `extractStepShell`'s marker-comment extraction and the `GAP_BOUND`
 * cross-guard check already use elsewhere in this file for a fact about text
 * rather than about one program run.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runFindingsOutputCases(ok, fail) {
  const src = readFileSync(realpathSync(import.meta.filename), 'utf8')
  for (const { name, signature, mustEmit } of TERMINAL_OUTPUT_FUNCTIONS) {
    // `\n\}` — a newline immediately followed by a ZERO-INDENT `}` — matches
    // only the function's OWN closing brace: every closing brace of a nested
    // block inside it is indented at least two spaces, so it cannot satisfy
    // this pattern first.
    const start = src.indexOf(signature)
    if (start === -1) {
      // A FAILURE, never a skip: a signature that no longer matches means
      // this check verified nothing about that function, which is exactly
      // what it exists to stop happening silently.
      fail(
        `\`${name}\`'s source could be located for the synchronous-output check`,
        `no occurrence of ${JSON.stringify(signature)} — the signature changed`,
      )
      continue
    }
    const end = src.indexOf('\n}', start)
    ok(`\`${name}\`'s source could be located for the synchronous-output check`)
    const body = src.slice(start, end)
    if (/console\.(?:error|log|warn|info)\(/.test(body)) {
      fail(
        `\`${name}\` emits nothing through console.* (a PIPE write node does not flush on exit)`,
        body,
      )
    } else {
      ok(`\`${name}\` emits nothing through console.* (a PIPE write node does not flush on exit)`)
    }
    // ...and the positive half. Without it, "no console.*" is satisfied by a
    // function that emits nothing at all — including one whose diagnostics
    // were deleted rather than converted, which is the same lost-explanation
    // outcome by a different route.
    if (!mustEmit) continue
    if (/\bemit(?:Err|Out)\(/.test(body)) {
      ok(`\`${name}\` still emits its diagnostics, through emitErr/emitOut`)
    } else {
      fail(`\`${name}\` still emits its diagnostics, through emitErr/emitOut`, body)
    }
  }
  // `emitErr`/`emitOut` are the only two places the bytes actually leave, so
  // they are where `writeSync` itself has to be spelled out.
  for (const [name, fd] of [
    ['emitErr', 2],
    ['emitOut', 1],
  ]) {
    const start = src.indexOf(`function ${name}(text) {`)
    const body = start === -1 ? '' : src.slice(start, src.indexOf('\n}', start))
    if (new RegExp(`writeSync\\(${fd},`).test(body)) {
      ok(`\`${name}\` writes with writeSync(${fd}, …)`)
    } else {
      fail(`\`${name}\` writes with writeSync(${fd}, …)`, body || '<not found>')
    }
  }
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
  writeFileSync(join(dir, 'merged-paths.txt'), `${mergedLogs(1318).join('\n')}\n`)

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

  // ── Outcome 2a: #4452 item 5. A clean verdict reached over a board this
  // run could not fully see. The guard's own warnings say a collision with a
  // truncated sibling COULD NOT BE RULED OUT, and the step used to print
  // "verified — no open PR shares a session-log number with another" right
  // on top of them. Still passes (each such sibling fails closed on its own
  // run, so nothing merges unchecked) — but it must not claim coverage this
  // run did not have. Both halves are asserted: the honest sentence appears,
  // and the overstating one does not.
  payload('cleanButTruncatedSibling')
  check(
    'process: a clean board with a truncated sibling still exits 0 with a CLEAN verdict',
    runGuard(dir, guard),
    (r) =>
      r.code === EXIT_VERIFIED_CLEAN &&
      r.verdict === 'CLEAN' &&
      /could not be ruled out/.test(r.out),
  )
  check(
    'step: a clean verdict over a board it could not fully see is NOT reported as "verified"',
    runStep(dir, stepPath, guard),
    (r) =>
      r.code === 0 &&
      /did not see the whole board/.test(r.out) &&
      /NOT a clean bill of health/.test(r.out) &&
      !/verified — no open PR shares/.test(r.out),
  )

  // ── Outcome 2b: THE #4431-REVIEW BLOCKING DEFECT, end to end. Two PRs
  // EDITING the same session log that is already on the merge target. The
  // first version reported `session-1318: claimed by #101 and #102` and
  // failed both PRs; the real guard, the real step, and the real
  // `merged-paths.txt` must now agree it is clean.
  payload('modification')
  check(
    'process: two PRs editing one already-merged session log exit 0 with a CLEAN verdict',
    runGuard(dir, guard),
    (r) => r.code === EXIT_VERIFIED_CLEAN && r.verdict === 'CLEAN',
  )
  check(
    'step: two PRs editing one already-merged session log pass the job',
    runStep(dir, stepPath, guard),
    (r) => r.code === 0 && !/duplicated in the merge result/.test(r.out),
  )

  // ── Outcome 2c: the mirror — one PR ADDING a file whose number is
  // already on the merge target. Same base listing, opposite verdict, and
  // the message has to name the merged file rather than a second PR.
  payload('staleClaim')
  check(
    'process: a new file with an already-merged number exits 20 with a COLLISION verdict',
    runGuard(dir, guard),
    (r) => r.code === EXIT_COLLISION && r.verdict === 'COLLISION',
  )
  check(
    'step: a new file with an already-merged number fails, naming the file it duplicates',
    runStep(dir, stepPath, guard),
    (r) =>
      r.code === 1 && /already on the merge target as/.test(r.out) && /BASE IS STALE/.test(r.out),
  )
  // …and the SAME finding has to name the rename case, end to end, because
  // that is what this finding looks like when GitHub's `previous_filename`
  // did not reach the run (#4431 review note 1). "Rebase and renumber" alone
  // is wrong advice for a rename, and this is the message the author reads.
  // Falsify by deleting the rename paragraph from `reportFindings`: this
  // goes red while the assertion above stays green.
  check(
    'step: a stale-claim finding also names the RENAME case, not only "renumber"',
    runStep(dir, stepPath, guard),
    (r) => r.code === 1 && /RENAME of a file already on the merge target/.test(r.out),
  )

  // ── #4452 item 4: the FETCH step's `+1`, which no run of this self-test
  // executes. `extractStepShell`'s BEGIN/END markers wrap only the
  // CLASSIFICATION step, so the `gh pr list` step above it is never run here
  // — and the `+1` is exactly what lets the guard tell a full page from a
  // truncated one. Dropping it passed every assertion in this file while
  // silently restoring the ambiguity it exists to remove: at precisely
  // PR_LIST_LIMIT open PRs, every PR's run refuses, permanently, with no
  // author able to clear it (#4431 review note 4). Marker-extracting the
  // fetch step is not an option — it calls `gh` — so the offset is pinned
  // the way `GAP_BOUND` is: as text, plus the arithmetic actually evaluated.
  //
  // The behavioural half of the same fact — `prLimit` entries pass and
  // `prLimit + 1` refuses — is `runPrLimitCases`; this is the half that says
  // the CALLER really does hand over that extra entry.
  const workflowSrc = readFileSync(workflow, 'utf8')
  const fetchLimit = /gh pr list[^\n]*--limit "([^"\n]+)"[^\n]*\\\n[^\n]*changedFiles/.exec(
    workflowSrc,
  )
  const guardLimit = /--pr-limit "\$([A-Z_]+)"/.exec(workflowSrc)
  const declaredCap = /^\s*PR_LIST_LIMIT: "(\d+)"\s*$/m.exec(workflowSrc)
  check(
    'cross-file: the collision job declares PR_LIST_LIMIT, fetches with it, and gates on it',
    {
      fetchExpr: fetchLimit === null ? null : fetchLimit[1],
      guardVar: guardLimit === null ? null : guardLimit[1],
      cap: declaredCap === null ? null : declaredCap[1],
    },
    (v) => v.fetchExpr !== null && v.guardVar === 'PR_LIST_LIMIT' && v.cap !== null,
  )
  // …and the arithmetic itself, EVALUATED rather than pattern-matched: the
  // page `gh` is asked for must be exactly ONE longer than the cap the guard
  // is told to enforce. `--limit "$PR_LIST_LIMIT"` (the shape that caused
  // #4431 review note 4) fails this; so does any other drift between them.
  //
  // #4466 note 4: this used to allow-list the expression to
  // `[A-Z_0-9$() +]` and hand it to `bash -c` — bounding the affordance
  // rather than removing it, since that class still admits `$(SOMEWORD)`
  // command substitution for an all-uppercase "command" name ahead of the
  // `bash -c`. Not attacker-controlled (this reads our own workflow file),
  // but a self-test with a shell in its evaluation path is a worse shape
  // than the check needs. The value this file actually ever writes is the
  // shell ARITHMETIC-EXPANSION form `$(( <expr> ))` — never a command
  // substitution — so this now requires exactly that shape, substitutes the
  // one named variable it names, and evaluates the result as bare
  // arithmetic in JS: no shell, and no character in the class this accepts
  // (digits, whitespace, `+`, `-`) that could ever start a command.
  const cap = declaredCap === null ? null : Number(declaredCap[1])
  const expr = fetchLimit === null ? '' : fetchLimit[1]
  const arithBody = /^\$\(\(([^$()]*)\)\)$/.exec(expr)?.[1] ?? null
  const substituted =
    arithBody === null || cap === null ? null : arithBody.replaceAll('PR_LIST_LIMIT', String(cap))
  // A GRAMMAR, not a character class: `<int> ( <+|-> <int> )*` with an
  // optional leading sign, anchored, so every character of `substituted` is
  // accounted for by a term or an operator. The looser `/^[\s\d+-]+$/` this
  // replaces was not enough to make the token sum below an EVALUATION: it
  // admitted two adjacent signs, and `substituted.match()` — which skips
  // anything it cannot start a match at, rather than failing — silently
  // dropped the first of them. `$((PR_LIST_LIMIT - +1))` therefore summed to
  // `100 + 1 = 101` and PASSED this check, while the shell that actually runs
  // it asks `gh` for 99 — the truncation ambiguity of #4431 review note 4,
  // waved through by the very assertion that exists to catch it. Refusing an
  // adjacent-sign expression outright (falling to `NaN`, which can never
  // equal `cap + 1`) fails closed instead of guessing.
  const evaluated =
    substituted !== null && /^\s*[+-]?\s*\d+(?:\s*[+-]\s*\d+)*\s*$/.test(substituted)
      ? // Under that grammar every token IS a signed integer literal and no
        // character sits outside one, so summing the signed terms IS
        // evaluating the expression: with only `+`/`-` left there is no
        // operator precedence to get wrong, and nothing for the scan to skip.
        (substituted.match(/[+-]?\s*\d+/g) ?? []).reduce(
          (sum, term) => sum + Number(term.replace(/\s+/g, '')),
          0,
        )
      : Number.NaN
  // Why a rejected expression reports WHY it was rejected: `arithBody` is
  // null for two very different reasons — the expression is not an arithmetic
  // expansion at all (the real drift this catches, e.g. the bare
  // `--limit "$PR_LIST_LIMIT"` of #4431 note 4), or it IS one but spells the
  // variable `$PR_LIST_LIMIT` inside the parens, which the `[^$()]*` body
  // class refuses. The second is idiomatic shell and arithmetically correct;
  // it is refused only because admitting `$` back into the body would widen
  // the class this check narrowed for #4466 note 4. That refusal is
  // deliberate and fails CLOSED, but without this hint it surfaces as a bare
  // `evaluated: null` and reads like the guard is broken rather than like the
  // workflow needs one character removed.
  const rejectedBecause =
    arithBody !== null
      ? null
      : expr.startsWith('$((')
        ? 'arithmetic expansion, but the body contains `$` — write the variable bare ' +
          '(`$((PR_LIST_LIMIT + 1))`, not `$(($PR_LIST_LIMIT + 1))`). The `$`-less ' +
          'form is required so this check never has to accept `$` in an expression ' +
          'it evaluates (#4466 note 4).'
        : 'not a `$(( ... ))` arithmetic expansion at all'

  check(
    'cross-file: gh is asked for exactly ONE more PR than the cap the guard enforces',
    { cap, expr, evaluated, ...(rejectedBecause === null ? {} : { rejectedBecause }) },
    (v) => v.cap !== null && v.evaluated === v.cap + 1,
  )

  // ── The two guards must agree about "next free". This script's window is
  // GAP_BOUND wide because check-session-log-numbering.sh's is; a change to
  // either that is not made to both hands out numbers the other rejects.
  const numbering = readFileSync(join(repoRoot, NUMBERING_GUARD), 'utf8')
  const boundThere = /^GAP_BOUND=(\d+)$/m.exec(numbering)
  check(
    `cross-guard: GAP_BOUND is the same in this script and ${NUMBERING_GUARD}`,
    { here: GAP_BOUND, there: boundThere === null ? null : Number(boundThere[1]) },
    (v) => v.there !== null && v.there === v.here,
  )

  // …and the window's ORIGIN, which the GAP_BOUND check above does not
  // cover (#4431 review note 2). That guard takes its max over `HEAD ∪
  // origin/main` — the BRANCH as well as the merge target — and
  // `suggestNextFree` mirrors the branch half by folding the self PR's own
  // claims into the origin. Pinned as TEXT, exactly like GAP_BOUND: if
  // either of those two lines is rewritten over there, this stops matching
  // and whoever rewrote it has to come here. The behavioural half of the
  // same fact (the suggestion actually landing inside that window) is
  // `runSuggestionCases`'s scenario loop.
  check(
    `cross-guard: ${NUMBERING_GUARD}'s window origin is still max(HEAD ∪ merge target)`,
    {
      unionIncludesHead: numbering.includes('"$head_nums" "$target_nums"'),
      expectedIsMaxPlusOne: numbering.includes('expected=$((existing_max + 1))'),
    },
    (v) => v.unionIncludesHead && v.expectedIsMaxPlusOne,
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
  runClaimSemanticsCases(ok, fail)
  runRenameCases(ok, fail)
  runSelfAttributionCases(ok, fail)
  runSuggestionCases(ok, fail)
  runMalformedPayloadCases(ok, fail)
  runTruncationCases(ok, fail)
  runPrLimitCases(ok, fail)
  runExitCodeCases(ok, fail)
  runFindingsOutputCases(ok, fail)
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
