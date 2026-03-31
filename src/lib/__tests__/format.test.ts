/**
 * Tests for src/lib/format.ts — formatTimestamp utility.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatTimestamp } from '../format'

// ── Fake-timer anchor ────────────────────────────────────────────────────
// All relative-time tests pin "now" to this instant so diffs are deterministic.
const NOW = new Date('2025-06-15T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Invalid input ────────────────────────────────────────────────────────

describe('invalid date handling', () => {
  it('returns the raw string for an unparseable date', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date')
  })

  it('returns the raw string for an empty string', () => {
    expect(formatTimestamp('')).toBe('')
  })

  it('returns the raw string for garbage input', () => {
    expect(formatTimestamp('abc123xyz')).toBe('abc123xyz')
  })
})

// ── Relative style ───────────────────────────────────────────────────────

describe('relative style', () => {
  it('returns "Just now" for timestamps less than 1 minute ago', () => {
    const thirtySecsAgo = new Date(NOW.getTime() - 30_000).toISOString()
    expect(formatTimestamp(thirtySecsAgo, 'relative')).toBe('Just now')
  })

  it('returns "Just now" for the exact current time', () => {
    expect(formatTimestamp(NOW.toISOString(), 'relative')).toBe('Just now')
  })

  it('returns "Xm ago" for 1 minute', () => {
    const oneMinAgo = new Date(NOW.getTime() - 60_000).toISOString()
    expect(formatTimestamp(oneMinAgo, 'relative')).toBe('1m ago')
  })

  it('returns "Xm ago" for 59 minutes', () => {
    const fiftyNineMinAgo = new Date(NOW.getTime() - 59 * 60_000).toISOString()
    expect(formatTimestamp(fiftyNineMinAgo, 'relative')).toBe('59m ago')
  })

  it('returns "Xh ago" for 1 hour', () => {
    const oneHrAgo = new Date(NOW.getTime() - 60 * 60_000).toISOString()
    expect(formatTimestamp(oneHrAgo, 'relative')).toBe('1h ago')
  })

  it('returns "Xh ago" for 23 hours', () => {
    const twentyThreeHrAgo = new Date(NOW.getTime() - 23 * 60 * 60_000).toISOString()
    expect(formatTimestamp(twentyThreeHrAgo, 'relative')).toBe('23h ago')
  })

  it('returns "Xd ago" for 1 day', () => {
    const oneDayAgo = new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString()
    expect(formatTimestamp(oneDayAgo, 'relative')).toBe('1d ago')
  })

  it('returns "Xd ago" for 29 days', () => {
    const twentyNineDaysAgo = new Date(NOW.getTime() - 29 * 24 * 60 * 60_000).toISOString()
    expect(formatTimestamp(twentyNineDaysAgo, 'relative')).toBe('29d ago')
  })

  it('falls back to toLocaleDateString for 30+ days', () => {
    const thirtyDaysAgo = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000)
    const result = formatTimestamp(thirtyDaysAgo.toISOString(), 'relative')
    // Should match the locale-formatted date (not a relative string)
    expect(result).toBe(thirtyDaysAgo.toLocaleDateString())
  })

  it('falls back to toLocaleDateString for 90+ days', () => {
    const ninetyDaysAgo = new Date(NOW.getTime() - 90 * 24 * 60 * 60_000)
    const result = formatTimestamp(ninetyDaysAgo.toISOString(), 'relative')
    expect(result).toBe(ninetyDaysAgo.toLocaleDateString())
  })
})

// ── Date style ───────────────────────────────────────────────────────────

describe('date style', () => {
  it('returns a formatted date string without time', () => {
    const iso = '2025-03-15T14:30:00Z'
    const expected = new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    expect(formatTimestamp(iso, 'date')).toBe(expected)
  })
})

// ── Full style (default) ─────────────────────────────────────────────────

describe('full style (default)', () => {
  it('returns date + time when style is "full"', () => {
    const iso = '2025-03-15T14:30:00Z'
    const expected = new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    expect(formatTimestamp(iso, 'full')).toBe(expected)
  })

  it('defaults to "full" style when no style argument is provided', () => {
    const iso = '2025-03-15T14:30:00Z'
    const withFull = formatTimestamp(iso, 'full')
    const withDefault = formatTimestamp(iso)
    expect(withDefault).toBe(withFull)
  })
})
