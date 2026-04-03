import { describe, expect, it } from 'vitest'
import { formatRepeatLabel } from '../repeat-utils'

describe('formatRepeatLabel', () => {
  it('returns "daily" for standard daily', () => {
    expect(formatRepeatLabel('daily')).toBe('daily')
  })

  it('returns "weekly (from completion)" for .+weekly', () => {
    expect(formatRepeatLabel('.+weekly')).toBe('weekly (from completion)')
  })

  it('returns "monthly (catch-up)" for ++monthly', () => {
    expect(formatRepeatLabel('++monthly')).toBe('monthly (catch-up)')
  })

  it('returns "every 3 days" for +3d', () => {
    expect(formatRepeatLabel('+3d')).toBe('every 3 days')
  })

  it('returns "every 2 weeks" for 2w', () => {
    expect(formatRepeatLabel('2w')).toBe('every 2 weeks')
  })

  it('returns raw value for unknown format', () => {
    expect(formatRepeatLabel('custom-value')).toBe('custom-value')
  })

  it('returns "yearly" for standard yearly', () => {
    expect(formatRepeatLabel('yearly')).toBe('yearly')
  })

  it('returns empty string for empty input', () => {
    expect(formatRepeatLabel('')).toBe('')
  })

  it('returns "daily (from completion)" for .+daily', () => {
    expect(formatRepeatLabel('.+daily')).toBe('daily (from completion)')
  })

  it('returns "daily (catch-up)" for ++daily', () => {
    expect(formatRepeatLabel('++daily')).toBe('daily (catch-up)')
  })

  it('returns "every 1 month" for 1m (singular)', () => {
    expect(formatRepeatLabel('1m')).toBe('every 1 month')
  })

  it('returns "every 1 day" for 1d (singular)', () => {
    expect(formatRepeatLabel('1d')).toBe('every 1 day')
  })

  it('returns "every 1 week" for 1w (singular)', () => {
    expect(formatRepeatLabel('1w')).toBe('every 1 week')
  })
})
