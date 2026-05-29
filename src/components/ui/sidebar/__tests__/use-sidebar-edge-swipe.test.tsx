/**
 * Tests for useSidebarEdgeSwipe hook.
 *
 * Validates:
 *  - Listeners are only attached when `isMobile=true && openMobile=false`.
 *  - A left-edge horizontal swipe past the threshold calls `setOpenMobile(true)`.
 *  - A vertical swipe is ignored (so scroll still wins).
 *  - A swipe that starts outside the 20-px edge zone is ignored.
 *  - Listeners are removed on unmount.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSidebarEdgeSwipe } from '../use-sidebar-edge-swipe'

/**
 * Builds a TouchEvent. jsdom does not implement TouchEvent constructor,
 * so we create a generic Event and stamp a `touches` array onto it.
 */
function makeTouchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend',
  touches: Array<{ clientX: number; clientY: number }>,
): TouchEvent {
  const event = new Event(type, { bubbles: true }) as Event & {
    touches: ReadonlyArray<{ clientX: number; clientY: number }>
  }
  event.touches = touches
  return event as unknown as TouchEvent
}

describe('useSidebarEdgeSwipe', () => {
  it('does nothing when isMobile=false', () => {
    const setOpenMobile = vi.fn()
    renderHook(() => useSidebarEdgeSwipe(false, false, setOpenMobile))

    document.dispatchEvent(makeTouchEvent('touchstart', [{ clientX: 5, clientY: 100 }]))
    document.dispatchEvent(makeTouchEvent('touchmove', [{ clientX: 80, clientY: 100 }]))
    expect(setOpenMobile).not.toHaveBeenCalled()
  })

  it('does nothing when openMobile=true (sheet already open)', () => {
    const setOpenMobile = vi.fn()
    renderHook(() => useSidebarEdgeSwipe(true, true, setOpenMobile))

    document.dispatchEvent(makeTouchEvent('touchstart', [{ clientX: 5, clientY: 100 }]))
    document.dispatchEvent(makeTouchEvent('touchmove', [{ clientX: 80, clientY: 100 }]))
    expect(setOpenMobile).not.toHaveBeenCalled()
  })

  it('opens sidebar on horizontal edge swipe past threshold', () => {
    const setOpenMobile = vi.fn()
    renderHook(() => useSidebarEdgeSwipe(true, false, setOpenMobile))

    document.dispatchEvent(makeTouchEvent('touchstart', [{ clientX: 5, clientY: 100 }]))
    document.dispatchEvent(makeTouchEvent('touchmove', [{ clientX: 60, clientY: 100 }]))
    expect(setOpenMobile).toHaveBeenCalledWith(true)
  })

  it('ignores swipe that starts outside the 20-px edge zone', () => {
    const setOpenMobile = vi.fn()
    renderHook(() => useSidebarEdgeSwipe(true, false, setOpenMobile))

    document.dispatchEvent(makeTouchEvent('touchstart', [{ clientX: 50, clientY: 100 }]))
    document.dispatchEvent(makeTouchEvent('touchmove', [{ clientX: 200, clientY: 100 }]))
    expect(setOpenMobile).not.toHaveBeenCalled()
  })

  it('ignores swipe that is more vertical than horizontal', () => {
    const setOpenMobile = vi.fn()
    renderHook(() => useSidebarEdgeSwipe(true, false, setOpenMobile))

    document.dispatchEvent(makeTouchEvent('touchstart', [{ clientX: 5, clientY: 100 }]))
    // dx=15, dy=200 → vertical dominates → tracking aborted.
    document.dispatchEvent(makeTouchEvent('touchmove', [{ clientX: 20, clientY: 300 }]))
    // Subsequent qualifying move should NOT re-arm since tracking was cleared.
    document.dispatchEvent(makeTouchEvent('touchmove', [{ clientX: 70, clientY: 300 }]))
    expect(setOpenMobile).not.toHaveBeenCalled()
  })

  it('ignores multi-touch (touches.length > 1)', () => {
    const setOpenMobile = vi.fn()
    renderHook(() => useSidebarEdgeSwipe(true, false, setOpenMobile))

    document.dispatchEvent(
      makeTouchEvent('touchstart', [
        { clientX: 5, clientY: 100 },
        { clientX: 50, clientY: 100 },
      ]),
    )
    document.dispatchEvent(makeTouchEvent('touchmove', [{ clientX: 80, clientY: 100 }]))
    expect(setOpenMobile).not.toHaveBeenCalled()
  })

  it('removes listeners on unmount', () => {
    const setOpenMobile = vi.fn()
    const { unmount } = renderHook(() => useSidebarEdgeSwipe(true, false, setOpenMobile))

    unmount()

    document.dispatchEvent(makeTouchEvent('touchstart', [{ clientX: 5, clientY: 100 }]))
    document.dispatchEvent(makeTouchEvent('touchmove', [{ clientX: 80, clientY: 100 }]))
    expect(setOpenMobile).not.toHaveBeenCalled()
  })
})
