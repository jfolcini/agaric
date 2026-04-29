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
import { __resetCalendarPageDatesForTests } from '../../hooks/useCalendarPageDates'
import { useJournalStore } from '../../stores/journal'
import { JournalControls } from '../JournalControls'

// Calendar mock — the real react-day-picker Calendar warns about unrecognised
// props on a plain <div>; we only care that *something* is rendered.
vi.mock('../ui/calendar', () => ({
  Calendar: () => <div data-testid="mock-calendar">Calendar</div>,
}))

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  __resetCalendarPageDatesForTests()
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2025, 5, 15),
    scrollToDate: null,
    scrollToPanel: null,
  })
  mockedInvoke.mockResolvedValue(emptyPage)
})

describe('JournalControls', () => {
  it('renders the four mode tabs', () => {
    render(<JournalControls />)
    expect(screen.getByRole('tab', { name: /daily view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /weekly view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /monthly view/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /agenda view/i })).toBeInTheDocument()
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

  it('fetches the page list once on mount', async () => {
    render(<JournalControls />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_blocks',
        expect.objectContaining({ blockType: 'page', limit: 500 }),
      )
    })
    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(1)
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
    const { container } = render(<JournalControls />)
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
