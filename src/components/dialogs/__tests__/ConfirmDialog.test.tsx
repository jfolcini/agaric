/**
 * Tests for the ConfirmDialog shared component.
 *
 * Validates:
 *  - Renders title, description, and buttons
 *  - Action callback fires on action button click
 *  - Loading state shows spinner and disables buttons
 *  - Children slot renders extra content
 *  - a11y compliance (axe audit)
 * Destructive variant flips initial focus to Cancel so a reflex
 *    Enter on open dismisses the dialog instead of confirming.
 * When `useIsMobile()` is true the dialog renders as a Sheet
 *    (`side="bottom"`) and the same controlled API + a11y guarantees still
 *    hold (see `describe('mobile path …')` block).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { useIsMobile } from '@/hooks/useIsMobile'

vi.mock('@/hooks/useIsMobile', () => ({
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
    onConfirm: vi.fn(),
  }

  it('renders title, description, and buttons', () => {
    render(<ConfirmDialog {...defaultProps} />)

    expect(screen.getByText('Confirm action?')).toBeInTheDocument()
    expect(screen.getByText('This will do something important.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeInTheDocument()
  })

  it('fires onConfirm when action button is clicked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: /Confirm/ }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
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
        <input aria-label="Extra content" data-testid="custom-input" placeholder="Extra content" />
      </ConfirmDialog>,
    )

    expect(screen.getByTestId('custom-input')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Extra content')).toBeInTheDocument()
  })

  it('uses default labels when none provided', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Test"
        description="Desc"
        onConfirm={vi.fn()}
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
    const onConfirm = vi.fn()

    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

    // Action button is auto-focused, so pressing Enter should trigger it
    await user.keyboard('{Enter}')

    expect(onConfirm).toHaveBeenCalledTimes(1)
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
        <input aria-label="Name" id="test-input" placeholder="Enter name" />
      </ConfirmDialog>,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ─── destructive variant safety ─────────────────────────────────────

  describe('destructive variant', () => {
    it('focuses the Cancel button on open (not the Action button)', () => {
      render(<ConfirmDialog {...defaultProps} variant="destructive" />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })

      expect(cancelBtn).toHaveFocus()
      expect(actionBtn).not.toHaveFocus()
    })

    it('reflex Enter on open closes the dialog WITHOUT firing onConfirm', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog
          {...defaultProps}
          variant="destructive"
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      )

      // Cancel is auto-focused for destructive — Enter activates Cancel, not Action.
      await user.keyboard('{Enter}')

      expect(onConfirm).not.toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('clicking action button still fires onConfirm (destructive variant)', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()

      render(<ConfirmDialog {...defaultProps} variant="destructive" onConfirm={onConfirm} />)

      await user.click(screen.getByRole('button', { name: /Confirm/ }))
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('non-destructive variant retains action-button focus and immediate Enter confirm', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()

      // Default variant — no actionVariant set.
      render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      expect(actionBtn).toHaveFocus()

      await user.keyboard('{Enter}')
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('has no a11y violations in destructive variant', async () => {
      const { container } = render(<ConfirmDialog {...defaultProps} variant="destructive" />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })

  // ─── mobile path renders as a Sheet ────────────────────────────

  describe('mobile path (Sheet, side="bottom")', () => {
    const mobileProps = {
      open: true,
      onOpenChange: vi.fn(),
      title: 'Confirm action?',
      description: 'This will do something important.',
      cancelLabel: 'Cancel',
      actionLabel: 'Confirm',
      onConfirm: vi.fn(),
    }

    beforeEach(() => {
      mockedUseIsMobile.mockReturnValue(true)
    })

    it('renders as a Sheet (data-slot="sheet-content") instead of an alert dialog', () => {
      const { container } = render(<ConfirmDialog {...mobileProps} />)

      expect(container.ownerDocument.querySelector('[data-slot="sheet-content"]')).toBeTruthy()
      expect(container.ownerDocument.querySelector('[data-slot="alert-dialog-content"]')).toBeNull()
    })

    it('Sheet content uses side="bottom" (anchored to viewport bottom)', () => {
      const { container } = render(<ConfirmDialog {...mobileProps} />)

      const content = container.ownerDocument.querySelector('[data-slot="sheet-content"]')
      expect(content).toBeTruthy()
      // Sheet's `side="bottom"` adds a `.bottom-0` anchor class.
      expect(content?.className).toMatch(/bottom-0/)
    })

    it('renders title, description, and both buttons', () => {
      render(<ConfirmDialog {...mobileProps} />)

      expect(screen.getByText('Confirm action?')).toBeInTheDocument()
      expect(screen.getByText('This will do something important.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Confirm/ })).toBeInTheDocument()
    })

    it('fires onConfirm and closes when action button is clicked', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...mobileProps} onConfirm={onConfirm} onOpenChange={onOpenChange} />)

      await user.click(screen.getByRole('button', { name: /Confirm/ }))

      expect(onConfirm).toHaveBeenCalledTimes(1)
      // Sheet has no auto-close primitive — ConfirmDialog must close it.
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('fires onOpenChange(false) when cancel button is clicked', async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...mobileProps} onOpenChange={onOpenChange} />)

      await user.click(screen.getByRole('button', { name: /Cancel/ }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('disables buttons and shows spinner when loading', () => {
      render(<ConfirmDialog {...mobileProps} loading />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })

      expect(actionBtn).toBeDisabled()
      expect(cancelBtn).toBeDisabled()
      expect(actionBtn.querySelector('.animate-spin')).toBeTruthy()
    })

    it('renders children slot content', () => {
      render(
        <ConfirmDialog {...mobileProps}>
          <input
            aria-label="Extra content"
            data-testid="custom-input"
            placeholder="Extra content"
          />
        </ConfirmDialog>,
      )

      expect(screen.getByTestId('custom-input')).toBeInTheDocument()
    })

    it('focuses the action button on open (non-destructive)', () => {
      render(<ConfirmDialog {...mobileProps} />)

      expect(screen.getByRole('button', { name: /Confirm/ })).toHaveFocus()
    })

    it('Escape key closes the Sheet', async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...mobileProps} onOpenChange={onOpenChange} />)

      await user.keyboard('{Escape}')

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('forwards contentTestId to the Sheet content', () => {
      const { container } = render(<ConfirmDialog {...mobileProps} contentTestId="my-confirm" />)

      const content = container.ownerDocument.querySelector('[data-testid="my-confirm"]')
      expect(content).toBeTruthy()
      expect(content?.getAttribute('data-slot')).toBe('sheet-content')
    })

    it('forwards cancelTestId and actionTestId to the Sheet buttons', () => {
      render(<ConfirmDialog {...mobileProps} cancelTestId="my-cancel" actionTestId="my-action" />)

      expect(screen.getByTestId('my-cancel')).toBeInTheDocument()
      expect(screen.getByTestId('my-action')).toBeInTheDocument()
    })

    it('action buttons meet the touch-target size on coarse pointers (≥ 44 px)', () => {
      render(<ConfirmDialog {...mobileProps} />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })

      // Button default size carries `[@media(pointer:coarse)]:h-11` (44 px) —
      // the class is the contract surfaced to coarse-pointer devices.
      expect(actionBtn.className).toMatch(/\[@media\(pointer:coarse\)\]:h-11/)
      expect(cancelBtn.className).toMatch(/\[@media\(pointer:coarse\)\]:h-11/)
    })

    it('has no a11y violations on the mobile path', async () => {
      const { container } = render(<ConfirmDialog {...mobileProps} />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('destructive variant focuses Cancel and reflex Enter dismisses without firing onConfirm', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog
          {...mobileProps}
          variant="destructive"
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      )

      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })
      expect(cancelBtn).toHaveFocus()

      await user.keyboard('{Enter}')

      expect(onConfirm).not.toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('destructive action click still fires onConfirm and closes', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog
          {...mobileProps}
          variant="destructive"
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      )

      await user.click(screen.getByRole('button', { name: /Confirm/ }))

      expect(onConfirm).toHaveBeenCalledTimes(1)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('has no a11y violations in destructive variant on mobile', async () => {
      const { container } = render(<ConfirmDialog {...mobileProps} variant="destructive" />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })

  // ─── i18n-key API + async onConfirm (merged from former ConfirmDestructiveAction) ─
  //
  // The merged ConfirmDialog absorbs the prior `ConfirmDestructiveAction`
  // surface area: i18n keys instead of pre-resolved strings, async-aware
  // confirm handler, and "stay open on rejection" semantics.

  describe('i18n-key API + async onConfirm', () => {
    // Use existing i18n keys from the catalog so we don't fuss with a fixture.
    const TITLE = 'Cancel pairing?'
    const DESCRIPTION =
      'Pairing is in progress. Closing this dialog will cancel the handshake and the other device will need to start over.'
    const CONFIRM = 'Cancel pairing'
    const CANCEL_KEEP = 'Keep pairing'

    const baseProps = {
      open: true as const,
      titleKey: 'pairing.confirmCloseTitle',
      descriptionKey: 'pairing.confirmCloseDescription',
      confirmKey: 'pairing.confirmCloseAction',
      cancelKey: 'pairing.confirmCloseKeep',
      variant: 'destructive' as const,
    }

    it('renders title, description, confirm, and cancel via i18n keys', () => {
      render(<ConfirmDialog {...baseProps} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)

      expect(screen.getByText(TITLE)).toBeInTheDocument()
      expect(screen.getByText(DESCRIPTION)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: CONFIRM })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: CANCEL_KEEP })).toBeInTheDocument()
    })

    it('falls back to dialog.cancel when cancelKey is not provided', () => {
      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          titleKey="pairing.confirmCloseTitle"
          descriptionKey="pairing.confirmCloseDescription"
          confirmKey="pairing.confirmCloseAction"
        />,
      )

      // dialog.cancel resolves to "Cancel" (see src/lib/i18n/common.ts).
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    })

    it('async onConfirm: awaits and closes via onOpenChange(false) on resolve', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn().mockResolvedValue(undefined)
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...baseProps} onOpenChange={onOpenChange} onConfirm={onConfirm} />)

      await user.click(screen.getByRole('button', { name: CONFIRM }))

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledTimes(1)
      })
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
      expect(onOpenChange.mock.invocationCallOrder[0]).toBeGreaterThan(
        onConfirm.mock.invocationCallOrder[0] ?? Infinity,
      )
    })

    it('synchronous onConfirm also closes the dialog', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn() // returns undefined (sync)
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...baseProps} onOpenChange={onOpenChange} onConfirm={onConfirm} />)

      await user.click(screen.getByRole('button', { name: CONFIRM }))

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledTimes(1)
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })

    it('onConfirm rejection: dialog stays open and rejection does not escape', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn().mockRejectedValue(new Error('backend exploded'))
      const onOpenChange = vi.fn()
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)

      render(<ConfirmDialog {...baseProps} onOpenChange={onOpenChange} onConfirm={onConfirm} />)

      await user.click(screen.getByRole('button', { name: CONFIRM }))

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledTimes(1)
      })

      // onOpenChange(false) was NOT called — the dialog stays open.
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(screen.getByText(TITLE)).toBeInTheDocument()
      expect(unhandled).not.toHaveBeenCalled()

      process.off('unhandledRejection', unhandled)
    })

    it('interpolates values into title and description', () => {
      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          titleKey="device.unpairConfirmTitle"
          descriptionKey="device.unpairConfirmDescription"
          confirmKey="device.unpairConfirmAction"
          values={{ deviceName: 'Work Laptop' }}
        />,
      )

      expect(screen.getByText('Unpair device?')).toBeInTheDocument()
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    })

    it('disables both buttons while async onConfirm is pending', async () => {
      const user = userEvent.setup()
      let resolveConfirm: () => void = () => {}
      const onConfirm = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveConfirm = resolve
          }),
      )

      render(<ConfirmDialog {...baseProps} onOpenChange={vi.fn()} onConfirm={onConfirm} />)

      const cancelBtn = screen.getByRole('button', { name: CANCEL_KEEP })
      const confirmBtn = screen.getByRole('button', { name: CONFIRM })

      await user.click(confirmBtn)

      await waitFor(() => {
        expect(confirmBtn).toBeDisabled()
        expect(cancelBtn).toBeDisabled()
      })

      resolveConfirm()
    })

    it('renders a Spinner inside the confirm button while async onConfirm is pending', async () => {
      const user = userEvent.setup()
      let resolveConfirm: () => void = () => {}
      const onConfirm = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveConfirm = resolve
          }),
      )

      render(
        <ConfirmDialog
          {...baseProps}
          onOpenChange={vi.fn()}
          onConfirm={onConfirm}
          actionTestId="confirm-action"
        />,
      )

      const confirmBtn = screen.getByTestId('confirm-action')

      expect(confirmBtn.querySelector('[data-slot="spinner"]')).toBeNull()

      await user.click(confirmBtn)

      await waitFor(() => {
        expect(confirmBtn.querySelector('[data-slot="spinner"]')).not.toBeNull()
      })

      resolveConfirm()

      await waitFor(() => {
        expect(confirmBtn.querySelector('[data-slot="spinner"]')).toBeNull()
      })
    })

    it('explicit `title` overrides `titleKey` when both are set', () => {
      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          titleKey="pairing.confirmCloseTitle"
          title="Custom override"
          descriptionKey="pairing.confirmCloseDescription"
          confirmKey="pairing.confirmCloseAction"
          onConfirm={vi.fn()}
        />,
      )

      expect(screen.getByText('Custom override')).toBeInTheDocument()
      expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
    })

    it('reflex Enter on open dismisses without firing onConfirm', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...baseProps} onOpenChange={onOpenChange} onConfirm={onConfirm} />)

      await user.keyboard('{Enter}')

      expect(onConfirm).not.toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('has no a11y violations on the i18n-key path', async () => {
      const { container } = render(
        <ConfirmDialog {...baseProps} onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
      )

      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
  })

  // ─── secondaryAction escape hatch (multi-action dialogs) ─────────────────────

  describe('secondaryAction', () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      title: 'Disconnect calendar?',
      description: 'Choose how to disconnect.',
      actionLabel: 'Delete calendar',
      cancelLabel: 'Cancel',
    }

    it('renders the secondary button between Cancel and Confirm', () => {
      render(
        <ConfirmDialog
          {...props}
          variant="destructive"
          onConfirm={vi.fn()}
          secondaryAction={{
            label: 'Keep calendar',
            variant: 'outline',
            onConfirm: vi.fn(),
            testId: 'secondary',
          }}
        />,
      )

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Keep calendar' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Delete calendar' })).toBeInTheDocument()
      expect(screen.getByTestId('secondary')).toBeInTheDocument()
    })

    it('clicking secondary fires its onConfirm and closes the dialog', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()
      const onSecondary = vi.fn()
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog
          {...props}
          onOpenChange={onOpenChange}
          variant="destructive"
          onConfirm={onConfirm}
          secondaryAction={{
            label: 'Keep calendar',
            variant: 'outline',
            onConfirm: onSecondary,
          }}
        />,
      )

      await user.click(screen.getByRole('button', { name: 'Keep calendar' }))

      expect(onSecondary).toHaveBeenCalledTimes(1)
      expect(onConfirm).not.toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('secondary async handler awaits + closes on resolve', async () => {
      const user = userEvent.setup()
      const onSecondary = vi.fn().mockResolvedValue(undefined)
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog
          {...props}
          onOpenChange={onOpenChange}
          variant="destructive"
          onConfirm={vi.fn()}
          secondaryAction={{
            label: 'Keep calendar',
            variant: 'outline',
            onConfirm: onSecondary,
          }}
        />,
      )

      await user.click(screen.getByRole('button', { name: 'Keep calendar' }))

      await waitFor(() => {
        expect(onSecondary).toHaveBeenCalledTimes(1)
      })
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false)
      })
    })

    it('labelKey resolves via i18n', () => {
      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          titleKey="pairing.confirmCloseTitle"
          descriptionKey="pairing.confirmCloseDescription"
          confirmKey="pairing.confirmCloseAction"
          cancelKey="dialog.cancel"
          variant="destructive"
          onConfirm={vi.fn()}
          secondaryAction={{
            labelKey: 'pairing.confirmCloseKeep',
            variant: 'outline',
            onConfirm: vi.fn(),
          }}
        />,
      )

      // pairing.confirmCloseKeep resolves to "Keep pairing"
      expect(screen.getByRole('button', { name: 'Keep pairing' })).toBeInTheDocument()
    })
  })

  // ─── #1612: empty accessible name fallback ───────────────────────────────────
  //
  // Both `title` and `titleKey` are optional. A caller omitting both must still
  // get a dialog with a non-empty accessible name (axe aria-dialog-name).

  describe('accessible name fallback (#1612)', () => {
    it('renders a non-empty accessible name when neither title nor titleKey is given', () => {
      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          description="Something will happen."
        />,
      )

      const dialog = screen.getByRole('alertdialog')
      // The dialog's accessible name comes from its (required) Title node; the
      // fallback resolves dialog.confirm → "Confirm".
      expect(dialog).toHaveAccessibleName('Confirm')
      expect(dialog).toHaveAccessibleName(/\S/)
    })

    it('passes axe with no title/titleKey (no aria-dialog-name violation)', async () => {
      const { container } = render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          description="Something will happen."
        />,
      )

      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })

    it('still honors an explicit title over the fallback', () => {
      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          title="Real title"
          description="Desc"
        />,
      )

      expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Real title')
    })

    it('falls back when an explicit title is whitespace-only (trimmed empty)', () => {
      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          title="   "
          description="Desc"
        />,
      )

      // A whitespace-only title is not a usable accessible name; the trim()
      // check must treat it as empty and fall back to dialog.confirm.
      expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Confirm')
    })

    it('warns in dev when no usable title is provided (gated on import.meta.env.DEV)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          description="Something will happen."
        />,
      )

      // Vitest runs with import.meta.env.DEV === true, so the dev-only guard
      // fires exactly one warning pointing at the empty accessible name.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/aria-dialog-name/)

      warn.mockRestore()
    })

    it('does not warn when a usable title is provided', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      render(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          title="Real title"
          description="Desc"
        />,
      )

      expect(warn).not.toHaveBeenCalled()

      warn.mockRestore()
    })
  })

  // ─── #1611: desktop Cancel respects the isPending guard ──────────────────────
  //
  // The desktop AlertDialogCancel previously bound the raw `onCancel` and relied
  // solely on `disabled={isPending}`. It now binds `handleCancel`, which
  // early-returns while pending — so even a click that bypasses `disabled`
  // (fireEvent on a disabled button) must NOT invoke onCancel or close.

  describe('Cancel honors isPending guard (#1611)', () => {
    it('desktop Cancel does not invoke onCancel while pending (loading)', () => {
      const onCancel = vi.fn()
      const onOpenChange = vi.fn()

      render(
        <ConfirmDialog {...defaultProps} loading onCancel={onCancel} onOpenChange={onOpenChange} />,
      )

      const cancelBtn = screen.getByRole('button', { name: /Cancel/ })
      expect(cancelBtn).toBeDisabled()

      // fireEvent dispatches a raw click that bypasses the `disabled` gate, so
      // this asserts the handler-level guard (handleCancel early-returns), not
      // just the disabled attribute.
      fireEvent.click(cancelBtn)

      expect(onCancel).not.toHaveBeenCalled()
      expect(onOpenChange).not.toHaveBeenCalled()
    })

    it('desktop Cancel invokes onCancel and closes when not pending', async () => {
      const user = userEvent.setup()
      const onCancel = vi.fn()
      const onOpenChange = vi.fn()

      render(<ConfirmDialog {...defaultProps} onCancel={onCancel} onOpenChange={onOpenChange} />)

      await user.click(screen.getByRole('button', { name: /Cancel/ }))

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  // ─── #1784: Confirm respects the isPending guard ─────────────────────────────
  //
  // runConfirm previously early-returned on the raw internal `pending` only, so
  // an external `loading` prop did not gate it. Buttons + handleCancel use
  // `isPending = pending || loading`; runConfirm now does too. So even a confirm
  // invocation that bypasses the `disabled` attribute (jsdom blocks clicks on a
  // disabled button, so we invoke the button's real React `onClick` prop — the
  // handler-level path) must NOT fire onConfirm or close while loading. This is
  // the Confirm-side cousin of #1611.

  // Reads the live React `onClick` prop off the rendered DOM node so we can
  // drive `handleConfirmClick` directly — a faithful stand-in for "any path
  // bypassing the disabled attribute". A plain fireEvent.click is a no-op on a
  // disabled button in jsdom and would pass even without the guard.
  function getReactOnClick(
    node: HTMLElement,
  ): ((e: { preventDefault(): void }) => unknown) | undefined {
    const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
    return key
      ? (
          node as unknown as Record<
            string,
            { onClick?: (e: { preventDefault(): void }) => unknown }
          >
        )[key]?.onClick
      : undefined
  }

  describe('Confirm honors isPending guard (#1784)', () => {
    it('does not invoke onConfirm while pending (external loading prop)', async () => {
      const onConfirm = vi.fn()

      render(<ConfirmDialog {...defaultProps} loading onConfirm={onConfirm} />)

      const actionBtn = screen.getByRole('button', { name: /Confirm/ })
      expect(actionBtn).toBeDisabled()

      // Bypass the `disabled` attribute by invoking the handler directly. With
      // the raw-`pending` guard this fires onConfirm and closes; with the
      // isPending guard it early-returns.
      const onClick = getReactOnClick(actionBtn)
      expect(onClick).toBeDefined()
      await onClick?.({ preventDefault() {} })

      // onConfirm is the discriminating signal: with the raw-`pending` guard it
      // fires here; with the isPending guard runConfirm early-returns. (We do
      // not assert on onOpenChange — Radix AlertDialogAction emits its own close
      // independent of runConfirm, so it is not a guard signal.)
      expect(onConfirm).not.toHaveBeenCalled()
    })

    it('invokes onConfirm exactly once when not pending/loading', async () => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()

      render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

      await user.click(screen.getByRole('button', { name: /Confirm/ }))

      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('has no a11y violations while loading (guard regression coverage)', async () => {
      const { container } = render(<ConfirmDialog {...defaultProps} loading onConfirm={vi.fn()} />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })
})
