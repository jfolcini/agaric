/**
 * Tests for useTrashFilter.
 *
 * Validates filter state, the debounced echo, the Unicode-aware
 * filteredBlocks memo, and the clearFilter helper extracted from
 * TrashView.tsx (MAINT-128).
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import type { BlockRow } from '../../lib/tauri'
import { useTrashFilter } from '../useTrashFilter'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useTrashFilter', () => {
  it('returns the full list when the debounced filter is empty', () => {
    const blocks: BlockRow[] = [
      makeBlock({ id: 'A', content: 'apple pie' }),
      makeBlock({ id: 'B', content: 'banana split' }),
    ]
    const { result } = renderHook(() => useTrashFilter({ blocks }))

    expect(result.current.filterText).toBe('')
    expect(result.current.debouncedFilter).toBe('')
    expect(result.current.filteredBlocks).toHaveLength(2)
  })

  it('setFilterText updates the raw input immediately and the debounced value after 300ms', () => {
    const blocks: BlockRow[] = [
      makeBlock({ id: 'A', content: 'apple pie' }),
      makeBlock({ id: 'B', content: 'banana split' }),
    ]
    const { result } = renderHook(() => useTrashFilter({ blocks }))

    act(() => result.current.setFilterText('apple'))
    // Raw text reflects immediately; debounced value is still empty.
    expect(result.current.filterText).toBe('apple')
    expect(result.current.debouncedFilter).toBe('')

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(result.current.debouncedFilter).toBe('apple')
    expect(result.current.filteredBlocks).toHaveLength(1)
    expect(result.current.filteredBlocks[0]?.id).toBe('A')
  })

  it('filteredBlocks uses the Unicode-aware fold matcher', () => {
    const blocks: BlockRow[] = [
      makeBlock({ id: 'A', content: 'İstanbul trip notes' }),
      makeBlock({ id: 'B', content: 'Ankara notes' }),
    ]
    const { result } = renderHook(() => useTrashFilter({ blocks }))

    act(() => result.current.setFilterText('istanbul'))
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(result.current.filteredBlocks).toHaveLength(1)
    expect(result.current.filteredBlocks[0]?.id).toBe('A')
  })

  it('clearFilter resets both the raw input and the debounced value', () => {
    const blocks: BlockRow[] = [
      makeBlock({ id: 'A', content: 'apple pie' }),
      makeBlock({ id: 'B', content: 'banana split' }),
    ]
    const { result } = renderHook(() => useTrashFilter({ blocks }))

    act(() => result.current.setFilterText('apple'))
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.debouncedFilter).toBe('apple')

    act(() => result.current.clearFilter())
    expect(result.current.filterText).toBe('')
    expect(result.current.debouncedFilter).toBe('')
    expect(result.current.filteredBlocks).toHaveLength(2)
  })

  it('clearFilter cancels a pending debounced update', () => {
    const blocks: BlockRow[] = [makeBlock({ id: 'A', content: 'apple' })]
    const { result } = renderHook(() => useTrashFilter({ blocks }))

    act(() => result.current.setFilterText('xyz'))
    expect(result.current.filterText).toBe('xyz')

    // Cancel before the 300ms window elapses.
    act(() => result.current.clearFilter())
    act(() => {
      vi.advanceTimersByTime(300)
    })

    // The pending update would have set debouncedFilter to 'xyz' had it fired.
    expect(result.current.debouncedFilter).toBe('')
    expect(result.current.filteredBlocks).toHaveLength(1)
  })

  it('treats a null content field as empty and excludes it from matches', () => {
    const blocks: BlockRow[] = [
      makeBlock({ id: 'A', content: null }),
      makeBlock({ id: 'B', content: 'apple pie' }),
    ]
    const { result } = renderHook(() => useTrashFilter({ blocks }))

    act(() => result.current.setFilterText('apple'))
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(result.current.filteredBlocks.map((b) => b.id)).toEqual(['B'])
  })
})
