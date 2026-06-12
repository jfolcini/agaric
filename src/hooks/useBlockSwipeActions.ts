import { useCallback, useRef, useState } from 'react'

import { useIsTouch } from './useIsTouch'

/** Minimum leftward drag to reveal the delete button (px). */
export const REVEAL_THRESHOLD = 80

/** Leftward drag distance that triggers an auto-delete (px). */
export const AUTO_DELETE_THRESHOLD = 200

/** Maximum vertical movement before the gesture is cancelled (px). */
export const VERTICAL_CANCEL_THRESHOLD = 10

/**
 * #927 f4: rightward drag distance that triggers an indent (px).
 *
 * Chosen at 60 px — large enough to clear an accidental horizontal jitter
 * during vertical scroll, small enough to feel like a flick. Indent is a
 * non-destructive, easily-reversible action, so a low bar is appropriate.
 */
export const INDENT_THRESHOLD = 60

/**
 * #927 f4: minimum leftward drag that triggers an outdent (px).
 *
 * Mirrors the indent threshold (60) so the two structural gestures feel
 * symmetric.
 */
export const OUTDENT_THRESHOLD = 60

/**
 * #927 f4: upper bound of the outdent band (px). A SHORT left swipe
 * (`OUTDENT_THRESHOLD` ≤ |dx| < `OUTDENT_MAX`) outdents; a longer left swipe
 * falls through to the delete ladder (reveal at `REVEAL_THRESHOLD`, auto-delete
 * at `AUTO_DELETE_THRESHOLD`).
 *
 * The bands are deliberately non-overlapping with a clear gap below the
 * delete affordance:
 *   indent  : dx ≥ +60 (right)
 *   outdent : −60 ≥ dx > −110 (short left)
 *   reveal  : −110 ≥ dx > −200 (left, shows delete button)
 *   delete  : dx ≤ −200 (long left)
 *
 * 110 sits roughly midway between the outdent floor (60) and the reveal
 * threshold (80)… — note 110 > REVEAL_THRESHOLD (80), so when the structural
 * gestures are active the reveal band starts at OUTDENT_MAX rather than
 * REVEAL_THRESHOLD, keeping outdent and reveal from overlapping.
 */
export const OUTDENT_MAX = 110

interface SwipeState {
  startX: number
  startY: number
  currentX: number
  swiping: boolean
}

/** Optional structural-gesture handlers (#927 f4). */
interface SwipeOptions {
  /** Right-swipe-to-indent handler. Omit to disable indent. */
  onIndent?: (() => void) | undefined
  /** Short-left-swipe-to-outdent handler. Omit to disable outdent. */
  onOutdent?: (() => void) | undefined
}

/**
 * Hook that provides swipe gesture handling for mobile block rows.
 *
 * Only active on coarse-pointer (touch) devices.
 *
 * Delete ladder (always available):
 * - Swipe left > 80 px → reveals a delete button behind the content
 * - Swipe left > 200 px → auto-confirms deletion (and `thresholdCrossed`
 *   flips to `true` mid-drag so callers can render a progressive cue —
 *   colour change + `t('block.swipe.releaseToDelete')` label — before the gesture
 *   actually fires; UX-304).
 * - Vertical scroll > 10 px cancels the gesture (avoids scroll conflicts)
 *
 * Structural gestures (#927 f4 — only when the matching handler is supplied):
 * - Swipe RIGHT > {@link INDENT_THRESHOLD} px → indent (`onIndent`)
 * - SHORT swipe LEFT in [{@link OUTDENT_THRESHOLD}, {@link OUTDENT_MAX}) px →
 *   outdent (`onOutdent`)
 *
 * When `onOutdent` is supplied the left-swipe reveal band starts at
 * {@link OUTDENT_MAX} instead of {@link REVEAL_THRESHOLD}, so outdent and the
 * delete-reveal never overlap. When neither structural handler is supplied the
 * hook behaves exactly as the original delete-only swipe (backward compatible).
 */
export function useBlockSwipeActions(onDelete: () => void, options?: SwipeOptions) {
  const onIndent = options?.onIndent
  const onOutdent = options?.onOutdent

  const [translateX, setTranslateX] = useState(0)
  const [isRevealed, setIsRevealed] = useState(false)
  // UX-304: live "you are past the auto-delete threshold" flag, exposed
  // so the overlay can switch from the muted reveal state to a
  // destructive "release to delete" affordance before touch-end.
  const [thresholdCrossed, setThresholdCrossed] = useState(false)
  const stateRef = useRef<SwipeState>({
    startX: 0,
    startY: 0,
    currentX: 0,
    swiping: false,
  })

  // Only active on coarse pointer devices (touch screens). useIsTouch
  // subscribes to the media query once instead of re-evaluating
  // matchMedia in the render body per block per render (#755), and is
  // reactive if the pointer mode changes (e.g. mouse attached).
  const isTouch = useIsTouch()

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

      // #927 f4: right swipe (positive dx) is the indent gesture. Track it so
      // touchEnd can fire indent, and give visual feedback by translating the
      // row rightward (clamped to the indent threshold so it reads as a hint,
      // not free dragging). Only when an indent handler is wired up — otherwise
      // right swipes are ignored exactly as before.
      if (dx > 10 && onIndent) {
        stateRef.current.swiping = true
        stateRef.current.currentX = touch.clientX
        setTranslateX(Math.min(dx, INDENT_THRESHOLD))
        setThresholdCrossed(false)
        return
      }

      // Left swipe (negative dx): delete ladder (+ outdent band when wired).
      if (dx < -10) {
        stateRef.current.swiping = true
        stateRef.current.currentX = touch.clientX
        setTranslateX(Math.max(dx, -AUTO_DELETE_THRESHOLD)) // Clamp to max swipe distance
        // UX-304: track the auto-delete threshold against the raw delta
        // (translateX is clamped, so it would always equal the threshold
        // once reached — we need the unclamped value to flip back if the
        // user drags partway back without lifting their finger).
        setThresholdCrossed(dx < -AUTO_DELETE_THRESHOLD)
      }
    },
    [isTouch, onIndent],
  )

  const onTouchEnd = useCallback(() => {
    if (!stateRef.current.swiping) return

    // Read final delta from ref to avoid stale closure over translateX
    const dx = stateRef.current.currentX - stateRef.current.startX

    // #927 f4: right swipe past the indent threshold → indent.
    if (onIndent && dx >= INDENT_THRESHOLD) {
      onIndent()
      setTranslateX(0)
      setIsRevealed(false)
      stateRef.current.swiping = false
      setThresholdCrossed(false)
      return
    }

    const leftDist = -dx // positive magnitude of a leftward swipe

    // #927 f4: SHORT left swipe in the outdent band → outdent. Sits entirely
    // below the delete-reveal band so the two never collide.
    if (onOutdent && leftDist >= OUTDENT_THRESHOLD && leftDist < OUTDENT_MAX) {
      onOutdent()
      setTranslateX(0)
      setIsRevealed(false)
      stateRef.current.swiping = false
      setThresholdCrossed(false)
      return
    }

    // When outdent is active, the delete-reveal band starts at OUTDENT_MAX so
    // it never overlaps the outdent band. Otherwise it keeps the original
    // REVEAL_THRESHOLD behaviour (backward compatible).
    const revealFloor = onOutdent ? OUTDENT_MAX : REVEAL_THRESHOLD

    if (dx < -AUTO_DELETE_THRESHOLD) {
      // Full swipe — auto-delete
      onDelete()
      setTranslateX(0)
      setIsRevealed(false)
    } else if (leftDist >= revealFloor) {
      // Partial swipe — reveal delete button
      setTranslateX(-REVEAL_THRESHOLD)
      setIsRevealed(true)
    } else {
      // Below threshold — snap back
      setTranslateX(0)
      setIsRevealed(false)
    }
    stateRef.current.swiping = false
    setThresholdCrossed(false)
  }, [onDelete, onIndent, onOutdent])

  const reset = useCallback(() => {
    setTranslateX(0)
    setIsRevealed(false)
    setThresholdCrossed(false)
  }, [])

  return {
    translateX,
    isRevealed,
    thresholdCrossed,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
    reset,
  }
}
