import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DayEntry } from '../../lib/date-utils'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('../../lib/tauri', () => ({
  countAgendaBatch: vi.fn(),
  countBacklinksBatch: vi.fn(),
}))

import { toast } from 'sonner'
import { countAgendaBatch, countBacklinksBatch } from '../../lib/tauri'
import { useBatchCounts } from '../useBatchCounts'

const mockedCountAgendaBatch = vi.mocked(countAgendaBatch)
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
    mockedCountAgendaBatch.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useBatchCounts([]))
    expect(result.current.agendaCounts).toEqual({})
    expect(result.current.backlinkCounts).toEqual({})
  })

  it('fetches and returns agenda + backlink counts', async () => {
    const entries = [makeDayEntry('2025-01-06', 'page-1'), makeDayEntry('2025-01-07', 'page-2')]

    mockedCountAgendaBatch.mockResolvedValue({ '2025-01-06': 3, '2025-01-07': 1 })
    mockedCountBacklinksBatch.mockResolvedValue({ 'page-1': 5, 'page-2': 2 })

    const { result } = renderHook(() => useBatchCounts(entries))

    await waitFor(() => {
      expect(result.current.agendaCounts).toEqual({ '2025-01-06': 3, '2025-01-07': 1 })
    })

    expect(result.current.backlinkCounts).toEqual({ 'page-1': 5, 'page-2': 2 })
    expect(mockedCountAgendaBatch).toHaveBeenCalledWith({ dates: ['2025-01-06', '2025-01-07'] })
    expect(mockedCountBacklinksBatch).toHaveBeenCalledWith({ pageIds: ['page-1', 'page-2'] })
  })

  it('handles empty entries array', async () => {
    mockedCountAgendaBatch.mockResolvedValue({})

    const { result } = renderHook(() => useBatchCounts([]))

    await waitFor(() => {
      expect(mockedCountAgendaBatch).toHaveBeenCalledWith({ dates: [] })
    })

    expect(result.current.agendaCounts).toEqual({})
    expect(result.current.backlinkCounts).toEqual({})
    expect(mockedCountBacklinksBatch).not.toHaveBeenCalled()
  })

  it('handles entries with no pageIds (skips backlink fetch)', async () => {
    const entries = [makeDayEntry('2025-01-06'), makeDayEntry('2025-01-07')]

    mockedCountAgendaBatch.mockResolvedValue({ '2025-01-06': 1 })

    const { result } = renderHook(() => useBatchCounts(entries))

    await waitFor(() => {
      expect(result.current.agendaCounts).toEqual({ '2025-01-06': 1 })
    })

    expect(result.current.backlinkCounts).toEqual({})
    expect(mockedCountBacklinksBatch).not.toHaveBeenCalled()
  })

  it('shows error toast on failure', async () => {
    mockedCountAgendaBatch.mockRejectedValue(new Error('network error'))

    renderHook(() => useBatchCounts([makeDayEntry('2025-01-06')]))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('journal.loadCountsFailed')
    })
  })

  it('cancels fetch on unmount (stale state not updated)', async () => {
    let resolveAgenda!: (v: Record<string, number>) => void
    mockedCountAgendaBatch.mockImplementation(
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
      resolveAgenda({ '2025-01-06': 99 })
    })

    // The hook was unmounted, so we verify the last known state was still empty
    expect(result.current.agendaCounts).toEqual({})
    expect(result.current.backlinkCounts).toEqual({})
  })
})
