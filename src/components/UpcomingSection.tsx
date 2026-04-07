/**
 * UpcomingSection — renders upcoming blocks approaching their deadline.
 *
 * Thin wrapper around AlertSection with pending variant.
 *
 * Shows blocks whose due_date is within the warning period (tomorrow
 * through warningDays ahead). Each item is clickable and navigates
 * to the parent page.
 *
 * Extracted from DuePanel.tsx for testability (#651-R6).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { NavigateToPageFn } from '../lib/block-events'
import type { BlockRow } from '../lib/tauri'
import { AlertSection } from './AlertSection'

export interface UpcomingSectionProps {
  blocks: BlockRow[]
  pageTitles: Map<string, string>
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function UpcomingSection(props: UpcomingSectionProps): React.ReactElement | null {
  const { t } = useTranslation()
  return <AlertSection variant="pending" title={t('duePanel.upcomingTitle')} {...props} />
}
