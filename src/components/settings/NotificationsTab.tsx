/**
 * NotificationsTab — OS notification settings (Settings slice).
 *
 * Reminders (#4554): the desktop backend fires one OS notification per open
 * task on its due date, at the reminder time chosen here, while the app is
 * running. Both preferences are device-local and live in the backend's
 * `app_settings` (`commands.getReminderSettings` / `setReminderSettings`),
 * because the maintenance job that fires them reads them without the webview.
 *
 * Affordances:
 *  - "Remind me about due tasks" — the master switch; off means nothing fires.
 *  - "Reminder time" — local wall-clock `HH:MM`.
 *  - "Request permission" — wires {@link ensureNotificationPermission};
 *    on Android 13+ this prompts for `POST_NOTIFICATIONS`, on desktop it
 *    resolves once the capability is granted.
 *  - "Send test notification" — gated on the switch; first ensures the
 *    permission, then fires a sample notification via
 *    {@link commands.notifyTask}.
 *
 * Every IPC / plugin call has an error-path fallback per AGENTS.md
 * §Testing Conventions — log + toast, never throw out of a handler.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ToggleRow } from '@/components/ui/toggle-row'
import { unwrap } from '@/lib/app-error'
import type { ReminderSettings } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { ensureNotificationPermission } from '@/lib/platform/notifications'

/** Mirrors `ReminderSettings::default()` in `src-tauri/src/reminders.rs`. */
const DEFAULT_SETTINGS: ReminderSettings = { enabled: false, time: '09:00' }

/** A `<input type="time">` reports `''` while incomplete; save only whole values. */
const HH_MM = /^\d{2}:\d{2}$/

export function NotificationsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_SETTINGS)
  const [requesting, setRequesting] = useState<boolean>(false)
  const [testing, setTesting] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = unwrap(await commands.getReminderSettings())
        if (!cancelled) setSettings(loaded)
      } catch (err) {
        logger.warn('NotificationsTab', 'loading reminder settings failed', undefined, err)
        notify.error(t('notifications.settingsLoadFailed'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [t])

  const save = useCallback(
    async (next: ReminderSettings) => {
      const previous = settings
      setSettings(next)
      try {
        unwrap(await commands.setReminderSettings(next))
      } catch (err) {
        logger.warn('NotificationsTab', 'saving reminder settings failed', undefined, err)
        notify.error(t('notifications.settingsSaveFailed'))
        setSettings(previous)
      }
    },
    [settings, t],
  )

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
      unwrap(
        await commands.notifyTask({
          title: t('notifications.testTitle'),
          body: t('notifications.testBody'),
        }),
      )
      notify.success(t('notifications.testSent'))
    } catch (err) {
      logger.warn('NotificationsTab', 'test notification failed', undefined, err)
      notify.error(t('notifications.testFailed'))
    } finally {
      setTesting(false)
    }
  }, [t])

  const { enabled, time } = settings

  return (
    <div className="notifications-tab space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>{t('notifications.title')}</CardTitle>
          <CardDescription>{t('notifications.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ToggleRow
            id="notifications-enabled"
            label={t('notifications.enableLabel')}
            description={t('notifications.enableDescription')}
            checked={enabled}
            onCheckedChange={(checked) => void save({ enabled: checked, time })}
            data-testid="notifications-enabled-switch"
          />

          <div className="space-y-2">
            <Label htmlFor="notifications-reminder-time" muted={false}>
              {t('notifications.reminderTimeLabel')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('notifications.reminderTimeDescription')}
            </p>
            <Input
              id="notifications-reminder-time"
              type="time"
              value={time}
              disabled={!enabled}
              onChange={(e) => {
                const next = e.target.value
                if (HH_MM.test(next)) void save({ enabled, time: next })
              }}
              className="w-32"
              data-testid="notifications-reminder-time"
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
