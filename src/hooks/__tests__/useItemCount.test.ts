/**
 * Tests for useItemCount — the polling-badge hook that powers the
 * conflicts-tab and trash-tab counters in the sidebar.
 *
 * PEND-35 Tier 2.11 — `useConflictCount` now routes through the
 * cheaper `count_conflicts` IPC (a single `SELECT COUNT(*)`) instead
 * of paginating `getConflicts({limit:100})` and reading
 * `data.items.length`. The hook itself accepts both shapes — paginated
 * page envelopes (legacy callsites still on full-row IPCs, e.g. the
 * trash badge) AND plain `number` returns (count-only IPCs) — so the
 * tier-by-tier audit migration can land without churning every
 * consumer at once.
 *
 * The "counts > 100" case is the audit-reported regression: the old
 * `getConflicts({limit:100})` shape silently capped the badge at 100
 * because the second page was never fetched. The number-shape path
 * exercised here surfaces the true count regardless of magnitude.
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

  // ── number-shape (count-only IPCs — PEND-35 Tier 2.11 path) ──

  it('returns the number when queryFn resolves to a count-only IPC', async () => {
    const queryFn = vi.fn().mockResolvedValue(7)
    const { result } = renderHook(() => useItemCount(queryFn, 30_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current).toBe(7)
    expect(queryFn).toHaveBeenCalledOnce()
  })

  it('surfaces counts > 100 — regression for the silently-capped getConflicts({limit:100}) shape', async () => {
    // PEND-35 Tier 2.11 audit symptom: under the old `.items.length`
    // shape the badge maxed out at 100 because the second page was
    // never fetched. The count-only IPC must surface the true count.
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
    // Trash badge still polls `listBlocks({ showDeleted: true, limit: 100 })`
    // — a paginated IPC. The hook must keep handling that shape until
    // the trash-side migration (Tier 4 follow-up) lands a count-only IPC.
    const queryFn = vi.fn().mockResolvedValue({
      items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      next_cursor: null,
      has_more: false,
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
