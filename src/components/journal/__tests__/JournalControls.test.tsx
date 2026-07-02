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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { format } from 'date-fns'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { JournalControls } from '@/components/journal/JournalControls'
import { __resetCalendarPageDatesForTests } from '@/hooks/useCalendarPageDates'
import { useJournalStore } from '@/stores/journal'

// Calendar mock — the real react-day-picker Calendar warns about unrecognised
// props on a plain <div>; we only care that *something* is rendered.
vi.mock('@/components/ui/calendar', () => ({
  Calendar: () => <div data-testid="mock-calendar">Calendar</div>,
}))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  __resetCalendarPageDatesForTests()
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2025, 5, 15),
    scrollToDate: null,
    scrollToPanel: null,
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

  it('fetches the page list once on mount', async () => {
    render(<JournalControls />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_journal_pages_in_range',
        expect.objectContaining({ spaceId: '' }),
      )
    })
    const fetchCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'list_journal_pages_in_range',
    )
    expect(fetchCalls).toHaveLength(1)
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

  // PEND journal-header-responsive: the header root container stacks vertically
  // on phones and inlines on sm:+, so the four mode tabs and the date-nav row
  // each get their own row on narrow viewports instead of being clipped by
  // the 56 px header height. Assertion is on the className flags (the test
  // env doesn't apply media queries, so we verify the responsive utilities
  // are present rather than computing the rendered layout).
  it('journal-header root uses flex-col sm:flex-row for the two-row mobile stack', () => {
    render(<JournalControls />)

    const root = screen.getByTestId('journal-header')
    expect(root.className).toContain('flex-col')
    expect(root.className).toContain('sm:flex-row')
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
