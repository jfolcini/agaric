/**
 * DuePanelFilters — source filter segments and hide-before-scheduled toggle.
 *
 * Renders the filter bar for DuePanel with a single-select ToggleGroup of
 * source types (All, Due, Scheduled, Properties) and a switch for hiding
 * future-scheduled blocks. The segments use the ToggleGroup's neutral outline
 * rather than a brand-red fill, which reads as an error beside the red Overdue
 * section.
 *
 * Extracted from DuePanel.tsx for testability (#651-R6).
 */

import type React from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Radix ToggleGroup values are strings; the "All" source (no filter) is `null`
// upstream, so it needs a string stand-in.
const ALL_SOURCES = 'all'

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
  const hideFutureId = useId()

  // Tooltips clarify the axis of each pill, especially the
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
      className="due-panel-filters flex flex-wrap items-center gap-2 px-2 py-1"
      data-testid="due-panel-filters"
    >
      <ToggleGroup
        type="single"
        className="max-w-full flex-wrap"
        value={sourceFilter ?? ALL_SOURCES}
        onValueChange={(value) => {
          // Radix reports clicking the active segment as '' (deselect); a
          // source filter always has one active segment, so ignore it.
          if (!value) return
          onSourceFilterChange(value === ALL_SOURCES ? null : value)
        }}
      >
        {filterOptions.map((opt) => {
          const count = sourceCounts
            ? opt.countKey === 'all'
              ? sourceCounts.due + sourceCounts.scheduled + sourceCounts.property
              : sourceCounts[opt.countKey]
            : 0
          return (
            <Tooltip key={opt.label}>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value={opt.value ?? ALL_SOURCES}
                  className="whitespace-nowrap [@media(pointer:coarse)]:px-3"
                >
                  {opt.label}
                  {sourceCounts && count > 0 ? ` (${count})` : ''}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{opt.tooltip}</TooltipContent>
            </Tooltip>
          )
        })}
      </ToggleGroup>
      <div className="flex items-center gap-2">
        <Switch
          id={hideFutureId}
          checked={hideBeforeScheduled}
          onCheckedChange={() => onToggleHideBeforeScheduled()}
        />
        <Label htmlFor={hideFutureId} className="font-normal whitespace-nowrap">
          {t('duePanel.hideFutureScheduled')}
        </Label>
      </div>
    </div>
  )
}
