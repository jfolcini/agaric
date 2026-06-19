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

describe('jaroWinkler — astral / non-BMP characters (#1564)', () => {
  it('scores an astral prefix identically to a BMP-equivalent char', () => {
    // 📌 is a single code point but two UTF-16 units. Indexing by code
    // point means '📌abc' vs '📌abz' must score exactly like the
    // single-BMP-char analogue 'xabc' vs 'xabz' (one trailing typo).
    const astral = jaroWinkler('📌abc', '📌abz')
    const bmp = jaroWinkler('xabc', 'xabz')
    expect(astral).toBe(bmp)
  })

  it('does not surrogate-inflate length when strings differ only by an emoji', () => {
    // Both strings are 4 code points; only the leading emoji differs.
    // A code-unit implementation would see 5 units and compare lone
    // surrogates, mis-scoring. Equivalent BMP analogue: 'xabc' vs 'yabc'.
    const astral = jaroWinkler('📌abc', '📍abc')
    const bmp = jaroWinkler('xabc', 'yabc')
    expect(astral).toBe(bmp)
  })

  it('scores two distinct emojis as fully disjoint single chars', () => {
    // '📌' vs '📍' share no code point → Jaro 0, no prefix boost.
    expect(jaroWinkler('📌', '📍')).toBe(0)
  })

  it('returns 1 for identical astral strings', () => {
    expect(jaroWinkler('📌📍🚀', '📌📍🚀')).toBe(1)
  })

  it('counts a shared astral prefix as one unit for the Winkler boost', () => {
    // Shared leading 📌 then a single trailing typo, mirrored against a
    // BMP analogue. Prefix length must be counted in code points so the
    // boost is identical, not doubled by the surrogate pair.
    const astral = jaroWinkler('📌pha', '📌phb')
    const bmp = jaroWinkler('xpha', 'xphb')
    expect(astral).toBe(bmp)
  })
})

describe('jaroWinkler — pure-ASCII regression (BMP path unchanged)', () => {
  it('keeps the canonical alfa→alpha score', () => {
    // Frozen pre-#1564 value: the BMP path must be byte-for-byte identical.
    expect(jaroWinkler('alfa', 'alpha')).toBeCloseTo(0.8266666666666667, 12)
  })
  it('keeps the alpa→alpha prefix-boosted score', () => {
    expect(jaroWinkler('alpa', 'alpha')).toBeCloseTo(0.9533333333333333, 12)
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
