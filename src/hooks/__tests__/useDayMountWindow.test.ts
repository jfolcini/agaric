/**
 * Tests for useDayMountWindow (#2670 — StreamView day-level mount bound).
 *
 * Validates:
 * - Below the window: every visited day stays mounted.
 * - Above the window: oldest-visited day(s) evict as new days are visited,
 *   bounding the mounted set at `windowSize`.
 * - Re-visiting an already-mounted day is a no-op (bails without churn).
 * - A day evicted then re-visited remounts (re-entry after eviction).
 * - `canEvict` protects a candidate (e.g. focused day) from eviction; the
 *   next-oldest candidate is evicted instead, and the window may briefly
 *   exceed its cap if every over-the-cap candidate is protected.
 * - Custom `windowSize` is honoured; default matches `STREAM_MOUNT_WINDOW`.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { STREAM_MOUNT_WINDOW, useDayMountWindow } from '../useDayMountWindow'

function days(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`)
}

describe('useDayMountWindow', () => {
  it('keeps every day mounted while below the window', () => {
    const { result, rerender } = renderHook(() => useDayMountWindow({ windowSize: 5 }))

    for (const d of days(4)) {
      result.current.markVisible(d)
      rerender()
    }

    for (const d of days(4)) {
      expect(result.current.isMounted(d)).toBe(true)
    }
  })

  it('evicts the oldest-visited day once the window overflows', () => {
    const { result, rerender } = renderHook(() => useDayMountWindow({ windowSize: 3 }))

    const [d1, d2, d3, d4] = days(4) as [string, string, string, string]
    result.current.markVisible(d1)
    rerender()
    result.current.markVisible(d2)
    rerender()
    result.current.markVisible(d3)
    rerender()
    // Window full at {d1, d2, d3}.
    expect(result.current.isMounted(d1)).toBe(true)

    result.current.markVisible(d4)
    rerender()

    // Oldest (d1) evicted; the rest stay mounted.
    expect(result.current.isMounted(d1)).toBe(false)
    expect(result.current.isMounted(d2)).toBe(true)
    expect(result.current.isMounted(d3)).toBe(true)
    expect(result.current.isMounted(d4)).toBe(true)
  })

  it('bounds the mounted set at windowSize after visiting many more days than the window', () => {
    const windowSize = 10
    const { result, rerender } = renderHook(() => useDayMountWindow({ windowSize }))

    const allDays = days(37)
    for (const d of allDays) {
      result.current.markVisible(d)
      rerender()
    }

    const mountedCount = allDays.filter((d) => result.current.isMounted(d)).length
    expect(mountedCount).toBe(windowSize)
    // The most-recently-visited `windowSize` days are exactly the mounted ones.
    const expectedMounted = new Set(allDays.slice(-windowSize))
    for (const d of allDays) {
      expect(result.current.isMounted(d)).toBe(expectedMounted.has(d))
    }
  })

  it('re-visiting an already-mounted day does not evict anyone', () => {
    const { result, rerender } = renderHook(() => useDayMountWindow({ windowSize: 2 }))
    const [d1, d2] = days(2) as [string, string]

    result.current.markVisible(d1)
    rerender()
    result.current.markVisible(d2)
    rerender()
    // Re-visit d1 (already mounted, window not overflowed).
    result.current.markVisible(d1)
    rerender()

    expect(result.current.isMounted(d1)).toBe(true)
    expect(result.current.isMounted(d2)).toBe(true)
  })

  it('re-mounts a day after eviction when it is visited again', () => {
    const { result, rerender } = renderHook(() => useDayMountWindow({ windowSize: 2 }))
    const [d1, d2, d3] = days(3) as [string, string, string]

    result.current.markVisible(d1)
    rerender()
    result.current.markVisible(d2)
    rerender()
    result.current.markVisible(d3)
    rerender()
    expect(result.current.isMounted(d1)).toBe(false) // evicted

    // Scroll back up to d1.
    result.current.markVisible(d1)
    rerender()

    expect(result.current.isMounted(d1)).toBe(true)
    // d2 (now oldest) is the one evicted to make room.
    expect(result.current.isMounted(d2)).toBe(false)
    expect(result.current.isMounted(d3)).toBe(true)
  })

  it('canEvict protects a candidate (e.g. focused day) from eviction', () => {
    const [d1, d2, d3, d4] = days(4) as [string, string, string, string]
    const canEvict = vi.fn((key: string) => key !== d1) // d1 is "focused" — never evict
    const { result, rerender } = renderHook(() => useDayMountWindow({ windowSize: 3, canEvict }))

    result.current.markVisible(d1)
    rerender()
    result.current.markVisible(d2)
    rerender()
    result.current.markVisible(d3)
    rerender()
    result.current.markVisible(d4)
    rerender()

    // d1 protected — d2 (next-oldest) evicted instead.
    expect(result.current.isMounted(d1)).toBe(true)
    expect(result.current.isMounted(d2)).toBe(false)
    expect(result.current.isMounted(d3)).toBe(true)
    expect(result.current.isMounted(d4)).toBe(true)
  })

  it('temporarily exceeds the window when every over-cap candidate is protected', () => {
    const [d1, d2, d3] = days(3) as [string, string, string]
    const canEvict = () => false // nothing is ever evictable
    const { result, rerender } = renderHook(() => useDayMountWindow({ windowSize: 2, canEvict }))

    result.current.markVisible(d1)
    rerender()
    result.current.markVisible(d2)
    rerender()
    result.current.markVisible(d3)
    rerender()

    // Window exceeds its cap of 2 rather than evict a protected day.
    expect(result.current.isMounted(d1)).toBe(true)
    expect(result.current.isMounted(d2)).toBe(true)
    expect(result.current.isMounted(d3)).toBe(true)
  })

  it('defaults windowSize to STREAM_MOUNT_WINDOW when not provided', () => {
    const { result, rerender } = renderHook(() => useDayMountWindow())

    const allDays = days(STREAM_MOUNT_WINDOW + 5)
    for (const d of allDays) {
      result.current.markVisible(d)
      rerender()
    }

    const mountedCount = allDays.filter((d) => result.current.isMounted(d)).length
    expect(mountedCount).toBe(STREAM_MOUNT_WINDOW)
  })
})
