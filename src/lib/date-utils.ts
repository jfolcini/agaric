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

export interface DayEntry {
  date: Date
  dateStr: string
  displayDate: string
  pageId: string | null
}
