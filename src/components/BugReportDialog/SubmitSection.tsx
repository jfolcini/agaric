/**
 * SubmitSection — footer-actions sub-component for {@link BugReportDialog}
 * (MAINT-Phase-3b decomposition).
 *
 * Renders the four footer buttons in the same order the original monolith
 * did:
 *
 *   Cancel | Copy report | [Download zip] | Open GitHub issue
 *
 * The `t('bugReport.downloadZip')` button is rendered only when `includeLogs`
 * is ON, and the primary `t('bugReport.openGitHubIssue')` button is disabled
 * until the confirmation
 * checkbox upstream is ticked AND metadata has resolved. All handlers come
 * from the orchestrator so the `openUrl` / `buildReportZip` IPC shapes stay
 * untouched.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

export interface SubmitSectionProps {
  /** Mirrors the parent's `t('bugReport.includeLogsLabel')` switch. */
  includeLogs: boolean
  /** Mirrors the parent's confirmation checkbox. */
  confirmed: boolean
  /** True while a submit/download flow is in flight. */
  submitting: boolean
  /** True while the initial metadata IPC is still loading. */
  loadingMetadata: boolean
  /** True while a logs-IPC is in flight (gates the Download zip button). */
  loadingLogs: boolean
  /** True when metadata has not yet resolved (disables Download zip). */
  metadataReady: boolean
  /** Length of the formatted report body — copy/submit are disabled at 0. */
  bodyLength: number

  onCancel: () => void
  onCopy: () => void
  onDownloadZip: () => void
  onSubmit: () => void
}

export function SubmitSection({
  includeLogs,
  confirmed,
  submitting,
  loadingMetadata,
  loadingLogs,
  metadataReady,
  bodyLength,
  onCancel,
  onCopy,
  onDownloadZip,
  onSubmit,
}: SubmitSectionProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
      <Button variant="outline" onClick={onCancel}>
        {t('bugReport.cancel')}
      </Button>
      <Button variant="outline" onClick={onCopy} disabled={loadingMetadata || bodyLength === 0}>
        {t('bugReport.copy')}
      </Button>
      {/* PEND-bug-report-zip-affordance: split the old "Open in
          GitHub" button into two explicit actions when logs are ON.
          The local file save and the browser navigation are now two
          distinct clicks, so the user can redo a step if the OS
          save dialog is dismissed, and the dialog no longer
          auto-closes mid-task. */}
      {includeLogs && (
        <Button
          variant="outline"
          onClick={onDownloadZip}
          disabled={submitting || loadingMetadata || loadingLogs || !metadataReady}
          aria-label={t('bugReport.downloadZip')}
          data-testid="bug-report-download-zip"
        >
          {submitting ? <Spinner /> : null}
          {t('bugReport.downloadZip')}
        </Button>
      )}
      <Button
        onClick={onSubmit}
        disabled={!confirmed || submitting || loadingMetadata || bodyLength === 0}
        aria-label={includeLogs ? t('bugReport.openGitHubIssue') : t('bugReport.openIssue')}
        data-testid="bug-report-open-github"
      >
        {submitting ? <Spinner /> : null}
        {includeLogs ? t('bugReport.openGitHubIssue') : t('bugReport.openIssue')}
      </Button>
    </>
  )
}
