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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlatBlock } from '../../lib/tree-utils'
import { useBlockCollapse } from '../useBlockCollapse'

function makeBlock(id: string, depth: number, parentId: string | null = null): FlatBlock {
  return {
    id,
    block_type: 'content',
    content: `Block ${id}`,
    parent_id: parentId,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    depth,
  }
}

// Mock localStorage
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key]
  }),
  clear: vi.fn(() => {
    for (const key of Object.keys(store)) delete store[key]
  }),
  get length() {
    return Object.keys(store).length
  },
  key: vi.fn((_index: number) => null),
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorageMock.clear()
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
})

describe('useBlockCollapse', () => {
  const flatBlocks: FlatBlock[] = [
    makeBlock('A', 0),
    makeBlock('B', 1, 'A'),
    makeBlock('C', 2, 'B'),
    makeBlock('D', 1, 'A'),
    makeBlock('E', 0),
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
    const { result } = renderHook(() => useBlockCollapse(flatBlocks))

    act(() => {
      result.current.toggleCollapse('A')
    })

    expect(localStorageMock.setItem).toHaveBeenCalledWith('collapsed_ids', expect.any(String))
    const stored = JSON.parse(localStorageMock.setItem.mock.calls[0]?.[1] as string) as string[]
    expect(stored).toContain('A')
  })

  it('restores collapsed IDs from localStorage on init', () => {
    store['collapsed_ids'] = JSON.stringify(['B'])

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
    const flatList = [makeBlock('X', 0), makeBlock('Y', 0), makeBlock('Z', 0)]
    const { result } = renderHook(() => useBlockCollapse(flatList))
    expect(result.current.hasChildrenSet.size).toBe(0)
    expect(result.current.visibleBlocks).toEqual(flatList)
  })
})
