/**
 * Tests for MonthlyView component (calendar grid layout).
 *
 * Validates:
 *  1. Grid has 7 column headers (Mon-Sun for weekStartsOn=1)
 *  2. Grid has correct number of cells (days in month + padding)
 *  3. Today cell gets isToday={true}
 *  4. Adjacent month cells get isCurrentMonth={false}
 *  5. Month cells get isCurrentMonth={true}
 *  6. Correct counts passed to cells
 *  7. Re-renders on month change
 *  8. axe audit
 *  9. Week start preference changes header order
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { format } from 'date-fns'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import type { DayEntry } from '../../../lib/date-utils'
import { useJournalStore } from '../../../stores/journal'

// ── Mock useBatchCounts ─────────────────────────────────────────────
const mockBatchCounts = vi.hoisted(() => ({
  agendaCounts: {} as Record<string, number>,
  agendaCountsBySource: {} as Record<string, Record<string, number>>,
  backlinkCounts: {} as Record<string, number>,
}))

vi.mock('../../../hooks/useBatchCounts', () => ({
  useBatchCounts: () => mockBatchCounts,
}))

// ── Mock useWeekStart ───────────────────────────────────────────────
const mockWeekStart = vi.hoisted(() => ({
  weekStartsOn: 1 as 0 | 1,
}))

vi.mock('../../../hooks/useWeekStart', () => ({
  useWeekStart: () => mockWeekStart,
}))

// ── Mock MonthlyDayCell ─────────────────────────────────────────────
// The mock forwards the roving props the real cell consumes (ref, tabIndex,
// onFocus) so the roving-tabindex / arrow-key tests below exercise
// MonthlyView's grid keyboard handler against focusable cells.
vi.mock('../MonthlyDayCell', () => ({
  MonthlyDayCell: (props: Record<string, unknown>) => {
    const entry = props['entry'] as DayEntry
    const isCurrentMonth = !!props['isCurrentMonth']
    const tabIndex = props['tabIndex'] as number | undefined
    return (
      /* oxlint-disable jsx-a11y/prefer-tag-over-role -- test mock; gridcell role mirrors MonthlyDayCell */
      <div
        ref={props['ref'] as React.Ref<HTMLDivElement> | undefined}
        role="gridcell"
        data-testid={`monthly-cell-${entry.dateStr}`}
        data-date={entry.dateStr}
        data-is-today={String(!!props['isToday'])}
        data-is-current-month={String(isCurrentMonth)}
        data-agenda-count={String(props['agendaCount'])}
        data-backlink-count={String(props['backlinkCount'])}
        aria-label={entry.displayDate}
        tabIndex={!isCurrentMonth ? -1 : (tabIndex ?? 0)}
        onFocus={props['onFocus'] as React.FocusEventHandler<HTMLDivElement> | undefined}
      >
        {entry.date.getDate()}
      </div>
    )
  },
}))

vi.mocked(invoke)

import { MonthlyView } from '../MonthlyView'

/** Fixed date: January 2025 (31 days). */
const FIXED_DATE = new Date(2025, 0, 15) // Wed, Jan 15, 2025

/** Fixed date: February 2025 (28 days, non-leap). */
const FEB_DATE = new Date(2025, 1, 10) // Mon, Feb 10, 2025

function makeDayEntry(d: Date): DayEntry {
  const dateStr = format(d, 'yyyy-MM-dd')
  return {
    date: d,
    dateStr,
    displayDate: d.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }),
    pageId: `page-${dateStr}`,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBatchCounts.agendaCounts = {}
  mockBatchCounts.agendaCountsBySource = {}
  mockBatchCounts.backlinkCounts = {}
  mockWeekStart.weekStartsOn = 1
  useJournalStore.setState({ currentDate: FIXED_DATE })
})

describe('MonthlyView', () => {
  it('renders 7 column headers (Mon-Sun for weekStartsOn=1)', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const headers = screen.getAllByRole('columnheader')
    expect(headers).toHaveLength(7)
    expect(headers[0]).toHaveTextContent('Mon')
    expect(headers[6]).toHaveTextContent('Sun')
  })

  it('renders correct number of grid cells for January 2025 (including padding)', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const cells = screen.getAllByRole('gridcell')
    // Jan 2025 with Mon start: Dec 30, Dec 31, Jan 1-31, Feb 1, Feb 2
    // Grid start: Mon Dec 30 (week containing Jan 1)
    // Grid end: Sun Feb 2 (week containing Jan 31)
    // That's 5 weeks = 35 cells
    expect(cells.length).toBeGreaterThanOrEqual(28)
    // Should be a multiple of 7
    expect(cells.length % 7).toBe(0)
  })

  it('renders correct number of cells for February 2025', () => {
    useJournalStore.setState({ currentDate: FEB_DATE })

    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const cells = screen.getAllByRole('gridcell')
    // Should be a multiple of 7
    expect(cells.length % 7).toBe(0)
    // Feb 2025 has 28 days, so at least 28 cells
    expect(cells.length).toBeGreaterThanOrEqual(28)
  })

  it('marks today cell with isToday=true', () => {
    const today = new Date()
    useJournalStore.setState({ currentDate: today })

    const todayStr = format(today, 'yyyy-MM-dd')

    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const todayCell = screen.getByTestId(`monthly-cell-${todayStr}`)
    expect(todayCell).toHaveAttribute('data-is-today', 'true')
  })

  it('marks adjacent month cells with isCurrentMonth=false', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    // Jan 2025 with Monday start: Dec 30 (Mon) is the first padding cell
    const dec30Cell = screen.getByTestId('monthly-cell-2024-12-30')
    expect(dec30Cell).toBeInTheDocument()
    expect(dec30Cell).toHaveAttribute('data-is-current-month', 'false')
  })

  it('marks current month cells with isCurrentMonth=true', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const jan15Cell = screen.getByTestId('monthly-cell-2025-01-15')
    expect(jan15Cell).toHaveAttribute('data-is-current-month', 'true')

    const jan1Cell = screen.getByTestId('monthly-cell-2025-01-01')
    expect(jan1Cell).toHaveAttribute('data-is-current-month', 'true')
  })

  it('passes correct counts to cells', () => {
    mockBatchCounts.agendaCounts = { '2025-01-15': 3 }
    mockBatchCounts.backlinkCounts = { 'page-2025-01-15': 5 }

    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const cell = screen.getByTestId('monthly-cell-2025-01-15')
    expect(cell).toHaveAttribute('data-agenda-count', '3')
    expect(cell).toHaveAttribute('data-backlink-count', '5')
  })

  it('re-renders when journal store currentDate changes to different month', () => {
    const { rerender } = render(<MonthlyView makeDayEntry={makeDayEntry} />)

    // Initially: January 2025
    expect(screen.getByTestId('monthly-cell-2025-01-01')).toBeInTheDocument()

    // Change to February 2025
    useJournalStore.setState({ currentDate: FEB_DATE })
    rerender(<MonthlyView makeDayEntry={makeDayEntry} />)

    expect(screen.getByTestId('monthly-cell-2025-02-01')).toBeInTheDocument()
    expect(screen.queryByTestId('monthly-cell-2025-01-15')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    useJournalStore.setState({ currentDate: FEB_DATE })

    const { container } = render(<MonthlyView makeDayEntry={makeDayEntry} />)
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('changes header order when weekStartsOn=0 (Sunday start)', () => {
    mockWeekStart.weekStartsOn = 0

    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const headers = screen.getAllByRole('columnheader')
    expect(headers).toHaveLength(7)
    expect(headers[0]).toHaveTextContent('Sun')
    expect(headers[6]).toHaveTextContent('Sat')
  })

  // ── #2057: roving tabindex + arrow-key navigation ───────────────────
  describe('#2057 roving tabindex / arrow-key navigation', () => {
    it('exposes exactly one tab stop across the whole grid', () => {
      render(<MonthlyView makeDayEntry={makeDayEntry} />)
      const tabbable = screen
        .getAllByRole('gridcell')
        .filter((c) => c.getAttribute('tabindex') === '0')
      expect(tabbable).toHaveLength(1)
      // Jan 2025: today (2026) is out-of-month, so the first in-month day (Jan 1)
      // owns the tab stop.
      expect(tabbable[0]).toBe(screen.getByTestId('monthly-cell-2025-01-01'))
    })

    it('adjacent-month padding cells are never a tab stop (-1)', () => {
      render(<MonthlyView makeDayEntry={makeDayEntry} />)
      // Dec 30 2024 is leading padding for the Monday-start Jan 2025 grid.
      expect(screen.getByTestId('monthly-cell-2024-12-30')).toHaveAttribute('tabindex', '-1')
    })

    it('ArrowRight moves the roving focus to the next in-month day', async () => {
      const user = userEvent.setup()
      render(<MonthlyView makeDayEntry={makeDayEntry} />)
      const jan1 = screen.getByTestId('monthly-cell-2025-01-01')
      jan1.focus()
      await user.keyboard('{ArrowRight}')
      const jan2 = screen.getByTestId('monthly-cell-2025-01-02')
      expect(jan2).toHaveFocus()
      expect(jan2).toHaveAttribute('tabindex', '0')
      // The old tab stop relinquished it (single tab stop invariant).
      expect(jan1).toHaveAttribute('tabindex', '-1')
    })

    it('ArrowDown moves the roving focus down one week (+7 days)', async () => {
      const user = userEvent.setup()
      render(<MonthlyView makeDayEntry={makeDayEntry} />)
      const jan1 = screen.getByTestId('monthly-cell-2025-01-01')
      jan1.focus()
      await user.keyboard('{ArrowDown}')
      expect(screen.getByTestId('monthly-cell-2025-01-08')).toHaveFocus()
    })

    it('ArrowLeft from the first in-month day stays in-month (skips padding)', async () => {
      const user = userEvent.setup()
      render(<MonthlyView makeDayEntry={makeDayEntry} />)
      const jan1 = screen.getByTestId('monthly-cell-2025-01-01')
      jan1.focus()
      // Left of Jan 1 is Dec 31 (padding) then Dec 30 (padding) — no in-month
      // cell to the left, so focus stays on Jan 1.
      await user.keyboard('{ArrowLeft}')
      expect(jan1).toHaveFocus()
    })

    it('Home/End jump within the current week row', async () => {
      const user = userEvent.setup()
      render(<MonthlyView makeDayEntry={makeDayEntry} />)
      // Move into the second week so Home/End land on real in-month days.
      const jan8 = screen.getByTestId('monthly-cell-2025-01-08')
      jan8.focus()
      await user.keyboard('{End}')
      // Week 2 (Mon Jan 6 – Sun Jan 12); End → Jan 12.
      expect(screen.getByTestId('monthly-cell-2025-01-12')).toHaveFocus()
      await user.keyboard('{Home}')
      // Home → Jan 6.
      expect(screen.getByTestId('monthly-cell-2025-01-06')).toHaveFocus()
    })

    it('re-seeds the tab stop to the first in-month day on month change', () => {
      const { rerender } = render(<MonthlyView makeDayEntry={makeDayEntry} />)
      expect(screen.getByTestId('monthly-cell-2025-01-01')).toHaveAttribute('tabindex', '0')

      useJournalStore.setState({ currentDate: FEB_DATE })
      rerender(<MonthlyView makeDayEntry={makeDayEntry} />)
      expect(screen.getByTestId('monthly-cell-2025-02-01')).toHaveAttribute('tabindex', '0')
      expect(screen.queryByTestId('monthly-cell-2025-01-01')).not.toBeInTheDocument()
    })
  })

  it('renders grid with role="grid" and aria-label', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const grid = screen.getByRole('grid')
    expect(grid).toBeInTheDocument()
    expect(grid).toHaveAttribute('aria-label', t('journal.monthlyCalendarLabel'))
  })

  // ── Edge-case: leap year vs non-leap year February ──────────────────
  it.each([
    { year: 2024, expectedDays: 29, label: 'leap year (29 days)' },
    { year: 2025, expectedDays: 28, label: 'non-leap year (28 days)' },
  ])('renders February $label correctly', ({ year, expectedDays }) => {
    const febDate = new Date(year, 1, 10)
    useJournalStore.setState({ currentDate: febDate })

    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const cells = screen.getAllByRole('gridcell')
    expect(cells.length % 7).toBe(0)
    expect(cells.length).toBeGreaterThanOrEqual(expectedDays)

    // Feb 28 must always exist
    expect(screen.getByTestId(`monthly-cell-${year}-02-28`)).toBeInTheDocument()

    // Feb 29 only exists in a leap year
    if (expectedDays === 29) {
      expect(screen.getByTestId(`monthly-cell-${year}-02-29`)).toBeInTheDocument()
      expect(screen.getByTestId(`monthly-cell-${year}-02-29`)).toHaveAttribute(
        'data-is-current-month',
        'true',
      )
    } else {
      expect(screen.queryByTestId(`monthly-cell-${year}-02-29`)).not.toBeInTheDocument()
    }
  })

  // ── Edge-case: 6-row grid vs 5-row grid ─────────────────────────────
  it.each([
    {
      label: '6-row grid (March 2025 starts on Saturday, 31 days)',
      date: new Date(2025, 2, 15),
      expectedCells: 42,
    },
    {
      label: '5-row grid (January 2025 starts on Wednesday, 31 days)',
      date: new Date(2025, 0, 15),
      expectedCells: 35,
    },
  ])('renders $label with correct cell count', ({ date, expectedCells }) => {
    mockWeekStart.weekStartsOn = 1
    useJournalStore.setState({ currentDate: date })

    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const cells = screen.getAllByRole('gridcell')
    expect(cells).toHaveLength(expectedCells)
    expect(cells.length / 7).toBe(expectedCells / 7)
  })

  // ── Edge-case: empty month (no agenda / backlink data) ──────────────
  it('renders all cells with zero counts when no pages have data', () => {
    mockBatchCounts.agendaCounts = {}
    mockBatchCounts.agendaCountsBySource = {}
    mockBatchCounts.backlinkCounts = {}

    render(<MonthlyView makeDayEntry={makeDayEntry} />)

    const cells = screen.getAllByRole('gridcell')
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.length % 7).toBe(0)

    // Every cell should report zero counts
    for (const cell of cells) {
      expect(cell).toHaveAttribute('data-agenda-count', '0')
      expect(cell).toHaveAttribute('data-backlink-count', '0')
    }
  })
})
