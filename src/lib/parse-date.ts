import { addMonths } from 'date-fns'

import { formatDate } from './date-utils'

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (year < 100 || year > 9999) return false
  if (month < 1 || month > 12) return false
  if (day < 1) return false
  const maxDay = new Date(year, month, 0).getDate()
  return day <= maxDay
}

function buildDate(year: number, month: number, day: number): string | null {
  if (!isValidDate(year, month, day)) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseMonthName(name: string): number | undefined {
  return MONTH_NAMES[name.toLowerCase()]
}

// True if the given year/month/day forms a real calendar date (i.e. the
// constructed Date doesn't roll over into the following month, e.g. Feb 29 in a
// non-leap year overflowing to Mar 1).
function yearHolds(year: number, month: number, day: number): boolean {
  const d = new Date(year, month - 1, day)
  return d.getMonth() === month - 1 && d.getDate() === day
}

function defaultYear(month: number, day: number, today: Date): number {
  const currentYear = today.getFullYear()
  // Guard against Feb 29 silently overflowing into March when the current year
  // is not a leap year: advance to the nearest future year that can hold it.
  // Only do this for an otherwise-plausible month/day (month 1-12, day 1-31)
  // that the current year can't hold (the sole real case being Feb 29); a
  // genuinely impossible month/day is left for buildDate/isValidDate to reject,
  // so we never loop unboundedly.
  if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && !yearHolds(currentYear, month, day)) {
    // Scan a bounded window of future years for one that can hold the date.
    // The only legitimate case is Feb 29, and a leap year occurs at least once
    // every 8 years, so an 8-year window always finds it. Impossible dates
    // (Feb 30/31, Apr/Jun/Sep/Nov 31) hold in NO year, so the bound is what
    // prevents an infinite loop — we fall through and let isValidDate reject.
    for (let year = currentYear + 1; year <= currentYear + 8; year += 1) {
      if (yearHolds(year, month, day)) return year
    }
  }
  const candidate = new Date(currentYear, month - 1, day)
  if (candidate < today) {
    return currentYear + 1
  }
  return currentYear
}

function tryRelative(input: string, today: Date): string | null {
  const match = input.match(/^\+(\d+)([dwm])$/i)
  if (!match) return null
  const n = Number.parseInt(match[1] as string, 10)
  const unit = match[2]?.toLowerCase()
  const result = new Date(today)
  if (unit === 'd') {
    result.setDate(result.getDate() + n)
  } else if (unit === 'w') {
    result.setDate(result.getDate() + n * 7)
  } else if (unit === 'm') {
    return formatDate(addMonths(result, n))
  }
  return formatDate(result)
}

function tryNatural(input: string, today: Date): string | null {
  const lower = input.toLowerCase()

  if (lower === 'today') return formatDate(today)

  if (lower === 'tomorrow') {
    const d = new Date(today)
    d.setDate(d.getDate() + 1)
    return formatDate(d)
  }

  if (lower === 'yesterday') {
    const d = new Date(today)
    d.setDate(d.getDate() - 1)
    return formatDate(d)
  }

  if (lower === 'next week') {
    const d = new Date(today)
    d.setDate(d.getDate() + 7)
    return formatDate(d)
  }

  if (lower === 'end of month') {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    return formatDate(d)
  }

  const nextDayMatch = lower.match(
    /^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/,
  )
  if (nextDayMatch) {
    const targetDay = DAY_NAMES[nextDayMatch[1] as string] as number
    const currentDay = today.getDay()
    let diff = targetDay - currentDay
    if (diff <= 0) diff += 7
    const d = new Date(today)
    d.setDate(d.getDate() + diff)
    return formatDate(d)
  }

  const inMatch = lower.match(/^in\s+(\d+)\s+(days?|weeks?|months?)$/)
  if (inMatch) {
    const n = Number.parseInt(inMatch[1] as string, 10)
    const unit = inMatch[2] as string
    const d = new Date(today)
    if (unit.startsWith('day')) {
      d.setDate(d.getDate() + n)
    } else if (unit.startsWith('week')) {
      d.setDate(d.getDate() + n * 7)
    } else if (unit.startsWith('month')) {
      return formatDate(addMonths(d, n))
    }
    return formatDate(d)
  }

  return null
}

function tryIso(input: string): string | null {
  const match = input.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/)
  if (!match) return null
  const year = Number.parseInt(match[1] as string, 10)
  const month = Number.parseInt(match[2] as string, 10)
  const day = Number.parseInt(match[3] as string, 10)
  return buildDate(year, month, day)
}

function tryMonthName(input: string): string | null {
  // "Apr 15, 2026" or "April 15 2026"
  const m1 = input.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m1) {
    const month = parseMonthName(m1[1] as string)
    if (month === undefined) return null
    const day = Number.parseInt(m1[2] as string, 10)
    const year = Number.parseInt(m1[3] as string, 10)
    return buildDate(year, month, day)
  }

  // "15 April 2026" or "15 Apr 2026"
  const m2 = input.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/)
  if (m2) {
    const day = Number.parseInt(m2[1] as string, 10)
    const month = parseMonthName(m2[2] as string)
    if (month === undefined) return null
    const year = Number.parseInt(m2[3] as string, 10)
    return buildDate(year, month, day)
  }

  // "15-Apr-2026"
  const m3 = input.match(/^(\d{1,2})-([A-Za-z]+)-(\d{4})$/)
  if (m3) {
    const day = Number.parseInt(m3[1] as string, 10)
    const month = parseMonthName(m3[2] as string)
    if (month === undefined) return null
    const year = Number.parseInt(m3[3] as string, 10)
    return buildDate(year, month, day)
  }

  return null
}

function tryNoYear(input: string, today: Date): string | null {
  // "Apr 15" or "April 15"
  const m1 = input.match(/^([A-Za-z]+)\s+(\d{1,2})$/)
  if (m1) {
    const month = parseMonthName(m1[1] as string)
    if (month === undefined) return null
    const day = Number.parseInt(m1[2] as string, 10)
    const year = defaultYear(month, day, today)
    return buildDate(year, month, day)
  }

  // "15 Apr" or "15 April"
  const m2 = input.match(/^(\d{1,2})\s+([A-Za-z]+)$/)
  if (m2) {
    const day = Number.parseInt(m2[1] as string, 10)
    const month = parseMonthName(m2[2] as string)
    if (month === undefined) return null
    const year = defaultYear(month, day, today)
    return buildDate(year, month, day)
  }

  // "MM-DD" or "MM/DD" (also handles "DD-MM" / "DD/MM" as a fallback)
  const m3 = input.match(/^(\d{1,2})[/-](\d{1,2})$/)
  if (m3) {
    const a = Number.parseInt(m3[1] as string, 10)
    const b = Number.parseInt(m3[2] as string, 10)
    // Mirror tryAmbiguousNumeric: if the first number can't be a month, it must
    // be a day → DD-MM.
    if (a > 12) {
      const year = defaultYear(b, a, today)
      return buildDate(year, b, a)
    }
    // Otherwise try MM-DD first, falling back to DD-MM.
    const mmddYear = defaultYear(a, b, today)
    const mmdd = buildDate(mmddYear, a, b)
    if (mmdd) return mmdd
    const ddmmYear = defaultYear(b, a, today)
    return buildDate(ddmmYear, b, a)
  }

  return null
}

function tryAmbiguousNumeric(input: string): string | null {
  // DD-MM-YYYY or MM-DD-YYYY
  const match = input.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/)
  if (!match) return null
  const a = Number.parseInt(match[1] as string, 10)
  const b = Number.parseInt(match[2] as string, 10)
  const year = Number.parseInt(match[3] as string, 10)

  // If first number > 12, it must be a day → DD-MM-YYYY
  if (a > 12) {
    return buildDate(year, b, a)
  }
  // Otherwise try MM-DD-YYYY first
  const mmdd = buildDate(year, a, b)
  if (mmdd) return mmdd
  // Fall back to DD-MM-YYYY
  return buildDate(year, b, a)
}

/**
 * Parse a flexible date input string and normalize to YYYY-MM-DD.
 * Returns null if the input cannot be parsed.
 *
 * Supports: ISO, European, US, short year, no year, month names,
 * natural language (today, tomorrow, next Monday), relative (+3d, +1w).
 */
export function parseDate(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return (
    tryRelative(trimmed, today) ??
    tryNatural(trimmed, today) ??
    tryIso(trimmed) ??
    tryMonthName(trimmed) ??
    tryNoYear(trimmed, today) ??
    tryAmbiguousNumeric(trimmed) ??
    null
  )
}
