/**
 * useIsTouch — whether the app lays itself out for touch.
 *
 * The platform decides (`detectTouch`, `src/lib/touch.ts`): the desktop Tauri
 * app never, the Android app always, and a plain browser when its pointer is
 * coarse and it has touch hardware (`navigator.maxTouchPoints > 0`). In a
 * browser the value follows the pointer: the hook re-renders when the
 * `(pointer: coarse)` media query changes. CSS reads the same answer through
 * the `coarse` variant.
 *
 * SSR-safe: returns `false` when `window` is undefined and only attaches the
 * `matchMedia` listener inside `useEffect`.
 */

import { useEffect, useState } from 'react'

import { COARSE_POINTER_QUERY, detectTouch } from '@/lib/touch'

export function useIsTouch(): boolean {
  const [isTouch, setIsTouch] = useState<boolean>(detectTouch)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(COARSE_POINTER_QUERY)
    const handler = () => {
      setIsTouch(detectTouch())
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isTouch
}
