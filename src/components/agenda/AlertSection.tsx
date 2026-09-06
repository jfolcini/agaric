/**
 * AlertSection — shared list component for overdue/upcoming alert blocks.
 *
 * Parameterized by variant, title, and optional priority Badge display.
 * Used by OverdueSection (destructive) and UpcomingSection (pending).
 *
 * Extracted to eliminate near-duplication between the two sections (#).
 */

import type React from 'react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

import { renderRichContent } from '@/components/RichContentRenderer'
import { AlertListRow } from '@/components/ui/alert-list-row'
import { Badge } from '@/components/ui/badge'
import { SectionTitle, type SectionTitleColor } from '@/components/ui/section-title'
import { useRichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { cn } from '@/lib/utils'

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

/**
 * Rich-content body of one alert row, memoized on the content string (#4705).
 *
 * DuePanel owns the roving-focus `focusedIndex` and re-renders on every arrow
 * keypress, and it renders `OverdueSection` / `UpcomingSection` inline —
 * unmemoized and unvirtualized, over a list `useDuePanelData` fills to a
 * 200-row page. Without this memo every visible row would rebuild its
 * `renderRichContent` element tree per keystroke: the same churn #2193 / #2200
 * already memoized away for the projected rows of the same panel. (The parse
 * itself is LRU-cached in `RichContentRenderer`; the element tree is not.)
 *
 * The callbacks are sourced INSIDE the memoized component, as `BlockListItem`
 * and `ProjectedEntryRow` do: `useRichContentCallbacks()` returns a fresh
 * object literal each render, so threading it through a prop would fail this
 * component's shallow compare on every parent re-render.
 *
 * No inner `useMemo` here, unlike `BlockListItem` / `BlockDndOverlay`. Those
 * two re-render for reasons unrelated to their content (`isFocused`, the drag's
 * per-pointer-move `projected`), so a memo has something to skip. `content` is
 * this component's ONLY prop, and its one other re-render trigger is the
 * resolve-store subscription inside `useRichContentCallbacks()` — which fires
 * exactly when a `[[ULID]]` has resolved and the tree therefore MUST be
 * rebuilt. A `useMemo` keyed on content + resolve version could never hit.
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

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (blocks.length === 0) return null

  return (
    <div className={config.sectionClass}>
      <SectionTitle color={config.titleColor} label={title} count={blocks.length} />
      <ul className="space-y-1">
        {blocks
          .toSorted((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
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
                  {block.content ? (
                    <AlertRowContent content={block.content} />
                  ) : (
                    t('duePanel.emptyContent')
                  )}
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
