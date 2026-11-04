/**
 * Footnotes `[^label]` (#6033): read, written, and numbered per page by the
 * order their labels are first referenced.
 */

import { describe, expect, it } from 'vitest'

import { bold, doc, footnoteRef, paragraph, text } from '@/editor/__tests__/builders'
import { definedLabel, pageFootnotes } from '@/editor/footnotes'
import { parse, serialize } from '@/editor/markdown-serializer'

const LINK = 'https://example.com'

describe('parse reads a footnote reference', () => {
  it('reads `[^label]` inline as a reference, the label as written', () => {
    expect(parse('see[^1] and [^note-a].')).toEqual(
      doc(
        paragraph(text('see'), footnoteRef('1'), text(' and '), footnoteRef('note-a'), text('.')),
      ),
    )
  })

  it('reads a definition block as its reference, then its text', () => {
    expect(parse('[^a-b]: x')).toEqual(doc(paragraph(footnoteRef('a-b'), text(': x'))))
  })

  it('reads a reference inside bold without ending the bold', () => {
    expect(parse('**a[^1]b**')).toEqual(doc(paragraph(bold('a'), footnoteRef('1'), bold('b'))))
  })

  it.each([
    ['an escaped bracket', '\\[^1\\]', '[^1]'],
    ['an empty label', '[^]', '[^]'],
    ['a label with a space', '[^a b]', '[^a b]'],
  ])('keeps %s as text', (_case, markdown, shown) => {
    expect(parse(markdown)).toEqual(doc(paragraph(text(shown))))
  })

  it('keeps a reference inside a code span as code', () => {
    expect(parse('`[^1]`')).toEqual(doc(paragraph(text('[^1]', [{ type: 'code' }]))))
  })

  it('reads `[^x](url)` as the link it also is', () => {
    expect(parse(`[^1](${LINK})`)).toEqual(
      doc(paragraph(text('^1', [{ type: 'link', attrs: { href: LINK } }]))),
    )
  })
})

describe('serialize writes a footnote reference', () => {
  it('writes the reference as `[^label]`', () => {
    expect(serialize(doc(paragraph(text('see'), footnoteRef('note-a'), text('.'))))).toBe(
      'see[^note-a].',
    )
  })

  it('keeps escaping a literal `[`, so text that reads as a reference stays text', () => {
    const md = serialize(doc(paragraph(text('[^1]'))))
    expect(md).toBe('\\[^1\\]')
    expect(parse(md)).toEqual(doc(paragraph(text('[^1]'))))
  })

  it('escapes a `(` right after a reference, which would read as a link', () => {
    const d = doc(paragraph(footnoteRef('1'), text('(x)')))
    const md = serialize(d)
    expect(md).toBe('[^1]\\(x)')
    expect(parse(md)).toEqual(d)
  })

  it('closes the marks around a reference, as around every atom', () => {
    const d = doc(paragraph(bold('a'), footnoteRef('1'), bold('b')))
    expect(serialize(d)).toBe('**a**[^1]**b**')
    expect(parse(serialize(d))).toEqual(d)
  })
})

describe('definedLabel', () => {
  it('is the label a block whose text starts `[^label]: ` defines', () => {
    expect(definedLabel(parse('[^note]: the note'))).toBe('note')
  })

  it.each([
    ['a reference not at the start', 'see [^note]: x'],
    ['no space after the colon', '[^note]:x'],
    ['no colon', '[^note] x'],
    ['a heading', '# [^note]: x'],
  ])('is null for %s', (_case, markdown) => {
    expect(definedLabel(parse(markdown))).toBeNull()
  })
})

describe('pageFootnotes numbers a page by first reference', () => {
  const blocks = [
    { id: 'B1', content: 'first [^b], then [^a]' },
    { id: 'B2', content: 'again [^b] and [^c]' },
    { id: 'DA', content: '[^a]: alpha' },
    { id: 'DB', content: '[^b]: beta' },
    { id: 'DB2', content: '[^b]: a second definition' },
    { id: 'DX', content: '[^x]: defined, never referenced' },
    { id: 'P', content: null },
  ]

  it('numbers labels in the order they are first referenced, across blocks', () => {
    const { numbers } = pageFootnotes(blocks)
    expect([...numbers]).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 3],
    ])
  })

  it('maps each label to the first block that defines it', () => {
    const { definitions } = pageFootnotes(blocks)
    expect([...definitions]).toEqual([
      ['a', 'DA'],
      ['b', 'DB'],
      ['x', 'DX'],
    ])
  })

  it('does not count a definition’s own marker as a reference', () => {
    const { numbers } = pageFootnotes([
      { id: 'D', content: '[^late]: defined first' },
      { id: 'R', content: 'refers to [^early] then [^late]' },
    ])
    expect([...numbers]).toEqual([
      ['early', 1],
      ['late', 2],
    ])
  })

  it('ignores an escaped reference and one inside code', () => {
    const { numbers } = pageFootnotes([{ id: 'B', content: '\\[^a\\] `[^b]` [^c]' }])
    expect([...numbers]).toEqual([['c', 1]])
  })

  it('computes once per block list and again for a changed one', () => {
    const first = pageFootnotes(blocks)
    expect(pageFootnotes(blocks)).toBe(first)
    const changed = [{ id: 'N', content: 'new [^z]' }, ...blocks]
    expect([...pageFootnotes(changed).numbers.keys()]).toEqual(['z', 'b', 'a', 'c'])
  })
})
