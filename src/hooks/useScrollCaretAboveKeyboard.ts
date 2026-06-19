/**
 * useScrollCaretAboveKeyboard — keep the focused block's caret above the
 * on-screen soft keyboard (#917).
 *
 * `scrollIntoView({ block: 'nearest' })` is keyboard-unaware: the browser's
 * `nearest` heuristic treats the *layout* viewport as the scroll target, but
 * on mobile the soft keyboard (Gboard, iOS) does NOT shrink the layout
 * viewport on edge-to-edge Android — it shrinks `window.visualViewport`
 * and covers the lower part of the screen. A block focused in (or created
 * via Enter at) that covered region therefore stays hidden behind the
 * keyboard.
 *
 * This hook mirrors the established `visualViewport` tracking used by
 * `Sheet` (#760), `InPageFind`, and `JournalCalendarDropdown`:
 *
 *  - On focus AND on every visualViewport `resize` / `scroll`, it computes
 *    the keyboard inset = `innerHeight - (vv.height + vv.offsetTop)`.
 *  - When the inset is 0 (no keyboard — desktop, jsdom, older WebViews, or
 *    a pinch-zoomed viewport) it falls back to the plain
 *    `scrollIntoView({ block: 'nearest' })` so desktop behavior is
 *    byte-identical to before.
 *  - When the inset is positive AND the focused element's bounding rect
 *    bottom sits within (or below) the keyboard-covered region, it scrolls
 *    the page so the element clears the keyboard with a small margin above
 *    it — pinning the active line above the keyboard the way Logseq does.
 *
 * Every path is guarded for SSR (`typeof window === 'undefined'`) and for
 * the absence of `window.visualViewport` (jsdom, older WebViews), so it
 * no-ops safely off-device.
 */

import { useEffect } from 'react'

import { computeKeyboardInset } from '@/lib/keyboard-inset'

/**
 * Gap (px) to leave between the bottom of the focused element and the top
 * of the keyboard, so the caret isn't flush against the keyboard edge.
 * Modest value — enough to breathe without wasting vertical space.
 */
const KEYBOARD_MARGIN_PX = 8

/**
 * Scroll `el` so its caret/bottom clears the soft keyboard.
 *
 * Pure-ish helper (reads layout, mutates scroll) extracted so the vitest
 * suite can drive it directly with a mocked `getBoundingClientRect` and a
 * spied `scrollIntoView`. With no keyboard inset it defers entirely to the
 * native `scrollIntoView({ block: 'nearest' })` — preserving the prior
 * desktop behavior.
 */
export function scrollCaretAboveKeyboard(el: HTMLElement, vv: VisualViewport | null): void {
  if (!vv) {
    // No visualViewport (jsdom, older WebViews, SSR-less desktop): keep the
    // original keyboard-unaware behavior.
    el.scrollIntoView({ block: 'nearest' })
    return
  }

  const inset = computeKeyboardInset(vv)
  if (inset === 0) {
    // Keyboard down (or pinch zoom): plain nearest scroll, as before.
    el.scrollIntoView({ block: 'nearest' })
    return
  }

  // Keyboard is up. The top of the keyboard, in layout-viewport (client)
  // coordinates, is the visual-viewport bottom: offsetTop + height.
  const keyboardTop = vv.offsetTop + vv.height
  const rect = el.getBoundingClientRect()

  // Only act when the element is actually within (or below) the covered
  // region — i.e. its bottom edge would be hidden by the keyboard. An
  // element comfortably above the keyboard is left untouched.
  if (rect.bottom <= keyboardTop - KEYBOARD_MARGIN_PX) return

  // First let the browser bring it as close as it can with the native
  // heuristic, then nudge the window up by the residual overlap so the
  // element's bottom sits `KEYBOARD_MARGIN_PX` above the keyboard. We
  // re-measure after the nearest scroll so the nudge is exact.
  el.scrollIntoView({ block: 'nearest' })
  const after = el.getBoundingClientRect()
  const overshoot = after.bottom - (keyboardTop - KEYBOARD_MARGIN_PX)
  if (overshoot > 0) {
    window.scrollBy({ top: overshoot, left: 0 })
  }
}

/**
 * Keep the element referenced by `ref` scrolled above the soft keyboard
 * while `enabled` is true.
 *
 * @param ref     Ref to the focused block's wrapper element.
 * @param enabled Whether the block is currently focused (drives mount/teardown
 *                of the visualViewport listeners and the initial scroll).
 */
export function useScrollCaretAboveKeyboard(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    const vv = window.visualViewport ?? null

    const apply = () => {
      const el = ref.current
      if (!el) return
      scrollCaretAboveKeyboard(el, vv)
    }

    // Initial scroll on focus. requestAnimationFrame defers until after the
    // editor has mounted/laid out, avoiding layout thrash — same rationale
    // as the original EditableBlock focus effect.
    const raf =
      typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(apply) : (apply(), null)

    if (!vv) {
      // No visualViewport to track (jsdom, older WebViews): the rAF above
      // already did the one-shot nearest scroll; nothing to listen to.
      return () => {
        if (raf !== null && typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(raf)
        }
      }
    }

    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      if (raf !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(raf)
      }
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [ref, enabled])
}
