import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  dueDateColor,
  formatCompactDate,
  formatDate,
  formatJournalTitle,
  formatWeekRange,
  getCalendarMonthRange,
  getDateRangeForFilter,
  getMaxJournalDate,
  getTodayString,
  getWeekDays,
  getWeekOptions,
  getWeekRange,
  isDateFormattedPage,
  MONTH_SHORT,
} from '@/lib/date-utils'

describe('formatDate (review-timezone semantics regression)', () => {
  // The migration replaced an inline `padStart`-based formatter
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

  it('returns original string for month 0', () => {
    expect(formatCompactDate('2026-00-15')).toBe('2026-00-15')
  })

  it('returns original string for month 13', () => {
    expect(formatCompactDate('2026-13-15')).toBe('2026-13-15')
  })

  it('returns original string for day 0', () => {
    expect(formatCompactDate('2026-04-00')).toBe('2026-04-00')
  })

  it('returns original string for day 32', () => {
    expect(formatCompactDate('2026-04-32')).toBe('2026-04-32')
  })

  it('returns original string when there are more than 3 dash-separated parts', () => {
    // 4 parts, but the first 3 parse to a valid month/day: only the
    // `parts.length !== 3` guard (not the NaN/undefined guards below it)
    // can reject this, since Number.parseInt-style coercion would happily
    // ignore the extra segment.
    expect(formatCompactDate('2026-04-15-extra')).toBe('2026-04-15-extra')
  })

  it('returns original string when a component is non-numeric', () => {
    // Exactly 3 parts, so the length guard passes through; only 1 of the
    // 3 components is NaN, which also exercises the `||` (vs `&&`) between
    // the isNaN checks.
    expect(formatCompactDate('2026-ab-15')).toBe('2026-ab-15')
  })
})

describe('MONTH_SHORT', () => {
  it('has 12 entries', () => expect(MONTH_SHORT).toHaveLength(12))
  it('starts with Jan', () => expect(MONTH_SHORT[0]).toBe('Jan'))
  it('ends with Dec', () => expect(MONTH_SHORT[11]).toBe('Dec'))

  it('contains all 12 month abbreviations in order', () => {
    expect(MONTH_SHORT).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ])
  })
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

  it('does not match "next-" with no digits (Regex quantifier guard)', () => {
    expect(getDateRangeForFilter('next--days', FAKE_NOW)).toBeNull()
  })

  it('does not match "next-N-days" with trailing garbage (Regex end-anchor guard)', () => {
    expect(getDateRangeForFilter('next-7-days-tomorrow', FAKE_NOW)).toBeNull()
  })

  it('does not match "next-N-days" with leading garbage (Regex start-anchor guard)', () => {
    expect(getDateRangeForFilter('xnext-7-days', FAKE_NOW)).toBeNull()
  })

  it('does not match "last-" with no digits (Regex quantifier guard)', () => {
    expect(getDateRangeForFilter('last--days', FAKE_NOW)).toBeNull()
  })

  it('does not match "last-N-days" with trailing garbage (Regex end-anchor guard)', () => {
    expect(getDateRangeForFilter('last-7-days-ago', FAKE_NOW)).toBeNull()
  })

  it('does not match "last-N-days" with leading garbage (Regex start-anchor guard)', () => {
    expect(getDateRangeForFilter('xlast-7-days', FAKE_NOW)).toBeNull()
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

describe('getMaxJournalDate (#757)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns 12 months from today', () => {
    vi.setSystemTime(new Date(2026, 3, 10)) // April 10, 2026
    expect(formatDate(getMaxJournalDate())).toBe('2027-04-10')
  })

  it('tracks the wall clock instead of freezing at module load', () => {
    // The pre-#757 `MAX_JOURNAL_DATE` const was computed once at import
    // time, so the navigable horizon silently shrank in long sessions.
    vi.setSystemTime(new Date(2026, 3, 10))
    const first = getMaxJournalDate()

    // 30 days later in the same session the horizon must have advanced.
    vi.setSystemTime(new Date(2026, 4, 10))
    const second = getMaxJournalDate()

    expect(formatDate(first)).toBe('2027-04-10')
    expect(formatDate(second)).toBe('2027-05-10')
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

  it('returns false for a title with leading characters before the date (Regex start-anchor guard)', () => {
    expect(isDateFormattedPage('x2026-04-06')).toBe(false)
  })

  it('returns false for a title with the wrong digit counts (Regex digit-count guard)', () => {
    expect(isDateFormattedPage('20261-04-06')).toBe(false)
    expect(isDateFormattedPage('2026-4-06')).toBe(false)
    expect(isDateFormattedPage('2026-04-6')).toBe(false)
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

describe('formatJournalTitle (#1448 — display-only journal date format)', () => {
  const ISO = '2026-06-17'

  it('is the identity transform for the ISO token (yyyy-MM-dd → unchanged)', () => {
    expect(formatJournalTitle(ISO, 'yyyy-MM-dd')).toBe('2026-06-17')
  })

  it('renders the localized default preset via the existing display formatter', () => {
    // The `locale` default must reproduce `formatDateDisplay` exactly so that
    // existing users see no change. Compare against the same locale call.
    const expected = new Date(2026, 5, 17).toLocaleDateString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    expect(formatJournalTitle(ISO, 'locale')).toBe(expected)
  })

  it('formats the long preset: MMMM d, yyyy → "June 17, 2026"', () => {
    expect(formatJournalTitle(ISO, 'MMMM d, yyyy')).toBe('June 17, 2026')
  })

  it('formats the slash preset: dd/MM/yyyy → "17/06/2026"', () => {
    expect(formatJournalTitle(ISO, 'dd/MM/yyyy')).toBe('17/06/2026')
  })

  it('formats the weekday preset: EEE, MMM d → "Wed, Jun 17"', () => {
    expect(formatJournalTitle(ISO, 'EEE, MMM d')).toBe('Wed, Jun 17')
  })

  it('parses the ISO key locally (no timezone drift across presets)', () => {
    // 2020-01-01 is a Wednesday; a UTC-vs-local off-by-one would render Tue.
    expect(formatJournalTitle('2020-01-01', 'EEE, MMM d')).toBe('Wed, Jan 1')
  })

  it('returns the raw string unchanged for non-ISO input (never throws)', () => {
    expect(formatJournalTitle('My Page', 'MMMM d, yyyy')).toBe('My Page')
    expect(formatJournalTitle('2026-13-40', 'MMMM d, yyyy')).toBe('2026-13-40')
    expect(formatJournalTitle('2026-02-30', 'MMMM d, yyyy')).toBe('2026-02-30')
  })

  it('does not treat a string with trailing characters as ISO (Regex end-anchor guard)', () => {
    expect(formatJournalTitle('2026-06-17X', 'MMMM d, yyyy')).toBe('2026-06-17X')
  })

  it('does not treat a string with leading characters as ISO (Regex start-anchor guard)', () => {
    expect(formatJournalTitle('X2026-06-17', 'MMMM d, yyyy')).toBe('X2026-06-17')
  })

  it('does not treat a single-digit month/day as ISO (Regex digit-count guard)', () => {
    expect(formatJournalTitle('2026-6-17', 'MMMM d, yyyy')).toBe('2026-6-17')
  })

  it('does not treat a 2-digit year as ISO (Regex digit-count guard)', () => {
    expect(formatJournalTitle('26-06-17', 'MMMM d, yyyy')).toBe('26-06-17')
  })

  it('rejects a year below 1000 via the round-trip fallback path', () => {
    // Year 999 parses into a *valid* Date with no month/day overflow, so
    // only the explicit `year < 1000` guard — not the getMonth/getDate
    // round-trip check below it — can reject it. This also kills the
    // LogicalOperator (||→&&) and BlockStatement mutants on that guard:
    // either mutant would fall through and format the date instead of
    // echoing the raw ISO string.
    expect(formatJournalTitle('0999-06-15', 'MMMM d, yyyy')).toBe('0999-06-15')
  })

  it('accepts the year lower bound of 1000', () => {
    expect(formatJournalTitle('1000-01-01', 'MMMM d, yyyy')).toBe('January 1, 1000')
  })

  it('accepts the year upper bound of 9999', () => {
    expect(formatJournalTitle('9999-12-31', 'MMMM d, yyyy')).toBe('December 31, 9999')
  })

  it('rejects month 00', () => {
    expect(formatJournalTitle('2026-00-15', 'MMMM d, yyyy')).toBe('2026-00-15')
  })

  it('accepts month 12 (upper bound)', () => {
    expect(formatJournalTitle('2026-12-25', 'MMMM d, yyyy')).toBe('December 25, 2026')
  })

  it('rejects day 00', () => {
    expect(formatJournalTitle('2026-01-00', 'MMMM d, yyyy')).toBe('2026-01-00')
  })

  it('accepts day 31 (upper bound, valid in a 31-day month)', () => {
    expect(formatJournalTitle('2026-01-31', 'MMMM d, yyyy')).toBe('January 31, 2026')
  })

  it('rejects day 45 (above the day upper bound)', () => {
    expect(formatJournalTitle('2026-01-45', 'MMMM d, yyyy')).toBe('2026-01-45')
  })

  it('rejects an overflowing day-of-month even in a 30-day month (round-trip check)', () => {
    // April has 30 days, so day 31 rolls over to May 1 — the
    // getMonth/getDate round-trip check must catch this.
    expect(formatJournalTitle('2026-04-31', 'MMMM d, yyyy')).toBe('2026-04-31')
  })

  it('degrades to the raw ISO content when date-fns rejects the format string', () => {
    // The format is a user-editable preference, so an invalid token string is
    // reachable input, not a theoretical one. date-fns throws a RangeError on
    // the protected `YYYY`/`DD` tokens (the single most likely typo for anyone
    // used to Moment/Java patterns) and on unescaped latin characters. The
    // `catch` must swallow that and echo the ISO content — an uncaught throw
    // here blanks the whole journal title.
    expect(formatJournalTitle(ISO, 'YYYY-MM-DD')).toBe('2026-06-17')
    expect(formatJournalTitle(ISO, 'not a token')).toBe('2026-06-17')
  })

  // Regression: the LOOKUP/identity key is the raw ISO content, and it must be
  // independent of the chosen display format. `formatJournalTitle` is the only
  // place the format is applied — it takes the ISO key and returns a *display*
  // string without ever mutating its input, so the value a caller passes to the
  // lookup (the same `isoContent`) is unaffected by the format choice.
  it('never mutates the ISO lookup key regardless of the display format', () => {
    const lookupKey = '2026-06-17'
    for (const fmt of ['locale', 'yyyy-MM-dd', 'MMMM d, yyyy', 'dd/MM/yyyy', 'EEE, MMM d']) {
      formatJournalTitle(lookupKey, fmt)
      // The canonical key the caller would pass to blocks.content lookup is
      // byte-for-byte unchanged after formatting under any preset.
      expect(lookupKey).toBe('2026-06-17')
    }
  })
})

// #3752 — `getWeekRange`, `getWeekDays`, `formatWeekRange` and
// `getCalendarMonthRange` had NO test anywhere in `src`, so every mutant in
// them was reported as "no coverage" rather than as a survivor and never
// showed up on the survivor list.
//
// Determinism: every expected value below is derived from the local-time
// `Date(y, m, d)` constructor and compared through `formatDate`, which uses
// local-time getters — so the assertions hold in any host timezone. The
// week-start preference is set explicitly (or cleared to the Monday default)
// rather than inherited from whatever a previous test left in localStorage.
describe('week helpers (getWeekRange / getWeekDays / formatWeekRange)', () => {
  // Friday, April 10 2026.
  const FRIDAY = new Date(2026, 3, 10)

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('getWeekRange spans Monday..Sunday under the default preference', () => {
    const { start, end } = getWeekRange(FRIDAY)
    expect(formatDate(start)).toBe('2026-04-06')
    expect(formatDate(end)).toBe('2026-04-12')
  })

  it('getWeekRange shifts with the Sunday week-start preference', () => {
    localStorage.setItem('week-start-preference', '0')
    const { start, end } = getWeekRange(FRIDAY)
    expect(formatDate(start)).toBe('2026-04-05')
    expect(formatDate(end)).toBe('2026-04-11')
  })

  it('getWeekDays returns the 7 consecutive days of the containing week', () => {
    expect(getWeekDays(FRIDAY).map(formatDate)).toEqual([
      '2026-04-06',
      '2026-04-07',
      '2026-04-08',
      '2026-04-09',
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
    ])
  })

  it('formatWeekRange renders "MMM d - MMM d, yyyy"', () => {
    expect(formatWeekRange(FRIDAY)).toBe('Apr 6 - Apr 12, 2026')
  })

  it('formatWeekRange prints the year of the END of a week crossing the new year', () => {
    // Wed Dec 31 2025 -> Mon Dec 29 2025 .. Sun Jan 4 2026. Only the end of
    // the range carries the year, so a week straddling January pins which
    // side of the range the `yyyy` token is attached to.
    expect(formatWeekRange(new Date(2025, 11, 31))).toBe('Dec 29 - Jan 4, 2026')
  })
})

describe('getCalendarMonthRange (the 6-week grid the calendar actually renders)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('starts at the week boundary on/before the 1st and spans exactly 42 days', () => {
    // Apr 1 2026 is a Wednesday, so the grid opens on Mon Mar 30 2026; the
    // 42nd day inclusive (start + 41) is Sun May 10 2026.
    expect(getCalendarMonthRange(new Date(2026, 3, 15))).toEqual({
      startDate: '2026-03-30',
      endDate: '2026-05-10',
    })
  })

  it('starts on the 1st itself when the 1st is already the week-start day', () => {
    // Jun 1 2026 is a Monday — no leading days from the previous month.
    expect(getCalendarMonthRange(new Date(2026, 5, 30))).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-07-12',
    })
  })

  it('anchors the grid on the Sunday week-start preference', () => {
    localStorage.setItem('week-start-preference', '0')
    expect(getCalendarMonthRange(new Date(2026, 3, 15))).toEqual({
      startDate: '2026-03-29',
      endDate: '2026-05-09',
    })
  })

  it('covers exactly 42 inclusive days', () => {
    // Guards the `+ 41` offset against both an off-by-one and a wrong
    // arithmetic direction, independent of the calendar dates above.
    const { startDate, endDate } = getCalendarMonthRange(new Date(2026, 1, 5))
    // Measured in UTC on purpose: a DST transition inside the window would
    // make local-time millisecond arithmetic off by an hour in some zones.
    const toUtcDay = (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
      return Date.UTC(y, m - 1, d) / 86_400_000
    }
    expect(toUtcDay(endDate) - toUtcDay(startDate)).toBe(41)
  })
})
