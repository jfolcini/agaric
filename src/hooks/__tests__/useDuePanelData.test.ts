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
  paginationLimit: (n: number) => n,
  listProjectedAgendaLimit: (n: number) => n,
  listBlocksLimit: (n: number) => n,
}))

let mockInvalidationKey = 0
vi.mock('../useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: mockInvalidationKey })),
}))

import { makeBlock } from '../../__tests__/fixtures'
import { logger } from '../../lib/logger'
import { batchResolve, listBlocks, listProjectedAgenda, queryByProperty } from '../../lib/tauri'
import { useBlockPropertyEvents } from '../useBlockPropertyEvents'
import { clearProjectedCache, extractUlidRefs, useDuePanelData } from '../useDuePanelData'

const mockedListBlocks = vi.mocked(listBlocks)
const mockedBatchResolve = vi.mocked(batchResolve)
const mockedListProjectedAgenda = vi.mocked(listProjectedAgenda)
const mockedQueryByProperty = vi.mocked(queryByProperty)
const mockedUseBlockPropertyEvents = vi.mocked(useBlockPropertyEvents)

const emptyResponse = {
  items: [],
  next_cursor: null,
  has_more: false,
  total_count: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearProjectedCache()
  mockInvalidationKey = 0
  mockedListBlocks.mockResolvedValue(emptyResponse)
  mockedBatchResolve.mockResolvedValue([])
  mockedListProjectedAgenda.mockResolvedValue({
    items: [],
    next_cursor: null,
    has_more: false,
    total_count: null,
  })
  mockedQueryByProperty.mockResolvedValue(emptyResponse)
  // TEST-31: Freeze Date only (not setTimeout/setInterval — waitFor and
  // renderHook rely on real timers). Prevents midnight-boundary flakes
  // where the test's `new Date()` crosses a day boundary mid-assertion.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-04-15T12:00:00Z'))
})

afterEach(() => {
  localStorage.clear()
  vi.useRealTimers()
})

describe('useDuePanelData', () => {
  it('fetches blocks on mount', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
      resolveBlocks({ items: [], next_cursor: null, has_more: false, total_count: null })
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('resolves page titles via batchResolve', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
    mockedListProjectedAgenda.mockResolvedValue({
      items: [
        {
          block: makeBlock({ id: 'PROJ1', content: 'Projected task' }),
          projected_date: '2025-06-15',
          source: 'due_date',
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

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
      total_count: null,
    })

    const { result } = renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(result.current.hasMore).toBe(true)
    })

    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B2' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    await act(async () => {
      result.current.loadMore()
    })

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'cursor_page2' }),
      )
    })

    // PEND-27 P4 — the merged paginated list reads through `blocksRef`
    // (no `blocks` in the deps array). The post-load state must contain
    // BOTH pages' items, in order, to prove the ref is fresh by the time
    // the second `fetchBlocks` runs.
    await waitFor(() => {
      expect(result.current.blocks.map((b) => b.id)).toEqual(['B1', 'B2'])
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
      total_count: null,
    })

    const { result } = renderHook(() =>
      useDuePanelData({ date: '2025-06-15', sourceFilter: 'property:' }),
    )

    await waitFor(() => {
      // Only B2 should remain (B1 has due_date matching the date)
      expect(result.current.blocks).toHaveLength(1)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- test assertion — length checked above
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

  it('filters out blocks with empty content (UX-129)', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'real task' }),
        makeBlock({ id: 'B2', content: null }),
        makeBlock({ id: 'B3', content: '' }),
        makeBlock({ id: 'B4', content: '   ' }),
        makeBlock({ id: 'B5', content: 'another task' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result } = renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(result.current.blocks).toHaveLength(2)
    })
    expect(result.current.blocks[0]?.id).toBe('B1')
    expect(result.current.blocks[1]?.id).toBe('B5')
    expect(result.current.totalCount).toBe(2)
  })

  it('re-fetches blocks when invalidationKey changes (B-50/F-39)', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', todo_state: 'TODO' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result, rerender } = renderHook(() =>
      useDuePanelData({ date: '2025-06-15', sourceFilter: null }),
    )

    await waitFor(() => {
      expect(result.current.blocks).toHaveLength(1)
    })

    // Clear and prepare updated response (block now DONE)
    mockedListBlocks.mockClear()
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', todo_state: 'DONE' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    // Simulate property change event by bumping invalidationKey
    mockInvalidationKey = 1
    mockedUseBlockPropertyEvents.mockReturnValue({ invalidationKey: 1 })
    rerender()

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(result.current.blocks[0]?.todo_state).toBe('DONE')
    })
  })

  it('sets loading=true synchronously when sourceFilter changes (B-51)', async () => {
    // First render: return blocks so loading settles to false
    mockedListBlocks.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { result, rerender } = renderHook(
      ({ sourceFilter }) => useDuePanelData({ date: '2025-06-15', sourceFilter }),
      { initialProps: { sourceFilter: null as string | null } },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.blocks).toHaveLength(1)
    })

    // Mock listBlocks to return a never-resolving promise so we can observe
    // the intermediate synchronous state before the async fetch completes.
    mockedListBlocks.mockReturnValue(new Promise(() => {}) as ReturnType<typeof listBlocks>)

    // Change the filter — the useEffect should setLoading(true) synchronously
    rerender({ sourceFilter: 'column:due_date' })

    // On the very next render, loading must be true even though the async
    // doFetch hasn't run yet. This prevents the panel from disappearing.
    expect(result.current.loading).toBe(true)
  })

  it('includes ULID refs from block content in batchResolve call (B-53)', async () => {
    const ULID_A = '01ABCDEFGHJKLMNPQRSTUVWXYZ'
    const ULID_B = '01ZYXWVUTSRQPNMLKJHGFEDCBA'

    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({
          id: 'B1',
          parent_id: 'PAGE1',
          page_id: 'PAGE1',
          content: `Link to [[${ULID_A}]] and tag #[${ULID_B}]`,
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Parent Page', block_type: 'page', deleted: false },
      { id: ULID_A, title: 'Linked Page', block_type: 'page', deleted: false },
      { id: ULID_B, title: 'Tag Page', block_type: 'page', deleted: false },
    ])

    renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalled()
    })

    const resolvedIds = mockedBatchResolve.mock.calls[0]?.[0] as string[]
    expect(resolvedIds).toContain('PAGE1')
    expect(resolvedIds).toContain(ULID_A)
    expect(resolvedIds).toContain(ULID_B)
  })

  it('extractUlidRefs extracts all reference types', () => {
    const content =
      'See [[01ABCDEFGHJKLMNPQRSTUVWXYZ]] and #[01ZYXWVUTSRQPNMLKJHGFEDCBA] and ((01AAAAAAAAAAAAAAAAAAAAAAAA))'
    const refs = extractUlidRefs(content)
    expect(refs).toHaveLength(3)
    expect(refs).toContain('01ABCDEFGHJKLMNPQRSTUVWXYZ')
    expect(refs).toContain('01ZYXWVUTSRQPNMLKJHGFEDCBA')
    expect(refs).toContain('01AAAAAAAAAAAAAAAAAAAAAAAA')
  })

  it('extractUlidRefs returns empty array for content without refs', () => {
    expect(extractUlidRefs('plain text content')).toHaveLength(0)
    expect(extractUlidRefs('')).toHaveLength(0)
  })

  it('overdue batchResolve includes content ULIDs (B-55)', async () => {
    const ULID_REF = '01ABCDEFGHJKLMNPQRSTUVWXYZ'
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`

    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({
          id: 'OD1',
          parent_id: 'POVER',
          page_id: 'POVER',
          due_date: yesterdayStr,
          todo_state: 'TODO',
          content: `Overdue ref [[${ULID_REF}]]`,
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'POVER', title: 'Overdue Parent', block_type: 'page', deleted: false },
      { id: ULID_REF, title: 'Ref Page', block_type: 'page', deleted: false },
    ])

    renderHook(() => useDuePanelData({ date: todayStr, sourceFilter: null }))

    await waitFor(() => {
      // Find the batchResolve call that includes 'POVER' (overdue effect)
      const overdueCall = mockedBatchResolve.mock.calls.find(
        (args) => Array.isArray(args[0]) && (args[0] as string[]).includes('POVER'),
      )
      expect(overdueCall).toBeDefined()
      const resolvedIds = overdueCall?.[0] as string[]
      expect(resolvedIds).toContain('POVER')
      expect(resolvedIds).toContain(ULID_REF)
    })
  })

  it('upcoming batchResolve includes content ULIDs (B-55)', async () => {
    const ULID_REF = '01ABCDEFGHJKLMNPQRSTUVWXYZ'
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    localStorage.setItem('agaric:deadlineWarningDays', '7')

    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({
          id: 'UP1',
          parent_id: 'PUPCOMING',
          page_id: 'PUPCOMING',
          due_date: tomorrowStr,
          todo_state: 'TODO',
          content: `Upcoming ref [[${ULID_REF}]]`,
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PUPCOMING', title: 'Upcoming Parent', block_type: 'page', deleted: false },
      { id: ULID_REF, title: 'Ref Page', block_type: 'page', deleted: false },
    ])

    renderHook(() => useDuePanelData({ date: todayStr, sourceFilter: null }))

    await waitFor(() => {
      const upcomingCall = mockedBatchResolve.mock.calls.find(
        (args) => Array.isArray(args[0]) && (args[0] as string[]).includes('PUPCOMING'),
      )
      expect(upcomingCall).toBeDefined()
      const resolvedIds = upcomingCall?.[0] as string[]
      expect(resolvedIds).toContain('PUPCOMING')
      expect(resolvedIds).toContain(ULID_REF)
    })
  })

  it('projected batchResolve includes content ULIDs (B-55)', async () => {
    const ULID_REF = '01ABCDEFGHJKLMNPQRSTUVWXYZ'

    mockedListProjectedAgenda.mockResolvedValue({
      items: [
        {
          block: makeBlock({
            id: 'PROJ1',
            parent_id: 'PPROJ',
            page_id: 'PPROJ',
            content: `Projected ref [[${ULID_REF}]]`,
          }),
          projected_date: '2025-06-15',
          source: 'due_date',
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PPROJ', title: 'Projected Parent', block_type: 'page', deleted: false },
      { id: ULID_REF, title: 'Ref Page', block_type: 'page', deleted: false },
    ])

    renderHook(() => useDuePanelData({ date: '2025-06-15', sourceFilter: null }))

    await waitFor(() => {
      const projectedCall = mockedBatchResolve.mock.calls.find(
        (args) => Array.isArray(args[0]) && (args[0] as string[]).includes('PPROJ'),
      )
      expect(projectedCall).toBeDefined()
      const resolvedIds = projectedCall?.[0] as string[]
      expect(resolvedIds).toContain('PPROJ')
      expect(resolvedIds).toContain(ULID_REF)
    })
  })

  it('logs overdue and upcoming fetch failures via logger.warn (FE-M-1)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    localStorage.setItem('agaric:deadlineWarningDays', '7')

    // Both effects run only when date === today, and upcoming additionally
    // requires warningDays > 0. Both share the same queryByProperty IPC,
    // so a single rejection drives both bare catch blocks.
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const fetchErr = new Error('queryByProperty boom')
    mockedQueryByProperty.mockRejectedValue(fetchErr)

    renderHook(() => useDuePanelData({ date: todayStr, sourceFilter: null }))

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        'useDuePanelData',
        'overdue fetch failed',
        { date: todayStr },
        fetchErr,
      )
      expect(warnSpy).toHaveBeenCalledWith(
        'useDuePanelData',
        'upcoming fetch failed',
        { date: todayStr, warningDays: 7 },
        fetchErr,
      )
    })

    warnSpy.mockRestore()
  })

  it('skips inner agenda catch side-effects after unmount (FE-M-2)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    // Outer listProjectedAgenda resolves so we enter the .then branch and
    // reach the nested resolveAndMergeTitles().catch(...) site.
    mockedListProjectedAgenda.mockResolvedValue({
      items: [
        {
          block: makeBlock({
            id: 'PROJ1',
            parent_id: 'PPROJ',
            page_id: 'PPROJ',
            content: 'projected task',
          }),
          projected_date: '2025-06-15',
          source: 'due_date',
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    // Hold batchResolve pending so we can unmount before the inner
    // resolveAndMergeTitles promise rejects.
    let rejectBatch!: (e: unknown) => void
    mockedBatchResolve.mockReturnValue(
      new Promise((_, rej) => {
        rejectBatch = rej
      }) as ReturnType<typeof batchResolve>,
    )

    const { unmount } = renderHook(() =>
      useDuePanelData({ date: '2025-06-15', sourceFilter: null }),
    )

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalled()
    })

    // Unmount marks stale = true; reject afterwards to fire the inner .catch.
    unmount()
    rejectBatch(new Error('nested fail'))

    // Flush microtasks so the rejection propagates to the .catch handler.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const nestedCalls = warnSpy.mock.calls.filter((c) => c[1] === 'nested agenda fetch failed')
    expect(nestedCalls).toHaveLength(0)

    warnSpy.mockRestore()
  })
})
