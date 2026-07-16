/**
 * Cap-arithmetic tests for useSearchResults (#2634).
 *
 * The retired `usePaginatedQuery` capped accumulation at `maxItems` (5000) and
 * its `usePaginatedQuery.test.ts` covered that arithmetic. After the TanStack
 * migration the cap lives in `useSearchResults` itself (`hasMore` / `loadMore`
 * gated on `results.length < MAX_ITEMS`, `capped` latching once the set reaches
 * the cap with more pages available), so it needs its own coverage — the
 * panel-level `SearchPanel.capped.test.tsx` only asserts the NOTICE renders when
 * handed `capped: true`, not the arithmetic that produces it.
 *
 * Driven through the real hook (IPC mocked at the `lib/tauri` wrapper, same
 * pattern as `useSearchResults.tagResolution.test.ts`).
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>()
  return {
    ...actual,
    searchBlocks: vi.fn(),
    listTagsByPrefix: vi.fn(),
    batchResolve: vi.fn(),
    getBlock: vi.fn(),
  }
})

import { useSearchResults } from '@/components/SearchPanel/useSearchResults'
import { queryClient } from '@/lib/query-client'
import { parse } from '@/lib/search-query'
import { batchResolve, searchBlocks, type SearchBlockRow } from '@/lib/tauri'

const mockedSearchBlocks = vi.mocked(searchBlocks)
const mockedBatchResolve = vi.mocked(batchResolve)

const toggles = { caseSensitive: false, wholeWord: false, isRegex: false }

/** Make `n` distinct, breadcrumb-free (`page_id: null`) result rows. */
function rows(prefix: string, n: number): SearchBlockRow[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        id: `${prefix}-${i}`,
        page_id: null,
        block_type: 'block',
        content: `row ${prefix}-${i}`,
      }) as unknown as SearchBlockRow,
  )
}

function renderSearch(query: string) {
  const debouncedAst = parse(query)
  return renderHook(() =>
    useSearchResults({
      debouncedAst,
      debouncedQuery: query,
      currentSpaceId: 'SPACE_A',
      spaceIsReady: true,
      toggles,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  queryClient.clear()
  mockedBatchResolve.mockResolvedValue([])
})

afterEach(() => {
  queryClient.clear()
})

describe('useSearchResults — cap arithmetic (#2634)', () => {
  it('below the cap: capped is false and load-more stays available', async () => {
    // 3000 < 5000, more pages available.
    mockedSearchBlocks.mockResolvedValue({
      items: rows('P1', 3000),
      next_cursor: 'C1',
      has_more: true,
      total_count: null,
    })

    const { result } = renderSearch('meeting')

    await waitFor(() => {
      expect(result.current.results.length).toBe(3000)
    })
    expect(result.current.capped).toBe(false)
    expect(result.current.hasMore).toBe(true)
  })

  it('crossing the cap latches capped, kills hasMore, and blocks further loadMore', async () => {
    // Page 1: 3000 (under the cap). Page 2 (cursor set): another 3000 → 6000 ≥ 5000.
    mockedSearchBlocks.mockImplementation(async (params) => {
      if (params.cursor == null) {
        return { items: rows('P1', 3000), next_cursor: 'C1', has_more: true, total_count: null }
      }
      return { items: rows('P2', 3000), next_cursor: 'C2', has_more: true, total_count: null }
    })

    const { result } = renderSearch('meeting')

    await waitFor(() => {
      expect(result.current.results.length).toBe(3000)
    })
    expect(result.current.capped).toBe(false)
    expect(result.current.hasMore).toBe(true)

    // Load the second page — this crosses the 5000 cap.
    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => {
      expect(result.current.results.length).toBe(6000)
    })
    expect(result.current.capped).toBe(true)
    expect(result.current.hasMore).toBe(false)

    // The cap gate must now block any further fetch: loadMore is a no-op.
    const callsAfterCap = mockedSearchBlocks.mock.calls.length
    await act(async () => {
      result.current.loadMore()
      await Promise.resolve()
    })
    expect(mockedSearchBlocks.mock.calls.length).toBe(callsAfterCap)
  })
})
