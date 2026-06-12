/**
 * usePullToDismiss — downward-drag-to-close gesture for a bottom sheet
 * (#133).
 *
 * Wires onto the sheet's grab handle / header region ONLY — never the
 * scrollable body — so a downward swipe inside the results list scrolls
 * normally and never fights the dismiss gesture. The handle is a small,
 * non-scrolling strip, so a downward drag there is unambiguous intent.
 *
 * Behaviour:
 *  - Tracks the live downward offset (`dragY`, clamped ≥ 0) so the
 *    consumer can translate the sheet under the finger for a "rubber
 *    band" feel.
 *  - On release past `threshold` px → fire `onDismiss` (with a haptic
 *    `dismiss` tick). Otherwise the offset springs back to 0.
 *  - Upward drags are ignored (clamped to 0) — you can't pull a
 *    bottom-anchored sheet further up.
 *
 * Pointer events + `setPointerCapture` so the drag keeps tracking even
 * if the finger leaves the handle's bounds mid-gesture.
 */

import { useCallback, useRef, useState } from 'react'

import { haptic } from '@/lib/haptics'

export const DEFAULT_DISMISS_THRESHOLD = 80

interface UsePullToDismissOptions {
  onDismiss: () => void
  threshold?: number
}

interface UsePullToDismissReturn {
  /** Current downward offset in px (0 when idle). Drive a translateY with this. */
  dragY: number
  /** Whether a drag is currently in progress (for disabling transitions). */
  dragging: boolean
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onPointerCancel: (e: React.PointerEvent) => void
  }
}

export function usePullToDismiss({
  onDismiss,
  threshold = DEFAULT_DISMISS_THRESHOLD,
}: UsePullToDismissOptions): UsePullToDismissReturn {
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const startY = useRef<number | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startY.current = e.clientY
    setDragging(true)
    // Keep receiving moves even if the finger slides off the handle.
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      // jsdom / unsupported — capture is an enhancement, not required.
    }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (startY.current == null) return
    // Clamp to ≥ 0: bottom sheets only pull DOWN.
    setDragY(Math.max(0, e.clientY - startY.current))
  }, [])

  const finish = useCallback(
    (e: React.PointerEvent) => {
      if (startY.current == null) return
      const travelled = Math.max(0, e.clientY - startY.current)
      startY.current = null
      setDragging(false)
      try {
        ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
      } catch {
        // Capture may never have been granted — ignore.
      }
      if (travelled >= threshold) {
        haptic('dismiss')
        // Leave the sheet translated where the finger let go; the
        // unmount/exit animation takes over from there.
        onDismiss()
        return
      }
      // Below threshold — spring back to rest.
      setDragY(0)
    },
    [onDismiss, threshold],
  )

  return {
    dragY,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  }
}
