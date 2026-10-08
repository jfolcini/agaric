/**
 * Tests for the `|width` suffix an image alt carries (#4712, Obsidian's
 * `![alt|300](url)` convention).
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { formatImageAlt, parseImageAlt } from '@/lib/image-alt-size'

describe('parseImageAlt', () => {
  it('reads a trailing `|300` as the width and strips it from the text', () => {
    expect(parseImageAlt('a cat|300')).toEqual({ text: 'a cat', width: 300 })
  })

  it('reads the width of an Obsidian `|300x200` suffix and drops the height', () => {
    expect(parseImageAlt('x|300x200')).toEqual({ text: 'x', width: 300 })
  })

  it('splits on the LAST pipe only, so a pipe inside the text survives', () => {
    expect(parseImageAlt('a|b|300')).toEqual({ text: 'a|b', width: 300 })
  })

  it('reads a width-only alt as an empty text', () => {
    expect(parseImageAlt('|300')).toEqual({ text: '', width: 300 })
  })

  it('returns a plain alt unchanged with no width', () => {
    expect(parseImageAlt('a cat')).toEqual({ text: 'a cat', width: null })
    expect(parseImageAlt('')).toEqual({ text: '', width: null })
  })

  it('keeps a zero width as plain text', () => {
    expect(parseImageAlt('a|0')).toEqual({ text: 'a|0', width: null })
  })

  it('keeps a non-numeric suffix as plain text', () => {
    expect(parseImageAlt('a|abc')).toEqual({ text: 'a|abc', width: null })
    expect(parseImageAlt('a|300px')).toEqual({ text: 'a|300px', width: null })
    expect(parseImageAlt('a|300x')).toEqual({ text: 'a|300x', width: null })
    expect(parseImageAlt('a|')).toEqual({ text: 'a|', width: null })
  })
})

describe('formatImageAlt', () => {
  it('appends the width as a `|` suffix', () => {
    expect(formatImageAlt('a cat', 300)).toBe('a cat|300')
  })

  it('returns the bare text for the natural size', () => {
    expect(formatImageAlt('a cat', null)).toBe('a cat')
  })
})

describe('parseImageAlt ∘ formatImageAlt', () => {
  /**
   * A text that does not already end in a size suffix of its own. Half the
   * runs draw from pipes, digits and `x`, which plain `fc.string()` rarely hits.
   */
  const arbText = fc
    .oneof(fc.string(), fc.string({ unit: fc.constantFrom('a', ' ', '|', '0', '7', 'x') }))
    .filter((s) => !/\|\d+(x\d+)?$/.test(s))
  const arbWidth = fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: null })

  it('round-trips any text and width', () => {
    fc.assert(
      fc.property(arbText, arbWidth, (text, width) => {
        expect(parseImageAlt(formatImageAlt(text, width))).toEqual({ text, width })
      }),
      { numRuns: 500 },
    )
  })
})
