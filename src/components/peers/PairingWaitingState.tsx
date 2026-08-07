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
 */

import { Loader2 } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

export interface PairingWaitingStateProps {
  /** `mm:ss` remaining before the pending-marker TTL expires, or `null` once expired/unbounded. */
  waitCountdownDisplay: string | null
  onCancel: () => void
}

export function PairingWaitingState({
  waitCountdownDisplay,
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
