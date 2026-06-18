/**
 * HelpTab — Help / Report-a-bug + Updates panel (FEAT-5 + updater wire-up).
 *
 * The bug-report dialog is mounted at App level (lazy) and listens for
 * `BUG_REPORT_EVENT`. This panel just exposes the trigger button and
 * forwards the click through `onReportBugClick`, which SettingsView
 * wires up to `dispatchBugReport()`. Keeping the import indirection
 * here means HelpTab does not pull `BugReportDialog` into its module
 * graph — that was the source of the INEFFECTIVE_DYNAMIC_IMPORT
 * warning that defeated App.tsx's `React.lazy` for the dialog.
 *
 * The Updates card is self-contained — it reads the last-check
 * timestamp from `localStorage` (key managed by `useUpdateCheck`) and
 * calls `checkForUpdatesNow()` when the user clicks the manual button.
 * Mobile builds replace the button with a hint pointing at the Play
 * Store / App Store distribution path, since the Tauri updater plugin
 * is desktop-only.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { checkForUpdatesNow, LAST_UPDATE_CHECK_STORAGE_KEY } from '@/hooks/useUpdateCheck'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { GESTURE_ENTRIES } from '@/lib/gesture-coachmark'
import { isMobilePlatform } from '@/lib/platform'

interface HelpTabProps {
  onReportBugClick: () => void
}

function readLastCheckIso(): string | null {
  try {
    return typeof localStorage !== 'undefined'
      ? localStorage.getItem(LAST_UPDATE_CHECK_STORAGE_KEY)
      : null
  } catch {
    return null
  }
}

export function HelpTab({ onReportBugClick }: HelpTabProps): React.ReactElement {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [lastCheckedIso, setLastCheckedIso] = useState<string | null>(() => readLastCheckIso())
  const mobile = isMobilePlatform()

  // Re-read the timestamp on storage events so a manual check (which
  // writes from inside `useUpdateCheck`) refreshes the displayed label
  // immediately, even though `localStorage.setItem` doesn't fire a
  // storage event in the same tab — we set the state ourselves on
  // success, and the listener covers the cross-tab case.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== LAST_UPDATE_CHECK_STORAGE_KEY) return
      setLastCheckedIso(readLastCheckIso())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const handleCheckNow = useCallback(async () => {
    setChecking(true)
    try {
      await checkForUpdatesNow()
    } finally {
      setChecking(false)
      setLastCheckedIso(readLastCheckIso())
    }
  }, [])

  const lastCheckedLabel =
    lastCheckedIso != null
      ? t('help.updateLastCheckedLabel', { ago: formatRelativeTime(lastCheckedIso, t) })
      : t('help.updateLastCheckedNever')

  return (
    <div className="space-y-4 max-w-xl">
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
                disabled={checking}
                aria-label={t('help.updateCheckNowButton')}
              >
                {checking ? t('help.updateCheckingLabel') : t('help.updateCheckNowButton')}
              </Button>
              <p className="text-xs text-muted-foreground">{lastCheckedLabel}</p>
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
            (Tailwind `list-none`). Matches WelcomeModal / UX-278.
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
