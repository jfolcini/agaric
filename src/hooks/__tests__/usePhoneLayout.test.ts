/**
 * Tests for usePhoneLayout — the one rule for a phone's surfaces: a window
 * under 768 px wide, or a touch screen under 500 px tall.
 *
 * The real `useIsMobile` and `useIsTouch` run, over a stubbed `matchMedia`,
 * `innerWidth` and `maxTouchPoints`.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePhoneLayout } from '@/hooks/usePhoneLayout'

const COARSE = '(pointer: coarse)'
const SHORT_SCREEN = '(max-device-height: 499px)'

interface Device {
  width: number
  touch: boolean
  /** Media queries that match, beyond the pointer's. */
  matching?: string[]
}

/** Stubs the device; returns a way to change which queries match and tell the listeners. */
function stubDevice({ width, touch, matching = [] }: Device): (next: string[]) => void {
  let matches = new Set(touch ? [...matching, COARSE] : matching)
  const listeners = new Set<() => void>()
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', { value: touch ? 5 : 0, configurable: true })
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        get matches() {
          return matches.has(query)
        },
        addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      }) as unknown as MediaQueryList,
  )
  return (next) => {
    matches = new Set(touch ? [...next, COARSE] : next)
    for (const listener of listeners) listener()
  }
}

const originalInnerWidth = window.innerWidth

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true })
  vi.unstubAllGlobals()
})

describe('usePhoneLayout', () => {
  it('is true in a narrow mouse window', () => {
    stubDevice({ width: 500, touch: false })
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(true)
  })

  it('is false in a wide mouse window', () => {
    stubDevice({ width: 1280, touch: false })
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false)
  })

  it('is true on a phone in portrait (390 × 844, touch)', () => {
    stubDevice({ width: 390, touch: true })
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(true)
  })

  it('is true on a phone in landscape (915 × 412, touch)', () => {
    stubDevice({ width: 915, touch: true, matching: [SHORT_SCREEN] })
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(true)
  })

  it('is false on a touch tablet, upright (768 × 1024) or on its side (1024 × 768)', () => {
    stubDevice({ width: 768, touch: true })
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false)
    stubDevice({ width: 1024, touch: true })
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false)
  })

  it('is false on a short screen without touch', () => {
    stubDevice({ width: 915, touch: false, matching: [SHORT_SCREEN] })
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false)
  })

  // On Android the soft keyboard shrinks the viewport, not the screen.
  it('is false on a touch tablet whose keyboard leaves the viewport under 500 px tall', () => {
    stubDevice({ width: 1280, touch: true, matching: ['(max-height: 499px)'] })
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false)
  })

  it('follows a wide phone as it turns on its side and back', () => {
    const turn = stubDevice({ width: 915, touch: true })
    const { result } = renderHook(() => usePhoneLayout())
    expect(result.current).toBe(false)
    act(() => turn([SHORT_SCREEN]))
    expect(result.current).toBe(true)
    act(() => turn([]))
    expect(result.current).toBe(false)
  })
})
