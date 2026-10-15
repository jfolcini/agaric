#!/usr/bin/env node
// Enforce the dynamic-SQL justification rule (#646).
//
// docs/architecture/tooling.md says every runtime `sqlx::query()` (no macro)
// carries a comment justifying the runtime form. This counts each runtime
// `sqlx::query(` / `query_as(` / `query_scalar(` call in production Rust (the
// macro forms are compile-checked and exempt) and compares the per-file count
// against `src-tauri/dynamic-sql-baseline.txt`:
//
//   * A file whose count EXCEEDS its baseline must carry, at every dynamic
//     site, a `// dynamic-sql: <reason>` marker attached to the statement:
//     on the call line, on an earlier line of the same statement, or in the
//     comment run directly above it (#3653). We cannot tell which site is
//     new, so a file that grows must be clean throughout.
//   * A file at or below its baseline passes (existing sites are
//     grandfathered).
//   * A file BELOW its baseline, or an entry naming a file the scan no longer
//     covers, fails: that is slack the ratchet would otherwise hold (#3659).
//
// Re-anchor with `node scripts/check-dynamic-sql.mjs --update-baseline
// <path>...`, or bare for the files in your current diff. It is scoped: every
// other entry stays byte-identical, because regenerating the whole file once
// laundered eight unrelated drifted entries into a one-file diff (#3659).
// `--update-baseline --all` regenerates everything, and refuses to drop an
// entry unless `--allow-reductions` is given (#4501).
//
// A file with an inner `#![cfg(test)]` is skipped outright: it cannot reach a
// release binary (#3653).
//
// prek passes the changed files as arguments (hook `check-dynamic-sql`). Over
// the whole tree:
//
//     node scripts/check-dynamic-sql.mjs $(git ls-files 'src-tauri/**/*.rs')
//
// Exits 1 on a violation or a stale baseline, 2 on an invocation error.
//
// The judged tree is the one containing this script, never one derived from
// the cwd: pr-merge-result-check.sh runs the MERGED worktree's own copy so its
// location says which tree to judge (scripts/lib/guard-file-source.mjs,
// "Which TREE is judged").

import { spawnSync } from 'node:child_process'
import { readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describeSource, gitEnv } from './lib/guard-file-source.mjs'
import {
  CRATE_ROOTS,
  WS,
  cfgTestLineSet,
  isExcludedFile,
  lineIndexer,
  missingCrateRoots,
  openFileSource,
  repoRelative,
  splitLines,
  stripRustComments,
  trimSpace,
  underCrateRoot,
  write,
} from './lib/rust-scan.mjs'

export { CRATE_ROOTS }

const REPO_ROOT = realpathSync(join(import.meta.dirname, '..'))
const BASELINE_REL = 'src-tauri/dynamic-sql-baseline.txt'

// `[^\n]`, not `.`: a JS `.` also stops at `\r`, U+2028 and U+2029.
// The turbofish body is lazy so nested generics close at the OUTER `>`
// (`::<_, Option<i64>>(`); missing the turbofish form was #1188.
const DYN_SQL_RE = new RegExp(`sqlx::query(?:_as|_scalar)?${WS}*(?:::<[^\\n]*?>)?${WS}*\\(`, 'gu')

const MARKER = '// dynamic-sql:'

// Rust accepts inner attributes only before the first item, so a match found
// scanning down past blanks, comments and other inner attributes gates the
// whole file. An outer `#[cfg(test)]` gates one item and is `cfgTestLineSet`'s.
const INNER_CFG_TEST_RE = new RegExp(
  `^${WS}*#!${WS}*\\[${WS}*cfg${WS}*\\(${WS}*test${WS}*\\)${WS}*\\]`,
  'u',
)
const INNER_ATTR_RE = new RegExp(`^${WS}*#!${WS}*\\[`, 'u')

const HINT = [
  '    -> #646: a runtime `sqlx::query(`/`query_as(`/`query_scalar(` is a',
  '       NEW dynamic-SQL site. Prefer the compile-checked macro form',
  '       (`sqlx::query!` / `query_as!`) so the query is validated against',
  '       the schema at build time (the .sqlx offline cache).',
  '       If the query is genuinely dynamic (recursive CTE built at',
  '       runtime, FTS5 query builder, snapshot/sync fan-out), add a',
  '       `// dynamic-sql: <reason>` comment on the call line, on an',
  '       earlier line of the same statement, or in the comment block',
  '       directly above it, then re-anchor the baseline:',
  '         node scripts/check-dynamic-sql.mjs --update-baseline',
].join('\n')

const ROOT_MISSING_HINT = [
  '    -> #4501: a CRATE_ROOTS entry in scripts/lib/rust-scan.mjs names a',
  '       directory that does not exist. Fix the LIST, not the baseline: the',
  '       walk yields nothing for a missing root, so re-anchoring here would',
  '       drop every entry under it and report success — the finding',
  '       destroyed by the command prescribed to fix it. If the crate was',
  '       genuinely retired, remove its root in the same commit, then',
  '       re-anchor. check-raw-tx and check-table-ownership share this list.',
  '       If the tree under test is deliberately NOT this repository (a',
  '       fixture repo), the caller says so with `--synthetic-tree`.',
].join('\n')

const SOURCE_FLAGS = [
  '--self-test',
  '--update-baseline',
  '--all',
  '--print-source',
  '--synthetic-tree',
  '--allow-reductions',
]

// Which copy of each file is judged. One module-level source, so the ratchet,
// the baseline read and the orphan sweep cannot disagree about it (#4017).
// `--update-baseline` and the self-test keep this working-tree default:
// re-anchoring is about the tree you are editing, not a commit in flight.
let src = openFileSource(['--worktree'], process.env, { repoRoot: REPO_ROOT })

/** True iff the file opens with an inner `#![cfg(test)]` (#3653). */
function isTestOnlyModule(text) {
  for (const raw of splitLines(text)) {
    const line = trimSpace(raw)
    if (!line || line.startsWith('//') || line.startsWith('/*')) continue
    if (INNER_CFG_TEST_RE.test(raw)) return true
    if (INNER_ATTR_RE.test(raw)) continue
    return false
  }
  return false
}

/** 0-based line indices of production dynamic-SQL sites in `text`. */
function scanText(text) {
  const stripped = stripRustComments(text)
  const testLines = cfgTestLineSet(splitLines(stripped))
  const lineAt = lineIndexer(stripped)
  const indices = []
  for (const m of stripped.matchAll(DYN_SQL_RE)) {
    const idx = lineAt(m.index)
    if (!testLines.has(idx)) indices.push(idx)
  }
  return indices
}

// The lines a marker for the site at `idx` may live on. `cargo fmt` owns
// physical offsets, so the marker attaches to the STATEMENT (#3653): walking
// up, earlier lines of the same statement (code not ending in `;`, `{` or
// `}`) and the comment run directly above it. A blank line or a completed
// statement stops the walk, so a previous statement's marker never covers it.
function markerScope(raw, code, idx) {
  const scope = [idx]
  for (let j = Math.min(idx, raw.length) - 1; j >= 0; j--) {
    const codeLine = j < code.length ? trimSpace(code[j]) : ''
    const rawLine = trimSpace(raw[j])
    if (!codeLine) {
      if (!['//', '/*', '*'].some((p) => rawLine.startsWith(p))) break
    } else if ([';', '{', '}'].some((s) => codeLine.endsWith(s))) {
      break
    }
    scope.push(j)
  }
  return scope
}

/** The 0-based indices of dynamic sites WITHOUT a marker. */
function unmarkedSites(text, indices) {
  const raw = splitLines(text)
  const code = splitLines(stripRustComments(text))
  return indices.filter(
    (idx) => !markerScope(raw, code, idx).some((j) => j < raw.length && raw[j].includes(MARKER)),
  )
}

// Every read goes through here, so there is one place that can be wrong about
// which copy is judged.
function readSource(rel) {
  return src.read(rel) ?? ''
}

function countSites(rel) {
  return scanText(readSource(rel))
}

// Only `--update-baseline` and the self-test walk the tree, and both judge the
// working tree (`src` keeps its default for them), so the walk is the disk's.
function allProductionFiles() {
  const files = []
  for (const root of CRATE_ROOTS) {
    let names
    try {
      names = readdirSync(join(REPO_ROOT, root), { encoding: 'utf8', recursive: true })
    } catch {
      continue
    }
    for (const name of names.toSorted()) {
      const rel = `${root}${name}`
      if (!rel.endsWith('.rs') || !src.exists(rel) || isExcludedFile(rel)) continue
      if (isTestOnlyModule(readSource(rel))) continue
      files.push(rel)
    }
  }
  return files
}

function computeBaseline() {
  const baseline = new Map()
  for (const rel of allProductionFiles()) {
    const count = countSites(rel).length
    if (count) baseline.set(rel, count)
  }
  return baseline
}

// `existing` with only `scope` re-anchored; a zero count drops the entry.
function mergeBaseline(existing, scope, counts) {
  const merged = new Map(existing)
  for (const rel of scope) {
    const count = counts.get(rel) ?? 0
    if (count) merged.set(rel, count)
    else merged.delete(rel)
  }
  return merged
}

// Downward drift never trips a ratchet that fires upward, so it is reported
// on its own; every stale entry is headroom for an unjustified site.
/** @param {Map<string, number>} baseline @param {Map<string, number>} counts */
function driftedEntries(baseline, counts) {
  return [...counts.keys()]
    .toSorted()
    .filter((rel) => baseline.has(rel) && counts.get(rel) < baseline.get(rel))
    .map(
      (rel) =>
        `${rel}: baseline records ${baseline.get(rel)} site(s), the tree has ${counts.get(rel)}`,
    )
}

// The one definition of "covered", shared by the orphan sweep and the
// re-anchor: when they disagreed, the printed remedy re-wrote the orphan it
// was run to clear (#3724).
function inScanScope(rel) {
  return src.exists(rel) && !isExcludedFile(rel) && !isTestOnlyModule(readSource(rel))
}

function baselineCount(rel) {
  return inScanScope(rel) ? countSites(rel).length : 0
}

// Global over the baseline, because prek's file list omits deletions. The
// warm-up batches the reads into `cat-file --batch` calls (#4063), and only
// for entries the loop will read: a damaged object behind an entry the loop
// discards must not turn an orphan report into exit 2 (#4193).
/** @param {Map<string, number>} baseline */
function orphanEntries(baseline) {
  src.readMany([...baseline.keys()].filter((rel) => !isExcludedFile(rel) && src.exists(rel)))
  const orphans = []
  for (const rel of [...baseline.keys()].toSorted()) {
    if (!src.exists(rel)) orphans.push(`${rel}: no such file (deleted or renamed)`)
    else if (isExcludedFile(rel)) orphans.push(`${rel}: now a test/fixture path, outside the scan`)
    else if (isTestOnlyModule(readSource(rel))) {
      orphans.push(`${rel}: now a whole-file \`#![cfg(test)]\` module`)
    }
  }
  return orphans
}

// The default scope of a bare `--update-baseline`: production .rs files
// changed against HEAD, plus untracked ones so a new module counts. The env
// is scrubbed so an inherited GIT_DIR cannot re-aim these calls (#4191).
function changedProductionFiles() {
  const env = gitEnv(REPO_ROOT, process.env)
  const out = []
  for (const args of [
    ['diff', '--name-only', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    const res = spawnSync('git', args, { cwd: REPO_ROOT, env, encoding: 'utf8' })
    if (res.error) continue
    out.push(...splitLines(res.stdout).map(trimSpace))
  }
  /** @type {string[]} */
  const scope = []
  for (const rel of out) {
    if (!rel.endsWith('.rs') || !underCrateRoot(rel)) continue
    if (isExcludedFile(rel) || scope.includes(rel)) continue
    scope.push(rel)
  }
  return scope.toSorted()
}

/** @param {Map<string, number>} baseline */
function writeBaseline(baseline) {
  const lines = [
    '# Dynamic-SQL baseline (#646) — per-file count of runtime ' +
      '`sqlx::query(`/`query_as(`/`query_scalar(` sites.',
    '# Generated by: node scripts/check-dynamic-sql.mjs ' +
      '--update-baseline <path>...  (SCOPED — #3659)',
    "# The check-dynamic-sql prek hook fails when a file's site count EXCEEDS its baseline",
    '# unless every dynamic site in that file carries an adjacent ' +
      '`// dynamic-sql: <reason>` marker.',
    '# Format: <count> <path-relative-to-repo-root>',
    '',
  ]
  for (const rel of [...baseline.keys()].toSorted()) lines.push(`${baseline.get(rel)} ${rel}`)
  writeFileSync(join(REPO_ROOT, BASELINE_REL), `${lines.join('\n')}\n`)
}

const SPACE_RE = new RegExp(WS, 'u')
const INT_RE = /^[+-]?[0-9]+(?:_[0-9]+)*$/

// From the judged source: a commit staging a re-anchor alongside its file is
// judged against the STAGED ceiling (#4017). Absent reads as empty.
function readBaseline() {
  const baseline = new Map()
  for (const raw of splitLines(readSource(BASELINE_REL))) {
    const line = trimSpace(raw)
    if (!line || line.startsWith('#')) continue
    const gap = SPACE_RE.exec(line)
    if (!gap) continue
    const count = line.slice(0, gap.index)
    if (!INT_RE.test(count)) continue
    baseline.set(trimSpace(line.slice(gap.index)), Number(count.replaceAll('_', '')))
  }
  return baseline
}

// The extension of the last real path segment, with its dot.
function suffixOf(arg) {
  const name = arg.split('/').findLast((seg) => seg !== '' && seg !== '.') ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : ''
}

function toScopedRel(arg) {
  const rel = repoRelative(arg, REPO_ROOT)
  if (rel === null || !rel.endsWith('.rs') || !underCrateRoot(rel)) return null
  return rel
}

/** Scoped re-anchor (#3659): only the named entries may change. */
function updateBaseline(argv, deps) {
  const { out, err } = deps
  /** @type {Map<string, number>} */
  const existing = deps.readBaseline()
  /** @type {Map<string, number>} */
  let next
  let scopeLabel
  if (argv.includes('--all')) {
    next = deps.computeBaseline()
    scopeLabel = 'the whole tree (--all)'
    // Only `--all` can delete an entry nobody named, and a narrowed walk
    // deletes every entry under it. Counted in ENTRIES: a falling sum is a
    // query becoming a macro, the routine good news. Refused before the
    // write, so re-running the command cannot absorb the deletion.
    const lost = [...existing.keys()].filter((rel) => !next.has(rel)).toSorted()
    if (lost.length > 0 && !argv.includes('--allow-reductions')) {
      err(
        `Refusing to re-anchor: --all would DROP ${lost.length} baseline entr(ies) ` +
          `(${existing.size} -> ${next.size}).\n`,
      )
      for (const rel of lost) {
        let stillThere = false
        try {
          stillThere = statSync(join(REPO_ROOT, rel)).isFile()
        } catch {
          // Gone.
        }
        const why = stillThere
          ? 'the file is still there — it left the WALK, not the tree'
          : 'the file is gone'
        err(`  ${rel}: ${existing.get(rel)} -> removed  (${why})`)
      }
      err(
        [
          '\n    -> An entry that leaves the walk stops being ratcheted, and a',
          '       rebuild records that as success. Check CRATE_ROOTS and the',
          '       test/fixture globs before deciding this is intended; a file',
          "       marked 'still there' is the case worth stopping for.",
          '       If every removal above is intended, re-run with',
          '       `--allow-reductions`. If you only meant to re-anchor a few',
          '       files, name them instead of passing --all (#3659) — the',
          '       scoped form cannot delete an entry you did not name.',
        ].join('\n'),
      )
      return 1
    }
  } else {
    let scope = []
    for (const arg of argv) {
      if (arg.startsWith('--')) continue
      const rel = toScopedRel(arg)
      if (rel === null) {
        err(`check-dynamic-sql: not a scanned production .rs path: ${arg}`)
        return 1
      }
      if (!scope.includes(rel)) scope.push(rel)
    }
    if (scope.length > 0) {
      scopeLabel = `${scope.length} file(s) given on the command line`
    } else {
      scope = changedProductionFiles()
      scopeLabel = `${scope.length} file(s) from the current diff`
      if (scope.length === 0) {
        err(
          'check-dynamic-sql: nothing to re-anchor — no production .rs files in the current diff.\n' +
            '  Name the files explicitly, or pass --all to regenerate the whole baseline\n' +
            '  (which rewrites EVERY entry — see #3659).',
        )
        return 1
      }
    }
    // An uncovered file must record ZERO and drop out, or the remedy cannot
    // clear the orphan it is run for.
    next = mergeBaseline(existing, scope, new Map(scope.map((rel) => [rel, baselineCount(rel)])))
  }

  const changed = [...new Set([...existing.keys(), ...next.keys()])]
    .filter((rel) => existing.get(rel) !== next.get(rel))
    .toSorted()
  deps.writeBaseline(next)
  out(`Re-anchored ${BASELINE_REL} — scope: ${scopeLabel}`)
  if (changed.length === 0) out('  (no entry changed — the baseline already agreed with the tree)')
  for (const rel of changed) {
    const before = existing.get(rel) ?? '-'
    const after = next.get(rel) ?? 'removed'
    out(`  ${rel}: ${before} -> ${after}`)
  }
  out(`  ${next.size} entries (was ${existing.size})`)
  return 0
}

function main(argv, overrides = {}) {
  const deps = {
    crateRoots: CRATE_ROOTS,
    readBaseline,
    computeBaseline,
    writeBaseline,
    check,
    out: write(process.stdout),
    err: write(process.stderr),
    ...overrides,
  }
  const { err } = deps
  if (argv.includes('--self-test')) return runSelfTest()
  // `updateBaseline` skips every `--` argument, so a misplaced opt-in would
  // otherwise be swallowed and the operator would believe it took effect.
  if (
    argv.includes('--allow-reductions') &&
    !(argv.includes('--update-baseline') && argv.includes('--all'))
  ) {
    err(
      'check-dynamic-sql: `--allow-reductions` only has meaning with `--update-baseline --all`,\n' +
        'which is the only re-anchor that can delete an entry you did not name.',
    )
    return 2
  }
  // `--synthetic-tree`: the caller says this tree is deliberately not this
  // repository (a fixture), so our crate roots are inapplicable. Combined
  // with a re-anchor it would rebuild the baseline from roots it just called
  // inapplicable, so the pair is refused.
  const synthetic = argv.includes('--synthetic-tree')
  if (synthetic && argv.includes('--update-baseline')) {
    err(
      'check-dynamic-sql: --synthetic-tree and --update-baseline are mutually exclusive:\n' +
        "the first says this tree's crate roots do not apply, the second rewrites the\n" +
        'baseline FROM those roots. Together they would silently drop every entry under\n' +
        'a root that is missing.',
    )
    return 2
  }
  const missing = synthetic ? [] : missingCrateRoots(deps.crateRoots, REPO_ROOT)
  if (missing.length > 0) {
    if (argv.includes('--update-baseline')) {
      err('Refusing to re-anchor: a declared CRATE_ROOTS entry is missing.\n')
    } else {
      err(
        'Dynamic-SQL justification guard (#646) — a declared CRATE_ROOTS directory does not exist:\n',
      )
    }
    for (const rel of missing) err(`  ${rel}`)
    err('')
    err(ROOT_MISSING_HINT)
    return 1
  }
  if (argv.includes('--update-baseline')) {
    return updateBaseline(
      argv.filter((arg) => arg !== '--update-baseline'),
      deps,
    )
  }

  try {
    src = openFileSource(argv, process.env, { repoRoot: REPO_ROOT, extraFlags: SOURCE_FLAGS })
  } catch (error) {
    if (!error.isUsageError && !error.isAmbiguousSource) throw error
    err(`check-dynamic-sql: invocation error: ${error.message}`)
    return 2
  }
  if (argv.includes('--print-source')) {
    deps.out(`check-dynamic-sql: ${describeSource(src.source)} (${src.why})`)
    return 0
  }
  try {
    return deps.check(argv, deps.readBaseline(), deps)
  } catch (error) {
    // Fail closed: an unreadable index would otherwise answer "absent" for
    // every path and report the whole baseline as orphaned, or nothing.
    err(`check-dynamic-sql: invocation error: ${error.message}`)
    return 2
  }
}

function check(argv, baseline, { err }) {
  const targets = []
  for (const arg of argv) {
    if (suffixOf(arg) !== '.rs') continue
    const rel = repoRelative(arg, REPO_ROOT)
    if (rel === null || !underCrateRoot(rel)) continue
    if (isExcludedFile(rel)) continue
    // Asked of the judged source: a file `git add`ed then deleted from disk
    // IS being committed.
    if (!src.exists(rel)) continue
    if (isTestOnlyModule(readSource(rel))) continue
    targets.push(rel)
  }

  const violations = []
  const actualCounts = new Map()
  for (const rel of targets) {
    const indices = countSites(rel)
    actualCounts.set(rel, indices.length)
    if (indices.length <= (baseline.get(rel) ?? 0)) continue
    const lines = splitLines(readSource(rel))
    for (const idx of unmarkedSites(readSource(rel), indices)) {
      violations.push(`${rel}:${idx + 1}: ${idx < lines.length ? trimSpace(lines[idx]) : ''}`)
    }
  }

  if (violations.length > 0) {
    err(
      'Dynamic-SQL justification guard (#646) — new runtime ' +
        '`sqlx::query(` site(s) without a `// dynamic-sql:` marker:\n',
    )
    err(`  (judged the ${describeSource(src.source)} — ${src.why})`)
    for (const v of violations) err(`  ${v}`)
    err('')
    err(HINT)
    return 1
  }

  // After the marker rule, so a real violation is never buried under
  // bookkeeping. Drift is judged for the files checked; orphans globally.
  const stale = [...driftedEntries(baseline, actualCounts), ...orphanEntries(baseline)]
  if (stale.length > 0) {
    err(
      'Dynamic-SQL baseline is out of step with the tree (#3659) — the ratchet is holding\n' +
        'slack it should have reclaimed:\n',
    )
    for (const s of stale) err(`  ${s}`)
    err(
      [
        '\n    -> Re-anchor just these entries (every other line stays byte-identical):',
        '         node scripts/check-dynamic-sql.mjs --update-baseline <path>...',
        '       or, for the files in your current diff:',
        '         node scripts/check-dynamic-sql.mjs --update-baseline',
      ].join('\n'),
    )
    return 1
  }
  return 0
}

// --- self-test --------------------------------------------------------------

// The #1188 contract: every runtime spelling, the turbofish included, and
// never a compile-checked macro.
const SHOULD_MATCH = [
  'sqlx::query("SELECT 1")',
  'sqlx::query_as::<_, BlockRow>(sql)',
  'sqlx::query_scalar::<_, String>(',
  'sqlx::query_scalar::<_, i64>("SELECT COUNT(*)")',
  'sqlx::query_as::<_, (String, i64)>(sql)',
  'sqlx::query_scalar::<_, Option<i64>>("SELECT position")',
  'sqlx::query_scalar::<_, Vec<u8>>(blob_sql)',
  'sqlx::query_scalar::<_, Option<String>>(q)',
]
const SHOULD_NOT_MATCH = [
  'sqlx::query!("SELECT 1")',
  'sqlx::query_as!(BlockRow, sql)',
  'sqlx::query_scalar!(',
  'let query = build_query();',
  '// sqlx::query_scalar mentioned in prose',
]

// [rel-path, expect excluded]: subcrate production files are scanned (#3107);
// property tests, the test-util helper, bins and test files are not.
const SCOPE_CASES = [
  ['src-tauri/agaric-store/src/op_log/append.rs', false],
  ['src-tauri/agaric-engine/src/loro/projection.rs', false],
  ['src-tauri/agaric-sync/src/lib.rs', false],
  ['src-tauri/src/commands/blocks/crud.rs', false],
  ['src-tauri/agaric-sync/src/dag_tests/proptest_b2.rs', true],
  ['src-tauri/agaric-store/src/test_support.rs', true],
  ['src-tauri/diagnostics/src/bin/audit_cross_space_refs.rs', true],
  ['src-tauri/agaric-store/src/op_log/tests.rs', true],
]

// [source, expect skipped, label] (#3653).
const TEST_ONLY_CASES = [
  [
    '#![cfg(test)]\n\nuse sqlx::SqlitePool;\n' +
      'async fn f(p: &SqlitePool) { sqlx::query("SELECT 1"); }\n',
    true,
    'bare inner attribute on line 1',
  ],
  [
    '//! Oracle module, test-only.\n\n// leading comment\n' +
      '#![allow(clippy::pedantic)]\n#![cfg(test)]\n\nfn f() {}\n',
    true,
    'inner attribute after doc comments and another inner attribute',
  ],
  ['  #! [ cfg ( test ) ]\nfn f() {}\n', true, 'whitespace-tolerant spelling'],
  [
    'use sqlx::SqlitePool;\nfn f() { sqlx::query("SELECT 1"); }\n',
    false,
    'ordinary production file',
  ],
  [
    '#[cfg(test)]\nmod tests {\n    fn f() {}\n}\n',
    false,
    'OUTER #[cfg(test)] gates one item, not the file',
  ],
  [
    'fn real() {}\nmod inline {\n    #![cfg(test)]\n    fn f() {}\n}\n',
    false,
    'inner attribute inside an inline mod is not a file-level gate',
  ],
]

// [source, expected unmarked sites, label] (#3653).
const MARKER_CASES = [
  [
    'let rows = sqlx::query("SELECT 1"); // dynamic-sql: on the call\n',
    0,
    'marker on the call line',
  ],
  [
    '// dynamic-sql: reason\nlet rows = sqlx::query("SELECT 1");\n',
    0,
    'marker on the line immediately above (the pre-#3653 rule)',
  ],
  [
    "// The schema is chosen at runtime from the caller's space set,\n" +
      '// so the column list cannot be known at compile time.\n' +
      '// dynamic-sql: runtime-built column list\n' +
      '// (see the module header for the full derivation)\n' +
      'let rows = sqlx::query("SELECT 1");\n',
    0,
    'marker anywhere in the contiguous comment run above',
  ],
  [
    // Verbatim rustfmt output for a call that no longer fits on one line.
    '    // dynamic-sql: runtime-built column list\n' +
      '    let rows_for_the_current_space =\n' +
      '        sqlx::query_as::<_, (String, i64, String)>(sql)\n' +
      '            .fetch_all(pool)\n' +
      '            .await;\n',
    0,
    'marker survives a cargo fmt reflow of the same statement',
  ],
  ['let rows = sqlx::query("SELECT 1");\n', 1, 'no marker at all still fails'],
  [
    '// dynamic-sql: this one is justified\n' +
      'let a = sqlx::query("SELECT 1");\n' +
      'let b = sqlx::query("SELECT 2");\n',
    1,
    "a previous statement's marker does not cover the next site",
  ],
  [
    'let a = sqlx::query("SELECT 1"); // dynamic-sql: justified\n' +
      'let b = sqlx::query("SELECT 2");\n',
    1,
    "a previous statement's TRAILING marker does not leak downward",
  ],
  [
    '// dynamic-sql: justified\n\nlet rows = sqlx::query("SELECT 1");\n',
    1,
    'a blank line ends the comment run',
  ],
]

// Real files, each with runtime sites the pre-#3724 re-anchor would have
// re-recorded, so the fixtures can tell the two implementations apart.
const REMEDY_FIXTURES = [
  ['src-tauri/src/bulk_equivalence/mod.rs', 'whole-file #![cfg(test)] module'],
  ['src-tauri/agaric-store/src/test_support.rs', 'test/fixture glob'],
  ['src-tauri/src/definitely-not-here-3659.rs', 'deleted file'],
]

const showMap = (map) => JSON.stringify(Object.fromEntries(map))

function sameMap(a, b) {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
}

function runSelfTest() {
  const failures = []
  for (const s of SHOULD_MATCH) {
    if (s.search(DYN_SQL_RE) === -1) failures.push(`expected MATCH, got none: '${s}'`)
  }
  for (const s of SHOULD_NOT_MATCH) {
    if (s.search(DYN_SQL_RE) !== -1) failures.push(`expected NO match, but matched: '${s}'`)
  }
  for (const [rel, expectExcluded] of SCOPE_CASES) {
    if (!underCrateRoot(rel)) failures.push(`scope: '${rel}' not under any scanned crate root`)
    const got = isExcludedFile(rel)
    if (got !== expectExcluded) {
      failures.push(`isExcludedFile('${rel}') expected ${expectExcluded}, got ${got}`)
    }
  }
  for (const [text, expectSkip, label] of TEST_ONLY_CASES) {
    const got = isTestOnlyModule(text)
    if (got !== expectSkip) {
      failures.push(`isTestOnlyModule (${label}): expected ${expectSkip}, got ${got}`)
    }
  }
  for (const [text, expectMissing, label] of MARKER_CASES) {
    const indices = scanText(text)
    if (indices.length === 0) {
      failures.push(`marker scope (${label}): no site detected at all`)
      continue
    }
    const got = unmarkedSites(text, indices).length
    if (got !== expectMissing) {
      failures.push(
        `marker scope (${label}): expected ${expectMissing} unmarked site(s), got ${got}`,
      )
    }
  }
  baselineSelfTest(failures)
  const rootCases = rootSelfTest(failures)

  if (failures.length > 0) {
    const err = write(process.stderr)
    err('check-dynamic-sql self-test FAILED:')
    for (const f of failures) err(`  ${f}`)
    return 1
  }
  const total =
    SHOULD_MATCH.length +
    SHOULD_NOT_MATCH.length +
    SCOPE_CASES.length +
    TEST_ONLY_CASES.length +
    MARKER_CASES.length +
    rootCases +
    // scoped-update / drift / orphan / remedy / live-agreement
    14
  write(process.stdout)(`check-dynamic-sql self-test passed (${total} cases).`)
  return 0
}

// The scoped re-anchor (#3659), drift and orphans, the printed remedy
// (#3724), and the live baseline against the tree.
function baselineSelfTest(failures) {
  const a = 'src-tauri/src/a.rs'
  const gone = 'src-tauri/src/gone.rs'
  const fixture = new Map([
    [a, 3],
    ['src-tauri/src/b.rs', 8],
    ['src-tauri/src/drifted.rs', 2], // the tree really has 11: must NOT move
    [gone, 1],
  ])
  const without = (map, key) => new Map([...map].filter(([k]) => k !== key))
  const merged = mergeBaseline(
    fixture,
    [a],
    new Map([
      [a, 5],
      ['src-tauri/src/drifted.rs', 11],
    ]),
  )
  if (merged.get(a) !== 5) failures.push('scoped update: the in-scope entry was not re-anchored')
  if (!sameMap(without(merged, a), without(fixture, a))) {
    failures.push(
      `scoped update: out-of-scope entries changed — ${showMap(without(merged, a))} != ` +
        `${showMap(without(fixture, a))}`,
    )
  }
  if (merged.size !== fixture.size) {
    failures.push(`scoped update: entry count not preserved (${merged.size} vs ${fixture.size})`)
  }
  const dropped = mergeBaseline(fixture, [gone], new Map())
  if (dropped.has(gone)) failures.push('scoped update: a zero-count scoped entry was not removed')
  if (!sameMap(without(dropped, gone), without(fixture, gone))) {
    failures.push('scoped update: removing one entry disturbed the others')
  }
  if (!sameMap(mergeBaseline(fixture, [], new Map()), fixture)) {
    failures.push('scoped update: an empty scope changed the baseline')
  }

  const drift = driftedEntries(
    new Map([
      [a, 8],
      ['src-tauri/src/b.rs', 2],
    ]),
    new Map([
      [a, 5],
      ['src-tauri/src/b.rs', 2],
    ]),
  )
  if (drift.length !== 1 || !drift[0].includes(a)) {
    failures.push(`downward drift not reported exactly once: ${JSON.stringify(drift)}`)
  }
  if (driftedEntries(new Map([[a, 5]]), new Map([[a, 9]])).length > 0) {
    failures.push(
      "a file ABOVE its baseline was reported as drift (that is the marker rule's job, not this one)",
    )
  }
  const orphans = orphanEntries(new Map([['src-tauri/src/definitely-not-here-3659.rs', 2]]))
  if (orphans.length !== 1) {
    failures.push(`orphan baseline entry not reported: ${JSON.stringify(orphans)}`)
  }
  if (orphanEntries(new Map()).length > 0) failures.push('orphan check fired on an empty baseline')

  for (const [rel, kind] of REMEDY_FIXTURES) {
    if (src.exists(rel) && countSites(rel).length === 0) {
      failures.push(
        `remedy fixture stale: ${rel} (${kind}) no longer has any runtime site, so it cannot ` +
          'distinguish the two implementations — pick another file',
      )
    }
    if (inScanScope(rel)) {
      failures.push(`remedy fixture stale: ${rel} is now IN scan scope (${kind} no longer holds)`)
    }
    if (baselineCount(rel) !== 0) {
      failures.push(
        `scoped re-anchor cannot clear the ${kind} orphan: baselineCount('${rel}') = ` +
          `${baselineCount(rel)}, expected 0`,
      )
    }
  }

  // End to end: running exactly the printed command over exactly the
  // flagged entries ends green.
  const healthy = 'src-tauri/agaric-engine/src/block_ops.rs'
  const orphaned = new Map([
    [healthy, 1], // deliberately stale, and IN scope: must be re-anchored
    ...REMEDY_FIXTURES.map(([rel]) => [rel, 7]),
  ])
  const flagged = orphanEntries(orphaned)
  if (flagged.length !== REMEDY_FIXTURES.length) {
    failures.push(
      `expected ${REMEDY_FIXTURES.length} orphans flagged, got ${JSON.stringify(flagged)}`,
    )
  }
  const remedyScope = [...REMEDY_FIXTURES.map(([rel]) => rel), healthy]
  const after = mergeBaseline(
    orphaned,
    remedyScope,
    new Map(remedyScope.map((rel) => [rel, baselineCount(rel)])),
  )
  if (orphanEntries(after).length > 0) {
    failures.push(
      `running the printed remedy left orphans behind: ${JSON.stringify(orphanEntries(after))}`,
    )
  }
  if (after.get(healthy) !== countSites(healthy).length) {
    failures.push(`the printed remedy did not re-anchor the in-scope entry: ${after.get(healthy)}`)
  }

  // After a re-anchor, a second one must be a no-op.
  const actual = computeBaseline()
  const recorded = readBaseline()
  if (!sameMap(actual, recorded)) {
    const onlyTree = new Map([...actual].filter(([k, v]) => recorded.get(k) !== v))
    const onlyBase = new Map([...recorded].filter(([k, v]) => actual.get(k) !== v))
    failures.push(
      'the checked-in baseline disagrees with the tree ' +
        `(${recorded.size} entries recorded, ${actual.size} real): ` +
        `tree says ${showMap(onlyTree)}; baseline says ${showMap(onlyBase)}. ` +
        'Re-anchor with: node scripts/check-dynamic-sql.mjs --update-baseline <path>...',
    )
  }
}

// #4501 and the re-anchor ratchet, driven through `main` so dropping the
// wiring is caught, in both directions of every flag. Everything past the
// roots check is stubbed, `writeBaseline` above all: these cases run with a
// narrowed walk, and a regressed arm must not rewrite the tracked baseline.
// Exact exit codes, because two gates exit 2 ahead of the roots check.
function rootSelfTest(failures) {
  let cases = 0
  const misspelled = ['src-tauri/agaric-stores/src/', 'src-tauri/src/']
  const writes = []
  const stub = {
    readBaseline: () =>
      new Map([
        ['src-tauri/src/kept.rs', 1],
        ['src-tauri/agaric-store/src/lost.rs', 2],
      ]),
    computeBaseline: () => new Map([['src-tauri/src/kept.rs', 1]]),
    writeBaseline: (baseline) => writes.push(baseline),
    check: () => 0,
    out: () => {},
    err: () => {},
  }
  const narrowed = { ...stub, crateRoots: misspelled }
  const savedSource = src

  cases += 1
  const reported = missingCrateRoots(misspelled, REPO_ROOT)
  if (reported.length !== 1 || reported[0] !== 'src-tauri/agaric-stores/src') {
    failures.push(`a misspelled crate root was not reported: ${JSON.stringify(reported)}`)
  }
  const missingRc = main([], narrowed)
  const missingUpdateRc = main(['--update-baseline', '--all'], narrowed)
  const suppressedRc = main(['--synthetic-tree'], narrowed)
  const bothRc = main(['--synthetic-tree', '--update-baseline', '--all'], narrowed)
  const intactRc = main(['--synthetic-tree', 'src-tauri/src/nothing.rs'], stub)
  const dropRc = main(['--update-baseline', '--all'], stub)
  // Snapshotted here: the next call is meant to write, so the final tally
  // would pass whether or not the refusal wrote first.
  const wroteAfterRefusal = writes.length
  const allowedRc = main(['--update-baseline', '--all', '--allow-reductions'], stub)
  const wroteAfterOptIn = writes.length
  const strayFlagRc = main(['--allow-reductions'], stub)
  src = savedSource

  const expect = (ok, message) => {
    cases += 1
    if (!ok) failures.push(message)
  }
  expect(
    missingRc === 1,
    'a missing CRATE_ROOTS entry did not fail the run with the roots code ' +
      `(expected 1, got ${missingRc})`,
  )
  expect(
    missingUpdateRc === 1,
    '--update-baseline over a missing root did not refuse — it would have re-anchored ' +
      `against the narrowed walk (expected 1, got ${missingUpdateRc})`,
  )
  expect(suppressedRc === 0, '--synthetic-tree did not suppress a MISSING root')
  expect(intactRc === 0, '--synthetic-tree changed the verdict on intact roots')
  expect(bothRc === 2, `--synthetic-tree --update-baseline was not refused (exit ${bothRc})`)
  expect(
    dropRc === 1,
    `--update-baseline --all that DROPS an entry was not refused (exit ${dropRc})`,
  )
  expect(
    wroteAfterRefusal === 0,
    `a refused re-anchor reached writeBaseline (${wroteAfterRefusal} call(s)) — it must ` +
      'refuse BEFORE writing, or re-running the command absorbs the deletion',
  )
  expect(allowedRc === 0, `--allow-reductions did not permit the drop (exit ${allowedRc})`)
  expect(
    wroteAfterOptIn - wroteAfterRefusal === 1,
    '--allow-reductions did not reach writeBaseline exactly once ' +
      `(${wroteAfterOptIn - wroteAfterRefusal} call(s))`,
  )
  expect(
    strayFlagRc === 2,
    '`--allow-reductions` without `--update-baseline --all` was swallowed instead of ' +
      `refused (exit ${strayFlagRc})`,
  )
  const realMissing = missingCrateRoots(CRATE_ROOTS, REPO_ROOT)
  expect(
    realMissing.length === 0,
    `the real CRATE_ROOTS reported a missing root: ${JSON.stringify(realMissing)}`,
  )
  return cases
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  process.exitCode = main(process.argv.slice(2))
}
