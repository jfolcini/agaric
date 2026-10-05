/**
 * Tests for JournalControls component.
 *
 * Validates:
 *  - Renders mode tabs, prev/next buttons, today, agenda, calendar
 *  - prev/next mutates currentDate based on mode
 *  - calendar dropdown opens on icon click
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { format } from 'date-fns'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { stubInvoke } from '@/__tests__/helpers/invoke'
import { JournalControls } from '@/components/journal/JournalControls'
import { __resetCalendarPageDatesForTests } from '@/hooks/useCalendarPageDates'
import { resetAllShortcuts, setCustomShortcut } from '@/lib/keyboard-config'
import { useJournalStore } from '@/stores/journal'
import { useSpaceStore } from '@/stores/space'

// Calendar mock — the real react-day-picker Calendar warns about unrecognised
// props on a plain <div>; we only care that *something* is rendered.
vi.mock('@/components/ui/calendar', () => ({
  Calendar: () => <div data-testid="mock-calendar">Calendar</div>,
}))

const mockedInvoke = vi.mocked(invoke)

/** Count of `list_journal_pages_in_range` IPC round trips so far. */
function pageRangeFetchCount(): number {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_journal_pages_in_range').length
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAllShortcuts()
  __resetCalendarPageDatesForTests()
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2025, 5, 15),
    scrollToDate: null,
    scrollToPanel: null,
  })
  // b1 — `list_journal_pages_in_range` is required-active; seed an active
  // space so the calendar-highlight mount fetch runs.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  // The two commands the controls fire on mount: the calendar-highlight page
  // fetch (a flat `BlockRow[]`, no pagination envelope) and the dropdown's
  // per-date agenda counts. Anything else fails by name.
  stubInvoke(mockedInvoke, {
    list_journal_pages_in_range: () => [],
    count_agenda_batch_by_source: () => ({}),
  })
})

describe('JournalControls', () => {
  it('renders the four mode tabs', () => {
    render(<JournalControls />)
    expect(screen.getByRole('tab', { name: /daily view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /weekly view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /monthly view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /agenda view/i })).toBeInTheDocument()
  })

  // Below lg the five tabs give way to one menu button, which is what leaves
  // the phone row room for Back / Forward and a readable date.
  it('below lg the mode tabs give way to a menu that switches mode', async () => {
    const user = userEvent.setup()
    render(<JournalControls />)

    expect(screen.getByRole('tablist').className).toContain('max-lg:hidden')
    const trigger = screen.getByRole('button', { name: 'Journal view mode: Day' })
    expect(trigger.className).toContain('lg:hidden')

    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: 'Week' }))

    expect(useJournalStore.getState().mode).toBe('weekly')
    expect(screen.getByRole('button', { name: 'Journal view mode: Week' })).toBeInTheDocument()
  })

  it('marks the active mode tab aria-selected', () => {
    render(<JournalControls />)
    expect(screen.getByRole('tab', { name: /daily view/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: /weekly view/i })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  it('switching to weekly tab updates the store mode', async () => {
    const user = userEvent.setup()
    render(<JournalControls />)

    await user.click(screen.getByRole('tab', { name: /weekly view/i }))

    expect(useJournalStore.getState().mode).toBe('weekly')
  })

  it('clicking prev moves currentDate one day back in daily mode', async () => {
    const user = userEvent.setup()
    render(<JournalControls />)

    await user.click(screen.getByRole('button', { name: /previous day/i }))

    expect(format(useJournalStore.getState().currentDate, 'yyyy-MM-dd')).toBe('2025-06-14')
  })

  it('clicking next moves currentDate one day forward in daily mode', async () => {
    const user = userEvent.setup()
    render(<JournalControls />)

    await user.click(screen.getByRole('button', { name: /next day/i }))

    expect(format(useJournalStore.getState().currentDate, 'yyyy-MM-dd')).toBe('2025-06-16')
  })

  it('shows custom navigation bindings in tooltips and aria-keyshortcuts', async () => {
    setCustomShortcut('prevDayWeekMonth', 'Ctrl + Shift + Arrow Left')
    const user = userEvent.setup()
    render(<JournalControls />)

    const previous = screen.getByRole('button', { name: /previous day/i })
    await user.hover(previous)

    expect(await screen.findByText('Ctrl + Shift + Arrow Left')).toBeInTheDocument()
    expect(previous).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+ArrowLeft')
    expect(screen.getByRole('button', { name: /next day/i })).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+ArrowRight',
    )
    expect(screen.getByRole('button', { name: /go to today/i })).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+T',
    )
  })

  it('renders the calendar trigger', () => {
    render(<JournalControls />)
    expect(screen.getByRole('button', { name: /open calendar picker/i })).toBeInTheDocument()
  })

  it('clicking the calendar trigger opens the dropdown dialog', async () => {
    const user = userEvent.setup()
    render(<JournalControls />)

    await user.click(screen.getByRole('button', { name: /open calendar picker/i }))

    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()
  })

  // SR users need a signal that the calendar trigger opens a popover
  // and whether it is currently open.
  it('calendar trigger has aria-haspopup="dialog" and aria-expanded reflects open state', async () => {
    const user = userEvent.setup()
    render(<JournalControls />)

    const trigger = screen.getByRole('button', { name: /open calendar picker/i })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  // #3340 — the calendar-highlight fetch moved OUT of this component and into
  // `JournalCalendarDropdown`, so it runs once when the dropdown opens rather
  // than on mount of the controls.
  it('fetches the page list once when the calendar dropdown opens', async () => {
    const user = userEvent.setup()
    render(<JournalControls />)

    await user.click(screen.getByRole('button', { name: /calendar/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_journal_pages_in_range',
        expect.objectContaining({ scope: { kind: 'active', space_id: 'SPACE_TEST' } }),
      )
    })
    const fetchCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'list_journal_pages_in_range',
    )
    expect(fetchCalls).toHaveLength(1)
  })

  // #3626 — closing the dropdown UNMOUNTS it (both call sites render it as
  // `{calendarOpen && <JournalCalendarDropdown …>}`), which is what keeps its
  // `displayedMonth` state honest across opens (#3340). The dedupe used to be
  // in-flight only, so that unmount/remount cycle cost a fresh IPC on every
  // reopen. Pin the COUNT: a fix that re-fetched but rendered identical dots
  // would be invisible here otherwise.
  it('re-opening the calendar dropdown does not re-fetch the highlight range (#3626)', async () => {
    const user = userEvent.setup()
    render(<JournalControls />)
    const trigger = screen.getByRole('button', { name: /open calendar picker/i })

    await user.click(trigger)
    await screen.findByTestId('mock-calendar')
    await waitFor(() => {
      expect(pageRangeFetchCount()).toBe(1)
    })

    await user.click(trigger)
    // Unmounted, not merely hidden — "fix the refetch by hiding instead of
    // unmounting" would silently reintroduce the stale month #3340 fixed.
    await waitFor(() => {
      expect(screen.queryByTestId('mock-calendar')).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('dialog', { name: /date picker/i })).not.toBeInTheDocument()

    await user.click(trigger)
    await screen.findByTestId('mock-calendar')

    expect(pageRangeFetchCount()).toBe(1)
  })

  it('does not fetch the page list when no space is active (b1)', async () => {
    // b1 — required-active: with no active space the fetch is skipped
    // rather than dispatching a Global scope (which the backend rejects).
    useSpaceStore.setState({ currentSpaceId: null })
    const user = userEvent.setup()

    render(<JournalControls />)
    // Open the dropdown — without this the assertion would be vacuous now
    // that nothing fetches the page list before it mounts (#3340).
    await user.click(screen.getByRole('button', { name: /calendar/i }))
    await screen.findByTestId('mock-calendar')

    expect(mockedInvoke).not.toHaveBeenCalledWith('list_journal_pages_in_range', expect.anything())
  })

  // The date readout's 100 px floor is gated on lg: — below it the chip is
  // squeezed (phones, 640-1023px touch screens) and the floor would push the
  // centred text out over the chevrons.
  it('date display min-width is scoped to the lg: breakpoint', () => {
    render(<JournalControls />)

    const dateDisplay = screen.getByTestId('date-display')
    expect(dateDisplay.className).toContain('lg:min-w-[100px]')
    // Must not have the unguarded min-w-[100px] reservation below lg.
    expect(dateDisplay.className).not.toMatch(/(?:^|\s)min-w-\[100px\]/)
  })

  // The header root used to be `flex-col sm:flex-row`, which — nested inside
  // the App header's own below-sm stack — gave a phone THREE rows: mode tabs,
  // date stepper, then the search trigger alone. It is now a single row at
  // every width (measured at 360px: 44px tall, down from 96-112px, with the
  // search trigger on the same row). Assertions are on the className flags —
  // jsdom applies no media queries, so the responsive utilities are the
  // observable contract here; `e2e/mobile-overflow.spec.ts` is what proves the
  // row actually fits.
  it('journal-header root is a single row at every width', () => {
    render(<JournalControls />)

    const root = screen.getByTestId('journal-header')
    // No `flex-col` in any form — a stacked variant is the bug being pinned.
    expect(root.className).not.toMatch(/(?:^|:)flex-col/)
    expect(root.className).toContain('items-center')
    // `min-w-0` is what lets the date chip shrink instead of pushing the row
    // wider than the viewport.
    expect(root.className).toContain('min-w-0')
  })

  // The row fits at 360px only because every control except the date is a
  // fixed, phone-sized width (the mode tabs are a menu there, see above).
  // Losing either lever re-overflows the row (and fails the e2e overflow
  // sweep).
  it('phone width shrinks the date stepper to fixed compact widths', () => {
    render(<JournalControls />)

    // Prev/next: 24px wide below sm, 44px tall as before.
    for (const name of [/previous day/i, /next day/i]) {
      expect(screen.getByRole('button', { name }).className).toContain('max-sm:w-6!')
    }

    // The date chip is the ONE elastic item: `shrink` (the Button base is
    // `shrink-0`) + `min-w-0` + a truncating label, so a long date can never
    // push the row past the viewport.
    const chip = screen.getByRole('button', { name: /open calendar picker/i })
    const chipClasses = chip.className.split(/\s+/)
    expect(chipClasses).toContain('shrink')
    // twMerge must have dropped the Button base's own `shrink-0` (the
    // `[&_svg]:shrink-0` arbitrary variant is a different, unrelated class).
    expect(chipClasses).not.toContain('shrink-0')
    expect(chipClasses).toContain('min-w-0')
  })

  // The date readout is also the calendar trigger — the standalone calendar
  // IconButton it replaced cost another 44px on the phone row, and the date is
  // what a user taps at anyway. Its accessible name keeps BOTH the full date
  // and the picker verb, so every `/open calendar picker/i` query still
  // resolves and a SR user still hears the unabbreviated date.
  it('the date display is the calendar trigger and carries full + compact labels', () => {
    render(<JournalControls />)

    const chip = screen.getByRole('button', { name: /open calendar picker/i })
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog')

    const full = screen.getByTestId('date-display')
    expect(chip).toContainElement(full)
    // Full string above sm, compact string below — mutually exclusive, same
    // pattern as the mode-tab labels above.
    expect(full.className).toContain('max-sm:hidden')
    const compact = chip.querySelector('span.sm\\:hidden')
    expect(compact).not.toBeNull()
    expect(compact?.textContent).not.toBe(full.textContent)
    // The compact label is decorative: the button's aria-label carries the
    // full date, so it must not join the accessible name.
    expect(compact).toHaveAttribute('aria-hidden', 'true')
    expect(chip.getAttribute('aria-label')).toContain(full.textContent ?? '')
  })

  // Today is always on the header row: an icon below md, where the word
  // would squeeze the date chip, and the word from md up. The calendar
  // dropdown no longer carries a second copy.
  it('Today stays on the header row and the dropdown has no duplicate', async () => {
    const user = userEvent.setup()
    useJournalStore.setState({ mode: 'weekly', currentDate: new Date(2025, 5, 15) })
    render(<JournalControls />)

    const today = screen.getByRole('button', { name: /go to today/i })
    expect(today.className).not.toMatch(/(?:^|\s)max-sm:hidden/)
    expect(today.querySelector('svg.md\\:hidden')).not.toBeNull()
    expect(today.querySelector('span.max-md\\:hidden')?.textContent).toBe('Today')

    await user.click(screen.getByRole('button', { name: /open calendar picker/i }))
    const dialog = await screen.findByRole('dialog', { name: /date picker/i })
    expect(within(dialog).queryByRole('button', { name: /^today$/i })).not.toBeInTheDocument()

    await user.click(today)
    // Weekly mode scrolls to today rather than switching mode.
    expect(useJournalStore.getState().scrollToDate).toBe(format(new Date(), 'yyyy-MM-dd'))
  })

  // Agenda and stream have no day to scroll to, so Today lands on today's
  // daily page.
  it.each(['agenda', 'stream'] as const)(
    'Today in %s mode switches to daily on today',
    async (mode) => {
      const user = userEvent.setup()
      useJournalStore.setState({ mode, currentDate: new Date(2025, 5, 15) })
      render(<JournalControls />)

      await user.click(screen.getByRole('button', { name: /go to today/i }))

      const state = useJournalStore.getState()
      expect(state.mode).toBe('daily')
      expect(format(state.currentDate, 'yyyy-MM-dd')).toBe(format(new Date(), 'yyyy-MM-dd'))
      expect(screen.getByRole('tab', { name: /daily view/i })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    },
  )

  it('hides the prev/next nav in agenda mode', () => {
    useJournalStore.setState({
      mode: 'agenda',
      currentDate: new Date(2025, 5, 15),
      scrollToDate: null,
      scrollToPanel: null,
    })
    render(<JournalControls />)

    expect(screen.queryByRole('button', { name: /previous day/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /next day/i })).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    // The active tab's aria-controls references the mode panel that JournalPage
    // renders in a separate subtree (App header vs. main). Provide a matching
    // panel stub so the cross-tree reference resolves under axe.
    const { container } = render(
      <>
        <JournalControls />
        <div role="tabpanel" id="journal-panel-daily" aria-labelledby="journal-tab-daily" />
      </>,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // #2261: roving keyboard navigation across the role="tablist" mode switcher.
  // WAI-ARIA tabs with MANUAL activation (APG): arrow keys / Home / End move
  // DOM focus ONLY (no mode change → no eager view mount / IPC), and
  // Enter/Space activates the focused tab. Tabs are ordered daily, weekly,
  // monthly, stream, agenda.
  describe('roving keyboard navigation (tablist, manual activation)', () => {
    it('ArrowRight moves focus to the next tab WITHOUT switching mode', async () => {
      const user = userEvent.setup()
      render(<JournalControls />)

      const dailyTab = screen.getByRole('tab', { name: /daily view/i })
      dailyTab.focus()
      await user.keyboard('{ArrowRight}')

      // Mode unchanged — focus moved only.
      expect(useJournalStore.getState().mode).toBe('daily')
      const weeklyTab = screen.getByRole('tab', { name: /weekly view/i })
      expect(weeklyTab).toHaveFocus()
      // Roving tabindex follows focus; selection (aria-selected) stays on daily.
      expect(weeklyTab).toHaveAttribute('tabindex', '0')
      expect(dailyTab).toHaveAttribute('tabindex', '-1')
      expect(dailyTab).toHaveAttribute('aria-selected', 'true')
      expect(weeklyTab).toHaveAttribute('aria-selected', 'false')
    })

    it('Enter activates the focused (roving) tab', async () => {
      const user = userEvent.setup()
      render(<JournalControls />)

      const dailyTab = screen.getByRole('tab', { name: /daily view/i })
      dailyTab.focus()
      await user.keyboard('{ArrowRight}')
      expect(useJournalStore.getState().mode).toBe('daily')

      await user.keyboard('{Enter}')

      expect(useJournalStore.getState().mode).toBe('weekly')
      const weeklyTab = screen.getByRole('tab', { name: /weekly view/i })
      expect(weeklyTab).toHaveAttribute('aria-selected', 'true')
    })

    it('Space activates the focused (roving) tab', async () => {
      const user = userEvent.setup()
      render(<JournalControls />)

      const dailyTab = screen.getByRole('tab', { name: /daily view/i })
      dailyTab.focus()
      await user.keyboard('{ArrowRight}{ArrowRight}')
      expect(useJournalStore.getState().mode).toBe('daily')

      await user.keyboard('[Space]')

      expect(useJournalStore.getState().mode).toBe('monthly')
    })

    it('clicking a tab activates it immediately', async () => {
      const user = userEvent.setup()
      render(<JournalControls />)

      await user.click(screen.getByRole('tab', { name: /monthly view/i }))

      expect(useJournalStore.getState().mode).toBe('monthly')
    })

    it('ArrowLeft moves focus to the previous tab without switching mode', async () => {
      const user = userEvent.setup()
      useJournalStore.setState({ mode: 'monthly', currentDate: new Date(2025, 5, 15) })
      render(<JournalControls />)

      const monthlyTab = screen.getByRole('tab', { name: /monthly view/i })
      monthlyTab.focus()
      await user.keyboard('{ArrowLeft}')

      expect(useJournalStore.getState().mode).toBe('monthly')
      expect(screen.getByRole('tab', { name: /weekly view/i })).toHaveFocus()
    })

    it('ArrowLeft from the first tab wraps focus to the last', async () => {
      const user = userEvent.setup()
      render(<JournalControls />)

      const dailyTab = screen.getByRole('tab', { name: /daily view/i })
      dailyTab.focus()
      await user.keyboard('{ArrowLeft}')

      expect(useJournalStore.getState().mode).toBe('daily')
      expect(screen.getByRole('tab', { name: /agenda view/i })).toHaveFocus()
    })

    it('ArrowRight from the last tab wraps focus to the first', async () => {
      const user = userEvent.setup()
      useJournalStore.setState({ mode: 'agenda', currentDate: new Date(2025, 5, 15) })
      render(<JournalControls />)

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      agendaTab.focus()
      await user.keyboard('{ArrowRight}')

      expect(useJournalStore.getState().mode).toBe('agenda')
      expect(screen.getByRole('tab', { name: /daily view/i })).toHaveFocus()
    })

    it('Home moves focus to the first tab and End to the last (no mode change)', async () => {
      const user = userEvent.setup()
      useJournalStore.setState({ mode: 'weekly', currentDate: new Date(2025, 5, 15) })
      render(<JournalControls />)

      const weeklyTab = screen.getByRole('tab', { name: /weekly view/i })
      weeklyTab.focus()
      await user.keyboard('{End}')

      expect(useJournalStore.getState().mode).toBe('weekly')
      expect(screen.getByRole('tab', { name: /agenda view/i })).toHaveFocus()

      await user.keyboard('{Home}')

      expect(useJournalStore.getState().mode).toBe('weekly')
      expect(screen.getByRole('tab', { name: /daily view/i })).toHaveFocus()
    })

    it('tabs reference their panel via aria-controls', () => {
      render(<JournalControls />)
      const dailyTab = screen.getByRole('tab', { name: /daily view/i })
      expect(dailyTab).toHaveAttribute('aria-controls', 'journal-panel-daily')
      expect(dailyTab).toHaveAttribute('id', 'journal-tab-daily')
    })
  })
})
