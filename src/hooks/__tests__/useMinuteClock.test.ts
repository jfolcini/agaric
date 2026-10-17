/**
 * Tests for useMinuteClock: the clock it returns moves once a minute, and its
 * timer goes with the component.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMinuteClock } from '@/hooks/useMinuteClock'

const START = new Date(2026, 5, 13, 10, 0, 0).getTime()

describe('useMinuteClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('returns the time at mount and re-reads it once each minute', () => {
    const { result } = renderHook(() => useMinuteClock())
    expect(result.current).toBe(START)

    act(() => {
      vi.advanceTimersByTime(59_999)
    })
    expect(result.current).toBe(START)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(START + 60_000)

    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })
    expect(result.current).toBe(START + 5 * 60_000)
  })

  it('stops its timer on unmount', () => {
    const { unmount } = renderHook(() => useMinuteClock())
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
