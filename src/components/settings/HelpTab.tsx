/**
 * HelpTab — Help / Report-a-bug panel (FEAT-5).
 *
 * Pure-presentation. The bug-report dialog itself is mounted by
 * `SettingsView` so its open state can outlive a tab switch; this
 * panel just exposes the trigger button and forwards the click
 * through `onReportBugClick`.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

interface HelpTabProps {
  onReportBugClick: () => void
}

export function HelpTab({ onReportBugClick }: HelpTabProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="space-y-4 max-w-xl">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('help.reportBugTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('help.reportBugDescription')}</p>
        <Button variant="outline" onClick={onReportBugClick} aria-label={t('help.reportBugButton')}>
          {t('help.reportBugButton')}
        </Button>
      </div>
    </div>
  )
}
