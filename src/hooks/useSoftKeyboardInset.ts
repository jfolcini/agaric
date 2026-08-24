/**
 * useSoftKeyboardInset — how many pixels of the layout viewport the on-screen
 * keyboard is currently covering.
 *
 * Extracted from `ui/sheet.tsx` (#760) in #4313. `computeKeyboardInset`'s own
 * doc comment already named three consumers of the underlying math; keeping the
 * subscribe/state half of it private to `Sheet` was the wrong shape for the
 * next consumer that needs it.
 *
 * NOT for sizing or placing a floating element against the keyboard: anything
 * positioned by floating-ui (Radix popper — `Popover`, `Select`, `Tooltip`, …)
 * is ALREADY measured against `window.visualViewport`, so feeding this number
 * back in as collision padding subtracts the keyboard twice (#4313). This is
 * for elements the app positions itself, like the pinned toolbar and the bottom
 * `Sheet`.
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
