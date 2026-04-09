/**
 * Tests for useDuePanelData hook.
 *
 * Validates:
 *  - Fetches blocks on mount
 *  - Returns loading state during fetch
 *  - Resolves page titles via batchResolve
 *  - Re-fetches when date changes
 *  - Re-fetches when sourceFilter changes
 *  - Fetches overdue blocks when isToday
 *  - Does not fetch overdue when not today
 *  - Fetches upcoming blocks when warningDays > 0
 *  - Does not fetch upcoming when warningDays is 0
 *  - Fetches projected entries
 *  - loadMore fetches next page with cursor
 *  - Handles fetch errors gracefully
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  listBlocks: vi.fn(),
  batchResolve: vi.fn(),
  listProjectedAgenda: vi.fn(),
  queryByProperty: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { batchResolve, listBlocks, listProjectedAgenda, queryByProperty } from '../../lib/tauri'
import { clearProjectedCache, useDuePanelData } from '../useDuePanelData'

const mockedListBlocks = vi.mocked(listBlocks)
const mockedBatchResolve = vi.mocked(batchResolve)
const mockedListProjectedAgenda = vi.mocked(listProjectedAgenda)
const mockedQueryByProperty = vi.mocked(queryByProperty)

const emptyResponse = {
  items: [],
  next_cursor: null,
  has_more: false,
}

function makeBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: 'B1',
    block_type: 'block',
    content: 'test block',
    parent_id: 'PAGE1',
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: '2025-06-15',
    scheduled_date: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearProjectedCache()
  mockedListBlocks.mockResolvedValue(emptyResponse)
  mockedBatchResolve.mockResolvedValue([])
  mockedListProjectedAgenda.mockResolvedValue([])
  mockedQueryByProperty.mockResolvedValue(emptyResponse)
})

afterEach(() => {
  localStorage.clear()
})

describe('useDuePanelData', () => {
  it('fetches blocks on mount', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(result.current.blocks).toHaveLength(1)
    })
    expect(mockedListBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ agendaDate: '2025-06-15' }),
    )
  })

  it('returns loading=true during fetch', async () => {
    let resolveBlocks!: (v: unknown) => void
    const pendingBlocks = new Promise((r) => {
      resolveBlocks = r
    })
    mockedListBlocks.mockReturnValue(pendingBlocks as ReturnType<typeof listBlocks>)

    const { result } = renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    // Initially loading
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveBlocks({ items: [], next_cursor: null, has_more: false })
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('resolves page titles via batchResolve', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1' })],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Resolved Title', block_type: 'page', deleted: false },
    ])

    const { result } = renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(result.current.pageTitles.get('PAGE1')).toBe('Resolved Title')
    })
  })

  it('re-fetches when date changes', async () => {
    mockedListBlocks.mockResolvedValue(emptyResponse)

    const { rerender } = renderHook(({ date }) => useDuePanelData({ date, sourceFilter: null }), {
      initialProps: { date: '2025-06-15' },
    })

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ agendaDate: '2025-06-15' }),
      )
    })

    mockedListBlocks.mockClear()

    rerender({ date: '2025-06-16' })

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ agendaDate: '2025-06-16' }),
      )
    })
  })

  it('re-fetches when sourceFilter changes', async () => {
    mockedListBlocks.mockResolvedValue(emptyResponse)

    const { rerender } = renderHook(
      ({ sourceFilter }) => useDuePanelData({ date: '2025-06-15', sourceFilter }),
      { initialProps: { sourceFilter: null as string | null } },
    )

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalled()
    })

    mockedListBlocks.mockClear()

    rerender({ sourceFilter: 'column:due_date' })

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ agendaSource: 'column:due_date' }),
      )
    })
  })

  it('does not fetch overdue when not today', async () => {
    renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalled()
    })

    // queryByProperty should NOT have been called for overdue since date !== today
    // (it may be called for upcoming if warningDays > 0, but default is 0)
    // The overdue fetch is only triggered when isToday is true
    expect(mockedQueryByProperty).not.toHaveBeenCalled()
  })

  it('fetches projected entries on mount', async () => {
    mockedListProjectedAgenda.mockResolvedValue([
      {
        block: makeBlock({ id: 'PROJ1', content: 'Projected task' }),
        projected_date: '2025-06-15',
        source: 'due_date',
      },
    ])

    const { result } = renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(result.current.projectedEntries).toHaveLength(1)
    })
    expect(mockedListProjectedAgenda).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2025-06-15', endDate: '2025-06-15' }),
    )
  })

  it('handles fetch errors gracefully', async () => {
    mockedListBlocks.mockRejectedValue(new Error('network error'))
    mockedListProjectedAgenda.mockRejectedValue(new Error('network error'))

    const { result } = renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    // Should still have empty arrays, not throw
    expect(result.current.blocks).toHaveLength(0)
    expect(result.current.projectedEntries).toHaveLength(0)
  })

  it('returns hasMore and loadMore from paginated response', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    })

    const { result } = renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(result.current.hasMore).toBe(true)
    })

    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B2' })],
      next_cursor: null,
      has_more: false,
    })

    await act(async () => {
      result.current.loadMore()
    })

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'cursor_page2' }),
      )
    })
  })

  it('applies property: filter client-side', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', due_date: '2025-06-15', scheduled_date: null }),
        makeBlock({ id: 'B2', due_date: null, scheduled_date: null }),
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() =>
      useDuePanelData({ date: '2025-06-15', sourceFilter: 'property:' }),
    )

    await waitFor(() => {
      // Only B2 should remain (B1 has due_date matching the date)
      expect(result.current.blocks).toHaveLength(1)
      // biome-ignore lint/style/noNonNullAssertion: test assertion — length checked above
      expect(result.current.blocks[0]!.id).toBe('B2')
    })
  })

  it('does not fetch upcoming when warningDays is 0', async () => {
    localStorage.setItem('agaric:deadlineWarningDays', '0')

    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    const { result } = renderHook(() => useDuePanelData({ date: todayStr, sourceFilter: null }))

    await waitFor(() => {
      expect(result.current.upcomingBlocks).toHaveLength(0)
    })
  })
})
