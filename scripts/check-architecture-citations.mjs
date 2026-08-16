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
//   - Read each file from the copy the caller is actually judging — the
//     STAGED INDEX during a commit, the WORKING TREE otherwise (#3962).
//     `--cached` / `--worktree` force it; with neither, `GIT_INDEX_FILE`
//     (git naming the index it is about to commit) decides. Reading the
//     working tree unconditionally, as this guard used to, let a staged
//     violation pass whenever the author fixed it on disk without
//     `git add`. Rationale, the measurements behind the auto rule, and the
//     deletion/unmerged/symlink decisions: scripts/lib/guard-file-source.mjs.
//   - Flag any line containing `ARCHITECTURE.md` followed (optionally
//     whitespace-separated) by the section-mark character. The mark is
//     built at runtime via `String.fromCharCode(0xA7)` rather than typed
//     literally, so this guard's own source text can never accidentally
//     trip its own regex.
//   - `docs/session-log/**` is excluded — those are historical records
//     that legitimately reference the old numbered-section structure.
//   - This script's own path is excluded too, belt-and-suspenders with the
//     runtime-built mark above.
//   - `git ls-files` failing with "not a git repository" (e.g. running from
//     an extracted tarball) is the deliberate fail-open case: skip quietly,
//     exit 0. Any OTHER `git ls-files` failure (git missing, permission
//     denied, ENOBUFS, ...) is a genuine invocation error and is re-thrown,
//     exiting 2 with the cause named — it must never be swallowed into a
//     silent "clean". `--self-test` spawns this script with `git` stripped
//     from PATH and asserts that. Mirrors
//     scripts/check-dead-symbol-citations.mjs's equivalent guard exactly.
//
// Usage:
//   node scripts/check-architecture-citations.mjs              # auto source
//   node scripts/check-architecture-citations.mjs --cached     # staged index
//   node scripts/check-architecture-citations.mjs --worktree   # working tree
//   node scripts/check-architecture-citations.mjs --print-source
//   node scripts/check-architecture-citations.mjs --self-test
//
// Any OTHER argument is a usage error, not a silently ignored one: a
// mistyped `--cache` that resolved to AUTO would judge a copy the caller did
// not ask for, and say nothing about it.
//
// Exit codes: 0 clean / 1 matches found / 2 invocation error.

import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSourceScenarios } from './lib/git-scratch-guard.mjs'
import {
  describeSource,
  listTrackedEntries,
  readContents,
  resolveSource,
} from './lib/guard-file-source.mjs'

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

// Enumeration, the `git ls-files` maxBuffer ceiling and the
// "not a git repository" fail-open all moved to
// `scripts/lib/guard-file-source.mjs` in #3962, so this guard and
// `scripts/check-dead-symbol-citations.mjs` cannot drift apart on any of
// them — they used to hold hand-kept copies annotated "kept in step with"
// each other, which is the arrangement that lets them stop being in step.

function scanTargets(tracked) {
  return tracked.filter((f) => {
    if (EXCLUDE_PATH_RE.test(f)) return false
    if (f === SELF_PATH) return false
    return /\.(md|rs|ts|tsx)$/.test(f)
  })
}

function findHits(files, bodies) {
  const hits = []
  for (const file of files) {
    const body = bodies.get(file)
    if (body === undefined) continue
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
  let chosen
  try {
    chosen = resolveSource(process.argv, process.env, {
      // This guard's own flags, declared so an argument that is neither
      // these nor a source flag is a usage error rather than a silent AUTO.
      extraFlags: ['--print-source', '--self-test'],
    })
  } catch (err) {
    process.stderr.write(`check-architecture-citations: invocation error: ${err.message}\n`)
    return 2
  }
  // Diagnostic: answer "which copy would you judge right now?" without
  // scanning anything, so the mechanism can be inspected from a shell as
  // easily as from this file's header.
  if (process.argv.includes('--print-source')) {
    console.log(`check-architecture-citations: ${describeSource(chosen.source)} (${chosen.why})`)
    return 0
  }
  let entries
  try {
    entries = listTrackedEntries(REPO_ROOT)
  } catch (err) {
    process.stderr.write(`check-architecture-citations: invocation error: ${err.message}\n`)
    return 2
  }
  if (entries === null) {
    console.warn('check-architecture-citations: not a git repo; skipping.')
    return 0
  }
  const targets = scanTargets(entries.paths)
  let bodies
  try {
    bodies = readContents(targets, { repoRoot: REPO_ROOT, source: chosen.source, entries })
  } catch (err) {
    process.stderr.write(`check-architecture-citations: invocation error: ${err.message}\n`)
    return 2
  }
  const hits = findHits(targets, bodies)
  if (hits.length === 0) {
    return 0
  }
  process.stderr.write(
    'ERROR: stale numbered-section citation(s) into docs/ARCHITECTURE.md — that file has no ' +
      'numbered sections anymore (it was split into docs/architecture/*.md; see its own "Map" ' +
      'section):\n',
  )
  // Name the source with the verdict. A red the author cannot reproduce by
  // opening the file is otherwise indistinguishable from a broken guard.
  process.stderr.write(`  (judged the ${describeSource(chosen.source)} — ${chosen.why})\n`)
  for (const hit of hits) {
    process.stderr.write(`  ${hit.file}:${hit.lineNo}: ${hit.text}\n`)
  }
  process.stderr.write(
    '\nFix: retarget the citation to the concrete split file + heading, e.g. ' +
      '`docs/architecture/<file>.md § <Heading>`.\n',
  )
  return 1
}

// Proves the exit-2 invocation-error path (added above) actually fires,
// rather than just existing in source. Spawns this same script as a child
// process with `git` removed from PATH — a genuine invocation error (ENOENT,
// no "not a git repository" stderr), distinct from the deliberate fail-open
// case. Asserts the child exits 2. Mirrors
// scripts/check-dead-symbol-citations.mjs's self-test.
function invocationErrorTest() {
  const result = spawnSync(process.execPath, [import.meta.filename], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  })
  if (result.status !== 2) {
    console.error(
      `self-test FAILED: expected exit 2 with \`git\` missing from PATH, got ${result.status}\n` +
        `  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
    )
    return 1
  }
  if (!/invocation error/.test(result.stderr)) {
    console.error(
      `self-test FAILED: exit was 2 but stderr didn't name it an invocation error:\n${result.stderr}`,
    )
    return 1
  }
  console.log('  ok   - git missing from PATH is a genuine invocation error and exits 2')
  return 0
}

// #3962 — index vs working tree, in throwaway repositories built through the
// shared scratch guard. Every assertion is a PAIR: the source that must go
// red and the source that must stay green on the same fixture. A one-sided
// "the fixed guard fails" would pass just as well against a guard that fails
// on everything.
//
// The fixture citation is assembled from `SECTION_MARK` at runtime, exactly
// as `CITATION_RE` is, so this file's own source text still cannot contain
// the sequence it searches for.
function sourceTest() {
  const root = mkdtempSync(join(tmpdir(), 'architecture-citations-selftest-'))
  try {
    const results = runSourceScenarios({
      scriptPath: import.meta.filename,
      file: 'notes.md',
      badLine: `See docs/ARCHITECTURE.md ${SECTION_MARK}7 for the block model.`,
      goodLine: 'See docs/architecture/blocks.md — Block model.',
      root,
    })
    let failures = 0
    for (const result of results) {
      if (result.ok) {
        console.log(`  ok   - ${result.name}`)
      } else {
        failures += 1
        console.error(`  FAIL - ${result.name}: ${result.detail}`)
      }
    }
    return failures === 0 ? 0 : 1
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function selfTest() {
  const failed = invocationErrorTest() + sourceTest()
  if (failed > 0) {
    console.error('\nself-test FAILED')
    return 1
  }
  console.log('self-test OK')
  return 0
}

process.exit(process.argv.includes('--self-test') ? selfTest() : check())
