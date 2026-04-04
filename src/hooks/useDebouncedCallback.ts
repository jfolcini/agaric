/**
 * useDebouncedCallback — shared debounce lifecycle hook.
 *
 * Manages a timeout ref internally and provides `schedule` (sets/resets
 * the timer) and `cancel` (clears it). Cleanup on unmount is automatic.
 *
 * Usage:
 *   const debounced = useDebouncedCallback((value) => {
 *     executeSearch(value)
 *   }, 300)
 *
 *   debounced.schedule(value)  // start/restart the timer
 *   debounced.cancel()         // cancel pending invocation
 */

import { useEffect, useRef } from 'react'

export function useDebouncedCallback(
  callback: (value: string) => void,
  delay = 300,
): {
  schedule: (value: string) => void
  cancel: () => void
} {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  function cancel() {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  function schedule(value: string) {
    cancel()
    timerRef.current = setTimeout(() => {
      callbackRef.current(value)
    }, delay)
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return { schedule, cancel }
}
