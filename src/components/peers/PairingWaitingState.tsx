/**
 * PairingWaitingState -- joiner-side "waiting for the other device" state.
 *
 * #3469 — after `confirm_pairing`, the joiner's device has only armed its
 * own side of the handshake; it has no way to know whether the typed
 * passphrase was correct until the peer actually appears (TOFU-pinned on
 * first authenticated connection). This component renders that honest
 * in-between state instead of the dialog closing and claiming success it
 * cannot observe. Success/failure/timeout are resolved by the parent
 * (PairingDialog) — this component is purely presentational.
 *
 * Extracted from PairingDialog, matching the PairingQrDisplay /
 * PairingEntryForm sub-component-for-testability convention.
 *
 * #3496 — mirrors the host path's #424 sr-only countdown
 * (PairingQrDisplay.tsx) so a screen-reader user gets more than one
 * "waiting for the other device" announcement before up to five minutes of
 * silence: `waitCountdown` announces at the same key-interval cadence
 * (minute marks + the 30s mark) via `aria-live="polite"` — never
 * "assertive", which would interrupt the screen reader every tick instead
 * of queueing behind other speech.
 */

import { Loader2 } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

export interface PairingWaitingStateProps {
  /** `mm:ss` remaining before the pending-marker TTL expires, or `null` once expired/unbounded. */
  waitCountdownDisplay: string | null
  /** Raw seconds remaining, used to gate the sr-only countdown announcements (#424 parity). */
  waitCountdown: number | null
  onCancel: () => void
}

export function PairingWaitingState({
  waitCountdownDisplay,
  waitCountdown,
  onCancel,
}: PairingWaitingStateProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div
      className="pairing-waiting flex flex-col items-center gap-2 py-6 text-center"
      data-testid="pairing-waiting-state"
    >
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{t('pairing.awaitingPeerMessage')}</p>
      <p className="text-xs text-muted-foreground max-w-xs">{t('pairing.waitingDescription')}</p>
      {waitCountdownDisplay && (
        <p className="pairing-wait-countdown text-xs text-muted-foreground mt-1" aria-hidden="true">
          {t('pairing.sessionExpiresIn')} {waitCountdownDisplay}
        </p>
      )}
      {/* #424 parity (#3496) — sr-only countdown, announced at the same
          key-interval cadence as the host's QR countdown
          (PairingQrDisplay.tsx). */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {waitCountdown !== null &&
        waitCountdown > 0 &&
        (waitCountdown % 60 === 0 || waitCountdown === 30)
          ? waitCountdown >= 60
            ? t('pairing.srCountdownMinutes', { count: Math.floor(waitCountdown / 60) })
            : t('pairing.srCountdownSeconds', { count: waitCountdown })
          : ''}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={onCancel}
        className="pairing-waiting-cancel-btn mt-2 touch-target"
      >
        {t('pairing.cancelButton')}
      </Button>
    </div>
  )
}
