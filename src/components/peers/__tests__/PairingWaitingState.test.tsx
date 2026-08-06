/**
 * Tests for PairingWaitingState component.
 *
 * Validates:
 *  - Renders the waiting message and cancel button
 *  - Calls onCancel when the cancel button is clicked
 *  - Shows/hides the visible (aria-hidden) countdown line
 *  - SR-only countdown announces at key intervals, mirroring the host
 *    path's #424 pattern (PairingQrDisplay) — added for #3496, which found
 *    the joiner waiting state had no sr-only countdown at all: a
 *    screen-reader user got a single "waiting for the other device"
 *    announcement, then silence for up to the full 300s TTL.
 *  - Accessibility audit
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PairingWaitingState } from '@/components/peers/PairingWaitingState'
import { t } from '@/lib/i18n'

const defaultProps = {
  waitCountdownDisplay: '4:30',
  waitCountdown: 270,
  onCancel: vi.fn(),
}

describe('PairingWaitingState', () => {
  it('renders the waiting message and cancel button', () => {
    render(<PairingWaitingState {...defaultProps} />)

    expect(screen.getByTestId('pairing-waiting-state')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the other device…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
  })

  it('calls onCancel when the cancel button is clicked', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<PairingWaitingState {...defaultProps} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows the visible countdown line when provided', () => {
    render(<PairingWaitingState {...defaultProps} />)
    expect(screen.getByText(/Session expires in/)).toBeInTheDocument()
  })

  it('hides the visible countdown line when null', () => {
    render(<PairingWaitingState {...defaultProps} waitCountdownDisplay={null} />)
    expect(screen.queryByText(/Session expires in/)).not.toBeInTheDocument()
  })

  // ── #3496: sr-only countdown, mirroring PairingQrDisplay's #424 pattern ──
  it('SR-only countdown announces 60-second intervals', () => {
    const { container } = render(
      <PairingWaitingState {...defaultProps} waitCountdown={60} waitCountdownDisplay="1:00" />,
    )

    const srOnly = container.querySelector('.sr-only[aria-live="polite"]')
    expect(srOnly).toBeTruthy()
    expect(srOnly?.textContent).toBe(t('pairing.srCountdownMinutes', { count: 1 }))
    expect(srOnly?.textContent).toBe('Session expires in 1 minute')
  })

  it('SR-only countdown announces at 30 seconds', () => {
    const { container } = render(
      <PairingWaitingState {...defaultProps} waitCountdown={30} waitCountdownDisplay="0:30" />,
    )

    const srOnly = container.querySelector('.sr-only[aria-live="polite"]')
    expect(srOnly).toBeTruthy()
    expect(srOnly?.textContent).toBe(t('pairing.srCountdownSeconds', { count: 30 }))
    expect(srOnly?.textContent).toBe('Session expires in 30 seconds')
  })

  it('SR-only countdown is empty at non-key intervals', () => {
    const { container } = render(
      <PairingWaitingState {...defaultProps} waitCountdown={45} waitCountdownDisplay="0:45" />,
    )

    const srOnly = container.querySelector('.sr-only[aria-live="polite"]')
    expect(srOnly).toBeTruthy()
    expect(srOnly?.textContent).toBe('')
  })

  it('SR-only countdown is empty once waitCountdown is null (expired/unbounded)', () => {
    const { container } = render(
      <PairingWaitingState {...defaultProps} waitCountdown={null} waitCountdownDisplay={null} />,
    )

    const srOnly = container.querySelector('.sr-only[aria-live="polite"]')
    expect(srOnly?.textContent).toBe('')
  })

  // #3496 explicitly calls out that this must be "polite", never
  // "assertive" — assertive would interrupt the screen reader every tick
  // instead of queueing behind other speech.
  it('SR-only countdown uses aria-live="polite", never "assertive"', () => {
    const { container } = render(
      <PairingWaitingState {...defaultProps} waitCountdown={60} waitCountdownDisplay="1:00" />,
    )

    expect(container.querySelector('.sr-only[aria-live="assertive"]')).toBeNull()
    expect(container.querySelector('.sr-only[aria-live="polite"]')).toBeTruthy()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PairingWaitingState {...defaultProps} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
