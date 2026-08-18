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
//     `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `pending/`, PLUS every
//     tracked `*.ts` / `*.tsx` file (comments only, see above).
//   - Read each file from the copy the caller is actually judging — the
//     STAGED INDEX during a commit, the WORKING TREE otherwise (#3962,
//     swept here by #4017). `--cached` / `--worktree` force it; with
//     neither, `GIT_INDEX_FILE` (git naming the index it is about to
//     commit) decides. Rationale, the measurements behind the auto rule,
//     and the deletion/unmerged/symlink decisions:
//     scripts/lib/guard-file-source.mjs.
//   - Extract candidate paths from inline-code spans (`` `path/...` `` —
//     the dominant doc AND code-comment convention) AND from markdown link
//     targets (`[label](relative/path)`) in `.md` files.
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

import { execSync, spawnSync } from 'node:child_process'
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
  resolveSource,
  SOURCE_INDEX,
} from './lib/guard-file-source.mjs'
import { ScanError, tokenize } from './lib/js-scanner.mjs'

// cwd-derived, not script-anchored — the documented EXCEPTION to "a guard
// judges the tree that contains it". The rule, the exception, the four guards
// that take it and what to do instead are stated once, in
// `scripts/lib/guard-file-source.mjs` ("Which TREE is judged, and the one
// documented exception").
const REPO_ROOT = (() => {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
})()

// The environment this guard's OWN `git` calls run under. An ambient
// `GIT_INDEX_FILE` outranks `cwd`, so without this an explicit `--cached`
// under somebody else's commit would enumerate that repository while
// `cwd=REPO_ROOT` made it look otherwise — see `gitEnv`.
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

function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return []
  const raw = readFileSync(BASELINE_FILE, 'utf8')
  const parsed = JSON.parse(raw)
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
  const docs = listMarkdownFiles(entries.paths)
  const tsFiles = listTsFiles(entries.paths)
  if (docs.length === 0 && tsFiles.length === 0) {
    return { misses: [], scanErrors: [], chosen }
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
  const judge = (citingFile, text) => {
    for (const ref of extractCandidates(text)) {
      const resolved = resolveAgainstDoc(citingFile, ref)
      const trackedExact = tracked.has(resolved)
      const trackedDir = [...tracked].some((t) => t === resolved || t.startsWith(`${resolved}/`))
      const isTracked = trackedExact || trackedDir
      // The index IS the answer to "will this path exist in the commit", so
      // under `--cached` the tracked set alone decides. Under `--worktree`
      // the path must ALSO be on disk, which is what catches a tracked file
      // deleted from the working tree without a `git rm` (see the header).
      const onDisk = chosen.source === SOURCE_INDEX ? null : existsSync(join(REPO_ROOT, resolved))
      if (!isTracked || onDisk === false) {
        misses.push({ doc: citingFile, ref, resolved, onDisk, tracked: isTracked })
      }
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
  return { misses, scanErrors, chosen }
}

function check() {
  const result = computeMisses()
  if (result.exitCode !== undefined) return result.exitCode
  const { misses, scanErrors, chosen } = result

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

  if (newMisses.length === 0 && staleEntries.length === 0 && scanErrors.length === 0) {
    return 0
  }
  // Name the source with the verdict. A red the author cannot reproduce by
  // opening the file is otherwise indistinguishable from a broken guard.
  if (newMisses.length > 0) {
    const shown = newMisses.slice(0, 50)
    process.stderr.write(
      'ERROR: doc/comment citations reference paths missing from the tracked tree:\n',
    )
    process.stderr.write(`  (judged the ${describeSource(chosen.source)} — ${chosen.why})\n`)
    for (const m of shown) {
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
  return 1
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
    existing = readBaseline()
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
      'Pre-existing at the #4126 .ts/.tsx comment-scan widening; not yet fixed.',
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
    results.push(...baselineScenarios(root))
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
