/**
 * Tests for DeadlineWarningSection component.
 *
 * Validates:
 *  - Renders current warning threshold (default 0)
 *  - Updates threshold and persists to localStorage
 *  - Has no a11y violations (axe)
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { DeadlineWarningSection } from '../DeadlineWarningSection'

beforeEach(() => {
  localStorage.removeItem('agaric:deadlineWarningDays')
})

describe('DeadlineWarningSection', () => {
  it('renders current warning threshold (default 0)', () => {
    render(<DeadlineWarningSection />)

    const input = screen.getByRole('spinbutton', { name: /Deadline warning/i })
    expect(input).toHaveValue(0)
  })

  it('renders threshold from localStorage', () => {
    localStorage.setItem('agaric:deadlineWarningDays', '14')

    render(<DeadlineWarningSection />)

    const input = screen.getByRole('spinbutton', { name: /Deadline warning/i })
    expect(input).toHaveValue(14)
  })

  it('updates threshold', async () => {
    const user = userEvent.setup()

    render(<DeadlineWarningSection />)

    const input = screen.getByRole('spinbutton', { name: /Deadline warning/i })
    await user.clear(input)
    await user.type(input, '7')

    expect(input).toHaveValue(7)
    expect(localStorage.getItem('agaric:deadlineWarningDays')).toBe('7')
  })

  it('clamps value to max 90', async () => {
    const user = userEvent.setup()

    render(<DeadlineWarningSection />)

    const input = screen.getByRole('spinbutton', { name: /Deadline warning/i })
    await user.clear(input)
    await user.type(input, '100')

    expect(input).toHaveValue(90)
    expect(localStorage.getItem('agaric:deadlineWarningDays')).toBe('90')
  })

  it('renders description text', () => {
    render(<DeadlineWarningSection />)

    expect(screen.getByText('days (0 = disabled)')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<DeadlineWarningSection />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
