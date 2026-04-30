import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dueDateColor,
  formatCompactDate,
  formatDate,
  getDateRangeForFilter,
  getTodayString,
  getWeekOptions,
  isDateFormattedPage,
  MONTH_SHORT,
} from '../date-utils'

describe('formatDate (review-MAINT-129: timezone semantics regression)', () => {
  // The MAINT-129 migration replaced an inline `padStart`-based formatter
  // in `BlockListItem` with this date-fns-backed `formatDate`. The
  // padStart version used local-time `Date` getters (`getFullYear()`,
  // `getMonth()`, `getDate()`); date-fns `format(d, 'yyyy-MM-dd')` also
  // uses local-time getters. These tests pin that invariant — if a
  // future version of date-fns ever changed to UTC by default, every
  // user not in UTC would see dates shift by ±1 day near midnight.
  it('formats a Date as YYYY-MM-DD using local time getters', () => {
    // Construct a date with a local-time intent (Date(year, month, day)
    // is local-time per spec, regardless of the host TZ).
    const d = new Date(2026, 3, 29) // April 29, 2026 (month is 0-indexed)
    expect(formatDate(d)).toBe('2026-04-29')
  })

  it('does NOT shift the date by host timezone offset', () => {
    // Build a Date that, in UTC, would be on a DIFFERENT day than the
    // local-time Date(year, month, day) constructor produces. If formatDate
    // ever used UTC getters, this test would fail.
    //
    // We pick a moment late in local-time April 29 — for hosts west of
    // UTC the Date's UTC equivalent is April 30. For hosts east of UTC
    // the Date's UTC equivalent is still April 29 but we still verify
    // local-time wins.
    const d = new Date(2026, 3, 29, 23, 30, 0) // local 11:30 PM Apr 29
    expect(formatDate(d)).toBe('2026-04-29')
  })

  it('zero-pads single-digit months and days', () => {
    expect(formatDate(new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(formatDate(new Date(2026, 8, 9))).toBe('2026-09-09')
  })
})

describe('formatCompactDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 10)) // April 10, 2026
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('formats a same-year date compactly', () => {
    expect(formatCompactDate('2026-04-15')).toBe('Apr 15')
  })

  it('formats a different-year date with year', () => {
    expect(formatCompactDate('2025-12-25')).toBe('Dec 25, 2025')
  })

  it('returns original string for invalid format', () => {
    expect(formatCompactDate('not-a-date')).toBe('not-a-date')
  })

  it('returns original string for partial date', () => {
    expect(formatCompactDate('2026-04')).toBe('2026-04')
  })

  it('handles January correctly', () => {
    expect(formatCompactDate('2026-01-01')).toBe('Jan 1')
  })

  it('handles December of a different year', () => {
    expect(formatCompactDate('2027-12-31')).toBe('Dec 31, 2027')
  })
})

describe('MONTH_SHORT', () => {
  it('has 12 entries', () => expect(MONTH_SHORT).toHaveLength(12))
  it('starts with Jan', () => expect(MONTH_SHORT[0]).toBe('Jan'))
  it('ends with Dec', () => expect(MONTH_SHORT[11]).toBe('Dec'))
})

describe('getDateRangeForFilter', () => {
  // April 10, 2026 is a Friday
  const FAKE_NOW = new Date(2026, 3, 10)

  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(FAKE_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('returns today range for "today"', () => {
    const result = getDateRangeForFilter('today', FAKE_NOW)
    expect(result).toEqual({ start: '2026-04-10', end: '2026-04-10' })
  })

  it('returns Monday-Sunday range for "this-week"', () => {
    // April 10 is Friday -> Monday is April 6, Sunday is April 12
    const result = getDateRangeForFilter('this-week', FAKE_NOW)
    expect(result).toEqual({ start: '2026-04-06', end: '2026-04-12' })
  })

  it('handles Sunday correctly for "this-week"', () => {
    const sunday = new Date(2026, 3, 12) // April 12, 2026 (Sunday)
    const result = getDateRangeForFilter('this-week', sunday)
    expect(result).toEqual({ start: '2026-04-06', end: '2026-04-12' })
  })

  it('returns first-last day for "this-month"', () => {
    const result = getDateRangeForFilter('this-month', FAKE_NOW)
    expect(result).toEqual({ start: '2026-04-01', end: '2026-04-30' })
  })

  it('returns null for "overdue"', () => {
    expect(getDateRangeForFilter('overdue', FAKE_NOW)).toBeNull()
  })

  it('computes next-7-days range', () => {
    const result = getDateRangeForFilter('next-7-days', FAKE_NOW)
    expect(result).toEqual({ start: '2026-04-10', end: '2026-04-16' })
  })

  it('computes next-14-days range', () => {
    const result = getDateRangeForFilter('next-14-days', FAKE_NOW)
    expect(result).toEqual({ start: '2026-04-10', end: '2026-04-23' })
  })

  it('computes next-30-days range crossing month boundary', () => {
    const result = getDateRangeForFilter('next-30-days', FAKE_NOW)
    expect(result).toEqual({ start: '2026-04-10', end: '2026-05-09' })
  })

  it('computes last-7-days range', () => {
    const result = getDateRangeForFilter('last-7-days', FAKE_NOW)
    expect(result).toEqual({ start: '2026-04-04', end: '2026-04-10' })
  })

  it('computes last-30-days range crossing month boundary', () => {
    const result = getDateRangeForFilter('last-30-days', FAKE_NOW)
    expect(result).toEqual({ start: '2026-03-12', end: '2026-04-10' })
  })

  it('returns null for unknown preset', () => {
    expect(getDateRangeForFilter('unknown', FAKE_NOW)).toBeNull()
  })

  it('returns Sunday-Saturday range for "this-week" when week starts on Sunday', () => {
    localStorage.setItem('week-start-preference', '0')
    // April 10, 2026 is Friday -> Sunday is April 5, Saturday is April 11
    const result = getDateRangeForFilter('this-week', FAKE_NOW)
    expect(result).toEqual({ start: '2026-04-05', end: '2026-04-11' })
  })
})

describe('getTodayString', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns today formatted as YYYY-MM-DD', () => {
    vi.setSystemTime(new Date(2026, 3, 10))
    expect(getTodayString()).toBe('2026-04-10')
  })
})

describe('dueDateColor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 10)) // April 10, 2026
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns destructive classes for past dates', () => {
    expect(dueDateColor('2025-12-31')).toBe('bg-destructive/10 text-destructive')
  })

  it('returns destructive classes for the day before today', () => {
    expect(dueDateColor('2026-04-09')).toBe('bg-destructive/10 text-destructive')
  })

  it('returns status-pending classes for today', () => {
    expect(dueDateColor('2026-04-10')).toBe('bg-status-pending text-status-pending-foreground')
  })

  it('returns muted classes for the day after today', () => {
    expect(dueDateColor('2026-04-11')).toBe('bg-muted text-muted-foreground')
  })

  it('returns muted classes for far-future dates', () => {
    expect(dueDateColor('2099-12-31')).toBe('bg-muted text-muted-foreground')
  })
})

describe('isDateFormattedPage', () => {
  it('returns true for valid YYYY-MM-DD', () => {
    expect(isDateFormattedPage('2026-04-06')).toBe(true)
    expect(isDateFormattedPage('2020-01-01')).toBe(true)
  })

  it('returns false for non-date strings', () => {
    expect(isDateFormattedPage('My Page')).toBe(false)
    expect(isDateFormattedPage('2026-04')).toBe(false)
    expect(isDateFormattedPage('2026-04-06 extra')).toBe(false)
    expect(isDateFormattedPage('')).toBe(false)
  })
})

describe('getWeekOptions', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('returns weekStartsOn: 1 by default', () => {
    localStorage.clear()
    expect(getWeekOptions()).toEqual({ weekStartsOn: 1 })
  })

  it('returns weekStartsOn: 0 when preference is Sunday', () => {
    localStorage.setItem('week-start-preference', '0')
    expect(getWeekOptions()).toEqual({ weekStartsOn: 0 })
  })

  it('returns weekStartsOn: 1 for invalid preference', () => {
    localStorage.setItem('week-start-preference', 'garbage')
    expect(getWeekOptions()).toEqual({ weekStartsOn: 1 })
  })
})
