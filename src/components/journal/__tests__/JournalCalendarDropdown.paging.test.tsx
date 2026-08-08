/**
 * Tests for JournalCalendarDropdown month paging (#3340).
 *
 * The picker used to be UNCONTROLLED (`defaultMonth={currentDate}`) while
 * react-day-picker's prev/next chevrons were rendered, and every indicator
 * fetch was keyed on `currentDate`'s month. Paging therefore swapped the grid
 * to a month whose page / due / scheduled / property dots had never been
 * fetched, and `aria-busy` stayed false throughout so nothing signalled that
 * the dots were missing rather than genuinely absent.
 *
 * These tests deliberately render the REAL `@/components/ui/calendar` (no
 * component mock) and click the REAL chevron, so they exercise the same
 * `month` / `onMonthChange` wiring the user drives.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { JournalCalendarDropdown } from '@/components/journal/JournalCalendarDropdown'
import { __resetCalendarPageDatesForTests } from '@/hooks/useCalendarPageDates'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: 0 })),
}))

const mockedInvoke = vi.mocked(invoke)

/** The dropdown opens on 2026-07-15, so the grid starts in July 2026. */
const CURRENT_DATE = new Date(2026, 6, 15)

/**
 * A mid-August day. It is the load-bearing date in this file: it lies OUTSIDE
 * the 42-day window anchored on July (that window ends in the first week of
 * August), so it can only appear in a fetch that was re-keyed to the month the
 * user paged to.
 */
const AUGUST_DAY = '2026-08-20'

const defaultProps = {
  currentDate: CURRENT_DATE,
  onSelectDate: vi.fn(),
  onSelectWeek: vi.fn(),
  onSelectMonth: vi.fn(),
  onClose: vi.fn(),
}

/** Every `count_agenda_batch_by_source` call's `dates` payload, in call order. */
function agendaFetchWindows(): string[][] {
  return mockedInvoke.mock.calls
    .filter(([command]) => command === 'count_agenda_batch_by_source')
    .map(([, args]) => (args as { dates: string[] }).dates)
}

/** Every `list_journal_pages_in_range` call's range, in call order. */
function pageRangeFetches(): Array<{ startDate: string; endDate: string }> {
  return mockedInvoke.mock.calls
    .filter(([command]) => command === 'list_journal_pages_in_range')
    .map(([, args]) => args as { startDate: string; endDate: string })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  __resetCalendarPageDatesForTests()
  // `list_journal_pages_in_range` is required-active, so the journal-page
  // highlight fetch only runs with a seeded space.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      count_agenda_batch_by_source: () => ({}),
      list_journal_pages_in_range: () => [],
    }),
  )
})

afterEach(() => {
  useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: false })
})

/** Click react-day-picker's real next-month chevron. */
async function pageToNextMonth(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /next month/i }))
}

describe('JournalCalendarDropdown month paging (#3340)', () => {
  it('refetches the agenda indicators for the month the user paged to', async () => {
    const user = userEvent.setup()
    render(<JournalCalendarDropdown {...defaultProps} />)

    await waitFor(() => {
      expect(agendaFetchWindows()).toHaveLength(1)
    })

    // The opening window is anchored on July and stops in the first week of
    // August — mid-August was never fetched.
    const julyWindow = agendaFetchWindows()[0] as string[]
    expect(julyWindow).toHaveLength(42)
    expect(julyWindow).toContain('2026-07-15')
    expect(julyWindow).not.toContain(AUGUST_DAY)

    await pageToNextMonth(user)

    // Paging must issue a SECOND fetch, for August's own 42-day window.
    await waitFor(() => {
      expect(agendaFetchWindows()).toHaveLength(2)
    })
    const augustWindow = agendaFetchWindows()[1] as string[]
    expect(augustWindow).toHaveLength(42)
    expect(augustWindow).toContain(AUGUST_DAY)
    expect(augustWindow).toContain('2026-08-31')
  })

  it('refetches the journal-page highlights for the month the user paged to', async () => {
    const user = userEvent.setup()
    render(<JournalCalendarDropdown {...defaultProps} />)

    await waitFor(() => {
      expect(pageRangeFetches()).toHaveLength(1)
    })
    expect(pageRangeFetches()[0]?.endDate.startsWith('2026-08')).toBe(true)

    await pageToNextMonth(user)

    // `highlightedDays` used to be computed by the CALLER off `currentDate`,
    // which cannot see the paged-to month at all.
    await waitFor(() => {
      expect(pageRangeFetches()).toHaveLength(2)
    })
    const augustRange = pageRangeFetches()[1]
    expect(augustRange?.startDate.startsWith('2026-07')).toBe(true)
    expect(augustRange?.endDate.startsWith('2026-09')).toBe(true)
  })

  it('re-arms aria-busy while the paged-to month is loading, then clears it', async () => {
    const user = userEvent.setup()
    let releaseAugust: (data: Record<string, Record<string, number>>) => void = () => {}
    const pendingAugust = new Promise<Record<string, Record<string, number>>>((resolve) => {
      releaseAugust = resolve
    })
    let agendaCall = 0
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        count_agenda_batch_by_source: () => (agendaCall++ === 0 ? {} : pendingAugust),
        list_journal_pages_in_range: () => [],
      }),
    )

    render(<JournalCalendarDropdown {...defaultProps} />)

    const dialog = screen.getByRole('dialog', { name: /date picker/i })
    await waitFor(() => {
      expect(dialog).toHaveAttribute('aria-busy', 'false')
    })

    await pageToNextMonth(user)

    // The paged-to fetch must re-arm the busy state — previously nothing did,
    // so a month with no dots was indistinguishable from a month with no data.
    await waitFor(() => {
      expect(dialog).toHaveAttribute('aria-busy', 'true')
    })

    releaseAugust({})

    await waitFor(() => {
      expect(dialog).toHaveAttribute('aria-busy', 'false')
    })
  })

  it('renders the paged-to month dots that only the second fetch could supply', async () => {
    const user = userEvent.setup()
    let agendaCall = 0
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        count_agenda_batch_by_source: () =>
          agendaCall++ === 0 ? {} : { [AUGUST_DAY]: { 'column:due_date': 2 } },
        list_journal_pages_in_range: () => [],
      }),
    )

    render(<JournalCalendarDropdown {...defaultProps} />)
    await waitFor(() => {
      expect(agendaFetchWindows()).toHaveLength(1)
    })

    await pageToNextMonth(user)

    // The August 20 grid cell must carry a real dot indicator. With the
    // indicators pinned to July's window this cell renders bare.
    const augustCell = await screen.findByRole('button', { name: /august 20th, 2026/i })
    await waitFor(() => {
      expect(within(augustCell).queryByTestId('calendar-dots')).not.toBeNull()
    })
  })

  it('has no a11y violations after paging to the next month', async () => {
    const user = userEvent.setup()
    const { container } = render(<JournalCalendarDropdown {...defaultProps} />)

    await waitFor(() => {
      expect(agendaFetchWindows()).toHaveLength(1)
    })
    await pageToNextMonth(user)
    await waitFor(() => {
      expect(agendaFetchWindows()).toHaveLength(2)
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
