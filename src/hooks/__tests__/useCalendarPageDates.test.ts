/**
 * Tests for useCalendarPageDates hook.
 *
 * Validates:
 * Loads pageMap from list_journal_pages_in_range on mount (follow-up)
 *  - highlightedDays derived from page-content YYYY-MM-DD strings
 *  - addPage merges a new entry without re-fetching
 *  - Multiple concurrent subscribers share ONE in-flight fetch (the
 * Perf bug fixes)
 *  - Toasts on error
 *  - Range parameters threaded through to the IPC call
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetCalendarPageDatesForTests,
  invalidateCalendarPageDates,
  PAGE_DATES_TTL_MS,
  useCalendarPageDates,
} from '@/hooks/useCalendarPageDates'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

/** Count of `list_journal_pages_in_range` IPC round trips so far. */
function fetchCallCount(): number {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_journal_pages_in_range').length
}

const RANGE = { startDate: '2025-06-01', endDate: '2025-06-30' }

const SPACE_ID = 'SPACE_TEST'

beforeEach(() => {
  vi.clearAllMocks()
  __resetCalendarPageDatesForTests()
  // b1 — `list_journal_pages_in_range` is required-active: the hook only
  // fetches when a space is active. Seed one so the mount-fetch path runs.
  useSpaceStore.setState({
    currentSpaceId: SPACE_ID,
    availableSpaces: [{ id: SPACE_ID, name: 'Test', accent_color: null }],
    isReady: true,
  })
  // Follow-up: the underlying fetch is `list_journal_pages_in_range`,
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

  it('passes startDate/endDate/scope to the IPC call', async () => {
    renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_journal_pages_in_range',
        expect.objectContaining({
          startDate: '2025-06-01',
          endDate: '2025-06-30',
          scope: { kind: 'active', space_id: SPACE_ID },
        }),
      )
    })
  })

  it('short-circuits to an empty pageMap with no active space, dispatching nothing (b1)', async () => {
    // b1 — `list_journal_pages_in_range` is required-active. With no active
    // space the hook must not dispatch (a Global scope is rejected by the
    // backend); the pageMap stays empty and loading resolves.
    useSpaceStore.setState({ currentSpaceId: null })

    const { result } = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.pageMap.size).toBe(0)
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_journal_pages_in_range', expect.anything())
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

  it('issues a single un-paginated fetch', async () => {
    // Replaces the cursor-paginated `list_blocks` loop with a
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

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining('calendar'),
      expect.objectContaining({ id: 'journal-load-calendar-failed' }),
    )
  })

  // #3626 — the dedupe used to be in-flight ONLY: the slot was dropped the
  // instant the fetch settled, so a SUCCESSIVE subscriber (the calendar
  // dropdown, which unmounts on close and remounts on reopen) paid a fresh
  // IPC round trip every time. The settled result is now retained per range.
  it('a successive subscriber after the fetch settles reuses the cached result (#3626)', async () => {
    const first = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })

    expect(fetchCallCount()).toBe(1)

    first.unmount()

    // Wait a microtask so the inflight cleanup has a chance to run.
    await Promise.resolve()

    const second = renderHook(() => useCalendarPageDates(RANGE))

    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
    })

    // The count, not merely the data: a fix that re-fetched but rendered the
    // same map would look identical to the user and silently regress.
    expect(fetchCallCount()).toBe(1)
  })

  it('the cached result still carries the fetched page map to the second subscriber (#3626)', async () => {
    mockedInvoke.mockResolvedValue([{ id: 'P1', block_type: 'page', content: '2025-06-15' }])

    const first = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })
    first.unmount()

    const second = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
    })

    expect(second.result.current.pageMap.get('2025-06-15')).toBe('P1')
    expect(fetchCallCount()).toBe(1)
  })

  it('invalidateCalendarPageDates forces the next subscriber to re-fetch (#3626)', async () => {
    const first = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })
    first.unmount()

    act(() => {
      invalidateCalendarPageDates()
    })

    const second = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
    })

    expect(fetchCallCount()).toBe(2)
  })

  it('a fetch in flight when the cache is invalidated does not repopulate it (#3626)', async () => {
    // The epoch guard: a response issued BEFORE the invalidation describes a
    // pre-mutation world and must not be promoted into the cache when it
    // lands, or the invalidation is silently undone by the very request it
    // was racing.
    let release: (rows: unknown[]) => void = () => {}
    mockedInvoke.mockImplementationOnce(
      async () =>
        await new Promise<unknown[]>((resolve) => {
          release = resolve
        }),
    )

    const first = renderHook(() => useCalendarPageDates(RANGE))
    invalidateCalendarPageDates()
    await act(async () => {
      release([])
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })
    first.unmount()

    const second = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
    })

    expect(fetchCallCount()).toBe(2)
  })

  it('a cached range expires after PAGE_DATES_TTL_MS (#3626)', async () => {
    const first = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })
    first.unmount()

    const now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now + PAGE_DATES_TTL_MS + 1)
    try {
      const second = renderHook(() => useCalendarPageDates(RANGE))
      await waitFor(() => {
        expect(second.result.current.loading).toBe(false)
      })
      expect(fetchCallCount()).toBe(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('a rejected fetch is not cached — the next subscriber retries (#3626)', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('boom'))

    const first = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })
    first.unmount()

    const second = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
    })

    expect(fetchCallCount()).toBe(2)
  })

  it('addPage keeps the cache correct instead of invalidating it (#3626)', async () => {
    const first = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(first.result.current.loading).toBe(false)
    })

    act(() => {
      first.result.current.addPage('2025-06-20', 'PNEW')
    })
    first.unmount()

    const second = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(second.result.current.loading).toBe(false)
    })

    // Still one fetch — and the locally created page is there, so the cache
    // is fresh by MERGE rather than by being thrown away.
    expect(fetchCallCount()).toBe(1)
    expect(second.result.current.pageMap.get('2025-06-20')).toBe('PNEW')
  })

  it('addPage does not leak a date into a cached range that excludes it (#3626)', async () => {
    const june = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(june.result.current.loading).toBe(false)
    })

    act(() => {
      june.result.current.addPage('2025-07-04', 'PJULY')
    })
    june.unmount()

    const juneAgain = renderHook(() => useCalendarPageDates(RANGE))
    await waitFor(() => {
      expect(juneAgain.result.current.loading).toBe(false)
    })

    expect(juneAgain.result.current.pageMap.has('2025-07-04')).toBe(false)
  })
})
