import { describe, expect, it } from 'vitest'
import { tokenize } from '../tokenize'

describe('tokenize', () => {
  it('returns no tokens for empty input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })

  it('splits whitespace-delimited words', () => {
    const tokens = tokenize('foo bar baz')
    expect(tokens).toHaveLength(3)
    expect(tokens[0]).toMatchObject({ kind: 'word', text: 'foo', span: [0, 3] })
    expect(tokens[1]).toMatchObject({ kind: 'word', text: 'bar', span: [4, 7] })
    expect(tokens[2]).toMatchObject({ kind: 'word', text: 'baz', span: [8, 11] })
  })

  it('preserves quoted phrases with internal whitespace', () => {
    const tokens = tokenize('"hello world" foo')
    expect(tokens[0]).toMatchObject({
      kind: 'quoted',
      text: '"hello world"',
      span: [0, 13],
    })
    expect(tokens[1]).toMatchObject({ kind: 'word', text: 'foo' })
  })

  it('falls back to word when quote is unmatched', () => {
    const tokens = tokenize('"unmatched start')
    const [t0, t1] = tokens
    expect(t0).toBeDefined()
    expect(t1).toBeDefined()
    if (!t0 || !t1) throw new Error('expected two tokens')
    expect(t0.kind).toBe('word')
    expect(t0.text).toBe('"unmatched')
    expect(t1.text).toBe('start')
  })

  it('treats internal quotes as part of the word', () => {
    const tokens = tokenize('say"hello')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ kind: 'word', text: 'say"hello' })
  })

  it('keeps colon-prefixed tokens as one word', () => {
    const tokens = tokenize('tag:#urgent path:Journal/*')
    expect(tokens).toHaveLength(2)
    const [t0, t1] = tokens
    if (!t0 || !t1) throw new Error('expected two tokens')
    expect(t0.text).toBe('tag:#urgent')
    expect(t1.text).toBe('path:Journal/*')
  })

  it('requires the closing quote at a token boundary (DSL-1)', () => {
    // `"a"b` — the inner `"` is glued to `b`, so it is not a clean
    // phrase close; the whole run degrades to a single word rather than
    // a fragmented phrase + word.
    const tokens = tokenize('"a"b')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ kind: 'word', text: '"a"b' })
  })

  it('a deliberately quoted phrase swallows a filter-shaped token (DSL-1 contract)', () => {
    // This is *correct* quote behaviour, documented as a regression
    // guard: once the user quotes a span, structured tokens inside it
    // are literal phrase text, not filters.
    const tokens = tokenize('hello "world tag:#x more"')
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toMatchObject({ kind: 'word', text: 'hello' })
    expect(tokens[1]).toMatchObject({ kind: 'quoted', text: '"world tag:#x more"' })
  })

  it('preserves Unicode characters', () => {
    const tokens = tokenize('tag:#日本語 #emoji-📌')
    const [t0, t1] = tokens
    if (!t0 || !t1) throw new Error('expected two tokens')
    expect(t0.text).toBe('tag:#日本語')
    expect(t1.text).toBe('#emoji-📌')
  })
})
