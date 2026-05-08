/**
 * Tests for useCalendarPageDates hook.
 *
 * Validates:
 *  - Loads pageMap from list_journal_pages_in_range on mount (BUG-48 follow-up)
 *  - highlightedDays derived from page-content YYYY-MM-DD strings
 *  - addPage merges a new entry without re-fetching
 *  - Multiple concurrent subscribers share ONE in-flight fetch (the
 *    perf bug MAINT-119 fixes)
 *  - Toasts on error
 *  - Range parameters threaded through to the IPC call
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCalendarPageDatesForTests, useCalendarPageDates } from '../useCalendarPageDates'

const mockedInvoke = vi.mocked(invoke)

const RANGE = { startDate: '2025-06-01', endDate: '2025-06-30' }

beforeEach(() => {
  vi.clearAllMocks()
  __resetCalendarPageDatesForTests()
  // BUG-48 follow-up: the underlying fetch is `list_journal_pages_in_range`,
  // which returns a flat `BlockRow[]` (not a paginated envelope).
  mockedInvoke.mockResolvedValue([])
})

afterEach(() => {
  __resetCalendarPageDatesForTests()
})

describe('useCalendarPageDates', () => {
  it('starts with empty pageMap and loading=true, then resolves', async () => {
    const { result } = renderHook(() => useCalendarPageDates(RANGE))

    expect(result.current.pageMap.size).toBe(0)
    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('populates pageMap with pages returned by list_journal_pages_in_range', async () => {
    mockedInvoke.mockResolvedValue([
      { id: 'P1', block_type: 'page', content: '2025-06-15' },
      { id: 'P2', block_type: 'page', content: '2025-06-16' },
    ])

    const { result } = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.pageMap.get('2025-06-15')).toBe('P1')
    expect(result.current.pageMap.get('2025-06-16')).toBe('P2')
    expect(result.current.pageMap.size).toBe(2)
  })

  it('passes startDate/endDate/spaceId to the IPC call', async () => {
    renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_journal_pages_in_range',
        expect.objectContaining({
          startDate: '2025-06-01',
          endDate: '2025-06-30',
          spaceId: '',
        }),
      )
    })
  })

  it('exposes highlightedDays derived from pageMap keys', async () => {
    mockedInvoke.mockResolvedValue([{ id: 'P1', block_type: 'page', content: '2025-06-15' }])

    const { result } = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.highlightedDays).toHaveLength(1)
    const [day] = result.current.highlightedDays
    expect(day?.getFullYear()).toBe(2025)
    expect(day?.getMonth()).toBe(5) // 0-indexed June
    expect(day?.getDate()).toBe(15)
  })

  it('addPage merges a new entry into pageMap without re-fetching', async () => {
    const { result } = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const callsBefore = mockedInvoke.mock.calls.length

    act(() => {
      result.current.addPage('2025-06-20', 'PNEW')
    })

    expect(result.current.pageMap.get('2025-06-20')).toBe('PNEW')
    // No additional invoke calls
    expect(mockedInvoke.mock.calls.length).toBe(callsBefore)
  })

  it('addPage is a no-op when the entry already matches', async () => {
    mockedInvoke.mockResolvedValue([{ id: 'P1', block_type: 'page', content: '2025-06-15' }])

    const { result } = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const before = result.current.pageMap

    act(() => {
      result.current.addPage('2025-06-15', 'P1')
    })

    // Same Map reference — no rerender churn for redundant updates
    expect(result.current.pageMap).toBe(before)
  })

  it('two concurrent subscribers with the same range share ONE in-flight fetch', async () => {
    // Render two separate hook instances simultaneously. With the inflight
    // dedupe in place, only one IPC call should fire when the range key
    // matches.
    const a = renderHook(() => useCalendarPageDates(RANGE))
    const b = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(a.result.current.loading).toBe(false)
      expect(b.result.current.loading).toBe(false)
    })

    const fetchCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'list_journal_pages_in_range',
    )
    expect(fetchCalls).toHaveLength(1)
  })

  it('different ranges trigger independent fetches', async () => {
    // Two subscribers asking for different months must each fire their
    // own IPC — the dedupe key includes the date range.
    const a = renderHook(() =>
      useCalendarPageDates({ startDate: '2025-06-01', endDate: '2025-06-30' }),
    )
    const b = renderHook(() =>
      useCalendarPageDates({ startDate: '2025-07-01', endDate: '2025-07-31' }),
    )

    await waitFor(() => {
      expect(a.result.current.loading).toBe(false)
      expect(b.result.current.loading).toBe(false)
    })

    const fetchCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'list_journal_pages_in_range',
    )
    expect(fetchCalls).toHaveLength(2)
  })

  it('issues a single un-paginated fetch (BUG-48)', async () => {
    // BUG-48: replaces the cursor-paginated `list_blocks` loop with a
    // single `list_journal_pages_in_range` call.
    mockedInvoke.mockResolvedValue([
      { id: 'P1', block_type: 'page', content: '2025-06-01' },
      { id: 'P2', block_type: 'page', content: '2025-06-02' },
    ])

    const { result } = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const fetchCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'list_journal_pages_in_range',
    )
    expect(fetchCalls).toHaveLength(1)

    expect(result.current.pageMap.get('2025-06-01')).toBe('P1')
    expect(result.current.pageMap.get('2025-06-02')).toBe('P2')
    expect(result.current.pageMap.size).toBe(2)
  })

  it('shows toast on fetch failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('boom'))

    const { result } = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('calendar'))
  })

  it('subsequent mount after settled fetch issues a fresh fetch', async () => {
    const first = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })

    expect(mockedInvoke.mock.calls.length).toBe(1)

    first.unmount()

    // Wait a microtask so the inflight cleanup has a chance to run
    await Promise.resolve()

    const second = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
    })

    expect(mockedInvoke.mock.calls.length).toBe(2)
  })
})
