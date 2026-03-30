/**
 * Tests for EmptyState component.
 *
 * Validates:
 *  - Renders with just a message
 *  - Renders with icon + message + description
 *  - Renders with action button
 *  - Compact variant applies smaller padding
 *  - a11y compliance
 */

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { EmptyState } from '../components/EmptyState'

function TestIcon({ className }: { className?: string }) {
  return <svg className={className} data-testid="test-icon" aria-hidden="true" />
}

describe('EmptyState', () => {
  it('renders with just a message', () => {
    render(<EmptyState message="Nothing here yet" />)

    expect(screen.getByText('Nothing here yet')).toBeInTheDocument()
  })

  it('renders with icon, message, and description', () => {
    render(
      <EmptyState
        icon={TestIcon}
        message="No items found"
        description="Try adjusting your search"
      />,
    )

    expect(screen.getByText('No items found')).toBeInTheDocument()
    expect(screen.getByText('Try adjusting your search')).toBeInTheDocument()
    expect(screen.getByTestId('test-icon')).toBeInTheDocument()
  })

  it('renders with an action button', () => {
    render(<EmptyState message="Empty list" action={<button type="button">Add item</button>} />)

    expect(screen.getByText('Empty list')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument()
  })

  it('applies compact styling with smaller padding', () => {
    const { container } = render(<EmptyState message="Compact state" compact />)
    const wrapper = container.firstElementChild as HTMLElement

    expect(wrapper.className).toContain('p-6')
    expect(wrapper.className).not.toContain('p-8')
  })

  it('applies default padding when not compact', () => {
    const { container } = render(<EmptyState message="Default state" />)
    const wrapper = container.firstElementChild as HTMLElement

    expect(wrapper.className).toContain('p-8')
    expect(wrapper.className).not.toContain('p-6')
  })

  it('does not render icon when not provided', () => {
    render(<EmptyState message="No icon" />)

    expect(screen.queryByTestId('test-icon')).not.toBeInTheDocument()
  })

  it('does not render description when not provided', () => {
    render(<EmptyState message="No description" />)

    // Only the message paragraph should be present
    expect(screen.getByText('No description')).toBeInTheDocument()
    expect(screen.queryByText('Try adjusting')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <EmptyState
        icon={TestIcon}
        message="No items found"
        description="Adjust your search criteria"
        action={<button type="button">Reset filters</button>}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations in compact mode', async () => {
    const { container } = render(<EmptyState message="Select an item to see details" compact />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
