import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode'
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'

// QR scanner component — production-ready implementation.
// Uses html5-qrcode for camera access and QR code detection.
// See docs/architecture/sync-and-network.md § Pairing for the
// platform constraint (Android CAMERA permission + file-upload + 4-word
// manual-entry fallbacks).

/** One camera start; the effect cleanup ends it. */
interface CameraSession {
  cancelled: boolean
  /** Stops the camera; html5-qrcode throws from stop() unless it is running. */
  stop: (() => Promise<void>) | null
}

interface QrScannerProps {
  onScan: (data: string) => void
}

export function QrScanner({ onScan }: QrScannerProps) {
  const { t } = useTranslation()
  // #1615: html5-qrcode keys its render target on the element id, so a
  // hardcoded id would collide if two scanners are mounted at once. Derive a
  // per-instance id from useId(). useId() yields colon-bearing strings (`:r0:`)
  // which are valid HTML ids but invalid CSS selectors, so we strip the colons
  // to a stable id that's safe for both getElementById and querySelector. The
  // value is memoized so it stays constant across renders.
  const generatedId = useId()
  const scannerId = useMemo(
    () => `qr-scanner-region-${generatedId.replace(/:/g, '')}`,
    [generatedId],
  )
  // The camera starts on mount, so the scanner is scanning until it fails or reads a code.
  const [scanning, setScanning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped by "Retry camera"; each value is one camera session.
  const [attempt, setAttempt] = useState(0)
  const scannerRef = useRef<HTMLDivElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (error) retryRef.current?.focus()
  }, [error])

  // Translate a getUserMedia / html5-qrcode failure into an actionable,
  // localized message. getUserMedia rejects with a DOMException whose `name`
  // distinguishes the cause, so the user (and our logs) can tell a permission
  // denial apart from a missing camera or an unsupported WebView. html5-qrcode
  // passes that failure on as a string that embeds the name:
  // "Error getting userMedia, error = NotAllowedError: Permission denied".
  const cameraErrorMessage = (err: unknown): string => {
    const cause =
      typeof err === 'string'
        ? err
        : err && typeof err === 'object' && 'name' in err
          ? String((err as { name: unknown }).name)
          : ''
    if (/\b(NotAllowedError|SecurityError)\b/.test(cause)) {
      return t('qrScanner.cameraDenied')
    }
    if (/\b(NotFoundError|DevicesNotFoundError|OverconstrainedError)\b/.test(cause)) {
      return t('qrScanner.cameraNotFound')
    }
    return t('qrScanner.cameraError')
  }

  const failCamera = (message: string) => {
    setError(message)
    setScanning(false)
  }

  const startCamera = useEffectEvent(async (session: CameraSession) => {
    // StrictMode mounts, cleans up and remounts in one commit. Starting a
    // microtask later lets that cleanup cancel before the camera is asked for.
    await Promise.resolve()
    if (session.cancelled) return

    // getUserMedia is only exposed in a secure context backed by a
    // media-capable WebView. On Android the app must hold the CAMERA
    // permission AND be served from a secure origin (tauri.localhost) for
    // this to be defined. When it isn't, html5-qrcode throws a cryptic
    // library error — bail early with a clear, actionable message and fall
    // back to manual entry instead.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      logger.warn(
        'QrScanner',
        'navigator.mediaDevices.getUserMedia is unavailable (insecure context or unsupported WebView)',
      )
      failCamera(t('qrScanner.cameraUnavailable'))
      return
    }

    const element = scannerRef.current
    if (!element) return

    try {
      const scanner = new Html5Qrcode(element.id)
      const stopIfStarted = () =>
        scanner.getState() === Html5QrcodeScannerState.NOT_STARTED
          ? Promise.resolve()
          : Promise.resolve().then(() => scanner.stop())
      session.stop = stopIfStarted
      // #758 item 2: html5-qrcode keeps decoding frames (fps: 10) while the
      // async stop() settles, so the decode callback can fire multiple times
      // for one physical scan. Latch on the first decode and drop the rest.
      let scanned = false

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          // Ask for a square stream so the video fills the square viewfinder.
          // No object-fit crop: html5-qrcode maps the qrbox to stream pixels
          // by the video element's rendered size.
          aspectRatio: 1,
          // Sized from the rendered video, so the frame always sits inside it.
          qrbox: (width, height) => {
            const side = Math.floor(Math.min(width, height) * 0.7)
            return { width: side, height: side }
          },
        },
        (decodedText) => {
          if (scanned) return
          scanned = true

          stopIfStarted().catch((err: unknown) => {
            logger.warn('QrScanner', 'Failed to stop scanner after successful scan', undefined, err)
          })
          session.stop = null
          setScanning(false)

          // Parse QR data safely — try JSON, fall back to raw text
          let parsed: string = decodedText
          try {
            const obj = JSON.parse(decodedText)
            parsed = typeof obj === 'string' ? obj : decodedText
          } catch {
            // Not JSON — use raw text (expected for passphrase QR codes)
          }
          onScan(parsed)
        },
        () => {
          // QR code not detected in frame — normal, keep scanning
        },
      )
      // Closed while start() was pending: the cleanup could not stop a
      // camera that had not started yet. A failure here is not an init failure.
      if (session.cancelled) {
        stopIfStarted().catch((err: unknown) => {
          logger.warn('QrScanner', 'Failed to stop scanner on unmount', undefined, err)
        })
      }
    } catch (err) {
      // Log the raw error for debugging, but surface a translated, cause-aware
      // message to the aria-live region (raw `err.message` is untranslated and
      // often a cryptic browser/library string). #1888
      logger.warn('QrScanner', 'Camera initialization failed', undefined, err)
      session.stop = null
      // A cancelled session (closed, or replaced by Retry) must not paint its
      // failure over the session that superseded it.
      if (session.cancelled) return
      failCamera(cameraErrorMessage(err))
    }
  })

  // Choosing to scan is the user's go-ahead: the camera starts on mount.
  useEffect(() => {
    const session: CameraSession = { cancelled: false, stop: null }
    // oxlint-disable-next-line react/set-state-in-effect -- startCamera sets state only after its first await, never synchronously in this effect
    void startCamera(session)
    return () => {
      session.cancelled = true
      session.stop?.().catch((err: unknown) => {
        logger.warn('QrScanner', 'Failed to stop scanner on unmount', undefined, err)
      })
    }
  }, [attempt])

  return (
    <div className="flex flex-col items-center gap-2">
      <section
        className="w-full max-w-64 aspect-square overflow-hidden bg-muted rounded-md flex flex-col items-center justify-center"
        aria-label={t('qrScanner.viewportLabel')}
      >
        {/* html5-qrcode empties this node on start(); React must render nothing in it.
            A camera that ignores the square request renders centred: a wide image
            letterboxed, a tall one clipped by the section, its frame still in view. */}
        <div id={scannerId} ref={scannerRef} className="w-full" />
        {/* Mounted empty, so screen readers announce the error when it is filled in. */}
        <p className="text-sm text-destructive px-4 text-center" aria-live="assertive">
          {error}
        </p>
      </section>
      {error && (
        <Button
          ref={retryRef}
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null)
            setScanning(true)
            setAttempt((n) => n + 1)
          }}
          className="touch-target"
        >
          {t('qrScanner.retryCameraButton')}
        </Button>
      )}
      {scanning && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('qrScanner.scanningMessage')}
        </p>
      )}
    </div>
  )
}
