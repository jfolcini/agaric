import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import {
  dispatchQuery,
  fetchBacklinksQuery,
  fetchFilteredQuery,
  fetchPropertyQuery,
  fetchTagQuery,
  QueryValidationError,
  useQueryExecution,
} from '../useQueryExecution'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useQueryExecution', () => {
  it('fetches tag query results and resolves page titles', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Tagged block', parent_id: 'P1', page_id: 'P1' })],
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
          items: [
            makeBlock({
              id: 'B1',
              content: 'Child block',
              parent_id: 'TARGET1',
              page_id: 'TARGET1',
            }),
          ],
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

  it('sets error when property query is missing key', async () => {
    const { result } = renderHook(() => useQueryExecution({ expression: 'type:property' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Property query requires key:NAME parameter')
    expect(result.current.results).toHaveLength(0)
  })

  it('sets error when backlinks query is missing target', async () => {
    const { result } = renderHook(() => useQueryExecution({ expression: 'type:backlinks' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Backlinks query requires target:ULID parameter')
    expect(result.current.results).toHaveLength(0)
  })
})

describe('fetchTagQuery', () => {
  it('returns items, nextCursor and hasMore for a tag prefix query', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1', content: 'Tagged' })],
      next_cursor: 'cur1',
      has_more: true,
    })

    const result = await fetchTagQuery({ expr: 'project' })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe('B1')
    expect(result.nextCursor).toBe('cur1')
    expect(result.hasMore).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ prefixes: ['project'], mode: 'or', limit: 50 }),
    )
  })

  it('passes no prefixes when expr is empty', async () => {
    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

    await fetchTagQuery({})

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ prefixes: [] }),
    )
  })

  it('forwards pageCursor for pagination', async () => {
    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

    await fetchTagQuery({ expr: 'project' }, 'CURSOR123')

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ cursor: 'CURSOR123' }),
    )
  })

  it('propagates backend rejection', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('backend down'))

    await expect(fetchTagQuery({ expr: 'project' })).rejects.toThrow('backend down')
  })
})

describe('fetchPropertyQuery', () => {
  it('returns items and pagination for a key/value property query', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1', content: 'High priority' })],
      next_cursor: null,
      has_more: false,
    })

    const result = await fetchPropertyQuery({ key: 'priority', value: '1' })

    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
    expect(result.hasMore).toBe(false)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_property',
      expect.objectContaining({ key: 'priority', valueText: '1' }),
    )
  })

  it('uses valueDate when a date param is provided', async () => {
    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

    await fetchPropertyQuery({ key: 'due_date', date: '2025-06-15' })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_property',
      expect.objectContaining({ key: 'due_date', valueDate: '2025-06-15' }),
    )
  })

  it('throws QueryValidationError when key is missing', async () => {
    await expect(fetchPropertyQuery({})).rejects.toBeInstanceOf(QueryValidationError)
    await expect(fetchPropertyQuery({})).rejects.toThrow(
      /Property query requires key:NAME parameter/,
    )
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('propagates backend rejection', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db fail'))

    await expect(fetchPropertyQuery({ key: 'priority' })).rejects.toThrow('db fail')
  })
})

describe('fetchBacklinksQuery', () => {
  it('returns items for a target parentId', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1', parent_id: 'TARGET1' })],
      next_cursor: null,
      has_more: false,
    })

    const result = await fetchBacklinksQuery({ target: 'TARGET1' })

    expect(result.items).toHaveLength(1)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_blocks',
      expect.objectContaining({ parentId: 'TARGET1' }),
    )
  })

  it('throws QueryValidationError when target is missing', async () => {
    await expect(fetchBacklinksQuery({})).rejects.toBeInstanceOf(QueryValidationError)
    await expect(fetchBacklinksQuery({})).rejects.toThrow(
      /Backlinks query requires target:ULID parameter/,
    )
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('propagates backend rejection', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('list_blocks failed'))

    await expect(fetchBacklinksQuery({ target: 'T1' })).rejects.toThrow('list_blocks failed')
  })
})

describe('fetchFilteredQuery', () => {
  it('returns empty result when no filters are supplied', async () => {
    const result = await fetchFilteredQuery([], [])

    expect(result.items).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
    expect(result.hasMore).toBe(false)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('returns a single result set unchanged when only one filter is supplied', async () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2' })]
    mockedInvoke.mockResolvedValueOnce({ items: blocks, next_cursor: null, has_more: false })

    const result = await fetchFilteredQuery([{ key: 'priority', value: '1', operator: 'eq' }], [])

    expect(result.items).toHaveLength(2)
    expect(result.items.map((b) => b.id)).toEqual(['B1', 'B2'])
  })

  it('AND-intersects multiple result sets', async () => {
    const todoBlocks = [
      makeBlock({ id: 'B1', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', todo_state: 'TODO' }),
    ]
    const priorityBlocks = [
      makeBlock({ id: 'B1', priority: '1' }),
      makeBlock({ id: 'B3', priority: '1' }),
    ]

    mockedInvoke.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'query_by_property') {
        const key = (args as { key: string }).key
        if (key === 'todo_state') return { items: todoBlocks, next_cursor: null, has_more: false }
        if (key === 'priority') return { items: priorityBlocks, next_cursor: null, has_more: false }
      }
      return { items: [], next_cursor: null, has_more: false }
    }) as never)

    const result = await fetchFilteredQuery(
      [
        { key: 'todo_state', value: 'TODO', operator: 'eq' },
        { key: 'priority', value: '1', operator: 'eq' },
      ],
      [],
    )

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe('B1')
  })

  it('issues parallel tag queries for tagFilters', async () => {
    mockedInvoke.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
    })

    const result = await fetchFilteredQuery([], ['alpha', 'beta'])

    expect(result.items).toHaveLength(1)
    const tagCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'query_by_tags')
    expect(tagCalls).toHaveLength(2)
    const prefixes = tagCalls.map((c) => (c[1] as { prefixes: string[] }).prefixes[0])
    expect(prefixes.sort()).toEqual(['alpha', 'beta'])
  })

  it('propagates backend rejection from any sub-query', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('sub-query failed'))

    await expect(
      fetchFilteredQuery([{ key: 'priority', value: '1', operator: 'eq' }], []),
    ).rejects.toThrow('sub-query failed')
  })
})

describe('dispatchQuery', () => {
  it('routes tag queries to query_by_tags', async () => {
    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

    await dispatchQuery({
      type: 'tag',
      params: { expr: 'x' },
      propertyFilters: [],
      tagFilters: [],
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', expect.anything())
  })

  it('routes property queries to query_by_property', async () => {
    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

    await dispatchQuery({
      type: 'property',
      params: { key: 'priority' },
      propertyFilters: [],
      tagFilters: [],
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', expect.anything())
  })

  it('routes backlinks queries to list_blocks', async () => {
    mockedInvoke.mockResolvedValueOnce({ items: [], next_cursor: null, has_more: false })

    await dispatchQuery({
      type: 'backlinks',
      params: { target: 'T1' },
      propertyFilters: [],
      tagFilters: [],
    })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_blocks',
      expect.objectContaining({ parentId: 'T1' }),
    )
  })

  it('routes filtered queries to fan out sub-queries', async () => {
    mockedInvoke.mockResolvedValue({ items: [], next_cursor: null, has_more: false })

    await dispatchQuery({
      type: 'filtered',
      params: {},
      propertyFilters: [{ key: 'priority', value: '1', operator: 'eq' }],
      tagFilters: ['alpha'],
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', expect.anything())
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', expect.anything())
  })

  it('throws QueryValidationError for unknown query types', async () => {
    await expect(
      dispatchQuery({
        type: 'unknown',
        params: {},
        propertyFilters: [],
        tagFilters: [],
      }),
    ).rejects.toBeInstanceOf(QueryValidationError)
    await expect(
      dispatchQuery({
        type: 'unknown',
        params: {},
        propertyFilters: [],
        tagFilters: [],
      }),
    ).rejects.toThrow(/Unknown query type: unknown/)
  })
})
