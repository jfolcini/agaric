/**
 * Tests ToggleRow UI primitive (#1653).
 *
 * Validates:
 *  - Renders label + help text + a switch
 *  - The Switch is named by its Label for a11y — `getByRole('switch', { name })`
 *    resolves via the `htmlFor`/`id` association
 *  - Toggling fires `onCheckedChange` with the next state
 *  - `disabled` forwards to the Switch
 *  - `data-testid` forwards onto the Switch
 *  - a11y: `axe(container)` clean
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { ToggleRow } from '../toggle-row'

const defaultProps = {
  id: 'sample-toggle',
  label: 'Enable feature',
  description: 'Turns the sample feature on or off.',
  checked: false,
  onCheckedChange: vi.fn(),
}

describe('ToggleRow', () => {
  it('renders the label, help text, and a switch', () => {
    render(<ToggleRow {...defaultProps} />)

    expect(screen.getByText('Enable feature')).toBeInTheDocument()
    expect(screen.getByText('Turns the sample feature on or off.')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeInTheDocument()
  })

  it('associates the Label with the Switch (a11y name resolves via label/id)', () => {
    render(<ToggleRow {...defaultProps} />)

    // The switch is reachable by its accessible name, proving the
    // htmlFor/id wiring (and aria-label) name the control.
    const toggle = screen.getByRole('switch', { name: 'Enable feature' })
    expect(toggle).toHaveAttribute('id', 'sample-toggle')
  })

  it('reflects the checked state', () => {
    const { rerender } = render(<ToggleRow {...defaultProps} checked={false} />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')

    rerender(<ToggleRow {...defaultProps} checked={true} />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('calls onCheckedChange with the next state when toggled', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<ToggleRow {...defaultProps} checked={false} onCheckedChange={onCheckedChange} />)

    await user.click(screen.getByRole('switch'))

    expect(onCheckedChange).toHaveBeenCalledTimes(1)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('does not fire onCheckedChange when disabled', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<ToggleRow {...defaultProps} disabled onCheckedChange={onCheckedChange} />)

    const toggle = screen.getByRole('switch')
    expect(toggle).toBeDisabled()
    await user.click(toggle)
    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  it('forwards data-testid onto the Switch', () => {
    render(<ToggleRow {...defaultProps} data-testid="sample-toggle-switch" />)
    expect(screen.getByTestId('sample-toggle-switch')).toBe(screen.getByRole('switch'))
  })

  it('has no a11y violations', async () => {
    const { container } = render(<ToggleRow {...defaultProps} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
