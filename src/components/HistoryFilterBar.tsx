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
  { value: 'edit_block', label: 'Edit' },
  { value: 'create_block', label: 'Create' },
  { value: 'delete_block', label: 'Delete' },
  { value: 'move_block', label: 'Move' },
  { value: 'add_tag', label: 'Add tag' },
  { value: 'remove_tag', label: 'Remove tag' },
  { value: 'set_property', label: 'Set property' },
  { value: 'delete_property', label: 'Delete property' },
  { value: 'add_attachment', label: 'Add attachment' },
  { value: 'delete_attachment', label: 'Delete attachment' },
  { value: 'restore_block', label: 'Restore' },
  { value: 'purge_block', label: 'Purge' },
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
            <SelectItem key={opType.value} value={opType.value}>
              {opType.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
