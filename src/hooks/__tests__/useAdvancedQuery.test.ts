/**
 * Tests for useAdvancedQuery (#1280 D2).
 *
 * Validates that the hook threads the new engine inputs (fulltext / sort /
 * groupBy / aggregates) into `runAdvancedQuery`, surfaces `groups` and
 * `aggregates` from the response, and handles grouped pagination over the same
 * cursor. IPC is mocked at the `@/lib/tauri` wrapper boundary.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri', () => ({
  runAdvancedQuery: vi.fn(),
  batchResolve: vi.fn(),
}))

import type {
  AdvancedQueryResponse,
  AggregateSpec,
  GroupSpec,
  QueryGroup,
  SortKey,
} from '@/lib/tauri'
import { batchResolve, runAdvancedQuery } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

import { useAdvancedQuery } from '../useAdvancedQuery'

const mockedRun = vi.mocked(runAdvancedQuery)
const mockedResolve = vi.mocked(batchResolve)

const SPACE = 'SPACE_A'

function makeResponse(over: Partial<AdvancedQueryResponse> = {}): AdvancedQueryResponse {
  return { rows: [], nextCursor: null, hasMore: false, totalCount: 0, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: SPACE })
  mockedResolve.mockResolvedValue([])
  mockedRun.mockResolvedValue(makeResponse())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useAdvancedQuery — D2 inputs', () => {
  it('omits the optional inputs entirely when unset (minimal wire shape)', async () => {
    renderHook(() => useAdvancedQuery({ filters: [] }))
    await waitFor(() => expect(mockedRun).toHaveBeenCalled())
    expect(mockedRun).toHaveBeenCalledWith({
      spaceId: SPACE,
      filter: { type: 'And', children: [] },
      limit: 50,
    })
  })

  it('threads fulltext / sort / aggregates into the request', async () => {
    const sort: SortKey[] = [{ source: { type: 'Relevance' } }]
    const aggregates: AggregateSpec[] = [{ op: 'count', target: null }]
    renderHook(() => useAdvancedQuery({ filters: [], fulltext: '  hello  ', sort, aggregates }))
    await waitFor(() => expect(mockedRun).toHaveBeenCalled())
    expect(mockedRun).toHaveBeenCalledWith({
      spaceId: SPACE,
      filter: { type: 'And', children: [] },
      limit: 50,
      fulltext: 'hello', // trimmed
      sort,
      aggregates,
    })
  })

  it('drops a stale Relevance sort key when no full-text term is set', async () => {
    // The engine rejects `SortSource::Relevance` without a `fulltext` term;
    // the picker only offers it while a term is set, but a stale key can
    // survive the term being cleared. The hook must sanitise it out.
    const sort: SortKey[] = [
      { source: { type: 'Relevance' } },
      { source: { type: 'Column', name: 'created' }, desc: true },
    ]
    renderHook(() => useAdvancedQuery({ filters: [], sort }))
    await waitFor(() => expect(mockedRun).toHaveBeenCalled())
    expect(mockedRun).toHaveBeenCalledWith({
      spaceId: SPACE,
      filter: { type: 'And', children: [] },
      limit: 50,
      // Relevance dropped; the Column key survives.
      sort: [{ source: { type: 'Column', name: 'created' }, desc: true }],
    })
  })

  it('keeps the Relevance sort key when a full-text term IS set', async () => {
    const sort: SortKey[] = [{ source: { type: 'Relevance' } }]
    renderHook(() => useAdvancedQuery({ filters: [], fulltext: 'hi', sort }))
    await waitFor(() => expect(mockedRun).toHaveBeenCalled())
    expect(mockedRun).toHaveBeenCalledWith(expect.objectContaining({ fulltext: 'hi', sort }))
  })

  it('does NOT send a whitespace-only fulltext', async () => {
    renderHook(() => useAdvancedQuery({ filters: [], fulltext: '   ' }))
    await waitFor(() => expect(mockedRun).toHaveBeenCalled())
    const arg = mockedRun.mock.calls[0]?.[0] as Record<string, unknown>
    expect(arg).not.toHaveProperty('fulltext')
  })

  it('surfaces global aggregates from the response', async () => {
    mockedRun.mockResolvedValue(
      makeResponse({ aggregates: [{ op: 'count', value: null, count: 7 }] }),
    )
    const { result } = renderHook(() =>
      useAdvancedQuery({ filters: [], aggregates: [{ op: 'count', target: null }] }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.aggregates).toEqual([{ op: 'count', value: null, count: 7 }])
    expect(result.current.groups).toBeNull()
  })
})

describe('useAdvancedQuery — grouped mode', () => {
  const groupBy: GroupSpec = { key: { type: 'Tag' } }

  function makeGroup(over: Partial<QueryGroup> = {}): QueryGroup {
    return { key: 'Tag', count: 3, members: [], ...over }
  }

  it('surfaces groups and total GROUP count, leaving results empty', async () => {
    mockedRun.mockResolvedValue(
      makeResponse({
        groups: [makeGroup({ key: 'project', count: 2 })],
        totalCount: 1,
      }),
    )
    const { result } = renderHook(() => useAdvancedQuery({ filters: [], groupBy }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockedRun).toHaveBeenCalledWith(expect.objectContaining({ groupBy }))
    expect(result.current.groups).toHaveLength(1)
    expect(result.current.groups?.[0]).toMatchObject({ key: 'project', count: 2 })
    expect(result.current.results).toEqual([])
    expect(result.current.totalCount).toBe(1)
  })

  it('paginates over groups via the same cursor', async () => {
    mockedRun
      .mockResolvedValueOnce(
        makeResponse({
          groups: [makeGroup({ key: 'g1' })],
          nextCursor: 'GCUR',
          hasMore: true,
          totalCount: 2,
        }),
      )
      .mockResolvedValueOnce(makeResponse({ groups: [makeGroup({ key: 'g2' })], totalCount: null }))

    const { result } = renderHook(() => useAdvancedQuery({ filters: [], groupBy }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    expect(result.current.hasMore).toBe(true)

    result.current.handleLoadMore()
    await waitFor(() => expect(result.current.groups).toHaveLength(2))
    // Second call carried the group-level cursor.
    expect(mockedRun).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'GCUR', groupBy }))
    expect(result.current.groups?.map((g) => g.key)).toEqual(['g1', 'g2'])
  })
})
