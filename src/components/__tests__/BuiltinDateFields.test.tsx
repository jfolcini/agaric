/**
 * Tests for BuiltinDateFields component.
 *
 * Validates:
 *  - Renders due date when provided
 *  - Renders scheduled date when provided
 *  - Renders both dates when both are provided
 *  - Returns null when neither date is provided
 *  - Shows separator when hasCustomProperties is true
 *  - Hides separator when hasCustomProperties is false
 *  - Clear button calls onClearDate
 *  - Date input calls onSaveDate
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('lucide-react', () => ({
  CalendarCheck2: ({ size }: { size: number }) => (
    <svg data-testid="calendar-check2-icon" width={size} height={size} />
  ),
  CalendarClock: ({ size }: { size: number }) => (
    <svg data-testid="calendar-clock-icon" width={size} height={size} />
  ),
  CalendarPlus: () => <svg data-testid="calendar-plus-icon" />,
  CheckCircle2: () => <svg data-testid="check-circle2-icon" />,
  Clock: () => <svg data-testid="clock-icon" />,
  MapPin: () => <svg data-testid="map-pin-icon" />,
  Repeat: () => <svg data-testid="repeat-icon" />,
  User: () => <svg data-testid="user-icon" />,
  X: () => <svg data-testid="x-icon" />,
}))

import { BuiltinDateFields } from '../BuiltinDateFields'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BuiltinDateFields', () => {
  it('renders due date when provided', () => {
    render(
      <BuiltinDateFields
        dueDate="2026-06-15"
        scheduledDate={null}
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )

    expect(screen.getByTitle('Due')).toBeInTheDocument()
    expect(screen.getByDisplayValue('2026-06-15')).toBeInTheDocument()
  })

  it('renders scheduled date when provided', () => {
    render(
      <BuiltinDateFields
        dueDate={null}
        scheduledDate="2026-07-01"
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )

    expect(screen.getByTitle('Scheduled')).toBeInTheDocument()
    expect(screen.getByDisplayValue('2026-07-01')).toBeInTheDocument()
  })

  it('renders both dates when both are provided', () => {
    render(
      <BuiltinDateFields
        dueDate="2026-06-15"
        scheduledDate="2026-07-01"
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )

    expect(screen.getByTitle('Due')).toBeInTheDocument()
    expect(screen.getByTitle('Scheduled')).toBeInTheDocument()
  })

  it('returns null when neither date is provided', () => {
    const { container } = render(
      <BuiltinDateFields
        dueDate={null}
        scheduledDate={null}
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )

    expect(container.innerHTML).toBe('')
  })

  it('shows separator when hasCustomProperties is true', () => {
    const { container } = render(
      <BuiltinDateFields
        dueDate="2026-06-15"
        scheduledDate={null}
        hasCustomProperties={true}
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )

    expect(container.querySelector('.border-t')).toBeInTheDocument()
  })

  it('hides separator when hasCustomProperties is false', () => {
    const { container } = render(
      <BuiltinDateFields
        dueDate="2026-06-15"
        scheduledDate={null}
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )

    expect(container.querySelector('.border-t')).not.toBeInTheDocument()
  })

  it('clear button calls onClearDate for due_date', async () => {
    const user = userEvent.setup()
    const onClearDate = vi.fn()
    render(
      <BuiltinDateFields
        dueDate="2026-06-15"
        scheduledDate={null}
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={onClearDate}
      />,
    )

    const clearBtn = screen.getByRole('button', { name: 'Clear due date' })
    await user.click(clearBtn)

    expect(onClearDate).toHaveBeenCalledWith('due_date')
  })

  it('clear button calls onClearDate for scheduled_date', async () => {
    const user = userEvent.setup()
    const onClearDate = vi.fn()
    render(
      <BuiltinDateFields
        dueDate={null}
        scheduledDate="2026-07-01"
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={onClearDate}
      />,
    )

    const clearBtn = screen.getByRole('button', { name: 'Clear scheduled date' })
    await user.click(clearBtn)

    expect(onClearDate).toHaveBeenCalledWith('scheduled_date')
  })

  it('date inputs have correct type attribute', () => {
    render(
      <BuiltinDateFields
        dueDate="2026-06-15"
        scheduledDate="2026-07-01"
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )

    const dueInput = screen.getByDisplayValue('2026-06-15')
    expect(dueInput).toHaveAttribute('type', 'date')

    const schedInput = screen.getByDisplayValue('2026-07-01')
    expect(schedInput).toHaveAttribute('type', 'date')
  })

  it('renders icons for date fields', () => {
    render(
      <BuiltinDateFields
        dueDate="2026-06-15"
        scheduledDate="2026-07-01"
        hasCustomProperties={false}
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )

    const dueBadge = screen.getByTitle('Due')
    expect(dueBadge.querySelector('svg')).toBeInTheDocument()

    const scheduledBadge = screen.getByTitle('Scheduled')
    expect(scheduledBadge.querySelector('svg')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <BuiltinDateFields
        dueDate="2025-06-15"
        scheduledDate="2025-07-01"
        hasCustomProperties
        onSaveDate={vi.fn()}
        onClearDate={vi.fn()}
      />,
    )
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
