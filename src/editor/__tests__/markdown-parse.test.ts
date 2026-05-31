/**
 * Tests for `markdown-parse.ts` behaviors not covered elsewhere.
 *
 * The bulk of `parse()` coverage lives in `markdown-serializer.test.ts` and
 * `markdown-serializer.property.test.ts`. This file pins behaviors that need
 * the logger mocked (FE-L-7: depth-limit truncation now emits a debug log).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { logger } from '../../lib/logger'
import { parse } from '../markdown-parse'
import { serialize } from '../markdown-serialize'
import { bold, doc, italic, paragraph, text } from './builders'

describe('parse — depth-limit truncation (FE-L-7)', () => {
  beforeEach(() => {
    vi.mocked(logger.debug).mockClear()
  })

  it('logs at debug level when depth exceeds MAX_PARSE_DEPTH', () => {
    // Calling parse with depth=11 directly trips the guard on the first
    // invocation, regardless of input shape.
    parse('> quoted', 11)

    expect(logger.debug).toHaveBeenCalledWith(
      'markdown-parse',
      'depth limit reached, truncating',
      expect.objectContaining({ depth: 11, maxDepth: 10, length: '> quoted'.length }),
    )
  })
})

describe('parse — GFM underscore emphasis (#211)', () => {
  it('parses _italic_ as an italic mark', () => {
    expect(parse('_italic_')).toEqual(doc(paragraph(italic('italic'))))
  })

  it('parses __bold__ as a bold mark', () => {
    expect(parse('__bold__')).toEqual(doc(paragraph(bold('bold'))))
  })

  it('leaves intraword snake_case literal (no marks)', () => {
    expect(parse('snake_case')).toEqual(doc(paragraph(text('snake_case'))))
  })

  it('leaves intraword a_b_c literal (no marks)', () => {
    expect(parse('a_b_c')).toEqual(doc(paragraph(text('a_b_c'))))
  })

  it('emphasises a word-bounded _bar_ in a sentence', () => {
    expect(parse('foo _bar_ baz')).toEqual(
      doc(paragraph(text('foo '), italic('bar'), text(' baz'))),
    )
  })

  it('handles mixed __bold__ and _italic_ in one line', () => {
    expect(parse('__bold__ and _italic_')).toEqual(
      doc(paragraph(bold('bold'), text(' and '), italic('italic'))),
    )
  })

  it('accepts both asterisk and underscore italic on one line', () => {
    expect(parse('*aster* _under_')).toEqual(
      doc(paragraph(italic('aster'), text(' '), italic('under'))),
    )
  })

  it('emphasises a standalone __dunder__ token (only word-flanked underscores stay literal)', () => {
    // Strict CommonMark: `__dunder__` opens/closes at line boundaries, so it IS
    // bold — same as `__bold__`. Only word-flanked `_` (snake_case) stays literal.
    expect(parse('__dunder__')).toEqual(doc(paragraph(bold('dunder'))))
  })

  it('reverts an unclosed _foo to literal text', () => {
    expect(parse('_foo')).toEqual(doc(paragraph(text('_foo'))))
  })

  it('reverts an unclosed __foo to literal text', () => {
    expect(parse('__foo')).toEqual(doc(paragraph(text('__foo'))))
  })

  it('serializes underscore italic back to canonical asterisk', () => {
    expect(serialize(parse('_italic_'))).toBe('*italic*')
  })

  it('serializes underscore bold back to canonical asterisk', () => {
    expect(serialize(parse('__bold__'))).toBe('**bold**')
  })

  it('serializes literal underscores WITHOUT backslash escaping', () => {
    expect(serialize(parse('snake_case'))).toBe('snake_case')
    expect(serialize(parse('a_b'))).toBe('a_b')
  })

  it('round-trips (parse∘serialize is stable) for underscore inputs', () => {
    for (const input of ['_italic_', '__bold__', 'snake_case', 'a_b_c', 'foo _bar_ baz']) {
      const once = serialize(parse(input))
      const twice = serialize(parse(once))
      expect(twice).toBe(once)
    }
  })

  it('leaves "_ italic _" literal (inner-space underscores never open/close)', () => {
    // CommonMark: a `_` followed by whitespace is not a left-flanking delimiter,
    // so it cannot open emphasis — the run stays literal plain text.
    expect(parse('_ italic _')).toEqual(doc(paragraph(text('_ italic _'))))
  })

  it('emphasises punctuation-flanked (_x_) inside parentheses', () => {
    expect(parse('(_x_)')).toEqual(doc(paragraph(text('('), italic('x'), text(')'))))
  })

  it('leaves cross-delimiter _foo* literal (never closes)', () => {
    expect(parse('_foo*')).toEqual(doc(paragraph(text('_foo*'))))
  })
})
