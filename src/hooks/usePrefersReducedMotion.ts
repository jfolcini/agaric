/**
 * usePrefersReducedMotion — detect the `prefers-reduced-motion: reduce` setting.
 *
 * Returns `true` when the user has requested reduced motion and `false`
 * otherwise. The value is reactive: if the OS-level preference changes while
 * the app is running the hook re-renders.
 *
 * SSR-safe: returns `false` when `window`/`matchMedia` is undefined and only
 * attaches the `matchMedia` listener inside `useEffect`.
 *
 * Mirrors `useIsTouch` (#755) so that `matchMedia` is read once on mount via a
 * useState initializer + a subscription, rather than re-evaluated in a render
 * body on every render.
 */

import { useEffect, useState } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(REDUCED_MOTION_QUERY)
    const handler = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches)
    }
    // Sync once in case the initial state is stale (e.g. hydration mismatch).
    setPrefersReducedMotion(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return prefersReducedMotion
}
