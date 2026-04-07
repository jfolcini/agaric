/**
 * Tests for CollapsiblePanelHeader component (R-15).
 *
 * Validates:
 *  1. Renders children text
 *  2. Shows ChevronDown when not collapsed (aria-expanded=true)
 *  3. Shows ChevronRight when collapsed (aria-expanded=false)
 *  4. Calls onToggle when clicked
 *  5. Applies custom className
 *  6. Has no a11y violations (axe)
 *  7. Focus-visible ring classes are present (UX-1)
 *  8. aria-label changes with collapsed state (UX-2)
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('lucide-react', () => ({
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="chevron-down" {...props} />,
}))

import { CollapsiblePanelHeader } from '../CollapsiblePanelHeader'

describe('CollapsiblePanelHeader', () => {
  it('renders children text', () => {
    render(
      <CollapsiblePanelHeader collapsed={false} onToggle={() => {}}>
        3 Completed
      </CollapsiblePanelHeader>,
    )
    expect(screen.getByText('3 Completed')).toBeInTheDocument()
  })

  it('shows ChevronDown when not collapsed (aria-expanded=true)', () => {
    render(
      <CollapsiblePanelHeader collapsed={false} onToggle={() => {}}>
        Header
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('chevron-down')).toBeInTheDocument()
    expect(screen.queryByTestId('chevron-right')).not.toBeInTheDocument()
  })

  it('shows ChevronRight when collapsed (aria-expanded=false)', () => {
    render(
      <CollapsiblePanelHeader collapsed={true} onToggle={() => {}}>
        Header
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('chevron-right')).toBeInTheDocument()
    expect(screen.queryByTestId('chevron-down')).not.toBeInTheDocument()
  })

  it('calls onToggle when clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <CollapsiblePanelHeader collapsed={false} onToggle={onToggle}>
        Header
      </CollapsiblePanelHeader>,
    )
    await user.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('applies custom className', () => {
    render(
      <CollapsiblePanelHeader collapsed={false} onToggle={() => {}} className="done-panel-header">
        Header
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button.className).toContain('done-panel-header')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <CollapsiblePanelHeader collapsed={false} onToggle={() => {}} className="due-panel-header">
        2 Due
      </CollapsiblePanelHeader>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('includes focus-visible ring classes on the button (UX-1)', () => {
    render(
      <CollapsiblePanelHeader collapsed={false} onToggle={() => {}}>
        Header
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button.className).toContain('focus-visible:ring-2')
    expect(button.className).toContain('focus-visible:ring-ring')
    expect(button.className).toContain('focus-visible:ring-offset-1')
  })

  it('sets aria-label to "Expand …" when collapsed (UX-2)', () => {
    render(
      <CollapsiblePanelHeader collapsed={true} onToggle={() => {}}>
        References
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-label', 'Expand References')
  })

  it('sets aria-label to "Collapse …" when not collapsed (UX-2)', () => {
    render(
      <CollapsiblePanelHeader collapsed={false} onToggle={() => {}}>
        References
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-label', 'Collapse References')
  })

  it('handles non-string children gracefully in aria-label (UX-2)', () => {
    render(
      <CollapsiblePanelHeader collapsed={true} onToggle={() => {}}>
        <span>Complex child</span>
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    // Non-string children → aria-label is omitted, text content is the accessible name
    expect(button).not.toHaveAttribute('aria-label')
  })
})
