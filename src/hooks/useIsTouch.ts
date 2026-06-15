/**
 * useIsTouch — detect coarse-pointer (touch) input.
 *
 * Returns `true` when the active pointer is coarse (touch screen, stylus on
 * tablet, etc.) AND the device exposes real touch hardware
 * (`navigator.maxTouchPoints > 0`), and `false` for fine pointers
 * (mouse, trackpad). The value is reactive: if the user attaches/detaches a
 * mouse the hook re-renders.
 *
 * #1236: the Linux Tauri WebKitGTK webview mis-reports
 * `matchMedia('(pointer: coarse)').matches === true` for a plain mouse, which
 * would flip the whole app into touch mode (per-block gutter controls on every
 * block). A desktop webview reports `maxTouchPoints === 0`, so requiring BOTH
 * signals short-circuits that false-coarse to a fine pointer while real touch
 * devices (maxTouchPoints > 0) keep behaving as touch.
 *
 * SSR-safe: returns `false` when `window` is undefined and only attaches the
 * `matchMedia` listener inside `useEffect`.
 */

import { useEffect, useState } from 'react'

const TOUCH_QUERY = '(pointer: coarse)'

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
