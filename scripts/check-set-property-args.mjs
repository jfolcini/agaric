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
// Instead this does real (if minimal) lexing, via the SHARED scanner in
// `scripts/lib/js-scanner.mjs`:
//
//   1. Comments are stripped first, string/template/regex-literal aware
//      (a `//` or `/* ` inside a string value, e.g. a URL, must not be
//      mistaken for a comment start).
//   1b. Call sites are then DISCOVERED in a second view with string and
//      template CONTENTS blanked as well, so a `commands.setProperty(`
//      written inside a string or a template literal — documentation, a
//      code sample, an error message — is not analysed as a real call.
//      It used to be, and reported missing keys for a call that does not
//      exist. Arguments are still read out of the comments-only-stripped
//      text, whose offsets are identical (both transforms preserve length
//      and newline positions).
//   2. `commands.setProperty(` call sites are located, then their
//      argument list is isolated with a bracket-depth scanner (tracks
//      `()[]{}` nesting and skips over string/template/regex contents,
//      including `${...}` interpolation) that finds the TRUE matching
//      close-paren regardless of newlines or nested calls.
//   3. The argument list is split on top-level commas (same scanner) to
//      get the three positional args.
//   4. If the third argument is a bare `{ ... }` object literal (after
//      unwrapping redundant wrapping parens), its body is split on
//      top-level commas and each entry's key is extracted.
//
// The scanner used to live here, hand-rolled, and was copy-pasted into
// `check-mutation-harness-clones.mjs`. Neither copy knew about REGEX
// LITERALS, so a regex containing a bare `}` closed a bracket scan early
// and a regex containing a quote (`/['"]/`) was read as a string opener,
// desyncing everything after it (#3950 — one root cause, two symptoms).
// Both guards now share one implementation that resolves the
// division-vs-regex ambiguity by previous-significant-token tracking; see
// that module's header for its decision table, its fail-closed policy,
// and its stated limits.
//
// This correctly handles arbitrary formatting/whitespace/nesting; it is
// still a lexer, not a full parser. Where it cannot decide, it raises
// `ScanError` and this guard reports the file as un-scannable — a
// FAILURE, never a silent skip, because a skipped file is a file whose
// missing keys nobody checked.
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
//        missing one or more of the five value keys (or a file could not
//        be scanned unambiguously), 2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ScanError,
  blankStringsAndTemplates,
  findMatchingBracket,
  splitTopLevelCommas,
  stripComments,
} from './lib/js-scanner.mjs'

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
  const violations = []
  let literalCount = 0
  let skippedCount = 0

  try {
    const src = stripComments(rawSrc)
    // Call sites are DISCOVERED in a view with string/template contents
    // blanked, so a `commands.setProperty(` written inside a string or a
    // template literal (documentation, a code sample) is not analysed as a
    // real call. Arguments are then read out of `src`, whose offsets are
    // identical because both transforms preserve length and newlines.
    const search = blankStringsAndTemplates(src)

    CALL_RE.lastIndex = 0
    let m
    while ((m = CALL_RE.exec(search))) {
      const openParenIdx = m.index + m[0].length - 1
      const closeParenIdx = findMatchingBracket(src, openParenIdx)
      if (closeParenIdx === -1) continue // malformed/truncated — skip defensively

      const argsInner = src.slice(openParenIdx + 1, closeParenIdx)
      const line = src.slice(0, m.index).split('\n').length
      // A `ScanError` raised while lexing this call's own argument text
      // carries an index relative to that SUBSTRING, which would resolve to
      // a line near the top of the file. Re-base it onto the call site so
      // the reported location is the call, not line 1.
      let args
      let literal
      try {
        args = splitTopLevelCommas(argsInner)
        if (args.length < 3) continue // not a 3-arg call — not our shape, skip defensively
        literal = parseObjectLiteral(args[2])
      } catch (err) {
        if (!(err instanceof ScanError)) throw err
        throw new ScanError(err.message, m.index)
      }

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
  } catch (err) {
    // The shared scanner refuses to guess at input it cannot decide. A
    // file we could not lex is a file whose `setProperty` calls nobody
    // checked, so it is reported as a FAILURE — counting it as "skipped"
    // would be the fail-open this guard exists to avoid.
    if (!(err instanceof ScanError)) throw err
    return { violations: [], literalCount: 0, skippedCount: 0, scanError: err }
  }

  return { violations, literalCount, skippedCount, scanError: null }
}

/**
 * Walk `srcDir` and aggregate `analyzeSource` over every source file.
 * Pure over the filesystem so the self-test can drive it against a
 * synthetic tree. Returns
 * `{ fileViolations, scanErrors, literalCount, skippedCount, scanned }`
 * where `fileViolations` is `[{ file, line, missingKeys }]` sorted by
 * file/line and `scanErrors` is `[{ file, line, message }]` for files the
 * shared scanner could not lex unambiguously (a failure, not a skip).
 */
function analyzeTree({ root, srcDir }) {
  const fileViolations = []
  const scanErrors = []
  let literalCount = 0
  let skippedCount = 0
  let scanned = 0

  for (const file of listSourceFiles(srcDir)) {
    scanned += 1
    const rawSrc = fs.readFileSync(file, 'utf8')
    const result = analyzeSource(rawSrc)
    const relFile = toPosix(path.relative(root, file))
    if (result.scanError) {
      scanErrors.push({
        file: relFile,
        line: rawSrc.slice(0, result.scanError.index ?? 0).split('\n').length,
        message: result.scanError.message,
      })
      continue
    }
    literalCount += result.literalCount
    skippedCount += result.skippedCount
    for (const v of result.violations) {
      fileViolations.push({ file: relFile, line: v.line, missingKeys: v.missingKeys })
    }
  }

  fileViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  scanErrors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { fileViolations, scanErrors, literalCount, skippedCount, scanned }
}

// ─── main ───────────────────────────────────────────────────────────

// Only run as a CLI when this file IS the entry point. Imported (by an
// ad-hoc comparison script, say), it is a library and must not scan the
// tree or exit the process.
const isMainModule =
  !!process.argv[1] && fs.realpathSync(import.meta.filename) === fs.realpathSync(process.argv[1])

if (isMainModule) {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
  } else {
    runGuard()
  }
}

export { analyzeSource, analyzeTree }

function runGuard() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }

  const { fileViolations, scanErrors, literalCount, skippedCount } = analyzeTree({
    root: ROOT,
    srcDir: SRC_DIR,
  })

  if (scanErrors.length > 0) {
    console.error('ERROR: file(s) could not be scanned unambiguously, so their')
    console.error('`commands.setProperty(...)` call sites were NOT verified:')
    console.error('')
    for (const e of scanErrors) {
      console.error(`  ${e.file}:${e.line} — ${e.message}`)
    }
    console.error('')
    console.error('The shared scanner (scripts/lib/js-scanner.mjs) fails closed rather than')
    console.error('guessing. Fix the construct it names, or extend the scanner.')
    process.exit(1)
  }

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

  // ── #3950: regex literals in and around the call site ──────────────
  //
  // Each of these reddens if regex-literal awareness is removed from the
  // shared scanner: the bare `}` inside the regex decrements bracket
  // depth, so the commas after it stop looking top-level and the keys
  // that follow are never seen — the guard then reports keys "missing"
  // that are right there (case 1), or, worse, cannot see that one really
  // IS missing (case 2).

  const braceRegexValue = analyzeSource(`commands.setProperty(blockId, key, {
      value_text: raw.replace(/\\}/g, ''),
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })`)
  if (braceRegexValue.violations.length === 0 && braceRegexValue.literalCount === 1) {
    ok('a value expression containing a regex with a bare `}` still parses all five keys')
  } else {
    fail(
      'a value expression containing a regex with a bare `}` still parses all five keys',
      JSON.stringify(braceRegexValue),
    )
  }

  const braceRegexMissingKey = analyzeSource(`commands.setProperty(blockId, key, {
      value_text: raw.replace(/\\}/g, ''),
      value_num: null,
      value_date: null,
      value_ref: null,
    })`)
  if (
    braceRegexMissingKey.violations.length === 1 &&
    braceRegexMissingKey.violations[0].missingKeys.join() === 'value_bool'
  ) {
    ok('a genuinely missing key is still caught when the literal contains a brace-bearing regex')
  } else {
    fail(
      'a genuinely missing key is still caught when the literal contains a brace-bearing regex',
      JSON.stringify(braceRegexMissingKey),
    )
  }

  const quoteRegexBefore = analyzeSource(`const QUOTE_RE = /['"]/
    commands.setProperty(blockId, key, {
      value_text: null,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })`)
  if (quoteRegexBefore.violations.length === 0 && quoteRegexBefore.literalCount === 1) {
    ok('a regex containing quotes earlier in the file does not desync the call-site scan')
  } else {
    fail(
      'a regex containing quotes earlier in the file does not desync the call-site scan',
      JSON.stringify(quoteRegexBefore),
    )
  }

  const divisionBefore = analyzeSource(`const ratio = a / b / c
    commands.setProperty(blockId, key, {
      value_text: null,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })`)
  if (divisionBefore.violations.length === 0 && divisionBefore.literalCount === 1) {
    ok('a division expression is not misread as a regex, so the following call is still verified')
  } else {
    fail(
      'a division expression is not misread as a regex, so the following call is still verified',
      JSON.stringify(divisionBefore),
    )
  }

  // A `commands.setProperty(` living inside a STRING or template literal is
  // data, not a call site. `CALL_RE` used to run over text with comments
  // blanked but strings intact, so it matched there and reported missing
  // keys for a call that does not exist. Over-reporting rather than
  // under-reporting, but a false failure blocks commits just as hard.
  const callInString = analyzeSource(
    `const doc = 'commands.setProperty(id, k, { value_text: null })'\nconst x = 1\n`,
  )
  if (
    callInString.violations.length === 0 &&
    callInString.literalCount === 0 &&
    callInString.skippedCount === 0
  ) {
    ok('a setProperty call inside a string literal is not analysed as a real call site')
  } else {
    fail(
      'a setProperty call inside a string literal is not analysed as a real call site',
      JSON.stringify(callInString),
    )
  }

  const callInTemplate = analyzeSource(
    'const doc = `\ncommands.setProperty(id, k, { value_text: null })\n`\nconst x = 1\n',
  )
  if (callInTemplate.violations.length === 0 && callInTemplate.literalCount === 0) {
    ok('a setProperty call inside a template literal is not analysed as a real call site')
  } else {
    fail(
      'a setProperty call inside a template literal is not analysed as a real call site',
      JSON.stringify(callInTemplate),
    )
  }

  // Positive control: blanking strings for call-site DISCOVERY must not stop
  // the real call's arguments from being read out of the unblanked source.
  const realCallWithStringValue = analyzeSource(
    `commands.setProperty(id, k, {\n  value_text: 'commands.setProperty(nope)',\n  value_num: null,\n  value_date: null,\n  value_ref: null,\n  value_bool: null,\n})\n`,
  )
  if (
    realCallWithStringValue.violations.length === 0 &&
    realCallWithStringValue.literalCount === 1
  ) {
    ok('a real call whose string VALUE mentions setProperty is still verified exactly once')
  } else {
    fail(
      'a real call whose string VALUE mentions setProperty is still verified exactly once',
      JSON.stringify(realCallWithStringValue),
    )
  }

  // The fail-open an unterminated `/*` used to produce at THIS guard: the
  // scanner consumed it to EOF as a comment, `stripComments` blanked the
  // tail, and the deficient call below it was never seen — zero call sites,
  // exit 0, a file reported clean that nobody checked.
  const afterUnterminatedComment = analyzeSource(
    `const a = 1\n/* never closed\ncommands.setProperty(id, k, {\n  value_text: null,\n  value_num: null,\n  value_date: null,\n  value_ref: null,\n})\n`,
  )
  if (
    afterUnterminatedComment.violations.length === 1 &&
    afterUnterminatedComment.violations[0].missingKeys.join() === 'value_bool'
  ) {
    ok('a deficient call AFTER an unterminated block comment is still caught, not blanked away')
  } else {
    fail(
      'a deficient call AFTER an unterminated block comment is still caught, not blanked away',
      JSON.stringify(afterUnterminatedComment),
    )
  }

  const unscannable = analyzeSource(
    "const s = 'never closed\ncommands.setProperty(blockId, key, { value_text: null })\n",
  )
  if (
    unscannable.scanError instanceof ScanError &&
    unscannable.violations.length === 0 &&
    unscannable.skippedCount === 0
  ) {
    ok('input the scanner cannot lex is returned as a scanError, not as a silent clean result')
  } else {
    fail(
      'input the scanner cannot lex is returned as a scanError, not as a silent clean result',
      JSON.stringify(unscannable),
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

    // The scanError path at its CALL SITE, not just in `analyzeSource`:
    // a file the scanner cannot lex must arrive in `scanErrors` (which
    // `runGuard` exits 1 on), never be dropped into the clean set.
    fs.writeFileSync(
      path.join(libDir, 'unscannable.ts'),
      "export const s = 'never closed\nexport const t = 1\n",
    )
    const withUnscannable = analyzeTree({ root: tmp, srcDir })
    if (
      withUnscannable.scanErrors.length === 1 &&
      withUnscannable.scanErrors[0].file === 'src/lib/unscannable.ts' &&
      withUnscannable.scanErrors[0].line === 1 &&
      withUnscannable.fileViolations.some((v) => v.file === 'src/lib/bad.ts')
    ) {
      ok(
        'a file the scanner cannot lex is reported in scanErrors, and the rest of the tree is still checked',
      )
    } else {
      fail(
        'a file the scanner cannot lex is reported in scanErrors, and the rest of the tree is still checked',
        JSON.stringify(withUnscannable),
      )
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
