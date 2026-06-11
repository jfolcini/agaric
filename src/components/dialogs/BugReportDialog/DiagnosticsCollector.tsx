/**
 * DiagnosticsCollector — diagnostics-collection sub-component for
 * {@link BugReportDialog} (MAINT-Phase-3b decomposition).
 *
 * Renders three pieces of the bug-report dialog that all revolve around
 * diagnostic logs:
 *
 *   1. The logs list (filename + size + per-row `t('bugReport.previewTitle')`
 *      Eye button), which is rendered only when
 *      `t('bugReport.includeLogsLabel')` is ON.
 *   2. The zip-download hint that names the eventual ZIP and reminds the
 *      user the file must be dragged into the GitHub issue manually.
 *   3. The nested per-log preview sub-dialog (UX-277) — a Radix Dialog
 *      portalled to `document.body` so it stacks above the parent dialog.
 *
 * State + IPC remain in the orchestrator: this component is a controlled
 * presentation layer that receives `logs`, `loadingLogs`, and the preview
 * state machine via props. That preserves the existing focus-trap
 * behaviour and keeps the `read_logs_for_report` Tauri-command shape
 * untouched.
 */

import { Eye } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import type { LogFileEntry } from '@/lib/tauri'
import { cn } from '@/lib/utils'

/** Maximum chars rendered in the per-log preview sub-dialog. */
export const PREVIEW_MAX_CHARS = 500

export interface DiagnosticsCollectorProps {
  /** Whether the parent's "include diagnostic logs" switch is ON. */
  includeLogs: boolean
  /** Resolved log entries (post-redaction when redact=true). */
  logs: LogFileEntry[]
  /** True while a `read_logs_for_report` IPC is in flight. */
  loadingLogs: boolean
  /** Filename of the eventual diagnostic-logs ZIP, surfaced in the inline hint. */
  zipFileName: string
  /** Click handler for a per-row "Preview" button. */
  onOpenPreview: (filename: string) => void

  // ── Per-log preview sub-dialog state (UX-277) ───────────────────────
  previewOpen: boolean
  previewFilename: string | null
  previewContents: string | null
  previewLoading: boolean
  previewError: string | null
  showFullLog: boolean
  onPreviewOpenChange: (next: boolean) => void
  onToggleShowFullLog: () => void
}

export function DiagnosticsCollector({
  includeLogs,
  logs,
  loadingLogs,
  zipFileName,
  onOpenPreview,
  previewOpen,
  previewFilename,
  previewContents,
  previewLoading,
  previewError,
  showFullLog,
  onPreviewOpenChange,
  onToggleShowFullLog,
}: DiagnosticsCollectorProps): React.ReactElement | null {
  const { t } = useTranslation()
  const logsSectionId = 'bug-report-logs-list'

  // When logs are OFF we still render the preview sub-dialog (it lives in
  // a Radix Portal and its open state is parent-owned) but skip the list.
  return (
    <>
      {includeLogs && (
        <div className="space-y-1.5">
          <Label htmlFor={logsSectionId} muted={false}>
            {t('bugReport.logsListTitle')}
          </Label>
          <ScrollArea className="max-h-32 rounded-md border bg-muted/30" viewportClassName="p-3">
            <ul id={logsSectionId} data-testid="bug-report-logs-list" className="text-xs space-y-1">
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
                        onOpenPreview(entry.name)
                      }}
                    >
                      <Eye />
                    </Button>
                  </li>
                ))}
            </ul>
          </ScrollArea>
          {/* PEND-bug-report-zip-affordance: inline hint that names
                the zip and tells the user they'll have to drag it
                into the GitHub issue manually. The footer's
                "Download zip" + "Open GitHub issue" split matches
                this wording. */}
          <p className="text-xs text-muted-foreground" data-testid="bug-report-zip-hint">
            {t('bugReport.zipDownloadHint', { fileName: zipFileName })}
          </p>
        </div>
      )}

      {/* UX-277: per-log preview sub-dialog. Radix portals this to
          document.body so it stacks correctly above the parent dialog.
          Kept as a regular Dialog primitive across viewports — nesting a
          Sheet inside a Sheet would compound the focus-trap and
          overlay-stacking edge cases the parent migration is avoiding. */}
      <Dialog open={previewOpen} onOpenChange={onPreviewOpenChange}>
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
            <output
              aria-live="polite"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Spinner />
              <span>{t('bugReport.previewLoading')}</span>
            </output>
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
                  {showFullLog ? previewContents : previewContents.slice(0, PREVIEW_MAX_CHARS)}
                </pre>
              </ScrollArea>
              {previewContents.length > PREVIEW_MAX_CHARS && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {showFullLog
                      ? null
                      : t('bugReport.previewTruncated', {
                          shown: PREVIEW_MAX_CHARS,
                          total: previewContents.length,
                        })}
                  </p>
                  {/* UX-12: View-full / collapse affordance so the
                      truncation notice isn't a dead end. */}
                  <Button
                    variant="link"
                    size="sm"
                    onClick={onToggleShowFullLog}
                    data-testid="bug-report-log-preview-toggle"
                  >
                    {showFullLog ? t('bugReport.collapseLog') : t('bugReport.viewFullLog')}
                  </Button>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onPreviewOpenChange(false)
              }}
              // PEND-23 L7: explicit autoFocus on the close button so
              // the nested log-preview dialog lands focus on a known,
              // dismissable target (rather than relying on Radix
              // default focus-trap discovery, which previously left
              // focus on the body when the preview opened in a
              // truncated state).
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional focus-on-open: nested log-preview dialog focuses its close button so the focus trap lands on a known dismissable target
              autoFocus
              data-testid="bug-report-log-preview-close"
            >
              {t('bugReport.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
