/**
 * AgendaFilterBuilder -- pill-based filter builder for the agenda view.
 *
 * Controlled component: parent owns `filters` state.
 * Renders active filters as removable chips and provides a `t('agendaFilter.addFilter')`
 * popover flow: pick a dimension, then pick values via checkboxes or text
 * input.  Chips are editable via click (opens an inline popover).
 */

import { Filter, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import {
  type AgendaFilterDimension,
  DIMENSION_GROUPS,
  DIMENSION_OPTIONS,
  dimensionLabel,
} from '../lib/filter-dimension-metadata'
import { ChoiceValuePicker } from './ChoiceValuePicker'
import { PropertyValuePicker } from './PropertyValuePicker'
import { TagValuePicker } from './TagValuePicker'

export type { AgendaSortGroupControlsProps } from './AgendaSortGroupControls'
export { AgendaSortGroupControls } from './AgendaSortGroupControls'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a property filter's values for human-readable pill display.
 * Parses the colon-separated "key:value" format into "key = value",
 * or just "key" when no value is present.
 */
function formatPropertyPill(values: string[]): string {
  if (values.length === 0) return ''
  const first = values[0]
  if (!first) return ''
  const colonIdx = first.indexOf(':')
  const key = colonIdx > 0 ? first.slice(0, colonIdx) : first
  const value = colonIdx > 0 ? first.slice(colonIdx + 1) : ''
  if (value) return `${key} = ${value}`
  return key
}

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
          <Plus className="h-3 w-3" />
          {t('agendaFilter.addFilter')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-3 max-w-[calc(100vw-2rem)]">
        {step === 'pick-dimension' && (
          // UX-9 — wrap each dimension item in a Tooltip so the
          // distinction between visually-similar dimensions (dueDate vs
          // scheduledDate, completedDate vs createdDate) is discoverable
          // without opening the dimension and trying its values.
          //
          // UX-323 — visually group the 8 dimensions under
          // `t('agendaFilter.group.taskMetadata')` /
          // `t('agendaFilter.group.dates')` /
          // `t('agendaFilter.group.organisation')` headings so users can scan by family
          // before reading individual labels. Group definitions live in
          // DIMENSION_GROUPS (filter-dimension-metadata.ts).
          <TooltipProvider>
            {/* role="group" carries the picker's accessible name (preserving the
                pre-UX-323 single-<ul> semantics); a nested <fieldset> inside the
                AgendaFilterBuilder's outer fieldset would be the wrong
                form-grouping primitive here. */}
            <div
              role="group"
              className="flex flex-col gap-2"
              aria-label={t('agendaFilter.filterDimensions')}
            >
              {DIMENSION_GROUPS.map((group) => (
                <div key={group.labelKey}>
                  <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t(group.labelKey)}
                  </p>
                  <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
                    {group.dimensions.map((dim) => {
                      const alreadyUsed = dim !== 'property' && existingDimensions.has(dim)
                      return (
                        <li key={dim}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              {/* Span wrapper so the tooltip surfaces over disabled
                                  menu items too — disabled buttons swallow pointer
                                  events otherwise. */}
                              <span className="block">
                                <PopoverMenuItem
                                  disabled={alreadyUsed}
                                  onClick={() => handleSelectDimension(dim)}
                                >
                                  {dimensionLabel(dim)}
                                </PopoverMenuItem>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs">
                              {t(`filter.dimension.${dim}.description`)}
                            </TooltipContent>
                          </Tooltip>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </TooltipProvider>
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
            {filters.map((filter, idx) => {
              const isProperty = filter.dimension === 'property'
              const pillLabel = isProperty
                ? formatPropertyPill(filter.values)
                : `${dimensionLabel(filter.dimension)}: ${filter.values.join(', ')}`

              return (
                <li key={filter.dimension} className="contents">
                  {/* UX review Tier 1 item 7 — chip visual chrome aligned
                      with the shared `FilterPill` primitive by adopting
                      `Badge variant="secondary"`. The two-button structure
                      (click-to-edit body + click-to-remove X) is preserved
                      because FilterPill is remove-only; the visual style
                      now matches the other filter surfaces. */}
                  <Badge
                    tone="secondary"
                    data-slot="filter-pill"
                    className="filter-pill shrink-0 gap-0 p-0 text-xs"
                    role="group"
                    aria-label={t('agendaFilter.editFilter', { label: pillLabel })}
                  >
                    <EditFilterPopover
                      filter={filter}
                      onUpdate={(values) => handleUpdate(idx, values)}
                      onRemove={() => handleRemove(idx)}
                    >
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded-l-full px-2 py-0.5 hover:bg-accent cursor-pointer focus-ring-visible"
                        title={pillLabel}
                        aria-label={t('agendaFilter.editFilter', {
                          label: pillLabel,
                        })}
                      >
                        {isProperty ? (
                          <span>{pillLabel}</span>
                        ) : (
                          <>
                            <span className="font-medium">{dimensionLabel(filter.dimension)}:</span>
                            <span>{filter.values.join(', ')}</span>
                          </>
                        )}
                      </button>
                    </EditFilterPopover>
                    <button
                      type="button"
                      className="ml-0.5 inline-flex items-center justify-center rounded-full p-1 hover:bg-muted active:bg-muted active:scale-95 focus-ring-visible [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px] touch-target"
                      onClick={() => handleRemove(idx)}
                      aria-label={t('agendaFilter.removeFilterLabel', {
                        label: isProperty ? pillLabel : dimensionLabel(filter.dimension),
                      })}
                    >
                      <X className="h-3 w-3 [@media(pointer:coarse)]:size-5" />
                    </button>
                  </Badge>
                </li>
              )
            })}
          </ul>
        )}

        {filters.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onFiltersChange([])}
            aria-label={t('agendaFilter.clearAllLabel')}
          >
            <X className="mr-0.5 h-3 w-3" />
            {t('agendaFilter.clearAll')}
          </Button>
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
