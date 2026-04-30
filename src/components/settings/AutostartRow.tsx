/**
 * AutostartRow — "Launch on login" toggle inside the General settings tab (FEAT-13).
 *
 * Three-state: `null` (loading or unavailable → row hidden), `true`
 * (toggle on), `false` (toggle off).  The unavailable case folds into
 * `null` because the only signal we have for "plugin not available"
 * is the rejection of `isAutostartEnabled()` (mobile build, browser
 * dev fallback, IPC denied).  Hiding the row in those cases matches
 * the spec — Android / iOS handle start-at-boot via the OS task
 * model, not this toggle.
 *
 * Toggle handler is optimistic-update + revert-on-failure, with a
 * single `toast.error(t('settings.autostart.toggleFailed'))` as the
 * user-visible failure surface.  `logger.error` carries the cause
 * chain for the daily-rolling backend log.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { logger } from '@/lib/logger'
import { disableAutostart, enableAutostart, isAutostartEnabled } from '@/lib/tauri'

export function AutostartRow(): React.ReactElement | null {
  const { t } = useTranslation()
  // `null` = either still resolving the initial state, or the plugin
  // is unavailable on this platform (mobile / browser-dev). Either
  // way the row is hidden — the user can't toggle something we can't
  // talk to.
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)

  // Resolve the initial state on mount. Any rejection (mobile, IPC
  // denied, plugin missing) collapses into the "unavailable" branch
  // so the row stays hidden.
  useEffect(() => {
    let cancelled = false
    isAutostartEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value)
      })
      .catch((err) => {
        if (cancelled) return
        // Not an error from the user's perspective — this is the
        // mobile / browser-dev path where the plugin is unregistered
        // and `isEnabled()` rejects. Log at warn level (with cause)
        // so a real desktop IPC failure still lands in the daily log,
        // and hide the row either way.
        logger.warn(
          'SettingsView',
          'autostart plugin unavailable; hiding launch-on-login row',
          undefined,
          err,
        )
        setEnabled(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = useCallback(
    async (next: boolean) => {
      // Optimistic update — the Switch flips immediately. If the IPC
      // round-trip rejects we revert and toast the failure so the
      // visible state never lies about the underlying setting.
      const previous = enabled
      setEnabled(next)
      setPending(true)
      try {
        if (next) {
          await enableAutostart()
        } else {
          await disableAutostart()
        }
      } catch (err) {
        logger.error('SettingsView', 'failed to update autostart setting', { requested: next }, err)
        setEnabled(previous)
        toast.error(t('settings.autostart.toggleFailed'))
      } finally {
        setPending(false)
      }
    },
    [enabled, t],
  )

  // Hide entirely on mobile / browser-dev where the plugin is
  // unavailable — matches the FEAT-13 "Desktop only" requirement
  // without needing a separate platform-detection helper.
  if (enabled === null) return null

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 space-y-1">
        <Label htmlFor="autostart-toggle" muted={false}>
          {t('settings.autostart.label')}
        </Label>
        <p className="text-xs text-muted-foreground">{t('settings.autostart.description')}</p>
      </div>
      <Switch
        id="autostart-toggle"
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={pending}
        aria-label={t('settings.autostart.label')}
      />
    </div>
  )
}
