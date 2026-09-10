/**
 * Tests for useInvalidateOnGraphStructure — the shared graph-structure
 * invalidation effect behind `useBacklinkGroups` and `useUnlinkedReferences`.
 *
 * The two cases are the whole contract: the counter's first value is the mount
 * (not a change), and a later bump invalidates the given prefix exactly once.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInvalidateOnGraphStructure } from '@/hooks/useInvalidateOnGraphStructure'
import {
  _resetGraphStructureEventsForTest,
  recordGraphStructureChange,
} from '@/lib/graph-structure-events'
import { queryClient } from '@/lib/query-client'

const KEY = ['someReferences', 'SPACE1', 'PAGE1'] as const

let invalidateSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  _resetGraphStructureEventsForTest()
  queryClient.clear()
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
})

afterEach(() => {
  invalidateSpy.mockRestore()
})

describe('useInvalidateOnGraphStructure', () => {
  it('does not invalidate on mount', () => {
    renderHook(() => useInvalidateOnGraphStructure(KEY))

    expect(invalidateSpy).toHaveBeenCalledTimes(0)
  })

  it('invalidates the given key once when the graph structure changes', async () => {
    renderHook(() => useInvalidateOnGraphStructure(KEY))

    act(() => {
      recordGraphStructureChange()
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledTimes(1)
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: KEY })
  })
})
