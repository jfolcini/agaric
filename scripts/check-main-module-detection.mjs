// ─────────────────────────────────────────────────────────────────────
// Entry-point ("is this module the main module?") detection guard (#3373).
//
// ─── Why ──────────────────────────────────────────────────────────────
//
// Guard and filer scripts gate their `main()` behind a check that the
// module is the process entry point, so a `vitest` test can import their
// pure helpers without the module `process.exit()`ing out of the importer.
// Three idioms had drifted into scripts/, and ALL THREE are wrong:
//
//   const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
//   const isMain = process.argv[1] === import.meta.filename
//   const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename
//
// `import.meta.url` / `import.meta.filename` is the RESOLVED REAL path —
// Node realpaths the entry specifier when it loads an ES module. But
// `process.argv[1]` is the path AS INVOKED, verbatim. The two differ
// whenever the script is reached through a symlink: a symlinked
// `scripts/` directory, a symlinked repo root, a symlinked checkout path.
// When they differ the check is false, `main()` never runs, and the
// script EXITS 0 HAVING DONE NOTHING.
//
// A guard that exits 0 without running is indistinguishable from a guard
// that ran and passed. That is the exact false-green class this repo's
// CI-hardening work exists to eliminate, and it was sitting in the guard
// suite itself.
//
// The ``file://`` template form additionally breaks on any path
// containing a space (or `#`, `?`, non-ASCII…), because `import.meta.url`
// percent-encodes them and a raw string interpolation does not — no
// symlink required.
//
// ─── The one sanctioned form ──────────────────────────────────────────
//
//   import { realpathSync } from 'node:fs'
//   const isMainModule =
//     !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
//
// Both sides realpath'd, so the comparison is between two canonical
// physical paths no matter how either side was spelled. `fs.realpathSync`
// (namespace import) is equally accepted.
//
// NOT `import.meta.main`: it is only `Added in: v24.2.0, v22.18.0`, while
// `package.json` declares `engines.node: ">=24"`. On a permitted-but-older
// Node 24.0/24.1 it evaluates to `undefined` — falsy — which reproduces
// the very silent-no-op failure this guard exists to prevent, with no
// diagnostic at all. The realpath comparison has no version floor.
//
// ─── Detection ────────────────────────────────────────────────────────
//
// Two rules, over comment-stripped source:
//
//   file-url-argv            — `process.argv[1]` interpolated into or
//                              concatenated onto a `file://` string.
//   unrealpathed-entry-check — `process.argv[1]` used as an operand of a
//                              `===` / `!==` / `==` comparison within
//                              ~240 chars of an `import.meta.*`
//                              reference, where that operand is not
//                              wrapped in `realpathSync(...)`.
//
// Comments are stripped by a small scanner that TRACKS string, template
// and regex literals rather than a naive `//` sweep — the banned
// `` `file://${…}` `` form contains a `//` inside a template literal, and
// a naive stripper would blank the violation it is supposed to catch.
//
// Known scope limit (mirrors check-raw-invoke.mjs's documented narrowness):
// detection is syntactic and local, so an entry check laundered through an
// intermediate binding (`const entry = process.argv[1]; … === entry`) is
// not matched. No such form exists in the tree; the rule covers the shapes
// that actually drifted.
//
// ─── Self-scan ────────────────────────────────────────────────────────
//
// This file is INSIDE the scanned tree and is NOT exempted — a guard that
// excludes itself has an invisible blind spot. Every literal instance of a
// banned form in this file therefore lives either in a comment (stripped)
// or is assembled from fragments at runtime (see `ARGV1_TEXT`), so the
// scanner cannot match its own source. `--self-test` asserts both halves:
// that the real scan covers this file, and that the real scan is clean.
//
// Usage: node scripts/check-main-module-detection.mjs
//        node scripts/check-main-module-detection.mjs --root <dir>
//        node scripts/check-main-module-detection.mjs --self-test
// Exit:  0 = clean, 1 = at least one violation, 2 = repo layout /
//        self-test failure.
// ─────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const SCANNED_EXTENSIONS = Object.freeze(['.mjs', '.js'])
const SKIP_DIRS = Object.freeze(
  new Set(['node_modules', 'dist', 'coverage', 'target', '__pycache__', '.git', 'gen']),
)

// Assembled from fragments so this file never contains a literal instance
// of the forms it bans (see § Self-scan). Every message and every
// self-test fixture below is built from these, never typed out directly.
const ARGV1_TEXT = `process.argv[${'1'}]`
const META_URL_TEXT = `import.meta${'.'}url`
const META_FILE_TEXT = `import.meta${'.'}filename`

// ─── comment stripping ────────────────────────────────────────────────

const REGEX_MAY_START_RE =
  /(?:^|[([{,;:=!&|?+\-*%~^<>]|\b(?:return|typeof|case|in|of|do|else|yield|await|new|delete|void|instanceof))\s*$/

/**
 * Blank out `//` and block comments, preserving every newline and the
 * total length so line numbers stay exact. String, template and regex
 * literals are skipped over intact: a `//` inside a template literal is
 * not a comment, and a regex literal may contain unbalanced quotes
 * (`/(['"`])/`) that would otherwise desynchronise the scan.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  const out = src.split('')
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') i = blankLineComment(src, out, i)
    else if (c === '/' && d === '*') i = blankBlockComment(src, out, i)
    else if (c === "'" || c === '"') i = skipQuoted(src, i)
    else if (c === '`') i = skipTemplateLiteral(src, i)
    else if (c === '/' && startsRegex(out, i)) i = skipRegexLiteral(src, i)
    else i += 1
  }
  return out.join('')
}

/** Blank `//` … end of line. Returns the index of the newline (or EOF). */
function blankLineComment(src, out, i) {
  let j = i
  while (j < src.length && src[j] !== '\n') {
    out[j] = ' '
    j += 1
  }
  return j
}

/** Blank a `/* … *\/` comment, keeping newlines. Returns the index after it. */
function blankBlockComment(src, out, i) {
  let j = i
  while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) {
    if (src[j] !== '\n') out[j] = ' '
    j += 1
  }
  if (j < src.length) {
    out[j] = ' '
    out[j + 1] = ' '
    j += 2
  }
  return j
}

/** Skip a `'…'` / `"…"` literal. Returns the index after it. */
function skipQuoted(src, i) {
  const quote = src[i]
  let j = i + 1
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src[j] === quote) return j + 1
    j += 1
  }
  return j
}

/**
 * Skip a `` `…` `` template literal. Returns the index after the closing
 * backtick. Unlike `skipQuoted`, this cannot just scan for the next `` ` ``:
 * a `${…}` substitution can itself contain a quoted literal that embeds a
 * literal backtick character (e.g. `` `${'`'}` `` — inserting a backtick
 * into the rendered text), and a naive same-char scan treats that embedded
 * backtick as the template's own close. That desyncs the cursor for the
 * rest of the line: subsequent quote/comment characters get matched against
 * the wrong state, and a REAL trailing `//` can end up wrongly treated as a
 * genuine comment, blanking a real violation that follows it on that line
 * (found by construction while adversarially reviewing #3373's fix — see
 * the `${'`'}` self-test case below). Instead, `${…}` is skipped as
 * balanced, recursively-quote-aware code so an embedded delimiter inside it
 * can never be mistaken for the template's own boundary.
 */
function skipTemplateLiteral(src, i) {
  let j = i + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '`') return j + 1
    if (c === '$' && src[j + 1] === '{') {
      j = skipTemplateExpr(src, j + 2)
      continue
    }
    j += 1
  }
  return j
}

/**
 * Skip the body of a `${…}` template substitution, starting right after the
 * `${`. Tracks brace nesting and recurses into any quoted/template literal
 * found inside, so a delimiter embedded in a nested literal can't desync
 * the enclosing template's own scan. Returns the index after the matching
 * `}`.
 */
function skipTemplateExpr(src, i) {
  let depth = 1
  let j = i
  while (j < src.length && depth > 0) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '{') {
      depth += 1
      j += 1
    } else if (c === '}') {
      depth -= 1
      j += 1
    } else if (c === '`') {
      j = skipTemplateLiteral(src, j)
    } else if (c === "'" || c === '"') {
      j = skipQuoted(src, j)
    } else {
      j += 1
    }
  }
  return j
}

/** A `/` starts a regex literal only where a value may begin. */
function startsRegex(out, i) {
  return REGEX_MAY_START_RE.test(out.slice(Math.max(0, i - 24), i).join(''))
}

/** Skip a `/…/` regex literal, character classes included. */
function skipRegexLiteral(src, i) {
  let j = i + 1
  let inClass = false
  while (j < src.length) {
    const r = src[j]
    if (r === '\\') {
      j += 2
      continue
    }
    if (r === '\n') return j
    if (r === '[') inClass = true
    else if (r === ']') inClass = false
    else if (r === '/' && !inClass) return j + 1
    j += 1
  }
  return j
}

/** 1-based line number lookup for a character offset. */
function makeLineLookup(src) {
  const starts = [0]
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1)
  return (idx) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

// ─── detection ────────────────────────────────────────────────────────

const ARGV1_SRC = String.raw`process\s*\.\s*argv\s*\[\s*1\s*\]`
const FILE_URL_TEMPLATE_SRC = String.raw`file://\$\{\s*${ARGV1_SRC}\s*\}`
const FILE_URL_CONCAT_SRC = String.raw`['"\`]file://['"\`]\s*\+\s*${ARGV1_SRC}`

/** How far from a `process.argv[1]` we look for an `import.meta.*`. */
const CONTEXT_CHARS = 240

const META_NEAR_RE = /import\s*\.\s*meta\s*\.\s*(?:url|filename|dirname)/
// `…) === ` / `=== ` immediately after the operand.
const CMP_AFTER_RE = /^\s*\)*\s*(?:===|!==|==)/
// `=== `, `=== resolve(`, `=== path.resolve(` immediately before it.
const CMP_BEFORE_RE = /(?:===|!==|==)\s*(?:[\w$.]+\s*\(\s*){0,3}$/
// The operand is `realpathSync(…)` / `fs.realpathSync(…)`.
const REALPATH_WRAP_RE = /realpathSync\s*\(\s*$/

/**
 * Scan one file's source. Returns `{ rule, line, detail }` violations,
 * sorted by line. Pure over a string so the self-test can drive it.
 *
 * @param {string} src
 * @returns {{rule: string, line: number, detail: string}[]}
 */
export function scanSource(src) {
  const stripped = stripComments(src)
  const lineOf = makeLineLookup(stripped)
  const found = []
  const seen = new Set()
  const push = (idx, rule, detail) => {
    const line = lineOf(idx)
    const key = `${rule}|${line}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ rule, line, detail })
  }

  for (const source of [FILE_URL_TEMPLATE_SRC, FILE_URL_CONCAT_SRC]) {
    const re = new RegExp(source, 'g')
    let m
    while ((m = re.exec(stripped))) {
      push(
        m.index,
        'file-url-argv',
        `a \`file://\` URL built from \`${ARGV1_TEXT}\` — not realpath-resolved, and percent-encoding makes it false for any path containing a space`,
      )
    }
  }

  const argvRe = new RegExp(ARGV1_SRC, 'g')
  let m
  while ((m = argvRe.exec(stripped))) {
    const start = m.index
    const end = start + m[0].length
    const context = stripped.slice(Math.max(0, start - CONTEXT_CHARS), end + CONTEXT_CHARS)
    if (!META_NEAR_RE.test(context)) continue

    const before = stripped.slice(Math.max(0, start - 120), start)
    const after = stripped.slice(end, end + 40)
    if (!CMP_AFTER_RE.test(after) && !CMP_BEFORE_RE.test(before)) continue
    if (REALPATH_WRAP_RE.test(before)) continue

    push(
      start,
      'unrealpathed-entry-check',
      `\`${ARGV1_TEXT}\` compared against an \`import.meta\` path without \`realpathSync(...)\` — \`${META_URL_TEXT}\`/\`${META_FILE_TEXT}\` is the RESOLVED path, \`${ARGV1_TEXT}\` is the path AS INVOKED`,
    )
  }

  return found.toSorted((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

// ─── tree walk ────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function isScanned(name) {
  return SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/**
 * Every `.mjs` / `.js` under `<root>/scripts` (recursive) plus the ones
 * sitting at `<root>` itself (non-recursive — that is where the stryker
 * configs live). Sorted, absolute.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listScannedFiles(root) {
  const out = []
  const visit = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        visit(path.join(dir, entry.name))
      } else if (entry.isFile() && isScanned(entry.name)) {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  visit(path.join(root, 'scripts'))
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && isScanned(entry.name)) out.push(path.join(root, entry.name))
    }
  }
  return out.toSorted()
}

/**
 * Scan a tree. Returns `{ violations, scanned, files }` where `files` is
 * the repo-relative POSIX list actually read (the self-test asserts this
 * file is in it).
 *
 * @param {{root: string}} opts
 */
export function analyze({ root }) {
  const violations = []
  const files = []
  for (const file of listScannedFiles(root)) {
    const rel = toPosix(path.relative(root, file))
    files.push(rel)
    for (const v of scanSource(readFileSync(file, 'utf8'))) violations.push({ file: rel, ...v })
  }
  return { violations, scanned: files.length, files }
}

// ─── entry point ──────────────────────────────────────────────────────

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])

if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    runSelfTest()
  } else {
    const rootFlag = argv.indexOf('--root')
    const root = rootFlag >= 0 ? path.resolve(argv[rootFlag + 1] ?? '') : ROOT
    runGuard(root)
  }
}

function runGuard(root) {
  if (!existsSync(path.join(root, 'scripts'))) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${root}/scripts`)
    process.exit(2)
  }

  const { violations, scanned } = analyze({ root })

  if (violations.length === 0) {
    console.log(`OK: ${scanned} script(s) scanned, entry-point detection is symlink-safe (#3373).`)
    process.exit(0)
  }

  console.error(`FAIL: ${violations.length} fragile entry-point check(s):`)
  for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.rule}] ${v.detail}`)
  console.error('')
  console.error('A script whose entry-point check is false does not fail — it EXITS 0 HAVING RUN')
  console.error('NOTHING, which is indistinguishable from a clean pass. Use the sanctioned form:')
  console.error('')
  console.error("  import { realpathSync } from 'node:fs'")
  console.error('  const isMainModule =')
  console.error(
    `    !!${ARGV1_TEXT} && realpathSync(${META_FILE_TEXT}) === realpathSync(${ARGV1_TEXT})`,
  )
  console.error('')
  process.exit(1)
}

// ─── self-test ────────────────────────────────────────────────────────

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  // Fixture sources, assembled from fragments (see § Self-scan) so this
  // file never contains a literal instance of a banned form.
  const badFileUrl = `const isMain = ${META_URL_TEXT} === \`file://\${${ARGV1_TEXT}}\`\n`
  const badConcat = `const isMain = ${META_URL_TEXT} === 'file://' + ${ARGV1_TEXT}\n`
  const badDirect = `const isMain = ${ARGV1_TEXT} === ${META_FILE_TEXT}\n`
  const badResolve = `const isMain = ${ARGV1_TEXT} && resolve(${ARGV1_TEXT}) === ${META_FILE_TEXT}\n`
  const badPathResolve = `const isMain = path.resolve(${ARGV1_TEXT}) === path.resolve(${META_FILE_TEXT})\n`
  const goodNamed = `const isMain =\n  !!${ARGV1_TEXT} && realpathSync(${META_FILE_TEXT}) === realpathSync(${ARGV1_TEXT})\n`
  const goodNamespace = `const isMain =\n  !!${ARGV1_TEXT} && fs.realpathSync(${META_FILE_TEXT}) === fs.realpathSync(${ARGV1_TEXT})\n`

  const has = (src, rule) => scanSource(src).some((v) => v.rule === rule)
  const clean = (src) => scanSource(src).length === 0

  // 1. Every banned shape is flagged.
  if (has(badFileUrl, 'file-url-argv')) ok('`file://` template form is flagged')
  else fail('`file://` template form is flagged', JSON.stringify(scanSource(badFileUrl)))

  if (has(badConcat, 'file-url-argv')) ok('`file://` string-concat form is flagged')
  else fail('`file://` string-concat form is flagged', JSON.stringify(scanSource(badConcat)))

  if (has(badDirect, 'unrealpathed-entry-check')) ok('bare argv-vs-filename compare is flagged')
  else fail('bare argv-vs-filename compare is flagged', JSON.stringify(scanSource(badDirect)))

  if (has(badResolve, 'unrealpathed-entry-check')) ok('`resolve(argv)` compare is flagged')
  else fail('`resolve(argv)` compare is flagged', JSON.stringify(scanSource(badResolve)))

  if (has(badPathResolve, 'unrealpathed-entry-check')) ok('`path.resolve` on both sides is flagged')
  else fail('`path.resolve` on both sides is flagged', JSON.stringify(scanSource(badPathResolve)))

  // 2. The sanctioned form passes, in both import styles.
  if (clean(goodNamed)) ok('sanctioned realpath form passes (named import)')
  else fail('sanctioned realpath form passes (named import)', JSON.stringify(scanSource(goodNamed)))

  if (clean(goodNamespace)) ok('sanctioned realpath form passes (fs namespace)')
  else {
    fail(
      'sanctioned realpath form passes (fs namespace)',
      JSON.stringify(scanSource(goodNamespace)),
    )
  }

  // 3. Comments are stripped; unrelated argv uses are not main-module checks.
  if (clean(`// ${badDirect}export const x = 1\n`)) ok('commented-out bad form passes')
  else fail('commented-out bad form passes', JSON.stringify(scanSource(`// ${badDirect}`)))

  if (clean(`/* ${badFileUrl} */\nexport const x = 1\n`)) ok('block-commented bad form passes')
  else {
    fail(
      'block-commented bad form passes',
      JSON.stringify(scanSource(`/* ${badFileUrl} */\nexport const x = 1\n`)),
    )
  }

  const unrelated = `const usage = \`usage: node \${basename(${ARGV1_TEXT})} --help\`\n`
  if (clean(unrelated)) ok('unrelated argv[1] use with no import.meta nearby passes')
  else
    fail(
      'unrelated argv[1] use with no import.meta nearby passes',
      JSON.stringify(scanSource(unrelated)),
    )

  const argvFlag = `if (${ARGV1_TEXT} === '--check') run()\n`
  if (clean(argvFlag)) ok('argv[1] compared to a flag string passes')
  else fail('argv[1] compared to a flag string passes', JSON.stringify(scanSource(argvFlag)))

  // 4. The comment stripper must not eat the `//` INSIDE the banned
  //    template literal — a naive `//` sweep blanks the violation.
  const trailing = `${badFileUrl.trimEnd()} // entry point\n`
  if (has(trailing, 'file-url-argv')) ok('`//` inside the template is not mistaken for a comment')
  else
    fail(
      '`//` inside the template is not mistaken for a comment',
      JSON.stringify(scanSource(trailing)),
    )

  // 5. A regex literal containing unbalanced quotes must not desync the
  //    stripper (the trailing comment after it still gets stripped).
  const regexThenComment = `const q = /(['"\`])/ // ${badDirect.trimEnd()}\nexport const x = 1\n`
  if (clean(regexThenComment)) ok('regex literal with quotes does not desync the stripper')
  else
    fail(
      'regex literal with quotes does not desync the stripper',
      JSON.stringify(scanSource(regexThenComment)),
    )

  // 5b. A template literal whose `${…}` substitution embeds a literal
  //     backtick (e.g. inserting one into rendered text) must not desync
  //     the template-close scan: a bare same-char scan would treat that
  //     embedded backtick as the template's own close, then a stray
  //     apostrophe later on the line (still truly inside the template)
  //     would open a bogus quote that a real trailing `//` closes out of —
  //     wrongly entering "code" mode and blanking a REAL violation that
  //     follows on that same line. Both the harmless in-string decoy and
  //     the real trailing violation must be judged correctly.
  const nestedBacktick = `const t = \`hi \${'\`'} it's // decoy: ${badDirect.trimEnd()}\` ; ${badDirect}`
  if (has(nestedBacktick, 'unrealpathed-entry-check')) {
    ok('a backtick nested inside a template substitution does not desync the stripper')
  } else {
    fail(
      'a backtick nested inside a template substitution does not desync the stripper',
      JSON.stringify(scanSource(nestedBacktick)),
    )
  }

  // 6. The live tree: this guard is scanned, and the tree is clean. Both
  //    halves matter — the second alone would also "pass" if the guard
  //    quietly excluded itself or scanned nothing.
  const live = analyze({ root: ROOT })
  if (live.files.includes('scripts/check-main-module-detection.mjs')) {
    ok('the guard scans its own source (no self-exclusion)')
  } else {
    fail('the guard scans its own source (no self-exclusion)', `files=${live.files.length}`)
  }

  if (live.scanned > 20) ok(`the live scan covers the tree (${live.scanned} files)`)
  else fail('the live scan covers the tree', `only ${live.scanned} file(s) scanned`)

  if (live.violations.length === 0) ok('the live tree has no fragile entry-point checks')
  else fail('the live tree has no fragile entry-point checks', JSON.stringify(live.violations))

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'main-module-selftest-'))
  try {
    runCliSelfTest(tmp, ok, fail, { badDirect, goodNamed })
    runSymlinkSelfTest(tmp, ok, fail)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

/**
 * End-to-end: spawn THIS script as a real subprocess against a synthetic
 * tree and assert the actual exit code. The assertions above drive
 * `scanSource`/`analyze` directly and never reach `process.exit(1)`, so a
 * regression that dropped the non-zero exit (defanging the gate entirely)
 * would sail through them.
 */
function runCliSelfTest(tmp, ok, fail, { badDirect, goodNamed }) {
  const fixture = path.join(tmp, 'cli')
  mkdirSync(path.join(fixture, 'scripts'), { recursive: true })
  const run = () =>
    spawnSync(process.execPath, [import.meta.filename, '--root', fixture], { encoding: 'utf8' })

  writeFileSync(path.join(fixture, 'scripts', 'thing.mjs'), goodNamed)
  let res = run()
  if (res.status === 0) ok('CLI exits 0 on a clean tree')
  else fail('CLI exits 0 on a clean tree', `status=${res.status} stderr=${res.stderr}`)

  writeFileSync(path.join(fixture, 'scripts', 'bad.mjs'), badDirect)
  res = run()
  if (res.status === 1 && res.stderr.includes('unrealpathed-entry-check')) {
    ok('CLI exits 1 on a violating fixture')
  } else {
    fail('CLI exits 1 on a violating fixture', `status=${res.status} stderr=${res.stderr}`)
  }

  rmSync(path.join(fixture, 'scripts'), { recursive: true, force: true })
  res = run()
  if (res.status === 2) ok('CLI exits 2 when the repo layout is missing')
  else fail('CLI exits 2 when the repo layout is missing', `status=${res.status}`)
}

/**
 * The #3373 regression test proper: invoke real scripts through a
 * SYMLINKED scripts/ directory and through a path containing a SPACE, and
 * assert they actually ran. Before the fix all three of these produced
 * empty output and exit 0.
 */
function runSymlinkSelfTest(tmp, ok, fail) {
  const link = path.join(tmp, 'scripts-link')
  symlinkSync(path.join(ROOT, 'scripts'), link, 'dir')

  const viaLink = spawnSync(
    process.execPath,
    [path.join(link, 'file-mutation-survivors.mjs'), '--self-test'],
    {
      encoding: 'utf8',
    },
  )
  if (viaLink.status === 0 && viaLink.stdout.includes('self-test: all assertions passed')) {
    ok('a script invoked through a symlinked scripts/ dir actually runs (#3373)')
  } else {
    fail(
      'a script invoked through a symlinked scripts/ dir actually runs (#3373)',
      `status=${viaLink.status} stdout=${JSON.stringify(viaLink.stdout)}`,
    )
  }

  const selfViaLink = spawnSync(
    process.execPath,
    [path.join(link, path.basename(import.meta.filename))],
    { encoding: 'utf8' },
  )
  if (selfViaLink.status === 0 && selfViaLink.stdout.includes('script(s) scanned')) {
    ok('this guard invoked through a symlink actually runs (#3373)')
  } else {
    fail(
      'this guard invoked through a symlink actually runs (#3373)',
      `status=${selfViaLink.status} stdout=${JSON.stringify(selfViaLink.stdout)}`,
    )
  }

  // Space in the REAL path: no symlink involved, breaks the `file://`
  // template form on its own via percent-encoding.
  const spaced = path.join(tmp, 'dir with space')
  mkdirSync(spaced, { recursive: true })
  const copied = path.join(spaced, 'file-mutation-survivors.mjs')
  cpSync(path.join(ROOT, 'scripts', 'file-mutation-survivors.mjs'), copied)
  const viaSpace = spawnSync(process.execPath, [copied, '--self-test'], { encoding: 'utf8' })
  if (viaSpace.status === 0 && viaSpace.stdout.includes('self-test: all assertions passed')) {
    ok('a script whose path contains a space actually runs (#3373)')
  } else {
    fail(
      'a script whose path contains a space actually runs (#3373)',
      `status=${viaSpace.status} stdout=${JSON.stringify(viaSpace.stdout)}`,
    )
  }
}
