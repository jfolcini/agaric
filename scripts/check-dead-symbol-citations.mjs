#!/usr/bin/env node
// #3817 accuracy guard — fail commits that (re)introduce a comment citing a
// Rust symbol that was deleted from the tree. #3817 found ~10 test-tree
// comments instructing readers to call `shared::install_for_test()` to
// drive the production engine path in tests; that function was removed in
// 81fe88b7a (#2249/#2250) when engine state moved from a process-global
// `OnceLock` to an explicit `&LoroState` parameter threaded through every
// `apply_*_via_loro` call. The comments outlived the function they
// described, actively misleading a later session (see #3817).
//
// This is deliberately narrow — the general version ("any doc comment
// citing a symbol that doesn't resolve") needs real Rust name resolution
// to check without a prohibitive false-positive rate, which is out of
// scope here (see #3817's own "optional hardening" note). This guard
// instead pins the ONE class of dead citation that has already recurred:
// word-boundary mentions of `install_for_test` in tracked `.rs` and `.md`
// files. If more deleted symbols accrue stale citations, add them to
// `DEAD_SYMBOLS` below rather than generalising prematurely.
//
// One file is intentionally exempted: the sql_only_fallback module doc
// (`src-tauri/agaric-engine/src/apply/sql_only_fallback.rs`) mentions
// `install_for_test` BY NAME on purpose, in the past tense, as the
// authoritative record of the #2249/#2250 deletion — "It must NOT come
// back." That is the citation this guard exists to keep singular.
//
// Heuristic:
//   - Scan every tracked `*.rs` and `*.md` file, via `git ls-files`
//     (untracked/build files can't hide a violation). `.md` is in scope
//     because the same dead citation had also rotted into the canonical
//     design doc `docs/architecture/sql-only-convergence.md` — prose
//     prescribing a deleted function misleads exactly as much as a code
//     comment does.
//   - Flag any line mentioning a dead symbol as a whole word. The match is
//     word-boundary anchored (not a bare substring) so a future dead symbol
//     that is a substring of a LIVE identifier — e.g. `install_for_test`
//     inside a hypothetical `reinstall_for_testing` — cannot false-positive.
//   - `docs/session-log/**` is excluded: session logs are historical
//     records that legitimately name the symbol in the past tense as an
//     account of what a past session did. Same exclusion the sibling guard
//     `scripts/check-architecture-citations.mjs` uses for its archive.
//   - The one file that legitimately documents the deletion is excluded.
//
// Exit codes: 0 clean / 1 matches found / 2 invocation error.

import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = (() => {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
})()

// This file's own repo-relative path. `scanTargets` below only ever matches
// `*.rs`/`*.md`, so a `.mjs` path can never reach this exclusion today — it
// is defensive-only, in case `scanTargets`'s extension filter is ever
// widened (e.g. to scripts) without anyone remembering this file also
// contains a live citation of the dead symbol by name (see the module doc
// above).
const SELF_PATH = 'scripts/check-dead-symbol-citations.mjs'

// The one file allowed to cite each dead symbol: the historical record of
// its deletion. Keyed by symbol so a future addition can pin its own
// canonical-explanation file independently.
const ALLOWED_FILE_BY_SYMBOL = {
  install_for_test: 'src-tauri/agaric-engine/src/apply/sql_only_fallback.rs',
}

// Symbols deleted from the tree that must not be cited as live elsewhere.
const DEAD_SYMBOLS = Object.keys(ALLOWED_FILE_BY_SYMBOL)

// `docs/session-log/*.md` are archives of past state; a historical session
// legitimately records that it called a since-deleted symbol. Excluded so
// the archive is not rewritten. Mirrors `check-architecture-citations.mjs`.
const EXCLUDE_PATH_RE = /^docs\/session-log\//

// Word-boundary matcher per symbol, so a dead symbol that happens to be a
// substring of a LIVE identifier cannot false-positive. `\b` is correct for
// Rust/JS identifier characters ([A-Za-z0-9_]); the symbol is regex-escaped
// before interpolation so a symbol containing regex metacharacters cannot
// change the pattern's meaning.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
const SYMBOL_RE = new Map(
  DEAD_SYMBOLS.map((symbol) => [symbol, new RegExp(`\\b${escapeRegExp(symbol)}\\b`)]),
)

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    // "not a git repository" is the deliberate fail-open case (e.g. running
    // from an extracted tarball) — skip quietly, exit 0. Anything else (git
    // not installed, permission denied, etc.) is a genuine invocation error
    // and must be reported loudly, not swallowed as if it were "clean".
    const stderr = String(err?.stderr ?? '')
    if (/not a git repository/i.test(stderr)) {
      return null
    }
    throw err
  }
}

function scanTargets(tracked) {
  return tracked.filter((f) => {
    if (f === SELF_PATH) return false
    if (EXCLUDE_PATH_RE.test(f)) return false
    return /\.(rs|md)$/.test(f)
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
    for (const symbol of DEAD_SYMBOLS) {
      if (file === ALLOWED_FILE_BY_SYMBOL[symbol]) continue
      lines.forEach((line, idx) => {
        if (SYMBOL_RE.get(symbol).test(line)) {
          hits.push({ file, lineNo: idx + 1, symbol, text: line.trim() })
        }
      })
    }
  }
  return hits
}

function check() {
  let tracked
  try {
    tracked = trackedFiles()
  } catch (err) {
    process.stderr.write(`check-dead-symbol-citations: invocation error: ${err.message}\n`)
    return 2
  }
  if (tracked === null) {
    console.warn('check-dead-symbol-citations: not a git repo; skipping.')
    return 0
  }
  const hits = findHits(scanTargets(tracked))
  if (hits.length === 0) {
    return 0
  }
  process.stderr.write(
    'ERROR: comment(s) cite a Rust symbol that no longer exists in the tree (#3817):\n',
  )
  for (const hit of hits) {
    process.stderr.write(`  ${hit.file}:${hit.lineNo}: [${hit.symbol}] ${hit.text}\n`)
  }
  process.stderr.write(
    '\nFix: describe the CURRENT mechanism instead (for `install_for_test`, that is a real\n' +
      '`&LoroState` threaded explicitly, plus `sql_only_fallback::count()` delta-zero checks —\n' +
      'see src-tauri/agaric-engine/src/apply/sql_only_fallback.rs for the canonical explanation).\n',
  )
  return 1
}

// Proves the exit-2 invocation-error path (added above) actually fires,
// rather than just existing in source. Spawns this same script as a child
// process with `git` removed from PATH — a genuine invocation error (ENOENT,
// no "not a git repository" stderr), distinct from the deliberate fail-open
// case. Asserts the child exits 2.
function selfTest() {
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
  console.log('self-test OK: git missing from PATH is a genuine invocation error and exits 2.')
  return 0
}

process.exit(process.argv.includes('--self-test') ? selfTest() : check())
