/**
 * Tests for useSidebarRailDrag hook.
 *
 * Validates:
 *  - `onDoubleClick` resets width and opens.
 *  - `onPointerDown` with no movement is treated as a click → toggle.
 *  - `onPointerDown` with horizontal drag past 2-px hysteresis sets
 *    isResizing=true and updates width.
 *  - Drag from collapsed state opens the sidebar.
 *  - Dragging below SIDEBAR_WIDTH_ICON_PX collapses the sidebar.
 *  - Unmounting mid-drag detaches the document-level listeners (FE-H-15).
 *  - Ignores non-primary mouse buttons.
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSidebarRailDrag } from '../use-sidebar-rail-drag'

function makePointerEvent(type: 'pointermove' | 'pointerup', clientX: number): PointerEvent {
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

  it('drag from collapsed state opens the sidebar', () => {
    const opts = defaultOptions({ open: false, sidebarWidth: 200 })
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(0))
    })
    act(() => {
      document.dispatchEvent(makePointerEvent('pointermove', 80)) // delta=80
    })

    expect(opts.setOpen).toHaveBeenCalledWith(true)
    // start width was 0 (collapsed), so new width is 0 + 80 = 80.
    expect(opts.setSidebarWidth).toHaveBeenCalledWith(80)

    act(() => {
      document.dispatchEvent(makePointerEvent('pointerup', 80))
    })
  })

  it('dragging below SIDEBAR_WIDTH_ICON_PX collapses the sidebar', () => {
    const opts = defaultOptions({ open: true, sidebarWidth: 100 })
    const { result } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(100))
    })
    // Drag left so new width = 100 - 70 = 30 (< 48 icon px).
    act(() => {
      document.dispatchEvent(makePointerEvent('pointermove', 30))
    })

    expect(opts.setIsResizing).toHaveBeenLastCalledWith(false)
    expect(opts.setOpen).toHaveBeenCalledWith(false)
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

  it('unmount mid-drag detaches document listeners (FE-H-15)', () => {
    const opts = defaultOptions()
    const { result, unmount } = renderHook(() => useSidebarRailDrag(opts))

    act(() => {
      result.current.onPointerDown(makeReactPointerEvent(100))
    })

    unmount()

    // After unmount, dispatching a move/up should not call any setters.
    document.dispatchEvent(makePointerEvent('pointermove', 200))
    document.dispatchEvent(makePointerEvent('pointerup', 200))

    expect(opts.setSidebarWidth).not.toHaveBeenCalled()
    expect(opts.toggleSidebar).not.toHaveBeenCalled()
  })
})
