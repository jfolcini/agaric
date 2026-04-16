/**
 * Tests for BlockDatePicker component.
 *
 * Validates:
 *  1. Date picker renders calendar and text input
 *  2. Escape key closes picker
 *  3. Date text input updates preview
 *  4. Calendar date selection calls handler
 *  5. Axe accessibility audit
 *  6. Focus auto-capture on mount
 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BlockDatePicker } from '../BlockDatePicker'

// ── Mocks ────────────────────────────────────────────────────────────────

// useWeekStart — return Monday start
vi.mock('../../../hooks/useWeekStart', () => ({
  useWeekStart: () => ({ weekStartsOn: 1 as const }),
}))

// parseDate — controllable mock for preview tests
const mockParseDate = vi.fn()
vi.mock('../../../lib/parse-date', () => ({
  parseDate: (...args: unknown[]) => mockParseDate(...args),
}))

// Calendar — renders a simple clickable day button to test onSelect pass-through
vi.mock('../../ui/calendar', () => ({
  Calendar: ({ onSelect }: { onSelect?: (day: Date | undefined) => void }) => (
    <div data-testid="calendar-mock">
      <button
        type="button"
        data-testid="calendar-day-15"
        onClick={() => onSelect?.(new Date(2025, 2, 15))}
      >
        15
      </button>
    </div>
  ),
}))

// ScrollArea — passthrough wrapper (Radix primitives need browser APIs)
vi.mock('../../ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

// ── Test suite ───────────────────────────────────────────────────────────

describe('BlockDatePicker', () => {
  const onSelect = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockParseDate.mockReturnValue(null)
  })

  // ── 1. Render test ──────────────────────────────────────────────────

  it('renders calendar and text input', () => {
    render(<BlockDatePicker onSelect={onSelect} onClose={onClose} />)

    // Calendar mock is present
    expect(screen.getByTestId('calendar-mock')).toBeInTheDocument()

    // Text input is present with correct aria-label
    const input = screen.getByRole('textbox', { name: 'Type a date' })
    expect(input).toBeInTheDocument()

    // Dialog container is present
    const dialog = screen.getByRole('dialog', { name: 'Date picker' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  // ── 2. Escape key closes picker ────────────────────────────────────

  it('calls onClose when Escape is pressed', () => {
    render(<BlockDatePicker onSelect={onSelect} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ── 3. Date text input updates preview ─────────────────────────────

  it('shows parsed date preview when typing a valid date', async () => {
    mockParseDate.mockReturnValue('2025-03-15')
    const user = userEvent.setup()

    render(<BlockDatePicker onSelect={onSelect} onClose={onClose} />)

    const input = screen.getByRole('textbox', { name: 'Type a date' })
    await user.type(input, '2025-03-15')

    // The preview should show the parsed date in a <strong> tag
    expect(screen.getByText('2025-03-15')).toBeInTheDocument()
    // The "Parsed:" label is part of a mixed-content <p>; use substring match
    expect(screen.getByText(/Parsed:/)).toBeInTheDocument()
  })

  // ── 4. Calendar date selection calls handler ───────────────────────

  it('calls onSelect when a calendar date is clicked', async () => {
    const user = userEvent.setup()

    render(<BlockDatePicker onSelect={onSelect} onClose={onClose} />)

    const dayButton = screen.getByTestId('calendar-day-15')
    await user.click(dayButton)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(new Date(2025, 2, 15))
  })

  // ── 5. Axe accessibility audit ─────────────────────────────────────

  it('has no a11y violations', async () => {
    const { container } = render(<BlockDatePicker onSelect={onSelect} onClose={onClose} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── 6. Focus auto-capture on mount ─────────────────────────────────

  it('auto-focuses the text input on mount', () => {
    render(<BlockDatePicker onSelect={onSelect} onClose={onClose} />)

    const input = screen.getByRole('textbox', { name: 'Type a date' })
    expect(document.activeElement).toBe(input)
  })
})
