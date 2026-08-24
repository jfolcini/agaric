import { useCallback, useEffect, useRef } from 'react'

export const LONG_PRESS_DELAY = 400
/**
 * Finger drift (px) past which a pending long-press is abandoned.
 *
 * MUST stay equal to `TOUCH_DRAG_TOLERANCE` (the @dnd-kit PointerSensor's
 * activation tolerance in `use-block-dnd.ts`) — see precedence note 3 below.
 * A drift-guard unit test asserts the two constants agree.
 */
export const LONG_PRESS_MOVE_THRESHOLD = 5

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
 *   3. THRESHOLDS MUST AGREE. The sensor cancels a pending drag once the finger
 *      drifts past its `tolerance` (`TOUCH_DRAG_TOLERANCE`, 5 px); this hook
 *      abandons a pending long-press once the finger drifts past
 *      `LONG_PRESS_MOVE_THRESHOLD`. While the latter was the looser 10 px, a
 *      6–9 px drift inside the first 250 ms fell in the gap: it killed the drag
 *      but not the long-press, so the menu popped on a gesture the user had
 *      performed as a drag. The two constants are now equal (5 px) and a unit
 *      test holds them there — deliberately tightening the long-press rather
 *      than loosening the sensor, since a looser sensor makes accidental
 *      reorders easier.
 *
 *   4. THE NATIVE `contextmenu` OBEYS THE SAME PRECEDENCE. Android WebView
 *      fires a native `contextmenu` at ~500 ms on a held element (wired via
 *      `SortableBlock`'s `onContextMenu`). By then the drag has activated
 *      (250 ms) and `clearLongPress()` has killed our own timer — but the
 *      native event arrives on its own path, so `handleContextMenu` re-checks
 *      `isDraggingRef` exactly like the timer callback does and bails.
 *
 * The single source of truth for "a drag is in progress" is `isDraggingRef`,
 * read both eagerly (cancel-on-drag-start via `clearLongPress`) and lazily (the
 * timer-callback guard and the native-`contextmenu` guard). This is a pragmatic
 * guard, not a full gesture arbiter.
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
  // Keep a reference to the touchstart event so we can call
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
      // A second touchstart before touchend (two-finger scroll / pinch) must
      // cancel any pending timer FIRST — assigning a new timer below would
      // otherwise orphan it (uncancellable, fires mid-scroll) — and a
      // multi-touch gesture is never a context-menu long-press, so bail.
      clearLongPress()
      if (e.touches.length > 1) return
      const touch = e.touches[0]
      if (!touch) return
      const target = e.target as HTMLElement | null
      // Inside the mounted editor's contenteditable the NATIVE long-press owns
      // the gesture (word selection / caret placement — the touch route to the
      // selection bubble menu). Hijacking it wiped the user's selection via
      // `removeAllRanges()` and popped the block menu over the text mid-edit.
      if (
        target &&
        typeof target.closest === 'function' &&
        target.closest('.ProseMirror, [contenteditable="true"]')
      ) {
        return
      }
      touchStartPos.current = { x: touch.clientX, y: touch.clientY }
      touchStartEvent.current = e
      const timer = setTimeout(() => {
        // #926 f2 (precedence guard 2/2): the lazy re-check. If a drag activated
        // between touchstart and now (250 ms < 400 ms), the drag wins — bail
        // without opening the menu. The eager cancel (`clearLongPress` on
        // drag-start) is the primary path; this covers any timer that outraced it.
        if (!isDraggingRef.current) {
          // Prevent the native text-select / magnifier that Android /
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
          const linkEl = target?.closest('.external-link') as
            | HTMLAnchorElement
            | HTMLSpanElement
            | null
          const linkUrl = linkEl
            ? (linkEl.getAttribute('href') ?? linkEl.getAttribute('data-href') ?? undefined)
            : undefined
          openContextMenu(touch.clientX, touch.clientY, linkUrl)
        }
        // Null the refs only while they still reference THIS timer — an
        // orphaned callback must not discard a newer pending timer's handle.
        if (longPressTimer.current === timer) {
          longPressTimer.current = null
          touchStartEvent.current = null
        }
      }, LONG_PRESS_DELAY)
      longPressTimer.current = timer
    },
    [openContextMenu, isDraggingRef, clearLongPress],
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
      // past LONG_PRESS_MOVE_THRESHOLD (5 px) in ANY direction before the
      // 400 ms timer fires, the user is dragging — a vertical scroll or a
      // press-and-hold reorder — not holding a stationary press. Cancel the
      // timer so the gesture isn't hijacked into a context menu. The radial
      // (Euclidean) check covers vertical, horizontal, and diagonal drags
      // alike; a near-stationary press (jitter ≤ 5 px) still opens the menu at
      // 400 ms. 5 px mirrors the drag sensor's tolerance (precedence note 3),
      // so no drift can cancel the drag while sparing the long-press.
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD) {
        clearLongPress()
      }
    },
    [clearLongPress],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Always suppress the browser's own menu — even mid-drag, where letting
      // the native menu through would be strictly worse than showing nothing.
      e.preventDefault()
      // #926 f2 (precedence guard, native path): Android WebView fires a native
      // `contextmenu` at ~500 ms on a held element. The drag activated at
      // 250 ms and `clearLongPress()` already killed our 400 ms timer, but this
      // event rides a separate path — so it needs the SAME `isDraggingRef`
      // check as the timer callback, or dragging a block also opens the menu.
      if (isDraggingRef.current) return
      const linkEl = (e.target as HTMLElement).closest('.external-link') as
        | HTMLAnchorElement
        | HTMLSpanElement
        | null
      const linkUrl = linkEl
        ? (linkEl.getAttribute('href') ?? linkEl.getAttribute('data-href') ?? undefined)
        : undefined
      openContextMenu(e.clientX, e.clientY, linkUrl)
    },
    [openContextMenu, isDraggingRef],
  )

  // Cleanup timer on unmount to prevent memory leak
  useEffect(
    () => () => {
      clearLongPress()
    },
    [clearLongPress],
  )

  return {
    handleTouchStart,
    handleTouchEnd,
    handleTouchMove,
    handleContextMenu,
    clearLongPress,
  }
}
