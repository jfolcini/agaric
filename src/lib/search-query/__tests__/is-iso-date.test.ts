import { describe, expect, it } from 'vitest'

import { isIsoDate } from '@/lib/search-query/is-iso-date'

describe('isIsoDate', () => {
  it('takes a real calendar day', () => {
    expect(isIsoDate('2026-01-05')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true)
  })

  it('refuses a day the calendar lacks or a malformed date', () => {
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-1-5')).toBe(false)
    expect(isIsoDate(' 2026-01-05')).toBe(false)
  })

  it('reads years 0000-0099 as themselves, not as 1900-1999', () => {
    expect(isIsoDate('0024-02-29')).toBe(true)
    expect(isIsoDate('0025-02-29')).toBe(false)
    expect(isIsoDate('0000-01-01')).toBe(true)
    expect(isIsoDate('0099-12-31')).toBe(true)
  })
})
