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
  // UseCalendarPageDates now hits `list_journal_pages_in_range`,
  // which returns a flat `BlockRow[]` (no pagination envelope).
  mockedInvoke.mockResolvedValue([])
})

describe('JournalControls', () => {
  it('renders the four mode tabs', () => {
    render(<JournalControls />)
    expect(screen.getByRole('tab', { name: /daily view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /weekly view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /monthly view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /agenda view/i })).toBeInTheDocument()
  })

  it('gives each compact single-letter tab a native title with the full mode name', () => {
    // #2281 — below 480px each tab collapses to its initial glyph (D/W/M/S/A).
    // A native `title` on that glyph surfaces the full mode name on hover so a
    // sighted user can disambiguate; the tab's aria-label already covers AT.
    render(<JournalControls />)
    const streamTab = screen.getByRole('tab', { name: /stream view/i })
    const glyph = streamTab.querySelector('[title]')
    expect(glyph).not.toBeNull()
    // Title mirrors the tab's accessible name (the computed ariaLabels[m]).
    expect(glyph?.getAttribute('title')).toBe(streamTab.getAttribute('aria-label'))
    expect(glyph).toHaveTextContent('S')
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

  // The date readout's min-width is gated on sm: so phones
  // (e.g. 360 px wide) aren't penalized by a fixed 100 px reservation that
  // wastes ~28 % of the viewport.
  it('date display min-width is scoped to sm: breakpoint', () => {
    render(<JournalControls />)

    const dateDisplay = screen.getByTestId('date-display')
    expect(dateDisplay.className).toContain('sm:min-w-[100px]')
    // Must not have the unguarded min-w-[100px] reservation on phones.
    expect(dateDisplay.className).not.toMatch(/(?:^|\s)min-w-\[100px\]/)
  })

  // PEND journal-header-responsive: under ~480 px the visible mode-tab text
  // collapses to its first letter (D/W/M/A); the full word stays on aria-label
  // and the longform span is hidden via `[@media(min-width:480px)]:` variants.
  // We assert the two spans co-exist with mutually exclusive visibility
  // classes so visual width shrinks while the accessible name is unchanged.
  it('mode-tab labels include both full and single-letter spans for xs collapse', () => {
    render(<JournalControls />)

    const dailyTab = screen.getByRole('tab', { name: /daily view/i })
    // Full word visible at >=480px, hidden below.
    const fullSpan = dailyTab.querySelector('span.hidden')
    // Single letter visible below 480px, hidden above.
    const compactSpan = dailyTab.querySelector(
      'span.\\[\\@media\\(min-width\\:480px\\)\\]\\:hidden',
    )

    expect(fullSpan).not.toBeNull()
    expect(compactSpan).not.toBeNull()
    expect(fullSpan?.className).toContain('[@media(min-width:480px)]:inline')
    expect(compactSpan?.textContent).toBe('D')
    // Accessible name still uses the long form via aria-label.
    expect(dailyTab).toHaveAttribute('aria-label', expect.stringMatching(/daily view/i))
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
  // fixed, phone-sized width. Pin the three levers that buy the space; losing
  // any one of them re-overflows the row (and fails the e2e overflow sweep).
  it('phone width shrinks the tabs and the date stepper to fixed compact widths', () => {
    render(<JournalControls />)

    // Mode tabs: 24px wide below sm (the `xs` size's coarse-pointer `px-3`
    // made them 31-35px, i.e. 174px for the five of them).
    const dailyTab = screen.getByRole('tab', { name: /daily view/i })
    expect(dailyTab.className).toContain('max-sm:w-6!')
    expect(dailyTab.className).toContain('max-sm:px-0!')

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

  // #7 — on a phone Today was the only bordered control on its row (its
  // `outline` partner, the Agenda button, is `hidden sm:inline-flex`). It is
  // also the one control the 360px row cannot afford. Rather than restyle the
  // desktop pair, the phone row drops it and the calendar dropdown re-offers
  // it — so the odd-one-out is gone AND the action is still reachable.
  it('Today is desktop-only on the header row and is re-offered in the dropdown', async () => {
    const user = userEvent.setup()
    // Weekly mode: Today is meaningful (daily-on-today hides it entirely).
    useJournalStore.setState({ mode: 'weekly', currentDate: new Date(2025, 5, 15) })
    render(<JournalControls />)

    const today = screen.getByRole('button', { name: /go to today/i })
    expect(today.className).toContain('max-sm:hidden')

    await user.click(screen.getByRole('button', { name: /open calendar picker/i }))
    const dialog = await screen.findByRole('dialog', { name: /date picker/i })
    const dropdownToday = within(dialog).getByRole('button', { name: /^today$/i })
    // Phone-only: the header already shows Today from sm up.
    expect(dropdownToday.parentElement?.className).toContain('sm:hidden')

    await user.click(dropdownToday)
    // Weekly mode scrolls to today rather than switching mode — same handler
    // the header button uses, which is the point of sharing `goToToday`.
    expect(useJournalStore.getState().scrollToDate).toBe(format(new Date(), 'yyyy-MM-dd'))
  })

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
