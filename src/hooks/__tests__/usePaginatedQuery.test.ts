import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type PaginatedResponse, usePaginatedQuery } from '../usePaginatedQuery'

const mockedToastError = vi.mocked(toast.error)

function makePage<T>(
  items: T[],
  hasMore = false,
  cursor: string | null = null,
): PaginatedResponse<T> {
  return { items, next_cursor: cursor, has_more: hasMore }
}

describe('usePaginatedQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Basic loading ──────────────────────────────────────────────

  it('fetches page 1 on mount', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a', 'b']))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(['a', 'b'])
    expect(queryFn).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('sets loading=true while the request is in flight', async () => {
    let resolve!: (v: PaginatedResponse<string>) => void
    const queryFn = vi.fn(
      () =>
        new Promise<PaginatedResponse<string>>((r) => {
          resolve = r
        }),
    )
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    expect(result.current.loading).toBe(true)
    expect(result.current.items).toEqual([])

    await act(async () => resolve(makePage(['x'])))
    expect(result.current.loading).toBe(false)
    expect(result.current.items).toEqual(['x'])
  })

  it('discards an in-flight response after `enabled` flips false (FE-1)', async () => {
    let resolve!: (v: PaginatedResponse<string>) => void
    const queryFn = vi.fn(
      () =>
        new Promise<PaginatedResponse<string>>((r) => {
          resolve = r
        }),
    )
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePaginatedQuery(queryFn, { enabled }),
      { initialProps: { enabled: true } },
    )

    expect(result.current.loading).toBe(true)
    // Disable mid-flight — e.g. the user cleared the search input.
    act(() => rerender({ enabled: false }))
    expect(result.current.loading).toBe(false)

    // The superseded request resolves late; its result must NOT
    // repopulate the just-cleared list.
    await act(async () => resolve(makePage(['stale'])))
    expect(result.current.items).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('tracks hasMore from the response', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a'], true, 'c1'))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasMore).toBe(true)
  })

  // ── Pagination ─────────────────────────────────────────────────

  it('appends items on loadMore', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce(makePage(['a', 'b'], true, 'cursor-1'))
      .mockResolvedValueOnce(makePage(['c'], false))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(['a', 'b'])

    await act(async () => result.current.loadMore())
    expect(queryFn).toHaveBeenCalledWith('cursor-1', expect.any(AbortSignal))
    expect(result.current.items).toEqual(['a', 'b', 'c'])
    expect(result.current.hasMore).toBe(false)
  })

  it('loadMore is a no-op when hasMore is false', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a']))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => result.current.loadMore())
    expect(queryFn).toHaveBeenCalledTimes(1) // only the initial call
  })

  it('loadMore is a no-op while loading', async () => {
    let resolve!: (v: PaginatedResponse<string>) => void
    const queryFn = vi.fn(
      () =>
        new Promise<PaginatedResponse<string>>((r) => {
          resolve = r
        }),
    )
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    // Still loading — loadMore should be a no-op
    expect(result.current.loading).toBe(true)
    act(() => result.current.loadMore())
    expect(queryFn).toHaveBeenCalledTimes(1)

    await act(async () => resolve(makePage(['a'], true, 'c1')))
  })

  // ── Reload ─────────────────────────────────────────────────────

  it('reload replaces items with fresh page 1', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce(makePage(['a', 'b']))
      .mockResolvedValueOnce(makePage(['x', 'y']))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(['a', 'b'])

    await act(async () => result.current.reload())
    expect(result.current.items).toEqual(['x', 'y'])
  })

  // ── setItems ───────────────────────────────────────────────────

  it('setItems allows optimistic updates', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a', 'b', 'c']))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setItems((prev) => prev.filter((x) => x !== 'b')))
    expect(result.current.items).toEqual(['a', 'c'])
  })

  // ── Error handling ─────────────────────────────────────────────

  it('sets error state on failure', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('boom')
    expect(result.current.items).toEqual([])
  })

  it('toasts onError message when provided', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => usePaginatedQuery(queryFn, { onError: 'Failed to load' }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Failed to load')
    expect(mockedToastError).toHaveBeenCalledWith('Failed to load')
  })

  it('does not toast when onError is omitted', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('clears error on successful fetch', async () => {
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(makePage(['ok']))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.error).toBe('fail'))

    await act(async () => result.current.reload())
    expect(result.current.error).toBeNull()
    expect(result.current.items).toEqual(['ok'])
  })

  // ── enabled flag ───────────────────────────────────────────────

  it('skips initial fetch when enabled=false', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a']))
    renderHook(() => usePaginatedQuery(queryFn, { enabled: false }))

    // Give it a tick to see if it fires
    await act(async () => {})
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('clears hasMore when enabled transitions from true to false', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a', 'b'], true, 'c1'))
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePaginatedQuery(queryFn, { enabled }),
      { initialProps: { enabled: true } },
    )

    await waitFor(() => expect(result.current.hasMore).toBe(true))

    rerender({ enabled: false })

    await waitFor(() => expect(result.current.hasMore).toBe(false))
    expect(result.current.items).toEqual(['a', 'b'])
  })

  it('fetches when enabled transitions from false to true', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a']))
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePaginatedQuery(queryFn, { enabled }),
      { initialProps: { enabled: false } },
    )

    await act(async () => {})
    expect(queryFn).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
  })

  // ── Stale response detection ───────────────────────────────────

  it('discards stale responses when queryFn changes', async () => {
    let resolveFirst!: (v: PaginatedResponse<string>) => void
    const firstQueryFn = vi.fn(
      () =>
        new Promise<PaginatedResponse<string>>((r) => {
          resolveFirst = r
        }),
    )
    const secondQueryFn = vi.fn().mockResolvedValue(makePage(['new']))

    const { result, rerender } = renderHook(
      ({ qf }: { qf: (cursor?: string) => Promise<PaginatedResponse<string>> }) =>
        usePaginatedQuery(qf),
      { initialProps: { qf: firstQueryFn } },
    )

    // First queryFn is in flight
    expect(result.current.loading).toBe(true)

    // Switch to second queryFn before first resolves
    rerender({ qf: secondQueryFn })

    await waitFor(() => expect(result.current.items).toEqual(['new']))

    // Now resolve the stale first request — should be ignored
    await act(async () => resolveFirst(makePage(['stale'])))
    expect(result.current.items).toEqual(['new'])
  })

  // ── Re-fetch on queryFn change ─────────────────────────────────

  it('re-fetches page 1 when queryFn identity changes', async () => {
    const qf1 = vi.fn().mockResolvedValue(makePage(['a']))
    const qf2 = vi.fn().mockResolvedValue(makePage(['b']))

    const { result, rerender } = renderHook(
      ({ qf }: { qf: (cursor?: string) => Promise<PaginatedResponse<string>> }) =>
        usePaginatedQuery(qf),
      { initialProps: { qf: qf1 } },
    )

    await waitFor(() => expect(result.current.items).toEqual(['a']))
    rerender({ qf: qf2 })
    await waitFor(() => expect(result.current.items).toEqual(['b']))
  })

  // ── maxItems cap ────────────────────────────────────────────────

  it('capped is false when items are below maxItems', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce(makePage(['a', 'b'], true, 'c1'))
      .mockResolvedValueOnce(makePage(['c'], false))
    const { result } = renderHook(() => usePaginatedQuery(queryFn, { maxItems: 10 }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.capped).toBe(false)

    await act(async () => result.current.loadMore())
    expect(result.current.items).toEqual(['a', 'b', 'c'])
    expect(result.current.capped).toBe(false)
  })

  it('capped becomes true when items exceed maxItems', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce(makePage(['a', 'b', 'c'], true, 'c1'))
      .mockResolvedValueOnce(makePage(['d', 'e', 'f'], false))
    const { result } = renderHook(() => usePaginatedQuery(queryFn, { maxItems: 5 }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(['a', 'b', 'c'])
    expect(result.current.capped).toBe(false)

    await act(async () => result.current.loadMore())
    // 3 + 3 = 6 > maxItems(5), so items should NOT be appended
    expect(result.current.items).toEqual(['a', 'b', 'c'])
    expect(result.current.capped).toBe(true)
  })

  it('hitting the cap clears hasMore so Load more stops fetch-and-discarding (#756)', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce(makePage(['a', 'b', 'c'], true, 'c1'))
      // Backend still reports more pages — but we discard this one.
      .mockResolvedValueOnce(makePage(['d', 'e', 'f'], true, 'c2'))
    const { result } = renderHook(() => usePaginatedQuery(queryFn, { maxItems: 5 }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasMore).toBe(true)

    await act(async () => result.current.loadMore())
    expect(result.current.items).toEqual(['a', 'b', 'c'])
    expect(result.current.capped).toBe(true)
    // Without this, consumers gating "Load more" on hasMore alone keep
    // fetching pages that are discarded forever past the cap.
    expect(result.current.hasMore).toBe(false)

    // Further loadMore() is a no-op: the cursor was cleared too.
    await act(async () => result.current.loadMore())
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('capped resets when queryFn changes', async () => {
    const qf1 = vi
      .fn()
      .mockResolvedValueOnce(makePage(['a', 'b', 'c'], true, 'c1'))
      .mockResolvedValueOnce(makePage(['d', 'e', 'f'], false))
    const qf2 = vi.fn().mockResolvedValue(makePage(['x']))

    const { result, rerender } = renderHook(
      ({ qf }: { qf: (cursor?: string) => Promise<PaginatedResponse<string>> }) =>
        usePaginatedQuery(qf, { maxItems: 5 }),
      { initialProps: { qf: qf1 } },
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => result.current.loadMore())
    expect(result.current.capped).toBe(true)

    // Switch queryFn — should reset capped
    rerender({ qf: qf2 })
    await waitFor(() => expect(result.current.items).toEqual(['x']))
    expect(result.current.capped).toBe(false)
  })

  // ── totalCount exposure ─────────────────────────────────────────

  it('exposes totalCount from the response when supplied', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({
      items: ['a', 'b'],
      next_cursor: 'c1',
      has_more: true,
      total_count: 312,
    })
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.totalCount).toBe(312)
  })

  it('totalCount is undefined when the response omits it', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a']))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.totalCount).toBeUndefined()
  })

  it('totalCount tracks the latest response across cursor pages', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({
        items: ['a', 'b'],
        next_cursor: 'c1',
        has_more: true,
        total_count: 300,
      })
      .mockResolvedValueOnce({
        items: ['c'],
        next_cursor: null,
        has_more: false,
        total_count: 301, // backend re-counted; new value wins
      })
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.totalCount).toBe(300))
    await act(async () => result.current.loadMore())
    expect(result.current.totalCount).toBe(301)
  })

  it('totalCount resets to undefined when queryFn changes', async () => {
    const qf1 = vi.fn().mockResolvedValue({
      items: ['a'],
      next_cursor: null,
      has_more: false,
      total_count: 7,
    })
    const qf2 = vi.fn().mockResolvedValue(makePage(['b']))

    const { result, rerender } = renderHook(
      ({ qf }: { qf: (cursor?: string) => Promise<PaginatedResponse<string>> }) =>
        usePaginatedQuery(qf),
      { initialProps: { qf: qf1 } },
    )

    await waitFor(() => expect(result.current.totalCount).toBe(7))
    rerender({ qf: qf2 })
    // After deps change the count resets; once qf2 resolves it stays undefined
    // because qf2 doesn't supply a total_count.
    await waitFor(() => expect(result.current.items).toEqual(['b']))
    expect(result.current.totalCount).toBeUndefined()
  })

  // ── AbortController (PEND-58f FE-2) ─────────────────────────────

  it('passes an AbortSignal to queryFn', async () => {
    const queryFn = vi.fn().mockResolvedValue(makePage(['a']))
    const { result } = renderHook(() => usePaginatedQuery(queryFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(queryFn).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    const signal = queryFn.mock.calls[0]?.[1] as AbortSignal | undefined
    expect(signal?.aborted).toBe(false)
  })

  it('a new load aborts the previous request signal', async () => {
    // First request stays pending; capture its signal so we can assert
    // it gets aborted when the second queryFn supersedes it.
    let firstSignal: AbortSignal | undefined
    const firstQueryFn = vi.fn((_cursor?: string, signal?: AbortSignal) => {
      firstSignal = signal
      return new Promise<PaginatedResponse<string>>(() => {}) // never resolves
    })
    const secondQueryFn = vi.fn().mockResolvedValue(makePage(['new']))

    const { result, rerender } = renderHook(
      ({
        qf,
      }: {
        qf: (cursor?: string, signal?: AbortSignal) => Promise<PaginatedResponse<string>>
      }) => usePaginatedQuery(qf),
      { initialProps: { qf: firstQueryFn } },
    )

    expect(result.current.loading).toBe(true)
    expect(firstSignal?.aborted).toBe(false)

    // Switching queryFn re-fires page 1 with a fresh controller, which
    // aborts the prior controller's signal.
    rerender({ qf: secondQueryFn })
    await waitFor(() => expect(result.current.items).toEqual(['new']))
    expect(firstSignal?.aborted).toBe(true)
  })

  it('aborted (cancelled) requests do not set error or items', async () => {
    // Simulate an AbortSignal-aware queryFn that rejects with the
    // backend-compatible `cancelled`-kind AppError when its signal
    // fires (the shape `withAbort` produces, which `isCancellation`
    // discriminates).
    const queryFn = vi.fn(
      (_cursor?: string, signal?: AbortSignal) =>
        new Promise<PaginatedResponse<string>>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject({ kind: 'cancelled', message: 'aborted client-side' })
          })
        }),
    )

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePaginatedQuery(queryFn, { enabled }),
      { initialProps: { enabled: true } },
    )

    expect(result.current.loading).toBe(true)

    // Disabling aborts the in-flight controller, rejecting the promise
    // with a cancellation. It must be swallowed silently.
    await act(async () => {
      rerender({ enabled: false })
    })

    expect(result.current.error).toBeNull()
    expect(result.current.items).toEqual([])
    expect(result.current.loading).toBe(false)
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('aborts the in-flight request on unmount', async () => {
    let capturedSignal: AbortSignal | undefined
    const queryFn = vi.fn((_cursor?: string, signal?: AbortSignal) => {
      capturedSignal = signal
      return new Promise<PaginatedResponse<string>>(() => {}) // never resolves
    })
    const { result, unmount } = renderHook(() => usePaginatedQuery(queryFn))

    expect(result.current.loading).toBe(true)
    expect(capturedSignal?.aborted).toBe(false)

    unmount()
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('respects a custom maxItems value', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce(makePage(['a'], true, 'c1'))
      .mockResolvedValueOnce(makePage(['b'], true, 'c2'))
      .mockResolvedValueOnce(makePage(['c'], false))
    const { result } = renderHook(() => usePaginatedQuery(queryFn, { maxItems: 2 }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual(['a'])
    expect(result.current.capped).toBe(false)

    // 1 + 1 = 2, still within cap
    await act(async () => result.current.loadMore())
    expect(result.current.items).toEqual(['a', 'b'])
    expect(result.current.capped).toBe(false)

    // 2 + 1 = 3 > maxItems(2), should cap
    await act(async () => result.current.loadMore())
    expect(result.current.items).toEqual(['a', 'b'])
    expect(result.current.capped).toBe(true)
  })
})
