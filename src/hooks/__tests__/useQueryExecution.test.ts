import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockRow } from '../../lib/tauri'
import { useQueryExecution } from '../useQueryExecution'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useQueryExecution', () => {
  it('fetches tag query results and resolves page titles', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Tagged block', parent_id: 'P1' })],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'My Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    const { result } = renderHook(() => useQueryExecution({ expression: 'type:tag expr:project' }))

    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.content).toBe('Tagged block')
    expect(result.current.error).toBeNull()
    expect(result.current.pageTitles.get('P1')).toBe('My Page')
  })

  it('fetches property query results', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Priority task', priority: '1' })],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    const { result } = renderHook(() =>
      useQueryExecution({ expression: 'type:property key:priority value:1' }),
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.content).toBe('Priority task')
    expect(result.current.error).toBeNull()
  })

  it('handles filtered query with AND intersection', async () => {
    const todoBlocks = [
      makeBlock({ id: 'B1', content: 'Match', todo_state: 'TODO', priority: '1' }),
      makeBlock({ id: 'B2', content: 'No match', todo_state: 'TODO', priority: '3' }),
    ]
    const priorityBlocks = [
      makeBlock({ id: 'B1', content: 'Match', todo_state: 'TODO', priority: '1' }),
      makeBlock({ id: 'B3', content: 'Other', todo_state: 'DONE', priority: '1' }),
    ]

    mockedInvoke.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'query_by_property') {
        if ((args as { key: string }).key === 'todo_state') {
          return { items: todoBlocks, next_cursor: null, has_more: false }
        }
        if ((args as { key: string }).key === 'priority') {
          return { items: priorityBlocks, next_cursor: null, has_more: false }
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    }) as never)

    const { result } = renderHook(() =>
      useQueryExecution({ expression: 'property:todo_state=TODO property:priority=1' }),
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    // Only B1 should be in the intersection
    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.id).toBe('B1')
    expect(result.current.error).toBeNull()
  })

  it('fetches backlinks query results', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Child block', parent_id: 'TARGET1' })],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    const { result } = renderHook(() =>
      useQueryExecution({ expression: 'type:backlinks target:TARGET1' }),
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.content).toBe('Child block')
    expect(result.current.error).toBeNull()
  })

  it('sets error for unknown query type', async () => {
    const { result } = renderHook(() => useQueryExecution({ expression: 'type:invalid' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toMatch(/Unknown query type/)
    expect(result.current.results).toHaveLength(0)
  })

  it('sets error for empty expression', async () => {
    const { result } = renderHook(() => useQueryExecution({ expression: '' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toMatch(/empty/i)
  })

  it('handles pagination with handleLoadMore', async () => {
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        callCount++
        if (callCount === 1) {
          return {
            items: [makeBlock({ id: 'B1', content: 'First' })],
            next_cursor: 'cursor1',
            has_more: true,
          }
        }
        return {
          items: [makeBlock({ id: 'B2', content: 'Second' })],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    const { result } = renderHook(() => useQueryExecution({ expression: 'type:tag expr:project' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.results).toHaveLength(1)
    expect(result.current.hasMore).toBe(true)

    await act(async () => {
      result.current.handleLoadMore()
    })

    await waitFor(() => {
      expect(result.current.loadingMore).toBe(false)
    })

    expect(result.current.results).toHaveLength(2)
    expect(result.current.results[0]?.content).toBe('First')
    expect(result.current.results[1]?.content).toBe('Second')
    expect(result.current.hasMore).toBe(false)
  })

  it('sets loading=true during initial fetch', async () => {
    let resolveQuery: ((value: unknown) => void) | undefined
    mockedInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve
        }),
    )

    const { result } = renderHook(() => useQueryExecution({ expression: 'type:tag expr:test' }))

    expect(result.current.loading).toBe(true)
    expect(result.current.loadingMore).toBe(false)

    await act(async () => {
      resolveQuery?.({ items: [], next_cursor: null, has_more: false })
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('sets error string on fetch failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Network error'))

    const { result } = renderHook(() => useQueryExecution({ expression: 'type:tag expr:test' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Network error')
  })

  it('shows generic fallback for non-Error rejection', async () => {
    mockedInvoke.mockRejectedValueOnce('string error')

    const { result } = renderHook(() => useQueryExecution({ expression: 'type:tag expr:test' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Query failed')
  })

  it('re-fetches when expression changes', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Result' })],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    const { result, rerender } = renderHook(({ expression }) => useQueryExecution({ expression }), {
      initialProps: { expression: 'type:tag expr:alpha' },
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const firstCallCount = mockedInvoke.mock.calls.filter((c) => c[0] === 'query_by_tags').length

    rerender({ expression: 'type:tag expr:beta' })

    await waitFor(() => {
      const newCallCount = mockedInvoke.mock.calls.filter((c) => c[0] === 'query_by_tags').length
      expect(newCallCount).toBeGreaterThan(firstCallCount)
    })
  })
})
