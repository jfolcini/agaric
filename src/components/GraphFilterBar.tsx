/**
 * GraphFilterBar — multi-dimension filter UI for the graph view (UX-205).
 *
 * Shows each active filter as a removable pill, plus an "Add filter" button
 * that opens a popover for picking a dimension and value. Built on top of
 * `FilterPill`, Radix `Popover`, and `Select` primitives — no custom
 * overlays or classes.
 *
 * Controlled component: parent owns the `filters` array and receives change
 * notifications via `onFiltersChange`. Duplicate filters of the same type are
 * replaced rather than stacked.
 */

import { Filter, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GRAPH_PRIORITY_VALUES,
  GRAPH_STATUS_VALUES,
  type GraphFilter,
  type GraphFilterType,
  getGraphFilterKey,
} from '@/lib/graph-filters'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { FilterPill } from './ui/filter-pill'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/** Tag shape accepted by the tag-dimension selector. Compatible with `TagCacheRow`. */
export interface GraphFilterBarTag {
  tag_id: string
  name: string
}

export interface GraphFilterBarProps {
  /** Current filter list. Controlled. */
  filters: GraphFilter[]
  /** Called with the next filter list whenever the user adds/removes/clears. */
  onFiltersChange: (filters: GraphFilter[]) => void
  /** Tag catalogue used to populate the tag dimension. */
  allTags: GraphFilterBarTag[]
  /** Optional total count of pages — used for the "showing N of M" label. */
  totalCount?: number | undefined
  /** Optional filtered count of pages — used for the "showing N of M" label. */
  filteredCount?: number | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a single filter (used inside the pill). */
// biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
function filterLabel(filter: GraphFilter, t: (...args: any[]) => any): string {
  switch (filter.type) {
    case 'tag':
      return `${t('graph.filter.tag')}: ${filter.tagIds.length}`
    case 'status':
      return `${t('graph.filter.status')}: ${filter.values.join(', ')}`
    case 'priority':
      return `${t('graph.filter.priority')}: ${filter.values.join(', ')}`
    case 'hasDueDate':
      return `${t('graph.filter.hasDueDate')}: ${filter.value ? t('graph.filter.yes') : t('graph.filter.no')}`
    case 'hasScheduledDate':
      return `${t('graph.filter.hasScheduledDate')}: ${filter.value ? t('graph.filter.yes') : t('graph.filter.no')}`
    case 'hasBacklinks':
      return `${t('graph.filter.hasBacklinks')}: ${filter.value ? t('graph.filter.yes') : t('graph.filter.no')}`
    case 'excludeTemplates':
      return t('graph.filter.excludeTemplates')
  }
}

// ---------------------------------------------------------------------------
// Add-filter popover contents
// ---------------------------------------------------------------------------

interface AddFilterFormProps {
  allTags: GraphFilterBarTag[]
  existingFilters: GraphFilter[]
  onApply: (filter: GraphFilter) => void
  onCancel: () => void
}

function AddFilterForm({
  allTags,
  existingFilters,
  onApply,
  onCancel,
}: AddFilterFormProps): React.ReactElement {
  const { t } = useTranslation()

  const [dimension, setDimension] = useState<GraphFilterType | ''>('')

  // Per-dimension state — kept separate so switching dimensions doesn't clobber
  // half-typed values.
  const [tagIds, setTagIds] = useState<string[]>([])
  const [statusValues, setStatusValues] = useState<string[]>([])
  const [priorityValues, setPriorityValues] = useState<string[]>([])
  const [boolValue, setBoolValue] = useState<'true' | 'false'>('true')

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      if (!dimension) return
      let filter: GraphFilter
      switch (dimension) {
        case 'tag':
          filter = { type: 'tag', tagIds }
          break
        case 'status':
          filter = { type: 'status', values: statusValues }
          break
        case 'priority':
          filter = { type: 'priority', values: priorityValues }
          break
        case 'hasDueDate':
          filter = { type: 'hasDueDate', value: boolValue === 'true' }
          break
        case 'hasScheduledDate':
          filter = { type: 'hasScheduledDate', value: boolValue === 'true' }
          break
        case 'hasBacklinks':
          filter = { type: 'hasBacklinks', value: boolValue === 'true' }
          break
        case 'excludeTemplates':
          filter = { type: 'excludeTemplates', value: true }
          break
      }
      onApply(filter)
    },
    [dimension, tagIds, statusValues, priorityValues, boolValue, onApply],
  )

  const toggleMultiValue = useCallback(
    (current: string[], value: string): string[] =>
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    [],
  )

  // Dimensions already in use should be hidden from the "add" selector so the
  // user can't stack duplicates (replacement would be confusing).
  const usedTypes = useMemo(() => new Set(existingFilters.map((f) => f.type)), [existingFilters])

  return (
    <form
      className="flex flex-col gap-2"
      aria-label={t('graph.filter.addFilter')}
      onSubmit={handleSubmit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <Select
        value={dimension || '__none__'}
        onValueChange={(val) => setDimension(val === '__none__' ? '' : (val as GraphFilterType))}
      >
        <SelectTrigger size="sm" aria-label={t('graph.filter.selectDimension')}>
          <SelectValue placeholder={t('graph.filter.selectDimension')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('graph.filter.selectDimension')}</SelectItem>
          {!usedTypes.has('tag') && <SelectItem value="tag">{t('graph.filter.tag')}</SelectItem>}
          {!usedTypes.has('status') && (
            <SelectItem value="status">{t('graph.filter.status')}</SelectItem>
          )}
          {!usedTypes.has('priority') && (
            <SelectItem value="priority">{t('graph.filter.priority')}</SelectItem>
          )}
          {!usedTypes.has('hasDueDate') && (
            <SelectItem value="hasDueDate">{t('graph.filter.hasDueDate')}</SelectItem>
          )}
          {!usedTypes.has('hasScheduledDate') && (
            <SelectItem value="hasScheduledDate">{t('graph.filter.hasScheduledDate')}</SelectItem>
          )}
          {!usedTypes.has('hasBacklinks') && (
            <SelectItem value="hasBacklinks">{t('graph.filter.hasBacklinks')}</SelectItem>
          )}
          {!usedTypes.has('excludeTemplates') && (
            <SelectItem value="excludeTemplates">{t('graph.filter.excludeTemplates')}</SelectItem>
          )}
        </SelectContent>
      </Select>

      {dimension === 'tag' && (
        <fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
          <legend className="sr-only">{t('graph.filter.tagPlural')}</legend>
          {allTags.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('graph.filter.tagNoTags')}</p>
          ) : (
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {allTags.map((tag) => (
                <label
                  key={tag.tag_id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={tagIds.includes(tag.tag_id)}
                    onChange={() => setTagIds((c) => toggleMultiValue(c, tag.tag_id))}
                    aria-label={tag.name}
                  />
                  <span>{tag.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      {dimension === 'status' && (
        <fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
          <legend className="sr-only">{t('graph.filter.status')}</legend>
          <div className="flex flex-col gap-1">
            {GRAPH_STATUS_VALUES.map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={statusValues.includes(v)}
                  onChange={() => setStatusValues((c) => toggleMultiValue(c, v))}
                  aria-label={t(`graph.filter.statusValue.${v}`)}
                />
                <span>{t(`graph.filter.statusValue.${v}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {dimension === 'priority' && (
        <fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
          <legend className="sr-only">{t('graph.filter.priority')}</legend>
          <div className="flex flex-col gap-1">
            {GRAPH_PRIORITY_VALUES.map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={priorityValues.includes(v)}
                  onChange={() => setPriorityValues((c) => toggleMultiValue(c, v))}
                  aria-label={t(`graph.filter.priorityValue.${v}`)}
                />
                <span>{t(`graph.filter.priorityValue.${v}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {(dimension === 'hasDueDate' ||
        dimension === 'hasScheduledDate' ||
        dimension === 'hasBacklinks') && (
        <Select value={boolValue} onValueChange={(val) => setBoolValue(val as 'true' | 'false')}>
          <SelectTrigger
            size="sm"
            aria-label={t(`graph.filter.${dimension}` as `graph.filter.${GraphFilterType}`)}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">{t('graph.filter.yes')}</SelectItem>
            <SelectItem value="false">{t('graph.filter.no')}</SelectItem>
          </SelectContent>
        </Select>
      )}

      {dimension === 'excludeTemplates' && (
        <p className="text-xs text-muted-foreground">{t('graph.filter.excludeTemplates')}</p>
      )}

      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onCancel}
          aria-label={t('graph.filter.cancel')}
        >
          {t('graph.filter.cancel')}
        </Button>
        <Button
          type="submit"
          variant="default"
          size="xs"
          disabled={!dimension}
          aria-label={t('graph.filter.apply')}
        >
          {t('graph.filter.apply')}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GraphFilterBar({
  filters,
  onFiltersChange,
  allTags,
  totalCount,
  filteredCount,
}: GraphFilterBarProps): React.ReactElement {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = useState(false)

  const handleAdd = useCallback(
    (filter: GraphFilter) => {
      // Replace existing filter of the same type (prevents duplicate pills).
      const key = getGraphFilterKey(filter)
      const withoutSameType = filters.filter((f) => f.type !== filter.type)
      const isExact = filters.some((f) => getGraphFilterKey(f) === key)
      if (isExact) {
        setPopoverOpen(false)
        return
      }
      onFiltersChange([...withoutSameType, filter])
      setPopoverOpen(false)
    },
    [filters, onFiltersChange],
  )

  const handleRemove = useCallback(
    (index: number) => {
      onFiltersChange(filters.filter((_, i) => i !== index))
    },
    [filters, onFiltersChange],
  )

  const handleClearAll = useCallback(() => {
    onFiltersChange([])
  }, [onFiltersChange])

  const hasFilters = filters.length > 0
  const showingCount =
    typeof totalCount === 'number' &&
    typeof filteredCount === 'number' &&
    hasFilters &&
    totalCount !== filteredCount

  return (
    <fieldset
      className="graph-filter-bar flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background/80 p-2 backdrop-blur-sm"
      aria-label={t('graph.filter.addFilter')}
      data-testid="graph-filter-bar"
    >
      <legend className="sr-only">{t('graph.filter.addFilter')}</legend>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {t('graph.filter.filtersApplied', { count: filters.length })}
      </div>

      <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />

      {filters.map((filter, i) => {
        const label = filterLabel(filter, t)
        return (
          <FilterPill
            key={`${filter.type}-${getGraphFilterKey(filter)}`}
            label={label}
            removeAriaLabel={t('graph.filter.removeFilter', { label })}
            onRemove={() => handleRemove(i)}
          />
        )
      })}

      {!hasFilters && (
        <Badge variant="outline" className="text-xs text-muted-foreground">
          {t('graph.filter.noFilters')}
        </Badge>
      )}

      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            className="h-7 gap-1 text-xs"
            aria-label={t('graph.filter.addFilter')}
            aria-expanded={popoverOpen}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {t('graph.filter.addFilter')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start">
          <AddFilterForm
            allTags={allTags}
            existingFilters={filters}
            onApply={handleAdd}
            onCancel={() => setPopoverOpen(false)}
          />
        </PopoverContent>
      </Popover>

      {hasFilters && (
        <Button
          variant="ghost"
          size="xs"
          className="h-7 text-xs"
          onClick={handleClearAll}
          aria-label={t('graph.filter.clearAll')}
        >
          <X className="h-3 w-3" aria-hidden="true" />
          {t('graph.filter.clearAll')}
        </Button>
      )}

      {showingCount && (
        <span
          className="ml-auto text-xs text-muted-foreground"
          aria-live="polite"
          aria-atomic="true"
          data-testid="graph-filter-count"
        >
          {t('graph.filter.showingCount', { filtered: filteredCount, total: totalCount })}
        </span>
      )}
    </fieldset>
  )
}
