/**
 * usePrefersReducedMotion tests.
 *
 * Mirrors the regression intent of `useBlockSwipeActions.test.ts` (#755):
 * matchMedia is read once on mount via a subscription, NOT re-evaluated in a
 * render body on every render (the anti-pattern #1070 removed from DaySection).
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePrefersReducedMotion } from '../usePrefersReducedMotion'

/**
 * Stateful matchMedia mock that supports `change` listeners, so the test can
 * flip the reduced-motion preference after mount and assert cleanup.
 */
function mockReducedMotion(initial: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  let matches = initial
  const mql = {
    get matches() {
      return matches
    },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((type: string, cb: (e: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(cb)
    }),
    removeEventListener: vi.fn((type: string, cb: (e: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(cb)
    }),
    dispatchEvent: vi.fn(),
  }
  window.matchMedia = vi.fn().mockReturnValue(mql)
  return {
    mql,
    set(next: boolean) {
      matches = next
      for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent)
    },
  }
}

describe('usePrefersReducedMotion', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('returns the initial matchMedia value', () => {
    mockReducedMotion(true)
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(true)
    unmount()
  })

  it('returns false when reduced motion is not requested', () => {
    mockReducedMotion(false)
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)
    unmount()
  })

  it('returns false when matchMedia is unavailable (SSR/jsdom-guarded)', () => {
    // @ts-expect-error — simulate an environment without matchMedia.
    window.matchMedia = undefined
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)
    unmount()
  })

  it('updates when the preference changes after mount', () => {
    const media = mockReducedMotion(false)
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)

    act(() => {
      media.set(true)
    })
    expect(result.current).toBe(true)

    act(() => {
      media.set(false)
    })
    expect(result.current).toBe(false)

    unmount()
  })

  it('does not re-evaluate matchMedia on every render (#1070)', () => {
    mockReducedMotion(false)
    const { rerender, unmount } = renderHook(() => usePrefersReducedMotion())

    const callsAfterMount = vi.mocked(window.matchMedia).mock.calls.length

    rerender()
    rerender()
    rerender()

    // The hook subscribes once on mount; re-renders must not hit matchMedia
    // again (the old DaySection code evaluated it in the render body, 7× per
    // WeeklyView render).
    expect(vi.mocked(window.matchMedia).mock.calls.length).toBe(callsAfterMount)

    unmount()
  })

  it('removes the change listener on unmount', () => {
    const media = mockReducedMotion(false)
    const { unmount } = renderHook(() => usePrefersReducedMotion())

    expect(media.mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))

    unmount()

    expect(media.mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })
})
