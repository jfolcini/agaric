/**
 * Tests for usePopoverEntity (PEND-30 D-3).
 *
 * Validates:
 *  - Initial state (closed, empty query, no suggestions, not loading).
 *  - Opening triggers the searchFn and stores results.
 *  - Changing the query re-fires the searchFn.
 *  - Closed popover never fires the searchFn.
 *  - Errors are caught and `suggestions` is reset to `[]`.
 *  - `reset()` closes the popover and clears the query.
 *  - `extraDeps` participate in the effect dep array.
 *  - In-flight cancellation prevents stale results from clobbering the
 *    latest value when the input changes mid-fetch.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { logger } from '../../../lib/logger'
import { usePopoverEntity } from '../usePopoverEntity'

interface Item {
  id: string
  name: string
}

describe('usePopoverEntity', () => {
  it('starts in the closed/empty state', () => {
    const searchFn = vi.fn().mockResolvedValue([])
    const { result } = renderHook(() => usePopoverEntity<Item>({ searchFn, logLabel: 'page' }))
    expect(result.current.open).toBe(false)
    expect(result.current.query).toBe('')
    expect(result.current.suggestions).toEqual([])
    expect(result.current.loading).toBe(false)
    expect(searchFn).not.toHaveBeenCalled()
  })

  it('does not call searchFn while closed even on query change', async () => {
    const searchFn = vi.fn().mockResolvedValue([])
    const { result } = renderHook(() => usePopoverEntity<Item>({ searchFn, logLabel: 'page' }))
    act(() => {
      result.current.setQuery('hello')
    })
    // Give effects a chance to flush.
    await Promise.resolve()
    expect(searchFn).not.toHaveBeenCalled()
  })

  it('fires searchFn on open and stores the result', async () => {
    const items: Item[] = [{ id: '1', name: 'Apollo' }]
    const searchFn = vi.fn().mockResolvedValue(items)
    const { result } = renderHook(() => usePopoverEntity<Item>({ searchFn, logLabel: 'page' }))

    act(() => {
      result.current.setOpen(true)
    })

    await waitFor(() => {
      expect(result.current.suggestions).toEqual(items)
    })
    expect(searchFn).toHaveBeenCalledWith('')
    expect(result.current.loading).toBe(false)
  })

  it('re-fires searchFn when query changes while open', async () => {
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce([{ id: '1', name: 'first' }])
      .mockResolvedValueOnce([{ id: '2', name: 'second' }])
    const { result } = renderHook(() => usePopoverEntity<Item>({ searchFn, logLabel: 'tag' }))

    act(() => {
      result.current.setOpen(true)
    })
    await waitFor(() => {
      expect(result.current.suggestions).toEqual([{ id: '1', name: 'first' }])
    })

    act(() => {
      result.current.setQuery('foo')
    })
    await waitFor(() => {
      expect(result.current.suggestions).toEqual([{ id: '2', name: 'second' }])
    })
    expect(searchFn).toHaveBeenCalledTimes(2)
    expect(searchFn).toHaveBeenNthCalledWith(2, 'foo')
  })

  it('sets loading=true during the fetch and clears it on settle', async () => {
    let resolveFn: ((items: Item[]) => void) | null = null
    const searchFn = vi.fn().mockImplementation(
      () =>
        new Promise<Item[]>((resolve) => {
          resolveFn = resolve
        }),
    )
    const { result } = renderHook(() => usePopoverEntity<Item>({ searchFn, logLabel: 'page' }))

    act(() => {
      result.current.setOpen(true)
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(true)
    })

    act(() => {
      resolveFn?.([{ id: '1', name: 'apollo' }])
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.suggestions).toEqual([{ id: '1', name: 'apollo' }])
  })

  it('logs and resets suggestions on searchFn rejection', async () => {
    const err = new Error('IPC down')
    const searchFn = vi.fn().mockRejectedValue(err)
    const { result } = renderHook(() => usePopoverEntity<Item>({ searchFn, logLabel: 'page' }))

    act(() => {
      result.current.setOpen(true)
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.suggestions).toEqual([])
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'SearchPanel',
      'page resolution failed',
      undefined,
      err,
    )
  })

  it('reset() closes the popover and clears the query', async () => {
    const searchFn = vi.fn().mockResolvedValue([])
    const { result } = renderHook(() => usePopoverEntity<Item>({ searchFn, logLabel: 'tag' }))

    act(() => {
      result.current.setOpen(true)
      result.current.setQuery('hello')
    })

    act(() => {
      result.current.reset()
    })

    expect(result.current.open).toBe(false)
    expect(result.current.query).toBe('')
  })

  it('re-fires searchFn when extraDeps change while open', async () => {
    const searchFn = vi.fn().mockResolvedValue([])

    function setup(extra: string) {
      return renderHook(
        ({ space }: { space: string }) =>
          usePopoverEntity<Item>({
            searchFn,
            logLabel: 'page',
            extraDeps: [space],
          }),
        { initialProps: { space: extra } },
      )
    }

    const { result, rerender } = setup('SPACE_A')
    act(() => {
      result.current.setOpen(true)
    })
    await waitFor(() => {
      expect(searchFn).toHaveBeenCalledTimes(1)
    })

    rerender({ space: 'SPACE_B' })
    await waitFor(() => {
      expect(searchFn).toHaveBeenCalledTimes(2)
    })
  })

  it('cancellation: a stale resolve does not overwrite the newer result', async () => {
    let firstResolve: ((items: Item[]) => void) | null = null
    let callIdx = 0
    const searchFn = vi.fn().mockImplementation((q: string) => {
      callIdx += 1
      if (callIdx === 1) {
        return new Promise<Item[]>((resolve) => {
          firstResolve = resolve
        })
      }
      return Promise.resolve([{ id: q, name: q }])
    })

    const { result } = renderHook(() => usePopoverEntity<Item>({ searchFn, logLabel: 'page' }))

    act(() => {
      result.current.setOpen(true)
    })
    await waitFor(() => {
      expect(searchFn).toHaveBeenCalledTimes(1)
    })

    // Change the query — this triggers the second fetch which resolves
    // immediately; the first fetch is now stale.
    act(() => {
      result.current.setQuery('newer')
    })
    await waitFor(() => {
      expect(result.current.suggestions).toEqual([{ id: 'newer', name: 'newer' }])
    })

    // Resolve the stale first fetch with a different value.
    act(() => {
      firstResolve?.([{ id: 'STALE', name: 'STALE' }])
    })

    // Wait a tick for the stale handler to potentially run.
    await Promise.resolve()
    await Promise.resolve()

    // The newer value still wins — cancellation flag prevented the
    // stale `setSuggestions`.
    expect(result.current.suggestions).toEqual([{ id: 'newer', name: 'newer' }])
  })
})
