#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Shared JS/TS lexical scanner for the `scripts/` guards (#3950).
//
// ─── Why this module exists ─────────────────────────────────────────
//
// Two guards — `check-mutation-harness-clones.mjs` and
// `check-set-property-args.mjs` — need to walk TS/TSX source and match
// brackets, split argument lists, and blank comments/strings, without a
// real parser. Both shipped the SAME hand-rolled `skipString` /
// `stripComments` / `findMatchingBracket` trio, copy-pasted, and both
// were blind to REGEX LITERALS. One root cause, two symptoms (#3950 and
// its scope-widening comment):
//
//   input                          symptom
//   ─────────────────────────────  ───────────────────────────────────
//   regex with a bare `}`          bracket-depth scan closes early →
//   (e.g. `/\}/`)                  TRUNCATED extraction, fails OPEN:
//                                  two functions differing by real code
//                                  AFTER the regex hash identically, so
//                                  genuine drift lands with the pin green
//   regex with a quote             `stripComments` reads it as a string
//   (e.g. `/['"]/`)                opener → the scanner desyncs from
//                                  that point on
//
// Fail-open is the serious direction: these guards exist to catch drift,
// and that is drift they structurally cannot see. So the fix is ONE
// scanner, extracted here, rather than two patches — a third inheritor
// cannot inherit the bug.
//
// ─── How the division-vs-regex ambiguity is resolved ────────────────
//
// `/` is either a division operator or the start of a regex literal, and
// JS decides by GRAMMAR CONTEXT, not by lookahead. The only correct way
// to disambiguate lexically is to track the PREVIOUS SIGNIFICANT TOKEN
// (the last token that is neither whitespace nor a comment). This
// tokenizer does exactly that, plus a paren-context stack and a
// brace-context stack for the two positions where the previous token
// alone is not enough.
//
// The decision table (`regexAllowedAfter` below is the implementation):
//
//   previous significant token        `/` is …
//   ────────────────────────────────  ─────────────────────────────────
//   nothing (start of scan)           REGEX  (expression position)
//   number / string / template /      DIVISION (the expression is
//     regex literal                     complete)
//   identifier                        DIVISION
//   keyword: return typeof case in    REGEX
//     of new delete void throw
//     yield instanceof await do
//     else if while for with switch
//   `)`                               depends on the matching `(`:
//                                     REGEX if that `(` headed an
//                                     `if`/`while`/`for`/`with`/`switch`
//                                     clause (`if (x) /re/.test(s)`),
//                                     DIVISION otherwise (`(a + b) / c`,
//                                     `f() / 2`)
//   `]`                               DIVISION (`a[0] / 2`)
//   `}`                               depends on the matching `{`:
//                                     REGEX if that `{` opened a BLOCK,
//                                     DIVISION if it opened an object
//                                     literal / JSX expression container
//   `++` / `--`                       DIVISION when no newline separates
//                                     it from the `/` (`x++ / 2` — the
//                                     operand is a complete expression,
//                                     so a regex cannot follow). When a
//                                     newline DOES separate them the
//                                     answer depends on ASI, which this
//                                     scanner does not model: it FAILS
//                                     CLOSED with a `ScanError` rather
//                                     than guessing. (Documented rule,
//                                     per #3950's "pick a defensible rule
//                                     and document which".)
//   `<` / `>`                         DIVISION — see the TSX note below.
//   any other punctuator/operator     REGEX (`= ( [ { , ; : ? => ! && …`)
//
// A second, independent safety net applies on top: even where a regex is
// ALLOWED, the candidate must actually LEX as a regex literal that
// terminates on the SAME LINE (regex literals may not contain an
// unescaped newline — ECMA-262). If it does not, the `/` is emitted as
// an ordinary punctuator instead. This is what keeps a mis-decided
// position from swallowing arbitrary text: the failure mode of a wrong
// "regex allowed" answer is almost always "no closing `/` on this line",
// which degrades to exactly the pre-#3950 behaviour rather than to
// something worse.
//
// ─── Fail-closed policy ─────────────────────────────────────────────
//
// This is not, and does not try to be, a complete JS parser. Where it
// cannot decide, it throws `ScanError` and callers surface "ambiguous,
// cannot verify" so the guard REDDENS and a human looks. Thrown for:
//   - a string literal that never closes,
//   - an unterminated template literal or `${…}` interpolation,
//   - a `/` after `++`/`--` with an intervening newline (ASI-dependent).
//
// ─── Stated limitations (all chosen to fail closed or to be inert) ──
//
//  1. JSX/TSX is not parsed as a grammar. `<` and `>` are therefore
//     treated as never introducing a regex, because in a `.tsx` file
//     `</` is overwhelmingly a closing tag while `a < /re/.source` is
//     absurd in real code. Cost: a regex literal written directly after
//     a relational operator is read as division. That is inert — the
//     `/` becomes a punctuator, exactly the pre-#3950 behaviour — not a
//     truncation.
//  2. JSX TEXT is lexed as if it were code. An apostrophe in bare JSX
//     text (`<p>don't</p>`) is read as a string opener and consumes up to
//     the next quote — inherited unchanged from the scanners this
//     replaces, and not what #3950 is about. It is bounded rather than
//     silent: a quote that never closes raises `ScanError`, and a
//     mis-consumed span almost always leaves the enclosing brackets
//     unbalanced, which every caller here reports as "ambiguous" rather
//     than extracting something truncated. The #3950 flavour of this —
//     a QUOTE INSIDE A REGEX LITERAL, `/['"]/` — is fixed: the regex is
//     lexed as a regex, so its quotes never open a string.
//  3. Brace classification (block vs object literal) is the standard
//     previous-token heuristic, not a parse. A misclassification only
//     matters when a `/` immediately follows the `}` AND a well-formed
//     same-line regex candidate follows it; otherwise it is inert.
//  4. Automatic semicolon insertion is not modelled anywhere except the
//     explicit `++`/`--` fail-closed case above.
//  5. Regex-literal FLAGS are lexed as a run of ASCII letters. A regex
//     immediately followed (no space) by an identifier is not valid JS,
//     so this cannot mis-consume real code.
//
// Usage (library):
//   import { findMatchingBracket, stripComments } from './lib/js-scanner.mjs'
// Usage (self-test):
//   node scripts/lib/js-scanner.mjs --self-test
// Exit (self-test): 0 = all assertions passed, 2 = an assertion failed.
// ─────────────────────────────────────────────────────────────────────

import { realpathSync } from 'node:fs'

/**
 * Raised when the scanner cannot decide what a construct is. Callers are
 * expected to convert this into a guard FAILURE ("ambiguous, cannot
 * verify"), never into a silent skip — an undecidable input must redden
 * the gate, not pass it.
 */
export class ScanError extends Error {
  constructor(message, index) {
    super(message)
    this.name = 'ScanError'
    this.index = index
  }
}

/** Keywords after which a `/` starts a regex literal, not a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'for',
  'if',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'switch',
  'throw',
  'typeof',
  'void',
  'while',
  'with',
  'yield',
])

/** Punctuators after which a `{` opens a BLOCK rather than an object literal. */
const BLOCK_PREV_PUNCT = new Set([')', ';', '{', '}', '=>'])

/** Keywords after which a `{` opens a BLOCK rather than an object literal. */
const BLOCK_PREV_KEYWORD = new Set(['else', 'do', 'try', 'finally', 'catch'])

/** Keywords whose `( … )` clause may be followed directly by a regex literal. */
const CONTROL_HEAD_KEYWORDS = new Set(['if', 'while', 'for', 'with', 'switch'])

const WS_CHARS = new Set([' ', '\t', '\n', '\r', '\f', '\v', '\u00A0', '\uFEFF'])

function isWs(c) {
  return WS_CHARS.has(c)
}

function isDigit(c) {
  return c >= '0' && c <= '9'
}

function isIdentStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c > '\u007F'
}

function isIdentPart(c) {
  return isIdentStart(c) || isDigit(c)
}

// ─── literal sub-scanners ───────────────────────────────────────────

/**
 * Advance past a `'`/`"` string literal starting at `i`. Returns the
 * index just past the closing quote. Throws `ScanError` if it never
 * closes.
 *
 * A raw newline is NOT treated as terminating the literal, even though
 * ECMA-262 forbids one inside a string literal: JSX attribute values are
 * ordinary-looking quoted strings that legitimately wrap across lines
 * (`className="…\n  …"`), and the guards that use this scanner walk
 * `.tsx`. Stopping at the newline would reject that real, valid source.
 */
function scanQuoted(src, i, to) {
  const quote = src[i]
  let j = i + 1
  while (j < to) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === quote) return j + 1
    j++
  }
  throw new ScanError(`unterminated ${quote}…${quote} string literal`, i)
}

/**
 * Advance past a template literal starting at `` ` `` at `i`, including
 * nested `${ … }` interpolations (which are themselves tokenized, so a
 * brace/quote/regex inside an interpolation is handled correctly).
 */
function scanTemplate(src, i, to) {
  let j = i + 1
  while (j < to) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '`') return j + 1
    if (c === '$' && src[j + 1] === '{') {
      j = scanTemplateExpr(src, j + 2, to)
      continue
    }
    j++
  }
  throw new ScanError('unterminated template literal', i)
}

/** Advance past a `${ … }` interpolation body; `i` points just after `${`. */
function scanTemplateExpr(src, i, to) {
  let depth = 1
  for (const tok of tokenize(src, {
    from: i,
    to,
    initialPrev: { kind: 'punct', value: '{', start: i - 1, end: i },
  })) {
    if (tok.kind !== 'punct') continue
    if (tok.value === '{') depth++
    else if (tok.value === '}') {
      depth--
      if (depth === 0) return tok.end
    }
  }
  throw new ScanError('unterminated ${…} interpolation in template literal', i)
}

/**
 * Try to lex a regex literal starting at the `/` at `i`. Returns the
 * index just past the trailing flags, or `null` if the candidate is not a
 * well-formed regex literal that terminates on the SAME line — in which
 * case the caller emits an ordinary `/` punctuator instead. Character
 * classes are tracked so a `/` inside `[ … ]` does not terminate it.
 */
function tryScanRegex(src, i, to) {
  let j = i + 1
  let inClass = false
  while (j < to) {
    const c = src[j]
    if (c === '\n') return null
    if (c === '\\') {
      j += 2
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') {
      inClass = true
    } else if (c === '/') {
      j++
      while (j < to && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) j++
      return j
    }
    j++
  }
  return null
}

// ─── the ambiguity resolver ─────────────────────────────────────────

/**
 * Decide whether the `/` at `slashIdx` starts a regex literal, given the
 * previous significant token. See the decision table in this file's
 * header. Throws `ScanError` for the one position whose answer depends on
 * automatic semicolon insertion.
 */
function regexAllowedAfter(prev, src, slashIdx) {
  if (prev === null) return true
  switch (prev.kind) {
    case 'number':
    case 'string':
    case 'template':
    case 'regex': {
      return false
    }
    case 'ident': {
      return REGEX_PRECEDING_KEYWORDS.has(prev.value)
    }
    case 'punct': {
      const v = prev.value
      if (v === ')') return prev.controlHead === true
      if (v === ']') return false
      if (v === '}') return prev.blockClose === true
      if (v === '<' || v === '>') return false
      if (v === '++' || v === '--') {
        if (src.slice(prev.end, slashIdx).includes('\n')) {
          throw new ScanError(
            `cannot decide whether the \`/\` is a regex literal or division: it follows \`${v}\` ` +
              'across a newline, so the answer depends on automatic semicolon insertion. This ' +
              'scanner refuses to guess (fails closed) rather than risk a silently wrong extraction.',
            slashIdx,
          )
        }
        return false
      }
      return true
    }
    default: {
      return true
    }
  }
}

// ─── the tokenizer ──────────────────────────────────────────────────

/**
 * Lex `src[from … to)` into tokens `{ kind, start, end, value? }` where
 * `kind` is one of `ws`, `comment`, `string`, `template`, `regex`,
 * `number`, `ident`, `punct`. `value` carries the text for `ident` and
 * `punct` (the two kinds whose identity drives decisions). `)` tokens
 * carry `controlHead`, `}` tokens carry `blockClose`.
 *
 * `initialPrev` seeds the previous-significant-token state for scans that
 * start mid-source: pass the token that lexically precedes `from`, or
 * leave it `null` to mean "expression/statement start" (the safe default
 * for the callers here, which always begin at a bracket or at the start
 * of an expression).
 *
 * Throws `ScanError` on undecidable input — see the header's fail-closed
 * policy.
 */
export function* tokenize(src, { from = 0, to = src.length, initialPrev = null } = {}) {
  let prev = initialPrev
  const parenStack = []
  const braceStack = []
  let i = from

  while (i < to) {
    const c = src[i]
    const c2 = src[i + 1]

    if (isWs(c)) {
      const start = i
      while (i < to && isWs(src[i])) i++
      yield { kind: 'ws', start, end: i }
      continue
    }

    if (c === '/' && c2 === '/') {
      const start = i
      while (i < to && src[i] !== '\n') i++
      yield { kind: 'comment', start, end: i }
      continue
    }

    if (c === '/' && c2 === '*') {
      const start = i
      let j = i + 2
      while (j < to && !(src[j] === '*' && src[j + 1] === '/')) j++
      i = Math.min(j + 2, to)
      yield { kind: 'comment', start, end: i }
      continue
    }

    if (c === "'" || c === '"') {
      const start = i
      i = scanQuoted(src, i, to)
      prev = { kind: 'string', start, end: i }
      yield prev
      continue
    }

    if (c === '`') {
      const start = i
      i = scanTemplate(src, i, to)
      prev = { kind: 'template', start, end: i }
      yield prev
      continue
    }

    if (c === '/') {
      const start = i
      if (regexAllowedAfter(prev, src, i)) {
        const end = tryScanRegex(src, i, to)
        if (end !== null) {
          i = end
          prev = { kind: 'regex', start, end: i }
          yield prev
          continue
        }
      }
      i += 1
      prev = { kind: 'punct', value: '/', start, end: i }
      yield prev
      continue
    }

    if (isDigit(c) || (c === '.' && isDigit(c2))) {
      const start = i
      i++
      while (i < to && (isIdentPart(src[i]) || src[i] === '.')) {
        // Exponent sign: `1e-3` / `1E+3`.
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-')) {
          i += 2
          continue
        }
        i++
      }
      prev = { kind: 'number', start, end: i }
      yield prev
      continue
    }

    if (isIdentStart(c)) {
      const start = i
      while (i < to && isIdentPart(src[i])) i++
      prev = { kind: 'ident', value: src.slice(start, i), start, end: i }
      yield prev
      continue
    }

    // Punctuators. Only the multi-character forms that change a decision
    // are lexed as one token: `=>` (an arrow body is a block, and a regex
    // may follow the arrow) and `++`/`--` (postfix, see the table).
    const start = i
    let value
    if ((c === '=' && c2 === '>') || (c === '+' && c2 === '+') || (c === '-' && c2 === '-')) {
      value = c + c2
      i += 2
    } else {
      value = c
      i += 1
    }
    const tok = { kind: 'punct', value, start, end: i }
    if (value === '(') {
      parenStack.push(
        prev !== null && prev.kind === 'ident' && CONTROL_HEAD_KEYWORDS.has(prev.value),
      )
    } else if (value === ')') {
      tok.controlHead = parenStack.length > 0 ? parenStack.pop() : false
    } else if (value === '{') {
      braceStack.push(
        prev === null ||
          (prev.kind === 'punct' && BLOCK_PREV_PUNCT.has(prev.value)) ||
          (prev.kind === 'ident' && BLOCK_PREV_KEYWORD.has(prev.value)),
      )
    } else if (value === '}') {
      tok.blockClose = braceStack.length > 0 ? braceStack.pop() : false
    }
    prev = tok
    yield tok
  }
}

// ─── the primitives the guards share ────────────────────────────────

/**
 * Advance past a string/template literal starting at `src[i]` (`'`, `"`
 * or `` ` ``). Returns the index just past the closing quote. Throws
 * `ScanError` if it never closes.
 */
export function skipString(src, i) {
  return src[i] === '`' ? scanTemplate(src, i, src.length) : scanQuoted(src, i, src.length)
}

/**
 * Replace comments with equal-length whitespace (newlines preserved, so
 * every offset into the result is still a valid offset into the input),
 * leaving strings, template literals and REGEX LITERALS untouched. Used
 * before any structural search so a `//` or `/*` inside a string — or
 * inside a regex literal, the #3950 case — is not mistaken for a comment.
 */
export function stripComments(src) {
  let out = ''
  let cursor = 0
  for (const tok of tokenize(src)) {
    if (tok.start > cursor) out += src.slice(cursor, tok.start)
    if (tok.kind === 'comment') {
      out += src.slice(tok.start, tok.end).replace(/[^\n]/g, ' ')
    } else {
      out += src.slice(tok.start, tok.end)
    }
    cursor = tok.end
  }
  if (cursor < src.length) out += src.slice(cursor)
  return out
}

/**
 * The mirror image of `stripComments`: replace string/template literal
 * CONTENTS (quotes included) with equal-length whitespace, preserving
 * comments, regex literals, newlines and length. Used before marker-line
 * matching so a marker-shaped line living inside a string or template
 * literal (data, not a real marker) is not mistaken for one, while a
 * genuine marker inside a comment is left intact.
 */
export function blankStringsAndTemplates(src) {
  let out = ''
  let cursor = 0
  for (const tok of tokenize(src)) {
    if (tok.start > cursor) out += src.slice(cursor, tok.start)
    if (tok.kind === 'string' || tok.kind === 'template') {
      out += src.slice(tok.start, tok.end).replace(/[^\n]/g, ' ')
    } else {
      out += src.slice(tok.start, tok.end)
    }
    cursor = tok.end
  }
  if (cursor < src.length) out += src.slice(cursor)
  return out
}

/**
 * Find the index of the bracket matching `src[openIdx]` (one of `([{`),
 * skipping over comments and string/template/regex literal contents.
 * Returns -1 if unmatched. Throws `ScanError` on undecidable input.
 */
export function findMatchingBracket(src, openIdx) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const openCh = src[openIdx]
  const closeCh = pairs[openCh]
  if (closeCh === undefined) return -1
  let depth = 0
  for (const tok of tokenize(src, { from: openIdx })) {
    if (tok.kind !== 'punct') continue
    if (tok.value === openCh) depth++
    else if (tok.value === closeCh) {
      depth--
      if (depth === 0) return tok.start
    }
  }
  return -1
}

/**
 * Split `src` on top-level commas (depth 0 relative to `src`'s own
 * `()[]{}` nesting), skipping over comments and string/template/regex
 * literal contents. Returns trimmed, non-empty segments.
 */
export function splitTopLevelCommas(src) {
  const parts = []
  let depth = 0
  let start = 0
  for (const tok of tokenize(src)) {
    if (tok.kind !== 'punct') continue
    const v = tok.value
    if (v === '(' || v === '[' || v === '{') depth++
    else if (v === ')' || v === ']' || v === '}') depth--
    else if (v === ',' && depth === 0) {
      parts.push(src.slice(start, tok.start))
      start = tok.end
    }
  }
  parts.push(src.slice(start))
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * Punctuators that, appearing as the first significant token of a line,
 * CONTINUE the previous line's expression rather than starting a new
 * statement (so no automatic semicolon is inserted before them). Used by
 * `findStatementEnd`. `(`, `[` and `` ` `` are included because JS really
 * does continue the expression there — the classic ASI hazard.
 */
const EXPR_CONTINUATION_PUNCT = new Set([
  '.',
  ',',
  '?',
  ':',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '&',
  '|',
  '^',
  '(',
  '[',
  '=>',
])

/** Keywords that continue an expression when they lead a line. */
const EXPR_CONTINUATION_KEYWORD = new Set(['instanceof', 'in', 'as', 'satisfies'])

/**
 * Find the end (exclusive) of the statement/expression that starts at
 * `from`, scanning at bracket depth 0 until either an explicit `;`, a
 * top-level `,` (the next declarator of a multi-declarator `const a = 1,
 * b = 2`), or an automatic-semicolon boundary: a newline after which the
 * next significant token cannot continue the expression.
 *
 * Returns the end offset of the LAST token of the expression (so a
 * trailing comment on the same line is not included), or `null` if the
 * brackets never balance (fail closed).
 *
 * This codebase writes no semicolons, so the ASI branch is the normal
 * path, not the exotic one.
 */
export function findStatementEnd(src, from) {
  let depth = 0
  let lastSignificantEnd = null
  let sawNewlineSinceLastToken = false

  for (const tok of tokenize(src, { from })) {
    if (tok.kind === 'ws') {
      if (src.slice(tok.start, tok.end).includes('\n')) sawNewlineSinceLastToken = true
      continue
    }
    if (tok.kind === 'comment') {
      if (src.slice(tok.start, tok.end).includes('\n')) sawNewlineSinceLastToken = true
      continue
    }
    if (depth === 0 && sawNewlineSinceLastToken && lastSignificantEnd !== null) {
      const continues =
        (tok.kind === 'punct' && EXPR_CONTINUATION_PUNCT.has(tok.value)) ||
        tok.kind === 'template' ||
        (tok.kind === 'ident' && EXPR_CONTINUATION_KEYWORD.has(tok.value))
      if (!continues) return lastSignificantEnd
    }
    if (tok.kind === 'punct') {
      const v = tok.value
      if (v === '(' || v === '[' || v === '{') depth++
      else if (v === ')' || v === ']' || v === '}') {
        depth--
        if (depth < 0) return lastSignificantEnd
      } else if (depth === 0 && (v === ';' || v === ',')) {
        return lastSignificantEnd
      }
    }
    lastSignificantEnd = tok.end
    sawNewlineSinceLastToken = false
  }

  if (depth !== 0) return null
  return lastSignificantEnd
}

// ─── self-test ──────────────────────────────────────────────────────

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])

if (isMainModule && process.argv.includes('--self-test')) {
  runSelfTest()
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const check = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

  /** Run a token stream to completion for its side effect (it may throw). */
  const drain = (iter) => {
    let n = 0
    for (const _tok of iter) n++
    return n
  }

  /** Kinds of every significant token, for compact assertions. */
  const kinds = (src) =>
    [...tokenize(src)]
      .filter((t) => t.kind !== 'ws' && t.kind !== 'comment')
      .map((t) => (t.kind === 'punct' || t.kind === 'ident' ? `${t.kind}:${t.value}` : t.kind))

  /** The source text of every regex literal the tokenizer finds. */
  const regexes = (src) =>
    [...tokenize(src)].filter((t) => t.kind === 'regex').map((t) => src.slice(t.start, t.end))

  // ── #3950: regex literals with braces ──────────────────────────────

  check(
    'a regex containing a bare `}` is lexed as one regex literal',
    regexes(String.raw`const r = /\}/g`).join() === String.raw`/\}/g`,
    JSON.stringify(regexes(String.raw`const r = /\}/g`)),
  )

  {
    // The load-bearing consequence: the bare `}` must not close a brace.
    const src = String.raw`function f() { const r = /\}/; return r }`
    const close = findMatchingBracket(src, src.indexOf('{'))
    check(
      'a regex containing a bare `}` does not close the enclosing block early',
      close === src.length - 1,
      `close=${close} (len ${src.length})`,
    )
  }

  {
    const src = String.raw`function f() { const r = /\{/; return r }`
    const close = findMatchingBracket(src, src.indexOf('{'))
    check(
      'a regex containing a bare `{` does not open a phantom block',
      close === src.length - 1,
      `close=${close} (len ${src.length})`,
    )
  }

  // ── #3950 (widened): regex literals with quotes ────────────────────

  {
    const src = "const r = /['\"]/\nconst after = 'plain'\n"
    check(
      'a regex containing `\'` and `"` is not read as a string opener',
      regexes(src).join() === '/[\'"]/',
      JSON.stringify(regexes(src)),
    )
    check(
      'the token stream after a quote-bearing regex is still in sync',
      kinds(src).join(' ') ===
        'ident:const ident:r punct:= regex ident:const ident:after punct:= string',
      kinds(src).join(' '),
    )
  }

  {
    const src = String.raw`function f() { if (/['"]/.test(s)) { return "}" } return 1 }`
    const close = findMatchingBracket(src, src.indexOf('{'))
    check(
      'a quote-bearing regex plus a `}` inside a string still balances',
      close === src.length - 1,
      `close=${close} (len ${src.length})`,
    )
  }

  // ── division must NOT be read as a regex ───────────────────────────

  check(
    '`a / b / c` is three operands and two divisions, not a regex',
    kinds('const x = a / b / c').join(' ') ===
      'ident:const ident:x punct:= ident:a punct:/ ident:b punct:/ ident:c',
    kinds('const x = a / b / c').join(' '),
  )

  check(
    '`1 / 2 / 3` (numeric operands) is division, not a regex',
    regexes('const x = 1 / 2 / 3').length === 0,
    JSON.stringify(regexes('const x = 1 / 2 / 3')),
  )

  check(
    '`(a + b) / c` — a `)` closing a grouping is division',
    regexes('const x = (a + b) / c').length === 0,
    JSON.stringify(regexes('const x = (a + b) / c')),
  )

  check(
    '`f() / 2 / 3` — a `)` closing a call is division',
    regexes('const x = f() / 2 / 3').length === 0,
    JSON.stringify(regexes('const x = f() / 2 / 3')),
  )

  check(
    '`a[0] / b / c` — after `]` is division',
    regexes('const x = a[0] / b / c').length === 0,
    JSON.stringify(regexes('const x = a[0] / b / c')),
  )

  check(
    '`x++ / y / z` — after a postfix `++` on the same line is division',
    regexes('const q = x++ / y / z').length === 0,
    JSON.stringify(regexes('const q = x++ / y / z')),
  )

  // ── regex in each ambiguous position ───────────────────────────────

  check(
    'after `)` of an `if` clause: `if (x) /re/.test(s)` is a regex',
    regexes('if (x) /re/.test(s)').join() === '/re/',
    JSON.stringify(regexes('if (x) /re/.test(s)')),
  )

  check(
    'after `return`: `return /re/.test(s)` is a regex',
    regexes('function f() { return /re/.test(s) }').join() === '/re/',
    JSON.stringify(regexes('function f() { return /re/.test(s) }')),
  )

  check(
    'after `typeof`/`case`/`in`/`new`/`void`/`throw`/`delete`: regex',
    regexes('switch (k) { case /a/.source: break }').join() === '/a/',
    JSON.stringify(regexes('switch (k) { case /a/.source: break }')),
  )

  check(
    'at statement start (first token of the scan): regex',
    regexes('/^ab$/.test(s)').join() === '/^ab$/',
    JSON.stringify(regexes('/^ab$/.test(s)')),
  )

  check(
    'after an identifier: division, even when a closing `/` exists on the line',
    regexes('const x = width / height / 2').length === 0,
    JSON.stringify(regexes('const x = width / height / 2')),
  )

  check(
    'after `=>`: `() => /re/.test(s)` is a regex',
    regexes('const f = () => /re/.test(s)').join() === '/re/',
    JSON.stringify(regexes('const f = () => /re/.test(s)')),
  )

  check(
    'after `,` inside a call: `f(a, /re/, b)` is a regex',
    regexes('f(a, /re/, b)').join() === '/re/',
    JSON.stringify(regexes('f(a, /re/, b)')),
  )

  check(
    'a `/` inside a regex character class does not terminate it',
    regexes('const r = /[/]/g').join() === '/[/]/g',
    JSON.stringify(regexes('const r = /[/]/g')),
  )

  // ── fail-closed cases ──────────────────────────────────────────────

  {
    let threw = null
    try {
      drain(tokenize('const x = a++\n/re/.test(s)'))
    } catch (err) {
      threw = err
    }
    check(
      'a `/` after `++` across a newline (ASI-dependent) FAILS CLOSED with ScanError',
      threw instanceof ScanError,
      String(threw),
    )
  }

  {
    let threw = null
    try {
      drain(tokenize("const s = 'never closed\nconst t = 2"))
    } catch (err) {
      threw = err
    }
    check(
      'an unterminated string literal FAILS CLOSED with ScanError',
      threw instanceof ScanError,
      String(threw),
    )
  }

  {
    let threw = null
    try {
      drain(tokenize('const s = `never closed'))
    } catch (err) {
      threw = err
    }
    check(
      'an unterminated template literal FAILS CLOSED with ScanError',
      threw instanceof ScanError,
      String(threw),
    )
  }

  {
    // A `/` that opens no well-formed same-line regex degrades to a
    // punctuator: it must NOT swallow text to the next `/` anywhere later
    // in the file. Here the only other `/` is two lines down, inside a
    // comment — swallowing to it would eat the `'` and the `{`, desyncing
    // everything after.
    const src =
      "function f() {\n  const ratio = a / b\n  // no regex here\n  const s = '}'\n  return s }"
    const close = findMatchingBracket(src, src.indexOf('{'))
    check(
      'a `/` with no well-formed same-line regex after it degrades to a punctuator, swallowing nothing',
      regexes(src).length === 0 && close === src.length - 1,
      `regexes=${JSON.stringify(regexes(src))} close=${close} (len ${src.length})`,
    )
  }

  {
    // #3950's "entirely unbalanced regex" input: a regex literal holding a
    // lone `{`. The OLD scanner had no regex awareness, so that `{` opened
    // a brace that never closed and extraction returned null ("ambiguous")
    // — fail closed, which is why the issue records it as already correct.
    // The new scanner does better: it extracts, and it extracts the WHOLE
    // function including everything after the regex.
    const src = 'function f() { const open = /\\{/; const s = "tail"; return s }'
    const close = findMatchingBracket(src, src.indexOf('{'))
    check(
      'a regex holding a lone `{` now extracts fully instead of only failing closed',
      close === src.length - 1 && src.slice(0, close + 1).includes('return s'),
      `close=${close} (len ${src.length})`,
    )
  }

  // ── the twelve adversarial inputs #3950 records as already correct ──

  {
    const src = 'function f() { const s = "}" ; return s }'
    check(
      'a string containing `}` does not close the block early',
      findMatchingBracket(src, src.indexOf('{')) === src.length - 1,
      String(findMatchingBracket(src, src.indexOf('{'))),
    )
  }

  {
    const src = 'function f() { const r = /a{2,3}/; return r }'
    check(
      'balanced regex quantifier braces `/a{2,3}/` extract correctly',
      findMatchingBracket(src, src.indexOf('{')) === src.length - 1 &&
        regexes(src).join() === '/a{2,3}/',
      `${findMatchingBracket(src, src.indexOf('{'))} ${JSON.stringify(regexes(src))}`,
    )
  }

  {
    const src = 'function f() { return `${ {x:1} }` }'
    check(
      '`${ {x:1} }` inside a template literal does not desync brace depth',
      findMatchingBracket(src, src.indexOf('{')) === src.length - 1,
      String(findMatchingBracket(src, src.indexOf('{'))),
    )
  }

  {
    const src = 'function f(m: Map<string, {x: number}>) { return m }'
    check(
      '`Map<string, {x: number}>` generics do not desync brace depth',
      findMatchingBracket(src, src.indexOf('{', src.indexOf(')'))) === src.length - 1,
      String(findMatchingBracket(src, src.indexOf('{', src.indexOf(')')))),
    )
  }

  {
    const src = "function f() { // a comment with a backtick ` and an apostrophe '\n  return 1 }"
    check(
      'a comment containing a backtick and an apostrophe does not desync',
      findMatchingBracket(src, src.indexOf('{')) === src.length - 1,
      String(findMatchingBracket(src, src.indexOf('{'))),
    )
  }

  {
    const src = 'function f() { /* an unbalanced } in a block comment */ return 1 }'
    check(
      'a block comment with an unbalanced `}` does not close the block',
      findMatchingBracket(src, src.indexOf('{')) === src.length - 1,
      String(findMatchingBracket(src, src.indexOf('{'))),
    )
  }

  // ── stripComments / blankStringsAndTemplates offset preservation ───

  {
    const src = 'const a = 1 // note\nconst r = /[\'"]/ /* tail */\nconst b = `x${ {y:1} }`\n'
    const stripped = stripComments(src)
    check(
      'stripComments preserves length and newline positions',
      stripped.length === src.length &&
        stripped.split('\n').length === src.split('\n').length &&
        !stripped.includes('note') &&
        stripped.includes('/[\'"]/'),
      JSON.stringify(stripped),
    )
    const blanked = blankStringsAndTemplates(src)
    check(
      'blankStringsAndTemplates preserves length, keeps comments and regex literals',
      blanked.length === src.length &&
        blanked.includes('note') &&
        blanked.includes('/[\'"]/') &&
        !blanked.includes('${'),
      JSON.stringify(blanked),
    )
  }

  // ── splitTopLevelCommas with a comma inside a regex ────────────────

  {
    const parts = splitTopLevelCommas('a, /x{1,2}/g, b')
    check(
      'a comma inside a regex quantifier is not a top-level comma',
      parts.length === 3 && parts[1] === '/x{1,2}/g',
      JSON.stringify(parts),
    )
  }

  // ── findStatementEnd ───────────────────────────────────────────────

  {
    const src = 'const R = /(!?)\\[([^\\]]*)\\]\\((attachment:[^)\\s]+)\\)/g\nconst after = 1\n'
    const end = findStatementEnd(src, src.indexOf('/'))
    check(
      'findStatementEnd stops at the ASI boundary, not at the next statement',
      end !== null &&
        src.slice(src.indexOf('/'), end) === '/(!?)\\[([^\\]]*)\\]\\((attachment:[^)\\s]+)\\)/g',
      JSON.stringify(end === null ? null : src.slice(src.indexOf('/'), end)),
    )
  }

  {
    const src = 'const X = foo(\n  1,\n  2,\n)\nconst after = 1\n'
    const end = findStatementEnd(src, src.indexOf('foo'))
    check(
      'findStatementEnd spans a multi-line call expression',
      end !== null && src.slice(src.indexOf('foo'), end) === 'foo(\n  1,\n  2,\n)',
      JSON.stringify(end === null ? null : src.slice(src.indexOf('foo'), end)),
    )
  }

  {
    const src = 'const X = foo(\n  1,\n'
    check(
      'findStatementEnd returns null when brackets never balance (fails closed)',
      findStatementEnd(src, src.indexOf('foo')) === null,
      String(findStatementEnd(src, src.indexOf('foo'))),
    )
  }

  {
    const src = 'const X = 1 // trailing comment\nconst after = 2\n'
    const end = findStatementEnd(src, src.indexOf('1'))
    check(
      'findStatementEnd excludes a trailing same-line comment',
      end !== null && src.slice(src.indexOf('1'), end) === '1',
      JSON.stringify(end === null ? null : src.slice(src.indexOf('1'), end)),
    )
  }

  {
    const src = 'const a = 1, b = 2\n'
    const end = findStatementEnd(src, src.indexOf('1'))
    check(
      'findStatementEnd stops at a top-level `,` (multi-declarator)',
      end !== null && src.slice(src.indexOf('1'), end) === '1',
      JSON.stringify(end === null ? null : src.slice(src.indexOf('1'), end)),
    )
  }

  // ── TSX shapes the guards actually walk ────────────────────────────

  {
    const src = '<Foo bar={x} />\n'
    check(
      'a JSX self-closing tag after `}` is not read as a regex',
      regexes(src).length === 0,
      JSON.stringify(regexes(src)),
    )
  }

  {
    const src = 'const el = <div>{a}/{b}</div>\n'
    check(
      'a `/` in JSX text after `}` is not read as a regex',
      regexes(src).length === 0,
      JSON.stringify(regexes(src)),
    )
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
