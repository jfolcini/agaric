/**
 * useScrollToFocus — schedule a `scrollIntoView` for an element once the
 * current paint settles.
 *
 * Two callsites used to inline this pattern with minor variations
 * (JournalPage's day/panel scroll, DailyView's `selectedBlockId` scroll
 * For). Each wrapped a `requestAnimationFrame` around an element
 * lookup + `scrollIntoView`, returning a `cancelAnimationFrame` cleanup.
 *
 * The hook centralises:
 *  - the rAF schedule + cancel-on-unmount cleanup (the rAF gives the DOM
 *    a paint to render the target before we try to scroll into it),
 *  - `prefers-reduced-motion` honouring (when `behavior` is provided we
 *    downgrade `'smooth'` → `'auto'` so the user's OS preference wins),
 *  - an `onComplete` hook for callsite-specific post-scroll work
 *    (clearing a one-shot store flag, restoring focus, …).
 *
 * `targetId == null` is a no-op — pass the raw store value without
 * pre-checking. The default element resolver is `document.getElementById`,
 * but callsites that key elements by attribute (e.g. `data-block-id`) can
 * pass a custom `resolveElement` to query whatever shape they need.
 *
 * The effect only depends on `targetId`. `options` may be a fresh inline
 * object on every render — we read it through a ref inside the rAF so a
 * caller doesn't need to memoise.
 */

import { useEffect, useRef } from 'react'

export interface UseScrollToFocusOptions {
  /**
   * Forwarded to `scrollIntoView`. Omit to inherit the browser default
   * (`'auto'`). When set, `prefers-reduced-motion: reduce` forces `'auto'`
   * regardless of the value passed.
   */
  behavior?: ScrollBehavior
  block?: ScrollLogicalPosition
  inline?: ScrollLogicalPosition
  /**
   * Custom element resolver. Defaults to `document.getElementById(id)`.
   * Use this for elements indexed by an attribute other than `id`
   * (e.g. `[data-block-id="..."]`).
   */
  resolveElement?: (id: string) => Element | null
  /**
   * Invoked inside the rAF callback after the scroll attempt — runs
   * whether or not the element was found. Useful for one-shot store
   * cleanup so the scroll trigger doesn't re-fire on the next render.
   */
  onComplete?: (id: string) => void
}

export function useScrollToFocus(
  targetId: string | null | undefined,
  options?: UseScrollToFocusOptions,
): void {
  // Stash the latest options on a ref so the effect's dep array can stay
  // narrow (`[targetId]`). Without this, an inline `{ behavior: 'smooth' }`
  // object literal would re-fire the effect on every render.
  const optionsRef = useRef<UseScrollToFocusOptions | undefined>(options)
  optionsRef.current = options

  useEffect(() => {
    if (targetId == null) return
    const id = targetId
    const rafId = requestAnimationFrame(() => {
      const opts = optionsRef.current
      const el = opts?.resolveElement ? opts.resolveElement(id) : document.getElementById(id)
      if (el) {
        const scrollOptions: ScrollIntoViewOptions = {}
        if (opts?.block !== undefined) scrollOptions.block = opts.block
        if (opts?.inline !== undefined) scrollOptions.inline = opts.inline
        if (opts?.behavior !== undefined) {
          // Global CSS forces `scroll-behavior: auto` under reduced motion,
          // but `scrollIntoView({ behavior: 'smooth' })` overrides that —
          // the JS option needs to be downgraded explicitly.
          const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
          scrollOptions.behavior = prefersReducedMotion ? 'auto' : opts.behavior
        }
        el.scrollIntoView(scrollOptions)
      }
      opts?.onComplete?.(id)
    })
    return () => cancelAnimationFrame(rafId)
  }, [targetId])
}
