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
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === '0') return 0
  } catch {
    // Storage unavailable (private mode / locked-down webview). This runs as
    // the useSyncExternalStore snapshot AND backs getWeekStartDay() during
    // calendar/agenda render, so a throw here must not break the view.
  }
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
    const newValue = String(day)
    let oldValue: string | null = null
    try {
      oldValue = localStorage.getItem(STORAGE_KEY)
      localStorage.setItem(STORAGE_KEY, newValue)
    } catch {
      // Storage unavailable — degrade to no-persist and skip the sync event.
      return
    }
    // Dispatch storage event for same-tab listeners
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEY,
        oldValue,
        newValue,
        url: window.location.href,
        storageArea: window.localStorage,
      }),
    )
  }, [])

  return { weekStartsOn, setWeekStart }
}

/** Non-hook getter for use in pure functions (date-utils.ts). */
export function getWeekStartDay(): WeekStartDay {
  return getSnapshot()
}
