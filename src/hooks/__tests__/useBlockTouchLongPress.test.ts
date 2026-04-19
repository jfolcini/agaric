import { act } from '@testing-library/react'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LONG_PRESS_DELAY,
  LONG_PRESS_MOVE_THRESHOLD,
  useBlockTouchLongPress,
} from '../useBlockTouchLongPress'

function renderHook<T>(hookFn: () => T): {
  result: { current: T }
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root

  const result = { current: undefined as unknown as T }

  function TestComponent(): null {
    result.current = hookFn()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(TestComponent))
  })

  return {
    result,
    unmount() {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe('useBlockTouchLongPress', () => {
  beforeEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: React test env global
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
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
    document.body.appendChild(div)

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

  it('does not cancel long press for small movements within threshold', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const div = document.createElement('div')
    document.body.appendChild(div)

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

  it('handleContextMenu prevents default and opens context menu', () => {
    const openContextMenu = vi.fn()
    const isDraggingRef = { current: false }

    const { result, unmount } = renderHook(() =>
      useBlockTouchLongPress({ openContextMenu, isDraggingRef }),
    )

    const div = document.createElement('div')
    document.body.appendChild(div)

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
    link.appendChild(span)
    document.body.appendChild(link)

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
    document.body.appendChild(div)

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
    document.body.appendChild(span)

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

  // BUG-37: the long-press timer must call preventDefault on the stored
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
    document.body.appendChild(div)

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
    document.body.appendChild(div)

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
