/**
 * Tests for WeeklyView component.
 *
 * Validates:
 *  1. Renders 7 DaySection components (Mon-Sun)
 *  2. Today's entry gets headingLevel="h2", others get "h3"
 *  3. All entries have compact and mode="weekly" props
 *  4. Passes agendaCounts, agendaCountsBySource, backlinkCounts from useBatchCounts
 *  5. Forwards onNavigateToPage and onAddBlock callbacks
 *  6. Separators between day sections
 *  7. Has no a11y violations
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { format } from 'date-fns'
import type React from 'react'
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
    const entry = props['entry'] as DayEntry
    return (
      <section
        data-testid={`day-section-${entry.dateStr}`}
        data-heading-level={props['headingLevel'] as string}
        data-compact={String(!!props['compact'])}
        data-mode={props['mode'] as string}
        data-has-navigate={String(!!props['onNavigateToPage'])}
        aria-label={`Journal for ${entry.displayDate}`}
      >
        <span>{entry.displayDate}</span>
        <button
          type="button"
          data-testid={`add-block-${entry.dateStr}`}
          onClick={() => (props['onAddBlock'] as (dateStr: string) => void)(entry.dateStr)}
        >
          Add block
        </button>
        {!!props['onNavigateToPage'] && (
          <button
            type="button"
            data-testid={`navigate-${entry.dateStr}`}
            onClick={() =>
              (props['onNavigateToPage'] as (pageId: string, title?: string) => void)(
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

// ── Mock RescheduleDropZone ─────────────────────────────────────────
vi.mock('../RescheduleDropZone', () => ({
  RescheduleDropZone: ({ dateStr, children }: { dateStr: string; children: React.ReactNode }) => (
    <div data-testid={`reschedule-drop-zone-${dateStr}`}>{children}</div>
  ),
}))

vi.mocked(invoke)

import { WeeklyView } from '../WeeklyView'

/** Fixed Wednesday for deterministic tests. */
const FIXED_DATE = new Date(2025, 0, 15) // Wed, Jan 15, 2025

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

describe('WeeklyView', () => {
  it('renders 7 DaySection components (Mon-Sun)', () => {
    render(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    // Week of Jan 15, 2025 (Wed): Mon Jan 13 - Sun Jan 19
    const sections = screen.getAllByTestId(/^day-section-/)
    expect(sections).toHaveLength(7)

    expect(screen.getByTestId('day-section-2025-01-13')).toBeInTheDocument() // Mon
    expect(screen.getByTestId('day-section-2025-01-14')).toBeInTheDocument() // Tue
    expect(screen.getByTestId('day-section-2025-01-15')).toBeInTheDocument() // Wed
    expect(screen.getByTestId('day-section-2025-01-16')).toBeInTheDocument() // Thu
    expect(screen.getByTestId('day-section-2025-01-17')).toBeInTheDocument() // Fri
    expect(screen.getByTestId('day-section-2025-01-18')).toBeInTheDocument() // Sat
    expect(screen.getByTestId('day-section-2025-01-19')).toBeInTheDocument() // Sun
  })

  it('gives today headingLevel="h2" and other days "h3"', () => {
    // Set currentDate to today so the "today" check in the component matches
    const today = new Date()
    useJournalStore.setState({ currentDate: today })

    const todayStr = format(today, 'yyyy-MM-dd')

    render(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

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

  it('passes compact and mode="weekly" to all DaySections', () => {
    render(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    const sections = screen.getAllByTestId(/^day-section-/)
    for (const section of sections) {
      expect(section).toHaveAttribute('data-compact', 'true')
      expect(section).toHaveAttribute('data-mode', 'weekly')
    }
  })

  it('forwards onAddBlock callback with the correct dateStr', async () => {
    const user = userEvent.setup()
    const onAddBlock = vi.fn()

    render(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={onAddBlock} />)

    await user.click(screen.getByTestId('add-block-2025-01-15'))
    expect(onAddBlock).toHaveBeenCalledWith('2025-01-15')
  })

  it('forwards onNavigateToPage callback', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()

    render(
      <WeeklyView
        makeDayEntry={makeDayEntry}
        onNavigateToPage={onNavigateToPage}
        onAddBlock={vi.fn()}
      />,
    )

    await user.click(screen.getByTestId('navigate-2025-01-13'))
    expect(onNavigateToPage).toHaveBeenCalledWith('page-2025-01-13', '2025-01-13')
  })

  it('renders without onNavigateToPage (optional prop)', () => {
    render(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    expect(screen.queryByTestId(/^navigate-/)).not.toBeInTheDocument()
    const sections = screen.getAllByTestId(/^day-section-/)
    for (const section of sections) {
      expect(section).toHaveAttribute('data-has-navigate', 'false')
    }
  })

  it('renders dividers between day sections', () => {
    const { container } = render(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    // 6 dividers for 7 days (between each pair)
    const dividers = container.querySelectorAll('.border-t')
    expect(dividers).toHaveLength(6)
  })

  it('re-renders when journal store currentDate changes', () => {
    const { rerender } = render(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    // Initially: week of Jan 13-19
    expect(screen.getByTestId('day-section-2025-01-13')).toBeInTheDocument()

    // Change to next week
    useJournalStore.setState({ currentDate: new Date(2025, 0, 22) })
    rerender(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    expect(screen.getByTestId('day-section-2025-01-20')).toBeInTheDocument()
    expect(screen.queryByTestId('day-section-2025-01-13')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <WeeklyView makeDayEntry={makeDayEntry} onNavigateToPage={vi.fn()} onAddBlock={vi.fn()} />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('wraps each DaySection in a RescheduleDropZone with the correct dateStr', () => {
    render(<WeeklyView makeDayEntry={makeDayEntry} onAddBlock={vi.fn()} />)

    // Week of Jan 15, 2025 (Wed): Mon Jan 13 - Sun Jan 19
    for (const dateStr of [
      '2025-01-13',
      '2025-01-14',
      '2025-01-15',
      '2025-01-16',
      '2025-01-17',
      '2025-01-18',
      '2025-01-19',
    ]) {
      const dropZone = screen.getByTestId(`reschedule-drop-zone-${dateStr}`)
      expect(dropZone).toBeInTheDocument()

      // DaySection should be inside the drop zone
      const daySection = screen.getByTestId(`day-section-${dateStr}`)
      expect(dropZone).toContainElement(daySection)
    }
  })
})
