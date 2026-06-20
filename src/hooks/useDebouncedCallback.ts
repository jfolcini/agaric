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

import { useEffect, useMemo, useRef } from 'react'

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
  const delayRef = useRef(delay)
  delayRef.current = delay

  // Cleanup on unmount
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    },
    [],
  )

  // The empty dependency array is intentional, NOT a stale-closure bug — do not
  // "fix" it by adding `callback`/`delay` to the deps.
  //
  // Contract (same ref-refresh pattern as `src/editor/use-roving-editor.ts:399`
  // and the `getState()`-in-async convention in `AGENTS.md`):
  //   - `schedule`/`cancel` are identity-stable for the hook's lifetime, so
  //     consumers can pass them to memoized children / effect dep arrays without
  //     churning those memos/effects on every render.
  //   - The latest `callback` and `delay` are read through `callbackRef.current`
  //     / `delayRef.current`, both refreshed on every render (lines 27/29). So
  //     the timer always fires the freshest callback at the freshest delay
  //     WITHOUT re-creating `schedule`/`cancel`.
  // Adding `callback`/`delay` to the deps would re-create both functions on every
  // render and silently break the identity-stability consumers rely on.
  return useMemo(() => {
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
      }, delayRef.current)
    }

    return { schedule, cancel }
  }, [])
}
