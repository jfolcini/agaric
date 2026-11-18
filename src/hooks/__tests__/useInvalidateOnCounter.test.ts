/**
 * Tests for useInvalidateOnCounter — the shared "a refresh axis moved, refetch
 * the prefix in place" effect behind both reference panels.
 *
 * The counter's first value is the mount (not a change), a later bump
 * invalidates the given prefix exactly once, and a bump while Load more fetches
 * keeps the page it asked for (#6911).
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInvalidateOnCounter } from '@/hooks/useInvalidateOnCounter'
import { queryClient } from '@/lib/query-client'

const KEY = ['someReferences', 'SPACE1', 'PAGE1'] as const

let invalidateSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  queryClient.clear()
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
})

afterEach(() => {
  invalidateSpy.mockRestore()
})

describe('useInvalidateOnCounter', () => {
  it('does not invalidate on mount, whatever the counter starts at', () => {
    renderHook(() => useInvalidateOnCounter(7, KEY))

    expect(invalidateSpy).toHaveBeenCalledTimes(0)
  })

  it('invalidates the given key once when the counter moves', async () => {
    const { rerender } = renderHook(({ counter }) => useInvalidateOnCounter(counter, KEY), {
      initialProps: { counter: 0 },
    })

    rerender({ counter: 1 })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledTimes(1)
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: KEY })

    // A re-render at the same counter is not another change.
    rerender({ counter: 1 })
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })

  it('a counter bump during fetchNextPage keeps the next page and refetches every page', async () => {
    const pending: Array<() => void> = []
    const fetched: number[] = []
    const { result, rerender } = renderHook(
      ({ counter }) => {
        useInvalidateOnCounter(counter, KEY)
        return useInfiniteQuery(
          {
            queryKey: KEY,
            queryFn: ({ pageParam }) => {
              fetched.push(pageParam)
              return pageParam === 0
                ? Promise.resolve([pageParam])
                : new Promise<number[]>((resolve) => pending.push(() => resolve([pageParam])))
            },
            initialPageParam: 0,
            getNextPageParam: (last: number[]) =>
              (last[0] ?? 0) < 1 ? (last[0] ?? 0) + 1 : undefined,
          },
          queryClient,
        )
      },
      { initialProps: { counter: 0 } },
    )
    await waitFor(() => expect(result.current.data?.pages).toEqual([[0]]))

    act(() => {
      void result.current.fetchNextPage()
    })
    await waitFor(() => expect(pending).toHaveLength(1))
    rerender({ counter: 1 })
    act(() => {
      for (const resolve of pending.splice(0)) resolve()
    })

    await waitFor(() => expect(result.current.data?.pages).toEqual([[0], [1]]))
    await waitFor(() => expect(pending).toHaveLength(1))
    act(() => {
      for (const resolve of pending.splice(0)) resolve()
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.data?.pages).toEqual([[0], [1]])
    // The page, then the refresh of both pages it now holds.
    expect(fetched).toEqual([0, 1, 0, 1])
  })
})
