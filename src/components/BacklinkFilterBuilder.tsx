/**
 * BacklinkFilterBuilder -- pill-based filter builder for backlink queries.
 *
 * Controlled component: parent owns `filters` and `sort` state.
 * Renders active filters as removable pills and provides an "Add filter" flow.
 */

import { ArrowUpDown, Filter, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { BacklinkFilter, BacklinkSort, CompareOp, SortDir } from '../lib/tauri'

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
// Human-readable filter summary
// ---------------------------------------------------------------------------

function filterSummary(filter: BacklinkFilter, tagResolver?: (id: string) => string): string {
  switch (filter.type) {
    case 'BlockType':
      return `type = ${filter.block_type}`
    case 'PropertyText':
      if (filter.key === 'todo') return `status ${opLabel(filter.op)} ${filter.value}`
      if (filter.key === 'priority') return `priority ${opLabel(filter.op)} ${filter.value}`
      return `${filter.key} ${opLabel(filter.op)} ${filter.value}`
    case 'PropertyNum':
      return `${filter.key} ${opLabel(filter.op)} ${filter.value}`
    case 'PropertyDate':
      return `${filter.key} ${opLabel(filter.op)} ${filter.value}`
    case 'PropertyIsSet':
      return `${filter.key} is set`
    case 'PropertyIsEmpty':
      return `${filter.key} is empty`
    case 'Contains':
      return `contains "${filter.query}"`
    case 'CreatedInRange': {
      const parts: string[] = []
      if (filter.after) parts.push(`after ${filter.after}`)
      if (filter.before) parts.push(`before ${filter.before}`)
      return `created ${parts.join(' ')}`
    }
    case 'HasTag':
      return tagResolver
        ? `has tag ${tagResolver(filter.tag_id)}`
        : `has tag ${filter.tag_id.slice(0, 8)}...`
    case 'HasTagPrefix':
      return `tag prefix "${filter.prefix}"`
    default:
      return 'filter'
  }
}

function opLabel(op: CompareOp): string {
  switch (op) {
    case 'Eq':
      return '='
    case 'Neq':
      return '!='
    case 'Lt':
      return '<'
    case 'Gt':
      return '>'
    case 'Lte':
      return '<='
    case 'Gte':
      return '>='
    case 'Contains':
      return 'contains'
    case 'StartsWith':
      return 'starts with'
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

  const handleApply = useCallback(() => {
    switch (category) {
      case 'type':
        onApply({ type: 'BlockType', block_type: blockType })
        break
      case 'status':
        onApply({ type: 'PropertyText', key: 'todo', op: 'Eq', value: statusValue })
        break
      case 'priority':
        onApply({ type: 'PropertyText', key: 'priority', op: 'Eq', value: priorityValue })
        break
      case 'contains':
        if (!containsQuery.trim()) {
          toast.error(t('backlink.searchTextRequired'))
          return
        }
        onApply({ type: 'Contains', query: containsQuery.trim() })
        break
      case 'property':
        if (!propKey.trim()) {
          toast.error(t('backlink.propertyKeyRequired'))
          return
        }
        // Warn if key doesn't exist in known property keys
        if (propertyKeys.length > 0 && !propertyKeys.includes(propKey.trim())) {
          toast.error(`No blocks have property "${propKey.trim()}"`)
          return
        }
        if (propType === 'num') {
          const numVal = Number.parseFloat(propValue)
          if (!Number.isFinite(numVal)) {
            toast.error(t('backlink.invalidNumber'))
            return
          }
          onApply({ type: 'PropertyNum', key: propKey, op: propOp, value: numVal })
        } else if (propType === 'date') {
          if (!propValue) {
            toast.error(t('backlink.dateValueRequired'))
            return
          }
          onApply({ type: 'PropertyDate', key: propKey, op: propOp, value: propValue })
        } else {
          onApply({ type: 'PropertyText', key: propKey, op: propOp, value: propValue })
        }
        break
      case 'date': {
        if (!dateAfter && !dateBefore) {
          toast.error(t('backlink.dateRangeRequired'))
          return
        }
        // Validate date format (YYYY-MM-DD)
        const dateRe = /^\d{4}-\d{2}-\d{2}$/
        if (dateAfter && !dateRe.test(dateAfter)) {
          toast.error(t('backlink.invalidDateAfter'))
          return
        }
        if (dateBefore && !dateRe.test(dateBefore)) {
          toast.error(t('backlink.invalidDateBefore'))
          return
        }
        onApply({
          type: 'CreatedInRange',
          after: dateAfter || null,
          before: dateBefore || null,
        })
        break
      }
      case 'property-set':
        if (!propSetKey.trim()) {
          toast.error(t('backlink.propertyKeyRequired'))
          return
        }
        onApply({ type: 'PropertyIsSet', key: propSetKey })
        break
      case 'property-empty':
        if (!propEmptyKey.trim()) {
          toast.error(t('backlink.propertyKeyRequired'))
          return
        }
        onApply({ type: 'PropertyIsEmpty', key: propEmptyKey })
        break
      case 'has-tag':
        if (!tagValue.trim()) {
          toast.error(t('backlink.tagIdRequired'))
          return
        }
        // Basic ULID format check (26 uppercase alphanumeric). Accepts I/L/O/U
        // which strict Crockford base32 excludes; backend handles gracefully.
        if (tags.length === 0 && !/^[0-9A-Z]{26}$/.test(tagValue.trim())) {
          toast.error(t('backlink.invalidUlidFormat'))
          return
        }
        onApply({ type: 'HasTag', tag_id: tagValue.trim() })
        break
      case 'tag-prefix':
        if (!prefixValue.trim()) {
          toast.error(t('backlink.tagPrefixRequired'))
          return
        }
        onApply({ type: 'HasTagPrefix', prefix: prefixValue.trim() })
        break
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
    tags,
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
        <Input
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
            <Input
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
          <Input
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
          <Input
            type="date"
            className="h-7 w-36 text-xs [@media(pointer:coarse)]:w-full"
            value={dateAfter}
            onChange={(e) => setDateAfter(e.target.value)}
            aria-label={t('backlink.dateAfterLabel')}
          />
          <span className="text-xs text-muted-foreground">{t('backlink.dateTo')}</span>
          <Input
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
          <Input
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
          <Input
            className="h-7 w-24 text-xs [@media(pointer:coarse)]:w-full"
            placeholder={t('backlink.keyPlaceholder')}
            value={propEmptyKey}
            onChange={(e) => setPropEmptyKey(e.target.value)}
            aria-label={t('backlink.propertyKeyLabel')}
          />
        ))}

      {category === 'has-tag' &&
        (tags.length > 0 ? (
          <Select value={tagValue} onValueChange={(val) => setTagValue(val)}>
            <SelectTrigger size="sm" aria-label={t('backlink.tagLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tags.map((tag) => (
                <SelectItem key={tag.id} value={tag.id}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            className="h-7 w-40 text-xs [@media(pointer:coarse)]:w-full"
            placeholder={t('backlink.tagIdPlaceholder')}
            value={tagValue}
            onChange={(e) => setTagValue(e.target.value)}
            aria-label={t('backlink.tagIdLabel')}
          />
        ))}

      {category === 'tag-prefix' && (
        <Input
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
      aria-label="Backlink filters"
    >
      <legend className="sr-only">Backlink filters</legend>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {filters.length} filter{filters.length === 1 ? '' : 's'} applied
      </div>

      {/* Filter pills + Add button row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />

        {filters.length > 0 && (
          <ul aria-label="Applied filters" className="contents list-none m-0 p-0">
            {filters.map((filter, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: getFilterKey can produce duplicates for structurally different filters with same key
                key={index}
                className="contents"
              >
                <Badge
                  variant="secondary"
                  className="filter-pill shrink-0 gap-1 text-xs"
                  role="group"
                  aria-label={`Filter: ${filterSummary(filter, tagResolver)}`}
                >
                  {filterSummary(filter, tagResolver)}
                  <button
                    type="button"
                    className="ml-0.5 inline-flex items-center justify-center rounded-full p-1 hover:bg-muted active:bg-muted active:scale-95 focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-w-[44px] touch-target"
                    onClick={() => handleRemoveFilter(index)}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      if (e.key === 'Delete' || e.key === 'Backspace') {
                        e.preventDefault()
                        handleRemoveFilter(index)
                      }
                    }}
                    aria-label={`Remove filter ${filterSummary(filter, tagResolver)}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}

        <Button
          ref={addFilterButtonRef}
          variant="outline"
          size="xs"
          className="add-filter-button h-7 gap-1 text-xs"
          onClick={() => setShowAddRow(true)}
          aria-label={t('backlink.addFilterLabel')}
        >
          <Plus className="h-3 w-3" />
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
            {t('backlink.clearAllButton')}
          </Button>
        )}

        {/* Sort control */}
        <span className="ml-auto flex items-center gap-1">
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          <Select
            value={sort ? (sort.type === 'Created' ? 'Created' : sort.key) : '__none__'}
            onValueChange={(val) => handleSortTypeChange(val === '__none__' ? '' : val)}
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
            className="h-7 px-1 text-xs"
            onClick={handleSortDirToggle}
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
