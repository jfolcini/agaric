/**
 * Tests for useAutoScrollOnDrag — auto-scroll during drag near viewport edges.
 *
 * Validates:
 * - Scroll starts when pointer is near top edge
 * - Scroll starts when pointer is near bottom edge
 * - Scroll speed increases as pointer approaches edge
 * - No scroll when pointer is in the middle of the container
 * - Scroll stops when drag ends (active=false)
 * - Cleanup: RAF cancelled on unmount
 * - Pointermove listener added/removed with active state
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SPEED, SCROLL_ZONE, useAutoScrollOnDrag } from '../useAutoScrollOnDrag'

// ── RAF mock ────────────────────────────────────────────────────────────

let rafCallbacks: Map<number, FrameRequestCallback> = new Map()
let rafIdCounter = 1

function mockRAF(cb: FrameRequestCallback): number {
  const id = rafIdCounter++
  rafCallbacks.set(id, cb)
  return id
}

function mockCancelRAF(id: number) {
  rafCallbacks.delete(id)
}

function flushRAF(count = 1) {
  for (let i = 0; i < count; i++) {
    const cbs = new Map(rafCallbacks)
    rafCallbacks = new Map()
    for (const cb of cbs.values()) {
      cb(performance.now())
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeContainer(rect: Partial<DOMRect> = {}) {
  const el = document.createElement('div')
  const defaultRect = {
    top: 100,
    bottom: 600,
    left: 0,
    right: 800,
    width: 800,
    height: 500,
    x: 0,
    y: 100,
    toJSON: () => {},
  }
  el.getBoundingClientRect = vi.fn(() => ({ ...defaultRect, ...rect }) as DOMRect)

  // scrollTop needs to be writable for the test
  let _scrollTop = 200
  Object.defineProperty(el, 'scrollTop', {
    get: () => _scrollTop,
    set: (v: number) => {
      _scrollTop = v
    },
    configurable: true,
  })

  return el
}

function firePointerMove(clientY: number) {
  const event = new PointerEvent('pointermove', { clientY })
  document.dispatchEvent(event)
}

// ── Setup / teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  rafCallbacks = new Map()
  rafIdCounter = 1
  vi.stubGlobal('requestAnimationFrame', mockRAF)
  vi.stubGlobal('cancelAnimationFrame', mockCancelRAF)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Tests ────────────────────────────────────────────────────────────────

describe('useAutoScrollOnDrag', () => {
  // 1. Scrolls up when pointer is near the top edge
  it('scrolls up when pointer is near the top edge', () => {
    const container = makeContainer({ top: 100, bottom: 600 })
    const ref = { current: container }

    renderHook(() => useAutoScrollOnDrag(ref, true))

    // Pointer at 120px (20px from top edge, within SCROLL_ZONE of 50px)
    act(() => firePointerMove(120))

    const initialScrollTop = container.scrollTop
    act(() => flushRAF(1))

    expect(container.scrollTop).toBeLessThan(initialScrollTop)
  })

  // 2. Scrolls down when pointer is near the bottom edge
  it('scrolls down when pointer is near the bottom edge', () => {
    const container = makeContainer({ top: 100, bottom: 600 })
    const ref = { current: container }

    renderHook(() => useAutoScrollOnDrag(ref, true))

    // Pointer at 580px (20px from bottom edge)
    act(() => firePointerMove(580))

    const initialScrollTop = container.scrollTop
    act(() => flushRAF(1))

    expect(container.scrollTop).toBeGreaterThan(initialScrollTop)
  })

  // 3. Speed increases as pointer approaches edge (top)
  it('scrolls faster when pointer is closer to top edge', () => {
    const container1 = makeContainer({ top: 100, bottom: 600 })
    const ref1 = { current: container1 }

    const container2 = makeContainer({ top: 100, bottom: 600 })
    const ref2 = { current: container2 }

    // Pointer at 130px (30px from top) — slower
    const { unmount: u1 } = renderHook(() => useAutoScrollOnDrag(ref1, true))
    act(() => firePointerMove(130))
    const before1 = container1.scrollTop
    act(() => flushRAF(1))
    const delta1 = before1 - container1.scrollTop
    u1()

    // Reset RAF state
    rafCallbacks = new Map()

    // Pointer at 105px (5px from top) — faster
    const { unmount: u2 } = renderHook(() => useAutoScrollOnDrag(ref2, true))
    act(() => firePointerMove(105))
    const before2 = container2.scrollTop
    act(() => flushRAF(1))
    const delta2 = before2 - container2.scrollTop
    u2()

    expect(delta2).toBeGreaterThan(delta1)
  })

  // 4. Speed increases as pointer approaches edge (bottom)
  it('scrolls faster when pointer is closer to bottom edge', () => {
    const container1 = makeContainer({ top: 100, bottom: 600 })
    const ref1 = { current: container1 }

    const container2 = makeContainer({ top: 100, bottom: 600 })
    const ref2 = { current: container2 }

    // Pointer at 570px (30px from bottom) — slower
    const { unmount: u1 } = renderHook(() => useAutoScrollOnDrag(ref1, true))
    act(() => firePointerMove(570))
    const before1 = container1.scrollTop
    act(() => flushRAF(1))
    const delta1 = container1.scrollTop - before1
    u1()

    rafCallbacks = new Map()

    // Pointer at 595px (5px from bottom) — faster
    const { unmount: u2 } = renderHook(() => useAutoScrollOnDrag(ref2, true))
    act(() => firePointerMove(595))
    const before2 = container2.scrollTop
    act(() => flushRAF(1))
    const delta2 = container2.scrollTop - before2
    u2()

    expect(delta2).toBeGreaterThan(delta1)
  })

  // 5. No scroll when pointer is in the middle
  it('does not scroll when pointer is in the middle of the container', () => {
    const container = makeContainer({ top: 100, bottom: 600 })
    const ref = { current: container }

    renderHook(() => useAutoScrollOnDrag(ref, true))

    // Pointer at 350px — well within the safe zone
    act(() => firePointerMove(350))

    const initialScrollTop = container.scrollTop
    act(() => flushRAF(1))

    expect(container.scrollTop).toBe(initialScrollTop)
  })

  // 6. No scroll when active is false
  it('does not scroll when drag is not active', () => {
    const container = makeContainer({ top: 100, bottom: 600 })
    const ref = { current: container }

    renderHook(() => useAutoScrollOnDrag(ref, false))

    act(() => firePointerMove(110))

    const initialScrollTop = container.scrollTop
    // No RAF should have been queued
    act(() => flushRAF(1))

    expect(container.scrollTop).toBe(initialScrollTop)
  })

  // 7. Scroll stops when active changes from true to false
  it('stops scrolling when drag ends', () => {
    const container = makeContainer({ top: 100, bottom: 600 })
    const ref = { current: container }

    const { rerender } = renderHook(({ active }) => useAutoScrollOnDrag(ref, active), {
      initialProps: { active: true },
    })

    act(() => firePointerMove(110))
    act(() => flushRAF(1))

    // Scrolling should have happened
    expect(container.scrollTop).toBeLessThan(200)

    // Reset scroll and deactivate
    container.scrollTop = 200
    rerender({ active: false })

    // Drain any queued RAF — cancelAnimationFrame should have been called
    act(() => flushRAF(1))

    expect(container.scrollTop).toBe(200)
  })

  // 8. Max speed at the very edge
  it('reaches max speed when pointer is exactly at the edge', () => {
    const container = makeContainer({ top: 100, bottom: 600 })
    const ref = { current: container }

    renderHook(() => useAutoScrollOnDrag(ref, true))

    // Pointer exactly at top edge (distFromTop = 0)
    act(() => firePointerMove(100))

    const before = container.scrollTop
    act(() => flushRAF(1))

    const delta = before - container.scrollTop
    expect(delta).toBeCloseTo(MAX_SPEED, 0)
  })

  // 9. Speed formula matches expectation
  it('scroll speed matches linear interpolation formula', () => {
    const container = makeContainer({ top: 100, bottom: 600 })
    const ref = { current: container }

    renderHook(() => useAutoScrollOnDrag(ref, true))

    // Pointer at 125px → 25px from top → speed = (50-25)/50 * 15 = 7.5
    act(() => firePointerMove(125))

    const before = container.scrollTop
    act(() => flushRAF(1))

    const delta = before - container.scrollTop
    const expected = ((SCROLL_ZONE - 25) / SCROLL_ZONE) * MAX_SPEED
    expect(delta).toBeCloseTo(expected, 5)
  })

  // 10. Pointermove listener is only active during drag
  it('adds pointermove listener when active and removes when inactive', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const container = makeContainer()
    const ref = { current: container }

    const { rerender, unmount } = renderHook(({ active }) => useAutoScrollOnDrag(ref, active), {
      initialProps: { active: false },
    })

    // No listener when inactive
    expect(addSpy).not.toHaveBeenCalledWith('pointermove', expect.any(Function))

    // Activate
    rerender({ active: true })
    expect(addSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))

    // Deactivate — cleanup should fire
    rerender({ active: false })
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))

    unmount()
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  // 11. RAF callbacks are cleaned up on unmount
  it('cancels animation frame on unmount', () => {
    const container = makeContainer()
    const ref = { current: container }

    const { unmount } = renderHook(() => useAutoScrollOnDrag(ref, true))

    // Should have queued at least one RAF callback
    expect(rafCallbacks.size).toBeGreaterThan(0)

    unmount()

    // After unmount, the queued callback should have been cancelled
    expect(rafCallbacks.size).toBe(0)
  })

  // 12. Handles null container ref gracefully
  it('does not throw when containerRef.current is null', () => {
    const ref = { current: null }

    renderHook(() => useAutoScrollOnDrag(ref, true))

    act(() => firePointerMove(110))

    // Should not throw — just skip scrolling
    expect(() => act(() => flushRAF(1))).not.toThrow()
  })
})
