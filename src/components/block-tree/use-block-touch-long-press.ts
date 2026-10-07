import { useCallback, useEffect, useRef } from 'react'

import { haptic } from '@/lib/haptics'

/** Hold (ms) before a touch press is recognised; also the drag sensor's delay. */
export const LONG_PRESS_DELAY = 400
/**
 * Finger drift (px) that ends a pending press; also the drag sensor's tolerance.
 * The sensor and this hook share both constants (`useBlockDnD` imports them) and
 * the same per-axis measure (`exceedsThreshold`), so no drift can end one
 * gesture while sparing the other.
 */
export const LONG_PRESS_MOVE_THRESHOLD = 5

/** dnd-kit's `hasExceededDistance`: either axis past the threshold. */
export function exceedsThreshold(dx: number, dy: number): boolean {
  return Math.abs(dx) > LONG_PRESS_MOVE_THRESHOLD || Math.abs(dy) > LONG_PRESS_MOVE_THRESHOLD
}

/**
 * One touch gesture on a block row, shared with the dnd-kit TouchSensor that
 * `SortableBlock` wires to the same row with the same delay and tolerance:
 *
 *   - Hold 400 ms without moving → the row lifts (the sensor activates; this
 *     hook ticks the haptic and clears the native selection).
 *   - Then move → it is a drag; this hook opens nothing.
 *   - Then release without moving → the block menu opens at the press point.
 *   - Move past 5 px before the hold → scroll or swipe; both the drag and the
 *     menu are abandoned.
 *
 * The hold is recognised by two independent timers (the sensor's and this
 * one's) started by the same `touchstart`, so the menu never waits on dnd-kit
 * state. Inside the mounted editor's contenteditable the native long-press owns
 * the gesture (word selection, the touch route to the selection bubble), so
 * neither starts there: `isInsideEditableText` gates both.
 *
 * Android fires a native `contextmenu` at its own long-press timeout (400 ms
 * by default, racing both timers). `handleContextMenu` always suppresses it
 * and opens nothing while a touch press on the row is pending or a drag is
 * active: the release decides, or the menu would pop under the finger and
 * stay open through a drag.
 */

/** Whether a touch landed inside the mounted editor's contenteditable. */
export function isInsideEditableText(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('.ProseMirror, [contenteditable="true"]') !== null
  )
}

function linkUrlAt(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  const linkEl = target.closest('.external-link')
  return linkEl
    ? (linkEl.getAttribute('href') ?? linkEl.getAttribute('data-href') ?? undefined)
    : undefined
}

interface TouchPress {
  x: number
  y: number
  target: EventTarget | null
  held: boolean
  moved: boolean
}

export interface UseBlockTouchLongPressOptions {
  openContextMenu: (x: number, y: number, linkUrl?: string) => void
  isDraggingRef: React.RefObject<boolean>
}

export interface UseBlockTouchLongPressReturn {
  handleTouchStart: (e: React.TouchEvent) => void
  handleTouchEnd: (e: React.TouchEvent) => void
  handleTouchMove: (e: React.TouchEvent) => void
  handleContextMenu: (e: React.MouseEvent) => void
}

export function useBlockTouchLongPress({
  openContextMenu,
  isDraggingRef,
}: UseBlockTouchLongPressOptions): UseBlockTouchLongPressReturn {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const press = useRef<TouchPress | null>(null)

  const cancelPress = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    press.current = null
  }, [])

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // A second finger (two-finger scroll / pinch) ends the press; cancel
      // FIRST so the pending timer is never orphaned by a new one.
      cancelPress()
      if (e.touches.length > 1) return
      const touch = e.touches[0]
      if (!touch) return
      if (isInsideEditableText(e.target)) return
      const current: TouchPress = {
        x: touch.clientX,
        y: touch.clientY,
        target: e.target,
        held: false,
        moved: false,
      }
      press.current = current
      holdTimer.current = setTimeout(() => {
        if (press.current !== current) return
        holdTimer.current = null
        current.held = true
        haptic('tick')
        // The native long-press selection (Android / iOS WebViews) must not
        // sit under the lifted row or the menu.
        if (typeof window !== 'undefined') {
          window.getSelection?.()?.removeAllRanges()
        }
      }, LONG_PRESS_DELAY)
    },
    [cancelPress],
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const current = press.current
      if (!current) return
      const touch = e.touches[0]
      if (!touch) return
      // Against the touchstart point, so several small moves add up.
      if (exceedsThreshold(touch.clientX - current.x, touch.clientY - current.y)) {
        if (current.held) {
          current.moved = true
        } else {
          cancelPress()
        }
      }
    },
    [cancelPress],
  )

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const current = press.current
      cancelPress()
      if (current?.held && !current.moved) {
        // No compat mouse events after this release: Chromium's `mousedown`
        // would move focus off the menu that opens here (and `click` would
        // focus the block under it). A plain tap keeps its click.
        e.preventDefault()
        openContextMenu(current.x, current.y, linkUrlAt(current.target))
      }
    },
    [cancelPress, openContextMenu],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Always suppress the browser's own menu — even mid-drag, where letting
      // the native menu through would be strictly worse than showing nothing.
      e.preventDefault()
      if (isDraggingRef.current || press.current) return
      openContextMenu(e.clientX, e.clientY, linkUrlAt(e.target))
    },
    [openContextMenu, isDraggingRef],
  )

  useEffect(() => cancelPress, [cancelPress])

  return {
    handleTouchStart,
    handleTouchEnd,
    handleTouchMove,
    handleContextMenu,
  }
}
