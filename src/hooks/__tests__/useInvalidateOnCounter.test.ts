/**
 * Tests for useInvalidateOnCounter — the shared "a refresh axis moved, refetch
 * the prefix in place" effect behind both reference panels.
 *
 * The two cases are the whole contract: the counter's first value is the mount
 * (not a change), and a later bump invalidates the given prefix exactly once.
 */

import { renderHook, waitFor } from '@testing-library/react'
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
})
