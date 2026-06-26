import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { QrScanner } from '@/components/peers/QrScanner'
import { t } from '@/lib/i18n'

// Configurable mock for html5-qrcode module
let mockStartBehavior: 'error' | 'scan' | 'pending' = 'error'
let mockScanData = ''
// #758 item 2: number of decode callbacks fired per scan. The real library
// keeps decoding frames (fps: 10) while the async stop() settles, so >1
// simulates the duplicate-decode burst of a single physical scan.
let mockScanFireCount = 1

const mockStop = vi.fn().mockResolvedValue(undefined)
// #1615: capture the element id each Html5Qrcode instance is constructed with
// so tests can assert it matches the rendered region id and that two mounted
// scanners get distinct (non-colliding) ids.
const constructedIds: string[] = []

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class MockHtml5Qrcode {
    constructor(elementId: string) {
      constructedIds.push(elementId)
    }
    async start(
      _cameraConfig: unknown,
      _scanConfig: unknown,
      onSuccess?: (text: string) => void,
      _onFailure?: () => void,
    ) {
      if (mockStartBehavior === 'error') {
        throw new Error('Camera access denied')
      }
      // Simulate successful scan(s) after a microtask
      if (mockStartBehavior === 'scan' && onSuccess) {
        for (let i = 0; i < mockScanFireCount; i++) {
          queueMicrotask(() => onSuccess(mockScanData))
        }
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
  mockScanFireCount = 1
  constructedIds.length = 0
  // jsdom leaves navigator.mediaDevices undefined; QrScanner now guards on it
  // and bails before touching html5-qrcode when getUserMedia is missing. Stub
  // a present API so the existing tests exercise the library path, not the
  // unavailable-API guard (which has its own test below).
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({}) },
  })
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
    // #1615: the region id is now per-instance (useId-derived), so query by
    // the stable aria-label instead of a hardcoded id.
    const region = screen.getByLabelText('QR code scanner viewport')
    expect(region).toBeTruthy()
    expect(region.getAttribute('aria-label')).toBe('QR code scanner viewport')
    expect(region.tagName.toLowerCase()).toBe('section')
  })

  // #1615: the viewport id must be generated per-instance (useId) and the SAME
  // value must be handed to the Html5Qrcode constructor, otherwise html5-qrcode
  // (which keys its render target on element id) collides when two scanners are
  // mounted at once.
  it('passes the rendered region id to the Html5Qrcode constructor (#1615)', async () => {
    const user = userEvent.setup()
    mockStartBehavior = 'pending'

    render(<QrScanner onScan={vi.fn()} />)

    const region = screen.getByLabelText('QR code scanner viewport')
    const regionId = region.getAttribute('id')
    expect(regionId).toBeTruthy()
    // Sanitized useId value: no colons (valid CSS selector / getElementById id).
    expect(regionId).not.toContain(':')

    await user.click(screen.getByRole('button', { name: /scan qr code/i }))

    await waitFor(() => {
      expect(constructedIds).toHaveLength(1)
    })
    // The constructor receives exactly the rendered region id.
    expect(constructedIds[0]).toBe(regionId)
  })

  it('gives two mounted scanners distinct region ids (#1615)', () => {
    render(<QrScanner onScan={vi.fn()} />)
    render(<QrScanner onScan={vi.fn()} />)

    const regions = screen.getAllByLabelText('QR code scanner viewport')
    expect(regions).toHaveLength(2)

    const [idA, idB] = regions.map((r) => r.getAttribute('id'))
    expect(idA).toBeTruthy()
    expect(idB).toBeTruthy()
    expect(idA).not.toBe(idB)
  })

  it('calls onError when camera access fails', async () => {
    const user = userEvent.setup()
    const onScan = vi.fn()
    const onError = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    // #1888: the user-facing error is the translated catalog string (not the
    // raw, untranslated `err.message`), and the same translated text is passed
    // to onError.
    expect(await screen.findByText(t('qrScanner.cameraError'))).toBeInTheDocument()
    expect(onError).toHaveBeenCalledWith(t('qrScanner.cameraError'))
    expect(onScan).not.toHaveBeenCalled()
  })

  // #1888: the announced (aria-live="assertive") error text is routed through
  // t() — never the raw browser/library error string.
  it('renders the translated camera error in the assertive live region (#1888)', async () => {
    const user = userEvent.setup()
    render(<QrScanner onScan={vi.fn()} onError={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /scan qr code/i }))

    const errorEl = await screen.findByText(t('qrScanner.cameraError'))
    expect(errorEl).toBeInTheDocument()
    expect(errorEl.getAttribute('aria-live')).toBe('assertive')
    // The raw library message must NOT leak through to the user.
    expect(screen.queryByText('Camera access denied')).not.toBeInTheDocument()
  })

  // Parent receives an explicit camera-denied signal so it can
  // auto-switch to manual entry rather than leave the user staring at the
  // in-scanner error indefinitely.
  it('calls onCameraDenied when camera access fails', async () => {
    const user = userEvent.setup()
    const onScan = vi.fn()
    const onError = vi.fn()
    const onCameraDenied = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} onCameraDenied={onCameraDenied} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    expect(await screen.findByText(t('qrScanner.cameraError'))).toBeInTheDocument()
    expect(onCameraDenied).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(t('qrScanner.cameraError'))
  })

  // When the WebView exposes no camera API at all (insecure context or an
  // Android build without the CAMERA permission), the scanner must short-circuit
  // with a clear "unavailable" message and fall back to manual entry — without
  // ever constructing html5-qrcode (which would otherwise throw a cryptic error).
  it('bails with an unavailable message when navigator.mediaDevices is missing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })

    const user = userEvent.setup()
    const onScan = vi.fn()
    const onError = vi.fn()
    const onCameraDenied = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} onCameraDenied={onCameraDenied} />)

    await user.click(screen.getByRole('button', { name: /scan qr code/i }))

    expect(await screen.findByText(t('qrScanner.cameraUnavailable'))).toBeInTheDocument()
    expect(onError).toHaveBeenCalledWith(t('qrScanner.cameraUnavailable'))
    expect(onCameraDenied).toHaveBeenCalledTimes(1)
    // The library must not be touched when the API is absent.
    expect(constructedIds).toHaveLength(0)
    expect(onScan).not.toHaveBeenCalled()
  })

  it('does not call onCameraDenied on successful scan', async () => {
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

  // #758 item 2: the decode callback fires at fps:10 while the async stop()
  // settles — without the hasScanned latch onScan fired once per duplicate
  // decode of the same physical QR code.
  it('fires onScan exactly once when the decode callback fires multiple times (#758 item 2)', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'dup-passphrase'
    mockScanFireCount = 3

    const user = userEvent.setup()
    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    await user.click(screen.getByRole('button', { name: /scan qr code/i }))

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('dup-passphrase')
    })
    // Let any remaining queued decode callbacks drain before asserting
    // (React 19 external-source wait pattern — see component AGENTS.md).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(onScan).toHaveBeenCalledTimes(1)
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
