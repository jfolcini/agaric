/**
 * HelpTab — Help / Report-a-bug + Updates panel (+ updater wire-up).
 *
 * The bug-report dialog is mounted at App level (lazy) and listens for
 * `BUG_REPORT_EVENT`. This panel just exposes the trigger button and
 * forwards the click through `onReportBugClick`, which SettingsView
 * wires up to `dispatchBugReport()`. Keeping the import indirection
 * here means HelpTab does not pull `BugReportDialog` into its module
 * graph — that was the source of the INEFFECTIVE_DYNAMIC_IMPORT
 * warning that defeated App.tsx's `React.lazy` for the dialog.
 *
 * The Updates row reads the persisted last-check outcome reactively via
 * `useUpdateStatus()` (owned by `useUpdateCheck`) so it always shows state —
 * "Up to date", "Update available", "Last check failed", or "Checking…" —
 * plus a relative "last checked" time, and calls `checkForUpdatesNow()` when
 * the user clicks the manual button (which also re-surfaces the install toast
 * when an update exists). Mobile builds replace the button with a hint
 * pointing at the Play Store / App Store distribution path, since the Tauri
 * updater plugin is desktop-only.
 */

import type { TFunction } from 'i18next'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { SettingRow } from '@/components/ui/setting-row'
import { checkForUpdatesNow, useUpdateStatus } from '@/hooks/useUpdateCheck'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { isMobilePlatform } from '@/lib/platform'
import type { UpdateStatusValue } from '@/lib/preferences'

interface HelpTabProps {
  onReportBugClick: () => void
}

/**
 * Human-readable status line for the Updates row, derived from the persisted
 * `UpdateStatusValue`. Uses `t()` for every branch (no hardcoded English) so
 * the row reflects whichever outcome the boot / manual check last recorded.
 */
function updateStatusLabel(status: UpdateStatusValue, checking: boolean, t: TFunction): string {
  if (checking || status.status === 'checking') return t('help.updateCheckingLabel')
  switch (status.status) {
    case 'up-to-date': {
      return status.currentVersion != null
        ? t('help.updateUpToDateLabel', { version: status.currentVersion })
        : t('help.updateUpToDateLabelNoVersion')
    }
    case 'available': {
      return t('help.updateAvailableStatus', { version: status.availableVersion ?? '' })
    }
    case 'error': {
      return t('help.updateCheckFailedLabel', {
        error: status.error ?? t('help.updateInstallFailedToast'),
      })
    }
    default: {
      // 'idle' — nothing has been checked yet this install.
      return t('help.updateLastCheckedNever')
    }
  }
}

export function HelpTab({ onReportBugClick }: HelpTabProps): React.ReactElement {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const updateStatus = useUpdateStatus()
  const mobile = isMobilePlatform()

  const handleCheckNow = useCallback(async () => {
    setChecking(true)
    try {
      await checkForUpdatesNow()
    } finally {
      setChecking(false)
    }
  }, [])

  const busy = checking || updateStatus.status === 'checking'
  const statusLabel = updateStatusLabel(updateStatus, busy, t)
  const isError = updateStatus.status === 'error' && !busy
  const lastCheckedAt = updateStatus.lastCheckedAt
  const lastCheckedLabel =
    lastCheckedAt != null
      ? t('help.updateLastCheckedLabel', { ago: formatRelativeTime(lastCheckedAt, t) })
      : null

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-6">
          <SettingRow label={t('help.reportBugTitle')} description={t('help.reportBugDescription')}>
            <Button
              variant="outline"
              size="sm"
              onClick={onReportBugClick}
              aria-label={t('help.reportBugButton')}
            >
              {t('help.reportBugButton')}
            </Button>
          </SettingRow>
          <div className="space-y-1">
            <SettingRow label={t('help.updateTitle')} description={t('help.updateDescription')}>
              {mobile ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCheckNow}
                  disabled={busy}
                  aria-label={t('help.updateCheckNowButton')}
                >
                  {busy ? t('help.updateCheckingLabel') : t('help.updateCheckNowButton')}
                </Button>
              )}
            </SettingRow>
            {mobile ? (
              <p className="text-sm text-muted-foreground">{t('help.updateMobileHint')}</p>
            ) : (
              <>
                {/* Persistent status — `<output>` is an implicit polite live
                    region (role="status"), so a boot check completing (or
                    failing) while Settings is open is announced, not silent. */}
                <output
                  className={
                    isError
                      ? 'block text-sm text-destructive'
                      : 'block text-sm text-muted-foreground'
                  }
                >
                  {statusLabel}
                </output>
                {lastCheckedLabel != null && (
                  <p className="text-xs text-muted-foreground">{lastCheckedLabel}</p>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
