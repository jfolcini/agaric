/**
 * DuePanelFilters — source filter pills and hide-before-scheduled toggle.
 *
 * Renders the filter bar for DuePanel with source type pills
 * (All, Due, Scheduled, Properties) and a toggle for hiding
 * future-scheduled blocks.
 *
 * Extracted from DuePanel.tsx for testability (#651-R6).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface DuePanelFiltersProps {
  sourceFilter: string | null
  onSourceFilterChange: (value: string | null) => void
  hideBeforeScheduled: boolean
  onToggleHideBeforeScheduled: () => void
  sourceCounts?: { due: number; scheduled: number; property: number }
}

export function DuePanelFilters({
  sourceFilter,
  onSourceFilterChange,
  hideBeforeScheduled,
  onToggleHideBeforeScheduled,
  sourceCounts,
}: DuePanelFiltersProps): React.ReactElement {
  const { t } = useTranslation()

  // UX-324 — Tooltips clarify the axis of each pill, especially the
  // Due-vs-Scheduled distinction (hard deadline vs soft planned start).
  const filterOptions = [
    {
      label: t('duePanel.filterAll'),
      tooltip: t('duePanel.filterAllTooltip'),
      value: null,
      countKey: 'all' as const,
    },
    {
      label: t('duePanel.filterDue'),
      tooltip: t('duePanel.filterDueTooltip'),
      value: 'column:due_date',
      countKey: 'due' as const,
    },
    {
      label: t('duePanel.filterScheduled'),
      tooltip: t('duePanel.filterScheduledTooltip'),
      value: 'column:scheduled_date',
      countKey: 'scheduled' as const,
    },
    {
      label: t('duePanel.filterProperties'),
      tooltip: t('duePanel.filterPropertiesTooltip'),
      value: 'property:',
      countKey: 'property' as const,
    },
  ]

  return (
    <div
      className="due-panel-filters flex items-center gap-1 px-2 py-1"
      data-testid="due-panel-filters"
    >
      <TooltipProvider>
        {filterOptions.map((opt) => {
          const count = sourceCounts
            ? opt.countKey === 'all'
              ? sourceCounts.due + sourceCounts.scheduled + sourceCounts.property
              : sourceCounts[opt.countKey]
            : 0
          return (
            <Tooltip key={opt.label}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'rounded-full px-2.5 py-1 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]',
                    sourceFilter === opt.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80',
                  )}
                  onClick={() => {
                    onSourceFilterChange(opt.value)
                  }}
                  aria-pressed={sourceFilter === opt.value}
                >
                  {opt.label}
                  {sourceCounts && count > 0 ? ` (${count})` : ''}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{opt.tooltip}</TooltipContent>
            </Tooltip>
          )
        })}
      </TooltipProvider>
      <button
        type="button"
        className={cn(
          'text-xs px-1.5 py-0.5 rounded border transition-colors [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]',
          hideBeforeScheduled
            ? 'bg-primary/10 border-primary/30 text-primary'
            : 'border-muted-foreground/20 text-muted-foreground hover:bg-accent/50 active:bg-accent/70',
        )}
        onClick={onToggleHideBeforeScheduled}
        title={
          hideBeforeScheduled
            ? t('duePanel.showingScheduledTodayTooltip')
            : t('duePanel.showingAllTasksTooltip')
        }
        aria-label={
          hideBeforeScheduled
            ? t('duePanel.scheduledHideFutureButton')
            : t('duePanel.scheduledShowAllButton')
        }
        aria-pressed={hideBeforeScheduled}
      >
        {hideBeforeScheduled
          ? t('duePanel.scheduledHideFutureButton')
          : t('duePanel.scheduledShowAllButton')}
      </button>
    </div>
  )
}
