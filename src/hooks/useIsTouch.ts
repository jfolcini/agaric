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

/**
 * A device is "touch" only when the primary pointer is coarse AND the device
 * actually has touch hardware. The `maxTouchPoints` guard is load-bearing:
 * WebKitGTK (the Linux Tauri webview, #1232) mis-reports `(pointer: coarse)`
 * for a plain mouse, which would otherwise flip the whole app into touch mode
 * (always-visible gutter controls on every block). A desktop webview with no
 * touchscreen reports `maxTouchPoints === 0`, so the AND short-circuits the
 * false-coarse to the correct fine-pointer behaviour. Real touch devices keep
 * `maxTouchPoints > 0` and stay touch.
 */
function detectTouch(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  const coarse = window.matchMedia(TOUCH_QUERY).matches
  const hasTouchPoints = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
  return coarse && hasTouchPoints
}

export function useIsTouch(): boolean {
  const [isTouch, setIsTouch] = useState<boolean>(detectTouch)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(TOUCH_QUERY)
    const handler = () => {
      setIsTouch(detectTouch())
    }
    // Sync once in case the initial state is stale (e.g. hydration mismatch).
    setIsTouch(detectTouch())
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isTouch
}
