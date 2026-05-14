import * as React from 'react'

/**
 * Swipe-from-left-edge gesture handler for the mobile Sidebar.
 *
 * Extracted from `sidebar.tsx`. Tracks touch events starting near the
 * viewport's left edge (`SWIPE_EDGE_ZONE` px) and opens the mobile Sheet
 * when the user crosses `SWIPE_MIN_DISTANCE` px horizontally. Cancels if
 * the gesture becomes more vertical than horizontal (so vertical scroll
 * still wins).
 *
 * Inactive when:
 *   - `isMobile` is false (gesture is irrelevant on desktop).
 *   - `openMobile` is already true (no point opening twice).
 */

export const SWIPE_EDGE_ZONE = 20 // px from left edge to start tracking
export const SWIPE_MIN_DISTANCE = 50 // px horizontal distance to trigger open

export function useSidebarEdgeSwipe(
  isMobile: boolean,
  openMobile: boolean,
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  React.useEffect(() => {
    if (!isMobile || openMobile) return

    let startX = 0
    let startY = 0
    let tracking = false

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) return
      const touch = e.touches[0]
      if (!touch) return
      if (touch.clientX < SWIPE_EDGE_ZONE) {
        startX = touch.clientX
        startY = touch.clientY
        tracking = true
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return
      const touch = e.touches[0]
      if (!touch) return
      const dx = touch.clientX - startX
      const dy = Math.abs(touch.clientY - startY)

      // Cancel if swipe becomes more vertical than horizontal
      if (dy > Math.abs(dx)) {
        tracking = false
        return
      }

      if (dx >= SWIPE_MIN_DISTANCE) {
        tracking = false
        setOpenMobile(true)
      }
    }

    const onTouchEnd = () => {
      tracking = false
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })

    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [isMobile, openMobile, setOpenMobile])
}
