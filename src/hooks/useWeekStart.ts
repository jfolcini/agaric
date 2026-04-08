/**
 * useWeekStart — localStorage-backed preference for week start day.
 *
 * Returns 0 (Sunday) or 1 (Monday, default). Reads/writes to
 * localStorage key 'week-start-preference'.
 */

import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'week-start-preference'

type WeekStartDay = 0 | 1

function getSnapshot(): WeekStartDay {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === '0') return 0
  return 1 // default: Monday
}

function getServerSnapshot(): WeekStartDay {
  return 1
}

function subscribe(callback: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export function useWeekStart(): {
  weekStartsOn: WeekStartDay
  setWeekStart: (day: WeekStartDay) => void
} {
  const weekStartsOn = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const setWeekStart = useCallback((day: WeekStartDay) => {
    localStorage.setItem(STORAGE_KEY, String(day))
    // Dispatch storage event for same-tab listeners
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
  }, [])

  return { weekStartsOn, setWeekStart }
}

/** Non-hook getter for use in pure functions (date-utils.ts). */
export function getWeekStartDay(): WeekStartDay {
  return getSnapshot()
}
