#!/usr/bin/env node
// docs-2546 accuracy guard — fail commits that reintroduce a stale
// numbered-section citation into `docs/ARCHITECTURE.md`. That file used to
// be a big numbered-section document; it was split into
// `docs/architecture/*.md` and is now a short index (see its own "Map"
// section) with no numbered sections at all. Any `ARCHITECTURE.md` +
// section-mark reference in tracked source/doc files is therefore a dead
// pointer — retarget it to the concrete split file + heading instead
// (`docs/architecture/<file>.md <mark> <Heading>`).
//
// Heuristic:
//   - Scan every tracked `*.md`, `*.rs`, `*.ts`, `*.tsx` file, discovered
//     via `git ls-files` so untracked/build files can't hide a violation.
//   - Flag any line containing `ARCHITECTURE.md` followed (optionally
//     whitespace-separated) by the section-mark character. The mark is
//     built at runtime via `String.fromCharCode(0xA7)` rather than typed
//     literally, so this guard's own source text can never accidentally
//     trip its own regex.
//   - `docs/session-log/**` is excluded — those are historical records
//     that legitimately reference the old numbered-section structure.
//   - This script's own path is excluded too, belt-and-suspenders with the
//     runtime-built mark above.
//
// Exit codes: 0 clean / 1 matches found / 2 invocation error.

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = (() => {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
})()

// This file's own repo-relative path — excluded from the scan.
const SELF_PATH = 'scripts/check-architecture-citations.mjs'

// `docs/session-log/*.md` are archives of past state; historical sessions
// legitimately cite the old numbered-section structure of ARCHITECTURE dot
// md and should not be rewritten.
const EXCLUDE_PATH_RE = /^docs\/session-log\//

// Section-mark character ('section sign', U+00A7), built at runtime so the
// guard's own source never contains the literal sequence it searches for.
const SECTION_MARK = String.fromCharCode(0xa7)
const CITATION_RE = new RegExp(`ARCHITECTURE\\.md\\s*${SECTION_MARK}`)

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return null
  }
}

function scanTargets(tracked) {
  return tracked.filter((f) => {
    if (EXCLUDE_PATH_RE.test(f)) return false
    if (f === SELF_PATH) return false
    return /\.(md|rs|ts|tsx)$/.test(f)
  })
}

function findHits(files) {
  const hits = []
  for (const file of files) {
    const abs = join(REPO_ROOT, file)
    let body
    try {
      body = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const lines = body.split('\n')
    lines.forEach((line, idx) => {
      if (CITATION_RE.test(line)) {
        hits.push({ file, lineNo: idx + 1, text: line.trim() })
      }
    })
  }
  return hits
}

function check() {
  const tracked = trackedFiles()
  if (tracked === null) {
    console.warn('check-architecture-citations: not a git repo; skipping.')
    return 0
  }
  const hits = findHits(scanTargets(tracked))
  if (hits.length === 0) {
    return 0
  }
  process.stderr.write(
    'ERROR: stale numbered-section citation(s) into docs/ARCHITECTURE.md — that file has no ' +
      'numbered sections anymore (it was split into docs/architecture/*.md; see its own "Map" ' +
      'section):\n',
  )
  for (const hit of hits) {
    process.stderr.write(`  ${hit.file}:${hit.lineNo}: ${hit.text}\n`)
  }
  process.stderr.write(
    '\nFix: retarget the citation to the concrete split file + heading, e.g. ' +
      '`docs/architecture/<file>.md § <Heading>`.\n',
  )
  return 1
}

process.exit(check())
