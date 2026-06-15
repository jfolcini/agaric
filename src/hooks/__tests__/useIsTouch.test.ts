import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useIsTouch } from '@/hooks/useIsTouch'

/**
 * #1232 — `useIsTouch` must require BOTH a coarse pointer AND real touch
 * hardware. WebKitGTK (the Linux Tauri webview) mis-reports `(pointer: coarse)`
 * for a plain mouse; without the `navigator.maxTouchPoints` guard the whole app
 * would flip into touch mode (gutter controls painted on every block).
 */
function mockEnv(coarse: boolean, maxTouchPoints: number) {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    writable: true,
    configurable: true,
    value: maxTouchPoints,
  })
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: coarse && query.includes('coarse'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    writable: true,
    configurable: true,
    value: 0,
  })
})

describe('useIsTouch', () => {
  it('coarse pointer + real touch hardware → touch', () => {
    mockEnv(true, 5)
    expect(renderHook(() => useIsTouch()).result.current).toBe(true)
  })

  it('coarse pointer but NO touch hardware (WebKitGTK mouse) → NOT touch', () => {
    mockEnv(true, 0)
    expect(renderHook(() => useIsTouch()).result.current).toBe(false)
  })

  it('fine pointer → NOT touch (even if hardware reports touch points)', () => {
    mockEnv(false, 5)
    expect(renderHook(() => useIsTouch()).result.current).toBe(false)
  })
})
