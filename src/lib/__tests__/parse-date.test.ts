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
