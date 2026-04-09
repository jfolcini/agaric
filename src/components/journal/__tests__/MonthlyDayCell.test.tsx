/**
 * Tests for MonthlyDayCell component (UX-83).
 *
 * Validates:
 *  1. Renders date number
 *  2. Shows today highlight (bg-primary class)
 *  3. Adjacent month cell has opacity-40 and pointer-events-none
 *  4. Calls onNavigateToDate on click for current month
 *  5. Does NOT call onNavigateToDate for adjacent month
 *  6. Keyboard: Enter/Space triggers navigation
 *  7. Shows count dots when counts > 0
 *  8. Has aria-label with full date
 *  9. Has tabIndex 0 for current month, -1 for adjacent
 *  10. axe audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { DayEntry } from '../../../lib/date-utils'
import { MonthlyDayCell } from '../MonthlyDayCell'

function makeEntry(dateStr: string): DayEntry {
  const parts = dateStr.split('-')
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
  return {
    date,
    dateStr,
    displayDate: date.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }),
    pageId: `page-${dateStr}`,
  }
}

describe('MonthlyDayCell', () => {
  const defaultProps = {
    entry: makeEntry('2025-01-15'),
    isToday: false,
    isCurrentMonth: true,
    agendaCount: 0,
    backlinkCount: 0,
    onNavigateToDate: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders date number', () => {
    render(<MonthlyDayCell {...defaultProps} />)
    expect(screen.getByText('15')).toBeInTheDocument()
  })

  it('shows today highlight with bg-primary class', () => {
    const { container } = render(<MonthlyDayCell {...defaultProps} isToday />)
    // The date number span should have bg-primary when isToday
    const dateSpan = container.querySelector('.bg-primary')
    expect(dateSpan).toBeInTheDocument()
    expect(dateSpan).toHaveTextContent('15')
  })

  it('adjacent month cell has opacity-40 and pointer-events-none', () => {
    render(<MonthlyDayCell {...defaultProps} isCurrentMonth={false} />)
    const cell = screen.getByRole('gridcell')
    expect(cell.className).toContain('opacity-40')
    expect(cell.className).toContain('pointer-events-none')
  })

  it('calls onNavigateToDate on click for current month', async () => {
    const user = userEvent.setup()
    const onNavigateToDate = vi.fn()
    render(<MonthlyDayCell {...defaultProps} onNavigateToDate={onNavigateToDate} />)

    await user.click(screen.getByRole('gridcell'))
    expect(onNavigateToDate).toHaveBeenCalledWith('2025-01-15')
  })

  it('does NOT call onNavigateToDate for adjacent month', async () => {
    const user = userEvent.setup()
    const onNavigateToDate = vi.fn()
    render(
      <MonthlyDayCell
        {...defaultProps}
        isCurrentMonth={false}
        onNavigateToDate={onNavigateToDate}
      />,
    )

    // pointer-events-none prevents actual clicks, but we test the handler logic
    const cell = screen.getByRole('gridcell')
    // Force fire click even though pointer-events-none
    await user.click(cell)
    expect(onNavigateToDate).not.toHaveBeenCalled()
  })

  it('keyboard: Enter triggers navigation for current month', async () => {
    const user = userEvent.setup()
    const onNavigateToDate = vi.fn()
    render(<MonthlyDayCell {...defaultProps} onNavigateToDate={onNavigateToDate} />)

    const cell = screen.getByRole('gridcell')
    cell.focus()

    await user.keyboard('{Enter}')
    expect(onNavigateToDate).toHaveBeenCalledWith('2025-01-15')
  })

  it('keyboard: Space triggers navigation for current month', async () => {
    const user = userEvent.setup()
    const onNavigateToDate = vi.fn()
    render(<MonthlyDayCell {...defaultProps} onNavigateToDate={onNavigateToDate} />)

    const cell = screen.getByRole('gridcell')
    cell.focus()

    await user.keyboard(' ')
    expect(onNavigateToDate).toHaveBeenCalledWith('2025-01-15')
  })

  it('shows count dots when counts > 0', () => {
    const { container } = render(
      <MonthlyDayCell
        {...defaultProps}
        agendaCount={2}
        agendaCountsBySource={{ 'column:due_date': 2 }}
        backlinkCount={1}
      />,
    )

    // Should have dots rendered (small rounded-full elements)
    // 1 dot per agendaCountsBySource entry + 1 dot for backlinkCount > 0 = 2
    const dots = container.querySelectorAll('.rounded-full.w-1\\.5')
    expect(dots).toHaveLength(2)
  })

  it('shows total count badge when counts > 0', () => {
    render(<MonthlyDayCell {...defaultProps} agendaCount={3} backlinkCount={2} />)

    // Total = 5
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('does not show count dots when all counts are 0', () => {
    const { container } = render(
      <MonthlyDayCell {...defaultProps} agendaCount={0} backlinkCount={0} />,
    )

    // No small dots should be rendered
    const dots = container.querySelectorAll('.w-1\\.5')
    expect(dots).toHaveLength(0)
  })

  it('has aria-label with full date', () => {
    render(<MonthlyDayCell {...defaultProps} />)
    const cell = screen.getByRole('gridcell')
    // format(new Date(2025, 0, 15), 'EEEE, MMMM d, yyyy') = 'Wednesday, January 15, 2025'
    expect(cell).toHaveAttribute('aria-label', 'Wednesday, January 15, 2025')
  })

  it('has tabIndex 0 for current month', () => {
    render(<MonthlyDayCell {...defaultProps} isCurrentMonth />)
    const cell = screen.getByRole('gridcell')
    expect(cell).toHaveAttribute('tabindex', '0')
  })

  it('has tabIndex -1 for adjacent month', () => {
    render(<MonthlyDayCell {...defaultProps} isCurrentMonth={false} />)
    const cell = screen.getByRole('gridcell')
    expect(cell).toHaveAttribute('tabindex', '-1')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      // biome-ignore lint/a11y/useSemanticElements: test wrapper for ARIA grid context
      <div role="grid">
        {/* biome-ignore lint/a11y/useFocusableInteractive: test wrapper */}
        {/* biome-ignore lint/a11y/useSemanticElements: test wrapper */}
        <div role="row">
          <MonthlyDayCell {...defaultProps} />
        </div>
      </div>,
    )
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('has no a11y violations when gridcell is focused', async () => {
    const { container } = render(
      // biome-ignore lint/a11y/useSemanticElements: test wrapper for ARIA grid context
      <div role="grid">
        {/* biome-ignore lint/a11y/useFocusableInteractive: test wrapper */}
        {/* biome-ignore lint/a11y/useSemanticElements: test wrapper */}
        <div role="row">
          <MonthlyDayCell {...defaultProps} />
        </div>
      </div>,
    )
    const cell = screen.getByRole('gridcell')
    cell.focus()
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
