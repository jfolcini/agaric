/**
 * useMinuteClock — `Date.now()`, re-read once a minute, for
 * `formatRelativeTime`'s `now`.
 *
 * Passed in, it makes a "5m ago" label a function of time, so each tick
 * recomputes it. Read inside the call instead, the clock is invisible to the
 * React Compiler, which caches the label on its other inputs: it reads
 * "just now" until the timestamp itself changes. A minute is the finest unit
 * the label shows.
 */

import { useEffect, useState } from 'react'

const MINUTE_MS = 60_000

export function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => clearInterval(id)
  }, [])

  return now
}
