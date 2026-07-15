/**
 * Tests for useBacklinkGroups — the TanStack `useInfiniteQuery`-backed grouped
 * backlink read hook (#2597).
 *
 * Validates parity with the old `LinkedReferences.fetchGroups` state machine:
 *  - happy path (first page: groups, totalCount, has_more)
 *  - load-more (appends + merges by page_id; totalCount stays first-page value)
 *  - error path (isError true, no throw to the caller)
 *  - invalidationKey change triggers a refetch (F-39)
 *
 * The client is passed explicitly to `useInfiniteQuery` inside the hook, so no
 * `QueryClientProvider` wrapper is needed here.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '../../lib/query-client'
import { useBacklinkGroups, type UseBacklinkGroupsParams } from '../useBacklinkGroups'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

function makeGroup(
  pageId: string,
  pageTitle: string | null,
  blocks: Array<{ id: string; content: string }>,
) {
  return {
    page_id: pageId,
    page_title: pageTitle,
    blocks: blocks.map((b) => ({
      id: b.id,
      block_type: 'content',
      content: b.content,
      parent_id: pageId,
      page_id: pageId,
      position: 1,
      deleted_at: null,
    })),
  }
}

function baseParams(overrides: Partial<UseBacklinkGroupsParams> = {}): UseBacklinkGroupsParams {
  return {
    pageId: 'PAGE1',
    filters: [],
    sort: null,
    sourcePageIncluded: [],
    sourcePageExcluded: [],
    spaceId: null,
    invalidationKey: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The client is a module singleton with gcTime: Infinity — clear cached
  // pages between tests so each case starts fresh.
  queryClient.clear()
})

describe('useBacklinkGroups', () => {
  it('happy path: returns first-page groups, totalCount and hasMore', async () => {
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }]),
        makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'block 2' }]),
      ],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 5,
      filtered_count: 5,
      truncated: false,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_backlinks_grouped') return resp
      return undefined
    })

    const { result } = renderHook(() => useBacklinkGroups(baseParams()))

    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.groups).toHaveLength(2)
    expect(result.current.groups[0]?.page_id).toBe('P1')
    expect(result.current.groups[1]?.page_id).toBe('P2')
    expect(result.current.totalCount).toBe(5)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.isError).toBe(false)
  })

  it('load-more: appends + merges by page_id, totalCount stays first-page value', async () => {
    const page1 = {
      groups: [
        makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }]),
        makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'block 2' }]),
      ],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 5,
      filtered_count: 5,
      truncated: false,
    }
    // Page 2 repeats P1 (blocks must merge) and adds P3. total_count 0 mirrors
    // the backend's non-first-page contract (#2201 item 1b).
    const page2 = {
      groups: [
        makeGroup('P1', 'Page One', [{ id: 'B3', content: 'block 3' }]),
        makeGroup('P3', 'Page Three', [{ id: 'B4', content: 'block 4' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 0,
      filtered_count: 0,
      truncated: false,
    }
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_backlinks_grouped') {
        callCount++
        return callCount === 1 ? page1 : page2
      }
      return undefined
    })

    const { result } = renderHook(() => useBacklinkGroups(baseParams()))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.groups).toHaveLength(2)

    // Capture the prior-render P1 group + its blocks array to assert no mutation.
    const priorP1 = result.current.groups.find((g) => g.page_id === 'P1')
    const priorP1Blocks = priorP1?.blocks
    expect(priorP1?.blocks).toHaveLength(1)

    await act(async () => {
      result.current.loadMore()
    })

    await waitFor(() => {
      expect(result.current.isFetchingMore).toBe(false)
    })

    // P1 merged (B1 + B3), P2 unchanged, P3 appended — first-appearance order.
    expect(result.current.groups.map((g) => g.page_id)).toEqual(['P1', 'P2', 'P3'])
    const mergedP1 = result.current.groups.find((g) => g.page_id === 'P1')
    expect(mergedP1?.blocks.map((b) => b.id)).toEqual(['B1', 'B3'])
    // The prior-render P1 object was not mutated (#1529).
    expect(priorP1?.blocks).toBe(priorP1Blocks)
    expect(priorP1?.blocks).toHaveLength(1)
    expect(mergedP1).not.toBe(priorP1)

    // totalCount keeps the FIRST page's value (never clobbered to 0).
    expect(result.current.totalCount).toBe(5)
    expect(result.current.hasMore).toBe(false)

    // Load-more issued a fetch with the first page's cursor.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_backlinks_grouped',
      expect.objectContaining({ cursor: 'cursor_page2' }),
    )
  })

  it('error path: isError true, no throw to the caller', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_backlinks_grouped') throw new Error('network failure')
      return undefined
    })

    const { result } = renderHook(() => useBacklinkGroups(baseParams()))

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    // The failure surfaces via isError; the hook never throws and groups stay
    // empty with a zero total.
    expect(result.current.groups).toHaveLength(0)
    expect(result.current.totalCount).toBe(0)
    expect(result.current.loading).toBe(false)
  })

  it('invalidationKey change triggers a refetch (F-39)', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_backlinks_grouped') return resp
      return undefined
    })

    const { result, rerender } = renderHook(
      ({ invalidationKey }) => useBacklinkGroups(baseParams({ invalidationKey })),
      { initialProps: { invalidationKey: 0 } },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    const callsBefore = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'list_backlinks_grouped',
    ).length
    expect(callsBefore).toBeGreaterThanOrEqual(1)

    // Bumping invalidationKey changes the query key -> a fresh query + refetch.
    rerender({ invalidationKey: 1 })

    await waitFor(() => {
      const callsAfter = mockedInvoke.mock.calls.filter(
        (c) => c[0] === 'list_backlinks_grouped',
      ).length
      expect(callsAfter).toBeGreaterThan(callsBefore)
    })
  })
})
