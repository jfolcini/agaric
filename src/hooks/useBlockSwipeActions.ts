import { useCallback, useRef, useState } from 'react'

/** Minimum leftward drag to reveal the delete button (px). */
export const REVEAL_THRESHOLD = 80

/** Leftward drag distance that triggers an auto-delete (px). */
export const AUTO_DELETE_THRESHOLD = 200

/** Maximum vertical movement before the gesture is cancelled (px). */
export const VERTICAL_CANCEL_THRESHOLD = 10

interface SwipeState {
  startX: number
  startY: number
  currentX: number
  swiping: boolean
}

/**
 * Hook that provides swipe-left-to-delete gesture handling for mobile.
 *
 * Only active on coarse-pointer (touch) devices.
 *
 * - Swipe left > 80 px → reveals a delete button behind the content
 * - Swipe left > 200 px → auto-confirms deletion
 * - Vertical scroll > 10 px cancels the gesture (avoids scroll conflicts)
 */
export function useBlockSwipeActions(onDelete: () => void) {
  const [translateX, setTranslateX] = useState(0)
  const [isRevealed, setIsRevealed] = useState(false)
  const stateRef = useRef<SwipeState>({
    startX: 0,
    startY: 0,
    currentX: 0,
    swiping: false,
  })

  // Only active on coarse pointer devices (touch screens)
  const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isTouch) return
      const touch = e.touches[0]
      if (!touch) return
      stateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        currentX: touch.clientX,
        swiping: false,
      }
    },
    [isTouch],
  )

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isTouch) return
      const touch = e.touches[0]
      if (!touch) return
      const dx = touch.clientX - stateRef.current.startX
      const dy = Math.abs(touch.clientY - stateRef.current.startY)

      // Cancel if vertical scroll exceeds threshold before swiping started
      if (dy > VERTICAL_CANCEL_THRESHOLD && !stateRef.current.swiping) return

      // Only allow left swipe (negative dx)
      if (dx < -10) {
        stateRef.current.swiping = true
        stateRef.current.currentX = touch.clientX
        setTranslateX(Math.max(dx, -AUTO_DELETE_THRESHOLD)) // Clamp to max swipe distance
      }
    },
    [isTouch],
  )

  const onTouchEnd = useCallback(() => {
    if (!stateRef.current.swiping) return

    // Read final delta from ref to avoid stale closure over translateX
    const dx = stateRef.current.currentX - stateRef.current.startX

    if (dx < -AUTO_DELETE_THRESHOLD) {
      // Full swipe — auto-delete
      onDelete()
      setTranslateX(0)
      setIsRevealed(false)
    } else if (dx < -REVEAL_THRESHOLD) {
      // Partial swipe — reveal delete button
      setTranslateX(-REVEAL_THRESHOLD)
      setIsRevealed(true)
    } else {
      // Below threshold — snap back
      setTranslateX(0)
      setIsRevealed(false)
    }
    stateRef.current.swiping = false
  }, [onDelete])

  const reset = useCallback(() => {
    setTranslateX(0)
    setIsRevealed(false)
  }, [])

  return {
    translateX,
    isRevealed,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
    reset,
  }
}
