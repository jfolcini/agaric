import { describe, expect, it } from 'vitest'

// The script is plain ESM (.mjs); `detectImports` is a pure, I/O-free export.
// Importing it does NOT trigger the src/ scan (the CLI body is guarded behind
// a direct-invocation check), so this stays a fast unit test.
// @ts-expect-error — no type declarations for the .mjs script.
import { detectImports } from '../../scripts/check-import-cycles.mjs'

/**
 * Guards the #868 fix: the import detector must remain context-aware so
 * import-shaped text inside a string or template literal never registers a
 * phantom edge (false-FAILing a legit PR), while real import/export
 * specifiers — themselves quoted strings — still survive.
 */
describe('check-import-cycles detectImports', () => {
  it('(1) detects a real static import specifier', () => {
    expect(detectImports(`import { x } from './foo'`)).toContain('./foo')
  })

  it('(2) does NOT detect an import inside a template literal', () => {
    const src = "const code = `import { y } from './bar'`"
    expect(detectImports(src)).not.toContain('./bar')
  })

  it('(3) detects a real dynamic import()', () => {
    expect(detectImports(`const m = await import('./baz')`)).toContain('./baz')
  })

  it('(4) does NOT detect an import inside a value-position string', () => {
    const src = `const s = "import q from './qux'"`
    expect(detectImports(src)).not.toContain('./qux')
  })

  it('(5) does NOT detect imports inside // line or /* */ block comments', () => {
    const line = `// import a from './lc'`
    const block = `/* import b from './bc' */`
    expect(detectImports(line)).not.toContain('./lc')
    expect(detectImports(block)).not.toContain('./bc')
    // A comment on the same line as real code must not eat the real import.
    const mixed = `import { r } from './real' // import f from './fake'`
    const specs = detectImports(mixed)
    expect(specs).toContain('./real')
    expect(specs).not.toContain('./fake')
  })

  it('keeps real imports alongside string/template decoys in one file', () => {
    const src = [
      `import { a } from './a'`,
      `import type { B } from './b'`,
      `export { c } from './c'`,
      "const tmpl = `import { z } from './decoy-tmpl'`",
      `const str = "import w from './decoy-str'"`,
      `// import v from './decoy-comment'`,
      `const dyn = import('./d')`,
    ].join('\n')
    const specs = detectImports(src)
    expect(specs).toEqual(expect.arrayContaining(['./a', './b', './c', './d']))
    expect(specs).not.toContain('./decoy-tmpl')
    expect(specs).not.toContain('./decoy-str')
    expect(specs).not.toContain('./decoy-comment')
  })

  it('handles escaped quotes inside a decoy string without leaking an edge', () => {
    // The escaped quote must not prematurely close the string and expose the
    // trailing text to the regex in code position.
    const src = `const s = "x = \\"import p from './esc'\\""`
    expect(detectImports(src)).not.toContain('./esc')
  })
})
