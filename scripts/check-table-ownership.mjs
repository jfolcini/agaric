#!/usr/bin/env node
// Per-(crate, table) raw-write table-ownership baseline guard (#2895).
//
// The SQLite store is written from several crates. Each core table has ONE
// owner crate (`OWNER`); the others are meant to call an owner function
// rather than open-code a raw `sqlx` write, because cross-crate raw writes
// are how a table's invariants (cache coherence, op-log append order,
// soft-delete rules) drift out of one place.
//
// Counts raw writes (`INSERT [OR …] INTO t`, `REPLACE INTO t`, `UPDATE t`,
// `DELETE FROM t`) per (crate, table) under every crate root and fails when a
// NON-owner pair's count exceeds `src-tauri/table-ownership-baseline.txt`.
// Owner writes are never recorded. Ownership is an aggregate, so the whole
// tree is rescanned whatever files prek passes.
//
//     node scripts/check-table-ownership.mjs
//     node scripts/check-table-ownership.mjs --update-baseline   # re-anchor
//     node scripts/check-table-ownership.mjs --self-test
//
// The SQL lives inside `sqlx::query!("…")` strings, so only comments are
// blanked before matching; string contents are kept.
//
// A declared crate root that does not exist fails the run (#4501): the walk
// would otherwise narrow to nothing and pass. `--update-baseline` refuses for
// the same reason, since re-anchoring against a narrowed walk deletes every
// count under the vanished root. `--synthetic-tree` says the tree is
// deliberately not this repository and skips that check; it is rejected with
// `--update-baseline`, which would re-anchor from the surviving roots only.
//
// Baseline format: each data line is `<count> <crate> <table>` with an
// optional trailing `# comment`; blank and full-line `#` lines are ignored for
// counts, and any other data line is a hard error. `--update-baseline`
// recomputes the counts only: the header (lines before the first pair), the
// footer (lines after the last), and each surviving pair's inline comment and
// the comment block directly above it are kept, so re-running it on an
// unchanged tree is byte-identical. A vanished pair loses its annotations; a
// new pair is emitted bare.
//
// The judged tree is the one containing this script (see
// scripts/lib/guard-file-source.mjs, "Which TREE is judged").

import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CRATE_ROOTS,
  WORD,
  WORD_END,
  WS,
  cfgTestLineSet,
  isDirectory,
  isExcludedFile,
  missingCrateRoots,
  splitLines,
  stripRustComments,
  trimSpace,
  write,
} from './lib/rust-scan.mjs'

export { CRATE_ROOTS }

const REPO_ROOT = realpathSync(join(import.meta.dirname, '..'))
const BASELINE_REL = 'src-tauri/table-ownership-baseline.txt'
const BASELINE_PATH = join(REPO_ROOT, BASELINE_REL)

// The short name each crate goes by in the baseline.
const CRATE_LABELS = new Map([
  ['src-tauri/agaric-store/src/', 'store'],
  ['src-tauri/agaric-engine/src/', 'engine'],
  ['src-tauri/agaric-sync/src/', 'sync'],
  // Scanned so a future non-bin write there is caught; today it holds only
  // standalone audit bins, which `**/src/bin/**` excludes.
  ['src-tauri/diagnostics/src/', 'diagnostics'],
  ['src-tauri/src/', 'app'],
])

// [label, repo-relative root with a trailing slash]
const LABELLED_ROOTS = CRATE_ROOTS.map((root) => {
  const label = CRATE_LABELS.get(root)
  if (label === undefined) throw new Error(`no crate label for ${root} in CRATE_LABELS`)
  return [label, root]
})

// The crate that owns each core table. `blocks` and `op_log` are known
// multi-writer debt frozen by the baseline, not clean single-writer tables
// (src-tauri/migrations/AGENTS.md, "Table ownership").
const OWNER = new Map([
  ['blocks', 'engine'],
  ['op_log', 'store'],
  ['peer_refs', 'store'],
  ['pages_cache', 'store'],
  ['tags_cache', 'store'],
  ['agenda_cache', 'store'],
  ['block_links', 'store'],
  ['page_link_cache', 'store'],
  ['projected_agenda_cache', 'store'],
  ['block_tag_refs', 'store'],
  ['block_tag_inherited', 'store'],
])

// `\s+` lets a statement span lines inside a macro string; the trailing word
// boundary keeps `blocks` from matching `block_links`, `_new_blocks` or
// `blocks_fts`. Bare `REPLACE INTO` is SQLite's synonym for `INSERT OR
// REPLACE INTO`, so it has its own arm.
function writeRe(table) {
  return new RegExp(
    `(?:INSERT(?:${WS}+OR${WS}+${WORD}+)?${WS}+INTO|REPLACE${WS}+INTO|UPDATE|DELETE${WS}+FROM)` +
      `${WS}+${table}${WORD_END}`,
    'giu',
  )
}

const WRITE_RES = new Map([...OWNER.keys()].map((table) => [table, writeRe(table)]))

const HINT = [
  '    -> #2895 table ownership: a NEW cross-crate raw write to a table',
  "       you do not own. Prefer calling the owning crate's store/owner",
  '       function instead of open-coding a raw `sqlx` write here. If the',
  '       cross-crate write is genuinely required, re-anchor the baseline:',
  '         node scripts/check-table-ownership.mjs --update-baseline',
  '       (regenerate after REMOVING a cross-crate site too, to lower the',
  '       floor). Ownership map: src-tauri/migrations/AGENTS.md.',
].join('\n')

const ROOT_MISSING_HINT = [
  '    -> #4501: a CRATE_ROOTS entry in scripts/lib/rust-scan.mjs',
  '       names a directory that does not exist. Fix the LIST, not the',
  '       baseline: the walk skips a missing root, so re-anchoring here',
  '       would drop every count under it and report success. If the crate',
  '       was genuinely retired, remove its root from CRATE_ROOTS in the',
  '       same commit, then re-anchor.',
].join('\n')

// Used only when no baseline file exists to keep the header of.
const DEFAULT_HEADER = [
  '# Table-ownership baseline (#2895) — per-(crate, table) count of NON-owner raw',
  '# write sites (`INSERT [OR ...] INTO t` / `UPDATE t` / `DELETE FROM t`).',
  '# Generated by: node scripts/check-table-ownership.mjs --update-baseline',
  '# The check-table-ownership prek hook fails when a non-owner (crate, table)',
  "# pair's count EXCEEDS its baseline. Owner-crate writes are unconstrained and",
  '# never listed here. Ownership map: src-tauri/migrations/AGENTS.md.',
  '#',
  '# Format: <count> <crate> <table>  [# annotation]',
  '# Blank lines and full-line `#` comments are ignored when parsing counts; an',
  '# inline `# …` after the three fields documents WHY a cross-crate write is a',
  '# sanctioned carve-out or WHEN it migrates. `--update-baseline` recomputes the',
  "# counts but PRESERVES this header, every surviving pair's inline comment and",
  '# the comment block directly above it (keyed by crate+table), and any footer.',
  '',
]

/** {table: [0-based line indices]} of raw writes in `text`. Pure. */
function countWritesInText(text) {
  const stripped = stripRustComments(text, { keepStrings: true })
  const testLines = cfgTestLineSet(splitLines(stripped))
  const hits = new Map()
  for (const [table, rx] of WRITE_RES) {
    for (const m of stripped.matchAll(rx)) {
      // Lines counted in `\n` only, though the test lines follow every line
      // break: the two part on a `\v` or `\f`.
      const idx = stripped.slice(0, m.index).split('\n').length - 1
      if (testLines.has(idx)) continue
      if (!hits.has(table)) hits.set(table, [])
      hits.get(table).push(idx)
    }
  }
  return hits
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function readSource(path) {
  try {
    return UTF8.decode(readFileSync(path)).replace(/\r\n?/g, '\n')
  } catch {
    return null
  }
}

const pairKey = (crate, table) => JSON.stringify([crate, table])

/**
 * Whole-tree scan: Map of pair key -> {crate, table, count, files}, `files`
 * being the repo-relative paths carrying the writes.
 */
function computeCounts(crateRoots) {
  const counts = new Map()
  for (const [crate, root] of crateRoots) {
    if (!isDirectory(join(REPO_ROOT, root))) continue
    for (const sub of readdirSync(join(REPO_ROOT, root), { encoding: 'utf8', recursive: true })) {
      // A directory named `*.rs` fails to read and is skipped.
      if (!sub.endsWith('.rs')) continue
      const rel = `${root}${sub}`
      if (isExcludedFile(rel)) continue
      const text = readSource(join(REPO_ROOT, rel))
      if (text === null) continue
      for (const [table, indices] of countWritesInText(text)) {
        const key = pairKey(crate, table)
        if (!counts.has(key)) counts.set(key, { crate, table, count: 0, files: new Set() })
        const entry = counts.get(key)
        entry.count += indices.length
        entry.files.add(rel)
      }
    }
  }
  return counts
}

/** The non-owner pairs: owner writes never fail, so they are never listed. */
function nonOwnerCounts(counts) {
  const baseline = new Map()
  for (const [key, { crate, table, count }] of counts) {
    if (count > 0 && OWNER.get(table) !== crate) baseline.set(key, { crate, table, count })
  }
  return baseline
}

class BaselineFormatError extends Error {}

/**
 * Split an annotated baseline into header, entries and footer. Each entry
 * keeps its inline `suffix` (whitespace plus optional `# comment`, verbatim,
 * so a round trip is byte-identical) and the comment/blank lines `preceding`
 * it.
 */
function parseBaselineText(text) {
  let header = []
  const entries = new Map()
  let footer = []
  let pending = []
  let seenData = false
  for (const raw of splitLines(text)) {
    const stripped = trimSpace(raw)
    if (!stripped || stripped.startsWith('#')) {
      pending.push(raw)
      continue
    }
    const [code] = raw.split('#', 1)
    const tokens = trimSpace(code).split(SPACE_RUN)
    if (tokens.length !== 3 || !/^[0-9]+$/.test(tokens[0])) {
      throw new BaselineFormatError(
        `malformed baseline line (expected '<count> <crate> <table>  [# comment]'): ${JSON.stringify(raw)}`,
      )
    }
    const [count, crate, table] = [Number(tokens[0]), tokens[1], tokens[2]]
    const suffix = raw.slice(code.replace(TRAILING_SPACE, '').length)
    let preceding = pending
    // Lines before the first pair are the header, not that pair's block, or
    // a render would emit them twice.
    if (!seenData) {
      header = pending
      seenData = true
      preceding = []
    }
    pending = []
    entries.set(pairKey(crate, table), { count, suffix, preceding })
  }
  if (seenData) footer = pending
  else header = pending
  return { header, entries, footer }
}

const SPACE_RUN = new RegExp(`${WS}+`, 'u')
const TRAILING_SPACE = new RegExp(`${WS}+$`, 'u')

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const comparePairs = (a, b) => byText(a.crate, b.crate) || byText(a.table, b.table)

/** `counts`, sorted, with the parsed file's header, footer and annotations. */
function renderBaseline({ header, entries, footer }, counts) {
  const out = [...header]
  for (const { crate, table, count } of [...counts.values()].toSorted(comparePairs)) {
    const ent = entries.get(pairKey(crate, table))
    if (ent !== undefined) out.push(...ent.preceding)
    out.push(`${count} ${crate} ${table}${ent?.suffix ?? ''}`)
  }
  out.push(...footer)
  return `${out.join('\n')}\n`
}

function readBaselineText() {
  try {
    return readFileSync(BASELINE_PATH, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function writeBaseline(counts) {
  const text = readBaselineText()
  const parsed =
    text === null
      ? { header: [...DEFAULT_HEADER], entries: new Map(), footer: [] }
      : parseBaselineText(text)
  writeFileSync(BASELINE_PATH, renderBaseline(parsed, counts))
}

/** Map of pair key -> baseline count; empty when there is no file. */
function readBaseline() {
  const text = readBaselineText()
  if (text === null) return new Map()
  const counts = new Map()
  for (const [key, { count }] of parseBaselineText(text).entries) counts.set(key, count)
  return counts
}

function main(argv) {
  const err = write(process.stderr)
  if (argv.includes('--self-test')) return runSelfTest()
  const synthetic = argv.includes('--synthetic-tree')
  const update = argv.includes('--update-baseline')
  if (synthetic && update) {
    err(
      '--synthetic-tree and --update-baseline are mutually exclusive: the first says\n' +
        "this tree's crate roots do not apply, the second rewrites the baseline FROM those\n" +
        'roots. Together they would silently drop every count under a root that is missing.',
    )
    return 2
  }
  const missing = synthetic ? [] : missingCrateRoots(CRATE_ROOTS, REPO_ROOT)
  if (missing.length > 0) {
    err(
      update
        ? 'Refusing to re-anchor: a declared CRATE_ROOTS entry is missing.\n'
        : 'Table-ownership guard (#2895) — a declared CRATE_ROOTS directory does not exist:\n',
    )
    for (const rel of missing) err(`  ${rel}`)
    err('')
    err(ROOT_MISSING_HINT)
    return 1
  }
  if (update) {
    writeBaseline(nonOwnerCounts(computeCounts(LABELLED_ROOTS)))
    write(process.stdout)(`Wrote ${BASELINE_REL}`)
    return 0
  }

  const counts = computeCounts(LABELLED_ROOTS)
  let baseline
  try {
    baseline = readBaseline()
  } catch (error) {
    if (!(error instanceof BaselineFormatError)) throw error
    err(
      `Table-ownership guard (#2895): ${error.message}\n` +
        `      Fix ${BASELINE_REL} or regenerate it with --update-baseline.`,
    )
    return 1
  }

  const violations = []
  for (const [key, { crate, table, count, files }] of [...counts].toSorted(([, a], [, b]) =>
    comparePairs(a, b),
  )) {
    if (OWNER.get(table) === crate) continue
    const base = baseline.get(key) ?? 0
    // At or below the baseline is grandfathered.
    if (count <= base) continue
    violations.push(
      `${crate} crate has ${count} raw write(s) to '${table}' ` +
        `(baseline ${base}; owner = ${OWNER.get(table)} crate)\n` +
        `      files: ${[...files].toSorted(byText).join(', ')}`,
    )
  }
  if (violations.length > 0) {
    err('Table-ownership guard (#2895) — new cross-crate raw write(s) past baseline:\n')
    for (const v of violations) err(`  ${v}`)
    err('')
    err(HINT)
    return 1
  }
  return 0
}

// --- self-test --------------------------------------------------------------

// [fixture, table, expect a match]
const REGEX_CASES = [
  // The real spellings, a multi-line one inside a string included.
  ['sqlx::query!("INSERT OR IGNORE INTO blocks (id) VALUES (?)")', 'blocks', true],
  ['UPDATE blocks\n            SET position = ? WHERE id = ?', 'blocks', true],
  ['update blocks set position = ?', 'blocks', true],
  ['sqlx::query!("DELETE FROM op_log WHERE seq > ?")', 'op_log', true],
  ['INSERT OR REPLACE INTO peer_refs (peer_id) VALUES (?)', 'peer_refs', true],
  ['sqlx::query!("REPLACE INTO blocks (id) VALUES (?)")', 'blocks', true],
  // Word-boundary and prefix hazards, the REPLACE arm included.
  ['UPDATE block_links SET target_id = ?', 'blocks', false],
  ['INSERT INTO _new_blocks SELECT * FROM blocks_old', 'blocks', false],
  ['UPDATE blocks_fts SET c0 = ?', 'blocks', false],
  ['REPLACE INTO block_links (source_id) VALUES (?)', 'blocks', false],
]

// [rel-path, expect excluded]
const EXCLUSION_CASES = [
  ['src-tauri/src/materializer_app_tests/apply_reproject_proptest.rs', true],
  ['src-tauri/agaric-sync/src/dag_tests/proptest_b2.rs', true],
  ['src-tauri/src/soft_delete/proptest_b3.rs', true],
  ['src-tauri/agaric-store/src/test_support.rs', true],
  ['src-tauri/diagnostics/src/bin/audit_cross_space_refs.rs', true],
  ['src-tauri/src/bulk_equivalence/blocks_lifecycle.rs', true],
  ['src-tauri/agaric-engine/src/materializer/handlers/mod.rs', false],
  ['src-tauri/agaric-store/src/op_log/append.rs', false],
]

const CFG_TEST_FIXTURE = `fn real() {
    sqlx::query!("DELETE FROM op_log WHERE seq > ?");
}
#[cfg(test)]
mod tests {
    fn t() {
        sqlx::query!("DELETE FROM op_log WHERE seq > 0");
    }
}
`

const PLAIN_BASELINE = '# header\n\n26 app blocks\n2 engine agenda_cache\n10 store blocks\n'
const ANNOTATED_BASELINE = `# header line one
# header line two

# --- app crate ---
26 app blocks  # migrating: slice 2

# engine caches are legitimate projection co-writers (#891)
2 engine agenda_cache  # projection co-writer
# === split contract ===
10 store blocks  # owner-adjacent: physical primitives
`

const countsOf = (entries) =>
  JSON.stringify(
    [...entries].map(([key, { count }]) => [key, count]).toSorted(([a], [b]) => byText(a, b)),
  )

function runSelfTest() {
  const failures = []
  const fail = (line) => failures.push(line)

  for (const [fixture, table, expect] of REGEX_CASES) {
    const got = fixture.search(WRITE_RES.get(table)) !== -1
    if (got !== expect) {
      fail(`regex[${table}] expected match=${expect}, got ${got}: ${JSON.stringify(fixture)}`)
    }
  }

  // Comment prose and `#[cfg(test)]` modules are not writes.
  const prose = '// update peer_refs when the lease expires\nlet x = 1;\n'
  if (countWritesInText(prose).has('peer_refs')) {
    fail("comment prose '// update peer_refs' counted a write")
  }
  const opLogHits = countWritesInText(CFG_TEST_FIXTURE).get('op_log') ?? []
  if (opLogHits.length !== 1) {
    fail(
      `expected exactly 1 op_log write outside #[cfg(test)], got ${opLogHits.length} ` +
        '(test-module write not excluded)',
    )
  }

  for (const [rel, expect] of EXCLUSION_CASES) {
    const got = isExcludedFile(rel)
    if (got !== expect) fail(`isExcludedFile('${rel}') expected ${expect}, got ${got}`)
  }

  const annotationCases = annotationSelfTest(fail)

  if (failures.length > 0) {
    const err = write(process.stderr)
    err('check-table-ownership self-test FAILED:')
    for (const f of failures) err(`  ${f}`)
    return 1
  }
  const total = REGEX_CASES.length + 2 + EXCLUSION_CASES.length + annotationCases
  write(process.stdout)(`check-table-ownership self-test passed (${total} cases).`)
  return 0
}

// An annotated baseline parses to its plain twin's counts, round-trips
// byte-identical, and a malformed data line is an error, not a skip.
function annotationSelfTest(fail) {
  const plain = countsOf(parseBaselineText(PLAIN_BASELINE).entries)
  const parsed = parseBaselineText(ANNOTATED_BASELINE)
  const annotated = countsOf(parsed.entries)
  if (plain !== annotated) {
    fail(`annotated baseline parsed to different counts than plain twin: ${annotated} != ${plain}`)
  }
  const roundTrip = new Map(
    [...parsed.entries].map(([key, { count }]) => {
      const [crate, table] = JSON.parse(key)
      return [key, { crate, table, count }]
    }),
  )
  const rendered = renderBaseline(parsed, roundTrip)
  if (rendered !== ANNOTATED_BASELINE) {
    fail(
      'annotation round-trip was not byte-identical:\n' +
        `--- expected ---\n${ANNOTATED_BASELINE}\n--- got ---\n${rendered}`,
    )
  }
  try {
    parseBaselineText('10 store # blocks\n')
    fail("malformed data line '10 store # blocks' did not raise BaselineFormatError")
  } catch (error) {
    if (!(error instanceof BaselineFormatError)) throw error
  }
  return 3
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  process.exitCode = main(process.argv.slice(2))
}
