/**
 * Property-based tests for date parsing and formatting (fast-check).
 *
 * These complement the example-based tests with generative fuzzing.
 * Covers: parseDate (parse-date.ts), formatDate, formatCompactDate,
 * isDateFormattedPage (date-utils.ts).
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatCompactDate, formatDate, isDateFormattedPage } from '../date-utils'
import { parseDate } from '../parse-date'

// -- Configuration ------------------------------------------------------------

/** Number of runs per property. Matches existing property test config. */
const NUM_RUNS = 500

// -- Generators ---------------------------------------------------------------

/** YYYY-MM-DD date string with valid ranges. */
const arbDateString: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 1901, max: 2099 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }), // 28 is always valid for any month
  )
  .map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)

/**
 * A Date object within the range parseDate considers valid (1901-2099).
 * We clamp to day 1-28 to avoid month-boundary issues in round-trip tests.
 */
const arbSafeDate: fc.Arbitrary<Date> = fc
  .tuple(
    fc.integer({ min: 1901, max: 2099 }),
    fc.integer({ min: 0, max: 11 }), // JS months are 0-based
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => new Date(y, m, d))

// -- Properties: parseDate safety ---------------------------------------------

describe('property: parseDate safety', () => {
  it('parseDate never throws for arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (s) => {
        // Should not throw — returns string | null
        const result = parseDate(s)
        expect(result === null || typeof result === 'string').toBe(true)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('parseDate never throws for unicode and special characters', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme-composite', minLength: 0, maxLength: 100 }), (s) => {
        const result = parseDate(s)
        expect(result === null || typeof result === 'string').toBe(true)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('parseDate result is always null or a valid YYYY-MM-DD string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (s) => {
        const result = parseDate(s)
        if (result !== null) {
          expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          // Verify the components represent a valid date
          const [y, m, d] = result.split('-').map(Number) as [number, number, number]
          expect(y).toBeGreaterThanOrEqual(1901)
          expect(y).toBeLessThanOrEqual(2099)
          expect(m).toBeGreaterThanOrEqual(1)
          expect(m).toBeLessThanOrEqual(12)
          expect(d).toBeGreaterThanOrEqual(1)
          expect(d).toBeLessThanOrEqual(31)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- Properties: round-trip stability -----------------------------------------

describe('property: date round-trip stability', () => {
  it('parseDate(formatDate(d)) preserves year/month/day for valid dates', () => {
    fc.assert(
      fc.property(arbSafeDate, (d) => {
        const formatted = formatDate(d)
        const parsed = parseDate(formatted)
        expect(parsed).not.toBeNull()
        expect(parsed).toBe(formatted)
        // Verify the components match the original Date
        const [y, m, day] = (parsed as string).split('-').map(Number) as [number, number, number]
        expect(y).toBe(d.getFullYear())
        expect(m).toBe(d.getMonth() + 1)
        expect(day).toBe(d.getDate())
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('parseDate is idempotent: parseDate(parseDate(s) ?? "") stabilizes', () => {
    fc.assert(
      fc.property(arbDateString, (s) => {
        const first = parseDate(s)
        if (first !== null) {
          const second = parseDate(first)
          expect(second).toBe(first)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- Properties: formatDate ---------------------------------------------------

describe('property: formatDate', () => {
  it('always produces a string matching YYYY-MM-DD pattern', () => {
    fc.assert(
      fc.property(arbSafeDate, (d) => {
        const result = formatDate(d)
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('formatDate output length is always 10 characters', () => {
    fc.assert(
      fc.property(arbSafeDate, (d) => {
        expect(formatDate(d)).toHaveLength(10)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- Properties: formatCompactDate --------------------------------------------

describe('property: formatCompactDate safety', () => {
  it('never throws for arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (s) => {
        const result = formatCompactDate(s)
        expect(typeof result).toBe('string')
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('returns the original string when format is not YYYY-MM-DD', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }).filter((s) => !/^\d+-\d+-\d+$/.test(s)),
        (s) => {
          expect(formatCompactDate(s)).toBe(s)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('returns a non-empty string for valid YYYY-MM-DD inputs', () => {
    fc.assert(
      fc.property(arbDateString, (s) => {
        const result = formatCompactDate(s)
        expect(result.length).toBeGreaterThan(0)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// -- Properties: isDateFormattedPage ------------------------------------------

describe('property: isDateFormattedPage', () => {
  it('returns true for all valid YYYY-MM-DD strings', () => {
    fc.assert(
      fc.property(arbDateString, (s) => {
        expect(isDateFormattedPage(s)).toBe(true)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('returns false for strings that do not match YYYY-MM-DD pattern', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }).filter((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s)),
        (s) => {
          expect(isDateFormattedPage(s)).toBe(false)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('never throws for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (s) => {
        const result = isDateFormattedPage(s)
        expect(typeof result).toBe('boolean')
      }),
      { numRuns: NUM_RUNS },
    )
  })
})
