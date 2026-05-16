/**
 * BugReportForm — form-section sub-component for {@link BugReportDialog}
 * (MAINT-Phase-3b decomposition of the 627-LOC monolith).
 *
 * Owns the title input, description textarea, the
 * `t('bugReport.includeLogsLabel')` switch, and the sibling
 * `t('bugReport.redactLabel')` switch (UX-383). All state lives in the
 * parent orchestrator — this component is a controlled presentation layer
 * so the existing IPC + redaction logic in `BugReportDialog.tsx` (and
 * `src-tauri/src/commands/bug_report.rs`) stays untouched.
 *
 * Accessibility is preserved verbatim: labels keep their original `htmlFor`
 * targets, the redact switch keeps its disabled-when-logs-off styling, and
 * the dialog focus trap continues to discover every interactive element via
 * the same DOM order as the pre-refactor markup.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export interface BugReportFormProps {
  title: string
  description: string
  includeLogs: boolean
  redact: boolean
  onTitleChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onIncludeLogsChange: (next: boolean) => void
  onRedactChange: (next: boolean) => void
}

export function BugReportForm({
  title,
  description,
  includeLogs,
  redact,
  onTitleChange,
  onDescriptionChange,
  onIncludeLogsChange,
  onRedactChange,
}: BugReportFormProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="bug-report-title" muted={false}>
          {t('bugReport.fieldTitleLabel')}
        </Label>
        <Input
          id="bug-report-title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
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
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={t('bugReport.fieldDescriptionPlaceholder')}
          rows={5}
        />
      </div>

      <div className="flex items-start gap-3">
        <Switch
          id="bug-report-include-logs"
          checked={includeLogs}
          onCheckedChange={onIncludeLogsChange}
          aria-label={t('bugReport.includeLogsLabel')}
        />
        <div className="space-y-0.5">
          <Label htmlFor="bug-report-include-logs" muted={false}>
            {t('bugReport.includeLogsLabel')}
          </Label>
          <p className="text-xs text-muted-foreground">{t('bugReport.includeLogsHint')}</p>
        </div>
      </div>

      {/* UX-383: Redact is a sibling row at the same indent as Include
            logs (not nested under it) so it's always visible. When
            Include logs is OFF the underlying Switch is disabled —
            Radix forwards `disabled` to the native disabled
            attribute and the Switch primitive applies
            `disabled:opacity-50 disabled:cursor-not-allowed`. We
            additionally mute the label + hint so the dependency on
            Include logs is obvious at a glance. */}
      <div className="flex items-start gap-3">
        <Switch
          id="bug-report-redact"
          checked={redact}
          onCheckedChange={onRedactChange}
          disabled={!includeLogs}
          aria-label={t('bugReport.redactLabel')}
        />
        <div className={cn('space-y-0.5', !includeLogs && 'opacity-50')}>
          <Label htmlFor="bug-report-redact" muted={false}>
            {t('bugReport.redactLabel')}
          </Label>
          <p className="text-xs text-muted-foreground">{t('bugReport.redactHint')}</p>
        </div>
      </div>
    </div>
  )
}
