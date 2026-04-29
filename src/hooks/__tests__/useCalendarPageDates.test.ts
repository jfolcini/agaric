/**
 * Tests for useCalendarPageDates hook.
 *
 * Validates:
 *  - Loads pageMap from listBlocks on mount
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
const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  __resetCalendarPageDatesForTests()
  mockedInvoke.mockResolvedValue(emptyPage)
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

  it('populates pageMap with YYYY-MM-DD pages from listBlocks', async () => {
    mockedInvoke.mockResolvedValue({
      items: [
        { id: 'P1', block_type: 'page', content: '2025-06-15' },
        { id: 'P2', block_type: 'page', content: '2025-06-16' },
        { id: 'P3', block_type: 'page', content: 'Not a date' },
      ],
      next_cursor: null,
      has_more: false,
    })

    const { result } = renderHook(() => useCalendarPageDates())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.pageMap.get('2025-06-15')).toBe('P1')
    expect(result.current.pageMap.get('2025-06-16')).toBe('P2')
    expect(result.current.pageMap.size).toBe(2)
  })

  it('exposes highlightedDays derived from pageMap keys', async () => {
    mockedInvoke.mockResolvedValue({
      items: [{ id: 'P1', block_type: 'page', content: '2025-06-15' }],
      next_cursor: null,
      has_more: false,
    })

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
    mockedInvoke.mockResolvedValue({
      items: [{ id: 'P1', block_type: 'page', content: '2025-06-15' }],
      next_cursor: null,
      has_more: false,
    })

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
    // dedupe in place, only one listBlocks call should be issued.
    const a = renderHook(() => useCalendarPageDates())
    const b = renderHook(() => useCalendarPageDates())

    await waitFor(() => {
      expect(a.result.current.loading).toBe(false)
      expect(b.result.current.loading).toBe(false)
    })

    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(1)
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
