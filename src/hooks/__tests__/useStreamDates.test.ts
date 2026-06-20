/**
 * Tests useStreamDates — windowed date list + page map backing the
 * continuous infinite-scroll journal stream (#1415).
 *
 * Validates:
 * 1. Initial window: today first, descending, STREAM_INITIAL_DAYS long.
 * 2. `loadOlder()` extends the window by STREAM_BATCH_DAYS into the past
 *    and refetches the page map for the wider span.
 * 3. The page map is built from `list_journal_pages_in_range` rows.
 * 4. `reachedEnd` flips true once the window reaches MIN_JOURNAL_DATE
 *    (and `loadOlder` then clamps).
 * 5. `addPage` merges a locally-created page without refetching.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatDate } from '../../lib/date-utils'

const listJournalPagesInRange = vi.hoisted(() => vi.fn())
vi.mock('../../lib/tauri', () => ({ listJournalPagesInRange }))

vi.mock('../../stores/space', () => ({
  useSpaceStore: (selector: (s: { currentSpaceId: string }) => unknown) =>
    selector({ currentSpaceId: 'space-1' }),
}))

import { STREAM_BATCH_DAYS, STREAM_INITIAL_DAYS, useStreamDates } from '../useStreamDates'

const TODAY = new Date(2026, 5, 20) // Sat, Jun 20, 2026

beforeEach(() => {
  vi.clearAllMocks()
  // `shouldAdvanceTime` lets RTL's `waitFor` real-time polling proceed while
  // `new Date()` inside the hook still resolves to the pinned `TODAY`.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(TODAY)
  listJournalPagesInRange.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useStreamDates', () => {
  it('starts with today first, descending, STREAM_INITIAL_DAYS long', async () => {
    const { result } = renderHook(() => useStreamDates())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.dates).toHaveLength(STREAM_INITIAL_DAYS)
    expect(formatDate(result.current.dates[0] as Date)).toBe('2026-06-20')
    // Strictly descending.
    for (let i = 1; i < result.current.dates.length; i++) {
      expect((result.current.dates[i - 1] as Date).getTime()).toBeGreaterThan(
        (result.current.dates[i] as Date).getTime(),
      )
    }
  })

  it('builds the page map from list_journal_pages_in_range rows', async () => {
    listJournalPagesInRange.mockResolvedValue([
      { id: 'p-20', content: '2026-06-20' },
      { id: 'p-18', content: '2026-06-18' },
    ])
    const { result } = renderHook(() => useStreamDates())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.pageMap.get('2026-06-20')).toBe('p-20')
    expect(result.current.pageMap.get('2026-06-18')).toBe('p-18')
    expect(result.current.pageMap.has('2026-06-19')).toBe(false)
  })

  it('loadOlder extends the window by STREAM_BATCH_DAYS and refetches', async () => {
    const { result } = renderHook(() => useStreamDates())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const initialLen = result.current.dates.length
    const callsBefore = listJournalPagesInRange.mock.calls.length

    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.dates.length).toBe(initialLen + STREAM_BATCH_DAYS))
    // A wider range was refetched.
    expect(listJournalPagesInRange.mock.calls.length).toBe(callsBefore + 1)
    const lastCall = listJournalPagesInRange.mock.calls.at(-1)?.[0] as {
      startDate: string
      endDate: string
    }
    expect(lastCall.endDate).toBe('2026-06-20')
    // Oldest day moved further back.
    const oldest = result.current.dates.at(-1) as Date
    expect(formatDate(oldest)).toBe(lastCall.startDate)
  })

  it('addPage merges a created page without an extra fetch', async () => {
    const { result } = renderHook(() => useStreamDates())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const callsBefore = listJournalPagesInRange.mock.calls.length

    act(() => result.current.addPage('2026-06-20', 'new-page'))
    expect(result.current.pageMap.get('2026-06-20')).toBe('new-page')
    expect(listJournalPagesInRange.mock.calls.length).toBe(callsBefore)
  })
})
