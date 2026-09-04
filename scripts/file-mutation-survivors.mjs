#!/usr/bin/env node
// #2947 — push-based mutation-survivor triage loop.
//
// `scheduled-deep-checks.yml`'s `mutants` (cargo-mutants) and
// `mutants-frontend` (StrykerJS) lanes only ever surface survivors in that
// run's step summary — nobody is notified, so triage is pull-based (someone
// has to remember to open the summary). This script closes the loop: it
// reads both lanes' survivor output, diffs the combined set against the
// SINGLE open tracking issue's last-known set (encoded in a marked block in
// the issue body), and files/updates that one issue only when NEW survivors
// appear. Resolved survivors (previously listed, no longer present) are
// dropped from the tracked set whenever an update fires, but are never
// themselves a reason to touch the issue — a pure "some mutants got killed"
// week stays a no-op, same as a pure "nothing changed" week.
//
// State lives in the tracking issue itself (its body), not a committed
// baseline file — the workflow only needs `issues: write`, never
// `contents: write`, and there is nothing to keep in sync with a repo file.
//
// #3788 — "survivor" in the paragraph above is a historical name. What this
// tracks is two DIFFERENT findings, and for a year it silently tracked only
// one: Stryker's `NoCoverage` (no test executed the mutated code at all) was
// dropped alongside `Killed`, so code with NO TEST WHATSOEVER was reported
// nowhere while the weakly-tested lines beside it were. `date-utils` filed 11
// entries for 22 provably-equivalent survivors (#3787) and said nothing about
// its 14 `NoCoverage` mutants, which covered four exported functions with no
// test anywhere in `src` — triage was pointed at the one part of the file where
// no test could help. Both outcomes are now kept, counted separately everywhere
// a human reads them, and no-coverage ranks FIRST. See § Mutant outcomes below.
// The same change gave frontend ids the mutant's COLUMN: without it the id key
// was (file, line, mutator) and distinct mutants on one line collapsed into a
// single entry (agenda-sort rendered 21 lines for 31 survivors), which matters
// because status diverges by column — the whole-condition mutant is killed
// while a sub-operand mutant on the same line survives.
//
// Usage (from the repo root or anywhere — paths are resolved as given):
//   node scripts/file-mutation-survivors.mjs \
//     --lane rust|frontend          (REQUIRED: which lane's tracking issue this
//                                    run owns. Each lane has its own; without
//                                    this the script would have to guess which
//                                    one to rewrite.)
//     --rust-missed <path to cargo-mutants missed.txt>        (--lane rust)
//     --frontend-dir <dir to search recursively for Stryker mutation.json>
//                                                             (--lane frontend)
//     [--require-input]             (#3364: FAIL if THIS lane's input is
//                                    absent. Says nothing about the other
//                                    lane, which this run does not read.)
//     [--children]                  (also open/update/close ONE child issue per
//                                    AREA — see § Parent/child below)
//     [--max-children N]            (blast-radius cap on child CREATES in a
//                                    single run; default DEFAULT_MAX_CHILDREN)
//     [--repo owner/repo]           (default: $GITHUB_REPOSITORY)
//     [--run-url <url>]             (default: derived from $GITHUB_SERVER_URL
//                                    /$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID)
//     [--dry-run]                   (compute + print; never call `gh`)
//     [--known-body-file <path>]    (TEST-ONLY: use this file's content as
//                                    the existing tracking issue's body
//                                    instead of calling `gh issue list`;
//                                    a missing/empty file means "no existing
//                                    issue". Lets the diff+file/update logic
//                                    be exercised without real GitHub state.)
//
// Both `--rust-missed` and `--frontend-dir` are optional: a missing rust
// file or an empty/missing frontend dir simply contributes zero survivors
// from that lane (a lane that crashed before writing output should not be
// misread as "zero survivors", but that failure is already visible via the
// lane's own job status / step summary — this script only tracks the
// survivor *content*, not lane health). #3330 note: that premise was true
// for the `mutants` (Rust) lane, which has a zero-coverage guard outside its
// `|| true`, but was FALSE for `mutants-frontend`, which had no such guard
// and could not go red at all. It now has one
// (`scripts/check-mutation-reports.mjs`, wired as the lane's
// `Lane-liveness guard` step), so the premise holds for both lanes again.
//
// #3364: visibility of a lane failure is NOT the same as integrity of this
// script's state. The lane going red does not stop this job — it runs under
// `if: always()` — so a dead lane still contributes `[]`.
//
// That USED to be able to delete the other lane's survivors, because one body
// held both. It cannot now: each lane owns its own issue and a run reads only
// its own lane's input, so a dead lane can only ever empty ITS OWN block. That
// is still wrong, and `--require-input` still turns a MISSING input into a
// hard error so it stays distinguishable from an EMPTY one — the blast radius
// is just one lane instead of two. The resulting red filer job is itself
// reported by #3359's `report-scheduled-failures`, which `needs:` this job.
//
// Issue-body shape (#3245/#3257): the body carries exactly ONE deduped
// survivor list — the machine-readable marker block. Per-run deltas ("new
// this run") are carried by each entry's first-seen date, not by a second
// section, so no survivor is ever listed twice and no stale snapshot
// masquerades as "new". They used to go in a per-run comment; this job no
// longer comments at all.
// The rendered body is clamped to MAX_BODY_CHARS so a large survivor batch
// cannot 422 `gh issue edit` and wedge this weekly job red indefinitely.
//
// ── Parent/child (#3667) ──────────────────────────────────────────────────
//
// The rolling issue above is a good NOTIFICATION and a bad WORKTOP. Measured
// on 2026-08-09, issue #3142 carried 261 tracked survivors across 9 areas in a
// 40 756-character body — two thirds of the way to the MAX_BODY_CHARS clamp,
// with the whole backlog in one thread. Nothing in it can be assigned, closed,
// or referenced by a PR: the triage convention is "hand-edit your line out of
// a 40 KB machine-readable block", which is why the block still held every
// survivor the run that first populated it produced.
//
// `--children` adds the layer that was missing: one CHILD issue per AREA
// (`survivorArea` — a Stryker module for the frontend lane, a source file for
// the rust lane), carrying that area's survivor lines. An area is the unit a
// maintainer actually acts on — one sitting, one PR, one set of tests — and it
// is a unit this script already computes, ranks and renders (#3350).
//
//   parent  = rolling status + the ONE machine-readable survivor block
//   child   = the individual fix, one per area, linked both ways
//
// State stays single-copy in the PARENT. A child's survivor list is a pure
// projection re-rendered from the parent's block every run, so a child that a
// human closes, edits or deletes costs nothing: the next run rebuilds it. The
// alternative — giving each child its own marker block — would scatter the
// filer's only cross-run memory across N issues, where one hand-deleted child
// silently drops that area's whole tracked set and re-reports it as new.
//
// DEDUPLICATION, which is the part that goes wrong. Two tiers, both reusing
// mechanisms already in this repo rather than inventing a third:
//   1. The parent's body carries a SECOND marker block (`mutation-children`)
//      mapping `#<number>` -> area. That is the primary record, it is written
//      by the same run that made the `gh` calls, and it needs no network.
//   2. When tier 1 has no number for an area (first run, hand-edited block, a
//      run that created a child and then died before it could rewrite the
//      parent), the area's child is looked up by VERBATIM TITLE via
//      `gh issue list --state all` — exactly how `findTrackingIssue` finds the
//      parent. So an orphaned child is adopted, never duplicated.
// Child titles are therefore load-bearing in the same way the parent's is:
// `childIssueTitle(area)` is a pure function of the area, and renaming a child
// makes the next run adopt-or-file a fresh one.
//
// Children are opened/updated only where a comment would not do. The split
// follows what the sibling filers already established: an EDIT is state and
// notifies nobody, a COMMENT is the notification. So a child is created when
// its area first appears, its body is re-rendered every run it survives, and
// it is COMMENTED on only when that area gained a survivor this run. When the
// area's last survivor is killed the child is commented and CLOSED — a
// permanently-open "these mutants survive" issue is the same lie
// `file-scheduled-failures.mjs` refuses to leave open.
//
// `--max-children` caps CHILD CREATES IN ONE RUN and throws past it, in the
// same spirit as the `--require-*` gates: refuse with a diagnosis rather than
// do something unrecoverable. The default is DERIVED, at import time, from
// the actual size of the area universe (see DEFAULT_MAX_CHILDREN and #3667 —
// a pinned copy of that size silently went stale once already), so it
// cannot bite on real data and can only bite if `survivorArea` starts
// fragmenting.
//
// ── Accepted-equivalent mutants (#4173) ──────────────────────────────────
//
// Some mutants are UNKILLABLE by construction: a `case 'invalid':` arm that
// falls through to a documented no-op, an `if (pos < s.length)` guard that is
// redundant with `String.prototype.slice`'s own behaviour past the end, a `?.`
// mandated by `noUncheckedIndexedAccess`, a dev-only `assertAdvanced` label
// whose whole point is to be unreachable. No test can kill them and no test
// should be written trying.
//
// Before #4173 the only way to record that verdict was to hand-remove the
// line from the survivor block above — which is BYTE-IDENTICAL to the mutant
// having been killed. The next weekly run re-observed it, re-added it as
// "new", and re-opened the child issue that had just been closed. Measured on
// #3142's triage slice: 25 mutants across `classify`, `tokenize`,
// `query-utils` and `to-search-filter` were proven equivalent TWICE, by two
// different sessions, a week apart, reaching the same verdicts. The cost is
// not the re-filing — it is that each cycle spends a real triage session
// re-deriving arguments already written two comments up, and that a genuinely
// new survivor appearing inside a block of 25 known-equivalent ones is much
// harder to see.
//
// So the parent carries a THIRD marker block, `mutation-accepted`, holding the
// ids triage has ruled equivalent. The filer SUBTRACTS it from the OBSERVED
// set before the diff, so an accepted mutant is not new, does not enter the
// tracked set, does not re-open a child, and is not announced as resolved
// either (see `main`). It is the one block in this body a HUMAN writes: the
// filer never adds a line here, it only re-renders what it read and drops what
// has gone stale.
//
// This is NOT the `// Stryker disable` mechanism #3593 considered and
// rejected, and it does not reopen that decision. The objection recorded there
// stands: a `disable next-line ConditionalExpression` suppresses EVERY
// conditional mutant on the line, including observable siblings that are
// genuinely killable. An accepted-block entry is keyed on the whole mutant id —
// (file, line, column, mutator), which is exactly what #3788 added the column
// for — so it has no blast radius past the single mutant it names, and a
// sibling mutant on the SAME LINE still reports normally. `selfTestAcceptedGaps`
// pins that property specifically, because it is the entire reason this
// mechanism is acceptable where the directives were not.
//
// STALENESS is the cost, and RE-ANCHORING is the mitigation. An entry names a
// line, and lines move; an entry left in place after its line moved would
// permanently suppress whatever mutant now sits at that id — silence in the
// one direction this script exists to prevent. So an accepted entry matching
// NOTHING in the observed set is DROPPED on the next body rewrite, and the
// mutant re-reports normally the next time it is seen. The failure mode is
// therefore "you have to re-accept it after a refactor", never "it is
// suppressed forever". (The alternative canvassed in #4173 — stamping each
// entry with the commit that accepted it — records the same fact but still
// needs a human to act on it; dropping is the version that self-heals.)
//
// Note the premise re-anchoring shares with the survivor block: it reads the
// OBSERVED set, so a lane that silently contributed nothing would drop that
// lane's accepted entries along with its survivors. That is the #3364 hazard
// exactly, and `--require-input` is its guard for both blocks.
//
// Exit codes: 0 on success (including the no-op case), 1 on a real error
// (bad args, a `gh` call failing).

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// One PARENT PER LANE, selected by `--lane`.
//
// A single parent spanning both lanes made every partial run dangerous: the
// body is one set, so rewriting it from the lane that ran deletes the lane
// that did not and re-reports it the following week (#3364). `--require-*`
// existed only to turn that into a loud failure rather than silent damage.
// With one parent per lane there is nothing to protect — a lane writes its
// own issue and cannot see the other's — so a single-lane dispatch can write
// for real instead of dry-running, which is the whole point of the `lanes`
// input in `scheduled-deep-checks.yml`.
//
// Stable titles: the ONLY thing the find-or-file logic matches on. Never
// rename an existing issue with one of these — the script would stop finding
// it and file a duplicate.
//
// Keyed by `--lane`, not by the `[lane]` tag ids carry. An earlier draft held
// the tag here too, to filter a mixed id set; `main` reads only the lane's own
// input now, so nothing ever needed it.
export const LANES = {
  rust: {
    title: 'Mutation testing: rust survivor triage (auto-filed, do not rename)',
  },
  frontend: {
    title: 'Mutation testing: frontend survivor triage (auto-filed, do not rename)',
  },
}
export const LANE_NAMES = Object.keys(LANES)
export const TRACKING_ISSUE_LABELS = ['testing', 'github-actions']

const MARKER_START = '<!-- mutation-survivors:begin -->'
const MARKER_END = '<!-- mutation-survivors:end -->'

// The parent's SECOND marker block: area -> child issue number. Distinct
// prefix from the survivor block above (no substring collision), and rendered
// after it, so `parseKnownSurvivors` — which slices between the survivor
// markers — cannot see it and the tracked set is unaffected.
const CHILD_MARKER_START = '<!-- mutation-children:begin -->'
const CHILD_MARKER_END = '<!-- mutation-children:end -->'

// The parent's THIRD marker block (#4173): the mutant ids triage has PROVEN
// equivalent (unkillable). A distinct prefix again — no substring collision
// with either block above — and rendered after both, so neither
// `parseKnownSurvivors` nor `parseChildLinks` can see it and neither the
// tracked set nor the child map is affected. Unlike the other two, this block
// is HAND-WRITTEN by triage: the filer only ever re-renders what it read, and
// drops entries that have gone stale. See § Accepted-equivalent above.
const ACCEPTED_MARKER_START = '<!-- mutation-accepted:begin -->'
const ACCEPTED_MARKER_END = '<!-- mutation-accepted:end -->'

// GitHub rejects an issue title over 256 characters. A rust area is a source
// path, so this is reachable in principle; failing here beats a bare 422 from
// `gh issue create` that nobody can act on.
export const MAX_TITLE_CHARS = 256

// Blast-radius cap on child CREATES in a single run — DERIVED at import
// time, not pinned, from the same two sources the area universe is actually
// made of:
//   frontend  `MODULE_NAMES.length` in `stryker.modules.mjs` — one area per
//             enrolled Stryker module.
//   rust      non-test `.rs` files reachable through `examine_globs` minus
//             `exclude_globs` in `src-tauri/.cargo/mutants.toml` — one area
//             per source FILE, which is the only grouping cargo-mutants' ids
//             expose. Enumerated the way `check-mutants-scope.mjs` does for
//             the GLOB half (its exported `tomlStringArray` / `globMatches`,
//             `globSync` per glob filtered to `.rs`, deduped across globs in
//             a `Set` since globs can overlap) — reused from there rather
//             than reimplemented here.
//
//             TWO DELIBERATE DIVERGENCES, stated because the two counts
//             agreeing today (both 23) is not the same as them being the
//             same computation: that guard additionally drops files that
//             exist but sit OUTSIDE the packages the lane examines
//             (`insideAny(p, examinedDirs, workspace.members)`, its
//             `glob-outside-examined-packages` arm). This cap does not. A
//             file inside `examine_globs` but outside the examined package
//             set would inflate the cap here while that guard reports the
//             surface as collapsed — the #2621 arch-wave shape. Not fixed
//             here because the cap wants an UPPER bound on plausible area
//             count and over-counting fails safe, whereas that guard wants
//             the true mutable surface; but this is the axis on which the
//             two copies can drift, so it is named rather than left to be
//             re-discovered.
//
//             SECOND: this dedupes across globs in a `Set`, while that guard
//             sums `live.length - unreachable.length` PER GLOB with no dedup.
//             Overlapping `examine_globs` entries therefore count once here
//             and twice there. The `Set` is right for a per-FILE area count
//             — the cap is a count of areas, and an area is a file — but the
//             two numbers can differ for that reason alone, and an earlier
//             version of this comment claimed to enumerate the divergences
//             while naming only the first. That reuse is a LAZY `import()`
//             inside `countRustAreaFiles`, never a top-level one: the #3373
//             `main-module-detection` assertions copy THIS FILE ALONE to a
//             detached path and run `--self-test` there, and a static
//             `./check-mutants-scope.mjs` specifier makes that copy die at
//             module load with ERR_MODULE_NOT_FOUND before any assertion
//             runs. Keep it lazy.
//
// This used to be a pinned constant: 43 = 21 + 22, exactly right the day it
// was written (2026-08-09). It went silently wrong when
// `agaric-store/src/op_log/high_water.rs` landed on 2026-08-16 (`fbdebb6a1`,
// #4016) and grew the rust half to 23 — a commit with no reason to think
// about a mutation-triage cap, which is exactly why a pinned number is the
// wrong shape here. Re-pinning to 44 would only restart the same clock for
// the next unrelated file to land in `examine_globs`'s scope; deriving means
// there is no clock. (#3667)
//
// A run asking to create more children than the derived universe still
// cannot be reporting real areas — it is `survivorArea` fragmenting (an id
// shape change collapsing everything into `(unparsed)`, say). Raising the
// cap by enrolling more Stryker modules or widening `examine_globs` is still
// the deliberate, reviewed step the pinned comment described; it now simply
// takes effect by editing those sources instead of this number.
//
// Degrades LOUDLY, and generously. Every path resolution below is anchored
// on `import.meta.dirname`, never on `process.cwd()` — the weekly job's cwd
// is not guaranteed to be the repo root.
//
// A HALF that derives to zero is a broken derivation, not a small universe:
// `examine_globs` present-but-empty (or renamed, or the file re-sectioned so
// the regex misses it) yields `rust 0` and would otherwise quietly halve the
// cap to 21 — the same silent-staleness failure this change exists to kill,
// one branch over. So each half must be a positive integer or the whole
// derivation is declared failed, and a failed derivation WARNS on stderr
// naming the reason before falling back. A cap that reverts to a constant
// without saying so is the bug, not the fix.
const REPO_ROOT = resolve(import.meta.dirname, '..')
const MUTANTS_TOML_PATH = resolve(REPO_ROOT, 'src-tauri/.cargo/mutants.toml')
const STRYKER_MODULES_PATH = resolve(REPO_ROOT, 'stryker.modules.mjs')

// Named fallback, used ONLY when the derivation cannot run. Deliberately
// NOT today's universe (44).
//
// Pinning the fallback to the current measurement re-creates exactly the
// drift #3667 removes: derivation breaks + universe has since grown to 50 →
// cap 44 → the guard refuses a legitimate run, and a throw in this weekly
// job wedges it red with no self-healing path. The two errors are not
// symmetric. Too LOW wedges the job on a healthy run; too HIGH only means
// the fragmentation backstop does not fire during a window in which the
// derivation is already broken and already warning on stderr — and junk
// child issues are recoverable, a wedged weekly job is not.
//
// 150 is chosen against both bounds, not measured: ~3.4x today's universe of
// 44, which no plausible near-term growth reaches (the universe grows by
// single files and single enrolled modules), while staying under a real
// `survivorArea` fragmentation event — that produces one area per SURVIVOR,
// and the current wave alone carries ~222 (see `stryker.modules.mjs`). So
// the backstop still catches the thing it is for. This number does not need
// re-measuring when the universe grows; if it ever needs raising, the
// derivation is what should have caught it.
export const FALLBACK_MAX_CHILDREN = 150

// Set when the derivation gave up, so the cap's own error message can say
// "fallback" instead of claiming a measurement it never made — a triager
// told "the derived universe is 150" would go hunting for a fragmentation
// bug that is not there.
let maxChildrenIsFallback = false

function warnDerivationFailed(reason) {
  maxChildrenIsFallback = true
  console.error(
    `warning: could not derive DEFAULT_MAX_CHILDREN (${reason}); falling back to ${FALLBACK_MAX_CHILDREN}. The child-creation cap is NOT tracking the real area universe — fix the derivation rather than living with the fallback.`,
  )
}

/**
 * Non-test `.rs` files the rust lane's `examine_globs` actually reach, minus
 * `exclude_globs`. The `check-mutants-scope.mjs` helpers are imported lazily
 * on purpose — see the block comment above.
 */
async function countRustAreaFiles() {
  // WORKSPACE_DIR comes from the SIBLING, not a local copy. Both files must
  // agree on where the mutation workspace lives, and nothing compares two
  // duplicated literals — it is a drift axis the self-test below explicitly
  // cannot catch, so it is removed rather than documented (#4557 review).
  const { globMatches, tomlStringArray, WORKSPACE_DIR } = await import('./check-mutants-scope.mjs')
  const workspaceDir = resolve(REPO_ROOT, WORKSPACE_DIR)
  // BEFORE the `readFileSync` below, not after, which is what makes this
  // branch do its job instead of being dead code. `MUTANTS_TOML_PATH` is
  // `src-tauri/.cargo/mutants.toml` — strictly INSIDE the workspace dir — so
  // reading the config first meant a missing workspace threw ENOENT on the
  // TOML and this check could never fire. Checked first, a missing workspace
  // is reported as the missing workspace, rather than as a missing config
  // file inside it or as the caller's "examine_globs matched no .rs file"
  // arm, which would point a triager at globs in a directory that is not
  // there. `check-mutants-scope.mjs:245` guards the same globSync.
  if (!existsSync(workspaceDir)) {
    throw new Error(`workspace directory ${workspaceDir} does not exist`)
  }
  const config = readFileSync(MUTANTS_TOML_PATH, 'utf8')
  const examine = tomlStringArray(config, 'examine_globs')
  const exclude = tomlStringArray(config, 'exclude_globs')
  const files = new Set()
  for (const glob of examine) {
    for (const path of globSync(glob, { cwd: workspaceDir })) {
      if (!path.endsWith('.rs')) continue
      if (exclude.some((e) => globMatches(e, path))) continue
      files.add(path)
    }
  }
  return files.size
}

/** A derived half is only usable if it is a positive integer. */
function isUsableCount(n) {
  return Number.isInteger(n) && n > 0
}

export async function computeDefaultMaxChildren() {
  let frontendCount
  try {
    // Relative to THIS module's URL (not cwd); same file as
    // `STRYKER_MODULES_PATH` by construction, since `REPO_ROOT` is `../`.
    const { MODULE_NAMES } = await import('../stryker.modules.mjs')
    // Guard the SHAPE, not just the import: a non-array `MODULE_NAMES` gives
    // `.length` of `undefined` (silently NaN) or a string's length (silently
    // wrong), neither of which throws.
    if (!Array.isArray(MODULE_NAMES)) {
      warnDerivationFailed('stryker.modules.mjs did not export MODULE_NAMES as an array')
      return FALLBACK_MAX_CHILDREN
    }
    frontendCount = MODULE_NAMES.length
  } catch (err) {
    warnDerivationFailed(`could not import ${STRYKER_MODULES_PATH}: ${err.message}`)
    return FALLBACK_MAX_CHILDREN
  }
  let rustCount
  try {
    rustCount = await countRustAreaFiles()
  } catch (err) {
    warnDerivationFailed(`could not enumerate the rust lane's area files: ${err.message}`)
    return FALLBACK_MAX_CHILDREN
  }
  if (!isUsableCount(frontendCount)) {
    warnDerivationFailed(`the frontend half derived to ${frontendCount}`)
    return FALLBACK_MAX_CHILDREN
  }
  if (!isUsableCount(rustCount)) {
    warnDerivationFailed(
      `the rust half derived to ${rustCount} — examine_globs in ${MUTANTS_TOML_PATH} matched no non-excluded .rs file`,
    )
    return FALLBACK_MAX_CHILDREN
  }
  return frontendCount + rustCount
}

export const DEFAULT_MAX_CHILDREN = await computeDefaultMaxChildren()

/**
 * How many Stryker `mutation.json` reports a COMPLETE frontend run produces —
 * one per enrolled module, from the same `stryker.modules.mjs` that
 * `computeDefaultMaxChildren` reads.
 *
 * Used to gate the CLOSE, and only the close. The rust lane already refuses
 * to write from a partial set: a merge that reassembled fewer than its 21
 * shards forces `--dry-run`. The frontend lane has no such signal, and
 * `--require-input` passes on a SINGLE report, so a Stryker run that lost a
 * module's report rewrites the frontend issue from partial data.
 *
 * That rewrite is pre-existing (#3364 — the marker block is the only
 * cross-run memory) and is deliberately left alone here. What this PR adds is
 * the OUTCOME: the parent now closes when its set empties, so a partial run
 * could close the issue outright, and a closed issue is one nobody re-reads.
 * Gating the close is the whole of the new risk; widening `--require-input`
 * would be a different, pre-existing fix wearing this PR's clothes.
 *
 * `undefined` when the count could not be derived, in which case the close is
 * not gated rather than being gated on an invented threshold.
 */
export const EXPECTED_FRONTEND_REPORTS = await (async () => {
  try {
    const { MODULE_NAMES } = await import('../stryker.modules.mjs')
    return Array.isArray(MODULE_NAMES) && MODULE_NAMES.length > 0 ? MODULE_NAMES.length : undefined
  } catch {
    return undefined
  }
})()

// #3257 — a GitHub issue body maxes out at 65536 characters; past that
// `gh issue edit` 422s, node exits non-zero, and this weekly non-gating job
// goes red and STAYS red, because the following week recomputes the same
// oversized body from the same unchanged `known` set. Same cap and same
// "never cut the marker block mid-way" rule as the sibling
// `scripts/file-fuzz-findings.mjs`.
//
// #4032 — THE CEILING IN FINDINGS, measured rather than guessed, because the
// first `NoCoverage`-admitting run (#3788) may be the one that reaches it and
// "roughly 600" is not a number anyone can plan against. Binary-searched
// through `buildIssueBody` on 2026-08-17 with a run URL and every line dated,
// which is the widest the state block ever renders:
//
//   rust id      89 chars  ->  635 findings  (body 59 917, 5 619 under 65 536)
//   frontend id  82 chars  ->  689 findings  (body 59 990, 5 546 under 65 536)
//   no-cov id    81 chars  ->  697 findings  (body 59 959, 5 577 under 65 536)
//
// So ~635 findings is the floor of the ceiling, and the 5 536-char gap between
// this cap and GitHub's hard limit is the headroom: whatever prose is added to
// the head above, the body still lands well inside 65 536 rather than 422-ing.
//
// Past that the parent body THROWS (see the end of `buildIssueBody`) — it does
// not truncate, because the block is the filer's only cross-run memory and a
// short block silently shrinks the tracked set. That red weekly job is the
// designed outcome, not a bug to be patched by raising this number; the fix is
// a per-outcome cap or a spill-to-child strategy. Comment bodies used to
// truncate instead, holding no state; the CI job no longer comments at all.
// CHILD bodies truncate their FINDING lists, and may: a child carries no
// marker block, so it is a projection of the parent's state rather than
// state itself. The parent body is the one render that must never lose a
// line.
//
// One gap, stated rather than fixed: the accepted-equivalent note a close
// writes goes into the child's HEAD, which the truncation path does not cut
// — an area holding roughly 700+ accepted ids would 422 `gh issue edit` on
// close. `buildChildCloseComment` used to clamp exactly that list, and went
// with the other comment builders. Today's whole accepted set is 155 across
// every area, so this is a claim being half-true rather than a live failure;
// fixing it now would be engineering for a case 4x away.
export const MAX_BODY_CHARS = 60_000

// ---------------------------------------------------------------------------
// Mutant outcomes (#3788)
// ---------------------------------------------------------------------------
//
// Two Stryker statuses are worth tracking and they are NOT the same finding:
//
//   Survived   — a test executed the mutated code and did not fail. The test
//                is weak; strengthening it is the fix.
//   NoCoverage — no test executed the mutated code at all. There is no test to
//                strengthen; the fix is to write one.
//
// Until #3788 the filer kept only `Survived`, so the strictly WORSE outcome was
// invisible: `date-utils` carried 14 `NoCoverage` mutants covering four exported
// functions with no test anywhere in `src` (`getWeekRange`, `getWeekDays`,
// `formatWeekRange`, `getCalendarMonthRange`) while the issue it filed pointed
// triage at 22 survivors that turned out to be provably equivalent (#3787). The
// lane's own step summary (`scripts/render-mutation-summary.mjs`) has always had
// a `No cov` column — it was only the PERSISTENT report that dropped it.
//
// Both outcomes live in the ONE marker block (single-copy state is what keeps
// the filer from re-reporting, #3245/#3364), so each line has to self-identify.
// `NoCoverage` ids carry this verbatim-Stryker-status suffix; an id without it
// is a survivor. The suffix is at the END so `survivorArea` — which anchors at
// the start — is unaffected, and it is greppable from the rendered body.
export const NO_COVERAGE_SUFFIX = ' (NoCoverage)'

/** `'NoCoverage'` for a no-coverage id, `'Survived'` for everything else. */
export function mutantOutcome(id) {
  return id.endsWith(NO_COVERAGE_SUFFIX) ? 'NoCoverage' : 'Survived'
}

/**
 * Splits a set of ids by outcome, preserving order. The two halves are counted
 * and rendered separately everywhere a human reads them, because the action
 * they ask for is different — merging them into one number tells a reader "the
 * tests missed this" when the truth is "there are no tests".
 */
export function partitionByOutcome(ids) {
  const survived = []
  const noCoverage = []
  for (const id of ids) {
    if (mutantOutcome(id) === 'NoCoverage') noCoverage.push(id)
    else survived.push(id)
  }
  return { survived, noCoverage }
}

/**
 * #3788 MIGRATION — the pre-#3788 form of a frontend survivor id, or
 * `undefined` when `id` has no pre-#3788 form.
 *
 * Frontend ids gained a `:<column>` this release (the second half of #3788: the
 * old line-level id collapsed several genuinely distinct mutants into one entry
 * — agenda-sort rendered 21 lines for 31 survivors, and status DIVERGES by
 * column, so an agent that killed the mutant at col 7 reasonably read the line
 * as done while col 24 stayed alive). Every existing frontend id in the
 * tracking issue therefore changes shape exactly once.
 *
 * Without a mapping back, the first run after this change would report the whole
 * standing frontend backlog as resolved AND as new in the same breath, and
 * restamp every first-seen date to today — the precise lie #3350 exists to
 * prevent, and #3245's double count in a new costume. So: a current id whose
 * pre-#3788 form is already tracked is NOT new, its predecessor is NOT resolved,
 * and it inherits its predecessor's first-seen date.
 *
 * #4032 — WHAT THAT COSTS, on the one run it applies. "Not new" reads as *the
 * mutant was always there, we only respelled it*, and for a line carrying
 * exactly one mutant that is exactly what happened. It is NOT what happened
 * when the old line-level id collapsed several: one tracked predecessor,
 * several current ids mapping back to it, so a mutant that started surviving
 * THIS WEEK at `f.ts:86:24` is absorbed as "not new" alongside the `f.ts:86:7`
 * that genuinely was tracked, inherits the legacy first-seen date, and is never
 * announced. Collapsing several mutants into one entry is precisely the defect
 * the column exists to fix, so the absorbed ids sit in exactly the lines this
 * change was written for.
 *
 * Accepted rather than fixed, and the trade is one-sided: a line-level
 * predecessor records no column, so there is nothing to compare the new one
 * against and no way to tell the tracked mutant from its new neighbour. The
 * only alternative is "treat every reshaped id as new" — the whole-backlog
 * churn two paragraphs up. An absorbed finding is unannounced, not lost: from
 * that run on it is in the state block, in its area's child body and in the
 * parent's counts, and only the one-off "new this run" comment misses it.
 *
 * Deliberately `undefined` for `NoCoverage` ids. Their pre-#3788 form would be
 * the survivor id at the same line and mutator, which the old filer could well
 * have been tracking for a different mutant on that line — inheriting from it
 * would silence the very finding this change exists to surface. A NoCoverage
 * mutant was never tracked before, so it is genuinely new, and says so.
 *
 * Self-retiring: once a run rewrites the block with the new ids, no legacy id
 * remains for this to match, and it becomes inert.
 */
export function legacyFrontendId(id) {
  if (mutantOutcome(id) !== 'Survived') return undefined
  const m = /^(\[frontend\] .+?:\d+):\d+( \[[^\]]+\])$/.exec(id)
  return m ? `${m[1]}${m[2]}` : undefined
}

// ---------------------------------------------------------------------------
// Parsing survivor sources
// ---------------------------------------------------------------------------

/**
 * cargo-mutants' `missed.txt` is one survivor per line, already a stable,
 * human-readable description (`<file>:<line>:<col>: replace ... with ...
 * in ...`). We treat each non-blank trimmed line as an opaque survivor ID —
 * it's already unique and stable across runs as long as the mutant and its
 * location don't change.
 *
 * #3788 note: there is no rust half to the NoCoverage fix. cargo-mutants has no
 * such outcome — every mutant it generates is built and run, and its outcomes
 * are caught/missed/unviable/timeout — so `missed.txt` is survivors and only
 * survivors. The blind spot was Stryker-only. These ids already carry a column
 * (`<file>:<line>:<col>:`), so they also need no migration.
 */
export function parseRustSurvivors(missedTxtPath) {
  if (!existsSync(missedTxtPath)) return []
  const text = readFileSync(missedTxtPath, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `[rust] ${line}`)
}

/**
 * Recursively finds every `mutation.json` under `dir` (Stryker's per-module
 * JSON report, one per module directory — see `stryker.modules.mjs` /
 * `scripts/run-mutation.mjs`) and extracts its actionable mutants, in the
 * `<module>: <file>:<line>:<col> [<mutatorName>]` shape (plus the
 * `NO_COVERAGE_SUFFIX` for a no-coverage mutant).
 *
 * #3788, two changes to what this returns, both of them "the report was not
 * faithful to the JSON":
 *
 *   NoCoverage is kept.  It used to be dropped along with Killed/Timeout, so a
 *     function with NO TEST AT ALL was reported nowhere while the weakly-tested
 *     lines beside it were. See the § Mutant outcomes note above.
 *
 *   The id carries the COLUMN.  Without it the id is a (file, line, mutator)
 *     key, and `diffSurvivors` deduplicates on it — so several distinct mutants
 *     on one line collapsed into a single entry and the counts under-reported
 *     (agenda-sort: 21 entries for 31 survivors). Column is exactly where the
 *     status diverges: on a compound condition the whole-condition mutant is
 *     routinely killed while a sub-operand mutant on the same line survives, and
 *     a line-level entry cannot say so. `location.start.column` makes the key
 *     (file, line, column, mutator), which is Stryker's own mutant identity.
 *
 * Everything else (Killed, Timeout, CompileError, RuntimeError, Ignored) is not
 * a finding and stays out.
 */
export function parseFrontendSurvivors(dir) {
  if (!existsSync(dir)) return []
  const survivors = []
  for (const jsonPath of findMutationJsonFiles(dir)) {
    let report
    try {
      report = JSON.parse(readFileSync(jsonPath, 'utf8'))
    } catch {
      continue // malformed/partial report — skip, don't crash the whole run
    }
    // Module name = the mutation.json's parent directory basename, matching
    // how `scripts/run-mutation.mjs` lays out `reports/mutation/<module>/`.
    const module_ = jsonPath.split('/').at(-2) ?? 'unknown'
    for (const [file, entry] of Object.entries(report.files ?? {})) {
      for (const mutant of entry.mutants ?? []) {
        if (mutant.status !== 'Survived' && mutant.status !== 'NoCoverage') continue
        const line = mutant.location?.start?.line ?? '?'
        const column = mutant.location?.start?.column ?? '?'
        const suffix = mutant.status === 'NoCoverage' ? NO_COVERAGE_SUFFIX : ''
        survivors.push(
          `[frontend] ${module_}: ${file}:${line}:${column} [${mutant.mutatorName}]${suffix}`,
        )
      }
    }
  }
  return survivors
}

/**
 * #3364 — how many Stryker `mutation.json` reports the frontend artifact
 * actually contains. ZERO is the machine-checkable signature of "no data":
 * a `mutants-frontend` lane that ran at all writes one report per module (the
 * lane's own liveness guard, `check-mutation-reports.mjs`, fails on a module
 * that produced none), so zero reports can only mean the artifact was never
 * uploaded or arrived empty — never "the frontend has no survivors".
 */
export function frontendReportCount(dir) {
  if (!existsSync(dir)) return 0
  return findMutationJsonFiles(dir).length
}

function findMutationJsonFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(full)
      } else if (entry === 'mutation.json') {
        out.push(full)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Diffing against the tracking issue's known state
// ---------------------------------------------------------------------------

// #3350 — each state-block line may carry a `YYYY-MM-DD<TAB>` first-seen
// prefix. Lines written before #3350 have no prefix and must keep parsing to
// exactly the same survivor id, or the first run after this change would read
// the whole tracked set as resolved-and-new-again. Hence: optional prefix,
// stripped on read, never part of the id.
const FIRST_SEEN_PREFIX = /^(\d{4}-\d{2}-\d{2})\t/

/**
 * The lines inside ONE fenced marker block. Parameterised over the markers
 * (#4173) because there are now two blocks with identical framing that carry
 * ids — the survivor block and the accepted-equivalent block — and a
 * copy-pasted slicer is how the two would eventually disagree about what
 * counts as a line. `parseChildLinks` keeps its own reader: its lines are
 * `#<number><TAB><area>`, not mutant ids.
 *
 * The boundary rule itself is split out into `markerBlockRange` for the same
 * reason: `parseReanchorNotes` has to ask "is this line INSIDE a block?" and a
 * second copy of the `indexOf` arithmetic is how that reader and this one would
 * eventually disagree about where a block ends. One rule, two callers — and in
 * particular both share the `end < start` case that returns nothing at all,
 * which is the case a poisoned marker creates.
 */
function markerBlockRange(body, startMarker, endMarker) {
  if (!body) return null
  const start = body.indexOf(startMarker)
  const end = body.indexOf(endMarker)
  if (start === -1 || end === -1 || end < start) return null
  return [start + startMarker.length, end]
}

function markerBlockLines(body, startMarker, endMarker) {
  const range = markerBlockRange(body, startMarker, endMarker)
  if (range === null) return []
  const block = body.slice(range[0], range[1])
  // The block is a fenced code block; strip the ``` fences and blank lines.
  // Only the trailing whitespace is trimmed — a leading trim would eat the
  // first-seen prefix's own separator on a malformed line and silently mint a
  // different survivor id.
  return block
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').replace(/^ +/, ''))
    .filter((l) => l.length > 0 && l !== '```')
}

function stateBlockLines(body) {
  return markerBlockLines(body, MARKER_START, MARKER_END)
}

function acceptedBlockLines(body) {
  return markerBlockLines(body, ACCEPTED_MARKER_START, ACCEPTED_MARKER_END)
}

/**
 * The `YYYY-MM-DD` prefix of every dated line in a block, keyed by the id it
 * prefixes. Lines with no prefix are simply ABSENT from the map rather than
 * defaulted: see `parseFirstSeen` for why "unknown" and "today" must not be
 * the same value.
 */
function blockDates(lines) {
  const out = new Map()
  for (const line of lines) {
    const m = FIRST_SEEN_PREFIX.exec(line)
    if (m) out.set(line.slice(m[0].length), m[1])
  }
  return out
}

/** Extracts the tracked survivor set from a tracking-issue body (or `''`/undefined for "no issue yet"). */
export function parseKnownSurvivors(body) {
  return new Set(stateBlockLines(body).map((l) => l.replace(FIRST_SEEN_PREFIX, '')))
}

/**
 * #3350 — extracts survivor id -> first-seen date (`YYYY-MM-DD`) from the
 * state block. Lines with no prefix (everything written before #3350, and
 * anything a human hand-edits in) are simply absent from the map, which
 * renders as "unknown" rather than as "seen today": claiming a survivor is
 * new when we do not know is the exact failure #3245 was about.
 */
export function parseFirstSeen(body) {
  return blockDates(stateBlockLines(body))
}

/**
 * #4173 — the mutant ids a human has recorded in the accepted-equivalent
 * block: proven unkillable, and therefore subtracted from the observed set
 * instead of re-reported every week. Mirrors `parseKnownSurvivors` exactly,
 * including the optional date prefix — same regex, different meaning (there it
 * is "first seen", here "accepted on"), and stripped on read in both so the
 * prefix can never become part of the id. An entry a triager pasted without a
 * date must parse to the same id as the same entry with one, or the block
 * would silently suppress nothing on the run after it was written.
 */
export function parseAcceptedSurvivors(body) {
  return new Set(acceptedBlockLines(body).map((l) => l.replace(FIRST_SEEN_PREFIX, '')))
}

/** #4173 — accepted-equivalent id -> the `YYYY-MM-DD` it was accepted on, where recorded. */
export function parseAcceptedOn(body) {
  return blockDates(acceptedBlockLines(body))
}

/**
 * #3350 — splits a survivor id into the area it belongs to, so the report can
 * group and rank by area instead of rendering one flat wall of lines.
 *
 * The two lanes encode their ids differently and neither is going to change:
 *   `[rust] agaric-store/src/op.rs:10:5: replace ... with ... in ...`
 *   `[frontend] glob-validate: src/lib/search-query/glob-validate.ts:12 [X]`
 * so rust groups by source FILE (cargo-mutants has no module concept the
 * filer can see) and frontend groups by Stryker MODULE (which is exactly the
 * unit `stryker.modules.mjs` enrols and a triager acts on).
 *
 * Anything unparseable falls back to the lane tag alone rather than being
 * dropped — a survivor that does not fit the shape is still a survivor.
 */
export function survivorArea(id) {
  const rust = /^\[rust\]\s+([^\s:]+):/.exec(id)
  if (rust) return `rust: ${rust[1]}`
  const frontend = /^\[frontend\]\s+([^:]+):/.exec(id)
  if (frontend) return `frontend: ${frontend[1].trim()}`
  const lane = /^\[([a-z]+)\]/.exec(id)
  return lane ? `${lane[1]}: (unparsed)` : '(unparsed)'
}

/**
 * Groups mutant ids by `survivorArea`, worst first.
 *
 * "Worst" is NO-COVERAGE COUNT first (#3788), then total, then area name for
 * determinism. An area with untested code outranks an area with the same number
 * of weakly-tested lines: the second has tests that can be sharpened, the first
 * has none at all, and the ranking is the whole navigational claim of the
 * report.
 *
 * #4032 — the equal-count tiebreak above is the mild half of what this actually
 * does. Because the FIRST comparator is the no-coverage count and only ties
 * there fall through to total, ANY area holding one no-coverage mutant outranks
 * EVERY survivor-only area, however large: 1 no-coverage sorts above 500
 * survivors. That is deliberate and it is the ranking's point — "there is no
 * test here" is a different and worse fact than "the tests are weak", and no
 * quantity of the second adds up to the first — but it is strong enough to
 * surprise a reader who saw only the tiebreak sentence, so it is written down.
 *
 * Each group also carries its two halves so callers never have to re-derive
 * (and risk disagreeing about) the split.
 */
export function groupByArea(ids) {
  const byArea = new Map()
  for (const id of ids) {
    const area = survivorArea(id)
    if (!byArea.has(area)) byArea.set(area, [])
    byArea.get(area).push(id)
  }
  return [...byArea.entries()]
    .map(([area, members]) => {
      const sorted = members.toSorted()
      const { survived, noCoverage } = partitionByOutcome(sorted)
      return { area, members: sorted, survived, noCoverage }
    })
    .toSorted(
      (a, b) =>
        b.noCoverage.length - a.noCoverage.length ||
        b.members.length - a.members.length ||
        a.area.localeCompare(b.area),
    )
}

export function diffSurvivors(current, known) {
  const currentSet = new Set(current)
  // #3788 — a tracked id whose successor is in `current` was not resolved, and
  // NO successor of it is announced as new. See `legacyFrontendId` for why
  // skipping this would make the release itself report the entire frontend
  // backlog twice, as resolved and as new, and reset every first-seen date —
  // and for the price of the "no successor": one predecessor can have several
  // successors, and the ones that are genuinely new go unannounced with the
  // rest on the single run this applies.
  const superseded = new Set()
  for (const id of currentSet) {
    const legacy = legacyFrontendId(id)
    if (legacy !== undefined && known.has(legacy)) superseded.add(legacy)
  }
  const newOnes = [...currentSet]
    .filter((s) => !known.has(s) && !superseded.has(legacyFrontendId(s)))
    .toSorted()
  const resolvedOnes = [...known].filter((s) => !currentSet.has(s) && !superseded.has(s)).toSorted()
  return { newOnes, resolvedOnes, all: [...currentSet].toSorted() }
}

/**
 * #3788 — the first-seen date of `id`, inheriting its pre-#3788 predecessor's
 * date when the id itself has none. One resolution rule, shared by the parent
 * table, the parent state block and the child bodies, so the three cannot
 * disagree about how old a finding is.
 */
function recordedFirstSeen(firstSeen, id) {
  return firstSeen.get(id) ?? firstSeen.get(legacyFrontendId(id))
}

// ---------------------------------------------------------------------------
// Child issues, one per area
// ---------------------------------------------------------------------------

/**
 * A child's title is a PURE FUNCTION of its area and is the tier-2 dedup key
 * (see § Parent/child in the header): the run that cannot find a recorded
 * number for an area searches for this exact string before it files anything.
 * Same contract as the parent's title in `LANES`, and the same warning —
 * rename one and the next run adopts-or-files a fresh child.
 */
export function childIssueTitle(area) {
  const title = `Mutation survivors — ${area} (auto-filed, do not rename)`
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(
      `the child issue title for area "${area}" is ${title.length} chars, over GitHub's ${MAX_TITLE_CHARS}-char limit — \`gh issue create\` would 422. Shorten the area key in survivorArea().`,
    )
  }
  return title
}

/** Reads the parent's `area -> child number` block. Absent/blank block ⇒ empty map. */
export function parseChildLinks(body) {
  const out = new Map()
  if (!body) return out
  const start = body.indexOf(CHILD_MARKER_START)
  const end = body.indexOf(CHILD_MARKER_END)
  if (start === -1 || end === -1 || end < start) return out
  for (const raw of body.slice(start + CHILD_MARKER_START.length, end).split('\n')) {
    const m = /^\s*#(\d+)\t(.+?)\s*$/.exec(raw)
    // Keyed by AREA, not by number: the area is what the next run computes and
    // looks up. A duplicate area line (hand-edit) keeps the first number, which
    // is the one the earlier run actually wrote.
    if (m && !out.has(m[2])) out.set(m[2], Number(m[1]))
  }
  return out
}

function renderChildBlock(childLinks) {
  if (childLinks.size === 0) return []
  const lines = [
    '### Child issues (one per area)',
    '_Machine-readable — do not hand-edit the marker lines below. Deleting a line does not lose any survivor state (the child is a projection of the block above); the next run re-adopts the child by its title, or files a fresh one._',
    CHILD_MARKER_START,
    '```',
  ]
  for (const [area, number] of [...childLinks.entries()].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`#${number}\t${area}`)
  }
  lines.push('```', CHILD_MARKER_END)
  return lines
}

/**
 * #4173 — the accepted-equivalent block: the ONE part of this body a human
 * writes and the filer only maintains.
 *
 * Two properties the preamble has to carry, because a reader who gets either
 * wrong will misuse the block:
 *   - it is HAND-EDITED, the exact opposite of the two blocks above it. The
 *     filer never adds a line here; a mutant becomes accepted only because a
 *     triager decided it was unkillable and wrote it down.
 *   - an entry suppresses exactly the one mutant its id names. That is the
 *     difference from the `// Stryker disable` directives #3593 rejected, and
 *     it is what makes the block safe to hand a triager at all.
 *
 * Rendered ALWAYS, empty included — unlike the child block, and deliberately
 * so. The head above tells a triager to "copy the id into the
 * accepted-equivalent block at the bottom of this body", and the how-to
 * preamble that tells them the line shape lives inside this block: on an issue
 * with nothing accepted yet, rendering only when non-empty meant the
 * instructions pointed at a block that was not on the page, and the FIRST
 * triager — the only one who has never seen the mechanism work — had to invent
 * the marker syntax from the script source. So the empty block IS the template:
 * markers, fence, and a line saying what goes between them. Measured, not
 * estimated: 1085 characters of the body budget on every body that renders,
 * which moves the #3257 clamp ceiling from 597 rust-shaped findings to 586. The
 * ladder's rungs are unchanged — the block is STATE and was never a rung — and
 * eleven findings of headroom is what the instruction being true costs.
 *
 * `reanchored` is the re-anchoring history (see `appendReanchorNote`): the
 * filer's own note of the entries it dropped. It renders here, ABOVE the
 * markers and therefore outside everything `parseAcceptedSurvivors` reads —
 * which holds only because `noteSafeId` has broken the marker delimiters in
 * every line spliced in here, whether this run wrote it (`appendReanchorNote`)
 * or read it out of the previous body (`parseReanchorNotes`). Position alone
 * does not buy it: the markers are found by `indexOf` over the whole body, so
 * an unsanitised note ABOVE them can move the boundary and put itself INSIDE
 * the block it was meant to sit outside. `reanchored` is therefore only ever
 * the output of those two functions — hand this a raw body line and the
 * guarantee is gone.
 */
function renderAcceptedBlock(accepted, acceptedOn, reanchored = []) {
  const lines = [
    `### Accepted-equivalent mutants (${accepted.length})`,
    "_Hand-edited — **this block is yours, not the filer's**. Record a mutant here once triage has PROVEN it equivalent (unkillable), and the weekly run stops re-filing it: copy its id verbatim from the block above, in the same `<accepted-on date><TAB><mutant>` shape (the date is bookkeeping and is ignored). The filer never adds a line here. It only re-renders what it read, and DROPS any entry whose id matches no observed mutant — so an entry whose line has moved stops suppressing anything and that mutant re-reports normally, rather than staying silently hidden (#4173). An entry suppresses **only the one mutant it names**: a different mutant on the same line, same mutator or not, still reports._",
  ]
  if (accepted.length === 0) {
    lines.push(
      '_Nothing accepted yet — **the empty block below is the template**. Paste one line per proven-unkillable mutant between the two marker comments, inside the fence, and the next run stops reporting it. Keep the marker comments exactly as they are: they are what the filer reads._',
    )
  }
  if (reanchored.length > 0) {
    lines.push(
      `_Re-anchoring history — entries the filer DROPPED because they matched no observed mutant (their mutants report normally again until re-accepted). Kept in the body because a dropped entry is a triage verdict quietly expiring, and the run log that recorded the drop expires with the run; the ${MAX_REANCHOR_NOTES} most recent are kept. These are history, not state: the ids below are not suppressing anything._`,
      ...reanchored,
    )
  }
  lines.push(ACCEPTED_MARKER_START, '```')
  for (const id of accepted) {
    const on = acceptedOn.get(id)
    lines.push(on ? `${on}\t${id}` : id)
  }
  lines.push('```', ACCEPTED_MARKER_END)
  return lines
}

/**
 * #4173 residual — the durable half of re-anchoring.
 *
 * Dropping a stale accepted entry is the SAFE direction (the mutant re-reports
 * rather than staying hidden), but it also silently retires a triage verdict a
 * human spent a session reaching, and until now the only record that it had
 * happened was a line in a CI log that GitHub deletes with the run. If every
 * recorded entry went stale in one run — a file rename does exactly that — the
 * whole block vanished from the issue and nothing on the page said why.
 *
 * So the drop is written into the body itself, as prose OUTSIDE the markers,
 * newest last and capped: bounded growth, and a triager who wonders why a
 * mutant they accepted in March is back has the answer on the page they are
 * already looking at.
 *
 * The ids in a note are deliberately NOT part of any findings list — #3245's
 * "no finding appears twice" rule is about the lists a triager counts, and a
 * history bullet is not one. A dropped id that later comes back as a live
 * survivor is therefore in the state block AND named in the history, which is
 * the honest rendering of "this came back after we retired it".
 */
const REANCHOR_NOTE_PREFIX = '- **Re-anchored '
const MAX_REANCHOR_NOTES = 5

/**
 * A note is the ONE place this filer echoes HAND-EDITED body text back into the
 * body, un-fenced and — because the note renders above the markers — EARLIER in
 * it than `ACCEPTED_MARKER_START`. Every marker here is an HTML comment and
 * `markerBlockLines` locates them with a bare `indexOf`, so an id carrying a
 * marker delimiter does not merely look odd in the history: it MOVES the block
 * boundary the next run reads.
 *
 * Both directions were reproducible, and the accepted block is hand-edited free
 * text, so an id shaped like a marker only takes a bad paste (re-seeding "the
 * whole block, markers included" INTO the fence is the obvious one) — or a
 * maintainer annotating the history by hand, which is the other way a note gets
 * written and the one this function never sees:
 *
 *   - a note containing `…accepted:begin -->` puts the FIRST start marker
 *     inside the note, so the block read next run starts mid-prose: the note's
 *     own tail and the real marker line parse as live accepted entries — the
 *     history parsing back as state, which is precisely what the note's
 *     position outside the markers was supposed to make impossible;
 *   - a note containing `…accepted:end -->` puts the FIRST end marker BEFORE
 *     the start marker, so `markerBlockLines` returns nothing, the block reads
 *     as empty FOREVER (the poisoned note is carried forward with no expiry),
 *     every accepted mutant re-reports as new, and the next rewrite renders an
 *     empty block — silently erasing every triage verdict on the page.
 *
 * So the delimiters are broken on BOTH paths a note reaches the body by, and
 * naming only one of them is how this invariant was wrong the first time. This
 * function is applied when a note is WRITTEN (below) and again when one is READ
 * back (`parseReanchorNotes`), because a note is carried forward verbatim from
 * the previous body and only the write path was ever the filer's. The read path
 * is the reachable one: a maintainer hand-annotating the re-anchoring history —
 * it renders as ordinary prose in a shape that invites it — quotes a raw end
 * marker, and from the next run on the accepted block reads EMPTY, the rewrite
 * renders it empty, and the note is picked back up and re-rendered unchanged, so
 * it never expires. Guarding the write path alone leaves that entirely open:
 * position outside the markers was never a proof of safety for text this filer
 * did not author, which is the whole point of the two cases above.
 *
 * Sanitising on read is idempotent — neither `<! --` nor `-- >` contains the
 * delimiter it came from — so a body that has been through one run is stable,
 * and a poisoned one converges in exactly one rewrite instead of never.
 *
 * A stale id is by definition one that matches no observed mutant, so nothing
 * downstream reads these back as state; the mangling is visible, which is the
 * right signal for a "mutant id" that contains an HTML comment in the first
 * place.
 */
function noteSafeId(id) {
  return id.replaceAll('<!--', '<! --').replaceAll('-->', '-- >')
}

/**
 * The re-anchoring notes already in a body, oldest first — SCOPED, SANITISED
 * and CAPPED on read, because everything this returns is spliced straight back
 * into the next body by `renderAcceptedBlock`, and none of it was written by
 * this script. A note survives by being copied forward, so "the filer only
 * writes safe notes" says nothing about what the filer READS.
 *
 * Scoped: only lines that BEGIN outside every marker block count. A note is
 * prose above the markers; a line in the note shape that begins inside a fence
 * is hand-edited block content that happens to start with the prefix, and
 * reading it as a note both duplicated it into the history and left it in the
 * block, where it is also read as an id. The test is where the line STARTS, not
 * whether it overlaps: a note whose own tail has been swallowed by a poisoned
 * marker still starts outside, and dropping it there would lose the record this
 * whole mechanism exists to keep.
 *
 * Sanitised: `noteSafeId` on read as well as on write. `markerBlockRange` finds
 * both delimiters with a bare `indexOf` over the whole body, so a carried-
 * forward note quoting a raw marker MOVES the accepted block — see `noteSafeId`
 * for the two directions. Applied here the poison is defused on the first run
 * that reads it, which is also what makes recovery converge.
 *
 * Capped: `appendReanchorNote` slices only when it appends, so a body that
 * somehow holds more than the cap — a paste, a hand-edit, an older revision of
 * this script — would otherwise carry them all forward for ever, and "bounded
 * growth" would hold only for bodies this script had never had to recover.
 */
export function parseReanchorNotes(body) {
  if (!body) return []
  const blocks = [
    markerBlockRange(body, MARKER_START, MARKER_END),
    markerBlockRange(body, ACCEPTED_MARKER_START, ACCEPTED_MARKER_END),
    markerBlockRange(body, CHILD_MARKER_START, CHILD_MARKER_END),
  ].filter((r) => r !== null)
  const notes = []
  let at = 0
  for (const line of body.split('\n')) {
    const startsAt = at
    at += line.length + 1
    if (!line.startsWith(REANCHOR_NOTE_PREFIX)) continue
    if (blocks.some(([from, to]) => startsAt >= from && startsAt < to)) continue
    notes.push(noteSafeId(line))
  }
  return notes.slice(-MAX_REANCHOR_NOTES)
}

/** Carried-forward notes plus this run's, if this run dropped anything. */
export function appendReanchorNote(notes, stale, today) {
  if (stale.length === 0) return notes.slice(-MAX_REANCHOR_NOTES)
  const what = `${stale.length} accepted entr${stale.length === 1 ? 'y' : 'ies'}`
  return [
    ...notes,
    `${REANCHOR_NOTE_PREFIX}${today ?? 'undated'}** — ${what} dropped, matching no observed mutant: ${stale.map((id) => `\`${noteSafeId(id)}\``).join(', ')}`,
  ].slice(-MAX_REANCHOR_NOTES)
}

/**
 * The per-area state machine, kept pure for the same reason
 * `file-scheduled-failures.mjs` keeps `decideAction` pure — it is the part with
 * real branches worth pinning:
 *
 *   'create' — the area has no known child.
 *   'notify' — the area gained a survivor this run: re-render the child's body
 *              AND comment (and reopen it if a human closed it).
 *   'sync'   — the area is unchanged or only shrank: re-render the body, do not
 *              comment, do not reopen. A partial recovery is not news, exactly
 *              as in the sibling reporter.
 *   'close'  — the area has no REPORTABLE finding left: rewrite the body
 *              (so it says WHICH kind of close this is) and close.
 *
 * `maxChildren` caps CREATES only. An update or a close cannot run away — they
 * are bounded by what is already recorded — so capping the total would just
 * wedge the job on a backlog it did not create.
 *
 * #4173 residual — `accepted` (this run's live accepted-equivalent ids) is
 * carried through to the close action for exactly one reason: an area whose
 * remaining findings are ALL accepted is absent from `groups`, so it closes on
 * the same branch as an area that was genuinely cleaned up, and the two must
 * not be told to the reader the same way. The close writes the child BODY
 * first and says which kind it is — that used to be a close comment, and the
 * CI job no longer comments.
 */
export function decideChildActions({
  groups,
  newOnes = [],
  knownChildren = new Map(),
  maxChildren = DEFAULT_MAX_CHILDREN,
  accepted = [],
}) {
  const newSet = new Set(newOnes)
  const live = new Set(groups.map((g) => g.area))
  const acceptedByArea = new Map(groupByArea(accepted).map((g) => [g.area, g.members]))
  const actions = []
  for (const g of groups) {
    const number = knownChildren.get(g.area)
    const hasNew = g.members.some((m) => newSet.has(m))
    actions.push({
      area: g.area,
      members: g.members,
      hasNew,
      number,
      action: number === undefined ? 'create' : hasNew ? 'notify' : 'sync',
    })
  }
  for (const [area, number] of knownChildren) {
    if (!live.has(area))
      actions.push({
        area,
        members: [],
        hasNew: false,
        number,
        action: 'close',
        accepted: acceptedByArea.get(area) ?? [],
      })
  }
  const creates = actions.filter((a) => a.action === 'create').length
  if (creates > maxChildren) {
    throw new Error(
      `refusing to open ${creates} child issues in one run (cap: ${maxChildren}). ${
        maxChildrenIsFallback
          ? `The area universe could not be derived, so DEFAULT_MAX_CHILDREN fell back to FALLBACK_MAX_CHILDREN = ${DEFAULT_MAX_CHILDREN}`
          : `DEFAULT_MAX_CHILDREN is the derived area universe of both lanes, ${DEFAULT_MAX_CHILDREN}`
      }, so a batch this large means survivorArea() is fragmenting rather than grouping — check the survivor id shapes before raising --max-children.`,
    )
  }
  return actions.toSorted((a, b) => a.area.localeCompare(b.area))
}

/**
 * A child's body: the area's findings, dated, plus the way back to the parent.
 * It carries NO marker block — the parent holds all state — so a plain
 * truncation is safe when a pathological area outgrows the body limit.
 *
 * #3788 — TWO sections, no-coverage first, each with its own count and its own
 * instruction. The child is the thing an agent actually works from, so this is
 * where the distinction has to be legible: "no test executed this line" and
 * "a test executed it and shrugged" ask for different work, and a single
 * "Survivors (N)" heading over both told every reader the second story. The
 * parent cannot repeat the split as a list (#3245 forbids any finding appearing
 * twice in that body); it carries the split as counts in its area table.
 */
export function buildChildBody({
  area,
  members,
  firstSeen = new Map(),
  parentNumber,
  parentTitle,
  accepted = [],
  runUrl,
}) {
  // A child filed BEFORE its lane parent exists has no number, so the title is
  // the only reference it can carry — and rendering `"undefined"` into a real
  // filed issue is worse than failing. That is not hypothetical: it is the
  // state every lane is in on its first run, which is the next real run until
  // the #3142 partition lands.
  // `!parentNumber`, not `=== undefined`: the ternary below is falsy-based, so
  // issue 0 — which the `--known-body-file` stub uses as a placeholder — takes
  // the title branch too. Checking only for `undefined` left the exact case
  // the render mishandles outside the guard, and so outside every test.
  if (!parentNumber && !parentTitle) {
    throw new Error(
      'buildChildBody needs `parentTitle` when there is no `parentNumber`: the child would otherwise be filed saying `Parent: "undefined"`.',
    )
  }
  const parentRef = parentNumber ? `#${parentNumber}` : `"${parentTitle}"`
  const { survived, noCoverage } = partitionByOutcome(members)
  // The two kinds of close read identically from the outside — no findings
  // left — and they mean opposite things: one area is genuinely clean, the
  // other is clean only because every finding in it was proven equivalent and
  // is still surviving. That distinction used to live in the close COMMENT.
  // The CI job does not comment, so it lives here, in the body, where it also
  // outlives the run log that would otherwise be its only record (#4173).
  const acceptedNote =
    accepted.length === 0
      ? []
      : [
          `**This is not an all-clear.** The ${accepted.length} finding(s) still present in **${area}** are recorded in the parent as **accepted as equivalent** — triage proved them unkillable (#4173), so they survive every run and the filer has stopped reporting them. If any OTHER mutant appears here, the next run reopens this issue rather than filing a new one.`,
          '',
          `**Accepted as equivalent (${accepted.length})** — still surviving, deliberately not reported:`,
          '```',
          ...accepted,
          '```',
          '',
        ]
  const head = [
    `Mutation findings in **${area}** from the weekly \`scheduled-deep-checks.yml\` mutation lanes: **${noCoverage.length} with no coverage** (no test executed the mutated code at all) and **${survived.length} survivor(s)** (a test ran and did not fail).`,
    '',
    `Parent: ${parentRef} (the rolling tracking issue). This child is filed, re-rendered and closed automatically by \`scripts/file-mutation-survivors.mjs\` — **do not rename the title**, the filer matches on it verbatim to re-find this issue instead of opening a duplicate.`,
    '',
    `Start with the no-coverage list: those mutants are unkillable by construction until a test exercises the code, so no amount of strengthening an existing test touches them. Survivors are the opposite — the test exists and is too weak. Either way, fix it the way the parent asks: add or strengthen a test that kills the mutant, or record it as an accepted gap. The lists below are re-rendered from the parent's machine-readable block on every run and hold no state of their own — remove a line **in the parent**, not here. This issue closes itself once ${area} has no findings left.`,
    '',
  ]
  head.push(...acceptedNote)
  const tail = []
  if (runUrl) tail.push('', `_Last updated by [this run](${runUrl})._`)

  const dated = (ids) =>
    ids.map((id) => {
      const seen = recordedFirstSeen(firstSeen, id)
      return seen ? `${seen}\t${id}` : id
    })
  // A section renders only when it has members: an empty `### No coverage (0)`
  // on every survivor-only child is noise, and its absence is the honest
  // rendering of "nothing here went untested".
  const section = (heading, ids) => (ids.length === 0 ? [] : [heading, '```', ...ids, '```', ''])
  const render = (nc, sv) =>
    [
      ...head,
      ...section(`### No coverage — no test executed this code (${noCoverage.length})`, nc),
      ...section(`### Survivors — a test ran and did not fail (${survived.length})`, sv),
      ...tail,
    ]
      .join('\n')
      // #4032 minor — `section` ends in a blank line so the next heading is
      // separated from the fence above it. With no `runUrl` there is no tail to
      // separate it from, and the body ends on a stray blank line.
      .replace(/\n+$/, '')

  const datedNc = dated(noCoverage)
  const datedSv = dated(survived)
  const full = render(datedNc, datedSv)
  if (full.length <= MAX_BODY_CHARS) return full

  // No state here, so truncating the lists is safe — unlike the parent, whose
  // block must never be cut mid-way. The no-coverage half is filled FIRST so it
  // is the half that survives the cut: it is the more serious finding and,
  // historically, much the smaller list.
  //
  // #4032 — the note is PER SECTION and must therefore count per section. It
  // used to report `members.length` (the whole area, not what was dropped) from
  // a single shared string appended to each overflowing list, so a child whose
  // no-coverage AND survivor lists both overflowed printed "…(1800 findings do
  // not fit…)" twice under an area holding 1800 findings — reading as 3600
  // omitted, and as "nothing here is shown" when in fact ~570 lines were. A
  // truncation note that overstates the loss is the same defect as one that
  // hides it: neither number is what was dropped.
  const note = (omitted, total) =>
    `…(${omitted} of this section's ${total} findings do not fit in one issue body — see the parent's machine-readable block for the full list)`
  const withNote = (ids, kept) =>
    kept.length < ids.length ? [...kept, note(ids.length - kept.length, ids.length)] : kept
  // Worst case for the reservation: each present section loses everything.
  const budget =
    MAX_BODY_CHARS -
    render(
      datedNc.length > 0 ? [note(datedNc.length, datedNc.length)] : [],
      datedSv.length > 0 ? [note(datedSv.length, datedSv.length)] : [],
    ).length
  const keptNc = []
  const keptSv = []
  let used = 0
  for (const [line, into] of [
    ...datedNc.map((l) => [l, keptNc]),
    ...datedSv.map((l) => [l, keptSv]),
  ]) {
    used += line.length + 1
    if (used > budget) break
    into.push(line)
  }
  return render(withNote(datedNc, keptNc), withNote(datedSv, keptSv))
}

// ---------------------------------------------------------------------------
// Issue body / comment rendering
// ---------------------------------------------------------------------------

/**
 * Renders the tracking issue's body.
 *
 * #3245 — there used to be a `### New this run (N)` section here as well.
 * It listed exactly the same survivor lines as the machine-readable "all
 * currently-known" block below, so on the run that first populates the issue
 * (and on any run where most survivors are new) EVERY survivor appeared
 * twice and every per-module count a triager grepped out of the body read
 * 2x the truth — the reported 114 `glob-validate` survivors were 57. Worse,
 * the section is a per-RUN snapshot baked into a PERSISTENT body: a week
 * later it no longer means "new", so a survivor that was triaged and removed
 * became indistinguishable from one nobody had ever looked at, which is
 * precisely the distinction the issue's triage convention depends on.
 *
 * The body is now ONE deduped list — the state block — and cannot drift.
 * "New this run" was a per-run comment; the CI job no longer comments, so the
 * per-run snapshot lives only in the run log and the run's own counts. The
 * body stays state, which is the half that had to be durable anyway.
 *
 * `resolvedOnes` is NOT part of `all` (it is the complement), so it
 * duplicates nothing; it stays as the one presentational section, and is the
 * section dropped first when the #3257 length clamp bites.
 */
export function buildIssueBody({
  all,
  resolvedOnes,
  runUrl,
  firstSeen = new Map(),
  today,
  newOnes = [],
  childLinks = new Map(),
  accepted = [],
  acceptedOn = new Map(),
  reanchored = [],
}) {
  const newSet = new Set(newOnes)
  const { survived, noCoverage } = partitionByOutcome(all)
  const head = []
  head.push(
    'This issue tracks mutation-testing findings (cargo-mutants + StrykerJS) surfaced by the weekly `scheduled-deep-checks.yml` run (#2947). It is filed and updated automatically by `scripts/file-mutation-survivors.mjs` — **do not rename the title**, the filing script matches on it verbatim to find this issue instead of opening a new one.',
  )
  head.push('')
  head.push(
    `Currently tracked: **${noCoverage.length} with no coverage** and **${survived.length} survivor(s)**. The two are different findings and #3788 stopped merging them:`,
  )
  head.push('')
  head.push(
    `- **No coverage** — no test executed the mutated code at all, so the mutant is unkillable until one does. Lines carry a trailing \`${NO_COVERAGE_SUFFIX.trim()}\`. These outrank survivors: there is no test to strengthen, and an area full of them is code nothing has ever run.`,
  )
  head.push(
    '- **Survivor** — a test executed the mutated code and did not fail. The test exists and is too weak.',
  )
  head.push('')
  head.push(
    'Triage each line below: either (a) add (no coverage) or strengthen (survivor) a test that kills it and remove its line here, or (b) leave a comment explaining why it is an accepted gap and remove its line here anyway. Removing a line is not durable on its own — once it is gone, the next run that sees that mutant again re-adds it as "new" — so for (b), also copy the id into the **accepted-equivalent** block at the bottom of this body, which is where a proven-unkillable mutant is recorded permanently (#4173). That block is always there, empty or not, and it carries the line shape and the marker comments you need — so there is nothing to invent even if you are the first to record one.',
  )
  head.push('')
  head.push(
    "The list below is the single deduped source of truth (#3245): every tracked mutant appears exactly once, including the no-coverage ones, which is why they are not repeated as a section of their own here. A finding first seen in the latest run carries that run's date in the leading first-seen column — there is no per-run comment; this job only ever edits bodies. The per-area split lives in the table below, and the per-area child issues render the two lists separately.",
  )
  head.push('')

  // #3350 — "where should I look first?" answered above the wall of lines.
  // Derived from `all` on every run, so it cannot drift out of sync with the
  // state block the way a hand-maintained count would. `first seen` is the
  // oldest date recorded for any survivor in the area: an area whose oldest
  // entry is months back is a standing gap (or a nest of equivalent mutants,
  // #3248), while one dated today is this run's news — and that distinction
  // is the whole reason a non-zero survivor count means anything.
  // ONE resolution rule, used by both the table and the state block below, so
  // the age a maintainer reads is exactly the age that gets written back.
  const dateOf = (id) => recordedFirstSeen(firstSeen, id) ?? (newSet.has(id) ? today : undefined)

  const areaSection = []
  const groups = groupByArea(all)
  if (groups.length > 0) {
    areaSection.push(`### Where the findings are (${groups.length} area(s), worst first)`)
    areaSection.push('')
    // The `Fix in` column appears only once children exist. A column of `—`
    // on every row for a repo running without `--children` is noise, and its
    // absence is the honest rendering of "this area has no child issue yet".
    const withChildren = childLinks.size > 0
    // #3788 — TWO count columns, no-coverage first, matching the ranking. A
    // single merged "Survivors" number ranked an area with 14 untested
    // functions below one with 22 equivalent-and-unkillable survivors, which is
    // exactly backwards as a "look here first" signal.
    areaSection.push(
      withChildren
        ? '| Area | No coverage | Survivors | Oldest first seen | Fix in |'
        : '| Area | No coverage | Survivors | Oldest first seen |',
    )
    areaSection.push(withChildren ? '|---|--:|--:|---|---|' : '|---|--:|--:|---|')
    for (const g of groups) {
      const dates = g.members.map(dateOf).filter(Boolean).toSorted()
      // An UNDATED member is not a missing value to be skipped — it means the
      // survivor predates first-seen tracking, i.e. it is older than any date
      // we hold. Dropping it and reporting the oldest RECORDED date would
      // print a recent date for an area whose real oldest entry is ancient,
      // which is the opposite of the fact this column exists to carry.
      const oldest = dates.length === g.members.length ? dates[0] : '_unknown_'
      const child = childLinks.get(g.area)
      const counts = `${g.noCoverage.length} | ${g.survived.length}`
      areaSection.push(
        withChildren
          ? `| ${g.area} | ${counts} | ${oldest} | ${child ? `#${child}` : '—'} |`
          : `| ${g.area} | ${counts} | ${oldest} |`,
      )
    }
    areaSection.push('')
  }

  const resolvedSection = []
  if (resolvedOnes.length > 0) {
    resolvedSection.push(`### Resolved since last run (${resolvedOnes.length})`)
    resolvedSection.push('```')
    resolvedSection.push(...resolvedOnes)
    resolvedSection.push('```')
    resolvedSection.push('')
  }

  const state = []
  state.push(
    `### All currently-known mutants (${noCoverage.length} no coverage, ${survived.length} survived)`,
  )
  state.push(
    `_Machine-readable — do not hand-edit the marker lines below. Remove a line once it is triaged; leave the rest untouched. Each line is \`<first-seen date><TAB><mutant>\`; the date is bookkeeping and is ignored when the set is compared, so removing it by hand changes nothing except the age reported above. A line ending in \`${NO_COVERAGE_SUFFIX.trim()}\` had no test executing it at all._`,
  )
  state.push(MARKER_START)
  state.push('```')
  // Date-prefixed (#3350). Three cases, and the third is the one that matters:
  //
  //   already dated  -> keep the date. Restamping would make every standing
  //                     gap read as new, which is the state this is fixing.
  //   genuinely new  -> stamp `today`. Only ids in `newOnes` qualify.
  //   known, undated -> leave undated. These are the entries the tracking
  //                     issue carried before #3350; we do not know when they
  //                     first appeared, and `_unknown_` is the truth. Dating
  //                     them today would silently convert the entire existing
  //                     backlog — including #3248's 21 permanent equivalent
  //                     mutants — into "found this week".
  state.push(
    ...all.map((id) => {
      const seen = dateOf(id)
      return seen ? `${seen}\t${id}` : id
    }),
  )
  state.push('```')
  state.push(MARKER_END)
  // Part of STATE, not of the presentational sections: it is bounded by the
  // area count (one short line each, capped by DEFAULT_MAX_CHILDREN) and it is
  // the primary dedup record, so the clamp ladder below must never drop it.
  state.push(...renderChildBlock(childLinks))
  // #4173 — STATE too, for the same reason and with the same consequence: it
  // is the filer's memory of what triage has already ruled equivalent, so the
  // clamp ladder below must never drop it. Dropping it would re-serve every
  // accepted mutant as "new" the following week — the precise loop the block
  // exists to end — and would do it silently, since the run that dropped it
  // looks exactly like a run that never had one.
  state.push(...renderAcceptedBlock(accepted, acceptedOn, reanchored))

  const tail = []
  if (runUrl) {
    tail.push('')
    tail.push(`_Last updated by [this run](${runUrl})._`)
  }

  const render = (middle) => [...head, ...middle, ...state, ...tail].join('\n')

  const full = render([...areaSection, ...resolvedSection])
  if (full.length <= MAX_BODY_CHARS) return full

  // #3257 — clamp by dropping the presentational section WHOLESALE rather
  // than truncating: the marker block is state and must never be cut
  // mid-way (a half-written block would silently shrink the known set and
  // re-report the dropped survivors as "new" forever after).
  //
  // #3350 — the resolved list goes first because it is a per-run curiosity;
  // the area table is the navigational aid and is worth more per character
  // (one row per area, vs one line per resolved survivor), so it is only
  // dropped if dropping the resolved list was not enough.
  // The note names what was ACTUALLY dropped. A single fixed wording keyed on
  // `resolvedOnes` used to be wrong in both directions on the second rung: it
  // announced "0 resolved-since-last-run entries were omitted" (nothing was —
  // there were none) while saying nothing about the area table, which is the
  // section a maintainer notices missing. A clamp note that misdescribes the
  // clamp is the same "the report lies" failure as #3245's double count.
  const note = (parts) => [
    `_Omitted to keep this body under GitHub's ${MAX_BODY_CHARS}-character working limit: ${parts.join('; ')} — see ${runUrl ? `[this run](${runUrl})` : 'the workflow run'}._`,
    '',
  ]
  const resolvedPart =
    resolvedOnes.length === 1
      ? 'the 1 resolved-since-last-run entry'
      : `the ${resolvedOnes.length} resolved-since-last-run entries`

  // Rung 2: drop the resolved list, keep the area table. Only reachable when
  // there IS a resolved list — with none, this render is strictly LONGER than
  // `full` (it adds the note and drops nothing) and can never fit.
  if (resolvedOnes.length > 0) {
    const clamped = render([...areaSection, ...note([resolvedPart])])
    if (clamped.length <= MAX_BODY_CHARS) return clamped
  }

  // Rung 3: the area table goes too. One row per area and areas are unbounded
  // (the rust lane groups by source FILE), so a wide-but-shallow survivor set
  // can make the table outweigh the state block it sits above.
  const droppedHere = []
  if (groups.length > 0)
    droppedHere.push(`the "where the findings are" table (${groups.length} area(s))`)
  if (resolvedOnes.length > 0) droppedHere.push(resolvedPart)
  const clampedHarder = render(droppedHere.length > 0 ? note(droppedHere) : [])
  if (clampedHarder.length <= MAX_BODY_CHARS) return clampedHarder

  // The state block alone does not fit. Fail with a diagnosis rather than
  // letting `gh issue edit` return a bare 422 nobody can act on.
  //
  // #4032 — this throw is the DESIGNED behaviour at the ceiling and the reason
  // there is no truncation arm here: the block is the only cross-run memory
  // this filer has, so a short block does not lose a report, it loses the
  // tracked set — every dropped line comes back as "new" the following week,
  // forever, which is #3245's double count with a longer fuse. Red-and-intact
  // beats green-and-lying. The measured ceiling is ~635 findings (see
  // MAX_BODY_CHARS); the message carries the actual numbers so a maintainer
  // reading a red weekly job knows by how much, not just that.
  throw new Error(
    `the survivor set outgrew a single issue body: ${all.length} finding(s) render to ${clampedHarder.length} chars, ${clampedHarder.length - MAX_BODY_CHARS} over the ${MAX_BODY_CHARS}-char cap (GitHub's hard limit is 65536; the measured ceiling is ~635 findings at ~90 chars each). The machine-readable state block cannot be truncated without corrupting the tracked set — every dropped line would be re-reported as new next run. Triage the tracking issue down, split the lanes into separate tracking issues, add a per-outcome cap or spill the lists to the child issues, or un-enrol the noisiest module from stryker.modules.mjs — the deferred list there records this ceiling as the reason some modules are not enrolled yet (#3350).`,
  )
}

// ---------------------------------------------------------------------------
// `gh` plumbing
// ---------------------------------------------------------------------------

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8' })
  return JSON.parse(out)
}

/** Finds the single tracking issue by exact title, preferring an OPEN match over a CLOSED one (so a triaged-and-closed issue gets reopened rather than duplicated). */
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
  // No open match — most recently numbered closed match (gh lists newest-ish
  // first already via search relevance, but sort explicitly to be sure).
  return exact.toSorted((a, b) => b.number - a.number)[0]
}

function withTempFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-survivors-'))
  const file = join(dir, 'body.md')
  writeFileSync(file, content, 'utf8')
  return fn(file)
}

function gh(args) {
  execFileSync('gh', args, { stdio: 'inherit' })
}

/** Tier-2 dedup: adopt an existing child by VERBATIM title (see the header). */
function findChildByTitle(repo, title) {
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
    'number,title,state',
    '--limit',
    '20',
  ])
  const exact = results.filter((i) => i.title === title)
  if (exact.length === 0) return null
  return exact.find((i) => i.state === 'OPEN') ?? exact.toSorted((a, b) => b.number - a.number)[0]
}

/**
 * A recorded child's current state. Queried rather than assumed so `reopen` and
 * `close` are only issued when they will actually do something — both exit
 * non-zero against an issue already in the target state, and a `|| true` there
 * would swallow a genuine permission failure along with the harmless case.
 */
function childState(repo, number) {
  try {
    return ghJson(['issue', 'view', String(number), '--repo', repo, '--json', 'state']).state
  } catch {
    // A deleted/transferred child is not a reason to fail the whole run: fall
    // through to the title lookup path, which files a fresh one.
    return null
  }
}

function createChild(repo, title, body) {
  const out = withTempFile(body, (f) =>
    execFileSync(
      'gh',
      ['issue', 'create', '--repo', repo, '--title', title, '--body-file', f].concat(
        TRACKING_ISSUE_LABELS.flatMap((l) => ['--label', l]),
      ),
      { encoding: 'utf8' },
    ),
  )
  const m = /\/issues\/(\d+)/.exec(out)
  if (!m) {
    throw new Error(
      `gh issue create did not print an issue URL for child "${title}" (got: ${out.trim() || '(empty)'}), so its number could not be recorded in the parent. The next run will adopt it by title rather than duplicate it.`,
    )
  }
  return Number(m[1])
}

/**
 * Performs the plan `decideChildActions` produced and returns the `area ->
 * number` map the parent body must record.
 *
 * Children are written BEFORE the parent on purpose: the parent's block is the
 * record of what exists, so it must be written from numbers that already do. If
 * this throws half-way, the parent keeps the previous (smaller) block and the
 * orphaned children are adopted by title next run — the reason tier 2 exists.
 */
function applyChildActions({ actions, repo, runUrl, firstSeen, parentNumber, parentTitle }) {
  const links = new Map()
  for (const a of actions) {
    let { number, action } = a
    if (action === 'create') {
      const title = childIssueTitle(a.area)
      const adopted = findChildByTitle(repo, title)
      if (adopted === null) {
        const created = createChild(
          repo,
          title,
          buildChildBody({ ...a, firstSeen, parentNumber, parentTitle, runUrl }),
        )
        links.set(a.area, created)
        console.log(`  child #${created} filed for ${a.area} (${a.members.length} finding(s))`)
        continue
      }
      // Adopted: an earlier run filed it and died before recording the number,
      // or a human renamed nothing and simply closed it. Fall through as a
      // normal update so the body is refreshed either way.
      number = adopted.number
      action = a.hasNew ? 'notify' : 'sync'
      console.log(`  adopted existing child #${number} for ${a.area} (was not recorded)`)
    }

    const state = childState(repo, number)
    if (state === null) {
      // The recorded child no longer exists (deleted, or transferred to
      // another repo). Editing it would throw and take the whole run — and the
      // parent — down over one child. Forget the record instead: the area has
      // no number next run, so it goes down the `create` path and is adopted
      // by title or filed fresh. This is exactly the hole tier 2 exists for.
      console.log(`  recorded child #${number} for ${a.area} is gone — dropping the record`)
      continue
    }
    if (action === 'close') {
      const acceptedHere = a.accepted ?? []
      // EDIT then close, never a close comment: the CI job does not comment.
      // The edit is not cosmetic — it is what makes the close honest. An area
      // closed because everything in it is accepted-equivalent looks exactly
      // like a clean one, and the difference used to be stated only in the
      // comment. Writing the body first puts it somewhere durable (#4173).
      withTempFile(
        buildChildBody({
          // `members` is already `[]` on every close action from
          // `decideChildActions`, and `...a` carries it.
          ...a,
          firstSeen,
          parentNumber,
          parentTitle,
          accepted: acceptedHere,
          runUrl,
        }),
        (f) => gh(['issue', 'edit', String(number), '--repo', repo, '--body-file', f]),
      )
      if (state !== 'CLOSED') gh(['issue', 'close', String(number), '--repo', repo])
      console.log(
        acceptedHere.length > 0
          ? `  child #${number} closed (${a.area} has nothing left to triage — ${acceptedHere.length} finding(s) accepted as equivalent, still surviving)`
          : `  child #${number} closed (${a.area} has no findings left)`,
      )
      continue
    }

    // Reopening is a notification-class action, so only a genuinely new
    // survivor does it — same rule the sibling reporter applies to the parent.
    if (action === 'notify' && state === 'CLOSED') {
      gh(['issue', 'reopen', String(number), '--repo', repo])
    }
    withTempFile(buildChildBody({ ...a, firstSeen, parentNumber, parentTitle, runUrl }), (f) =>
      gh(['issue', 'edit', String(number), '--repo', repo, '--body-file', f]),
    )
    // The reopen above is the whole notification. A comment naming the new
    // members used to follow it; the body it just wrote already lists them.
    links.set(a.area, number)
  }
  return links
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dryRun: false,
    requireInput: false,
    children: false,
    maxChildren: DEFAULT_MAX_CHILDREN,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--rust-missed': {
        args.rustMissed = argv[++i]
        break
      }
      case '--frontend-dir': {
        args.frontendDir = argv[++i]
        break
      }
      case '--lane': {
        args.lane = argv[++i]
        break
      }
      case '--require-input': {
        args.requireInput = true
        break
      }
      case '--children': {
        args.children = true
        break
      }
      case '--max-children': {
        const raw = argv[++i]
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`--max-children expects a non-negative integer, got "${raw}"`)
        }
        args.maxChildren = n
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

/**
 * #3364 — a MISSING lane input must be distinguishable from an EMPTY one.
 *
 * Without these gates a dead lane contributes `[]`, which is identical to
 * "that lane has no survivors": if the other lane then contributes even one
 * NEW survivor, `main()` rewrites the issue body from `all`, and every
 * survivor belonging to the dead lane is DELETED from the marker block — i.e.
 * from the filer's only cross-run memory — then re-reported as "new" the
 * following week. That is state corruption, not a display bug, and #3330's
 * liveness guard does not prevent it: the guard makes the LANE go red, while
 * this job keeps running under `if: always()` regardless.
 *
 * Throwing (rather than gating the whole job on `needs.<lane>.result`) is
 * deliberate: a skipped job reports `skipped`, which #3359's
 * `report-scheduled-failures` would then have to special-case away; a thrown
 * filer reports `failure`, which is the truth and rides the ordinary path.
 *
 * An EMPTY-but-present `missed.txt` is real data (cargo-mutants writes one
 * when nothing survived); only an ABSENT one is "no data". For the frontend,
 * ZERO `mutation.json` files is the machine-checkable "no data" signature — a
 * lane that ran writes one report per module, and its own liveness guard
 * (`check-mutation-reports.mjs`) fails on a module that produced none.
 */
function assertLaneInputsPresent(args) {
  if (!args.requireInput) return
  if (args.lane === 'rust' && !existsSync(args.rustMissed ?? '')) {
    throw new Error(
      `--require-input: no cargo-mutants missed.txt at ${args.rustMissed ?? '(unset)'} — the mutants lane produced no data, which is NOT the same as "no rust survivors". Refusing to rewrite the rust tracking issue, which would delete every rust survivor from its tracked set (#3364).`,
    )
  }
  if (args.lane === 'frontend' && frontendReportCount(args.frontendDir ?? '') === 0) {
    throw new Error(
      `--require-input: no Stryker mutation.json under ${args.frontendDir ?? '(unset)'} — the mutants-frontend lane produced no data, which is NOT the same as "no frontend survivors". Refusing to rewrite the frontend tracking issue, which would delete every frontend survivor from its tracked set (#3364).`,
    )
  }
}

/**
 * #4173 — the accepted-equivalent block, applied to the OBSERVED set before
 * anything else looks at it. Two steps, in this order:
 *
 *   RE-ANCHOR  an accepted entry matching no observed mutant is stale — its
 *              line moved, or the mutant became killable — and is dropped
 *              here, so it is simply not rendered back into the body. An entry
 *              can therefore never suppress a mutant forever; the worst case
 *              is that a refactor costs a re-accept.
 *   SUBTRACT   the entries that survived re-anchoring come out of `current`
 *              AND out of `known`. HERE, at `diffSurvivors`' call site, and
 *              not inside it — that stays a pure two-set function with its own
 *              fixtures. Out of `current` so the mutant is never new and never
 *              re-enters the tracked set (and so its area can never be the
 *              reason a child issue is re-opened); out of `known` so dropping
 *              it from the tracked set is not announced as "resolved", which
 *              would claim a test now kills a mutant that cannot be killed — a
 *              lie of exactly the #3245 family.
 *
 * Split out of `main` for its branches, like `writeParent` below.
 */
function applyAcceptedGaps({ body, current }) {
  const observed = new Set(current)
  const recorded = [...parseAcceptedSurvivors(body)].toSorted()
  const accepted = recorded.filter((id) => observed.has(id))
  const stale = recorded.filter((id) => !observed.has(id))
  const acceptedSet = new Set(accepted)
  if (recorded.length > 0) {
    console.log(
      `accepted-equivalent (#4173): ${accepted.length} suppressed of ${recorded.length} recorded`,
    )
  }
  // The DROP is not announced here. Nothing has been dropped yet: an entry
  // leaves the block only when the body is rewritten, and this run may not
  // rewrite it at all (the no-op arm in `main` is the common case on a quiet
  // week). The old log said "dropped N accepted entries" from here, before that
  // was decided, so on every quiet week it claimed a removal that had not
  // happened and would not happen — the entries stayed in the body and were
  // re-evaluated the following Monday. `main` owns the announcement now,
  // because `main` is where it becomes true or false.
  return {
    accepted,
    stale,
    acceptedOn: parseAcceptedOn(body),
    reported: current.filter((id) => !acceptedSet.has(id)),
    known: new Set([...parseKnownSurvivors(body)].filter((id) => !acceptedSet.has(id))),
  }
}

/**
 * #4173 residual — the re-anchoring announcement, made from `main` and not from
 * `applyAcceptedGaps`, because only `main` knows whether the body is going to
 * be rewritten at all.
 *
 * A stale entry is dropped by being LEFT OUT of a rewrite. On a run that writes
 * nothing — the quiet week, which is the common case — it is therefore not
 * dropped: it is still in the issue on Tuesday and is re-evaluated next Monday.
 * The old log said "dropped N accepted entries" from before the no-op check,
 * i.e. every quiet week it announced a removal that had not happened and was
 * not going to, about the filer's own state, in the one report whose entire job
 * is not to say things that are not so.
 */
function announceReanchoring({ stale, willWrite, dryRun }) {
  if (stale.length === 0) return
  const what = `${stale.length} accepted entr${stale.length === 1 ? 'y' : 'ies'} matching no observed mutant: ${stale.join(', ')}`
  if (!willWrite) {
    console.log(
      `re-anchoring (#4173): LEFT IN PLACE — this run rewrites nothing, so the entries stay in the body and are re-evaluated next run — ${what}`,
    )
    return
  }
  console.log(
    `re-anchoring (#4173): ${dryRun ? 'would drop' : 'dropping'} ${what} — so an entry whose line has moved cannot go on suppressing whatever mutant now sits at that id. The drop is recorded in the body's re-anchoring history, not only here.`,
  )
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (!LANE_NAMES.includes(args.lane)) {
    throw new Error(
      `--lane is required and must be one of ${LANE_NAMES.join(', ')} — got ${args.lane === undefined ? '(unset)' : `"${args.lane}"`}. Each lane owns its own tracking issue; running without one would have to guess which issue to rewrite.`,
    )
  }
  args.title = LANES[args.lane].title
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY
  const runUrl = args.runUrl ?? defaultRunUrl()

  // #3364 — a MISSING lane input is a hard error, not an empty one; see
  // `assertLaneInputsPresent` above for why the alternative silently corrupts
  // the tracking issue's state.
  assertLaneInputsPresent(args)

  // Only the lane's OWN input is read. An earlier draft parsed both and
  // filtered by tag; review correctly called that dead weight, since the two
  // sources are already tag-pure and the filter could never drop anything.
  // Not reading the other lane's input at all is simpler AND strictly safer:
  // passing `--frontend-dir` with `--lane rust` now cannot contribute an id,
  // rather than contributing ids a filter is trusted to remove.
  const current =
    args.lane === 'rust'
      ? args.rustMissed
        ? parseRustSurvivors(args.rustMissed)
        : []
      : args.frontendDir
        ? parseFrontendSurvivors(args.frontendDir)
        : []

  const { survived, noCoverage } = partitionByOutcome(current)
  console.log(
    `${args.lane} mutation findings this run: ${current.length} — ${noCoverage.length} no-coverage, ${survived.length} survived`,
  )

  // --known-body-file is a TEST-ONLY escape hatch: it substitutes for the
  // `gh issue list` lookup so the diff/file/update logic can be exercised
  // against sample data without touching real GitHub state. The real
  // (non-test) path always goes through `gh issue list`.
  let existingIssue = null
  if (args.knownBodyFile !== undefined) {
    const body = existsSync(args.knownBodyFile) ? readFileSync(args.knownBodyFile, 'utf8') : ''
    existingIssue = body ? { number: 0, state: 'OPEN', body } : null
  } else {
    if (!repo)
      throw new Error(
        '--repo (or $GITHUB_REPOSITORY) is required outside of --known-body-file test mode',
      )
    existingIssue = findTrackingIssue(repo, args.title)
  }

  // #4173 — see `applyAcceptedGaps`: the proven-equivalent mutants come out of
  // the observed set (and out of the tracked set) before anything else looks
  // at either.
  const { accepted, stale, acceptedOn, reported, known } = applyAcceptedGaps({
    body: existingIssue?.body,
    current,
  })
  // #3350 — carried forward from the existing body so a survivor's age is
  // measured from when it FIRST appeared, not from the last time the body was
  // rewritten. Entries with no recorded date (anything written before #3350)
  // stay dateless until they resolve; back-dating them to today would make
  // every standing gap look new, which is the state this whole issue exists
  // to get out of.
  const firstSeen = parseFirstSeen(existingIssue?.body)
  const today = new Date().toISOString().slice(0, 10)
  const { newOnes, resolvedOnes, all } = diffSurvivors(reported, known)

  // The child bookkeeping (#3667). The recorded `area -> #number` map is READ
  // unconditionally and ACTED ON only under `--children`: parsing it only when
  // the flag is on would make a single run without the flag silently delete
  // the block on its next body rewrite, losing the tier-1 dedup record and
  // making the run after that re-file every child that already exists.
  const knownChildren = parseChildLinks(existingIssue?.body)
  // The plan is computed BEFORE the no-op check because it can itself be a
  // reason to act: an area whose LAST survivor was killed leaves a child issue
  // standing that claims mutants survive there, and that is the same lie
  // `file-scheduled-failures.mjs` refuses to leave open on the lane tracker.
  const childActions = args.children
    ? decideChildActions({
        groups: groupByArea(all),
        newOnes,
        knownChildren,
        maxChildren: args.maxChildren,
        // #4173 residual — an area whose every remaining finding is accepted is
        // absent from `groupByArea(all)` and closes like a clean one. The plan
        // carries the accepted ids so the close can say which of the two it is.
        accepted,
      })
    : []
  // A 'sync' re-renders a child body that is identical to what is already
  // there, so an unchanged week still writes nothing and never spams.
  const childWork = childActions.filter((a) => a.action !== 'sync')

  // An open issue with nothing left to track is itself a reason to act: the
  // close would otherwise depend on child bookkeeping happening to land in the
  // SAME run. It usually does — the last survivor resolving also closes its
  // area's child — but "usually" leaves the issue open forever in every case
  // where it does not, and a quiet week is precisely when nobody looks.
  // …and gated on the lane's input looking COMPLETE, not merely present.
  // `--require-input` only proves the frontend lane produced something; a run
  // that lost a module's report empties that module's share of the set, and
  // closing on that is the one NEW way this PR could lose an issue. The
  // rewrite-from-partial-data underneath is pre-existing (#3364) and left
  // alone: widening `--require-input` would be a different fix wearing this
  // PR's clothes. The rust lane needs no equivalent — a short merge already
  // forces `--dry-run`, so it never reaches a write at all.
  const frontendComplete =
    args.lane !== 'frontend' ||
    EXPECTED_FRONTEND_REPORTS === undefined ||
    frontendReportCount(args.frontendDir ?? '') >= EXPECTED_FRONTEND_REPORTS
  // Computed ONCE and threaded into every site that acts on it. It was
  // spelled three times — here, in `writeParent`, and in `printDryRun` — and
  // only this copy carried `frontendComplete`, so the gate did not gate the
  // close it was added for: with `--children`, a partial frontend run's
  // child-closes make `willWrite` true on their own and `writeParent` then
  // closed on its own un-gated copy of the condition.
  const needsClose =
    all.length === 0 &&
    existingIssue !== null &&
    existingIssue.state !== 'CLOSED' &&
    frontendComplete
  const willWrite = newOnes.length > 0 || childWork.length > 0 || needsClose
  announceReanchoring({ stale, willWrite, dryRun: args.dryRun })

  if (!willWrite) {
    console.log('no new mutation findings — no-op (tracking issue left untouched)')
    if (resolvedOnes.length > 0) {
      console.log(
        `(${resolvedOnes.length} previously-known finding(s) no longer present — not a reason to touch the issue on their own: ${resolvedOnes.join(', ')})`,
      )
    }
    return
  }

  // #4173 residual — the durable half: the run log that recorded a drop dies
  // with the run, so the drop is written into the body too, carried forward
  // from the body that is being replaced.
  const reanchored = appendReanchorNote(parseReanchorNotes(existingIssue?.body), stale, today)

  if (args.dryRun) {
    // Rendered against the ALREADY-RECORDED links only: a dry run files no
    // child, so no new number exists, and inventing one would misdescribe what
    // the real run would write. The planned actions are printed separately.
    const body = buildIssueBody({
      all,
      resolvedOnes,
      runUrl,
      firstSeen,
      today,
      newOnes,
      childLinks: knownChildren,
      accepted,
      acceptedOn,
      reanchored,
    })
    printDryRun({ args, existingIssue, newOnes, resolvedOnes, all, body, childActions, needsClose })
    return
  }

  if (!repo) throw new Error('--repo (or $GITHUB_REPOSITORY) is required to file/update an issue')

  // Children FIRST — the parent records their numbers, so they have to exist.
  const childLinks = args.children
    ? applyChildActions({
        actions: childActions,
        repo,
        runUrl,
        firstSeen,
        parentNumber: existingIssue?.number,
        parentTitle: args.title,
      })
    : knownChildren

  const body = buildIssueBody({
    all,
    resolvedOnes,
    runUrl,
    firstSeen,
    today,
    newOnes,
    childLinks,
    accepted,
    acceptedOn,
    reanchored,
  })
  writeParent({ existingIssue, repo, title: args.title, body, newOnes, childWork, needsClose })
}

/**
 * The parent write. Split from `main` for its cyclomatic complexity, and
 * because it carries three branches' worth of policy: a run with NEW
 * survivors reopens a closed issue, a run with only CHILD work syncs the body
 * silently, and a run whose lane has emptied closes it. Reopening is the only
 * notification left — this job never comments — so the "quiet week writes
 * nothing" rule that keeps child bookkeeping from becoming a weekly
 * notification now rests entirely on the sync branch being silent.
 *
 * Close when there is nothing left to act on; reopen when something new
 * arises. The children have always done this; the parent only ever reopened,
 * so a lane that got to zero left its parent standing with an empty survivor
 * block — indistinguishable, at a glance, from a lane nobody had triaged.
 *
 * "Nothing to act on" is `all.length === 0`: every tracked finding is gone or
 * accepted-equivalent. Accepted entries deliberately do NOT keep it open —
 * they are recorded, unkillable and not work — which is the same rule the
 * child close already uses, and why that close writes the not-an-all-clear
 * note into its body first.
 */
function writeParent({ existingIssue, repo, title, body, newOnes, childWork, needsClose }) {
  if (existingIssue === null) {
    withTempFile(body, (bodyFile) => {
      const labelArgs = TRACKING_ISSUE_LABELS.flatMap((l) => ['--label', l])
      gh([
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        title,
        '--body-file',
        bodyFile,
        ...labelArgs,
      ])
    })
    console.log(`filed a new tracking issue (${newOnes.length} finding(s))`)
    return
  }

  const number = String(existingIssue.number)
  if (newOnes.length === 0) {
    withTempFile(body, (f) => gh(['issue', 'edit', number, '--repo', repo, '--body-file', f]))
    // Body first, then close: the body is the record of WHY it closed, and a
    // close that raced ahead of it would leave the old survivor list showing.
    if (needsClose) {
      gh(['issue', 'close', number, '--repo', repo])
      console.log(`closed tracking issue #${number} — nothing left to act on in this lane`)
      return
    }
    console.log(
      `synced tracking issue #${number} body (${childWork.length} child action(s); no new findings)`,
    )
    return
  }

  if (existingIssue.state === 'CLOSED') {
    gh(['issue', 'reopen', number, '--repo', repo])
  }
  withTempFile(body, (f) => gh(['issue', 'edit', number, '--repo', repo, '--body-file', f]))
  console.log(`updated tracking issue #${number} (${newOnes.length} new finding(s))`)
}

function printDryRun({
  args,
  existingIssue,
  newOnes,
  resolvedOnes,
  all,
  body,
  childActions,
  needsClose,
}) {
  // Compare to null explicitly — issue #0 is not a real GitHub issue
  // number, but the `--known-body-file` test stub uses 0 as a placeholder
  // and 0 is falsy, so a `existingIssue.number` truthiness check here
  // would misreport an existing issue as "not found".
  if (existingIssue !== null) {
    console.log(
      `[dry-run] would ${existingIssue.state === 'CLOSED' && newOnes.length > 0 ? 'REOPEN + ' : ''}edit issue #${existingIssue.number}`,
    )
    // The close is the branch a smoke dispatch most needs previewed: it is
    // the only one that changes the issue's STATE, and a lane reaching zero
    // is exactly when someone runs a dry run to see what would happen.
    if (needsClose && newOnes.length === 0) {
      console.log(
        `[dry-run] would CLOSE issue #${existingIssue.number} — nothing left to act on in this lane`,
      )
    }
  } else {
    console.log(`[dry-run] would CREATE a new issue titled "${args.title}"`)
  }
  console.log(
    `[dry-run] new findings: ${newOnes.length}, resolved: ${resolvedOnes.length}, total known: ${all.length}`,
  )
  if (args.children) {
    console.log(`[dry-run] child issues (cap ${args.maxChildren}):`)
    for (const a of childActions) {
      // A close whose area still holds accepted-equivalent mutants reads as
      // "0 finding(s)" like any other close, which is the same false all-clear
      // the close COMMENT used to carry. Say which kind of close it is here too.
      const acceptedNote =
        (a.accepted?.length ?? 0) > 0
          ? ` (${a.accepted.length} accepted as equivalent, still surviving)`
          : ''
      console.log(
        `[dry-run]   ${a.action.padEnd(6)} ${a.number ? `#${a.number}` : '(new)'} ${a.area} — ${a.members.length} finding(s)${acceptedNote}`,
      )
      if (a.action === 'create') {
        console.log(`[dry-run]     title: ${childIssueTitle(a.area)}`)
      }
    }
  }
  console.log('[dry-run] --- issue body ---')
  console.log(body)
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
//
// Fixture suite for the two rendering invariants this script has already
// broken once:
//   #3245 — no survivor may appear twice in the issue body (the old
//           `### New this run` section re-listed the whole known set, so
//           every count a triager grepped out of the body read 2x).
//   #3257 — the rendered body must never exceed MAX_BODY_CHARS, and the
//           machine-readable marker block must never be cut mid-way (a
//           truncated block silently shrinks the tracked set).
// USED to run as the `mutation-survivors-filer-selftest` prek hook; #4556
// Phase 1 unwired it. These assertions still execute, but only transitively,
// via `main-module-detection-selftest` — see the note on that hook's stanza
// in prek.toml before re-keying either.
// #3364 fixtures, split out of `runSelfTest` to keep its cyclomatic
// complexity under the repo lint budget.
// #3350 fixtures — survivor AGE, which is what makes "long-standing" and
// "new" distinguishable at all, plus the ONE thing that half could plausibly break: the
// state-block format changed to carry a first-seen date, and if that change
// were not backward compatible, the first run after it would read every
// pre-existing survivor as resolved-and-immediately-new — silently resetting
// the very memory the filer exists to keep. Split out of `runSelfTest` to
// keep its cyclomatic complexity under the repo lint budget.
function selfTestSurvivorAges({ ok, fail, survivor }) {
  const rust = (line) => `[rust] agaric-store/src/op.rs:${line}:5: replace foo with bar in x`

  // 9a. MIGRATION. A body written by the PRE-#3350 code (no date prefixes)
  //     must parse to exactly the same ids as the new format. If this ever
  //     fails, the deploy of #3350 itself wipes the tracked set.
  {
    const legacy = [
      MARKER_START,
      '```',
      survivor(1),
      survivor(2),
      rust(10),
      '```',
      MARKER_END,
    ].join('\n')
    const parsed = parseKnownSurvivors(legacy)
    const ages = parseFirstSeen(legacy)
    if (parsed.size === 3 && parsed.has(survivor(1)) && parsed.has(rust(10)) && ages.size === 0)
      ok('an undated (pre-#3350) state block still parses to the same ids (#3350)')
    else
      fail(
        'an undated (pre-#3350) state block still parses to the same ids (#3350)',
        `size=${parsed.size} ages=${ages.size}`,
      )
  }

  // 9b. ROUND TRIP. A dated body parses back to the same ids AND to the dates
  //     it was written with — the property that makes "long-standing" mean
  //     something on the next run.
  {
    const all = [survivor(1), survivor(2)]
    const firstSeen = new Map([[survivor(1), '2026-01-15']])
    const body = buildIssueBody({
      all,
      resolvedOnes: [],
      firstSeen,
      today: '2026-07-31',
      newOnes: [survivor(2)],
    })
    const reparsed = parseKnownSurvivors(body)
    const reages = parseFirstSeen(body)
    if (
      reparsed.size === 2 &&
      all.every((s) => reparsed.has(s)) &&
      reages.get(survivor(1)) === '2026-01-15' &&
      reages.get(survivor(2)) === '2026-07-31'
    )
      ok('a dated state block round-trips ids and preserves the older date (#3350)')
    else
      fail(
        'a dated state block round-trips ids and preserves the older date (#3350)',
        `ids=${reparsed.size} d1=${reages.get(survivor(1))} d2=${reages.get(survivor(2))}`,
      )
  }

  // 9c. AGE IS NOT REWRITTEN. Re-rendering an existing set on a later day
  //     must not restamp it — otherwise every survivor is permanently "seen
  //     today" and the age column is decoration.
  {
    const all = [survivor(1)]
    const day1 = buildIssueBody({ all, resolvedOnes: [], today: '2026-01-15', newOnes: all })
    const day2 = buildIssueBody({
      all,
      resolvedOnes: [],
      firstSeen: parseFirstSeen(day1),
      today: '2026-07-31',
      newOnes: [],
    })
    if (parseFirstSeen(day2).get(survivor(1)) === '2026-01-15' && day2.includes('2026-01-15'))
      ok('re-rendering a known survivor does not restamp its first-seen date (#3350)')
    else
      fail(
        're-rendering a known survivor does not restamp its first-seen date (#3350)',
        String(parseFirstSeen(day2).get(survivor(1))),
      )
  }

  // 9c2. A survivor that is ALREADY TRACKED but carries no date (every entry
  //     the tracking issue held before #3350, including #3248's 21 permanent
  //     equivalent mutants) must stay undated rather than be stamped today.
  //     Back-dating them would relabel the entire standing backlog as "found
  //     this week" on the very first run after this change — the same class
  //     of lie as #3245's double count, just in the other direction.
  {
    const legacyId = survivor(1)
    const trulyNew = survivor(2)
    const body = buildIssueBody({
      all: [legacyId, trulyNew],
      resolvedOnes: [],
      firstSeen: new Map(),
      today: '2026-07-31',
      newOnes: [trulyNew],
    })
    const ages = parseFirstSeen(body)
    if (
      !ages.has(legacyId) &&
      ages.get(trulyNew) === '2026-07-31' &&
      parseKnownSurvivors(body).size === 2
    )
      ok('a known-but-undated survivor is not back-dated to today (#3350)')
    else
      fail(
        'a known-but-undated survivor is not back-dated to today (#3350)',
        `legacy=${ages.get(legacyId)} new=${ages.get(trulyNew)} ids=${parseKnownSurvivors(body).size}`,
      )
  }

  // 9c3. The age the TABLE reports must equal the age the STATE BLOCK writes
  //     back. Two independent resolutions of the same fact is how a report
  //     starts lying: the table said `_unknown_` for a survivor the block had
  //     just stamped with today's date, so a maintainer read "standing gap"
  //     where the truth was "found this run".
  {
    const all = [survivor(1), survivor(2)]
    const body = buildIssueBody({
      all,
      resolvedOnes: [],
      firstSeen: new Map([[survivor(1), '2026-01-15']]),
      today: '2026-07-31',
      newOnes: [survivor(2)],
    })
    const table = body.slice(body.indexOf('| Area |'), body.indexOf('### All currently-known'))
    const written = parseFirstSeen(body)
    // One area (both fixtures are glob-validate), oldest = the January date.
    if (table.includes('| 2026-01-15 |') && written.get(survivor(1)) === '2026-01-15')
      ok('the area table reports the same age the state block writes back (#3350)')
    else
      fail(
        'the area table reports the same age the state block writes back (#3350)',
        `table=${table.trim()} written=${written.get(survivor(1))}`,
      )

    // An area MIXING a dated member with an undated one must report
    //     `_unknown_`, not the dated one. The undated member predates
    //     tracking, so it is OLDER than any date held; printing the recent
    //     date as "oldest" would make an ancient standing gap read as fresh.
    {
      const mixed = buildIssueBody({
        all: [survivor(1), survivor(2)],
        resolvedOnes: [],
        firstSeen: new Map(),
        today: '2026-07-31',
        newOnes: [survivor(2)],
      })
      const row = mixed.slice(mixed.indexOf('| frontend: glob-validate |'))
      if (row.startsWith('| frontend: glob-validate | 0 | 2 | _unknown_ |'))
        ok('an area mixing dated and undated members reports "unknown" (#3350)')
      else
        fail(
          'an area mixing dated and undated members reports "unknown" (#3350)',
          row.split('\n')[0],
        )
    }

    // …and an all-new area reports today, not `_unknown_`.
    const fresh = buildIssueBody({
      all: [survivor(3)],
      resolvedOnes: [],
      today: '2026-07-31',
      newOnes: [survivor(3)],
    })
    if (fresh.includes('| 2026-07-31 |') && !fresh.includes('_unknown_'))
      ok('an all-new area reports today, not "unknown" (#3350)')
    else
      fail(
        'an all-new area reports today, not "unknown" (#3350)',
        fresh.slice(fresh.indexOf('| Area |'), fresh.indexOf('### All currently-known')),
      )
  }
}

// #3350 (second half) — grouping and ranking. Split from the age fixtures
// above only to keep each function under the repo's cyclomatic-complexity
// lint budget; the two halves are asserted together from `runSelfTest`.
function selfTestGroupingAndRanking({ ok, fail, survivor }) {
  const rust = (line) => `[rust] agaric-store/src/op.rs:${line}:5: replace foo with bar in x`

  // 9d. AREA SPLITTING for both lanes' id shapes, and the unparseable
  //     fallback (a survivor that does not fit the shape is still a survivor
  //     and must not be dropped from the grouping).
  {
    const cases = [
      [survivor(1), 'frontend: glob-validate'],
      [rust(10), 'rust: agaric-store/src/op.rs'],
      ['[frontend] not-a-survivor-line', 'frontend: (unparsed)'],
      ['garbage', '(unparsed)'],
    ]
    const bad = cases.filter(([id, want]) => survivorArea(id) !== want)
    if (bad.length === 0) ok('survivorArea splits both lanes and falls back safely (#3350)')
    else fail('survivorArea splits both lanes and falls back safely (#3350)', JSON.stringify(bad))

    const grouped = groupByArea(cases.map(([id]) => id))
    const total = grouped.reduce((n, g) => n + g.members.length, 0)
    if (total === cases.length) ok('groupByArea drops nothing (#3350)')
    else fail('groupByArea drops nothing (#3350)', `${total} of ${cases.length}`)
  }

  // 9e. RANKING. The worst area must come first in both the body's table and
  //     the per-run comment — that ordering is the entire readability claim.
  {
    const many = Array.from({ length: 5 }, (_, i) => rust(i + 1))
    const few = [survivor(1)]
    const ids = [...few, ...many]
    const groups = groupByArea(ids)
    const body = buildIssueBody({ all: ids, resolvedOnes: [], today: '2026-07-31' })
    const bodyRustFirst =
      body.indexOf('| rust: agaric-store/src/op.rs |') < body.indexOf('| frontend: glob-validate |')
    if (groups[0].members.length === 5 && bodyRustFirst)
      ok('the worst area is ranked first in the body (#3350)')
    else
      fail(
        'the worst area is ranked first in the body (#3350)',
        `first=${groups[0].area} body=${bodyRustFirst}`,
      )
  }

  // 9f. The area table must still not duplicate any survivor line — the
  //     #3245 double-count invariant, re-asserted against the section #3350
  //     adds, because a "helpful" summary that lists members instead of
  //     counts is exactly how that bug happened the first time.
  {
    const ids = [survivor(1), survivor(2), rust(10)]
    const body = buildIssueBody({ all: ids, resolvedOnes: [], today: '2026-07-31' })
    const counts = ids.map((s) => body.split(s).length - 1)
    if (counts.every((c) => c === 1)) ok('the #3350 area table adds no duplicate lines (#3245)')
    else fail('the #3350 area table adds no duplicate lines (#3245)', JSON.stringify(counts))
  }

  // 9g. CLAMP ORDER. When the body overflows, the resolved list goes before
  //     the area table (worth more per character), and when even that is not
  //     enough the area table goes too — but the state block survives both,
  //     intact and re-parseable.
  {
    const all = Array.from({ length: 200 }, (_, i) => survivor(i))
    const resolvedOnes = Array.from({ length: 600 }, (_, i) => survivor(10_000 + i))
    const body = buildIssueBody({ all, resolvedOnes, today: '2026-07-31' })
    if (
      body.length <= MAX_BODY_CHARS &&
      body.includes('Where the findings are') &&
      !body.includes(resolvedOnes[0]) &&
      parseKnownSurvivors(body).size === 200
    )
      ok('the clamp drops the resolved list before the area table (#3350)')
    else
      fail(
        'the clamp drops the resolved list before the area table (#3350)',
        `len=${body.length} area=${body.includes('Where the findings are')} state=${parseKnownSurvivors(body).size}`,
      )
  }

  // 9h. THE LAST RUNG, which nothing else covers: 9g pins "resolved goes
  //     before the table" and fixture 4 pins the throw, but the render in
  //     between — area table dropped, body still valid — had no assertion at
  //     all, and was where the note lied. Areas are unbounded (the rust lane
  //     groups by source FILE), so a WIDE-but-shallow set reaches this rung
  //     with an empty resolved list, and the note used to read "0
  //     resolved-since-last-run entries were omitted" while silently dropping
  //     the table it never mentioned.
  {
    const wide = Array.from(
      { length: 430 },
      (_, a) =>
        `[frontend] module-${String(a).padStart(3, '0')}-with-a-long-descriptive-name: a.ts:1 [X]`,
    )
    const body = buildIssueBody({
      all: wide,
      resolvedOnes: [],
      runUrl: 'https://example/run',
      today: '2026-07-31',
      newOnes: wide,
    })
    if (
      body.length <= MAX_BODY_CHARS &&
      !body.includes('Where the findings are') &&
      body.includes('"where the findings are" table (430 area(s))') &&
      !body.includes('0 resolved-since-last-run') &&
      parseKnownSurvivors(body).size === 430
    )
      ok('dropping the area table says so, and never claims "0 resolved" (#3350)')
    else
      fail(
        'dropping the area table says so, and never claims "0 resolved" (#3350)',
        `len=${body.length} table=${body.includes('Where the findings are')} state=${parseKnownSurvivors(body).size} note=${body.split('\n').find((l) => l.includes('Omitted to keep'))}`,
      )

    // …and when BOTH sections go, the note names both rather than one.
    const both = buildIssueBody({
      all: wide,
      resolvedOnes: [survivor(1), survivor(2)],
      runUrl: 'https://example/run',
      today: '2026-07-31',
      newOnes: wide,
    })
    const noteLine = both.split('\n').find((l) => l.includes('Omitted to keep')) ?? ''
    if (noteLine.includes('table (430 area(s))') && noteLine.includes('2 resolved-since-last-run'))
      ok('a two-section clamp names both dropped sections (#3350)')
    else fail('a two-section clamp names both dropped sections (#3350)', noteLine)
  }
}

function selfTestLaneInputGuards({ ok, fail, survivor }) {
  // Tracked by the fixture body below and NOT present in `fullDir`, so the
  // lane observes nothing and the issue's set empties.
  const STALE_ONLY_ID = '[rust] agaric-store/src/op.rs:4242:9: replace x with ()'
  // 8. #3364 — a MISSING lane input must be distinguishable from an EMPTY
  //    one. First, the damage the guards prevent, demonstrated on the pure
  //    functions: a dead frontend lane contributes `[]`, and one new rust
  //    survivor is enough to rewrite the body WITHOUT the frontend entries.
  {
    const frontendSurvivor = survivor(1)
    const rustOld = '[rust] src/op.rs:10:5: replace foo with bar'
    const rustNew = '[rust] src/op.rs:99:1: replace baz with qux'
    const known = new Set([frontendSurvivor, rustOld])
    // frontend lane dead -> contributes nothing; rust lane contributes a new one
    const { newOnes, resolvedOnes, all } = diffSurvivors([rustOld, rustNew], known)
    const body = buildIssueBody({ all, resolvedOnes, runUrl: undefined })
    if (newOnes.length === 1 && !parseKnownSurvivors(body).has(frontendSurvivor))
      ok('an unguarded dead lane really would delete its survivors from the tracked set (#3364)')
    else
      fail(
        'an unguarded dead lane really would delete its survivors from the tracked set (#3364)',
        `newOnes=${newOnes.length} stillTracked=${parseKnownSurvivors(body).has(frontendSurvivor)}`,
      )
  }

  // …and the guards themselves. `main()` runs in dry-run + --known-body-file
  // mode throughout, so no `gh` call is ever made.
  {
    const root = mkdtempSync(join(tmpdir(), 'survivor-require-'))
    const emptyDir = join(root, 'empty')
    mkdirSync(emptyDir)
    const fullDir = join(root, 'full')
    mkdirSync(join(fullDir, 'glob-validate'), { recursive: true })
    writeFileSync(join(fullDir, 'glob-validate', 'mutation.json'), JSON.stringify({ files: {} }))
    const missed = join(root, 'missed.txt')
    writeFileSync(missed, '')
    const absent = join(root, 'nope')

    const runQuiet = (argv) => {
      const realLog = console.log
      console.log = () => {}
      try {
        main(argv)
        return null
      } catch (err) {
        return err
      } finally {
        console.log = realLog
      }
    }
    const base = ['--dry-run', '--known-body-file', join(root, 'no-such-body.md')]

    const cases = [
      [
        'an ABSENT frontend dir fails --require-input (#3364)',
        [...base, '--lane', 'frontend', '--frontend-dir', absent, '--require-input'],
        /no Stryker mutation\.json/,
      ],
      [
        'an EMPTY frontend dir fails --require-input too — empty artifact is still no data (#3364)',
        [...base, '--lane', 'frontend', '--frontend-dir', emptyDir, '--require-input'],
        /no Stryker mutation\.json/,
      ],
      [
        'an absent missed.txt fails --require-input (#3364)',
        [...base, '--lane', 'rust', '--rust-missed', absent, '--require-input'],
        /no cargo-mutants missed\.txt/,
      ],
      [
        'an unknown --lane is refused rather than guessing which issue to rewrite',
        [...base, '--lane', 'bogus', '--rust-missed', missed],
        /--lane is required and must be one of/,
      ],
      [
        'a missing --lane is refused for the same reason',
        [...base, '--rust-missed', missed],
        /--lane is required and must be one of/,
      ],
      [
        // The guard is per-lane now: --require-input on the rust lane says
        // nothing about the frontend dir, so the OTHER lane's absent input
        // must not fail it. Under the old cross-lane pair this was the
        // failure that made a single-lane run impossible (#4685 review).
        "--require-input on one lane ignores the other lane's absent input",
        [
          ...base,
          '--lane',
          'rust',
          '--rust-missed',
          absent,
          '--frontend-dir',
          absent,
          '--require-input',
        ],
        /no cargo-mutants missed\.txt/,
      ],
    ]
    for (const [name, argv, pattern] of cases) {
      const err = runQuiet(argv)
      if (err && pattern.test(err.message)) ok(name)
      else fail(name, err ? err.message : 'did not throw')
    }

    // The complement: real data must still pass, or the guard is just a
    // permanent red lane. An EMPTY missed.txt is real data (cargo-mutants
    // writes one when nothing survived) — only an ABSENT one is "no data".
    const okCases = [
      [
        'a populated frontend dir passes --require-input',
        [...base, '--lane', 'frontend', '--frontend-dir', fullDir, '--require-input'],
      ],
      [
        'an empty-but-present missed.txt passes --require-input',
        [...base, '--lane', 'rust', '--rust-missed', missed, '--require-input'],
      ],
      [
        'the guard is opt-in: an absent dir is still tolerated without the flag',
        [...base, '--lane', 'frontend', '--frontend-dir', absent, '--rust-missed', absent],
      ],
      [
        // The frontend lane's own input is absent, but it is the RUST lane
        // running: its input is present, so this run is fine. The old paired
        // flags made this combination a hard error.
        "the frontend lane's absent input does not block the rust lane",
        [
          ...base,
          '--lane',
          'rust',
          '--rust-missed',
          missed,
          '--frontend-dir',
          absent,
          '--require-input',
        ],
      ],
    ]
    for (const [name, argv] of okCases) {
      const err = runQuiet(argv)
      if (err === null) ok(name)
      else fail(name, err.message)
    }

    // A CLOSE-ONLY RUN. The lane observes nothing and its issue still tracks
    // one entry, with no child work to do. `willWrite` used to be
    // `newOnes || childWork`, so this returned at the no-op branch and the
    // issue stayed open forever — the close only ever fired when the last
    // child's close happened to land in the SAME run. Both halves are pinned:
    // it must NOT no-op, and the dry run must say it would close, because a
    // dry run that hides the one state-changing branch is why this was missed.
    {
      const trackedBody = join(root, 'close-only-body.md')
      writeFileSync(
        trackedBody,
        [
          'Tracking issue.',
          '',
          MARKER_START,
          '```',
          `2026-08-01\t${STALE_ONLY_ID}`,
          '```',
          MARKER_END,
        ].join('\n'),
        'utf8',
      )
      // The RUST lane, deliberately: an empty-but-present missed.txt is a
      // complete run that found nothing, so the close is not gated. The
      // frontend equivalent is the case immediately below, which must NOT
      // close.
      const { out, err } = captureMain([
        '--dry-run',
        '--lane',
        'rust',
        '--rust-missed',
        missed,
        '--known-body-file',
        trackedBody,
      ])
      const problems = []
      if (err) problems.push(`threw: ${err.message}`)
      if (/no-op \(tracking issue left untouched\)/.test(out))
        problems.push('took the no-op branch, so the issue would stay open')
      if (!/would CLOSE issue #\d+ — nothing left to act on/.test(out))
        problems.push('the dry run did not preview the close')
      if (problems.length === 0)
        ok('a lane whose last finding is gone closes, with no child work to trigger it')
      else
        fail(
          'a lane whose last finding is gone closes, with no child work to trigger it',
          problems.join('; '),
        )

      // THE SAME STATE, ON A SHORT FRONTEND REPORT SET. `fullDir` holds ONE
      // module's mutation.json while a complete run writes one per module, so
      // the emptied set is an artifact of the missing reports, not a lane that
      // got clean. Rewriting from partial data is pre-existing (#3364); what
      // this PR added is that the same partial data could CLOSE the issue,
      // which is the one outcome nobody re-reads. It must not.
      //
      // `--children` AND a recorded child link are both load-bearing here.
      // Without them this ran through the `no-op` branch and never reached
      // the close guard — it asserted "did not close" about a run that was
      // never going to write at all, the vacuous shape AGENTS.md names. With
      // them the emptied set makes `decideChildActions` emit a close for the
      // recorded area, so `childWork > 0` and `willWrite` is true on its own,
      // leaving the close guard as the only thing between a partial report
      // set and a closed issue.
      const feTracked = join(root, 'close-only-frontend-body.md')
      writeFileSync(
        feTracked,
        [
          'Tracking issue.',
          '',
          MARKER_START,
          '```',
          `2026-08-01\t${survivor(4242)}`,
          '```',
          MARKER_END,
          CHILD_MARKER_START,
          '```',
          `#101\t${survivorArea(survivor(4242))}`,
          '```',
          CHILD_MARKER_END,
        ].join('\n'),
        'utf8',
      )
      const short = captureMain([
        '--dry-run',
        '--children',
        '--lane',
        'frontend',
        '--frontend-dir',
        fullDir,
        '--known-body-file',
        feTracked,
      ])
      // Only meaningful when the expected count could be derived. The #3373
      // guard runs this self-test from a DETACHED copy, where
      // `../stryker.modules.mjs` is not importable and
      // `EXPECTED_FRONTEND_REPORTS` is `undefined` — the gate then disables
      // itself by design (documented on the constant), so asserting it holds
      // there asserts the opposite of the intended behaviour.
      if (EXPECTED_FRONTEND_REPORTS === undefined)
        ok(
          'a short frontend report set does not close the lane issue (skipped: count not derivable here)',
        )
      else if (!/would CLOSE issue/.test(short.out))
        ok('a short frontend report set does not close the lane issue')
      else
        fail(
          'a short frontend report set does not close the lane issue',
          `EXPECTED_FRONTEND_REPORTS=${EXPECTED_FRONTEND_REPORTS}; out=${short.out.slice(0, 200)}`,
        )
    }
  }
}

/**
 * Parent/child fixtures, pure half. The invariant that matters most is the
 * FIRST one: the child block lives in the same body as the survivor block, so a
 * botched marker would either swallow survivor lines into the child map or
 * leak `#12\tarea` lines into the tracked survivor set — and either way the
 * next run reads a corrupted set and re-reports the difference as "new".
 */
function selfTestChildPlanning({ check, survivor }) {
  const rust = (line) => `[rust] agaric-store/src/op.rs:${line}:5: replace foo with bar in x`
  const FE = 'frontend: glob-validate'
  const RS = 'rust: agaric-store/src/op.rs'

  // 10a. The two blocks must not see each other's lines, in either direction.
  {
    const all = [survivor(1), survivor(2), rust(10)]
    const links = new Map([
      [FE, 41],
      [RS, 42],
    ])
    const body = buildIssueBody({
      all,
      resolvedOnes: [],
      today: '2026-08-09',
      newOnes: all,
      childLinks: links,
    })
    const survivors = parseKnownSurvivors(body)
    const children = parseChildLinks(body)
    check(
      survivors.size === 3 &&
        all.every((s) => survivors.has(s)) &&
        ![...survivors].some((s) => s.startsWith('#')),
      'the child block does not leak into the tracked survivor set',
      [...survivors].join(' | '),
    )
    check(
      children.size === 2 && children.get(FE) === 41 && children.get(RS) === 42,
      'the child block round-trips area -> issue number',
      JSON.stringify([...children]),
    )
    check(
      parseFirstSeen(body).size === 3,
      'the child block does not disturb first-seen parsing',
      String(parseFirstSeen(body).size),
    )
    // …and the area table names where to go.
    check(
      body.includes(`| ${FE} | 0 | 2 | 2026-08-09 | #41 |`),
      'the area table carries the child link when children exist',
      body.slice(body.indexOf('| Area'), body.indexOf('### All currently-known')),
    )
  }

  // 10b. …and with NO children the table keeps its old three-column shape, so
  //      a repo running without `--children` sees exactly what it saw before.
  {
    const body = buildIssueBody({ all: [survivor(1)], resolvedOnes: [], today: '2026-08-09' })
    check(
      body.includes('| Area | No coverage | Survivors | Oldest first seen |') &&
        !body.includes('Fix in') &&
        !body.includes(CHILD_MARKER_START),
      'without children the body is unchanged (no column, no block)',
      body.slice(body.indexOf('| Area'), body.indexOf('### All currently-known')),
    )
  }

  // 10c. The state machine. `create` on an unknown area, `notify` only when
  //      that area gained a survivor, `sync` otherwise (a quiet week must not
  //      comment on nine children), `close` when the area is gone.
  {
    const groups = groupByArea([survivor(1), survivor(2), rust(10)])
    const actions = decideChildActions({
      groups,
      newOnes: [survivor(2)],
      knownChildren: new Map([
        [FE, 41],
        ['frontend: date-utils', 43],
      ]),
    })
    const byArea = new Map(actions.map((a) => [a.area, a]))
    check(
      byArea.get(FE).action === 'notify' &&
        byArea.get(RS).action === 'create' &&
        byArea.get('frontend: date-utils').action === 'close' &&
        byArea.get('frontend: date-utils').number === 43,
      'child state machine: notify on new, create on unknown, close on vanished',
      actions.map((a) => `${a.area}=${a.action}`).join(' '),
    )
    const quiet = decideChildActions({
      groups,
      newOnes: [],
      knownChildren: new Map([
        [FE, 41],
        [RS, 42],
      ]),
    })
    check(
      quiet.every((a) => a.action === 'sync'),
      'an unchanged week plans only syncs (no child comment, no reopen)',
      quiet.map((a) => `${a.area}=${a.action}`).join(' '),
    )
  }

  // 10d. The blast-radius cap. Refusing loudly beats opening N issues nobody
  //      asked for, and it must count CREATES only — a large existing backlog
  //      of updates/closes is not a runaway.
  {
    const groups = groupByArea([survivor(1), rust(10)])
    let threw = null
    try {
      decideChildActions({ groups, newOnes: [], knownChildren: new Map(), maxChildren: 1 })
    } catch (err) {
      threw = err
    }
    check(threw !== null, 'the child cap throws rather than opening the batch', 'no throw')
    const manyCloses = decideChildActions({
      groups: [],
      newOnes: [],
      knownChildren: new Map(Array.from({ length: 50 }, (_, i) => [`area-${i}`, i + 1])),
      maxChildren: 1,
    })
    check(
      manyCloses.length === 50 && manyCloses.every((a) => a.action === 'close'),
      'the cap counts creates only — 50 closes are not a runaway',
      `${manyCloses.length} action(s)`,
    )
  }

  // 10e. A title is a pure function of the area and must fit GitHub's limit;
  //      an over-long one throws HERE rather than as a 422 from `gh`.
  {
    check(
      childIssueTitle(FE) === childIssueTitle(FE) && childIssueTitle(FE).includes(FE),
      'a child title is derived from the area verbatim (the tier-2 dedup key)',
      childIssueTitle(FE),
    )
    let threw = null
    try {
      childIssueTitle('x'.repeat(MAX_TITLE_CHARS))
    } catch (err) {
      threw = err
    }
    check(threw !== null, 'an over-long child title throws instead of 422ing `gh`', 'no throw')
  }

  // 10f. The clamp ladder must never drop the child block — it is the primary
  //      dedup record, so losing it would make the next run re-file every
  //      child it already has.
  {
    const wide = Array.from(
      { length: 430 },
      (_, a) =>
        `[frontend] module-${String(a).padStart(3, '0')}-with-a-long-descriptive-name: a.ts:1 [X]`,
    )
    const links = new Map([['frontend: module-000-with-a-long-descriptive-name', 77]])
    const body = buildIssueBody({
      all: wide,
      resolvedOnes: [],
      today: '2026-08-09',
      newOnes: wide,
      childLinks: links,
      runUrl: 'https://example/run',
    })
    check(
      body.length <= MAX_BODY_CHARS &&
        !body.includes('Where the findings are') &&
        parseChildLinks(body).get('frontend: module-000-with-a-long-descriptive-name') === 77 &&
        parseKnownSurvivors(body).size === 430,
      'the clamp drops the area table but never the child block',
      `len=${body.length} children=${parseChildLinks(body).size} state=${parseKnownSurvivors(body).size}`,
    )
  }

  // 10g. A child body is a projection: bounded, dated, pointing back at the
  //      parent, and carrying NO marker block of its own (state stays single
  //      copy, so a hand-mangled child costs nothing).
  {
    const members = Array.from({ length: 1200 }, (_, i) => survivor(i))
    const child = buildChildBody({
      area: FE,
      members,
      firstSeen: new Map([[survivor(0), '2026-01-15']]),
      parentNumber: 3142,
      runUrl: 'https://example/run',
    })
    check(
      child.length <= MAX_BODY_CHARS &&
        child.includes('Parent: #3142') &&
        child.includes('2026-01-15\t') &&
        !child.includes(MARKER_START) &&
        !child.includes(CHILD_MARKER_START) &&
        child.includes('do not fit in one issue body'),
      'an oversized child body truncates safely and links back to the parent',
      `len=${child.length}`,
    )
    const small = buildChildBody({ area: FE, members: [survivor(1)], parentNumber: 3142 })
    check(
      !small.includes('do not fit') && small.includes(survivor(1)),
      'a small child body is not truncated',
      small,
    )

    // THE FIRST RUN OF A LANE. `findTrackingIssue` returns null, so there is
    // no parent NUMBER and the title is the only reference the child can
    // carry. Review caught the `create` call site not passing it, which
    // rendered a literal `Parent: "undefined"` into a real filed issue — and
    // that is the state every lane is in on its first run, i.e. the next real
    // run. Before the split this could not happen: the fallback was a module
    // constant. Both halves are pinned: it must THROW rather than render the
    // string, and it must render the lane's own title when given one.
    let threw = null
    try {
      buildChildBody({ area: FE, members: [survivor(1)], parentNumber: undefined })
    } catch (err) {
      threw = err
    }
    check(
      threw !== null && /needs `parentTitle`/.test(threw.message),
      'a child with no parent number refuses to render `Parent: "undefined"`',
      threw ? threw.message : 'did not throw',
    )
    const firstRun = buildChildBody({
      area: FE,
      members: [survivor(1)],
      parentNumber: undefined,
      parentTitle: LANES.frontend.title,
    })
    check(
      firstRun.includes(`Parent: "${LANES.frontend.title}"`) && !firstRun.includes('undefined'),
      "a child filed before its lane parent exists names that lane's parent by title",
      firstRun.split('\n').find((l) => l.startsWith('Parent:')) ?? '(no Parent line)',
    )
  }
}

/**
 * What `main()` ACTUALLY writes when `--children` is on, driven end to end
 * against a stub `gh` placed first on `$PATH` — the same technique
 * `file-scheduled-failures.mjs` uses, and for the same reason: every fixture
 * above is a pure-function assertion, so deleting the `gh issue close` from the
 * resolved path, or the child-number recording from the parent edit, leaves
 * them all green while reintroducing exactly the bugs they describe.
 *
 * The single most important assertion here is the last one: an unchanged week
 * must issue NO `gh` call at all. This layer multiplies every write by the
 * number of areas, so a filer that "just refreshes" nine children every Monday
 * is nine notifications a week and the end of anyone reading them.
 */
function selfTestChildGh({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-children-gh-'))
  const log = join(dir, 'gh.log')
  const listFixture = join(dir, 'list.json')
  const stateFixture = join(dir, 'state.txt')
  const counter = join(dir, 'counter.txt')
  const stub = join(dir, 'gh')
  // Extensionless + CommonJS on purpose: `execFileSync('gh', …)` resolves the
  // name verbatim through `$PATH`, and a file under `tmpdir()` has no
  // `package.json` above it, so Node parses it as CJS.
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const a = process.argv.slice(2)',
      'const sub = a[1]',
      "const bi = a.indexOf('--body-file')",
      "const ti = a.indexOf('--title')",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({`,
      '  sub,',
      "  title: ti === -1 ? '' : a[ti + 1],",
      "  target: /^\\d+$/.test(a[2] || '') ? a[2] : '',",
      "  body: bi === -1 ? '' : fs.readFileSync(a[bi + 1], 'utf8'),",
      "}) + '\\n')",
      `if (sub === 'list') process.stdout.write(fs.readFileSync(${JSON.stringify(listFixture)}, 'utf8'))`,
      "else if (sub === 'view') {",
      `  const s = fs.readFileSync(${JSON.stringify(stateFixture)}, 'utf8').trim()`,
      // 'MISSING' stands in for a child that was deleted or transferred: `gh`
      // exits non-zero and prints nothing.
      "  if (s === 'MISSING') process.exit(1)",
      '  process.stdout.write(JSON.stringify({ state: s }))',
      '}',
      "else if (sub === 'create') {",
      `  const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1`,
      `  fs.writeFileSync(${JSON.stringify(counter)}, String(n))`,
      "  process.stdout.write('https://github.com/owner/repo/issues/' + n + '\\n')",
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(stub, 0o755)

  const missed = join(dir, 'missed.txt')
  const knownBody = join(dir, 'known-body.md')
  const opId = '[rust] agaric-store/src/op.rs:10:5: replace foo with bar in x'
  const revId = '[rust] src/reverse/mod.rs:20:1: replace baz with qux in y'
  const OP = 'rust: agaric-store/src/op.rs'
  const REV = 'rust: src/reverse/mod.rs'

  const drive = ({ missedLines, body, list = [], state = 'OPEN' }) => {
    writeFileSync(missed, missedLines.join('\n'), 'utf8')
    writeFileSync(knownBody, body, 'utf8')
    writeFileSync(listFixture, JSON.stringify(list), 'utf8')
    writeFileSync(stateFixture, state, 'utf8')
    writeFileSync(counter, '100', 'utf8')
    writeFileSync(log, '', 'utf8')
    const prevPath = process.env.PATH
    const prevLog = console.log
    process.env.PATH = `${dir}:${prevPath}`
    console.log = () => {}
    let threw = null
    try {
      main([
        '--lane',
        'rust',
        '--rust-missed',
        missed,
        '--children',
        '--known-body-file',
        knownBody,
        '--repo',
        'owner/repo',
        '--run-url',
        'https://example/run',
      ])
    } catch (err) {
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

  const parentWith = (all, childLinks, accepted = []) =>
    buildIssueBody({
      all,
      resolvedOnes: [],
      today: '2026-08-09',
      newOnes: [],
      childLinks,
      accepted,
      acceptedOn: new Map(accepted.map((id) => [id, '2026-08-09'])),
    })

  // 11a. BOOTSTRAP. A parent that already tracks both survivors but has no
  //      children yet: nothing is NEW, yet the children must still be filed —
  //      and the parent must record their numbers, or next week files them
  //      again. No parent COMMENT: there is no news, only bookkeeping.
  {
    const calls = drive({
      missedLines: [opId.replace('[rust] ', ''), revId.replace('[rust] ', '')],
      body: parentWith([opId, revId], new Map()),
    })
    const seq = calls.map((c) => c.sub).join(',')
    const created = calls.filter((c) => c.sub === 'create')
    const parentEdit = calls.findLast((c) => c.sub === 'edit')
    const recorded = parseChildLinks(parentEdit?.body ?? '')
    check(
      seq === 'list,create,list,create,edit',
      'bootstrap: each area is looked up, then filed, then the parent is edited once',
      `gh sequence was: ${seq || '(no gh calls at all)'}`,
    )
    check(
      created.length === 2 &&
        created
          .map((c) => c.title)
          .toSorted()
          .join(' | ') === [childIssueTitle(OP), childIssueTitle(REV)].toSorted().join(' | '),
      'bootstrap files one child per area, under the derived titles',
      created.map((c) => c.title).join(' | '),
    )
    check(
      recorded.get(OP) === 101 && recorded.get(REV) === 102,
      'the parent body main() writes records every child number (tier-1 dedup)',
      JSON.stringify([...recorded]),
    )
    check(
      !calls.some((c) => c.sub === 'comment'),
      'bootstrap posts no comment — filing children is bookkeeping, not news',
      seq,
    )
  }

  // 11b. ADOPTION (tier 2). A child exists under the derived title but the
  //      parent has no record of it — the state left behind by a run that
  //      created it and then died. It must be adopted, never duplicated.
  {
    const calls = drive({
      missedLines: [opId.replace('[rust] ', '')],
      body: parentWith([opId], new Map()),
      list: [{ number: 555, title: childIssueTitle(OP), state: 'OPEN' }],
      state: 'OPEN',
    })
    const seq = calls.map((c) => c.sub).join(',')
    const recorded = parseChildLinks(calls.findLast((c) => c.sub === 'edit')?.body ?? '')
    check(
      !calls.some((c) => c.sub === 'create') && recorded.get(OP) === 555,
      'an orphaned child is adopted by title, not duplicated (tier-2 dedup)',
      `${seq} recorded=${JSON.stringify([...recorded])}`,
    )
  }

  // 11c. RESOLVED. The area's last survivor is gone: the child is told why and
  //      CLOSED, the parent body is synced, and still nobody is spammed with a
  //      parent comment.
  {
    const calls = drive({
      missedLines: [],
      body: parentWith([opId], new Map([[OP, 101]])),
      state: 'OPEN',
    })
    const seq = calls.map((c) => c.sub).join(',')
    const closeBody = calls.find((c) => c.sub === 'edit' && c.target === '101')?.body ?? ''
    check(
      // ...,edit,close: the PARENT closes too, because this lane now has
      // nothing left to act on. The child close is the first `close` (target
      // 101), the parent's is the second — asserted by target below so the
      // two cannot be confused for one repeated call.
      seq === 'view,edit,close,edit,close' &&
        calls
          .filter((c) => c.sub === 'close')
          .map((c) => c.target)
          .join(',') === '101,0' &&
        closeBody.includes(OP) &&
        // This area really was cleaned up — the missed.txt is empty and
        // nothing is accepted — so the child body must carry NO
        // not-an-all-clear caveat, and 11i is the same sequence where it must.
        // The pair is what makes either assertion mean anything. The claim
        // moved from the close comment to the body the close writes first.
        !/not an all-clear/i.test(closeBody) &&
        !/accepted as equivalent/i.test(closeBody),
      'a resolved area edits its child body, closes it, then syncs the parent',
      `gh sequence was: ${seq || '(no gh calls at all)'} — body: ${closeBody.slice(0, 200)}`,
    )
    check(
      parseChildLinks(calls.findLast((c) => c.sub === 'edit')?.body ?? '').size === 0,
      'the closed child is dropped from the parent’s child block',
      calls.findLast((c) => c.sub === 'edit')?.body ?? '',
    )
  }

  // 11d. QUIET WEEK. Same survivors, same children, nothing new: not one `gh`
  //      call. This layer multiplies writes by the area count, so a filer that
  //      re-renders every child every Monday is the notification fatigue the
  //      rolling-issue design exists to avoid.
  {
    const calls = drive({
      missedLines: [opId.replace('[rust] ', ''), revId.replace('[rust] ', '')],
      body: parentWith(
        [opId, revId],
        new Map([
          [OP, 101],
          [REV, 102],
        ]),
      ),
    })
    check(
      calls.length === 0,
      'an unchanged week issues no `gh` write at all, children included',
      calls.map((c) => c.sub).join(','),
    )
  }

  // 11e. NEW SURVIVOR in a tracked area: the child is commented on (that is
  //      the notification) and so is the parent (that is the news).
  {
    const calls = drive({
      missedLines: [opId.replace('[rust] ', ''), 'agaric-store/src/op.rs:99:9: replace a with b'],
      body: parentWith([opId], new Map([[OP, 101]])),
      state: 'OPEN',
    })
    const seq = calls.map((c) => c.sub).join(',')
    const childEdit = calls.find((c) => c.sub === 'edit' && c.target === '101')
    check(
      // Two edits, no comments: the CI job never comments. The child's own
      // body is what names the new survivor, so asserting on it keeps this
      // test meaningful rather than reducing it to a call count.
      seq === 'view,edit,edit' && (childEdit?.body ?? '').includes('op.rs:99:9'),
      'a new survivor is written into its child body and the parent body',
      `gh sequence was: ${seq || '(no gh calls at all)'}`,
    )
  }

  // 11f. A child a human CLOSED must reopen when its area regresses — and only
  //      then. A `sync` against a closed child leaves it closed, exactly as the
  //      sibling reporter leaves a closed parent closed on a partial recovery.
  {
    const relapse = drive({
      missedLines: [opId.replace('[rust] ', ''), 'agaric-store/src/op.rs:99:9: replace a with b'],
      body: parentWith([opId], new Map([[OP, 101]])),
      state: 'CLOSED',
    })
    const quiet = drive({
      missedLines: [opId.replace('[rust] ', '')],
      body: parentWith([opId], new Map([[OP, 101]])),
      state: 'CLOSED',
    })
    check(
      relapse.map((c) => c.sub).join(',') === 'view,reopen,edit,edit',
      'a closed child reopens when its area gains a survivor',
      relapse.map((c) => c.sub).join(','),
    )
    check(
      quiet.length === 0,
      'a closed child is left closed when nothing changed',
      quiet.map((c) => c.sub).join(','),
    )
  }

  selfTestAcceptedChildClose({ check, drive, parentWith, opId, OP })

  // 11g. A recorded child that no longer exists (deleted, or transferred) must
  //      not take the whole run down with it — the parent update, and every
  //      other area, would be lost over one dead issue. The record is dropped
  //      so the next run re-adopts or re-files it.
  {
    const calls = drive({
      missedLines: [opId.replace('[rust] ', ''), 'agaric-store/src/op.rs:99:9: replace a with b'],
      body: parentWith([opId], new Map([[OP, 101]])),
      state: 'MISSING',
    })
    const parentEdit = calls.findLast((c) => c.sub === 'edit')
    check(
      !calls.some((c) => c.target === '101' && c.sub !== 'view') &&
        parentEdit !== undefined &&
        parseChildLinks(parentEdit.body).size === 0,
      'a vanished child is dropped from the record, and the parent is still updated',
      calls.map((c) => `${c.sub}${c.target ? `#${c.target}` : ''}`).join(','),
    )
  }

  // 11h. Running WITHOUT `--children` against a parent that has them must not
  //      delete the child block. It is the tier-1 dedup record, and dropping
  //      it makes the next run with the flag on re-file every child that
  //      already exists — the one way this layer can produce duplicates.
  {
    writeFileSync(missed, [opId.replace('[rust] ', ''), 'a/b.rs:1:1: replace x with y'].join('\n'))
    writeFileSync(knownBody, parentWith([opId], new Map([[OP, 101]])), 'utf8')
    writeFileSync(log, '', 'utf8')
    const prevPath = process.env.PATH
    const prevLog = console.log
    process.env.PATH = `${dir}:${prevPath}`
    console.log = () => {}
    try {
      main([
        '--lane',
        'rust',
        '--rust-missed',
        missed,
        '--known-body-file',
        knownBody,
        '--repo',
        'owner/repo',
      ])
    } finally {
      console.log = prevLog
      process.env.PATH = prevPath
    }
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    const written = parseChildLinks(calls.find((c) => c.sub === 'edit')?.body ?? '')
    check(
      !calls.some((c) => c.sub === 'create' || c.sub === 'view') && written.get(OP) === 101,
      'a run without --children preserves the child block instead of deleting it',
      `${calls.map((c) => c.sub).join(',')} recorded=${JSON.stringify([...written])}`,
    )
  }
}

/**
 * #4173 residual — the false all-clear, driven through the real close path.
 * Split out of `selfTestChildGh` to keep that function's complexity from
 * growing further; it runs inside it, against the same `gh` stub.
 */
function selfTestAcceptedChildClose({ check, drive, parentWith, opId, OP }) {
  // 11i. #4173 residual — THE FALSE ALL-CLEAR, end to end and through the real
  //      close path. Same shape as 11c (the area leaves the grouping, the child
  //      is commented on and closed) with ONE difference: the mutant is still
  //      in `missed.txt`. It survives. It is simply accepted as equivalent, so
  //      it is subtracted from the observed set and its area vanishes from
  //      `groupByArea(all)` exactly as a cleaned-up area does. 11c pins the
  //      wording for the clean case; this pins that the same wording is NOT
  //      reused here, that the surviving id is named, and that the mutant did
  //      not sneak back into the tracked set on the way past.
  {
    const calls = drive({
      missedLines: [opId.replace('[rust] ', '')],
      body: parentWith([opId], new Map([[OP, 101]]), [opId]),
      state: 'OPEN',
    })
    const seq = calls.map((c) => c.sub).join(',')
    const closeBody = calls.find((c) => c.sub === 'edit' && c.target === '101')?.body ?? ''
    const parentEdit = calls.findLast((c) => c.sub === 'edit')
    check(
      // Same trailing parent close as 11e: an area whose every finding is
      // accepted-equivalent leaves nothing to act on, so the lane's parent
      // closes — and the child body says why it is not an all-clear.
      seq === 'view,edit,close,edit,close' &&
        closeBody.includes('not an all-clear') &&
        closeBody.includes('Accepted as equivalent (1)') &&
        closeBody.includes(opId),
      'an area that is clean ONLY because everything in it was accepted does not close with an all-clear (#4173)',
      `gh sequence was: ${seq || '(no gh calls at all)'} — body: ${closeBody.slice(0, 200)}`,
    )
    check(
      parseAcceptedSurvivors(parentEdit?.body ?? '').has(opId) &&
        !parseKnownSurvivors(parentEdit?.body ?? '').has(opId),
      'the accepted mutant stays accepted and out of the tracked set across the close (#4173)',
      parentEdit?.body ?? '(no parent edit)',
    )
  }
}

// #3788 fixtures. This script's failure mode is SILENCE — it reported only
// `Survived` for a year and nothing went red, because a report that omits a
// finding looks exactly like a report that had none. So the fixtures below are
// written to fail loudly if the omission comes back: they drive a real Stryker
// `mutation.json` through `parseFrontendSurvivors` and on through the rendered
// parent body, the child body and `main()` itself, and they assert both the
// PRESENCE of the no-coverage entry and its SEPARATION from the survivors — a
// fix that merged the two buckets would still "surface" it while telling every
// reader the wrong story about what is wrong with the code.
const STRYKER_FIXTURE = {
  files: {
    'src/lib/date-utils.ts': {
      // Two survivors on ONE line, differing only by column: the case the
      // pre-#3788 line-level id collapsed into a single entry (#3749).
      mutants: [
        {
          id: '1',
          mutatorName: 'ConditionalExpression',
          status: 'Survived',
          location: { start: { line: 86, column: 7 }, end: { line: 86, column: 40 } },
        },
        {
          id: '2',
          mutatorName: 'ConditionalExpression',
          status: 'Survived',
          location: { start: { line: 86, column: 24 }, end: { line: 86, column: 40 } },
        },
        // The finding the filer used to drop entirely: `getWeekRange` has no
        // test anywhere in `src`, so nothing executed this line at all.
        {
          id: '3',
          mutatorName: 'BlockStatement',
          status: 'NoCoverage',
          location: { start: { line: 120, column: 3 }, end: { line: 131, column: 2 } },
        },
        // Neither of these is a finding and neither may be reported.
        {
          id: '4',
          mutatorName: 'BooleanLiteral',
          status: 'Killed',
          location: { start: { line: 12, column: 1 }, end: { line: 12, column: 9 } },
        },
        {
          id: '5',
          mutatorName: 'ArrowFunction',
          status: 'Timeout',
          location: { start: { line: 13, column: 1 }, end: { line: 13, column: 9 } },
        },
      ],
    },
  },
}

const NC_ID = '[frontend] date-utils: src/lib/date-utils.ts:120:3 [BlockStatement] (NoCoverage)'
const SV_COL7 = '[frontend] date-utils: src/lib/date-utils.ts:86:7 [ConditionalExpression]'
const SV_COL24 = '[frontend] date-utils: src/lib/date-utils.ts:86:24 [ConditionalExpression]'
const LEGACY_SV = '[frontend] date-utils: src/lib/date-utils.ts:86 [ConditionalExpression]'

/** Writes `report` as `<tmp>/<module>/mutation.json` and returns the tmp root. */
function writeStrykerFixture(module_, report) {
  const root = mkdtempSync(join(tmpdir(), 'survivor-outcome-'))
  mkdirSync(join(root, module_), { recursive: true })
  writeFileSync(join(root, module_, 'mutation.json'), JSON.stringify(report))
  return root
}

/** Runs `main(argv)` capturing stdout, so a fixture can assert on what it said. */
function captureMain(argv) {
  const realLog = console.log
  const out = []
  console.log = (...parts) => out.push(parts.join(' '))
  try {
    main(argv)
    return { out: out.join('\n'), err: null }
  } catch (err) {
    return { out: out.join('\n'), err }
  } finally {
    console.log = realLog
  }
}

function selfTestNoCoverage({ ok, fail }) {
  // 12a. PARSING. Both actionable statuses come through, nothing else does,
  //      and the two same-line survivors stay two.
  {
    const ids = parseFrontendSurvivors(writeStrykerFixture('date-utils', STRYKER_FIXTURE))
    const set = new Set(ids)
    if (
      ids.length === 3 &&
      set.size === 3 &&
      set.has(NC_ID) &&
      set.has(SV_COL7) &&
      set.has(SV_COL24) &&
      !ids.some((i) => i.includes(':12:') || i.includes(':13:'))
    )
      ok('a NoCoverage mutant is parsed, distinctly, and Killed/Timeout are not (#3788)')
    else
      fail(
        'a NoCoverage mutant is parsed, distinctly, and Killed/Timeout are not (#3788)',
        JSON.stringify(ids),
      )

    // …and the outcome is recoverable from the id alone, which is what lets
    // the ONE marker block hold both without a second state block.
    const outcomes = ids.map(mutantOutcome).toSorted()
    if (JSON.stringify(outcomes) === JSON.stringify(['NoCoverage', 'Survived', 'Survived']))
      ok('an id carries its own outcome, so one state block holds both (#3788)')
    else
      fail('an id carries its own outcome, so one state block holds both (#3788)', outcomes.join())
  }

  // 12b. THE PARENT BODY. Present AND separated: the counts are split, the
  //      state block says which is which, and the no-coverage entry is not
  //      described as something a test ran over.
  {
    const all = [NC_ID, SV_COL7, SV_COL24].toSorted()
    const body = buildIssueBody({
      all,
      resolvedOnes: [],
      today: '2026-08-16',
      newOnes: all,
      runUrl: undefined,
    })
    const table = body.slice(body.indexOf('| Area |'), body.indexOf('### All currently-known'))
    if (
      body.includes(NC_ID) &&
      table.includes('| frontend: date-utils | 1 | 2 | 2026-08-16 |') &&
      body.includes('### All currently-known mutants (1 no coverage, 2 survived)') &&
      // #3245 still holds across the split: nothing is listed twice.
      all.every((id) => body.split(id).length - 1 === 1)
    )
      ok('the parent body surfaces the NoCoverage mutant with its own count (#3788)')
    else
      fail(
        'the parent body surfaces the NoCoverage mutant with its own count (#3788)',
        `present=${body.includes(NC_ID)} table=${table.trim()}`,
      )

    // 12c. THE CHILD BODY — the thing an agent actually works from. Two
    //      sections, no-coverage first, each id under the right heading.
    const child = buildChildBody({
      area: 'frontend: date-utils',
      members: all,
      parentNumber: 3142,
    })
    const ncAt = child.indexOf('### No coverage')
    const svAt = child.indexOf('### Survivors')
    if (
      ncAt !== -1 &&
      svAt > ncAt &&
      child.includes('### No coverage — no test executed this code (1)') &&
      child.includes('### Survivors — a test ran and did not fail (2)') &&
      child.indexOf(NC_ID) > ncAt &&
      child.indexOf(NC_ID) < svAt &&
      child.indexOf(SV_COL7) > svAt
    )
      ok('the child body renders no-coverage and survivors as separate sections (#3788)')
    else
      fail(
        'the child body renders no-coverage and survivors as separate sections (#3788)',
        `nc@${ncAt} sv@${svAt} ncId@${child.indexOf(NC_ID)}`,
      )
  }

  // 12e. RANKING. An area with untested code outranks a bigger survivor-only
  //      area — the ordering is the report's whole "look here first" claim, and
  //      before #3788 date-utils' 14 untested mutants ranked below 22
  //      provably-equivalent survivors (#3787).
  {
    const bigSurvivorArea = Array.from(
      { length: 5 },
      (_, i) => `[frontend] tree-utils: src/lib/tree-utils.ts:${i + 1}:1 [ConditionalExpression]`,
    )
    const groups = groupByArea([...bigSurvivorArea, NC_ID])
    if (groups[0].area === 'frontend: date-utils' && groups[0].noCoverage.length === 1)
      ok('an area with no-coverage outranks a larger survivor-only area (#3788)')
    else
      fail('an area with no-coverage outranks a larger survivor-only area (#3788)', groups[0].area)
  }
}

function selfTestNoCoverageEmptyAndMigration({ ok, fail }) {
  // 12f. THE EMPTY CASE. A lane that ran and found nothing must be a NO-OP,
  //      not a report. Filing/editing an issue that says "0 findings" would be
  //      a claim of coverage this script never verified — and it must stay
  //      distinguishable from the #3364 "no data at all" case, which is an
  //      error, not an all-clear.
  {
    const killedOnly = {
      files: {
        'src/lib/date-utils.ts': {
          mutants: [
            {
              id: '1',
              mutatorName: 'BooleanLiteral',
              status: 'Killed',
              location: { start: { line: 12, column: 1 } },
            },
          ],
        },
      },
    }
    const dir = writeStrykerFixture('date-utils', killedOnly)
    const found = parseFrontendSurvivors(dir)
    const reports = frontendReportCount(dir)
    const { out, err } = captureMain([
      '--dry-run',
      '--known-body-file',
      join(dir, 'no-such-body.md'),
      '--frontend-dir',
      dir,
      '--lane',
      'frontend',
      '--require-input',
    ])
    if (
      found.length === 0 &&
      reports === 1 &&
      err === null &&
      out.includes('no new mutation findings — no-op') &&
      !out.includes('would CREATE') &&
      !out.includes('would edit')
    )
      ok('a lane that ran and found nothing is a no-op, not an all-clear report (#3788)')
    else
      fail(
        'a lane that ran and found nothing is a no-op, not an all-clear report (#3788)',
        `found=${found.length} reports=${reports} err=${err?.message} out=${out}`,
      )

    // The complement, end-to-end: the mixed fixture DOES produce a report, and
    // the no-coverage line reaches the body `main()` would write. Without this
    // half, 12f above passes just as well on a filer that reports nothing ever.
    const mixedDir = writeStrykerFixture('date-utils', STRYKER_FIXTURE)
    const mixed = captureMain([
      '--dry-run',
      '--known-body-file',
      join(mixedDir, 'no-such-body.md'),
      '--frontend-dir',
      mixedDir,
      '--lane',
      'frontend',
      '--require-input',
    ])
    if (
      mixed.err === null &&
      mixed.out.includes('would CREATE') &&
      mixed.out.includes('1 no-coverage, 2 survived') &&
      mixed.out.includes(NC_ID)
    )
      ok('the same path DOES report when there is something to report (#3788)')
    else
      fail(
        'the same path DOES report when there is something to report (#3788)',
        `err=${mixed.err?.message} out=${mixed.out.slice(0, 600)}`,
      )
  }

  // 12g. THE MIGRATION. Frontend ids gained a column this release, so every
  //      tracked frontend survivor changes shape exactly once. Unmigrated, the
  //      deploy run would report the whole standing backlog as resolved AND as
  //      new and restamp every first-seen date to today — #3350's lie and
  //      #3245's double count in one. See `legacyFrontendId`.
  {
    const known = new Set([LEGACY_SV])
    const { newOnes, resolvedOnes, all } = diffSurvivors([SV_COL7, SV_COL24, NC_ID], known)
    // Both columnar survivors descend from the one tracked line: neither is
    // NEW (the mutants were always there, only under-reported) and the line
    // they replace is not RESOLVED. The NoCoverage entry is genuinely new —
    // nothing has ever tracked it — and deliberately does not inherit.
    if (
      resolvedOnes.length === 0 &&
      newOnes.length === 1 &&
      newOnes[0] === NC_ID &&
      all.length === 3
    )
      ok('the pre-#3788 id migrates instead of churning the whole backlog (#3788)')
    else
      fail(
        'the pre-#3788 id migrates instead of churning the whole backlog (#3788)',
        `new=${JSON.stringify(newOnes)} resolved=${JSON.stringify(resolvedOnes)}`,
      )

    // …and the age survives the reshape, which is the fact the migration
    // exists to protect.
    const body = buildIssueBody({
      all,
      resolvedOnes,
      firstSeen: new Map([[LEGACY_SV, '2026-01-15']]),
      today: '2026-08-16',
      newOnes,
    })
    const ages = parseFirstSeen(body)
    if (
      ages.get(SV_COL7) === '2026-01-15' &&
      ages.get(SV_COL24) === '2026-01-15' &&
      ages.get(NC_ID) === '2026-08-16'
    )
      ok('a migrated survivor keeps its first-seen date; the new finding gets today (#3788)')
    else
      fail(
        'a migrated survivor keeps its first-seen date; the new finding gets today (#3788)',
        `col7=${ages.get(SV_COL7)} col24=${ages.get(SV_COL24)} nc=${ages.get(NC_ID)}`,
      )

    // A NoCoverage id must never adopt a legacy survivor id, even at the same
    // line and mutator: inheriting would suppress it as "already known", which
    // is precisely the silence #3788 is about.
    if (legacyFrontendId(NC_ID) === undefined && legacyFrontendId(SV_COL7) === LEGACY_SV)
      ok('no-coverage ids do not inherit a survivor predecessor (#3788)')
    else
      fail(
        'no-coverage ids do not inherit a survivor predecessor (#3788)',
        `nc=${legacyFrontendId(NC_ID)} sv=${legacyFrontendId(SV_COL7)}`,
      )
  }
}

/**
 * #4032 — the 60k boundary, both arms.
 *
 * Both arms, because a clamp that always truncates and always labels passes any
 * single-arm test while destroying every report it touches. So: an over-cap
 * render is cut, labelled, and labelled with the RIGHT number; an under-cap
 * render comes back byte-for-byte with no label anywhere.
 *
 * The fixtures use real id shapes at real lengths (~90 chars) so the counts here
 * are the counts the weekly job will see — see MAX_BODY_CHARS for the measured
 * ceiling these were derived from.
 */
function selfTestBodyCap({ ok, fail }) {
  // Lines of VARYING length, which is what a real `missed.txt` looks like (the
  // description carries the mutated expression). Uniform-length fixtures make a
  // character slice land on a line boundary by luck, which hides the arm this
  // exists to test: the cut severing an id mid-string.
  const rust = (i) =>
    `[rust] src/reverse/batch.rs:${1000 + i}:${(i % 40) + 1}: replace is_skippable_non_reversible${'_x'.repeat(i % 9)} -> bool with true`
  const ncId = (i) =>
    `[frontend] date-utils: src/lib/date-utils.ts:${1000 + i}:${(i % 40) + 1} [BooleanLiteral]${NO_COVERAGE_SUFFIX}`
  const RUN = 'https://github.com/o/r/actions/runs/1234567890'

  // ── child body: the note counts PER SECTION, not the whole area, twice ──
  {
    const members = [
      ...Array.from({ length: 900 }, (_, i) => ncId(i)),
      ...Array.from({ length: 900 }, (_, i) => rust(i)),
    ].toSorted()
    const body = buildChildBody({
      area: 'frontend: date-utils',
      members,
      parentNumber: 3142,
      runUrl: RUN,
    })
    // Deliberately wording-agnostic: match any "…(N …)" note and add the Ns up.
    // Keying on the new phrasing would make this test pass the old code for the
    // wrong reason (no match, so nothing claimed) instead of catching what the
    // old code actually did — print the whole area's 1800 under BOTH sections.
    const notes = [...body.matchAll(/…\((\d+)\b[^)]*\)/g)]
    const shown = members.filter((id) => body.includes(id)).length
    const claimed = notes.reduce((n, m) => n + Number(m[1]), 0)
    const problems = []
    if (body.length > MAX_BODY_CHARS) problems.push(`len=${body.length}`)
    if (notes.length !== 2) problems.push(`${notes.length} note(s), expected one per section`)
    if (claimed !== members.length - shown)
      problems.push(
        `notes claim ${claimed} omitted (${notes.map((m) => m[1]).join(' + ')}), actually ${members.length - shown} of ${members.length}`,
      )
    if (problems.length === 0)
      ok('child-body truncation notes count per section, not the whole area twice (#4032)')
    else
      fail(
        'child-body truncation notes count per section, not the whole area twice (#4032)',
        problems.join('; '),
      )
  }

  // ── the PARENT stays fail-closed: it throws, it does not truncate state ──
  {
    const all = Array.from({ length: 900 }, (_, i) => rust(i)).toSorted()
    let threw = null
    let body = null
    try {
      body = buildIssueBody({ all, resolvedOnes: [], runUrl: RUN, today: '2026-08-17' })
    } catch (err) {
      threw = err
    }
    if (threw && /\d+ over the 60000-char cap/.test(threw.message))
      ok('over-cap PARENT body throws with the overshoot rather than truncating state (#4032)')
    else
      fail(
        'over-cap PARENT body throws with the overshoot rather than truncating state (#4032)',
        threw ? threw.message : `no throw; body=${body.length} chars`,
      )
  }
}

/**
 * #4173 — the accepted-equivalent block, end to end.
 *
 * The loop this closes: a mutant proven UNKILLABLE could only be recorded by
 * hand-removing its line from the survivor block, which is byte-identical to
 * the mutant having been killed, so the next run re-observed it, re-filed it
 * as new, and re-opened the child issue that had just been closed. Three of
 * #3142's areas went round that loop twice.
 *
 * Four properties here, and the second is the load-bearing one — it is the
 * whole reason this mechanism is allowed where #3593's `// Stryker disable`
 * directives were not. The block's own parsing invariants (the optional date
 * prefix, block isolation) are in `selfTestAcceptedBlockShape` below.
 *
 * Driven through `main()` under `--dry-run --known-body-file` rather than
 * against `buildIssueBody` alone, because the subtraction deliberately lives
 * at the CALL SITE (`diffSurvivors` stays a pure two-set function): a
 * unit-level fixture would pass just as well on a filer that never applies it.
 */
function selfTestAcceptedGaps({ ok, fail, survivor }) {
  const AREA = 'frontend: date-utils'
  // A mutant the Stryker fixture reports as Killed, so it is NOT in the
  // observed set: this is what a stale entry looks like after the line it
  // named moved or the mutant became killable.
  const STALE = '[frontend] date-utils: src/lib/date-utils.ts:12:1 [BooleanLiteral]'
  const root = writeStrykerFixture('date-utils', STRYKER_FIXTURE)
  const bodyFile = (name, body) => {
    const path = join(root, name)
    writeFileSync(path, body)
    return path
  }
  const runDry = (path) =>
    captureMain([
      '--dry-run',
      '--children',
      '--known-body-file',
      path,
      '--frontend-dir',
      root,
      '--lane',
      'frontend',
      '--require-input',
    ])

  // 14a. SUPPRESSED. The accepted mutant is observed by the lane this run;
  //      with the other two findings unchanged the run has nothing to say. Not
  //      new, not re-tracked, no child touched (so nothing re-opened), and the
  //      suppression is reported for what it is.
  //
  //      NOT the `known`-side subtraction, despite what this comment used to
  //      claim: SV_COL7 is accepted here but is NOT in this fixture's tracked
  //      block (`all` is NC_ID + SV_COL24), so the `known` filter has nothing
  //      to remove and `resolvedOnes` is 0 with or without it. The
  //      "not announced as RESOLVED" check below is a genuine no-op in this
  //      fixture. 14b is the one that earns that credit — see the
  //      new/resolved-count assertion there.
  {
    const path = bodyFile(
      'accepted-suppressed.md',
      buildIssueBody({
        all: [NC_ID, SV_COL24].toSorted(),
        resolvedOnes: [],
        today: '2026-08-01',
        firstSeen: new Map([
          [NC_ID, '2026-08-01'],
          [SV_COL24, '2026-08-01'],
        ]),
        childLinks: new Map([[AREA, 4242]]),
        accepted: [SV_COL7],
        acceptedOn: new Map([[SV_COL7, '2026-08-19']]),
      }),
    )
    const { out, err } = runDry(path)
    const problems = []
    if (err) problems.push(`threw: ${err.message}`)
    if (!out.includes('no new mutation findings — no-op')) problems.push('not a no-op')
    if (out.includes('notify')) problems.push('a child was notified/re-opened')
    if (out.includes('no longer present')) problems.push('announced as resolved')
    if (!out.includes('1 suppressed of 1 recorded')) problems.push('suppression not reported')
    if (problems.length === 0)
      ok('an accepted mutant is not new, not re-tracked, not re-opened and not "resolved" (#4173)')
    else
      fail(
        'an accepted mutant is not new, not re-tracked, not re-opened and not "resolved" (#4173)',
        `${problems.join('; ')} — out=${out.slice(0, 800)}`,
      )
  }

  // 14b. THE SIBLING ON THE SAME LINE STILL REPORTS. This test exists because
  //      it is the entire difference between this block and the
  //      `// Stryker disable next-line <Mutator>` directives #3593 rejected:
  //      a directive suppresses every mutant on the line, including ones that
  //      are genuinely killable, so accepting one gap silently buys silence on
  //      its neighbours. An accepted entry is keyed on the full mutant id —
  //      (file, line, column, mutator), which is exactly what #3788 added the
  //      column for — so it has no blast radius past the mutant it names.
  //      SV_COL7 and SV_COL24 are the same file, the same line 86 and the same
  //      ConditionalExpression mutator, differing ONLY in column: accepting
  //      the first must leave the second reporting exactly as if nothing had
  //      been accepted. If this assertion ever has to be relaxed, the
  //      mechanism has become the one that was rejected.
  //
  //      The same fixture pins re-anchoring (the stale entry is dropped) and
  //      the block's round trip (the live entry survives the rewrite with its
  //      date), because both are observable in the body this run would write.
  {
    const path = bodyFile(
      'accepted-sibling.md',
      buildIssueBody({
        all: [SV_COL7],
        resolvedOnes: [],
        today: '2026-08-01',
        firstSeen: new Map([[SV_COL7, '2026-08-01']]),
        childLinks: new Map([[AREA, 4242]]),
        accepted: [SV_COL7, STALE].toSorted(),
        acceptedOn: new Map([[SV_COL7, '2026-08-19']]),
      }),
    )
    const { out, err } = runDry(path)
    const bodyAt = out.indexOf('[dry-run] --- issue body ---')
    // The body block is the LAST thing the dry run prints now that there is
    // no comment section after it — the CI job never comments.
    const body = out.slice(bodyAt)
    // "Announced as new" used to mean "named in the per-run comment". The CI
    // job does not comment, so the claim is carried by the tracked set plus
    // the exact new/resolved counts asserted at the bottom of this block —
    // 3 observed, 1 accepted, so exactly 2 new and 0 resolved. That pair is
    // strictly stronger than the old per-id comment check: it fails if the
    // accepted id leaks into EITHER side.
    const tracked = parseKnownSurvivors(body)
    const acceptedBack = parseAcceptedSurvivors(body)
    const problems = []
    if (err) problems.push(`threw: ${err.message}`)
    if (!tracked.has(SV_COL24)) problems.push('the same-line sibling was suppressed too')
    if (tracked.has(SV_COL7)) problems.push('the accepted mutant entered the tracked set')
    // THE `known` SIDE OF THE SUBTRACTION, and this is the fixture that
    // exercises it (14a cannot: its accepted id is not in its tracked block, so
    // the filter there is a no-op). Here SV_COL7 IS tracked and IS accepted, so
    // dropping `.filter(id => !acceptedSet.has(id))` from `known` leaves it in
    // the tracked set while it is absent from `reported` — and `diffSurvivors`
    // announces it as RESOLVED, i.e. claims a test now kills a mutant triage
    // has just certified as unkillable. `resolved: 0` is that claim's tripwire.
    if (!out.includes('new findings: 2, resolved: 0'))
      problems.push('wrong new/resolved counts (an accepted id must be neither)')
    if (problems.length === 0)
      ok('a sibling mutant on the SAME LINE still reports — an entry suppresses one id (#4173)')
    else
      fail(
        'a sibling mutant on the SAME LINE still reports — an entry suppresses one id (#4173)',
        `${problems.join('; ')} — out=${out.slice(0, 900)}`,
      )

    // Re-anchoring: the entry matching no observed mutant is gone from the
    // rewritten block, so it can never permanently suppress the id it names;
    // the live entry survives, with the date it was accepted on.
    const staleProblems = []
    if (acceptedBack.has(STALE)) staleProblems.push('the stale entry survived the rewrite')
    if (!acceptedBack.has(SV_COL7)) staleProblems.push('the live entry was dropped')
    if (parseAcceptedOn(body).get(SV_COL7) !== '2026-08-19')
      staleProblems.push(`lost its accepted-on date (${parseAcceptedOn(body).get(SV_COL7)})`)
    // The wording matters, not just the word: this run DOES rewrite the body,
    // so a drop is what happens. `selfTestAcceptedReanchorTrace` pins the other
    // arm, where the same stale entry is not dropped at all.
    if (!out.includes('re-anchoring (#4173): would drop 1 accepted entry'))
      staleProblems.push('the drop was not reported as a drop')
    if (staleProblems.length === 0)
      ok('a stale accepted entry is dropped on rewrite and the live one is kept, dated (#4173)')
    else
      fail(
        'a stale accepted entry is dropped on rewrite and the live one is kept, dated (#4173)',
        staleProblems.join('; '),
      )
  }

  // 14d. THE CLAMP. The accepted block is STATE: the same #3257 fixture that
  //      proves the survivor block survives a clamped body must prove this one
  //      does. Dropping it would re-serve every accepted mutant as "new" the
  //      following week — the loop this closes — and would do it silently.
  {
    const all = Array.from({ length: 200 }, (_, i) => survivor(i))
    const resolvedOnes = Array.from({ length: 600 }, (_, i) => survivor(10_000 + i))
    const body = buildIssueBody({
      all,
      resolvedOnes,
      runUrl: 'https://example/run',
      accepted: [SV_COL7],
      acceptedOn: new Map([[SV_COL7, '2026-08-19']]),
    })
    const acceptedBack = parseAcceptedSurvivors(body)
    if (
      body.length <= MAX_BODY_CHARS &&
      !body.includes(resolvedOnes[0]) &&
      acceptedBack.size === 1 &&
      acceptedBack.has(SV_COL7) &&
      parseAcceptedOn(body).get(SV_COL7) === '2026-08-19' &&
      parseKnownSurvivors(body).size === 200
    )
      ok('the accepted block survives the body-size clamp, like the state block (#4173)')
    else
      fail(
        'the accepted block survives the body-size clamp, like the state block (#4173)',
        `len=${body.length} accepted=${acceptedBack.size} tracked=${parseKnownSurvivors(body).size}`,
      )
  }
}

/**
 * #4173, the pure half: what the accepted block itself has to guarantee, with
 * no lane fixture in the way. Split from `selfTestAcceptedGaps` above only to
 * keep each function under the repo's cyclomatic-complexity budget, the same
 * split `selfTestNoCoverageEmptyAndMigration` makes.
 */
function selfTestAcceptedBlockShape({ ok, fail }) {
  // 14c. The date prefix is bookkeeping, never part of the id. A triager who
  //      pastes an id without a date must get the same suppression as one who
  //      dates it — otherwise the block silently suppresses nothing and the
  //      mutant comes back next week with no sign of why.
  {
    const block = (line) =>
      `${ACCEPTED_MARKER_START}\n\`\`\`\n${line}\n\`\`\`\n${ACCEPTED_MARKER_END}`
    const dated = parseAcceptedSurvivors(block(`2026-08-19\t${SV_COL7}`))
    const undated = parseAcceptedSurvivors(block(SV_COL7))
    if (
      dated.size === 1 &&
      undated.size === 1 &&
      dated.has(SV_COL7) &&
      undated.has(SV_COL7) &&
      parseAcceptedOn(block(`2026-08-19\t${SV_COL7}`)).get(SV_COL7) === '2026-08-19' &&
      !parseAcceptedOn(block(SV_COL7)).has(SV_COL7)
    )
      ok('an accepted entry parses to the same id with or without its date prefix (#4173)')
    else
      fail(
        'an accepted entry parses to the same id with or without its date prefix (#4173)',
        `dated=${[...dated]} undated=${[...undated]}`,
      )

    // …and the accepted block is invisible to the survivor reader, or every
    // accepted id would come straight back as a tracked survivor.
    const mixed = buildIssueBody({
      all: [SV_COL24],
      resolvedOnes: [],
      accepted: [SV_COL7],
      acceptedOn: new Map(),
    })
    if (!parseKnownSurvivors(mixed).has(SV_COL7) && parseKnownSurvivors(mixed).size === 1)
      ok('the accepted block does not leak into the tracked survivor set (#4173)')
    else
      fail(
        'the accepted block does not leak into the tracked survivor set (#4173)',
        [...parseKnownSurvivors(mixed)].join(' | '),
      )
  }

  // 14e. #4173 residual — THE INSTRUCTIONS EXIST ON THE PAGE THEY POINT AT.
  //      The head tells a triager to copy the id into "the accepted-equivalent
  //      block at the bottom of this body", and the how-to (the line shape, the
  //      marker comments, the one-id-per-entry rule) lives inside that block.
  //      Rendered only when non-empty, NEITHER existed on a tracking issue with
  //      nothing accepted yet — which is every issue until the first triager
  //      records one, i.e. exactly the reader with no way to know the syntax.
  //      An empty block is furniture; furniture that makes the instruction true
  //      is worth its 1085 characters (measured against the same builder, not
  //      estimated — it moves the #3257 ceiling from 597 findings to 586).
  {
    const empty = buildIssueBody({ all: [SV_COL24], resolvedOnes: [], accepted: [] })
    const problems = []
    if (!empty.includes(ACCEPTED_MARKER_START) || !empty.includes(ACCEPTED_MARKER_END))
      problems.push('no marker pair to paste into')
    if (!empty.includes('accepted-equivalent** block at the bottom of this body'))
      problems.push('the head stopped pointing at the block')
    if (!empty.includes('the empty block below is the template'))
      problems.push('no "this is the template" line')
    if (!empty.includes('`<accepted-on date><TAB><mutant>` shape'))
      problems.push('the how-to preamble (the line shape) is missing')
    // …and the furniture is furniture: an empty block must parse to an empty
    // set, or every issue would boot with a phantom accepted entry.
    if (parseAcceptedSurvivors(empty).size > 0) problems.push('the empty block minted an entry')
    if (parseKnownSurvivors(empty).size !== 1) problems.push('it disturbed the tracked set')
    if (problems.length === 0)
      ok('a body with nothing accepted still carries the block a triager is told to use (#4173)')
    else
      fail(
        'a body with nothing accepted still carries the block a triager is told to use (#4173)',
        problems.join('; '),
      )
  }
}

/**
 * #4173 residual — re-anchoring, which is a CLAIM the filer makes about its own
 * state, and both halves of the claim were wrong.
 *
 *   1. It was announced from `applyAcceptedGaps`, which runs BEFORE the no-op
 *      check. A stale entry is dropped by being left out of a body rewrite, so
 *      on a quiet week — the common case — nothing was written, the entry
 *      stayed in the issue, and the log said it had been dropped anyway. The
 *      next run re-evaluated the same entry and said it again.
 *   2. When it did happen, the only record was that log line, and a workflow
 *      log expires. A drop retires a triage verdict a human spent a session
 *      reaching; if every entry went stale at once (a file rename does that),
 *      the whole block left the issue with nothing on the page saying why.
 *
 * Driven through `main()` because both halves are decisions `main` makes:
 * whether the body is rewritten at all, and what goes into it when it is.
 */
function selfTestAcceptedReanchorTrace({ ok, fail }) {
  const AREA = 'frontend: date-utils'
  const STALE = '[frontend] date-utils: src/lib/date-utils.ts:12:1 [BooleanLiteral]'
  const root = writeStrykerFixture('date-utils', STRYKER_FIXTURE)
  const HEAD = '[dry-run] --- issue body ---\n'
  // Runs to the end: the comment section that used to terminate the body
  // block is gone, because the CI job never comments.
  const bodyOf = (out) => out.slice(out.indexOf(HEAD) + HEAD.length)
  const bodyFile = (name, body) => {
    const path = join(root, name)
    writeFileSync(path, body)
    return path
  }
  const runDry = (dir, path) =>
    captureMain([
      '--dry-run',
      '--children',
      '--known-body-file',
      path,
      '--frontend-dir',
      dir,
      '--lane',
      'frontend',
      '--require-input',
    ])

  // 14f. THE QUIET WEEK. Everything observed is already tracked and nothing is
  //      accepted-and-live, so the run writes nothing — and therefore drops
  //      nothing. The entry is still in the issue on Tuesday. Saying "dropped"
  //      here is the filer misreporting its own state, which is the one thing
  //      this script exists to stop other reports doing.
  {
    const path = bodyFile(
      'quiet-with-stale.md',
      buildIssueBody({
        all: [NC_ID, SV_COL7, SV_COL24].toSorted(),
        resolvedOnes: [],
        today: '2026-08-01',
        firstSeen: new Map([
          [NC_ID, '2026-08-01'],
          [SV_COL7, '2026-08-01'],
          [SV_COL24, '2026-08-01'],
        ]),
        childLinks: new Map([[AREA, 4242]]),
        accepted: [STALE],
        acceptedOn: new Map([[STALE, '2026-08-19']]),
      }),
    )
    const { out, err } = runDry(root, path)
    const problems = []
    if (err) problems.push(`threw: ${err.message}`)
    if (!out.includes('no new mutation findings — no-op')) problems.push('not a no-op')
    if (!out.includes('re-anchoring (#4173): LEFT IN PLACE'))
      problems.push('the stale entry was not reported as left in place')
    if (/re-anchoring \(#4173\): (would drop|dropping|dropped)/.test(out))
      problems.push('a run that wrote nothing claimed it dropped an entry')
    if (problems.length === 0)
      ok('a run that rewrites nothing does not claim it dropped a stale entry (#4173)')
    else
      fail(
        'a run that rewrites nothing does not claim it dropped a stale entry (#4173)',
        `${problems.join('; ')} — out=${out.slice(0, 900)}`,
      )
  }

  // 14g. THE DURABLE TRACE, and that it survives the NEXT rewrite. A run that
  //      does drop an entry records it in the body — outside the markers, so a
  //      historical id can never come back as a live entry — and the run after
  //      it carries the note forward instead of quietly losing it with the
  //      workflow log.
  {
    const path = bodyFile(
      'drops-one.md',
      buildIssueBody({
        all: [NC_ID, SV_COL7].toSorted(),
        resolvedOnes: [],
        today: '2026-08-01',
        firstSeen: new Map([
          [NC_ID, '2026-08-01'],
          [SV_COL7, '2026-08-01'],
        ]),
        childLinks: new Map([[AREA, 4242]]),
        accepted: [STALE],
        acceptedOn: new Map([[STALE, '2026-08-19']]),
      }),
    )
    const first = runDry(root, path)
    const written = bodyOf(first.out)
    const notes = parseReanchorNotes(written)
    const problems = []
    if (first.err) problems.push(`threw: ${first.err.message}`)
    if (notes.length !== 1) problems.push(`${notes.length} note(s) in the body, expected 1`)
    else if (!notes[0].includes(STALE)) problems.push('the note does not name the dropped entry')
    // Not just "the id string is absent": ANY live accepted entry that the
    // note text contains is the history parsing back as state. Checking only
    // `has(STALE)` passed even with the note rendered INSIDE the markers, where
    // the whole note line became a live entry.
    const leaked = [...parseAcceptedSurvivors(written)].filter((id) =>
      notes.some((n) => n.includes(id)),
    )
    if (leaked.length > 0)
      problems.push(`the note leaked back as live entries: ${leaked.join(' | ')}`)

    // The run after it: a genuinely new mutant, so the body IS rewritten, and
    // nothing is stale this time. The note must still be there — a trace that
    // only survives until the next Monday is the expiring log again.
    const grown = structuredClone(STRYKER_FIXTURE)
    grown.files['src/lib/date-utils.ts'].mutants.push({
      id: '6',
      mutatorName: 'ArithmeticOperator',
      status: 'Survived',
      location: { start: { line: 200, column: 5 }, end: { line: 200, column: 9 } },
    })
    const second = runDry(
      writeStrykerFixture('date-utils', grown),
      bodyFile('carried-forward.md', written),
    )
    const carried = parseReanchorNotes(bodyOf(second.out))
    if (second.err) problems.push(`second run threw: ${second.err.message}`)
    if (!second.out.includes('new findings: 1')) problems.push('the second run did not rewrite')
    if (carried.length !== 1 || !carried[0].includes(STALE))
      problems.push(`the note did not survive the next rewrite (${carried.length} note(s))`)
    if (problems.length === 0)
      ok('a dropped accepted entry leaves a note in the body that outlives the run log (#4173)')
    else
      fail(
        'a dropped accepted entry leaves a note in the body that outlives the run log (#4173)',
        problems.join('; '),
      )
  }

  selfTestReanchorNoteCannotParseBack({ ok, fail })
}

/**
 * #4173 residual — THE LOAD-BEARING CLAIM of the durable note, pinned on its
 * own because the note is the one place this filer writes hand-edited body text
 * back into the body, un-fenced, ABOVE the markers.
 *
 * "Above the markers, therefore outside the block" is not a proof. Both markers
 * are HTML comments located by a bare `indexOf` over the WHOLE body, so an id
 * carrying a marker delimiter does not sit outside the block — it MOVES it. The
 * accepted fence is hand-edited free text, so a marker-shaped entry is one bad
 * paste away (re-seeding "the whole block, markers included" INTO the fence).
 *
 * Both directions, both reproducible before `noteSafeId`, and the second is the
 * worse one — it is not a wrong line in a report, it is the silent destruction
 * of every recorded triage verdict on an issue nobody re-reads:
 *
 *   begin -> the FIRST start marker lands inside the note, so the block read
 *            next run starts mid-prose: the note's own tail and the real marker
 *            line come back as LIVE accepted entries.
 *   end   -> the FIRST end marker precedes the start marker, `markerBlockLines`
 *            returns nothing, the block reads EMPTY for ever (the poisoned note
 *            is carried forward with no expiry), every accepted mutant
 *            re-reports as new, and the next rewrite renders an empty block.
 *
 * One assertion covers both, and it needs both halves: the real verdict must
 * still be readable (the `end` failure zeroes it) AND nothing else may appear
 * (the `begin` failure mints entries). Assert only "no bogus entry" and the
 * erasure passes; assert only "the verdict survives" and the injection does.
 *
 * And it needs both PATHS. A note reaches a body two ways — this run wrote it
 * (`appendReanchorNote`) or this run read it out of the last body
 * (`parseReanchorNotes`) — and only the first is the filer's own text. Driving
 * the poison through `appendReanchorNote` alone proves the claim exactly where
 * it was never in doubt, so the arms below plant it in the INPUT BODY as well,
 * in the shape a maintainer annotating the history by hand would leave. That
 * one is the reachable failure and the non-convergent one: the note is copied
 * forward unchanged every week, so `end` erases the accepted block for ever
 * rather than for a run.
 */
function selfTestReanchorNoteCannotParseBack({ ok, fail }) {
  // 14h. A NOTE CAN NEVER PARSE BACK AS A LIVE ACCEPTED ENTRY.
  const LIVE = SV_COL7
  const problems = []
  for (const [dir, poison] of [
    ['begin', `${ACCEPTED_MARKER_START} smuggled`],
    ['end', `smuggled ${ACCEPTED_MARKER_END}`],
  ]) {
    const notes = appendReanchorNote([], [poison], '2026-08-08')
    const body = buildIssueBody({
      all: [LIVE],
      resolvedOnes: [],
      today: '2026-08-08',
      accepted: [LIVE],
      acceptedOn: new Map([[LIVE, '2026-07-01']]),
      reanchored: notes,
    })
    const back = parseAcceptedSurvivors(body)
    if (!back.has(LIVE)) problems.push(`${dir}: the recorded verdict became unreadable`)
    if (back.size !== 1)
      problems.push(`${dir}: minted ${back.size - 1} phantom entr(y|ies): ${[...back].join(' | ')}`)
    // And the note is still THERE — "fixing" it by dropping the history would
    // pass the two checks above while losing the record they exist to protect.
    if (parseReanchorNotes(body).length !== 1) problems.push(`${dir}: the note itself was lost`)
  }
  if (problems.length === 0)
    ok('a re-anchoring note cannot move the accepted markers or parse back as an entry (#4173)')
  else
    fail(
      'a re-anchoring note cannot move the accepted markers or parse back as an entry (#4173)',
      problems.join('; '),
    )

  // 14h (read path). THE SAME CLAIM, ON THE PATH THAT WAS ACTUALLY UNGUARDED.
  //      The two arms above hand the poison to `appendReanchorNote`, so they
  //      only ever exercise ids THIS run dropped — text the filer authored,
  //      which is the half `noteSafeId` already covered. A note reaches the
  //      next body the other way too: it is READ out of the previous body and
  //      spliced back in. That path needs no stale mutant at all — the history
  //      renders as ordinary prose in an inviting `- **Re-anchored …** — …`
  //      shape, so a maintainer annotating it, or a paste, is enough to put a
  //      raw marker into a line the next run copies forward verbatim.
  //
  //      The composition is production's, from the one place notes are carried:
  //      `appendReanchorNote(parseReanchorNotes(existingIssue.body), stale,
  //      today)`. `stale` is EMPTY on purpose — the quiet path, where the write
  //      path contributes nothing and everything rendered is what was read.
  //
  //      The third check is convergence, and it is the one that separates this
  //      from a run-of-the-mill wrong line: unsanitised, the poisoned note is
  //      re-rendered unchanged every week, so `end` does not erase the block for
  //      a run, it erases it for ever. A second round-trip must therefore leave
  //      the body no worse than the first, and must leave the note itself still
  //      on the page — deleting the history would satisfy the other checks
  //      while losing exactly what the mechanism exists to keep.
  {
    const readProblems = []
    for (const [dir, poison] of [
      ['begin', `${ACCEPTED_MARKER_START} smuggled`],
      ['end', `smuggled ${ACCEPTED_MARKER_END}`],
    ]) {
      const render = (reanchored) =>
        buildIssueBody({
          all: [LIVE],
          resolvedOnes: [],
          today: '2026-08-15',
          accepted: [LIVE],
          acceptedOn: new Map([[LIVE, '2026-07-01']]),
          reanchored,
        })
      // Not `appendReanchorNote`'s output: a hand-written annotation, raw, in
      // the body the next run will read. This is the input the filer does not
      // control and never sanitised.
      const handAnnotated = render([
        `${REANCHOR_NOTE_PREFIX}2026-08-08** — 1 accepted entry dropped, matching no observed mutant: \`${poison}\``,
      ])
      let body = handAnnotated
      for (const round of ['first', 'second']) {
        body = render(appendReanchorNote(parseReanchorNotes(body), [], '2026-08-15'))
        const back = parseAcceptedSurvivors(body)
        if (!back.has(LIVE))
          readProblems.push(`${dir}/${round}: the recorded verdict became unreadable`)
        // `> 1`, not `!== 1`: the empty case is already reported above by the
        // verdict check, and subtracting from a zero-size set printed
        // "minted -1 phantom entries" next to it.
        if (back.size > 1)
          readProblems.push(
            `${dir}/${round}: minted ${back.size - 1} phantom entr(y|ies): ${[...back].join(' | ')}`,
          )
        if (parseReanchorNotes(body).length !== 1)
          readProblems.push(`${dir}/${round}: the note itself was lost`)
      }
    }
    if (readProblems.length === 0)
      ok('a note READ BACK from a hand-edited body cannot move the accepted markers either (#4173)')
    else
      fail(
        'a note READ BACK from a hand-edited body cannot move the accepted markers either (#4173)',
        readProblems.join('; '),
      )
  }

  // 14h (scoping). A NOTE IS PROSE ABOVE THE MARKERS, NOT ANY LINE THAT LOOKS
  //      LIKE ONE. `parseReanchorNotes` used to scan the whole body, fences
  //      included, so a line pasted INTO the accepted fence in the note shape —
  //      the same bad paste that motivates the arms above, re-seeding a whole
  //      rendered section into the block — was read twice: once as an accepted
  //      id, which is what it now is, and once as a note, which duplicated it
  //      into the history above the markers where it then never expired.
  //
  //      Pinned on the rendered body rather than on the parser alone, because
  //      the duplication is the thing that matters: the line must appear
  //      EXACTLY once in the body the next run would write.
  {
    const scopeProblems = []
    const pasted = `${REANCHOR_NOTE_PREFIX}2026-05-01** — 1 accepted entry dropped: \`m9\``
    const seeded = buildIssueBody({
      all: [LIVE],
      resolvedOnes: [],
      today: '2026-08-15',
      accepted: [LIVE, pasted],
      acceptedOn: new Map([[LIVE, '2026-07-01']]),
    })
    const notes = parseReanchorNotes(seeded)
    if (notes.length > 0)
      scopeProblems.push(`a line inside the fence was read as ${notes.length} note(s)`)
    const rewritten = buildIssueBody({
      all: [LIVE],
      resolvedOnes: [],
      today: '2026-08-15',
      accepted: [LIVE, pasted],
      acceptedOn: new Map([[LIVE, '2026-07-01']]),
      reanchored: appendReanchorNote(notes, [], '2026-08-15'),
    })
    const copies = rewritten.split(pasted).length - 1
    if (copies !== 1) scopeProblems.push(`the pasted line appears ${copies} time(s), expected 1`)
    // The other direction of the same rule, so the scoping cannot be "read
    // nothing": a genuine note, above the markers, is still read.
    const genuine = buildIssueBody({
      all: [LIVE],
      resolvedOnes: [],
      today: '2026-08-15',
      accepted: [LIVE],
      acceptedOn: new Map([[LIVE, '2026-07-01']]),
      reanchored: appendReanchorNote([], ['m9'], '2026-05-01'),
    })
    if (parseReanchorNotes(genuine).length !== 1)
      scopeProblems.push('a genuine note above the markers stopped being read')
    if (scopeProblems.length === 0)
      ok('only prose outside the marker blocks counts as a re-anchoring note (#4173)')
    else
      fail(
        'only prose outside the marker blocks counts as a re-anchoring note (#4173)',
        scopeProblems.join('; '),
      )
  }

  // 14i. BOUNDED GROWTH, on BOTH paths. The history is capped so it cannot eat
  //      the body budget the state block needs, and the cap has to hold on READ
  //      as well as on append: capping only where a note is added leaves a body
  //      that already carries more — a paste, a hand-edit, an older revision of
  //      this script — carrying them forward for ever, which is the unbounded
  //      growth the cap exists to prevent, just entered by a different door.
  //
  //      And it must keep the NEWEST. A cap that keeps the oldest five is the
  //      same size and answers the opposite question: the reader asking why a
  //      mutant is back needs the recent drops, not the first five ever made.
  {
    const many = Array.from(
      { length: MAX_REANCHOR_NOTES + 2 },
      (_, i) => `${REANCHOR_NOTE_PREFIX}2026-0${i + 1}-01** — 1 accepted entry dropped: \`m${i}\``,
    )
    const capProblems = []
    const newest = (notes) => notes.at(-1)?.includes(`\`m${many.length - 1}\``)
    const onRead = parseReanchorNotes(many.join('\n'))
    if (onRead.length !== MAX_REANCHOR_NOTES)
      capProblems.push(`read kept ${onRead.length}, expected ${MAX_REANCHOR_NOTES}`)
    if (!newest(onRead)) capProblems.push('read kept the oldest notes, not the newest')
    // The quiet path: nothing dropped this run, so nothing is appended — and
    // that is exactly the path where an over-full history used to sail through.
    const carried = appendReanchorNote(many, [], '2026-09-01')
    if (carried.length !== MAX_REANCHOR_NOTES)
      capProblems.push(`carry-forward kept ${carried.length}, expected ${MAX_REANCHOR_NOTES}`)
    if (!newest(carried)) capProblems.push('carry-forward kept the oldest notes, not the newest')
    if (capProblems.length === 0)
      ok(`the re-anchoring history is capped at ${MAX_REANCHOR_NOTES}, newest kept (#4173)`)
    else
      fail(
        `the re-anchoring history is capped at ${MAX_REANCHOR_NOTES}, newest kept (#4173)`,
        capProblems.join('; '),
      )
  }
}

/**
 * #3667 — `DEFAULT_MAX_CHILDREN` must track the REAL area universe, not a
 * pinned copy of it (43 = 21 + 22 was exactly right on 2026-08-09 and
 * silently wrong from 2026-08-16 on, once `agaric-store/src/op_log/high_water.rs`
 * landed in #4016 and nobody had reason to revisit this constant).
 *
 * This recomputes both halves independently of `computeDefaultMaxChildren`
 * — reading `stryker.modules.mjs` and `mutants.toml` itself rather than
 * calling that function again — so a bug that makes the derivation drop or
 * miscount one half is actually caught here instead of the test and the
 * code agreeing on the same wrong number. The existing child-planning
 * fixtures above all pass `maxChildren` explicitly and so never exercised
 * this default at all, which is how it drifted unnoticed for two weeks
 * (2026-08-16 → 2026-08-30, 14 days).
 *
 * That independence has a KNOWN LIMIT, and the non-zero checks below exist
 * because of it. The two sides duplicate the enumeration, but they share
 * `MUTANTS_TOML_PATH`, the workspace root, and the `tomlStringArray` /
 * `globMatches` / `globSync` semantics — so a change to any of THOSE moves
 * both sides together and cannot be caught by comparing them. Measured:
 * dropping the `exclude_globs` filter from `countRustAreaFiles` alone
 * reddens this (44 vs 54), but repointing the workspace root at the
 * repo root left it green at `frontend 21 + rust 0 = 21`. The half-is-zero
 * assertions are what close that class, since every shared-surface break
 * found so far collapses a half to zero rather than perturbing it.
 */
async function selfTestDefaultMaxChildren({ ok, fail }) {
  // #3373 copies this file ALONE to a detached path and runs `--self-test`
  // there, asserting exit 0. There is no repo to measure against in that
  // run, so the derivation legitimately took the fallback; asserting the
  // derived number would redden a healthy guard. Skip explicitly (and
  // visibly) rather than failing or silently passing.
  //
  // The skip is keyed on the SIBLING SCRIPT, not on the two files being
  // measured. Keying it on `mutants.toml` would turn "the config was moved
  // or deleted" — the #3386 failure mode this whole lane exists to catch —
  // into a silent skip. A detached single-file copy has no sibling; a real
  // checkout that lost its config still runs the assertion and reddens.
  if (!existsSync(resolve(import.meta.dirname, 'check-mutants-scope.mjs'))) {
    ok(
      `DEFAULT_MAX_CHILDREN derivation not checked — running detached from a checkout at ${REPO_ROOT} (#3373); cap took FALLBACK_MAX_CHILDREN=${FALLBACK_MAX_CHILDREN}`,
    )
    return
  }
  let frontendCount
  let rustCount
  // Declared out here, NOT inside the `try`: the `rustCount <= 0` branch below
  // names it, and that branch sits after the `catch`. A `const` inside the try
  // is out of scope there, and module code is strict — so the one message that
  // reports a stale `examine_globs` would throw ReferenceError instead of
  // printing, exiting 1 with a stack trace rather than 2 with the diagnosis.
  let workspaceDir
  try {
    const { globMatches, tomlStringArray, WORKSPACE_DIR } =
      await import('./check-mutants-scope.mjs')
    const { MODULE_NAMES } = await import('../stryker.modules.mjs')
    workspaceDir = resolve(REPO_ROOT, WORKSPACE_DIR)
    frontendCount = MODULE_NAMES.length
    const config = readFileSync(MUTANTS_TOML_PATH, 'utf8')
    const examine = tomlStringArray(config, 'examine_globs')
    const exclude = tomlStringArray(config, 'exclude_globs')
    const files = new Set()
    for (const glob of examine) {
      for (const path of globSync(glob, { cwd: workspaceDir })) {
        if (path.endsWith('.rs') && !exclude.some((e) => globMatches(e, path))) files.add(path)
      }
    }
    rustCount = files.size
  } catch (err) {
    fail('DEFAULT_MAX_CHILDREN can be independently verified against the real config', err.message)
    return
  }
  const expected = frontendCount + rustCount
  const detail = `frontend ${frontendCount} + rust ${rustCount} = ${expected}, got ${DEFAULT_MAX_CHILDREN}`
  const name = `DEFAULT_MAX_CHILDREN is derived from the measured area universe (${detail})`

  // Each half must be non-zero IN ITS OWN RIGHT. Without this, the two
  // failure modes that break BOTH sides identically pass green: an empty or
  // renamed `examine_globs`, and a wrong workspace root (both sides
  // share that constant). Either one yields `rust 0`, and `21 === 21` agrees
  // itself into a silently halved cap. Measured: pointing
  // the workspace root at the repo root instead of `src-tauri/` used to
  // leave this assertion green at `frontend 21 + rust 0 = 21`.
  if (frontendCount <= 0) {
    fail(name, `the frontend half derived to ${frontendCount} — stryker.modules.mjs enrols nothing`)
    return
  }
  if (rustCount <= 0) {
    fail(
      name,
      `the rust half derived to ${rustCount} — examine_globs matched no non-excluded .rs file under ${workspaceDir}`,
    )
    return
  }
  if (DEFAULT_MAX_CHILDREN === expected) ok(name)
  else fail(name, detail)
}

async function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  const survivor = (i) =>
    `[frontend] glob-validate: src/lib/search-query/glob-validate.ts:${i} [ConditionalExpression]`

  // 1. #3245 — the first-fill case: an empty `known` set means EVERY
  //    survivor is "new". The old body listed them under `New this run` AND
  //    under the marker block; the deduped body must list each exactly once.
  {
    const current = [survivor(1), survivor(2), survivor(3)]
    const { newOnes, resolvedOnes, all } = diffSurvivors(current, new Set())
    const body = buildIssueBody({ all, resolvedOnes, runUrl: 'https://example/run' })
    const counts = current.map((s) => body.split(s).length - 1)
    if (newOnes.length === 3 && counts.every((c) => c === 1))
      ok('first fill lists each survivor exactly once (#3245)')
    else
      fail(
        'first fill lists each survivor exactly once (#3245)',
        `newOnes=${newOnes.length} per-survivor occurrences=${JSON.stringify(counts)}`,
      )

    // …and the marker block round-trips to exactly the same set, so the
    // dedupe did not cost the script its state.
    const reparsed = parseKnownSurvivors(body)
    if (reparsed.size === 3 && current.every((s) => reparsed.has(s)))
      ok('deduped body round-trips through parseKnownSurvivors')
    else fail('deduped body round-trips through parseKnownSurvivors', `size=${reparsed.size}`)
  }

  // 2. #3245 — the incremental case: a genuinely new survivor must not
  //    duplicate the already-known ones either.
  {
    const known = new Set([survivor(1), survivor(2)])
    const current = [survivor(1), survivor(2), survivor(9)]
    const { resolvedOnes, all } = diffSurvivors(current, known)
    const body = buildIssueBody({ all, resolvedOnes, runUrl: undefined })
    const counts = current.map((s) => body.split(s).length - 1)
    if (counts.every((c) => c === 1)) ok('incremental run lists each survivor exactly once (#3245)')
    else fail('incremental run lists each survivor exactly once (#3245)', JSON.stringify(counts))
  }

  // 3. Resolved entries are the complement of `all`, so they duplicate
  //    nothing and stay visible.
  {
    const known = new Set([survivor(1), survivor(2)])
    const { resolvedOnes, all } = diffSurvivors([survivor(1)], known)
    const body = buildIssueBody({ all, resolvedOnes, runUrl: undefined })
    if (
      resolvedOnes.length === 1 &&
      body.includes('Resolved since last run (1)') &&
      body.split(survivor(1)).length - 1 === 1
    )
      ok('resolved section renders and duplicates nothing')
    else fail('resolved section renders and duplicates nothing', JSON.stringify(resolvedOnes))
  }

  // 4. #3257 — a large batch must not exceed MAX_BODY_CHARS. These fixture
  //    lines are ~90 chars, so 800 survivors render to ~72K: past both the
  //    60K working cap and GitHub's 65536 hard limit. That is the batch
  //    which used to 422 `gh issue edit` and wedge the weekly job red
  //    forever (the same body is recomputed from the same unchanged `known`
  //    set the following week, so it never self-heals).
  {
    const all = Array.from({ length: 800 }, (_, i) => survivor(i))
    let threw = null
    let body = null
    try {
      body = buildIssueBody({ all, resolvedOnes: [], runUrl: 'https://example/run' })
    } catch (err) {
      threw = err
    }
    if (threw && /outgrew a single issue body/.test(threw.message))
      ok('oversized state block fails with an actionable error, not a raw 422 (#3257)')
    else
      fail(
        'oversized state block fails with an actionable error, not a raw 422 (#3257)',
        threw ? threw.message : `no throw; body=${body.length} chars`,
      )
  }

  // 5. #3257 — a body that only overflows because of the presentational
  //    `Resolved` section must CLAMP (drop that section) rather than throw,
  //    and the marker block must survive intact.
  {
    const all = Array.from({ length: 200 }, (_, i) => survivor(i))
    const resolvedOnes = Array.from({ length: 600 }, (_, i) => survivor(10_000 + i))
    const body = buildIssueBody({ all, resolvedOnes, runUrl: 'https://example/run' })
    const reparsed = parseKnownSurvivors(body)
    if (
      body.length <= MAX_BODY_CHARS &&
      body.includes(MARKER_START) &&
      body.includes(MARKER_END) &&
      reparsed.size === 200 &&
      !body.includes(resolvedOnes[0])
    )
      ok('clamp drops the presentational section and keeps the state block whole (#3257)')
    else
      fail(
        'clamp drops the presentational section and keeps the state block whole (#3257)',
        `len=${body.length} markers=${body.includes(MARKER_START)}/${body.includes(MARKER_END)} reparsed=${reparsed.size}`,
      )
  }

  // 7. A body that comfortably fits is left completely alone.
  {
    const all = [survivor(1), survivor(2)]
    const body = buildIssueBody({ all, resolvedOnes: [], runUrl: 'https://example/run' })
    if (!body.includes('omitted') && !body.includes('truncated')) ok('a small body is not clamped')
    else fail('a small body is not clamped', body)
  }

  // 8. #3364 — a MISSING lane input must be distinguishable from an EMPTY
  //    one. Fixtures live in `selfTestLaneInputGuards` above.
  selfTestLaneInputGuards({ ok, fail, survivor })

  // 9. #3350 — survivor age, then grouping and ranking. Fixtures live in
  //    `selfTestSurvivorAges` / `selfTestGroupingAndRanking` above.
  selfTestSurvivorAges({ ok, fail, survivor })
  selfTestGroupingAndRanking({ ok, fail, survivor })

  // 10/11. Parent/child issues: the plan, then what `main()` really writes.
  const check = (cond, name, detail) => (cond ? ok(name) : fail(name, detail))
  selfTestChildPlanning({ check, survivor })
  selfTestChildGh({ check })

  // 12. #3788 — NoCoverage is surfaced, and surfaced SEPARATELY from Survived;
  //     the column makes same-line mutants distinct; nothing-found stays a
  //     no-op; and the one-off id reshape migrates instead of churning.
  selfTestNoCoverage({ ok, fail })
  selfTestNoCoverageEmptyAndMigration({ ok, fail })

  // 13. #4032 — the 60k boundary, both arms: over-cap truncates AND says by how
  //     much, under-cap is untouched AND unlabelled, and the parent's state
  //     block still refuses to be cut at all.
  selfTestBodyCap({ ok, fail })

  // 14. #4173 — the accepted-equivalent block: proven-unkillable mutants are
  //     subtracted from the OBSERVED set instead of being re-filed every week,
  //     one id at a time (a same-line sibling still reports), and a stale
  //     entry re-anchors rather than suppressing forever.
  selfTestAcceptedGaps({ ok, fail, survivor })
  selfTestAcceptedBlockShape({ ok, fail })
  selfTestAcceptedReanchorTrace({ ok, fail })

  // 15. #3667 — the default child-creation cap is DERIVED, not pinned, so it
  //     cannot silently go stale the way the hardcoded 43 did.
  await selfTestDefaultMaxChildren({ ok, fail })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.slice(2).includes('--self-test')) {
    await runSelfTest()
  } else {
    try {
      main()
    } catch (err) {
      console.error(`file-mutation-survivors: ${err.message}`)
      process.exit(1)
    }
  }
}
