/**
 * Tests for the ConfirmDialog shared component.
 *
 * Validates:
 *  - Renders title, description, and buttons
 *  - Action callback fires on action button click
 *  - Loading state shows spinner and disables buttons
 *  - Children slot renders extra content
 *  - a11y compliance (axe audit)
 *  - UX-259: destructive variant flips initial focus to Cancel so a reflex
 *    Enter on open dismisses the dialog instead of confirming.
 *  - PEND-23 H3: when `useIsMobile()` is true the dialog renders as a Sheet
 *    (`side="bottom"`) and the same controlled API + a11y guarantees still
 *    hold (see `describe('mobile path …')` block).
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { useIsMobile } from '../../hooks/useIsMobile'
import { ConfirmDialog } from '../ConfirmDialog'

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedUseIsMobile = vi.mocked(useIsMobile)

beforeEach(() => {
  vi.clearAllMocks()
  // Default to the desktop path so existing test bodies keep their semantics.
  mockedUseIsMobile.mockReturnValue(false)
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

  it('applies contentTestId, cancelTestId, and actionTestId when provided', () => {
    const { container } = render(
      <ConfirmDialog
        {...defaultProps}
        contentTestId="my-confirm"
        cancelTestId="my-cancel"
        actionTestId="my-action"
      />,
    )

    // Dialog content root gets the contentTestId
    const content = container.ownerDocument.querySelector('[data-testid="my-confirm"]')
    expect(content).toBeTruthy()

    // Cancel and Action buttons get their respective test ids
    expect(screen.getByTestId('my-cancel')).toBeInTheDocument()
    expect(screen.getByTestId('my-action')).toBeInTheDocument()
  })

  it('does not render data-testid attributes when testid props are omitted', () => {
    const { container } = render(<ConfirmDialog {...defaultProps} />)

    // No data-testid attribute should be set on the dialog content / buttons
    const content = container.ownerDocument.querySelector('[data-slot="alert-dialog-content"]')
    expect(content).toBeTruthy()
    expect(content?.getAttribute('data-testid')).toBeNull()

    const actionBtn = screen.getByRole('button', { name: /Confirm/ })
    const cancelBtn = screen.getByRole('button', { name: /Cancel/ })
    expect(actionBtn.getAttribute('data-testid')).toBeNull()
    expect(cancelBtn.getAttribute('data-testid')).toBeNull()
  })

  it('focuses the action button on open', () => {
    render(<ConfirmDialog {...defaultProps} />)

    const actionBtn = screen.getByRole('button', { name: /Confirm/ })
    expect(actionBtn).toHaveFocus()
  })

  it('Enter key triggers the action when dialog is open', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()

    render(<ConfirmDialog {...defaultProps} onAction={onAction} />)

    // Action button is auto-focused, so pressing Enter should trigger it
    await user.keyboard('{Enter}')

    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('Escape key closes the dialog', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<ConfirmDialog {...defaultProps} onOpenChange={onOpenChange} />)

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Tab cycles between Cancel and Action buttons', async () => {
    const user = userEvent.setup()

    render(<ConfirmDialog {...defaultProps} />)

    const actionBtn = screen.getByRole('button', { name: /Confirm/ })
    const cancelBtn = screen.getByRole('button', { name: /Cancel/ })

    // Action button starts with focus (autoFocus)
    expect(actionBtn).toHaveFocus()

    // Tab should move focus to Cancel button (focus trap cycles)
    await user.tab()
    expect(cancelBtn).toHaveFocus()

    // Tab again should cycle back to Action button
    await user.tab()
    expect(actionBtn).toHaveFocus()
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

  // ─── UX-259: destructive variant safety ─────────────────────────────────────

  describe('destructive variant (UX-259)', () => {
    it('focuses the Cancel button on open (not the Action button)', () => {
      render(<ConfirmDialog {...defaultProps} actionVariant="destructive" />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })

      expect(cancelBtn).toHaveFocus()
      expect(actionBtn).not.toHaveFocus()
    })

    it('reflex Enter on open closes the dialog WITHOUT firing onAction', async () => {
      const user = userEvent.setup()
      const onAction = vi.fn()
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog
          {...defaultProps}
          actionVariant="destructive"
          onAction={onAction}
          onOpenChange={onOpenChange}
        />,
      )

      // Cancel is auto-focused for destructive — Enter activates Cancel, not Action.
      await user.keyboard('{Enter}')

      expect(onAction).not.toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('clicking action button still fires onAction (destructive variant)', async () => {
      const user = userEvent.setup()
      const onAction = vi.fn()

      render(<ConfirmDialog {...defaultProps} actionVariant="destructive" onAction={onAction} />)

      await user.click(screen.getByRole('button', { name: /Confirm/ }))
      expect(onAction).toHaveBeenCalledTimes(1)
    })

    it('non-destructive variant retains action-button focus and immediate Enter confirm', async () => {
      const user = userEvent.setup()
      const onAction = vi.fn()

      // Default variant — no actionVariant set.
      render(<ConfirmDialog {...defaultProps} onAction={onAction} />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      expect(actionBtn).toHaveFocus()

      await user.keyboard('{Enter}')
      expect(onAction).toHaveBeenCalledTimes(1)
    })

    it('has no a11y violations in destructive variant', async () => {
      const { container } = render(<ConfirmDialog {...defaultProps} actionVariant="destructive" />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })

  // ─── PEND-23 H3: mobile path renders as a Sheet ────────────────────────────

  describe('mobile path (Sheet, side="bottom")', () => {
    const defaultProps = {
      open: true,
      onOpenChange: vi.fn(),
      title: 'Confirm action?',
      description: 'This will do something important.',
      cancelLabel: 'Cancel',
      actionLabel: 'Confirm',
      onAction: vi.fn(),
    }

    beforeEach(() => {
      mockedUseIsMobile.mockReturnValue(true)
    })

    it('renders as a Sheet (data-slot="sheet-content") instead of an alert dialog', () => {
      const { container } = render(<ConfirmDialog {...defaultProps} />)

      expect(container.ownerDocument.querySelector('[data-slot="sheet-content"]')).toBeTruthy()
      expect(container.ownerDocument.querySelector('[data-slot="alert-dialog-content"]')).toBeNull()
    })

    it('Sheet content uses side="bottom" (anchored to viewport bottom)', () => {
      const { container } = render(<ConfirmDialog {...defaultProps} />)

      const content = container.ownerDocument.querySelector('[data-slot="sheet-content"]')
      expect(content).toBeTruthy()
      // Sheet's `side="bottom"` adds a `.bottom-0` anchor class.
      expect(content?.className).toMatch(/bottom-0/)
    })

    it('renders title, description, and both buttons', () => {
      render(<ConfirmDialog {...defaultProps} />)

      expect(screen.getByText('Confirm action?')).toBeInTheDocument()
      expect(screen.getByText('This will do something important.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Confirm/ })).toBeInTheDocument()
    })

    it('fires onAction and closes when action button is clicked', async () => {
      const user = userEvent.setup()
      const onAction = vi.fn()
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...defaultProps} onAction={onAction} onOpenChange={onOpenChange} />)

      await user.click(screen.getByRole('button', { name: /Confirm/ }))

      expect(onAction).toHaveBeenCalledTimes(1)
      // Sheet has no auto-close primitive — ConfirmDialog must close it.
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('fires onOpenChange(false) when cancel button is clicked', async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...defaultProps} onOpenChange={onOpenChange} />)

      await user.click(screen.getByRole('button', { name: /Cancel/ }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('disables buttons and shows spinner when loading', () => {
      render(<ConfirmDialog {...defaultProps} loading />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })

      expect(actionBtn).toBeDisabled()
      expect(cancelBtn).toBeDisabled()
      expect(actionBtn.querySelector('.animate-spin')).toBeTruthy()
    })

    it('renders children slot content', () => {
      render(
        <ConfirmDialog {...defaultProps}>
          <input data-testid="custom-input" placeholder="Extra content" />
        </ConfirmDialog>,
      )

      expect(screen.getByTestId('custom-input')).toBeInTheDocument()
    })

    it('focuses the action button on open (non-destructive)', () => {
      render(<ConfirmDialog {...defaultProps} />)

      expect(screen.getByRole('button', { name: /Confirm/ })).toHaveFocus()
    })

    it('Escape key closes the Sheet', async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...defaultProps} onOpenChange={onOpenChange} />)

      await user.keyboard('{Escape}')

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('forwards contentTestId to the Sheet content', () => {
      const { container } = render(<ConfirmDialog {...defaultProps} contentTestId="my-confirm" />)

      const content = container.ownerDocument.querySelector('[data-testid="my-confirm"]')
      expect(content).toBeTruthy()
      expect(content?.getAttribute('data-slot')).toBe('sheet-content')
    })

    it('forwards cancelTestId and actionTestId to the Sheet buttons', () => {
      render(<ConfirmDialog {...defaultProps} cancelTestId="my-cancel" actionTestId="my-action" />)

      expect(screen.getByTestId('my-cancel')).toBeInTheDocument()
      expect(screen.getByTestId('my-action')).toBeInTheDocument()
    })

    it('action buttons meet the touch-target size on coarse pointers (≥ 44 px)', () => {
      render(<ConfirmDialog {...defaultProps} />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })

      // Button default size carries `[@media(pointer:coarse)]:h-11` (44 px) —
      // the class is the contract surfaced to coarse-pointer devices.
      expect(actionBtn.className).toMatch(/\[@media\(pointer:coarse\)\]:h-11/)
      expect(cancelBtn.className).toMatch(/\[@media\(pointer:coarse\)\]:h-11/)
    })

    it('has no a11y violations on the mobile path', async () => {
      const { container } = render(<ConfirmDialog {...defaultProps} />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('destructive variant focuses Cancel and reflex Enter dismisses without firing onAction', async () => {
      const user = userEvent.setup()
      const onAction = vi.fn()
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog
          {...defaultProps}
          actionVariant="destructive"
          onAction={onAction}
          onOpenChange={onOpenChange}
        />,
      )

      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })
      expect(cancelBtn).toHaveFocus()

      await user.keyboard('{Enter}')

      expect(onAction).not.toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('destructive action click still fires onAction and closes', async () => {
      const user = userEvent.setup()
      const onAction = vi.fn()
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog
          {...defaultProps}
          actionVariant="destructive"
          onAction={onAction}
          onOpenChange={onOpenChange}
        />,
      )

      await user.click(screen.getByRole('button', { name: /Confirm/ }))

      expect(onAction).toHaveBeenCalledTimes(1)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('has no a11y violations in destructive variant on mobile', async () => {
      const { container } = render(<ConfirmDialog {...defaultProps} actionVariant="destructive" />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })
})
