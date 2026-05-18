/**
 * Tests for the Jaro-Winkler fuzzy scorer (PEND-51).
 */

import { describe, expect, it } from 'vitest'
import { blendFtsFuzzy, jaroWinkler } from '../jaro-winkler'

describe('jaroWinkler — boundaries', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinkler('alpha', 'alpha')).toBe(1)
  })

  it('returns 1 for case-insensitive identical strings (lower-cased)', () => {
    expect(jaroWinkler('Alpha', 'ALPHA')).toBe(1)
  })

  it('returns 0 when either input is empty', () => {
    expect(jaroWinkler('', 'foo')).toBe(0)
    expect(jaroWinkler('foo', '')).toBe(0)
  })

  it('returns 0 for fully disjoint strings', () => {
    expect(jaroWinkler('abcdef', 'ghijkl')).toBe(0)
  })
})

describe('jaroWinkler — typo tolerance (the palette use-case)', () => {
  it('forgives a transposed letter ("alfa" → "alpha")', () => {
    // Plan §"Fuzzy ranking" — `alfa` should be a strong match for
    // `Alpha` despite the FTS5 trigram tokenizer missing it.
    const score = jaroWinkler('alfa', 'alpha')
    expect(score).toBeGreaterThan(0.7)
  })

  it('rewards a common prefix more than a common suffix', () => {
    // `alpa` is missing the `h`; `phaz` shares the suffix vowel. The
    // prefix-share match should rank higher under JW's `ℓp`-prefix boost.
    const prefixMatch = jaroWinkler('alpa', 'alpha')
    const suffixMatch = jaroWinkler('phaz', 'alpha')
    expect(prefixMatch).toBeGreaterThan(suffixMatch)
  })

  it('rewards a longer common prefix more than a shorter one', () => {
    // Identical first 4 chars vs identical first 2 chars (with the
    // rest disjoint) — longer prefix should score higher.
    const fourChar = jaroWinkler('alphaaaa', 'alphabbb')
    const twoChar = jaroWinkler('alzzzzz', 'alqqqqq')
    expect(fourChar).toBeGreaterThan(twoChar)
  })
})

describe('blendFtsFuzzy — 0.7 FTS / 0.3 fuzzy', () => {
  it('returns the FTS score verbatim when fuzzy is 0', () => {
    expect(blendFtsFuzzy(1, 0)).toBeCloseTo(0.7, 6)
  })
  it('returns the fuzzy score scaled when FTS is 0', () => {
    expect(blendFtsFuzzy(0, 1)).toBeCloseTo(0.3, 6)
  })
  it('blends additively', () => {
    expect(blendFtsFuzzy(1, 1)).toBeCloseTo(1, 6)
    expect(blendFtsFuzzy(0.5, 0.5)).toBeCloseTo(0.5, 6)
  })
})
