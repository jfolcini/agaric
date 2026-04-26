import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { QrScanner } from '../QrScanner'

// Configurable mock for html5-qrcode module
let mockStartBehavior: 'error' | 'scan' | 'pending' = 'error'
let mockScanData = ''

const mockStop = vi.fn().mockResolvedValue(undefined)

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class MockHtml5Qrcode {
    async start(
      _cameraConfig: unknown,
      _scanConfig: unknown,
      onSuccess?: (text: string) => void,
      _onFailure?: () => void,
    ) {
      if (mockStartBehavior === 'error') {
        throw new Error('Camera access denied')
      }
      // Simulate successful scan after a microtask
      if (mockStartBehavior === 'scan' && onSuccess) {
        queueMicrotask(() => onSuccess(mockScanData))
      }
      // 'pending': started but no scan result yet — scanner stays running
    }
    async stop() {
      return mockStop()
    }
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStartBehavior = 'error'
  mockScanData = ''
})

describe('QrScanner', () => {
  it('renders without crashing', () => {
    render(<QrScanner onScan={vi.fn()} />)
    expect(screen.getByText('Camera preview')).toBeInTheDocument()
  })

  it('shows scan button', () => {
    render(<QrScanner onScan={vi.fn()} />)
    expect(screen.getByRole('button', { name: /scan qr code/i })).toBeInTheDocument()
  })

  it('passes accessibility audit', async () => {
    const { container } = render(<QrScanner onScan={vi.fn()} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('scanner region has aria-label', () => {
    render(<QrScanner onScan={vi.fn()} />)
    const region = document.getElementById('qr-scanner-region')
    expect(region).toBeTruthy()
    expect(region?.getAttribute('aria-label')).toBe('QR code scanner viewport')
    expect(region?.tagName.toLowerCase()).toBe('section')
  })

  it('calls onError when camera access fails', async () => {
    const user = userEvent.setup()
    const onScan = vi.fn()
    const onError = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    // Should show error and call onError callback
    expect(await screen.findByText('Camera access denied')).toBeInTheDocument()
    expect(onError).toHaveBeenCalledWith('Camera access denied')
    expect(onScan).not.toHaveBeenCalled()
  })

  // UX-264: parent receives an explicit camera-denied signal so it can
  // auto-switch to manual entry rather than leave the user staring at the
  // in-scanner error indefinitely.
  it('calls onCameraDenied when camera access fails (UX-264)', async () => {
    const user = userEvent.setup()
    const onScan = vi.fn()
    const onError = vi.fn()
    const onCameraDenied = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} onCameraDenied={onCameraDenied} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    expect(await screen.findByText('Camera access denied')).toBeInTheDocument()
    expect(onCameraDenied).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('Camera access denied')
  })

  it('does not call onCameraDenied on successful scan (UX-264)', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'success'

    const user = userEvent.setup()
    const onScan = vi.fn()
    const onCameraDenied = vi.fn()

    render(<QrScanner onScan={onScan} onCameraDenied={onCameraDenied} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('success')
    })
    expect(onCameraDenied).not.toHaveBeenCalled()
  })

  it('shows Retry Camera button after error', async () => {
    const user = userEvent.setup()
    render(<QrScanner onScan={vi.fn()} onError={vi.fn()} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    // After error, button text should change to "Retry Camera"
    expect(await screen.findByRole('button', { name: /retry camera/i })).toBeInTheDocument()
  })

  it('success: calls onScan with decoded text', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'hello-world'

    const user = userEvent.setup()
    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('hello-world')
    })
  })

  it('success: parses JSON QR data', async () => {
    mockStartBehavior = 'scan'
    mockScanData = JSON.stringify('passphrase-data')

    const user = userEvent.setup()
    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('passphrase-data')
    })
  })

  it('success: passes through non-JSON data as raw text', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'raw-passphrase'

    const user = userEvent.setup()
    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('raw-passphrase')
    })
  })

  it('success: scanner stops after scan (button reappears)', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'some-data'

    const user = userEvent.setup()
    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    // After successful scan, scanning stops and button should reappear
    await waitFor(() => {
      expect(onScan).toHaveBeenCalled()
    })

    // Button should be visible again (not "Scanning..." text)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /scan qr code/i })).toBeInTheDocument()
    })
    expect(screen.queryByText('Scanning...')).not.toBeInTheDocument()
  })

  it('cleanup: stops scanner on unmount', async () => {
    // Use 'pending' mode so scanner starts but onSuccess never fires —
    // scannerInstanceRef stays set and the cleanup effect is what calls stop().
    mockStartBehavior = 'pending'

    const user = userEvent.setup()
    const onScan = vi.fn()

    const { unmount } = render(<QrScanner onScan={onScan} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    // Unmount while scanner is running (no scan result yet)
    unmount()

    // The cleanup effect should have called stop()
    expect(mockStop).toHaveBeenCalled()
  })
})
