/**
 * NotificationsTab — OS notification settings (FEAT-11, Settings slice).
 *
 * A bounded, shippable slice of the larger notification feature (#138):
 * an enable/disable preference plus permission + test affordances. The
 * scheduler, the dedupe ledger ("don't re-fire on materialize replay"),
 * and snooze are explicitly out of scope here and tracked on #138.
 *
 * State:
 *  - `enabled` — persisted via {@link useLocalStoragePreference} under
 *    `agaric-notifications-enabled` (the existing localStorage preference
 *    mechanism shared with the agenda / deadline-warning settings).
 *
 * Affordances:
 *  - "Request permission" — wires {@link ensureNotificationPermission};
 *    on Android 13+ this prompts for `POST_NOTIFICATIONS`, on desktop it
 *    resolves once the capability is granted.
 *  - "Send test notification" — gated on the toggle; first ensures the
 *    permission, then fires a sample notification via {@link notifyTask}.
 *
 * Every IPC / plugin call has an error-path fallback per AGENTS.md
 * §Testing Conventions — log + toast, never throw out of a handler.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { ensureNotificationPermission, notifyTask } from '@/lib/tauri'

const ENABLED_KEY = 'agaric-notifications-enabled'

export function NotificationsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useLocalStoragePreference<boolean>(ENABLED_KEY, false, {
    source: 'NotificationsTab',
  })
  const [requesting, setRequesting] = useState<boolean>(false)
  const [testing, setTesting] = useState<boolean>(false)

  const handleRequestPermission = useCallback(async () => {
    setRequesting(true)
    try {
      const granted = await ensureNotificationPermission()
      if (granted) {
        notify.success(t('notifications.permissionGranted'))
      } else {
        notify.error(t('notifications.permissionDenied'))
      }
    } catch (err) {
      logger.warn('NotificationsTab', 'permission request failed', undefined, err)
      notify.error(t('notifications.permissionDenied'))
    } finally {
      setRequesting(false)
    }
  }, [t])

  const handleSendTest = useCallback(async () => {
    setTesting(true)
    try {
      const granted = await ensureNotificationPermission()
      if (!granted) {
        notify.error(t('notifications.permissionDenied'))
        return
      }
      await notifyTask({
        title: t('notifications.testTitle'),
        body: t('notifications.testBody'),
      })
      notify.success(t('notifications.testSent'))
    } catch (err) {
      logger.warn('NotificationsTab', 'test notification failed', undefined, err)
      notify.error(t('notifications.testFailed'))
    } finally {
      setTesting(false)
    }
  }, [t])

  return (
    <div className="notifications-tab space-y-4 max-w-xl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('notifications.title')}</CardTitle>
          <CardDescription>{t('notifications.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enable / disable preference */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="notifications-enabled" muted={false}>
                {t('notifications.enableLabel')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('notifications.enableDescription')}
              </p>
            </div>
            <Switch
              id="notifications-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t('notifications.enableLabel')}
              data-testid="notifications-enabled-switch"
            />
          </div>

          {/* Permission + test affordances */}
          <div className="space-y-2">
            <Label muted={false}>{t('notifications.permissionLabel')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('notifications.permissionDescription')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleRequestPermission()}
                disabled={requesting}
                aria-busy={requesting}
                data-testid="notifications-request-permission-button"
              >
                {requesting && <Spinner size="sm" />}
                {t('notifications.requestPermissionButton')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSendTest()}
                disabled={!enabled || testing}
                aria-busy={testing}
                data-testid="notifications-send-test-button"
              >
                {testing && <Spinner size="sm" />}
                {t('notifications.sendTestButton')}
              </Button>
            </div>
            {!enabled && (
              <p className="text-xs text-muted-foreground" role="note">
                {t('notifications.testDisabledHint')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
