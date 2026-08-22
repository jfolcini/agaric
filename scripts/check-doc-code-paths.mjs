#!/usr/bin/env node
// ui-improvements 2026-05-16 §Maintenance / tooling — fail commits where a
// doc file cites a `src/…` (or `src-tauri/…`, `scripts/…`, `e2e/…`,
// `docs/architecture/…`) path that no longer exists in the working tree
// + git index. Many of the AGENTS.md / docs/* manual audit findings would
// be auto-caught by this; cheap to run.
//
// #4126 — the same class of dead citation recurs in CODE COMMENTS, not just
// doc prose: `src/lib/tree-utils.ts` cited a Rust path deleted by the #882
// crate split, in a `/**` JSDoc block explaining where the mirrored
// `MAX_BLOCK_DEPTH` constant lives on the Rust side. A doc-only scan is
// structurally blind to that — it was found by a human review, not by this
// guard. So this guard also scans every tracked `*.ts` / `*.tsx` file's
// COMMENTS (both `//` line comments and `/* … */` / JSDoc block comments —
// the tree-utils.ts defect was a block comment, and restricting to `//`
// only would miss the exact case that motivated this) for the same
// backtick-wrapped path citations, using the shared `js-scanner.mjs`
// tokenizer to find comment spans so a path-shaped STRING LITERAL in real
// code is never mistaken for a citation (`scripts/lib/js-scanner.mjs`'s own
// header: any JS-side guard needing to isolate comments from code MUST use
// that module, not a hand-rolled stripper).
//
// Heuristic:
//   - Scan every tracked `*.md` file under `docs/`, the repo root,
//     `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md` (see `DOC_ROOTS` for the
//     exact list — `pending/` is NOT one of these; that folder was retired
//     and its files migrated to GitHub issues), PLUS every tracked `*.ts` /
//     `*.tsx` file (comments only, see above).
//   - Read each file from the copy the caller is actually judging — the
//     STAGED INDEX during a commit, the WORKING TREE otherwise (#3962,
//     swept here by #4017). `--cached` / `--worktree` force it; with
//     neither, `GIT_INDEX_FILE` (git naming the index it is about to
//     commit) decides. Rationale, the measurements behind the auto rule,
//     and the deletion/unmerged/symlink decisions:
//     scripts/lib/guard-file-source.mjs.
//   - Extract candidate paths from inline-code spans (`` `path/...` `` —
//     the dominant doc AND code-comment convention) AND from markdown link
//     targets (`[label](relative/path)`) — `extractCandidates` runs both
//     extractions over EVERY judged text, `.md` body or `.ts`/`.tsx` comment
//     span alike, so a `](path)` inside a JSDoc comment is a candidate too,
//     not only inside a `.md` file.
//   - For each candidate, check whether the path exists IN THAT SAME
//     SOURCE. Strip any `#anchor`, `?query`, `:N` line-number suffix
//     before checking.
//   - Skip http(s)://, `mailto:`, anchor-only refs (`#section`), and
//     paths that obviously don't look like file references (no slash
//     and no recognised extension).
//   - A `.ts`/`.tsx` file the shared tokenizer cannot lex unambiguously is
//     reported as a SCAN ERROR (a failure — same rule as
//     `check-set-property-args.mjs`), never silently skipped: a file
//     nobody could check is not a file that passed.
//   - Report the first 50 mismatches (plus any scan errors) and exit
//     non-zero.
//
// ─── Baseline (#4126 widening) ─────────────────────────────────────────
//
// Widening the scan to `.ts`/`.tsx` comments surfaced 18 pre-existing dead
// citations that predate this guard — files moved by the #882 crate split
// and later component reshuffles, cited from a comment that was never
// swept. Bulk-fixing 18 call sites in the same PR that lands the widened
// scanner would bury the mechanical change under an unrelated content
// sweep, so — following the shrink-only baseline convention already used
// by `scripts/strict-invoke-optout-baseline.json`,
// `scripts/lib-layering-baseline.json` and `scripts/bulk-equivalence-baseline.json`
// — they are recorded in `scripts/doc-code-paths-baseline.json` instead. A
// baselined (file, ref) pair is grandfathered; anything ELSE is still a
// hard failure, so this guard already prevents the count from growing even
// before the backlog is burned down. Two failure modes, not one:
//   - a NEW (file, ref) miss not in the baseline — an actual regression;
//   - a STALE baseline entry whose (file, ref) pair is no longer a miss
//     (fixed, or the citing file/text changed) — must be pruned via
//     `--update-baseline`, so the baseline can only ever shrink, never
//     silently keep phantom cover for a citation that already moved on.
//
// #4135's bare-filename widening (`BARE_CODE_CITATION_RE`, below) uses the
// SAME baseline and the same two failure modes; it added 142 pre-existing
// (file, ref) pairs, carrying their own `reason` string so the two intakes
// stay distinguishable in the file. #4181 tracks burning those down.
//
// ─── The two working-tree reads this guard used to carry (#4017) ─────────
//
// It enumerated with `git ls-files` (the index) and then judged with
// `readFileSync` / `existsSync` (the working tree). BOTH halves diverged:
//
//   1. DOC BODIES — a staged doc citing a path that was just deleted
//      committed cleanly whenever the author had already fixed the citation
//      on disk without `git add`, and vice versa.
//   2. LINK TARGETS — `existsSync` asked the working tree whether the cited
//      file exists. A file `git rm --cached`'d (staged deletion, still on
//      disk) satisfied `existsSync` and every citation of it passed, while
//      the commit removed it. Under the index source the tracked set IS the
//      answer to "does this exist in what is being committed", so the
//      on-disk half is dropped rather than combined with it — keeping it would
//      reintroduce exactly the divergence being closed.
//
// Usage:
//   node scripts/check-doc-code-paths.mjs              # auto source
//   node scripts/check-doc-code-paths.mjs --cached     # staged index
//   node scripts/check-doc-code-paths.mjs --worktree   # working tree
//   node scripts/check-doc-code-paths.mjs --print-source
//   node scripts/check-doc-code-paths.mjs --self-test
//   node scripts/check-doc-code-paths.mjs --update-baseline  # re-anchor baseline
//
// Any OTHER argument is a usage error, not a silently ignored one: a
// mistyped `--cache` that resolved to AUTO would judge a copy the caller did
// not ask for, and say nothing about it.
//
// Exit codes: 0 clean / 1 mismatches (or stale baseline) / 2 invocation error.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import {
  initScratchRepo,
  runSourceScenarios,
  scrubbedGitEnv,
  withScrubbedProcessEnv,
} from './lib/git-scratch-guard.mjs'
import {
  describeSource,
  gitEnv,
  listTrackedEntries,
  readContents,
  repoRootFromCwd,
  resolveSource,
  SOURCE_INDEX,
} from './lib/guard-file-source.mjs'
import { ScanError, tokenize } from './lib/js-scanner.mjs'

// cwd-derived, not script-anchored — the documented EXCEPTION to "a guard
// judges the tree that contains it", taken through the SHARED
// `repoRootFromCwd` rather than a private `show-toplevel` (#4192: a private
// copy asked git under the ambient environment, where a leaked git context
// redirects the root itself). The rule, the exception, the five guards that
// take it and what to do instead are stated once, in
// `scripts/lib/guard-file-source.mjs` ("Which TREE is judged, and the one
// documented exception").
const REPO_ROOT = repoRootFromCwd()

// The environment this guard's OWN `git` calls run under. An ambient
// `GIT_INDEX_FILE` outranks `cwd` for the INDEX and an ambient `GIT_DIR`
// outranks it for the REPOSITORY (#4191), so without this a leaked git
// context would enumerate somebody else's tree — under `--worktree` as
// readily as `--cached` — while `cwd=REPO_ROOT` made it look otherwise. See
// `gitEnv`.
const GIT_ENV = gitEnv(REPO_ROOT, process.env)

// #4126 shrink-only baseline of pre-existing (file, ref) misses — see the
// header's "Baseline" section. Deliberately read from PLAIN DISK, not
// through the source-selection machinery the cited files go through: it is
// this guard's own config, not user-authored content under review, and
// every self-test fixture (a throwaway repo with no `scripts/` dir at all)
// must see it as absent rather than erroring, so a missing file reads as an
// EMPTY baseline rather than an invocation error.
const BASELINE_FILE = join(REPO_ROOT, 'scripts', 'doc-code-paths-baseline.json')

function baselineKey(file, ref) {
  return `${file}\u0000${ref}`
}

// `lenientOnParseError` (Note 5): ONLY `updateBaseline` may pass this. A
// baseline that fails to parse (an unresolved merge-conflict marker, say)
// is treated as empty so `--update-baseline` can re-anchor it from scratch
// — the remedy the `check` error message itself points at. `check` never
// passes it: a commit must still hard-fail on a corrupt baseline rather
// than silently running as if nothing were grandfathered.
function readBaseline({ lenientOnParseError = false } = {}) {
  if (!existsSync(BASELINE_FILE)) return []
  const raw = readFileSync(BASELINE_FILE, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    if (lenientOnParseError) return []
    throw new Error(`${BASELINE_FILE} is not valid JSON: ${err.message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${BASELINE_FILE} must contain a JSON array`)
  }
  return parsed
}

function writeBaseline(entries) {
  // Plain UTF-8/UTF-16 code-unit order, NOT `localeCompare` — the
  // repo-wide baseline convention (`scripts/check-strict-invoke-optout.mjs`'s
  // `.toSorted()` with no comparator, and the tag-row byte-sort fix in #4125)
  // is a byte sort, and `localeCompare` disagrees with it on case (it would
  // sort `SearchPanel` before `backlinks`; a byte sort does not).
  const key = (e) => `${e.file}\u0000${e.ref}`
  const sorted = entries.toSorted((a, b) => {
    const ak = key(a)
    const bk = key(b)
    return ak < bk ? -1 : ak > bk ? 1 : 0
  })
  writeFileSync(BASELINE_FILE, `${JSON.stringify(sorted, null, 2)}\n`)
}

// Markdown files we audit. Keep this list explicit so node_modules and
// other surfaces don't get accidentally pulled in.
const DOC_ROOTS = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'README.md',
  'CODE_OF_CONDUCT.md',
  'COMPARISON.md',
  'docs',
]
// Doc paths excluded from the audit:
//  - `docs/session-log/*.md` are archives of past state; references in
//    archived sessions are expected to drift (files get renamed,
//    refactored, deleted) and the historical record stays accurate.
//  - `docs/security/review-*.md` are point-in-time reviews that record the
//    HEAD they were taken against and declare, in their own header, that they
//    are not updated as the code changes. Repointing their citations would
//    falsify the record; the audit therefore leaves them alone. The living
//    `docs/security/README.md` is still audited.
const EXCLUDE_PATH_RE = /^docs\/(session-log\/|security\/review-)/

function listMarkdownFiles(tracked) {
  const out = []
  for (const path of tracked) {
    if (!path.endsWith('.md')) continue
    if (EXCLUDE_PATH_RE.test(path)) continue
    for (const root of DOC_ROOTS) {
      if (path === root || path.startsWith(`${root}/`)) {
        out.push(path)
        break
      }
    }
  }
  return out
}

// #4126 — every tracked `.ts`/`.tsx` file, comments-only. Unlike
// `listMarkdownFiles` this has no root allowlist: a stale cross-language
// citation can appear in any TS/TSX comment (the tree-utils.ts defect was
// under `src/lib/`, but nothing about the shape is specific to that
// directory), so the scan set is "every tracked file with this extension",
// the same breadth `check-architecture-citations.mjs` and
// `check-dead-symbol-citations.mjs` already use for their `.ts`/`.tsx`
// scanning.
function listTsFiles(tracked) {
  return tracked.filter((path) => /\.tsx?$/.test(path))
}

/**
 * Concatenate every COMMENT span (`//` line comments and `/* … *‍/` block
 * comments, JSDoc included) in a `.ts`/`.tsx` file's text, via the shared
 * tokenizer — never a hand-rolled stripper (`scripts/lib/js-scanner.mjs`'s
 * own header names this as a repeat mistake, #3991). A path-shaped STRING
 * LITERAL in real code (`const p = 'src/x.ts'`) must never be read as a
 * citation, and only the tokenizer reliably tells a comment from a string
 * without also tripping on a `//`/`/*` inside one.
 *
 * Comments are joined with `\n` — not concatenated raw — so a candidate
 * cannot span two unrelated comments glued end to end.
 *
 * Throws `ScanError` (propagated to the caller) on input the shared
 * tokenizer cannot lex unambiguously; callers must not swallow it, per the
 * module's fail-closed policy.
 */
function extractCommentText(body) {
  const spans = []
  for (const tok of tokenize(body)) {
    if (tok.kind === 'comment') spans.push(body.slice(tok.start, tok.end))
  }
  return spans.join('\n')
}

// Path prefixes that are gitignored on this repo and therefore expected
// to be missing from `git ls-files`. References to them in docs are
// build-output / cache mentions, not source drift.
const GITIGNORED_PREFIX_RE =
  /^(?:[a-zA-Z0-9_./-]*\/)?(?:target|node_modules|dist|coverage|src-tauri\/gen|src-tauri\/target|src-tauri\/binaries|\.cargo\/config\.toml)(?:\/|$)/

// Repo-rooted prefixes we know are real source locations. Anything that
// doesn't start with one of these is treated as prose (a filename mentioned
// by brand, a doc section heading, etc.) and skipped — too noisy otherwise.
const PATH_PREFIX_RE = /^(?:src|src-tauri|scripts|e2e|docs|\.github|\.cargo)\//

function isLocalPathCandidate(raw) {
  if (!raw) return false
  if (raw.startsWith('http://') || raw.startsWith('https://')) return false
  if (raw.startsWith('mailto:')) return false
  if (raw.startsWith('#')) return false
  // Prose tells: whitespace, glob wildcards, brace expansion, regex
  // anchors, Rust path-with-function (::name), shell-ellipsis. Skip.
  if (/[\s*<>?|{}]/.test(raw)) return false
  if (raw.includes('...') || raw.includes('::')) return false
  // Strip anchor / query / line-number suffixes. The line-number suffix is
  // not always a single `:N` / `:N-M` — a citation naming several spots in
  // one file spells it as a comma-separated list (`:220,349-351`, the shape
  // `src/lib/tauri-mock/handlers/shared.ts` actually uses to cite
  // `metadata.rs`), so the trailing group must be allowed to repeat via
  // `(?:,\d+(?:-\d+)?)*` — a single-number stripper leaves the comma-list
  // suffix attached to the path and manufactures a guaranteed miss on a
  // citation that is otherwise entirely correct (found reviewing #4126/#4129:
  // two of the newly-baselined "misses" were this, not a real dead path).
  const cleaned = raw
    .split('#')[0]
    .split('?')[0]
    .replace(/:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, '')
    .replace(/\/+$/, '')
    .trim()
  if (!cleaned) return false
  if (isAbsolute(cleaned)) return false
  // Must be repo-rooted under one of the known source prefixes — bare
  // filenames in prose ("`Cargo.toml`", "`README.md`") are out of scope.
  if (!PATH_PREFIX_RE.test(`${cleaned}/`)) return false
  // Skip references into gitignored build-output / cache paths.
  if (GITIGNORED_PREFIX_RE.test(cleaned)) return false
  return cleaned
}

function extractCandidates(text) {
  const found = new Set()
  // Inline code spans: `` `path` ``.
  for (const match of text.matchAll(/`([^`\n]{2,200})`/g)) {
    const cleaned = isLocalPathCandidate(match[1] ?? '')
    if (cleaned) found.add(cleaned)
  }
  // Markdown links: [label](target).
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const cleaned = isLocalPathCandidate(match[1] ?? '')
    if (cleaned) found.add(cleaned)
  }
  return found
}

// #4244 part (b) — an OPPORTUNISTIC WARNING (never a failure) when a cited
// line number exceeds the target file's current length. This guard strips
// `:N` before checking anything (see the header) — it verifies the file
// EXISTS, never that the line is right — so a citation can be "path-valid"
// and still point at a section that moved or was deleted long ago. Checking
// the number against the file's actual length is cheap and catches the most
// egregious drift (a citation dozens or hundreds of lines past EOF) without
// pretending to verify the PROSE matches the line, which no mechanical
// check can do.
//
// Deliberately a WARNING, not a red: a citation can legitimately name a
// line number past the file's CURRENT length on purpose — the tree already
// has one, `tauri.ts:1871` in `src/lib/__tests__/platform.test.ts`, a
// historical anchor a test asserts the ABSENCE of (`src/lib/tauri.ts` is
// 106 lines; the comment calls the anchor "stale" in so many words). A hard
// check would redden the build on that citation, which is correct as
// written. So this only ever prints — `check()` never folds it into
// `failed`.
//
// Known floor: that same `tauri.ts:1871` anchor is permanent by
// construction (the test it lives in exists to assert the anchor stays
// gone), so this warning channel opens at a floor of ONE known-intentional
// citation, not zero — a clean tree still prints one warning line. This is
// the only entry in that floor as of #4258; if the floor grows beyond
// deliberately-historical anchors like this one, the fix is an
// acknowledgment list (baseline it the way `newMisses` is baselined above),
// NOT deleting the warning — a permanent non-zero floor left undocumented
// is how a warning channel gets tuned out and ignored.
//
// `extractCandidates` above already discards the `:N` suffix (that is the
// whole reason #4244 part (a), the sweep, has to happen by hand instead of
// mechanically) and DEDUPES by the stripped path — a file cited twice in
// the same text at two different line numbers would collapse to one Set
// entry, silently losing whichever line number did not win the dedupe. So
// this is a separate extraction, keyed on the FULL raw citation (path +
// suffix) instead, over the same two surfaces (inline code spans, markdown
// link targets) `extractCandidates` scans.
//
// The one known-intentional entry in this channel's floor (see the header
// above) — the historical `tauri.ts:1871` anchor. Named here, as a plain
// literal rather than a baseline file, purely so the warning OUTPUT can
// say "known-intentional" vs "new" instead of a bare undifferentiated
// list; this is not a suppression/acknowledgment mechanism (there isn't
// one — see the header) and nothing here changes `check()`'s exit code.
const KNOWN_INTENTIONAL_WARNINGS = new Set([
  'src/lib/__tests__/platform.test.ts src/lib/tauri.ts 1871',
])
const warningKey = (w) => `${w.doc} ${w.ref} ${w.maxCited}`

// @param {string} text
// @returns {{cleaned: string, lineNumbers: number[]}[]}
function extractLineCitations(text) {
  const found = new Map()
  const consider = (raw) => {
    const trimmed = (raw ?? '').trim()
    const cleaned = isLocalPathCandidate(trimmed)
    if (!cleaned) return
    const suffixMatch = trimmed
      .split('#')[0]
      .split('?')[0]
      .match(/:(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/)
    if (!suffixMatch) return // no line-number suffix — nothing to bound-check
    const key = `${cleaned} ${suffixMatch[1]}`
    if (found.has(key)) return
    const lineNumbers = suffixMatch[1]
      .split(',')
      .flatMap((seg) => seg.split('-'))
      .map((n) => Number.parseInt(n, 10))
    found.set(key, { cleaned, lineNumbers })
  }
  for (const match of text.matchAll(/`([^`\n]{2,200})`/g)) consider(match[1])
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) consider(match[1])
  return [...found.values()]
}

/**
 * Count a file's lines the way `wc -l` does: the number of `\n` bytes, plus
 * one more if the content does not itself end in a newline (an unterminated
 * final line still counts as a line). A trailing newline is the common case
 * and must NOT add a phantom empty final line — `body.split('\n').length`
 * alone over-counts by exactly one for any newline-terminated file, which
 * would make every citation of the file's true last line look one short of
 * a warning.
 *
 * @param {string} body
 */
function countFileLines(body) {
  if (body.length === 0) return 0
  const newlines = (body.match(/\n/g) ?? []).length
  return body.endsWith('\n') ? newlines : newlines + 1
}

// #4135 — a code citation written as a BARE FILENAME with a line number,
// e.g. `` `session_supervisor.rs:708-716` ``, carries no repo-rooted prefix
// at all, so `isLocalPathCandidate`'s `PATH_PREFIX_RE` gate above treats it
// exactly like `` `Cargo.toml` `` or `` `README.md` `` — an ordinary prose
// mention — and silently skips it. That is the shape prose most naturally
// takes once a paragraph has already named the file once (`docs/architecture/`
// is full of it), and it is also the shape most likely to rot: a bare
// filename carries no signal about which crate/dir it lives in after a move,
// and this repo has already done one crate split (#882). `threat-model.md`
// once cited `session_supervisor.rs:708-716` for behaviour that had moved
// entirely into `lan_interface.rs` — wrong file, not merely a drifted line
// number — and no guard could see it; a human reading the source caught it
// on the third review pass.
//
// Resolving the bare name against the tracked tree (rather than flagging the
// form outright) was considered and rejected: `mod.rs`, `error.rs` and
// `tests.rs` each exist under several directories in this repo, so a naive
// resolution is either an arbitrary first match or a false positive whenever
// more than one candidate exists. So the FORM is the rule instead — a code
// citation with a line number must be repo-rooted, full stop — which is also
// what a reader actually wants from the citation.
//
// Scoped to citations that carry a LINE NUMBER (`:N` / `:N-M`, the same
// trailing-suffix grammar `isLocalPathCandidate` strips): a bare mention with
// no line number (`` `error.rs` ``) is genuinely ambiguous prose ("the file
// handling errors") in a way `error.rs:42` is not, and flagging every bare
// filename mention with no signal beyond its name would be far noisier for
// far less benefit. The extension list matches the languages this repo's own
// code actually lives in (Rust, TS/TSX, the JS script variants, Python,
// shell, SQL migrations, TOML config) — narrow on purpose, so an unrelated
// dotted token that happens to end in a real extension after a `:digit`
// (unlikely, but see `isLocalPathCandidate`'s own prose-tell list) stays the
// only false-positive surface.
//
// WHAT THIS STILL DOES NOT SEE, stated rather than implied — #4135's framing
// is "a code citation with a line number must be repo-rooted", and this
// pattern only enforces the BARE end of that. (The middle shape — a
// PARTIALLY-ROOTED citation with a slash but no known root, e.g.
// `pagination/mod.rs:658-668` — used to fall between this gate and
// `isLocalPathCandidate`'s `PATH_PREFIX_RE` gate; #4184 closed it with
// `PARTIALLY_ROOTED_CODE_CITATION_RE`, below.)
//
//   - A citation inside a FENCED CODE BLOCK. Like `extractCandidates` above,
//     this scans the whole judged text, fences included, so a doc that
//     DEMONSTRATES a bad citation inside a ``` block would be flagged for
//     the demonstration. No such case exists in the tree today (checked),
//     and the behaviour is deliberately identical to the pre-existing
//     extraction rather than a second, divergent notion of "in scope" — but
//     it is the shape to reach for a repo-rooted example in, if one is ever
//     needed. `docs/session-log/` is excluded from the scan entirely, so a
//     session log quoting a bad citation is already safe.
const BARE_CODE_CITATION_RE =
  /^([A-Za-z0-9][A-Za-z0-9_.-]*\.(?:rs|tsx?|mjs|cjs|jsx?|py|sh|sql|toml)):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/

/**
 * Every inline-code-span citation in `text` matching the bare-filename shape
 * `BARE_CODE_CITATION_RE` describes — a citation this guard's normal
 * candidate extraction never even sees, since it is gated out before
 * `isLocalPathCandidate` returns. Returned as the raw citation text itself
 * (there is nothing to resolve — the form IS the violation), deduplicated the
 * same way `extractCandidates` dedupes its own candidates.
 *
 * Only inline code spans are scanned, not markdown link targets: a bare
 * filename is not a valid relative link target to begin with (there is
 * nothing for a browser or GitHub's renderer to resolve it against), so that
 * shape does not occur in `](…)` targets in practice — see the "how it
 * surfaced" citations above, all of which are inline code spans.
 *
 * @param {string} text
 */
function extractBareCitations(text) {
  const found = new Set()
  for (const match of text.matchAll(/`([^`\n]{2,200})`/g)) {
    const raw = (match[1] ?? '').trim()
    if (BARE_CODE_CITATION_RE.test(raw)) found.add(raw)
  }
  return found
}

// #4184 — the PARTIALLY-ROOTED middle shape `BARE_CODE_CITATION_RE`'s own
// comment names: a citation like `pagination/mod.rs:658-668`,
// `agaric-store/src/query/engine.rs:229`, `ui/sidebar.tsx:865`,
// `fts/search/fetch.rs:292` or `sync_protocol/types.rs:37` HAS a slash (so
// the bare-form pattern, which forbids one by anchoring on a single
// filename with no `/`, does not match it) but its leading segment is not
// one of `PATH_PREFIX_RE`'s known roots (`src`, `src-tauri`, `scripts`,
// `e2e`, `docs`, `.github`, `.cargo`), so `isLocalPathCandidate` treats it
// as prose and skips it too. It fell between both gates and was invisible
// to exactly the drift the bare form is — arguably more so, because a
// crate-relative prefix READS as authoritative while naming no crate, so a
// reader trusts it more and a reviewer questions it less.
//
// Same rule as #4135: the FORM is the violation, not a resolution attempt —
// "cite a repo-rooted path" is what a reader actually wants, and resolving
// a multi-segment suffix against the tracked tree (option 2 in #4184) was
// considered and left for a future issue; this ships the option consistent
// with what #4135 already shipped (option 1), so the two intakes share one
// mechanism.
//
// Scoped identically to `BARE_CODE_CITATION_RE`: requires a trailing
// line-number suffix (the same `(?:,\d+(?:-\d+)?)*` comma-list grammar),
// matched in inline code spans only (see `extractBareCitations`'s own
// rationale — a partially-rooted path is not a valid relative link target
// either, so this shape does not occur in `](…)` targets), and the SAME
// `^…$` anchoring keeps a log line, a URL, and a `file:LINE:COL` coordinate
// green for the identical reason the bare form's own fixtures establish:
// none of the three is the ENTIRE content of the code span.
//
// A candidate that IS already repo-rooted (starts with a known
// `PATH_PREFIX_RE` root) is explicitly excluded here — that shape is a
// normal candidate, judged for existence by `isLocalPathCandidate` /
// `extractCandidates` instead, not a form violation.
const PARTIALLY_ROOTED_CODE_CITATION_RE =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+\.(?:rs|tsx?|mjs|cjs|jsx?|py|sh|sql|toml):\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/

/**
 * Every inline-code-span citation in `text` matching the partially-rooted
 * shape `PARTIALLY_ROOTED_CODE_CITATION_RE` describes AND not already
 * repo-rooted under a known `PATH_PREFIX_RE` prefix. Like
 * `extractBareCitations`, the raw citation text itself is the violation —
 * there is nothing to resolve.
 *
 * @param {string} text
 */
function extractPartiallyRootedCitations(text) {
  const found = new Set()
  for (const match of text.matchAll(/`([^`\n]{2,200})`/g)) {
    const raw = (match[1] ?? '').trim()
    if (!PARTIALLY_ROOTED_CODE_CITATION_RE.test(raw)) continue
    if (PATH_PREFIX_RE.test(raw)) continue
    found.add(raw)
  }
  return found
}

function resolveAgainstDoc(_docFile, ref) {
  // Every candidate is already gated through `PATH_PREFIX_RE` so it's
  // repo-rooted by construction. Normalise to strip any redundant `./`
  // or duplicate slashes.
  return normalize(ref)
}

/**
 * Resolve the source, enumerate `.md` + `.ts`/`.tsx` files and compute
 * every current (miss, scanError) — shared by `check()` (which filters
 * through the baseline) and `updateBaseline()` (which does not: it needs
 * the RAW current set to re-anchor against).
 *
 * Returns `{ exitCode, ... }` with `exitCode` set (2, or 0 for the
 * "nothing to scan" / "not a git repo" early-outs) when the caller should
 * stop and propagate it as-is; otherwise `{ misses, scanErrors, chosen }`.
 */
function computeMisses() {
  let chosen
  try {
    chosen = resolveSource(process.argv, process.env, {
      // This guard's own flags, declared so an argument that is neither
      // these nor a source flag is a usage error rather than a silent AUTO.
      extraFlags: ['--print-source', '--self-test', '--update-baseline'],
      // AUTO must know whose index `GIT_INDEX_FILE` names, not merely that it
      // is set — see `resolveSource`.
      repoRoot: REPO_ROOT,
    })
  } catch (err) {
    process.stderr.write(`check-doc-code-paths: invocation error: ${err.message}\n`)
    return { exitCode: 2 }
  }
  if (process.argv.includes('--print-source')) {
    console.log(`check-doc-code-paths: ${describeSource(chosen.source)} (${chosen.why})`)
    return { exitCode: 0 }
  }
  let entries
  try {
    entries = listTrackedEntries(REPO_ROOT, { env: GIT_ENV })
  } catch (err) {
    process.stderr.write(`check-doc-code-paths: invocation error: ${err.message}\n`)
    return { exitCode: 2 }
  }
  if (entries === null) {
    console.warn('check-doc-code-paths: not a git repo; skipping.')
    return { exitCode: 0 }
  }
  const tracked = new Set(entries.paths)
  // Every ANCESTOR DIRECTORY of every tracked path, built ONCE from
  // `entries.paths` — not per candidate. A directory-shaped citation (a
  // citing text that names a directory, not a file) resolves by asking
  // whether that directory is itself present as some tracked file's
  // ancestor, which this Set answers in O(1); the previous fallback
  // instead spread `tracked` into a fresh array and linear-scanned it with
  // `.some(startsWith(...))` for every directory-shaped candidate AND
  // every genuine miss, paying O(n) per candidate on top of the O(n)
  // materialisation itself.
  const trackedDirs = new Set()
  for (const path of entries.paths) {
    const parts = path.split('/')
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      trackedDirs.add(prefix)
    }
  }
  const docs = listMarkdownFiles(entries.paths)
  const tsFiles = listTsFiles(entries.paths)
  if (docs.length === 0 && tsFiles.length === 0) {
    return { misses: [], scanErrors: [], warnings: [], chosen }
  }
  let bodies
  let tsBodies
  try {
    bodies = readContents(docs, {
      repoRoot: REPO_ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    })
    tsBodies = readContents(tsFiles, {
      repoRoot: REPO_ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    })
  } catch (err) {
    process.stderr.write(`check-doc-code-paths: invocation error: ${err.message}\n`)
    return { exitCode: 2 }
  }
  const misses = []
  const scanErrors = []
  // #4244 part (b) — every line-number citation whose PATH resolves (a
  // citation that does not resolve is already a `missing` miss above; there
  // is no file to bound-check a line number against). Collected across every
  // judged text and batch-read once, after both loops below, rather than
  // read per-citation: the same target Rust file is commonly cited dozens of
  // times across `search.ts` alone, and `readContents` already exists to do
  // exactly this kind of batched, SOURCE-consistent read (`--cached` reads
  // the blob about to be committed, `--worktree` reads disk — the warning
  // must judge the same copy the rest of the guard just judged, or it could
  // warn — or fail to warn — about a line count that is not actually what is
  // being committed).
  const lineCitations = []
  const judge = (citingFile, text) => {
    for (const ref of extractCandidates(text)) {
      const resolved = resolveAgainstDoc(citingFile, ref)
      // Gated behind the exact-match result: the common case (a live
      // citation) resolves on `tracked.has` alone. The fallback — a
      // directory-shaped citation — answers from `trackedDirs`, the
      // ancestor-directory Set built ONCE above, so neither branch pays to
      // materialise or scan the full tracked Set per candidate; that O(n)
      // per-candidate cost is what the #4126 widening (~500 more TS/TSX
      // candidates on top of the Markdown set) made expensive enough to
      // matter.
      const trackedExact = tracked.has(resolved)
      const isTracked = trackedExact || trackedDirs.has(resolved)
      // The index IS the answer to "will this path exist in the commit", so
      // under `--cached` the tracked set alone decides. Under `--worktree`
      // the path must ALSO be on disk, which is what catches a tracked file
      // deleted from the working tree without a `git rm` (see the header).
      const onDisk = chosen.source === SOURCE_INDEX ? null : existsSync(join(REPO_ROOT, resolved))
      if (!isTracked || onDisk === false) {
        misses.push({ doc: citingFile, ref, resolved, onDisk, tracked: isTracked, kind: 'missing' })
      }
    }
    for (const { cleaned, lineNumbers } of extractLineCitations(text)) {
      const resolved = resolveAgainstDoc(citingFile, cleaned)
      const isTracked = tracked.has(resolved) || trackedDirs.has(resolved)
      if (!isTracked) continue // already a `missing` miss above — nothing to bound-check
      lineCitations.push({ doc: citingFile, resolved, lineNumbers })
    }
    // #4135 — a citation whose FORM is the violation, independent of whether
    // anything resolves: see `extractBareCitations`. `resolved`/`onDisk`/
    // `tracked` carry no meaning for this kind (there is nothing this guard
    // tried to resolve), so they are left `null`/`false` rather than
    // fabricating a value, and `check()`'s rendering branches on `kind`
    // before ever printing them.
    for (const raw of extractBareCitations(text)) {
      misses.push({
        doc: citingFile,
        ref: raw,
        resolved: null,
        onDisk: null,
        tracked: false,
        kind: 'bare-form',
      })
    }
    // #4184 — the partially-rooted middle shape; see
    // `extractPartiallyRootedCitations`.
    for (const raw of extractPartiallyRootedCitations(text)) {
      misses.push({
        doc: citingFile,
        ref: raw,
        resolved: null,
        onDisk: null,
        tracked: false,
        kind: 'partial-root',
      })
    }
  }
  for (const doc of docs) {
    // `=== undefined`, never a truthiness test: a zero-byte doc reads as
    // `''` and must count as READ, not as skipped. See `readContents`.
    const body = bodies.get(doc)
    if (body === undefined) continue
    judge(doc, body)
  }
  for (const file of tsFiles) {
    const body = tsBodies.get(file)
    if (body === undefined) continue
    let commentText
    try {
      commentText = extractCommentText(body)
    } catch (err) {
      // The shared scanner refuses to guess at input it cannot decide. A
      // file we could not lex is a file whose comments nobody checked, so
      // it is reported as a FAILURE — counting it as clean would be the
      // fail-open this guard exists to avoid. Mirrors
      // `check-set-property-args.mjs`'s `scanErrors` handling exactly.
      if (!(err instanceof ScanError)) throw err
      scanErrors.push({ file, message: err.message })
      continue
    }
    judge(file, commentText)
  }
  // #4244 part (b) — batch-read every distinct target a line-numbered
  // citation resolved to, ONCE, through the same source-aware reader used
  // for docs/tsFiles above (see `lineCitations`'s own comment for why).
  // Best-effort: a read failure here must never fail the guard — the
  // warning is opportunistic, not a claim this guard fully re-verified
  // every target's content, so a target that could not be read for
  // whatever reason is silently skipped rather than surfaced as a
  // scanError (which WOULD fail the build, exactly what this feature must
  // not do).
  const warnings = []
  if (lineCitations.length > 0) {
    let targetBodies
    try {
      targetBodies = readContents([...new Set(lineCitations.map((c) => c.resolved))], {
        repoRoot: REPO_ROOT,
        source: chosen.source,
        entries,
        env: GIT_ENV,
      })
    } catch {
      targetBodies = new Map()
    }
    for (const { doc, resolved, lineNumbers } of lineCitations) {
      const body = targetBodies.get(resolved)
      if (body === undefined) continue
      const fileLineCount = countFileLines(body)
      const maxCited = Math.max(...lineNumbers)
      if (maxCited > fileLineCount) {
        warnings.push({ doc, ref: resolved, maxCited, fileLineCount })
      }
    }
  }
  return { misses, scanErrors, warnings, chosen }
}

function check() {
  const result = computeMisses()
  if (result.exitCode !== undefined) return result.exitCode
  const { misses, scanErrors, warnings, chosen } = result

  let baseline
  try {
    baseline = readBaseline()
  } catch (err) {
    process.stderr.write(`check-doc-code-paths: invocation error: ${err.message}\n`)
    return 2
  }
  const baselineSet = new Set(baseline.map((e) => baselineKey(e.file, e.ref)))
  const missKeys = new Set(misses.map((m) => baselineKey(m.doc, m.ref)))
  const newMisses = misses.filter((m) => !baselineSet.has(baselineKey(m.doc, m.ref)))
  const staleEntries = baseline.filter((e) => !missKeys.has(baselineKey(e.file, e.ref)))
  // #4244 part (b) — `warnings` never joins this: it decides whether the
  // run PRINTS, not whether it FAILS. A run with warnings and nothing else
  // wrong must still exit 0 — see `extractLineCitations`'s header for why
  // (the `tauri.ts:1871` historical citation must stay green).
  const failed = newMisses.length > 0 || staleEntries.length > 0 || scanErrors.length > 0

  if (!failed && warnings.length === 0) {
    return 0
  }
  // Name the source with the verdict — on ANY failure OR warning, not just
  // a new miss: a run failing purely on stale baseline entries (or only
  // printing a warning) still needs this, or it reports no source at all,
  // which is exactly the "a red the author cannot reproduce by opening the
  // file is otherwise indistinguishable from a broken guard" case this line
  // exists to prevent.
  process.stderr.write(`  (judged the ${describeSource(chosen.source)} — ${chosen.why})\n`)
  if (newMisses.length > 0) {
    const shown = newMisses.slice(0, 50)
    process.stderr.write(
      'ERROR: doc/comment citations reference paths missing from the tracked tree:\n',
    )
    for (const m of shown) {
      // #4135 — a `bare-form` miss never resolved anything (there was no
      // repo-rooted path to resolve), so printing its `resolved`/`onDisk`/
      // `tracked` fields would read as a real resolution attempt that failed
      // rather than what actually happened: the citation's FORM is the
      // violation. Give it its own line instead.
      if (m.kind === 'bare-form') {
        process.stderr.write(
          `  - ${m.doc} → \`${m.ref}\`  (bare filename with a line number — cite a repo-rooted path instead, #4135)\n`,
        )
        continue
      }
      if (m.kind === 'partial-root') {
        process.stderr.write(
          `  - ${m.doc} → \`${m.ref}\`  (partially-rooted citation — cite a repo-rooted path instead, #4184)\n`,
        )
        continue
      }
      const onDisk = m.onDisk === null ? 'n/a' : String(m.onDisk)
      process.stderr.write(
        `  - ${m.doc} → \`${m.ref}\`  (resolved: ${m.resolved}, onDisk=${onDisk}, tracked=${m.tracked})\n`,
      )
    }
    if (newMisses.length > shown.length) {
      process.stderr.write(`  ...and ${newMisses.length - shown.length} more\n`)
    }
    process.stderr.write('\nFix: restore the file, update the reference, or remove the mention.\n')
  }
  if (staleEntries.length > 0) {
    process.stderr.write(
      'ERROR: scripts/doc-code-paths-baseline.json has stale entr(ies) that are no longer misses:\n',
    )
    for (const e of staleEntries) {
      process.stderr.write(`  - ${e.file} → \`${e.ref}\`\n`)
    }
    process.stderr.write('\nPrune with:  node scripts/check-doc-code-paths.mjs --update-baseline\n')
  }
  if (scanErrors.length > 0) {
    process.stderr.write(
      'ERROR: file(s) could not be lexed unambiguously, so their comments were not checked:\n',
    )
    for (const e of scanErrors) {
      process.stderr.write(`  - ${e.file}: ${e.message}\n`)
    }
  }
  if (warnings.length > 0) {
    // #4244 part (b) — printed, never counted toward `failed`. A cited line
    // number past the target's current length is USUALLY drift (the file
    // shrank, or the section moved), but not always — see the
    // `tauri.ts:1871` historical citation above — so this can only ever be
    // a nudge to go look, not a gate.
    const newWarnings = warnings.filter((w) => !KNOWN_INTENTIONAL_WARNINGS.has(warningKey(w)))
    const knownCount = warnings.length - newWarnings.length
    process.stderr.write(
      `WARNING: citation(s) name a line number beyond the target file’s current length (${knownCount} known-intentional, ${newWarnings.length} new) —\n`,
    )
    process.stderr.write(
      'the cited line may be stale (or deliberately historical). Not a build failure:\n',
    )
    // Same cap-and-tail shape as `newMisses` above: a refactor that shrinks
    // a heavily-cited file (or a mechanical rename sweep) could otherwise
    // dump an unbounded block here.
    const shownWarnings = warnings.slice(0, 50)
    for (const w of shownWarnings) {
      const tag = KNOWN_INTENTIONAL_WARNINGS.has(warningKey(w)) ? 'known-intentional' : 'NEW'
      process.stderr.write(
        `  - ${w.doc} → \`${w.ref}\`  cites line ${w.maxCited}, but the file is only ${w.fileLineCount} line(s) long  (${tag})\n`,
      )
    }
    if (warnings.length > shownWarnings.length) {
      process.stderr.write(`  ...and ${warnings.length - shownWarnings.length} more\n`)
    }
    process.stderr.write('\n')
  }
  return failed ? 1 : 0
}

/**
 * Re-anchor `scripts/doc-code-paths-baseline.json` to the CURRENT raw miss
 * set (unfiltered — the whole point is to recompute what "current" means).
 * An existing entry's `reason` is preserved when its (file, ref) pair is
 * still a miss; a newly-baselined pair gets a generic placeholder reason
 * naming this as the mechanism, so a reviewer can tell an intentionally
 * curated entry from a mechanically re-anchored one.
 *
 * Refuses to write (exit 2) when there is a scan error: a baseline
 * computed from a tree we could not fully read is not trustworthy.
 *
 * Note 5: reads the EXISTING baseline leniently — an unparseable file
 * (e.g. a leftover merge-conflict marker) is treated as empty rather than
 * a hard error, so this is the one path that can actually repair it. `check`
 * never does this (see `readBaseline`'s own comment).
 */
function updateBaseline() {
  const result = computeMisses()
  if (result.exitCode !== undefined) return result.exitCode
  const { misses, scanErrors } = result
  if (scanErrors.length > 0) {
    process.stderr.write(
      'check-doc-code-paths: refusing to write a baseline — file(s) could not be lexed:\n',
    )
    for (const e of scanErrors) {
      process.stderr.write(`  - ${e.file}: ${e.message}\n`)
    }
    return 2
  }
  let existing
  try {
    existing = readBaseline({ lenientOnParseError: true })
  } catch (err) {
    process.stderr.write(`check-doc-code-paths: invocation error: ${err.message}\n`)
    return 2
  }
  const reasonByKey = new Map(existing.map((e) => [baselineKey(e.file, e.ref), e.reason]))
  const entries = misses.map((m) => ({
    file: m.doc,
    ref: m.ref,
    reason:
      reasonByKey.get(baselineKey(m.doc, m.ref)) ??
      (m.kind === 'bare-form'
        ? 'Pre-existing at the #4135 bare-filename-citation widening; not yet fixed.'
        : m.kind === 'partial-root'
          ? 'Pre-existing at the #4184 partially-rooted-citation widening; not yet fixed.'
          : 'Pre-existing at the #4126 .ts/.tsx comment-scan widening; not yet fixed.'),
  }))
  writeBaseline(entries)
  console.log(`OK: wrote ${entries.length} baselined citation(s) to ${BASELINE_FILE}`)
  return 0
}

/**
 * The SECOND working-tree read (#4017): the cited TARGET's existence.
 *
 * `runSourceScenarios` covers the doc BODY — which copy of `README.md` the
 * guard reads. It cannot see this one, because in every one of its fixtures
 * the cited path is absent from both sources. The divergence lives in the
 * `existsSync(join(REPO_ROOT, resolved))` that used to be combined with the
 * tracked-set membership test: a file that is STAGED but has since been
 * removed from the working tree IS in the commit and IS `git ls-files`-
 * visible, and `existsSync` says no.
 *
 * So the pair below is: same fixture, `--worktree` red (the defect — a
 * commit blocked over a citation that is correct in the content being
 * committed), `--cached` green (the fix). Both fixtures are built through
 * the shared scratch guard; nothing here touches the real repository.
 */
function linkTargetScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'link-targets')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'staged-only.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'README.md'), 'The module lives in `src/staged-only.ts`.\n')
    git('add', '-A')
    // Staged, then removed from the working tree WITHOUT a `git rm`. The
    // commit still contains it; `existsSync` still says it is gone.
    rmSync(join(dir, 'src', 'staged-only.ts'))
    const run = (flags) => {
      const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      return { status: r.status, stderr: r.stderr ?? '' }
    }
    const wt = run(['--worktree'])
    const cached = run(['--cached'])
    record(
      'link target: the WORKING TREE reader blocks a citation of a STAGED file (the defect)',
      wt.status === 1 && /staged-only\.ts/.test(wt.stderr),
      `expected 1 naming src/staged-only.ts, got ${wt.status}: ${wt.stderr}`,
    )
    record(
      'link target: the INDEX reader passes it — the path IS in the commit (the fix)',
      cached.status === 0,
      `expected 0, got ${cached.status}: ${cached.stderr}`,
    )
    // …and the guard has not simply stopped judging targets under the index:
    // a citation of a path in NEITHER source is still red.
    writeFileSync(join(dir, 'README.md'), 'See `src/never-existed.ts` for details.\n')
    git('add', '-A')
    const stillRed = run(['--cached'])
    record(
      'link target: a citation of a path in neither source is still red under --cached',
      stillRed.status === 1 && /never-existed\.ts/.test(stillRed.stderr),
      `expected 1 naming src/never-existed.ts, got ${stillRed.status}: ${stillRed.stderr}`,
    )
    return results
  })
}

/**
 * #4126 — the guard also reads `.ts`/`.tsx` COMMENTS, not just markdown.
 * Every assertion here is a fixture in a throwaway repo, run through the
 * real CLI (`--worktree`, so the tracked-set/on-disk pairing above already
 * covers `--cached` vs `--worktree` and this scenario need not repeat it).
 */
function tsCommentScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'ts-comments')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    const run = (flags) => {
      const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      return { status: r.status, stderr: r.stderr ?? '' }
    }
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'real.ts'), 'export const REAL = 1\n')

    // A `//` line comment citing a path missing from the tree is red — the
    // literal shape #4126 asks for.
    writeFileSync(
      join(dir, 'src', 'notes.ts'),
      '// Mirrors the limit in `src/nowhere/deleted-module.ts`.\nexport const LIMIT = 20\n',
    )
    git('add', '-A')
    const lineBad = run(['--worktree'])
    record(
      '.ts `//` comment citing a missing path is red',
      lineBad.status === 1 &&
        /notes\.ts/.test(lineBad.stderr) &&
        /deleted-module\.ts/.test(lineBad.stderr),
      `expected 1 naming src/notes.ts + deleted-module.ts, got ${lineBad.status}: ${lineBad.stderr}`,
    )
    // Fix: retarget the citation at a path that actually exists.
    writeFileSync(
      join(dir, 'src', 'notes.ts'),
      '// Mirrors the limit in `src/real.ts`.\nexport const LIMIT = 20\n',
    )
    git('add', '-A')
    const lineGood = run(['--worktree'])
    record(
      'retargeting the `//` citation at a real path clears it',
      lineGood.status === 0,
      `expected 0, got ${lineGood.status}: ${lineGood.stderr}`,
    )

    // A `/** … */` JSDoc block comment is checked the same way — the actual
    // #4126 defect (tree-utils.ts citing a Rust path the #882 crate split
    // deleted) was a block comment, not a `//` line, so a self-test that
    // only proves line comments would not have caught the real regression.
    writeFileSync(
      join(dir, 'src', 'block.ts'),
      [
        '/**',
        ' * See `src/nowhere/also-deleted.ts` for the Rust mirror.',
        ' */',
        'export const X = 1',
        '',
      ].join('\n'),
    )
    git('add', '-A')
    const blockBad = run(['--worktree'])
    record(
      '.ts `/** */` block comment citing a missing path is red',
      blockBad.status === 1 && /also-deleted\.ts/.test(blockBad.stderr),
      `expected 1 naming also-deleted.ts, got ${blockBad.status}: ${blockBad.stderr}`,
    )
    writeFileSync(
      join(dir, 'src', 'block.ts'),
      ['/**', ' * See `src/real.ts` for the Rust mirror.', ' */', 'export const X = 1', ''].join(
        '\n',
      ),
    )
    git('add', '-A')

    // A path-shaped STRING LITERAL — not a comment — must never be read as
    // a citation. Proves the tokenizer-based comment isolation actually
    // scopes the scan, rather than the guard just grepping the whole file.
    writeFileSync(
      join(dir, 'src', 'literal.ts'),
      "export const P = 'src/nowhere/string-literal-not-a-citation.ts'\n",
    )
    git('add', '-A')
    const literalOk = run(['--worktree'])
    record(
      'a path-shaped STRING LITERAL (not a comment) is not flagged',
      literalOk.status === 0,
      `expected 0, got ${literalOk.status}: ${literalOk.stderr}`,
    )
    return results
  })
}

/**
 * #4135 — a code citation written as a BARE FILENAME with a line number is
 * flagged by FORM, independent of whether anything on disk happens to match
 * it. The fixture uses the issue's own motivating shape (a `.rs` citation
 * with a line RANGE) in a doc, plus the acceptance cases that keep the rule
 * from being noisier than intended: no line number is not flagged, and the
 * rule is wired through the SAME shrink-only baseline mechanism a `missing`
 * miss already uses.
 */
function bareCitationScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'bare-citation')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    const run = (flags) => {
      const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      return { status: r.status, stderr: r.stderr ?? '' }
    }
    mkdirSync(join(dir, 'src-tauri', 'src'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'src', 'session_supervisor.rs'), 'fn f() {}\n')

    // THE ACTUAL #4135 DEFECT SHAPE: a bare filename with a line RANGE, cited
    // from a doc, naming a file that does not even exist under that bare
    // name anywhere in the tree — exactly what `threat-model.md:164` did.
    writeFileSync(
      join(dir, 'README.md'),
      'The handshake retry lives in `session_supervisor.rs:708-716`.\n',
    )
    git('add', '-A')
    const bareBad = run(['--worktree'])
    record(
      'a bare `<file>.rs:<range>` citation is red, even with no on-disk match at all',
      bareBad.status === 1 &&
        /session_supervisor\.rs:708-716/.test(bareBad.stderr) &&
        /bare filename/.test(bareBad.stderr) &&
        /#4135/.test(bareBad.stderr),
      `expected 1 naming session_supervisor.rs:708-716 as a bare-form miss, got ${bareBad.status}: ${bareBad.stderr}`,
    )

    // Retargeting at the real, repo-rooted path clears it — the fix the
    // error message itself recommends.
    writeFileSync(
      join(dir, 'README.md'),
      'The handshake retry lives in `src-tauri/src/session_supervisor.rs:708-716`.\n',
    )
    git('add', '-A')
    const bareFixed = run(['--worktree'])
    record(
      'rewriting the SAME citation as a repo-rooted path clears it',
      bareFixed.status === 0,
      `expected 0, got ${bareFixed.status}: ${bareFixed.stderr}`,
    )

    // ACCEPTANCE: the FORM requires a line-number suffix. A bare filename
    // mention with NO line number is genuinely ambiguous prose ("the file
    // handling the session"), not a precise citation, and must not be
    // flagged — this is the deliberate scoping `BARE_CODE_CITATION_RE`'s own
    // comment argues for, actually exercised.
    writeFileSync(
      join(dir, 'README.md'),
      'See `session_supervisor.rs` for the handshake retry logic.\n',
    )
    git('add', '-A')
    const noLineNumber = run(['--worktree'])
    record(
      'a bare filename with NO line number is not flagged — too ambiguous to be a form violation',
      noLineNumber.status === 0,
      `expected 0, got ${noLineNumber.status}: ${noLineNumber.stderr}`,
    )

    // ACCEPTANCE: the rule is the WHOLE code span, anchored at both ends.
    // Flagging by FORM only works if the form is unambiguous, so the three
    // shapes that most look like one without being one must stay green: a
    // quoted log/diagnostic line that HAPPENS to contain a `file.ext:N`, a
    // URL whose path ends that way, and a `file.ext:LINE:COL` diagnostic
    // coordinate. Without the `^…$` anchors every one of these reds, and the
    // guard becomes the noise generator `BARE_CODE_CITATION_RE`'s own
    // scoping argument is trying to avoid.
    writeFileSync(
      join(dir, 'README.md'),
      [
        'A log line: `panicked at session_supervisor.rs:708, thread main`.',
        '',
        'A URL: `https://github.com/o/r/blob/main/session_supervisor.rs:708`.',
        '',
        'A rustc coordinate: `session_supervisor.rs:708:16`.',
        '',
      ].join('\n'),
    )
    git('add', '-A')
    const notCitations = run(['--worktree'])
    record(
      'a log line, a URL and a `file:LINE:COL` coordinate inside a code span are NOT bare citations',
      notCitations.status === 0,
      `expected 0, got ${notCitations.status}: ${notCitations.stderr}`,
    )

    // THE SAME SHRINK-ONLY BASELINE MECHANISM `missing` misses use also
    // grandfathers a `bare-form` miss — proved both directions, the same
    // discipline `baselineScenarios` applies to the `missing` kind.
    writeFileSync(
      join(dir, 'README.md'),
      'The handshake retry lives in `session_supervisor.rs:708-716`.\n',
    )
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    const baselinePath = join(dir, 'scripts', 'doc-code-paths-baseline.json')
    const writeFixtureBaseline = (entries) =>
      writeFileSync(baselinePath, `${JSON.stringify(entries, null, 2)}\n`)
    writeFixtureBaseline([
      { file: 'README.md', ref: 'session_supervisor.rs:708-716', reason: 'self-test fixture' },
    ])
    git('add', '-A')
    const grandfathered = run(['--worktree'])
    record(
      'a bare-form miss LISTED in the baseline is grandfathered (green)',
      grandfathered.status === 0,
      `expected 0, got ${grandfathered.status}: ${grandfathered.stderr}`,
    )

    writeFixtureBaseline([])
    git('add', '-A')
    const unbaselined = run(['--worktree'])
    record(
      'the SAME bare-form miss, once removed from the baseline, is red again',
      unbaselined.status === 1 && /session_supervisor\.rs:708-716/.test(unbaselined.stderr),
      `expected 1 naming session_supervisor.rs:708-716, got ${unbaselined.status}: ${unbaselined.stderr}`,
    )
    return results
  })
}

/**
 * #4184 — the PARTIALLY-ROOTED middle shape: a citation with a slash but no
 * known `PATH_PREFIX_RE` root, which used to fall between the bare-form gate
 * (forbids a slash) and `isLocalPathCandidate`'s root gate (requires one).
 * Mirrors `bareCitationScenarios` structurally: the OLD guard (this fixture
 * run through a checkout predating the widening would need no baseline entry
 * at all and pass green) vs the NEW guard, proved via the SAME repo-rooted
 * fixture the issue itself names (`pagination/mod.rs:658-668`).
 */
function partiallyRootedCitationScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'partial-root-citation')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    const run = (flags) => {
      const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      return { status: r.status, stderr: r.stderr ?? '' }
    }
    mkdirSync(join(dir, 'src', 'pagination'), { recursive: true })
    writeFileSync(join(dir, 'src', 'pagination', 'mod.rs'), 'fn f() {}\n')

    // THE ACTUAL #4184 DEFECT SHAPE, the issue's own example: a citation with
    // a slash but no known root, naming a file that DOES exist in the tree
    // under a DIFFERENT (repo-rooted) path — this is exactly what made the
    // form invisible to both gates: it isn't bare (has a slash) and isn't
    // repo-rooted (doesn't start with `src/`), so the old guard (equivalent
    // to this same fixture with `PARTIALLY_ROOTED_CODE_CITATION_RE` deleted)
    // passed it silently.
    writeFileSync(
      join(dir, 'README.md'),
      'The cursor pagination logic lives in `pagination/mod.rs:658-668`.\n',
    )
    git('add', '-A')
    const partialBad = run(['--worktree'])
    record(
      'a partially-rooted `<dir>/<file>.rs:<range>` citation (no known root) is red',
      partialBad.status === 1 &&
        /pagination\/mod\.rs:658-668/.test(partialBad.stderr) &&
        /partially-rooted/.test(partialBad.stderr) &&
        /#4184/.test(partialBad.stderr),
      `expected 1 naming pagination/mod.rs:658-668 as a partial-root miss, got ${partialBad.status}: ${partialBad.stderr}`,
    )

    // Retargeting at the real, repo-rooted path clears it — the fix the
    // error message itself recommends, and proof this is a FORM rule (same
    // file, same line range, only the leading root added).
    writeFileSync(
      join(dir, 'README.md'),
      'The cursor pagination logic lives in `src/pagination/mod.rs:658-668`.\n',
    )
    git('add', '-A')
    const partialFixed = run(['--worktree'])
    record(
      'rewriting the SAME citation as a repo-rooted path clears it',
      partialFixed.status === 0,
      `expected 0, got ${partialFixed.status}: ${partialFixed.stderr}`,
    )

    // ACCEPTANCE: a LEGITIMATE citation must still pass — no false positive
    // on an ordinary repo-rooted citation just because this rule was added.
    writeFileSync(
      join(dir, 'README.md'),
      'The cursor pagination logic lives in `src/pagination/mod.rs:658-668`, unchanged from before.\n',
    )
    git('add', '-A')
    const legitimate = run(['--worktree'])
    record(
      'an ordinary repo-rooted citation is unaffected by the new rule (no false positive)',
      legitimate.status === 0,
      `expected 0, got ${legitimate.status}: ${legitimate.stderr}`,
    )

    // ACCEPTANCE: the FORM requires a line-number suffix, exactly like the
    // bare-form rule — a partially-rooted mention with no line number is
    // ambiguous prose, not a precise citation.
    writeFileSync(join(dir, 'README.md'), 'See `pagination/mod.rs` for the cursor logic.\n')
    git('add', '-A')
    const noLineNumber = run(['--worktree'])
    record(
      'a partially-rooted filename with NO line number is not flagged',
      noLineNumber.status === 0,
      `expected 0, got ${noLineNumber.status}: ${noLineNumber.stderr}`,
    )

    // ACCEPTANCE — #4135's own negative controls, re-run against a
    // partially-rooted (not bare) form: a log line, a URL, and a
    // `file:LINE:COL` diagnostic coordinate inside a code span must all stay
    // green, for the identical `^…$`-anchoring reason the bare-form fixture
    // establishes.
    writeFileSync(
      join(dir, 'README.md'),
      [
        'A log line: `panicked at src/pagination/mod.rs:658, thread main`.',
        '',
        'A URL: `https://github.com/o/r/blob/main/pagination/mod.rs:658`.',
        '',
        'A rustc coordinate: `pagination/mod.rs:658:16`.',
        '',
      ].join('\n'),
    )
    git('add', '-A')
    const notCitations = run(['--worktree'])
    record(
      'a log line, a URL and a `file:LINE:COL` coordinate inside a code span are NOT partial-root citations',
      notCitations.status === 0,
      `expected 0, got ${notCitations.status}: ${notCitations.stderr}`,
    )

    // THE SAME SHRINK-ONLY BASELINE MECHANISM the `missing` and `bare-form`
    // kinds use also grandfathers a `partial-root` miss.
    writeFileSync(
      join(dir, 'README.md'),
      'The cursor pagination logic lives in `pagination/mod.rs:658-668`.\n',
    )
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    const baselinePath = join(dir, 'scripts', 'doc-code-paths-baseline.json')
    const writeFixtureBaseline = (entries) =>
      writeFileSync(baselinePath, `${JSON.stringify(entries, null, 2)}\n`)
    writeFixtureBaseline([
      { file: 'README.md', ref: 'pagination/mod.rs:658-668', reason: 'self-test fixture' },
    ])
    git('add', '-A')
    const grandfathered = run(['--worktree'])
    record(
      'a partial-root miss LISTED in the baseline is grandfathered (green)',
      grandfathered.status === 0,
      `expected 0, got ${grandfathered.status}: ${grandfathered.stderr}`,
    )

    writeFixtureBaseline([])
    git('add', '-A')
    const unbaselined = run(['--worktree'])
    record(
      'the SAME partial-root miss, once removed from the baseline, is red again',
      unbaselined.status === 1 && /pagination\/mod\.rs:658-668/.test(unbaselined.stderr),
      `expected 1 naming pagination/mod.rs:658-668, got ${unbaselined.status}: ${unbaselined.stderr}`,
    )
    return results
  })
}

/**
 * #4244 part (b) — the opportunistic line-bounds WARNING. Every assertion
 * here proves the same two things together: the warning fires/does-not-fire
 * on the right shape, AND (the part that actually matters) it never once
 * moves the exit code away from what the miss/baseline machinery alone
 * would have produced — a run with only a warning is still green, and a run
 * that is failing for a real reason still fails with the warning printed
 * alongside it rather than swallowed.
 */
function lineBoundsWarningScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'line-bounds-warning')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    const run = (flags) => {
      const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      return { status: r.status, stderr: r.stderr ?? '' }
    }
    mkdirSync(join(dir, 'src'), { recursive: true })
    // A short, known-length target: exactly 5 lines.
    writeFileSync(
      join(dir, 'src', 'short.ts'),
      'export const A = 1\nexport const B = 2\nexport const C = 3\nexport const D = 4\nexport const E = 5\n',
    )

    // IN-BOUNDS: cites line 3 of a 5-line file — no warning at all.
    writeFileSync(join(dir, 'README.md'), 'See `src/short.ts:3` for the constant.\n')
    git('add', '-A')
    const inBounds = run(['--worktree'])
    record(
      'a citation whose line number is within the target file is not warned about',
      inBounds.status === 0 && !/WARNING/.test(inBounds.stderr),
      `expected 0 with no WARNING, got ${inBounds.status}: ${inBounds.stderr}`,
    )

    // EXACTLY the file's last line: the boundary itself must not warn (only
    // a number STRICTLY GREATER than the length is out of bounds).
    writeFileSync(join(dir, 'README.md'), 'See `src/short.ts:5` for the constant.\n')
    git('add', '-A')
    const atBoundary = run(['--worktree'])
    record(
      'a citation of the file’s EXACT last line is not warned about (off-by-one boundary)',
      atBoundary.status === 0 && !/WARNING/.test(atBoundary.stderr),
      `expected 0 with no WARNING, got ${atBoundary.status}: ${atBoundary.stderr}`,
    )

    // OUT-OF-BOUNDS: cites line 40 of a 5-line file — warns, but the exit
    // code STAYS 0. This is the central claim of #4244 part (b): a
    // deliberately historical citation (the real `tauri.ts:1871` case) must
    // never be reddened by this feature.
    writeFileSync(join(dir, 'README.md'), 'See `src/short.ts:40` for the constant.\n')
    git('add', '-A')
    const outOfBounds = run(['--worktree'])
    record(
      'a citation past the target’s length WARNS but still exits 0 (never a failure)',
      outOfBounds.status === 0 &&
        /WARNING/.test(outOfBounds.stderr) &&
        /short\.ts/.test(outOfBounds.stderr) &&
        /cites line 40/.test(outOfBounds.stderr) &&
        /only 5 line/.test(outOfBounds.stderr),
      `expected 0 with a WARNING naming short.ts/line 40/5 lines, got ${outOfBounds.status}: ${outOfBounds.stderr}`,
    )

    // A RANGE citation is bound-checked on its END (the larger number): the
    // start can be in-bounds while the end drifts past EOF.
    writeFileSync(join(dir, 'README.md'), 'See `src/short.ts:2-40` for the constant.\n')
    git('add', '-A')
    const rangeOutOfBounds = run(['--worktree'])
    record(
      'a RANGE citation whose END exceeds the file length still warns',
      rangeOutOfBounds.status === 0 && /WARNING/.test(rangeOutOfBounds.stderr),
      `expected 0 with a WARNING, got ${rangeOutOfBounds.status}: ${rangeOutOfBounds.stderr}`,
    )

    // THE WARNING NEVER MASKS A REAL FAILURE, and never gets masked BY one:
    // one doc citing a MISSING path (a real failure) and, separately, an
    // out-of-bounds line citation of a file that DOES exist — both must be
    // visible, and the exit code must still be 1 (from the real miss).
    writeFileSync(
      join(dir, 'README.md'),
      'Gone: `src/nowhere/deleted.ts`. Also see `src/short.ts:40` for the constant.\n',
    )
    git('add', '-A')
    const both = run(['--worktree'])
    record(
      'a real miss (exit 1) and an out-of-bounds warning coexist — the warning does not swallow the failure',
      both.status === 1 && /deleted\.ts/.test(both.stderr) && /WARNING/.test(both.stderr),
      `expected 1 naming deleted.ts AND a WARNING, got ${both.status}: ${both.stderr}`,
    )

    // THE REAL #4244 SHAPE: a test asserting the ABSENCE of a deliberately
    // stale doc anchor, past the target file's current length — mirrors
    // `tauri.ts:1871` in `src/lib/__tests__/platform.test.ts` (106 lines) —
    // must warn but stay green, from a `.ts` COMMENT (not a markdown doc),
    // proving the historical citation in the real tree is unaffected by
    // this change. `README.md` is reset first — the previous scenario left
    // it citing a genuinely missing path, and this one must isolate the
    // warning-only case.
    writeFileSync(join(dir, 'README.md'), 'Nothing notable here.\n')
    writeFileSync(join(dir, 'src', 'tauri.ts'), 'export const TAURI = 1\n')
    writeFileSync(
      join(dir, 'src', 'historical.test.ts'),
      '// must NOT carry the stale `src/tauri.ts:1871` doc anchor.\nexport const OK = 1\n',
    )
    git('add', '-A')
    const historical = run(['--worktree'])
    record(
      'the real #4244 historical shape (a stale anchor named for its ABSENCE) warns but stays green',
      historical.status === 0 &&
        /WARNING/.test(historical.stderr) &&
        /tauri\.ts/.test(historical.stderr),
      `expected 0 with a WARNING naming tauri.ts, got ${historical.status}: ${historical.stderr}`,
    )
    return results
  })
}

/**
 * #4126 — the shrink-only baseline. Three assertions, each proving one
 * direction the mechanism must hold:
 *   1. a miss LISTED in the baseline is grandfathered (green);
 *   2. removing it from the baseline turns the SAME miss red again (proves
 *      grandfathering is baseline-driven, not "this citation is somehow
 *      exempt");
 *   3. FIXING the citation while the baseline still names it leaves a
 *      STALE entry, which is also red — the baseline can only shrink.
 */
function baselineScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'baseline')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    const run = (flags) => {
      const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      return { status: r.status, stderr: r.stderr ?? '' }
    }
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'notes.ts'),
      '// Mirrors the limit in `src/nowhere/grandfathered.ts`.\nexport const LIMIT = 20\n',
    )
    const baselinePath = join(dir, 'scripts', 'doc-code-paths-baseline.json')
    const writeFixtureBaseline = (entries) =>
      writeFileSync(baselinePath, `${JSON.stringify(entries, null, 2)}\n`)
    writeFixtureBaseline([
      { file: 'src/notes.ts', ref: 'src/nowhere/grandfathered.ts', reason: 'self-test fixture' },
    ])
    git('add', '-A')

    const grandfathered = run(['--worktree'])
    record(
      'a miss listed in the baseline is grandfathered (green)',
      grandfathered.status === 0,
      `expected 0, got ${grandfathered.status}: ${grandfathered.stderr}`,
    )

    writeFixtureBaseline([])
    git('add', '-A')
    const unbaselined = run(['--worktree'])
    record(
      'the SAME miss, once removed from the baseline, is red again',
      unbaselined.status === 1 && /grandfathered\.ts/.test(unbaselined.stderr),
      `expected 1 naming grandfathered.ts, got ${unbaselined.status}: ${unbaselined.stderr}`,
    )

    // Restore the baseline, then fix the citation on disk — the entry is
    // now STALE (its (file, ref) pair is no longer a miss at all) and must
    // itself be reported, not silently accepted as "still covers nothing".
    writeFixtureBaseline([
      { file: 'src/notes.ts', ref: 'src/nowhere/grandfathered.ts', reason: 'self-test fixture' },
    ])
    writeFileSync(
      join(dir, 'src', 'notes.ts'),
      '// Mirrors the limit in `src/notes.ts` itself.\nexport const LIMIT = 20\n',
    )
    git('add', '-A')
    const stale = run(['--worktree'])
    record(
      'a baseline entry whose miss was fixed is reported as STALE (red)',
      stale.status === 1 && /stale/i.test(stale.stderr) && /grandfathered\.ts/.test(stale.stderr),
      `expected 1 naming a stale entry for grandfathered.ts, got ${stale.status}: ${stale.stderr}`,
    )
    // A failure that is PURELY a stale baseline entry (zero new misses,
    // zero scan errors) must still print the "(judged the …)" source
    // attribution — the same fixture as above already has the guard red on
    // a stale-only cause, so it doubles as this assertion too.
    record(
      'a stale-only failure (no new misses) still prints the judged-source line',
      /\(judged the .+\)/.test(stale.stderr),
      `expected a "(judged the …)" line, got: ${stale.stderr}`,
    )
    return results
  })
}

/**
 * Note 5 — `--update-baseline` must be able to repair a CORRUPT baseline
 * (e.g. an unresolved merge-conflict marker), not just re-anchor a valid
 * one. `check` must still hard-fail on the same corrupt file — treating it
 * as empty belongs to `updateBaseline` alone, never to the read path a
 * normal commit goes through.
 */
function corruptBaselineScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'corrupt-baseline')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    const run = (flags) => {
      const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' }
    }
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'src', 'real.ts'), 'export const REAL = 1\n')
    writeFileSync(
      join(dir, 'README.md'),
      'The pipeline lives in `src/real.ts` today, per `src/nowhere/deleted.ts`.\n',
    )
    const baselinePath = join(dir, 'scripts', 'doc-code-paths-baseline.json')
    // An unresolved merge-conflict marker — unparseable JSON.
    writeFileSync(
      baselinePath,
      '<<<<<<< HEAD\n[]\n=======\n[{"file":"x","ref":"y"}]\n>>>>>>> branch\n',
    )
    git('add', '-A')

    const checkResult = run(['--worktree'])
    record(
      '`check` still hard-fails (exit 2) on an unparseable baseline — never silently empty',
      checkResult.status === 2,
      `expected 2, got ${checkResult.status}: ${checkResult.stderr}`,
    )

    const updateResult = run(['--update-baseline'])
    record(
      '`--update-baseline` treats the SAME corrupt file as empty and repairs it (the fix)',
      updateResult.status === 0,
      `expected 0, got ${updateResult.status}: ${updateResult.stderr}`,
    )

    const rewritten = JSON.parse(readFileSync(baselinePath, 'utf8'))
    record(
      'the repaired baseline re-anchors to the current real miss, discarding the conflict markers',
      Array.isArray(rewritten) &&
        rewritten.length === 1 &&
        rewritten[0].file === 'README.md' &&
        rewritten[0].ref === 'src/nowhere/deleted.ts',
      `expected one entry for README.md → src/nowhere/deleted.ts, got: ${JSON.stringify(rewritten)}`,
    )

    const cleanCheck = run(['--worktree'])
    record(
      '`check` is green afterward — the repaired baseline covers the same miss',
      cleanCheck.status === 0,
      `expected 0, got ${cleanCheck.status}: ${cleanCheck.stderr}`,
    )
    return results
  })
}

// #3962/#4017 — index vs working tree, in throwaway repositories built
// through the shared scratch guard. Every assertion is a PAIR: the source
// that must go red and the source that must stay green on the same fixture.
// A one-sided "the fixed guard fails" would pass just as well against a
// guard that fails on everything.
//
// The fixture doc is `README.md` because that is one of the DOC_ROOTS this
// guard actually scans — a fixture outside the scan set would be green for
// the wrong reason, which is the failure mode under test.
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'doc-code-paths-selftest-'))
  try {
    const results = runSourceScenarios({
      scriptPath: import.meta.filename,
      file: 'README.md',
      badLine: 'The pipeline lives in `src/nowhere/deleted-module.ts` today.',
      goodLine: 'The pipeline lives where the architecture doc says it does.',
      root,
    })
    results.push(...linkTargetScenarios(root))
    results.push(...tsCommentScenarios(root))
    results.push(...bareCitationScenarios(root))
    results.push(...partiallyRootedCitationScenarios(root))
    results.push(...lineBoundsWarningScenarios(root))
    results.push(...baselineScenarios(root))
    results.push(...corruptBaselineScenarios(root))
    let failures = 0
    for (const result of results) {
      if (result.ok) {
        console.log(`  ok   - ${result.name}`)
      } else {
        failures += 1
        console.error(`  FAIL - ${result.name}: ${result.detail}`)
      }
    }
    if (failures > 0) {
      console.error('\nself-test FAILED')
      return 1
    }
    console.log('self-test OK')
    return 0
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  if (process.argv.includes('--update-baseline')) return updateBaseline()
  return check()
}

process.exit(main())
