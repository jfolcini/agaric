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
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'

// Lazy-load QrScanner to avoid bundling html5-qrcode on desktop
const LazyQrScanner = lazy(() => import('./QrScanner').then((m) => ({ default: m.QrScanner })))

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

  return (
    <>
      <div className="relative my-4">
        <Separator />
        <span className="pairing-separator absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
          {t('pairing.orSeparator')}
        </span>
      </div>

      {/* Entry mode toggle: manual passphrase vs QR scan */}
      <div className="pairing-entry-toggle flex gap-2 mb-4 justify-center">
        <Button
          variant={entryMode === 'manual' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onEntryModeChange('manual')}
          className="touch-target"
        >
          {t('pairing.typePassphraseButton')}
        </Button>
        <Button
          variant={entryMode === 'scan' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onEntryModeChange('scan')}
          className="touch-target"
        >
          <Camera className="h-4 w-4 mr-1" />
          {t('pairing.scanQrCodeButton')}
        </Button>
      </div>

      {/* Conditional: manual word inputs or QR scanner */}
      {entryMode === 'manual' ? (
        <div className="pairing-word-inputs grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          {(['first', 'second', 'third', 'fourth'] as const).map((slot, i) => (
            <Input
              key={slot}
              value={words[i]}
              onChange={(e) => onWordChange(i, e.target.value)}
              onKeyDown={(e) => onWordKeyDown(i, e)}
              placeholder={t('pairing.wordPlaceholder', {
                ordinal: ['1st', '2nd', '3rd', '4th'][i],
              })}
              aria-label={t('pairing.wordLabel', { num: i + 1 })}
              className="text-center touch-target"
              disabled={pairLoading || isExpired}
            />
          ))}
        </div>
      ) : (
        <div className="pairing-qr-scanner mb-4">
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-8">
                <Spinner className="text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  {t('pairing.loadingScannerMessage')}
                </span>
              </div>
            }
          >
            <LazyQrScanner onScan={onQrScan} onError={(err) => onQrError(err)} />
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
