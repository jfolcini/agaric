/**
 * Tests for useCalendarPageDates hook.
 *
 * Validates:
 *  - Loads pageMap from listJournalPageDates on mount (BUG-48)
 *  - highlightedDays derived from page-content YYYY-MM-DD strings
 *  - addPage merges a new entry without re-fetching
 *  - Multiple concurrent subscribers share ONE in-flight fetch (the
 *    perf bug MAINT-119 fixes)
 *  - Toasts on error
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCalendarPageDatesForTests, useCalendarPageDates } from '../useCalendarPageDates'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  __resetCalendarPageDatesForTests()
  // BUG-48: the underlying fetch is now `list_journal_page_dates`, which
  // returns a flat `BlockRow[]` (not a paginated envelope).
  mockedInvoke.mockResolvedValue([])
})

afterEach(() => {
  __resetCalendarPageDatesForTests()
})

describe('useCalendarPageDates', () => {
  it('starts with empty pageMap and loading=true, then resolves', async () => {
    const { result } = renderHook(() => useCalendarPageDates())

    expect(result.current.pageMap.size).toBe(0)
    expect(result.current.loading).toBe(true)

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it('populates pageMap with YYYY-MM-DD pages from list_journal_page_dates', async () => {
    mockedInvoke.mockResolvedValue([
      { id: 'P1', block_type: 'page', content: '2025-06-15' },
      { id: 'P2', block_type: 'page', content: '2025-06-16' },
    ])

    const { result } = renderHook(() => useCalendarPageDates())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.pageMap.get('2025-06-15')).toBe('P1')
    expect(result.current.pageMap.get('2025-06-16')).toBe('P2')
    expect(result.current.pageMap.size).toBe(2)
  })

  it('exposes highlightedDays derived from pageMap keys', async () => {
    mockedInvoke.mockResolvedValue([{ id: 'P1', block_type: 'page', content: '2025-06-15' }])

    const { result } = renderHook(() => useCalendarPageDates())

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
    const { result } = renderHook(() => useCalendarPageDates())

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

    const { result } = renderHook(() => useCalendarPageDates())

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

  it('two concurrent subscribers share ONE in-flight fetch', async () => {
    // Render two separate hook instances simultaneously. With the inflight
    // dedupe in place, only one `list_journal_page_dates` IPC should fire.
    const a = renderHook(() => useCalendarPageDates())
    const b = renderHook(() => useCalendarPageDates())

    await waitFor(() => {
      expect(a.result.current.loading).toBe(false)
      expect(b.result.current.loading).toBe(false)
    })

    const fetchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_journal_page_dates')
    expect(fetchCalls).toHaveLength(1)
  })

  it('issues a single un-paginated fetch (BUG-48)', async () => {
    // BUG-48: replaces the cursor-paginated `list_blocks` loop with a
    // single `list_journal_page_dates` call. Guards against a regression
    // that re-introduces pagination on this code path.
    mockedInvoke.mockResolvedValue([
      { id: 'P1', block_type: 'page', content: '2025-06-01' },
      { id: 'P2', block_type: 'page', content: '2025-06-02' },
    ])

    const { result } = renderHook(() => useCalendarPageDates())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const fetchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_journal_page_dates')
    expect(fetchCalls).toHaveLength(1)
    // Argument shape: { spaceId } only — no cursor / limit / blockType.
    expect(fetchCalls[0]?.[1]).toEqual({ spaceId: '' })

    expect(result.current.pageMap.get('2025-06-01')).toBe('P1')
    expect(result.current.pageMap.get('2025-06-02')).toBe('P2')
    expect(result.current.pageMap.size).toBe(2)
  })

  it('shows toast on fetch failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('boom'))

    const { result } = renderHook(() => useCalendarPageDates())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('calendar'))
  })

  it('subsequent mount after settled fetch issues a fresh fetch', async () => {
    const first = renderHook(() => useCalendarPageDates())

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })

    expect(mockedInvoke.mock.calls.length).toBe(1)

    first.unmount()

    // Wait a microtask so the inflight cleanup has a chance to run
    await Promise.resolve()

    const second = renderHook(() => useCalendarPageDates())

    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
    })

    expect(mockedInvoke.mock.calls.length).toBe(2)
  })
})
