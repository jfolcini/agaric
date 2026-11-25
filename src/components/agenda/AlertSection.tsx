/**
 * AlertSection — shared list component for overdue/upcoming alert blocks.
 *
 * Parameterized by variant, title, and optional priority Badge display.
 * Used by OverdueSection (destructive), UpcomingSection (pending) and the Due
 * panel's open tasks scheduled before today (scheduled), which date by their
 * scheduled date instead of their due date.
 *
 * Extracted to eliminate near-duplication between the two sections (#).
 */

import type React from 'react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

import { TaskMarkerButton } from '@/components/editor/TaskMarkerButton'
import { renderRichContent } from '@/components/RichContentRenderer'
import { AlertListRow } from '@/components/ui/alert-list-row'
import { Badge } from '@/components/ui/badge'
import { SectionTitle, type SectionTitleColor } from '@/components/ui/section-title'
import { useRichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import { useTaskStateCycle } from '@/hooks/useTaskStateCycle'
import { useToday } from '@/hooks/useToday'
import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { formatCompactDate } from '@/lib/date-utils'
import { cn } from '@/lib/utils'

type AlertVariant = 'destructive' | 'pending' | 'scheduled'

const variantConfig: Record<
  AlertVariant,
  {
    sectionClass: string
    titleColor: SectionTitleColor
    keyPrefix: string
    dateColor: string
    row: 'destructive' | 'pending'
    dateField: 'due_date' | 'scheduled_date'
    ageKey: 'duePanel.daysOverdue' | 'duePanel.scheduledDaysAgo'
  }
> = {
  destructive: {
    sectionClass: 'overdue-section mb-3',
    titleColor: 'overdue',
    keyPrefix: 'overdue',
    dateColor: 'text-alert-error-foreground',
    row: 'destructive',
    dateField: 'due_date',
    ageKey: 'duePanel.daysOverdue',
  },
  pending: {
    sectionClass: 'upcoming-section mb-3',
    titleColor: 'pending',
    keyPrefix: 'upcoming',
    dateColor: 'text-muted-foreground',
    row: 'pending',
    dateField: 'due_date',
    ageKey: 'duePanel.daysOverdue',
  },
  scheduled: {
    sectionClass: 'scheduled-earlier-section mb-3',
    titleColor: 'pending',
    keyPrefix: 'scheduled',
    dateColor: 'text-muted-foreground',
    row: 'pending',
    dateField: 'scheduled_date',
    ageKey: 'duePanel.scheduledDaysAgo',
  },
}

/**
 * Rich-content body of one alert row, memoized on the content string (#4705).
 *
 * DuePanel owns the roving-focus `focusedIndex` and re-renders on every arrow
 * keypress, and it renders `OverdueSection` / `UpcomingSection` inline —
 * unmemoized and unvirtualized, over a list `useDuePanelData` fills to a
 * 200-row page. Without this memo every visible row would rebuild its
 * `renderRichContent` element tree per keystroke, the churn #2193 already
 * memoized away for the projected rows of this same panel.
 *
 * The callbacks are sourced INSIDE the memoized component, as `BlockListItem`
 * and `ProjectedEntryRow` do: `useRichContentCallbacks()` returns a fresh
 * object literal each render, so threading it through a prop would fail this
 * component's shallow compare on every parent re-render.
 */
function AlertRowContentInner({ content }: { content: string }): React.ReactElement {
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, resolveTagStatus } =
    useRichContentCallbacks()
  return (
    <>
      {renderRichContent(content, {
        // The whole row is the click target (`AlertListRow`'s onClick navigates
        // to the parent page), so rendered links must stay inert rather than
        // becoming competing click targets nested inside it.
        interactive: false,
        // The row is a single clamped line; `inline` keeps a heading/list/table
        // block from landing inside the truncating <span>.
        inline: true,
        resolveBlockTitle,
        resolveBlockStatus,
        resolveTagName,
        resolveTagStatus,
      })}
    </>
  )
}

const AlertRowContent = memo(AlertRowContentInner)
AlertRowContent.displayName = 'AlertRowContent'

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
  const cycleTaskState = useTaskStateCycle()

  const today = new Date(`${useToday()}T00:00:00`)

  if (blocks.length === 0) return null

  return (
    <div className={config.sectionClass}>
      <SectionTitle color={config.titleColor} label={title} count={blocks.length} />
      <ul className="space-y-1">
        {blocks
          .toSorted((a, b) => (a[config.dateField] ?? '').localeCompare(b[config.dateField] ?? ''))
          .map((block) => {
            const pageTitle = block.page_id ? pageTitles.get(block.page_id) : undefined
            const day = block[config.dateField]
            const date = day ? new Date(`${day}T00:00:00`) : null
            const daysAgo = date
              ? Math.floor((today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
              : 0
            return (
              <AlertListRow
                key={`${config.keyPrefix}-${block.id}`}
                variant={config.row}
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
                  <TaskMarkerButton
                    blockId={block.id}
                    todoState={block.todo_state}
                    onToggleTodo={(id) => void cycleTaskState(id, block.todo_state as string)}
                  />
                )}
                {showPriorityBadge && block.priority && (
                  <Badge tone="priority" size="sm" priorityLevel={block.priority}>
                    P{block.priority}
                  </Badge>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {block.content ? (
                    <AlertRowContent content={block.content} />
                  ) : (
                    t('duePanel.emptyContent')
                  )}
                </span>
                <span className={cn('shrink-0 truncate text-xs', config.dateColor)}>
                  <span>{day && formatCompactDate(day)}</span>
                  {daysAgo > 0 && (
                    <span className="text-muted-foreground ml-1">
                      ({t(config.ageKey, { count: daysAgo })})
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
