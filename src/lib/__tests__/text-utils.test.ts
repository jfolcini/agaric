/**
 * Tests for src/lib/text-utils.ts — truncateContent.
 */

import { describe, expect, it } from 'vitest'

import { truncateContent } from '@/lib/text-utils'

describe('truncateContent', () => {
  it('returns emptyFallback for null input', () => {
    expect(truncateContent(null)).toBe('(empty)')
  })

  it('returns emptyFallback for empty string', () => {
    expect(truncateContent('')).toBe('(empty)')
  })

  it('uses custom emptyFallback', () => {
    expect(truncateContent(null, 120, 'N/A')).toBe('N/A')
  })

  it('strips [[...]] wiki links (keeps inner text)', () => {
    expect(truncateContent('See [[My Page]] for details')).toBe('See My Page for details')
  })

  it('reads a [[x|label]] link as its label (#5160 D9)', () => {
    expect(truncateContent('See [[01ARZ3NDEKTSV4RRFFQ69G5FAV|the plan]] now')).toBe(
      'See the plan now',
    )
  })

  // A human link a tie left as text is not a stored link: its `|` belongs to
  // the title (`Article | Medium`), not to a label.
  it('keeps the whole text of an unresolved [[A | B]]', () => {
    expect(truncateContent('Read [[Article | Medium]]')).toBe('Read Article | Medium')
  })

  it('strips markdown chars #*_~`', () => {
    expect(truncateContent('# Hello **world** _foo_ ~bar~ `code`')).toBe(
      ' Hello world foo bar code',
    )
  })

  it('truncates at max length with ...', () => {
    const long = 'a'.repeat(200)
    const result = truncateContent(long)
    expect(result).toBe(`${'a'.repeat(120)}...`)
  })

  it('does not truncate when under max', () => {
    expect(truncateContent('short text')).toBe('short text')
  })

  it('works with custom max (e.g., 80)', () => {
    const long = 'b'.repeat(100)
    const result = truncateContent(long, 80)
    expect(result).toBe(`${'b'.repeat(80)}...`)
  })

  it('handles content that is exactly at max length (no truncation)', () => {
    const exact = 'c'.repeat(120)
    expect(truncateContent(exact)).toBe(exact)
  })
})
