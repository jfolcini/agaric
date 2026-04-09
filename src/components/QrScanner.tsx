import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'

// QR scanner component — production-ready implementation.
// Uses html5-qrcode for camera access and QR code detection.
// See docs/SYNC-PLATFORM-NOTES.md #220 for original implementation plan.

interface QrScannerProps {
  onScan: (data: string) => void
  onError?: (error: string) => void
}

export function QrScanner({ onScan, onError }: QrScannerProps) {
  const { t } = useTranslation()
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scannerRef = useRef<HTMLDivElement>(null)
  const scannerInstanceRef = useRef<{ stop: () => Promise<void> } | null>(null)

  // Cleanup scanner on unmount to prevent camera leaks
  useEffect(() => {
    return () => {
      if (scannerInstanceRef.current) {
        scannerInstanceRef.current.stop().catch((err: unknown) => {
          logger.warn('QrScanner', 'Failed to stop scanner on unmount', undefined, err)
        })
        scannerInstanceRef.current = null
      }
    }
  }, [])

  const startScanning = async () => {
    try {
      // Dynamic import to avoid bundling html5-qrcode on desktop
      const { Html5Qrcode } = await import('html5-qrcode')

      if (!scannerRef.current) return

      const scanner = new Html5Qrcode(scannerRef.current.id)
      scannerInstanceRef.current = scanner
      setScanning(true)
      setError(null)

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          scanner.stop().catch((err: unknown) => {
            logger.warn('QrScanner', 'Failed to stop scanner after successful scan', undefined, err)
          })
          scannerInstanceRef.current = null
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Camera access denied'
      setError(message)
      setScanning(false)
      scannerInstanceRef.current = null
      onError?.(message)
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <section
        id="qr-scanner-region"
        ref={scannerRef}
        className="w-full max-w-64 aspect-square bg-muted rounded-md flex items-center justify-center"
        aria-label={t('qrScanner.viewportLabel')}
      >
        {!scanning && !error && (
          <p className="text-sm text-muted-foreground">{t('qrScanner.cameraPreview')}</p>
        )}
        {error && (
          <p
            className="qr-scanner-error text-sm text-destructive px-4 text-center"
            aria-live="assertive"
          >
            {error}
          </p>
        )}
      </section>
      {!scanning && (
        <Button variant="outline" size="sm" onClick={startScanning} className="touch-target">
          {error ? t('qrScanner.retryCameraButton') : t('qrScanner.scanQrCodeButton')}
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
