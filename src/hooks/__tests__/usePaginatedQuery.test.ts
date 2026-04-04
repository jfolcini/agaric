import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PaginatedResponse, usePaginatedQuery } from '../usePaginatedQuery'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

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
    expect(queryFn).toHaveBeenCalledWith(undefined)
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
    expect(queryFn).toHaveBeenCalledWith('cursor-1')
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
})
