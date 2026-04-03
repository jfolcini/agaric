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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgendaFilterDimension = 'status' | 'priority' | 'dueDate' | 'tag'

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

const DIMENSION_OPTIONS: Record<
  AgendaFilterDimension,
  { label: string; choices: string[] | null }
> = {
  status: { label: 'Status', choices: ['TODO', 'DOING', 'DONE'] },
  priority: { label: 'Priority', choices: ['1', '2', '3'] },
  dueDate: { label: 'Due date', choices: ['Today', 'This week', 'Overdue', 'Next 7 days'] },
  tag: { label: 'Tag', choices: null }, // free-text
}

const ALL_DIMENSIONS: AgendaFilterDimension[] = ['status', 'priority', 'dueDate', 'tag']

export function dimensionLabel(dim: AgendaFilterDimension): string {
  return DIMENSION_OPTIONS[dim].label
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
    <fieldset className="flex flex-col gap-1 border-0 p-0 m-0" aria-label={`${label} options`}>
      <legend className="sr-only">{label} options</legend>
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
  const [text, setText] = useState(selected[0] ?? '')
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        className="h-7 text-xs"
        placeholder="Tag name prefix..."
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value.trim()) {
            onChange([e.target.value.trim()])
          } else {
            onChange([])
          }
        }}
        aria-label="Tag name"
      />
    </div>
  )
}

function ValuePicker({ dimension, selected, onChange }: ValuePickerProps): React.ReactElement {
  const meta = DIMENSION_OPTIONS[dimension]

  if (meta.choices) {
    return (
      <ChoiceValuePicker
        choices={meta.choices}
        label={meta.label}
        selected={selected}
        onChange={onChange}
      />
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
          aria-label="Add filter"
        >
          <Plus size={12} />
          Add filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-3">
        {step === 'pick-dimension' && (
          <ul className="flex flex-col gap-1 list-none m-0 p-0" aria-label="Filter dimensions">
            {ALL_DIMENSIONS.map((dim) => {
              const alreadyUsed = existingDimensions.has(dim)
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
              aria-label="Apply filter"
            >
              Apply
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
            aria-label={`Remove ${dimensionLabel(filter.dimension)} filter`}
          >
            Remove filter
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
    <fieldset className="agenda-filter-builder border-0 p-0 m-0" aria-label="Agenda filters">
      <legend className="sr-only">Agenda filters</legend>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {filters.length} filter{filters.length === 1 ? '' : 's'} applied
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto">
        <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />

        {filters.length > 0 && (
          <ul aria-label="Applied filters" className="contents list-none m-0 p-0">
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
                      aria-label={`Edit ${dimensionLabel(filter.dimension)} filter`}
                    >
                      <span className="font-medium">{dimensionLabel(filter.dimension)}:</span>
                      <span>{filter.values.join(', ')}</span>
                    </button>
                  </EditFilterPopover>
                  <button
                    type="button"
                    className="rounded-r-full px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-accent"
                    onClick={() => handleRemove(idx)}
                    aria-label={`Remove ${dimensionLabel(filter.dimension)} filter`}
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
            Filters combined with AND
          </span>
        )}
      </div>
    </fieldset>
  )
}
