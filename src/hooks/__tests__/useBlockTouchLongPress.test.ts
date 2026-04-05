import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LONG_PRESS_DELAY,
  LONG_PRESS_MOVE_THRESHOLD,
  useBlockTouchLongPress,
} from '../useBlockTouchLongPress'

// biome-ignore lint/suspicious/noExplicitAny: act typing varies across React versions
let act: (cb: () => void) => void = undefined as any

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
  beforeEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: React test env global
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    const React = await import('react')
    // biome-ignore lint/suspicious/noExplicitAny: act typing varies across React versions
    act = (React as any).act
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

    const touchEvent = {
      touches: [{ clientX: 100, clientY: 200 }],
    } as unknown as React.TouchEvent

    act(() => {
      result.current.handleTouchStart(touchEvent)
    })

    expect(openContextMenu).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })

    expect(openContextMenu).toHaveBeenCalledOnce()
    expect(openContextMenu).toHaveBeenCalledWith(100, 200)

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

    act(() => {
      result.current.handleTouchStart({
        touches: [{ clientX: 100, clientY: 100 }],
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

    const preventDefault = vi.fn()
    const mouseEvent = {
      preventDefault,
      clientX: 300,
      clientY: 400,
    } as unknown as React.MouseEvent

    act(() => {
      result.current.handleContextMenu(mouseEvent)
    })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(openContextMenu).toHaveBeenCalledWith(300, 400)

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
})
