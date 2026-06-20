/**
 * Tests for useItemCount — the polling-badge hook that powers
 * sidebar counters (e.g. the trash-tab badge).
 *
 * The hook accepts both shapes — paginated page envelopes AND plain
 * `number` returns (count-only IPCs).
 *
 * The "counts > 100" case is a regression guard: paginated-page
 * counters silently cap at the page limit because the second page is
 * never fetched. The number-shape path surfaces the true count
 * regardless of magnitude.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useItemCount } from '../useItemCount'

describe('useItemCount', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── number-shape (count-only IPCs — path) ──

  it('returns the number when queryFn resolves to a count-only IPC', async () => {
    const queryFn = vi.fn().mockResolvedValue(7)
    const { result } = renderHook(() => useItemCount(queryFn, 30_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current).toBe(7)
    expect(queryFn).toHaveBeenCalledOnce()
  })

  it('surfaces counts > 100 — regression guard for the silently-capped page-shape', async () => {
    // Under a `.items.length` shape the badge maxes out at the page
    // limit because the second page is never fetched. The count-only
    // IPC must surface the true count.
    const queryFn = vi.fn().mockResolvedValue(427)
    const { result } = renderHook(() => useItemCount(queryFn, 30_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current).toBe(427)
  })

  it('returns 0 before the first resolution (loading state)', async () => {
    let resolve!: (n: number) => void
    const queryFn = vi.fn(
      () =>
        new Promise<number>((r) => {
          resolve = r
        }),
    )
    const { result } = renderHook(() => useItemCount(queryFn, 30_000))

    // Pre-resolution: data is null → 0.
    expect(result.current).toBe(0)

    await act(async () => resolve(12))
    expect(result.current).toBe(12)
  })

  // ── page-envelope (paginated IPCs — legacy trash-badge path) ──

  it('returns items.length when queryFn resolves to a page envelope', async () => {
    // The hook supports paginated IPCs that return a page envelope as well
    // as count-only IPCs that return a plain number.
    const queryFn = vi.fn().mockResolvedValue({
      items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    const { result } = renderHook(() => useItemCount(queryFn, 30_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current).toBe(3)
  })

  it('returns 0 for an empty page envelope', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    const { result } = renderHook(() => useItemCount(queryFn, 30_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current).toBe(0)
  })

  // ── 30 s polling cadence ───────────────────────────────────────

  it('re-polls at the configured interval', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
    const { result } = renderHook(() => useItemCount(queryFn, 30_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current).toBe(1)
    expect(queryFn).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(result.current).toBe(2)
    expect(queryFn).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(result.current).toBe(3)
    expect(queryFn).toHaveBeenCalledTimes(3)
  })

  it('returns 0 when queryFn rejects', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('IPC down'))
    const { result } = renderHook(() => useItemCount(queryFn, 30_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current).toBe(0)
  })
})
