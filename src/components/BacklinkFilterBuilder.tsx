/**
 * BacklinkFilterBuilder -- pill-based filter builder for backlink queries.
 *
 * Controlled component: parent owns `filters` and `sort` state.
 * Renders active filters as removable pills and provides an "Add filter" flow.
 */

import { ArrowUpDown, Filter, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
// Human-readable filter summary
// ---------------------------------------------------------------------------

function filterSummary(filter: BacklinkFilter): string {
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
      // TODO: resolve tag name from tag_id via Tauri command
      return `has tag ${filter.tag_id.slice(0, 8)}...`
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
  }
}

// ---------------------------------------------------------------------------
// Add-filter row (inline form)
// ---------------------------------------------------------------------------

interface AddFilterRowProps {
  propertyKeys: string[]
  onApply: (filter: BacklinkFilter) => void
  onCancel: () => void
}

function AddFilterRow({ propertyKeys, onApply, onCancel }: AddFilterRowProps): React.ReactElement {
  const [category, setCategory] = useState<FilterCategory | ''>('')
  const [blockType, setBlockType] = useState('content')
  const [statusValue, setStatusValue] = useState('TODO')
  const [priorityValue, setPriorityValue] = useState('A')
  const [containsQuery, setContainsQuery] = useState('')
  const [propKey, setPropKey] = useState(propertyKeys[0] ?? '')
  const [propOp, setPropOp] = useState<CompareOp>('Eq')
  const [propValue, setPropValue] = useState('')
  const [propType, setPropType] = useState<'text' | 'num' | 'date'>('text')
  const [dateAfter, setDateAfter] = useState('')
  const [dateBefore, setDateBefore] = useState('')
  const [propSetKey, setPropSetKey] = useState(propertyKeys[0] ?? '')
  const [propEmptyKey, setPropEmptyKey] = useState(propertyKeys[0] ?? '')
  const [tagValue, setTagValue] = useState('')
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
          toast.error('Search text is required')
          return
        }
        onApply({ type: 'Contains', query: containsQuery.trim() })
        break
      case 'property':
        if (!propKey.trim()) {
          toast.error('Property key is required')
          return
        }
        if (propType === 'num') {
          const numVal = Number.parseFloat(propValue)
          if (Number.isNaN(numVal)) {
            toast.error('Invalid number')
            return
          }
          onApply({ type: 'PropertyNum', key: propKey, op: propOp, value: numVal })
        } else if (propType === 'date') {
          if (!propValue) {
            toast.error('Date value is required')
            return
          }
          onApply({ type: 'PropertyDate', key: propKey, op: propOp, value: propValue })
        } else {
          onApply({ type: 'PropertyText', key: propKey, op: propOp, value: propValue })
        }
        break
      case 'date':
        if (!dateAfter && !dateBefore) {
          toast.error('At least one date boundary is required')
          return
        }
        onApply({
          type: 'CreatedInRange',
          after: dateAfter || null,
          before: dateBefore || null,
        })
        break
      case 'property-set':
        if (!propSetKey.trim()) {
          toast.error('Property key is required')
          return
        }
        onApply({ type: 'PropertyIsSet', key: propSetKey })
        break
      case 'property-empty':
        if (!propEmptyKey.trim()) {
          toast.error('Property key is required')
          return
        }
        onApply({ type: 'PropertyIsEmpty', key: propEmptyKey })
        break
      case 'has-tag':
        if (!tagValue.trim()) {
          toast.error('Tag ID is required')
          return
        }
        onApply({ type: 'HasTag', tag_id: tagValue.trim() })
        break
      case 'tag-prefix':
        if (!prefixValue.trim()) {
          toast.error('Tag prefix is required')
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
    onApply,
  ])

  return (
    <form
      className="add-filter-row flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/50 p-2"
      aria-label="Add filter"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <select
        className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
        value={category}
        onChange={(e) => setCategory(e.target.value as FilterCategory | '')}
        aria-label="Filter category"
      >
        <option value="">Select filter...</option>
        <option value="type">Block Type</option>
        <option value="status">Status</option>
        <option value="priority">Priority</option>
        <option value="contains">Contains</option>
        <option value="property">Property</option>
        <option value="date">Created Date</option>
        <option value="property-set">Property Is Set</option>
        <option value="property-empty">Property Is Empty</option>
        <option value="has-tag">Has Tag</option>
        <option value="tag-prefix">Tag Prefix</option>
      </select>

      {category === 'type' && (
        <select
          className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
          value={blockType}
          onChange={(e) => setBlockType(e.target.value)}
          aria-label="Block type value"
        >
          <option value="content">Content</option>
          <option value="page">Page</option>
          <option value="tag">Tag</option>
        </select>
      )}

      {category === 'status' && (
        <select
          className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
          value={statusValue}
          onChange={(e) => setStatusValue(e.target.value)}
          aria-label="Status value"
        >
          <option value="TODO">TODO</option>
          <option value="DOING">DOING</option>
          <option value="DONE">DONE</option>
        </select>
      )}

      {category === 'priority' && (
        <select
          className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
          value={priorityValue}
          onChange={(e) => setPriorityValue(e.target.value)}
          aria-label="Priority value"
        >
          <option value="A">High [A]</option>
          <option value="B">Medium [B]</option>
          <option value="C">Low [C]</option>
        </select>
      )}

      {category === 'contains' && (
        <Input
          className="h-7 w-40 text-xs"
          placeholder="Search text..."
          value={containsQuery}
          onChange={(e) => setContainsQuery(e.target.value)}
          aria-label="Contains text"
        />
      )}

      {category === 'property' && (
        <>
          {propertyKeys.length > 0 ? (
            <select
              className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
              value={propKey}
              onChange={(e) => setPropKey(e.target.value)}
              aria-label="Property key"
            >
              {propertyKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          ) : (
            <Input
              className="h-7 w-24 text-xs"
              placeholder="key"
              value={propKey}
              onChange={(e) => setPropKey(e.target.value)}
              aria-label="Property key"
            />
          )}
          <select
            className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
            value={propType}
            onChange={(e) => setPropType(e.target.value as 'text' | 'num' | 'date')}
            aria-label="Property type"
          >
            <option value="text">Text</option>
            <option value="num">Number</option>
            <option value="date">Date</option>
          </select>
          <select
            className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
            value={propOp}
            onChange={(e) => setPropOp(e.target.value as CompareOp)}
            aria-label="Comparison operator"
          >
            <option value="Eq">=</option>
            <option value="Neq">!=</option>
            <option value="Lt">&lt;</option>
            <option value="Gt">&gt;</option>
            <option value="Lte">&lt;=</option>
            <option value="Gte">&gt;=</option>
          </select>
          <Input
            className="h-7 w-24 text-xs"
            placeholder="value"
            value={propValue}
            onChange={(e) => setPropValue(e.target.value)}
            aria-label="Property value"
          />
        </>
      )}

      {category === 'date' && (
        <>
          <Input
            type="date"
            className="h-7 w-36 text-xs"
            value={dateAfter}
            onChange={(e) => setDateAfter(e.target.value)}
            aria-label="Date after"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            className="h-7 w-36 text-xs"
            value={dateBefore}
            onChange={(e) => setDateBefore(e.target.value)}
            aria-label="Date before"
          />
        </>
      )}

      {category === 'property-set' &&
        (propertyKeys.length > 0 ? (
          <select
            className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
            value={propSetKey}
            onChange={(e) => setPropSetKey(e.target.value)}
            aria-label="Property key"
          >
            {propertyKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        ) : (
          <Input
            className="h-7 w-24 text-xs"
            placeholder="key"
            value={propSetKey}
            onChange={(e) => setPropSetKey(e.target.value)}
            aria-label="Property key"
          />
        ))}

      {category === 'property-empty' &&
        (propertyKeys.length > 0 ? (
          <select
            className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-2 text-xs"
            value={propEmptyKey}
            onChange={(e) => setPropEmptyKey(e.target.value)}
            aria-label="Property key"
          >
            {propertyKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        ) : (
          <Input
            className="h-7 w-24 text-xs"
            placeholder="key"
            value={propEmptyKey}
            onChange={(e) => setPropEmptyKey(e.target.value)}
            aria-label="Property key"
          />
        ))}

      {category === 'has-tag' && (
        <Input
          className="h-7 w-40 text-xs"
          placeholder="Tag ID..."
          value={tagValue}
          onChange={(e) => setTagValue(e.target.value)}
          aria-label="Tag ID"
        />
      )}

      {category === 'tag-prefix' && (
        <Input
          className="h-7 w-40 text-xs"
          placeholder="Tag prefix..."
          value={prefixValue}
          onChange={(e) => setPrefixValue(e.target.value)}
          aria-label="Tag prefix"
        />
      )}

      {category && (
        <Button
          variant="default"
          size="xs"
          className="h-7 text-xs"
          onClick={handleApply}
          aria-label="Apply filter"
        >
          Apply
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="h-7 text-xs"
        onClick={onCancel}
        aria-label="Cancel adding filter"
      >
        Cancel
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
}: BacklinkFilterBuilderProps): React.ReactElement {
  const [showAddRow, setShowAddRow] = useState(false)
  const addFilterButtonRef = useRef<HTMLButtonElement>(null)

  const handleAddFilter = useCallback(
    (filter: BacklinkFilter) => {
      const summary = filterSummary(filter)
      const isDuplicate = filters.some((f) => filterSummary(f) === summary)
      if (isDuplicate) {
        toast.error('Filter already applied')
        setShowAddRow(false)
        return
      }
      onFiltersChange([...filters, filter])
      setShowAddRow(false)
      requestAnimationFrame(() => addFilterButtonRef.current?.focus())
    },
    [filters, onFiltersChange],
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
      {/* Filter pills + Add button row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />

        {filters.map((filter, index) => (
          <Badge
            // biome-ignore lint/suspicious/noArrayIndexKey: filterSummary can produce duplicates for structurally different filters
            key={index}
            variant="secondary"
            className="filter-pill gap-1 text-xs"
            tabIndex={0}
            aria-label={`Filter: ${filterSummary(filter)}`}
          >
            {filterSummary(filter)}
            <button
              type="button"
              className="ml-0.5 rounded-full hover:bg-muted"
              onClick={() => handleRemoveFilter(index)}
              aria-label={`Remove filter ${filterSummary(filter)}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        <Button
          ref={addFilterButtonRef}
          variant="outline"
          size="xs"
          className="add-filter-button h-7 gap-1 text-xs"
          onClick={() => setShowAddRow(true)}
          aria-label="Add filter"
        >
          <Plus className="h-3 w-3" />
          Add filter
        </Button>

        {/* Sort control */}
        <span className="ml-auto flex items-center gap-1">
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            className="h-7 [@media(pointer:coarse)]:h-10 rounded-md border bg-background px-1.5 text-xs"
            value={sort ? (sort.type === 'Created' ? 'Created' : sort.key) : ''}
            onChange={(e) => handleSortTypeChange(e.target.value)}
            aria-label="Sort by"
          >
            <option value="">Sort by creation date (default)</option>
            <option value="Created">Created</option>
            {propertyKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {sort && (
            <Button
              variant="ghost"
              size="xs"
              className="h-7 px-1 text-xs"
              onClick={handleSortDirToggle}
              aria-label={`Toggle sort direction (currently ${sort.dir === 'Asc' ? 'ascending' : 'descending'})`}
            >
              {sort.dir === 'Asc' ? 'Asc' : 'Desc'}
            </Button>
          )}
        </span>

        {hasFilters && (
          <Button
            variant="ghost"
            size="xs"
            className="clear-all-button h-7 text-xs text-muted-foreground"
            onClick={handleClearAll}
          >
            Clear all
          </Button>
        )}
      </div>

      {/* Add filter row */}
      {showAddRow && (
        <AddFilterRow
          propertyKeys={propertyKeys}
          onApply={handleAddFilter}
          onCancel={() => setShowAddRow(false)}
        />
      )}

      {/* Count display */}
      {hasFilters && (
        <p
          className="filter-count text-xs text-muted-foreground"
          aria-live="polite"
          aria-atomic="true"
        >
          Showing {filteredCount} of {totalCount} backlinks
        </p>
      )}
    </fieldset>
  )
}
