import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

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
 * its matching close (bracket-depth, quote, and comment aware — any open
 * bracket type increments the same counter a matching close decrements,
 * which is enough for well-formed TS even when the group nests a different
 * bracket kind inside it). Returns -1 if the group is never closed.
 */
function matchBracket(src: string, openIdx: number): number {
  let depth = 0
  let quote: string | null = null
  for (let k = openIdx; k < src.length; k++) {
    const c = src[k]
    if (quote) {
      if (c === '\\') {
        k++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    // A comment inside the group is not string content: an apostrophe in
    // `/* the node we don't own */` must not latch `quote` and start
    // swallowing every real closing bracket looking for a `'` that could be
    // found anywhere later in the source (#4475 note 2 — the same fix as
    // the parameter-list loop below, applied here too).
    if (c === '/' && src[k + 1] === '/') {
      const nl = src.indexOf('\n', k)
      k = nl === -1 ? src.length : nl
      continue
    }
    if (c === '/' && src[k + 1] === '*') {
      const end = src.indexOf('*/', k + 2)
      k = end === -1 ? src.length : end + 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      continue
    }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') {
      depth--
      if (depth === 0) return k + 1
    }
  }
  return -1
}

/**
 * Locate the index just after the opening `{` of `function <name>(...) {`'s
 * body: skip the parameter list (paren-depth + quote/comment aware, so a
 * default value, type annotation, or comment containing `(`, `)`, or a
 * quote character can't miscount it), skip an optional return type
 * annotation, and return the position right after the body's own opening
 * brace. Returns null if `functionName` isn't found as a function
 * declaration in `src`.
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

  let depth = 0
  let quote: string | null = null
  let parenEnd = -1
  for (let j = parenStart; j < src.length; j++) {
    const c = src[j]
    if (quote) {
      if (c === '\\') {
        j++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    // A comment inside the parameter list is not string content: an
    // apostrophe in `blockId, // the block we don't own` must not latch
    // `quote` and start swallowing every real `)` looking for a closing `'`
    // that — with this file's own trailing directive strings around — can
    // be found anywhere later in the source, well past the real one.
    if (c === '/' && src[j + 1] === '/') {
      const nl = src.indexOf('\n', j)
      j = nl === -1 ? src.length : nl
      continue
    }
    if (c === '/' && src[j + 1] === '*') {
      const end = src.indexOf('*/', j + 2)
      j = end === -1 ? src.length : end + 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) {
        parenEnd = j
        break
      }
    }
  }
  if (parenEnd === -1) return null

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
 */
function isDirectiveInPrologue(src: string, functionName: string, directiveText: string): boolean {
  const bodyStart = findFunctionBodyStart(src, functionName)
  if (bodyStart === null) {
    throw new Error(`Could not find \`function ${functionName}(...) { ... }\` in the given source`)
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
})
