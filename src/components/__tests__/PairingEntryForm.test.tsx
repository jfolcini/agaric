/**
 * Tests for PairingEntryForm component.
 *
 * Validates:
 *  - Renders 4 word input fields in manual mode
 *  - Shows "or" separator
 *  - Entry mode toggle buttons work
 *  - Word inputs call onWordChange with correct index and value
 *  - Word inputs call onWordKeyDown on key press
 *  - Cancel button calls onCancel
 *  - Pair button calls onPair
 *  - Pair button is disabled when words are empty
 *  - Pair button is disabled when session is expired
 *  - Inputs are disabled when pairLoading or isExpired
 *  - Responsive grid classes on word inputs container
 *  - Accessibility audit
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PairingEntryForm } from '../PairingEntryForm'

// Mock QrScanner to avoid loading html5-qrcode in tests.
// UX-264: also expose an `onCameraDenied` button so tests can drive the
// camera-denied auto-fallback to manual entry.
vi.mock('../QrScanner', () => ({
  QrScanner: ({
    onScan,
    onCameraDenied,
  }: {
    onScan: (data: string) => void
    onCameraDenied?: () => void
  }) => (
    <div data-testid="qr-scanner-mock">
      <button type="button" onClick={() => onScan('test scan data')}>
        Mock Scan
      </button>
      <button type="button" data-testid="mock-camera-denied" onClick={() => onCameraDenied?.()}>
        Mock Camera Denied
      </button>
    </div>
  ),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

const defaultProps = {
  words: ['', '', '', ''] as [string, string, string, string],
  entryMode: 'manual' as const,
  onEntryModeChange: vi.fn(),
  onWordChange: vi.fn(),
  onWordKeyDown: vi.fn(),
  onQrScan: vi.fn(),
  onQrError: vi.fn(),
  onCancel: vi.fn(),
  onPair: vi.fn(),
  pairLoading: false,
  isExpired: false,
}

describe('PairingEntryForm', () => {
  it('renders 4 word input fields in manual mode', () => {
    render(<PairingEntryForm {...defaultProps} />)

    const inputs = screen.getAllByRole('textbox')
    expect(inputs.length).toBe(4)
  })

  it('shows word input aria-labels', () => {
    render(<PairingEntryForm {...defaultProps} />)

    expect(screen.getByLabelText('Passphrase word 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 2')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 3')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 4')).toBeInTheDocument()
  })

  it('shows "or" separator', () => {
    render(<PairingEntryForm {...defaultProps} />)

    expect(screen.getByText('OR')).toBeInTheDocument()
  })

  it('shows entry mode toggle buttons', () => {
    render(<PairingEntryForm {...defaultProps} />)

    expect(screen.getByRole('button', { name: /Type passphrase/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Scan QR code/i })).toBeInTheDocument()
  })

  it('calls onEntryModeChange when scan button is clicked', async () => {
    const user = userEvent.setup()
    const onEntryModeChange = vi.fn()
    render(<PairingEntryForm {...defaultProps} onEntryModeChange={onEntryModeChange} />)

    await user.click(screen.getByRole('button', { name: /Scan QR code/i }))
    expect(onEntryModeChange).toHaveBeenCalledWith('scan')
  })

  it('calls onEntryModeChange when type passphrase button is clicked', async () => {
    const user = userEvent.setup()
    const onEntryModeChange = vi.fn()
    render(
      <PairingEntryForm {...defaultProps} entryMode="scan" onEntryModeChange={onEntryModeChange} />,
    )

    await user.click(screen.getByRole('button', { name: /Type passphrase/i }))
    expect(onEntryModeChange).toHaveBeenCalledWith('manual')
  })

  it('calls onWordChange when typing in a word input', async () => {
    const user = userEvent.setup()
    const onWordChange = vi.fn()
    render(<PairingEntryForm {...defaultProps} onWordChange={onWordChange} />)

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0] as HTMLElement, 'a')

    expect(onWordChange).toHaveBeenCalledWith(0, 'a')
  })

  it('Cancel button calls onCancel', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<PairingEntryForm {...defaultProps} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Pair button calls onPair when all words filled', async () => {
    const user = userEvent.setup()
    const onPair = vi.fn()
    render(
      <PairingEntryForm
        {...defaultProps}
        words={['echo', 'foxtrot', 'golf', 'hotel']}
        onPair={onPair}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^Pair$/i }))
    expect(onPair).toHaveBeenCalledTimes(1)
  })

  it('Pair button is disabled when words are empty', () => {
    render(<PairingEntryForm {...defaultProps} />)

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    expect(pairBtn).toBeDisabled()
  })

  it('Pair button is disabled when some words are empty', () => {
    render(<PairingEntryForm {...defaultProps} words={['echo', '', 'golf', '']} />)

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    expect(pairBtn).toBeDisabled()
  })

  it('Pair button is disabled when session is expired', () => {
    render(
      <PairingEntryForm
        {...defaultProps}
        words={['echo', 'foxtrot', 'golf', 'hotel']}
        isExpired={true}
      />,
    )

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    expect(pairBtn).toBeDisabled()
  })

  it('inputs are disabled when pairLoading is true', () => {
    render(<PairingEntryForm {...defaultProps} pairLoading={true} />)

    const inputs = screen.getAllByRole('textbox')
    for (const input of inputs) {
      expect(input).toBeDisabled()
    }
  })

  it('inputs are disabled when isExpired is true', () => {
    render(<PairingEntryForm {...defaultProps} isExpired={true} />)

    const inputs = screen.getAllByRole('textbox')
    for (const input of inputs) {
      expect(input).toBeDisabled()
    }
  })

  it('Cancel button is disabled when pairLoading is true', () => {
    render(<PairingEntryForm {...defaultProps} pairLoading={true} />)

    const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
    expect(cancelBtn).toBeDisabled()
  })

  it('word inputs container has responsive grid classes', () => {
    render(<PairingEntryForm {...defaultProps} />)

    const grid = document.querySelector('.pairing-word-inputs')
    expect(grid).toBeInTheDocument()
    expect(grid?.classList.contains('grid-cols-2')).toBe(true)
    expect(grid?.classList.contains('sm:grid-cols-4')).toBe(true)
  })

  it('displays word values from props', () => {
    render(<PairingEntryForm {...defaultProps} words={['echo', 'foxtrot', 'golf', 'hotel']} />)

    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[]
    expect(inputs[0]).toHaveValue('echo')
    expect(inputs[1]).toHaveValue('foxtrot')
    expect(inputs[2]).toHaveValue('golf')
    expect(inputs[3]).toHaveValue('hotel')
  })

  it('has no a11y violations in manual mode', async () => {
    const { container } = render(<PairingEntryForm {...defaultProps} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with filled words', async () => {
    const { container } = render(
      <PairingEntryForm {...defaultProps} words={['echo', 'foxtrot', 'golf', 'hotel']} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // UX-263: visible ordinal labels above each word input
  it('renders a visible ordinal Label above each word input', () => {
    const { container } = render(<PairingEntryForm {...defaultProps} />)

    const labels = container.querySelectorAll('.pairing-word-label')
    expect(labels.length).toBe(4)
    expect(labels[0]?.textContent).toBe('1st word')
    expect(labels[1]?.textContent).toBe('2nd word')
    expect(labels[2]?.textContent).toBe('3rd word')
    expect(labels[3]?.textContent).toBe('4th word')
  })

  it('associates each ordinal Label with its input via htmlFor / id (UX-263)', () => {
    const { container } = render(<PairingEntryForm {...defaultProps} />)

    const labels = container.querySelectorAll('label.pairing-word-label')
    const inputs = container.querySelectorAll('.pairing-word-inputs input')
    expect(labels.length).toBe(4)
    expect(inputs.length).toBe(4)
    for (let i = 0; i < 4; i++) {
      const labelFor = labels[i]?.getAttribute('for')
      const inputId = inputs[i]?.getAttribute('id')
      expect(labelFor).toBeTruthy()
      expect(inputId).toBeTruthy()
      expect(labelFor).toBe(inputId)
    }
  })

  // UX-264: when the QR scanner's camera permission is denied, the form
  // auto-switches back to manual entry and surfaces a toast so the user is
  // never stranded on a failing scanner UI.
  it('switches to manual mode and shows toast when QR scanner reports camera denial (UX-264)', async () => {
    const user = userEvent.setup()
    const onEntryModeChange = vi.fn()

    render(
      <PairingEntryForm {...defaultProps} entryMode="scan" onEntryModeChange={onEntryModeChange} />,
    )

    // The mocked scanner is rendered (we're in scan mode).
    // PairingEntryForm uses React.lazy for QrScanner so we await Suspense
    // to resolve the dynamic import before driving the mock buttons.
    const cameraDeniedBtn = await screen.findByTestId('mock-camera-denied')

    // Fire the camera-denied signal from the scanner.
    await user.click(cameraDeniedBtn)

    // Parent is asked to switch back to manual entry…
    expect(onEntryModeChange).toHaveBeenCalledWith('manual')
    // …and a toast.info surfaces the fallback explanation.
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        'Camera access denied \u2014 switched to manual entry',
      )
    })
  })
})
