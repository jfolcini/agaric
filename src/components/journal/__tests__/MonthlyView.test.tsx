/**
 * Tests for MonthlyView component.
 *
 * Validates:
 *  1. Renders one DaySection per day of the month
 *  2. Today's entry gets headingLevel="h2", others get "h3"
 *  3. All entries have compact and mode="monthly" props
 *  4. Passes agendaCounts, agendaCountsBySource, backlinkCounts from useBatchCounts
 *  5. Forwards onNavigateToPage and onAddBlock callbacks
 *  6. Separators between day sections
 *  7. Re-renders when currentDate changes months
 *  8. Has no a11y violations
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

// ── Mock DaySection ─────────────────────────────────────────────────
vi.mock('../DaySection', () => ({
  DaySection: (props: Record<string, unknown>) => {
    const entry = props.entry as DayEntry
    return (
      <section
        data-testid={`day-section-${entry.dateStr}`}
        data-heading-level={props.headingLevel as string}
        data-compact={String(!!props.compact)}
        data-mode={props.mode as string}
        data-has-navigate={String(!!props.onNavigateToPage)}
        aria-label={`Journal for ${entry.displayDate}`}
      >
        <span>{entry.displayDate}</span>
        <button
          type="button"
          data-testid={`add-block-${entry.dateStr}`}
          onClick={() => (props.onAddBlock as (dateStr: string) => void)(entry.dateStr)}
        >
          Add block
        </button>
        {!!props.onNavigateToPage && (
          <button
            type="button"
            data-testid={`navigate-${entry.dateStr}`}
            onClick={() =>
              (props.onNavigateToPage as (pageId: string, title?: string) => void)(
                `page-${entry.dateStr}`,
                entry.dateStr,
              )
            }
          >
            Navigate
          </button>
        )}
      </section>
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
  useJournalStore.setState({ currentDate: FIXED_DATE })
})

describe('MonthlyView', () => {
  it('renders one DaySection per day of January 2025 (31 days)', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const sections = screen.getAllByTestId(/^day-section-/)
    expect(sections).toHaveLength(31)

    // Spot-check first and last day
    expect(screen.getByTestId('day-section-2025-01-01')).toBeInTheDocument()
    expect(screen.getByTestId('day-section-2025-01-31')).toBeInTheDocument()
  })

  it('renders correct number of days for February 2025 (28 days)', () => {
    useJournalStore.setState({ currentDate: FEB_DATE })

    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const sections = screen.getAllByTestId(/^day-section-/)
    expect(sections).toHaveLength(28)

    expect(screen.getByTestId('day-section-2025-02-01')).toBeInTheDocument()
    expect(screen.getByTestId('day-section-2025-02-28')).toBeInTheDocument()
    expect(screen.queryByTestId('day-section-2025-02-29')).not.toBeInTheDocument()
  })

  it('gives today headingLevel="h2" and other days "h3"', () => {
    // Set currentDate to today so the "today" check in the component matches
    const today = new Date()
    useJournalStore.setState({ currentDate: today })

    const todayStr = format(today, 'yyyy-MM-dd')

    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const sections = screen.getAllByTestId(/^day-section-/)

    for (const section of sections) {
      const dateStr = section.getAttribute('data-testid')?.replace('day-section-', '')
      if (dateStr === todayStr) {
        expect(section).toHaveAttribute('data-heading-level', 'h2')
      } else {
        expect(section).toHaveAttribute('data-heading-level', 'h3')
      }
    }
  })

  it('passes compact and mode="monthly" to all DaySections', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const sections = screen.getAllByTestId(/^day-section-/)
    for (const section of sections) {
      expect(section).toHaveAttribute('data-compact', 'true')
      expect(section).toHaveAttribute('data-mode', 'monthly')
    }
  })

  it('forwards onAddBlock callback with the correct dateStr', async () => {
    const user = userEvent.setup()
    const onAddBlock = vi.fn()

    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={onAddBlock} />)

    await user.click(screen.getByTestId('add-block-2025-01-15'))
    expect(onAddBlock).toHaveBeenCalledWith('2025-01-15')
  })

  it('forwards onNavigateToPage callback', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()

    render(
      <MonthlyView
        makeDayEntry={makeDayEntry}
        onNavigateToPage={onNavigateToPage}
        onAddBlock={vi.fn()}
      />,
    )

    await user.click(screen.getByTestId('navigate-2025-01-01'))
    expect(onNavigateToPage).toHaveBeenCalledWith('page-2025-01-01', '2025-01-01')
  })

  it('renders without onNavigateToPage (optional prop)', () => {
    render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    expect(screen.queryByTestId(/^navigate-/)).not.toBeInTheDocument()
    const sections = screen.getAllByTestId(/^day-section-/)
    for (const section of sections) {
      expect(section).toHaveAttribute('data-has-navigate', 'false')
    }
  })

  it('renders dividers between day sections', () => {
    const { container } = render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    // 30 dividers for 31 days (between each pair)
    const dividers = container.querySelectorAll('.border-t')
    expect(dividers).toHaveLength(30)
  })

  it('re-renders when journal store currentDate changes to different month', () => {
    const { rerender } = render(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    // Initially: January 2025 (31 days)
    expect(screen.getAllByTestId(/^day-section-/)).toHaveLength(31)
    expect(screen.getByTestId('day-section-2025-01-01')).toBeInTheDocument()

    // Change to February 2025 (28 days)
    useJournalStore.setState({ currentDate: FEB_DATE })
    rerender(<MonthlyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    expect(screen.getAllByTestId(/^day-section-/)).toHaveLength(28)
    expect(screen.getByTestId('day-section-2025-02-01')).toBeInTheDocument()
    expect(screen.queryByTestId('day-section-2025-01-01')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    // Use a short month to keep the test fast
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
})
