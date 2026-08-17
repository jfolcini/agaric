#!/usr/bin/env node
// ui-improvements 2026-05-16 §Maintenance / tooling — fail commits where a
// doc file cites a `src/…` (or `src-tauri/…`, `scripts/…`, `e2e/…`,
// `docs/architecture/…`) path that no longer exists in the working tree
// + git index. Many of the AGENTS.md / docs/* manual audit findings would
// be auto-caught by this; cheap to run.
//
// Heuristic:
//   - Scan every tracked `*.md` file under `docs/`, the repo root,
//     `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `pending/`.
//   - Read each doc from the copy the caller is actually judging — the
//     STAGED INDEX during a commit, the WORKING TREE otherwise (#3962,
//     swept here by #4017). `--cached` / `--worktree` force it; with
//     neither, `GIT_INDEX_FILE` (git naming the index it is about to
//     commit) decides. Rationale, the measurements behind the auto rule,
//     and the deletion/unmerged/symlink decisions:
//     scripts/lib/guard-file-source.mjs.
//   - Extract candidate paths from inline-code spans (`` `path/...` `` —
//     the dominant doc convention) AND from markdown link targets
//     (`[label](relative/path)`).
//   - For each candidate, check whether the path exists IN THAT SAME
//     SOURCE. Strip any `#anchor`, `?query`, `:N` line-number suffix
//     before checking.
//   - Skip http(s)://, `mailto:`, anchor-only refs (`#section`), and
//     paths that obviously don't look like file references (no slash
//     and no recognised extension).
//   - Report the first 50 mismatches and exit non-zero.
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
//
// Any OTHER argument is a usage error, not a silently ignored one: a
// mistyped `--cache` that resolved to AUTO would judge a copy the caller did
// not ask for, and say nothing about it.
//
// Exit codes: 0 clean / 1 mismatches / 2 invocation error.

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  // Strip anchor / query / line-number suffixes.
  const cleaned = raw
    .split('#')[0]
    .split('?')[0]
    .replace(/:\d+(?:-\d+)?$/, '')
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

function check() {
  let chosen
  try {
    chosen = resolveSource(process.argv, process.env, {
      // This guard's own flags, declared so an argument that is neither
      // these nor a source flag is a usage error rather than a silent AUTO.
      extraFlags: ['--print-source', '--self-test'],
      // AUTO must know whose index `GIT_INDEX_FILE` names, not merely that it
      // is set — see `resolveSource`.
      repoRoot: REPO_ROOT,
    })
  } catch (err) {
    process.stderr.write(`check-doc-code-paths: invocation error: ${err.message}\n`)
    return 2
  }
  if (process.argv.includes('--print-source')) {
    console.log(`check-doc-code-paths: ${describeSource(chosen.source)} (${chosen.why})`)
    return 0
  }
  let entries
  try {
    entries = listTrackedEntries(REPO_ROOT, { env: GIT_ENV })
  } catch (err) {
    process.stderr.write(`check-doc-code-paths: invocation error: ${err.message}\n`)
    return 2
  }
  if (entries === null) {
    console.warn('check-doc-code-paths: not a git repo; skipping.')
    return 0
  }
  const tracked = new Set(entries.paths)
  const docs = listMarkdownFiles(entries.paths)
  if (docs.length === 0) {
    return 0
  }
  let bodies
  try {
    bodies = readContents(docs, {
      repoRoot: REPO_ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    })
  } catch (err) {
    process.stderr.write(`check-doc-code-paths: invocation error: ${err.message}\n`)
    return 2
  }
  const misses = []
  for (const doc of docs) {
    // `=== undefined`, never a truthiness test: a zero-byte doc reads as
    // `''` and must count as READ, not as skipped. See `readContents`.
    const body = bodies.get(doc)
    if (body === undefined) continue
    for (const ref of extractCandidates(body)) {
      const resolved = resolveAgainstDoc(doc, ref)
      const trackedExact = tracked.has(resolved)
      const trackedDir = [...tracked].some((t) => t === resolved || t.startsWith(`${resolved}/`))
      const isTracked = trackedExact || trackedDir
      // The index IS the answer to "will this path exist in the commit", so
      // under `--cached` the tracked set alone decides. Under `--worktree`
      // the path must ALSO be on disk, which is what catches a tracked file
      // deleted from the working tree without a `git rm` (see the header).
      const onDisk = chosen.source === SOURCE_INDEX ? null : existsSync(join(REPO_ROOT, resolved))
      if (!isTracked || onDisk === false) {
        misses.push({ doc, ref, resolved, onDisk, tracked: isTracked })
      }
    }
  }
  if (misses.length === 0) {
    return 0
  }
  const shown = misses.slice(0, 50)
  process.stderr.write('ERROR: doc files reference paths missing from the tracked tree:\n')
  // Name the source with the verdict. A red the author cannot reproduce by
  // opening the file is otherwise indistinguishable from a broken guard.
  process.stderr.write(`  (judged the ${describeSource(chosen.source)} — ${chosen.why})\n`)
  for (const m of shown) {
    const onDisk = m.onDisk === null ? 'n/a' : String(m.onDisk)
    process.stderr.write(
      `  - ${m.doc} → \`${m.ref}\`  (resolved: ${m.resolved}, onDisk=${onDisk}, tracked=${m.tracked})\n`,
    )
  }
  if (misses.length > shown.length) {
    process.stderr.write(`  ...and ${misses.length - shown.length} more\n`)
  }
  process.stderr.write('\nFix: restore the file, update the reference, or remove the mention.\n')
  return 1
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

process.exit(process.argv.includes('--self-test') ? selfTest() : check())
