import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockRow } from '../../lib/tauri'
import { compareValues, useQuerySorting } from '../useQuerySorting'

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'BLK001',
    block_type: 'content',
    content: 'Test block',
    parent_id: null,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    ...overrides,
  }
}

describe('compareValues', () => {
  it('returns 0 when both values are null', () => {
    expect(compareValues(null, null, 'asc')).toBe(0)
    expect(compareValues(null, null, 'desc')).toBe(0)
  })

  it('sorts null last in ascending', () => {
    expect(compareValues(null, 'a', 'asc')).toBeGreaterThan(0)
    expect(compareValues('a', null, 'asc')).toBeLessThan(0)
  })

  it('sorts null first in descending', () => {
    expect(compareValues(null, 'a', 'desc')).toBeLessThan(0)
    expect(compareValues('a', null, 'desc')).toBeGreaterThan(0)
  })

  it('compares strings ascending', () => {
    expect(compareValues('alpha', 'beta', 'asc')).toBeLessThan(0)
    expect(compareValues('beta', 'alpha', 'asc')).toBeGreaterThan(0)
    expect(compareValues('same', 'same', 'asc')).toBe(0)
  })

  it('compares strings descending', () => {
    expect(compareValues('alpha', 'beta', 'desc')).toBeGreaterThan(0)
    expect(compareValues('beta', 'alpha', 'desc')).toBeLessThan(0)
    // -0 and 0 are equivalent for sorting purposes
    expect(compareValues('same', 'same', 'desc')).toBeCloseTo(0)
  })
})

describe('useQuerySorting', () => {
  const blockA = makeBlock({ id: 'A', content: 'Alpha' })
  const blockB = makeBlock({ id: 'B', content: 'Beta' })
  const blockC = makeBlock({ id: 'C', content: 'Charlie' })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns results unchanged when no sorting applied', () => {
    const results = [blockB, blockA, blockC]
    const { result } = renderHook(() => useQuerySorting({ results }))

    expect(result.current.sortedResults).toBe(results)
    expect(result.current.sortKey).toBeNull()
    expect(result.current.sortDir).toBe('asc')
  })

  it('sorts by content ascending', () => {
    const results = [blockB, blockA, blockC]
    const { result } = renderHook(() => useQuerySorting({ results }))

    act(() => {
      result.current.handleColumnSort('content')
    })

    expect(result.current.sortKey).toBe('content')
    expect(result.current.sortDir).toBe('asc')
    expect(result.current.sortedResults.map((b) => b.content)).toEqual(['Alpha', 'Beta', 'Charlie'])
  })

  it('sorts by content descending on second click', () => {
    const results = [blockB, blockA, blockC]
    const { result } = renderHook(() => useQuerySorting({ results }))

    act(() => {
      result.current.handleColumnSort('content')
    })
    act(() => {
      result.current.handleColumnSort('content')
    })

    expect(result.current.sortDir).toBe('desc')
    expect(result.current.sortedResults.map((b) => b.content)).toEqual(['Charlie', 'Beta', 'Alpha'])
  })

  it('toggles direction on same key', () => {
    const results = [blockA, blockB]
    const { result } = renderHook(() => useQuerySorting({ results }))

    act(() => {
      result.current.handleColumnSort('content')
    })
    expect(result.current.sortDir).toBe('asc')

    act(() => {
      result.current.handleColumnSort('content')
    })
    expect(result.current.sortDir).toBe('desc')

    act(() => {
      result.current.handleColumnSort('content')
    })
    expect(result.current.sortDir).toBe('asc')
  })

  it('resets to ascending when switching to a different key', () => {
    const results = [
      makeBlock({ id: 'A', content: 'Alpha', todo_state: 'DONE' }),
      makeBlock({ id: 'B', content: 'Beta', todo_state: 'TODO' }),
    ]
    const { result } = renderHook(() => useQuerySorting({ results }))

    // Sort by content, then toggle to desc
    act(() => {
      result.current.handleColumnSort('content')
    })
    act(() => {
      result.current.handleColumnSort('content')
    })
    expect(result.current.sortDir).toBe('desc')

    // Switch to todo_state — should reset to asc
    act(() => {
      result.current.handleColumnSort('todo_state')
    })
    expect(result.current.sortKey).toBe('todo_state')
    expect(result.current.sortDir).toBe('asc')
  })

  it('null values sort last in ascending', () => {
    const results = [
      makeBlock({ id: 'A', content: 'Alpha', priority: null }),
      makeBlock({ id: 'B', content: 'Beta', priority: '1' }),
      makeBlock({ id: 'C', content: 'Charlie', priority: '2' }),
    ]
    const { result } = renderHook(() => useQuerySorting({ results }))

    act(() => {
      result.current.handleColumnSort('priority')
    })

    expect(result.current.sortedResults.map((b) => b.priority)).toEqual(['1', '2', null])
  })

  it('null values sort first in descending', () => {
    const results = [
      makeBlock({ id: 'A', content: 'Alpha', priority: null }),
      makeBlock({ id: 'B', content: 'Beta', priority: '1' }),
      makeBlock({ id: 'C', content: 'Charlie', priority: '2' }),
    ]
    const { result } = renderHook(() => useQuerySorting({ results }))

    act(() => {
      result.current.handleColumnSort('priority')
    })
    act(() => {
      result.current.handleColumnSort('priority')
    })

    expect(result.current.sortDir).toBe('desc')
    expect(result.current.sortedResults.map((b) => b.priority)).toEqual([null, '2', '1'])
  })
})
