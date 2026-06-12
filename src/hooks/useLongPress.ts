/**
 * useLongPress — generic press-and-hold gesture for touch surfaces.
 *
 * A search-local sibling of `useBlockTouchLongPress` (which is coupled
 * to the block drag sensor and context-menu plumbing). This one is a
 * plain "fire `onLongPress` after the finger has held still for
 * `delay` ms" primitive — used by the mobile search-sheet scope toggle
 * to pin a scope (#135).
 *
 * Returns pointer-event handlers to spread onto the target. Pointer
 * events (not touch) so the same gesture works for stylus and
 * long-mouse-press without a separate code path; `pointerType` is
 * available on the event if a consumer wants to gate to touch.
 *
 * Cancellation: any movement past `moveThreshold` px (a scroll / drag
 * intent), pointer-up before the timer, or pointer-leave cancels the
 * pending long-press. The timer is also cleared on unmount.
 */

import { useCallback, useEffect, useRef } from 'react'

export const DEFAULT_LONG_PRESS_DELAY = 500
export const DEFAULT_LONG_PRESS_MOVE_THRESHOLD = 10

interface UseLongPressOptions {
  onLongPress: () => void
  delay?: number
  moveThreshold?: number
}

interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerMove: (e: React.PointerEvent) => void
}

export function useLongPress({
  onLongPress,
  delay = DEFAULT_LONG_PRESS_DELAY,
  moveThreshold = DEFAULT_LONG_PRESS_MOVE_THRESHOLD,
}: UseLongPressOptions): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)

  // Latest callback in a ref so the timer always fires the current
  // closure without re-creating the handlers on every render.
  const onLongPressRef = useRef(onLongPress)
  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])

  const clear = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    startPos.current = null
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      startPos.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        timer.current = null
        startPos.current = null
        onLongPressRef.current()
      }, delay)
    },
    [delay],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = startPos.current
      if (start == null) return
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (Math.sqrt(dx * dx + dy * dy) > moveThreshold) clear()
    },
    [clear, moveThreshold],
  )

  useEffect(() => clear, [clear])

  return {
    onPointerDown,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerMove,
  }
}
