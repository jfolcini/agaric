/**
 * FilterBar — the one filter-bar layout every view shares (#7165 U3): the
 * active chips on their own wrapping row, then one actions row of Add filter,
 * Clear all and the view's own trailing controls. Each view keeps its chips,
 * actions and data flow; this only places them.
 */

import type React from 'react'

import { cn } from '@/lib/utils'

export interface FilterBarProps {
  /** Whether any chip is active; without one the chips row and Clear all are left out. */
  hasChips: boolean
  chips: React.ReactNode
  addFilter: React.ReactNode
  clearAll?: React.ReactNode
  /** The view's own controls after Clear all (counts, view menus). */
  trailing?: React.ReactNode
  className?: string
  'data-testid'?: string
}

// On touch a wrapped line sits far enough below the chips that its controls'
// 44 px hit areas do not take the chips' lower edge.
const ROW = 'flex flex-wrap items-center gap-1.5 coarse:gap-y-4'

export function FilterBar({
  hasChips,
  chips,
  addFilter,
  clearAll,
  trailing,
  className,
  'data-testid': testId,
}: FilterBarProps): React.ReactElement {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-1.5 coarse:gap-4', className)}
      data-testid={testId}
    >
      {hasChips && (
        <div className={ROW} data-slot="filter-bar-chips">
          {chips}
        </div>
      )}
      <div className={ROW} data-slot="filter-bar-actions">
        {addFilter}
        {hasChips && clearAll}
        {trailing}
      </div>
    </div>
  )
}
