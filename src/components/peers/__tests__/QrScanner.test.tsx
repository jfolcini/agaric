import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { QrScanner } from '@/components/peers/QrScanner'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'

// Configurable mock for html5-qrcode module
let mockStartBehavior: 'error' | 'scan' | 'pending' | 'hanging' = 'error'
let mockScanData = ''
// #758 item 2: number of decode callbacks fired per scan. The real library
// keeps decoding frames (fps: 10) while the async stop() settles, so >1
// simulates the duplicate-decode burst of a single physical scan.
let mockScanFireCount = 1
// 'hanging': start() stays pending (camera prompt open) until the test calls this.
let mockRejection: unknown = new Error('Camera access denied')
let releaseHangingStart: (() => void) | null = null
let failHangingStart: ((err: unknown) => void) | null = null

const mockStop = vi.fn().mockResolvedValue(undefined)
// #1615: capture the element id each Html5Qrcode instance is constructed with
// so tests can assert it matches the rendered region id and that two mounted
// scanners get distinct (non-colliding) ids.
const constructedIds: string[] = []

// Mirrors html5-qrcode (node_modules/html5-qrcode/esm/html5-qrcode.js):
// - start() synchronously empties its element (clearElement, :127, :704-711)
//   and only reaches SCANNING once the camera renders (:185-186).
// - stop() THROWS a string, it does not reject, unless SCANNING (:226-229).
vi.mock('html5-qrcode', () => ({
  Html5QrcodeScannerState: { UNKNOWN: 0, NOT_STARTED: 1, SCANNING: 2, PAUSED: 3 },
  Html5Qrcode: class MockHtml5Qrcode {
    private state = 1
    private readonly elementId: string
    constructor(elementId: string) {
      this.elementId = elementId
      constructedIds.push(elementId)
    }
    getState() {
      return this.state
    }
    start(
      _cameraConfig: unknown,
      _scanConfig: unknown,
      onSuccess?: (text: string) => void,
      _onFailure?: () => void,
    ) {
      const element = document.getElementById(this.elementId)
      if (element) element.innerHTML = ''
      const reachScanning = () => {
        this.state = 2
        element?.append(document.createElement('video'))
      }
      if (mockStartBehavior === 'error') {
        return Promise.reject(mockRejection)
      }
      if (mockStartBehavior === 'hanging') {
        return new Promise<void>((resolve, reject) => {
          releaseHangingStart = () => {
            reachScanning()
            resolve()
          }
          failHangingStart = reject
        })
      }
      reachScanning()
      // Simulate successful scan(s) after a microtask
      if (mockStartBehavior === 'scan' && onSuccess) {
        for (let i = 0; i < mockScanFireCount; i++) {
          queueMicrotask(() => onSuccess(mockScanData))
        }
      }
      // 'pending': started but no scan result yet — scanner stays running
      return Promise.resolve()
    }
    stop() {
      // oxlint-disable-next-line only-throw-error -- the library throws a bare string
      if (this.state !== 2) throw 'Cannot stop, scanner is not running or paused.'
      this.state = 1
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
  releaseHangingStart = null
  failHangingStart = null
  mockRejection = new Error('Camera access denied')
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
  // #5386: choosing to scan is the go-ahead; a second "Scan QR code" press is not.
  it('starts the camera on mount, with no button to press', async () => {
    mockStartBehavior = 'pending'
    render(<QrScanner onScan={vi.fn()} />)

    expect(await screen.findByText(t('qrScanner.scanningMessage'))).toBeInTheDocument()
    expect(constructedIds).toHaveLength(1)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('Retry camera after a denied camera starts it again', async () => {
    mockRejection = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<QrScanner onScan={vi.fn()} />)
    const retry = await screen.findByRole('button', { name: /retry camera/i })

    mockStartBehavior = 'pending'
    await user.click(retry)

    expect(await screen.findByText(t('qrScanner.scanningMessage'))).toBeInTheDocument()
    expect(screen.queryByText(t('qrScanner.cameraDenied'))).not.toBeInTheDocument()
    expect(constructedIds).toHaveLength(2)
  })

  // StrictMode mounts, unmounts and remounts at once: one camera, not two.
  it('starts one camera under StrictMode', async () => {
    mockStartBehavior = 'pending'
    const { container } = render(
      <StrictMode>
        <QrScanner onScan={vi.fn()} />
      </StrictMode>,
    )

    expect(await screen.findByText(t('qrScanner.scanningMessage'))).toBeInTheDocument()
    expect(constructedIds).toHaveLength(1)
    expect(container.querySelectorAll('video')).toHaveLength(1)
  })

  it('a start that fails after a quick close is not reported to the gone parent', async () => {
    mockStartBehavior = 'hanging'
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const onError = vi.fn()
    const onCameraDenied = vi.fn()
    const { unmount } = render(
      <QrScanner onScan={vi.fn()} onError={onError} onCameraDenied={onCameraDenied} />,
    )
    await waitFor(() => expect(failHangingStart).not.toBeNull())
    unmount()

    await act(async () => {
      failHangingStart?.(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    })
    expect(onError).not.toHaveBeenCalled()
    expect(onCameraDenied).not.toHaveBeenCalled()
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
    mockStartBehavior = 'pending'

    render(<QrScanner onScan={vi.fn()} />)

    const region = screen.getByLabelText('QR code scanner viewport')
    // html5-qrcode renders into an empty child div, not the labelled section.
    const regionId = region.firstElementChild?.getAttribute('id')
    expect(regionId).toBeTruthy()
    // Sanitized useId value: no colons (valid CSS selector / getElementById id).
    expect(regionId).not.toContain(':')

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

    const [idA, idB] = regions.map((r) => r.firstElementChild?.getAttribute('id'))
    expect(idA).toBeTruthy()
    expect(idB).toBeTruthy()
    expect(idA).not.toBe(idB)
  })

  it('calls onError when camera access fails', async () => {
    const onScan = vi.fn()
    const onError = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} />)

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
    render(<QrScanner onScan={vi.fn()} onError={vi.fn()} />)

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
    const onScan = vi.fn()
    const onError = vi.fn()
    const onCameraDenied = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} onCameraDenied={onCameraDenied} />)

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

    const onScan = vi.fn()
    const onError = vi.fn()
    const onCameraDenied = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} onCameraDenied={onCameraDenied} />)

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

    const onScan = vi.fn()
    const onCameraDenied = vi.fn()

    render(<QrScanner onScan={onScan} onCameraDenied={onCameraDenied} />)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('success')
    })
    expect(onCameraDenied).not.toHaveBeenCalled()
  })

  it('shows Retry camera button after error', async () => {
    render(<QrScanner onScan={vi.fn()} onError={vi.fn()} />)

    expect(await screen.findByRole('button', { name: /retry camera/i })).toBeInTheDocument()
  })

  it('success: calls onScan with decoded text', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'hello-world'

    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('hello-world')
    })
  })

  it('success: parses JSON QR data', async () => {
    mockStartBehavior = 'scan'
    mockScanData = JSON.stringify('passphrase-data')

    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('passphrase-data')
    })
  })

  it('success: passes through non-JSON data as raw text', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'raw-passphrase'

    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('raw-passphrase')
    })
  })

  it('success: scanner stops after scan', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'some-data'

    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

    await waitFor(() => {
      expect(onScan).toHaveBeenCalled()
    })
    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Scanning...')).not.toBeInTheDocument()
  })

  // #758 item 2: the decode callback fires at fps:10 while the async stop()
  // settles — without the hasScanned latch onScan fired once per duplicate
  // decode of the same physical QR code.
  it('fires onScan exactly once when the decode callback fires multiple times (#758 item 2)', async () => {
    mockStartBehavior = 'scan'
    mockScanData = 'dup-passphrase'
    mockScanFireCount = 3

    const onScan = vi.fn()

    render(<QrScanner onScan={onScan} />)

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

  // Issue #5386: the real start() empties its element; React must own nothing in it.
  it('keeps the preview rendered after start() empties its element (#5386)', async () => {
    mockStartBehavior = 'pending'
    const { container } = render(<QrScanner onScan={vi.fn()} />)

    expect(await screen.findByText(t('qrScanner.scanningMessage'))).toBeInTheDocument()
    expect(container.querySelector('video')).not.toBeNull()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('unmount with a running camera stops it without throwing (#5386)', async () => {
    mockStartBehavior = 'pending'
    const { unmount } = render(<QrScanner onScan={vi.fn()} />)
    await screen.findByText(t('qrScanner.scanningMessage'))

    expect(() => unmount()).not.toThrow()
    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1))
  })

  it('a quick close while start is pending throws nothing and stops once start settles (#5386)', async () => {
    mockStartBehavior = 'hanging'
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { unmount } = render(<QrScanner onScan={vi.fn()} />)
    await waitFor(() => expect(releaseHangingStart).not.toBeNull())

    expect(() => unmount()).not.toThrow()
    expect(mockStop).not.toHaveBeenCalled()

    await act(async () => {
      releaseHangingStart?.()
    })
    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1))
    // The not-yet-started camera is skipped, not stopped-and-logged as a failure.
    expect(warn).not.toHaveBeenCalled()
  })

  it('a stop that fails after unmount is logged, not reported to the gone parent as a camera error', async () => {
    mockStartBehavior = 'hanging'
    const stopFailure = new Error('stop failed')
    mockStop.mockRejectedValueOnce(stopFailure)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const onError = vi.fn()
    const onCameraDenied = vi.fn()
    const { unmount } = render(
      <QrScanner onScan={vi.fn()} onError={onError} onCameraDenied={onCameraDenied} />,
    )
    await waitFor(() => expect(releaseHangingStart).not.toBeNull())
    unmount()

    await act(async () => {
      releaseHangingStart?.()
    })
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'QrScanner',
        'Failed to stop scanner on unmount',
        undefined,
        stopFailure,
      ),
    )
    expect(onError).not.toHaveBeenCalled()
    expect(onCameraDenied).not.toHaveBeenCalled()
  })

  it('permission denied shows the denied message, logs, and notifies the parent (#5386)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mockStartBehavior = 'error'
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const onCameraDenied = vi.fn()
    mockRejection = denied
    render(<QrScanner onScan={vi.fn()} onCameraDenied={onCameraDenied} />)

    expect(await screen.findByText(t('qrScanner.cameraDenied'))).toBeInTheDocument()
    expect(onCameraDenied).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'QrScanner',
      'Camera initialization failed',
      undefined,
      denied,
    )
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
