/**
 * A coloured highlight is stored in Obsidian's form (#6759): a colour emoji
 * right after the opening `==`, as `==🔴text==`. The parser reads the emoji as
 * the mark's colour and the serializer writes it back.
 */

import { describe, expect, it } from 'vitest'

import { doc, highlight, paragraph, text } from '@/editor/__tests__/builders'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { TextNode } from '@/editor/types'
import { HIGHLIGHT_COLORS, type HighlightColor } from '@/lib/highlight-colors'

function colored(t: string, color: HighlightColor): TextNode {
  return { type: 'text', text: t, marks: [{ type: 'highlight', attrs: { color } }] }
}

const OBSIDIAN_FORMS: ReadonlyArray<readonly [HighlightColor, string]> = [
  ['red', '==🔴Important=='],
  ['orange', '==🟠Important=='],
  ['yellow', '==🟡Important=='],
  ['green', '==🟢Important=='],
  ['blue', '==🔵Important=='],
  ['purple', '==🟣Important=='],
]

describe('coloured highlights', () => {
  it('offers Obsidian’s six colours', () => {
    expect(HIGHLIGHT_COLORS.map((c) => c.id)).toEqual(OBSIDIAN_FORMS.map(([id]) => id))
  })

  it.each(OBSIDIAN_FORMS)('reads %s from its emoji, and writes it back', (color, markdown) => {
    const parsed = parse(markdown)
    expect(parsed).toEqual(doc(paragraph(colored('Important', color))))
    expect(serialize(parsed)).toBe(markdown)
  })

  it('keeps a highlight with no emoji the default one', () => {
    expect(parse('==plain==')).toEqual(doc(paragraph(highlight('plain'))))
    expect(serialize(doc(paragraph(highlight('plain'))))).toBe('==plain==')
  })

  it('reads a coloured highlight inside a sentence', () => {
    expect(parse('a ==🟢agreed== b')).toEqual(
      doc(paragraph(text('a '), colored('agreed', 'green'), text(' b'))),
    )
  })

  it('closes one colour and opens the next where two touch', () => {
    const touching = doc(paragraph(colored('claim', 'yellow'), colored('doubt', 'red')))
    expect(parse(serialize(touching))).toEqual(touching)
  })

  it('switches between a coloured and a plain highlight', () => {
    const touching = doc(paragraph(highlight('plain'), text(' and '), colored('blue', 'blue')))
    expect(parse(serialize(touching))).toEqual(touching)
  })

  it('leaves an unclosed coloured opener as the text it is', () => {
    expect(parse('==🔴open')).toEqual(doc(paragraph(text('==🔴open'))))
  })

  it('leaves an empty coloured highlight as text', () => {
    expect(parse('a ==🔴== b')).toEqual(doc(paragraph(text('a ==🔴== b'))))
  })

  it('reads an emoji that names no colour as highlighted text', () => {
    expect(parse('==⭐star==')).toEqual(doc(paragraph(highlight('⭐star'))))
  })
})
