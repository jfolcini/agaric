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
import { cn } from '@/lib/utils'

export interface DuePanelFiltersProps {
  sourceFilter: string | null
  onSourceFilterChange: (value: string | null) => void
  hideBeforeScheduled: boolean
  onToggleHideBeforeScheduled: () => void
}

export function DuePanelFilters({
  sourceFilter,
  onSourceFilterChange,
  hideBeforeScheduled,
  onToggleHideBeforeScheduled,
}: DuePanelFiltersProps): React.ReactElement {
  const { t } = useTranslation()

  const filterOptions = [
    { label: t('duePanel.filterAll'), value: null },
    { label: t('duePanel.filterDue'), value: 'column:due_date' },
    { label: t('duePanel.filterScheduled'), value: 'column:scheduled_date' },
    { label: t('duePanel.filterProperties'), value: 'property:' },
  ]

  return (
    <div className="due-panel-filters flex items-center gap-1 px-2 py-1">
      {filterOptions.map((opt) => (
        <button
          key={opt.label}
          type="button"
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
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
        </button>
      ))}
      <button
        type="button"
        className={cn(
          'text-xs px-1.5 py-0.5 rounded border transition-colors',
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
        aria-pressed={hideBeforeScheduled}
      >
        {hideBeforeScheduled
          ? t('duePanel.scheduledHideFutureButton')
          : t('duePanel.scheduledShowAllButton')}
      </button>
    </div>
  )
}
