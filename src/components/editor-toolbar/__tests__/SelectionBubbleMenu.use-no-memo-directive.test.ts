import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// #4484 — delegate bracket-matching to the repo's sanctioned shared JS/TS
// scanner (`scripts/lib/js-scanner.mjs`, #3991) instead of hand-rolling a
// quote/comment/escape-aware state machine locally; see `matchBracket`'s own
// docstring below. No type declarations exist for this `.mjs` script — same
// as the existing `src/__tests__/check-bare-icon-buttons.test.ts` and its
// siblings, which already import guard scripts this way.
// @ts-expect-error — no type declarations for the .mjs script.
import { findMatchingBracket } from '../../../../scripts/lib/js-scanner.mjs'

/**
 * Guards PR #4471's non-blocking review note 3: the `'use no memo'`
 * directive that opts `SelectionBubbleMenu` out of React Compiler
 * memoisation (see the comment above the directive in the component itself
 * — a cached `<BubbleMenu>` element froze the mermaid-in-code-block subtree
 * and broke `e2e/mobile-editor.spec.ts`, #4469) only takes effect as part of
 * the leading run of string-literal statements (the directive prologue) at
 * the top of the function body. A real statement placed ahead of that run
 * silently deactivates it: the compiler still reports `CompileSuccess`,
 * oxlint and `tsc` stay green, and the only prior symptom was that e2e spec
 * failing as an unrelated-looking 15s timeout.
 *
 * The compiler runs at build time and is disabled under Vitest
 * (`vite.config.ts`'s `VITEST` check), so nothing rendered through this
 * test file can observe the regression directly — the only way a unit test
 * can catch a misplaced directive is to read the component's own source and
 * check its syntactic position, which is what this file does.
 *
 * Brace/quote-aware text scan, mirroring the other source-reading guards in
 * this suite (e.g. `scripts/check-bare-icon-buttons.mjs`'s brace-aware tag
 * scanner), rather than a full AST parse: this repo's `typescript` package
 * is v7 (the Go-ported compiler) and does not expose the classic Node
 * compiler API — `Object.keys(require('typescript'))` is just `['version',
 * 'versionMajorMinor']` — and `@babel/parser` is only a transitive
 * dependency of `@babel/core`, not one this repo declares directly.
 *
 * Also guards PR #4475's first-review non-blocking notes 1, 2, 3, and 4 on
 * this scanner itself: a same-name-prefixed sibling declaration ahead of the
 * real one, an inline object return type, a comment containing an apostrophe
 * inside the parameter list, and a directive prologue holding more than one
 * entry.
 *
 * A second review of the same PR then found the scanner's own fixes needed
 * hardening: `matchBracket` wasn't comment-aware like its sibling loop
 * (note 2), the literal scan ignored backslash escapes (note 3), the name
 * `isDirectiveFirstStatement` contradicted the semantics note 4 above
 * established — renamed to `isDirectiveInPrologue` (note 4), and the two
 * helpers were exported with no importer (note 5, addressed by dropping the
 * exports). Note 1 (a generic-wrapped return type such as
 * `Promise<{ node: X }>`) is recorded as a known limit on
 * `findFunctionBodyStart` rather than closed, since no such signature exists
 * in this file's source today.
 *
 * A third review found those very hardening fixes unpinned: `matchBracket`'s
 * quote and backslash-escape handling, and the identical handling in the
 * parameter-list loop, were reachable by no fixture — the live component's
 * return type is brace-free so `matchBracket` never runs on it, the fixtures
 * that do reach it contain no quote character, and none put a string literal
 * in a parameter list (note 1). Four fixtures below close that: a bracketed
 * default value and an escaped quote inside one, each in both a parameter
 * list (the paren-matching loop) and a string-literal return type
 * (`matchBracket`).
 *
 * A fourth review (#4484) found the two hardened scanners were themselves
 * the defect generator: `matchBracket` and the parameter-list loop above
 * were near-verbatim duplicates — same quote state machine, same escape
 * handling, same two comment branches — and every one of the last two
 * rounds fixed exactly one copy and left its sibling to be caught by a
 * reviewer rather than a test. They are now one function: `matchBracket`
 * delegates to `scripts/lib/js-scanner.mjs`'s `findMatchingBracket` (the
 * shared, self-tested JS/TS scanner every JS-side guard in this repo is
 * built to delegate lexing to, #3991 — "the sanctioned implementation, do
 * not hand-roll a fourth"), and the parameter-list skip calls it directly
 * instead of hand-rolling a second copy. That review also found
 * `skipTrivia`'s block-comment branch reachable by no fixture (closed
 * below) and three gaps in `findFunctionBodyStart`'s and
 * `isDirectiveInPrologue`'s known-limits documentation (a type-parameter
 * list containing a paren, a composite return type, and a raw-text-only
 * directive match) — recorded where each function already enumerates its
 * other limits.
 */

const COMPONENT_PATH = join(__dirname, '../SelectionBubbleMenu.tsx')
const COMPONENT_NAME = 'SelectionBubbleMenu'
const DIRECTIVE = 'use no memo'

// Skip whitespace, line comments, and block comments starting at index `i`.
function skipTrivia(src: string, start: number): number {
  let i = start
  for (;;) {
    while (i < src.length && /\s/.test(src[i] ?? '')) i++
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl + 1
      continue
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    break
  }
  return i
}

/**
 * Given `src[openIdx]` is one of `{`, `[`, or `(`, return the index just past
 * its matching close. Returns -1 if the group is never closed by an ordinary
 * (un)balanced bracket count.
 *
 * A thin return-convention adapter over `findMatchingBracket` from the
 * repo's shared JS/TS scanner (`scripts/lib/js-scanner.mjs`, #3991): that
 * function returns the index OF the closing bracket itself, one less than
 * what `findFunctionBodyStart` below needs at both of its call sites, so
 * this just adds one.
 *
 * Does NOT catch `ScanError`: `findMatchingBracket` throws it (uncaught,
 * propagating straight through this adapter and through
 * `findFunctionBodyStart`) rather than returning -1 when the scanned range
 * holds an unterminated string or template literal — a different failure
 * mode than the old hand-rolled loop it replaced, which just returned -1 for
 * that case too, quietly. Left uncaught deliberately: `ScanError`'s own
 * contract (`scripts/lib/js-scanner.mjs`) says a caller must turn it into a
 * loud guard failure, never a silent -1, and this file's whole point is
 * fail-loud over silent-pass. No fixture in this file reaches this path (the
 * live component and every fixture here are well-formed), so it is
 * documented rather than exercised in the ordinary suite; see the dedicated
 * regression test below.
 *
 * #4484 replaced what used to be two independent hand-rolled
 * quote/comment/escape state machines here — this function, and
 * `findFunctionBodyStart`'s parameter-list loop — with this one adapter.
 * They were near-verbatim duplicates (same quote handling, same two comment
 * branches, same escape handling), and the file's own review history shows
 * why that is a defect generator rather than tidiness debt: #4475's second
 * review round added comment-awareness to the parameter-list loop and not
 * to this function, and its third round added escape-awareness to one of
 * them and not the other (see the file header). A hand-rolled copy can
 * drift from its sibling with nothing to catch it; a three-line adapter
 * over an already self-tested shared implementation cannot drift from
 * itself. Delegating also CLOSES, rather than merely documents, a limit the
 * old hand-rolled version had: it treated a template literal's backtick as
 * an opaque quote, so a bracket inside a `${…}` interpolation was skipped
 * instead of counted; the shared tokenizer models template interpolations
 * as real code.
 */
function matchBracket(src: string, openIdx: number): number {
  const closeIdx = findMatchingBracket(src, openIdx)
  return closeIdx === -1 ? -1 : closeIdx + 1
}

/**
 * Locate the index just after the opening `{` of `function <name>(...) {`'s
 * body: skip the parameter list, skip an optional return type annotation,
 * and return the position right after the body's own opening brace. Returns
 * null if `functionName` isn't found as a function declaration in `src`.
 *
 * The parameter list is skipped by finding `(`'s match with `matchBracket`
 * (the same helper used below for the return-type group, and — since
 * #4484 — bracket-depth, quote, comment, AND template-literal aware) rather
 * than a second hand-rolled loop: a default value, type annotation, or
 * comment containing `(`, `)`, or a quote character can't miscount it.
 *
 * Known limit, deliberately not closed (#4475 note 1): the return-type skip
 * below only covers a brace-free type (`React.ReactElement`) or one whose
 * FIRST character opens a `{`, `[`, or `(` group (an inline object type, a
 * tuple type, a function type). It does NOT cover a generic-wrapped type
 * whose type argument list itself contains a bracket (`Promise<{ node: X
 * }>`, `Record<string, { a: 1 }>`) — there the character right after `:` is
 * an identifier, not a bracket, so the skip never triggers and the fallback
 * lands on the type's own brace instead of the body's, reading the wrong
 * text. No such signature exists in this file's current source, and the
 * failure is loud (a red assertion), never a silent pass — closing it needs
 * a second, angle-bracket-aware scan, disproportionate for a guard that
 * reads one known file. Revisit if this ever needs to model a
 * generic-wrapped return type.
 *
 * Known limit, deliberately not closed (#4484): a COMPOSITE return type
 * whose first token opens a bracket and then continues past its close —
 * `): { a: X } | null {`, `): [A, B] & C {` — fails differently from the
 * generic-wrapped case just above. `matchBracket` correctly closes the
 * type's own group, but the token right past it is `|` or `&` rather than
 * `{`, so the `if (src[after] === '{') bodyBrace = after` branch below
 * doesn't fire and `bodyBrace` is left on the type's own opening brace.
 * That character IS `{`, so the `src[bodyBrace] !== '{'` fallback never
 * runs either — the function returns a position inside the TYPE, not the
 * body. Same loud-failure property as the case above (a misread body reads
 * the wrong text and fails an assertion rather than passing silently), so
 * this is a docstring completeness point, not a defect.
 *
 * Known limit, deliberately not closed (#4484): `parenStart` below assumes
 * the first `(` after the function name opens the parameter list. A type
 * parameter list containing a paren ahead of the real one —
 * `function SelectionBubbleMenu<T extends (x: A) => B>(props)` — makes this
 * scan the type parameter's own group instead of the real parameter list.
 */
function findFunctionBodyStart(src: string, functionName: string): number | null {
  const marker = `function ${functionName}`
  // A bare `indexOf` would match `function ${functionName}Header` too, since
  // that text starts with `marker` — silently scanning the WRONG function's
  // body. Require the character right after the name to not continue an
  // identifier (whitespace or `(` in real source; end-of-string is rejected
  // too, since a function declaration always has a parameter list after its
  // name).
  //
  // Known limit, deliberately not closed: this scans raw source, so a COMMENT
  // earlier in the file containing the literal text `function SelectionBubbleMenu`
  // would seed a match here. Closing it needs trivia tracking from offset 0,
  // which is disproportionate for a guard that reads one known file — and the
  // failure is loud (a thrown "could not find" or a red assertion), never a
  // silent pass. Revisit only if this helper is ever reused elsewhere.
  let fnStart = -1
  for (let searchFrom = 0; ;) {
    const idx = src.indexOf(marker, searchFrom)
    if (idx === -1) return null
    const next = src[idx + marker.length]
    if (next !== undefined && !/[A-Za-z0-9_$]/.test(next)) {
      fnStart = idx
      break
    }
    searchFrom = idx + 1
  }

  const parenStart = src.indexOf('(', fnStart + marker.length)
  if (parenStart === -1) return null

  // #4484 — was a second hand-rolled quote/comment-aware paren-depth loop
  // here, near-verbatim to `matchBracket` above except for counting only
  // parens. Delegating gives that up for nothing: `findMatchingBracket`
  // counts only the OPENER'S OWN kind — here `(` and `)`, ignoring any
  // `{`/`[` nested in between — which is exactly what the loop it replaces
  // did, and it skips comment and string/template/regex contents on top of
  // that. So a default value, type annotation, or comment containing `(`,
  // `)`, or a quote character (e.g. `blockId, // the block we don't own`)
  // can't miscount it either way. One copy cannot drift from itself.
  const parenClose = matchBracket(src, parenStart)
  if (parenClose === -1) return null
  const parenEnd = parenClose - 1

  // The parameter list may be followed by a return type annotation before
  // the body's own `{` (`): React.ReactElement {`, or an inline object
  // return type, `): { node: React.ReactElement } {`). A bare
  // `indexOf('{', parenEnd)` finds the object type's own brace in the
  // second case and scans that instead of the body. Skip an optional
  // `: <type>` first: if the type itself opens a bracket group, match it and
  // check what immediately follows — a complete return type is always
  // followed directly (ignoring trivia) by the body's `{`, so landing on `{`
  // right after closing the group means THAT is the body. Otherwise the
  // group we matched was the body all along (a brace-free return type, or a
  // type shape this scan doesn't specifically model), so leave it in place
  // rather than walk past it.
  let bodyBrace = skipTrivia(src, parenEnd + 1)
  if (src[bodyBrace] === ':') {
    bodyBrace = skipTrivia(src, bodyBrace + 1)
    const opener = src[bodyBrace]
    if (opener === '{' || opener === '[' || opener === '(') {
      const groupEnd = matchBracket(src, bodyBrace)
      if (groupEnd === -1) return null
      const after = skipTrivia(src, groupEnd)
      if (src[after] === '{') bodyBrace = after
    }
  }
  if (src[bodyBrace] !== '{') {
    bodyBrace = src.indexOf('{', bodyBrace)
  }
  if (bodyBrace === -1) return null
  return bodyBrace + 1
}

/**
 * True iff `directiveText` appears somewhere in the leading run of bare
 * string-literal statements at the start of `functionName`'s body — the JS
 * directive prologue, which is what the React Compiler actually reads (per
 * the ECMA-262 grammar, every entry in that leading run is a directive, not
 * just the first one). A REAL statement ahead of the run breaks it — the
 * silent regression #4469 documents — but another directive ahead of
 * `directiveText` (e.g. a leading `'use client'`) does not, so this walks
 * the whole run instead of only checking the very first token. Named for
 * that semantics rather than `isDirectiveFirstStatement` (this file's own
 * prior name): the directive need not be first, only somewhere in the
 * prologue, and a name asserting otherwise is the exact misreading this
 * guard exists to correct (#4475 note 4).
 *
 * Known limit, deliberately not closed (#4484): a prologue entry is
 * accepted the moment its raw literal text equals `directiveText`, without
 * confirming the literal is a COMPLETE expression statement — a body
 * opening with `'use no memo' + x` (a real binary expression, not a
 * directive) would report true. The converse direction fails closed (a
 * genuine directive is never missed), so this is a caveat on the positive
 * case, not a defect worth a statement-boundary check.
 */
function isDirectiveInPrologue(src: string, functionName: string, directiveText: string): boolean {
  const bodyStart = findFunctionBodyStart(src, functionName)
  if (bodyStart === null) {
    throw new Error(
      `Could not find \`function ${functionName}(...) { ... }\` in the given source — only ` +
        `\`function <name>\` declarations are recognised, not e.g. a ` +
        `\`const ${functionName} = (...) => { ... }\` arrow-function form`,
    )
  }
  let i = skipTrivia(src, bodyStart)
  for (;;) {
    const quote = src[i]
    if (quote !== '"' && quote !== "'") return false
    // Escape-aware, mirroring `matchBracket`: a bare `indexOf(quote, i + 1)`
    // would treat an escaped quote (`\'`) inside a prologue entry as the
    // literal's end, truncating the slice and resuming the walk mid-literal
    // (#4475 note 3).
    let close = i + 1
    for (;;) {
      if (close >= src.length) return false
      if (src[close] === '\\') {
        close += 2
        continue
      }
      if (src[close] === quote) break
      close++
    }
    if (src.slice(i + 1, close) === directiveText) return true
    i = skipTrivia(src, close + 1)
    if (src[i] === ';') i = skipTrivia(src, i + 1)
  }
}

describe(`SelectionBubbleMenu — '${DIRECTIVE}' directive position (#4469, #4471 note 3)`, () => {
  it('is in the live component body directive prologue', () => {
    const source = readFileSync(COMPONENT_PATH, 'utf8')
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('detector sanity: accepts a body where the directive genuinely leads', () => {
    const source = `
      function ${COMPONENT_NAME}({ editor }: Props) {
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('detector sanity: rejects a body where a statement precedes the directive', () => {
    const source = `
      function ${COMPONENT_NAME}({ editor }: Props) {
        const { t } = useTranslation()
        '${DIRECTIVE}'
        return t
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(false)
  })

  it('detector sanity: rejects a body whose leading string literal is not the directive', () => {
    const source = `
      function ${COMPONENT_NAME}() {
        // a leading comment doesn't change which statement is first
        'not the directive'
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(false)
  })

  it('does not mistake a same-name-prefixed sibling function for the real component (#4475 note 1)', () => {
    const source = `
      function ${COMPONENT_NAME}Header(props: HeaderProps): React.ReactElement {
        const notTheDirective = 'not the directive'
        return null
      }

      function ${COMPONENT_NAME}({ editor }: Props) {
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it("does not confuse an inline object return type's brace for the body's (#4475 note 2)", () => {
    const source = `
      function ${COMPONENT_NAME}(props: Props): { node: React.ReactElement } {
        '${DIRECTIVE}'
        return { node: null }
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('does not let an apostrophe inside a `//` comment in the parameter list swallow the real `)` (#4475 note 3)', () => {
    const source = `
      function ${COMPONENT_NAME}(
        editor, // the block we don't own
      ): React.ReactElement {
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('does not let an apostrophe inside a `/* */` comment in the parameter list swallow the real `)` (#4475 note 3)', () => {
    const source = `
      function ${COMPONENT_NAME}(
        editor, /* the block we don't own */
      ): React.ReactElement {
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('does not let an apostrophe inside a comment in an inline object return type swallow the real `}` (#4475 second-review note 2)', () => {
    const source = `
      function ${COMPONENT_NAME}(props: Props): { /* the node we don't own */ node: React.ReactElement } {
        '${DIRECTIVE}'
        return { node: null }
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('does not let an escaped quote inside a prologue entry end the literal scan early (#4475 second-review note 3)', () => {
    const source = `
      function ${COMPONENT_NAME}({ editor }: Props) {
        'it\\'s a prologue entry, not the directive'
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('accepts the directive when another directive precedes it in the prologue (#4475 note 4)', () => {
    const source = `
      function ${COMPONENT_NAME}({ editor }: Props) {
        'use client'
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('still rejects the directive when a real statement interrupts the prologue ahead of it', () => {
    const source = `
      function ${COMPONENT_NAME}({ editor }: Props) {
        'use client'
        const ok = 1
        '${DIRECTIVE}'
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(false)
  })

  it('does not let a block comment between the body brace and the directive stop the prologue scan (#4484)', () => {
    // The live component and every other fixture in this file put a `//`
    // line comment (if any) between the body's opening brace and the
    // directive, so `skipTrivia`'s block-comment branch had no fixture
    // reaching it through this call site.
    const source = `
      function ${COMPONENT_NAME}({ editor }: Props) {
        /* a block comment before the directive */
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('fails loud (throws) rather than silently misreading the prologue when the parameter list holds an unterminated string (#4484)', () => {
    // `matchBracket` delegates to `findMatchingBracket` (#4484), which throws
    // `ScanError` on an unterminated string/template literal in the scanned
    // range instead of returning -1 the way the old hand-rolled loop here
    // did. Nothing in this file's other fixtures reaches that path — they are
    // all well-formed — so this pins the one thing that matters about it:
    // an unclosed string still reddens this guard loudly, it does not make
    // `isDirectiveInPrologue` return a wrong boolean silently.
    const source = `
      function ${COMPONENT_NAME}({ editor = 'never closes
        return editor
      }
    `
    // Asserts the SPECIFIC error, not just "throws something": if a future
    // change caught `ScanError` here and mapped it back to -1 (matching the
    // old loop's quiet behaviour), `findFunctionBodyStart` would return null
    // and this would still throw — but the generic, misleading "Could not
    // find `function ... { ... }`" message instead of one naming what
    // actually went wrong.
    expect(() => isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toThrow(/unterminated/)
  })

  it('resolves correctly when the sibling-prefix, return-type, and comment fixes all apply together', () => {
    const source = `
      function ${COMPONENT_NAME}Header(props: HeaderProps): React.ReactElement {
        return null
      }

      function ${COMPONENT_NAME}(
        editor, // the block we don't own
        blockId, /* also not a quote */
      ): { node: React.ReactElement } {
        '${DIRECTIVE}'
        return { node: null }
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('does not let a bracket character inside a quoted default value in the parameter list miscount the parameter-list depth (#4475 third-review note 1)', () => {
    const source = `
      function ${COMPONENT_NAME}(sep = '(', flag) {
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('does not let an escaped quote inside a quoted default value in the parameter list end the string early (#4475 third-review note 1)', () => {
    const source = `
      function ${COMPONENT_NAME}(sep = 'a\\'(b)', flag) {
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('does not let a bracket character inside a quoted string-literal return type miscount the group `matchBracket` scans (#4475 third-review note 1)', () => {
    const source = `
      function ${COMPONENT_NAME}(props: Props): { closer: '}' } {
        '${DIRECTIVE}'
        return { closer: '}' }
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('does not let an escaped quote inside a quoted string-literal return type end the string early in `matchBracket` (#4475 third-review note 1)', () => {
    const source = `
      function ${COMPONENT_NAME}(props: Props): { closer: 'a\\'(b)' } {
        '${DIRECTIVE}'
        return { closer: 'a\\'(b)' }
      }
    `
    expect(isDirectiveInPrologue(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })
})
