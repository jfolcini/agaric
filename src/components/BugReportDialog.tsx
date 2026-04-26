/**
 * BugReportDialog — in-app bug-report surface (FEAT-5).
 *
 * Three-section dialog:
 *   1. Form — title, description, "include diagnostic logs" switch (default
 *      OFF), nested "redact file paths and device ID" switch (default ON,
 *      visible only when logs-on).
 *   2. Preview — scrollable, read-only Markdown body + list of log files
 *      that will be packaged in the ZIP.
 *   3. Footer — Cancel / Copy report / Open in GitHub. The primary button
 *      is disabled until the user ticks the "I've reviewed what will be
 *      shared" checkbox.
 *
 * Flow on primary click:
 *   - If logs ON:  readLogsForReport(redact) → buildReportZip → downloadBlob → openUrl
 *   - If logs OFF: openUrl directly
 *   - On IPC/JSZip failure: toast.error + logger.warn; dialog stays open.
 *
 * Errors are never swallowed silently — every `.catch` routes through
 * `logger.warn` per AGENTS.md's "no silent catch" rule.
 */

import { Eye } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { buildGitHubIssueUrl, formatReportBody } from '@/lib/bug-report'
import { bugReportZipFilename, buildReportZip } from '@/lib/bug-report-zip'
import { writeText } from '@/lib/clipboard'
import { BUG_TRACKER } from '@/lib/config'
import { downloadBlob } from '@/lib/export-graph'
import { logger } from '@/lib/logger'
import { openUrl } from '@/lib/open-url'
import type { BugReport, LogFileEntry } from '@/lib/tauri'
import { collectBugReportMetadata, readLogsForReport } from '@/lib/tauri'
import { cn } from '@/lib/utils'

/** Maximum chars rendered in the per-log preview sub-dialog. */
const PREVIEW_MAX_CHARS = 500

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

  // Per-log preview sub-dialog state. UX-277: lets the user inspect log
  // contents before the report leaves the device. Falls back to a fresh
  // `readLogsForReport(redact)` call per click so loading + error UX is
  // observable; H-9c (`bug_report_preview` IPC) will eventually replace
  // this with a server-rendered redacted bundle.
  const [previewOpen, setPreviewOpen] = useState<boolean>(false)
  const [previewFilename, setPreviewFilename] = useState<string | null>(null)
  const [previewContents, setPreviewContents] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState<boolean>(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

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
    collectBugReportMetadata()
      .then((md) => {
        setMetadata(md)
      })
      .catch((err: unknown) => {
        logger.warn(MODULE, 'failed to collect metadata', undefined, err)
        toast.error(t('bugReport.loadMetadataFailed'))
      })
      .finally(() => {
        setLoadingMetadata(false)
      })
  }, [open, initialTitle, initialDescription, t])

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
        toast.error(t('bugReport.readLogsFailed'))
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

  const handleCopy = useCallback(async () => {
    try {
      if (typeof navigator === 'undefined' || navigator.clipboard == null) {
        toast.error(t('bugReport.copyFailed'))
        return
      }
      await writeText(body)
      toast.success(t('bugReport.copied'))
    } catch (err) {
      logger.warn(MODULE, 'clipboard write failed', undefined, err)
      toast.error(t('bugReport.copyFailed'))
    }
  }, [body, t])

  const handleSubmit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      if (includeLogs && metadata != null) {
        // Logs on → build a ZIP, save to disk, then open the GitHub URL
        // with a body that points at the saved filename.
        try {
          const entries = await readLogsForReport(redact)
          const blob = await buildReportZip(entries, metadata)
          downloadBlob(blob, zipFileName)
        } catch (err) {
          logger.warn(MODULE, 'failed to build/download ZIP', { redact }, err)
          toast.error(t('bugReport.buildZipFailed'))
          return
        }
      }
      await openUrl(issueUrl)
      toast.success(t('bugReport.submitted'))
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }, [submitting, includeLogs, metadata, redact, zipFileName, issueUrl, onOpenChange, t])

  const handleOpenPreview = useCallback(
    async (filename: string) => {
      setPreviewFilename(filename)
      setPreviewContents(null)
      setPreviewError(null)
      setPreviewLoading(true)
      setPreviewOpen(true)
      try {
        const entries = await readLogsForReport(redact)
        const entry = entries.find((e) => e.name === filename)
        if (entry == null) {
          throw new Error(`log entry not found: ${filename}`)
        }
        setPreviewContents(entry.contents)
      } catch (err) {
        logger.error(MODULE, 'failed to read log for preview', { filename, redact }, err)
        setPreviewError(t('bugReport.previewError'))
      } finally {
        setPreviewLoading(false)
      }
    },
    [redact, t],
  )

  const handlePreviewOpenChange = useCallback((next: boolean) => {
    setPreviewOpen(next)
    if (!next) {
      setPreviewFilename(null)
      setPreviewContents(null)
      setPreviewError(null)
      setPreviewLoading(false)
    }
  }, [])

  const logsSectionId = 'bug-report-logs-list'
  const previewSectionId = 'bug-report-preview'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('bugReport.title')}</DialogTitle>
          <DialogDescription>{t('bugReport.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Form */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bug-report-title" muted={false}>
                {t('bugReport.fieldTitleLabel')}
              </Label>
              <Input
                id="bug-report-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('bugReport.fieldTitlePlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bug-report-description" muted={false}>
                {t('bugReport.fieldDescriptionLabel')}
              </Label>
              <Textarea
                id="bug-report-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('bugReport.fieldDescriptionPlaceholder')}
                rows={5}
              />
            </div>

            <div className="flex items-start gap-3">
              <Switch
                id="bug-report-include-logs"
                checked={includeLogs}
                onCheckedChange={setIncludeLogs}
                aria-label={t('bugReport.includeLogsLabel')}
              />
              <div className="space-y-0.5">
                <Label htmlFor="bug-report-include-logs" muted={false}>
                  {t('bugReport.includeLogsLabel')}
                </Label>
                <p className="text-xs text-muted-foreground">{t('bugReport.includeLogsHint')}</p>
              </div>
            </div>

            {includeLogs && (
              <div className="flex items-start gap-3 pl-6">
                <Switch
                  id="bug-report-redact"
                  checked={redact}
                  onCheckedChange={setRedact}
                  aria-label={t('bugReport.redactLabel')}
                />
                <div className="space-y-0.5">
                  <Label htmlFor="bug-report-redact" muted={false}>
                    {t('bugReport.redactLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t('bugReport.redactHint')}</p>
                </div>
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="space-y-1.5">
            <Label htmlFor={previewSectionId} muted={false}>
              {t('bugReport.previewTitle')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('bugReport.previewHint')}</p>
            <ScrollArea className="h-56 rounded-md border bg-muted/30" viewportClassName="p-3">
              <pre
                id={previewSectionId}
                data-testid="bug-report-preview"
                className="text-xs leading-5 whitespace-pre-wrap break-words font-mono"
              >
                {loadingMetadata ? <Spinner /> : body}
              </pre>
            </ScrollArea>
          </div>

          {/* Logs list (only when logs ON) */}
          {includeLogs && (
            <div className="space-y-1.5">
              <Label htmlFor={logsSectionId} muted={false}>
                {t('bugReport.logsListTitle')}
              </Label>
              <ScrollArea className="h-32 rounded-md border bg-muted/30" viewportClassName="p-3">
                <ul
                  id={logsSectionId}
                  data-testid="bug-report-logs-list"
                  className="text-xs space-y-1"
                >
                  {loadingLogs && (
                    <li className="flex items-center gap-2 text-muted-foreground">
                      <Spinner />
                    </li>
                  )}
                  {!loadingLogs && logs.length === 0 && (
                    <li className="text-muted-foreground italic">{t('bugReport.logsListEmpty')}</li>
                  )}
                  {!loadingLogs &&
                    logs.map((entry) => (
                      <li key={entry.name} className="flex items-center justify-between gap-3">
                        <span className="font-mono break-all flex-1 min-w-0">{entry.name}</span>
                        <span className="text-muted-foreground shrink-0">
                          {t('bugReport.logsSize', { size: entry.contents.length })}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('bugReport.previewLabel', { filename: entry.name })}
                          onClick={() => {
                            void handleOpenPreview(entry.name)
                          }}
                        >
                          <Eye />
                        </Button>
                      </li>
                    ))}
                </ul>
              </ScrollArea>
            </div>
          )}

          {/* Confirmation */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="bug-report-confirm"
              checked={confirmed}
              onCheckedChange={(v) => {
                if (typeof v === 'boolean') setConfirmed(v)
              }}
            />
            <Label htmlFor="bug-report-confirm" muted={false}>
              {t('bugReport.confirmCheckbox')}
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('bugReport.cancel')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              void handleCopy()
            }}
            disabled={loadingMetadata || body.length === 0}
          >
            {t('bugReport.copy')}
          </Button>
          <Button
            onClick={() => {
              void handleSubmit()
            }}
            disabled={!confirmed || submitting || loadingMetadata || body.length === 0}
            aria-label={t('bugReport.openIssue')}
          >
            {submitting ? <Spinner /> : null}
            {t('bugReport.openIssue')}
          </Button>
        </DialogFooter>

        {/* UX-277: per-log preview sub-dialog. Radix portals this to
            document.body so it stacks correctly above the parent dialog. */}
        <Dialog open={previewOpen} onOpenChange={handlePreviewOpenChange}>
          <DialogContent
            className="max-w-2xl"
            data-testid="bug-report-log-preview"
            aria-busy={previewLoading}
          >
            <DialogHeader>
              <DialogTitle>{t('bugReport.previewTitle')}</DialogTitle>
              {previewFilename != null && (
                <DialogDescription className="font-mono break-all">
                  {previewFilename}
                </DialogDescription>
              )}
            </DialogHeader>

            {previewLoading && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Spinner />
                <span>{t('bugReport.previewLoading')}</span>
              </div>
            )}

            {!previewLoading && previewError != null && (
              <p role="alert" className="text-sm text-destructive">
                {previewError}
              </p>
            )}

            {!previewLoading && previewError == null && previewContents != null && (
              <div className="space-y-2">
                <ScrollArea
                  className={cn('max-h-96 rounded-md border bg-muted/30')}
                  viewportClassName="p-3"
                >
                  <pre
                    data-testid="bug-report-log-preview-content"
                    className="text-xs leading-5 whitespace-pre-wrap break-words font-mono"
                  >
                    {previewContents.slice(0, PREVIEW_MAX_CHARS)}
                  </pre>
                </ScrollArea>
                {previewContents.length > PREVIEW_MAX_CHARS && (
                  <p className="text-xs text-muted-foreground">
                    {t('bugReport.previewTruncated', {
                      shown: PREVIEW_MAX_CHARS,
                      total: previewContents.length,
                    })}
                  </p>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  handlePreviewOpenChange(false)
                }}
              >
                {t('bugReport.cancel')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
