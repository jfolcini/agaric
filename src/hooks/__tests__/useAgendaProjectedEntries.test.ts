import { act, renderHook, waitFor } from '@testing-library/react'
import { addDays, format } from 'date-fns'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockedListProjectedAgenda } = vi.hoisted(() => ({ mockedListProjectedAgenda: vi.fn() }))
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listProjectedAgenda: (...args: unknown[]) =>
        mockedListProjectedAgenda(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('@/hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: 0 })),
}))

vi.mock('@/lib/notify', () => ({ notify: { retry: vi.fn() } }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { makeProjectedEntry } from '@/__tests__/fixtures'
import { useAgendaProjectedEntries } from '@/hooks/useAgendaProjectedEntries'
import type { AgendaFilter } from '@/lib/filter-dimension-metadata'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useSpaceStore } from '@/stores/space'

const DEFAULT_FILTERS: AgendaFilter[] = [{ dimension: 'status', values: ['TODO', 'DOING'] }]

const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd')

function page(items: ReturnType<typeof makeProjectedEntry>[], nextCursor: string | null = null) {
  return { items, next_cursor: nextCursor, has_more: nextCursor !== null, total_count: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
})

describe('useAgendaProjectedEntries', () => {
  it('fetches the coming week and keeps the occurrences the filters accept', async () => {
    const inRange = makeProjectedEntry({
      projected_date: day(3),
      block: { id: 'R1', due_date: day(-4) },
    })
    // A `.+` occurrence on the task's own date, which the agenda lists already.
    const onOwnDate = makeProjectedEntry({
      projected_date: day(5),
      block: { id: 'R2', due_date: day(5) },
    })
    const done = makeProjectedEntry({
      projected_date: day(2),
      block: { id: 'R3', due_date: day(-5), todo_state: 'CANCELLED' },
    })
    mockedListProjectedAgenda.mockResolvedValue(page([inRange, onOwnDate, done]))

    const { result } = renderHook(() => useAgendaProjectedEntries(DEFAULT_FILTERS))

    await waitFor(() => expect(result.current.entries).toEqual([inRange]))
    expect(mockedListProjectedAgenda).toHaveBeenCalledExactlyOnceWith(day(0), day(6), null, 100, {
      kind: 'active',
      space_id: 'SPACE_1',
    })
    expect(result.current.hasMore).toBe(false)
  })

  it('pages through the cursor on loadMore', async () => {
    const first = makeProjectedEntry({
      projected_date: day(1),
      block: { id: 'R1', due_date: day(-6) },
    })
    const second = makeProjectedEntry({
      projected_date: day(2),
      block: { id: 'R2', due_date: day(-5) },
    })
    mockedListProjectedAgenda
      .mockResolvedValueOnce(page([first], 'CURSOR_1'))
      .mockResolvedValueOnce(page([second]))

    const { result } = renderHook(() => useAgendaProjectedEntries(DEFAULT_FILTERS))
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    expect(result.current.entries).toEqual([first])

    act(() => result.current.loadMore())

    await waitFor(() => expect(result.current.entries).toEqual([first, second]))
    expect(result.current.hasMore).toBe(false)
    expect(mockedListProjectedAgenda).toHaveBeenLastCalledWith(day(0), day(6), 'CURSOR_1', 100, {
      kind: 'active',
      space_id: 'SPACE_1',
    })
  })

  it('reads past a page the filters reject entirely', async () => {
    const cancelled = makeProjectedEntry({
      projected_date: day(1),
      block: { id: 'R1', due_date: day(-6), todo_state: 'CANCELLED' },
    })
    const accepted = makeProjectedEntry({
      projected_date: day(2),
      block: { id: 'R2', due_date: day(-5) },
    })
    mockedListProjectedAgenda
      .mockResolvedValueOnce(page([cancelled], 'CURSOR_1'))
      .mockResolvedValueOnce(page([accepted]))

    const { result } = renderHook(() => useAgendaProjectedEntries(DEFAULT_FILTERS))

    await waitFor(() => expect(result.current.entries).toEqual([accepted]))
    expect(result.current.hasMore).toBe(false)
    expect(mockedListProjectedAgenda).toHaveBeenCalledTimes(2)
  })

  it('asks nothing under a filter no occurrence can answer', async () => {
    mockedListProjectedAgenda.mockResolvedValue(page([makeProjectedEntry()]))
    const { result } = renderHook(() =>
      useAgendaProjectedEntries([{ dimension: 'tag', values: ['work'] }]),
    )
    // A positive control for the zero-call assertion: the same render with the
    // default filters does ask.
    const control = renderHook(() => useAgendaProjectedEntries(DEFAULT_FILTERS))
    await waitFor(() => expect(mockedListProjectedAgenda).toHaveBeenCalledTimes(1))
    control.unmount()
    // Let the tag-filtered query settle, so a failed one would have reported.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current.entries).toEqual([])
    expect(vi.mocked(notify.retry)).not.toHaveBeenCalled()
    expect(result.current.hasMore).toBe(false)
  })

  it('logs and offers a retry when the IPC rejects', async () => {
    mockedListProjectedAgenda.mockRejectedValue(new Error('backend down'))

    const { result } = renderHook(() => useAgendaProjectedEntries(DEFAULT_FILTERS))

    await waitFor(() =>
      expect(vi.mocked(notify.retry)).toHaveBeenCalledWith(
        t('agenda.loadProjectedFailed'),
        expect.any(Function),
        { id: 'agenda-projected-failed' },
      ),
    )
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'useAgendaProjectedEntries',
      'projected agenda fetch failed',
      undefined,
      expect.any(Error),
    )
    expect(result.current.entries).toEqual([])
  })
})
