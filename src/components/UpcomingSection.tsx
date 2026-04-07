/**
 * UpcomingSection — renders upcoming blocks approaching their deadline.
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
import { truncateContent } from '../lib/text-utils'
import { AlertListItem } from './ui/alert-list-item'
import { SectionTitle } from './ui/section-title'
import { StatusBadge } from './ui/status-badge'

export interface UpcomingSectionProps {
  blocks: BlockRow[]
  pageTitles: Map<string, string>
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function UpcomingSection({
  blocks,
  pageTitles,
  onNavigateToPage,
}: UpcomingSectionProps): React.ReactElement | null {
  const { t } = useTranslation()

  if (blocks.length === 0) return null

  return (
    <div className="upcoming-section mb-3">
      <SectionTitle
        color="text-status-pending-foreground"
        label={t('duePanel.upcomingTitle')}
        count={blocks.length}
      />
      <ul className="space-y-1">
        {blocks
          .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
          .map((block) => {
            const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
            return (
              <AlertListItem
                key={`upcoming-${block.id}`}
                variant="pending"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
                tabIndex={0}
                onClick={() => {
                  if (block.parent_id && onNavigateToPage)
                    onNavigateToPage(block.parent_id, pageTitle ?? '', block.id)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  if (block.parent_id && onNavigateToPage)
                    onNavigateToPage(block.parent_id, pageTitle ?? '', block.id)
                }}
              >
                {block.todo_state && <StatusBadge state="default">{block.todo_state}</StatusBadge>}
                <span className="min-w-0 flex-1 truncate">
                  {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                </span>
                <span className="shrink-0 text-xs text-status-pending-foreground/60">
                  {block.due_date}
                </span>
              </AlertListItem>
            )
          })}
      </ul>
    </div>
  )
}
