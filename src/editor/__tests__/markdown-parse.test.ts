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
import { bold, bulletList, doc, italic, listItem, paragraph, task, text } from './builders'

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

describe('parse — bare-URL & angle autolinks (#1441)', () => {
  /** A text node carrying just a link mark (text === href is the common case). */
  const link = (t: string, href = t) => text(t, [{ type: 'link', attrs: { href } }])

  it('autolinks a bare https:// URL in text (acceptance criterion)', () => {
    expect(parse('https://example.com')).toEqual(doc(paragraph(link('https://example.com'))))
  })

  it('autolinks a bare http:// URL', () => {
    expect(parse('http://example.com')).toEqual(doc(paragraph(link('http://example.com'))))
  })

  it('autolinks a bare URL embedded in a sentence', () => {
    expect(parse('see https://example.com here')).toEqual(
      doc(paragraph(text('see '), link('https://example.com'), text(' here'))),
    )
  })

  it('autolinks an <https://…> angle-bracket autolink', () => {
    expect(parse('<https://example.com>')).toEqual(doc(paragraph(link('https://example.com'))))
  })

  it('keeps a trailing period as text (GFM trailing-punctuation trim)', () => {
    expect(parse('https://example.com.')).toEqual(
      doc(paragraph(link('https://example.com'), text('.'))),
    )
  })

  it('keeps trailing sentence punctuation (comma) as text', () => {
    expect(parse('see https://example.com, ok')).toEqual(
      doc(paragraph(text('see '), link('https://example.com'), text(', ok'))),
    )
  })

  it('does NOT re-link a URL already inside [text](url) syntax', () => {
    expect(parse('[text](https://example.com)')).toEqual(
      doc(paragraph(link('text', 'https://example.com'))),
    )
  })

  it('does NOT re-link a URL whose display text is the URL in [url](url)', () => {
    // The explicit link wins; the bare-URL scanner never sees the inner URL.
    expect(parse('[https://example.com](https://example.com)')).toEqual(
      doc(paragraph(link('https://example.com', 'https://example.com'))),
    )
  })

  it('does NOT autolink an intraword http (left boundary)', () => {
    expect(parse('ahttps://example.com')).toEqual(doc(paragraph(text('ahttps://example.com'))))
  })

  it('keeps a balanced trailing paren in a Wikipedia-style URL', () => {
    expect(parse('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(
      doc(paragraph(link('https://en.wikipedia.org/wiki/Foo_(bar)'))),
    )
  })

  it('does NOT autolink a URL inside a code span (backticks win)', () => {
    // scanCodeSpan runs before scanAutolink, so the URL is raw code, not a link.
    expect(parse('inline `https://example.com` only')).toEqual(
      doc(
        paragraph(text('inline '), text('https://example.com', [{ type: 'code' }]), text(' only')),
      ),
    )
  })

  it('does NOT swallow a closing bold delimiter into the href (#1441 regression)', () => {
    // The bare-URL body only hard-stops at whitespace/`<`/`\`; without trimming
    // trailing mark delimiters the URL would eat the closing `**`, leaving bold
    // unclosed (reverted to literal text). The trailing `**` must close bold and
    // the link mark must sit ON the bolded URL text.
    expect(parse('**https://example.com**')).toEqual(
      doc(
        paragraph(
          text('https://example.com', [
            { type: 'bold' },
            { type: 'link', attrs: { href: 'https://example.com' } },
          ]),
        ),
      ),
    )
  })

  it('does NOT swallow a closing strike delimiter into the href (#1441)', () => {
    expect(parse('~~https://example.com~~')).toEqual(
      doc(
        paragraph(
          text('https://example.com', [
            { type: 'strike' },
            { type: 'link', attrs: { href: 'https://example.com' } },
          ]),
        ),
      ),
    )
  })

  it('trims a trailing pipe/bracket and round-trips them as escaped text (#1441)', () => {
    // A bare URL followed by a structural delimiter (`|` table gate, `]` label
    // close) must not absorb it; the delimiter stays literal text. The serializer
    // escapes it (`\|`/`\]`) and the bare-URL scanner hard-stops at the `\`, so
    // the next parse re-globs the URL identically (idempotent, no escape pileup).
    expect(parse('see https://example.com| end')).toEqual(
      doc(paragraph(text('see '), link('https://example.com'), text('| end'))),
    )
    expect(parse('see https://example.com] end')).toEqual(
      doc(paragraph(text('see '), link('https://example.com'), text('] end'))),
    )
    for (const input of [
      'see https://example.com| end',
      'see https://example.com] end',
      'https://example.com/path*glob*',
      '**https://example.com**',
      '~~https://example.com~~',
    ]) {
      const once = serialize(parse(input))
      expect(serialize(parse(once))).toBe(once)
    }
  })

  it('round-trips (parse→serialize) bare and angle autolinks losslessly', () => {
    // A bare URL stays bare (not `[url](url)`); an angle autolink normalizes to
    // the bare URL (the serializer's canonical, link-preserving form).
    expect(serialize(parse('https://example.com'))).toBe('https://example.com')
    expect(serialize(parse('see https://example.com here'))).toBe('see https://example.com here')
    expect(serialize(parse('https://example.com.'))).toBe('https://example.com.')
    expect(serialize(parse('<https://example.com>'))).toBe('https://example.com')
    expect(serialize(parse('[text](https://example.com)'))).toBe('[text](https://example.com)')

    // parse∘serialize is a stable fixed point for each.
    for (const input of [
      'https://example.com',
      'see https://example.com here',
      'https://example.com.',
      '<https://example.com>',
      '[text](https://example.com)',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]) {
      const once = serialize(parse(input))
      expect(serialize(parse(once))).toBe(once)
    }
  })
})

describe('parse — GFM task lists (#1435)', () => {
  it('parses "- [ ] a" as a TODO task block', () => {
    expect(parse('- [ ] a')).toEqual(doc(task('TODO', text('a'))))
  })

  it('parses "- [x] b" as a DONE task block', () => {
    expect(parse('- [x] b')).toEqual(doc(task('DONE', text('b'))))
  })

  it('parses "- [/] c" as a DOING task block', () => {
    expect(parse('- [/] c')).toEqual(doc(task('DOING', text('c'))))
  })

  it('parses "- [-] d" as a CANCELLED task block', () => {
    expect(parse('- [-] d')).toEqual(doc(task('CANCELLED', text('d'))))
  })

  it('does NOT turn a plain bullet into a task', () => {
    expect(parse('- item')).toEqual(doc(bulletList(listItem(paragraph(text('item'))))))
  })

  it('imports a multi-item GFM task list', () => {
    expect(parse('- [ ] one\n- [x] two')).toEqual(
      doc(task('TODO', text('one')), task('DONE', text('two'))),
    )
  })

  it('round-trips each state through serialize→parse', () => {
    for (const state of ['TODO', 'DOING', 'DONE', 'CANCELLED'] as const) {
      const original = doc(task(state, text('x')))
      expect(parse(serialize(original))).toEqual(original)
    }
  })
})
