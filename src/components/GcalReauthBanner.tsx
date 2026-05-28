/**
 * GcalReauthBanner — MAINT-216 frontend listener for the
 * `gcal:reauth_required` Tauri event (PEND-24 H3 backend).
 *
 * When the Google Calendar refresh token is revoked the backend:
 *   1. Sets `gcal_settings.reauth_required = 'true'` in SQLite.
 *   2. Pauses the gcal push connector loop (every subsequent cycle is
 *      skipped until reauth completes).
 *   3. Emits a `gcal:reauth_required` Tauri event with payload
 *      `{ account_email: string | null }`.
 *
 * Before MAINT-216 the frontend never listened for this event, so the
 * user kept using the app expecting calendar sync, got nothing, and
 * had no idea why. This component closes that loop: it subscribes
 * once at the shell level and renders a compact, non-dismissable
 * top-of-app banner with a `t('gcal.reauth.reconnect')` CTA that triggers the existing
 * `begin_gcal_oauth` IPC (the same entry point the Settings → Google
 * Calendar tab uses).
 *
 * Lifecycle:
 *   - Activates on `gcal:reauth_required` (latest payload wins so a
 *     re-emit after a different account swaps the displayed email).
 *   - Clears when the user clicks Reconnect AND `begin_gcal_oauth`
 *     resolves successfully. No `gcal:reconnected` event exists, so
 *     the user's own action is the only resolution signal we have. If
 *     the OAuth call rejects we keep the banner up and surface a
 *     toast — the user can retry.
 *
 * Design notes:
 *   - Non-dismissable by design — the user MUST reconnect or accept
 *     that sync is broken. No close button.
 *   - Returns `null` when inactive so it has zero footprint until an
 *     event fires.
 *   - `role="alert"` so assistive tech announces the disconnection
 *     when it appears.
 *   - Renders inline above the sidebar/content shell (mounted in
 *     `App.tsx` between `SpaceTopStripe` and `SidebarProvider`) so it
 *     is visible on every view without overlaying content.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlertCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

const EVENT_REAUTH = 'gcal:reauth_required'

/**
 * Mirror of the Rust `ReauthRequiredPayload` shape emitted by the
 * Tauri bus (see `src-tauri/src/gcal_push/keyring_store.rs:155-167`).
 * Kept inline rather than imported from `@/lib/bindings` because the
 * payload type is not part of `tauri-specta`'s generated bindings.
 */
interface ReauthRequiredPayload {
  account_email: string | null
}

export function GcalReauthBanner(): React.ReactElement | null {
  const { t } = useTranslation()
  const [active, setActive] = useState<boolean>(false)
  const [accountEmail, setAccountEmail] = useState<string | null>(null)

  // Subscribe once at mount. Mirrors the cleanup pattern used in
  // `GoogleCalendarSettingsTab` so the cancellation race between the
  // async `listen()` resolution and an unmount mid-flight is handled
  // safely: if we unmounted before the promise resolves, run the
  // unlisten fn immediately rather than stashing it.
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void listen<ReauthRequiredPayload>(EVENT_REAUTH, (event) => {
      if (cancelled) return
      const payload = event.payload
      setAccountEmail(payload?.account_email ?? null)
      setActive(true)
    })
      .then((fn) => {
        if (cancelled) {
          fn()
        } else {
          unlisten = fn
        }
      })
      .catch((err) => {
        logger.warn('GcalReauthBanner', `failed to subscribe to ${EVENT_REAUTH}`, undefined, err)
      })

    return () => {
      cancelled = true
      if (unlisten) {
        try {
          unlisten()
        } catch (err) {
          logger.warn('GcalReauthBanner', 'unlisten threw during cleanup', undefined, err)
        }
      }
    }
  }, [])

  // Kick off the same OAuth flow the Settings → Google Calendar tab
  // uses. On success we clear the banner — there is no
  // `gcal:reconnected` event, so the user's own successful action is
  // the resolution signal. On rejection we keep the banner up so the
  // user can retry.
  const { execute: executeBeginOauth, loading: oauthInFlight } = useIpcCommand<void, void>({
    call: () => invoke('begin_gcal_oauth'),
    module: 'GcalReauthBanner',
    errorLogMessage: 'failed to begin gcal oauth from reauth banner',
    onSuccess: () => {
      setActive(false)
      setAccountEmail(null)
    },
    onError: () => {
      // User may click Reconnect repeatedly when the IPC keeps
      // rejecting; dedup so the toast updates in place rather than
      // stacking one per click.
      notify.error(t('gcal.connectFailed'), { id: 'gcal-connect-failed' })
    },
  })

  const handleReconnect = useCallback(() => {
    void executeBeginOauth()
  }, [executeBeginOauth])

  if (!active) return null

  const body =
    accountEmail !== null && accountEmail.length > 0
      ? t('gcal.reauth.body', { email: accountEmail })
      : t('gcal.reauth.bodyNoEmail')

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="gcal-reauth-banner"
      className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive-foreground"
    >
      <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{t('gcal.reauth.title')}</span>
        <span className="text-muted-foreground"> — </span>
        <span className="text-foreground">{body}</span>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={handleReconnect}
        disabled={oauthInFlight}
        aria-busy={oauthInFlight}
        data-testid="gcal-reauth-reconnect-button"
      >
        {t('gcal.reauth.reconnect')}
      </Button>
    </div>
  )
}
