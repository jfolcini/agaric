/**
 * useIsMobile — detect a mobile-width viewport (< 768px).
 *
 * Returns `true` when the viewport is narrower than `MOBILE_BREAKPOINT`. The
 * value is reactive: it re-renders when the viewport crosses the breakpoint.
 *
 * SSR-safe: returns `false` when `window` is undefined (matching the guard in
 * `useIsTouch`) and only attaches the `matchMedia` listener inside `useEffect`.
 * This keeps the most-used responsive hook from throwing in any non-DOM
 * context (SSR, tests, workers) that imports it.
 */

import * as React from 'react'

const MOBILE_BREAKPOINT = 768

function detectIsMobile(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return window.innerWidth < MOBILE_BREAKPOINT
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(detectIsMobile)

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(detectIsMobile())
    }
    // Sync once in case the initial state is stale (e.g. hydration mismatch).
    setIsMobile(detectIsMobile())
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
