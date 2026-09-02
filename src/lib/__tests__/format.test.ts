/**
 * Tests for src/lib/format.ts — formatTimestamp (absolute styles), truncateId.
 *
 * Relative-time formatting (and the old `formatLastSynced` "Never synced"
 * helper) moved to `formatRelativeTime` (i18n-aware) — see #745 and
 * format-relative-time.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatTimestamp, truncateId, ulidToDate } from '@/lib/format'
import { i18n } from '@/lib/i18n'

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

// #4555 — `formatTimestamp` used to pass `undefined` (the OS/browser
// locale) to `toLocaleDateString`. `getAppLocaleTag()` binds it to the same
// source the UI catalog resolves from instead, so this can never disagree
// with it. Pins the TRACKING behaviour via a real `i18n.changeLanguage()`
// round trip (Intl reads the runtime's own ICU data directly — it doesn't
// consult `date-locale.ts`'s `DATE_LOCALES` map — so a real BCP-47 tag is
// used rather than a synthetic registered one).
describe('locale tracking (#4555)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders English under the app default locale', () => {
    const iso = '2025-03-15T14:30:00Z'
    expect(formatTimestamp(iso, 'date')).toBe('Mar 15, 2025')
  })

  it('tracks a changed app locale, and reverts when it changes back', async () => {
    const iso = '2025-03-15T14:30:00Z'
    await i18n.changeLanguage('es')
    expect(formatTimestamp(iso, 'date')).toBe('15 mar 2025')
    await i18n.changeLanguage('en')
    expect(formatTimestamp(iso, 'date')).toBe('Mar 15, 2025')
  })
})

// ── truncateId ───────────────────────────────────────────────────────────

describe('truncateId', () => {
  it('returns the full string when shorter than len', () => {
    expect(truncateId('abc')).toBe('abc')
  })

  it('returns the full string when equal to len', () => {
    expect(truncateId('abcdefghijkl')).toBe('abcdefghijkl') // exactly 12
  })

  it('truncates and adds ellipsis when longer than len', () => {
    expect(truncateId('abcdefghijklmno')).toBe('abcdefghijkl...')
  })

  it('respects custom length parameter', () => {
    expect(truncateId('abcdefghij', 5)).toBe('abcde...')
  })

  it('handles empty string', () => {
    expect(truncateId('')).toBe('')
  })
})

// ── ulidToDate ───────────────────────────────────────────────────────────

/** Encode a millisecond timestamp into a 10-character Crockford base32 ULID prefix. */
function encodeUlidTimestamp(ms: number): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let chars = ''
  let remaining = ms
  for (let i = 0; i < 10; i++) {
    chars = ALPHABET[remaining % 32] + chars
    remaining = Math.floor(remaining / 32)
  }
  return chars
}

describe('ulidToDate', () => {
  it('decodes a valid ULID to the correct timestamp', () => {
    const ts = 1700000000000
    const prefix = encodeUlidTimestamp(ts)
    const ulid = `${prefix}ABCDEFGHIJKLMNOP` // 26 chars total
    const date = ulidToDate(ulid)
    expect(date).not.toBeNull()
    expect(date?.getTime()).toBe(ts)
  })

  it('returns null for empty string', () => {
    expect(ulidToDate('')).toBeNull()
  })

  it('returns null for string shorter than 10 chars', () => {
    expect(ulidToDate('ABC')).toBeNull()
  })

  it('returns null for invalid Crockford base32 characters', () => {
    expect(ulidToDate('IIIIIIIIIIIIIIIIIIIIIIIIII')).toBeNull() // 'I' not in Crockford
  })

  it('handles lowercase ULIDs (normalizes to uppercase)', () => {
    const ts = 1700000000000
    const prefix = encodeUlidTimestamp(ts).toLowerCase()
    const ulid = `${prefix}abcdefghijklmnop`
    const date = ulidToDate(ulid)
    expect(date).not.toBeNull()
    expect(date?.getTime()).toBe(ts)
  })

  it('decodes epoch zero', () => {
    const ulid = '0000000000ABCDEFGHIJKLMNOP'
    const date = ulidToDate(ulid)
    expect(date).not.toBeNull()
    expect(date?.getTime()).toBe(0)
  })
})
