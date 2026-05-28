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
//   - Extract candidate paths from inline-code spans (`` `path/...` `` —
//     the dominant doc convention) AND from markdown link targets
//     (`[label](relative/path)`).
//   - For each candidate, check whether the path exists. Strip any
//     `#anchor`, `?query`, `:N` line-number suffix before checking.
//   - Skip http(s)://, `mailto:`, anchor-only refs (`#section`), and
//     paths that obviously don't look like file references (no slash
//     and no recognised extension).
//   - Report the first 50 mismatches and exit non-zero.
//
// Exit codes: 0 clean / 1 mismatches / 2 invocation error.

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

const REPO_ROOT = (() => {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
})()

// Tracked-file set lets us reject working-tree-only paths (which would
// silently pass on the author's machine but fail in CI's fresh checkout).
function trackedFiles() {
  try {
    return new Set(
      execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean),
    )
  } catch {
    return null
  }
}

const TRACKED = trackedFiles()

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
const EXCLUDE_PATH_RE = /^docs\/session-log\//

function listMarkdownFiles() {
  if (!TRACKED) {
    return []
  }
  const out = []
  for (const tracked of TRACKED) {
    if (!tracked.endsWith('.md')) continue
    if (EXCLUDE_PATH_RE.test(tracked)) continue
    for (const root of DOC_ROOTS) {
      if (tracked === root || tracked.startsWith(`${root}/`)) {
        out.push(tracked)
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
  if (!TRACKED) {
    console.warn('check-doc-code-paths: not a git repo; skipping.')
    return 0
  }
  const docs = listMarkdownFiles()
  if (docs.length === 0) {
    return 0
  }
  const misses = []
  for (const doc of docs) {
    const abs = join(REPO_ROOT, doc)
    if (!existsSync(abs)) continue
    let body
    try {
      body = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    for (const ref of extractCandidates(body)) {
      const resolved = resolveAgainstDoc(doc, ref)
      const absResolved = join(REPO_ROOT, resolved)
      // Path must exist on disk AND be tracked by git (working-tree-only
      // shadow files would mask a missed `git add`).
      const onDisk = existsSync(absResolved)
      const trackedExact = TRACKED.has(resolved)
      const trackedDir = [...TRACKED].some((t) => t === resolved || t.startsWith(`${resolved}/`))
      if (!onDisk || (!trackedExact && !trackedDir)) {
        misses.push({ doc, ref, resolved, onDisk, tracked: trackedExact || trackedDir })
      }
    }
  }
  if (misses.length === 0) {
    return 0
  }
  const shown = misses.slice(0, 50)
  process.stderr.write('ERROR: doc files reference paths missing from the tracked tree:\n')
  for (const m of shown) {
    process.stderr.write(
      `  - ${m.doc} → \`${m.ref}\`  (resolved: ${m.resolved}, onDisk=${m.onDisk}, tracked=${m.tracked})\n`,
    )
  }
  if (misses.length > shown.length) {
    process.stderr.write(`  ...and ${misses.length - shown.length} more\n`)
  }
  process.stderr.write('\nFix: restore the file, update the reference, or remove the mention.\n')
  return 1
}

process.exit(check())
