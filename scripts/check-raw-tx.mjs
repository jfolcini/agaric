#!/usr/bin/env node
// Guard against NEW raw write-transaction sites in production Rust (#110).
//
// #110 replaced ad-hoc `pool.begin_with("BEGIN IMMEDIATE")` write
// transactions on user-edit paths with the `CommandTx` convention (open via
// `crate::db::begin_immediate_logged`, couple the commit with post-commit
// materializer dispatch). This flags any new raw write-tx opened outside the
// audited allowlist or the per-site escape hatch.
//
// prek passes the changed files as arguments (hook `check-raw-tx`). Over the
// whole tree:
//
//     node scripts/check-raw-tx.mjs $(git ls-files 'src-tauri/**/*.rs')
//
// Rules, per .rs file under a crate root (`CRATE_ROOTS`):
//   * Any `begin_with(` (whatever its argument, so a const-hoisted
//     `"BEGIN IMMEDIATE"` cannot evade it, #818) or `begin_immediate_logged(`
//     is a raw write-tx site, except on the line defining
//     `pub async fn begin_immediate_logged`.
//   * #653: a bare `.begin(` (sqlx's default, BEGIN DEFERRED) is flagged only
//     in a file that also calls `append_local_op_in_tx` /
//     `append_local_undo_op_in_tx`. Their `SELECT MAX(seq)+1` then `INSERT`
//     races to SQLITE_BUSY_SNAPSHOT under a deferred tx, and would compile
//     clean. Read-only `.begin()` elsewhere stays legitimate.
//   * The scan runs over comment- and literal-stripped text, so a call split
//     across lines is caught and a mention in a comment or string never fires.
//   * Skipped: lines inside `#[cfg(test)] mod`, whole test files, standalone
//     bins, and files matching `ALLOWLIST_GLOBS`. A site is exempt when its
//     line, or the line above, carries `// allow-raw-tx: <reason>`.
//
// Exits 1 listing each `file:line: code`, 2 on an invocation error.
//
// The judged tree is the one containing this script, never one derived from
// the cwd: pr-merge-result-check.sh runs the MERGED worktree's own copy so its
// location says which tree to judge (scripts/lib/guard-file-source.mjs,
// "Which TREE is judged").

import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { describeSource } from './lib/guard-file-source.mjs'
import {
  CRATE_ROOTS,
  WORD_END,
  WORD_START,
  WS,
  cfgTestLineSet,
  globMatch,
  isTestFile,
  openFileSource,
  splitLines,
  stripRustComments,
  trimSpace,
} from './lib/rust-scan.mjs'

export { CRATE_ROOTS }

const REPO_ROOT = realpathSync(join(import.meta.dirname, '..'))

const ISSUE_HINT = [
  '    -> #110: route user-edit write txs through the CommandTx convention',
  '       (`crate::db::begin_immediate_logged` + coupled post-commit dispatch).',
  '       If raw tx is genuinely correct here (no op_log writes / derived-cache / system-level),',
  '       add `// allow-raw-tx: <reason>` on the line or the line above, or extend the',
  '       allowlist in scripts/check-raw-tx.mjs.',
].join('\n')

// Files where a raw write-tx is architecturally legitimate (the #110 audit),
// matched against the repo-relative path; `**` spans directories.
const ALLOWLIST_GLOBS = [
  // App crate: the CommandTx wrapper's own `begin_immediate_logged` call.
  'src-tauri/src/db/**',
  // The write-tx primitive itself and its internal `begin_with`.
  'src-tauri/agaric-store/src/db/**',
  // Cache rebuilds: pure consumers of op_log, never producers.
  'src-tauri/agaric-store/src/cache/**',
  // FTS index: derived data, no op_log.
  'src-tauri/agaric-store/src/fts/index.rs',
  // Tag-inheritance rebuild: derived cache, no op_log writes.
  'src-tauri/agaric-store/src/tag_inheritance/rebuild.rs',
  // The Loro->SQLite projection: dispatching from it would self-recurse.
  // (draft.rs is not here; its one site carries a per-line marker.)
  'src-tauri/agaric-engine/src/apply/**',
  // Materializer task handlers: dispatching here would self-recurse.
  'src-tauri/agaric-engine/src/materializer/handlers/**',
  // System-level snapshot / compaction: must not dispatch edit tasks.
  'src-tauri/agaric-sync/src/snapshot/create.rs',
  // Startup recovery, before any user edit.
  'src-tauri/agaric-sync/src/recovery/draft_recovery.rs',
  // Transport layer.
  'src-tauri/agaric-sync/src/sync_daemon/snapshot_transfer.rs',
  // apply_remote applies remote ops; dispatching would double-fire.
  'src-tauri/agaric-sync/src/sync_protocol/loro_sync.rs',
  // Post-session bookkeeping.
  'src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs',
]

// Standalone bins (diagnostics audit tools) open raw txs on throwaway fixture
// DBs; they are not edit paths.
const BIN_FILE_GLOBS = ['**/src/bin/**']

const RAW_TX_RE = new RegExp(`begin_with${WS}*\\(|begin_immediate_logged${WS}*\\(`, 'gu')
// Matched against the STRIPPED line, so a trailing comment naming the
// definition cannot exempt a real call.
const DEFINITION = 'pub async fn begin_immediate_logged'
// `\bbegin\s*\(` reaches the paren only for a bare `begin(`, never for
// `begin_with(` or `begin_immediate_logged(`.
const DEFERRED_BEGIN_RE = new RegExp(`${WORD_START}begin${WS}*\\(`, 'gu')
const APPEND_HELPER_RE = new RegExp(`${WORD_START}append_local_(?:undo_)?op_in_tx${WORD_END}`, 'u')
const ALLOW_MARKER = '// allow-raw-tx:'

const ROOT_MISSING_HINT = [
  '    -> #4501: a CRATE_ROOTS entry in scripts/lib/rust-scan.mjs names a',
  '       directory that does not exist. These prefixes decide which changed',
  '       files this guard is willing to police, so a stale one silently',
  '       exempts every file under that crate rather than narrowing a walk.',
  '       Fix the LIST, and its hand-synchronised copy in',
  '       check-dynamic-sql.py.',
  '       If the tree under test is deliberately NOT this repository (a',
  '       fixture repo), the caller says so with `--synthetic-tree`.',
].join('\n')

function isAllowlistedFile(relPath) {
  return ALLOWLIST_GLOBS.some((glob) => globMatch(relPath, glob))
}

function isBinFile(relPath) {
  return BIN_FILE_GLOBS.some((glob) => globMatch(relPath, glob))
}

function underCrateRoot(relPath, crateRoots) {
  return crateRoots.some((root) => relPath.startsWith(root))
}

// A root that names no directory is a broken declaration: the roots are
// prefixes deciding which changed files are policed, so a stale one exempts
// every file under its crate and the run still exits 0 (#4501).
function missingCrateRoots(crateRoots) {
  return crateRoots
    .filter((root) => {
      try {
        return !statSync(join(REPO_ROOT, root)).isDirectory()
      } catch {
        return true
      }
    })
    .map((root) => root.replace(/\/+$/, ''))
}

/** Violations in one file's text. Pure, so the self-test can drive it. */
function scanText(relPath, text) {
  const stripped = stripRustComments(text)
  const lines = splitLines(text)
  const strippedLines = splitLines(stripped)
  const testLines = cfgTestLineSet(strippedLines)
  const lineAt = lineIndexer(stripped)
  // The marker is a comment, so it is sought in the ORIGINAL text.
  const exempt = (idx, line) =>
    testLines.has(idx) ||
    line.includes(ALLOW_MARKER) ||
    (idx > 0 && lines[idx - 1].includes(ALLOW_MARKER))

  const violations = []
  for (const m of stripped.matchAll(RAW_TX_RE)) {
    const idx = lineAt(m.index)
    const line = lines[idx] ?? ''
    if ((strippedLines[idx] ?? '').includes(DEFINITION)) continue
    if (exempt(idx, line)) continue
    violations.push(`${relPath}:${idx + 1}: ${trimSpace(line)}`)
  }
  // A doc-comment mention of the helper must not arm the #653 scan.
  if (APPEND_HELPER_RE.test(stripped)) {
    const deferredAt = lineIndexer(stripped)
    for (const m of stripped.matchAll(DEFERRED_BEGIN_RE)) {
      const idx = deferredAt(m.index)
      const line = lines[idx] ?? ''
      if (exempt(idx, line)) continue
      violations.push(
        `${relPath}:${idx + 1}: ${trimSpace(line)}  ` +
          '[#653: deferred .begin() near append_local_op_in_tx — must be BEGIN IMMEDIATE]',
      )
    }
  }
  return violations
}

// 0-based line of each offset, for offsets asked in ascending order.
function lineIndexer(text) {
  let pos = 0
  let line = 0
  return (offset) => {
    for (; pos < offset; pos++) if (text[pos] === '\n') line += 1
    return line
  }
}

// `Path.resolve()`: symlinks resolved as far as the path exists, the rest
// appended, so a staged file deleted from disk still maps into the repo.
function resolveExisting(arg) {
  let head = resolve(arg)
  const tail = []
  for (;;) {
    try {
      return join(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return resolve(arg)
      tail.unshift(basename(head))
      head = parent
    }
  }
}

// `str(PurePosixPath(arg))`: no empty or `.` segments, no trailing slash.
function purePosix(arg) {
  const body = arg
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/')
  if (arg.startsWith('/')) return `/${body}`
  return body || '.'
}

function relPathOf(arg) {
  const rel = relative(REPO_ROOT, resolveExisting(arg))
  if (rel === '') return '.'
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return purePosix(arg)
  return rel
}

function checkFile(relPath, src) {
  if (isAllowlistedFile(relPath)) return []
  if (isTestFile(relPath) || isBinFile(relPath)) return []
  const text = src.read(relPath)
  if (text === null) return []
  return scanText(relPath, text)
}

const write = (stream) => (line) => stream.write(`${line}\n`)

function main(argv, { crateRoots = CRATE_ROOTS, err = write(process.stderr) } = {}) {
  if (argv.includes('--self-test')) return runSelfTest()

  let src
  try {
    src = openFileSource(argv, process.env, {
      repoRoot: REPO_ROOT,
      extraFlags: ['--self-test', '--print-source', '--synthetic-tree'],
    })
  } catch (error) {
    if (!error.isUsageError && !error.isAmbiguousSource) throw error
    err(`check-raw-tx: invocation error: ${error.message}`)
    return 2
  }
  if (argv.includes('--print-source')) {
    write(process.stdout)(`check-raw-tx: ${describeSource(src.source)} (${src.why})`)
    return 0
  }

  // `--synthetic-tree`: the caller says this tree is deliberately not this
  // repository (a fixture), so our crate roots are inapplicable, not
  // violated. A flag rather than inference or an env var: inference cannot
  // tell deleted crates from a foreign tree, and an env var can be inherited
  // by accident.
  if (!argv.includes('--synthetic-tree')) {
    const missing = missingCrateRoots(crateRoots)
    if (missing.length > 0) {
      err('Raw write-transaction guard (#110) — a declared CRATE_ROOTS directory does not exist:\n')
      for (const rel of missing) err(`  ${rel}`)
      err('')
      err(ROOT_MISSING_HINT)
      return 1
    }
  }

  const violations = []
  try {
    for (const arg of argv) {
      if (arg.startsWith('-')) continue
      if (extname(basename(purePosix(arg))) !== '.rs') continue
      const rel = relPathOf(arg)
      if (!underCrateRoot(rel, crateRoots)) continue
      // Presence is asked of the source being judged, not of the disk: a
      // file `git add`ed then deleted IS being committed.
      if (!src.exists(rel)) continue
      violations.push(...checkFile(rel, src))
    }
  } catch (error) {
    // Fail closed: an index that could not be read answers "absent" for
    // every path, which would exit 0 having read nothing.
    err(`check-raw-tx: invocation error: ${error.message}`)
    return 2
  }

  if (violations.length > 0) {
    err('Raw write-transaction guard (#110) found new unmanaged site(s):\n')
    err(`  (judged the ${describeSource(src.source)} — ${src.why})`)
    for (const v of violations) err(`  ${v}`)
    err('')
    err(ISSUE_HINT)
    return 1
  }
  return 0
}

// --- self-test --------------------------------------------------------------

// [name, body, expect a #653 flag]
const SELFTEST_CASES = [
  [
    'raw deferred begin() in a file that calls the append helper -> FLAG',
    `
        async fn bad(pool: &SqlitePool) -> Result<(), AppError> {
            let mut tx = pool.begin().await?;
            op_log::append_local_op_in_tx(&mut tx, dev, payload, now).await?;
            tx.commit().await?;
            Ok(())
        }
        `,
    true,
  ],
  [
    'CommandTx / begin_immediate_logged path with the append helper -> clean',
    `
        async fn good(pool: &SqlitePool) -> Result<(), AppError> {
            let mut tx = CommandTx::begin_immediate(pool, "good").await?;
            op_log::append_local_op_in_tx(&mut tx, dev, payload, now).await?;
            tx.commit_and_dispatch(mat).await?;
            Ok(())
        }
        `,
    false,
  ],
  [
    'bare begin() but NO append helper in the file -> clean (read-only path)',
    `
        async fn read_only(pool: &SqlitePool) -> Result<(), AppError> {
            let mut read_tx = pool.begin().await?;
            let _ = sqlx::query("SELECT 1").fetch_one(&mut *read_tx).await?;
            Ok(())
        }
        `,
    false,
  ],
  [
    'bare begin() near the helper but carrying the // allow-raw-tx escape hatch -> clean',
    `
        async fn justified(pool: &SqlitePool) -> Result<(), AppError> {
            // allow-raw-tx: single-writer migration path, no contention
            let mut tx = pool.begin().await?;
            op_log::append_local_op_in_tx(&mut tx, dev, payload, now).await?;
            Ok(())
        }
        `,
    false,
  ],
  [
    'bare begin() + append helper, but both inside a #[cfg(test)] module -> clean',
    `
        #[cfg(test)]
        mod tests {
            async fn t(pool: &SqlitePool) {
                let mut tx = pool.begin().await.unwrap();
                op_log::append_local_op_in_tx(&mut tx, dev, payload, now).await.unwrap();
            }
        }
        `,
    false,
  ],
  [
    'append helper mentioned only in a doc comment, real begin() below -> clean (scan not armed)',
    `
        /// See append_local_op_in_tx for the BEGIN IMMEDIATE contract.
        async fn read_only(pool: &SqlitePool) -> Result<(), AppError> {
            let mut read_tx = pool.begin().await?;
            Ok(())
        }
        `,
    false,
  ],
]

// [rel-path, expected]: files under every crate root are policed (#3110),
// out-of-scope roots (benches/fuzz/gen) are not.
const CRATE_ROOT_CASES = [
  ['src-tauri/src/commands/blocks/crud.rs', true],
  ['src-tauri/agaric-store/src/cache/agenda.rs', true],
  ['src-tauri/agaric-engine/src/draft.rs', true],
  ['src-tauri/agaric-sync/src/snapshot/create.rs', true],
  ['src-tauri/diagnostics/src/lib.rs', true],
  ['src-tauri/benches/interactive_slo.rs', false],
  ['src-tauri/fuzz/fuzz_targets/apply.rs', false],
  ['scripts/whatever.rs', false],
]

// [rel-path, expected excluded]: test files and diagnostics bins skipped,
// ordinary subcrate files not.
const EXCLUSION_CASES = [
  ['src-tauri/diagnostics/src/bin/audit_cross_space_refs.rs', true],
  ['src-tauri/agaric-store/src/op_log/tests/append.rs', true],
  ['src-tauri/agaric-store/src/cache/tests.rs', true],
  ['src-tauri/agaric-store/src/cache/agenda.rs', false],
  ['src-tauri/agaric-engine/src/apply/pages_cache.rs', false],
]

// [rel-path, expected allowlisted]: each glob matches its real file; paths
// whose code moved or was removed (gcal, the old app cache/fts/sync homes,
// marker-only draft.rs) do not.
const ALLOWLIST_CASES = [
  ['src-tauri/agaric-store/src/db/mod.rs', true],
  ['src-tauri/agaric-store/src/cache/agenda.rs', true],
  ['src-tauri/agaric-store/src/fts/index.rs', true],
  ['src-tauri/agaric-store/src/tag_inheritance/rebuild.rs', true],
  ['src-tauri/agaric-engine/src/apply/pages_cache.rs', true],
  ['src-tauri/agaric-sync/src/snapshot/create.rs', true],
  ['src-tauri/agaric-sync/src/sync_daemon/snapshot_transfer.rs', true],
  ['src-tauri/agaric-sync/src/sync_protocol/loro_sync.rs', true],
  ['src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs', true],
  ['src-tauri/src/db/command_tx.rs', true],
  ['src-tauri/agaric-engine/src/materializer/handlers/apply.rs', true],
  ['src-tauri/agaric-sync/src/recovery/draft_recovery.rs', true],
  ['src-tauri/src/recovery/draft_recovery.rs', false],
  ['src-tauri/src/gcal_push/connector.rs', false],
  ['src-tauri/src/cache/pages.rs', false],
  ['src-tauri/src/fts/index.rs', false],
  ['src-tauri/src/snapshot/create.rs', false],
  ['src-tauri/agaric-engine/src/draft.rs', false],
]

const ROOT_CASES = 5

function runSelfTest() {
  const out = write(process.stdout)
  let failures = 0
  const fail = (line) => {
    failures += 1
    out(line)
  }

  for (const [name, body, expectFlag] of SELFTEST_CASES) {
    // A non-allowlisted, non-test path, so only the scan decides.
    const violations = scanText('src-tauri/src/__fixture__.rs', body)
    const gotFlag = violations.some((v) => v.includes('#653'))
    out(`  [${gotFlag === expectFlag ? 'PASS' : 'FAIL'}] ${name}`)
    if (gotFlag !== expectFlag) {
      fail(`         expected flag=${expectFlag}, got ${JSON.stringify(violations)}`)
    }
  }
  for (const [rel, expect] of CRATE_ROOT_CASES) {
    const got = underCrateRoot(rel, CRATE_ROOTS)
    if (got !== expect) {
      fail(`  [FAIL] underCrateRoot('${rel}') expected ${expect}, got ${got}`)
    }
  }
  for (const [rel, expect] of EXCLUSION_CASES) {
    const got = isTestFile(rel) || isBinFile(rel)
    if (got !== expect) {
      fail(`  [FAIL] exclusion('${rel}') expected ${expect}, got ${got}`)
    }
  }
  for (const [rel, expect] of ALLOWLIST_CASES) {
    const got = isAllowlistedFile(rel)
    if (got !== expect) {
      fail(`  [FAIL] isAllowlistedFile('${rel}') expected ${expect}, got ${got}`)
    }
  }
  rootSelfTest(fail)

  const total =
    SELFTEST_CASES.length +
    CRATE_ROOT_CASES.length +
    EXCLUSION_CASES.length +
    ALLOWLIST_CASES.length +
    ROOT_CASES
  if (failures > 0) {
    process.stderr.write(`\n${failures} self-test case(s) FAILED\n`)
    return 1
  }
  out(
    `\nAll ${total} raw-tx guard self-tests passed ` +
      '(#653 scan + #3110 subcrate scanning / exclusions / allowlist port).',
  )
  return 0
}

// #4501: a declared root naming nothing is LOUD. Both directions plus both
// arms of `--synthetic-tree`, because each half alone passes against a
// different bug (a guard reporting every root missing; a flag that disables
// the check on the production path). Driven through `main`, so dropping the
// wiring is caught, not only a helper regression.
function rootSelfTest(fail) {
  const misspelled = ['src-tauri/agaric-stores/src/', 'src-tauri/src/']
  const silent = { err: () => {} }
  const reported = missingCrateRoots(misspelled)
  if (reported.length !== 1 || reported[0] !== 'src-tauri/agaric-stores/src') {
    fail(`  [FAIL] a misspelled crate root was not reported: ${JSON.stringify(reported)}`)
  }
  const missingRc = main([], { ...silent, crateRoots: misspelled })
  const suppressedRc = main(['--synthetic-tree'], { ...silent, crateRoots: misspelled })
  const intactRc = main(['--synthetic-tree'], silent)
  // Exactly 1: an invocation error exits 2 before the roots check, so
  // "not 0" would also pass for a run that died for an unrelated reason.
  if (missingRc !== 1) {
    fail(
      '  [FAIL] a missing CRATE_ROOTS entry did not fail the run with ' +
        `the roots code (expected 1, got ${missingRc})`,
    )
  }
  if (suppressedRc !== 0) fail('  [FAIL] --synthetic-tree did not suppress a MISSING root')
  if (intactRc !== 0) fail('  [FAIL] --synthetic-tree changed the verdict on intact roots')
  const realMissing = missingCrateRoots(CRATE_ROOTS)
  if (realMissing.length > 0) {
    fail(`  [FAIL] the real CRATE_ROOTS reported a missing root: ${JSON.stringify(realMissing)}`)
  }
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  process.exitCode = main(process.argv.slice(2))
}
