/**
 * Tests for KaTeX/LaTeX math markdown support (#1437).
 *
 * Covers inline `$…$` and block `$$…$$` parsing, serialization, the
 * round-trip stability of both, and the `$`-disambiguation rules that keep a
 * currency amount (`$5`) or an escaped `\$` from becoming math.
 */
import { describe, expect, it } from 'vitest'

import { parse } from '../markdown-parse'
import { serialize } from '../markdown-serialize'
import type { DocNode, MathBlockNode, MathInlineNode, ParagraphNode, TextNode } from '../types'

/** First block of a parsed doc. */
function firstBlock(md: string) {
  return (parse(md) as DocNode).content?.[0]
}

/** Inline content nodes of the first paragraph. */
function firstParaContent(md: string) {
  const block = firstBlock(md) as ParagraphNode
  return block.content ?? []
}

describe('inline math `$…$` — parse (#1437)', () => {
  it('parses `$a^2$` as a math_inline node carrying the raw LaTeX', () => {
    const content = firstParaContent('$a^2$')
    expect(content).toEqual([{ type: 'math_inline', attrs: { latex: 'a^2' } }])
  })

  it('parses inline math surrounded by text', () => {
    const content = firstParaContent('see $a^2$ here')
    expect(content).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'math_inline', attrs: { latex: 'a^2' } },
      { type: 'text', text: ' here' },
    ])
  })

  it('does NOT treat `$5` as math (currency)', () => {
    const content = firstParaContent('$5')
    expect(content).toEqual([{ type: 'text', text: '$5' }])
  })

  it('does NOT treat `cost is $5 and $10` as math (currency, two dollars)', () => {
    const content = firstParaContent('cost is $5 and $10')
    expect(content).toEqual([{ type: 'text', text: 'cost is $5 and $10' }])
  })

  it('does NOT open math when the `$` is followed by a space', () => {
    const content = firstParaContent('a $ b $ c')
    // No valid open (space after `$`), so the text stays literal.
    expect(content).toEqual([{ type: 'text', text: 'a $ b $ c' }])
  })

  it('does NOT close math when the closing `$` is preceded by a space', () => {
    const content = firstParaContent('$x $')
    // `$x ` has a space before the closing `$` → not a valid closer → literal.
    expect(content).toEqual([{ type: 'text', text: '$x $' }])
  })

  it('keeps `\\$` literal (escaped dollar, not math)', () => {
    const content = firstParaContent('\\$x\\$')
    expect(content).toEqual([{ type: 'text', text: '$x$' }])
  })

  it('leaves a `$` inside a code span untouched', () => {
    const content = firstParaContent('`$x$`')
    expect(content).toEqual([{ type: 'text', text: '$x$', marks: [{ type: 'code' }] }])
  })

  it('honours `\\$` escapes inside a math span (does not close early)', () => {
    const content = firstParaContent('$a\\$b$')
    expect(content).toEqual([{ type: 'math_inline', attrs: { latex: 'a\\$b' } }])
  })
})

describe('block math `$$…$$` — parse (#1437)', () => {
  it('parses a multi-line `$$…$$` block', () => {
    const block = firstBlock('$$\n\\int_0^1 x\\,dx\n$$')
    expect(block).toEqual({ type: 'math_block', attrs: { latex: '\\int_0^1 x\\,dx' } })
  })

  it('parses a single-line `$$ … $$` block', () => {
    const block = firstBlock('$$ E = mc^2 $$')
    expect(block).toEqual({ type: 'math_block', attrs: { latex: 'E = mc^2' } })
  })

  it('does NOT treat a lone `$$` with no closer as a math block', () => {
    // An unterminated opening fence falls back to ordinary text.
    const block = firstBlock('$$\nx + y')
    expect((block as { type: string }).type).not.toBe('math_block')
  })
})

describe('inline math — serialize (#1437)', () => {
  it('serializes a math_inline node back to `$…$`', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'math_inline', attrs: { latex: 'a^2' } } as MathInlineNode],
        },
      ],
    }
    expect(serialize(doc)).toBe('$a^2$')
  })

  it('escapes a literal `$` that would open math on reparse', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'price $x dollars' } as TextNode] },
      ],
    }
    // `$x` would re-open math, so the serializer escapes the `$`.
    expect(serialize(doc)).toBe('price \\$x dollars')
  })

  it('does NOT escape a `$` before a digit (currency stays readable)', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '$5' } as TextNode] }],
    }
    expect(serialize(doc)).toBe('$5')
  })
})

describe('block math — serialize (#1437)', () => {
  it('serializes a math_block node to a `$$…$$` fence', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'math_block', attrs: { latex: '\\int_0^1 x\\,dx' } } as MathBlockNode],
    }
    expect(serialize(doc)).toBe('$$\n\\int_0^1 x\\,dx\n$$')
  })
})

describe('round-trip stability (#1437)', () => {
  it('inline `$a^2$` parse → serialize is stable', () => {
    expect(serialize(parse('$a^2$'))).toBe('$a^2$')
  })

  it('block `$$\\int_0^1 x\\,dx$$` parse → serialize is stable', () => {
    const md = '$$\n\\int_0^1 x\\,dx\n$$'
    expect(serialize(parse(md))).toBe(md)
  })

  it('single-line `$$ E = mc^2 $$` normalizes to the multi-line fence and is then stable', () => {
    const once = serialize(parse('$$ E = mc^2 $$'))
    expect(once).toBe('$$\nE = mc^2\n$$')
    // serialize∘parse is a fixed point on the canonical form.
    expect(serialize(parse(once))).toBe(once)
  })

  it('currency text `cost is $5 and $10` round-trips unchanged', () => {
    const md = 'cost is $5 and $10'
    expect(serialize(parse(md))).toBe(md)
  })

  it('escaped `\\$x\\$` stays literal `$` and reaches a stable serialize∘parse fixed point', () => {
    // `\$x\$` parses to the literal text `$x$`. On serialize the leading `$`
    // (followed by `x`) is re-escaped to keep it from opening math, while the
    // trailing `$` (end of text, cannot open math) is left bare — a canonical
    // form. serialize∘parse is then a fixed point (lossless, never math).
    const once = serialize(parse('\\$x\\$'))
    expect(once).toBe('\\$x$')
    expect(serialize(parse(once))).toBe(once)
    // And it never becomes math.
    const content = (parse(once) as DocNode).content?.[0] as ParagraphNode
    expect(content.content).toEqual([{ type: 'text', text: '$x$' }])
  })

  it('inline math mixed with text round-trips', () => {
    const md = 'see $a^2$ here'
    expect(serialize(parse(md))).toBe(md)
  })
})
