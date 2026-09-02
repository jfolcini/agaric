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
//     never re-checks, because it only ever examines the STAGED ADDITIONS
//     of the commit in front of it (`--diff-filter=A`; a rename is invisible
//     to it, since it carries no `R` handling). Once the adding commit is
//     behind you, a sibling PR merging that number under your still-open PR
//     is invisible to it forever; that is exactly the #3690 "two
//     session-1281 files" shape, and the reason a green local guard is not
//     evidence for an open PR. This guard re-checks it on every CI run
//     against a base that is fresh at that moment, and reports it below as
//     a STALE CLAIM. The two overlap deliberately at the addition commit;
//     only this one covers everything after it.
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
// it's optional here only so ad-hoc invocations aren't forced to fabricate a
// limit that means nothing to them.
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
// mirrored from that script — so the ORIGIN matters as much as the width, and
// both must track it. The first number in the window that no
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
//                             throw)
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

import { readFileSync, realpathSync, writeSync } from 'node:fs'
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
 * script is bash — so keep this equal to the value there, or the two drift
 * into recommending numbers the other rejects.
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
    // A refusal attributes its (empty) findings to nobody and offers no
    // remedy: `selfPr` is what `reportFindings` reads to tell "the PR
    // reading this has a row in that table" from "it does not" (#4531
    // review note 1), and neither statement is available here.
    carrierRemedy: null,
    // A refusal allocated nothing, which is a different statement from
    // "allocated numbers that happened to be distinct" — the empty array
    // says so, and keeps the run-wide invariant checkable on every result
    // shape rather than only the verified one.
    allocated: [],
    selfPr: null,
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
 * This function does NOT allocate: it answers "what is next" and takes
 * nothing off the table, so calling it twice returns the same number twice
 * (#4531 review round 3). That is safe for its ONE remaining caller — the
 * CLEAN path's closing sentence, printed only when this run reports no
 * findings at all and therefore hands out nothing else. Every number offered
 * to somebody to TAKE goes through `createRunAllocator` instead, which is
 * the single place in this file that can hand the same number to two
 * readers and so the single place that has to make sure it never does.
 *
 * @param {Map<number, unknown>} claims
 * @param {number[]} mergedNums
 * @param {number[]} selfClaimedNums
 */
function suggestNextFree(claims, mergedNums, selfClaimedNums = []) {
  return firstFreeInWindow(Math.max(0, ...mergedNums, ...selfClaimedNums), claims, new Set())
}

/**
 * The numbers, among `claims`, that PR `pr` itself carries — the same rule
 * `selfClaimedNums` (in `analyze`) applies to the PR running this check,
 * generalized to ANY PR this run's `claims` map already has a row for.
 * `suggestNextFree`'s origin needs exactly this set for whichever PR the
 * suggestion is FOR: `check-session-log-numbering.sh` computes its own
 * window over THAT PR's own `HEAD ∪ origin/main`, not over the board as a
 * whole (see the doc comment above `suggestNextFree`).
 *
 * @param {number} pr
 * @param {Map<number, {prs:number[]}[]>} claims
 */
function claimedNumbersOf(pr, claims) {
  const nums = []
  for (const [number, entries] of claims) {
    if (entries.some((c) => c.prs.some((p) => Number(p) === Number(pr)))) nums.push(number)
  }
  return nums
}

/**
 * The first number in `suggestNextFree`'s own `GAP_BOUND`-wide window that
 * neither an open PR has claimed (`claims`) nor an earlier allocation in
 * this same run has already handed out (`taken`). Past the end of the
 * window this returns `null`, exactly as `suggestNextFree` does when every
 * number in it is spoken for — never a number outside the window, which
 * `check-session-log-numbering.sh` would reject on sight.
 *
 * This function is a pure LOOKUP and makes no distinctness claim of its own:
 * it only skips what its caller passes in `taken`, so two calls with the
 * same `taken` return the same number. Distinctness is a property of the
 * ALLOCATOR that owns the set, not of this scan — see `createRunAllocator`,
 * which is the only thing in this file that adds to one. Saying it here
 * rather than "distinctness then holds by construction" is #4531 review
 * note 3: the old wording was true within one `taken` set and silently
 * false across two, which is exactly how a second set came to exist.
 *
 * A shared `taken` set is the whole of the fix for #4531's blocking finding.
 * The previous shape was `nthFreeInWindow(origin, k, claims)` — the k-th
 * free number in the window, with `k` the claimant's RANK — which is
 * distinct-by-construction only while every claimant shares one window. It
 * does not, and need not: `rankedCollisionAssignment` derives each
 * claimant's origin from ITS OWN branch (a multi-entry PR carrying some
 * other number above the merge target starts higher — case 33). Two
 * differing windows made rank-indexing hand out the SAME number:
 *
 *   merge target max 1404; #100 claims 1423 and 1426, #200 claims 1423 and
 *   1424, 1425 unclaimed. #100 (rank 0) has origin 1426 and window
 *   1427..1436, so it takes 1427. #200 (rank 1) has origin 1424 and window
 *   1425..1434: 1425 is free but is only the 0th free number, 1426 is
 *   claimed, and 1427 is the 1st — so rank 1 lands on 1427 too. Both rows
 *   rendered `→ session-1427`, deterministically, from the same board.
 *
 * The same arithmetic also WASTED free numbers without colliding: rank k
 * skips the first k free numbers of its own window whether or not anybody
 * else could ever want them (case 33 offered 1452 with 1451 free).
 * Allocating SEQUENTIALLY through a shared `taken` set fixes both at once —
 * distinctness stops depending on the windows lining up, and no free number
 * is passed over unless something really did take it.
 *
 * @param {number} origin
 * @param {Map<number, unknown>} claims
 * @param {Set<number>} taken
 */
function firstFreeInWindow(origin, claims, taken) {
  for (let n = origin + 1; n <= origin + GAP_BOUND; n++) {
    if (claims.has(n)) continue
    if (taken.has(n)) continue
    return n
  }
  return null
}

/**
 * The origin of PR `pr`'s OWN suggestion window: the highest number either
 * already on the merge target or carried by that PR's own branch. One
 * definition, because every number this run offers anybody has to sit inside
 * the window `check-session-log-numbering.sh` will compute for THAT branch —
 * `max(HEAD ∪ origin/main)` — and three call sites deriving it separately is
 * how the two of them drift apart.
 *
 * @param {number} pr
 * @param {Map<number, {prs:number[]}[]>} claims
 * @param {number[]} mergedNums
 */
function windowOriginOf(pr, claims, mergedNums) {
  return Math.max(0, ...mergedNums, ...claimedNumbersOf(pr, claims))
}

/**
 * THE allocator: one per run of `analyze`, threaded through every place this
 * file produces a number for somebody to take. Its invariant is the whole
 * point — a number this run has handed out anywhere is never handed out
 * again, whatever finding, table, or remedy asks next.
 *
 * This exists because the same defect reached review three times, one level
 * further out each round, and each round's fix scoped the cure to the
 * instance in front of it:
 *
 *   1. #4518 — ONE number for a whole collision. Both colliding authors were
 *      told "the next free number is N", both took N, and the guard fired
 *      again on N. Fixed by giving each claimant its own number.
 *   2. #4531 round 2 — per-claimant, but by RANK INDEX into each claimant's
 *      own window, which is distinct only while the windows coincide. Two
 *      differing windows produced one number. Fixed by a sequential `taken`
 *      set inside `rankedCollisionAssignment`.
 *   3. #4531 round 3 (this) — that set was created PER COLLISION, so it
 *      reset between tables. Merge-target max 1404 with `{#100: 1423,
 *      #200: 1423, #300: 1424, #400: 1424}`: table A hands #100 1425 and
 *      #200 1426; table B starts from an empty set and hands #300 1425 and
 *      #400 1426. #100 and #300 are told the same number, from the SAME
 *      board, so every run computes it identically — deterministic
 *      convergence, not the race the tables' "sees the SAME open-PR board"
 *      qualifier covers. Worse, it is silent: each PR's report shows only
 *      its own collision, so neither author can see the other was sent to
 *      the same place. With `{#100: 1423 + 1424, #200: 1423, #300: 1424}`
 *      the two converging rows land in ONE report, both reading 1425.
 *
 * The shape is identical every time: two things that must be distinct are
 * allocated from independent, non-communicating scopes. So the scope is the
 * RUN, once, and nothing else in this file owns a `taken` set — the collision
 * tables, the stale-claim remedies and the row-less carrier's number all draw
 * from this one. `analyze` allocates board-wide and in a fixed order (every
 * collision's table, then every stale claim's per-file remedy, then every
 * row-less carrier's own number) BEFORE the self/other split, so two PRs
 * looking at the same board still compute the same allocation as each other
 * — the property the tables' stability claim rests on.
 *
 * `take` returns `null`, and consumes nothing, when the window is exhausted:
 * an honest "no number left" (see `firstFreeInWindow`), never a number
 * outside the window `check-session-log-numbering.sh` would reject on sight.
 *
 * @param {Map<number, unknown>} claims
 */
function createRunAllocator(claims) {
  /** @type {Set<number>} */
  const taken = new Set()
  return {
    /** Every number handed out by this run so far, in allocation order. */
    taken,
    /** @param {number} origin */
    take(origin) {
      const number = firstFreeInWindow(origin, claims, taken)
      if (number !== null) taken.add(number)
      return number
    },
  }
}

/**
 * Break a collision's tie the way #4518 asks for: `nextFreeSentence`'s
 * single "next free number" is a pure function of (merge target, open-PR
 * claims), so two colliding PRs run it against the same inputs and get
 * the SAME answer — each renumbers to it, and the guard fires again on
 * the identical collision one number higher. Neither author did anything
 * wrong; the answer just was not allocator-safe.
 *
 * Here every claimant is ranked by PR number — stable, visible to every
 * run that can see the collision at all (seeing every claimant's PR
 * number is what it takes to report the collision in the first place),
 * and therefore identical from whichever colliding branch computes it —
 * and handed a free number from ITS OWN window, not a shared one. "Its
 * own" matters: two claimants only share a window when their own branches
 * carry the same numbers above the merge target, which is the common case
 * (the colliding number IS that number for both) but not guaranteed — a
 * claimant whose branch also carries some OTHER number above the target
 * gets a window that starts higher, exactly as `suggestNextFree`'s own
 * origin already treats the running PR (case 16b/18b/18c above). The PR
 * actually running this check should read the entry naming ITS OWN
 * number; the others are shown only so the reader can see the assignment
 * is not one PR's private guess, and can tell whether it agrees with what
 * a sibling PR's own run would compute.
 *
 * Allocation is SEQUENTIAL, through the RUN-WIDE allocator this function is
 * handed, and NOT "the k-th free number in the window for rank k" (#4531
 * blocking finding). Rank-indexing computes every row independently, so it
 * is distinct-by-construction only while every claimant shares one window —
 * and the whole point of the paragraph above is that they need not. With
 * merge-target max 1404, `{#100: 1423 + 1426, #200: 1423 + 1424}` and 1425
 * unclaimed, rank 0 took 1427 out of its 1427..1436 window and rank 1 took
 * 1427 out of its 1425..1434 window (1425 was free but was only that
 * window's 0th free number, and 1426 was claimed) — two rows, one number,
 * deterministically, from a single board. Seeding each lookup with what the
 * earlier ranks were actually handed makes distinctness a property of the
 * allocation rather than of the windows lining up, and stops rank k
 * skipping the first k free numbers of its own window for nobody's benefit.
 *
 * The allocator is a PARAMETER and never created here (#4531 review round
 * 3). Owning one made this function's own rows distinct and said nothing
 * about anybody else's: `analyze` calls it once PER COLLISION, so the set
 * reset on every table and two tables on one board handed out the same
 * number. See `createRunAllocator` for the reproduction and for why the
 * scope has to be the RUN.
 *
 * @param {{claims:{pr:number, prs:number[], file:string}[]}} collision
 * @param {Map<number, {prs:number[]}[]>} claims
 * @param {number[]} mergedNums
 * @param {ReturnType<typeof createRunAllocator>} alloc
 */
function rankedCollisionAssignment(collision, claims, mergedNums, alloc) {
  const reps = [...new Set(collision.claims.map((c) => c.pr))]
  return reps.map((pr, i) => ({
    pr,
    rank: i + 1,
    total: reps.length,
    number: alloc.take(windowOriginOf(pr, claims, mergedNums)),
  }))
}

/**
 * The core analysis. Pure — no filesystem, no network — so it is exercisable
 * on its own, with nothing about argument parsing or process exit codes.
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

  // #4518: attach each collision's own DISTINCT per-claimant assignment
  // now, while `claims`/`mergedNums` are in scope — `reportFindings` only
  // sees `result`, so the tie-break has to travel on the finding object
  // itself rather than being recomputed from data it does not have.
  //
  // Everything this run will offer anybody comes off ONE allocator (#4531
  // review round 3 — see `createRunAllocator` for the three rounds of the
  // same defect that made the scope the run rather than the finding). The
  // order below is fixed and board-wide, computed BEFORE the self/other
  // split, so it does not depend on which PR is running the check: every
  // collision's table, then every stale claim's per-file remedy, then every
  // row-less carrier's own number.
  const mergedNumsArr = [...merged.byNumber.keys()]
  const alloc = createRunAllocator(claims)

  // #4531 review note 5: NEW objects, not `c.assignment = …` on the ones
  // built above. Attaching in place made a function whose doc comment leads
  // with "Pure" mutate its own intermediates — harmless while
  // `selfCollisions` filtered the very same array, and exactly the kind of
  // harmless-today that stops being obvious the moment somebody reuses one.
  //
  // Fields spelled out rather than spread (`oxc(no-map-spread)`), which also
  // makes the shape a reader can see without chasing where `collisions` was
  // built.
  const rankedCollisions = collisions.map((c) => ({
    number: c.number,
    claims: c.claims,
    assignment: rankedCollisionAssignment(c, claims, mergedNumsArr, alloc),
  }))

  // #4531 review round 4 note 2: a number that is BOTH a cross-PR collision
  // AND a stale claim (case 13/21: two open PRs both add session-1000,
  // already on the merge target) shares its `claims` array between the two
  // findings, entry for entry — the collision row for PR #101's file IS the
  // stale-claim entry for that same file. Looking up by `${number}:${pr}`
  // is what `rankedCollisionAssignment` already assigned that PR for that
  // number: one file, one number, reused by the second finding rather than
  // handed a fresh one of its own.
  const collisionNumberByPr = new Map(
    rankedCollisions.flatMap((c) => c.assignment.map((a) => [`${c.number}:${a.pr}`, a.number])),
  )

  // #4531 review note 1: a PR holding TWO stale claims holds two FILES, and
  // each needs its own number. The remedy was a single `remedySuggestion`
  // computed once per run and printed inside the per-finding loop, so such a
  // PR was told to renumber both files to the same one — self-contradictory
  // inside a single report, and the same "allocate, don't reuse" defect as
  // the tables. Allocated per claim ENTRY (one entry is one file), for every
  // stale claim on the board rather than only this PR's, so the numbering is
  // board-wide and self-independent like the tables above.
  //
  // A number this run already assigned that SAME (number, pr) via the
  // collision table above is reused rather than allocated again (round 4
  // note 2): without the reuse, case 13's own fixture told #101 to renumber
  // its one file to two different numbers in one report — a table row and a
  // stale-claim remedy disagreeing about the very file they both describe —
  // and burned a second window slot doing it.
  const remediedStaleClaims = staleClaims.map((s) => ({
    number: s.number,
    mergedPaths: s.mergedPaths,
    claims: s.claims,
    remedies: s.claims.map((cl) => {
      const reused = collisionNumberByPr.get(`${s.number}:${cl.pr}`)
      return {
        pr: cl.pr,
        prs: cl.prs,
        file: cl.file,
        number: reused ?? alloc.take(windowOriginOf(cl.pr, claims, mergedNumsArr)),
      }
    }),
  }))

  // #4531 review note 2: one number per row-less CARRIER, not one per
  // collision it carries. A stacked child inheriting two of its parent's
  // colliding session logs is short at most one number of its OWN (the
  // inherited files are not its to renumber — see `carrierWithoutRowAdvice`),
  // so it gets one, once, instead of the same paragraph and the same number
  // repeated per finding. Board-wide and PR-ordered for the same reason as
  // everything above it.
  const carrierPrs = [
    ...new Set(
      rankedCollisions.flatMap((c) =>
        c.claims
          .flatMap((cl) => cl.prs)
          .filter((p) => !c.assignment.some((a) => Number(a.pr) === Number(p))),
      ),
    ),
  ].toSorted((a, b) => a - b)
  const carrierRemedies = new Map(
    carrierPrs.map((p) => [p, alloc.take(windowOriginOf(p, claims, mergedNumsArr))]),
  )

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
  // With no `--self-pr` (an ad-hoc call, never the real CI
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
    selfPr === null ? rankedCollisions : rankedCollisions.filter((c) => isSelfClaim(c.claims))
  const otherCollisions =
    selfPr === null ? [] : rankedCollisions.filter((c) => !isSelfClaim(c.claims))
  const selfStaleClaims =
    selfPr === null ? remediedStaleClaims : remediedStaleClaims.filter((s) => isSelfClaim(s.claims))
  const otherStaleClaims =
    selfPr === null ? [] : remediedStaleClaims.filter((s) => !isSelfClaim(s.claims))

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

  // There is deliberately no single run-wide `remedySuggestion` field any
  // more (#4531 review round 3). One number reused by every remedy in a
  // report is the defect, not the fix for it: each finding now carries the
  // number IT was allocated (`staleClaims[].remedies[].number`,
  // `carrierRemedy`), so nothing downstream can reuse one by accident. The
  // only number left that is not an allocation is `suggestion`, and it is
  // printed on the CLEAN path alone, where this run hands out nothing else.
  //
  // `allocated` is every number this run offered anybody, in allocation
  // order — the run-wide distinctness invariant made observable in one place
  // rather than re-derived per finding (which is how the last two rounds of
  // this defect survived).
  return {
    verified: true,
    reason: null,
    warnings: [...warnings, ...boardWarnings],
    collisions: selfCollisions,
    staleClaims: selfStaleClaims,
    suggestion: suggestNextFree(claims, mergedNumsArr, selfClaimedNums),
    carrierRemedy: selfPr === null ? null : (carrierRemedies.get(Number(selfPr)) ?? null),
    allocated: [...alloc.taken],
    selfPr,
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
 * also accept, or an honest "none in the window" when it is exhausted.
 *
 * The `null` case has TWO distinct causes, and this function is called from
 * sites on both sides of that split (#4531 review round 4 note 3):
 *
 *   * the CLEAN path's closing sentence reads `result.suggestion` —
 *     `suggestNextFree`'s own non-allocating query, which never consumes
 *     from the run-wide `taken` set (see that function's doc comment). Its
 *     `null` really does mean every number in the window is in `claims` —
 *     an open PR has genuinely added a file naming it.
 *   * the carrier's advice and the per-file stale-claim remedy both read a
 *     number `alloc.take()` produced, which DOES draw from that shared set.
 *     A run with roughly ten or more findings can exhaust the window with
 *     numbers this run itself offered to OTHER findings above or below —
 *     each to a real open PR, but as a SUGGESTED remedy, not evidence that
 *     PR (or anybody else) has actually claimed that specific number, and
 *     nothing requires it ever will. Telling that reader "every one is
 *     already claimed by an open PR" names the wrong cause: the numbers are
 *     genuinely free of any actual claim, just already spoken for by this
 *     run's own bookkeeping. A guard that explains a refusal with the wrong
 *     reason sends the reader to look for contention that is not there.
 *
 * `exhaustedByRunAllocator` selects which explanation applies; the two
 * calls sourced from `alloc.take()` pass `true`, the CLEAN path's does not.
 *
 * @param {number|null} suggestion
 * @param {{exhaustedByRunAllocator?: boolean}} [opts]
 */
function nextFreeSentence(suggestion, { exhaustedByRunAllocator = false } = {}) {
  if (suggestion === null) {
    return exhaustedByRunAllocator
      ? `no number in ${NUMBERING_GUARD}'s window (the ${GAP_BOUND} above the merge target's ` +
          'max) is left for THIS finding — not because every one is claimed by an open PR, but ' +
          "because this run already offered every number in it as some OTHER finding's remedy " +
          'earlier in this same report (a collision row, another stale claim, or another ' +
          'carrier), whether or not that PR ever acts on it. Rebase onto the freshest ' +
          'origin/main and re-derive it there, or move further up your own window, past this ' +
          "run's own reservations rather than real contention."
      : `no number in ${NUMBERING_GUARD}'s window (the ${GAP_BOUND} above the merge target's max) ` +
          'is free — every one is already claimed by an open PR, so rebase onto the freshest ' +
          'origin/main and re-derive it there rather than taking one from this run.'
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
 * The per-claimant remedy line for one collision (#4518): naming a SINGLE
 * "next free number" here is exactly the bug, because every colliding
 * claimant's run computes that same single answer and converges back onto
 * an identical collision one number higher (`nextFreeSentence` is safe for
 * the no-collision case this function is not used for; see the header on
 * `rankedCollisionAssignment`). Each claimant is named with the DISTINCT
 * number its own rank resolves to, so a PR reading this need only find its
 * own `#pr` in the list.
 *
 * The denominator is stated rather than implied, and it is stated at FULL
 * strength (#4518 review): the assignment is stable across runs that see
 * the SAME board — not across runs, full stop. Both the rank (which
 * claimants of this number exist) and the enumeration (which numbers in the
 * window are already spoken for) are read off THIS run's `gh` snapshot, so
 * a claim that appears or disappears between two claimants' runs can shift
 * one table relative to the other and hand two of them the same number
 * after all. Verified, not theorised: with the board `{#4506:1423,
 * #4515:1423}` the two rows are 1424 and 1425, but if #4506's run also sees
 * a third PR holding 1424, ITS rows become 1425/1426 — and #4506 reading
 * 1425 lands exactly on what #4515's earlier run told #4515 to take. That
 * is a race, not the deterministic convergence #4518 reported (where the
 * SAME board produced the SAME answer for everyone, every round, forever),
 * but it is the same outcome, so the line has to say so and has to name the
 * way out: go FURTHER UP your own window rather than re-taking your row,
 * which is exactly how the reported incident was actually broken.
 *
 * @param {{pr:number, rank:number, total:number, number:number|null}[]} assignment
 */
function renumberAdvice(assignment) {
  const named = assignment.map((a) =>
    a.number === null
      ? `#${a.pr} (rank ${a.rank} of ${a.total}) — no free number left in its own window`
      : `#${a.pr} (rank ${a.rank} of ${a.total}) → session-${a.number}`,
  )
  return (
    // #4531 review note 3: "Each claimant takes a DISTINCT number" used to
    // stop there, and was true of THIS table and nothing else — a second
    // collision's table on the same board could hand one of its claimants a
    // number this one already named. The scope is now the run, so say the
    // run: the sentence has to be as wide as the guarantee and no wider,
    // which is what the previous round was written to fix one level in.
    '    Each claimant takes a DISTINCT number — distinct from every other row here, from ' +
    'every row of any OTHER collision reported below, and from every number this run offers ' +
    'further down, because one allocator hands out all of them. Ranked by PR number, so every ' +
    `run of this check that sees the SAME open-PR board computes the same assignment: ${named.join(', ')}. ` +
    "That board-conditional qualifier is the whole of the guarantee: this is THIS run's own " +
    'view of the board, not a reservation. A PR that has not pushed yet, and a PR whose ' +
    'changed-file list gh truncated at its 100-file cap, are both invisible here — either ' +
    'can take one of these numbers before you push, and either APPEARING between two ' +
    "claimants' runs shifts one table relative to the other, which can hand two of you the " +
    'same number after all. So rebase onto the freshest origin/main and re-check there ' +
    'rather than treating this as final — and if this fires AGAIN on the same PRs, the two ' +
    'runs saw different boards: do NOT re-take your row. Move FURTHER UP your own window ' +
    `instead (${NUMBERING_GUARD} accepts any free number in the ${GAP_BOUND} above your ` +
    "branch's max), which is what actually breaks the tie."
  )
}

/**
 * The remedy for a claimant that OWNS this finding but has no ROW in
 * `renumberAdvice`'s table (#4531 review note 1).
 *
 * The two keys disagree on purpose. Self-attribution reads `claim.prs` —
 * EVERY open PR whose `gh`-reported file list carries the path — because a
 * stacked child contains its parent's commits and would carry the duplicate
 * into the merge result (see `analyze`'s `isSelfClaim`). The table reads
 * `claim.pr`, the folded representative, because renumbering is a change to
 * ONE file and only the PR that owns it can make it. So a child stacked on
 * an open parent, carrying nothing but the parent's colliding session log,
 * is a self-claimant with no row: it fails closed, correctly, and
 * `renumberAdvice`'s "find your own #pr in the list" is false for it.
 *
 * It does not get a row of its own: the number in it would be for a file it
 * merely inherited, and taking one would only rename that file a second
 * time the moment the owner renumbers and the child rebases. What it gets
 * is the explanation and a number that is genuinely free — `carrierRemedy`,
 * allocated once for this PR out of the same run-wide allocator as every
 * table above — for a session log of its own, if that is what it is
 * actually short of.
 *
 * Printed ONCE per report, not once per collision (#4531 review note 2). A
 * stacked child inheriting two of its parent's colliding session logs got
 * this whole seven-line paragraph twice, naming the same number both times —
 * and the number was the same because it was one run-wide value reused, the
 * defect this round exists to remove. A PR is short of at most one session
 * log OF ITS OWN however many inherited files it carries, so one paragraph
 * and one number is also simply the right answer.
 *
 * @param {number|null} suggestion
 */
function carrierWithoutRowAdvice(suggestion) {
  return (
    '    THIS PR carries one or more of the files above but represents none of them, so no ' +
    'row in those tables names it. The usual cause is a STACKED branch: your base is another ' +
    'open PR, so its commits — and its session log — are in your changed-file list too, and a ' +
    "table's rows belong to the PRs that OWN those files. Renumbering a file you merely " +
    'inherited would only rename it a second time once the owner renumbers and you rebase, so ' +
    'do not take a number for it. The finding is still yours, because the duplicate reaches ' +
    'the merge result through you: wait for the owner to renumber, then rebase onto it (or ' +
    'onto the freshest origin/main once it lands) and re-run this check. If it is a session ' +
    'log of YOUR OWN that you still need a number for, this run answers that separately from ' +
    // #4531 review note 4: `nextFreeSentence` returns a lowercase INDEPENDENT
    // clause, so splicing it straight after a comma ("…need a number for,
    // the next free number is session-1322.") was a comma splice, and worse
    // in the `null` branch, where the clause is long enough to read as a
    // second sentence that lost its full stop. A colon introduces it
    // correctly and works for both branches without asking the sentence
    // above to know which one it got.
    // This PR's own number, like the stale-claim remedy below, comes from
    // `alloc.take()` — the run-wide allocator — never from the non-consuming
    // `suggestNextFree` the CLEAN path reads, so a `null` here is the
    // run's-own-reservations cause, not "every number is claimed" (see
    // `nextFreeSentence`).
    `every row above: ${nextFreeSentence(suggestion, { exhaustedByRunAllocator: true })}`
  )
}

/**
 * Both finding kinds RENDERED, each with the evidence for THAT kind — a
 * cross-PR collision names the other PR, a stale claim names the file
 * already on the merge target. Split out of `main()` so the two stay
 * distinct in the log: they have different causes and different fixes, and
 * a reader who cannot tell which one fired cannot act on either.
 *
 * Pure, and split out of `reportFindings` (which now only writes the joined
 * result) so the LINES are inspectable without a spawned process's stdout.
 * #4531's blocking finding was a defect in what two readers are TOLD, and it
 * survived two rounds because rendering could only be observed through a
 * whole process run. It is now checkable in-process, for any board.
 *
 * @param {ReturnType<typeof analyze>} result
 */
export function findingLines(result) {
  const total = duplicatedNumberCount(result)
  const lines = [
    `::error::check-session-log-pr-collision: ${total} session-log number(s) would be duplicated in the merge result`,
  ]
  for (const c of result.collisions) {
    const who = c.claims.map(describeClaim).join(' and ')
    lines.push(`  session-${c.number}: claimed by more than one open PR — ${who}`)
    lines.push('    One of these PRs must renumber; neither branch can see the other.')
    lines.push(renumberAdvice(c.assignment))
  }
  // #4531 review note 1: the table's rows are the folded REPRESENTATIVES
  // (`claim.pr`), while self-attribution keys on every CARRIER (`claim.prs`)
  // — so a PR can own this finding and have no row in it. The advice line
  // above tells such a reader to "find its own #pr in the list", and it is
  // not there to be found; before this, the closing "next free number"
  // sentence was suppressed for it too, leaving it with no number at all.
  //
  // #4531 review note 2: emitted after the loop, ONCE, rather than inside it
  // once per collision. A stacked child inheriting two of its parent's
  // colliding session logs got the identical paragraph and the identical
  // number twice; it is short of at most one session log of its own however
  // many it inherited, and `analyze` allocates exactly one for it.
  if (
    result.selfPr !== null &&
    result.collisions.some((c) => !c.assignment.some((a) => Number(a.pr) === Number(result.selfPr)))
  ) {
    lines.push(carrierWithoutRowAdvice(result.carrierRemedy))
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
    // #4518: the single shared "next free number" sentence is only unsafe
    // where a collision's per-claimant table ALREADY answered the same
    // question — printing both there would put the allocator-unsafe answer
    // `renumberAdvice` exists to replace right next to the correct one, for
    // a reader to grab by mistake. A stale claim has no such table (one
    // open PR is enough to hold one), so it needs this sentence.
    //
    // #4531 review note 2: that made it a GLOBAL gate
    // (`result.collisions.length === 0`), which is one finding's rule
    // applied to another's output — a run carrying BOTH kinds dropped the
    // number for the stale claim too, and the stale-claim author was left
    // with "rebase and renumber" and nothing to renumber TO. Gated per
    // finding instead: the sentence belongs to this stale claim and is
    // printed with it.
    //
    // #4531 review round 3, note 1: one line PER FILE, each naming its own
    // ALLOCATED number, not one `remedySuggestion` reused. Moving the
    // sentence into this loop while the number stayed a single run-wide
    // value made a two-stale-claim report actively self-contradictory — it
    // told one author to renumber two different files to the same number.
    // Every entry here is a distinct file that needs a distinct number, and
    // `analyze` allocated one for each out of the run-wide allocator, so
    // none of them can be a number a collision table above already handed
    // out either. Rendered uniformly whether there is one entry or five:
    // the single-entry shape is not special-cased, because a rendering
    // branch only the rare board reaches is precisely the branch nobody
    // writes a test for.
    for (const remedy of s.remedies) {
      // Each remedy number is `alloc.take()`'s (or reused from a collision
      // row that already was), so a `null` here is the run's own
      // reservations exhausting the window, not "every number is claimed
      // by an open PR" (#4531 review round 4 note 3, `nextFreeSentence`).
      lines.push(
        `    #${remedy.pr} (\`${remedy.file}\`): ` +
          `${nextFreeSentence(remedy.number, { exhaustedByRunAllocator: true })}`,
      )
    }
    lines.push(
      '    Rebase onto the freshest origin/main first, since another PR may claim it before ' +
        'you push.',
    )
  }
  return lines
}

/**
 * Write what `findingLines` rendered, as ONE synchronous write.
 *
 * `emitErr` (a single `writeSync`), not `console.error` (#4431 review round
 * 4 note 1): the CI step runs this guard under `2>&1 | tee collision.log`,
 * and a write to a PIPE is ASYNCHRONOUS in node — the exact hazard
 * `finish()`'s verdict line already guards against. `console.error` here is
 * the same hazard one level up: `main()` calls `finish()` (which
 * `process.exit`s) immediately after this function returns, so a long
 * finding list queued as async pipe writes can be truncated while the
 * SYNCHRONOUS verdict line still survives — a red job carrying `COLLISION`
 * with none of the explanation for which numbers collided. Since #4452 item
 * 3 the refusal, warning, OK and crash-handler paths go through the same
 * helper, so this is no longer the one careful site among four careless
 * siblings.
 *
 * The join stays HERE rather than in `findingLines` so there is still
 * exactly one write for the whole report: splitting the rendering out must
 * not become splitting the write up.
 *
 * @param {ReturnType<typeof analyze>} result
 */
function reportFindings(result) {
  emitErr(findingLines(result).join('\n'))
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

// Entry-point check (#3373): realpath BOTH sides.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  mainGuarded(process.argv.slice(2))
}
