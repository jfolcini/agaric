#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Mutation-harness source-pin guard (#3907).
//
// ONE WAY THIS CAN BREAK A BUILD, added by #4509 and worth knowing before it
// surprises you: any line in a harness whose comment OPENS with the
// `mutation-harness-source-pin:` keyword is now required to be a well-formed
// pin. So a prose comment that merely mentions the keyword — for instance
// `// mutation-harness-source-pin: see the guard for the syntax` — is a hard
// failure rather than being ignored. That is the intended trade: such a line
// is genuinely indistinguishable from a pin with a typo in it, and treating
// it as prose is what let a malformed marker vanish in the first place. Refer
// to the marker without leading with the keyword.
//
// `scripts/mutation-harnesses/*.harness.ts` each contain hand-copied
// CLONES of a real function under test, plus hand-copied clones of the
// specific mutants they discriminate — necessary, because you cannot
// sweep a mutant without a copy of it. But nothing tied the clone to the
// original: the harnesses are deliberately out of CI (minutes-long
// sweeps, no gating value) and `scripts/` is in no tsconfig project, so
// nothing type-checks them either. Editing the real function silently
// invalidates the clones, with no signal anywhere — the harness keeps
// passing, reporting numbers about code that no longer exists. That is
// the exact rot #3804 documented for the equivalence ledgers, one layer
// down.
//
// ─── How it works ───────────────────────────────────────────────────
//
// Every `*.harness.ts` file must carry one or more SOURCE-PIN markers:
//
//   // mutation-harness-source-pin: <repo-relative-path>#<symbolName> sha256=<64-hex>
//
// `<symbolName>` names EITHER a top-level `function` declaration OR a
// top-level `const`/`let`/`var` declaration with an initializer (#3953 —
// a hand-cloned regex constant like `ATTACHMENT_REF_RE` is exactly the
// shape the function-only guard could not see). For each marker this
// guard:
//   1. Resolves `<repo-relative-path>` and reads it (missing file FAILS).
//   2. Extracts the named symbol's FULL text:
//        - function: signature through its matching closing brace;
//        - const/let/var: the declaration keyword through the end of its
//          initializer expression (statement end — an explicit `;`, a
//          top-level `,` of a multi-declarator, or the automatic-
//          semicolon boundary this semicolon-free codebase relies on).
//          The declarator prefix (`export const NAME: T =`) is inside the
//          hashed text on purpose: a rename, a `const`→`let`, or a
//          changed type annotation is drift a clone should re-verify too.
//      Both use the shared scanner in `scripts/lib/js-scanner.mjs`.
//      Ambiguous (0 or 2+ declarations of the name), unbalanced, or
//      un-scannable input FAILS — never guessed at.
//   3. Canonicalizes it (collapse all whitespace runs to a single space,
//      trim) and hashes it with sha256. Whitespace-only reformatting
//      therefore does NOT trip the gate; any token-level change
//      (including a changed comment inside the function, which in this
//      codebase's style routinely encodes the invariants a clone's
//      equivalence argument depends on) does.
//   4. Compares against the pinned hash. A mismatch FAILS, naming the
//      harness, the source location, and the fact that the clone needs
//      re-syncing and its pin needs updating.
//
// A harness file with ZERO markers FAILS — that is precisely the #3907
// gap this guard exists to close; a new harness must declare what it
// clones from day one, not leave it implicit.
//
// A marker line that IS present but MALFORMED — a placeholder hash
// (`sha256=PLACEHOLDER`), a truncated or uppercase hash, a missing
// `#symbolName`, a missing `sha256=`, or trailing garbage after an
// otherwise-valid hash — also FAILS, naming the file and line (#4509).
// Before this, a malformed marker was indistinguishable from an ordinary
// comment and was silently excluded from the pin count: a harness with
// eleven good pins and one typo'd one reported "OK: 11 source-pin(s)"
// instead of failing, and the clone the typo'd pin was meant to gate went
// unpinned with no signal anywhere — the one failure mode a drift guard
// must not have.
//
// ─── Why the scanner lives in scripts/lib/js-scanner.mjs ────────────
//
// This file used to carry its own copy of `skipString`/`stripComments`/
// `findMatchingBracket`, copy-pasted from `check-set-property-args.mjs`.
// Neither copy knew about REGEX LITERALS, which produced two symptoms
// from one cause (#3950): a regex containing a bare `}` closed the
// bracket-depth scan early — TRUNCATING the extraction, so two functions
// differing by real code after the regex hashed identically and drift
// landed with the pin still green (fail OPEN, the serious direction) —
// and a regex containing a quote was read as a string opener, desyncing
// everything after it. Both scanners now share one implementation that
// resolves division-vs-regex by previous-significant-token tracking, so
// the bug cannot be inherited a third time. See that module's header for
// the decision table, the fail-closed policy, and the stated limits.
//
// This is a fast, local, static check (no vitest, no execution of the
// harnesses' actual sweeps) — cheap enough to run on every commit that
// touches a harness or a pinned source file, unlike the sweeps
// themselves, which stay out of CI by design (#3804).
//
// Usage: node scripts/check-mutation-harness-clones.mjs
//        node scripts/check-mutation-harness-clones.mjs --self-test
// Exit:  0 = every pin matches, 1 = a pin is missing/stale/unresolvable,
//        2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ScanError,
  blankStringsAndTemplates,
  findMatchingBracket,
  findStatementEndDetailed,
  stripComments,
  tokenize,
} from './lib/js-scanner.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const HARNESS_DIR = path.join(ROOT, 'scripts', 'mutation-harnesses')

// Matches the marker either as a standalone `//` line or as a line inside a
// `/** ... */` JSDoc block (leading ` * `), so a harness's existing header
// doc comment can carry the pin without breaking out into a separate line.
//
// Split into a PREFIX and a BODY regex (#4509) rather than one all-or-
// nothing pattern. The original single regex required the hash group to be
// exactly `[0-9a-f]{64}`; a line that said `mutation-harness-source-pin:`
// but had a malformed body — a placeholder (`sha256=PLACEHOLDER`), a
// truncated or uppercase hash, a missing `#symbolName`, a missing `sha256=`
// entirely, or trailing garbage after an otherwise-valid hash — simply
// failed to match, and `findPins` (below) treated "did not match" as "not a
// pin marker at all" and silently dropped the line. A typo made while
// re-typing a hash therefore *disabled* that pin instead of failing the
// build — the guard reported a smaller, wrong "N source-pin(s)" count and
// exited 0. Recognising the marker on its PREFIX means every line that
// *intends* to be a pin (starts with the marker keyword, in a real comment)
// is found; the BODY regex then decides well-formed vs malformed, and
// `findPins` reports the malformed shape as its own kind of result instead
// of `null` (indistinguishable from "not a marker"), so `checkTree` can
// raise a violation naming the file and line rather than silently
// shrinking the pin count.
const PIN_PREFIX_RE = /^\s*(?:\/\/|\*(?!\/))\s*mutation-harness-source-pin:\s*(.*)$/
const PIN_BODY_RE = /^(\S+?)#([A-Za-z_$][A-Za-z0-9_$]*)\s+sha256=([0-9a-f]{64})\s*$/

// #4526 — `PIN_PREFIX_RE`'s prefix substring is byte-identical to the old
// (pre-#4509) `PIN_RE`'s, and both shared the same blind spot: a line that a
// human would obviously read as an ATTEMPTED marker, but that doesn't fit
// one of the two envelopes above, matched neither regex and — like a
// malformed body before #4509 — was silently dropped, indistinguishable
// from an ordinary comment. Two more envelope regexes exist purely to
// DETECT such an attempt so `findPins` can report it as its own kind of
// malformed result; neither one ever produces a well-formed pin, even when
// its body would otherwise satisfy `PIN_BODY_RE`. Accepting either as valid
// would be a second, drift-prone parsing path for the canonical marker
// syntax `PIN_BODY_RE` already defines — the issue this closes (#4526)
// explicitly chose "tell the author" over "guess what they meant" for
// exactly that reason.
//
// `PIN_PREFIX_CI_RE` is `PIN_PREFIX_RE` with the keyword matched
// case-insensitively (and captured, to report what was actually written).
// By the time `findPins` falls through to this regex, `PIN_PREFIX_RE` has
// already failed on the same line — and the two differ only in the `i` flag
// and none of `//`, `*`, `:` are letters — so a match here always means the
// keyword's letter case is what's wrong, never the envelope shape. Only the
// keyword is matched case-insensitively; the body afterward keeps requiring
// an exact-case `sha256=` and lowercase hex even when merely being used for
// the diagnostic, because loosening that too would risk this path someday
// being asked to also validate a body, and a case-INSENSITIVE hash means
// something different from the hex `sha256hex` produces.
const PIN_PREFIX_CI_RE = /^\s*(?:\/\/|\*(?!\/))\s*(mutation-harness-source-pin):\s*(.*)$/i

// A single-line `/* mutation-harness-source-pin: ... */` or
// `/** mutation-harness-source-pin: ... */` block comment — opened and
// closed on the same line, keyword matched case-insensitively since a wrong
// envelope and a wrong case are independent mistakes and this guard reports
// each attempt with ONE diagnosis, not a combinatorial pile of them. This
// envelope is never accepted as well-formed regardless of case or body —
// see the comment above.
//
// Deliberately NOT covered by this regex (or by anything else in this
// file), enumerated rather than left to be discovered by a future false
// negative: (1) a trailing `// mutation-harness-source-pin: ...` comment
// after real code on the same line (`const x = 1 // mutation-harness-...`),
// and its mirror image, a marker starting right after a `*/` that closes a
// preceding comment on the same line — both require knowing where a
// comment BEGINS mid-line, which needs the real tokenizer's division-vs-
// regex-vs-comment resolution (`scripts/lib/js-scanner.mjs`), not a line
// regex: `//` and `/*` are not reliably comment openers when something
// precedes them on the line. (2) A multi-line PLAIN `/* ... */` block (no
// leading `*` per line) with the marker on an inner line — the issue named
// "a single-line block comment" specifically, this is a different shape,
// and it is not the "existing header doc comment" JSDoc case `PIN_PREFIX_RE`
// already supports either. Both are the same class of gap this issue closes
// and could be closed the same way; they are left for a future pass rather
// than folded in here, in the same spirit #4509's own text used to defer
// this issue's scope in the first place — not "impossible", just "a bigger
// change than this one line regex covers, and not what was reported."
const PIN_BLOCK_LINE_RE = /^\s*\/\*\*?\s*(mutation-harness-source-pin):\s*(.*?)\s*\*\/\s*$/i

/** Escape a string for safe interpolation into a `RegExp` source. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True for the whitespace characters `stripped` can contain. */
function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
}

/** Collapse whitespace runs to a single space and trim — reformatting-tolerant, token-sensitive. */
function canonicalize(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

// ─── extraction ─────────────────────────────────────────────────────

/**
 * Build the two views every extraction works from:
 *   - `stripped`: comments blanked (equal-length whitespace, newlines
 *     preserved), strings/templates/regexes intact. Bracket matching and
 *     statement-end scanning run here.
 *   - `search`: `stripped` with string/template CONTENTS blanked too. The
 *     declaration-finding regexes run here, so a `function foo(` or
 *     `const FOO =` living inside a template literal (documentation, a
 *     code sample) is not counted as a declaration.
 * Both preserve length and newline positions, so an offset found in
 * either is a valid offset into the original `src`.
 */
function views(src) {
  const stripped = stripComments(src)
  return { stripped, search: blankStringsAndTemplates(stripped) }
}

/**
 * Extract the full text (signature through matching closing brace) of a
 * `function` declaration whose signature match `m` was found in `search`.
 *
 * The body's opening brace is the first `{` found after the parameter
 * list's closing `)` at ANGLE-BRACKET depth 0. This matters because a
 * return-type annotation can itself contain a brace before the real body
 * starts — `scanLiteralFolded` is pinned with exactly this shape,
 * `): Array<{ start: number; end: number }> {`. Without tracking angle
 * depth, the first `{` seen is the one inside `Array<{ ... }>`, and its
 * matching `}` closes on the same line — the extracted (and hashed) text
 * would be signature-only, with the entire real body outside the hash and
 * every mutation to it invisible to this guard. A `{` seen while
 * angle-depth is 0 opens the body; a `{` seen while angle-depth > 0 opens
 * a type-literal nested inside a generic argument, so it is skipped over
 * via its own matching brace instead of ending the scan.
 *
 * The remaining shape angle-depth cannot disambiguate is a return-type
 * object-type literal with NO enclosing angle brackets (`): { a: string }
 * {`): angle-depth never leaves 0 for either brace, so the first one — the
 * type literal, not the body — was taken as the body open. That was a
 * FAIL-OPEN: the signature-only text hashed stably, and a pin generated
 * from it stayed green through arbitrary body drift, which is the exact
 * failure mode this guard exists to refuse (#3971).
 *
 * It is now DETECTED rather than documented. If the first significant
 * character after the parameter list's `)` is a `:` and the next one is a
 * `{`, the annotation itself begins with an object-type literal and this
 * extractor cannot tell that brace from the body's without a real type
 * grammar (a union like `): { a } | { b } {` would defeat any
 * skip-one-literal heuristic). So it returns `ambiguous-return-type` and
 * the pin FAILS, rather than hashing a prefix. A comment plus a hand audit
 * repeated for every new pin is not a gate; this is.
 */
function extractFunctionAt(src, stripped, m) {
  // Start of the actual declaration (skip the leading \n / whitespace the
  // regex consumed so the extracted text starts at `export`/`function`).
  const declStart = m.index + m[0].indexOf(m[0].trimStart())
  const openParenIdx = m.index + m[0].length - 1
  const closeParenIdx = findMatchingBracket(stripped, openParenIdx)
  if (closeParenIdx === -1) return { text: null, reason: 'unbalanced' }

  // Is there a return-type annotation at all? Comments are already blanked
  // to spaces in `stripped`, so skipping whitespace skips them too.
  let hasAnnotation = false
  {
    let k = closeParenIdx + 1
    while (k < stripped.length && isSpace(stripped[k])) k++
    hasAnnotation = stripped[k] === ':'
  }

  let i = closeParenIdx + 1
  let angleDepth = 0
  // Paren depth as well as angle depth: a function-TYPE parameter list in
  // the annotation (`): (x: { a: string }) => void {`) puts an object-type
  // literal at angle depth 0, and without this it was taken as the body
  // open — the same signature-only truncation as the union case, found by
  // auditing return-type shapes rather than reported.
  let parenDepth = 0
  let bodyOpen = -1
  while (i < stripped.length) {
    const c = stripped[i]
    if (c === '<') {
      angleDepth++
      i++
      continue
    }
    if (c === '>') {
      if (angleDepth > 0) angleDepth--
      i++
      continue
    }
    if (c === '(') {
      parenDepth++
      i++
      continue
    }
    if (c === ')') {
      if (parenDepth > 0) parenDepth--
      i++
      continue
    }
    if (c === '{') {
      if (angleDepth === 0 && parenDepth === 0) {
        bodyOpen = i
        break
      }
      const nestedClose = findMatchingBracket(stripped, i)
      if (nestedClose === -1) return { text: null, reason: 'unbalanced' }
      i = nestedClose + 1
      continue
    }
    i++
  }
  if (bodyOpen === -1) return { text: null, reason: 'unbalanced' }
  const bodyClose = findMatchingBracket(stripped, bodyOpen)
  if (bodyClose === -1) return { text: null, reason: 'unbalanced' }

  // Was the brace we just took as the body actually an OBJECT-TYPE LITERAL
  // inside the annotation? Testing only whether the annotation STARTS with
  // `{` caught `): { a } {` but not `): Foo | { a } {` — the very union the
  // docstring named as the defeating shape — where the probe saw `F`,
  // declined, and the loop then took the literal's brace as the body,
  // yielding signature-only text that stays green through arbitrary body
  // drift. Position-independent test instead: if what follows the candidate
  // brace's matching `}` continues a TYPE rather than ending the
  // declaration, the candidate was a type literal and the real body is
  // further right. Distinguishing them needs a type grammar, so refuse.
  if (hasAnnotation) {
    let k = bodyClose + 1
    while (k < stripped.length && isSpace(stripped[k])) k++
    const next = stripped[k]
    if (next === '{' || next === '|' || next === '&' || next === '[') {
      return { text: null, reason: 'ambiguous-return-type' }
    }
  }

  return { text: src.slice(declStart, bodyClose + 1), reason: null }
}

/**
 * Extract a `const`/`let`/`var` declaration whose match `m` was found in
 * `search` (#3953). Returns the text from the declaration keyword (or
 * `export`) through the end of the initializer expression.
 *
 * Finding the `=` is a scan, not a regex, because a type annotation can
 * contain almost anything — `const X: Map<string, number> = …`, where a
 * naive `[^=]*` stops at the wrong place and a naive comma-split stops
 * inside the generic. Angle depth is tracked for exactly that reason.
 * Terminating the initializer is `findStatementEnd`, which understands
 * the ASI boundary this semicolon-free codebase depends on.
 */
function extractConstAt(src, stripped, m) {
  const declStart = m.index + m[0].indexOf(m[0].trimStart())
  const nameEnd = m.index + m[0].length

  let depth = 0
  let angleDepth = 0
  let initStart = -1
  for (const tok of tokenize(stripped, { from: nameEnd })) {
    // A newline between the declarator name and any `=`, at top level,
    // ends the declaration (ASI): `let LATER: number` followed by a
    // separate `LATER = 1` assignment statement is NOT an initializer.
    // Newlines INSIDE a bracketed or generic type annotation are not
    // top-level, which is why both depths are tracked.
    if (tok.kind === 'ws' || tok.kind === 'comment') {
      if (depth === 0 && angleDepth === 0 && stripped.slice(tok.start, tok.end).includes('\n')) {
        break
      }
      continue
    }
    if (tok.kind !== 'punct') continue
    const v = tok.value
    if (v === '(' || v === '[' || v === '{') depth++
    else if (v === ')' || v === ']' || v === '}') depth--
    else if (v === '<') angleDepth++
    else if (v === '>') {
      if (angleDepth > 0) angleDepth--
    } else if (depth === 0 && angleDepth === 0) {
      if (v === '=') {
        initStart = tok.end
        break
      }
      // A `;`, a `,` (next declarator) or anything else at top level
      // before an `=` means this declarator has no initializer.
      if (v === ';' || v === ',') break
    }
  }
  if (initStart === -1) return { text: null, reason: 'no-initializer' }

  // The scanner reports WHY it refused. Mapping every `null` to
  // `unbalanced` presented its DELIBERATE fail-closed rules as bracket
  // errors, naming neither the cause nor the remedy its header spells out.
  const { end, reason } = findStatementEndDetailed(stripped, initStart)
  if (end === null) return { text: null, reason }
  return { text: src.slice(declStart, end), reason: null }
}

/**
 * Extract the pinned symbol's full text from `src`. Returns
 * `{ text, kind, matchCount, otherForm, reason }`:
 *   - `text` is `null` unless EXACTLY ONE top-level declaration of `name`
 *     was found (0 = not found, 2+ = ambiguous — both are refused rather
 *     than guessed at) and its extraction balanced.
 *   - `kind` is `'function'` or `'const'` for a successful extraction.
 *   - `reason` names why `text` is null: `not-found`, `ambiguous`,
 *     `unbalanced`, `no-initializer`, or `unscannable`.
 *
 * `unscannable` is the fail-closed path: the shared scanner raises
 * `ScanError` when it cannot decide what a construct is, and this guard
 * turns that into a violation rather than into a silent pass.
 */
function extractPinned(src, name) {
  let stripped
  let search
  try {
    ;({ stripped, search } = views(src))
  } catch (err) {
    if (err instanceof ScanError) {
      return { text: null, kind: null, matchCount: 0, otherForm: false, reason: 'unscannable', err }
    }
    throw err
  }

  // Anchored at COLUMN 0, not `(?:^|\n)\s*`. `\s` matches indentation (and
  // further newlines), so the old form matched a declaration nested inside a
  // function body just as readily as a module-level one — despite this
  // file's header and this function's docstring both saying "top-level".
  // A name present at both levels tripped `matchCount === 2` and failed
  // closed, but a name present ONLY as a function-local `const` was
  // extracted and hashed as though it were the symbol the pin names.
  // Top-level declarations in this codebase start at column 0, so requiring
  // that is exact; an indented declaration now reads as not-found, which is
  // the fail-closed direction.
  const escaped = escapeRegExp(name)
  const fnRe = new RegExp(
    `(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`,
    'g',
  )
  const constRe = new RegExp(
    `(?:^|\\n)(?:export\\s+)?(?:const|let|var)\\s+${escaped}(?![A-Za-z0-9_$])`,
    'g',
  )
  const fnMatches = [...search.matchAll(fnRe)]
  const constMatches = [...search.matchAll(constRe)]
  const matchCount = fnMatches.length + constMatches.length

  if (matchCount !== 1) {
    return {
      text: null,
      kind: null,
      matchCount,
      otherForm: matchCount === 0 && nameAppearsInOtherForm(search, name),
      reason: matchCount === 0 ? 'not-found' : 'ambiguous',
    }
  }

  try {
    const isFn = fnMatches.length === 1
    const r = isFn
      ? extractFunctionAt(src, stripped, fnMatches[0])
      : extractConstAt(src, stripped, constMatches[0])
    return {
      text: r.text,
      kind: r.text === null ? null : isFn ? 'function' : 'const',
      matchCount,
      otherForm: false,
      reason: r.reason,
    }
  } catch (err) {
    if (err instanceof ScanError) {
      return { text: null, kind: null, matchCount, otherForm: false, reason: 'unscannable', err }
    }
    throw err
  }
}

/**
 * When `extractPinned` finds zero declarations of `name`, check whether
 * `name` nonetheless appears in some OTHER form this guard doesn't
 * extract — a generic signature (`function name<T>(`), a default export
 * (`export default function name(`), or a class declaration. Used only to
 * pick a more accurate message; doesn't change pass/fail (still fails
 * closed either way).
 */
function nameAppearsInOtherForm(search, name) {
  const escaped = escapeRegExp(name)
  const otherFormRe = new RegExp(
    `function\\s+${escaped}\\s*<` +
      `|export\\s+default\\s+function\\s+${escaped}\\s*\\(` +
      `|\\bclass\\s+${escaped}\\b`,
  )
  return otherFormRe.test(search)
}

// ─── pin discovery ──────────────────────────────────────────────────

/**
 * Find every marker LINE in `harnessSrc` — well-formed pins, malformed
 * bodies (#4509), and, now, attempted markers in an envelope or keyword
 * case this guard doesn't accept (#4526). Returns one entry per line
 * matching `PIN_PREFIX_RE`, `PIN_BLOCK_LINE_RE`, or `PIN_PREFIX_CI_RE`:
 *   - well-formed: `{ lineNo, malformed: false, sourcePath, symbolName,
 *     expectedHash }`
 *   - malformed body (#4509): `{ lineNo, malformed: true, reason: 'body',
 *     raw }`, where `raw` is the text after `mutation-harness-source-pin:`
 *     verbatim — the body didn't match `PIN_BODY_RE`, so there is no
 *     path/symbol/hash to trust.
 *   - malformed envelope, a single-line block comment (#4526):
 *     `{ lineNo, malformed: true, reason: 'block-comment', raw }`, `raw`
 *     being the text between the keyword and the block comment's closer.
 *   - malformed keyword case (#4526): `{ lineNo, malformed: true,
 *     reason: 'wrong-case', raw, foundKeyword }`, `foundKeyword` the
 *     verbatim (wrongly-cased) keyword text and `raw` the rest of the line.
 * All three malformed shapes are reported, never silently dropped and
 * never promoted to well-formed — a body that would otherwise satisfy
 * `PIN_BODY_RE` is not parsed out of an envelope/case-malformed line, so
 * there is exactly one path that produces a trusted `sourcePath`/
 * `symbolName`/`expectedHash` triple.
 * A line matching NONE of the three regexes is not an attempted marker at
 * all (ordinary prose, possibly mentioning the keyword later in the line
 * rather than opening with it) and is omitted, same as before.
 */
function findPins(harnessSrc) {
  // String/template contents are blanked (comments kept) so a pin-shaped
  // line living inside a template literal or string — data, not a real
  // marker — is not mistaken for a real pin, while a genuine pin inside a
  // `//` or JSDoc-block comment is left untouched.
  const blanked = blankStringsAndTemplates(harnessSrc)
  return blanked
    .split('\n')
    .map((line, idx) => ({ line, lineNo: idx + 1 }))
    .map(({ line, lineNo }) => {
      const prefixMatch = line.match(PIN_PREFIX_RE)
      if (prefixMatch) {
        const rest = prefixMatch[1]
        const bodyMatch = rest.match(PIN_BODY_RE)
        if (!bodyMatch) return { lineNo, malformed: true, reason: 'body', raw: rest.trim() }
        return {
          lineNo,
          malformed: false,
          sourcePath: bodyMatch[1],
          symbolName: bodyMatch[2],
          expectedHash: bodyMatch[3],
        }
      }

      // #4526 — `PIN_PREFIX_RE` already failed on this line (checked
      // above), so a match here is one of the two envelope/case gaps that
      // regex cannot see: a single-line block comment, or a keyword whose
      // letter case doesn't match exactly. Checked in this order only
      // because the two are mutually exclusive by their opening token
      // (`/*` vs `//`/`*`) — a line can't match both.
      const blockMatch = line.match(PIN_BLOCK_LINE_RE)
      if (blockMatch) {
        return { lineNo, malformed: true, reason: 'block-comment', raw: blockMatch[2].trim() }
      }
      const ciMatch = line.match(PIN_PREFIX_CI_RE)
      if (ciMatch) {
        return {
          lineNo,
          malformed: true,
          reason: 'wrong-case',
          foundKeyword: ciMatch[1],
          raw: ciMatch[2].trim(),
        }
      }

      return null
    })
    .filter((x) => x !== null)
}

/**
 * Thrown by `checkTree` when the repo layout itself is wrong (the harness
 * directory is missing) rather than a pin being missing or stale. Kept
 * distinct from a `violations` entry so `runGuard` can exit 2, matching
 * this file's own documented exit code for "repo layout ... failure" —
 * an empty `{ violations: [] }` would otherwise print `OK: 0 ... 0 ...`
 * and exit 0, silently disarming the whole gate if `scripts/
 * mutation-harnesses/` is ever moved or renamed.
 */
class LayoutError extends Error {}

/**
 * Check every harness file under `harnessDir` against `root`. Returns
 * `{ violations, harnessCount, pinCount }`. `violations` is
 * `[{ harness, message }]`, one per problem found (a harness may
 * contribute more than one, or contribute a single "no pins" violation).
 * Pure over the filesystem so the self-test can point it at a synthetic
 * tree. Throws `LayoutError` if `harnessDir` itself doesn't exist.
 */
function checkTree({ root, harnessDir }) {
  const violations = []
  let harnessCount = 0
  let pinCount = 0

  if (!fs.existsSync(harnessDir)) {
    throw new LayoutError(
      `harness directory not found: ${path.relative(root, harnessDir) || harnessDir} — has ` +
        'scripts/mutation-harnesses/ been moved or renamed? (an empty tree here would otherwise ' +
        'report "OK: 0 pins across 0 harness files" and exit 0, silently disarming this whole gate)',
    )
  }

  // realpath the root once, for the symlink-escape check below (a pinned
  // source path can be lexically inside the repo yet resolve, through a
  // symlink, to somewhere outside it).
  const realRoot = fs.realpathSync(root)

  // { recursive: true } (Node >=20) so a harness placed in a subdirectory
  // of scripts/mutation-harnesses/ is still discovered and required to
  // carry a pin, instead of silently never being checked.
  const files = fs
    .readdirSync(harnessDir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.harness.ts'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .toSorted()

  for (const harnessFile of files) {
    harnessCount += 1
    const relHarness = path.relative(root, harnessFile).split(path.sep).join('/')
    const harnessSrc = fs.readFileSync(harnessFile, 'utf8')
    let pins
    try {
      pins = findPins(harnessSrc)
    } catch (err) {
      if (!(err instanceof ScanError)) throw err
      violations.push({
        harness: relHarness,
        message:
          `${relHarness} could not be scanned for pin markers (${err.message}) — refusing to ` +
          'report it as pinned. Fix the construct the scanner names, or extend ' +
          'scripts/lib/js-scanner.mjs.',
      })
      continue
    }

    if (pins.length === 0) {
      violations.push({
        harness: relHarness,
        message:
          'no mutation-harness-source-pin marker found — this clone has no gate against drift',
      })
      continue
    }

    for (const pin of pins) {
      // #4509 — a line that opens with the marker keyword but whose body
      // doesn't parse (a placeholder hash, a truncated/uppercase hash, a
      // missing `#symbolName`, a missing `sha256=`, or trailing garbage
      // after an otherwise-valid hash) is reported as a violation, named by
      // file and line, rather than silently excluded from `pinCount` the
      // way "not a marker at all" is. #4526 adds two more `malformed`
      // reasons — a single-line block-comment envelope, and a wrong-case
      // keyword — that are reported the same way, for the same reason: an
      // attempted marker this guard doesn't recognise used to be
      // indistinguishable from "not a marker at all". None of the three
      // are counted into `pinCount`: none were ever verified against
      // anything, and the `OK: N source-pin(s) ...` line below only ever
      // prints once `violations` is empty — i.e. once every malformed
      // marker here has been fixed or removed — so `pinCount` never
      // advertises a malformed line as a verified pin.
      if (pin.malformed) {
        let message
        if (pin.reason === 'block-comment') {
          // #4526 — the envelope itself is the defect here, independent of
          // whether `pin.raw` would otherwise satisfy `PIN_BODY_RE`; the
          // message never claims the body is wrong, only that this shape
          // is not one of the two this guard reads.
          message =
            `${relHarness}:${pin.lineNo} has a mutation-harness-source-pin marker written in a ` +
            `single-line block comment (found "${pin.raw}" inside it). This envelope is never ` +
            'accepted as a pin, well-formed body or not — the only recognised forms are a `// ' +
            'mutation-harness-source-pin: ...` line comment, or a `*` continuation line inside a ' +
            'multi-line `/** ... */` JSDoc block. A marker in an unsupported envelope used to be ' +
            'silently invisible — indistinguishable from an ordinary comment — so the clone it was ' +
            'meant to gate went unpinned with no signal anywhere; it now fails instead. Rewrite the ' +
            'marker in a supported envelope rather than removing it.'
        } else if (pin.reason === 'wrong-case') {
          // #4526 — likewise, the keyword's case is the defect, independent
          // of whether the rest of the line would otherwise parse.
          message =
            `${relHarness}:${pin.lineNo} has a mutation-harness-source-pin marker whose keyword is ` +
            `not exactly lowercase (found "${pin.foundKeyword}:", followed by "${pin.raw}"). This ` +
            'guard matches the keyword case-sensitively, so a differently-cased keyword used to be ' +
            'silently invisible — indistinguishable from an ordinary comment — so the clone it was ' +
            'meant to gate went unpinned with no signal anywhere; it now fails instead. Fix the ' +
            'keyword\'s case to exactly "mutation-harness-source-pin:" rather than removing the line.'
        } else {
          // #4509 review — a shape-correct hash with something after it
          // (most often a JSDoc `*/` closed on the same line) is the one
          // malformed case where a reader will study the HASH and not the
          // line ending, because the hash is the part that looks like it
          // could be wrong. Name it when we can see it; the generic
          // message keeps the rest.
          const trailing = /sha256=[0-9a-f]{64}(?<rest>.+)$/.exec(pin.raw)?.groups?.rest?.trim()
          const trailingHint = trailing
            ? ` The hash itself is well-formed; what breaks it is the trailing "${trailing}" — a marker must end at the hash.`
            : ''
          message =
            `${relHarness}:${pin.lineNo} has a mutation-harness-source-pin marker that does not ` +
            `match the required shape "<repo-relative-path>#<symbolName> sha256=<64 lowercase hex ` +
            `chars>" (got "${pin.raw}"). A malformed marker used to be silently dropped — indistinguishable ` +
            'from an ordinary comment — so the clone it was meant to gate went unpinned with no ' +
            `signal anywhere; it now fails instead. Fix the marker (or generate a correct pin) rather than removing it.${trailingHint}`
        }
        violations.push({ harness: relHarness, message })
        continue
      }
      pinCount += 1
      const sourceFile = path.join(root, pin.sourcePath)
      const relToRoot = path.relative(root, sourceFile)
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        violations.push({
          harness: relHarness,
          message: `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.symbolName}, which resolves outside the repo root — refusing to read it`,
        })
        continue
      }
      // #3970 — name the path that was actually RESOLVED, not the text the
      // pin author wrote. `path.join(root, '/etc/passwd')` is
      // `<root>/etc/passwd`: the leading `/` is neutralised, which is the
      // correct security behaviour and is why the absolute path is never
      // opened. But a diagnostic reading "but /etc/passwd does not exist"
      // names a path this guard never looked at — the reader confirms
      // `/etc/passwd` is right there and concludes the guard is broken.
      // Only the file-on-disk messages below use this; the pin's own
      // identity is still reported verbatim so the marker can be found.
      const resolvedRel = relToRoot.split(path.sep).join('/')
      const resolvedNote =
        resolvedRel === pin.sourcePath
          ? pin.sourcePath
          : `${resolvedRel} (the pin text "${pin.sourcePath}" is joined to the repo root, which ` +
            `neutralises a leading "/" or "./" — ${resolvedRel} is the path this guard resolved and checked)`
      // Existence, file-ness, symlink containment and the read all happen
      // against ONE open descriptor rather than four lookups of the same
      // path. Checking a path and then reading it is a TOCTOU race
      // (`js/file-system-race`): between the checks and the read the name
      // can be repointed, so the thing validated and the thing read are not
      // guaranteed to be the same inode. Opening first and validating the
      // descriptor closes that — `fstat` and the read cannot disagree about
      // which file they mean.
      //
      // `realpathSync` still takes a path, but it runs while we hold the fd,
      // and its answer is only used to reject; a repoint between open and
      // realpath can make us refuse a legitimate file, never accept an
      // illegitimate one. Failing closed under a race is the correct
      // direction for a guard.
      let fd
      try {
        fd = fs.openSync(sourceFile, 'r')
      } catch (err) {
        violations.push({
          harness: relHarness,
          message:
            err.code === 'ENOENT'
              ? `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.symbolName}, but ${resolvedNote} does not exist`
              : `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.symbolName}, but ${resolvedNote} could not be opened (${err.code ?? err.message})`,
        })
        continue
      }
      let sourceSrc
      try {
        // `existsSync` would have been true for a directory too, and reading
        // one throws an uncaught EISDIR instead of the intended violation.
        if (!fs.fstatSync(fd).isFile()) {
          violations.push({
            harness: relHarness,
            message: `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.symbolName}, but ${resolvedNote} is a directory, not a file`,
          })
          continue
        }
        // The lexical containment check above (`path.relative` on the
        // unresolved path) catches a `../`-escaping pin path, but not a
        // symlink that sits inside the repo and points outside it.
        const realSourceFile = fs.realpathSync(sourceFile)
        const relRealToRoot = path.relative(realRoot, realSourceFile)
        if (relRealToRoot.startsWith('..') || path.isAbsolute(relRealToRoot)) {
          violations.push({
            harness: relHarness,
            message: `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.symbolName}, which is a symlink resolving outside the repo root — refusing to read it`,
          })
          continue
        }
        sourceSrc = fs.readFileSync(fd, 'utf8')
      } finally {
        fs.closeSync(fd)
      }
      const { text, matchCount, otherForm, reason, err } = extractPinned(sourceSrc, pin.symbolName)
      if (text === null) {
        const where = `${relHarness}:${pin.lineNo} pins ${pin.sourcePath}#${pin.symbolName}`
        let message
        if (reason === 'unscannable') {
          message =
            `${where}, but ${pin.sourcePath} could not be scanned unambiguously (${err.message}) — ` +
            'refusing to report a hash for input this scanner cannot decide. Fix the construct ' +
            'it names, or extend scripts/lib/js-scanner.mjs.'
        } else if (reason === 'not-found' && otherForm) {
          message =
            `${where} — the name is present in that file, but not as a plain ` +
            `\`function ${pin.symbolName}(...)\` declaration or a \`const/let/var ${pin.symbolName} = ...\` ` +
            'initializer (a generic signature, `export default function`, or a class declaration ' +
            "would all look like this). If that's what happened, either revert the refactor or " +
            'extend the guard — don\'t read this as "renamed or removed."'
        } else if (reason === 'not-found') {
          message = `${where}, but no such function or const exists there anymore (renamed or removed — the clone is orphaned)`
        } else if (reason === 'no-initializer') {
          message = `${where}, which is declared without an initializer — there is no expression to hash`
        } else if (reason === 'ambiguous-angle-line-end') {
          message =
            `${where}, whose initializer has a line ending in \`>\`. That is either a closing ` +
            'JSX element (expression complete) or a dangling relational operator (expression ' +
            'incomplete), and no lexer can tell them apart — guessing one way over-extends into ' +
            'the next statement, the other hashes a truncated prefix. The scanner refuses ' +
            'instead. Reformat the initializer so no line ends in `>`, or pin a different symbol.'
        } else if (reason === 'dangling-operator') {
          message =
            `${where}, whose initializer ends dangling on an operator, so there is no defensible ` +
            'end offset to hash. This usually means the declaration is genuinely incomplete.'
        } else if (reason === 'ambiguous-return-type') {
          message =
            `${where}, whose return-type annotation begins with an object-type literal ` +
            "(`): { … } {`). This extractor cannot tell that brace from the body's opening " +
            'brace without a real type grammar, and guessing would hash a signature-only ' +
            'prefix that stays green through arbitrary body drift (#3971) — so it refuses. ' +
            'Wrap the return type (`): Readonly<{ … }> {`), name it (`): Shape {`), or pin a ' +
            'different symbol.'
        } else {
          message = `${where}, which is ambiguous (${matchCount} declarations) or has unbalanced brackets`
        }
        violations.push({ harness: relHarness, message })
        continue
      }
      const actualHash = sha256hex(canonicalize(text))
      if (actualHash !== pin.expectedHash) {
        violations.push({
          harness: relHarness,
          message:
            `${relHarness}:${pin.lineNo} — ${pin.sourcePath}#${pin.symbolName} has changed since ` +
            `this harness's clone was last verified (expected sha256=${pin.expectedHash}, ` +
            `got sha256=${actualHash}). Re-sync the hand-copied clone in the harness against the ` +
            `current source, then update the pin.`,
        })
      }
    }
  }

  return { violations, harnessCount, pinCount }
}

// ─── main ───────────────────────────────────────────────────────────

// Only run as a CLI when this file IS the entry point. Imported (by the
// falsification harness in the self-test, or by an ad-hoc script), it is
// a library and must not exit the process.
// Guarded — see the same note in scripts/lib/js-scanner.mjs: this runs at
// module evaluation, so an unresolvable `process.argv[1]` would throw before
// any export exists and break every importer.
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
  if (process.argv.includes('--self-test')) {
    runSelfTest()
  } else {
    runGuard()
  }
}

export { canonicalize, checkTree, extractPinned, sha256hex }

function runGuard() {
  let result
  try {
    result = checkTree({ root: ROOT, harnessDir: HARNESS_DIR })
  } catch (err) {
    if (err instanceof LayoutError) {
      console.error(`ERROR: ${err.message}`)
      process.exit(2)
    }
    throw err
  }
  const { violations, harnessCount, pinCount } = result

  if (violations.length > 0) {
    console.error(
      'ERROR: mutation-harness clone(s) have drifted from (or lack a pin to) their source:',
    )
    console.error('')
    for (const v of violations) {
      console.error(`  ${v.message}`)
    }
    console.error('')
    console.error(
      'Each scripts/mutation-harnesses/*.harness.ts hand-clones the function it sweeps; a ' +
        '`// mutation-harness-source-pin: <path>#<fn> sha256=<hex>` marker ties that clone to the ' +
        "source it was copied from. See the guard's own header comment (scripts/check-mutation-harness-clones.mjs).",
    )
    process.exit(1)
  }

  console.log(
    `OK: ${pinCount} source-pin(s) across ${harnessCount} harness file(s) all match their source`,
  )
}

// ─── self-test ──────────────────────────────────────────────────────
//
// Drives extractPinned()/checkTree() against synthetic fixtures in a
// temp dir so the guard's own exit behavior is verified: a matching pin
// PASSES, a source edit inside the pinned function FAILS, restoring it
// PASSES again, whitespace-only reformatting inside the function PASSES
// (canonicalization), an edit OUTSIDE the pinned function (a sibling
// function, or a comment before/after) does NOT trip the guard (proves
// the extraction boundary is scoped to the named function, not the
// whole file), a harness with no pin at all FAILS, a pin naming a
// missing source file FAILS, a pin naming a function that no longer
// exists in the source FAILS — plus, for #3950/#3953, that a regex
// literal containing a brace no longer truncates the extraction and that
// a `const` initializer can be pinned and gates on a real edit — plus,
// for #4509, that several shapes of MALFORMED marker (placeholder hash,
// truncated/overlong/uppercase hash, missing `#symbol`, missing
// `sha256=`, trailing garbage) are reported as violations rather than
// silently dropped from the pin count, while a well-formed marker of the
// same shape still parses and passes (both arms).
function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  // ── extractPinned() boundary cases ─────────────────────────────────

  const src1 = `
export function before() {
  return 1
}

export function target(a: number, b: string): number {
  const x = a + 1
  return x
}

export function after() {
  return 2
}
`
  const ext1 = extractPinned(src1, 'target')
  if (
    ext1.text &&
    ext1.kind === 'function' &&
    ext1.text.includes('const x = a + 1') &&
    !ext1.text.includes('before')
  ) {
    ok('extracts exactly the named function, not neighbors')
  } else {
    fail('extracts exactly the named function, not neighbors', JSON.stringify(ext1))
  }

  const extMissing = extractPinned(src1, 'nonexistent')
  if (extMissing.text === null && extMissing.reason === 'not-found') {
    ok('missing symbol name yields reason not-found')
  } else {
    fail('missing symbol name yields reason not-found', JSON.stringify(extMissing))
  }

  const srcDup = `export function dup() { return 1 }\nexport function dup() { return 2 }\n`
  const extDup = extractPinned(srcDup, 'dup')
  if (extDup.text === null && extDup.matchCount === 2 && extDup.reason === 'ambiguous') {
    ok('ambiguous (2+) symbol name is refused, not guessed')
  } else {
    fail('ambiguous (2+) symbol name is refused, not guessed', JSON.stringify(extDup))
  }

  // A name declared BOTH as a function and as a const is ambiguous too —
  // the guard must not silently prefer one reading.
  const srcBothForms = `export const both = 1\nexport function both() { return 2 }\n`
  const extBoth = extractPinned(srcBothForms, 'both')
  if (extBoth.text === null && extBoth.matchCount === 2 && extBoth.reason === 'ambiguous') {
    ok('a name declared as BOTH a function and a const is refused as ambiguous')
  } else {
    fail(
      'a name declared as BOTH a function and a const is refused as ambiguous',
      JSON.stringify(extBoth),
    )
  }

  // Regression: a comment containing a backslash immediately before a
  // backtick (this guard's real-world trigger — inline-property-parse.ts's
  // `stripPropertyLines` has exactly this in a doc comment) must not be
  // misread as an escaped-backtick opening an unterminated template
  // literal, which would desync bracket-depth tracking for the rest of the
  // function and either mis-extract or fail to find the real closing brace.
  const srcCommentBacktick = `
export function withTrickyComment(a: number): number {
  // a marker like (\`literal\\\` + more text) should not confuse the scanner
  const x = a + 1
  return x
}
`
  const extTricky = extractPinned(srcCommentBacktick, 'withTrickyComment')
  if (
    extTricky.text &&
    extTricky.text.trim().endsWith('}') &&
    extTricky.text.includes('return x')
  ) {
    ok('a backslash-before-backtick inside a comment does not desync extraction')
  } else {
    fail(
      'a backslash-before-backtick inside a comment does not desync extraction',
      JSON.stringify(extTricky),
    )
  }

  // Regression (the #3951 review blocker): an object-type literal nested
  // inside a generic return-type annotation — `): Array<{ a: number }> {`,
  // exactly `scanLiteralFolded`'s real shape — must not be mistaken for
  // the body. Before the angle-bracket-depth fix, the first `{` seen (the
  // one inside `Array<{ ... }>`) was taken as the body open and its
  // same-line matching `}` as the body close, so the extracted text was
  // signature-only and every real statement in the body (the `push` call
  // below) fell outside it, silently.
  const srcGenericReturn = `
export function scanExample(
  text: string,
  flag: boolean,
): Array<{ a: number }> {
  const out: Array<{ a: number }> = []
  if (flag) {
    out.push({ a: text.length })
  }
  return out
}
`
  const extGeneric = extractPinned(srcGenericReturn, 'scanExample')
  if (
    extGeneric.text &&
    extGeneric.text.includes('out.push({ a: text.length })') &&
    extGeneric.text.trim().endsWith('\n}')
  ) {
    ok(
      'an object-type literal inside a generic return type (`Array<{ a: number }>`) does not truncate extraction to the signature',
    )
  } else {
    fail(
      'an object-type literal inside a generic return type (`Array<{ a: number }>`) does not truncate extraction to the signature',
      JSON.stringify(extGeneric),
    )
  }

  // The LAST documented fail-open in this extractor (#3971): a return-type
  // annotation that is a bare object-type literal, `): { a: string } {`.
  // Angle-depth tracking does not disambiguate it — neither brace is inside
  // `< >` — so the type literal was taken as the body and its same-line `}`
  // as the body close. The extracted text was signature-only, hashed
  // stably, and stayed green through ARBITRARY body drift: the exact
  // failure mode this whole guard is organised around refusing. A comment
  // plus a hand audit repeated per new pin is not a gate, so the shape is
  // now DETECTED and refused rather than documented.
  const objReturnA = `export function shape(n: number): { a: string } {\n  return { a: String(n) }\n}\n`
  const objReturnB = `export function shape(n: number): { a: string } {\n  return { a: 'totally different body' }\n}\n`
  const extObjA = extractPinned(objReturnA, 'shape')
  const extObjB = extractPinned(objReturnB, 'shape')
  if (
    extObjA.text === null &&
    extObjA.reason === 'ambiguous-return-type' &&
    extObjB.text === null
  ) {
    ok(
      'a bare object-type return annotation (`): { a: string } {`) FAILS CLOSED, not signature-only',
    )
  } else {
    fail(
      'a bare object-type return annotation (`): { a: string } {`) FAILS CLOSED, not signature-only',
      JSON.stringify({ a: extObjA, b: extObjB }),
    )
  }

  // The other arrangement of the same tokens: the object-type literal is
  // the SECOND arm of the union, so a probe that only inspects the first
  // character of the annotation sees `F`, declines to refuse, and the
  // angle-depth loop then takes the literal's brace as the body open —
  // signature-only text, stable hash, green through arbitrary body drift.
  // The docstring named this exact shape as the defeating one while the
  // implementation covered only the half where the literal comes first.
  for (const [annotation, label] of [
    ['Foo | { a: string }', 'the literal SECOND in a union'],
    ['{ a: string } | Foo', 'the literal FIRST in a union'],
    ['Foo & { a: string }', 'an intersection'],
    ['{ a: string }[]', 'an array of an object type'],
    ['() => { a: string }', 'a function type returning a literal'],
  ]) {
    const mk = (body) => `export function f(): ${annotation} {\n  ${body}\n}\n`
    const ea = extractPinned(mk('return x'), 'f')
    const eb = extractPinned(mk('return totallyDifferent(1, 2, 3)'), 'f')
    if (ea.text === null && ea.reason === 'ambiguous-return-type' && eb.text === null) {
      ok(`an object-type literal in the return annotation FAILS CLOSED (${label})`)
    } else {
      fail(
        `an object-type literal in the return annotation FAILS CLOSED (${label})`,
        JSON.stringify({ a: ea, b: eb }),
      )
    }
  }

  // The const-pin path's own instance of the same class: a comma inside
  // generic type arguments truncated the initializer to a stable prefix.
  // `src/lib/prefetch-page-subtree.ts#prefetchMap` is this shape live.
  {
    const mk = (valueType) =>
      `const prefetchMap = new Map<string, ${valueType}>()\nconst after = 1\n`
    const ea = extractPinned(mk('PrefetchEntry'), 'prefetchMap')
    const eb = extractPinned(mk('SomethingElseEntirely'), 'prefetchMap')
    const same =
      ea.text !== null &&
      eb.text !== null &&
      sha256hex(canonicalize(ea.text)) === sha256hex(canonicalize(eb.text))
    if (ea.text === 'const prefetchMap = new Map<string, PrefetchEntry>()' && !same) {
      ok('a generic const initializer extracts fully, so a changed type parameter changes the hash')
    } else {
      fail(
        'a generic const initializer extracts fully, so a changed type parameter changes the hash',
        JSON.stringify({ a: ea.text, b: eb.text, identicalHash: same }),
      )
    }
  }

  // An object-type literal that is unambiguously INSIDE a function-type
  // parameter list is not a candidate body at all, so it extracts fully
  // rather than being refused. Found by auditing return-type shapes rather
  // than by review: the body-open loop tracked angle depth but not paren
  // depth, and took this literal's brace as the body open.
  for (const [annotation, label] of [
    ['(x: { a: string }) => void', 'a literal inside a function-type parameter'],
    ['Record<string, { a: number }>', 'a literal inside generic arguments'],
    ['Map<string, Array<{ a: 1 }>>', 'a deeply nested literal'],
  ]) {
    const mk = (body) => `export function f(): ${annotation} {\n  ${body}\n}\n`
    const ea = extractPinned(mk('return one'), 'f')
    const eb = extractPinned(mk('return totallyDifferent(1, 2, 3)'), 'f')
    const driftVisible =
      ea.text !== null &&
      eb.text !== null &&
      sha256hex(canonicalize(ea.text)) !== sha256hex(canonicalize(eb.text))
    if (ea.text?.includes('return one') && driftVisible) {
      ok(`an unambiguous nested object-type literal still extracts the full body (${label})`)
    } else {
      fail(
        `an unambiguous nested object-type literal still extracts the full body (${label})`,
        JSON.stringify({ text: ea.text, reason: ea.reason, driftVisible }),
      )
    }
  }

  // Positive controls: the shapes that must keep extracting. A generic
  // wrapper (`Array<{…}>`) and a plain named return type both start their
  // annotation with something other than `{`.
  const extArrayReturn = extractPinned(
    `export function g(n: number): Array<{ a: number }> {\n  return [{ a: n }]\n}\n`,
    'g',
  )
  const extPlainReturn = extractPinned(
    `export function h(n: number): number {\n  return n + 1\n}\n`,
    'h',
  )
  if (
    extArrayReturn.text?.includes('return [{ a: n }]') &&
    extPlainReturn.text?.includes('return n + 1')
  ) {
    ok('generic and plain return-type annotations still extract the full body')
  } else {
    fail(
      'generic and plain return-type annotations still extract the full body',
      JSON.stringify({ arr: extArrayReturn, plain: extPlainReturn }),
    )
  }

  // ── #3950: the fail-open this guard shipped with ───────────────────
  //
  // Two versions of the same function differing ONLY by real code AFTER a
  // regex literal containing a bare `}`. The pre-fix bracket scanner
  // closed the body at the regex's `}`, so both extractions were the same
  // truncated prefix and both hashed identically — genuine drift with the
  // pin still green. These two assertions redden if the regex-literal
  // awareness is ever removed from the shared scanner.
  const braceRegexA = `
export function stripTrailing(s: string): string {
  const re = /\\}/g
  return s.replace(re, '')
}
`
  const braceRegexB = `
export function stripTrailing(s: string): string {
  const re = /\\}/g
  return s.replace(re, '').trimEnd()
}
`
  const extA = extractPinned(braceRegexA, 'stripTrailing')
  const extB = extractPinned(braceRegexB, 'stripTrailing')
  if (
    extA.text &&
    extB.text &&
    extA.text.includes("s.replace(re, '')") &&
    extA.text.trim().endsWith('}') &&
    sha256hex(canonicalize(extA.text)) !== sha256hex(canonicalize(extB.text))
  ) {
    ok(
      'a regex literal containing a bare `}` no longer truncates extraction — code after it changes the hash (#3950)',
    )
  } else {
    fail(
      'a regex literal containing a bare `}` no longer truncates extraction — code after it changes the hash (#3950)',
      JSON.stringify({ a: extA, b: extB }),
    )
  }

  const quoteRegexSrc = `
export function hasQuote(s: string): boolean {
  const re = /['"]/
  return re.test(s) && s.length > 0
}
`
  const extQuote = extractPinned(quoteRegexSrc, 'hasQuote')
  if (
    extQuote.text &&
    extQuote.text.includes('s.length > 0') &&
    extQuote.text.trim().endsWith('}')
  ) {
    ok('a regex literal containing quotes does not desync the scanner (#3950 widened scope)')
  } else {
    fail(
      'a regex literal containing quotes does not desync the scanner (#3950 widened scope)',
      JSON.stringify(extQuote),
    )
  }

  // ── #3953: const-initializer extraction ────────────────────────────

  const constSrc = `
const OTHER = 1
const RE = /(!?)\\[([^\\]]*)\\]\\((attachment:[^)\\s]+)\\)/g
const AFTER = 2
`
  const extConst = extractPinned(constSrc, 'RE')
  if (
    extConst.kind === 'const' &&
    extConst.text === 'const RE = /(!?)\\[([^\\]]*)\\]\\((attachment:[^)\\s]+)\\)/g'
  ) {
    ok('a const regex initializer extracts exactly, stopping at the ASI statement end')
  } else {
    fail(
      'a const regex initializer extracts exactly, stopping at the ASI statement end',
      JSON.stringify(extConst),
    )
  }

  const extConstAnnotated = extractPinned(
    'export const M: Map<string, number> = new Map([\n  ["a", 1],\n])\nconst next = 1\n',
    'M',
  )
  if (
    extConstAnnotated.kind === 'const' &&
    extConstAnnotated.text === 'export const M: Map<string, number> = new Map([\n  ["a", 1],\n])'
  ) {
    ok('a const with a generic type annotation and a multi-line initializer extracts fully')
  } else {
    fail(
      'a const with a generic type annotation and a multi-line initializer extracts fully',
      JSON.stringify(extConstAnnotated),
    )
  }

  // Both declaration regexes must be TOP-LEVEL anchored, as this file's
  // header and `extractPinned`'s docstring both promise. `(?:^|\n)\s*` did
  // not deliver that: `\s` matches indentation, so a declaration nested
  // inside a function body matched too, and a name present ONLY as a
  // function-local `const` was extracted and hashed as though it were the
  // module-level symbol the pin names.
  const extNestedConst = extractPinned(
    'export function outer() {\n  const NESTED = 1\n  return NESTED\n}\n',
    'NESTED',
  )
  if (extNestedConst.text === null && extNestedConst.reason === 'not-found') {
    ok('a function-local `const` is NOT extracted as though it were top-level')
  } else {
    fail(
      'a function-local `const` is NOT extracted as though it were top-level',
      JSON.stringify(extNestedConst),
    )
  }

  const extNestedFn = extractPinned(
    'export function outer() {\n  function nested() { return 1 }\n  return nested\n}\n',
    'nested',
  )
  if (extNestedFn.text === null && extNestedFn.reason === 'not-found') {
    ok('a function-local `function` declaration is NOT extracted as though it were top-level')
  } else {
    fail(
      'a function-local `function` declaration is NOT extracted as though it were top-level',
      JSON.stringify(extNestedFn),
    )
  }

  // Positive control: the anchoring must not stop finding real top-level
  // declarations, with or without `export`.
  const extTopLevelStill = extractPinned('const TOP = 1\nexport const TOP2 = 2\n', 'TOP2')
  if (extTopLevelStill.kind === 'const' && extTopLevelStill.text === 'export const TOP2 = 2') {
    ok('top-level declarations are still found after anchoring')
  } else {
    fail('top-level declarations are still found after anchoring', JSON.stringify(extTopLevelStill))
  }

  // The scanner's DELIBERATE fail-closed rules must not all surface as
  // "unbalanced brackets", which named neither the cause nor the remedy.
  // The reason is produced by the code that makes the decision, not
  // re-derived here — a second copy of the rule is the failure mode this
  // whole PR removes, and the first attempt at one misclassified a
  // genuinely unbalanced initializer as a dangling operator.
  for (const [src, name, wantReason, label] of [
    [
      'const El = <div>x</div>\nconst after = 1\n',
      'El',
      'ambiguous-angle-line-end',
      'a JSX-valued const',
    ],
    ["const P =\n  'head' +\n", 'P', 'dangling-operator', 'an initializer dangling on an operator'],
    ['const X = foo(\n  1,\n', 'X', 'unbalanced', 'a genuinely unbalanced initializer'],
  ]) {
    const r = extractPinned(src, name)
    if (r.text === null && r.reason === wantReason) {
      ok(`${label} refuses with reason \`${wantReason}\``)
    } else {
      fail(`${label} refuses with reason \`${wantReason}\``, JSON.stringify(r))
    }
  }

  const extNoInit = extractPinned('let LATER: number\nLATER = 1\n', 'LATER')
  if (extNoInit.text === null && extNoInit.reason === 'no-initializer') {
    ok('a declaration with no initializer FAILS CLOSED with its own reason')
  } else {
    fail(
      'a declaration with no initializer FAILS CLOSED with its own reason',
      JSON.stringify(extNoInit),
    )
  }

  // A const whose initializer differs only AFTER a brace-bearing regex —
  // the #3953-shaped instance of the #3950 fail-open.
  const constDriftA = "const R = [/\\}/g, 'a']\nconst next = 1\n"
  const constDriftB = "const R = [/\\}/g, 'b']\nconst next = 1\n"
  const hA = sha256hex(canonicalize(extractPinned(constDriftA, 'R').text))
  const hB = sha256hex(canonicalize(extractPinned(constDriftB, 'R').text))
  if (hA !== hB) {
    ok('a const initializer edit after a brace-bearing regex changes the hash')
  } else {
    fail('a const initializer edit after a brace-bearing regex changes the hash', `${hA} vs ${hB}`)
  }

  // ── fail-closed on un-scannable input ──────────────────────────────

  const extUnscannable = extractPinned(
    "export function f(): string {\n  const s = 'never closed\n  return s\n}\n",
    'f',
  )
  if (extUnscannable.text === null && extUnscannable.reason === 'unscannable') {
    ok('input the scanner cannot decide is reported as unscannable, not silently hashed')
  } else {
    fail(
      'input the scanner cannot decide is reported as unscannable, not silently hashed',
      JSON.stringify(extUnscannable),
    )
  }

  // ── canonicalize() reformatting tolerance ──────────────────────────

  const reformatted = `
export function     target(a: number, b: string): number {
  const x =
    a +
    1
  return x
}
`
  const h1 = sha256hex(canonicalize(ext1.text))
  const h2 = sha256hex(canonicalize(extractPinned(reformatted, 'target').text))
  if (h1 === h2) {
    ok('whitespace-only reformatting does not change the canonical hash')
  } else {
    fail('whitespace-only reformatting does not change the canonical hash', `${h1} vs ${h2}`)
  }

  const tokenChanged = `
export function target(a: number, b: string): number {
  const x = a + 2
  return x
}
`
  const h3 = sha256hex(canonicalize(extractPinned(tokenChanged, 'target').text))
  if (h3 !== h1) {
    ok('a real token change (a + 1 -> a + 2) changes the canonical hash')
  } else {
    fail('a real token change (a + 1 -> a + 2) changes the canonical hash', `${h1} vs ${h3}`)
  }

  // ── #4509: findPins() reports a malformed marker, not `null` ───────
  //
  // Before this fix, `PIN_RE` was one all-or-nothing pattern: a line
  // opening with the marker keyword but failing to match the strict
  // `sha256=[0-9a-f]{64}` shape was rejected by the WHOLE regex, so
  // `findPins` mapped it to `null` and filtered it out — identical to an
  // ordinary comment that never mentioned the keyword at all. These
  // assertions call `findPins` directly (fast, no filesystem) to pin the
  // parsing boundary itself: every shape below must come back
  // `{ malformed: true }`, never silently dropped. Enumerated from the
  // issue's acceptance criteria (placeholder, short, uppercase hash) plus
  // every other way the body regex's own anchors could be violated
  // (missing `#symbol`, missing `sha256=`, and — the mirror image of
  // "too short" — trailing garbage after an otherwise-valid hash, which
  // the original regex's own `$` anchor already refused but which is
  // worth pinning explicitly since it exercises the same anchor).
  const validHash = 'a'.repeat(64)
  for (const [label, rest] of [
    ['a placeholder instead of a hash', 'src/lib/x.ts#foo sha256=PLACEHOLDER'],
    ['a 63-character (truncated) hash', `src/lib/x.ts#foo sha256=${'a'.repeat(63)}`],
    ['a 65-character (overlong) hash', `src/lib/x.ts#foo sha256=${'a'.repeat(65)}`],
    ['an uppercase hash', `src/lib/x.ts#foo sha256=${'A'.repeat(64)}`],
    ['a missing "#symbolName" separator', `src/lib/x.ts foo sha256=${validHash}`],
    ['a missing "sha256=" prefix', `src/lib/x.ts#foo ${validHash}`],
    [
      'trailing garbage after an otherwise-valid hash',
      `src/lib/x.ts#foo sha256=${validHash} extra`,
    ],
  ]) {
    const found = findPins(`// mutation-harness-source-pin: ${rest}\nexport {}\n`)
    if (found.length === 1 && found[0].malformed === true && found[0].lineNo === 1) {
      ok(`findPins reports ${label} as malformed, not dropped`)
    } else {
      fail(`findPins reports ${label} as malformed, not dropped`, JSON.stringify(found))
    }
  }

  // The other arm: a well-formed marker of the exact same shape must
  // still parse as a normal pin — a fix that rejected everything would
  // pass every case above while breaking every real harness in the repo.
  const wellFormedFound = findPins(
    `// mutation-harness-source-pin: src/lib/x.ts#foo sha256=${validHash}\nexport {}\n`,
  )
  if (
    wellFormedFound.length === 1 &&
    wellFormedFound[0].malformed === false &&
    wellFormedFound[0].sourcePath === 'src/lib/x.ts' &&
    wellFormedFound[0].symbolName === 'foo' &&
    wellFormedFound[0].expectedHash === validHash
  ) {
    ok('findPins still parses a well-formed marker normally (both arms pinned)')
  } else {
    fail(
      'findPins still parses a well-formed marker normally (both arms pinned)',
      JSON.stringify(wellFormedFound),
    )
  }

  // ── #4526: findPins() recognises two MORE attempted-marker envelopes ──
  //
  // `PIN_PREFIX_RE`'s prefix substring was byte-identical to the pre-#4509
  // `PIN_RE`'s, and shared its blind spot one layer up: a line matching
  // NEITHER envelope regex was — like a malformed body before #4509 —
  // indistinguishable from an ordinary comment and silently dropped. These
  // assertions call `findPins` directly, mirroring the #4509 block above.

  const blockPin = findPins(
    `/* mutation-harness-source-pin: src/lib/x.ts#foo sha256=${validHash} */\nexport {}\n`,
  )
  if (
    blockPin.length === 1 &&
    blockPin[0].malformed === true &&
    blockPin[0].reason === 'block-comment' &&
    blockPin[0].lineNo === 1 &&
    blockPin[0].raw === `src/lib/x.ts#foo sha256=${validHash}`
  ) {
    ok(
      'findPins reports a single-line /* ... */ block comment as a malformed block-comment envelope',
    )
  } else {
    fail(
      'findPins reports a single-line /* ... */ block comment as a malformed block-comment envelope',
      JSON.stringify(blockPin),
    )
  }

  // The `/** ... */` JSDoc-style spelling of the same single-line shape.
  const jsdocBlockPin = findPins(
    `/** mutation-harness-source-pin: src/lib/x.ts#foo sha256=${validHash} */\nexport {}\n`,
  )
  if (
    jsdocBlockPin.length === 1 &&
    jsdocBlockPin[0].malformed === true &&
    jsdocBlockPin[0].reason === 'block-comment'
  ) {
    ok('findPins reports a single-line /** ... */ block comment the same way')
  } else {
    fail(
      'findPins reports a single-line /** ... */ block comment the same way',
      JSON.stringify(jsdocBlockPin),
    )
  }

  // A differently-cased keyword, in each of the two envelopes that
  // otherwise accept it.
  for (const [label, line] of [
    ['a `//` line comment', `// MUTATION-HARNESS-SOURCE-PIN: src/lib/x.ts#foo sha256=${validHash}`],
    [
      'a `*` JSDoc continuation line',
      ` * Mutation-Harness-Source-Pin: src/lib/x.ts#foo sha256=${validHash}`,
    ],
  ]) {
    const found = findPins(`${line}\nexport {}\n`)
    if (
      found.length === 1 &&
      found[0].malformed === true &&
      found[0].reason === 'wrong-case' &&
      found[0].raw === `src/lib/x.ts#foo sha256=${validHash}`
    ) {
      ok(
        `findPins reports a differently-cased keyword in ${label} as a malformed wrong-case marker`,
      )
    } else {
      fail(
        `findPins reports a differently-cased keyword in ${label} as a malformed wrong-case marker`,
        JSON.stringify(found),
      )
    }
  }

  // The two mistakes are independent: a wrong-case keyword TOGETHER with a
  // body that is also malformed in the #4509 sense (a placeholder hash)
  // still comes back as exactly one `wrong-case` diagnosis, not a crash and
  // not a second, contradictory attempt to also validate the (irrelevant,
  // since the envelope is already wrong) body.
  const bothWrong = findPins(
    '// MUTATION-HARNESS-SOURCE-PIN: src/lib/x.ts#foo sha256=PLACEHOLDER\nexport {}\n',
  )
  if (
    bothWrong.length === 1 &&
    bothWrong[0].malformed === true &&
    bothWrong[0].reason === 'wrong-case'
  ) {
    ok(
      'a wrong-case keyword together with an also-malformed body is still ONE wrong-case violation',
    )
  } else {
    fail(
      'a wrong-case keyword together with an also-malformed body is still ONE wrong-case violation',
      JSON.stringify(bothWrong),
    )
  }

  // ── #4526: template-string exclusion still holds for the NEW envelopes ──
  //
  // `blankStringsAndTemplates` blanks template-literal TEXT (not `${…}`
  // code) before `findPins` ever splits into lines, same mechanism the
  // existing "pin-shaped line inside a template literal" case below relies
  // on for the canonical envelope. These two assertions prove that
  // protection extends to the two new envelopes too, rather than being
  // bypassed because the detection logic changed.
  const blockPinInTemplate = findPins(
    'export const sample = `\n' +
      `/* mutation-harness-source-pin: src/lib/x.ts#foo sha256=${validHash} */\n` +
      '`\n',
  )
  if (blockPinInTemplate.length === 0) {
    ok(
      'a block-comment-shaped marker living inside a template literal is not parsed as a real pin attempt',
    )
  } else {
    fail(
      'a block-comment-shaped marker living inside a template literal is not parsed as a real pin attempt',
      JSON.stringify(blockPinInTemplate),
    )
  }

  const wrongCaseInTemplate = findPins(
    'export const sample = `\n' +
      `// MUTATION-HARNESS-SOURCE-PIN: src/lib/x.ts#foo sha256=${validHash}\n` +
      '`\n',
  )
  if (wrongCaseInTemplate.length === 0) {
    ok(
      'a wrong-case-keyword marker living inside a template literal is not parsed as a real pin attempt',
    )
  } else {
    fail(
      'a wrong-case-keyword marker living inside a template literal is not parsed as a real pin attempt',
      JSON.stringify(wrongCaseInTemplate),
    )
  }

  // ── #4526: envelopes deliberately left UNDETECTED ────────────────────
  //
  // Enumerated in `PIN_BLOCK_LINE_RE`'s own header comment as a considered
  // choice, not an oversight: both require locating where a comment BEGINS
  // mid-line, which a line regex cannot do reliably (a `//` or `/*` is not
  // certainly a comment opener when something else precedes it on the
  // line — that needs the real tokenizer's division-vs-regex-vs-comment
  // resolution). These assertions pin the choice down as a choice: if
  // either ever starts being detected, one of these should be updated
  // deliberately, not silently start failing.

  const trailingAfterCode = findPins(
    `const x = 1 // mutation-harness-source-pin: src/lib/x.ts#foo sha256=${validHash}\n`,
  )
  if (trailingAfterCode.length === 0) {
    ok(
      'a trailing // marker after real code on the same line is NOT detected (deliberate — needs the real tokenizer, not a line regex)',
    )
  } else {
    fail(
      'a trailing // marker after real code on the same line is NOT detected (deliberate — needs the real tokenizer, not a line regex)',
      JSON.stringify(trailingAfterCode),
    )
  }

  const afterClosingStarSlash = findPins(
    `/** doc */ // mutation-harness-source-pin: src/lib/x.ts#foo sha256=${validHash}\n`,
  )
  if (afterClosingStarSlash.length === 0) {
    ok(
      'a marker starting right after a same-line */ that closes a preceding comment is NOT detected (deliberate, same reason)',
    )
  } else {
    fail(
      'a marker starting right after a same-line */ that closes a preceding comment is NOT detected (deliberate, same reason)',
      JSON.stringify(afterClosingStarSlash),
    )
  }

  const multiLinePlainBlock = findPins(
    `/*\nmutation-harness-source-pin: src/lib/x.ts#foo sha256=${validHash}\n*/\nexport {}\n`,
  )
  if (multiLinePlainBlock.length === 0) {
    ok(
      'a marker on an inner line of a multi-line PLAIN /* */ block (no leading `*`) is NOT detected (deliberate — a different shape than "single-line block comment")',
    )
  } else {
    fail(
      'a marker on an inner line of a multi-line PLAIN /* */ block (no leading `*`) is NOT detected (deliberate — a different shape than "single-line block comment")',
      JSON.stringify(multiLinePlainBlock),
    )
  }

  // ── checkTree() end-to-end, on a synthetic filesystem ──────────────

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-harness-clones-selftest-'))
  try {
    const srcDir = path.join(tmp, 'src', 'lib')
    const harnessDir = path.join(tmp, 'scripts', 'mutation-harnesses')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(harnessDir, { recursive: true })

    const sourceRel = 'src/lib/example.ts'
    const writeSource = (bodyLine) =>
      fs.writeFileSync(
        path.join(tmp, sourceRel),
        `// unrelated leading comment\nexport function example(n: number): number {\n  ${bodyLine}\n}\n// unrelated trailing comment\n`,
      )

    const pinHashFor = (bodyLine) => {
      writeSource(bodyLine)
      const s = fs.readFileSync(path.join(tmp, sourceRel), 'utf8')
      return sha256hex(canonicalize(extractPinned(s, 'example').text))
    }

    const originalBody = 'return n + 1'
    const originalHash = pinHashFor(originalBody)

    const harnessPath = path.join(harnessDir, 'example.harness.ts')
    const writeHarness = (hash) =>
      fs.writeFileSync(
        harnessPath,
        `// mutation-harness-source-pin: ${sourceRel}#example sha256=${hash}\nexport {}\n`,
      )

    // Case 1: matching pin passes.
    writeSource(originalBody)
    writeHarness(originalHash)
    let r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0 && r.pinCount === 1) {
      ok('matching pin passes cleanly')
    } else {
      fail('matching pin passes cleanly', JSON.stringify(r.violations))
    }

    // Case 1b: the same pin, but written as a `/** ... */` JSDoc line
    // (leading ` * `) instead of a standalone `//` comment — must also pass,
    // and a bare `*/` closer line must not be misread as a marker line.
    fs.writeFileSync(
      harnessPath,
      `/**\n * mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\n */\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0 && r.pinCount === 1) {
      ok('a pin written inside a JSDoc block comment also passes')
    } else {
      fail('a pin written inside a JSDoc block comment also passes', JSON.stringify(r.violations))
    }
    writeHarness(originalHash) // back to the plain `//` form for the rest

    // Case 2: DRIFT — edit the pinned function's source, pin stays stale. Must FAIL.
    writeSource('return n + 2')
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes('has changed since') &&
      r.violations[0].message.includes('example.harness.ts:1')
    ) {
      ok('a source edit inside the pinned function FAILS the gate')
    } else {
      fail('a source edit inside the pinned function FAILS the gate', JSON.stringify(r.violations))
    }

    // Case 3: RESTORE — revert the source. Must PASS again.
    writeSource(originalBody)
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0) {
      ok('restoring the source PASSES the gate again')
    } else {
      fail('restoring the source PASSES the gate again', JSON.stringify(r.violations))
    }

    // Case 4: edit OUTSIDE the pinned function (leading comment) must NOT trip it.
    fs.writeFileSync(
      path.join(tmp, sourceRel),
      `// a totally different leading comment now\nexport function example(n: number): number {\n  ${originalBody}\n}\n// unrelated trailing comment\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0) {
      ok('an edit outside the pinned function body does not trip the gate')
    } else {
      fail(
        'an edit outside the pinned function body does not trip the gate',
        JSON.stringify(r.violations),
      )
    }
    writeSource(originalBody) // restore for subsequent cases

    // Case 5: harness with NO pin at all must FAIL.
    fs.writeFileSync(harnessPath, `export {}\n`)
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes('no mutation-harness-source-pin')
    ) {
      ok('a harness with no source-pin marker FAILS')
    } else {
      fail('a harness with no source-pin marker FAILS', JSON.stringify(r.violations))
    }

    // Case 6: pin naming a MISSING source file must FAIL.
    writeHarness(originalHash)
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: src/lib/does-not-exist.ts#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('does not exist')) {
      ok('a pin naming a missing source file FAILS')
    } else {
      fail('a pin naming a missing source file FAILS', JSON.stringify(r.violations))
    }

    // Case 7: pin naming a symbol no longer present (renamed away) must FAIL.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#renamedAway sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes('no such function or const exists')
    ) {
      ok('a pin naming a symbol absent from the source FAILS')
    } else {
      fail('a pin naming a symbol absent from the source FAILS', JSON.stringify(r.violations))
    }

    // Case 8: a pinned name ending in `$` must still match — `$` is a valid
    // identifier character but a regex metacharacter, so an unescaped
    // interpolation would compile `function\s+foo$\s*\(`, which can never
    // match (anchors end-of-string before the literal `(` it still expects)
    // and would misreport "renamed or removed" even though the function is
    // right there, unchanged.
    fs.writeFileSync(
      path.join(tmp, sourceRel),
      `export function example$(n: number): number {\n  return n + 1\n}\n`,
    )
    const dollarHash = sha256hex(
      canonicalize(
        extractPinned(fs.readFileSync(path.join(tmp, sourceRel), 'utf8'), 'example$').text,
      ),
    )
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example$ sha256=${dollarHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0) {
      ok('a pinned name ending in `$` is matched (regex-escaped), not misreported as orphaned')
    } else {
      fail(
        'a pinned name ending in `$` is matched (regex-escaped), not misreported as orphaned',
        JSON.stringify(r.violations),
      )
    }
    writeSource(originalBody) // restore for subsequent cases

    // Case 9: a pin whose `sourcePath` escapes the repo root via `../` must
    // FAIL closed (refusing to read outside the repo), not silently resolve
    // and read whatever file happens to sit there.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ../../../../../../etc/passwd#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('outside the repo root')) {
      ok('a pin path escaping the repo root via `../` is rejected, not read')
    } else {
      fail(
        'a pin path escaping the repo root via `../` is rejected, not read',
        JSON.stringify(r.violations),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 10: a name present ONLY as a form this guard still doesn't
    // extract (a generic signature) gets a distinct "found it, but not as a
    // plain declaration" message instead of being misdiagnosed as "renamed
    // or removed". (The const-arrow form used to live here; #3953 made it
    // extractable, so it is now Case 10b instead.)
    fs.writeFileSync(
      path.join(tmp, sourceRel),
      `export function example<T>(n: T): T {\n  return n\n}\n`,
    )
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes('not as a plain') &&
      !r.violations[0].message.includes('the clone is orphaned')
    ) {
      ok(
        'a generic-signature form of the pinned name gets its own message, not "renamed or removed"',
      )
    } else {
      fail(
        'a generic-signature form of the pinned name gets its own message, not "renamed or removed"',
        JSON.stringify(r.violations),
      )
    }

    // Case 10b (#3953): a `const` initializer — the shape that was
    // unpinnable — pins, gates on a real edit, and passes again when
    // restored. This is the whole point of the issue, end to end.
    const constSourceRel = 'src/lib/consts.ts'
    const writeConstSource = (pattern) =>
      fs.writeFileSync(
        path.join(tmp, constSourceRel),
        `// leading\nconst OTHER = 1\nconst SHAPE_RE = ${pattern}\nexport function user(s: string) {\n  return SHAPE_RE.test(s)\n}\n`,
      )
    const originalPattern = '/(!?)\\[([^\\]]*)\\]\\((attachment:[^)\\s]+)\\)/g'
    writeConstSource(originalPattern)
    const constHash = sha256hex(
      canonicalize(
        extractPinned(fs.readFileSync(path.join(tmp, constSourceRel), 'utf8'), 'SHAPE_RE').text,
      ),
    )
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${constSourceRel}#SHAPE_RE sha256=${constHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0 && r.pinCount === 1) {
      ok('a const initializer can be pinned and passes when unchanged (#3953)')
    } else {
      fail('a const initializer can be pinned and passes when unchanged (#3953)', JSON.stringify(r))
    }

    // The exact edit #3953 names as the one the equivalence claim is
    // sensitive to: making capture group 3 OPTIONAL.
    writeConstSource('/(!?)\\[([^\\]]*)\\]\\((attachment:[^)\\s]+)?\\)/g')
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('has changed since')) {
      ok('making the pinned const regex’s group 3 optional FAILS the gate (#3953)')
    } else {
      fail(
        'making the pinned const regex’s group 3 optional FAILS the gate (#3953)',
        JSON.stringify(r.violations),
      )
    }

    writeConstSource(originalPattern)
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0) {
      ok('restoring the const regex PASSES the gate again (#3953)')
    } else {
      fail('restoring the const regex PASSES the gate again (#3953)', JSON.stringify(r.violations))
    }

    // An edit to the FUNCTION that merely uses the pinned const must not
    // trip the const pin — the extraction boundary is the declaration, not
    // the file.
    fs.writeFileSync(
      path.join(tmp, constSourceRel),
      `// leading\nconst OTHER = 1\nconst SHAPE_RE = ${originalPattern}\nexport function user(s: string) {\n  return SHAPE_RE.test(s.trim())\n}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0) {
      ok('an edit outside the pinned const declaration does not trip the gate')
    } else {
      fail(
        'an edit outside the pinned const declaration does not trip the gate',
        JSON.stringify(r.violations),
      )
    }

    writeSource(originalBody)
    writeHarness(originalHash) // restore for subsequent cases

    // Case 11: a pin naming a DIRECTORY (not a file) must be reported as
    // the intended violation, not crash with an uncaught EISDIR.
    const dirAsSource = path.join(tmp, 'src', 'lib', 'a-directory')
    fs.mkdirSync(dirAsSource, { recursive: true })
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: src/lib/a-directory#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('directory, not a file')) {
      ok('a pin naming a directory FAILS with a message, not an uncaught EISDIR')
    } else {
      fail(
        'a pin naming a directory FAILS with a message, not an uncaught EISDIR',
        JSON.stringify(r.violations),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 12: a pin whose `sourcePath` is lexically inside the repo but
    // is a SYMLINK resolving outside it must FAIL closed (mirrors case 9,
    // but for a symlink escape instead of a `../` escape — a lexical-only
    // containment check passes a symlink straight through).
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-harness-clones-outside-'))
    try {
      const outsideFile = path.join(outsideDir, 'secret.ts')
      fs.writeFileSync(outsideFile, `export function example(n: number): number {\n  return n\n}\n`)
      const symlinkRel = 'src/lib/escape-link.ts'
      fs.symlinkSync(outsideFile, path.join(tmp, symlinkRel))
      fs.writeFileSync(
        harnessPath,
        `// mutation-harness-source-pin: ${symlinkRel}#example sha256=${originalHash}\nexport {}\n`,
      )
      r = checkTree({ root: tmp, harnessDir })
      if (
        r.violations.length === 1 &&
        r.violations[0].message.includes('symlink resolving outside the repo root')
      ) {
        ok('a pin path that is a symlink resolving outside the repo root is rejected, not read')
      } else {
        fail(
          'a pin path that is a symlink resolving outside the repo root is rejected, not read',
          JSON.stringify(r.violations),
        )
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 13: a harness placed in a SUBDIRECTORY of `scripts/
    // mutation-harnesses/` must still be discovered and required to carry
    // a pin — `readdirSync` without `{ recursive: true }` would silently
    // skip it, leaving it un-gated forever.
    const nestedHarnessDir = path.join(harnessDir, 'nested')
    fs.mkdirSync(nestedHarnessDir, { recursive: true })
    fs.writeFileSync(path.join(nestedHarnessDir, 'nested.harness.ts'), `export {}\n`)
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.harnessCount === 2 &&
      r.violations.some(
        (v) =>
          v.harness.endsWith('nested/nested.harness.ts') &&
          v.message.includes('no mutation-harness-source-pin'),
      )
    ) {
      ok('a harness in a subdirectory of scripts/mutation-harnesses/ is discovered and gated')
    } else {
      fail(
        'a harness in a subdirectory of scripts/mutation-harnesses/ is discovered and gated',
        JSON.stringify({ harnessCount: r.harnessCount, violations: r.violations }),
      )
    }
    fs.rmSync(nestedHarnessDir, { recursive: true, force: true })

    // Case 14: a pin-SHAPED line living inside a template literal (data,
    // not a real marker — e.g. a code sample embedded in a console.log)
    // must not be parsed as a real pin.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\n` +
        `export const sample = \`\n// mutation-harness-source-pin: src/lib/does-not-exist.ts#nope sha256=${'0'.repeat(64)}\n\`\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 0 && r.pinCount === 1) {
      ok('a pin-shaped line inside a template literal is not parsed as a real pin')
    } else {
      fail(
        'a pin-shaped line inside a template literal is not parsed as a real pin',
        JSON.stringify(r),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 15: a harness whose own source the scanner cannot lex must FAIL
    // (reported as un-scannable), never be treated as "no pins here, move
    // on" or as passing.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\nconst broken = 'never closed\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('could not be scanned')) {
      ok('a harness the scanner cannot lex FAILS as un-scannable, not silently')
    } else {
      fail(
        'a harness the scanner cannot lex FAILS as un-scannable, not silently',
        JSON.stringify(r.violations),
      )
    }

    // Case 16: a pinned SOURCE file the scanner cannot lex must FAIL the
    // pin (fail closed), not hash a truncated guess.
    fs.writeFileSync(
      path.join(tmp, sourceRel),
      `export function example(n: number): number {\n  const s = 'never closed\n  return n\n}\n`,
    )
    writeHarness(originalHash)
    r = checkTree({ root: tmp, harnessDir })
    if (r.violations.length === 1 && r.violations[0].message.includes('could not be scanned')) {
      ok('a pinned source file the scanner cannot lex FAILS the pin, fail-closed')
    } else {
      fail(
        'a pinned source file the scanner cannot lex FAILS the pin, fail-closed',
        JSON.stringify(r.violations),
      )
    }
    writeSource(originalBody)

    // Case 15b (#3970): an ABSOLUTE pin path is neutralised by `path.join`
    // (`path.join(root, '/etc/passwd')` → `<root>/etc/passwd`), so the file
    // named in the marker is never opened. That resolution is the
    // security-relevant part and is unchanged; what this case pins is the
    // REPORT. The violation must name the path that was actually resolved
    // and checked — a message reading "but /etc/passwd does not exist" is a
    // claim about a path this guard never looked at, and a reader who goes
    // and confirms /etc/passwd is right there concludes the guard is broken.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: /etc/passwd#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    const absMsg = r.violations[0]?.message ?? ''
    if (
      r.violations.length === 1 &&
      absMsg.includes('does not exist') &&
      absMsg.includes('etc/passwd (the pin text "/etc/passwd" is joined to the repo root') &&
      !absMsg.includes('but /etc/passwd does not exist')
    ) {
      ok('an absolute pin path is reported under the path RESOLVED, not the one written')
    } else {
      fail(
        'an absolute pin path is reported under the path RESOLVED, not the one written',
        JSON.stringify(r.violations),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 16b (#3970): the converse — an ordinary repo-relative pin, where
    // written and resolved paths are the SAME, must keep its short message
    // and not acquire the "resolved to …" clarification. Without this, a
    // fix that unconditionally appended the resolution would pass case 15
    // while making every everyday failure message noisier.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: src/lib/does-not-exist.ts#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    const relMsg = r.violations[0]?.message ?? ''
    if (
      r.violations.length === 1 &&
      relMsg.includes('but src/lib/does-not-exist.ts does not exist') &&
      !relMsg.includes('joined to the repo root')
    ) {
      ok('a plain repo-relative pin keeps the short message (written path == resolved path)')
    } else {
      fail(
        'a plain repo-relative pin keeps the short message (written path == resolved path)',
        JSON.stringify(r.violations),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 18 (#4509): the issue's exact repro shape — a MALFORMED pin
    // living ALONGSIDE an otherwise-valid one. Must FAIL, naming only the
    // malformed line, and `pinCount` must count only the well-formed pin —
    // the bug this closes was specifically that the malformed one vanished
    // from the tally while the run still reported `OK`. Here the run
    // doesn't report OK at all (it fails), so the trusted count is never
    // printed short; asserting `pinCount === 1` pins that a regression
    // re-counting the malformed line as a verified pin (as opposed to a
    // violation) couldn't slip through unnoticed inside a still-failing run.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\n` +
        `// mutation-harness-source-pin: ${sourceRel}#example sha256=PLACEHOLDER\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    const relHarnessPath = path.relative(tmp, harnessPath).split(path.sep).join('/')
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes(`${relHarnessPath}:2`) &&
      r.violations[0].message.includes('PLACEHOLDER') &&
      r.pinCount === 1
    ) {
      ok(
        'a malformed pin alongside a valid one FAILS, names only the bad line, and does not inflate pinCount',
      )
    } else {
      fail(
        'a malformed pin alongside a valid one FAILS, names only the bad line, and does not inflate pinCount',
        JSON.stringify(r),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 19 (#4526): the ISSUE'S OWN REPRO, end to end — a well-formed
    // pin living alongside a single-line `/* ... */` block-comment marker.
    // Before this fix this reported `violations: [], pinCount: 1`, exit 0,
    // "OK" — the block-comment pin was invisible, not invalid, so the
    // clone it named went unpinned with no signal anywhere. It must now
    // FAIL, naming the second line, and `pinCount` must still be exactly 1
    // (the well-formed pin only — the block-comment one was never
    // verified against anything and must not inflate the trusted count).
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\n` +
        `/* mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash} */\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes(`${relHarnessPath}:2`) &&
      r.violations[0].message.includes('block comment') &&
      r.pinCount === 1
    ) {
      ok(
        'issue repro: a well-formed pin alongside a single-line block-comment marker FAILS, names the block-comment line, pinCount stays 1',
      )
    } else {
      fail(
        'issue repro: a well-formed pin alongside a single-line block-comment marker FAILS, names the block-comment line, pinCount stays 1',
        JSON.stringify(r),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases

    // Case 20 (#4526): the issue's second repro shape — a well-formed pin
    // alongside a differently-cased keyword. Same pre-fix symptom
    // (`violations: [], pinCount: 1`, exit 0), same required outcome.
    fs.writeFileSync(
      harnessPath,
      `// mutation-harness-source-pin: ${sourceRel}#example sha256=${originalHash}\n` +
        `// MUTATION-HARNESS-SOURCE-PIN: ${sourceRel}#example sha256=${originalHash}\nexport {}\n`,
    )
    r = checkTree({ root: tmp, harnessDir })
    if (
      r.violations.length === 1 &&
      r.violations[0].message.includes(`${relHarnessPath}:2`) &&
      r.violations[0].message.includes('not exactly lowercase') &&
      r.pinCount === 1
    ) {
      ok(
        'issue repro: a well-formed pin alongside a differently-cased keyword FAILS, names the wrong-case line, pinCount stays 1',
      )
    } else {
      fail(
        'issue repro: a well-formed pin alongside a differently-cased keyword FAILS, names the wrong-case line, pinCount stays 1',
        JSON.stringify(r),
      )
    }
    writeHarness(originalHash) // restore for subsequent cases
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // Case 17: a MISSING harness directory (moved/renamed) must fail the
  // repo-layout check rather than being read as "zero harnesses, zero
  // pins, all clean" — silently disarming the whole gate. `checkTree`
  // must throw `LayoutError`, not return an empty, all-clear result.
  const tmpNoHarnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-harness-clones-nodir-'))
  try {
    const missingHarnessDir = path.join(tmpNoHarnessDir, 'scripts', 'mutation-harnesses')
    let threw = null
    try {
      checkTree({ root: tmpNoHarnessDir, harnessDir: missingHarnessDir })
    } catch (err) {
      threw = err
    }
    if (threw instanceof LayoutError) {
      ok('a missing harness directory throws LayoutError instead of reporting a silent all-clear')
    } else {
      fail(
        'a missing harness directory throws LayoutError instead of reporting a silent all-clear',
        threw ? String(threw) : 'checkTree returned normally instead of throwing',
      )
    }
  } finally {
    fs.rmSync(tmpNoHarnessDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
