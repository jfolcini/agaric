import { describe, expect, it, vi } from 'vitest'
import { parse, serialize } from '../markdown-serializer'
import type { InlineNode, ParagraphNode } from '../types'
import {
  blockLink,
  bold,
  boldItalic,
  code,
  doc,
  hardBreak,
  italic,
  paragraph,
  tagRef,
  text,
} from '../types'

// -- serialize ----------------------------------------------------------------

describe('serialize', () => {
  describe('plain text', () => {
    it('empty doc', () => {
      expect(serialize(doc())).toBe('')
    })

    it('empty doc with no content field', () => {
      expect(serialize({ type: 'doc' })).toBe('')
    })

    it('empty paragraph', () => {
      expect(serialize(doc(paragraph()))).toBe('')
    })

    it('plain text', () => {
      expect(serialize(doc(paragraph(text('hello world'))))).toBe('hello world')
    })

    it('whitespace-only', () => {
      expect(serialize(doc(paragraph(text('   '))))).toBe('   ')
    })

    it('paragraph with empty content array', () => {
      const p: ParagraphNode = { type: 'paragraph', content: [] }
      expect(serialize({ type: 'doc', content: [p] })).toBe('')
    })
  })

  describe('marks', () => {
    it('bold', () => {
      expect(serialize(doc(paragraph(bold('strong'))))).toBe('**strong**')
    })

    it('italic', () => {
      expect(serialize(doc(paragraph(italic('emphasis'))))).toBe('*emphasis*')
    })

    it('code', () => {
      expect(serialize(doc(paragraph(code('fn()'))))).toBe('`fn()`')
    })

    it('bold + italic (nested)', () => {
      expect(serialize(doc(paragraph(boldItalic('both'))))).toBe('***both***')
    })

    it('adjacent marks', () => {
      expect(serialize(doc(paragraph(bold('a'), text(' '), italic('b'))))).toBe('**a** *b*')
    })

    it('bold adjacent to plain text', () => {
      expect(serialize(doc(paragraph(text('before '), bold('mid'), text(' after'))))).toBe(
        'before **mid** after',
      )
    })

    it('code does not escape contents', () => {
      expect(serialize(doc(paragraph(code('**not bold**'))))).toBe('`**not bold**`')
    })

    it('bold+code marks — code wins, bold dropped', () => {
      const node = text('x', [{ type: 'bold' }, { type: 'code' }])
      expect(serialize(doc(paragraph(node)))).toBe('`x`')
    })

    it('mark ordering: italic-before-bold still produces ***text***', () => {
      const node = text('both', [{ type: 'italic' }, { type: 'bold' }])
      expect(serialize(doc(paragraph(node)))).toBe('***both***')
    })
  })

  describe('tokens', () => {
    it('tag_ref', () => {
      expect(serialize(doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))))).toBe(
        '#[01ARZ3NDEKTSV4RRFFQ69G5FAV]',
      )
    })

    it('block_link', () => {
      expect(serialize(doc(paragraph(blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'))))).toBe(
        '[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]',
      )
    })

    it('token adjacent to text', () => {
      expect(
        serialize(
          doc(paragraph(text('see '), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' here'))),
        ),
      ).toBe('see #[01ARZ3NDEKTSV4RRFFQ69G5FAV] here')
    })

    it('token at start of line', () => {
      expect(serialize(doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' end'))))).toBe(
        '#[01ARZ3NDEKTSV4RRFFQ69G5FAV] end',
      )
    })

    it('token at end of line', () => {
      expect(
        serialize(doc(paragraph(text('start '), blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV')))),
      ).toBe('start [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')
    })

    it('token adjacent to mark', () => {
      expect(serialize(doc(paragraph(bold('look: '), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))))).toBe(
        '**look: **#[01ARZ3NDEKTSV4RRFFQ69G5FAV]',
      )
    })
  })

  describe('special nodes', () => {
    it('hardBreak emits newline', () => {
      expect(serialize(doc(paragraph(text('a'), hardBreak(), text('b'))))).toBe('a\nb')
    })

    it('multiple paragraphs joined with newline', () => {
      expect(serialize(doc(paragraph(text('first')), paragraph(text('second'))))).toBe(
        'first\nsecond',
      )
    })

    it('unknown inline node stripped with warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const unknown = { type: 'unknown_node' } as unknown as InlineNode
      expect(serialize(doc(paragraph(text('a'), unknown, text('b'))))).toBe('ab')
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })

    it('unknown top-level node stripped with warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const unknown = { type: 'heading', content: [] } as unknown as ParagraphNode
      expect(serialize(doc(unknown, paragraph(text('ok'))))).toBe('\nok')
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })
  })

  describe('escaping', () => {
    it('escapes literal asterisk', () => {
      expect(serialize(doc(paragraph(text('a * b'))))).toBe('a \\* b')
    })

    it('escapes literal backtick', () => {
      expect(serialize(doc(paragraph(text('a ` b'))))).toBe('a \\` b')
    })

    it('escapes literal #[', () => {
      expect(serialize(doc(paragraph(text('use #[not a tag'))))).toBe('use \\#[not a tag')
    })

    it('escapes literal [[', () => {
      expect(serialize(doc(paragraph(text('use [[not a link'))))).toBe('use \\[[not a link')
    })

    it('escapes literal backslash', () => {
      expect(serialize(doc(paragraph(text('a \\ b'))))).toBe('a \\\\ b')
    })

    it('multiple escapes in one string', () => {
      expect(serialize(doc(paragraph(text('*`#['))))).toBe('\\*\\`\\#[')
    })

    it('lone # without [ is not escaped', () => {
      expect(serialize(doc(paragraph(text('a # b'))))).toBe('a # b')
    })

    it('lone [ without [[ is not escaped', () => {
      expect(serialize(doc(paragraph(text('a [ b'))))).toBe('a [ b')
    })
  })
})

// -- parse --------------------------------------------------------------------

describe('parse', () => {
  describe('plain text', () => {
    it('empty string', () => {
      expect(parse('')).toEqual({ type: 'doc' })
    })

    it('plain text', () => {
      expect(parse('hello world')).toEqual(doc(paragraph(text('hello world'))))
    })

    it('whitespace-only', () => {
      expect(parse('   ')).toEqual(doc(paragraph(text('   '))))
    })
  })

  describe('marks', () => {
    it('bold', () => {
      expect(parse('**strong**')).toEqual(doc(paragraph(bold('strong'))))
    })

    it('italic', () => {
      expect(parse('*emphasis*')).toEqual(doc(paragraph(italic('emphasis'))))
    })

    it('code', () => {
      expect(parse('`fn()`')).toEqual(doc(paragraph(code('fn()'))))
    })

    it('bold + italic nested', () => {
      expect(parse('***both***')).toEqual(doc(paragraph(boldItalic('both'))))
    })

    it('bold with surrounding text', () => {
      expect(parse('before **mid** after')).toEqual(
        doc(paragraph(text('before '), bold('mid'), text(' after'))),
      )
    })

    it('italic with surrounding text', () => {
      expect(parse('before *mid* after')).toEqual(
        doc(paragraph(text('before '), italic('mid'), text(' after'))),
      )
    })

    it('code with surrounding text', () => {
      expect(parse('before `mid` after')).toEqual(
        doc(paragraph(text('before '), code('mid'), text(' after'))),
      )
    })

    it('adjacent bold and italic', () => {
      expect(parse('**a** *b*')).toEqual(doc(paragraph(bold('a'), text(' '), italic('b'))))
    })

    it('code does not parse marks inside', () => {
      expect(parse('`**not bold**`')).toEqual(doc(paragraph(code('**not bold**'))))
    })

    it('code does not parse tokens inside', () => {
      expect(parse('`#[01ARZ3NDEKTSV4RRFFQ69G5FAV]`')).toEqual(
        doc(paragraph(code('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'))),
      )
    })

    it('italic inside bold', () => {
      expect(parse('**a *b* c**')).toEqual(doc(paragraph(bold('a '), boldItalic('b'), bold(' c'))))
    })

    it('bold then italic (different marks adjacent)', () => {
      expect(parse('**a***b*')).toEqual(doc(paragraph(bold('a'), italic('b'))))
    })
  })

  describe('unclosed marks', () => {
    it('unclosed bold becomes plain text', () => {
      expect(parse('**unclosed')).toEqual(doc(paragraph(text('**unclosed'))))
    })

    it('unclosed italic becomes plain text', () => {
      expect(parse('*unclosed')).toEqual(doc(paragraph(text('*unclosed'))))
    })

    it('unclosed code becomes plain text', () => {
      expect(parse('`unclosed')).toEqual(doc(paragraph(text('`unclosed'))))
    })

    it('unclosed bold with content before', () => {
      expect(parse('before **unclosed')).toEqual(doc(paragraph(text('before **unclosed'))))
    })

    it('unclosed italic after closed bold', () => {
      expect(parse('**ok** *unclosed')).toEqual(doc(paragraph(bold('ok'), text(' *unclosed'))))
    })

    it('unclosed bold containing unclosed italic', () => {
      expect(parse('**bold *italic')).toEqual(doc(paragraph(text('**bold *italic'))))
    })

    it('unclosed italic containing unclosed bold', () => {
      expect(parse('*italic **bold')).toEqual(doc(paragraph(text('*italic **bold'))))
    })

    it('unclosed code with bold syntax inside', () => {
      expect(parse('`**stuff')).toEqual(doc(paragraph(text('`**stuff'))))
    })

    it('empty bold **** produces empty paragraph', () => {
      expect(parse('****')).toEqual(doc(paragraph()))
    })

    it('unclosed bold containing tag_ref reverts to plain text', () => {
      expect(parse('**see #[01ARZ3NDEKTSV4RRFFQ69G5FAV]')).toEqual(
        doc(paragraph(text('**see #[01ARZ3NDEKTSV4RRFFQ69G5FAV]'))),
      )
    })

    it('unclosed bold containing block_link reverts to plain text', () => {
      expect(parse('**see [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')).toEqual(
        doc(paragraph(text('**see [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]'))),
      )
    })
  })

  describe('tokens', () => {
    it('tag_ref', () => {
      expect(parse('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]')).toEqual(
        doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('block_link', () => {
      expect(parse('[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')).toEqual(
        doc(paragraph(blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('tag_ref with surrounding text', () => {
      expect(parse('see #[01ARZ3NDEKTSV4RRFFQ69G5FAV] here')).toEqual(
        doc(paragraph(text('see '), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' here'))),
      )
    })

    it('block_link with surrounding text', () => {
      expect(parse('see [[01ARZ3NDEKTSV4RRFFQ69G5FAV]] here')).toEqual(
        doc(paragraph(text('see '), blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' here'))),
      )
    })

    it('invalid ULID passes through as text', () => {
      expect(parse('#[not-a-ulid]')).toEqual(doc(paragraph(text('#[not-a-ulid]'))))
    })

    it('#[ with lowercase ulid passes through as text', () => {
      expect(parse('#[01arz3ndektsv4rrffq69g5fav]')).toEqual(
        doc(paragraph(text('#[01arz3ndektsv4rrffq69g5fav]'))),
      )
    })

    it('[[ with short content passes through as text', () => {
      expect(parse('[[short]]')).toEqual(doc(paragraph(text('[[short]]'))))
    })

    it('[[ with 26 non-ULID chars passes through as text', () => {
      expect(parse('[[abcdefghijklmnopqrstuvwxyz]]')).toEqual(
        doc(paragraph(text('[[abcdefghijklmnopqrstuvwxyz]]'))),
      )
    })

    it('token at start of line', () => {
      expect(parse('#[01ARZ3NDEKTSV4RRFFQ69G5FAV] end')).toEqual(
        doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), text(' end'))),
      )
    })

    it('token at end of line', () => {
      expect(parse('start [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]')).toEqual(
        doc(paragraph(text('start '), blockLink('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('token inside bold', () => {
      expect(parse('**#[01ARZ3NDEKTSV4RRFFQ69G5FAV]**')).toEqual(
        doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('consecutive tokens without separator', () => {
      expect(parse('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]#[01ARZ3NDEKTSV4RRFFQ69G5FAV]')).toEqual(
        doc(paragraph(tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })

    it('token immediately after mark close', () => {
      expect(parse('**x**#[01ARZ3NDEKTSV4RRFFQ69G5FAV]')).toEqual(
        doc(paragraph(bold('x'), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))),
      )
    })
  })

  describe('escapes', () => {
    it('escaped asterisk', () => {
      expect(parse('a \\* b')).toEqual(doc(paragraph(text('a * b'))))
    })

    it('escaped backtick', () => {
      expect(parse('a \\` b')).toEqual(doc(paragraph(text('a ` b'))))
    })

    it('escaped backslash', () => {
      expect(parse('a \\\\ b')).toEqual(doc(paragraph(text('a \\ b'))))
    })

    it('escaped #[', () => {
      expect(parse('use \\#[not a tag')).toEqual(doc(paragraph(text('use #[not a tag'))))
    })

    it('escaped [[', () => {
      expect(parse('use \\[[not a link')).toEqual(doc(paragraph(text('use [[not a link'))))
    })

    it('backslash at end of line is literal', () => {
      expect(parse('end\\')).toEqual(doc(paragraph(text('end\\'))))
    })

    it('backslash before non-special char is literal', () => {
      expect(parse('\\a')).toEqual(doc(paragraph(text('\\a'))))
    })
  })

  describe('newlines (multi-paragraph)', () => {
    it('two lines produce two paragraphs', () => {
      expect(parse('first\nsecond')).toEqual(
        doc(paragraph(text('first')), paragraph(text('second'))),
      )
    })

    it('empty line produces empty paragraph', () => {
      expect(parse('a\n\nb')).toEqual(doc(paragraph(text('a')), paragraph(), paragraph(text('b'))))
    })

    it('trailing newline produces empty paragraph', () => {
      expect(parse('a\n')).toEqual(doc(paragraph(text('a')), paragraph()))
    })
  })
})

// -- round-trip ---------------------------------------------------------------

describe('round-trip: serialize(parse(s)) === s', () => {
  const cases: [string, string][] = [
    ['empty string', ''],
    ['plain text', 'hello world'],
    ['bold', '**strong**'],
    ['italic', '*emphasis*'],
    ['code', '`fn()`'],
    ['bold+italic', '***both***'],
    ['tag_ref', '#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'],
    ['block_link', '[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]'],
    ['escaped asterisk', 'a \\* b'],
    ['escaped backtick', 'a \\` b'],
    ['escaped backslash', 'a \\\\ b'],
    ['escaped #[', 'use \\#[not a tag'],
    ['escaped [[', 'use \\[[not a link'],
    ['mixed marks and text', 'hello **bold** and *italic* and `code` end'],
    ['token with text', 'see #[01ARZ3NDEKTSV4RRFFQ69G5FAV] here'],
    ['two lines', 'first\nsecond'],
    ['whitespace-only', '   '],
    ['marks adjacent to tokens', '**look: **#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'],
    ['code with special chars inside', '`**not \\* bold**`'],
    ['multiple tokens', '#[01ARZ3NDEKTSV4RRFFQ69G5FAV] and [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]'],
    ['consecutive tokens', '#[01ARZ3NDEKTSV4RRFFQ69G5FAV]#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'],
    ['bold+italic with surrounding text', 'before ***both*** after'],
    ['escaped backslash before bold', '\\\\**bold**'],
    ['token after mark close', '**x**#[01ARZ3NDEKTSV4RRFFQ69G5FAV]'],
    ['bold then italic adjacent', '**a***b*'],
  ]

  for (const [name, input] of cases) {
    it(name, () => {
      expect(serialize(parse(input))).toBe(input)
    })
  }
})

// -- mark coalescing (bold-inside-italic) -------------------------------------
// These test the fix for the data-loss bug where the serializer wrapped each
// TextNode independently, creating ambiguous delimiter sequences.
// See REVIEW-LATER.md "[2026-03-28] Serializer: bold-inside-italic mark merging"

describe('mark coalescing: nested marks across adjacent text nodes', () => {
  it('italic(a)+boldItalic(b)+italic(c) → *a**b**c*', () => {
    const input = doc(paragraph(italic('a'), boldItalic('b'), italic('c')))
    const md = serialize(input)
    expect(md).toBe('*a**b**c*')
    // Round-trip: parse should recover the original structure
    expect(parse(md)).toEqual(input)
  })

  it('bold(a)+boldItalic(b)+bold(c) → **a*b*c**', () => {
    const input = doc(paragraph(bold('a'), boldItalic('b'), bold('c')))
    const md = serialize(input)
    expect(md).toBe('**a*b*c**')
    expect(parse(md)).toEqual(input)
  })

  it('italic(a)+boldItalic(b) → *a**b***', () => {
    const input = doc(paragraph(italic('a'), boldItalic('b')))
    const md = serialize(input)
    expect(md).toBe('*a**b***')
    expect(parse(md)).toEqual(input)
  })

  it('boldItalic(a)+italic(b) → ***a**b*', () => {
    const input = doc(paragraph(boldItalic('a'), italic('b')))
    const md = serialize(input)
    expect(md).toBe('***a**b*')
    expect(parse(md)).toEqual(input)
  })

  it('boldItalic(a)+bold(b) → ***a*b**', () => {
    const input = doc(paragraph(boldItalic('a'), bold('b')))
    const md = serialize(input)
    expect(md).toBe('***a*b**')
    expect(parse(md)).toEqual(input)
  })

  it('bold(a)+boldItalic(b) → **a*b***', () => {
    const input = doc(paragraph(bold('a'), boldItalic('b')))
    const md = serialize(input)
    expect(md).toBe('**a*b***')
    expect(parse(md)).toEqual(input)
  })

  it('round-trip stability: serialize→parse→serialize is idempotent', () => {
    const input = doc(paragraph(italic('a'), boldItalic('b'), italic('c')))
    const md1 = serialize(input)
    const md2 = serialize(parse(md1))
    expect(md2).toBe(md1)
    // Third pass for extra confidence
    const md3 = serialize(parse(md2))
    expect(md3).toBe(md1)
  })

  it('three-segment bold-inside-italic with longer text', () => {
    const input = doc(paragraph(italic('hello '), boldItalic('world'), italic(' end')))
    const md = serialize(input)
    expect(md).toBe('*hello **world** end*')
    expect(parse(md)).toEqual(input)
  })

  it('italic→bold transition (no shared marks)', () => {
    const input = doc(paragraph(italic('a'), bold('b')))
    const md = serialize(input)
    expect(md).toBe('*a***b**')
    expect(parse(md)).toEqual(input)
  })

  it('bold→italic transition (no shared marks)', () => {
    const input = doc(paragraph(bold('a'), italic('b')))
    const md = serialize(input)
    expect(md).toBe('**a***b*')
    expect(parse(md)).toEqual(input)
  })
})
