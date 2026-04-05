/**
 * Tests for the ConfirmDialog shared component.
 *
 * Validates:
 *  - Renders title, description, and buttons
 *  - Action callback fires on action button click
 *  - Loading state shows spinner and disables buttons
 *  - Children slot renders extra content
 *  - a11y compliance (axe audit)
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ConfirmDialog } from '../ConfirmDialog'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ConfirmDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Confirm action?',
    description: 'This will do something important.',
    cancelLabel: 'Cancel',
    actionLabel: 'Confirm',
    onAction: vi.fn(),
  }

  it('renders title, description, and buttons', () => {
    render(<ConfirmDialog {...defaultProps} />)

    expect(screen.getByText('Confirm action?')).toBeInTheDocument()
    expect(screen.getByText('This will do something important.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeInTheDocument()
  })

  it('fires onAction when action button is clicked', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()

    render(<ConfirmDialog {...defaultProps} onAction={onAction} />)

    await user.click(screen.getByRole('button', { name: /Confirm/ }))

    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('fires onOpenChange when cancel button is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<ConfirmDialog {...defaultProps} onOpenChange={onOpenChange} />)

    await user.click(screen.getByRole('button', { name: /Cancel/ }))

    expect(onOpenChange).toHaveBeenCalled()
  })

  it('shows spinner and disables buttons when loading', () => {
    render(<ConfirmDialog {...defaultProps} loading />)

    const actionBtn = screen.getByRole('button', { name: /Confirm/ })
    const cancelBtn = screen.getByRole('button', { name: /Cancel/ })

    expect(actionBtn).toBeDisabled()
    expect(cancelBtn).toBeDisabled()

    // Spinner should be visible (Loader2 renders an svg with animate-spin class)
    const spinner = actionBtn.querySelector('.animate-spin')
    expect(spinner).toBeTruthy()
  })

  it('does not show spinner when not loading', () => {
    render(<ConfirmDialog {...defaultProps} />)

    const actionBtn = screen.getByRole('button', { name: /Confirm/ })
    const spinner = actionBtn.querySelector('.animate-spin')
    expect(spinner).toBeNull()
  })

  it('renders children slot content', () => {
    render(
      <ConfirmDialog {...defaultProps}>
        <input data-testid="custom-input" placeholder="Extra content" />
      </ConfirmDialog>,
    )

    expect(screen.getByTestId('custom-input')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Extra content')).toBeInTheDocument()
  })

  it('uses default labels when none provided', () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Test"
        description="Desc"
        onAction={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeInTheDocument()
  })

  it('uses custom labels when provided', () => {
    render(<ConfirmDialog {...defaultProps} cancelLabel="No thanks" actionLabel="Yes, delete" />)

    expect(screen.getByRole('button', { name: /No thanks/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Yes, delete/ })).toBeInTheDocument()
  })

  it('does not render when open is false', () => {
    render(<ConfirmDialog {...defaultProps} open={false} />)

    expect(screen.queryByText('Confirm action?')).not.toBeInTheDocument()
  })

  it('applies className to the dialog content', () => {
    const { container } = render(<ConfirmDialog {...defaultProps} className="custom-test-class" />)

    // The className is applied to AlertDialogContent which has data-slot
    const content = container.ownerDocument.querySelector('.custom-test-class')
    expect(content).toBeTruthy()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<ConfirmDialog {...defaultProps} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with loading state', async () => {
    const { container } = render(<ConfirmDialog {...defaultProps} loading />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with children', async () => {
    const { container } = render(
      <ConfirmDialog {...defaultProps}>
        <label htmlFor="test-input">Name</label>
        <input id="test-input" placeholder="Enter name" />
      </ConfirmDialog>,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
