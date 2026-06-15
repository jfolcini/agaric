/**
 * Tests for useIsTouch hook — coarse-pointer (touch) input detection.
 *
 * #1236: the hook requires BOTH a coarse pointer (`matchMedia('(pointer:
 * coarse)')`) AND real touch hardware (`navigator.maxTouchPoints > 0`). This
 * guards against the Linux WebKitGTK webview, which mis-reports a plain mouse
 * as a coarse pointer — a desktop webview reports `maxTouchPoints === 0`, so
 * the false-coarse short-circuits to a fine pointer.
 *
 * Validates:
 * - coarse + maxTouchPoints > 0 → true (real touch device)
 * - coarse + maxTouchPoints === 0 → false (the WebKitGTK false-coarse case)
 * - fine (coarse=false) + maxTouchPoints > 0 → false
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useIsTouch } from '../useIsTouch'

function mockMatchMedia(coarse: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function setMaxTouchPoints(value: number) {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value,
    writable: true,
    configurable: true,
  })
}

describe('useIsTouch', () => {
  afterEach(() => {
    // Reset to desktop default so the simulated touch hardware doesn't leak.
    setMaxTouchPoints(0)
    vi.restoreAllMocks()
  })

  it('returns true for a coarse pointer with real touch hardware', () => {
    mockMatchMedia(true)
    setMaxTouchPoints(5)
    const { result } = renderHook(() => useIsTouch())
    expect(result.current).toBe(true)
  })

  it('returns false for a coarse pointer with no touch hardware (WebKitGTK false-coarse)', () => {
    mockMatchMedia(true)
    setMaxTouchPoints(0)
    const { result } = renderHook(() => useIsTouch())
    expect(result.current).toBe(false)
  })

  it('returns false for a fine pointer even with touch hardware reported', () => {
    mockMatchMedia(false)
    setMaxTouchPoints(5)
    const { result } = renderHook(() => useIsTouch())
    expect(result.current).toBe(false)
  })
})
