/**
 * useAutoScrollOnDrag — auto-scrolls a container when the drag pointer
 * approaches the top or bottom edges of the viewport.
 *
 * Uses requestAnimationFrame for smooth 60fps scrolling with speed that
 * increases proportionally as the pointer gets closer to the edge.
 *
 * Honours `prefers-reduced-motion: reduce` — the global CSS rule covers
 * CSS animations, but this JS-driven RAF loop has to opt out manually
 * (per UX.md §"JS-driven animations ignore global reduced-motion CSS").
 * When the user prefers reduced motion we skip the loop entirely: a
 * continuous edge-scroll is exactly the kind of unexpected sustained
 * motion that preference is meant to suppress, and forcing a single jump
 * per pointermove would surprise the user mid-drag instead.
 *
 * @param containerRef - ref to the scrollable container element
 * @param active - whether a drag is currently in progress
 */

import { type RefObject, useEffect, useRef } from 'react'

/** Distance in px from viewport edge that triggers auto-scroll. */
export const SCROLL_ZONE = 50

/** Maximum scroll speed in px per animation frame (~900px/s at 60fps). */
export const MAX_SPEED = 15

export function useAutoScrollOnDrag(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  const pointerY = useRef(0)
  const rafId = useRef<number | null>(null)

  // Track pointer position via a global pointermove listener while dragging
  useEffect(() => {
    if (!active) return

    const handlePointerMove = (e: PointerEvent) => {
      pointerY.current = e.clientY
    }

    document.addEventListener('pointermove', handlePointerMove)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
    }
  }, [active])

  // Run the auto-scroll RAF loop while dragging
  useEffect(() => {
    if (!active) return

    // Suppress the auto-scroll loop entirely under reduced motion. The
    // pointer-tracking effect above still runs so the drag itself works;
    // only the continuous near-edge scrolling is disabled.
    const prefersReducedMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (prefersReducedMotion) return

    const tick = () => {
      const container = containerRef.current
      if (!container) {
        rafId.current = requestAnimationFrame(tick)
        return
      }

      const rect = container.getBoundingClientRect()
      const y = pointerY.current

      const distFromTop = y - rect.top
      const distFromBottom = rect.bottom - y

      if (distFromTop < SCROLL_ZONE && distFromTop >= 0) {
        const speed = ((SCROLL_ZONE - distFromTop) / SCROLL_ZONE) * MAX_SPEED
        container.scrollTop -= speed
      } else if (distFromBottom < SCROLL_ZONE && distFromBottom >= 0) {
        const speed = ((SCROLL_ZONE - distFromBottom) / SCROLL_ZONE) * MAX_SPEED
        container.scrollTop += speed
      }

      rafId.current = requestAnimationFrame(tick)
    }

    rafId.current = requestAnimationFrame(tick)

    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
    }
  }, [active, containerRef])
}
