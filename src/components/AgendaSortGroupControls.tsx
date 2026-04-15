import type { LucideIcon } from 'lucide-react'
import { ArrowUpDown, Layers } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { cn } from '@/lib/utils'
import type { AgendaGroupBy, AgendaSortBy } from '../lib/agenda-sort'

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

interface DropdownSelectorProps<T extends string> {
  icon: LucideIcon
  label: string
  currentValue: T
  currentLabel: string | undefined
  options: ReadonlyArray<{ value: T; labelKey: string }>
  onChange: (value: T) => void
}

function DropdownSelector<T extends string>({
  icon: Icon,
  label,
  currentValue,
  currentLabel,
  options,
  onChange,
}: DropdownSelectorProps<T>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-full bg-muted',
            'px-2.5 py-1 text-xs hover:bg-accent cursor-pointer [@media(pointer:coarse)]:min-h-[44px]',
          )}
          aria-label={t(label)}
        >
          <Icon className="h-3 w-3" aria-hidden="true" />
          <span className="font-medium">{t(label)}:</span>
          <span>{currentLabel ?? currentValue}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-40 p-1 max-w-[calc(100vw-2rem)]">
        <ul className="flex flex-col gap-0.5 list-none m-0 p-0" aria-label={t(label)}>
          {options.map((opt) => (
            <li key={opt.value}>
              <PopoverMenuItem
                active={opt.value === currentValue}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                aria-current={opt.value === currentValue ? 'true' : undefined}
              >
                {t(opt.labelKey)}
              </PopoverMenuItem>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
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

  const groupLabel = GROUP_OPTIONS.find((o) => o.value === groupBy)
  const sortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)

  return (
    <div
      className="agenda-sort-group-controls flex items-center gap-1.5"
      data-testid="agenda-sort-group-controls"
      role="toolbar"
      aria-label={`${t('agenda.sortBy')} / ${t('agenda.groupBy')}`}
    >
      <DropdownSelector
        icon={Layers}
        label="agenda.groupBy"
        currentValue={groupBy}
        currentLabel={groupLabel ? t(groupLabel.labelKey) : undefined}
        options={GROUP_OPTIONS}
        onChange={onGroupByChange}
      />
      <DropdownSelector
        icon={ArrowUpDown}
        label="agenda.sortBy"
        currentValue={sortBy}
        currentLabel={sortLabel ? t(sortLabel.labelKey) : undefined}
        options={SORT_OPTIONS}
        onChange={onSortByChange}
      />
    </div>
  )
}
