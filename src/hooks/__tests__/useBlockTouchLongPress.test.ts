import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LONG_PRESS_DELAY,
  LONG_PRESS_MOVE_THRESHOLD,
  useBlockTouchLongPress,
} from '../useBlockTouchLongPress'

describe('useBlockTouchLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exports correct LONG_PRESS_DELAY constant', () => {
    expect(LONG_PRESS_DELAY).toBe(400)
  })

  it('exports correct LONG_PRESS_MOVE_THRESHOLD constant', () => {
    expect(LONG_PRESS_MOVE_THRESHOLD).toBe(10)
  })

  it('returns all expected handler functions', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    expect(typeof result.current.handleTouchStart).toBe('function')
    expect(typeof result.current.handleTouchEnd).toBe('function')
    expect(typeof result.current.handleTouchMove).toBe('function')
    expect(typeof result.current.handleContextMenu).toBe('function')
    expect(typeof result.current.clearLongPress).toBe('function')

    unmount()
  })

  it('opens context menu after LONG_PRESS_DELAY', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const div = document.createElement('div')
    document.body.append(div)

    const touchEvent = {
      touches: [{ clientX: 100, clientY: 200 }],
      target: div,
    } as unknown as React.TouchEvent

    act(() => {
      result.current.handleTouchStart(touchEvent)
    })

    expect(openContextMenu).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).toHaveBeenCalledOnce()
    expect(openContextMenu).toHaveBeenCalledWith(100, 200, undefined)

    document.body.removeChild(div)
    unmount()
  })

  it('does not open context menu if touch ends before delay', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const touchEvent = {
      touches: [{ clientX: 100, clientY: 200 }],
    } as unknown as React.TouchEvent

    act(() => {
      result.current.handleTouchStart(touchEvent)
    })

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY / 2)
    })

    act(() => {
      result.current.handleTouchEnd()
    })

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  it('cancels long press when touch moves beyond threshold', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 100 }],
      } as unknown as React.TouchEvent)
    })

    act(() => {
      result.current.handleTouchMove({
        touches: [{ clientX: 100 + LONG_PRESS_MOVE_THRESHOLD + 1, clientY: 100 }],
      } as unknown as React.TouchEvent)
    })

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  // #927 f5: the canonical scroll-conflict scenario — the user starts a
  // vertical scroll. Pure vertical movement past the threshold must cancel
  // the long-press so the scroll is not hijacked into a context menu.
  it('cancels long press on vertical scroll (scroll intent wins)', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 200 }],
      } as unknown as React.TouchEvent)
    })

    // Pure vertical drag (no horizontal component) past the threshold —
    // the classic "I'm scrolling" gesture, fired BEFORE the 400ms timer.
    act(() => {
      result.current.handleTouchMove({
        touches: [{ clientX: 100, clientY: 200 + LONG_PRESS_MOVE_THRESHOLD + 1 }],
      } as unknown as React.TouchEvent)
    })

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  // #927 f5: a multi-step scroll — several small moves that individually stay
  // under the threshold but cumulatively pass it — must still cancel, because
  // the threshold is measured against the original touchstart, not the prior
  // move. (Documents that we compare to the START, not the last position.)
  it('cancels long press once cumulative vertical travel passes the threshold', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 200 }],
      } as unknown as React.TouchEvent)
    })

    // First small move stays within threshold — does not cancel yet.
    act(() => {
      result.current.handleTouchMove({
        touches: [{ clientX: 100, clientY: 205 }],
      } as unknown as React.TouchEvent)
    })
    // Second move crosses the threshold relative to the START position.
    act(() => {
      result.current.handleTouchMove({
        touches: [{ clientX: 100, clientY: 212 }],
      } as unknown as React.TouchEvent)
    })

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  it('does not cancel long press for small movements within threshold', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const div = document.createElement('div')
    document.body.append(div)

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 100 }],
        target: div,
      } as unknown as React.TouchEvent)
    })

    act(() => {
      result.current.handleTouchMove({
        touches: [{ clientX: 105, clientY: 103 }],
      } as unknown as React.TouchEvent)
    })

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).toHaveBeenCalledOnce()

    document.body.removeChild(div)
    unmount()
  })

  it('does not open context menu if isDragging is true', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 200 }],
      } as unknown as React.TouchEvent)
    })

    isDraggingRef.current = true

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  // ── #926 f2: documented gesture precedence — DRAG WINS over long-press ──
  // The drag sensor's 250 ms delay elapses before the 400 ms long-press timer.
  // When the drag activates, the consumer calls `clearLongPress()` (the eager
  // cancel path). This asserts that cancelling the PENDING timer at t≈250 ms
  // prevents the context menu even after the full 400 ms would have elapsed —
  // distinct from the lazy `isDraggingRef` re-check at the 400 ms mark.
  it('drag activation cancels the pending long-press timer (drag wins — #926 f2)', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 200 }],
      } as unknown as React.TouchEvent)
    })

    // Drag sensor activates at its 250 ms delay (< the 400 ms long-press).
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(openContextMenu).not.toHaveBeenCalled() // timer still pending, hasn't fired

    // Consumer's isDragging effect fires `clearLongPress()` on drag-start: the
    // pending long-press timer is cancelled eagerly.
    isDraggingRef.current = true
    act(() => {
      result.current.clearLongPress()
    })

    // Advance well past 400 ms: the cancelled timer must NOT open the menu.
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })
    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  // ── #926 f2: the complementary case — ELSEWHERE the long-press WINS ──
  // With no drag activator (block body), no drag ever activates, so the timer
  // fires uncontested at 400 ms and opens the context menu (the touch path to
  // Indent/Dedent/Move — #926 f4).
  it('long-press wins when no drag activates (block body — #926 f2)', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 300, clientY: 400 }],
        target: document.createElement('div'),
      } as unknown as React.TouchEvent)
    })

    // No drag activates: advance to the full long-press delay.
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).toHaveBeenCalledTimes(1)

    unmount()
  })

  it('handleContextMenu prevents default and opens context menu', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const div = document.createElement('div')
    document.body.append(div)

    const preventDefault = vi.fn()
    const mouseEvent = {
      preventDefault,
      clientX: 300,
      clientY: 400,
      target: div,
    } as unknown as React.MouseEvent

    act(() => {
      result.current.handleContextMenu(mouseEvent)
    })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(openContextMenu).toHaveBeenCalledWith(300, 400, undefined)

    document.body.removeChild(div)
    unmount()
  })

  it('handles touch event with no touches gracefully', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    act(() => {
      result.current.handleTouchStart({
        touches: [],
      } as unknown as React.TouchEvent)
    })

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  it('handles touch move with no prior start gracefully', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    act(() => {
      result.current.handleTouchMove({
        touches: [{ clientX: 200, clientY: 200 }],
      } as unknown as React.TouchEvent)
    })

    // Should not throw
    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  it('clearLongPress can be called safely when no timer is active', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    // Should not throw
    act(() => {
      result.current.clearLongPress()
    })

    unmount()
  })

  it('handleContextMenu passes linkUrl when clicking on an .external-link element', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    // Create a DOM structure with an external link
    const link = document.createElement('a')
    link.classList.add('external-link')
    link.setAttribute('href', 'https://example.com')
    const span = document.createElement('span')
    link.append(span)
    document.body.append(link)

    const preventDefault = vi.fn()
    const mouseEvent = {
      preventDefault,
      clientX: 300,
      clientY: 400,
      target: span,
    } as unknown as React.MouseEvent

    act(() => {
      result.current.handleContextMenu(mouseEvent)
    })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(openContextMenu).toHaveBeenCalledWith(300, 400, 'https://example.com')

    document.body.removeChild(link)
    unmount()
  })

  it('handleContextMenu passes undefined linkUrl when clicking on a non-link element', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const div = document.createElement('div')
    document.body.append(div)

    const preventDefault = vi.fn()
    const mouseEvent = {
      preventDefault,
      clientX: 100,
      clientY: 200,
      target: div,
    } as unknown as React.MouseEvent

    act(() => {
      result.current.handleContextMenu(mouseEvent)
    })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(openContextMenu).toHaveBeenCalledWith(100, 200, undefined)

    document.body.removeChild(div)
    unmount()
  })

  it('handleContextMenu reads data-href when href is absent', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const span = document.createElement('span')
    span.classList.add('external-link')
    span.setAttribute('data-href', 'https://fallback.com')
    document.body.append(span)

    const preventDefault = vi.fn()
    const mouseEvent = {
      preventDefault,
      clientX: 50,
      clientY: 60,
      target: span,
    } as unknown as React.MouseEvent

    act(() => {
      result.current.handleContextMenu(mouseEvent)
    })

    expect(openContextMenu).toHaveBeenCalledWith(50, 60, 'https://fallback.com')

    document.body.removeChild(span)
    unmount()
  })

  // The long-press timer must call preventDefault on the stored
  // touchstart event so the native text-select / magnifier UI doesn't
  // race with the custom context menu on Android / iOS.
  it('calls preventDefault on the stored touchstart event when the long-press fires', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const preventDefault = vi.fn()
    const div = document.createElement('div')
    document.body.append(div)

    const touchEvent = {
      touches: [{ clientX: 100, clientY: 200 }],
      target: div,
      preventDefault,
    } as unknown as React.TouchEvent

    act(() => {
      result.current.handleTouchStart(touchEvent)
    })

    // Before the threshold: preventDefault must NOT be called — the user
    // might still scroll / lift their finger without triggering the menu.
    expect(preventDefault).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(openContextMenu).toHaveBeenCalledWith(100, 200, undefined)

    document.body.removeChild(div)
    unmount()
  })

  it('does NOT call preventDefault when the touch ends before the threshold', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const preventDefault = vi.fn()
    const touchEvent = {
      touches: [{ clientX: 100, clientY: 200 }],
      target: document.createElement('div'),
      preventDefault,
    } as unknown as React.TouchEvent

    act(() => {
      result.current.handleTouchStart(touchEvent)
    })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY / 2)
    })
    act(() => {
      result.current.handleTouchEnd()
    })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  it('does NOT call preventDefault when the drag flag is set', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const preventDefault = vi.fn()
    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 200 }],
        preventDefault,
      } as unknown as React.TouchEvent)
    })

    isDraggingRef.current = true

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(openContextMenu).not.toHaveBeenCalled()

    unmount()
  })

  it('silently swallows preventDefault failures (passive listener safety)', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const preventDefault = vi.fn(() => {
      throw new Error('passive listener — preventDefault not allowed')
    })
    const div = document.createElement('div')
    document.body.append(div)

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 200 }],
        target: div,
        preventDefault,
      } as unknown as React.TouchEvent)
    })

    // Must not throw — the hook swallows preventDefault errors.
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY)
      })
    }).not.toThrow()

    expect(openContextMenu).toHaveBeenCalledOnce()

    document.body.removeChild(div)
    unmount()
  })
})
