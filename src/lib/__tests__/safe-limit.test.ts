/**
 * Tests for `safe-limit` — the pagination-limit boundary helpers.
 *
 * Covers the throwing constructor {@link safeLimit} (for literal /
 * known-valid inputs) and the non-throwing {@link clampLimit} (the
 * exported safe API for dynamically-derived limits, added for #1619 so
 * a bad config / restored-state / computed page size degrades into
 * range instead of throwing an uncaught render error).
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  LIST_BLOCKS_MAX,
  PAGINATION_MAX,
  SEARCH_BLOCKS_MAX,
  clampLimit,
  partitionedSearchLimit,
  safeLimit,
  safeLimitZero,
} from '../safe-limit'

describe('safeLimit', () => {
  it('returns the value unchanged when in range', () => {
    expect(safeLimit(1, PAGINATION_MAX)).toBe(1)
    expect(safeLimit(50, PAGINATION_MAX)).toBe(50)
    expect(safeLimit(PAGINATION_MAX, PAGINATION_MAX)).toBe(PAGINATION_MAX)
  })

  it('throws below 1', () => {
    expect(() => safeLimit(0, PAGINATION_MAX)).toThrow(RangeError)
    expect(() => safeLimit(-5, PAGINATION_MAX)).toThrow(RangeError)
  })

  it('throws above max', () => {
    expect(() => safeLimit(PAGINATION_MAX + 1, PAGINATION_MAX)).toThrow(RangeError)
    expect(() => safeLimit(500, PAGINATION_MAX)).toThrow(RangeError)
  })

  it('throws on non-integer', () => {
    expect(() => safeLimit(1.5, PAGINATION_MAX)).toThrow(RangeError)
    expect(() => safeLimit(Number.NaN, PAGINATION_MAX)).toThrow(RangeError)
    expect(() => safeLimit(Number.POSITIVE_INFINITY, PAGINATION_MAX)).toThrow(RangeError)
  })
})

describe('clampLimit', () => {
  it('passes a valid in-range value through unchanged', () => {
    expect(clampLimit(50, PAGINATION_MAX)).toBe(50)
    expect(clampLimit(1, PAGINATION_MAX)).toBe(1)
    expect(clampLimit(PAGINATION_MAX, PAGINATION_MAX)).toBe(PAGINATION_MAX)
  })

  it('clamps values below 1 up to 1', () => {
    expect(clampLimit(0, PAGINATION_MAX)).toBe(1)
    expect(clampLimit(-100, PAGINATION_MAX)).toBe(1)
  })

  it('clamps values above max down to max', () => {
    expect(clampLimit(PAGINATION_MAX + 1, PAGINATION_MAX)).toBe(PAGINATION_MAX)
    expect(clampLimit(10_000, PAGINATION_MAX)).toBe(PAGINATION_MAX)
    expect(clampLimit(150, LIST_BLOCKS_MAX)).toBe(LIST_BLOCKS_MAX)
  })

  it('floors non-integers into range', () => {
    expect(clampLimit(1.9, PAGINATION_MAX)).toBe(1)
    expect(clampLimit(49.99, PAGINATION_MAX)).toBe(49)
    // Floors first, then clamps: 0.4 -> 0 -> 1.
    expect(clampLimit(0.4, PAGINATION_MAX)).toBe(1)
  })

  it('degrades non-finite inputs into range without throwing', () => {
    // NaN fails the `>= 1` guard -> floor of 1; +Infinity clamps to max;
    // -Infinity fails the guard -> 1.
    expect(clampLimit(Number.NaN, PAGINATION_MAX)).toBe(1)
    expect(clampLimit(Number.POSITIVE_INFINITY, PAGINATION_MAX)).toBe(PAGINATION_MAX)
    expect(clampLimit(Number.NEGATIVE_INFINITY, PAGINATION_MAX)).toBe(1)
  })

  it('defaults max to PAGINATION_MAX when omitted', () => {
    expect(clampLimit(PAGINATION_MAX + 50)).toBe(PAGINATION_MAX)
    expect(clampLimit(50)).toBe(50)
  })

  it('never throws across a wide range of dynamic inputs', () => {
    for (const n of [-1, 0, 0.5, 1, 99.9, 200, 201, 1e9, Number.NaN]) {
      expect(() => clampLimit(n, PAGINATION_MAX)).not.toThrow()
    }
  })

  it('always yields an in-range integer for any double input (fuzz)', () => {
    fc.assert(
      fc.property(
        // Any double — includes ±Infinity, NaN, sub-1, huge, fractional.
        fc.double({ noDefaultInfinity: false, noNaN: false }),
        fc.integer({ min: 1, max: 1000 }),
        (n, max) => {
          const result = clampLimit(n, max)
          expect(Number.isInteger(result)).toBe(true)
          expect(result).toBeGreaterThanOrEqual(1)
          expect(result).toBeLessThanOrEqual(max)
        },
      ),
      { numRuns: 1000 },
    )
  })
})

describe('safeLimitZero (inclusive-zero lower bound)', () => {
  it('accepts 0 (the link-mode sentinel) unlike safeLimit', () => {
    expect(safeLimitZero(0, 100)).toBe(0)
    // The throwing [1, max] constructor rejects 0.
    expect(() => safeLimit(0, 100)).toThrow(RangeError)
  })

  it('accepts an in-range integer and the max boundary', () => {
    expect(safeLimitZero(40, 100)).toBe(40)
    expect(safeLimitZero(100, 100)).toBe(100)
  })

  it('throws on a negative value', () => {
    expect(() => safeLimitZero(-1, 100)).toThrow(RangeError)
  })

  it('throws when above the cap', () => {
    expect(() => safeLimitZero(101, 100)).toThrow(RangeError)
  })

  it('throws on non-integers', () => {
    expect(() => safeLimitZero(0.5, 100)).toThrow(RangeError)
  })
})

describe('partitionedSearchLimit', () => {
  it('accepts 0 (blockLimit: 0 = link-mode, pages only)', () => {
    expect(partitionedSearchLimit(0)).toBe(0)
  })

  it('accepts valid in-range limits and the SEARCH_BLOCKS_MAX boundary', () => {
    expect(partitionedSearchLimit(8)).toBe(8)
    expect(partitionedSearchLimit(40)).toBe(40)
    expect(partitionedSearchLimit(SEARCH_BLOCKS_MAX)).toBe(SEARCH_BLOCKS_MAX)
  })

  it('rejects an over-cap value (> SEARCH_BLOCKS_MAX) at the call site', () => {
    // 500 compiled cleanly before branding, then the backend hard-rejected
    // it at the IPC boundary (#1570). Now it throws here instead.
    expect(() => partitionedSearchLimit(SEARCH_BLOCKS_MAX + 1)).toThrow(RangeError)
    expect(() => partitionedSearchLimit(500)).toThrow(RangeError)
  })

  it('rejects negatives', () => {
    expect(() => partitionedSearchLimit(-1)).toThrow(RangeError)
  })
})
