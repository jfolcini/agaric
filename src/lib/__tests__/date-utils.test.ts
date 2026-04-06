import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatCompactDate,
  getDateRangeForFilter,
  getTodayString,
  isDateFormattedPage,
} from '../date-utils'

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

describe('getDateRangeForFilter', () => {
  // April 10, 2026 is a Friday
  const FAKE_NOW = new Date(2026, 3, 10)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FAKE_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
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
})

describe('getTodayString', () => {
  it('returns today formatted as YYYY-MM-DD', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 3, 10))
    expect(getTodayString()).toBe('2026-04-10')
    vi.useRealTimers()
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
