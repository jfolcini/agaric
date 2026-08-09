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

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  useUnlinkedReferences,
  type UseUnlinkedReferencesParams,
} from '@/hooks/useUnlinkedReferences'
import { queryClient } from '@/lib/query-client'

// #3332 — the shared strict `invoke` mock from `src/test-setup.ts` stays in
// place (no per-file module mock), so an IPC this file does not model fails the
// test by name instead of resolving `undefined` into a phantom success.
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
    mockedInvoke.mockImplementation(mockInvokeCommands({ list_unlinked_references: () => resp }))

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
    // The exported query key mirrors the hook's read location exactly. The
    // trailing element is the #3316 item-2 group limit (20 = panel expanded).
    expect(result.current.queryKey).toEqual(['unlinkedReferences', null, 'PAGE1', [], null, 20])
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
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_unlinked_references: () => {
          callCount++
          return callCount === 1 ? page1 : page2
        },
      }),
    )

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
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_unlinked_references: () => {
          throw new Error('network failure')
        },
      }),
    )

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
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_unlinked_references: () => {
          callCount++
          return callCount === 1 ? page1 : page2
        },
      }),
    )

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

  // #3316 item 1 — the hook used to read `total_count` only and drop
  // `filtered_count`, so the component had no post-filter number to render and
  // passed `filteredCount={totalCount}`: "Showing 40 of 40" above 4 rows.
  it('#3316 item 1: surfaces the backend filtered_count separately from totalCount', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      // Pre-filter total is 40; the active filter leaves 4.
      total_count: 40,
      filtered_count: 4,
      truncated: false,
    }
    mockedInvoke.mockImplementation(mockInvokeCommands({ list_unlinked_references: () => resp }))

    const { result } = renderHook(() =>
      useUnlinkedReferences(baseParams({ filters: [{ type: 'TodoState', state: 'TODO' }] })),
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.totalCount).toBe(40)
    expect(result.current.filteredCount).toBe(4)
  })

  // #3316 item 2 — `UnlinkedReferences` is mounted for every page and starts
  // collapsed, so the full 20-group page (up to 20 x MAX_BLOCKS_PER_GROUP block
  // rows, fetched + JSON-serialised over IPC) was paid for on every page open
  // for a list nobody had opened. A collapsed panel needs only the counts, which
  // the backend computes over the whole match set before pagination.
  it('#3316 item 2: a collapsed panel requests one group, an expanded one the full page', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 40,
      filtered_count: 40,
      truncated: false,
    }
    mockedInvoke.mockImplementation(mockInvokeCommands({ list_unlinked_references: () => resp }))

    const { result, rerender } = renderHook(
      ({ collapsed }: { collapsed: boolean }) => useUnlinkedReferences(baseParams({ collapsed })),
      { initialProps: { collapsed: true } },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const limitOf = (call: unknown[]): unknown => (call[1] as { limit?: unknown }).limit
    const unlinkedCalls = () =>
      mockedInvoke.mock.calls.filter((c) => c[0] === 'list_unlinked_references')

    // Collapsed: one group only — but the counts are still exact.
    expect(unlinkedCalls().map(limitOf)).toEqual([1])
    expect(result.current.totalCount).toBe(40)

    // Expanding re-keys the query and pulls the real page size.
    rerender({ collapsed: false })
    await waitFor(() => {
      expect(unlinkedCalls()).toHaveLength(2)
    })
    expect(unlinkedCalls().map(limitOf)).toEqual([1, 20])
  })

  // #3738 note 2 — the counts already survive the `groupLimit` re-key (#3733
  // note 2), but `truncated` did not, so it flipped true → false → true across
  // an expand while the numbers rendered right next to it held steady. It is
  // the same "two adjacent statements about the same fetch disagree" defect the
  // carry was introduced to remove.
  it('#3738 note 2: truncated survives the collapsed→expanded re-key with the counts', async () => {
    const collapsedPage = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 12,
      filtered_count: 12,
      truncated: true,
    }
    // The expanded fetch never settles, so the new key holds no data at all —
    // exactly the window the carry exists for.
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_unlinked_references: (args) =>
          Number(args['limit']) === 1 ? collapsedPage : new Promise(() => {}),
      }),
    )

    const { result, rerender } = renderHook(
      ({ collapsed }: { collapsed: boolean }) => useUnlinkedReferences(baseParams({ collapsed })),
      { initialProps: { collapsed: true } },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.truncated).toBe(true)
    expect(result.current.totalCount).toBe(12)

    rerender({ collapsed: false })

    await waitFor(() => {
      expect(
        mockedInvoke.mock.calls.filter((c) => c[0] === 'list_unlinked_references'),
      ).toHaveLength(2)
    })
    // Mid-re-key: the counts are carried…
    expect(result.current.totalCount).toBe(12)
    expect(result.current.filteredCount).toBe(12)
    // …and so is the flag rendered beside them.
    expect(result.current.truncated).toBe(true)
  })

  // #3738 note 1 — the carry deliberately also spans a FAILED fetch: `data` is
  // `undefined` for an errored key exactly as it is for a pending one. Dropping
  // it would make the whole panel disappear under the click that expanded it.
  it('#3738 note 1: a failed expand keeps the count already known for that identity', async () => {
    const collapsedPage = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 12,
      filtered_count: 12,
      truncated: false,
    }
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_unlinked_references: (args) => {
          if (Number(args['limit']) === 1) return collapsedPage
          throw new Error('expand failed')
        },
      }),
    )

    const { result, rerender } = renderHook(
      ({ collapsed }: { collapsed: boolean }) => useUnlinkedReferences(baseParams({ collapsed })),
      { initialProps: { collapsed: true } },
    )
    await waitFor(() => {
      expect(result.current.totalCount).toBe(12)
    })

    rerender({ collapsed: false })
    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    // The count was never unknown — only the bigger page failed to arrive.
    expect(result.current.totalCount).toBe(12)
    expect(result.current.groups).toHaveLength(0)
  })

  // #3738 note 8 — the optimistic "Link it" removal has to reach EVERY limit
  // variant, so the key it targets is exported without the limit too.
  it('#3738 note 8: exports the limit-free key prefix that matches both variants', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedInvoke.mockImplementation(mockInvokeCommands({ list_unlinked_references: () => resp }))

    const { result } = renderHook(() => useUnlinkedReferences(baseParams()))
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.queryKeyPrefix).toEqual(['unlinkedReferences', null, 'PAGE1', [], null])
    // It is exactly the read key minus the trailing group limit, so
    // `setQueriesData` prefix-matching cannot drift from where the hook reads.
    expect(result.current.queryKey).toEqual([...result.current.queryKeyPrefix, 20])
  })

  // #3316 item 2 (b) — `pageId` is part of the query key, so under the client's
  // inherited `gcTime: Infinity` a session that visits N pages leaves N
  // observer-less cache entries that are never collected. The hook must
  // override it, as `useBacklinkGroups` already does.
  it('#3316 item 2: overrides the client default gcTime so per-pageId entries are collectable', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedInvoke.mockImplementation(mockInvokeCommands({ list_unlinked_references: () => resp }))

    const { result } = renderHook(() => useUnlinkedReferences(baseParams()))
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const entry = queryClient.getQueryCache().find({ queryKey: result.current.queryKey })
    expect(entry).toBeDefined()
    expect(entry?.gcTime).toBe(5 * 60 * 1000)
    expect(entry?.gcTime).toBeLessThan(Number.POSITIVE_INFINITY)
  })
})
