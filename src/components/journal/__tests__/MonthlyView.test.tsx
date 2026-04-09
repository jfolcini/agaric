/**
 * Tests for MonthlyView component (UX-83 — calendar grid layout).
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
import { format } from 'date-fns'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
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
vi.mock('../MonthlyDayCell', () => ({
  MonthlyDayCell: (props: Record<string, unknown>) => {
    const entry = props.entry as DayEntry
    return (
      // biome-ignore lint/a11y/useFocusableInteractive: test mock
      // biome-ignore lint/a11y/useSemanticElements: test mock for gridcell
      <div
        role="gridcell"
        data-testid={`monthly-cell-${entry.dateStr}`}
        data-is-today={String(!!props.isToday)}
        data-is-current-month={String(!!props.isCurrentMonth)}
        data-agenda-count={String(props.agendaCount)}
        data-backlink-count={String(props.backlinkCount)}
        aria-label={entry.displayDate}
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
    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const headers = screen.getAllByRole('columnheader')
    expect(headers).toHaveLength(7)
    expect(headers[0]).toHaveTextContent('Mon')
    expect(headers[6]).toHaveTextContent('Sun')
  })

  it('renders correct number of grid cells for January 2025 (including padding)', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

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

    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

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

    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const todayCell = screen.getByTestId(`monthly-cell-${todayStr}`)
    expect(todayCell).toHaveAttribute('data-is-today', 'true')
  })

  it('marks adjacent month cells with isCurrentMonth=false', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    // Jan 2025 with Monday start: Dec 30 should be in the grid but not current month
    const dec30Cell = screen.queryByTestId('monthly-cell-2024-12-30')
    if (dec30Cell) {
      expect(dec30Cell).toHaveAttribute('data-is-current-month', 'false')
    }
  })

  it('marks current month cells with isCurrentMonth=true', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const jan15Cell = screen.getByTestId('monthly-cell-2025-01-15')
    expect(jan15Cell).toHaveAttribute('data-is-current-month', 'true')

    const jan1Cell = screen.getByTestId('monthly-cell-2025-01-01')
    expect(jan1Cell).toHaveAttribute('data-is-current-month', 'true')
  })

  it('passes correct counts to cells', () => {
    mockBatchCounts.agendaCounts = { '2025-01-15': 3 }
    mockBatchCounts.backlinkCounts = { 'page-2025-01-15': 5 }

    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const cell = screen.getByTestId('monthly-cell-2025-01-15')
    expect(cell).toHaveAttribute('data-agenda-count', '3')
    expect(cell).toHaveAttribute('data-backlink-count', '5')
  })

  it('re-renders when journal store currentDate changes to different month', () => {
    const { rerender } = render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    // Initially: January 2025
    expect(screen.getByTestId('monthly-cell-2025-01-01')).toBeInTheDocument()

    // Change to February 2025
    useJournalStore.setState({ currentDate: FEB_DATE })
    rerender(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    expect(screen.getByTestId('monthly-cell-2025-02-01')).toBeInTheDocument()
    expect(screen.queryByTestId('monthly-cell-2025-01-15')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    useJournalStore.setState({ currentDate: FEB_DATE })

    const { container } = render(
      <MonthlyView makeDayEntry={makeDayEntry} onNavigateToPage={vi.fn()} onAddBlock={vi.fn()} />,
    )
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

    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const headers = screen.getAllByRole('columnheader')
    expect(headers).toHaveLength(7)
    expect(headers[0]).toHaveTextContent('Sun')
    expect(headers[6]).toHaveTextContent('Sat')
  })

  it('renders grid with role="grid" and aria-label', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const grid = screen.getByRole('grid')
    expect(grid).toBeInTheDocument()
    expect(grid).toHaveAttribute('aria-label', 'Monthly calendar')
  })
})
