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
      <h4 className="text-xs font-semibold text-status-pending-foreground mb-1.5 flex items-center gap-1">
        <span>{t('duePanel.upcomingTitle')}</span>
        <span className="text-muted-foreground font-normal">({blocks.length})</span>
      </h4>
      <ul className="space-y-1">
        {blocks
          .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
          .map((block) => {
            const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
            return (
              <li
                key={`upcoming-${block.id}`}
                className="flex items-center gap-2 rounded-md border border-status-pending/30 bg-status-pending/30 px-2 py-1.5 text-sm cursor-pointer hover:bg-status-pending/50 transition-colors"
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
                {block.todo_state && (
                  <span className="shrink-0 rounded px-1 py-0.5 text-xs font-bold leading-none bg-status-pending text-status-pending-foreground">
                    {block.todo_state}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                </span>
                <span className="shrink-0 text-xs text-status-pending-foreground/60">
                  {block.due_date}
                </span>
              </li>
            )
          })}
      </ul>
    </div>
  )
}
