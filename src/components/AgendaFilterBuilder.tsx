/**
 * AgendaFilterBuilder -- pill-based filter builder for the agenda view.
 *
 * Controlled component: parent owns `filters` state.
 * Renders active filters as removable chips and provides an "Add filter"
 * popover flow: pick a dimension, then pick values via checkboxes or text
 * input.  Chips are editable via click (opens an inline popover).
 */

import { ArrowUpDown, Filter, Layers, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { AgendaGroupBy, AgendaSortBy } from '../lib/agenda-sort'
import i18n from '../lib/i18n'
import { listPropertyKeys } from '../lib/tauri'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgendaFilterDimension =
  | 'status'
  | 'priority'
  | 'dueDate'
  | 'scheduledDate'
  | 'completedDate'
  | 'createdDate'
  | 'tag'
  | 'property'

export interface AgendaFilter {
  dimension: AgendaFilterDimension
  values: string[] // e.g. ['TODO','DOING'] for status, ['1','2'] for priority
}

export interface AgendaFilterBuilderProps {
  filters: AgendaFilter[]
  onFiltersChange: (filters: AgendaFilter[]) => void
}

// ---------------------------------------------------------------------------
// Dimension metadata
// ---------------------------------------------------------------------------

/** Read custom task states from localStorage, filtering out nulls. */
export function getTaskStates(): string[] {
  try {
    const stored = localStorage.getItem('task_cycle')
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0)
      }
    }
  } catch {}
  return ['TODO', 'DOING', 'DONE']
}

const DIMENSION_OPTIONS: Record<
  AgendaFilterDimension,
  { labelKey: string; choices: string[] | null | (() => string[]) }
> = {
  status: { labelKey: 'agendaFilter.status', choices: getTaskStates },
  priority: { labelKey: 'agendaFilter.priority', choices: ['1', '2', '3'] },
  dueDate: {
    labelKey: 'agendaFilter.dueDate',
    choices: [
      'Today',
      'This week',
      'This month',
      'Overdue',
      'Next 7 days',
      'Next 14 days',
      'Next 30 days',
    ],
  },
  scheduledDate: {
    labelKey: 'agendaFilter.scheduledDate',
    choices: [
      'Today',
      'This week',
      'This month',
      'Overdue',
      'Next 7 days',
      'Next 14 days',
      'Next 30 days',
    ],
  },
  completedDate: {
    labelKey: 'agendaFilter.completedDate',
    choices: ['Today', 'This week', 'This month', 'Last 7 days', 'Last 30 days'],
  },
  createdDate: {
    labelKey: 'agendaFilter.createdDate',
    choices: ['Today', 'This week', 'This month', 'Last 7 days', 'Last 30 days'],
  },
  tag: { labelKey: 'agendaFilter.tag', choices: null }, // free-text
  property: { labelKey: 'agendaFilter.property', choices: null }, // dynamic — two-step picker
}

const ALL_DIMENSIONS: AgendaFilterDimension[] = [
  'status',
  'priority',
  'dueDate',
  'scheduledDate',
  'completedDate',
  'createdDate',
  'tag',
  'property',
]

export function dimensionLabel(dim: AgendaFilterDimension): string {
  return i18n.t(DIMENSION_OPTIONS[dim].labelKey)
}

// ---------------------------------------------------------------------------
// ValuePicker -- checkboxes for fixed choices, text input for tag
// ---------------------------------------------------------------------------

interface ValuePickerProps {
  dimension: AgendaFilterDimension
  selected: string[]
  onChange: (values: string[]) => void
}

function ChoiceValuePicker({
  choices,
  label,
  selected,
  onChange,
}: {
  choices: string[]
  label: string
  selected: string[]
  onChange: (values: string[]) => void
}): React.ReactElement {
  return (
    <fieldset
      className="flex flex-col gap-1 border-0 p-0 m-0"
      aria-label={i18n.t('agendaFilter.optionsLabel', { label })}
    >
      <legend className="sr-only">{i18n.t('agendaFilter.optionsLabel', { label })}</legend>
      {choices.map((choice) => {
        const checked = selected.includes(choice)
        return (
          <label
            key={choice}
            className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent cursor-pointer"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => {
                if (checked) {
                  onChange(selected.filter((v) => v !== choice))
                } else {
                  onChange([...selected, choice])
                }
              }}
              className="accent-primary"
            />
            {choice}
          </label>
        )
      })}
    </fieldset>
  )
}

function TextValuePicker({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (values: string[]) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [text, setText] = useState(selected[0] ?? '')
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        className="h-7 text-xs"
        placeholder={t('agendaFilter.tagPlaceholder')}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value.trim()) {
            onChange([e.target.value.trim()])
          } else {
            onChange([])
          }
        }}
        aria-label={t('agendaFilter.tagName')}
      />
    </div>
  )
}

function PropertyValuePicker({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (values: string[]) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [propertyKeys, setPropertyKeys] = useState<string[]>([])
  const [propertyKey, setPropertyKey] = useState(() => {
    if (selected.length > 0) {
      const first = selected[0] as string
      const colonIdx = first.indexOf(':')
      return colonIdx > 0 ? first.slice(0, colonIdx) : first
    }
    return ''
  })
  const [propertyValue, setPropertyValue] = useState(() => {
    if (selected.length > 0) {
      const first = selected[0] as string
      const colonIdx = first.indexOf(':')
      return colonIdx > 0 ? first.slice(colonIdx + 1) : ''
    }
    return ''
  })

  useEffect(() => {
    listPropertyKeys()
      .then(setPropertyKeys)
      .catch(() => setPropertyKeys([]))
  }, [])

  useEffect(() => {
    if (propertyKey) {
      const filterValue = propertyValue ? `${propertyKey}:${propertyValue}` : propertyKey
      onChange([filterValue])
    } else {
      onChange([])
    }
  }, [propertyKey, propertyValue, onChange]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium">
        {t('agendaFilter.propertyKey')}
        <select
          className="h-7 text-xs border rounded px-2 mt-1 block w-full"
          value={propertyKey}
          onChange={(e) => setPropertyKey(e.target.value)}
        >
          <option value="">{t('agendaFilter.selectProperty')}</option>
          {propertyKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="prop-filter-value" className="text-xs font-medium">
        {t('agendaFilter.propertyValue')}
      </label>
      <Input
        id="prop-filter-value"
        className="h-7 text-xs"
        placeholder={t('agendaFilter.propertyValuePlaceholder')}
        value={propertyValue}
        onChange={(e) => setPropertyValue(e.target.value)}
      />
    </div>
  )
}

function ValuePicker({ dimension, selected, onChange }: ValuePickerProps): React.ReactElement {
  const meta = DIMENSION_OPTIONS[dimension]
  const label = dimensionLabel(dimension)
  const choices = typeof meta.choices === 'function' ? meta.choices() : meta.choices

  if (dimension === 'property') {
    return <PropertyValuePicker selected={selected} onChange={onChange} />
  }

  if (choices) {
    return (
      <ChoiceValuePicker choices={choices} label={label} selected={selected} onChange={onChange} />
    )
  }

  return <TextValuePicker selected={selected} onChange={onChange} />
}

// ---------------------------------------------------------------------------
// AddFilterPopover -- dimension selector then value picker
// ---------------------------------------------------------------------------

interface AddFilterPopoverProps {
  existingDimensions: Set<AgendaFilterDimension>
  onAdd: (filter: AgendaFilter) => void
}

function AddFilterPopover({
  existingDimensions,
  onAdd,
}: AddFilterPopoverProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'pick-dimension' | 'pick-values'>('pick-dimension')
  const [dimension, setDimension] = useState<AgendaFilterDimension | null>(null)
  const [values, setValues] = useState<string[]>([])
  const triggerRef = useRef<HTMLButtonElement>(null)

  const reset = useCallback(() => {
    setStep('pick-dimension')
    setDimension(null)
    setValues([])
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (!next) reset()
    },
    [reset],
  )

  const handleSelectDimension = useCallback((dim: AgendaFilterDimension) => {
    setDimension(dim)
    setValues([])
    setStep('pick-values')
  }, [])

  const handleApply = useCallback(() => {
    if (!dimension || values.length === 0) return
    onAdd({ dimension, values })
    setOpen(false)
    reset()
  }, [dimension, values, onAdd, reset])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          size="xs"
          className="h-7 gap-1 text-xs"
          aria-label={t('agendaFilter.addFilter')}
        >
          <Plus size={12} />
          {t('agendaFilter.addFilter')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-3">
        {step === 'pick-dimension' && (
          <ul
            className="flex flex-col gap-1 list-none m-0 p-0"
            aria-label={t('agendaFilter.filterDimensions')}
          >
            {ALL_DIMENSIONS.map((dim) => {
              const alreadyUsed = dim !== 'property' && existingDimensions.has(dim)
              return (
                <li key={dim}>
                  <button
                    type="button"
                    disabled={alreadyUsed}
                    className={cn(
                      'w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
                      alreadyUsed && 'opacity-50 cursor-not-allowed',
                    )}
                    onClick={() => handleSelectDimension(dim)}
                  >
                    {dimensionLabel(dim)}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {step === 'pick-values' && dimension && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium">{dimensionLabel(dimension)}</p>
            <ValuePicker dimension={dimension} selected={values} onChange={setValues} />
            <Button
              size="xs"
              className="h-7 text-xs"
              disabled={values.length === 0}
              onClick={handleApply}
              aria-label={t('agendaFilter.applyFilter')}
            >
              {t('agendaFilter.apply')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// EditFilterPopover -- inline edit popover for an existing chip
// ---------------------------------------------------------------------------

interface EditFilterPopoverProps {
  filter: AgendaFilter
  onUpdate: (values: string[]) => void
  onRemove: () => void
  children: React.ReactNode
}

function EditFilterPopover({
  filter,
  onUpdate,
  onRemove,
  children,
}: EditFilterPopoverProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-3">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium">{dimensionLabel(filter.dimension)}</p>
          <ValuePicker dimension={filter.dimension} selected={filter.values} onChange={onUpdate} />
          <Button
            variant="destructive"
            size="xs"
            className="h-7 text-xs"
            onClick={() => {
              onRemove()
              setOpen(false)
            }}
            aria-label={t('agendaFilter.removeFilterLabel', {
              label: dimensionLabel(filter.dimension),
            })}
          >
            {t('agendaFilter.removeFilter')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AgendaFilterBuilder({
  filters,
  onFiltersChange,
}: AgendaFilterBuilderProps): React.ReactElement {
  const { t } = useTranslation()
  const existingDimensions = new Set(filters.map((f) => f.dimension))

  const handleAdd = useCallback(
    (filter: AgendaFilter) => {
      onFiltersChange([...filters, filter])
    },
    [filters, onFiltersChange],
  )

  const handleRemove = useCallback(
    (index: number) => {
      onFiltersChange(filters.filter((_, i) => i !== index))
    },
    [filters, onFiltersChange],
  )

  const handleUpdate = useCallback(
    (index: number, values: string[]) => {
      const next = filters.map((f, i) => (i === index ? { ...f, values } : f))
      onFiltersChange(next)
    },
    [filters, onFiltersChange],
  )

  return (
    <fieldset
      className="agenda-filter-builder border-0 p-0 m-0"
      data-testid="agenda-filter-builder"
      aria-label={t('agendaFilter.agendaFilters')}
    >
      <legend className="sr-only">{t('agendaFilter.agendaFilters')}</legend>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {filters.length === 1
          ? t('agendaFilter.filterAppliedOne')
          : t('agendaFilter.filtersApplied', { count: filters.length })}
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto">
        <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />

        {filters.length > 0 && (
          <ul aria-label={t('agendaFilter.appliedFilters')} className="contents list-none m-0 p-0">
            {filters.map((filter, idx) => (
              <li key={filter.dimension} className="contents">
                <div className="flex items-center gap-0 rounded-full bg-muted text-xs shrink-0">
                  <EditFilterPopover
                    filter={filter}
                    onUpdate={(values) => handleUpdate(idx, values)}
                    onRemove={() => handleRemove(idx)}
                  >
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-l-full px-2 py-1 hover:bg-accent cursor-pointer"
                      aria-label={t('agendaFilter.editFilter', {
                        label: dimensionLabel(filter.dimension),
                      })}
                    >
                      <span className="font-medium">{dimensionLabel(filter.dimension)}:</span>
                      <span>{filter.values.join(', ')}</span>
                    </button>
                  </EditFilterPopover>
                  <button
                    type="button"
                    className="rounded-r-full px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-accent"
                    onClick={() => handleRemove(idx)}
                    aria-label={t('agendaFilter.removeFilterLabel', {
                      label: dimensionLabel(filter.dimension),
                    })}
                  >
                    <X size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <AddFilterPopover existingDimensions={existingDimensions} onAdd={handleAdd} />

        {filters.length >= 2 && (
          <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
            {t('agendaFilter.combinedWithAnd')}
          </span>
        )}
      </div>
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// AgendaSortGroupControls — sort/group toolbar dropdowns
// ---------------------------------------------------------------------------

const GROUP_OPTIONS: { value: AgendaGroupBy; labelKey: string }[] = [
  { value: 'date', labelKey: 'agenda.groupDate' },
  { value: 'priority', labelKey: 'agenda.groupPriority' },
  { value: 'state', labelKey: 'agenda.groupState' },
  { value: 'none', labelKey: 'agenda.groupNone' },
]

const SORT_OPTIONS: { value: AgendaSortBy; labelKey: string }[] = [
  { value: 'date', labelKey: 'agenda.sortDate' },
  { value: 'priority', labelKey: 'agenda.sortPriority' },
  { value: 'state', labelKey: 'agenda.sortState' },
]

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
  const [groupOpen, setGroupOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)

  const groupLabel = GROUP_OPTIONS.find((o) => o.value === groupBy)
  const sortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)

  return (
    <div
      className="agenda-sort-group-controls flex items-center gap-1.5"
      data-testid="agenda-sort-group-controls"
      role="toolbar"
      aria-label={`${t('agenda.sortBy')} / ${t('agenda.groupBy')}`}
    >
      {/* Group by */}
      <Popover open={groupOpen} onOpenChange={setGroupOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-accent cursor-pointer"
            aria-label={t('agenda.groupBy')}
          >
            <Layers size={12} aria-hidden="true" />
            <span className="font-medium">{t('agenda.groupBy')}:</span>
            <span>{groupLabel ? t(groupLabel.labelKey) : groupBy}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-40 p-1">
          <ul className="flex flex-col gap-0.5 list-none m-0 p-0" aria-label={t('agenda.groupBy')}>
            {GROUP_OPTIONS.map((opt) => (
              <li key={opt.value}>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer',
                    opt.value === groupBy && 'bg-accent font-medium',
                  )}
                  onClick={() => {
                    onGroupByChange(opt.value)
                    setGroupOpen(false)
                  }}
                  aria-current={opt.value === groupBy ? 'true' : undefined}
                >
                  {t(opt.labelKey)}
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>

      {/* Sort by */}
      <Popover open={sortOpen} onOpenChange={setSortOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-accent cursor-pointer"
            aria-label={t('agenda.sortBy')}
          >
            <ArrowUpDown size={12} aria-hidden="true" />
            <span className="font-medium">{t('agenda.sortBy')}:</span>
            <span>{sortLabel ? t(sortLabel.labelKey) : sortBy}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-40 p-1">
          <ul className="flex flex-col gap-0.5 list-none m-0 p-0" aria-label={t('agenda.sortBy')}>
            {SORT_OPTIONS.map((opt) => (
              <li key={opt.value}>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer',
                    opt.value === sortBy && 'bg-accent font-medium',
                  )}
                  onClick={() => {
                    onSortByChange(opt.value)
                    setSortOpen(false)
                  }}
                  aria-current={opt.value === sortBy ? 'true' : undefined}
                >
                  {t(opt.labelKey)}
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  )
}
