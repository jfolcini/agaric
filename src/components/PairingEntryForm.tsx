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
import { lazy, Suspense, useCallback, useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'

// Lazy-load QrScanner to avoid bundling html5-qrcode on desktop
const LazyQrScanner = lazy(() => import('./QrScanner').then((m) => ({ default: m.QrScanner })))

// UX-263: Auto-resume window — even an idle user with focus in an input
// must not keep the pairing countdown paused indefinitely. After this many
// milliseconds without further keystrokes we notify the parent to resume.
const TYPING_DEBOUNCE_MS = 5000

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
  /**
   * UX-263: Notify the parent dialog when the user starts/stops typing in
   * a passphrase input so the countdown can be paused mid-keystroke. Fires
   * `true` on every keystroke; fires `false` on blur, after a 5s debounce
   * of no keystrokes, and on unmount.
   *
   * Note: we deliberately do NOT trigger on `onFocus`. The dialog
   * autofocuses the first input on mount, and auto-focus alone is not
   * "typing" — pausing the countdown the instant the dialog opens would
   * be confusing UX (the timer would appear stuck before the user did
   * anything). Real keystrokes via `onChange` are the trigger.
   */
  onTypingStateChange?: (isTyping: boolean) => void
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
  onTypingStateChange,
}: PairingEntryFormProps): React.ReactElement {
  const { t } = useTranslation()
  // UX-263: Stable id prefix so visible ordinal Labels can htmlFor each input.
  const inputIdPrefix = useId()

  // UX-263: Track the typing-debounce timer so each keystroke resets the
  // 5-second auto-resume window. Stash the latest callback in a ref so the
  // unmount cleanup always sees the most-recent prop reference without
  // re-running on every parent render.
  const debounceRef = useRef<number | null>(null)
  const onTypingStateChangeRef = useRef(onTypingStateChange)
  useEffect(() => {
    onTypingStateChangeRef.current = onTypingStateChange
  })

  const notifyTyping = useCallback((isTyping: boolean) => {
    onTypingStateChangeRef.current?.(isTyping)
  }, [])

  const armTypingDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      notifyTyping(false)
    }, TYPING_DEBOUNCE_MS)
  }, [notifyTyping])

  const handleInputBlur = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    notifyTyping(false)
  }, [notifyTyping])

  const handleInputChange = useCallback(
    (i: number, value: string) => {
      notifyTyping(true)
      armTypingDebounce()
      onWordChange(i, value)
    },
    [notifyTyping, armTypingDebounce, onWordChange],
  )

  // UX-264: when the QR scanner fails to acquire the camera (typically a
  // permission denial), auto-switch back to manual word entry and surface
  // a toast so the user understands what happened. Without this fallback
  // the user would be stuck looking at an in-scanner error.
  const handleCameraDenied = useCallback(() => {
    onEntryModeChange('manual')
    toast.info(t('pairing.cameraDeniedFallback'))
  }, [onEntryModeChange, t])

  // UX-263: Cleanup — if the form unmounts while the user is mid-typing
  // (e.g. parent closes the dialog), clear the pending debounce and tell
  // the parent typing has ended so the countdown isn't left paused.
  useEffect(
    () => () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      notifyTyping(false)
    },
    [notifyTyping],
  )

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
          {(['first', 'second', 'third', 'fourth'] as const).map((slot, i) => {
            // UX-7: ordinal labels come from i18n (`pairing.ordinal.<slot>`)
            // so they can be localized rather than hardcoded English.
            const ordinal = t(`pairing.ordinal.${slot}`)
            const inputId = `${inputIdPrefix}-pairing-word-${i}`
            return (
              // UX-263: Each word slot gets a visible ordinal Label so users
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
                  onChange={(e) => handleInputChange(i, e.target.value)}
                  onKeyDown={(e) => onWordKeyDown(i, e)}
                  onBlur={handleInputBlur}
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
              <div className="flex items-center justify-center py-8">
                <Spinner className="text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  {t('pairing.loadingScannerMessage')}
                </span>
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
