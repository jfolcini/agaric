#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// No `JSON.parse(...) as <Type>` in app code (#3881).
//
// `JSON.parse` returns `any` here, so a cast type-ASSERTS the shape of a
// value fresh out of storage instead of checking it: a stale schema or a
// hand-edited value becomes a wrong-shaped `T` for every consumer. Parse into
// `unknown` and validate before use — model: `src/lib/filters/validate.ts`,
// or a `validate:` on `useLocalStoragePreference`. Zero occurrences are
// allowed; there is no baseline.
//
// ─── Detection ────────────────────────────────────────────────────────
//
// Flags `JSON.parse(...)` immediately followed (module the standard
// wrapping-paren idiom, e.g. `(JSON.parse(raw) as unknown) !== false`) by an
// `as` cast — the exact shape #3881 names, not every `JSON.parse` call (a
// call whose result is checked field-by-field before use, e.g. `const
// parsed: unknown = JSON.parse(raw)` followed by a narrowing function, is
// NOT flagged: that is the validated shape this guard exists to push
// callers toward). Uses the SHARED scanner (`scripts/lib/js-scanner.mjs`,
// per its header: "do not hand-roll a fourth"), the same way
// `check-set-property-args.mjs` locates its call sites:
//
//   1. Comments are stripped first (string/template/regex-literal aware),
//      so a `JSON.parse(x) as Foo` written inside a comment is not counted.
//   2. Call sites are then DISCOVERED in a second view with string/template
//      CONTENTS also blanked, so `JSON.parse(x) as Foo` appearing inside a
//      string or template literal (documentation, an error message, a code
//      sample) is not analysed as a real call either.
//   3. Each `JSON.parse(` found is paired with its true matching close-paren
//      via a bracket-depth scan (handles nested calls/objects/strings). Any
//      REDUNDANT wrapping parens placed directly around the call itself —
//      `(JSON.parse(raw)) as Foo`, `((JSON.parse(raw))) as Foo` — are then
//      unwrapped outward (mirroring `check-set-property-args.mjs`'s
//      `unwrapParens`, walked from the call site instead of from a known
//      expression boundary), and the text immediately after THAT close-paren
//      is checked for a leading `as` (word-boundary, so `assert`/`async` do
//      not false-match). This is a different paren than the standard
//      `(JSON.parse(raw) as unknown) !== false` idiom, where the wrapping
//      paren encloses the whole `... as unknown` expression, not just the
//      call — that shape needs no unwrapping at all, since the `as` already
//      sits directly after `JSON.parse`'s own close-paren; the two are easy
//      to conflate but exercise different code paths here.
//   4. A `JSON.parse(` call whose own parens never balance (a call site the
//      bracket-depth scan cannot close) is counted into a reported skipped
//      total rather than silently dropped — see `runGuard`'s output.
//
// A file the shared scanner cannot lex unambiguously is reported as a
// FAILURE (a `scanError`), never silently skipped — a file this guard could
// not parse is a file whose `JSON.parse` casts nobody verified.
//
// ─── Scope gap: `any`, not `unknown` ───────────────────────────────────
//
// Because `JSON.parse` returns `any` here (see above), the unsound-cast
// hazard is NOT limited to the `JSON.parse(...) as T` spelling this guard
// detects. With `any`, TypeScript silently narrows to the target type at
// the assignment/return/call boundary with no cast keyword at all to grep
// for — these three forms are exactly as unsound and entirely INVISIBLE to
// this guard:
//
//   - `const v: Foo = JSON.parse(raw)`             (typed local, no `as`)
//   - `return JSON.parse(raw)` from a `Foo`-typed function
//   - `f(JSON.parse(raw))` into a parameter typed as `Foo`
//
// This is not a hypothetical gap to keep in mind while reading a green run:
// rewriting a flagged `JSON.parse(raw) as Foo` site into any of the three
// forms above makes this guard's count go DOWN — an unsound rewrite reads
// as progress. Detecting these forms would require type-aware analysis
// (resolving the declared/inferred type at the assignment, return, or call
// site), which is out of scope for this lexical guard; this guard closes
// off one spelling of the hazard, not the class. As of this writing,
// nothing in `src/**` uses any of the three forms above with a non-`unknown`
// target type — every typed local assigned directly from `JSON.parse` is
// typed `unknown` (e.g. `src/lib/preferences.ts`'s `const parsed: unknown =
// JSON.parse(raw)`), which is the validated shape this guard exists to push
// callers toward, not an instance of the gap.
//
// ─── Scope ────────────────────────────────────────────────────────────
//
// Scans `src/**/*.{ts,tsx}`, excluding test files (`*.test.ts[x]`,
// `__tests__/`, `/tests/` directories) and `.d.ts` — the same exclusion as
// `check-set-property-args.mjs`. Test
// files legitimately parse known-good fixture JSON (`JSON.parse(readFileSync(
// FIXTURE_PATH, 'utf8')) as Vectors`) and cast controlled mock payloads —
// that is a different trust boundary from a value that round-tripped through
// a real user's localStorage, so it is out of scope by design.
//
// `src/lib/tauri-mock/**` is ALSO excluded by path, entirely — #3881 names
// this directory explicitly as "test/mock-only": it is the in-memory backend
// double the frontend test suite drives instead of the real Tauri IPC layer,
// never shipped, never fed untrusted user input. Its many `JSON.parse(...)
// as Record<string, unknown>` sites decode payloads the SAME test run just
// encoded moments earlier, which is the fixture-trust argument above, not
// the localStorage-corruption argument this guard exists for.
//
//
// Usage: node scripts/check-json-parse-cast.mjs
// Exit:  0 = clean, 1 = an occurrence or an unscannable file, 2 = repo layout failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'

import {
  ScanError,
  blankStringsAndTemplates,
  findMatchingBracket,
  stripComments,
} from './lib/js-scanner.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')

/** Directory (relative to `src/`) excluded entirely — see the Scope header. */
const EXCLUDED_DIR = 'lib/tauri-mock'

const CALL_RE = /JSON\.parse\s*\(/g
/** A leading `as` cast, word-boundary so `assert`/`async` never false-match. */
const AS_CAST_RE = /^\s*as\b/

// ─── helpers ────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk `src/**` for `*.ts` / `*.tsx` files, excluding test files,
 * `__tests__/` + `tests/` directories, and `EXCLUDED_DIR` (the tauri-mock
 * layer — see the Scope header). Mirrors `check-set-property-args.mjs`'s
 * `listSourceFiles`, plus the one extra directory exclusion.
 */
function listSourceFiles(srcDir = SRC_DIR) {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = toPosix(path.relative(srcDir, full))
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'tests') continue
        if (rel === EXCLUDED_DIR) continue
        visit(full)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx') &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(full)
      }
    }
  }
  visit(srcDir)
  return out
}

/**
 * Given a `JSON.parse(` call found at `callStart` (the match index) whose
 * own opening paren truly closes at `closeParenIdx` (via
 * `findMatchingBracket`), walk outward past any REDUNDANT parens wrapping
 * the call itself — `(JSON.parse(raw))`, `((JSON.parse(raw)))` — and return
 * the index of the outermost such close-paren (or `closeParenIdx`
 * unchanged if there is no wrapping). Mirrors
 * `check-set-property-args.mjs`'s `unwrapParens`, but walked outward from a
 * known call site instead of inward from a known expression boundary: a
 * candidate `(` immediately (modulo whitespace) before the call is only
 * accepted if IT ALSO matches (via `findMatchingBracket`) a `)` immediately
 * (modulo whitespace) after the current close-paren — which is what
 * distinguishes this from the standard `(JSON.parse(raw) as unknown) !==
 * false` idiom, whose wrapping paren's match lands well past `raw)`, not
 * adjacent to it, so that idiom is correctly left untouched (it needs no
 * unwrapping — the `as` already sits right after `JSON.parse`'s own
 * close-paren).
 */
function skipWrappingCloseParens(src, callStart, closeParenIdx) {
  let openIdx = callStart
  let closeIdx = closeParenIdx
  for (;;) {
    let i = openIdx - 1
    while (i >= 0 && /\s/.test(src[i])) i--
    if (i < 0 || src[i] !== '(') break
    const matchClose = findMatchingBracket(src, i)
    if (matchClose === -1) break
    let j = closeIdx + 1
    while (j < src.length && /\s/.test(src[j])) j++
    if (matchClose !== j) break
    openIdx = i
    closeIdx = matchClose
  }
  return closeIdx
}

/**
 * Scan one file's source for `JSON.parse(...) as` occurrences. Returns
 * `{ hits, skippedCount, scanError }` where `hits` is `[{ line }]`
 * (1-based), `skippedCount` counts `JSON.parse(` call sites whose own
 * parens never balance (COUNTED, not silently dropped — see the sibling
 * `check-set-property-args.mjs:254-260`, which this mirrors), and
 * `scanError` is set (with `hits: []`) when the shared scanner could not
 * lex the file unambiguously — a FAILURE, never a silent skip (see header).
 */
export function analyzeSource(rawSrc) {
  try {
    const src = stripComments(rawSrc)
    // Call sites are DISCOVERED in a view with string/template contents also
    // blanked, so `JSON.parse(x) as Foo` written inside a string or template
    // literal is not analysed as a real call. The cast check right below
    // reads from `src` (comments stripped, strings intact) at the SAME
    // offsets — both transforms preserve length and newline positions.
    const search = blankStringsAndTemplates(src)
    const hits = []
    let skippedCount = 0
    CALL_RE.lastIndex = 0
    let m
    while ((m = CALL_RE.exec(search))) {
      const openParenIdx = m.index + m[0].length - 1
      const closeParenIdx = findMatchingBracket(src, openParenIdx)
      if (closeParenIdx === -1) {
        // Counted, not dropped: a call site this guard could not parse must
        // show up in the summary's skipped tally, matching
        // check-set-property-args.mjs's fail-open fix for the same case.
        skippedCount++
        continue
      }
      const wrappedCloseIdx = skipWrappingCloseParens(src, m.index, closeParenIdx)
      const after = src.slice(wrappedCloseIdx + 1)
      if (AS_CAST_RE.test(after)) {
        hits.push({ line: src.slice(0, m.index).split('\n').length })
      }
    }
    return { hits, skippedCount, scanError: null }
  } catch (err) {
    if (!(err instanceof ScanError)) throw err
    return { hits: [], skippedCount: 0, scanError: err }
  }
}

// ─── analysis ─────────────────────────────────────────────────────────

/**
 * Compute the live per-file `JSON.parse(...) as` occurrences. Pure over the
 * filesystem: `root`/`srcDir` are parameters, not globals. Returns
 * `{ offenders, details, scanned, skippedCount, scanErrors }`, where
 * `details` maps an offender's repo-relative path to its hit lines and
 * `scanErrors` is `{ file, message }` for files the shared scanner could not
 * lex unambiguously.
 */
export function analyze({ root, srcDir }) {
  /** @type {string[]} */
  const offenders = []
  const details = new Map()
  const scanErrors = []
  let scanned = 0
  let skippedCount = 0

  for (const file of listSourceFiles(srcDir)) {
    scanned += 1
    const rel = toPosix(path.relative(root, file))
    const rawSrc = fs.readFileSync(file, 'utf8')
    const { hits, skippedCount: fileSkipped, scanError } = analyzeSource(rawSrc)
    if (scanError) {
      scanErrors.push({ file: rel, message: scanError.message })
      continue
    }
    skippedCount += fileSkipped
    if (hits.length > 0) {
      offenders.push(rel)
      details.set(
        rel,
        hits.map((h) => h.line),
      )
    }
  }

  offenders.sort()
  return { offenders, details, scanned, skippedCount, scanErrors }
}

// ─── entry point ────────────────────────────────────────────────────────

// Only run as a CLI when this file IS the entry point. Imported (from a
// vitest test, say), it is a library and must not scan the tree or exit the
// process — `analyzeSource`/`analyze` are exported for exactly that use.
// Guarded — see the same note in scripts/lib/js-scanner.mjs and
// check-set-property-args.mjs: this runs at module evaluation, so an
// unresolvable `process.argv[1]` would throw before any export exists and
// break every importer.
const isMainModule = (() => {
  try {
    return (
      !!process.argv[1] &&
      fs.realpathSync(import.meta.filename) === fs.realpathSync(process.argv[1])
    )
  } catch {
    return false
  }
})()

if (isMainModule) {
  runGuard()
}

function requireLayout() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }
}

function runGuard() {
  requireLayout()
  const { offenders, details, scanned, skippedCount, scanErrors } = analyze({
    root: ROOT,
    srcDir: SRC_DIR,
  })
  if (scanned === 0) {
    console.error(`ERROR: no source files found under ${SRC_DIR}; the scan checked nothing`)
    process.exit(2)
  }

  let failed = false

  if (scanErrors.length > 0) {
    failed = true
    console.error('ERROR: file(s) could not be scanned unambiguously, so their JSON.parse casts')
    console.error('were NOT verified:')
    console.error('')
    for (const e of scanErrors) console.error(`  ${e.file} — ${e.message}`)
    console.error('')
    console.error('The shared scanner (scripts/lib/js-scanner.mjs) fails closed rather than')
    console.error('guessing. Fix the construct it names, or extend the scanner.')
    console.error('')
  }

  if (offenders.length > 0) {
    failed = true
    console.error('ERROR: JSON.parse(...) as <Type> occurrence(s) (#3881) — a value fresh out')
    console.error('of JSON.parse is type-ASSERTED, not checked. A stale entry from an older')
    console.error('schema, a hand-edited devtools value, or a future migration produces a')
    console.error('well-formed value of the WRONG shape, and the cast waves it through unchecked:')
    console.error('')
    for (const f of offenders) console.error(`  ${f}  (line ${details.get(f).join(', ')})`)
    console.error('')
    console.error('FIX: parse into `unknown` and validate the shape before trusting it. Model:')
    console.error('src/lib/filters/validate.ts (#3791) for a rich per-kind union, or thread a')
    console.error('`validate:` into `useLocalStoragePreference` (#3913) for a localStorage-backed')
    console.error('preference.')
  }

  if (failed) process.exit(1)

  console.log(
    `OK: no JSON.parse(...)-as-cast occurrences in ${scanned} file(s) (${skippedCount} call site(s) skipped: unbalanced parens)`,
  )
}
