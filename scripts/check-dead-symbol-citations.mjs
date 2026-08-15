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
// literal mentions of `install_for_test` in tracked `.rs` files. If more
// deleted symbols accrue stale citations, add them to `DEAD_SYMBOLS` below
// rather than generalising prematurely.
//
// One file is intentionally exempted: the sql_only_fallback module doc
// (`src-tauri/agaric-engine/src/apply/sql_only_fallback.rs`) mentions
// `install_for_test` BY NAME on purpose, in the past tense, as the
// authoritative record of the #2249/#2250 deletion — "It must NOT come
// back." That is the citation this guard exists to keep singular.
//
// Heuristic:
//   - Scan every tracked `*.rs` file, via `git ls-files` (untracked/build
//     files can't hide a violation).
//   - Flag any line containing a dead symbol's literal text.
//   - The one file that legitimately documents the deletion is excluded.
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

// This file's own repo-relative path — excluded from the scan so its
// documentation above can name the symbol without tripping itself.
const SELF_PATH = 'scripts/check-dead-symbol-citations.mjs'

// The one file allowed to cite each dead symbol: the historical record of
// its deletion. Keyed by symbol so a future addition can pin its own
// canonical-explanation file independently.
const ALLOWED_FILE_BY_SYMBOL = {
  install_for_test: 'src-tauri/agaric-engine/src/apply/sql_only_fallback.rs',
}

// Symbols deleted from the tree that must not be cited as live elsewhere.
const DEAD_SYMBOLS = Object.keys(ALLOWED_FILE_BY_SYMBOL)

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
  return tracked.filter((f) => f !== SELF_PATH && f.endsWith('.rs'))
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
        if (line.includes(symbol)) {
          hits.push({ file, lineNo: idx + 1, symbol, text: line.trim() })
        }
      })
    }
  }
  return hits
}

function check() {
  const tracked = trackedFiles()
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

process.exit(check())
