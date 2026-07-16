/**
 * useWeekStart — localStorage-backed preference for week start day.
 *
 * Returns 0 (Sunday) or 1 (Monday, default). Reads/writes the localStorage
 * key 'week-start-preference' via the preferences registry
 * (`PREFERENCES.weekStart`). Cross-instance / cross-window sync comes from
 * the shared `usePreference` primitive (#2666) — this hook previously
 * hand-rolled the same synthetic-StorageEvent broadcast itself.
 */

import { useCallback } from 'react'

import { PREFERENCES, readPreference, usePreference, type WeekStartDay } from '@/lib/preferences'

export type { WeekStartDay } from '@/lib/preferences'

export function useWeekStart(): {
  weekStartsOn: WeekStartDay
  setWeekStart: (day: WeekStartDay) => void
} {
  const [weekStartsOn, setValue] = usePreference(PREFERENCES.weekStart)

  const setWeekStart = useCallback((day: WeekStartDay) => setValue(day), [setValue])

  return { weekStartsOn, setWeekStart }
}

/**
 * Non-hook getter for use in pure functions (date-utils.ts). Runs during
 * calendar/agenda render, so it must never throw — `readPreference`
 * degrades to the Monday default on any storage failure.
 */
export function getWeekStartDay(): WeekStartDay {
  return readPreference(PREFERENCES.weekStart)
}
