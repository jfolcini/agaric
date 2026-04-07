/**
 * AgendaFilterBuilder -- pill-based filter builder for the agenda view.
 *
 * Controlled component: parent owns `filters` state.
 * Renders active filters as removable chips and provides an "Add filter"
 * popover flow: pick a dimension, then pick values via checkboxes or text
 * input.  Chips are editable via click (opens an inline popover).
 */

import { Filter, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import {
  type AgendaFilterDimension,
  ALL_DIMENSIONS,
  DIMENSION_OPTIONS,
  dimensionLabel,
} from '../lib/filter-dimension-metadata'
import { ChoiceValuePicker } from './ChoiceValuePicker'
import { PropertyValuePicker } from './PropertyValuePicker'
import { TagValuePicker } from './TagValuePicker'

// Re-export all previously public symbols for backward compat
export type { AgendaFilterDimension } from '../lib/filter-dimension-metadata'
export {
  ALL_DIMENSIONS,
  DIMENSION_OPTIONS,
  dimensionLabel,
  getTaskStates,
} from '../lib/filter-dimension-metadata'
export type { AgendaSortGroupControlsProps } from './AgendaSortGroupControls'
export { AgendaSortGroupControls } from './AgendaSortGroupControls'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgendaFilter {
  dimension: AgendaFilterDimension
  values: string[] // e.g. ['TODO','DOING'] for status, ['1','2'] for priority
}

export interface AgendaFilterBuilderProps {
  filters: AgendaFilter[]
  onFiltersChange: (filters: AgendaFilter[]) => void
}

// ---------------------------------------------------------------------------
// ValuePicker -- checkboxes for fixed choices, text input for tag
// ---------------------------------------------------------------------------

interface ValuePickerProps {
  dimension: AgendaFilterDimension
  selected: string[]
  onChange: (values: string[]) => void
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

  return <TagValuePicker selected={selected} onChange={onChange} />
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
      <PopoverContent align="start" className="w-56 p-3 max-w-[calc(100vw-2rem)]">
        {step === 'pick-dimension' && (
          <ul
            className="flex flex-col gap-1 list-none m-0 p-0"
            aria-label={t('agendaFilter.filterDimensions')}
          >
            {ALL_DIMENSIONS.map((dim) => {
              const alreadyUsed = dim !== 'property' && existingDimensions.has(dim)
              return (
                <li key={dim}>
                  <PopoverMenuItem
                    disabled={alreadyUsed}
                    onClick={() => handleSelectDimension(dim)}
                  >
                    {dimensionLabel(dim)}
                  </PopoverMenuItem>
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
      <PopoverContent align="start" className="w-56 p-3 max-w-[calc(100vw-2rem)]">
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

      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />

        {filters.length > 0 && (
          <ul aria-label={t('agendaFilter.appliedFilters')} className="contents list-none m-0 p-0">
            {filters.map((filter, idx) => (
              <li key={filter.dimension} className="contents">
                <div className="flex items-center gap-0 rounded-full bg-muted text-xs">
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
