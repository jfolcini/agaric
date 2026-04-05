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
import { cn } from '@/lib/utils'
import type { NavigateToPageFn } from '../lib/block-events'
import { priorityColor } from '../lib/priority-color'
import type { BlockRow } from '../lib/tauri'
import { truncateContent } from '../lib/text-utils'

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
      <h4 className="text-xs font-semibold text-destructive mb-1.5 flex items-center gap-1">
        <span>{t('duePanel.overdueTitle')}</span>
        <span className="text-muted-foreground font-normal">({blocks.length})</span>
      </h4>
      <ul className="space-y-1">
        {blocks
          .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
          .map((block) => {
            const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
            return (
              <li
                key={`overdue-${block.id}`}
                className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-sm cursor-pointer hover:bg-destructive/10 transition-colors"
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
                {block.todo_state && (
                  <span className="shrink-0 rounded px-1 py-0.5 text-xs font-bold leading-none bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                    {block.todo_state}
                  </span>
                )}
                {block.priority && (
                  <span
                    className={cn(
                      'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-xs font-bold leading-none',
                      priorityColor(block.priority),
                    )}
                  >
                    P{block.priority}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                </span>
                <span className="shrink-0 text-xs text-destructive/60">{block.due_date}</span>
              </li>
            )
          })}
      </ul>
    </div>
  )
}
