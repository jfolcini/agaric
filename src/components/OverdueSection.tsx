/**
 * OverdueSection — renders overdue blocks with count badge.
 *
 * Thin wrapper around AlertSection with destructive variant and PriorityBadge.
 *
 * Shows blocks whose due_date is before today and are not DONE.
 * Each item is clickable and navigates to the parent page.
 *
 * Extracted from DuePanel.tsx for testability (#651-R6).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { NavigateToPageFn } from '../lib/block-events'
import type { BlockRow } from '../lib/tauri'
import { AlertSection } from './AlertSection'

export interface OverdueSectionProps {
  blocks: BlockRow[]
  pageTitles: Map<string, string>
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function OverdueSection(props: OverdueSectionProps): React.ReactElement | null {
  const { t } = useTranslation()
  return (
    <AlertSection
      variant="destructive"
      title={t('duePanel.overdueTitle')}
      showPriorityBadge
      {...props}
    />
  )
}
