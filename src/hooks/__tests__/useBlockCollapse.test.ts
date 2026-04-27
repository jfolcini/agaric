/**
 * Tests for useBlockCollapse hook.
 *
 * Validates:
 * - Initial state with empty collapsedIds
 * - localStorage persistence of collapsed IDs
 * - toggleCollapse adds/removes block IDs
 * - onBeforeCollapse is called when collapsing (not expanding)
 * - visibleBlocks filters out descendants of collapsed blocks
 * - hasChildrenSet correctly identifies parent blocks
 * - Multiple levels of nesting collapse correctly
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import type { FlatBlock } from '../../lib/tree-utils'
import { useBlockCollapse } from '../useBlockCollapse'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('useBlockCollapse', () => {
  const flatBlocks: FlatBlock[] = [
    makeBlock({ id: 'A', depth: 0, content: 'Block A' }),
    makeBlock({ id: 'B', depth: 1, parent_id: 'A', content: 'Block B' }),
    makeBlock({ id: 'C', depth: 2, parent_id: 'B', content: 'Block C' }),
    makeBlock({ id: 'D', depth: 1, parent_id: 'A', content: 'Block D' }),
    makeBlock({ id: 'E', depth: 0, content: 'Block E' }),
  ]

  it('starts with empty collapsedIds', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))
    expect(result.current.collapsedIds.size).toBe(0)
  })

  it('returns all blocks as visibleBlocks when nothing is collapsed', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))
    expect(result.current.visibleBlocks).toEqual(flatBlocks)
  })

  it('correctly identifies hasChildrenSet', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))
    // A has child B (depth 0 -> 1), B has child C (depth 1 -> 2)
    expect(result.current.hasChildrenSet.has('A')).toBe(true)
    expect(result.current.hasChildrenSet.has('B')).toBe(true)
    // D and E have no children
    expect(result.current.hasChildrenSet.has('D')).toBe(false)
    expect(result.current.hasChildrenSet.has('E')).toBe(false)
    // C has no children
    expect(result.current.hasChildrenSet.has('C')).toBe(false)
  })

  it('toggleCollapse adds a block ID to collapsedIds', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })

    expect(result.current.collapsedIds.has('A')).toBe(true)
  })

  it('toggleCollapse removes a block ID from collapsedIds when toggled again', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(result.current.collapsedIds.has('A')).toBe(true)

    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(result.current.collapsedIds.has('A')).toBe(false)
  })

  it('filters descendants of collapsed blocks from visibleBlocks', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })

    const visibleIds = result.current.visibleBlocks.map((b) => b.id)
    // A is visible (it's collapsed, not hidden), B, C, D are descendants hidden
    expect(visibleIds).toEqual(['A', 'E'])
  })

  it('collapsing a nested parent hides only its descendants', () => {
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('B')
    })

    const visibleIds = result.current.visibleBlocks.map((b) => b.id)
    // B is collapsed, so C is hidden, but A, D, E remain
    expect(visibleIds).toEqual(['A', 'B', 'D', 'E'])
  })

  it('calls onBeforeCollapse when collapsing (not expanding)', () => {
    const onBeforeCollapse = vi.fn()
    const { result } = renderHook(() => useBlockCollapse(flatBlocks, { onBeforeCollapse }))

    // First toggle: collapse
    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(onBeforeCollapse).toHaveBeenCalledWith('A')
    expect(onBeforeCollapse).toHaveBeenCalledTimes(1)

    // Second toggle: expand — should NOT call onBeforeCollapse
    act(() => {
      result.current.toggleCollapse('A')
    })
    expect(onBeforeCollapse).toHaveBeenCalledTimes(1)
  })

  it('persists collapsed IDs to localStorage', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })

    expect(setItemSpy).toHaveBeenCalledWith('collapsed_ids', expect.any(String))
    const stored = JSON.parse(setItemSpy.mock.calls[0]?.[1] as string) as string[]
    expect(stored).toContain('A')
  })

  it('restores collapsed IDs from localStorage on init', () => {
    localStorage.setItem('collapsed_ids', JSON.stringify(['B']))

    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    expect(result.current.collapsedIds.has('B')).toBe(true)
    const visibleIds = result.current.visibleBlocks.map((b) => b.id)
    // B is collapsed, C is hidden
    expect(visibleIds).toEqual(['A', 'B', 'D', 'E'])
  })

  it('handles empty block list gracefully', () => {
    const { result } = renderHook(() => useBlockCollapse([]))
    expect(result.current.visibleBlocks).toEqual([])
    expect(result.current.hasChildrenSet.size).toBe(0)
  })

  it('handles blocks with no parent-child relationships', () => {
    const flatList = [
      makeBlock({ id: 'X', depth: 0, content: 'Block X' }),
      makeBlock({ id: 'Y', depth: 0, content: 'Block Y' }),
      makeBlock({ id: 'Z', depth: 0, content: 'Block Z' }),
    ]
    const { result } = renderHook(() => useBlockCollapse(flatList))
    expect(result.current.hasChildrenSet.size).toBe(0)
    expect(result.current.visibleBlocks).toEqual(flatList)
  })
})
