import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Guards PR #4471's non-blocking review note 3: the `'use no memo'`
 * directive that opts `SelectionBubbleMenu` out of React Compiler
 * memoisation (see the comment above the directive in the component itself
 * — a cached `<BubbleMenu>` element froze the mermaid-in-code-block subtree
 * and broke `e2e/mobile-editor.spec.ts`, #4469) only takes effect as the
 * FIRST statement of the function body. A statement placed above it
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
 */

const COMPONENT_PATH = join(__dirname, '../SelectionBubbleMenu.tsx')
const COMPONENT_NAME = 'SelectionBubbleMenu'
const DIRECTIVE = 'use no memo'

/**
 * Locate the index just after the opening `{` of `function <name>(...) {`'s
 * body: skip the parameter list (paren-depth + quote/template aware, so a
 * default value or type annotation containing `(`, `)`, or a string can't
 * miscount it) and return the position right after the first top-level `{`
 * that follows the parameter list's matching `)` — the body's own opening
 * brace. Returns null if `functionName` isn't found as a function
 * declaration in `src`.
 */
export function findFunctionBodyStart(src: string, functionName: string): number | null {
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

  const bodyBrace = src.indexOf('{', parenEnd)
  if (bodyBrace === -1) return null
  return bodyBrace + 1
}

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
 * True iff the FIRST non-trivia content inside `functionName`'s body is a
 * quoted string literal exactly equal to `directiveText` — i.e. the
 * directive prologue is genuinely the first statement, with nothing (not
 * even another statement) ahead of it. A statement, a different string
 * literal, or anything else preceding it fails this — exactly the silent
 * regression #4469 documents.
 */
export function isDirectiveFirstStatement(
  src: string,
  functionName: string,
  directiveText: string,
): boolean {
  const bodyStart = findFunctionBodyStart(src, functionName)
  if (bodyStart === null) {
    throw new Error(`Could not find \`function ${functionName}(...) { ... }\` in the given source`)
  }
  const i = skipTrivia(src, bodyStart)
  const quote = src[i]
  if (quote !== '"' && quote !== "'") return false
  const close = src.indexOf(quote, i + 1)
  if (close === -1) return false
  return src.slice(i + 1, close) === directiveText
}

describe(`SelectionBubbleMenu — '${DIRECTIVE}' directive position (#4469, #4471 note 3)`, () => {
  it('is the first statement of the live component body', () => {
    const source = readFileSync(COMPONENT_PATH, 'utf8')
    expect(isDirectiveFirstStatement(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('detector sanity: accepts a body where the directive genuinely leads', () => {
    const source = `
      function ${COMPONENT_NAME}({ editor }: Props) {
        '${DIRECTIVE}'
        const ok = 1
        return ok
      }
    `
    expect(isDirectiveFirstStatement(source, COMPONENT_NAME, DIRECTIVE)).toBe(true)
  })

  it('detector sanity: rejects a body where a statement precedes the directive', () => {
    const source = `
      function ${COMPONENT_NAME}({ editor }: Props) {
        const { t } = useTranslation()
        '${DIRECTIVE}'
        return t
      }
    `
    expect(isDirectiveFirstStatement(source, COMPONENT_NAME, DIRECTIVE)).toBe(false)
  })

  it('detector sanity: rejects a body whose leading string literal is not the directive', () => {
    const source = `
      function ${COMPONENT_NAME}() {
        // a leading comment doesn't change which statement is first
        'not the directive'
      }
    `
    expect(isDirectiveFirstStatement(source, COMPONENT_NAME, DIRECTIVE)).toBe(false)
  })
})
