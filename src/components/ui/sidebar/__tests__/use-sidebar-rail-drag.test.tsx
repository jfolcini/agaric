/**
 * Tests for useSidebarRailDrag hook.
 *
 * Validates:
 *  - `onDoubleClick` resets width and opens.
 *  - `onPointerDown` with no movement is treated as a click → toggle.
 *  - `onPointerDown` with horizontal drag past 2-px hysteresis sets
 *    isResizing=true and updates width.
 *  - Incremental drags from a collapsed state survive below the icon threshold.
 *  - Dragging below SIDEBAR_WIDTH_ICON_PX collapses the sidebar.
 *  - Unmounting mid-drag detaches the document-level listeners (FE-H-15).
 *  - Ignores non-primary mouse buttons.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSidebarRailDrag } from '@/components/ui/sidebar/use-sidebar-rail-drag'

function makePointerEvent(
  type: 'pointermove' | 'pointerup' | 'pointercancel',
  clientX: number,
): PointerEvent {
  const event = new Event(type, { bubbles: true }) as Event & { clientX: number }
  event.clientX = clientX
  return event as unknown as PointerEvent
}

function makeReactPointerEvent(clientX: number, button = 0): React.PointerEvent {
  return {
    button,
    clientX,
    preventDefault: vi.fn(),
  } as unknown as React.PointerEvent
}

function defaultOptions(overrides: Partial<Parameters<typeof useSidebarRailDrag>[0]> = {}) {
  return {
    open: true,
    sidebarWidth: 200,
    setSidebarWidth: vi.fn(),
    setOpen: vi.fn(),
    setIsResizing: vi.fn(),
    toggleSidebar: vi.fn(),
    ...overrides,
  }
}

describe('useSidebarRailDrag', () => {
  afterEach(() => {
    document.documentElement.style.cursor = ''
    document.body.style.userSelect = ''
  })

  it('onDoubleClick resets width to default and opens', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onDoubleClick()
    })

    expect(opts.setSidebarWidth).toHaveBeenCalledWith(150)
    expect(opts.setOpen).toHaveBeenCalledWith(true)
  })

  it('pointerdown with no movement is treated as a click → toggleSidebar', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(100))
    })

    // Pointerup without any movement.
    act(() => {
      document.dispatchEvent(makePointerEvent('pointerup', 100))
    })

    expect(opts.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(opts.setIsResizing).not.toHaveBeenCalled()
    expect(opts.setSidebarWidth).not.toHaveBeenCalled()
  })

  it('horizontal drag past 2-px hysteresis triggers isResizing + width update', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(100))
    })

    act(() => {
      document.dispatchEvent(makePointerEvent('pointermove', 120)) // delta=20
    })

    expect(opts.setIsResizing).toHaveBeenCalledWith(true)
    // start width 200 + delta 20 = 220
    expect(opts.setSidebarWidth).toHaveBeenCalledWith(220)

    act(() => {
      document.dispatchEvent(makePointerEvent('pointerup', 120))
    })

    // Final pointerup releases resize lock.
    expect(opts.setIsResizing).toHaveBeenLastCalledWith(false)
    // toggleSidebar should NOT fire (we moved).
    expect(opts.toggleSidebar).not.toHaveBeenCalled()
  })

  it('incrementally drags from collapsed through the icon threshold and opens', () => {
    const opts = defaultOptions({ open: false, sidebarWidth: 200 })
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(0))
    })

    for (const delta of [3, 10, 25]) {
      act(() => {
        document.dispatchEvent(makePointerEvent('pointermove', delta))
      })

      expect(document.documentElement.style.cursor).toBe('col-resize')
      expect(document.body.style.userSelect).toBe('none')
      expect(opts.setOpen).not.toHaveBeenCalledWith(false)
    }

    expect(opts.setOpen).toHaveBeenCalledWith(true)

    act(() => {
      document.dispatchEvent(makePointerEvent('pointermove', 60))
      document.dispatchEvent(makePointerEvent('pointermove', 120))
    })

    // The collapsed drag starts at zero and continues after crossing 48px.
    expect(opts.setSidebarWidth).toHaveBeenNthCalledWith(1, 3)
    expect(opts.setSidebarWidth).toHaveBeenNthCalledWith(2, 10)
    expect(opts.setSidebarWidth).toHaveBeenNthCalledWith(3, 25)
    expect(opts.setSidebarWidth).toHaveBeenNthCalledWith(4, 60)
    expect(opts.setSidebarWidth).toHaveBeenLastCalledWith(120)

    act(() => {
      document.dispatchEvent(makePointerEvent('pointerup', 120))
    })

    expect(opts.setOpen).not.toHaveBeenCalledWith(false)
    expect(opts.setIsResizing).toHaveBeenLastCalledWith(false)
  })

  it('recollapses after a collapsed drag crosses back below SIDEBAR_WIDTH_ICON_PX', () => {
    const opts = defaultOptions({ open: false, sidebarWidth: 150 })
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(0))
    })
    act(() => {
      document.dispatchEvent(makePointerEvent('pointermove', 60))
      document.dispatchEvent(makePointerEvent('pointermove', 25))
    })

    expect(opts.setIsResizing).toHaveBeenLastCalledWith(false)
    expect(opts.setOpen).toHaveBeenCalledWith(false)
    expect(document.documentElement.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('pointercancel ends a drag without falling back to a click', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(100))
      document.dispatchEvent(makePointerEvent('pointermove', 120))
      document.dispatchEvent(makePointerEvent('pointercancel', 120))
    })

    expect(opts.setIsResizing).toHaveBeenLastCalledWith(false)
    expect(opts.toggleSidebar).not.toHaveBeenCalled()
    expect(document.documentElement.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    document.dispatchEvent(makePointerEvent('pointermove', 200))
    document.dispatchEvent(makePointerEvent('pointerup', 200))
    expect(opts.setSidebarWidth).toHaveBeenCalledTimes(1)
  })

  it('ignores non-primary mouse buttons', () => {
    const opts = defaultOptions()
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(100, 2)) // right-click
    })
    act(() => {
      document.dispatchEvent(makePointerEvent('pointermove', 200))
      document.dispatchEvent(makePointerEvent('pointerup', 200))
    })

    expect(opts.setSidebarWidth).not.toHaveBeenCalled()
    expect(opts.toggleSidebar).not.toHaveBeenCalled()
    expect(opts.setIsResizing).not.toHaveBeenCalled()
  })

  it('unmount mid-drag restores the prior global styles and detaches listeners (FE-H-15)', () => {
    const opts = defaultOptions()
    const { result, unmount } = renderHook(() => useSidebarRailDrag(opts))

    document.documentElement.style.cursor = 'wait'
    document.body.style.userSelect = 'text'

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(100))
    })

    unmount()

    expect(document.documentElement.style.cursor).toBe('wait')
    expect(document.body.style.userSelect).toBe('text')

    // After unmount, dispatching a move/up should not call any setters.
    document.dispatchEvent(makePointerEvent('pointermove', 200))
    document.dispatchEvent(makePointerEvent('pointerup', 200))

    expect(opts.setSidebarWidth).not.toHaveBeenCalled()
    expect(opts.toggleSidebar).not.toHaveBeenCalled()
  })
})
