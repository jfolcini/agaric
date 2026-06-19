import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseDate } from '../parse-date'

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('parseDate', () => {
  const FAKE_NOW = new Date(2026, 3, 10) // April 10, 2026 (Friday)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FAKE_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ---- ISO formats ----
  it('parses ISO format YYYY-MM-DD', () => {
    expect(parseDate('2026-04-15')).toBe('2026-04-15')
  })

  it('parses ISO with slashes YYYY/MM/DD', () => {
    expect(parseDate('2026/04/15')).toBe('2026-04-15')
  })

  it('parses ISO with dots YYYY.MM.DD', () => {
    expect(parseDate('2026.04.15')).toBe('2026-04-15')
  })

  // ---- Relative (Org-mode style) ----
  it('parses relative days +3d', () => {
    const expected = new Date(FAKE_NOW)
    expected.setDate(expected.getDate() + 3)
    expect(parseDate('+3d')).toBe(fmt(expected))
  })

  it('parses relative weeks +1w', () => {
    const expected = new Date(FAKE_NOW)
    expected.setDate(expected.getDate() + 7)
    expect(parseDate('+1w')).toBe(fmt(expected))
  })

  it('parses relative months +2m', () => {
    const expected = new Date(FAKE_NOW)
    expected.setMonth(expected.getMonth() + 2)
    expect(parseDate('+2m')).toBe(fmt(expected))
  })

  // ---- Natural language ----
  it('parses "today"', () => {
    expect(parseDate('today')).toBe('2026-04-10')
  })

  it('parses "tomorrow"', () => {
    expect(parseDate('tomorrow')).toBe('2026-04-11')
  })

  it('parses "yesterday"', () => {
    expect(parseDate('yesterday')).toBe('2026-04-09')
  })

  it('parses "next monday"', () => {
    // April 10, 2026 is a Friday → next Monday is April 13
    expect(parseDate('next monday')).toBe('2026-04-13')
  })

  it('parses "next week"', () => {
    expect(parseDate('next week')).toBe('2026-04-17')
  })

  it('parses "in 3 days"', () => {
    expect(parseDate('in 3 days')).toBe('2026-04-13')
  })

  it('parses "in 2 weeks"', () => {
    expect(parseDate('in 2 weeks')).toBe('2026-04-24')
  })

  it('parses "end of month"', () => {
    expect(parseDate('end of month')).toBe('2026-04-30')
  })

  // ---- Month name formats ----
  it('parses "Apr 15, 2026"', () => {
    expect(parseDate('Apr 15, 2026')).toBe('2026-04-15')
  })

  it('parses "15 April 2026"', () => {
    expect(parseDate('15 April 2026')).toBe('2026-04-15')
  })

  it('parses "15-Apr-2026"', () => {
    expect(parseDate('15-Apr-2026')).toBe('2026-04-15')
  })

  // ---- No year ----
  it('parses "Apr 15" (future date in current year)', () => {
    // Apr 15 is after Apr 10 → same year
    expect(parseDate('Apr 15')).toBe('2026-04-15')
  })

  it('parses "Jan 5" (past date → next year)', () => {
    // Jan 5 is before Apr 10 → next year
    expect(parseDate('Jan 5')).toBe('2027-01-05')
  })

  // #1565: no-year numeric MM-DD / DD-MM
  it('parses no-year "5/13" as MM-DD (precedence unchanged)', () => {
    // May 13 is after Apr 10 → same year
    expect(parseDate('5/13')).toBe('2026-05-13')
  })

  it('parses no-year "13/5" via DD-MM fallback (first number > 12)', () => {
    // day=13, month=5 → May 13, after Apr 10 → same year
    expect(parseDate('13/5')).toBe('2026-05-13')
  })

  it('parses no-year "13-5" (dash separator) via DD-MM fallback', () => {
    expect(parseDate('13-5')).toBe('2026-05-13')
  })

  it('rejects no-year numeric where neither order is valid', () => {
    // 13 as month is invalid, and 99 as day is invalid in either order
    expect(parseDate('13/99')).toBeNull()
  })

  // #1565: leap-day default-year guard — Feb 29 in a non-leap current year
  // must not overflow to Mar 1; it resolves to the nearest future leap year.
  it('parses no-year "2/29" to nearest future leap year (not Mar 1)', () => {
    // FAKE_NOW = Apr 10, 2026 (non-leap). 2026/2027 non-leap → 2028 leap.
    expect(parseDate('2/29')).toBe('2028-02-29')
  })

  it('parses no-year "29/2" (DD-MM) to nearest future leap year', () => {
    expect(parseDate('29/2')).toBe('2028-02-29')
  })

  // #1565: loop-termination guard. Feb 30/31 and Apr 31 pass the (day<=31)
  // plausibility gate but hold in NO year — the default-year scan must be
  // bounded and fall through to rejection rather than spin forever.
  it('returns null for impossible "2/30" without hanging (Feb has no 30th)', () => {
    expect(parseDate('2/30')).toBeNull()
  })

  it('returns null for impossible "2/31" without hanging', () => {
    expect(parseDate('2/31')).toBeNull()
  })

  it('returns null for impossible "4/31" without hanging (Apr has 30 days)', () => {
    expect(parseDate('4/31')).toBeNull()
  })

  // #1565: non-edge dates keep ordinary default-year semantics (guard must not
  // hijack them). Mar 15 is before Apr 10 → rolls to next year (unchanged
  // behavior); May 13 is after → stays current year.
  it('rolls a past no-year date "3/15" to next year (unchanged)', () => {
    expect(parseDate('3/15')).toBe('2027-03-15')
  })

  it('keeps current year for a future no-year date "5/1" (unchanged)', () => {
    expect(parseDate('5/1')).toBe('2026-05-01')
  })

  // ---- Invalid inputs ----
  it('returns null for non-date string', () => {
    expect(parseDate('not a date')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseDate('')).toBeNull()
  })

  it('returns null for invalid month 13', () => {
    expect(parseDate('2026-13-01')).toBeNull()
  })

  // ---- Case insensitive ----
  it('handles case-insensitive "TOMORROW"', () => {
    expect(parseDate('TOMORROW')).toBe('2026-04-11')
  })

  // ---- Whitespace trimming ----
  it('trims whitespace around input', () => {
    expect(parseDate('  today  ')).toBe('2026-04-10')
  })

  // ---- Additional edge cases ----
  it('parses "in 1 month"', () => {
    expect(parseDate('in 1 month')).toBe('2026-05-10')
  })

  it('returns null for whitespace-only input', () => {
    expect(parseDate('   ')).toBeNull()
  })

  it('returns null for invalid day 32', () => {
    expect(parseDate('2026-01-32')).toBeNull()
  })
})

describe('edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('leap year: Feb 29 parses correctly', () => {
    expect(parseDate('2024-02-29')).toBe('2024-02-29')
  })

  it('month boundary: Jan 31 + 1 month clamps to end of Feb (date-fns addMonths)', () => {
    vi.setSystemTime(new Date('2026-01-31'))
    // #1254: month arithmetic clamps to the last valid day of the target month
    // (Feb 28 in 2026) instead of overflowing to March, matching date-fns
    // addMonths used by the sibling date-utils module.
    expect(parseDate('+1m')).toBe('2026-02-28')
  })

  it('month boundary: "in 1 month" from Jan 31 clamps to end of Feb', () => {
    vi.setSystemTime(new Date('2026-01-31'))
    expect(parseDate('in 1 month')).toBe('2026-02-28')
  })

  it('leap-year month boundary: Jan 31 + 1 month clamps to Feb 29 in 2028', () => {
    vi.setSystemTime(new Date('2028-01-31'))
    expect(parseDate('+1m')).toBe('2028-02-29')
  })

  it('zero offset: +0d returns today', () => {
    vi.setSystemTime(new Date('2026-04-10'))
    expect(parseDate('+0d')).toBe('2026-04-10')
  })

  it('year boundary: Dec 31 + 1 day', () => {
    vi.setSystemTime(new Date('2025-12-31'))
    expect(parseDate('+1d')).toBe('2026-01-01')
  })

  it('invalid month name rejected', () => {
    expect(parseDate('Foo 15')).toBeNull()
  })

  it('Feb 30 rejected', () => {
    expect(parseDate('2026-02-30')).toBeNull()
  })
})
