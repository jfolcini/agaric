/**
 * PairingQrDisplay -- QR code and passphrase display for the pairing dialog.
 *
 * Shows the QR code SVG from the backend, the passphrase text, a countdown
 * timer, and a session-expired retry button.
 *
 * Extracted from PairingDialog (#R-9).
 */

import { Copy, Pause } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'

export interface PairingQrDisplayProps {
  qrSvg: string
  passphrase: string
  countdownDisplay: string | null
  countdown: number | null
  isExpired: boolean
  error: string | null
  onRetry: () => void
  retryBtnRef: React.RefObject<HTMLButtonElement | null>
  /**
   * UX-263: When true, render an inline "Paused while typing…" indicator
   * next to the countdown so the user knows the timer isn't ticking
   * while they enter the passphrase.
   */
  pausedByTyping?: boolean
}

export function PairingQrDisplay({
  qrSvg,
  passphrase,
  countdownDisplay,
  countdown,
  isExpired,
  error,
  onRetry,
  retryBtnRef,
  pausedByTyping = false,
}: PairingQrDisplayProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col sm:flex-row [@media(pointer:coarse)]:flex-col gap-4 items-center mb-4">
      {/* #290: Use backend QR SVG instead of react-qr-code */}
      <div
        className="pairing-qr shrink-0 w-[200px] max-w-full rounded-lg border bg-white p-3 [&_svg]:w-full [&_svg]:h-auto"
        role="img"
        aria-label={t('pairing.qrCodeLabel')}
        data-testid="pairing-qr-code"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG from our own Rust backend, not user input
        dangerouslySetInnerHTML={{ __html: qrSvg }}
      />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-muted-foreground">
          {t('pairing.passphraseLabel')}
        </span>
        {/* UX-12: passphrase + inline copy button. Wrapping in a flex row
            keeps the copy affordance discoverable next to the value. */}
        <div className="flex items-center gap-2">
          <p className="pairing-passphrase text-lg font-mono font-semibold break-words">
            {passphrase}
          </p>
          <Button
            variant="ghost"
            size="icon-xs"
            className="pairing-passphrase-copy shrink-0"
            aria-label={t('pairing.copyPassphraseAriaLabel')}
            onClick={() => {
              writeText(passphrase)
                .then(() => {
                  toast.success(t('pairing.passphraseCopied'))
                })
                .catch((err: unknown) => {
                  logger.warn('PairingQrDisplay', 'failed to copy passphrase', undefined, err)
                  toast.error(t('pairing.passphraseCopyFailed'))
                })
            }}
          >
            <Copy />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{t('pairing.scanOrEnterInstruction')}</p>
        {/* #294: Countdown timer.
            UX-263: When pausedByTyping is true, append an inline indicator so
            the user understands why the timer isn't ticking.
            UX-12: bump the indicator from muted italic to foreground +
            Pause icon so it actually catches the eye while typing. */}
        {countdownDisplay && (
          <p className="pairing-countdown text-xs text-muted-foreground mt-1" aria-hidden="true">
            {t('pairing.sessionExpiresIn')} {countdownDisplay}
            {pausedByTyping && (
              <span className="pairing-countdown-paused ml-2 inline-flex items-center gap-1 text-foreground font-medium">
                <Pause className="h-3 w-3" />
                {t('pairing.countdownPaused')}
              </span>
            )}
          </p>
        )}
        {/* #424: SR-only countdown — announces at key intervals only */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {countdown !== null && countdown > 0 && (countdown % 60 === 0 || countdown === 30)
            ? `Session expires in ${
                countdown >= 60
                  ? `${Math.floor(countdown / 60)} minute${
                      Math.floor(countdown / 60) !== 1 ? 's' : ''
                    }`
                  : `${countdown} seconds`
              }`
            : ''}
        </p>
        {isExpired && !error && (
          <div className="pairing-expired flex items-center gap-2 mt-1">
            <p className="text-xs text-destructive font-medium flex-1">
              {t('pairing.sessionExpired')}
            </p>
            <Button
              variant="outline"
              size="sm"
              ref={retryBtnRef as React.RefObject<HTMLButtonElement>}
              onClick={onRetry}
              className="pairing-retry-expired-btn shrink-0"
            >
              {t('pairing.retryButton')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
