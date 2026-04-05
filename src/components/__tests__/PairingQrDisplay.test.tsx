/**
 * Tests for PairingQrDisplay component.
 *
 * Validates:
 *  - Renders QR code SVG via dangerouslySetInnerHTML
 *  - Displays passphrase text
 *  - Shows countdown timer when provided
 *  - Hides countdown when null
 *  - Shows session expired state with retry button
 *  - Does not show expired section when error is present
 *  - SR-only countdown announces at key intervals
 *  - Accessibility audit
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PairingQrDisplay } from '../PairingQrDisplay'

beforeEach(() => {
  vi.clearAllMocks()
})

const defaultProps = {
  qrSvg: '<svg data-testid="backend-qr"><rect width="100" height="100"/></svg>',
  passphrase: 'alpha bravo charlie delta',
  countdownDisplay: '4:30',
  countdown: 270,
  isExpired: false,
  error: null,
  onRetry: vi.fn(),
  retryBtnRef: { current: null } as React.RefObject<HTMLButtonElement | null>,
}

describe('PairingQrDisplay', () => {
  it('renders QR code SVG via dangerouslySetInnerHTML', () => {
    render(<PairingQrDisplay {...defaultProps} />)

    const qr = screen.getByTestId('pairing-qr-code')
    expect(qr).toBeInTheDocument()
    expect(qr.innerHTML).toContain('<svg')
    expect(qr.innerHTML).toContain('backend-qr')
  })

  it('displays passphrase text', () => {
    render(<PairingQrDisplay {...defaultProps} />)

    expect(screen.getByText('alpha bravo charlie delta')).toBeInTheDocument()
  })

  it('shows passphrase label', () => {
    render(<PairingQrDisplay {...defaultProps} />)

    expect(screen.getByText('Passphrase:')).toBeInTheDocument()
  })

  it('shows countdown timer when provided', () => {
    render(<PairingQrDisplay {...defaultProps} />)

    expect(screen.getByText(/Session expires in 4:30/)).toBeInTheDocument()
  })

  it('hides countdown when countdownDisplay is null', () => {
    render(<PairingQrDisplay {...defaultProps} countdownDisplay={null} countdown={null} />)

    expect(screen.queryByText(/Session expires in/)).not.toBeInTheDocument()
  })

  it('shows session expired state with retry button', () => {
    const onRetry = vi.fn()
    render(
      <PairingQrDisplay
        {...defaultProps}
        countdownDisplay={null}
        countdown={0}
        isExpired={true}
        onRetry={onRetry}
      />,
    )

    expect(screen.getByText('Session expired')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
  })

  it('calls onRetry when retry button is clicked', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <PairingQrDisplay
        {...defaultProps}
        countdownDisplay={null}
        countdown={0}
        isExpired={true}
        onRetry={onRetry}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('does not show expired section when error is present', () => {
    render(
      <PairingQrDisplay
        {...defaultProps}
        countdownDisplay={null}
        countdown={0}
        isExpired={true}
        error="Some error"
      />,
    )

    expect(screen.queryByText('Session expired')).not.toBeInTheDocument()
  })

  it('QR code container has aria role and label', () => {
    render(<PairingQrDisplay {...defaultProps} />)

    const qr = screen.getByRole('img')
    expect(qr).toBeInTheDocument()
    expect(qr).toHaveAttribute('aria-label', 'QR code for device pairing')
  })

  it('SR-only countdown announces at 60-second intervals', () => {
    const { container } = render(
      <PairingQrDisplay {...defaultProps} countdown={60} countdownDisplay="1:00" />,
    )

    const srOnly = container.querySelector('.sr-only[aria-live="polite"]')
    expect(srOnly).toBeTruthy()
    expect(srOnly?.textContent).toContain('Session expires in 1 minute')
  })

  it('SR-only countdown announces at 30 seconds', () => {
    const { container } = render(
      <PairingQrDisplay {...defaultProps} countdown={30} countdownDisplay="0:30" />,
    )

    const srOnly = container.querySelector('.sr-only[aria-live="polite"]')
    expect(srOnly).toBeTruthy()
    expect(srOnly?.textContent).toContain('Session expires in 30 seconds')
  })

  it('SR-only countdown is empty at non-key intervals', () => {
    const { container } = render(
      <PairingQrDisplay {...defaultProps} countdown={45} countdownDisplay="0:45" />,
    )

    const srOnly = container.querySelector('.sr-only[aria-live="polite"]')
    expect(srOnly).toBeTruthy()
    expect(srOnly?.textContent).toBe('')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PairingQrDisplay {...defaultProps} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when expired', async () => {
    const { container } = render(
      <PairingQrDisplay {...defaultProps} countdownDisplay={null} countdown={0} isExpired={true} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
