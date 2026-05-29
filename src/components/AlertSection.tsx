/**
 * AlertSection — shared list component for overdue/upcoming alert blocks.
 *
 * Parameterized by variant, title, and optional priority Badge display.
 * Used by OverdueSection (destructive) and UpcomingSection (pending).
 *
 * Extracted to eliminate near-duplication between the two sections (#M-11).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import type { NavigateToPageFn } from '../lib/block-events'
import type { BlockRow } from '../lib/tauri'
import { truncateContent } from '../lib/text-utils'
import { AlertListRow } from './ui/alert-list-row'
import { Badge } from './ui/badge'
import { SectionTitle, type SectionTitleColor } from './ui/section-title'

type AlertVariant = 'destructive' | 'pending'

const variantConfig: Record<
  AlertVariant,
  {
    sectionClass: string
    titleColor: SectionTitleColor
    keyPrefix: string
    badgeState: 'overdue' | 'default'
    dateColor: string
  }
> = {
  destructive: {
    sectionClass: 'overdue-section mb-3',
    titleColor: 'overdue',
    keyPrefix: 'overdue',
    badgeState: 'overdue',
    dateColor: 'text-destructive/60',
  },
  pending: {
    sectionClass: 'upcoming-section mb-3',
    titleColor: 'pending',
    keyPrefix: 'upcoming',
    badgeState: 'default',
    dateColor: 'text-status-pending-foreground/60',
  },
}

export interface AlertSectionProps {
  variant: AlertVariant
  title: string
  blocks: BlockRow[]
  pageTitles: Map<string, string>
  showPriorityBadge?: boolean
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function AlertSection({
  variant,
  title,
  blocks,
  pageTitles,
  showPriorityBadge = false,
  onNavigateToPage,
}: AlertSectionProps): React.ReactElement | null {
  const { t } = useTranslation()
  const config = variantConfig[variant]

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (blocks.length === 0) return null

  return (
    <div className={config.sectionClass}>
      <SectionTitle color={config.titleColor} label={title} count={blocks.length} />
      <ul className="space-y-1">
        {blocks
          .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
          .map((block) => {
            const pageTitle = block.page_id ? pageTitles.get(block.page_id) : undefined
            const dueDate = block.due_date ? new Date(`${block.due_date}T00:00:00`) : null
            const daysOverdue = dueDate
              ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
              : 0
            return (
              <AlertListRow
                key={`${config.keyPrefix}-${block.id}`}
                variant={variant}
                tabIndex={0}
                onClick={() => {
                  if (block.page_id && onNavigateToPage) {
                    onNavigateToPage(block.page_id, pageTitle ?? '', block.id)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  if (block.page_id && onNavigateToPage) {
                    onNavigateToPage(block.page_id, pageTitle ?? '', block.id)
                  }
                }}
              >
                {block.todo_state && (
                  <Badge
                    tone="status"
                    shape="rounded"
                    size="compact"
                    statusState={config.badgeState}
                  >
                    {block.todo_state}
                  </Badge>
                )}
                {showPriorityBadge && block.priority && (
                  <Badge tone="priority" shape="rounded" size="sm" priorityLevel={block.priority}>
                    P{block.priority}
                  </Badge>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                </span>
                <span className={cn('shrink-0 truncate text-xs', config.dateColor)}>
                  <span>{block.due_date}</span>
                  {daysOverdue > 0 && (
                    <span className="text-muted-foreground ml-1">
                      ({t('duePanel.daysOverdue', { count: daysOverdue })})
                    </span>
                  )}
                </span>
              </AlertListRow>
            )
          })}
      </ul>
    </div>
  )
}
