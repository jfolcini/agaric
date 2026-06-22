import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import { encodeInlineQueryPayload } from '../../lib/inline-query-spec'
import {
  dispatchQuery,
  fetchBacklinksQuery,
  fetchFilteredQuery,
  fetchPropertyQuery,
  fetchRichInlineQuery,
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
      if (cmd === 'run_advanced_query') {
        return {
          rows: [makeBlock({ id: 'B1', content: 'Tagged block', parent_id: 'P1', page_id: 'P1' })],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'list_tags_by_prefix') {
        return [{ tag_id: 'TAG_PROJECT', name: 'project', usage_count: 1, updated_at: '' }]
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
      if (cmd === 'run_advanced_query') {
        return {
          rows: [makeBlock({ id: 'B1', content: 'Priority task', priority: '1' })],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
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

  // Filtered queries collapse from N IPCs (one
  // per sub-filter) + JS intersection to ONE IPC into
  // `filtered_blocks_query`. Pre-Tier-2.10b this test mocked
  // `query_by_property` twice and asserted the JS-side intersection;
  // post-fix the backend resolves the AND in SQL so the mock returns
  // the post-intersection set directly.
  it('handles filtered query with AND intersection (single IPC, no JS intersect)', async () => {
    const intersected = [
      makeBlock({ id: 'B1', content: 'Match', todo_state: 'TODO', priority: '1' }),
    ]

    mockedInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return { rows: intersected, nextCursor: null, hasMore: false, totalCount: null }
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

    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.id).toBe('B1')
    expect(result.current.error).toBeNull()

    // Exactly ONE rich-engine IPC fires (the filtered AND reroutes to
    // `run_advanced_query`, which resolves the conjunction in SQL).
    const richCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'run_advanced_query')
    expect(richCalls).toHaveLength(1)
    // No fan-out to the legacy filter endpoints.
    const filterCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'filtered_blocks_query')
    const propertyCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'query_by_property')
    const tagCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'query_by_tags')
    expect(filterCalls).toHaveLength(0)
    expect(propertyCalls).toHaveLength(0)
    expect(tagCalls).toHaveLength(0)
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
          total_count: null,
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
      if (cmd === 'run_advanced_query') {
        callCount++
        if (callCount === 1) {
          return {
            rows: [makeBlock({ id: 'B1', content: 'First' })],
            nextCursor: 'cursor1',
            hasMore: true,
            totalCount: null,
          }
        }
        return {
          rows: [makeBlock({ id: 'B2', content: 'Second' })],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'list_tags_by_prefix') {
        return [{ tag_id: 'TAG_PROJECT', name: 'project', usage_count: 1, updated_at: '' }]
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
      resolveQuery?.({ items: [], next_cursor: null, has_more: false, total_count: null })
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
      if (cmd === 'run_advanced_query') {
        return {
          rows: [makeBlock({ id: 'B1', content: 'Result' })],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'list_tags_by_prefix') {
        return [{ tag_id: 'TAG_X', name: 'x', usage_count: 1, updated_at: '' }]
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

    const firstCallCount = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'run_advanced_query',
    ).length

    rerender({ expression: 'type:tag expr:beta' })

    await waitFor(() => {
      const newCallCount = mockedInvoke.mock.calls.filter(
        (c) => c[0] === 'run_advanced_query',
      ).length
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

  // Stale-fetch guard. When `expression` changes before the previous
  // IPC resolves, the older (slower) fetch must NOT clobber the newer
  // (faster) fetch's results. The hook uses a monotonic `reqIdRef` counter:
  // each `fetchResults` call captures `myReqId = ++reqIdRef.current` and
  // bails out at every await boundary if the counter has advanced.
  it('discards stale results when an older fetch resolves after a newer fetch', async () => {
    let resolveAlpha: ((value: unknown) => void) | undefined
    let resolveBeta: ((value: unknown) => void) | undefined
    let tagCallCount = 0

    mockedInvoke.mockImplementation(((cmd: string): Promise<unknown> => {
      if (cmd === 'run_advanced_query') {
        tagCallCount++
        if (tagCallCount === 1) {
          return new Promise((resolve) => {
            resolveAlpha = resolve
          })
        }
        return new Promise((resolve) => {
          resolveBeta = resolve
        })
      }
      if (cmd === 'list_tags_by_prefix') {
        return Promise.resolve([{ tag_id: 'TAG_X', name: 'x', usage_count: 1, updated_at: '' }])
      }
      if (cmd === 'batch_resolve') return Promise.resolve([])
      return Promise.resolve(null)
    }) as never)

    const { result, rerender } = renderHook(({ expression }) => useQueryExecution({ expression }), {
      initialProps: { expression: 'type:tag expr:alpha' },
    })

    // First fetch (alpha) is in flight.
    expect(result.current.loading).toBe(true)

    // The reroute resolves the tag prefix (`list_tags_by_prefix`) on a
    // microtask BEFORE the controlled `run_advanced_query` promise is
    // created, so flush microtasks until alpha's `run_advanced_query`
    // has been issued (its resolver captured).
    await waitFor(() => {
      expect(resolveAlpha).toBeDefined()
    })

    // Re-render with beta BEFORE alpha resolves: this triggers fetch #2.
    rerender({ expression: 'type:tag expr:beta' })

    // Likewise wait for beta's `run_advanced_query` to be issued.
    await waitFor(() => {
      expect(resolveBeta).toBeDefined()
    })

    // Beta resolves FIRST (the "newer, faster" fetch).
    await act(async () => {
      resolveBeta?.({
        rows: [makeBlock({ id: 'B1', content: 'beta-result' })],
        nextCursor: null,
        hasMore: false,
        totalCount: null,
      })
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.content).toBe('beta-result')

    // Now alpha (the "older, slower" fetch) finally resolves. Without the
    // stale-fetch guard, this would call applyQueryResult and overwrite
    // beta's payload. With the guard it must be a no-op.
    await act(async () => {
      resolveAlpha?.({
        rows: [makeBlock({ id: 'A1', content: 'alpha-result' })],
        nextCursor: null,
        hasMore: false,
        totalCount: null,
      })
      await Promise.resolve()
    })

    // Results should still be beta — alpha's late resolution was discarded.
    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.id).toBe('B1')
    expect(result.current.results[0]?.content).toBe('beta-result')
  })
})

describe('fetchTagQuery', () => {
  it('returns items, nextCursor and hasMore for a tag prefix query', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1', content: 'Tagged' })],
      next_cursor: 'cur1',
      has_more: true,
      total_count: null,
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
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    await fetchTagQuery({})

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ prefixes: [] }),
    )
  })

  it('forwards pageCursor for pagination', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

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
      total_count: null,
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
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

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
      total_count: null,
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

// `fetchFilteredQuery` no longer fans out one
// IPC per sub-filter and intersects in JS; it delegates to the new
// `filtered_blocks_query` IPC which composes the AND in SQL via
// EXISTS subqueries. Pre-Tier-2.10b the FE silently dropped any
// AND-set member outside the top-200 of any one sub-query because the
// 200-row sub-query cap was applied BEFORE the JS intersection.
describe('fetchFilteredQuery', () => {
  it('short-circuits to empty result when no filters are supplied (no IPC)', async () => {
    const result = await fetchFilteredQuery([], [])

    expect(result.items).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
    expect(result.hasMore).toBe(false)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('passes a single property filter to filtered_blocks_query', async () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2' })]
    mockedInvoke.mockResolvedValueOnce({ items: blocks, next_cursor: null, has_more: false })

    const result = await fetchFilteredQuery([{ key: 'priority', value: '1', operator: 'eq' }], [])

    expect(result.items).toHaveLength(2)
    expect(result.items.map((b) => b.id)).toEqual(['B1', 'B2'])

    expect(mockedInvoke).toHaveBeenCalledOnce()
    const [cmd, args] = mockedInvoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(cmd).toBe('filtered_blocks_query')
    const propertyFilters = args['propertyFilters'] as Array<Record<string, unknown>>
    expect(propertyFilters).toHaveLength(1)
    expect(propertyFilters[0]?.['key']).toBe('priority')
    expect(propertyFilters[0]?.['valueText']).toBe('1')
    expect(propertyFilters[0]?.['operator']).toBe('eq')
  })

  it('issues ONE IPC with composed property filters (no fan-out, no JS intersect)', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const result = await fetchFilteredQuery(
      [
        { key: 'todo_state', value: 'TODO', operator: 'eq' },
        { key: 'priority', value: '1', operator: 'eq' },
      ],
      [],
    )

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe('B1')

    // ONE IPC — was N (one per sub-filter) pre-Tier-2.10b.
    expect(mockedInvoke).toHaveBeenCalledOnce()
    const [cmd, args] = mockedInvoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(cmd).toBe('filtered_blocks_query')
    const filters = args['propertyFilters'] as Array<Record<string, unknown>>
    expect(filters).toHaveLength(2)
    expect(filters.map((f) => f['key']).toSorted()).toEqual(['priority', 'todo_state'])
    // Legacy fan-out endpoints must NOT be touched.
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'query_by_property')).toHaveLength(0)
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'query_by_tags')).toHaveLength(0)
  })

  it('bundles tag filters into a single tagFilters arg (no parallel tag IPCs)', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const result = await fetchFilteredQuery([], ['alpha', 'beta'])

    expect(result.items).toHaveLength(1)
    expect(mockedInvoke).toHaveBeenCalledOnce()
    const [cmd, args] = mockedInvoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(cmd).toBe('filtered_blocks_query')
    const tagFilters = args['tagFilters'] as Record<string, unknown>
    expect(tagFilters).toBeTruthy()
    expect(tagFilters['prefixes']).toEqual(['alpha', 'beta'])
    expect(tagFilters['mode']).toBe('or')
  })

  it('propagates backend rejection from the single IPC', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('sub-query failed'))

    await expect(
      fetchFilteredQuery([{ key: 'priority', value: '1', operator: 'eq' }], []),
    ).rejects.toThrow('sub-query failed')
  })

  // **Load-bearing regression test** for the silent-cap bug
  // Tier 2.10b fixes. Pre-fix: each sub-query was capped at 200 rows
  // BEFORE the JS-side intersection — any AND-set member outside any
  // one sub-query's top-200 was silently dropped. Post-fix: the
  // backend composes the AND in SQL so the cap (now only the page
  // limit) applies AFTER the intersection. The mock returns the
  // post-intersection block directly; the test asserts the FE no
  // longer applies a JS-side intersection (which it cannot, having
  // no per-sub-query result sets to intersect anymore).
  it('silent-cap regression: relies on backend AND-intersection (no JS post-filter)', async () => {
    // The backend has already done the intersection — there is no
    // way the FE could "drop" a row past row 200 because the FE
    // never sees the per-sub-query unfiltered results. We assert
    // this by returning a row from the mock and verifying the FE
    // surfaces it verbatim, even with multiple input sub-filters.
    const rareMatch = makeBlock({
      id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ', // top-of-sort-key ULID
      content: 'rare AND-set member',
    })
    mockedInvoke.mockResolvedValueOnce({
      items: [rareMatch],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const result = await fetchFilteredQuery(
      [
        { key: 'noise', value: 'on', operator: 'eq' },
        { key: 'target', value: 'rare', operator: 'eq' },
      ],
      [],
    )

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe('ZZZZZZZZZZZZZZZZZZZZZZZZZZ')
    expect(mockedInvoke).toHaveBeenCalledOnce()
  })
})

describe('dispatchQuery', () => {
  it('routes tag queries to query_by_tags', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    await dispatchQuery({
      type: 'tag',
      params: { expr: 'x' },
      propertyFilters: [],
      tagFilters: [],
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', expect.anything())
  })

  it('routes property queries to query_by_property', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    await dispatchQuery({
      type: 'property',
      params: { key: 'priority' },
      propertyFilters: [],
      tagFilters: [],
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', expect.anything())
  })

  it('routes backlinks queries to list_blocks', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

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

  it('routes filtered queries to a single filtered_blocks_query IPC (Tier 2.10b)', async () => {
    mockedInvoke.mockResolvedValue({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    await dispatchQuery({
      type: 'filtered',
      params: {},
      propertyFilters: [{ key: 'priority', value: '1', operator: 'eq' }],
      tagFilters: ['alpha'],
    })

    // ONE IPC — composes property + tag filters into a single SQL
    // EXISTS-chain on the backend.
    expect(mockedInvoke).toHaveBeenCalledOnce()
    expect(mockedInvoke).toHaveBeenCalledWith('filtered_blocks_query', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('query_by_property', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('query_by_tags', expect.anything())
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

describe('useQueryExecution — structured (v2) inline queries', () => {
  it('routes a v2 payload through run_advanced_query, not the legacy IPCs', async () => {
    const expression = encodeInlineQueryPayload({
      filter: {
        type: 'Or',
        children: [
          { type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } },
          { type: 'Leaf', primitive: { type: 'Tag', tag: 'T1' } },
        ],
      },
      table: false,
    })

    const seen: string[] = []
    mockedInvoke.mockImplementation(async (cmd: string) => {
      seen.push(cmd)
      if (cmd === 'run_advanced_query') {
        return {
          rows: [makeBlock({ id: 'B1', content: 'Rich match', parent_id: 'P1', page_id: 'P1' })],
          nextCursor: null,
          hasMore: false,
          totalCount: 1,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'My Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    const { result } = renderHook(() => useQueryExecution({ expression }))
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.content).toBe('Rich match')
    expect(result.current.error).toBeNull()
    // The rich engine was used; no legacy tag/property/filtered IPC fired.
    expect(seen).toContain('run_advanced_query')
    expect(seen).not.toContain('query_by_tags')
    expect(seen).not.toContain('query_by_property')
    expect(seen).not.toContain('filtered_blocks_query')
  })

  it('fetchRichInlineQuery maps the engine response to the fetch-result shape', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return {
          rows: [makeBlock({ id: 'B2', content: 'row' })],
          nextCursor: 'CURSOR',
          hasMore: true,
          totalCount: 9,
        }
      }
      return null
    })
    const out = await fetchRichInlineQuery({ type: 'And', children: [] }, undefined, 'SPACE')
    expect(out.items).toHaveLength(1)
    expect(out.nextCursor).toBe('CURSOR')
    expect(out.hasMore).toBe(true)
  })
})
