import { describe, expect, it } from 'vitest'
import { parse } from '../classify'

describe('classify / parse', () => {
  it('parses an empty string', () => {
    const ast = parse('')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('')
  })

  it('recognises tag: prefix', () => {
    const ast = parse('tag:#urgent')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.freeText).toBe('')
  })

  it('recognises bare #tag alias', () => {
    const ast = parse('#urgent')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
  })

  it('strips leading # inside tag: value', () => {
    const a = parse('tag:#x')
    const b = parse('tag:x')
    expect(a.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(b.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
  })

  it('recognises path: include and not-path: exclude', () => {
    const ast = parse('path:Journal/* not-path:Archive/**')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Journal/*' })
    expect(ast.filters[1]).toMatchObject({ kind: 'pathExclude', value: 'Archive/**' })
  })

  it('places free text into freeText, preserving order-agnostically', () => {
    const ast = parse('hello tag:#urgent world')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'urgent' })
    expect(ast.freeText).toBe('hello world')
  })

  it('rejects unknown filter keys as invalid tokens', () => {
    const ast = parse('foo:bar baz')
    expect(ast.filters).toHaveLength(1)
    const tok = ast.filters[0]
    expect(tok).toMatchObject({
      kind: 'invalid',
      source: 'foo:bar',
    })
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain("'foo:'")
    }
    expect(ast.freeText).toBe('baz')
  })

  it('flags malformed glob as invalid with InvalidGlob: prefix', () => {
    const ast = parse('path:[unclosed')
    expect(ast.filters).toHaveLength(1)
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toMatch(/^InvalidGlob:/)
      expect(tok.error).toContain('unbalanced bracket')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags brace nesting as invalid', () => {
    const ast = parse('path:{a,{b,c}}')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('brace nesting')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('flags empty tag: value as invalid', () => {
    const ast = parse('tag:')
    const tok = ast.filters[0]
    if (tok && tok.kind === 'invalid') {
      expect(tok.error).toContain('required')
    } else {
      throw new Error('expected invalid token')
    }
  })

  it('preserves Unicode tag names', () => {
    const ast = parse('tag:#日本語')
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: '日本語' })
  })

  it('passes quoted phrases through to free text verbatim', () => {
    const ast = parse('"exact phrase" tag:#x')
    expect(ast.filters).toHaveLength(1)
    expect(ast.filters[0]).toMatchObject({ kind: 'tag', value: 'x' })
    expect(ast.freeText).toContain('exact phrase')
  })

  it('does not treat boolean operators as filters', () => {
    const ast = parse('foo AND bar OR baz NOT quux')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('foo AND bar OR baz NOT quux')
  })

  it('falls back to substring-style bare token as freeText, not a filter', () => {
    // PEND-54 decision: bare tokens stay in freeText (FTS5 trigram
    // substring already covers the "match anywhere" use-case).
    const ast = parse('alpha')
    expect(ast.filters).toEqual([])
    expect(ast.freeText).toBe('alpha')
  })

  it('supports multiple path: tokens (AND across the IN clause)', () => {
    const ast = parse('path:Journal/* path:Notes/*')
    expect(ast.filters).toHaveLength(2)
    expect(ast.filters[0]).toMatchObject({ kind: 'pathInclude', value: 'Journal/*' })
    expect(ast.filters[1]).toMatchObject({ kind: 'pathInclude', value: 'Notes/*' })
  })

  it('accepts brace expansion', () => {
    const ast = parse('path:{Journal,Archive}/*')
    expect(ast.filters[0]).toMatchObject({
      kind: 'pathInclude',
      value: '{Journal,Archive}/*',
    })
  })

  it('records token spans pointing into the original input', () => {
    const input = '  tag:#urgent  '
    const ast = parse(input)
    const tok = ast.filters[0]
    if (!tok) throw new Error('expected a filter token')
    const span = tok.span
    expect(input.slice(span[0], span[1])).toBe('tag:#urgent')
  })
})
