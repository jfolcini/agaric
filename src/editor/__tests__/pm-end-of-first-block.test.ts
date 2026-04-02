import { describe, expect, it } from 'vitest'
import {
  blockLink,
  bold,
  codeBlock,
  doc,
  hardBreak,
  heading,
  paragraph,
  pmEndOfFirstBlock,
  tagRef,
  text,
} from '../types'

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
    expect(pmEndOfFirstBlock(doc(paragraph(text('hi '), tagRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))))).toBe(5)
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

  it('only uses first block when multiple blocks exist', () => {
    // doc(paragraph("ab"), paragraph("cdef")) → first block: 1 + 2 = 3
    expect(pmEndOfFirstBlock(doc(paragraph(text('ab')), paragraph(text('cdef'))))).toBe(3)
  })
})
