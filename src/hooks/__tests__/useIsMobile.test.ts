/**
 * Tests for useIsMobile hook — responsive mobile breakpoint detection.
 *
 * Validates:
 * - Returns false when window.innerWidth > MOBILE_BREAKPOINT (768)
 * - Returns true when window.innerWidth < MOBILE_BREAKPOINT
 * - Responds to matchMedia change events
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIsMobile } from '../useIsMobile'

// ── Helpers ──────────────────────────────────────────────────────────────

/** Stub matchMedia so we can trigger change events. */
function createMatchMediaMock(matches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = []
  const mql = {
    matches,
    media: '',
    onchange: null,
    addEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.push(cb)
    }),
    removeEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
      const idx = listeners.indexOf(cb)
      if (idx !== -1) listeners.splice(idx, 1)
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }

  return {
    mql,
    listeners,
    mockFn: vi.fn().mockReturnValue(mql),
  }
}

describe('useIsMobile', () => {
  const originalInnerWidth = window.innerWidth
  let matchMediaMock: ReturnType<typeof createMatchMediaMock>

  beforeEach(() => {
    matchMediaMock = createMatchMediaMock(false)
    window.matchMedia = matchMediaMock.mockFn as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    })
    vi.restoreAllMocks()
  })

  it('returns false when window.innerWidth > 768', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1024,
    })

    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('returns true when window.innerWidth < 768', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 375,
    })

    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it('returns false when window.innerWidth === 768', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 768,
    })

    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('responds to matchMedia change events', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1024,
    })

    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)

    // Simulate viewport resize to mobile
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 375,
    })

    act(() => {
      for (const listener of matchMediaMock.listeners) {
        listener({ matches: true } as MediaQueryListEvent)
      }
    })

    expect(result.current).toBe(true)
  })

  it('cleans up matchMedia listener on unmount', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1024,
    })

    const { unmount } = renderHook(() => useIsMobile())

    expect(matchMediaMock.mql.addEventListener).toHaveBeenCalledTimes(1)
    unmount()
    expect(matchMediaMock.mql.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
