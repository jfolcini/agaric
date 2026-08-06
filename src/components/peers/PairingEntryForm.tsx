/**
 * PairingEntryForm -- passphrase entry form for the pairing dialog.
 *
 * Provides a toggle between manual word entry (4 text inputs) and QR camera
 * scanning, plus Cancel / Pair action buttons.
 *
 * Extracted from PairingDialog (#R-9).
 */

import { Camera } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useCallback, useId } from 'react'
import { useTranslation } from 'react-i18next'

import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { notify } from '@/lib/notify'

// Lazy-load QrScanner to avoid bundling html5-qrcode on desktop
const LazyQrScanner = lazy(() =>
  import('@/components/peers/QrScanner').then((m) => ({ default: m.QrScanner })),
)

export interface PairingEntryFormProps {
  words: [string, string, string, string]
  entryMode: 'manual' | 'scan'
  onEntryModeChange: (mode: 'manual' | 'scan') => void
  onWordChange: (index: number, value: string) => void
  onWordKeyDown: (index: number, e: React.KeyboardEvent<HTMLInputElement>) => void
  onQrScan: (data: string) => void
  onQrError: (err: string) => void
  onCancel: () => void
  onPair: () => void
  pairLoading: boolean
  isExpired: boolean
}

export function PairingEntryForm({
  words,
  entryMode,
  onEntryModeChange,
  onWordChange,
  onWordKeyDown,
  onQrScan,
  onQrError,
  onCancel,
  onPair,
  pairLoading,
  isExpired,
}: PairingEntryFormProps): React.ReactElement {
  const { t } = useTranslation()
  // Stable id prefix so visible ordinal Labels can htmlFor each input.
  const inputIdPrefix = useId()

  // When the QR scanner fails to acquire the camera (typically a
  // permission denial), auto-switch back to manual word entry and surface
  // a toast so the user understands what happened. Without this fallback
  // the user would be stuck looking at an in-scanner error.
  const handleCameraDenied = useCallback(() => {
    onEntryModeChange('manual')
    notify.info(t('pairing.cameraDeniedFallback'))
  }, [onEntryModeChange, t])

  return (
    <>
      <div className="relative my-4">
        <Separator />
        <span className="pairing-separator absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
          {t('pairing.orSeparator')}
        </span>
      </div>

      {/* Entry mode toggle: QR scan (recommended) vs manual passphrase.
          QR is faster and signposted as the recommended path. */}
      <div className="pairing-entry-toggle flex flex-col gap-2 mb-4 sm:flex-row sm:justify-center">
        <Button
          variant={entryMode === 'scan' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onEntryModeChange('scan')}
          className="touch-target w-full sm:w-auto"
        >
          <Camera className="h-4 w-4 mr-1" />
          {t('pairing.scanQrCodeButton')}
          <Badge tone="secondary" className="ml-1.5 text-xs py-0 px-1.5">
            {t('pairing.recommendedBadge')}
          </Badge>
        </Button>
        <Button
          variant={entryMode === 'manual' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onEntryModeChange('manual')}
          className="touch-target w-full sm:w-auto"
        >
          {t('pairing.typePassphraseButton')}
        </Button>
      </div>

      {/* Conditional: manual word inputs or QR scanner */}
      {entryMode === 'manual' ? (
        <div className="pairing-word-inputs grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          {(['first', 'second', 'third', 'fourth'] as const).map((slot, i) => {
            // Ordinal labels come from i18n (`pairing.ordinal.<slot>`)
            // so they can be localized rather than hardcoded English.
            const ordinal = t(`pairing.ordinal.${slot}`)
            const inputId = `${inputIdPrefix}-pairing-word-${i}`
            return (
              // Each word slot gets a visible ordinal Label so users
              // can confirm which position they're typing into without
              // relying on placeholders alone.
              <div key={slot} className="pairing-word-slot flex flex-col gap-1">
                <Label
                  htmlFor={inputId}
                  size="sm"
                  muted={false}
                  className="pairing-word-label text-foreground"
                >
                  {t('pairing.entryFormWord', { ordinal })}
                </Label>
                <Input
                  id={inputId}
                  value={words[i]}
                  onChange={(e) => onWordChange(i, e.target.value)}
                  onKeyDown={(e) => onWordKeyDown(i, e)}
                  placeholder={t('pairing.wordPlaceholder', { ordinal })}
                  aria-label={t('pairing.wordLabel', { num: i + 1 })}
                  className="text-center touch-target"
                  disabled={pairLoading || isExpired}
                />
              </div>
            )
          })}
        </div>
      ) : (
        <div className="pairing-qr-scanner mb-4">
          <Suspense
            fallback={
              <div className="flex flex-col items-center gap-2 py-4">
                <span className="text-sm text-muted-foreground">
                  {t('pairing.loadingScannerMessage')}
                </span>
                <LoadingSkeleton
                  count={1}
                  height="h-48"
                  className="w-48"
                  ariaLabel={t('pairing.loadingScannerMessage')}
                />
              </div>
            }
          >
            <LazyQrScanner
              onScan={onQrScan}
              onError={(err) => onQrError(err)}
              onCameraDenied={handleCameraDenied}
            />
          </Suspense>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex justify-between gap-2 mb-4">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={pairLoading}
          className="touch-target"
        >
          {t('pairing.cancelButton')}
        </Button>
        <Button
          onClick={onPair}
          disabled={pairLoading || words.some((w) => w === '') || isExpired}
          className="pairing-pair-btn touch-target"
        >
          {pairLoading && <Spinner className="mr-1" />}
          {t('pairing.pairButton')}
        </Button>
      </div>
    </>
  )
}
