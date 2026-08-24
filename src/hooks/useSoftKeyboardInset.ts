/**
 * useSoftKeyboardInset — how many pixels of the layout viewport the on-screen
 * keyboard is currently covering.
 *
 * Extracted from `ui/sheet.tsx` (#760) when the popover primitive needed the
 * same number (#4313). `computeKeyboardInset`'s own doc comment already named
 * three consumers; a fourth made the private copy the wrong shape.
 *
 * WHY THIS EXISTS AT ALL: on Android (edge-to-edge / targetSdk 36) the
 * theme-level `adjustResize` is largely neutered — the LAYOUT viewport does not
 * shrink when the IME opens. `100dvh`, `100vh` and `window.innerHeight` all keep
 * reporting the full screen while the bottom third of it is keyboard. Anything
 * that sizes or positions itself against those units will happily place content
 * underneath the keyboard, where it cannot be seen or tapped.
 * `window.visualViewport` is the only signal that survives edge-to-edge.
 *
 * Returns 0 — so desktop and jsdom behave exactly as they did before this hook
 * existed — when the keyboard is hidden, when the API is unavailable (jsdom,
 * older WebViews), or when `enabled` is false. A pinch-zoomed viewport
 * (`visualViewport.scale > 1`) also reports 0: zoom shrinks `vv.height` exactly
 * as the IME does, and `computeKeyboardInset` uses `scale` to tell them apart.
 */

import { useEffect, useState } from 'react'

import { computeKeyboardInset } from '@/lib/keyboard-inset'

export function useSoftKeyboardInset(enabled = true): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setInset(0)
      return
    }
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const update = () => {
      setInset(computeKeyboardInset(vv))
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [enabled])

  return inset
}
