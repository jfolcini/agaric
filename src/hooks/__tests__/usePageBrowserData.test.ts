/**
 * Tests for usePageBrowserData — the data-fetch orchestration extracted
 * from `PageBrowser` (#1263). Covers the v2-cursor recovery retry, the
 * `InvalidFilter`-coded suppressed toast, the retained `displayTotalCount`
 * (adopt-first-page / ignore-cursor-null / reset-on-basis-change), and
 * the delete-decrement interceptor.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, StrictMode, type ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePageBrowserData } from '@/hooks/usePageBrowserData'
import type { SortOption } from '@/hooks/usePageBrowserSort'
import type { BlockRow, FilterPrimitive, PageWithMetadataRow } from '@/lib/bindings'

type DeleteSetter = (updater: (prev: BlockRow[]) => BlockRow[]) => void

const deleteAdapter = vi.hoisted(() => ({
  setPages: null as DeleteSetter | null,
  onRestored: null as ((pageId: string) => void) | null,
}))

vi.mock('@/hooks/usePageDelete', () => ({
  usePageDelete: (setPages: DeleteSetter, onRestored: (pageId: string) => void) => {
    deleteAdapter.setPages = setPages
    deleteAdapter.onRestored = onRestored
    return {
      deletingId: null,
      setDeleteTarget: vi.fn(),
      confirmDialog: null,
    }
  },
}))

// #2927 phase 7 — `usePageBrowserData` calls `commands.listPagesWithMetadata`
// from `@/lib/bindings` directly. The spy now sees the real wire arguments
// `(filter, cursor, limit)` rather than the wrapper's params object, and the
// shim wraps a fulfilment in the `{ status: 'ok', data }` envelope `unwrap`
// expects.
const mockedList = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listPagesWithMetadata: (...args: unknown[]) =>
        mockedList(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})
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
  deleteAdapter.setPages = null
  deleteAdapter.onRestored = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePageBrowserData', () => {
  it('retries the IPC without a cursor on a RequiresRefresh-coded validation error', async () => {
    // First page resolves; the cursor page rejects with RequiresRefresh,
    // then the cursorless retry resolves.
    mockedList
      .mockResolvedValueOnce(resp([page('A')], { cursor: 'CUR', hasMore: true, total: 2 }))
      .mockRejectedValueOnce({ kind: 'validation', code: 'RequiresRefresh', message: 'v1 cursor' })
      .mockResolvedValueOnce(resp([page('B')], { hasMore: false }))

    const { result } = renderHook(() => usePageBrowserData(BASE))
    await waitFor(() => expect(result.current.pages.length).toBe(1))

    await act(async () => {
      result.current.loadMore()
    })

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(3))
    // The third (recovery) call carries no cursor. On the generated binding
    // the cursor is the second positional argument, sent as an explicit
    // `null` when absent.
    expect(mockedList.mock.calls[2]?.[1]).toBeNull()
    // …and the second (rejected) call is the one that DID carry it, so the
    // assertion above can't pass vacuously.
    expect(mockedList.mock.calls[1]?.[1]).toBe('CUR')
    expect(mockedToastError).not.toHaveBeenCalled()
  })

  it('surfaces the invalid-filter toast and suppresses the generic loadFailed toast', async () => {
    mockedList.mockRejectedValueOnce({
      kind: 'validation',
      code: 'InvalidFilter',
      message: 'bad chip',
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

  it('re-shows the retained total when the basis changes but the total is unchanged (#2634)', async () => {
    // A sort switch re-keys and refetches, but never changes the count. With
    // `totalCount` derived from `data` and `keepPreviousData` keeping `data`
    // defined, the value never transitions — so the adopt effect must key on the
    // fetch settling, not on the number, or the reset-then-never-re-adopt would
    // permanently hide the chip.
    mockedList.mockResolvedValue(resp([page('A')], { total: 7 }))
    const { result, rerender } = renderHook((props) => usePageBrowserData(props), {
      initialProps: BASE,
    })
    await waitFor(() => expect(result.current.displayTotalCount).toBe(7))

    rerender({ ...BASE, sortOption: 'alphabetical' })
    // Blanks briefly on the basis change, then re-adopts the same total (7) once
    // the refetch settles — the chip must not vanish.
    await waitFor(() => expect(result.current.displayTotalCount).toBe(7))
  })

  it('removes a deleted row and decrements the total once under StrictMode', async () => {
    mockedList.mockResolvedValueOnce(resp([page('A'), page('B')], { total: 2 }))
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children)
    const { result } = renderHook(() => usePageBrowserData(BASE), { wrapper })
    await waitFor(() => expect(result.current.displayTotalCount).toBe(2))

    act(() => {
      deleteAdapter.setPages?.((rows) => rows.filter((row) => row.id !== 'A'))
    })

    await waitFor(() => expect(result.current.pages.map((row) => row.id)).toEqual(['B']))
    expect(result.current.displayTotalCount).toBe(1)
  })

  it('reconciles a decremented total from page 1 after a two-page Undo refetch', async () => {
    mockedList
      // Initial two-page query: only page 1 owns the authoritative total.
      .mockResolvedValueOnce(resp([page('A')], { cursor: 'CUR', hasMore: true, total: 2 }))
      .mockResolvedValueOnce(resp([page('B')], { total: null }))
      // Undo refetches every loaded page; the final cursor page is null again.
      .mockResolvedValueOnce(resp([page('A')], { cursor: 'CUR', hasMore: true, total: 2 }))
      .mockResolvedValueOnce(resp([page('B')], { total: null }))
    const { result } = renderHook(() => usePageBrowserData(BASE))
    await waitFor(() => expect(result.current.displayTotalCount).toBe(2))

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.pages.map((row) => row.id)).toEqual(['A', 'B']))

    act(() => {
      deleteAdapter.setPages?.((rows) => rows.filter((row) => row.id !== 'A'))
    })
    await waitFor(() => expect(result.current.pages.map((row) => row.id)).toEqual(['B']))
    expect(result.current.displayTotalCount).toBe(1)

    act(() => {
      deleteAdapter.onRestored?.('A')
    })

    await waitFor(() => {
      expect(result.current.pages.map((row) => row.id)).toEqual(['A', 'B'])
      expect(result.current.displayTotalCount).toBe(2)
    })
    expect(mockedList).toHaveBeenCalledTimes(4)
  })

  it('does not let a slower concurrent reload overwrite a newer total', async () => {
    let resolveOlder: ((value: ReturnType<typeof resp>) => void) | undefined
    let resolveNewer: ((value: ReturnType<typeof resp>) => void) | undefined
    mockedList
      .mockResolvedValueOnce(resp([page('A')], { total: 1 }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewer = resolve
          }),
      )
    const { result } = renderHook(() => usePageBrowserData(BASE))
    await waitFor(() => expect(result.current.displayTotalCount).toBe(1))

    act(() => {
      deleteAdapter.onRestored?.('A')
    })
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2))
    act(() => {
      deleteAdapter.onRestored?.('A')
    })
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(3))

    await act(async () => {
      resolveNewer?.(resp([page('A')], { total: 3 }))
    })
    await waitFor(() => expect(result.current.displayTotalCount).toBe(3))

    await act(async () => {
      resolveOlder?.(resp([page('A')], { total: 99 }))
    })
    expect(result.current.displayTotalCount).toBe(3)
  })

  it('keeps the optimistic decrement when the post-Undo refetch fails', async () => {
    mockedList
      .mockResolvedValueOnce(resp([page('A'), page('B')], { total: 2 }))
      .mockRejectedValueOnce(new Error('reload failed'))
    const { result } = renderHook(() => usePageBrowserData(BASE))
    await waitFor(() => expect(result.current.displayTotalCount).toBe(2))

    act(() => {
      deleteAdapter.setPages?.((rows) => rows.filter((row) => row.id !== 'A'))
    })
    await waitFor(() => expect(result.current.pages.map((row) => row.id)).toEqual(['B']))
    expect(result.current.displayTotalCount).toBe(1)

    act(() => {
      deleteAdapter.onRestored?.('A')
    })

    await waitFor(() => expect(mockedToastError).toHaveBeenCalled())
    expect(mockedList).toHaveBeenCalledTimes(2)
    expect(result.current.pages.map((row) => row.id)).toEqual(['B'])
    expect(result.current.displayTotalCount).toBe(1)
  })
})
