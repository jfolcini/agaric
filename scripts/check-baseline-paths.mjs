#!/usr/bin/env node
// Every path named by a baseline, allowlist or embedded exemption set must
// resolve (#4501).
//
// A path-keyed guard whose subject moves does not fail: it matches nothing,
// reports nothing and exits 0. The allowlist checkers cannot see a dangling
// entry at all, because they walk discovered files and ask "is this one
// allowed?", never "does this entry still name a file?". This asks the second
// question and nothing else: no opinion about hooks, scan roots or `files:`
// triggers.
//
//     node scripts/check-baseline-paths.mjs        # check
//     node scripts/check-baseline-paths.mjs -v     # + per-source counts
//
// Exits 1 on a finding, 2 on an unknown argument.
//
// THE POPULATION. Data files are DISCOVERED: every tracked file whose basename
// contains `baseline`, `allowlist` or `allow-list`, whatever its extension. A
// discovered file in neither `DATA_SOURCES` nor `NO_PATHS` is a failure, not a
// skip, so a baseline added tomorrow is either covered or loud. Discovery asks
// `git ls-files` rather than walking the disk, because a walk also sees
// gitignored copies (`.stryker-tmp/sandbox-*/scripts/`, Android build output)
// and would fail every commit in a checkout that has them. A git enumeration
// that fails or comes back empty is a finding.
//
// Sets embedded in guard sources cannot be discovered, so they are declared in
// `EMBEDDED_SOURCES`. Each declaration must still name an existing file and
// still yield at least one entry, so a renamed constant fails loudly. A
// PARTIAL under-extraction is still silent: a set assembled from several
// literals (`[...] + EXTRA`), a backtick template literal or a `/* */` comment
// inside the literal, and an escape (`\x` is dropped with its backslash).
// Keep these sets to one literal of plain quoted paths. A `{key: value}`
// literal yields its keys only, so the paths must be on the left.
//
// Entries containing `*` or `?` are globs and are skipped per entry, not per
// set: "matches at least one path" is a different assertion, and a
// forward-looking pattern is legal. The skipped count is printed.
//
// No `--self-test`: a defect in an existence check shows up as a false
// positive, which announces itself. The end-to-end cases live in
// scripts/check-baseline-paths.test.mjs.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { GIT_LS_FILES_MAX_BUFFER } from './lib/guard-file-source.mjs'

const REPO_ROOT = realpathSync(join(import.meta.dirname, '..'))

// Tracked directories not searched: the session-log corpus, whose prose
// filenames legitimately contain "baseline". Anchored to the directory it
// means, not matched as a bare segment, so a baseline under some other
// `session-log/` stays visible.
const PRUNE_DIRS = ['docs/session-log/']

// repo-relative path -> [extractor, base directory the entries are relative to].
// `base` is declared, not guessed: one of these is relative to `src-tauri/`,
// and guessing would make a dangling entry look resolvable.
export const DATA_SOURCES = {
  // JSON array of objects; the `fn` field is `<path>::<symbol>`.
  'scripts/bulk-equivalence-baseline.json': ['json:fn::', '.'],
  // JSON array of objects keyed by a `file` field.
  'scripts/content-regex-baseline.json': ['json:file', '.'],
  // `file` is the document carrying the citation and must resolve. The `ref`
  // field is the cited code path and is excluded: a `ref` that no longer
  // resolves is what this baseline grandfathers.
  'scripts/doc-code-paths-baseline.json': ['json:file', '.'],
  // `<count> <path>` text lines.
  'src-tauri/dynamic-sql-baseline.txt': ['text:count-path', '.'],
  // One path per line, relative to `src-tauri/` (the file's header says so).
  'src-tauri/unsafe-allowlist.txt': ['text:lines', 'src-tauri'],
}

// Discovered files that name no paths, with the reason, so "checked and found
// nothing to check" reads differently from "never looked".
export const NO_PATHS = {
  'scripts/coverage-baseline.json': 'two coverage percentages, no paths',
  'scripts/metric-firing-baseline.json': 'metric symbol names (`Type::field`)',
  'src-tauri/migrations-test-coverage-baseline.txt':
    'bare migration NUMBERS (`0001`), not filenames — the guard resolves ' +
    'them against test names, not the filesystem',
  'src-tauri/table-ownership-baseline.txt':
    '`<count> <crate> <table>` — crate labels and SQL table names',
  // Matched by name but are guard scripts, not their data.
  'scripts/check-unsafe-allowlist.sh': 'a guard script, not an allowlist',
  'scripts/check-baseline-paths.mjs': 'this script — it DECLARES the population, it is not in it',
  'scripts/check-baseline-paths.test.mjs': "this script's test, not its data",
}

// [repo-relative guard file, constant name, base directory]. Each is asserted
// below to still find its constant and still yield entries.
export const EMBEDDED_SOURCES = [
  // Sanctioned raw-transaction sites. Mixed exact paths and `**` globs.
  ['scripts/check-raw-tx.mjs', 'ALLOWLIST_GLOBS', '.'],
  // Sanctioned raw `invoke(` / `localStorage` seams.
  ['scripts/check-raw-invoke.mjs', 'EXEMPT_FILES', '.'],
  // Directory prefixes: existence covers both, and a prefix that stopped
  // naming a directory exempts nothing just as silently.
  ['scripts/check-raw-invoke.mjs', 'EXEMPT_DIR_PREFIXES', '.'],
  ['scripts/check-raw-local-storage.mjs', 'EXEMPT_FILES', '.'],
  // Components allowed to have no IPC error-path test.
  ['scripts/check-ipc-error-path.mjs', 'NO_TEST_ALLOWLIST', '.'],
]

// Embedded sets deliberately NOT declared, because they name something other
// than a repo-relative path:
//   check-git-fixture-isolation.mjs EXEMPT_BASENAMES  — bare basenames
//   check-store-layering.mjs PAGE_BLOCK_STORE_*       — basenames under src/stores/
//   check-raw-tx.mjs BIN_FILE_GLOBS, lib/rust-scan.mjs TEST_FILE_GLOBS,
//     EXTRA_TEST_FILE_GLOBS                           — structural patterns
//   check-table-ownership.mjs OWNER / EXTRA_TEST_...  — table names / patterns
// Two path-keyed sets are excluded for reasons about this script:
//   check-dead-symbol-citations.mjs ALLOWED_FILE_BY_SYMBOL — `{symbol: path}`,
//     paths on the RIGHT; the extractor returns keys, so declaring it would
//     fail on every symbol name.
//   check-tauri-command-sanitize.mjs ALLOWLIST — must stay empty, so the
//     "yielded no entries" arm would fail permanently.
// Scan roots (`CRATE_ROOTS`, `SCAN_ROOTS`) are each owning guard's own check.

const BANNERS = {
  dangling: 'Baseline/allowlist path guard (#4501) — an entry names a path that does not exist:\n',
  unknown:
    "Baseline/allowlist path guard (#4501) — a baseline/allowlist file is outside this check's\n" +
    'declared population:\n',
  unread:
    'Baseline/allowlist path guard (#4501) — a declared set was NOT READ, so nothing in it was\n' +
    'checked:\n',
  discovery:
    'Baseline/allowlist path guard (#4501) — the repository could not be ENUMERATED, so the\n' +
    'population is unknown:\n',
  vanished:
    'Baseline/allowlist path guard (#4501) — a DECLARED source is gone from the checkout:\n',
}

const HINTS = {
  dangling: [
    '',
    '    -> A dangling entry protects nothing: the guard that owns it',
    "       walks discovered files and asks 'is this one allowed?', never",
    "       'does this entry still name a file?'. Repoint the entry at",
    '       where the file moved, or delete it if the subject is gone —',
    "       and check whether the OWNING guard's scan roots followed the",
    '       move too, which is the half this check cannot see.',
    '',
  ].join('\n'),
  unknown: [
    '',
    '    -> Not a dangling entry. Discovery fails CLOSED on purpose: a',
    '       baseline this script has never been taught to read would',
    '       otherwise be silently exempt from the one check that exists to',
    '       stop baselines going stale. Add it to DATA_SOURCES, or to',
    '       NO_PATHS with the reason its entries are not paths.',
    '',
  ].join('\n'),
  unread: [
    '',
    '    -> Not a dangling entry, and NOT a pass: a set that yields no',
    '       entries contributes zero findings for the same reason an empty',
    '       one does, which is how a guard reports success over a subject',
    "       it stopped reading (#4501's whole subject). Fix the extractor",
    '       or the declaration; do not delete the source to quiet it.',
    '',
  ].join('\n'),
  vanished: [
    '',
    '    -> The inverse of `unknown`: this file IS declared and has gone',
    '       MISSING, so the declaration now protects nothing. Either the',
    '       source moved — repoint the DATA_SOURCES / NO_PATHS key — or it',
    '       was deleted, in which case remove the declaration. Leaving it',
    '       is a stale entry in a hand-maintained set, which is precisely',
    '       what this guard exists to catch.',
    '',
  ].join('\n'),
  discovery: [
    '',
    '    -> Not a dangling entry, and NOT a pass. Discovery asks git for',
    "       the tracked file list; if that fails, the 'is anything new",
    "       unaccounted for?' half of this check silently becomes a",
    '       negative claim over an empty set — which is the exact shape',
    '       #4501 exists to end. Run this from inside a git checkout.',
    '',
  ].join('\n'),
}

// Composed, not chosen by priority: a run red for two reasons prints both, so
// an unread set is never reported as a moved file.
const KIND_ORDER = ['dangling', 'unknown', 'vanished', 'unread', 'discovery']

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Strict UTF-8: invalid bytes throw instead of becoming U+FFFD. */
function readText(path) {
  return UTF8.decode(readFileSync(path))
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Quoted strings inside `name`'s collection literal, or null if absent.
 *
 * A bracket-depth scan from the constant's assignment to the matching close,
 * not a language parser; "found nothing" is failed loudly by the caller. A
 * string whose next non-space character is `:` is a mapping key, and if the
 * literal has any, only the keys are returned: a `{path: reason}` allowlist
 * states paths on the left and prose on the right. A `//` comment line inside
 * the literal (a commented-out example entry) is not a declaration.
 */
function stringsInLiteral(text, name) {
  let hit = -1
  for (const lead of [`\nconst ${name} `, `\nexport const ${name} `]) {
    hit = text.indexOf(lead)
    if (hit !== -1) break
  }
  if (hit === -1) return null
  let i = text.indexOf('=', hit)
  if (i === -1) return null
  let depth = 0
  let started = false
  let quote = ''
  let buf = ''
  let pending = null
  const pairs = []
  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) {
        pending = buf
        buf = ''
        quote = ''
      } else {
        buf += ch
      }
    } else if (pending !== null && !/\s/.test(ch)) {
      pairs.push([pending, ch === ':'])
      pending = null
      // Re-dispatch this character as code on the next pass.
      continue
    } else if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i)
      if (nl === -1) break
      i = nl
    } else if (ch === "'" || ch === '"') {
      quote = ch
      buf = ''
    } else if ('([{'.includes(ch)) {
      depth += 1
      started = true
    } else if (')]}'.includes(ch)) {
      depth -= 1
      if (started && depth <= 0) break
    }
    i += 1
  }
  if (pending !== null) pairs.push([pending, false])
  if (!started) return null
  if (pairs.some(([, isKey]) => isKey)) return pairs.filter(([, isKey]) => isKey).map(([s]) => s)
  return pairs.map(([s]) => s)
}

/**
 * Every file git tracks under `REPO_ROOT`, or null if git could not say.
 *
 * null, not `[]`: "git is not available here" and "this repository tracks no
 * files" must not collapse into a silent zero, which reads as a pass. The
 * caller turns either into a finding.
 */
function trackedFiles() {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: GIT_LS_FILES_MAX_BUFFER,
  })
  if (r.error || r.status !== 0) return null
  const files = r.stdout.split('\0').filter(Boolean)
  return files.length > 0 ? files : null
}

/** Every path-shaped entry a data source declares. Throws if it cannot be
 * read as `kind`. */
function entriesOf(kind, path) {
  const text = readText(path)
  if (kind.startsWith('json:')) {
    const field = kind.slice('json:'.length)
    const key = field.endsWith('::') ? field.slice(0, -2) : field
    const values = []
    for (const o of JSON.parse(text)) {
      if (!(key in o)) throw new Error(`missing field \`${key}\``)
      values.push(String(o[key]))
    }
    return key === field ? values : values.map((v) => v.split('::')[0])
  }
  const lines = text
    .split(/\r\n?|\n/)
    .map((ln) => ln.trim())
    .filter((ln) => ln && !ln.startsWith('#'))
  if (kind === 'text:count-path') {
    return lines.flatMap((ln) => {
      const m = /^\S+\s+(\S[\s\S]*)$/.exec(ln)
      return m ? [m[1].trim()] : []
    })
  }
  return lines
}

/** Push a finding per dangling entry. Returns [nDangling, nGlobs]. */
function checkEntries(label, entries, base, findings) {
  const root = base === '.' ? REPO_ROOT : join(REPO_ROOT, base)
  let dangling = 0
  let globs = 0
  for (const entry of entries) {
    if (entry.includes('*') || entry.includes('?')) {
      globs += 1
      continue
    }
    if (!existsSync(resolve(root, entry))) {
      dangling += 1
      findings.push(['dangling', `${label}: \`${entry}\` names a path that does not exist`])
    }
  }
  return [dangling, globs]
}

/** Discovery, failing CLOSED on an unrecognised baseline-shaped file and on a
 * declared file that has gone. */
function discover(findings) {
  let tracked = trackedFiles()
  if (tracked === null) {
    findings.push([
      'discovery',
      '`git ls-files` did not return a tracked file list, so no ' +
        'baseline could be DISCOVERED. The declared sources below were ' +
        'still checked, but a baseline added outside them would have gone ' +
        'unnoticed — which is the failure this check exists to prevent.',
    ])
    tracked = []
  }
  for (const rel of tracked) {
    if (PRUNE_DIRS.some((d) => rel.startsWith(d))) continue
    const low = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
    if (!(low.includes('baseline') || low.includes('allowlist') || low.includes('allow-list'))) {
      continue
    }
    if (Object.hasOwn(DATA_SOURCES, rel) || Object.hasOwn(NO_PATHS, rel)) continue
    findings.push([
      'unknown',
      `${rel}: a tracked file whose BASENAME matches ` +
        'baseline/allowlist/allow-list, which this script has never ' +
        'been taught to read. Three answers, and the third is the ' +
        'common one for ordinary source: (1) it IS guard data with ' +
        'paths -> DATA_SOURCES, with the base directory its entries ' +
        'are relative to; (2) it IS guard data naming no paths -> ' +
        'NO_PATHS, with the reason; (3) it is NOT guard data at all ' +
        '(app source, a test fixture) -> NO_PATHS is still the right ' +
        'home, and the reason should say so plainly, e.g. ' +
        "'application source, not a guard baseline'. Discovery is " +
        'basename-based on purpose, so it will keep finding it.',
    ])
  }
  // Both declaration tables get the existence check: a NO_PATHS entry whose
  // file is gone is a stale path in a hand-maintained set too.
  const declared = [
    ...Object.keys(DATA_SOURCES).map((rel) => [rel, 'DATA_SOURCES']),
    ...Object.keys(NO_PATHS).map((rel) => [rel, 'NO_PATHS']),
  ]
  for (const [rel, table] of declared) {
    if (!isFile(join(REPO_ROOT, rel))) {
      findings.push(['vanished', `${rel}: declared in ${table} but not in this checkout`])
    }
  }
}

function checkDataSources(findings, perSource) {
  for (const rel of Object.keys(DATA_SOURCES).toSorted()) {
    const [kind, base] = DATA_SOURCES[rel]
    const src = join(REPO_ROOT, rel)
    if (!isFile(src)) continue
    let entries
    try {
      entries = entriesOf(kind, src)
    } catch (err) {
      findings.push([
        'unread',
        `${rel}: could not be read as \`${kind}\` (${err.name}: ${err.message})`,
      ])
      continue
    }
    if (entries.length === 0) {
      findings.push([
        'unread',
        `${rel}: yielded ZERO entries. Either the file was emptied, or ` +
          `its format changed under the \`${kind}\` extractor — which would ` +
          'make this script report success over a set it stopped reading.',
      ])
      continue
    }
    const [dangling, globs] = checkEntries(rel, entries, base, findings)
    perSource.push([rel, entries.length - dangling - globs, globs])
  }
}

function checkEmbeddedSources(findings, perSource) {
  for (const [rel, name, base] of EMBEDDED_SOURCES) {
    const src = join(REPO_ROOT, rel)
    if (!isFile(src)) {
      findings.push(['unread', `${rel}: declared as carrying \`${name}\` but not in this checkout`])
      continue
    }
    let entries
    try {
      const text = `\n${readText(src)}`.replaceAll(/\r\n?/g, '\n')
      entries = stringsInLiteral(text, name)
    } catch (err) {
      findings.push([
        'unread',
        `${rel}: could not be read for \`${name}\` (${err.name}: ${err.message})`,
      ])
      continue
    }
    if (!entries || entries.length === 0) {
      findings.push([
        'unread',
        `${rel}: \`${name}\` yielded no entries — renamed, restructured or ` +
          'emptied. Until this is corrected the set is UNCHECKED, which is ' +
          'the failure mode #4501 is about.',
      ])
      continue
    }
    const [dangling, globs] = checkEntries(`${rel}:${name}`, entries, base, findings)
    perSource.push([`${rel}:${name}`, entries.length - dangling - globs, globs])
  }
}

function main(argv) {
  const verbose = argv.includes('-v') || argv.includes('--verbose')
  const unknown = argv.filter((a) => a !== '-v' && a !== '--verbose')
  if (unknown.length > 0) {
    console.error(`check-baseline-paths: unknown argument(s): ${JSON.stringify(unknown)}`)
    return 2
  }

  // [kind, message]; the kind picks the banner and the hint.
  const findings = []
  // [label, resolved, globs]
  const perSource = []
  discover(findings)
  checkDataSources(findings, perSource)
  checkEmbeddedSources(findings, perSource)

  if (verbose) {
    for (const [label, n, g] of perSource) {
      console.log(
        `  ${String(n).padStart(4)} path(s)${(g ? ` (+${g} glob)` : '').padStart(12)}  ${label}`,
      )
    }
  }

  if (findings.length > 0) {
    for (const kind of KIND_ORDER) {
      const hits = findings.filter(([k]) => k === kind).map(([, m]) => m)
      if (hits.length === 0) continue
      console.error(BANNERS[kind])
      for (const m of hits) console.error(`  ${m}`)
      console.error(HINTS[kind])
    }
    return 1
  }

  const checked = perSource.reduce((sum, [, n]) => sum + n, 0)
  const globs = perSource.reduce((sum, [, , g]) => sum + g, 0)
  if (checked === 0) {
    console.error(
      'check-baseline-paths: checked ZERO paths. A negative claim over an empty set is not a pass.',
    )
    return 1
  }
  console.log(
    `check-baseline-paths: ${checked} path(s) resolve, across ` +
      `${perSource.length} baseline/allowlist set(s)` +
      `${globs ? `; ${globs} glob entr(ies) skipped` : ''}.`,
  )
  return 0
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  process.exitCode = main(process.argv.slice(2))
}
