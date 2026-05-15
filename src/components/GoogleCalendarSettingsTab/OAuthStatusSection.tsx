/**
 * OAuthStatusSection — Account/OAuth surface for the Google Calendar
 * settings tab.
 *
 * Extracted from `GoogleCalendarSettingsTab.tsx` per Phase 3b of
 * `pending/design-system-maintainability-2026-05-09.md`. The component
 * is purely presentational — the orchestrator owns the OAuth IPC
 * (`begin_gcal_oauth`) and `disconnect_gcal` calls and passes the
 * resolved state + handlers as props.
 *
 * Two visual states:
 *  - Connected: shows the bound account email + a small "Disconnect"
 *    button that opens the parent's disconnect dialog.
 *  - Disconnected: shows the "Connect Google Account" CTA which
 *    triggers `onConnect`; while the IPC is in flight the button is
 *    disabled, aria-busy, and shows the spinner + waiting label.
 *
 * Data-test IDs and accessible labels are preserved exactly so the
 * existing `GoogleCalendarSettingsTab.test.tsx` suite continues to
 * pass without modification.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

export interface OAuthStatusSectionProps {
  /** True once the user has completed OAuth and tokens are stored. */
  connected: boolean
  /** Bound Google account email, when connected. */
  accountEmail: string | null
  /** True while `begin_gcal_oauth` is in flight (UX gate). */
  oauthInFlight: boolean
  /** Kick off `begin_gcal_oauth`. */
  onConnect: () => void
  /** Open the disconnect confirmation dialog (parent-owned). */
  onRequestDisconnect: () => void
}

export function OAuthStatusSection({
  connected,
  accountEmail,
  oauthInFlight,
  onConnect,
  onRequestDisconnect,
}: OAuthStatusSectionProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      <Label muted={false}>{t('gcal.accountLabel')}</Label>
      {connected && accountEmail !== null ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <code
              className="flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono break-all"
              data-testid="gcal-account-email"
            >
              {accountEmail}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRequestDisconnect}
              aria-label={t('gcal.disconnect.button')}
            >
              {t('gcal.disconnect.button')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('gcal.pushingToCalendar')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <Button
            variant="default"
            size="sm"
            onClick={onConnect}
            aria-label={t('gcal.connectButton')}
            aria-busy={oauthInFlight}
            disabled={oauthInFlight}
            data-testid="gcal-connect-button"
          >
            {oauthInFlight && <Spinner size="sm" />}
            {oauthInFlight ? t('gcal.connecting') : t('gcal.connectButton')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('gcal.connectHelp')}</p>
        </div>
      )}
    </div>
  )
}
