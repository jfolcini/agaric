import { useCallback, useEffect, useRef } from 'react'

export const LONG_PRESS_DELAY = 400
export const LONG_PRESS_MOVE_THRESHOLD = 10

/**
 * #926 f2 — DOCUMENTED gesture precedence: long-press (this hook, 400 ms) vs
 * drag (the @dnd-kit PointerSensor, 250 ms — see `useBlockDnD`). The two timers
 * are independent, so we encode an explicit, deterministic precedence rather
 * than let both fire:
 *
 *   1. ON THE DRAG HANDLE — the DRAG WINS. The sensor's 250 ms delay elapses
 *      first; when the drag activates, `useSortable().isDragging` flips true and
 *      the consumer (`SortableBlock`) immediately calls `clearLongPress()`,
 *      cancelling the still-pending 400 ms timer so no context menu opens behind
 *      the lift. Belt-and-suspenders: even if the timer somehow survives, its
 *      callback re-checks `isDraggingRef.current` at the 400 ms mark and bails.
 *
 *   2. ELSEWHERE (block body / content, no drag activator) — the LONG-PRESS
 *      WINS. No drag sensor is wired to those targets, so the 400 ms timer fires
 *      uncontested and opens the context menu (which itself offers Indent /
 *      Dedent / Move so touch users still get reorder + nesting — #926 f4).
 *
 * The single source of truth for "a drag is in progress" is `isDraggingRef`,
 * read both eagerly (cancel-on-drag-start via `clearLongPress`) and lazily (the
 * timer-callback guard). This is a pragmatic guard, not a full gesture arbiter.
 */

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
        // #926 f2 (precedence guard 2/2): the lazy re-check. If a drag activated
        // between touchstart and now (250 ms < 400 ms), the drag wins — bail
        // without opening the menu. The eager cancel (`clearLongPress` on
        // drag-start) is the primary path; this covers any timer that outraced it.
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
      // #927 f5: scroll intent wins over long-press. If the finger travels
      // past LONG_PRESS_MOVE_THRESHOLD (10 px) in ANY direction before the
      // 400 ms timer fires, the user is dragging — almost always a vertical
      // scroll — not holding a stationary press. Cancel the timer so the
      // scroll isn't hijacked into a context menu. The radial (Euclidean)
      // check covers vertical, horizontal, and diagonal drags alike; a
      // near-stationary press (jitter < 10 px) still opens the menu at 400 ms.
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
