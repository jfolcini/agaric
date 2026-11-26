/**
 * AlertSection — a Due panel section of open tasks that are not on the day's
 * own list: Overdue (destructive), Upcoming (pending) and the open tasks
 * scheduled before today (scheduled), which date by their scheduled date
 * instead of their due date.
 *
 * A heading over the one task row (`BlockListItem`), the rows of every other
 * group in the panel (#7040): Overdue is told apart by its heading's colour
 * and each row's red date chip, not by a card around each row.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { BlockListItem } from '@/components/editor/BlockListItem'
import { SectionGroupHeader } from '@/components/ui/section-group-header'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useToday } from '@/hooks/useToday'
import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'

type AlertVariant = 'destructive' | 'pending' | 'scheduled'

const variantConfig: Record<
  AlertVariant,
  {
    sectionClass: string
    titleClass: string | undefined
    keyPrefix: string
    dateField: 'due_date' | 'scheduled_date'
    ageKey: 'duePanel.daysOverdue' | 'duePanel.scheduledDaysAgo'
  }
> = {
  destructive: {
    sectionClass: 'overdue-section',
    titleClass: 'text-alert-error-foreground',
    keyPrefix: 'overdue',
    dateField: 'due_date',
    ageKey: 'duePanel.daysOverdue',
  },
  pending: {
    sectionClass: 'upcoming-section',
    titleClass: undefined,
    keyPrefix: 'upcoming',
    dateField: 'due_date',
    ageKey: 'duePanel.daysOverdue',
  },
  scheduled: {
    sectionClass: 'scheduled-earlier-section',
    titleClass: undefined,
    keyPrefix: 'scheduled',
    dateField: 'scheduled_date',
    ageKey: 'duePanel.scheduledDaysAgo',
  },
}

export interface AlertSectionProps {
  variant: AlertVariant
  title: string
  blocks: BlockRow[]
  pageTitles: Map<string, string>
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function AlertSection({
  variant,
  title,
  blocks,
  pageTitles,
  onNavigateToPage,
}: AlertSectionProps): React.ReactElement | null {
  const { t } = useTranslation()
  const config = variantConfig[variant]
  const { getRowHandlers } = useBlockNavigation({ onNavigateToPage, pageTitles, untitledLabel: '' })

  const today = new Date(`${useToday()}T00:00:00`)

  if (blocks.length === 0) return null

  return (
    <div className={config.sectionClass}>
      <SectionGroupHeader asChild className={config.titleClass}>
        <h2>
          {title} <span className="font-normal text-muted-foreground">({blocks.length})</span>
        </h2>
      </SectionGroupHeader>
      <ul className="m-0 list-none p-0">
        {blocks
          .toSorted((a, b) => (a[config.dateField] ?? '').localeCompare(b[config.dateField] ?? ''))
          .map((block) => {
            const day = block[config.dateField]
            const date = day ? new Date(`${day}T00:00:00`) : null
            const daysAgo = date
              ? Math.floor((today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
              : 0
            const rowHandlers = getRowHandlers(block)
            return (
              <BlockListItem
                key={`${config.keyPrefix}-${block.id}`}
                blockId={block.id}
                content={block.content}
                emptyContentFallback={t('duePanel.emptyContent')}
                taskState={block.todo_state}
                priority={block.priority}
                dueDate={block.due_date}
                scheduledDate={block.scheduled_date}
                {...(daysAgo > 0 && { note: `(${t(config.ageKey, { count: daysAgo })})` })}
                pageId={block.page_id}
                pageTitle={
                  block.page_id ? (pageTitles.get(block.page_id) ?? t('duePanel.untitled')) : ''
                }
                breadcrumbArrow={t('duePanel.breadcrumbArrow')}
                className="hover:bg-muted/50 active:bg-muted/70 ml-2 max-w-[calc(100%-0.5rem)]"
                breadcrumbClassName="due-panel-breadcrumb"
                testId="due-panel-alert-item"
                onClick={rowHandlers.onClick}
                onKeyDown={rowHandlers.onKeyDown}
              />
            )
          })}
      </ul>
    </div>
  )
}
