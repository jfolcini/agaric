/**
 * Shared date utility helpers for the journal views.
 */

import { addMonths, eachDayOfInterval, endOfWeek, format, startOfWeek } from 'date-fns'

export const WEEK_OPTIONS = { weekStartsOn: 1 as const }

/** Earliest navigable journal date. */
export const MIN_JOURNAL_DATE = new Date(2020, 0, 1)

/** Latest navigable journal date (1 year from today). */
export const MAX_JOURNAL_DATE = addMonths(new Date(), 12)

/** Format a Date as YYYY-MM-DD. */
export function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** Format a Date as a readable string (e.g., "Mon, Jan 15 2025"). */
export function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Get the Monday-start week range for a given date. */
export function getWeekRange(d: Date): { start: Date; end: Date } {
  return {
    start: startOfWeek(d, WEEK_OPTIONS),
    end: endOfWeek(d, WEEK_OPTIONS),
  }
}

/** Build the 7 day range for a week (Mon-Sun). */
export function getWeekDays(d: Date): Date[] {
  const { start, end } = getWeekRange(d)
  return eachDayOfInterval({ start, end })
}

/** Format the week range for display: "Mar 24 - Mar 30, 2025" */
export function formatWeekRange(d: Date): string {
  const { start, end } = getWeekRange(d)
  const startStr = format(start, 'MMM d')
  const endStr = format(end, 'MMM d, yyyy')
  return `${startStr} - ${endStr}`
}

/** Short month names for compact date display. */
const MONTH_SHORT = [
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
]

/**
 * Format a YYYY-MM-DD date string compactly.
 * Same year → "Apr 15", different year → "Apr 15, 2025".
 */
export function formatCompactDate(dateStr: string): string {
  const parts = dateStr.split('-')
  if (parts.length !== 3) return dateStr
  const [y, m, d] = parts.map(Number)
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return dateStr
  const month = MONTH_SHORT[(m ?? 1) - 1] ?? 'Jan'
  const day = d ?? 1
  const now = new Date()
  if (y === now.getFullYear()) return `${month} ${day}`
  return `${month} ${day}, ${y}`
}

/** Compute a { start, end } date range for common filter presets. Returns null for 'overdue'. */
export function getDateRangeForFilter(
  preset: string,
  today: Date,
): { start: string; end: string } | null {
  const todayStr = formatDate(today)

  if (preset === 'today') {
    return { start: todayStr, end: todayStr }
  }

  if (preset === 'this-week') {
    const day = today.getDay()
    const mondayOffset = day === 0 ? -6 : 1 - day
    const weekStart = new Date(today)
    weekStart.setDate(today.getDate() + mondayOffset)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    return { start: formatDate(weekStart), end: formatDate(weekEnd) }
  }

  if (preset === 'this-month') {
    const year = today.getFullYear()
    const month = today.getMonth()
    return {
      start: formatDate(new Date(year, month, 1)),
      end: formatDate(new Date(year, month + 1, 0)),
    }
  }

  const nextMatch = preset.match(/^next-(\d+)-days$/)
  if (nextMatch) {
    const numDays = Number.parseInt(nextMatch[1] as string, 10)
    const rangeEnd = new Date(today)
    rangeEnd.setDate(today.getDate() + numDays - 1)
    return { start: todayStr, end: formatDate(rangeEnd) }
  }

  const lastMatch = preset.match(/^last-(\d+)-days$/)
  if (lastMatch) {
    const numDays = Number.parseInt(lastMatch[1] as string, 10)
    const rangeStart = new Date(today)
    rangeStart.setDate(today.getDate() - (numDays - 1))
    return { start: formatDate(rangeStart), end: todayStr }
  }

  if (preset === 'overdue') {
    return null
  }

  return null
}

/** Return today's date as a YYYY-MM-DD string. */
export function getTodayString(): string {
  return formatDate(new Date())
}

/** Check if a string is a YYYY-MM-DD date page title. */
export function isDateFormattedPage(title: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(title)
}

export interface DayEntry {
  date: Date
  dateStr: string
  displayDate: string
  pageId: string | null
}
