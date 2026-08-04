import { describe, expect, it } from 'vitest'

import {
  blockLink,
  blockquote,
  bold,
  bulletList,
  codeBlock,
  doc,
  hardBreak,
  heading,
  listItem,
  orderedList,
  paragraph,
  tagRef,
  text,
} from '@/editor/__tests__/builders'
import { pmEndOfFirstBlock } from '@/editor/types'

describe('pmEndOfFirstBlock', () => {
  it('plain text', () => {
    // doc(paragraph("hello")) → pos 1 (para open) + 5 (text) = 6
    expect(pmEndOfFirstBlock(doc(paragraph(text('hello'))))).toBe(6)
  })

  it('bold text', () => {
    // doc(paragraph(bold("bold"))) → pos 1 + 4 = 5
    // Marks don't affect PM positions — only text length matters
    expect(pmEndOfFirstBlock(doc(paragraph(bold('bold'))))).toBe(5)
  })

  it('mixed text and atom node', () => {
    // doc(paragraph("hi ", tagRef)) → pos 1 + 3 + 1 = 5
    expect(
      pmEndOfFirstBlock(doc(paragraph(text('hi '), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV')))),
    ).toBe(5)
  })

  it('multiple atom nodes', () => {
    // doc(paragraph(tagRef, " ", blockLink)) → pos 1 + 1 + 1 + 1 = 4
    expect(pmEndOfFirstBlock(doc(paragraph(tagRef('A'), text(' '), blockLink('B'))))).toBe(4)
  })

  it('text with hard break', () => {
    // doc(paragraph("ab", hardBreak, "cd")) → pos 1 + 2 + 1 + 2 = 6
    expect(pmEndOfFirstBlock(doc(paragraph(text('ab'), hardBreak(), text('cd'))))).toBe(6)
  })

  it('empty paragraph', () => {
    // doc(paragraph()) → pos 1 (just the open tag, no content)
    expect(pmEndOfFirstBlock(doc(paragraph()))).toBe(1)
  })

  it('empty doc', () => {
    // doc() → no blocks at all, fallback to 1
    expect(pmEndOfFirstBlock(doc())).toBe(1)
  })

  it('heading', () => {
    // doc(heading(2, "Title")) → pos 1 + 5 = 6
    expect(pmEndOfFirstBlock(doc(heading(2, text('Title'))))).toBe(6)
  })

  it('code block with content', () => {
    // doc(codeBlock("let x = 1")) → pos 1 + 9 = 10
    expect(pmEndOfFirstBlock(doc(codeBlock('let x = 1')))).toBe(10)
  })

  it('empty code block', () => {
    // doc(codeBlock("")) → pos 1 + 0 = 1
    expect(pmEndOfFirstBlock(doc(codeBlock('')))).toBe(1)
  })

  it('bullet list', () => {
    // list open (1) + item open (1) + paragraph open (1) + "hello" (5) = 8
    expect(pmEndOfFirstBlock(doc(bulletList(listItem(paragraph(text('hello'))))))).toBe(8)
  })

  it('ordered list', () => {
    // list open (1) + item open (1) + paragraph open (1) + "first" (5) = 8
    expect(pmEndOfFirstBlock(doc(orderedList(listItem(paragraph(text('first'))))))).toBe(8)
  })

  it('blockquote', () => {
    // quote open (1) + paragraph open (1) + "quoted" (6) = 8
    expect(pmEndOfFirstBlock(doc(blockquote(paragraph(text('quoted')))))).toBe(8)
  })

  it('empty textblock inside a wrapper', () => {
    // quote open (1) + empty paragraph open (1) = 2
    expect(pmEndOfFirstBlock(doc(blockquote(paragraph())))).toBe(2)
  })

  it('rightmost empty textblock inside nested wrappers', () => {
    const wrapped = bulletList(listItem(paragraph(), blockquote(paragraph())))

    // list/item opens (2) + first empty paragraph nodeSize (2) + quote/last
    // empty paragraph opens (2) lands inside the final textblock at position 6.
    expect(pmEndOfFirstBlock(doc(wrapped))).toBe(6)
  })

  it('multi-item list with a nested list', () => {
    const wrapped = bulletList(
      listItem(paragraph(text('one'))),
      listItem(
        paragraph(text('parent')),
        orderedList(
          listItem(paragraph(text('inner'))),
          listItem(paragraph(text('tail'), hardBreak(), tagRef('T'))),
        ),
      ),
    )

    // Outer list content starts at 1. The first item occupies 7 positions
    // (item tags 2 + paragraph tags 2 + "one" 3), so item two starts at 8.
    // Its open tag and "parent" paragraph occupy 1 + 8, putting the nested
    // list at 17. Nested open (1) + first item (9) + last item/paragraph opens
    // (2) + "tail" (4) + hardBreak (1) + tagRef (1) lands at position 35.
    expect(pmEndOfFirstBlock(doc(wrapped))).toBe(35)
  })

  it('only uses first block when multiple blocks exist', () => {
    // doc(paragraph("ab"), paragraph("cdef")) → first block: 1 + 2 = 3
    expect(pmEndOfFirstBlock(doc(paragraph(text('ab')), paragraph(text('cdef'))))).toBe(3)
  })
})
