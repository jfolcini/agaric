#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tracked-file markdown link integrity check.
//
// For every tracked .md file in the repo, find every relative-path
// link of the form `[text](relative/path[#anchor])` and verify the
// target path is ALSO tracked by git. Catches the failure mode where
// a file is removed from history (e.g. via filter-repo, then
// .gitignore'd) but references to it remain in committed docs.
//
// Why this is separate from lychee: lychee resolves relative file
// links against the working tree, so an UNTRACKED on-disk copy of
// the target shadows the gap and the local pre-commit run passes.
// CI's checkout doesn't have the untracked copy, so lychee fails
// there. This script asks `git ls-files` instead, matching CI.
//
// Originally added after `REVIEW-LATER.md` was filter-repo'd out of
// history but two committed Markdown links to it (in ARCHITECTURE.md
// §19 and CONTRIBUTING.md "Before you start") remained — caught
// only by the 0.1.0 release-time lychee run.
//
// Skipped link types: URL schemes (`http://`, `mailto:`, …),
// pure anchors (`#section`), and anything whose path resolves to a
// `.gitignore`-d directory (`node_modules/`, `dist/`, `target/`, …)
// — those are owned by tooling, not by us.
//
// Usage: `node scripts/check-md-link-targets.mjs`
// Exit: 0 = clean, 1 = at least one untracked target.
// ─────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ─── 1. List of tracked files (lookup table) ─────────────────────────
const trackedFiles = new Set(
  execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean),
)

// ─── 2. Markdown files to scan ───────────────────────────────────────
const mdFiles = execSync('git ls-files "*.md"', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

// ─── 3. Walk every link and verify ───────────────────────────────────
//
// Match `](href)` where href is non-empty and contains no whitespace
// inside the parens. We strip surrounding `<>` (for autolinks) and an
// optional title after the URL (`](href "title")`). The title syntax
// is rare in this repo but the tolerant parse keeps us out of trouble.
const LINK_RE = /\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g

const failures = []

// Replace fenced code blocks and inline code spans with whitespace
// of the same length so absolute character offsets stay stable but
// markdown-syntax-as-documentation (e.g. `[text](url)` inside a
// table cell explaining link syntax) doesn't trip the link regex.
function stripCode(src) {
  return src
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
}

for (const md of mdFiles) {
  const fileSrc = fs.readFileSync(path.join(ROOT, md), 'utf8')
  const stripped = stripCode(fileSrc)
  const dir = path.dirname(md)

  for (const match of stripped.matchAll(LINK_RE)) {
    const href = match[1]

    // External URL? Skip — lychee covers those.
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href)) continue
    // Pure anchor inside the same file? Skip.
    if (href.startsWith('#')) continue
    // Strip fragment / query (lychee handles fragments separately).
    const pathOnly = href.replace(/[#?].*$/, '')
    if (!pathOnly) continue

    // Resolve relative to the markdown file's directory.
    const resolved = path.posix.normalize(path.posix.join(dir, pathOnly))

    // Out-of-tree (`../` past the repo root) — not our problem.
    if (resolved.startsWith('..')) continue
    // Already known not to be a file (link points at a directory) —
    // git ls-files won't list directories, so verify either the
    // exact path OR an `index.md` / README inside it.
    if (
      trackedFiles.has(resolved) ||
      trackedFiles.has(`${resolved}/index.md`) ||
      trackedFiles.has(`${resolved}/README.md`)
    ) {
      continue
    }

    // The target may be a directory implicitly listed via its files;
    // check if any tracked file lives under that prefix.
    const dirPrefix = `${resolved}/`
    let isDirHit = false
    for (const tracked of trackedFiles) {
      if (tracked.startsWith(dirPrefix)) {
        isDirHit = true
        break
      }
    }
    if (isDirHit) continue

    failures.push({ source: md, link: href, resolved })
  }
}

// ─── 4. Report ───────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('ERROR: tracked Markdown files link to paths not tracked by git:')
  for (const f of failures) {
    console.error(`  ${f.source} → ${f.link}  (resolves to ${f.resolved})`)
  }
  console.error('')
  console.error(
    'Either restore the target file (git restore / re-add to tracking), update the link to point',
  )
  console.error(
    'at the new home, or remove the broken reference. Lychee in CI catches these eventually,',
  )
  console.error(
    'but only after a fresh checkout — local lychee runs see untracked working-tree copies and pass.',
  )
  process.exit(1)
}

console.log(`OK: ${mdFiles.length} tracked .md files have no broken intra-repo links.`)
process.exit(0)
