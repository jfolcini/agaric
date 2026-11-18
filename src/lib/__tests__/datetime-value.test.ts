import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  datetimeToLocalParts,
  formatDatetimeForDisplay,
  formatDatetimeWithOffset,
  isCanonicalDatetime,
  localDayStartUtc,
  localPartsToDatetime,
  parseDatetimeInput,
} from '@/lib/datetime-value'

/**
 * Runs `body` in `tz`, or skips it where the worker ignores `process.env.TZ`
 * (the `pool: 'threads'` the Stryker runner forces): `probe` must hold there.
 */
function inZone(tz: string, probe: () => boolean, body: () => void): void {
  vi.stubEnv('TZ', tz)
  try {
    if (!probe()) return
    body()
  } finally {
    vi.unstubAllEnvs()
  }
}

// Berlin is UTC+1 in November and UTC+2 in July.
const inBerlin = (body: () => void) =>
  inZone('Europe/Berlin', () => new Date(Date.UTC(2026, 10, 14, 8, 30)).getHours() === 9, body)

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isCanonicalDatetime', () => {
  it('takes the fixed-width UTC minute form', () => {
    expect(isCanonicalDatetime('2026-11-14T08:30Z')).toBe(true)
  })

  it('refuses a day, seconds, an offset, a space and an impossible instant', () => {
    expect(isCanonicalDatetime('2026-11-14')).toBe(false)
    expect(isCanonicalDatetime('2026-11-14T08:30:00Z')).toBe(false)
    expect(isCanonicalDatetime('2026-11-14T08:30+01:00')).toBe(false)
    expect(isCanonicalDatetime('2026-11-14 08:30Z')).toBe(false)
    expect(isCanonicalDatetime('2026-02-30T08:30Z')).toBe(false)
    expect(isCanonicalDatetime('2026-11-14T24:00Z')).toBe(false)
    expect(isCanonicalDatetime('2026-11-14T08:60Z')).toBe(false)
  })
})

describe('parseDatetimeInput', () => {
  it('reads a zone-less time in the device time zone', () => {
    inBerlin(() => {
      expect(parseDatetimeInput('2026-11-14T09:30')).toBe('2026-11-14T08:30Z')
      expect(parseDatetimeInput('2026-11-14 09:30')).toBe('2026-11-14T08:30Z')
      expect(parseDatetimeInput('2026-07-14 09:30')).toBe('2026-07-14T07:30Z')
    })
  })

  it('reads Z and an offset as the instant they name, whatever the device zone', () => {
    inBerlin(() => {
      expect(parseDatetimeInput('2026-11-14T08:30Z')).toBe('2026-11-14T08:30Z')
      expect(parseDatetimeInput('2026-11-14T09:30+05:30')).toBe('2026-11-14T04:00Z')
      expect(parseDatetimeInput('2026-11-14T23:30-02:00')).toBe('2026-11-15T01:30Z')
    })
  })

  it('drops seconds', () => {
    expect(parseDatetimeInput('2026-11-14T08:30:59Z')).toBe('2026-11-14T08:30Z')
  })

  it('takes no day alone, which is never midnight', () => {
    expect(parseDatetimeInput('2026-11-14')).toBeNull()
  })

  it('refuses a malformed or impossible value', () => {
    expect(parseDatetimeInput('2026-11-14  09:30')).toBeNull()
    expect(parseDatetimeInput('2026-11-14T9:30')).toBeNull()
    expect(parseDatetimeInput('2026-02-30T09:30Z')).toBeNull()
    expect(parseDatetimeInput('2026-11-14T25:00Z')).toBeNull()
    expect(parseDatetimeInput('2026-11-14T09:30:61Z')).toBeNull()
    expect(parseDatetimeInput('2026-11-14T09:30+24:00')).toBeNull()
    expect(parseDatetimeInput('next friday 9:30')).toBeNull()
    expect(parseDatetimeInput('')).toBeNull()
  })

  it('refuses a local time the clocks skipped', () => {
    // Berlin skipped 02:00-03:00 on 2026-03-29.
    inBerlin(() => {
      expect(parseDatetimeInput('2026-03-29T02:30')).toBeNull()
      expect(parseDatetimeInput('2026-03-29T03:30')).toBe('2026-03-29T01:30Z')
    })
  })
})

describe('local parts', () => {
  it('splits a canonical value into the device-local day and time', () => {
    inBerlin(() => {
      expect(datetimeToLocalParts('2026-11-14T23:30Z')).toEqual({
        date: '2026-11-15',
        time: '00:30',
      })
    })
  })

  it('joins a local day and time into the canonical UTC value', () => {
    inBerlin(() => {
      expect(localPartsToDatetime('2026-11-15', '00:30')).toBe('2026-11-14T23:30Z')
    })
  })

  it('refuses parts that make no time', () => {
    expect(localPartsToDatetime('2026-11-15', '')).toBeNull()
    expect(localPartsToDatetime('', '09:30')).toBeNull()
  })

  it('shows a canonical value as its local day and time', () => {
    inBerlin(() => {
      expect(formatDatetimeForDisplay('2026-11-14T08:30Z')).toBe('2026-11-14 09:30')
    })
  })

  it('shows any other value as it is', () => {
    expect(formatDatetimeForDisplay('2026-11-14')).toBe('2026-11-14')
  })

  it('writes a canonical value as its local time with its offset, as Markdown does', () => {
    inBerlin(() => {
      expect(formatDatetimeWithOffset('2026-11-14T08:30Z')).toBe('2026-11-14T09:30+01:00')
      expect(formatDatetimeWithOffset('2026-07-14T23:30Z')).toBe('2026-07-15T01:30+02:00')
    })
    inZone(
      'America/St_Johns',
      () => new Date(Date.UTC(2026, 10, 14, 12, 0)).getMinutes() === 30,
      () => {
        expect(formatDatetimeWithOffset('2026-11-14T12:00Z')).toBe('2026-11-14T08:30-03:30')
      },
    )
  })

  it("gives a local day's first instant in UTC", () => {
    inBerlin(() => {
      expect(localDayStartUtc('2026-11-14')).toBe('2026-11-13T23:00Z')
    })
  })
})
