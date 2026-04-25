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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { logger } from '@/lib/logger'
import type { BacklinkFilter, BacklinkSort, CompareOp, SortDir } from '../lib/tauri'
import { listTagsByPrefix } from '../lib/tauri'
import { FilterPillRow } from './FilterPillRow'
import { FilterSortControls } from './FilterSortControls'
import { SearchablePopover } from './SearchablePopover'

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

type FilterCategory =
  | 'type'
  | 'status'
  | 'priority'
  | 'contains'
  | 'property'
  | 'date'
  | 'property-set'
  | 'property-empty'
  | 'has-tag'
  | 'tag-prefix'

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
// Per-category filter builders (extracted from handleApply to reduce complexity)
// ---------------------------------------------------------------------------

interface BuildState {
  blockType: string
  statusValue: string
  priorityValue: string
  containsQuery: string
  propKey: string
  propOp: CompareOp
  propValue: string
  propType: 'text' | 'num' | 'date'
  dateAfter: string
  dateBefore: string
  propSetKey: string
  propEmptyKey: string
  tagValue: string
  prefixValue: string
  propertyKeys: string[]
}

type BuildResult = { filter: BacklinkFilter } | { error: string }
// biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
type TFunc = (...args: any[]) => any

function buildTypeFilter(s: BuildState): BuildResult {
  return { filter: { type: 'BlockType', block_type: s.blockType } }
}

function buildStatusFilter(s: BuildState): BuildResult {
  return { filter: { type: 'PropertyText', key: 'todo', op: 'Eq', value: s.statusValue } }
}

function buildPriorityFilter(s: BuildState): BuildResult {
  return { filter: { type: 'PropertyText', key: 'priority', op: 'Eq', value: s.priorityValue } }
}

function buildContainsFilter(s: BuildState, t: TFunc): BuildResult {
  const query = s.containsQuery.trim()
  if (!query) return { error: t('backlink.searchTextRequired') }
  return { filter: { type: 'Contains', query } }
}

function buildPropertyFilter(s: BuildState, t: TFunc): BuildResult {
  const trimmedKey = s.propKey.trim()
  if (!trimmedKey) return { error: t('backlink.propertyKeyRequired') }
  if (s.propertyKeys.length > 0 && !s.propertyKeys.includes(trimmedKey)) {
    return { error: t('backlink.propertyNotFound', { key: trimmedKey }) }
  }
  if (s.propType === 'num') {
    const numVal = Number.parseFloat(s.propValue)
    if (!Number.isFinite(numVal)) return { error: t('backlink.invalidNumber') }
    return { filter: { type: 'PropertyNum', key: s.propKey, op: s.propOp, value: numVal } }
  }
  if (s.propType === 'date') {
    if (!s.propValue) return { error: t('backlink.dateValueRequired') }
    return {
      filter: { type: 'PropertyDate', key: s.propKey, op: s.propOp, value: s.propValue },
    }
  }
  return { filter: { type: 'PropertyText', key: s.propKey, op: s.propOp, value: s.propValue } }
}

function buildDateFilter(s: BuildState, t: TFunc): BuildResult {
  if (!s.dateAfter && !s.dateBefore) return { error: t('backlink.dateRangeRequired') }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  if (s.dateAfter && !dateRe.test(s.dateAfter)) return { error: t('backlink.invalidDateAfter') }
  if (s.dateBefore && !dateRe.test(s.dateBefore)) {
    return { error: t('backlink.invalidDateBefore') }
  }
  return {
    filter: {
      type: 'CreatedInRange',
      after: s.dateAfter || null,
      before: s.dateBefore || null,
    },
  }
}

function buildPropertySetFilter(s: BuildState, t: TFunc): BuildResult {
  if (!s.propSetKey.trim()) return { error: t('backlink.propertyKeyRequired') }
  return { filter: { type: 'PropertyIsSet', key: s.propSetKey } }
}

function buildPropertyEmptyFilter(s: BuildState, t: TFunc): BuildResult {
  if (!s.propEmptyKey.trim()) return { error: t('backlink.propertyKeyRequired') }
  return { filter: { type: 'PropertyIsEmpty', key: s.propEmptyKey } }
}

function buildHasTagFilter(s: BuildState, t: TFunc): BuildResult {
  const id = s.tagValue.trim()
  if (!id) return { error: t('backlink.tagRequired') }
  return { filter: { type: 'HasTag', tag_id: id } }
}

function buildTagPrefixFilter(s: BuildState, t: TFunc): BuildResult {
  const prefix = s.prefixValue.trim()
  if (!prefix) return { error: t('backlink.tagPrefixRequired') }
  return { filter: { type: 'HasTagPrefix', prefix } }
}

function buildFilterForCategory(
  category: FilterCategory,
  state: BuildState,
  t: TFunc,
): BuildResult {
  switch (category) {
    case 'type':
      return buildTypeFilter(state)
    case 'status':
      return buildStatusFilter(state)
    case 'priority':
      return buildPriorityFilter(state)
    case 'contains':
      return buildContainsFilter(state, t)
    case 'property':
      return buildPropertyFilter(state, t)
    case 'date':
      return buildDateFilter(state, t)
    case 'property-set':
      return buildPropertySetFilter(state, t)
    case 'property-empty':
      return buildPropertyEmptyFilter(state, t)
    case 'has-tag':
      return buildHasTagFilter(state, t)
    case 'tag-prefix':
      return buildTagPrefixFilter(state, t)
  }
}

// ---------------------------------------------------------------------------
// Add-filter row (inline form)
// ---------------------------------------------------------------------------

interface AddFilterRowProps {
  propertyKeys: string[]
  tags: Array<{ id: string; name: string }>
  onApply: (filter: BacklinkFilter) => void
  onCancel: () => void
}

function AddFilterRow({
  propertyKeys,
  tags,
  onApply,
  onCancel,
}: AddFilterRowProps): React.ReactElement {
  const { t } = useTranslation()
  const [category, setCategory] = useState<FilterCategory | ''>('')
  const [blockType, setBlockType] = useState('content')
  const [statusValue, setStatusValue] = useState('TODO')
  const [priorityValue, setPriorityValue] = useState('1')
  const [containsQuery, setContainsQuery] = useState('')
  const [propKey, setPropKey] = useState(propertyKeys[0] ?? '')
  const [propOp, setPropOp] = useState<CompareOp>('Eq')
  const [propValue, setPropValue] = useState('')
  const [propType, setPropType] = useState<'text' | 'num' | 'date'>('text')
  const [dateAfter, setDateAfter] = useState('')
  const [dateBefore, setDateBefore] = useState('')
  const [propSetKey, setPropSetKey] = useState(propertyKeys[0] ?? '')
  const [propEmptyKey, setPropEmptyKey] = useState(propertyKeys[0] ?? '')
  const [tagValue, setTagValue] = useState(tags[0]?.id ?? '')
  const [prefixValue, setPrefixValue] = useState('')

  // -----------------------------------------------------------------------
  // Tag search state (B-72 — searchable tag filter)
  // -----------------------------------------------------------------------
  const [tagSearchOpen, setTagSearchOpen] = useState(false)
  const [tagSearchQuery, setTagSearchQuery] = useState('')
  const [tagSearchResults, setTagSearchResults] = useState<Array<{ id: string; name: string }>>([])
  const [tagSearchLoading, setTagSearchLoading] = useState(false)

  const debouncedTagSearch = useDebouncedCallback((query: string) => {
    setTagSearchLoading(true)
    listTagsByPrefix({ prefix: query, limit: 50 })
      .then((rows) => {
        setTagSearchResults(rows.map((r) => ({ id: r.tag_id, name: r.name })))
      })
      .catch((err) => {
        logger.warn('Tag search failed', err)
      })
      .finally(() => {
        setTagSearchLoading(false)
      })
  }, 150)

  useEffect(() => {
    if (tagSearchOpen) {
      debouncedTagSearch.schedule(tagSearchQuery)
    } else {
      debouncedTagSearch.cancel()
    }
  }, [tagSearchQuery, tagSearchOpen, debouncedTagSearch])

  const handleApply = useCallback(() => {
    if (!category) return
    const result = buildFilterForCategory(
      category,
      {
        blockType,
        statusValue,
        priorityValue,
        containsQuery,
        propKey,
        propOp,
        propValue,
        propType,
        dateAfter,
        dateBefore,
        propSetKey,
        propEmptyKey,
        tagValue,
        prefixValue,
        propertyKeys,
      },
      t,
    )
    if ('filter' in result) {
      onApply(result.filter)
    } else {
      toast.error(result.error)
    }
  }, [
    category,
    blockType,
    statusValue,
    priorityValue,
    containsQuery,
    propKey,
    propOp,
    propValue,
    propType,
    dateAfter,
    dateBefore,
    propSetKey,
    propEmptyKey,
    tagValue,
    prefixValue,
    propertyKeys,
    onApply,
    t,
  ])

  return (
    <form
      className="add-filter-row flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/50 p-2 [@media(pointer:coarse)]:flex-col [@media(pointer:coarse)]:items-stretch"
      aria-label={t('backlink.addFilterLabel')}
      onSubmit={(e) => {
        e.preventDefault()
        if (category) handleApply()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <Select
        value={category || '__none__'}
        onValueChange={(val) => setCategory(val === '__none__' ? '' : (val as FilterCategory))}
      >
        <SelectTrigger size="sm" aria-label={t('backlink.filterCategoryLabel')}>
          <SelectValue placeholder={t('backlink.selectFilter')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('backlink.selectFilter')}</SelectItem>
          <SelectItem value="type">{t('backlink.typeOption')}</SelectItem>
          <SelectItem value="status">{t('backlink.statusOption')}</SelectItem>
          <SelectItem value="priority">{t('backlink.priorityOption')}</SelectItem>
          <SelectItem value="contains">{t('backlink.containsOption')}</SelectItem>
          <SelectItem value="property">{t('backlink.propertyOption')}</SelectItem>
          <SelectItem value="date">{t('backlink.createdDateOption')}</SelectItem>
          <SelectItem value="property-set">{t('backlink.propertyIsSetOption')}</SelectItem>
          <SelectItem value="property-empty">{t('backlink.propertyIsEmptyOption')}</SelectItem>
          <SelectItem value="has-tag">{t('backlink.hasTagOption')}</SelectItem>
          <SelectItem value="tag-prefix">{t('backlink.tagPrefixOption')}</SelectItem>
        </SelectContent>
      </Select>

      {category === 'type' && (
        <Select value={blockType} onValueChange={(val) => setBlockType(val)}>
          <SelectTrigger size="sm" aria-label={t('backlink.blockTypeValueLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="content">{t('backlink.contentType')}</SelectItem>
            <SelectItem value="page">{t('backlink.pageType')}</SelectItem>
            <SelectItem value="tag">{t('backlink.tagType')}</SelectItem>
          </SelectContent>
        </Select>
      )}

      {category === 'status' && (
        <Select value={statusValue} onValueChange={(val) => setStatusValue(val)}>
          <SelectTrigger size="sm" aria-label={t('backlink.statusValueLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="TODO">{t('backlink.todoStatus')}</SelectItem>
            <SelectItem value="DOING">{t('backlink.doingStatus')}</SelectItem>
            <SelectItem value="DONE">{t('backlink.doneStatus')}</SelectItem>
          </SelectContent>
        </Select>
      )}

      {category === 'priority' && (
        <Select value={priorityValue} onValueChange={(val) => setPriorityValue(val)}>
          <SelectTrigger size="sm" aria-label={t('backlink.priorityValueLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">{t('backlink.highPriority')}</SelectItem>
            <SelectItem value="2">{t('backlink.mediumPriority')}</SelectItem>
            <SelectItem value="3">{t('backlink.lowPriority')}</SelectItem>
          </SelectContent>
        </Select>
      )}

      {category === 'contains' && (
        <SearchInput
          className="h-7 w-40 text-xs [@media(pointer:coarse)]:w-full"
          placeholder={t('backlink.searchTextPlaceholder')}
          value={containsQuery}
          onChange={(e) => setContainsQuery(e.target.value)}
          aria-label={t('backlink.containsTextLabel')}
        />
      )}

      {category === 'property' && (
        <>
          {propertyKeys.length > 0 ? (
            <Select value={propKey} onValueChange={(val) => setPropKey(val)}>
              <SelectTrigger size="sm" aria-label={t('backlink.propertyKeyLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {propertyKeys.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <SearchInput
              className="h-7 w-24 text-xs [@media(pointer:coarse)]:w-full"
              placeholder={t('backlink.keyPlaceholder')}
              value={propKey}
              onChange={(e) => setPropKey(e.target.value)}
              aria-label={t('backlink.propertyKeyLabel')}
            />
          )}
          <Select value={propOp} onValueChange={(val) => setPropOp(val as CompareOp)}>
            <SelectTrigger size="sm" aria-label={t('backlink.comparisonOpLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Eq">=</SelectItem>
              <SelectItem value="Neq">!=</SelectItem>
              <SelectItem value="Lt">&lt;</SelectItem>
              <SelectItem value="Gt">&gt;</SelectItem>
              <SelectItem value="Lte">&lt;=</SelectItem>
              <SelectItem value="Gte">&gt;=</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={propType}
            onValueChange={(val) => setPropType(val as 'text' | 'num' | 'date')}
          >
            <SelectTrigger size="sm" aria-label={t('backlink.propertyTypeLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">{t('backlink.textType')}</SelectItem>
              <SelectItem value="num">{t('backlink.numberType')}</SelectItem>
              <SelectItem value="date">{t('backlink.dateType')}</SelectItem>
            </SelectContent>
          </Select>
          <SearchInput
            className="h-7 w-24 text-xs [@media(pointer:coarse)]:w-full"
            placeholder={t('backlink.valuePlaceholder')}
            value={propValue}
            onChange={(e) => setPropValue(e.target.value)}
            aria-label={t('backlink.propertyValueLabel')}
          />
        </>
      )}

      {category === 'date' && (
        <>
          <SearchInput
            type="date"
            className="h-7 w-36 text-xs [@media(pointer:coarse)]:w-full"
            value={dateAfter}
            onChange={(e) => setDateAfter(e.target.value)}
            aria-label={t('backlink.dateAfterLabel')}
          />
          <span className="text-xs text-muted-foreground">{t('backlink.dateTo')}</span>
          <SearchInput
            type="date"
            className="h-7 w-36 text-xs [@media(pointer:coarse)]:w-full"
            value={dateBefore}
            onChange={(e) => setDateBefore(e.target.value)}
            aria-label={t('backlink.dateBeforeLabel')}
          />
        </>
      )}

      {category === 'property-set' &&
        (propertyKeys.length > 0 ? (
          <Select value={propSetKey} onValueChange={(val) => setPropSetKey(val)}>
            <SelectTrigger size="sm" aria-label={t('backlink.propertyKeyLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {propertyKeys.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <SearchInput
            className="h-7 w-24 text-xs [@media(pointer:coarse)]:w-full"
            placeholder={t('backlink.keyPlaceholder')}
            value={propSetKey}
            onChange={(e) => setPropSetKey(e.target.value)}
            aria-label={t('backlink.propertyKeyLabel')}
          />
        ))}

      {category === 'property-empty' &&
        (propertyKeys.length > 0 ? (
          <Select value={propEmptyKey} onValueChange={(val) => setPropEmptyKey(val)}>
            <SelectTrigger size="sm" aria-label={t('backlink.propertyKeyLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {propertyKeys.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <SearchInput
            className="h-7 w-24 text-xs [@media(pointer:coarse)]:w-full"
            placeholder={t('backlink.keyPlaceholder')}
            value={propEmptyKey}
            onChange={(e) => setPropEmptyKey(e.target.value)}
            aria-label={t('backlink.propertyKeyLabel')}
          />
        ))}

      {category === 'has-tag' && (
        <SearchablePopover
          open={tagSearchOpen}
          onOpenChange={setTagSearchOpen}
          items={tagSearchResults.length > 0 ? tagSearchResults : tags}
          isLoading={tagSearchLoading}
          onSelect={(tag) => {
            setTagValue(tag.id)
            setTagSearchOpen(false)
          }}
          renderItem={(tag) => tag.name}
          keyExtractor={(tag) => tag.id}
          searchValue={tagSearchQuery}
          onSearchChange={setTagSearchQuery}
          searchPlaceholder={t('backlink.searchTagPlaceholder')}
          emptyMessage={t('backlink.noTagsFound')}
          triggerLabel={
            tagValue
              ? (tags.find((tg) => tg.id === tagValue)?.name ??
                tagSearchResults.find((tg) => tg.id === tagValue)?.name ??
                tagValue)
              : t('backlink.selectTag')
          }
        />
      )}

      {category === 'tag-prefix' && (
        <SearchInput
          className="h-7 w-40 text-xs [@media(pointer:coarse)]:w-full"
          placeholder={t('backlink.tagPrefixPlaceholder')}
          value={prefixValue}
          onChange={(e) => setPrefixValue(e.target.value)}
          aria-label={t('backlink.tagPrefixLabel')}
          maxLength={100}
        />
      )}

      {category && (
        <Button
          variant="default"
          size="xs"
          className="h-7 text-xs [@media(pointer:coarse)]:w-full"
          onClick={handleApply}
          aria-label={t('backlink.applyFilterLabel')}
        >
          {t('backlink.applyButton')}
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="h-7 text-xs [@media(pointer:coarse)]:w-full"
        onClick={onCancel}
        aria-label={t('backlink.cancelAddingFilterLabel')}
      >
        {t('backlink.cancelButton')}
      </Button>
    </form>
  )
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
