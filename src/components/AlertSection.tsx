/**
 * AlertSection — shared list component for overdue/upcoming alert blocks.
 *
 * Parameterized by variant, title, and optional PriorityBadge display.
 * Used by OverdueSection (destructive) and UpcomingSection (pending).
 *
 * Extracted to eliminate near-duplication between the two sections (#M-11).
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

type AlertVariant = 'destructive' | 'pending'

const variantConfig: Record<
  AlertVariant,
  {
    sectionClass: string
    titleColor: string
    keyPrefix: string
    badgeState: 'overdue' | 'default'
    dateColor: string
  }
> = {
  destructive: {
    sectionClass: 'overdue-section mb-3',
    titleColor: 'text-destructive',
    keyPrefix: 'overdue',
    badgeState: 'overdue',
    dateColor: 'text-destructive/60',
  },
  pending: {
    sectionClass: 'upcoming-section mb-3',
    titleColor: 'text-status-pending-foreground',
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
            const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
            const dueDate = block.due_date ? new Date(`${block.due_date}T00:00:00`) : null
            const daysOverdue = dueDate
              ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
              : 0
            return (
              <AlertListItem
                key={`${config.keyPrefix}-${block.id}`}
                variant={variant}
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
                  <StatusBadge state={config.badgeState}>{block.todo_state}</StatusBadge>
                )}
                {showPriorityBadge && block.priority && <PriorityBadge priority={block.priority} />}
                <span className="min-w-0 flex-1 truncate">
                  {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                </span>
                <span className={`shrink-0 text-xs ${config.dateColor}`}>
                  <span>{block.due_date}</span>
                  {daysOverdue > 0 && (
                    <span className="text-muted-foreground ml-1">
                      ({t('duePanel.daysOverdue', { count: daysOverdue })})
                    </span>
                  )}
                </span>
              </AlertListItem>
            )
          })}
      </ul>
    </div>
  )
}
