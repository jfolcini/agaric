/**
 * BacklinkFilterBuilder -- pill-based filter builder for backlink queries.
 *
 * Controlled component: parent owns `filters` and `sort` state.
 * Renders active filters as removable pills and provides an "Add filter" flow.
 *
 * Filter pills are rendered by `FilterPillRow`; sort controls by
 * `FilterSortControls`. Both were extracted for testability (#651-R4).
 */

import { Filter, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { BacklinkFilter, BacklinkSort, SortDir } from '../lib/tauri'
import { AddFilterRow } from './backlink-filter/AddFilterRow'
import { FilterPillRow } from './FilterPillRow'
import { FilterSortControls } from './FilterSortControls'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BacklinkFilterBuilderProps {
  filters: BacklinkFilter[]
  sort: BacklinkSort | null
  onFiltersChange: (filters: BacklinkFilter[]) => void
  onSortChange: (sort: BacklinkSort | null) => void
  totalCount: number
  filteredCount: number
  propertyKeys: string[]
  tags: Array<{ id: string; name: string }>
  tagResolver?: (id: string) => string
}

// ---------------------------------------------------------------------------
// Structural filter key (for duplicate detection — #329)
// ---------------------------------------------------------------------------

function getFilterKey(filter: BacklinkFilter): string {
  switch (filter.type) {
    case 'BlockType':
      return `BlockType:${filter.block_type}`
    case 'PropertyText':
      return `PropertyText:${filter.key}:${filter.op}:${filter.value}`
    case 'PropertyNum':
      return `PropertyNum:${filter.key}:${filter.op}:${filter.value}`
    case 'PropertyDate':
      return `PropertyDate:${filter.key}:${filter.op}:${filter.value}`
    case 'PropertyIsSet':
      return `PropertyIsSet:${filter.key}`
    case 'PropertyIsEmpty':
      return `PropertyIsEmpty:${filter.key}`
    case 'Contains':
      return `Contains:${filter.query}`
    case 'CreatedInRange':
      return `CreatedInRange:${filter.after ?? ''}:${filter.before ?? ''}`
    case 'HasTag':
      return `HasTag:${filter.tag_id}`
    case 'HasTagPrefix':
      return `HasTagPrefix:${filter.prefix}`
    default:
      return JSON.stringify(filter)
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BacklinkFilterBuilder({
  filters,
  sort,
  onFiltersChange,
  onSortChange,
  totalCount,
  filteredCount,
  propertyKeys,
  tags,
  tagResolver,
}: BacklinkFilterBuilderProps): React.ReactElement {
  const { t } = useTranslation()
  const [showAddRow, setShowAddRow] = useState(false)
  const addFilterButtonRef = useRef<HTMLButtonElement>(null)

  const handleAddFilter = useCallback(
    (filter: BacklinkFilter) => {
      const key = getFilterKey(filter)
      const isDuplicate = filters.some((f) => getFilterKey(f) === key)
      if (isDuplicate) {
        toast.error(t('backlink.filterAlreadyApplied'))
        setShowAddRow(false)
        return
      }
      onFiltersChange([...filters, filter])
      setShowAddRow(false)
      requestAnimationFrame(() => addFilterButtonRef.current?.focus())
    },
    [filters, onFiltersChange, t],
  )

  const handleRemoveFilter = useCallback(
    (index: number) => {
      const next = filters.filter((_, i) => i !== index)
      onFiltersChange(next)
      requestAnimationFrame(() => addFilterButtonRef.current?.focus())
    },
    [filters, onFiltersChange],
  )

  const handleClearAll = useCallback(() => {
    onFiltersChange([])
    onSortChange(null)
    requestAnimationFrame(() => addFilterButtonRef.current?.focus())
  }, [onFiltersChange, onSortChange])

  const handleSortTypeChange = useCallback(
    (value: string) => {
      if (value === '') {
        onSortChange(null)
        return
      }
      const dir: SortDir = sort?.dir ?? 'Desc'
      if (value === 'Created') {
        onSortChange({ type: 'Created', dir })
      } else {
        onSortChange({ type: 'PropertyText', key: value, dir })
      }
    },
    [sort, onSortChange],
  )

  const handleSortDirToggle = useCallback(() => {
    if (!sort) return
    const newDir: SortDir = sort.dir === 'Asc' ? 'Desc' : 'Asc'
    onSortChange({ ...sort, dir: newDir })
  }, [sort, onSortChange])

  const hasFilters = filters.length > 0 || sort !== null

  return (
    <fieldset
      className="backlink-filter-builder space-y-2 border-0 p-0 m-0"
      aria-label={t('backlink.filtersLabel')}
    >
      <legend className="sr-only">{t('backlink.filtersLegend')}</legend>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {t('backlink.filtersApplied', { count: filters.length })}
      </div>

      {/* Filter pills + Add button row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />

        <FilterPillRow filters={filters} onRemove={handleRemoveFilter} tagResolver={tagResolver} />

        <Button
          ref={addFilterButtonRef}
          variant="outline"
          size="xs"
          className="add-filter-button h-7 gap-1 text-xs"
          onClick={() => setShowAddRow(true)}
          aria-label={t('backlink.addFilterLabel')}
        >
          {t('backlink.addFilterLabel')}
        </Button>

        {hasFilters && (
          <Button
            variant="ghost"
            size="xs"
            className="clear-all-button h-7 text-xs"
            onClick={handleClearAll}
            aria-label={t('backlink.clearAllLabel')}
          >
            <X className="h-3 w-3" />
            {t('backlink.clearAllButton')}
          </Button>
        )}

        {/* Sort control */}
        <FilterSortControls
          sort={sort}
          propertyKeys={propertyKeys}
          onSortTypeChange={handleSortTypeChange}
          onSortDirToggle={handleSortDirToggle}
        />
      </div>

      {/* Add filter row */}
      {showAddRow && (
        <AddFilterRow
          propertyKeys={propertyKeys}
          tags={tags}
          onApply={handleAddFilter}
          onCancel={() => {
            setShowAddRow(false)
            requestAnimationFrame(() => addFilterButtonRef.current?.focus())
          }}
        />
      )}

      {/* Count display */}
      {hasFilters && (
        <p
          className="filter-count text-xs text-muted-foreground"
          aria-live="polite"
          aria-atomic="true"
        >
          {t('backlink.showingCount', { filtered: filteredCount, total: totalCount })}
        </p>
      )}
    </fieldset>
  )
}
