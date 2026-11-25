/**
 * BugReportForm — form-section sub-component for {@link BugReportDialog}
 * (MAINT-Phase-3b decomposition of the 627-LOC monolith).
 *
 * Owns the title input, description textarea, the
 * `t('bugReport.includeLogsLabel')` switch, and the sibling
 * `t('bugReport.redactLabel')` switch. All state lives in the
 * parent orchestrator — this component is a controlled presentation layer
 * so the existing IPC + redaction logic in `BugReportDialog.tsx` (and
 * `src-tauri/src/commands/bug_report.rs`) stays untouched.
 *
 * The two switches are `ToggleRow`s, as in Settings: the label keeps its
 * `htmlFor` target, the hint describes the switch, and the redact switch is
 * disabled while logs are off.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleRow } from '@/components/ui/toggle-row'

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

      {/* Switch rows as Settings lays them out, the switch right of its label
          (#7040). Redact stays visible, disabled while Include logs is off. */}
      <ToggleRow
        id="bug-report-include-logs"
        label={t('bugReport.includeLogsLabel')}
        description={t('bugReport.includeLogsHint')}
        checked={includeLogs}
        onCheckedChange={onIncludeLogsChange}
      />
      <ToggleRow
        id="bug-report-redact"
        label={t('bugReport.redactLabel')}
        description={t('bugReport.redactHint')}
        checked={redact}
        onCheckedChange={onRedactChange}
        disabled={!includeLogs}
      />
    </div>
  )
}
