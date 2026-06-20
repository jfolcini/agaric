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
 * 7. Focus-visible ring classes are present
 * 8. aria-label changes with collapsed state
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('@/components/ui/chevron-toggle', () => ({
  ChevronToggle: ({ isExpanded, ...rest }: { isExpanded: boolean } & Record<string, unknown>) => (
    <svg data-testid={isExpanded ? 'chevron-down' : 'chevron-right'} {...rest} />
  ),
}))

import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CollapsiblePanelHeader', () => {
  it('renders children text', () => {
    render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}}>
        3 Completed
      </CollapsiblePanelHeader>,
    )
    expect(screen.getByText('3 Completed')).toBeInTheDocument()
  })

  it('shows ChevronDown when not collapsed (aria-expanded=true)', () => {
    render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}}>
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
      <CollapsiblePanelHeader isCollapsed onToggle={() => {}}>
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
      <CollapsiblePanelHeader isCollapsed={false} onToggle={onToggle}>
        Header
      </CollapsiblePanelHeader>,
    )
    await user.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('applies custom className', () => {
    render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}} className="done-panel-header">
        Header
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button.className).toContain('done-panel-header')
  })

  it('applies testId as data-testid on the button when provided', () => {
    render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}} testId="my-panel-header">
        Header
      </CollapsiblePanelHeader>,
    )
    expect(screen.getByTestId('my-panel-header')).toBe(screen.getByRole('button'))
  })

  it('does not set data-testid when testId prop is omitted', () => {
    render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}}>
        Header
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button.getAttribute('data-testid')).toBeNull()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}} className="due-panel-header">
        2 Due
      </CollapsiblePanelHeader>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('includes focus-visible ring classes on the button ()', () => {
    render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}}>
        Header
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button.className).toContain('focus-ring-visible')
  })

  // Header button must allow shrinking inside a narrow flex parent so
  // siblings like the inline filter toggle never wrap below it.
  it('includes min-w-0 on the button to allow flex shrinking', () => {
    render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}}>
        Header
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button.className).toContain('min-w-0')
    // w-full must remain — the full-width click target is intentional.
    expect(button.className).toContain('w-full')
  })

  it('sets aria-label to "Expand …" when collapsed', () => {
    render(
      <CollapsiblePanelHeader isCollapsed onToggle={() => {}}>
        References
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-label', 'Expand References')
  })

  it('sets aria-label to "Collapse …" when not collapsed', () => {
    render(
      <CollapsiblePanelHeader isCollapsed={false} onToggle={() => {}}>
        References
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-label', 'Collapse References')
  })

  it('handles non-string children gracefully in aria-label', () => {
    render(
      <CollapsiblePanelHeader isCollapsed onToggle={() => {}}>
        <span>Complex child</span>
      </CollapsiblePanelHeader>,
    )
    const button = screen.getByRole('button')
    // Non-string children → aria-label is omitted, text content is the accessible name
    expect(button).not.toHaveAttribute('aria-label')
  })
})
