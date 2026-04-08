/**
 * Tests for formatRelativeTime utility.
 *
 * Validates all time brackets:
 *  - Less than 60s → "just now"
 *  - Less than 60m → "Xm ago"
 *  - Less than 24h → "Xh ago"
 *  - 24h+ → "Xd ago"
 *  - Future timestamps → "just now"
 */

import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from '../format-relative-time'

// Simple mock t() that returns the key with interpolated values
function mockT(key: string, opts?: Record<string, unknown>): string {
  if (opts && 'count' in opts) {
    return `${key}:${opts.count}`
  }
  if (opts && 'time' in opts) {
    return `${key}:${opts.time}`
  }
  return key
}

describe('formatRelativeTime', () => {
  it('returns justNow for timestamps less than 60 seconds ago', () => {
    const now = new Date()
    const thirtySecsAgo = new Date(now.getTime() - 30_000).toISOString()
    expect(formatRelativeTime(thirtySecsAgo, mockT as never)).toBe('sidebar.justNow')
  })

  it('returns justNow for timestamps 0 seconds ago', () => {
    const now = new Date().toISOString()
    expect(formatRelativeTime(now, mockT as never)).toBe('sidebar.justNow')
  })

  it('returns minutesAgo for timestamps between 1-59 minutes ago', () => {
    const now = new Date()
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString()
    expect(formatRelativeTime(fiveMinAgo, mockT as never)).toBe('sidebar.minutesAgo:5')
  })

  it('returns minutesAgo for exactly 1 minute ago', () => {
    const now = new Date()
    const oneMinAgo = new Date(now.getTime() - 60_000).toISOString()
    expect(formatRelativeTime(oneMinAgo, mockT as never)).toBe('sidebar.minutesAgo:1')
  })

  it('returns minutesAgo for 59 minutes ago', () => {
    const now = new Date()
    const fiftyNineMinAgo = new Date(now.getTime() - 59 * 60_000).toISOString()
    expect(formatRelativeTime(fiftyNineMinAgo, mockT as never)).toBe('sidebar.minutesAgo:59')
  })

  it('returns hoursAgo for timestamps between 1-23 hours ago', () => {
    const now = new Date()
    const threeHoursAgo = new Date(now.getTime() - 3 * 3600_000).toISOString()
    expect(formatRelativeTime(threeHoursAgo, mockT as never)).toBe('sidebar.hoursAgo:3')
  })

  it('returns hoursAgo for exactly 1 hour ago', () => {
    const now = new Date()
    const oneHourAgo = new Date(now.getTime() - 3600_000).toISOString()
    expect(formatRelativeTime(oneHourAgo, mockT as never)).toBe('sidebar.hoursAgo:1')
  })

  it('returns hoursAgo for 23 hours ago', () => {
    const now = new Date()
    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 3600_000).toISOString()
    expect(formatRelativeTime(twentyThreeHoursAgo, mockT as never)).toBe('sidebar.hoursAgo:23')
  })

  it('returns daysAgo for timestamps 24+ hours ago', () => {
    const now = new Date()
    const twoDaysAgo = new Date(now.getTime() - 2 * 86400_000).toISOString()
    expect(formatRelativeTime(twoDaysAgo, mockT as never)).toBe('sidebar.daysAgo:2')
  })

  it('returns daysAgo for exactly 1 day ago', () => {
    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 86400_000).toISOString()
    expect(formatRelativeTime(oneDayAgo, mockT as never)).toBe('sidebar.daysAgo:1')
  })

  it('returns daysAgo for 30 days ago', () => {
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400_000).toISOString()
    expect(formatRelativeTime(thirtyDaysAgo, mockT as never)).toBe('sidebar.daysAgo:30')
  })

  it('returns justNow for future timestamps', () => {
    const now = new Date()
    const future = new Date(now.getTime() + 60_000).toISOString()
    expect(formatRelativeTime(future, mockT as never)).toBe('sidebar.justNow')
  })
})
