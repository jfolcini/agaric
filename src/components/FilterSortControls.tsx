/**
 * FilterSortControls — sort field selector and order toggle for backlink queries.
 *
 * Renders a dropdown to pick the sort field and a button to toggle
 * ascending/descending order.
 * Extracted from BacklinkFilterBuilder.tsx for testability (#651-R4).
 */

import { ArrowUpDown } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { BacklinkSort } from '../lib/tauri'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FilterSortControlsProps {
  sort: BacklinkSort | null
  propertyKeys: string[]
  onSortTypeChange: (value: string) => void
  onSortDirToggle: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FilterSortControls({
  sort,
  propertyKeys,
  onSortTypeChange,
  onSortDirToggle,
}: FilterSortControlsProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <span className="ml-auto flex items-center gap-1">
      <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      <Select
        value={sort ? (sort.type === 'Created' ? 'Created' : sort.key) : '__none__'}
        onValueChange={(val) => onSortTypeChange(val === '__none__' ? '' : val)}
      >
        <SelectTrigger size="sm" aria-label={t('backlink.sortByLabel')} className="px-1.5">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('backlink.defaultOrderOption')}</SelectItem>
          <SelectItem value="Created">{t('backlink.createdOption')}</SelectItem>
          {propertyKeys.map((k) => (
            <SelectItem key={k} value={k}>
              {k}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="xs"
        className="h-7 px-1 text-xs [@media(pointer:coarse)]:min-h-[44px]"
        onClick={onSortDirToggle}
        disabled={!sort}
        aria-label={
          sort
            ? t('backlink.toggleSortLabel', {
                direction: sort.dir === 'Asc' ? 'ascending' : 'descending',
              })
            : t('backlink.toggleSortDefault')
        }
      >
        {sort?.dir === 'Asc' ? t('backlink.ascSort') : t('backlink.descSort')}
      </Button>
    </span>
  )
}
