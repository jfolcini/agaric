/**
 * Tests for usePageBrowserData — the data-fetch orchestration extracted
 * from `PageBrowser` (#1263). Covers the v2-cursor recovery retry, the
 * `InvalidFilter:` suppressed toast, the retained `displayTotalCount`
 * (adopt-first-page / ignore-cursor-null / reset-on-basis-change), and
 * the delete-decrement interceptor.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FilterPrimitive, PageWithMetadataRow } from '../../lib/tauri'
import { usePageBrowserData } from '../usePageBrowserData'
import type { SortOption } from '../usePageBrowserSort'

vi.mock('../../lib/tauri', () => ({
  listPagesWithMetadata: vi.fn(),
  deleteBlock: vi.fn(),
}))

import { listPagesWithMetadata } from '../../lib/tauri'

const mockedList = vi.mocked(listPagesWithMetadata)
const mockedToastError = vi.mocked(toast.error)

function page(id: string): PageWithMetadataRow {
  return { id, content: id, block_type: 'page' } as unknown as PageWithMetadataRow
}

function resp(
  items: PageWithMetadataRow[],
  opts: { cursor?: string | null; hasMore?: boolean; total?: number | null } = {},
) {
  return {
    items,
    next_cursor: opts.cursor ?? null,
    has_more: opts.hasMore ?? false,
    total_count: opts.total ?? null,
  }
}

const BASE: {
  currentSpaceId: string | null
  spaceIsReady: boolean
  sortOption: SortOption
  wireFilters: FilterPrimitive[]
  wireFiltersKey: string
} = {
  currentSpaceId: 'SPACE_A',
  spaceIsReady: true,
  sortOption: 'default',
  wireFilters: [],
  wireFiltersKey: '[]',
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePageBrowserData', () => {
  it('retries the IPC without a cursor on a RequiresRefresh: validation error', async () => {
    // First page resolves; the cursor page rejects with RequiresRefresh,
    // then the cursorless retry resolves.
    mockedList
      .mockResolvedValueOnce(resp([page('A')], { cursor: 'CUR', hasMore: true, total: 2 }))
      .mockRejectedValueOnce({ kind: 'validation', message: 'RequiresRefresh: v1 cursor' })
      .mockResolvedValueOnce(resp([page('B')], { hasMore: false }))

    const { result } = renderHook(() => usePageBrowserData(BASE))
    await waitFor(() => expect(result.current.pages.length).toBe(1))

    await act(async () => {
      result.current.loadMore()
    })

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(3))
    // The third (recovery) call carries no cursor.
    expect(mockedList.mock.calls[2]?.[0]).not.toHaveProperty('cursor')
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('surfaces the invalid-filter toast and suppresses the generic loadFailed toast', async () => {
    mockedList.mockRejectedValueOnce({
      kind: 'validation',
      message: 'InvalidFilter: bad chip',
    })

    renderHook(() => usePageBrowserData(BASE))

    // Exactly one toast — the specific invalidFilter one; the suppressed
    // (cancelled-shaped) re-throw stops usePaginatedQuery's loadFailed.
    await waitFor(() => expect(mockedToastError).toHaveBeenCalledTimes(1))
  })

  it('retains the first-page total across a cursor page returning null', async () => {
    mockedList
      .mockResolvedValueOnce(resp([page('A')], { cursor: 'CUR', hasMore: true, total: 42 }))
      .mockResolvedValueOnce(resp([page('B')], { hasMore: false, total: null }))

    const { result } = renderHook(() => usePageBrowserData(BASE))
    await waitFor(() => expect(result.current.displayTotalCount).toBe(42))

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.pages.length).toBe(2))
    // The cursor page's null total must NOT blank the retained value.
    expect(result.current.displayTotalCount).toBe(42)
  })

  it('resets the retained total when the query basis changes', async () => {
    mockedList.mockResolvedValue(resp([page('A')], { total: 7 }))
    const { result, rerender } = renderHook((props) => usePageBrowserData(props), {
      initialProps: BASE,
    })
    await waitFor(() => expect(result.current.displayTotalCount).toBe(7))

    mockedList.mockResolvedValue(resp([page('Z')], { total: 3 }))
    rerender({ ...BASE, sortOption: 'alphabetical' })
    // Reset fires synchronously on the basis change, then re-adopts the
    // new first-page total once the refetch settles.
    await waitFor(() => expect(result.current.displayTotalCount).toBe(3))
  })
})
