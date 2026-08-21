/**
 * Tests for `@/lib/block-title` — the canonical resolve-store block-title
 * normalisation (#4228).
 */

import { describe, expect, it } from 'vitest'

import { blockFirstLineOr, normalizeBlockRefTitle, untitledOr } from '@/lib/block-title'
import { t } from '@/lib/i18n'

describe('untitledOr', () => {
  it('substitutes the localized "Untitled" placeholder for null', () => {
    expect(untitledOr(null)).toBe(t('block.untitled'))
  })

  it('substitutes the placeholder for a whitespace-only string', () => {
    expect(untitledOr('   \n  ')).toBe(t('block.untitled'))
  })

  it('substitutes the placeholder for an exact-empty string', () => {
    expect(untitledOr('')).toBe(t('block.untitled'))
  })

  it('passes a genuinely-titled string through unchanged', () => {
    expect(untitledOr('real title')).toBe('real title')
  })

  it('preserves surrounding whitespace on an otherwise non-blank string', () => {
    expect(untitledOr('  foo  ')).toBe('  foo  ')
  })
})

describe('blockFirstLineOr', () => {
  it('returns the placeholder for null content', () => {
    expect(blockFirstLineOr(null)).toBe(t('block.untitled'))
  })

  it('returns the placeholder when the first line is empty (newline-leading content)', () => {
    // The defect #4228 fixes: content whose first line is blank even though
    // a LATER line holds real text — the picker row (#4222) already gets
    // this right; the resolve-store seed didn't.
    expect(blockFirstLineOr('\nreal text')).toBe(t('block.untitled'))
  })

  it('returns the placeholder for a whitespace-only first line', () => {
    expect(blockFirstLineOr('   \nsecond line')).toBe(t('block.untitled'))
  })

  it('returns the real first line for genuinely-titled multi-line content', () => {
    expect(blockFirstLineOr('real title\nsecond line')).toBe('real title')
  })

  it('returns single-line content unchanged', () => {
    expect(blockFirstLineOr('single line')).toBe('single line')
  })
})

describe('normalizeBlockRefTitle — the resolve-store seed normalisation', () => {
  it('substitutes "Untitled" for null content', () => {
    expect(normalizeBlockRefTitle(null)).toBe(t('block.untitled'))
  })

  it('substitutes "Untitled" for whitespace-only content', () => {
    expect(normalizeBlockRefTitle('   ')).toBe(t('block.untitled'))
  })

  it('substitutes "Untitled" for newline-leading content whose first line is blank', () => {
    // This is the exact shape the issue names: a block whose content
    // begins with "\n" must not normalize to a blank string — a blank
    // stored title is what rendered the chip empty.
    const result = normalizeBlockRefTitle('\nreal text')
    expect(result).toBe(t('block.untitled'))
    expect(result.length).toBeGreaterThan(0)
  })

  // Symmetric pair: a fix that shows the placeholder unconditionally is not
  // a fix. A genuinely-titled block must keep rendering its real (capped)
  // first line, not the placeholder.
  it('keeps the real first line for a genuinely-titled multi-line block, dropping later lines', () => {
    expect(normalizeBlockRefTitle('real title\nsecond line')).toBe('real title')
  })

  it('passes short single-line content through unchanged', () => {
    expect(normalizeBlockRefTitle('short title')).toBe('short title')
  })

  it('caps content over 60 chars to 57 chars plus an ellipsis', () => {
    const longTitle = 'x'.repeat(120)
    expect(normalizeBlockRefTitle(longTitle)).toBe(`${'x'.repeat(57)}...`)
  })

  it('does not cap content at exactly 60 chars', () => {
    const exactTitle = 'y'.repeat(60)
    expect(normalizeBlockRefTitle(exactTitle)).toBe(exactTitle)
  })

  it('caps content at 61 chars (one over the boundary)', () => {
    const overTitle = 'z'.repeat(61)
    expect(normalizeBlockRefTitle(overTitle)).toBe(`${'z'.repeat(57)}...`)
  })

  // Multi-byte boundary. `slice` cuts on UTF-16 code units, so a cap that
  // lands mid-surrogate-pair would persist an unpaired high surrogate into
  // the store — invalid Unicode that renders as a U+FFFD replacement box.
  it('does not leave an unpaired surrogate when the cap lands mid-emoji', () => {
    // 56 ASCII + an astral emoji => the emoji occupies code units 56 and 57,
    // so a naive `slice(0, 57)` keeps ONLY its high half.
    const result = normalizeBlockRefTitle(`${'a'.repeat(56)}😀${'b'.repeat(20)}`)

    expect(result).toBe(`${'a'.repeat(56)}...`)
    // The direct invariant, independent of the exact expected string: no
    // code unit in the result is an unpaired surrogate, so encoding it is
    // lossless (a lone surrogate round-trips through UTF-8 as U+FFFD).
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(result).not.toContain('�')
  })

  it('keeps a whole emoji that fits entirely inside the cap', () => {
    // 55 ASCII + emoji => code units 55 and 56, both inside `slice(0, 57)`.
    const result = normalizeBlockRefTitle(`${'a'.repeat(55)}😀${'b'.repeat(20)}`)

    expect(result).toBe(`${'a'.repeat(55)}😀...`)
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('caps the FIRST LINE length, not the raw multi-line content length', () => {
    // A first line just over 60 chars, followed by a long second line: the
    // cap must apply to the (already first-line-only) 65-char first line,
    // not to the 200+ char raw content.
    const firstLine = 'a'.repeat(65)
    const content = `${firstLine}\n${'b'.repeat(200)}`
    expect(normalizeBlockRefTitle(content)).toBe(`${'a'.repeat(57)}...`)
  })
})
