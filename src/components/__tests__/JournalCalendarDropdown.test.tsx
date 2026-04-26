import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { logger } from '@/lib/logger'
import { computeSourceModifiers, JournalCalendarDropdown } from '../journal/JournalCalendarDropdown'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: 0 })),
}))

vi.mock('../ui/calendar', () => ({
  Calendar: (props: Record<string, unknown>) => {
    const modifiers = props['modifiers'] as Record<string, Date[]> | undefined
    const components = props['components'] as Record<string, unknown> | undefined
    return (
      <div
        data-testid="mock-calendar"
        data-has-content={modifiers?.['hasContent']?.length ?? 0}
        data-has-due={modifiers?.['hasDue']?.length ?? 0}
        data-has-scheduled={modifiers?.['hasScheduled']?.length ?? 0}
        data-has-property={modifiers?.['hasProperty']?.length ?? 0}
        data-has-day-button={components?.['DayButton'] ? 'true' : 'false'}
      >
        Calendar
      </div>
    )
  },
}))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue({})
})

describe('computeSourceModifiers', () => {
  it('returns empty arrays for null/undefined data', () => {
    const result = computeSourceModifiers(null as unknown as Record<string, Record<string, number>>)
    expect(result.datesWithDue).toHaveLength(0)
    expect(result.datesWithScheduled).toHaveLength(0)
    expect(result.datesWithProperty).toHaveLength(0)
  })

  it('returns empty arrays for empty object', () => {
    const result = computeSourceModifiers({})
    expect(result.datesWithDue).toHaveLength(0)
    expect(result.datesWithScheduled).toHaveLength(0)
    expect(result.datesWithProperty).toHaveLength(0)
  })

  it('detects due dates from column:due_date source', () => {
    const data = {
      '2025-06-15': { 'column:due_date': 2 },
    }
    const result = computeSourceModifiers(data)
    expect(result.datesWithDue).toHaveLength(1)
    expect(result.datesWithDue[0]?.getFullYear()).toBe(2025)
    expect(result.datesWithDue[0]?.getMonth()).toBe(5)
    expect(result.datesWithDue[0]?.getDate()).toBe(15)
  })

  it('detects scheduled dates from column:scheduled_date source', () => {
    const data = {
      '2025-06-20': { 'column:scheduled_date': 1 },
    }
    const result = computeSourceModifiers(data)
    expect(result.datesWithScheduled).toHaveLength(1)
    expect(result.datesWithScheduled[0]?.getDate()).toBe(20)
  })

  it('detects property dates from property: prefixed sources', () => {
    const data = {
      '2025-06-25': { 'property:deadline': 3 },
    }
    const result = computeSourceModifiers(data)
    expect(result.datesWithProperty).toHaveLength(1)
    expect(result.datesWithProperty[0]?.getDate()).toBe(25)
  })

  it('handles multiple dates with mixed sources', () => {
    const data = {
      '2025-06-10': { 'column:due_date': 1, 'column:scheduled_date': 2 },
      '2025-06-11': { 'property:custom': 1 },
      '2025-06-12': { 'column:due_date': 0, 'column:scheduled_date': 0 },
    }
    const result = computeSourceModifiers(data)
    expect(result.datesWithDue).toHaveLength(1)
    expect(result.datesWithScheduled).toHaveLength(1)
    expect(result.datesWithProperty).toHaveLength(1)
  })

  it('skips entries with invalid date strings', () => {
    const data = {
      invalid: { 'column:due_date': 1 },
      '2025-06-15': { 'column:due_date': 1 },
    }
    const result = computeSourceModifiers(data)
    expect(result.datesWithDue).toHaveLength(1)
  })

  it('skips entries where sources is not an object', () => {
    const data = {
      '2025-06-15': null as unknown as Record<string, number>,
    }
    const result = computeSourceModifiers(data)
    expect(result.datesWithDue).toHaveLength(0)
  })

  it('ignores zero-count sources', () => {
    const data = {
      '2025-06-15': { 'column:due_date': 0, 'property:test': 0 },
    }
    const result = computeSourceModifiers(data)
    expect(result.datesWithDue).toHaveLength(0)
    expect(result.datesWithProperty).toHaveLength(0)
  })
})

describe('JournalCalendarDropdown', () => {
  const defaultProps = {
    currentDate: new Date(2025, 5, 15),
    highlightedDays: [],
    onSelectDate: vi.fn(),
    onSelectWeek: vi.fn(),
    onSelectMonth: vi.fn(),
    onClose: vi.fn(),
  }

  it('renders a dialog with date picker label', () => {
    render(<JournalCalendarDropdown {...defaultProps} />)
    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()
  })

  it('renders the calendar component', () => {
    render(<JournalCalendarDropdown {...defaultProps} />)
    expect(screen.getByTestId('mock-calendar')).toBeInTheDocument()
  })

  it('renders a backdrop overlay', () => {
    render(<JournalCalendarDropdown {...defaultProps} />)
    const backdrop = document.querySelector('.fixed.inset-0')
    expect(backdrop).not.toBeNull()
  })

  it('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<JournalCalendarDropdown {...defaultProps} onClose={onClose} />)

    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement
    await user.click(backdrop)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<JournalCalendarDropdown {...defaultProps} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('fetches agenda counts on mount', async () => {
    render(<JournalCalendarDropdown {...defaultProps} />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'count_agenda_batch_by_source',
        expect.objectContaining({
          dates: expect.arrayContaining([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]),
        }),
      )
    })
  })

  it('passes highlighted days as modifiers to Calendar', () => {
    const highlightedDays = [new Date(2025, 5, 10), new Date(2025, 5, 20)]
    render(<JournalCalendarDropdown {...defaultProps} highlightedDays={highlightedDays} />)

    const calendar = screen.getByTestId('mock-calendar')
    expect(calendar).toHaveAttribute('data-has-content', '2')
  })

  it('positions below by default (top-full class)', () => {
    render(<JournalCalendarDropdown {...defaultProps} />)

    const dropdown = screen.getByRole('dialog')
    expect(dropdown.className).toContain('top-full')
    expect(dropdown.className).not.toContain('bottom-full')
  })

  it('flips above when calendar overflows viewport bottom', () => {
    const originalGBCR = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = () => ({
      top: 500,
      bottom: 900,
      left: 100,
      right: 400,
      width: 300,
      height: 400,
      x: 100,
      y: 500,
      toJSON: () => {},
    })
    // The mock object intentionally lacks `addEventListener`. If left in
    // place, floating-ui's `autoUpdate` will crash on the next Radix
    // Tooltip/Popover mount (see the matching test in JournalPage.test.tsx
    // and the global afterEach in test-setup.ts for the full story).
    Object.defineProperty(window, 'visualViewport', {
      value: { height: 600, width: 1024 },
      writable: true,
      configurable: true,
    })

    try {
      render(<JournalCalendarDropdown {...defaultProps} />)

      const dropdown = screen.getByRole('dialog')
      expect(dropdown.className).toContain('bottom-full')
    } finally {
      Element.prototype.getBoundingClientRect = originalGBCR
      // biome-ignore lint/performance/noDelete: restoring jsdom default (undefined)
      delete (window as { visualViewport?: unknown }).visualViewport
    }
  })

  it('shifts right when calendar overflows left edge', () => {
    const originalGBCR = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = () => ({
      top: 50,
      bottom: 350,
      left: -20,
      right: 280,
      width: 300,
      height: 300,
      x: -20,
      y: 50,
      toJSON: () => {},
    })
    Object.defineProperty(window, 'visualViewport', {
      value: { height: 800, width: 300 },
      writable: true,
      configurable: true,
    })

    try {
      render(<JournalCalendarDropdown {...defaultProps} />)

      const dropdown = screen.getByRole('dialog') as HTMLElement
      expect(dropdown.style.transform).toBe('translateX(28px)')
    } finally {
      Element.prototype.getBoundingClientRect = originalGBCR
      // biome-ignore lint/performance/noDelete: restoring jsdom default (undefined)
      delete (window as { visualViewport?: unknown }).visualViewport
    }
  })

  it('passes custom DayButton component to Calendar instead of inline styles', () => {
    render(<JournalCalendarDropdown {...defaultProps} />)

    // No inline <style> tag should be present
    const styleEl = document.querySelector('style')
    expect(styleEl).toBeNull()

    // Calendar should receive a custom DayButton component
    const calendar = screen.getByTestId('mock-calendar')
    expect(calendar).toHaveAttribute('data-has-day-button', 'true')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<JournalCalendarDropdown {...defaultProps} />)
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with highlighted days', async () => {
    const highlightedDays = [new Date(2025, 5, 10)]
    const { container } = render(
      <JournalCalendarDropdown {...defaultProps} highlightedDays={highlightedDays} />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // -----------------------------------------------------------------------
  // Error-path tests (mockRejectedValueOnce)
  // -----------------------------------------------------------------------

  it('still renders calendar when countAgendaBatchBySource rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Backend unavailable'))

    render(<JournalCalendarDropdown {...defaultProps} />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'count_agenda_batch_by_source',
        expect.objectContaining({ dates: expect.any(Array) }),
      )
    })

    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()
    expect(screen.getByTestId('mock-calendar')).toBeInTheDocument()
  })

  it('logs warning when countAgendaBatchBySource rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('DB connection lost'))

    render(<JournalCalendarDropdown {...defaultProps} />)

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'JournalCalendarDropdown',
        'Failed to load agenda counts for calendar',
        undefined,
        expect.objectContaining({ message: 'DB connection lost' }),
      )
    })
  })

  it('shows zero agenda-source dots when countAgendaBatchBySource rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Timeout'))

    render(<JournalCalendarDropdown {...defaultProps} />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalled()
    })

    const calendar = screen.getByTestId('mock-calendar')
    expect(calendar).toHaveAttribute('data-has-due', '0')
    expect(calendar).toHaveAttribute('data-has-scheduled', '0')
    expect(calendar).toHaveAttribute('data-has-property', '0')
  })

  it('does not crash on non-Error rejection from countAgendaBatchBySource', async () => {
    mockedInvoke.mockRejectedValueOnce('string error without Error wrapper')

    render(<JournalCalendarDropdown {...defaultProps} />)

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'JournalCalendarDropdown',
        'Failed to load agenda counts for calendar',
        undefined,
        'string error without Error wrapper',
      )
    })

    expect(screen.getByRole('dialog', { name: /date picker/i })).toBeInTheDocument()
  })

  // ── Calendar dot legend ─────────────────────────────────────────────

  it('renders color dot legend with all 4 source labels inside the dropdown', () => {
    render(<JournalCalendarDropdown {...defaultProps} />)

    const legend = screen.getByTestId('calendar-legend')
    expect(legend).toBeInTheDocument()

    // All 4 legend labels should be present
    expect(within(legend).getByText('Page')).toBeInTheDocument()
    expect(within(legend).getByText('Due')).toBeInTheDocument()
    expect(within(legend).getByText('Scheduled')).toBeInTheDocument()
    expect(within(legend).getByText('Property')).toBeInTheDocument()
  })
})
