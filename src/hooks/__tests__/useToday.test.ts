/**
 * Tests for useToday (#739).
 *
 * The agenda/journal surfaces previously froze "today" in a `[]`-keyed
 * `useMemo(() => getTodayString(), [])`, so a tab left open across local
 * midnight kept yesterday's date and overdue/highlight logic went stale.
 *
 * Covers:
 *  - returns today's YYYY-MM-DD on mount
 *  - rolls over to the new date when local midnight passes (fake timers)
 *  - keeps rolling across multiple consecutive midnights (timer re-arms)
 *  - corrects on `visibilitychange` when a backgrounded tab wakes after
 *    midnight (the throttled background timer may not have fired)
 *  - does NOT change when visibilitychange fires before midnight / while hidden
 *  - overdue/highlight logic (dateStr < today) flips across the rollover
 *  - cleans up the timer + listener on unmount
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useToday } from '../useToday'

describe('useToday', () => {
  let visibility: DocumentVisibilityState = 'visible'

  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('returns today as a YYYY-MM-DD string on mount', () => {
    // 2026-06-13 10:00 local
    vi.setSystemTime(new Date(2026, 5, 13, 10, 0, 0))
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-06-13')
  })

  it('rolls over to the new date when local midnight passes', () => {
    // 23:59:50 local — 10 s before midnight
    vi.setSystemTime(new Date(2026, 5, 13, 23, 59, 50))
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-06-13')

    // Advance just past local midnight; the scheduled timeout fires.
    act(() => {
      vi.advanceTimersByTime(11_000)
    })
    expect(result.current).toBe('2026-06-14')
  })

  it('keeps rolling across multiple consecutive midnights', () => {
    vi.setSystemTime(new Date(2026, 5, 13, 23, 59, 50))
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-06-13')

    act(() => {
      vi.advanceTimersByTime(11_000)
    })
    expect(result.current).toBe('2026-06-14')

    // A full day later the re-armed timeout fires again.
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    })
    expect(result.current).toBe('2026-06-15')
  })

  it('corrects on visibilitychange when waking after midnight (throttled timer)', () => {
    vi.setSystemTime(new Date(2026, 5, 13, 23, 0, 0))
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-06-13')

    // Simulate a backgrounded tab: jump the wall clock past midnight WITHOUT
    // letting the throttled background timeout fire, then wake the tab.
    act(() => {
      vi.setSystemTime(new Date(2026, 5, 14, 8, 30, 0))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe('2026-06-14')
  })

  it('does not change on visibilitychange while still hidden', () => {
    vi.setSystemTime(new Date(2026, 5, 13, 10, 0, 0))
    const { result } = renderHook(() => useToday())

    act(() => {
      visibility = 'hidden'
      vi.setSystemTime(new Date(2026, 5, 14, 1, 0, 0))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // We only sync when becoming visible, not when going hidden.
    expect(result.current).toBe('2026-06-13')
  })

  it('does not change on visibilitychange before midnight', () => {
    vi.setSystemTime(new Date(2026, 5, 13, 10, 0, 0))
    const { result } = renderHook(() => useToday())

    act(() => {
      vi.setSystemTime(new Date(2026, 5, 13, 14, 0, 0))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe('2026-06-13')
  })

  it('flips overdue/highlight logic across the rollover', () => {
    // A block due on 2026-06-14 is NOT overdue on the 13th, but becomes
    // overdue once midnight rolls into the 14th... and "today" once we model
    // it as a same-day comparison.
    const dueStr = '2026-06-14'
    vi.setSystemTime(new Date(2026, 5, 13, 23, 59, 50))
    const { result } = renderHook(() => useToday())

    // Before midnight: due date is in the future (not overdue, not today).
    expect(dueStr > result.current).toBe(true)
    expect(dueStr === result.current).toBe(false)

    act(() => {
      vi.advanceTimersByTime(11_000)
    })

    // After midnight: due date is now "today" — highlight should activate.
    expect(dueStr === result.current).toBe(true)
    expect(dueStr > result.current).toBe(false)
  })

  it('clears the timer and listener on unmount', () => {
    vi.setSystemTime(new Date(2026, 5, 13, 23, 59, 50))
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount, result } = renderHook(() => useToday())

    unmount()

    expect(clearSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    // After unmount, crossing midnight must NOT update (no setState on a
    // dead component, no stale value resurfacing).
    act(() => {
      vi.advanceTimersByTime(60_000)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe('2026-06-13')
  })
})
