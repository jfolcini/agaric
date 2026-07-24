#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// set-property args-completeness guard (#3127).
//
// `commands.setProperty(blockId, key, args)` takes a `SetPropertyArgs`
// (src-tauri/src/commands/mod.rs) whose five value fields — `value_text`,
// `value_num`, `value_date`, `value_ref`, `value_bool` — are ALL optional
// in the generated `src/lib/bindings.ts` (they come from `Option<T>` +
// `#[serde(default)]` on the Rust struct, so tauri-specta emits `key?:
// T | null`). The backend contract is "exactly one value field
// non-null" — but omitting a key from the object literal is NOT a type
// error, and omitting is NOT equivalent to passing `null`: it silently
// clears whatever was previously stored for that key, because the
// backend can't distinguish "field not sent" from "field sent as null"
// once serde defaults it. The retired `src/lib/tauri/properties.ts`
// wrapper always built all five with `?? null`; any new direct caller of
// `commands.setProperty` must do the same, but nothing in the type
// system enforces it.
//
// This is live risk for the ongoing #2927 migration: as more UI moves
// off `@/lib/tauri` and calls `commands.setProperty` directly, a dropped
// key is a silent behavior change (a property value quietly clearing)
// that only manual review catches today.
//
// ─── How it works ───────────────────────────────────────────────────
//
// Walks `src/**/*.{ts,tsx}` (non-test, see Scope below) looking for
// `commands.setProperty(...)` call expressions. For each call, inspects
// the THIRD argument (the `SetPropertyArgs` value):
//
//   - If it is an object literal (`{ ... }`), every one of the five
//     required keys (`value_text`, `value_num`, `value_date`,
//     `value_ref`, `value_bool`) must be PRESENT (as `key: expr` or
//     shorthand `key`). The guard does NOT check the values — `value_num:
//     null` and `value_num: params.n` are equally fine. It only checks
//     presence. A missing key FAILS with the file, line, and exactly
//     which key(s) are missing.
//   - If it is anything else — a variable, a spread, a function call, a
//     ternary, a parenthesized expression that isn't a bare literal — the
//     call is SKIPPED, not failed. We cannot statically verify what keys
//     a non-literal expression produces, and flagging it would be a
//     false positive that blocks a legitimate caller (e.g. a typed
//     helper that already guarantees all five keys, or a wrapper
//     function like `src/lib/tauri/properties.ts`'s own `setProperty`
//     which takes a *different*, camelCase-optional shape and builds the
//     five-key literal internally — that internal literal IS checked,
//     the wrapper's own external params are not this guard's concern).
//   - Same applies to a literal that contains a spread (`{ ...defaults,
//     value_text: x }`) or a computed key (`{ [k]: v }`): the literal's
//     explicit keys don't tell us what the spread/computed key
//     contributes, so it is SKIPPED rather than risk a false positive.
//
// ─── Parsing ────────────────────────────────────────────────────────
//
// Real call sites are formatted across 6+ lines (one field per line), so
// a single-line regex would miss nearly every real call — that would be
// a guard that silently passes everything, which is worse than no guard.
// Instead this does real (if minimal) lexing:
//
//   1. Comments are stripped first, string/template-literal aware (a
//      `//` or `/* ` inside a string value, e.g. a URL, must not be
//      mistaken for a comment start).
//   2. `commands.setProperty(` call sites are located, then their
//      argument list is isolated with a bracket-depth scanner (tracks
//      `()[]{}` nesting and skips over string/template contents,
//      including `${...}` interpolation) that finds the TRUE matching
//      close-paren regardless of newlines or nested calls.
//   3. The argument list is split on top-level commas (same
//      string/bracket-aware scanner) to get the three positional args.
//   4. If the third argument is a bare `{ ... }` object literal (after
//      unwrapping redundant wrapping parens), its body is split on
//      top-level commas and each entry's key is extracted.
//
// This correctly handles arbitrary formatting/whitespace/nesting; it is
// still a lexer, not a full parser, so pathological non-standard syntax
// could in principle confuse it, but the codebase's actual call sites
// (per --self-test and the real files this was verified against) parse
// correctly.
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// Scans `src/**/*.{ts,tsx}`, excluding test files (`*.test.ts[x]`,
// `__tests__/`, `/tests/`) and `.d.ts` — same exclusion as the sibling
// `check-tauri-import-baseline.mjs` guard. Tests may legitimately
// construct partial/invalid `SetPropertyArgs` on purpose (to exercise
// backend validation, mock-layer edge cases, etc.), so they are out of
// scope by design, not by oversight.
//
// The mock layer (`src/lib/tauri-mock/`) is NOT specially excluded: it
// is in scope like any other non-test file. In practice it never calls
// `commands.setProperty` (it *implements* the mock handler that
// `commands.setProperty` would otherwise invoke over IPC, so calling it
// again from inside its own handler would be circular) — but if that
// ever changed, the same five-key contract should still apply to it, so
// no special-casing was added.
//
// Usage: node scripts/check-set-property-args.mjs
//        node scripts/check-set-property-args.mjs --self-test
// Exit:  0 = clean, 1 = a call site's object-literal third argument is
//        missing one or more of the five value keys, 2 = repo layout /
//        self-test failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')

const REQUIRED_KEYS = ['value_text', 'value_num', 'value_date', 'value_ref', 'value_bool']

const CALL_RE = /commands\.setProperty\s*\(/g

// ─── helpers ────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk `src/**` for `*.ts` / `*.tsx` files, excluding test files and
 * `__tests__/` + `tests/` directories. Mirrors
 * `check-tauri-import-baseline.mjs`'s `listSourceFiles` exactly.
 */
function listSourceFiles(srcDir = SRC_DIR) {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'tests') continue
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
 * Advance past a string/template literal starting at `src[i]` (which
 * must be `'`, `"`, or `` ` ``). Returns the index just past the closing
 * quote. Handles backslash escapes and, for template literals, nested
 * `${...}` interpolation (which may itself contain strings/braces).
 */
function skipString(src, i) {
  const quote = src[i]
  const n = src.length
  let j = i + 1
  while (j < n) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      j = skipTemplateExpr(src, j + 2)
      continue
    }
    if (c === quote) return j + 1
    j++
  }
  return n
}

/** Advance past a `${ ... }` template interpolation body; `i` points just after `${`. */
function skipTemplateExpr(src, i) {
  const n = src.length
  let depth = 1
  let j = i
  while (j < n && depth > 0) {
    const c = src[j]
    if (c === "'" || c === '"' || c === '`') {
      j = skipString(src, j)
      continue
    }
    if (c === '{') {
      depth++
      j++
      continue
    }
    if (c === '}') {
      depth--
      j++
      continue
    }
    j++
  }
  return j
}

/**
 * Replace block comments and line comments with equal-length whitespace
 * (preserving newlines, so line numbers stay accurate), skipping over
 * string/template literal contents so a `//` or `/*` inside a string
 * value is not mistaken for a comment.
 */
function stripComments(src) {
  const n = src.length
  let out = ''
  let i = 0
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === "'" || c === '"' || c === '`') {
      const j = skipString(src, i)
      out += src.slice(i, j)
      i = j
      continue
    }
    if (c === '/' && c2 === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += ' '.repeat(j - i)
      i = j
      continue
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(j + 2, n)
      out += src.slice(i, j).replace(/[^\n]/g, ' ')
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Find the index of the bracket matching `src[openIdx]` (one of
 * `([{`), scanning forward and skipping over string/template literal
 * contents. Returns -1 if unmatched (malformed/truncated input).
 */
function findMatchingBracket(src, openIdx) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const openCh = src[openIdx]
  const closeCh = pairs[openCh]
  const n = src.length
  let depth = 0
  let i = openIdx
  while (i < n) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === openCh) {
      depth++
    } else if (c === closeCh) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/**
 * Split `src` on top-level commas (depth 0 relative to `src`'s own
 * `()[]{}` nesting), skipping over string/template literal contents.
 * Returns trimmed, non-empty segments.
 */
function splitTopLevelCommas(src) {
  const n = src.length
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++
      i++
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--
      i++
      continue
    }
    if (c === ',' && depth === 0) {
      parts.push(src.slice(start, i))
      i++
      start = i
      continue
    }
    i++
  }
  parts.push(src.slice(start, n))
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Strip redundant wrapping parens: `((x))` → `x`. Non-recursive-unsafe input tolerant. */
function unwrapParens(expr) {
  let s = expr.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    const close = findMatchingBracket(s, 0)
    if (close !== s.length - 1) break // the leading '(' doesn't wrap the whole expr
    s = s.slice(1, -1).trim()
  }
  return s
}

/**
 * If `expr` is (after unwrapping redundant parens) a bare object
 * literal, extract its top-level keys. Returns `null` if `expr` is not
 * a bare object literal (variable, call, spread-at-top, ternary, etc.).
 * `hasUnverifiable` is true when the literal contains a top-level spread
 * or computed key, meaning presence/absence of the required keys can't
 * be fully determined statically.
 */
function parseObjectLiteral(expr) {
  const s = unwrapParens(expr)
  if (!(s.startsWith('{') && s.endsWith('}'))) return null
  const close = findMatchingBracket(s, 0)
  if (close !== s.length - 1) return null // e.g. `{...}.foo` — not a bare literal

  const inner = s.slice(1, -1)
  const entries = splitTopLevelCommas(inner)
  const keys = []
  let hasUnverifiable = false
  const keyRe = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*(?::|$)/
  for (const entry of entries) {
    if (entry.startsWith('...') || entry.startsWith('[')) {
      hasUnverifiable = true
      continue
    }
    const m = entry.match(keyRe)
    if (m) {
      keys.push(m[1] ?? m[2] ?? m[3])
    } else {
      // Unrecognized entry shape — be conservative and treat as unverifiable
      // rather than silently ignoring it (would risk a false PASS).
      hasUnverifiable = true
    }
  }
  return { keys, hasUnverifiable }
}

// ─── analysis ───────────────────────────────────────────────────────

/**
 * Scan one file's source for `commands.setProperty(...)` calls. Returns
 * `{ violations, literalCount, skippedCount }`:
 *   - `violations`: `{ line, missingKeys }` for each call whose third
 *     argument is a verifiable object literal missing required key(s).
 *   - `literalCount`: calls whose third argument was a fully verifiable
 *     object literal (whether it passed or failed).
 *   - `skippedCount`: calls whose third argument could not be statically
 *     verified (non-literal, or a literal with a spread/computed key).
 */
function analyzeSource(rawSrc) {
  const src = stripComments(rawSrc)
  const violations = []
  let literalCount = 0
  let skippedCount = 0

  CALL_RE.lastIndex = 0
  let m
  while ((m = CALL_RE.exec(src))) {
    const openParenIdx = m.index + m[0].length - 1
    const closeParenIdx = findMatchingBracket(src, openParenIdx)
    if (closeParenIdx === -1) continue // malformed/truncated — skip defensively

    const argsInner = src.slice(openParenIdx + 1, closeParenIdx)
    const args = splitTopLevelCommas(argsInner)
    if (args.length < 3) continue // not a 3-arg call — not our shape, skip defensively

    const line = src.slice(0, m.index).split('\n').length
    const literal = parseObjectLiteral(args[2])

    if (literal === null || literal.hasUnverifiable) {
      skippedCount++
      continue
    }

    literalCount++
    const missing = REQUIRED_KEYS.filter((k) => !literal.keys.includes(k))
    if (missing.length > 0) {
      violations.push({ line, missingKeys: missing })
    }
  }

  return { violations, literalCount, skippedCount }
}

/**
 * Walk `srcDir` and aggregate `analyzeSource` over every source file.
 * Pure over the filesystem so the self-test can drive it against a
 * synthetic tree. Returns `{ fileViolations, literalCount, skippedCount, scanned }`
 * where `fileViolations` is `[{ file, line, missingKeys }]` sorted by file/line.
 */
function analyzeTree({ root, srcDir }) {
  const fileViolations = []
  let literalCount = 0
  let skippedCount = 0
  let scanned = 0

  for (const file of listSourceFiles(srcDir)) {
    scanned += 1
    const rawSrc = fs.readFileSync(file, 'utf8')
    const result = analyzeSource(rawSrc)
    literalCount += result.literalCount
    skippedCount += result.skippedCount
    const relFile = toPosix(path.relative(root, file))
    for (const v of result.violations) {
      fileViolations.push({ file: relFile, line: v.line, missingKeys: v.missingKeys })
    }
  }

  fileViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { fileViolations, literalCount, skippedCount, scanned }
}

// ─── main ───────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  runGuard()
}

function runGuard() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }

  const { fileViolations, literalCount, skippedCount } = analyzeTree({
    root: ROOT,
    srcDir: SRC_DIR,
  })

  if (fileViolations.length > 0) {
    console.error('ERROR: `commands.setProperty(...)` call(s) missing required value key(s):')
    console.error('')
    for (const v of fileViolations) {
      console.error(`  ${v.file}:${v.line} — missing: ${v.missingKeys.join(', ')}`)
    }
    console.error('')
    console.error('`SetPropertyArgs` (src-tauri/src/commands/mod.rs) requires all five value')
    console.error('fields to be present — `value_text`, `value_num`, `value_date`, `value_ref`,')
    console.error('`value_bool` — with exactly one non-null. Omitting a key is NOT the same as')
    console.error('passing `null`: it silently drops whatever was previously stored. Build the')
    console.error('literal with every key explicit, e.g.:')
    console.error('')
    console.error('    await commands.setProperty(blockId, key, {')
    console.error('      value_text: null,')
    console.error('      value_num: null,')
    console.error('      value_date: null,')
    console.error('      value_ref: null,')
    console.error('      value_bool: null,')
    console.error('    })')
    process.exit(1)
  }

  console.log(
    `OK: ${literalCount} commands.setProperty(...) call site(s) with a verifiable object-literal ` +
      `third argument all pass the five-key contract (${skippedCount} non-literal/unverifiable ` +
      'call site(s) skipped)',
  )
}

// ─── self-test ──────────────────────────────────────────────────────
//
// Drives analyzeSource()/analyzeTree() against inline fixtures so the
// guard's own exit behavior is verified: a complete 5-key literal
// PASSES (single-line and realistic multi-line), each single
// missing-key case FAILS with the right key named, a non-literal third
// argument (variable / spread / call) is SKIPPED not failed, a literal
// with an internal spread is SKIPPED, a commented-out call is ignored,
// and a test file is ignored regardless of content.
function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  // ── analyzeSource() cases ──────────────────────────────────────────

  const complete = analyzeSource(`
    export async function f() {
      return commands.setProperty(blockId, key, {
        value_text: params.valueText ?? null,
        value_num: params.valueNum ?? null,
        value_date: params.valueDate ?? null,
        value_ref: params.valueRef ?? null,
        value_bool: params.valueBool ?? null,
      })
    }
  `)
  if (complete.violations.length === 0 && complete.literalCount === 1) {
    ok('complete 5-key multi-line literal passes')
  } else {
    fail('complete 5-key multi-line literal passes', JSON.stringify(complete))
  }

  const completeOneLine = analyzeSource(
    `commands.setProperty(id, k, { value_text: null, value_num: null, value_date: null, value_ref: null, value_bool: null })`,
  )
  if (completeOneLine.violations.length === 0 && completeOneLine.literalCount === 1) {
    ok('complete 5-key single-line literal passes')
  } else {
    fail('complete 5-key single-line literal passes', JSON.stringify(completeOneLine))
  }

  for (const missingKey of REQUIRED_KEYS) {
    const fields = REQUIRED_KEYS.filter((k) => k !== missingKey)
      .map((k) => `${k}: null,`)
      .join('\n        ')
    const src = `
      commands.setProperty(blockId, key, {
        ${fields}
      })
    `
    const result = analyzeSource(src)
    const v = result.violations[0]
    if (v && v.missingKeys.length === 1 && v.missingKeys[0] === missingKey) {
      ok(`missing '${missingKey}' is flagged`)
    } else {
      fail(`missing '${missingKey}' is flagged`, JSON.stringify(result))
    }
  }

  const nonLiteralVar = analyzeSource('commands.setProperty(blockId, key, args)')
  if (nonLiteralVar.violations.length === 0 && nonLiteralVar.skippedCount === 1) {
    ok('variable third argument is skipped, not failed')
  } else {
    fail('variable third argument is skipped, not failed', JSON.stringify(nonLiteralVar))
  }

  const spreadArg = analyzeSource('commands.setProperty(blockId, key, ...rest)')
  // `...rest` as a positional arg makes this a >3-arg-shaped call from the
  // scanner's perspective in some formations; what matters is it never
  // reports a violation.
  if (spreadArg.violations.length === 0) {
    ok('spread third argument never reports a violation')
  } else {
    fail('spread third argument never reports a violation', JSON.stringify(spreadArg))
  }

  const fnCallArg = analyzeSource('commands.setProperty(blockId, key, buildArgs(x, y))')
  if (fnCallArg.violations.length === 0 && fnCallArg.skippedCount === 1) {
    ok('function-call third argument is skipped, not failed')
  } else {
    fail('function-call third argument is skipped, not failed', JSON.stringify(fnCallArg))
  }

  const internalSpread = analyzeSource(
    'commands.setProperty(blockId, key, { ...defaults, value_text: x })',
  )
  if (internalSpread.violations.length === 0 && internalSpread.skippedCount === 1) {
    ok('literal with internal spread is skipped, not failed')
  } else {
    fail('literal with internal spread is skipped, not failed', JSON.stringify(internalSpread))
  }

  const commentedOut = analyzeSource(
    '// commands.setProperty(blockId, key, { value_text: null })\nconst x = 1',
  )
  if (
    commentedOut.violations.length === 0 &&
    commentedOut.literalCount === 0 &&
    commentedOut.skippedCount === 0
  ) {
    ok('commented-out call is ignored entirely')
  } else {
    fail('commented-out call is ignored entirely', JSON.stringify(commentedOut))
  }

  const blockCommentedOut = analyzeSource(
    '/* commands.setProperty(blockId, key, { value_text: null }) */\nconst x = 1',
  )
  if (
    blockCommentedOut.violations.length === 0 &&
    blockCommentedOut.literalCount === 0 &&
    blockCommentedOut.skippedCount === 0
  ) {
    ok('block-commented-out call is ignored entirely')
  } else {
    fail('block-commented-out call is ignored entirely', JSON.stringify(blockCommentedOut))
  }

  const stringWithSlashes = analyzeSource(
    `commands.setProperty(blockId, key, {
      value_text: 'https://example.com/path',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })`,
  )
  if (stringWithSlashes.violations.length === 0 && stringWithSlashes.literalCount === 1) {
    ok('string value containing // is not mistaken for a comment')
  } else {
    fail(
      'string value containing // is not mistaken for a comment',
      JSON.stringify(stringWithSlashes),
    )
  }

  // ── analyzeTree() — scope (test files ignored) ─────────────────────

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'set-property-args-selftest-'))
  try {
    const srcDir = path.join(tmp, 'src')
    const libDir = path.join(srcDir, 'lib')
    const testDir = path.join(libDir, '__tests__')
    for (const d of [libDir, testDir]) fs.mkdirSync(d, { recursive: true })

    fs.writeFileSync(
      path.join(libDir, 'good.ts'),
      `export const g = () => commands.setProperty(id, k, {
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      })
      `,
    )
    fs.writeFileSync(
      path.join(libDir, 'bad.ts'),
      `export const b = () => commands.setProperty(id, k, {
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: null,
      })
      `,
    )
    fs.writeFileSync(
      path.join(testDir, 'bad.test.ts'),
      `it('x', () => commands.setProperty(id, k, { value_text: null }))\n`,
    )

    const { fileViolations, scanned } = analyzeTree({ root: tmp, srcDir })

    if (
      fileViolations.some(
        (v) => v.file === 'src/lib/bad.ts' && v.missingKeys.includes('value_bool'),
      )
    ) {
      ok('non-test file missing a key is flagged with the right file/key')
    } else {
      fail(
        'non-test file missing a key is flagged with the right file/key',
        JSON.stringify(fileViolations),
      )
    }

    if (!fileViolations.some((v) => v.file === 'src/lib/good.ts')) {
      ok('non-test file with all keys is not flagged')
    } else {
      fail('non-test file with all keys is not flagged', JSON.stringify(fileViolations))
    }

    if (!fileViolations.some((v) => v.file.includes('__tests__'))) {
      ok('test file is ignored regardless of content')
    } else {
      fail('test file is ignored regardless of content', JSON.stringify(fileViolations))
    }

    if (scanned === 2) {
      ok('scan walked exactly the 2 non-test files')
    } else {
      fail('scan walked exactly the 2 non-test files', `scanned=${scanned}`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
