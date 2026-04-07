/**
 * OverdueSection — renders overdue blocks with count badge.
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
import { truncateContent } from '../lib/text-utils'
import { AlertListItem } from './ui/alert-list-item'
import { PriorityBadge } from './ui/priority-badge'
import { SectionTitle } from './ui/section-title'
import { StatusBadge } from './ui/status-badge'

export interface OverdueSectionProps {
  blocks: BlockRow[]
  pageTitles: Map<string, string>
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function OverdueSection({
  blocks,
  pageTitles,
  onNavigateToPage,
}: OverdueSectionProps): React.ReactElement | null {
  const { t } = useTranslation()

  if (blocks.length === 0) return null

  return (
    <div className="overdue-section mb-3">
      <SectionTitle
        color="text-destructive"
        label={t('duePanel.overdueTitle')}
        count={blocks.length}
      />
      <ul className="space-y-1">
        {blocks
          .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
          .map((block) => {
            const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
            return (
              <AlertListItem
                key={`overdue-${block.id}`}
                variant="destructive"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
                tabIndex={0}
                onClick={() => {
                  if (block.parent_id && onNavigateToPage) {
                    onNavigateToPage(block.parent_id, pageTitle ?? '', block.id)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  if (block.parent_id && onNavigateToPage) {
                    onNavigateToPage(block.parent_id, pageTitle ?? '', block.id)
                  }
                }}
              >
                {block.todo_state && <StatusBadge state="overdue">{block.todo_state}</StatusBadge>}
                {block.priority && <PriorityBadge priority={block.priority} />}
                <span className="min-w-0 flex-1 truncate">
                  {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                </span>
                <span className="shrink-0 text-xs text-destructive/60">{block.due_date}</span>
              </AlertListItem>
            )
          })}
      </ul>
    </div>
  )
}
