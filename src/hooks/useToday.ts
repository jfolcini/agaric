/**
 * useToday — the current local "today" as a YYYY-MM-DD string, kept live.
 *
 * #739 — several agenda/journal surfaces froze today's date in a `[]`-keyed
 * `useMemo(() => getTodayString(), [])`. When the app is left open across local
 * midnight, those memos kept yesterday's date, so overdue/highlight logic
 * (e.g. "is this block due today?", the today-row highlight) went stale until a
 * remount.
 *
 * This hook re-evaluates `getTodayString()` whenever local midnight passes by
 * scheduling a timeout to the next local midnight, and re-checks on
 * `visibilitychange` so a backgrounded tab that wakes after midnight corrects
 * immediately (background timers are throttled/coalesced and can fire late).
 * The next-midnight timeout is recomputed after each fire. The timer and
 * listener are cleaned up on unmount.
 */

import { useEffect, useState } from 'react'

import { getTodayString } from '../lib/date-utils'

/** Milliseconds from `now` until the next local midnight (always > 0). */
function msUntilNextMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return next.getTime() - now.getTime()
}

/**
 * Return today's local date as a `YYYY-MM-DD` string, updating when local
 * midnight passes or the tab becomes visible again after midnight.
 */
export function useToday(): string {
  const [today, setToday] = useState(getTodayString)

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    // Re-read the current date and, if it changed, push it into state. Returns
    // nothing — the caller re-arms the timer separately.
    function syncToday() {
      setToday((prev) => {
        const next = getTodayString()
        return next === prev ? prev : next
      })
    }

    // Arm a timeout for the next local midnight. On fire, sync and re-arm so a
    // single mount keeps correcting across multiple day boundaries.
    function scheduleNextMidnight() {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        syncToday()
        scheduleNextMidnight()
      }, msUntilNextMidnight(new Date()))
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        // A wake after a throttled/late background timer may have skipped the
        // rollover — sync immediately and re-arm relative to now.
        syncToday()
        scheduleNextMidnight()
      }
    }

    scheduleNextMidnight()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return today
}
