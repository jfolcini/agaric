/**
 * Tests for useUnlinkedReferences — the TanStack `useInfiniteQuery`-backed
 * grouped *unlinked*-reference read hook (#2597, surface 2).
 *
 * Validates parity with the old `UnlinkedReferences.fetchGroups` state machine:
 *  - happy path (first page: groups, totalCount, truncated, has_more)
 *  - load-more (appends + merges by page_id; no mutation of prior objects)
 *  - error path (isError true, no throw to the caller)
 *  - totalCount/truncated derive from the LAST page (differs from
 *    useBacklinkGroups' first-page rule)
 *
 * The client is passed explicitly to `useInfiniteQuery` inside the hook, so no
 * `QueryClientProvider` wrapper is needed here.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '../../lib/query-client'
import { useUnlinkedReferences, type UseUnlinkedReferencesParams } from '../useUnlinkedReferences'

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

function baseParams(
  overrides: Partial<UseUnlinkedReferencesParams> = {},
): UseUnlinkedReferencesParams {
  return {
    pageId: 'PAGE1',
    filters: [],
    sort: null,
    spaceId: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The client is a module singleton with gcTime: Infinity — clear cached
  // pages between tests so each case starts fresh.
  queryClient.clear()
})

describe('useUnlinkedReferences', () => {
  it('happy path: returns first-page groups, totalCount, truncated and hasMore', async () => {
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }]),
        makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'block 2' }]),
      ],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 5,
      filtered_count: 5,
      truncated: true,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_unlinked_references') return resp
      return undefined
    })

    const { result } = renderHook(() => useUnlinkedReferences(baseParams()))

    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.groups).toHaveLength(2)
    expect(result.current.groups[0]?.page_id).toBe('P1')
    expect(result.current.groups[1]?.page_id).toBe('P2')
    expect(result.current.totalCount).toBe(5)
    expect(result.current.truncated).toBe(true)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.isError).toBe(false)
    // The exported query key mirrors the hook's read location exactly.
    expect(result.current.queryKey).toEqual(['unlinkedReferences', null, 'PAGE1', [], null])
  })

  it('load-more: appends + merges by page_id without mutating prior objects', async () => {
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
    // Page 2 repeats P1 (blocks must merge) and adds P3.
    const page2 = {
      groups: [
        makeGroup('P1', 'Page One', [{ id: 'B3', content: 'block 3' }]),
        makeGroup('P3', 'Page Three', [{ id: 'B4', content: 'block 4' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 5,
      filtered_count: 5,
      truncated: false,
    }
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_unlinked_references') {
        callCount++
        return callCount === 1 ? page1 : page2
      }
      return undefined
    })

    const { result } = renderHook(() => useUnlinkedReferences(baseParams()))

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
    expect(result.current.hasMore).toBe(false)

    // Load-more issued a fetch with the first page's cursor.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_unlinked_references',
      expect.objectContaining({ cursor: 'cursor_page2' }),
    )
  })

  it('error path: isError true, no throw to the caller', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_unlinked_references') throw new Error('network failure')
      return undefined
    })

    const { result } = renderHook(() => useUnlinkedReferences(baseParams()))

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    // The failure surfaces via isError; the hook never throws and groups stay
    // empty with a zero total.
    expect(result.current.groups).toHaveLength(0)
    expect(result.current.totalCount).toBe(0)
    expect(result.current.truncated).toBe(false)
    expect(result.current.loading).toBe(false)
  })

  it('totalCount/truncated derive from the LAST page (per-fetch, not first-page)', async () => {
    // Unlike useBacklinkGroups, the old fetchGroups set total_count/truncated on
    // EVERY fetch. So a load-more whose last page reports different values must
    // surface the LAST page's numbers.
    const page1 = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 10,
      filtered_count: 10,
      truncated: true,
    }
    const page2 = {
      groups: [makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'block 2' }])],
      next_cursor: null,
      has_more: false,
      total_count: 7,
      filtered_count: 7,
      truncated: false,
    }
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_unlinked_references') {
        callCount++
        return callCount === 1 ? page1 : page2
      }
      return undefined
    })

    const { result } = renderHook(() => useUnlinkedReferences(baseParams()))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    // First page's values.
    expect(result.current.totalCount).toBe(10)
    expect(result.current.truncated).toBe(true)

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => {
      expect(result.current.isFetchingMore).toBe(false)
    })

    // After load-more, the LAST page's values win (7, false) — not the first.
    expect(result.current.totalCount).toBe(7)
    expect(result.current.truncated).toBe(false)
  })
})
