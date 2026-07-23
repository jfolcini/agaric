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
 * The Updates card reads the persisted last-check outcome reactively via
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { checkForUpdatesNow, useUpdateStatus } from '@/hooks/useUpdateCheck'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { GESTURE_ENTRIES } from '@/lib/gesture-coachmark'
import { isMobilePlatform } from '@/lib/platform'
import type { UpdateStatusValue } from '@/lib/preferences'

interface HelpTabProps {
  onReportBugClick: () => void
}

/**
 * Human-readable status line for the Updates card, derived from the persisted
 * `UpdateStatusValue`. Uses `t()` for every branch (no hardcoded English) so
 * the card reflects whichever outcome the boot / manual check last recorded.
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
        <CardHeader className="pb-3">
          <CardTitle>{t('help.reportBugTitle')}</CardTitle>
          <CardDescription>{t('help.reportBugDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={onReportBugClick}
            aria-label={t('help.reportBugButton')}
          >
            {t('help.reportBugButton')}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>{t('help.updateTitle')}</CardTitle>
          <CardDescription>{t('help.updateDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {mobile ? (
            <p className="text-sm text-muted-foreground">{t('help.updateMobileHint')}</p>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={handleCheckNow}
                disabled={busy}
                aria-label={t('help.updateCheckNowButton')}
              >
                {busy ? t('help.updateCheckingLabel') : t('help.updateCheckNowButton')}
              </Button>
              {/* Persistent status — `<output>` is an implicit polite live
                  region (role="status"), so a boot check completing (or
                  failing) while Settings is open is announced, not silent. */}
              <output
                className={
                  isError ? 'block text-sm text-destructive' : 'block text-sm text-muted-foreground'
                }
              >
                {statusLabel}
              </output>
              {lastCheckedLabel != null && (
                <p className="text-xs text-muted-foreground">{lastCheckedLabel}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
      {/* #1422 — persistent "Touch gestures" reference. Mirrors the
          first-run coach-mark copy (shared `GESTURE_ENTRIES` source) so
          users can re-find the hidden swipe / long-press / edge-swipe /
          quick-capture gestures after the one-time overlay is dismissed.
          Cross-platform: harmless on desktop, the discovery path on mobile. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>{t('gestures.help.title')}</CardTitle>
          <CardDescription>{t('gestures.help.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            oxlint-disable-next-line jsx-a11y/no-redundant-roles -- explicit
            role="list" is required because Safari + VoiceOver strip the
            implicit list role from a <ul> with `list-style: none`
            (Tailwind `list-none`). Matches WelcomeModal / .
          */}
          <ul role="list" className="grid list-none gap-4 pl-0">
            {GESTURE_ENTRIES.map((entry) => (
              <li key={entry.titleKey} className="flex items-start gap-3">
                <entry.icon
                  className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium">{t(entry.titleKey)}</p>
                  <p className="text-sm text-muted-foreground">{t(entry.descKey)}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
