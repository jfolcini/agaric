/**
 * useIsTouch — detect coarse-pointer (touch) input.
 *
 * Returns `true` when the active pointer is coarse (touch screen, stylus on
 * tablet, etc.) and `false` for fine pointers (mouse, trackpad). The value
 * is reactive: if the user attaches/detaches a mouse the hook re-renders.
 *
 * SSR-safe: returns `false` when `window` is undefined and only attaches the
 * `matchMedia` listener inside `useEffect`.
 */

import { useEffect, useState } from 'react'

const TOUCH_QUERY = '(pointer: coarse)'

export function useIsTouch(): boolean {
  const [isTouch, setIsTouch] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia(TOUCH_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(TOUCH_QUERY)
    const handler = (event: MediaQueryListEvent) => {
      setIsTouch(event.matches)
    }
    // Sync once in case the initial state is stale (e.g. hydration mismatch).
    setIsTouch(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isTouch
}
