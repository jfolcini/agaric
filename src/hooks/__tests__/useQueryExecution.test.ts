import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import {
  dispatchQuery,
  fetchBacklinksQuery,
  fetchFilteredQuery,
  fetchPropertyQuery,
  fetchRichInlineQuery,
  fetchTagQuery,
  QueryValidationError,
  useQueryExecution,
} from '@/hooks/useQueryExecution'
import type { AdvancedQueryResponse, PageResponse, QueryResultRow } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { encodeInlineQueryPayload } from '@/lib/inline-query-spec'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

/** {@link stubInvoke}, additionally recording every command name invoked. */
function stubInvokeRecording(handlers: Readonly<TypedInvokeHandlers>): string[] {
  const seen: string[] = []
  const dispatch = mockInvokeCommands(handlers)
  mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
    seen.push(cmd)
    return dispatch(cmd, args)
  })
  return seen
}

/** An `AdvancedQueryResponse` page; the engine's field names are camelCase. */
function advancedPage(
  rows: QueryResultRow[],
  overrides: Partial<AdvancedQueryResponse> = {},
): AdvancedQueryResponse {
  return { rows, nextCursor: null, hasMore: false, totalCount: null, ...overrides }
}

/** A `PageResponse<T>`; `total_count` is not optional on the wire. */
function page<T>(items: T[], overrides: Partial<PageResponse<T>> = {}): PageResponse<T> {
  return { items, next_cursor: null, has_more: false, total_count: null, ...overrides }
}

const projectTag = { tag_id: 'TAG_PROJECT', name: 'project', usage_count: 1, updated_at: '' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useQueryExecution', () => {
  it('fetches tag query results and resolves page titles', async () => {
    stubInvoke({
      run_advanced_query: () =>
        advancedPage([
          makeBlock({ id: 'B1', content: 'Tagged block', parent_id: 'P1', page_id: 'P1' }),
        ]),
      list_tags_by_prefix: () => [projectTag],
      batch_resolve: () => [{ id: 'P1', title: 'My Page', block_type: 'page', deleted: false }],
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
    stubInvoke({
      run_advanced_query: () =>
        advancedPage([makeBlock({ id: 'B1', content: 'Priority task', priority: '1' })]),
      batch_resolve: () => [],
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

    stubInvoke({
      run_advanced_query: () => advancedPage(intersected),
      batch_resolve: () => [],
    })

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

  it('fetches backlinks query results (reroutes to ChildOf via run_advanced_query)', async () => {
    const seen = stubInvokeRecording({
      run_advanced_query: () =>
        advancedPage([
          makeBlock({
            id: 'B1',
            content: 'Child block',
            parent_id: 'TARGET1',
            page_id: 'TARGET1',
          }),
        ]),
      batch_resolve: () => [],
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
    // Backlinks-with-target reroutes through the rich engine, not legacy list_blocks.
    expect(seen).toContain('run_advanced_query')
    expect(seen).not.toContain('list_blocks')
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
    stubInvoke({
      run_advanced_query: () => {
        callCount++
        return callCount === 1
          ? advancedPage([makeBlock({ id: 'B1', content: 'First' })], {
              nextCursor: 'cursor1',
              hasMore: true,
            })
          : advancedPage([makeBlock({ id: 'B2', content: 'Second' })])
      },
      list_tags_by_prefix: () => [projectTag],
      batch_resolve: () => [],
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
    let resolveQuery: ((value: AdvancedQueryResponse) => void) | undefined
    stubInvoke({
      list_tags_by_prefix: () => [projectTag],
      run_advanced_query: () =>
        new Promise<AdvancedQueryResponse>((resolve) => {
          resolveQuery = resolve
        }),
    })

    const { result } = renderHook(() => useQueryExecution({ expression: 'type:tag expr:test' }))

    expect(result.current.loading).toBe(true)
    expect(result.current.loadingMore).toBe(false)

    // The tag reroute resolves `list_tags_by_prefix` on a microtask before the
    // controlled `run_advanced_query` promise exists. The old catch-all stub
    // handed BOTH commands the same promise, so this test used to resolve
    // `list_tags_by_prefix` with a page envelope and reach `loading === false`
    // down the ERROR path.
    await waitFor(() => {
      expect(resolveQuery).toBeDefined()
    })

    await act(async () => {
      resolveQuery?.(advancedPage([]))
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('sets error string on fetch failure', async () => {
    stubInvoke({
      list_tags_by_prefix: () => Promise.reject(new Error('Network error')),
    })

    const { result } = renderHook(() => useQueryExecution({ expression: 'type:tag expr:test' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Network error')
  })

  it('shows generic fallback for non-Error rejection', async () => {
    // A non-Error rejection is the point: the hook must not assume `.message`.
    stubInvoke({ list_tags_by_prefix: () => Promise.reject('string error') })

    const { result } = renderHook(() => useQueryExecution({ expression: 'type:tag expr:test' }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe('Query failed')
  })

  it('re-fetches when expression changes', async () => {
    stubInvoke({
      run_advanced_query: () => advancedPage([makeBlock({ id: 'B1', content: 'Result' })]),
      list_tags_by_prefix: () => [{ ...projectTag, tag_id: 'TAG_X', name: 'x' }],
      batch_resolve: () => [],
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

  // #4555 — these error strings used to be hardcoded English literals. The
  // English catalog value is byte-equal to the old literal, so the two
  // tests above can't tell "reads the catalog" from "hardcoded literal" —
  // overriding the catalog and asserting the override appears proves the
  // call sites actually resolve through `t()`. Fails if a call site
  // reverts to a bare string literal.
  it('#4555: property/empty-expression errors resolve through the i18n catalog, not a hardcoded literal', async () => {
    const KEYS: [string, string][] = [
      ['query.propertyRequiresKey', '__OVERRIDDEN_KEY_REQUIRED__'],
      ['query.expressionEmpty', '__OVERRIDDEN_EMPTY__'],
    ]
    for (const [key, value] of KEYS) i18n.addResource('en', 'translation', key, value)
    try {
      const { result: propResult } = renderHook(() =>
        useQueryExecution({ expression: 'type:property' }),
      )
      await waitFor(() => expect(propResult.current.loading).toBe(false))
      expect(propResult.current.error).toBe('__OVERRIDDEN_KEY_REQUIRED__')

      const { result: emptyResult } = renderHook(() => useQueryExecution({ expression: '' }))
      expect(emptyResult.current.error).toBe('__OVERRIDDEN_EMPTY__')
    } finally {
      i18n.addResource(
        'en',
        'translation',
        'query.propertyRequiresKey',
        'Property query requires key:NAME parameter',
      )
      i18n.addResource('en', 'translation', 'query.expressionEmpty', 'Query expression is empty')
    }
  })

  // Stale-fetch guard. When `expression` changes before the previous
  // IPC resolves, the older (slower) fetch must NOT clobber the newer
  // (faster) fetch's results. The hook uses a monotonic `reqIdRef` counter:
  // each `fetchResults` call captures `myReqId = ++reqIdRef.current` and
  // bails out at every await boundary if the counter has advanced.
  it('discards stale results when an older fetch resolves after a newer fetch', async () => {
    let resolveAlpha: ((value: AdvancedQueryResponse) => void) | undefined
    let resolveBeta: ((value: AdvancedQueryResponse) => void) | undefined
    let tagCallCount = 0

    stubInvoke({
      run_advanced_query: () => {
        tagCallCount++
        return new Promise<AdvancedQueryResponse>((resolve) => {
          if (tagCallCount === 1) resolveAlpha = resolve
          else resolveBeta = resolve
        })
      },
      list_tags_by_prefix: () => [{ ...projectTag, tag_id: 'TAG_X', name: 'x' }],
      batch_resolve: () => [],
    })

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
      resolveBeta?.(advancedPage([makeBlock({ id: 'B1', content: 'beta-result' })]))
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
      resolveAlpha?.(advancedPage([makeBlock({ id: 'A1', content: 'alpha-result' })]))
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
    stubInvoke({
      query_by_tags: () =>
        page([makeBlock({ id: 'B1', content: 'Tagged' })], {
          next_cursor: 'cur1',
          has_more: true,
        }),
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
    stubInvoke({ query_by_tags: () => page([]) })

    await fetchTagQuery({})

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ prefixes: [] }),
    )
  })

  it('forwards pageCursor for pagination', async () => {
    stubInvoke({ query_by_tags: () => page([]) })

    await fetchTagQuery({ expr: 'project' }, 'CURSOR123')

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ cursor: 'CURSOR123' }),
    )
  })

  it('propagates backend rejection', async () => {
    stubInvoke({ query_by_tags: () => Promise.reject(new Error('backend down')) })

    await expect(fetchTagQuery({ expr: 'project' })).rejects.toThrow('backend down')
  })
})

describe('fetchPropertyQuery', () => {
  it('returns items and pagination for a key/value property query', async () => {
    stubInvoke({
      query_by_property: () => page([makeBlock({ id: 'B1', content: 'High priority' })]),
    })

    const result = await fetchPropertyQuery({ key: 'priority', value: '1' })

    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
    expect(result.hasMore).toBe(false)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_property',
      // #2277 item 7 — query params nest under `request`.
      expect.objectContaining({
        request: expect.objectContaining({ key: 'priority', valueText: '1' }),
      }),
    )
  })

  it('uses valueDate when a date param is provided', async () => {
    stubInvoke({ query_by_property: () => page([]) })

    await fetchPropertyQuery({ key: 'due_date', date: '2025-06-15' })

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_property',
      expect.objectContaining({
        request: expect.objectContaining({ key: 'due_date', valueDate: '2025-06-15' }),
      }),
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
    stubInvoke({ query_by_property: () => Promise.reject(new Error('db fail')) })

    await expect(fetchPropertyQuery({ key: 'priority' })).rejects.toThrow('db fail')
  })
})

describe('fetchBacklinksQuery', () => {
  it('returns items for a target parentId', async () => {
    stubInvoke({ list_blocks: () => page([makeBlock({ id: 'B1', parent_id: 'TARGET1' })]) })

    // #2248 — a backlinks fetch requires an active space; pass one so it dispatches.
    const result = await fetchBacklinksQuery({ target: 'TARGET1' }, undefined, 'SPACE_1')

    expect(result.items).toHaveLength(1)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_blocks',
      // #2277 item 7 — query params nest under `request`; `scope` stays separate.
      expect.objectContaining({
        request: expect.objectContaining({ parentId: 'TARGET1' }),
        scope: { kind: 'active', space_id: 'SPACE_1' },
      }),
    )
  })

  it('throws QueryValidationError when target is missing', async () => {
    await expect(fetchBacklinksQuery({})).rejects.toBeInstanceOf(QueryValidationError)
    await expect(fetchBacklinksQuery({})).rejects.toThrow(
      /Backlinks query requires target:ULID parameter/,
    )
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('short-circuits to an empty result without dispatching when there is no active space (#2248)', async () => {
    // `listBlocks` has no cross-space form, so a backlinks fetch with no active
    // space must return empty rather than invoking (which would throw).
    const result = await fetchBacklinksQuery({ target: 'TARGET1' })

    expect(result).toEqual({ items: [], nextCursor: null, hasMore: false })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('propagates backend rejection', async () => {
    stubInvoke({ list_blocks: () => Promise.reject(new Error('list_blocks failed')) })

    await expect(fetchBacklinksQuery({ target: 'T1' }, undefined, 'SPACE_1')).rejects.toThrow(
      'list_blocks failed',
    )
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
    // `total_count` is not optional on `PageResponse`; the old literal omitted it.
    stubInvoke({ filtered_blocks_query: () => page(blocks) })

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
    stubInvoke({ filtered_blocks_query: () => page([makeBlock({ id: 'B1' })]) })

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
    stubInvoke({ filtered_blocks_query: () => page([makeBlock({ id: 'B1' })]) })

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
    stubInvoke({ filtered_blocks_query: () => Promise.reject(new Error('sub-query failed')) })

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
    stubInvoke({ filtered_blocks_query: () => page([rareMatch]) })

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
    stubInvoke({ query_by_tags: () => page([]) })

    await dispatchQuery({
      type: 'tag',
      params: { expr: 'x' },
      propertyFilters: [],
      tagFilters: [],
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', expect.anything())
  })

  it('routes property queries to query_by_property', async () => {
    stubInvoke({ query_by_property: () => page([]) })

    await dispatchQuery({
      type: 'property',
      params: { key: 'priority' },
      propertyFilters: [],
      tagFilters: [],
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', expect.anything())
  })

  it('routes backlinks queries to list_blocks', async () => {
    stubInvoke({ list_blocks: () => page([]) })

    await dispatchQuery(
      {
        type: 'backlinks',
        params: { target: 'T1' },
        propertyFilters: [],
        tagFilters: [],
      },
      // #2248 — backlinks routing requires an active space to dispatch.
      undefined,
      'SPACE_1',
    )

    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_blocks',
      expect.objectContaining({
        request: expect.objectContaining({ parentId: 'T1' }),
        scope: { kind: 'active', space_id: 'SPACE_1' },
      }),
    )
  })

  it('routes filtered queries to a single filtered_blocks_query IPC (Tier 2.10b)', async () => {
    stubInvoke({ filtered_blocks_query: () => page([]) })

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

    const seen = stubInvokeRecording({
      run_advanced_query: () =>
        advancedPage(
          [makeBlock({ id: 'B1', content: 'Rich match', parent_id: 'P1', page_id: 'P1' })],
          { totalCount: 1 },
        ),
      batch_resolve: () => [{ id: 'P1', title: 'My Page', block_type: 'page', deleted: false }],
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
    stubInvoke({
      run_advanced_query: () =>
        advancedPage([makeBlock({ id: 'B2', content: 'row' })], {
          nextCursor: 'CURSOR',
          hasMore: true,
          totalCount: 9,
        }),
    })
    const out = await fetchRichInlineQuery({ type: 'And', children: [] }, undefined, 'SPACE')
    expect(out.items).toHaveLength(1)
    expect(out.nextCursor).toBe('CURSOR')
    expect(out.hasMore).toBe(true)
  })
})
