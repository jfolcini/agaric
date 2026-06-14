/**
 * BugReportDialog — in-app bug-report surface (FEAT-5).
 *
 * Three-section dialog: a form (title, description, include-logs +
 * redact switches), a read-only Markdown preview + list of log files,
 * and a footer with Cancel / Copy report / [t('bugReport.downloadZip')] /
 * t('bugReport.openGitHubIssue'). The download-zip button only renders
 * when logs are ON; the open-issue button is gated on the confirmation
 * checkbox.
 *
 * Flow (PEND-bug-report-zip-affordance):
 *   - logs ON:  user clicks t('bugReport.downloadZip') (readLogsForReport →
 *               buildReportZip → downloadBlob → success toast naming the
 *               file), then clicks t('bugReport.openGitHubIssue') (openUrl). The
 *               dialog stays open so the user can re-download if the OS
 *               save dialog is dismissed.
 *   - logs OFF: user clicks t('bugReport.openIssue') (openUrl), dialog closes.
 *   - On IPC/JSZip failure: notify.error + logger.warn; dialog stays open.
 *
 * Errors are never swallowed silently — every `.catch` routes through
 * `logger.warn` per AGENTS.md's "no silent catch" rule.
 *
 * MAINT-Phase-3b: this file is the orchestrator only. The form, the
 * diagnostics list + preview sub-dialog, and the footer buttons live in
 * `src/components/BugReportDialog/{BugReportForm,DiagnosticsCollector,
 * SubmitSection}.tsx`. All state, IPC wiring, and side effects stay
 * here so the focus-trap behaviour and Tauri-command shapes are
 * unchanged.
 */

import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BugReportForm } from '@/components/dialogs/BugReportDialog/BugReportForm'
import { DiagnosticsCollector } from '@/components/dialogs/BugReportDialog/DiagnosticsCollector'
import { SubmitSection } from '@/components/dialogs/BugReportDialog/SubmitSection'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogBody } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SheetBody } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { buildGitHubIssueUrl, formatReportBody } from '@/lib/bug-report'
import { bugReportZipFilename, buildReportZip } from '@/lib/bug-report-zip'
import { writeText } from '@/lib/clipboard'
import { BUG_TRACKER } from '@/lib/config'
import { downloadBlob } from '@/lib/export-graph'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { openUrl } from '@/lib/open-url'
import type { BugReport, LogFileEntry } from '@/lib/tauri'
import { collectBugReportMetadata, readLogsForReport } from '@/lib/tauri'

interface BugReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional initial title (e.g. the error message when opened from the crash screen). */
  initialTitle?: string
  /** Optional initial description (e.g. the stack trace when opened from the crash screen). */
  initialDescription?: string
}

const MODULE = 'BugReportDialog'

export function BugReportDialog({
  open,
  onOpenChange,
  initialTitle,
  initialDescription,
}: BugReportDialogProps): React.ReactElement {
  const { t } = useTranslation()

  const [title, setTitle] = useState<string>(initialTitle ?? '')
  const [description, setDescription] = useState<string>(initialDescription ?? '')
  const [includeLogs, setIncludeLogs] = useState<boolean>(false)
  const [redact, setRedact] = useState<boolean>(true)
  const [confirmed, setConfirmed] = useState<boolean>(false)

  const [metadata, setMetadata] = useState<BugReport | null>(null)
  const [logs, setLogs] = useState<LogFileEntry[]>([])
  const [loadingMetadata, setLoadingMetadata] = useState<boolean>(false)
  const [loadingLogs, setLoadingLogs] = useState<boolean>(false)
  const [submitting, setSubmitting] = useState<boolean>(false)

  // UX-277: per-log preview sub-dialog state. Falls back to a fresh
  // `readLogsForReport(redact)` call per click so loading + error UX is
  // observable; H-9c will eventually replace this with a server-rendered
  // redacted bundle. UX-12: `showFullLog` toggles the truncated preview.
  const [previewOpen, setPreviewOpen] = useState<boolean>(false)
  const [previewFilename, setPreviewFilename] = useState<string | null>(null)
  const [previewContents, setPreviewContents] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState<boolean>(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [showFullLog, setShowFullLog] = useState<boolean>(false)

  // MAINT-120: collect metadata via the shared useIpcCommand hook. The
  // `setLoadingMetadata` flag stays external because it's tied to the
  // open/close lifecycle rather than the IPC itself.
  const { execute: executeCollectMetadata } = useIpcCommand<void, BugReport>({
    call: () => collectBugReportMetadata(),
    module: MODULE,
    errorLogMessage: 'failed to collect metadata',
    logLevel: 'warn',
    onSuccess: (md) => {
      setMetadata(md)
    },
    onError: () => {
      notify.error(t('bugReport.loadMetadataFailed'))
    },
  })

  // Reset form when re-opening, and load metadata lazily on open.
  useEffect(() => {
    if (!open) return
    setTitle(initialTitle ?? '')
    setDescription(initialDescription ?? '')
    setIncludeLogs(false)
    setRedact(true)
    setConfirmed(false)
    setLogs([])
    setPreviewOpen(false)
    setPreviewFilename(null)
    setPreviewContents(null)
    setPreviewError(null)
    setPreviewLoading(false)

    setLoadingMetadata(true)
    void executeCollectMetadata().finally(() => {
      setLoadingMetadata(false)
    })
  }, [open, initialTitle, initialDescription, executeCollectMetadata])

  // Reload logs whenever the user toggles either switch while the dialog
  // is open. When the outer switch is off, we clear the list.
  useEffect(() => {
    if (!open) return
    if (!includeLogs) {
      setLogs([])
      return
    }

    let cancelled = false
    setLoadingLogs(true)
    readLogsForReport(redact)
      .then((entries) => {
        if (!cancelled) setLogs(entries)
      })
      .catch((err: unknown) => {
        logger.warn(MODULE, 'failed to read logs', { redact }, err)
        notify.error(t('bugReport.readLogsFailed'))
        if (!cancelled) setLogs([])
      })
      .finally(() => {
        if (!cancelled) setLoadingLogs(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, includeLogs, redact, t])

  const zipFileName = useMemo(() => bugReportZipFilename(), [])

  const body = useMemo<string>(() => {
    if (metadata == null) return ''
    return formatReportBody({
      metadata,
      description,
      zipFileName: includeLogs ? zipFileName : undefined,
    })
  }, [metadata, description, includeLogs, zipFileName])

  const issueUrl = useMemo<string>(() => {
    return buildGitHubIssueUrl({
      owner: BUG_TRACKER.owner,
      repo: BUG_TRACKER.repo,
      title: title.trim().length > 0 ? title : t('bugReport.title'),
      body,
    })
  }, [title, body, t])

  // MAINT-120: copy the formatted report body. The navigator-availability
  // guard stays in the wrapper because it short-circuits BEFORE the IPC.
  const { execute: executeCopy } = useIpcCommand<void, void>({
    call: () => writeText(body),
    module: MODULE,
    errorLogMessage: 'clipboard write failed',
    logLevel: 'warn',
    onSuccess: () => {
      notify.success(t('bugReport.copied'))
    },
    onError: () => {
      notify.error(t('bugReport.copyFailed'))
    },
  })

  const handleCopy = useCallback(async () => {
    if (typeof navigator === 'undefined' || navigator.clipboard == null) {
      notify.error(t('bugReport.copyFailed'))
      return
    }
    await executeCopy()
  }, [executeCopy, t])

  // MAINT-120: build + download the diagnostic-logs ZIP. Returns `true`
  // on success so callers can branch on it (vs `undefined` on error).
  const { execute: executeBuildZip } = useIpcCommand<
    { redact: boolean; metadata: BugReport },
    true
  >({
    call: async ({ redact: r, metadata: md }) => {
      const entries = await readLogsForReport(r)
      // #840: thread the redact toggle into the ZIP composer so metadata.json
      // scrubs device_id to the same sentinel the logs use when redaction is on.
      const blob = await buildReportZip(entries, md, r)
      downloadBlob(blob, zipFileName)
      return true
    },
    module: MODULE,
    errorLogMessage: 'failed to build/download ZIP',
    errorLogContext: ({ redact: r }) => ({ redact: r }),
    logLevel: 'warn',
    onError: () => {
      notify.error(t('bugReport.buildZipFailed'))
    },
  })

  // PEND-bug-report-zip-affordance: t('bugReport.downloadZip') footer handler.
  // readLogsForReport → buildReportZip → downloadBlob, then a toast
  // naming the saved file. The dialog stays open so the user can then
  // click t('bugReport.openGitHubIssue') and drag the file in.
  const handleDownloadZip = useCallback(async () => {
    if (submitting) return
    if (metadata == null) return
    setSubmitting(true)
    try {
      const ok = await executeBuildZip({ redact, metadata })
      if (ok === undefined) return
      notify.success(t('bugReport.zipDownloaded', { fileName: zipFileName }))
    } finally {
      setSubmitting(false)
    }
  }, [submitting, metadata, redact, executeBuildZip, zipFileName, t])

  const handleSubmit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      // PEND-bug-report-zip-affordance: handleSubmit only opens the GitHub
      // URL — the zip download happens via the dedicated footer button.
      // MAINT-177: openUrl resolves false when the Tauri shell errored AND
      // window.open was popup-blocked / null. In that case neither path
      // actually opened a tab, so we must NOT claim success — surface an
      // error toast, copy the issue URL as a manual escape hatch, and
      // leave the dialog open so the user can retry.
      const opened = await openUrl(issueUrl)
      if (!opened) {
        let copied = false
        if (typeof navigator !== 'undefined' && navigator.clipboard != null) {
          try {
            await navigator.clipboard.writeText(issueUrl)
            copied = true
          } catch (err) {
            logger.warn(MODULE, 'clipboard fallback failed', undefined, err)
          }
        }
        notify.error(
          t(copied ? 'bugReport.browserOpenFailed' : 'bugReport.browserOpenFailedNoClipboard'),
        )
        return
      }
      notify.success(t('bugReport.submitted'))
      // PEND-bug-report-zip-affordance: with logs ON, stay open so the
      // user can re-trigger Download zip if needed. With logs OFF there
      // is no follow-up step, so close.
      if (!includeLogs) {
        onOpenChange(false)
      }
    } finally {
      setSubmitting(false)
    }
  }, [submitting, includeLogs, issueUrl, onOpenChange, t])

  // MAINT-120: re-fetch logs and surface one entry inline for preview.
  // `setPreviewLoading` toggles outside the hook because it gates
  // aria-busy on the sub-dialog.
  const { execute: executePreview } = useIpcCommand<{ filename: string; redact: boolean }, string>({
    call: async ({ filename, redact: r }) => {
      const entries = await readLogsForReport(r)
      const entry = entries.find((e) => e.name === filename)
      if (entry == null) {
        throw new Error(`log entry not found: ${filename}`)
      }
      return entry.contents
    },
    module: MODULE,
    errorLogMessage: 'failed to read log for preview',
    errorLogContext: ({ filename, redact: r }) => ({ filename, redact: r }),
    onSuccess: (contents) => {
      setPreviewContents(contents)
    },
    onError: () => {
      setPreviewError(t('bugReport.previewError'))
    },
  })

  const handleOpenPreview = useCallback(
    async (filename: string) => {
      setPreviewFilename(filename)
      setPreviewContents(null)
      setPreviewError(null)
      setPreviewLoading(true)
      setPreviewOpen(true)
      await executePreview({ filename, redact })
      setPreviewLoading(false)
    },
    [executePreview, redact],
  )

  const handlePreviewOpenChange = useCallback((next: boolean) => {
    setPreviewOpen(next)
    if (!next) {
      setPreviewFilename(null)
      setPreviewContents(null)
      setPreviewError(null)
      setPreviewLoading(false)
      setShowFullLog(false)
    }
  }, [])

  const previewSectionId = 'bug-report-preview'

  // MAINT-215: on phones < 768 px render as a bottom Sheet — `'dialog'`
  // kind keeps regular Dialog parts on desktop.
  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title, Description, Footer } = parts
  const contentSideProps = parts.isMobile ? ({ side: 'bottom' } as const) : {}
  const Body = parts.isMobile ? SheetBody : DialogBody

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      {/* PEND-28b: Dialog primitive bakes in flex flex-col + pinned
          header/footer + a scrollable DialogBody slot. */}
      <Content className="max-w-2xl" {...contentSideProps}>
        <Header>
          <Title>{t('bugReport.title')}</Title>
          <Description>{t('bugReport.description')}</Description>
        </Header>

        <Body data-testid="bug-report-body">
          {/* Form */}
          <BugReportForm
            title={title}
            description={description}
            includeLogs={includeLogs}
            redact={redact}
            onTitleChange={setTitle}
            onDescriptionChange={setDescription}
            onIncludeLogsChange={setIncludeLogs}
            onRedactChange={setRedact}
          />

          {/* Preview */}
          <div className="space-y-1.5">
            <Label htmlFor={previewSectionId} muted={false}>
              {t('bugReport.previewTitle')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('bugReport.previewHint')}</p>
            <ScrollArea className="max-h-56 rounded-md border bg-muted/30" viewportClassName="p-3">
              <pre
                id={previewSectionId}
                data-testid="bug-report-preview"
                className="text-xs leading-5 whitespace-pre-wrap break-words font-mono"
              >
                {loadingMetadata ? <Spinner /> : body}
              </pre>
            </ScrollArea>
          </div>

          {/* Diagnostics: logs list + zip hint + per-log preview sub-dialog. */}
          <DiagnosticsCollector
            includeLogs={includeLogs}
            logs={logs}
            loadingLogs={loadingLogs}
            zipFileName={zipFileName}
            onOpenPreview={(filename) => {
              void handleOpenPreview(filename)
            }}
            previewOpen={previewOpen}
            previewFilename={previewFilename}
            previewContents={previewContents}
            previewLoading={previewLoading}
            previewError={previewError}
            showFullLog={showFullLog}
            onPreviewOpenChange={handlePreviewOpenChange}
            onToggleShowFullLog={() => setShowFullLog((s) => !s)}
          />

          {/* Confirmation */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="bug-report-confirm"
              checked={confirmed}
              onCheckedChange={(v) => {
                if (typeof v === 'boolean') setConfirmed(v)
              }}
              // UX-12: aria-required surfaces the required state to AT.
              aria-required="true"
            />
            <Label htmlFor="bug-report-confirm" muted={false}>
              {t('bugReport.confirmCheckbox')}
              {/* UX-12: visual asterisk; aria-hidden because the checkbox
                  itself announces the required state via aria-required. */}
              <span
                aria-hidden="true"
                className="ml-1 text-destructive"
                data-testid="bug-report-confirm-required-marker"
              >
                *
              </span>
            </Label>
          </div>
        </Body>

        <Footer>
          <SubmitSection
            includeLogs={includeLogs}
            confirmed={confirmed}
            submitting={submitting}
            loadingMetadata={loadingMetadata}
            loadingLogs={loadingLogs}
            metadataReady={metadata != null}
            bodyLength={body.length}
            onCancel={() => onOpenChange(false)}
            onCopy={() => {
              void handleCopy()
            }}
            onDownloadZip={() => {
              void handleDownloadZip()
            }}
            onSubmit={() => {
              void handleSubmit()
            }}
          />
        </Footer>
      </Content>
    </Root>
  )
}
