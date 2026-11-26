/**
 * AgendaSortGroupControls — the Agenda's one View button, opening its Group by
 * and Sort by choices (#7040), a bottom sheet on a phone. It reads as a button,
 * not one more filter chip; the filters stay chips.
 */

import { Check, ChevronDown } from 'lucide-react'
import type React from 'react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import type { AgendaGroupBy, AgendaSortBy } from '@/lib/agenda-sort'

const GROUP_OPTIONS: { value: AgendaGroupBy; labelKey: string }[] = [
  { value: 'date', labelKey: 'agenda.groupDate' },
  { value: 'priority', labelKey: 'agenda.groupPriority' },
  { value: 'state', labelKey: 'agenda.groupState' },
  { value: 'page', labelKey: 'agenda.groupPage' },
  { value: 'none', labelKey: 'agenda.groupNone' },
]

const SORT_OPTIONS: { value: AgendaSortBy; labelKey: string }[] = [
  { value: 'date', labelKey: 'agenda.sortDate' },
  { value: 'priority', labelKey: 'agenda.sortPriority' },
  { value: 'state', labelKey: 'agenda.sortState' },
  { value: 'page', labelKey: 'agenda.sortPage' },
]

interface ChoiceListProps<T extends string> {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; labelKey: string }>
  onChange: (value: T) => void
}

function ChoiceList<T extends string>({ label, value, options, onChange }: ChoiceListProps<T>) {
  const { t } = useTranslation()
  const labelId = useId()
  return (
    <div>
      <p id={labelId} className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-labelledby={labelId}>
        {options.map((opt) => (
          <li key={opt.value}>
            <PopoverMenuItem
              className="flex items-center justify-between"
              active={opt.value === value}
              aria-current={opt.value === value ? 'true' : undefined}
              onClick={() => onChange(opt.value)}
            >
              {t(opt.labelKey)}
              {opt.value === value && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            </PopoverMenuItem>
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface AgendaSortGroupControlsProps {
  groupBy: AgendaGroupBy
  onGroupByChange: (value: AgendaGroupBy) => void
  sortBy: AgendaSortBy
  onSortByChange: (value: AgendaSortBy) => void
}

export function AgendaSortGroupControls({
  groupBy,
  onGroupByChange,
  sortBy,
  onSortByChange,
}: AgendaSortGroupControlsProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <div className="agenda-sort-group-controls shrink-0" data-testid="agenda-sort-group-controls">
      {/* Open while choosing, so a grouping and a sort are set in one visit. */}
      <Popover open={open} onOpenChange={setOpen} sheetTitle={t('agenda.view')}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="xs" className="[@media(pointer:coarse)]:h-11">
            {t('agenda.view')}
            <ChevronDown aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <MenuPopoverContent align="end" className="w-48" aria-label={t('agenda.view')}>
          <ChoiceList
            label={t('agenda.groupBy')}
            value={groupBy}
            options={GROUP_OPTIONS}
            onChange={onGroupByChange}
          />
          <ChoiceList
            label={t('agenda.sortBy')}
            value={sortBy}
            options={SORT_OPTIONS}
            onChange={onSortByChange}
          />
        </MenuPopoverContent>
      </Popover>
    </div>
  )
}
