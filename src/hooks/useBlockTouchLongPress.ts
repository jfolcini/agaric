import { useCallback, useEffect, useRef } from 'react'

export const LONG_PRESS_DELAY = 400
export const LONG_PRESS_MOVE_THRESHOLD = 10

export interface UseBlockTouchLongPressOptions {
  openContextMenu: (x: number, y: number, linkUrl?: string) => void
  isDraggingRef: React.RefObject<boolean>
}

export interface UseBlockTouchLongPressReturn {
  handleTouchStart: (e: React.TouchEvent) => void
  handleTouchEnd: () => void
  handleTouchMove: (e: React.TouchEvent) => void
  handleContextMenu: (e: React.MouseEvent) => void
  clearLongPress: () => void
}

export function useBlockTouchLongPress({
  openContextMenu,
  isDraggingRef,
}: UseBlockTouchLongPressOptions): UseBlockTouchLongPressReturn {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchStartPos = useRef<{ x: number; y: number } | null>(null)
  // BUG-37: keep a reference to the touchstart event so we can call
  // `preventDefault()` when the long-press is *recognized* (after 400ms).
  // This suppresses the browser's native text-selection / magnifier UI
  // that would otherwise compete with our custom context menu.
  const touchStartEvent = useRef<React.TouchEvent | null>(null)

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    touchStartPos.current = null
    touchStartEvent.current = null
  }, [])

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      const target = e.target as HTMLElement
      touchStartPos.current = { x: touch.clientX, y: touch.clientY }
      touchStartEvent.current = e
      longPressTimer.current = setTimeout(() => {
        if (!isDraggingRef.current) {
          // BUG-37: prevent the native text-select / magnifier that Android /
          // iOS WebViews trigger on long-press. Best-effort even on passive
          // listeners — clearing the native selection belt-and-suspenders.
          try {
            touchStartEvent.current?.preventDefault()
          } catch {
            // Passive listener — swallow; `touch-action: none` on the
            // wrapper (applied by the consumer) is the fallback.
          }
          if (typeof window !== 'undefined') {
            window.getSelection?.()?.removeAllRanges()
          }
          const linkEl = target.closest('.external-link') as
            | HTMLAnchorElement
            | HTMLSpanElement
            | null
          const linkUrl = linkEl
            ? (linkEl.getAttribute('href') ?? linkEl.getAttribute('data-href') ?? undefined)
            : undefined
          openContextMenu(touch.clientX, touch.clientY, linkUrl)
        }
        longPressTimer.current = null
        touchStartEvent.current = null
      }, LONG_PRESS_DELAY)
    },
    [openContextMenu, isDraggingRef],
  )

  const handleTouchEnd = useCallback(() => {
    clearLongPress()
  }, [clearLongPress])

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartPos.current) return
      const touch = e.touches[0]
      if (!touch) return
      const dx = touch.clientX - touchStartPos.current.x
      const dy = touch.clientY - touchStartPos.current.y
      if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD) {
        clearLongPress()
      }
    },
    [clearLongPress],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const linkEl = (e.target as HTMLElement).closest('.external-link') as
        | HTMLAnchorElement
        | HTMLSpanElement
        | null
      const linkUrl = linkEl
        ? (linkEl.getAttribute('href') ?? linkEl.getAttribute('data-href') ?? undefined)
        : undefined
      openContextMenu(e.clientX, e.clientY, linkUrl)
    },
    [openContextMenu],
  )

  // Cleanup timer on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      clearLongPress()
    }
  }, [clearLongPress])

  return {
    handleTouchStart,
    handleTouchEnd,
    handleTouchMove,
    handleContextMenu,
    clearLongPress,
  }
}
