/**
 * HistoryFilterBar --- operation type filter dropdown for the history view.
 *
 * Extracted from HistoryView for testability.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OP_TYPES = [
  'edit',
  'create',
  'delete',
  'move',
  'tag',
  'property',
  'attachment',
  'restore',
  'purge',
  'sync_merge',
  'sync_receive',
] as const

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HistoryFilterBarProps {
  opTypeFilter: string | null
  onFilterChange: (filter: string | null) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryFilterBar({
  opTypeFilter,
  onFilterChange,
}: HistoryFilterBarProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="history-filter-bar flex items-center gap-3">
      <label htmlFor="op-type-filter" className="text-sm font-medium text-muted-foreground">
        {t('history.filterLabel')}
      </label>
      <Select
        value={opTypeFilter ?? '__all__'}
        onValueChange={(val) => onFilterChange(val === '__all__' ? null : val)}
      >
        <SelectTrigger
          id="op-type-filter"
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          aria-label={t('history.filterByTypeLabel')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">{t('history.allTypesOption')}</SelectItem>
          {OP_TYPES.map((opType) => (
            <SelectItem key={opType} value={opType}>
              {opType}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
