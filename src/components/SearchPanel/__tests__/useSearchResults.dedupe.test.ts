/**
 * #5659 — a bm25 cursor that shifts between two "Load more" fetches can make
 * page 2 repeat a row page 1 already returned. The flattened list keeps the
 * first occurrence, and the next "Load more" still follows page 2's cursor.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-helpers')>()
  return {
    ...actual,
    searchBlocks: vi.fn(),
  }
})

const { mockBatchResolve } = vi.hoisted(() => ({ mockBatchResolve: vi.fn() }))
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: { ...actual.commands, batchResolve: mockBatchResolve },
  }
})

import { useSearchResults } from '@/components/SearchPanel/useSearchResults'
import type { SearchBlockRow } from '@/lib/bindings'
import { searchBlocks } from '@/lib/ipc-helpers'
import { queryClient } from '@/lib/query-client'
import { parse } from '@/lib/search-query'

const mockedSearchBlocks = vi.mocked(searchBlocks)

const toggles = { caseSensitive: false, wholeWord: false, isRegex: false }

function row(id: string): SearchBlockRow {
  return {
    id,
    page_id: null,
    block_type: 'content',
    content: `row ${id}`,
  } as unknown as SearchBlockRow
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
  mockBatchResolve.mockResolvedValue({ status: 'ok', data: [] })
})

afterEach(() => {
  queryClient.clear()
})

describe('useSearchResults — repeated rows across pages (#5659)', () => {
  it('lists a row page 2 repeats once, at its page 1 position, and keeps paging by page 2 cursor', async () => {
    mockedSearchBlocks.mockImplementation(async (params) => {
      if (params.cursor == null) {
        return { items: [row('A'), row('B')], next_cursor: 'C1', has_more: true, total_count: null }
      }
      if (params.cursor === 'C1') {
        return { items: [row('B'), row('C')], next_cursor: 'C2', has_more: true, total_count: null }
      }
      return { items: [row('D')], next_cursor: null, has_more: false, total_count: null }
    })

    const { result } = renderSearch('meeting')

    await waitFor(() => {
      expect(result.current.results.map((r) => r.id)).toEqual(['A', 'B'])
    })

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => {
      expect(result.current.results.map((r) => r.id)).toEqual(['A', 'B', 'C'])
    })
    expect(result.current.hasMore).toBe(true)

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => {
      expect(result.current.results.map((r) => r.id)).toEqual(['A', 'B', 'C', 'D'])
    })
    expect(result.current.hasMore).toBe(false)
  })
})
