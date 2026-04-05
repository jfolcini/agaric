import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DayEntry } from '../../lib/date-utils'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('../../lib/tauri', () => ({
  countAgendaBatchBySource: vi.fn(),
  countBacklinksBatch: vi.fn(),
}))

import { toast } from 'sonner'
import { countAgendaBatchBySource, countBacklinksBatch } from '../../lib/tauri'
import { useBatchCounts } from '../useBatchCounts'

const mockedCountAgendaBatchBySource = vi.mocked(countAgendaBatchBySource)
const mockedCountBacklinksBatch = vi.mocked(countBacklinksBatch)
const mockedToastError = vi.mocked(toast.error)

function makeDayEntry(dateStr: string, pageId: string | null = null): DayEntry {
  return {
    date: new Date(dateStr),
    dateStr,
    displayDate: dateStr,
    pageId,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useBatchCounts', () => {
  it('returns empty counts initially', () => {
    mockedCountAgendaBatchBySource.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useBatchCounts([]))
    expect(result.current.agendaCounts).toEqual({})
    expect(result.current.agendaCountsBySource).toEqual({})
    expect(result.current.backlinkCounts).toEqual({})
  })

  it('fetches and returns agenda + backlink counts', async () => {
    const entries = [makeDayEntry('2025-01-06', 'page-1'), makeDayEntry('2025-01-07', 'page-2')]

    mockedCountAgendaBatchBySource.mockResolvedValue({
      '2025-01-06': { 'column:due_date': 2, 'column:scheduled_date': 1 },
      '2025-01-07': { 'column:due_date': 1 },
    })
    mockedCountBacklinksBatch.mockResolvedValue({ 'page-1': 5, 'page-2': 2 })

    const { result } = renderHook(() => useBatchCounts(entries))

    await waitFor(() => {
      expect(result.current.agendaCounts).toEqual({ '2025-01-06': 3, '2025-01-07': 1 })
    })

    expect(result.current.agendaCountsBySource).toEqual({
      '2025-01-06': { 'column:due_date': 2, 'column:scheduled_date': 1 },
      '2025-01-07': { 'column:due_date': 1 },
    })
    expect(result.current.backlinkCounts).toEqual({ 'page-1': 5, 'page-2': 2 })
    expect(mockedCountAgendaBatchBySource).toHaveBeenCalledWith({
      dates: ['2025-01-06', '2025-01-07'],
    })
    expect(mockedCountBacklinksBatch).toHaveBeenCalledWith({ pageIds: ['page-1', 'page-2'] })
  })

  it('handles empty entries array', async () => {
    mockedCountAgendaBatchBySource.mockResolvedValue({})

    const { result } = renderHook(() => useBatchCounts([]))

    await waitFor(() => {
      expect(mockedCountAgendaBatchBySource).toHaveBeenCalledWith({ dates: [] })
    })

    expect(result.current.agendaCounts).toEqual({})
    expect(result.current.agendaCountsBySource).toEqual({})
    expect(result.current.backlinkCounts).toEqual({})
    expect(mockedCountBacklinksBatch).not.toHaveBeenCalled()
  })

  it('handles entries with no pageIds (skips backlink fetch)', async () => {
    const entries = [makeDayEntry('2025-01-06'), makeDayEntry('2025-01-07')]

    mockedCountAgendaBatchBySource.mockResolvedValue({
      '2025-01-06': { 'column:due_date': 1 },
    })

    const { result } = renderHook(() => useBatchCounts(entries))

    await waitFor(() => {
      expect(result.current.agendaCounts).toEqual({ '2025-01-06': 1 })
    })

    expect(result.current.backlinkCounts).toEqual({})
    expect(mockedCountBacklinksBatch).not.toHaveBeenCalled()
  })

  it('shows error toast on failure', async () => {
    mockedCountAgendaBatchBySource.mockRejectedValue(new Error('network error'))

    renderHook(() => useBatchCounts([makeDayEntry('2025-01-06')]))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('journal.loadCountsFailed')
    })
  })

  it('cancels fetch on unmount (stale state not updated)', async () => {
    let resolveAgenda!: (v: Record<string, Record<string, number>>) => void
    mockedCountAgendaBatchBySource.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAgenda = resolve
        }),
    )
    mockedCountBacklinksBatch.mockResolvedValue({})

    const entries = [makeDayEntry('2025-01-06', 'page-1')]
    const { result, unmount } = renderHook(() => useBatchCounts(entries))

    // Unmount before the promise resolves
    unmount()

    // Now resolve the promise — state should NOT update because cancelled = true
    await act(async () => {
      resolveAgenda({ '2025-01-06': { 'column:due_date': 99 } })
    })

    // The hook was unmounted, so we verify the last known state was still empty
    expect(result.current.agendaCounts).toEqual({})
    expect(result.current.agendaCountsBySource).toEqual({})
    expect(result.current.backlinkCounts).toEqual({})
  })
})
