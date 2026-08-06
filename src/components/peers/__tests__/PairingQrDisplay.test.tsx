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

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { PairingQrDisplay } from '@/components/peers/PairingQrDisplay'
import { writeText } from '@/lib/clipboard'
import { t } from '@/lib/i18n'

vi.mock('@/lib/clipboard', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))
const mockedWriteText = vi.mocked(writeText)

beforeEach(() => {
  vi.clearAllMocks()
  mockedWriteText.mockResolvedValue(undefined)
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
        isExpired
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
        isExpired
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
        isExpired
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

  // #758 item 6: the SR-only countdown is routed through t() with i18next
  // plural keys instead of hardcoded English + manual pluralization.
  it('SR-only countdown text comes from the i18n catalog with plural handling (#758 item 6)', () => {
    const { container, rerender } = render(
      <PairingQrDisplay {...defaultProps} countdown={120} countdownDisplay="2:00" />,
    )

    const srOnly = container.querySelector('.sr-only[aria-live="polite"]')
    expect(srOnly?.textContent).toBe(t('pairing.srCountdownMinutes', { count: 2 }))
    expect(srOnly?.textContent).toBe('Session expires in 2 minutes')

    // Singular form via the i18n plural rules, not manual' suffixing.
    rerender(<PairingQrDisplay {...defaultProps} countdown={60} countdownDisplay="1:00" />)
    expect(srOnly?.textContent).toBe(t('pairing.srCountdownMinutes', { count: 1 }))
    expect(srOnly?.textContent).toBe('Session expires in 1 minute')

    // Seconds branch at the 30s key interval.
    rerender(<PairingQrDisplay {...defaultProps} countdown={30} countdownDisplay="0:30" />)
    expect(srOnly?.textContent).toBe(t('pairing.srCountdownSeconds', { count: 30 }))
    expect(srOnly?.textContent).toBe('Session expires in 30 seconds')
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

  // ── passphrase copy button + visible pause indicator ─────────
  describe('passphrase copy button', () => {
    it('renders a copy button with the localized aria-label', () => {
      render(<PairingQrDisplay {...defaultProps} />)

      expect(screen.getByRole('button', { name: /Copy passphrase/i })).toBeInTheDocument()
    })

    it('writes the passphrase to the clipboard on click', async () => {
      const user = userEvent.setup()
      render(<PairingQrDisplay {...defaultProps} passphrase="word1 word2 word3 word4" />)

      await user.click(screen.getByRole('button', { name: /Copy passphrase/i }))

      await waitFor(() => {
        expect(mockedWriteText).toHaveBeenCalledWith('word1 word2 word3 word4')
      })
      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Passphrase copied')
      })
    })

    it('shows an error toast when the clipboard write fails', async () => {
      const user = userEvent.setup()
      mockedWriteText.mockRejectedValueOnce(new Error('clipboard denied'))

      render(<PairingQrDisplay {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /Copy passphrase/i }))

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to copy passphrase')
      })
    })

    it('passes axe with the copy button mounted', async () => {
      const { container } = render(<PairingQrDisplay {...defaultProps} />)
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when expired', async () => {
    const { container } = render(
      <PairingQrDisplay {...defaultProps} countdownDisplay={null} countdown={0} isExpired />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('keeps the visual countdown paragraph aria-hidden', () => {
    // #3463 (review): the countdown-pause-while-typing feature (#294) was
    // removed as dead code — it was only reachable when the countdown
    // (host-only) and the passphrase inputs (joiner-only) could render on
    // the same screen, which the implicit-role split makes impossible. The
    // countdown paragraph itself stays aria-hidden; SR users get the
    // interval-crossing announcements from PairingDialog's separate,
    // still-live announcer effect (`announce.pairingCountdown*`), not from
    // this component.
    const { container } = render(<PairingQrDisplay {...defaultProps} />)

    const countdown = container.querySelector('.pairing-countdown')
    expect(countdown).toHaveAttribute('aria-hidden', 'true')
  })
})
