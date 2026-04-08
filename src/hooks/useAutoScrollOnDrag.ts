/**
 * useAutoScrollOnDrag — auto-scrolls a container when the drag pointer
 * approaches the top or bottom edges of the viewport.
 *
 * Uses requestAnimationFrame for smooth 60fps scrolling with speed that
 * increases proportionally as the pointer gets closer to the edge.
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
