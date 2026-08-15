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
//   the same keyword spelled as a     DIVISION — `obj.in`, `map.delete`,
//     PROPERTY NAME (directly after     `x.return` are member expressions,
//     `.` or `?.`)                      i.e. COMPLETE expressions. This is
//                                       the only position where a reserved
//                                       word is a plain identifier.
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
// Two constructs deliberately DEGRADE instead of throwing, because for both
// of them the ambiguous input occurs in valid source and a throw would stop
// the gate repo-wide rather than name a defect:
//   - a `/` that opens no well-formed same-line regex becomes an ordinary
//     punctuator;
//   - a `/*` with no closer is not treated as a comment at all, and its `/`
//     and `*` become ordinary punctuators. Consuming it to EOF instead was
//     the one remaining fail-OPEN: it blanked the whole tail of the file, so
//     `check-set-property-args` reported a file it had not checked as clean.
//     Degrading keeps the tail lexed; it does NOT silently hide anything.
//
// `findStatementEnd` has its own fail-closed rules: it returns `null` when
// the expression is still dangling on an operator at end of input, and when
// a line ENDS IN `>` at a statement boundary. The latter is undecidable for
// a lexer — either a JSX element just closed (expression complete) or a
// relational operator is dangling (expression incomplete) — and the two
// wrong answers are an over-extension into the next statement and a
// truncated-prefix hash respectively. Refusing beats guessing either way,
// so a JSX-valued `const` is currently unpinnable rather than mis-pinned.
//
// ─── Stated limitations (all chosen to fail closed or to be inert) ──
//
//  1. JSX/TSX is not parsed as a grammar. `<` and `>` are therefore
//     treated as never introducing a regex, because in a `.tsx` file
//     `</` is overwhelmingly a closing tag while `a < /re/.source` is
//     absurd in real code. Cost: a regex literal written directly after
//     a relational operator is read as division, which leaves the
//     pre-#3950 behaviour in place for that one position — INCLUDING the
//     pre-#3950 failure mode. `n < /\}/.source` really does truncate a
//     bracket-depth scan at the regex's brace, exactly as #3950 describes;
//     this is a deliberately unfixed corner, not an inert one, and the
//     earlier "never a truncation" wording here was wrong.
//     It is kept unfixed because the alternative is worse: permitting a
//     regex after `<` makes a one-line `<div>{a}</div><span>{b}</span>`
//     lex `</div><span>{b}<` as a regex literal, which desyncs brace depth
//     across ordinary TSX rather than across a construct nobody writes.
//     A repo-wide sweep found zero `<`-then-regex occurrences.
//  2. JSX TEXT is lexed as if it were code. An apostrophe in bare JSX
//     text (`<p>don't</p>`) is read as a string opener and consumes up to
//     the next quote — inherited unchanged from the scanners this
//     replaces, and not what #3950 is about. The #3950 flavour of this —
//     a QUOTE INSIDE A REGEX LITERAL, `/['"]/` — is fixed: the regex is
//     lexed as a regex, so its quotes never open a string.
//
//     BLAST RADIUS. The LIKELY outcome is the bad one: `scanQuoted` does
//     not stop at a newline, so the apostrophe usually pairs with some
//     later, unrelated `'` in the same file and everything between them is
//     silently consumed as a string — a desync of exactly the class #3950
//     exists to close, reported by nobody. `ScanError` (and with it
//     `check-set-property-args` exiting 1 for the WHOLE TREE, blocking every
//     commit until the text is escaped as `<p>don&apos;t</p>` or
//     `<p>{"don't"}</p>`) is the LUCKY outcome, and only happens when no
//     later quote exists to pair with. Ranking them the other way round —
//     as this note previously did — reads as "worst case: the gate stops",
//     which understates it.
//
//     Both outcomes are inherited unchanged from the scanners this replaces
//     (the old `skipString` also ignored newlines, and merely returned the
//     end offset instead of raising), so this is not a regression — but it
//     is the one place where this module can still desync silently, and it
//     is not fixable without a JSX grammar. A repo sweep over 1781 files
//     finds zero today.
//
//     The same JSX-text hazard is why an unterminated `/*` degrades rather
//     than raising: `<span>path:Journal/*</span>` is real, valid source in
//     this repo, so raising there would stop the gate on a non-defect. The
//     two cases differ because a stray quote in JSX text is rare and easy to
//     escape, while a trailing `/*` in a glob is neither.
//  3. Brace classification (block vs object literal) is the standard
//     previous-token heuristic, not a parse, PLUS one extra rule for TS: a
//     `:` directly after a `)` opens a return-type annotation, and the next
//     `{` at generic-depth 0 is that function's BODY. Without it the token
//     before the body brace of `function f(): void {` is the ident `void`,
//     which is in neither BLOCK_PREV set, so the most common shape in this
//     codebase was classified as an object literal and the "`}` → REGEX
//     after a block" row never fired for it. Ternary `:` is excluded (a `?`
//     that is not `?.` and not `a?:` opens one), so `c ? f() : { a: 1 }`
//     stays an object literal. A misclassification only matters when a `/`
//     immediately follows the `}` AND a well-formed same-line regex
//     candidate follows it; otherwise it is inert.
//  4. Automatic semicolon insertion is not modelled anywhere except the
//     explicit `++`/`--` fail-closed case above and `findStatementEnd`'s
//     boundary test, which looks BOTH ways: a newline is a boundary only if
//     the next token cannot continue the expression AND the previous token
//     did not leave it incomplete. Restricted productions (`return`,
//     `throw`, `yield`, `break`, `continue`), where ASI really does fire
//     across a newline, are why the incomplete-expression test covers
//     punctuators only and not keywords.
//  5. Regex-literal FLAGS are lexed as a run of ASCII letters. A regex
//     immediately followed (no space) by an identifier is not valid JS,
//     so this cannot mis-consume real code.
//  6. `of` is the ONLY member of the keyword set above that is not a
//     reserved word, so it is the only one that can also be a plain
//     variable name. `for (x of /re/)` needs `of` in the set; `const of =
//     4; of / 2 / 3` would then mis-lex `/ 2 /` as a regex. Deciding
//     between them needs a parser, not a lexer, so the for-of reading
//     wins. The property-name correction above already covers `obj.of`,
//     which is the common shape; a bare `of` BINDING is not (a repo-wide
//     sweep found zero). Reserved-word members of the set cannot hit this.
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
      // The escape must not step OVER the newline guard above. A backslash
      // immediately before a newline used to consume it and let the scan
      // keep hunting for a closing `/` on later lines, puncturing the
      // "terminates on the SAME LINE" property that bounds a mis-decided
      // `/`. A regex literal may not contain an unescaped OR escaped line
      // terminator (ECMA-262), so this is a non-regex either way.
      if (j + 1 >= to || src[j + 1] === '\n') return null
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
      // A keyword spelled as a PROPERTY NAME is not a keyword: `obj.in`,
      // `map.delete`, `x.return` are member expressions, and a member
      // expression is a COMPLETE expression, so a following `/` is
      // division. Without this, `const x = obj.in / y / z` lexed `/ y /`
      // as a regex literal and desynced everything after it — the same
      // class of defect as #3950 itself (a `/` mis-decided as a regex
      // swallows whatever sits between it and the next `/` on the line,
      // including quotes and braces the bracket scan depends on).
      // Property names are the one position where a reserved word may
      // legally appear as a plain identifier, so it is also the only
      // position this correction needs.
      if (prev.propertyName === true) return false
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
  // See the `?`/`:` handling below: `returnTypeContext` is true between a
  // `): ` and the `{` that opens the annotated function's body.
  let returnTypeContext = false
  let returnTypeAngleDepth = 0
  let ternaryDepth = 0
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

    // A block comment, but ONLY if it actually closes. Clamping to `to`
    // when it does not made this the single fail-OPEN left in the scanner:
    // `/*` with no closer was consumed to EOF as a comment, `stripComments`
    // blanked the whole tail of the file, and `check-set-property-args`
    // then found zero call sites after it and reported the file clean
    // without having checked it.
    //
    // An unterminated candidate DEGRADES to ordinary punctuators instead of
    // raising — the same move the regex lexer below already makes for a `/`
    // that does not open a well-formed literal, and for the same reason.
    // Raising would be wrong here: `/*` appears in bare JSX TEXT in valid
    // source (`<span>path:Journal/*</span>`,
    // src/components/search/FilterHelperPopover.tsx:262), which JSX-unaware
    // lexing cannot distinguish from a comment opener, so a throw would
    // block every commit repo-wide on a file that is not defective.
    // Degrading keeps the rest of the file lexed, and therefore checked.
    if (c === '/' && c2 === '*') {
      const start = i
      let j = i + 2
      while (j < to && !(src[j] === '*' && src[j + 1] === '/')) j++
      if (j < to) {
        i = j + 2
        yield { kind: 'comment', start, end: i }
        continue
      }
      // Falls through: the `/` is emitted as an ordinary punctuator below.
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
      // A radix prefix rules out both the exponent sign and a fraction dot:
      // without the check, `0xE+1` lexed as ONE number token that swallowed
      // the `+` operator, because `E` followed by `+` looked like an
      // exponent. A number also has at most ONE `.`, so `1.5.toFixed` is a
      // number, a `.` and a property — it used to be one token that ate the
      // member access whole.
      const radixPrefixed =
        c === '0' &&
        (c2 === 'x' || c2 === 'X' || c2 === 'b' || c2 === 'B' || c2 === 'o' || c2 === 'O')
      let seenDot = c === '.'
      i++
      while (i < to) {
        const d = src[i]
        if (d === '.') {
          if (seenDot || radixPrefixed) break
          seenDot = true
          i++
          continue
        }
        // Exponent sign: `1e-3` / `1E+3`, decimal literals only.
        if (
          !radixPrefixed &&
          (d === 'e' || d === 'E') &&
          (src[i + 1] === '+' || src[i + 1] === '-') &&
          isDigit(src[i + 2])
        ) {
          i += 2
          continue
        }
        if (isIdentPart(d)) {
          i++
          continue
        }
        break
      }
      prev = { kind: 'number', start, end: i }
      yield prev
      continue
    }

    if (isIdentStart(c)) {
      const start = i
      while (i < to && isIdentPart(src[i])) i++
      // An identifier directly after `.` or `?.` is a PROPERTY NAME, which
      // may legally be a reserved word (`obj.in`, `map?.delete`). Recorded
      // here so `regexAllowedAfter` does not read it as the keyword. Both
      // spellings must be listed since `?.` became a single token.
      prev = {
        kind: 'ident',
        value: src.slice(start, i),
        start,
        end: i,
        propertyName:
          prev !== null && prev.kind === 'punct' && (prev.value === '.' || prev.value === '?.'),
      }
      yield prev
      continue
    }

    // Punctuators. Only the multi-character forms that change a decision
    // are lexed as one token: `=>` (an arrow body is a block, and a regex
    // may follow the arrow) and `++`/`--` (postfix, see the table).
    const start = i
    let value
    // `??` and `?.` MUST be single tokens. Lexed as two bare `?`s, each one
    // took the ternary branch below (its next significant char is neither
    // `.` nor `:`), nothing balanced them, and the next two `:` tokens in
    // the file were consumed as ternary closers — including a `): T {`
    // return-type colon, silently disabling the return-type rule for any
    // file containing an idiomatic `?? null`.
    // `?.` followed by a DIGIT is not optional chaining: `a?.5:b` is the
    // ternary `a ? .5 : b`.
    if (
      (c === '=' && c2 === '>') ||
      (c === '+' && c2 === '+') ||
      (c === '-' && c2 === '-') ||
      (c === '?' && c2 === '?') ||
      (c === '?' && c2 === '.' && !isDigit(src[i + 2]))
    ) {
      value = c + c2
      i += 2
    } else {
      value = c
      i += 1
    }
    const tok = { kind: 'punct', value, start, end: i }

    // ── TS return-type annotations ────────────────────────────────────
    // A return type sits BETWEEN the parameter list's `)` and the body `{`,
    // so for `function f(): void {` the token before the body brace is the
    // ident `void`, and for `): Promise<T> {` it is `>`. Neither is in
    // BLOCK_PREV_*, so those bodies were classified as OBJECT LITERALS and
    // the "`}` → REGEX if that `{` opened a BLOCK" row never fired for the
    // most common shape in a `.ts`/`.tsx` codebase. `returnTypeContext`
    // carries "a `:` directly after a `)`" forward across the type's tokens.
    if (value === '?') {
      // Only a BARE `?` reaches here — `?.` and `??` are single tokens
      // above. What remains to exclude is the optional parameter/property
      // marker `a?: T`, which is not a ternary and whose `:` therefore must
      // stay available to the return-type rule.
      let k = i
      while (k < to && isWs(src[k])) k++
      if (src[k] !== ':') ternaryDepth++
    } else if (value === ':') {
      if (ternaryDepth > 0) {
        ternaryDepth--
      } else if (prev !== null && prev.kind === 'punct' && prev.value === ')') {
        returnTypeContext = true
        returnTypeAngleDepth = 0
      }
    } else if (returnTypeContext) {
      // Angle depth is tracked so a `,`/`(`/`)` INSIDE the type — as in
      // `): Map<string, number> {` — does not end the annotation, and so a
      // type-literal brace nested in a generic (`): Array<{ a: 1 }> {`)
      // does not consume the context before the real body brace arrives.
      if (value === '<') returnTypeAngleDepth++
      else if (value === '>') {
        if (returnTypeAngleDepth > 0) returnTypeAngleDepth--
      } else if (value === '=>' || value === '=' || value === ';') {
        returnTypeContext = false
      } else if (returnTypeAngleDepth === 0 && (value === ',' || value === '(' || value === ')')) {
        returnTypeContext = false
      }
    }

    // Both stacks must honour `propertyName` for the same reason
    // `regexAllowedAfter` does: `obj.with(a, b)` is a METHOD CALL, not a
    // `with` statement, so its `)` must not carry `controlHead` and permit
    // a regex; `p.catch` before a `{` is a property, not a `catch` clause.
    // Consulting the keyword sets without that check reinstated the exact
    // hole the `regexAllowedAfter` correction closed, one branch below it.
    if (value === '(') {
      parenStack.push(
        prev !== null &&
          prev.kind === 'ident' &&
          prev.propertyName !== true &&
          CONTROL_HEAD_KEYWORDS.has(prev.value),
      )
    } else if (value === ')') {
      tok.controlHead = parenStack.length > 0 ? parenStack.pop() : false
    } else if (value === '{') {
      braceStack.push(
        returnTypeContext ||
          prev === null ||
          (prev.kind === 'punct' && BLOCK_PREV_PUNCT.has(prev.value)) ||
          (prev.kind === 'ident' &&
            prev.propertyName !== true &&
            BLOCK_PREV_KEYWORD.has(prev.value)),
      )
      // The body brace consumes the annotation; a brace still inside `< >`
      // is a type literal, so it leaves the context in place.
      if (returnTypeContext && returnTypeAngleDepth === 0) returnTypeContext = false
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

/** Blank every character of `text` except newlines, preserving length. */
function blankKeepingNewlines(text) {
  return text.replace(/[^\n]/g, ' ')
}

/**
 * The mirror image of `stripComments`: replace string/template literal
 * CONTENTS (quotes included) with equal-length whitespace, preserving
 * comments, regex literals, newlines and length. Used before marker-line
 * matching so a marker-shaped line living inside a string or template
 * literal (data, not a real marker) is not mistaken for one, while a
 * genuine marker inside a comment is left intact.
 *
 * A template literal's `${…}` interpolations hold CODE, not literal text,
 * and are therefore NOT blanked — only the literal chunks around them are.
 * Blanking them too made a real `commands.setProperty(…)` written inside an
 * interpolation invisible to `check-set-property-args`'s call-site
 * discovery: not checked, and not counted as skipped either, which is the
 * one outcome that guard exists to make impossible. Interpolated code is
 * blanked recursively, so a string nested inside one is still blanked.
 */
export function blankStringsAndTemplates(src) {
  return blankStringsInRange(src, 0, src.length)
}

function blankStringsInRange(src, from, to) {
  let out = ''
  let cursor = from
  for (const tok of tokenize(src, { from, to })) {
    if (tok.start > cursor) out += src.slice(cursor, tok.start)
    if (tok.kind === 'string') {
      out += blankKeepingNewlines(src.slice(tok.start, tok.end))
    } else if (tok.kind === 'template') {
      out += blankTemplateKeepingInterpolations(src, tok.start, tok.end)
    } else {
      out += src.slice(tok.start, tok.end)
    }
    cursor = tok.end
  }
  if (cursor < to) out += src.slice(cursor, to)
  return out
}

/**
 * Blank a template literal's literal text while leaving each `${…}`
 * interpolation's code in place (recursively blanked itself). `start` points
 * at the opening backtick, `end` just past the closing one. Length and
 * newline positions are preserved, so offsets stay valid.
 */
function blankTemplateKeepingInterpolations(src, start, end) {
  let out = ''
  let j = start
  while (j < end) {
    const c = src[j]
    if (c === '\\') {
      out += blankKeepingNewlines(src.slice(j, Math.min(j + 2, end)))
      j += 2
      continue
    }
    if (c === '$' && src[j + 1] === '{') {
      // `scanTemplateExpr` returns the index just past the closing `}`.
      const exprEnd = scanTemplateExpr(src, j + 2, end)
      out += '  ' // the `${` delimiter itself carries no information
      out += blankStringsInRange(src, j + 2, exprEnd - 1)
      out += ' ' // the closing `}`
      j = exprEnd
      continue
    }
    out += c === '\n' ? '\n' : ' '
    j++
  }
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
  '?.',
  '??',
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
 * Punctuators that can legally END an expression. Any OTHER punctuator
 * standing as the last significant token means the expression is
 * syntactically INCOMPLETE (`… 'a' +`, `… &&`, `… ,`), so the newline that
 * follows it is not an automatic-semicolon boundary and `findStatementEnd`
 * must not break there.
 *
 * Only punctuators are listed. Keywords are deliberately excluded: `return`,
 * `throw`, `yield`, `break` and `continue` are RESTRICTED PRODUCTIONS where
 * ASI genuinely does fire across a newline, so treating a trailing keyword
 * as "incomplete" would be wrong in the one place it matters.
 */
const EXPR_TERMINAL_PUNCT = new Set([')', ']', '}', '++', '--'])

/** True when `tok` cannot be the last token of a complete expression. */
function leavesExpressionIncomplete(tok) {
  return tok !== null && tok.kind === 'punct' && !EXPR_TERMINAL_PUNCT.has(tok.value)
}

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
  let lastSignificantTok = null
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
    // The ASI test has to look BOTH ways. Asking only whether the NEXT
    // token can continue the expression truncates a multi-line initializer
    // whose lines end in a binary operator (`'a' +\n  'b'`), because a
    // string is not a continuation token — even though no ASI can occur
    // after a `+`. The previous token settles it first.
    // A line ending in `>` is genuinely undecidable here. It is either the
    // close of a JSX element — expression COMPLETE, so this newline IS a
    // boundary — or a dangling relational operator, expression INCOMPLETE,
    // so it is not. Guessing "complete" truncates `a >\n b` into a stable
    // hash over a prefix, which is the fail-open this module exists to
    // close; guessing "incomplete" runs a JSX-valued initializer into the
    // following statement. Refuse instead, per the fail-closed policy.
    if (
      depth === 0 &&
      sawNewlineSinceLastToken &&
      lastSignificantEnd !== null &&
      lastSignificantTok !== null &&
      lastSignificantTok.kind === 'punct' &&
      lastSignificantTok.value === '>'
    ) {
      return null
    }
    if (
      depth === 0 &&
      sawNewlineSinceLastToken &&
      lastSignificantEnd !== null &&
      !leavesExpressionIncomplete(lastSignificantTok)
    ) {
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
    lastSignificantTok = tok
    sawNewlineSinceLastToken = false
  }

  if (depth !== 0) return null
  // Ran out of input with the expression still dangling on an operator:
  // there is no defensible end offset, so refuse rather than report the
  // operator's own end (which is how the truncation above used to look).
  if (leavesExpressionIncomplete(lastSignificantTok)) return null
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

  // The escape branch used to be tested BEFORE the newline guard, so a
  // backslash sitting immediately before a newline stepped straight over it
  // and the scan kept hunting for a closing `/` on later lines. That is a
  // hole in the same-line property the header presents as the second,
  // independent safety net — the one thing that bounds a mis-decided `/`.
  for (const [src, label] of [
    ['function f() {\n  return / a\\\n  const t = b / c\n}', 'in open regex text'],
    ['function f() {\n  return / [a\\\n]  const t = b / c\n}', 'inside a character class'],
  ]) {
    check(
      `a backslash immediately before a newline does not escape the same-line rule (${label})`,
      regexes(src).length === 0,
      JSON.stringify(regexes(src)),
    )
  }

  check(
    'an ordinary escape inside a regex still works',
    regexes(String.raw`const r = /a\/b/g`).join() === String.raw`/a\/b/g`,
    JSON.stringify(regexes(String.raw`const r = /a\/b/g`)),
  )

  // A TS RETURN-TYPE ANNOTATION sits between the parameter list's `)` and
  // the body `{`, so the token before the body brace is the last token of
  // the TYPE (`void`, `>`, `]`), not `)`. The brace stack classified those
  // bodies as OBJECT LITERALS, so the decision-table row "`}` → REGEX if
  // that `{` opened a BLOCK" did not fire for the most common shape in this
  // codebase. It went unnoticed because the only assertion covering that
  // branch used the UNTYPED `function f() { g() }`, which passes either way.
  for (const [sig, label] of [
    ['function f(): void', 'a plain return type'],
    ['function f(): Promise<void>', 'a generic return type'],
    ['function f(): string[]', 'an array return type'],
    ['function f(): A | B', 'a union return type'],
    ['async function f(): Promise<void>', 'an async generic return type'],
  ]) {
    const src = `${sig} { g() }\n/re/.test(s)`
    check(
      `after a typed function body (${label}), a \`/\` at statement start is a regex`,
      regexes(src).join() === '/re/',
      JSON.stringify(regexes(src)),
    )
  }

  {
    // A type-literal brace NESTED IN A GENERIC return type must not consume
    // the annotation before the real body brace arrives — `): Array<{ a }> {`
    // has two braces, and only the second opens the body.
    const src = 'function f(): Array<{ a: number }> { g() }\n/re/.test(s)'
    check(
      'a type-literal brace inside a generic return type does not steal the body classification',
      regexes(src).join() === '/re/',
      JSON.stringify(regexes(src)),
    )
  }

  {
    const src = 'class A { m(): void { g() } }'
    const methodClose = [...tokenize(src)].find((t) => t.kind === 'punct' && t.value === '}')
    check(
      'a class method with a return type closes a BLOCK, not an object literal',
      methodClose !== undefined && methodClose.blockClose === true,
      `blockClose=${methodClose?.blockClose}`,
    )
  }

  // `??` and `?.` must lex as SINGLE punctuators. When `??` lexed as two
  // bare `?` tokens, each one took the ternary branch (its next significant
  // char is neither `.` nor `:`), nothing balanced them, and the next two
  // `:` tokens anywhere in the file were eaten as ternary closers —
  // including a `): T {` return-type colon. `?? null` is idiomatic here, so
  // the return-type fix was silently disabled for most real `.ts` files
  // after their first `??`. It reverted to the pre-#3950 classification, so
  // nothing reddened; no self-test input contained a `??` outside a string.
  check(
    '`??` lexes as one punctuator, not two ternary `?`s',
    kinds('const a = x ?? null').join(' ') ===
      'ident:const ident:a punct:= ident:x punct:?? ident:null',
    kinds('const a = x ?? null').join(' '),
  )

  check(
    '`?.` lexes as one punctuator',
    kinds('const a = x?.y').join(' ') === 'ident:const ident:a punct:= ident:x punct:?. ident:y',
    kinds('const a = x?.y').join(' '),
  )

  for (const [lead, label] of [
    ['const a = x ?? null', 'a single `??`'],
    ['const a = x ?? null\nconst b = y ?? null', 'two `??`s'],
    ['const a = { t: r.text ?? null, n: r.num ?? null }', '`??` inside an object literal'],
    ['const a = x?.y ?? null', 'mixed `?.` and `??`'],
  ]) {
    const src = `${lead}\nfunction f(): void { g() }\n/re/.test(s)`
    check(
      `${label} before a typed function does not disarm the return-type rule`,
      regexes(src).join() === '/re/',
      JSON.stringify(regexes(src)),
    )
  }

  // A real ternary must still balance after the `??` change.
  check(
    'a genuine ternary still consumes its `:` (no return-type false positive)',
    (() => {
      const src = 'const v = c ? f() : { a: 1 }'
      const close = [...tokenize(src)].find((t) => t.kind === 'punct' && t.value === '}')
      return close !== undefined && close.blockClose === false
    })(),
    'see source',
  )

  {
    // Regression guard on the fix above: a `:` that belongs to a TERNARY,
    // not to a return type, must still leave `{` an object literal.
    const src = 'const v = c ? f() : { a: 1 }'
    const close = [...tokenize(src)].find((t) => t.kind === 'punct' && t.value === '}')
    check(
      'a ternary `:` after `)` does not turn the following `{` into a block',
      close !== undefined && close.blockClose === false,
      `blockClose=${close?.blockClose}`,
    )
  }

  {
    // …and an ordinary object literal after a typed declaration is still an
    // object literal once the return-type context has been consumed.
    const src = 'function f(): void { g() }\nconst o = { a: 1 }\nconst n = 1'
    const closes = [...tokenize(src)].filter((t) => t.kind === 'punct' && t.value === '}')
    check(
      'the return-type context does not leak onto the next object literal',
      closes.length === 2 && closes[0].blockClose === true && closes[1].blockClose === false,
      JSON.stringify(closes.map((t) => t.blockClose)),
    )
  }

  // NUMBER LEXING. `0xE+1` used to lex as ONE number token, swallowing the
  // `+`, because the exponent-sign special case never checked the radix.
  // `1.5.toFixed(2)` lost `.toFixed` entirely for the same reason in the
  // `.`-consuming loop. Both are inert for bracket matching and for the
  // division-vs-regex decision (prev kind `number` answers as `ident` does),
  // but they are wrong at the token level.
  check(
    '`0xE+1` is a hex literal, a `+` punctuator and a number — not one token',
    kinds('const x = 0xE+1').join(' ') === 'ident:const ident:x punct:= number punct:+ number',
    kinds('const x = 0xE+1').join(' '),
  )

  check(
    '`1.5.toFixed(2)` keeps the member access as its own tokens',
    kinds('const y = 1.5.toFixed(2)').join(' ') ===
      'ident:const ident:y punct:= number punct:. ident:toFixed punct:( number punct:)',
    kinds('const y = 1.5.toFixed(2)').join(' '),
  )

  for (const [expr, want] of [
    ['const z = 1e-3', 'ident:const ident:z punct:= number'],
    ['const w = 0x1F', 'ident:const ident:w punct:= number'],
    ['const v = 1_000n', 'ident:const ident:v punct:= number'],
    ['const u = .5', 'ident:const ident:u punct:= number'],
  ]) {
    check(
      `\`${expr.slice(10)}\` still lexes as a single number`,
      kinds(expr).join(' ') === want,
      kinds(expr).join(' '),
    )
  }

  // The `}`-closes-a-BLOCK half of the brace-context stack. The two JSX
  // assertions below cover only the object-literal/expression-container
  // half (`}` → division); without this one, hard-wiring `blockClose` to
  // `false` passed the whole suite, so the stack's regex-permitting branch
  // was decoration. A regex at statement start after a block close is the
  // shape that exercises it.
  check(
    'after a `}` that closes a BLOCK, a `/` at statement start is a regex',
    regexes('function f() { g() }\n/re/.test(s)').join() === '/re/',
    JSON.stringify(regexes('function f() { g() }\n/re/.test(s)')),
  )

  // The documented `<`/`>` choice (limitation 1). Without this, flipping
  // `<`/`>` to permit a regex passed the whole suite, so the decision was
  // untested either way.
  check(
    'a `/` DIRECTLY after a relational `<` is division, per the documented TSX choice',
    regexes('const ok = a < /re/.source').length === 0,
    JSON.stringify(regexes('const ok = a < /re/.source')),
  )

  // The "second, independent safety net" the header leans on: a regex is
  // only lexed if it TERMINATES ON THE SAME LINE. The existing
  // "degrades to a punctuator" case never reached this code — its `/`
  // followed an identifier, so `regexAllowedAfter` already said no. This
  // one puts the `/` in a regex-ALLOWED position (after `return`) with the
  // next `/` two lines down, so only the same-line rule can reject it.
  {
    const src = 'function f() {\n  return / a\n  const t = b / c\n}'
    check(
      'a regex-allowed `/` with no closing `/` on the SAME line is not lexed as a regex',
      regexes(src).length === 0,
      JSON.stringify(regexes(src)),
    )
    check(
      'and the token stream after it stays in sync (nothing was swallowed)',
      kinds(src).includes('ident:const') && kinds(src).includes('ident:t'),
      kinds(src).join(' '),
    )
  }

  // A reserved word spelled as a PROPERTY NAME is an ordinary member
  // expression, so a following `/` is division. Before this, `obj.in / y /
  // z` lexed `/ y /` as a regex literal and desynced from there.
  for (const [expr, label] of [
    ['const x = obj.in / y / z', 'obj.in'],
    ['const x = obj.return / y / z', 'obj.return'],
    ['const x = map.delete / y / z', 'map.delete'],
    ['const x = obj?.of / y / z', 'obj?.of (optional chaining)'],
  ]) {
    check(
      `a keyword used as a property name (\`${label}\`) is followed by DIVISION, not a regex`,
      regexes(expr).length === 0,
      JSON.stringify(regexes(expr)),
    )
  }

  // The correction must not disarm the keyword rule in its real position:
  // `in` after `.` is a property, `in` as a statement keyword still allows
  // a regex.
  check(
    'the property-name correction does not disarm the keyword rule itself',
    regexes('for (const k in /re/.source) { g(k) }').join() === '/re/',
    JSON.stringify(regexes('for (const k in /re/.source) { g(k) }')),
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
      blanked.length === src.length && blanked.includes('note') && blanked.includes('/[\'"]/'),
      JSON.stringify(blanked),
    )
  }

  {
    // A template literal's `${…}` holds CODE, not literal text. Blanking it
    // along with the surrounding text hid real call sites from the guards
    // that use this view for discovery — a call nobody checked, reported as
    // clean. The literal chunks are still blanked; only the interpolated
    // expressions survive.
    const src = 'const s = `LEADINGWORD${ commands.setProperty(a, b) }TRAILINGWORD`\n'
    const blanked = blankStringsAndTemplates(src)
    check(
      'blankStringsAndTemplates preserves `${…}` interpolation CODE',
      blanked.includes('commands.setProperty') && blanked.length === src.length,
      JSON.stringify(blanked),
    )
    check(
      'blankStringsAndTemplates still blanks the template literal TEXT around it',
      !blanked.includes('LEADINGWORD') && !blanked.includes('TRAILINGWORD'),
      JSON.stringify(blanked),
    )
  }

  {
    // Nested: a string inside an interpolation is still blanked, and a
    // template inside an interpolation recurses the same way.
    const src = 'const s = `a${ f("secret") }b${ `c${ g("deep") }d` }e`\n'
    const blanked = blankStringsAndTemplates(src)
    check(
      'blanking recurses into nested interpolations, blanking their strings',
      blanked.includes('f(') &&
        blanked.includes('g(') &&
        !blanked.includes('secret') &&
        !blanked.includes('deep') &&
        blanked.length === src.length,
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

  // A multi-line initializer whose LINES END IN A BINARY OPERATOR. No ASI
  // happens after `+` — the expression is syntactically incomplete, so the
  // newline is not a statement boundary. The ASI test used to inspect only
  // the NEXT token, so it broke here and `extractConstAt` hashed
  // `const P =\n  'a' +` — a stable hash over a truncated prefix, with
  // every line after the first operator freely rewritable behind a green
  // pin. That is #3950's own failure mode inside #3950's fix.
  //
  // The pre-existing multi-line assertion (`foo(\n 1,\n 2,\n)`) cannot
  // catch this: it sits at bracket depth > 0, where this branch never runs.
  // Live shape: src/lib/__tests__/export-graph.test.ts's REPORT_PREAMBLE.
  {
    const src =
      "const P =\n  'Agaric export report\\n' +\n  '\\n' +\n  'tail\\n'\nconst after = 1\n"
    const end = findStatementEnd(src, src.indexOf("'Agaric"))
    const got = end === null ? null : src.slice(src.indexOf("'Agaric"), end)
    check(
      'findStatementEnd does not break at a newline after a trailing binary operator',
      got === "'Agaric export report\\n' +\n  '\\n' +\n  'tail\\n'",
      JSON.stringify(got),
    )
  }

  {
    // The consequence the guard cares about: two initializers differing only
    // AFTER the first trailing operator must not hash identically.
    const mk = (tail) => `const P =\n  'head' +\n  '${tail}'\nconst after = 1\n`
    const endOf = (s) => {
      const at = s.indexOf("'head'")
      const e = findStatementEnd(s, at)
      return e === null ? null : s.slice(at, e)
    }
    check(
      'two initializers differing after the trailing operator do not extract identically',
      endOf(mk('one')) !== null && endOf(mk('one')) !== endOf(mk('two-and-longer')),
      `${JSON.stringify(endOf(mk('one')))} vs ${JSON.stringify(endOf(mk('two-and-longer')))}`,
    )
  }

  {
    // Fail-closed backstop: an initializer that ENDS on a dangling operator
    // never completes, so there is no defensible end offset to report.
    const src = "const P =\n  'head' +\n"
    check(
      'an initializer ending on a dangling operator returns null (fails closed)',
      findStatementEnd(src, src.indexOf("'head'")) === null,
      JSON.stringify(findStatementEnd(src, src.indexOf("'head'"))),
    )
  }

  // A line ending in `>` is genuinely undecidable for a lexer: it is either
  // the end of a JSX element (expression COMPLETE, so the newline is a
  // statement boundary) or a dangling relational operator (expression
  // INCOMPLETE, so it is not). Treating it as incomplete over-extends a
  // JSX-valued const into the following statement; treating it as complete
  // truncates `a >\n b`, which is the fail-open this scanner exists to
  // close. Neither guess is defensible, so both refuse.
  for (const [src, label] of [
    ['const El = <div>x</div>\nconst next = 1\n', 'a JSX-valued initializer'],
    ['const x = a >\n  b\nconst next = 1\n', 'a dangling relational operator'],
  ]) {
    const at = src.indexOf('=') + 1
    check(
      `${label} ending a line in \`>\` is refused (null), not guessed`,
      findStatementEnd(src, at) === null,
      JSON.stringify(src.slice(at, findStatementEnd(src, at) ?? undefined)),
    )
  }

  check(
    'a `>` that is NOT at a line end still terminates normally',
    (() => {
      const src = 'const x = a > b\nconst next = 1\n'
      const at = src.indexOf('=') + 1
      return src.slice(at, findStatementEnd(src, at) ?? undefined).trim() === 'a > b'
    })(),
    'see source',
  )

  // The property-name correction must reach the paren and brace context
  // stacks too, not just `REGEX_PRECEDING_KEYWORDS`. `obj.with(…)` is a
  // method call, so its `)` must NOT carry `controlHead` and permit a
  // regex; `p.catch {`-shaped input must not open a BLOCK.
  // `otelContext.with(...)` is live at src/lib/observability/tracer.ts.
  for (const [expr, label] of [
    ['const x = obj.with(a, b) / y / z', 'obj.with(…)'],
    ['const x = obj.if(a) / y / z', 'obj.if(…)'],
    ['const x = obj.for(a) / y / z', 'obj.for(…)'],
    ['const x = obj.switch(a) / y / z', 'obj.switch(…)'],
  ]) {
    check(
      `a method call named like a control keyword (\`${label}\`) is followed by DIVISION`,
      regexes(expr).length === 0,
      JSON.stringify(regexes(expr)),
    )
  }

  check(
    'the paren-stack correction does not disarm the real control-head rule',
    regexes('if (x) /re/.test(s)').join() === '/re/',
    JSON.stringify(regexes('if (x) /re/.test(s)')),
  )

  // `catch` / `finally` in PROPERTY position must not classify a following
  // `{` as a BLOCK (`BLOCK_PREV_KEYWORD`), because its `}` would then permit
  // a regex. Asserted on the brace-context flag directly as well as on the
  // regex outcome — `p.catch {}` is the minimal input that reaches this
  // branch, since a property named `catch` before a `{` is the only way in.
  for (const kw of ['catch', 'finally']) {
    const src = `p.${kw} {} / y / z`
    const closeTok = [...tokenize(src)].find((t) => t.kind === 'punct' && t.value === '}')
    check(
      `a property named \`${kw}\` does not classify a following \`{\` as a block`,
      closeTok !== undefined && closeTok.blockClose === false && regexes(src).length === 0,
      `blockClose=${closeTok?.blockClose} regexes=${JSON.stringify(regexes(src))}`,
    )
  }

  check(
    'the brace-stack correction does not disarm the real `catch` block rule',
    regexes('try { g() } catch (e) {}\n/re/.test(s)').join() === '/re/',
    JSON.stringify(regexes('try { g() } catch (e) {}\n/re/.test(s)')),
  )

  {
    // A `/*` WITH NO CLOSER is not a comment. Consuming it to EOF as one was
    // the single fail-OPEN left in the scanner: `stripComments` blanked the
    // whole tail of the file, so every construct after it vanished and
    // `check-set-property-args` reported a file it had not actually checked
    // as clean.
    //
    // The fix is degradation, not a throw — the same move the regex lexer
    // already makes for a `/` that does not open a well-formed literal. A
    // throw looks more rigorous but is wrong here: `/*` occurs in bare JSX
    // TEXT in real, valid source (`<span>path:Journal/*</span>` at
    // src/components/search/FilterHelperPopover.tsx:262), and raising would
    // block every commit repo-wide on a file that is not defective.
    // Degrading emits `/` and `*` as ordinary punctuators, which keeps the
    // rest of the file lexed and checked.
    const src = 'const a = 1\n/* never closed\nconst b = 2\nconst c = 3\n'
    const stripped = stripComments(src)
    check(
      'an unterminated block comment does not blank the rest of the file',
      stripped.includes('const b = 2') && stripped.includes('const c = 3'),
      JSON.stringify(stripped),
    )
    check(
      'an unterminated block comment is lexed as punctuators, not as a comment token',
      [...tokenize(src)].every((t) => t.kind !== 'comment'),
      JSON.stringify(
        [...tokenize(src)]
          .filter((t) => t.kind === 'comment')
          .map((t) => src.slice(t.start, t.end)),
      ),
    )
  }

  {
    // The real-source shape that forced degradation over a throw.
    const src = '<span className="x">path:Journal/*</span>\nconst after = 1\n'
    let threw = null
    let stripped = null
    try {
      stripped = stripComments(src)
    } catch (err) {
      threw = err
    }
    check(
      'a glob in bare JSX text (`path:Journal/*`) neither raises nor blanks the file',
      threw === null && stripped !== null && stripped.includes('const after = 1'),
      threw ? String(threw) : JSON.stringify(stripped),
    )
  }

  check(
    'a properly terminated block comment is still blanked as a comment',
    !stripComments('const a = 1 /* note */\nconst b = 2\n').includes('note'),
    JSON.stringify(stripComments('const a = 1 /* note */\nconst b = 2\n')),
  )

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
