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
// KNOWN COVERAGE GAP — state it rather than imply the sweep is complete.
// #2249/#2250 deleted `shared::get()` and `shared::init()` alongside
// `install_for_test`, and stale citations of those two recur just as often
// (#3959's review found one in `snapshot.rs`, and a follow-up sweep found
// three more in `session_state_machine.rs`, `create_edit_convergence_tests.rs`
// and `sync_daemon/tests.rs`). They are NOT in `DEAD_SYMBOLS` and cannot
// usefully be: this guard matches on the bare symbol name with `\b`
// boundaries, and `get` / `init` are ubiquitous live identifiers, so adding
// them would fire on essentially every file. Matching the qualified path
// (`shared::get`) instead would miss the real citations, which are prose
// (`... via `shared::get()``) and intra-doc links
// (`[`agaric_engine::loro::shared::get`]`) written many different ways.
// So: this hook covers `install_for_test` and nothing else. Dead citations
// of the sibling symbols are caught by review, not by CI.
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
//   - Each file is read from the copy the caller is actually judging — the
//     STAGED INDEX during a commit, the WORKING TREE otherwise (#3962).
//     `--cached` / `--worktree` force it; with neither, `GIT_INDEX_FILE`
//     (git naming the index it is about to commit) decides. Reading the
//     working tree unconditionally, as this guard used to, let a staged
//     citation pass whenever the author fixed it on disk without
//     `git add`. Rationale, the measurements behind the auto rule, and the
//     deletion/unmerged/symlink decisions: scripts/lib/guard-file-source.mjs.
//
// Usage:
//   node scripts/check-dead-symbol-citations.mjs              # auto source
//   node scripts/check-dead-symbol-citations.mjs --cached     # staged index
//   node scripts/check-dead-symbol-citations.mjs --worktree   # working tree
//   node scripts/check-dead-symbol-citations.mjs --print-source
//
// Any OTHER argument is a usage error, not a silently ignored one: a
// mistyped `--cache` that resolved to AUTO would judge a copy the caller did
// not ask for, and say nothing about it.
//
// Exit codes: 0 clean / 1 matches found / 2 invocation error.

import {
  describeSource,
  gitEnv,
  listTrackedEntries,
  readContents,
  repoRootFromCwd,
  resolveSource,
} from './lib/guard-file-source.mjs'

// cwd-derived, not script-anchored — the documented EXCEPTION to "a guard judges
// the tree that contains it", taken through the SHARED `repoRootFromCwd` rather
// than a private `show-toplevel` (#4192: a private copy asked git under the
// ambient environment, where a leaked git context redirects the root itself).
// The rule, the exception, the five guards that take it and what to do instead
// are stated once, in `scripts/lib/guard-file-source.mjs` ("Which TREE is
// judged, and the one documented exception").
const REPO_ROOT = repoRootFromCwd()

// The environment this guard's OWN `git` calls run under. An ambient
// `GIT_INDEX_FILE` outranks `cwd` for the INDEX and an ambient `GIT_DIR`
// outranks it for the REPOSITORY (#4191), so without this a leaked git
// context would enumerate somebody else's tree — under `--worktree` as
// readily as `--cached` — while `cwd=REPO_ROOT` made it look otherwise. See
// `gitEnv`.
const GIT_ENV = gitEnv(REPO_ROOT, process.env)

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
//
// This map (plus `EXCLUDE_PATH_RE` below) is the ONLY sanctioned exemption.
// Files outside the scan set are not exempt, they are merely unreachable —
// a distinction that matters because it evaporates the moment `scanTargets`
// widens. `prek.toml`, which documents this hook, therefore does not name the
// symbol at all rather than leaning on `.toml` being unscanned; keep it that
// way, or allowlist it here if it ever needs the name back.
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

// Enumeration, the `git ls-files` maxBuffer ceiling and the
// "not a git repository" fail-open all moved to
// `scripts/lib/guard-file-source.mjs` in #3962, so this guard and
// `scripts/check-architecture-citations.mjs` cannot drift apart on any of
// them — they used to hold hand-kept copies annotated "should stay in step"
// with each other, which is the arrangement that lets them stop being in
// step.

function scanTargets(tracked) {
  return tracked.filter((f) => {
    if (f === SELF_PATH) return false
    if (EXCLUDE_PATH_RE.test(f)) return false
    return /\.(rs|md)$/.test(f)
  })
}

function findHits(files, bodies) {
  const hits = []
  for (const file of files) {
    const body = bodies.get(file)
    if (body === undefined) continue
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
  let chosen
  try {
    chosen = resolveSource(process.argv, process.env, {
      // This guard's own flags, declared so an argument that is neither
      // these nor a source flag is a usage error rather than a silent AUTO.
      extraFlags: ['--print-source'],
      // AUTO must know whose index `GIT_INDEX_FILE` names, not merely that it
      // is set — see `resolveSource`.
      repoRoot: REPO_ROOT,
    })
  } catch (err) {
    process.stderr.write(`check-dead-symbol-citations: invocation error: ${err.message}\n`)
    return 2
  }
  // Diagnostic: answer "which copy would you judge right now?" without
  // scanning anything, so the mechanism can be inspected from a shell as
  // easily as from this file's header.
  if (process.argv.includes('--print-source')) {
    console.log(`check-dead-symbol-citations: ${describeSource(chosen.source)} (${chosen.why})`)
    return 0
  }
  let entries
  try {
    entries = listTrackedEntries(REPO_ROOT, { env: GIT_ENV })
  } catch (err) {
    process.stderr.write(`check-dead-symbol-citations: invocation error: ${err.message}\n`)
    return 2
  }
  if (entries === null) {
    console.warn('check-dead-symbol-citations: not a git repo; skipping.')
    return 0
  }
  const targets = scanTargets(entries.paths)
  let bodies
  try {
    bodies = readContents(targets, {
      repoRoot: REPO_ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    })
  } catch (err) {
    process.stderr.write(`check-dead-symbol-citations: invocation error: ${err.message}\n`)
    return 2
  }
  const hits = findHits(targets, bodies)
  if (hits.length === 0) {
    return 0
  }
  process.stderr.write(
    'ERROR: comment(s) cite a Rust symbol that no longer exists in the tree (#3817):\n',
  )
  // Name the source with the verdict. A red the author cannot reproduce by
  // opening the file is otherwise indistinguishable from a broken guard.
  process.stderr.write(`  (judged the ${describeSource(chosen.source)} — ${chosen.why})\n`)
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
