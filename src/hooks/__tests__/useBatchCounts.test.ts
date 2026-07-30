import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DayEntry } from '@/lib/date-utils'

const { mockCountAgendaBatchBySource, mockCountBacklinksBatch } = vi.hoisted(() => ({
  mockCountAgendaBatchBySource: vi.fn(),
  mockCountBacklinksBatch: vi.fn(),
}))

vi.mock('@/lib/bindings', () => ({
  commands: {
    countAgendaBatchBySource: (...args: unknown[]) => mockCountAgendaBatchBySource(...args),
    countBacklinksBatch: (...args: unknown[]) => mockCountBacklinksBatch(...args),
  },
}))

import { toast } from 'sonner'

import { useBatchCounts } from '@/hooks/useBatchCounts'
import { toSpaceScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

const mockedCountAgendaBatchBySource = mockCountAgendaBatchBySource
const mockedCountBacklinksBatch = mockCountBacklinksBatch
const mockedToastError = vi.mocked(toast.error)

/** Wrap a resolved value in the bindings `{ status: 'ok', data }` envelope. */
function ok<T>(data: T): { status: 'ok'; data: T } {
  return { status: 'ok', data }
}

function makeDayEntry(dateStr: string, pageId: string | null = null): DayEntry {
  // TEST-FE-5: `displayDate` is intentionally rendered to a HUMAN-FACING format
  // distinct from `dateStr` so any test asserting on `agendaCounts` keys would
  // FAIL if the hook were ever refactored to key by `displayDate` instead of
  // the canonical `dateStr`. Option B (TEST-FE-5) — pairs with
  // the explicit `Object.keys(...).toEqual([...])` assertion below.
  const date = new Date(dateStr)
  const displayDate = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  return {
    date,
    dateStr,
    displayDate,
    pageId,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the space store so each test starts from a clean
  // `currentSpaceId: null` state (cross-space / Global). Tests that
  // exercise the active-space branch set it explicitly.
  useSpaceStore.setState({ currentSpaceId: null })
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

    mockedCountAgendaBatchBySource.mockResolvedValue(
      ok({
        '2025-01-06': { 'column:due_date': 2, 'column:scheduled_date': 1 },
        '2025-01-07': { 'column:due_date': 1 },
      }),
    )
    mockedCountBacklinksBatch.mockResolvedValue(ok({ 'page-1': 5, 'page-2': 2 }))

    const { result } = renderHook(() => useBatchCounts(entries))

    await waitFor(() => {
      expect(result.current.agendaCounts).toEqual({ '2025-01-06': 3, '2025-01-07': 1 })
    })

    // Lock cache-key contract: agendaCounts is keyed by canonical `dateStr`,
    // not the timezone-formatted `displayDate`. Pinning the exact keys here
    // documents the contract for future refactors.
    expect(Object.keys(result.current.agendaCounts)).toEqual(['2025-01-06', '2025-01-07'])

    expect(result.current.agendaCountsBySource).toEqual({
      '2025-01-06': { 'column:due_date': 2, 'column:scheduled_date': 1 },
      '2025-01-07': { 'column:due_date': 1 },
    })
    expect(result.current.backlinkCounts).toEqual({ 'page-1': 5, 'page-2': 2 })
    expect(mockedCountAgendaBatchBySource).toHaveBeenCalledWith(
      ['2025-01-06', '2025-01-07'],
      toSpaceScope(null),
    )
    // SpaceId must be forwarded so badge counts
    // exclude source blocks the user can't see (cross-space).
    expect(mockedCountBacklinksBatch).toHaveBeenCalledWith(['page-1', 'page-2'], toSpaceScope(null))
  })

  it('handles empty entries array', async () => {
    mockedCountAgendaBatchBySource.mockResolvedValue(ok({}))

    const { result } = renderHook(() => useBatchCounts([]))

    await waitFor(() => {
      expect(mockedCountAgendaBatchBySource).toHaveBeenCalledWith([], toSpaceScope(null))
    })

    expect(result.current.agendaCounts).toEqual({})
    expect(result.current.agendaCountsBySource).toEqual({})
    expect(result.current.backlinkCounts).toEqual({})
    expect(mockedCountBacklinksBatch).not.toHaveBeenCalled()
  })

  it('handles entries with no pageIds (skips backlink fetch)', async () => {
    const entries = [makeDayEntry('2025-01-06'), makeDayEntry('2025-01-07')]

    mockedCountAgendaBatchBySource.mockResolvedValue(
      ok({
        '2025-01-06': { 'column:due_date': 1 },
      }),
    )

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
      expect(mockedToastError).toHaveBeenCalledWith(
        expect.stringContaining('calendar counts'),
        // Auto-refreshing journal counts: dedup so date scrubs that
        // repeatedly hit a failing backend don't stack toasts.
        expect.objectContaining({ id: 'journal-load-counts-failed' }),
      )
    })
  })

  it('cancels fetch on unmount (stale state not updated)', async () => {
    // Two sibling hook instances share the same pending promise. Unmounting one
    // and then resolving the promise verifies the resolve path is exercised
    // (the still-mounted sibling MUST receive the update) without the original
    // vacuous post-unmount `result.current` check — React 19 freezes
    // `result.current` at its last pre-unmount value, so asserting it equals
    // the initial empty state passes regardless of whether the hook's
    // `cancelled` guard works. React 19 also silently drops setState calls on
    // unmounted components (no console warning), so a console-spy approach
    // would also be vacuous; the sibling pattern is the strongest non-invasive
    // signal available.
    let resolveAgenda!: (v: { status: 'ok'; data: Record<string, Record<string, number>> }) => void
    const sharedPromise = new Promise<{
      status: 'ok'
      data: Record<string, Record<string, number>>
    }>((resolve) => {
      resolveAgenda = resolve
    })
    mockedCountAgendaBatchBySource.mockImplementation(() => sharedPromise)
    mockedCountBacklinksBatch.mockResolvedValue(ok({ 'page-1': 7 }))

    const entries = [makeDayEntry('2025-01-06', 'page-1')]
    const hookA = renderHook(() => useBatchCounts(entries))
    const hookB = renderHook(() => useBatchCounts(entries))

    // Belt-and-suspenders: catch any future React version that reintroduces
    // an unmounted-state-update warning.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Unmount one sibling before the shared promise resolves
    hookA.unmount()

    // Resolve the shared promise — both hooks' `.then` callbacks run, but only
    // the still-mounted sibling should observably update.
    await act(async () => {
      resolveAgenda(ok({ '2025-01-06': { 'column:due_date': 99 } }))
    })

    await waitFor(() => {
      expect(hookB.result.current.agendaCounts).toEqual({ '2025-01-06': 99 })
    })
    expect(hookB.result.current.agendaCountsBySource).toEqual({
      '2025-01-06': { 'column:due_date': 99 },
    })
    expect(hookB.result.current.backlinkCounts).toEqual({ 'page-1': 7 })

    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
    hookB.unmount()
  })

  // When the active space is set, both batch
  // helpers receive that spaceId so badge counts (and agenda counts)
  // stay scoped to what the user can see.
  it('forwards the active spaceId to countBacklinksBatch', async () => {
    useSpaceStore.setState({ currentSpaceId: 'SPACE_ABC' })

    mockedCountAgendaBatchBySource.mockResolvedValue(ok({}))
    mockedCountBacklinksBatch.mockResolvedValue(ok({ 'page-1': 3 }))

    const entries = [makeDayEntry('2025-01-06', 'page-1')]
    renderHook(() => useBatchCounts(entries))

    await waitFor(() => {
      expect(mockedCountBacklinksBatch).toHaveBeenCalledWith(['page-1'], toSpaceScope('SPACE_ABC'))
    })
    expect(mockedCountAgendaBatchBySource).toHaveBeenCalledWith(
      ['2025-01-06'],
      toSpaceScope('SPACE_ABC'),
    )
  })

  // PERF #1632 — the parent recreates the `entries` array on unrelated
  // renders (e.g. journal page creation churns `makeDayEntry`'s identity).
  // The fetch effect must key on the REAL inputs (date range + page-id set),
  // not the array reference, so a new-but-equivalent `entries` array does NOT
  // re-fire the batch-count IPC — but a genuinely changed date range does.
  it('does not re-fire the IPC when entries is a new array with identical dates/pageIds', async () => {
    mockedCountAgendaBatchBySource.mockResolvedValue(ok({}))
    mockedCountBacklinksBatch.mockResolvedValue(ok({}))

    // Fresh DayEntry objects each render → new array identity, same values.
    const { rerender } = renderHook(() => useBatchCounts([makeDayEntry('2025-01-06', 'page-1')]))

    await waitFor(() => {
      expect(mockedCountAgendaBatchBySource).toHaveBeenCalledTimes(1)
    })

    // Re-render with a brand-new array of equivalent entries (simulates the
    // identity churn from page creation). The IPC must NOT fire again.
    rerender()
    rerender()

    // Give any erroneous effect re-run a chance to fire.
    await Promise.resolve()
    expect(mockedCountAgendaBatchBySource).toHaveBeenCalledTimes(1)
    expect(mockedCountBacklinksBatch).toHaveBeenCalledTimes(1)
  })

  it('re-fires the IPC when the date range actually changes', async () => {
    mockedCountAgendaBatchBySource.mockResolvedValue(ok({}))
    mockedCountBacklinksBatch.mockResolvedValue(ok({}))

    let dateStr = '2025-01-06'
    const { rerender } = renderHook(() => useBatchCounts([makeDayEntry(dateStr)]))

    await waitFor(() => {
      expect(mockedCountAgendaBatchBySource).toHaveBeenCalledTimes(1)
    })

    // A genuinely different date range must trigger a refetch.
    dateStr = '2025-02-06'
    rerender()

    await waitFor(() => {
      expect(mockedCountAgendaBatchBySource).toHaveBeenCalledTimes(2)
    })
    expect(mockedCountAgendaBatchBySource).toHaveBeenLastCalledWith(
      ['2025-02-06'],
      toSpaceScope(null),
    )
  })

  it('re-fires the IPC when a new pageId surfaces (page creation)', async () => {
    mockedCountAgendaBatchBySource.mockResolvedValue(ok({}))
    mockedCountBacklinksBatch.mockResolvedValue(ok({ 'page-1': 4 }))

    // Start with a date that has no page yet, then have one created for it —
    // the backlink fetch must run for the newly-surfaced pageId.
    let pageId: string | null = null
    const { rerender } = renderHook(() => useBatchCounts([makeDayEntry('2025-01-06', pageId)]))

    await waitFor(() => {
      expect(mockedCountAgendaBatchBySource).toHaveBeenCalledTimes(1)
    })
    // No pageId yet → backlink fetch skipped.
    expect(mockedCountBacklinksBatch).not.toHaveBeenCalled()

    pageId = 'page-1'
    rerender()

    await waitFor(() => {
      expect(mockedCountBacklinksBatch).toHaveBeenCalledWith(['page-1'], toSpaceScope(null))
    })
    expect(mockedCountAgendaBatchBySource).toHaveBeenCalledTimes(2)
  })
})
