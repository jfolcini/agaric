/**
 * BacklinkFilterBuilder -- pill-based filter builder for backlink queries.
 *
 * Controlled component: parent owns `filters` and `sort` state.
 * Renders active filters as removable pills and provides an "Add filter" flow.
 */

import { ArrowUpDown, Filter, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useState } from 'react'
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

type FilterCategory = 'type' | 'status' | 'priority' | 'contains' | 'property' | 'date'

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
  const [dateAfter, setDateAfter] = useState('')
  const [dateBefore, setDateBefore] = useState('')

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
        if (containsQuery.trim()) {
          onApply({ type: 'Contains', query: containsQuery.trim() })
        }
        break
      case 'property':
        if (propKey.trim()) {
          onApply({ type: 'PropertyText', key: propKey, op: propOp, value: propValue })
        }
        break
      case 'date':
        onApply({
          type: 'CreatedInRange',
          after: dateAfter || null,
          before: dateBefore || null,
        })
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
    dateAfter,
    dateBefore,
    onApply,
  ])

  return (
    <div className="add-filter-row flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/50 p-2">
      <select
        className="h-7 rounded-md border bg-background px-2 text-xs"
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
      </select>

      {category === 'type' && (
        <select
          className="h-7 rounded-md border bg-background px-2 text-xs"
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
          className="h-7 rounded-md border bg-background px-2 text-xs"
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
          className="h-7 rounded-md border bg-background px-2 text-xs"
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
              className="h-7 rounded-md border bg-background px-2 text-xs"
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
            className="h-7 rounded-md border bg-background px-2 text-xs"
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
    </div>
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

  const handleAddFilter = useCallback(
    (filter: BacklinkFilter) => {
      onFiltersChange([...filters, filter])
      setShowAddRow(false)
    },
    [filters, onFiltersChange],
  )

  const handleRemoveFilter = useCallback(
    (index: number) => {
      const next = filters.filter((_, i) => i !== index)
      onFiltersChange(next)
    },
    [filters, onFiltersChange],
  )

  const handleClearAll = useCallback(() => {
    onFiltersChange([])
    onSortChange(null)
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
    <div className="backlink-filter-builder space-y-2" role="toolbar" aria-label="Backlink filters">
      {/* Filter pills + Add button row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />

        {filters.map((filter, index) => (
          <Badge
            key={filterSummary(filter)}
            variant="secondary"
            className="filter-pill gap-1 text-xs"
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
          variant="outline"
          size="xs"
          className="add-filter-button h-6 gap-1 text-xs"
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
            className="h-6 rounded-md border bg-background px-1.5 text-xs"
            value={
              sort ? (sort.type === 'Created' ? 'Created' : 'key' in sort ? sort.key : '') : ''
            }
            onChange={(e) => handleSortTypeChange(e.target.value)}
            aria-label="Sort by"
          >
            <option value="">Default sort</option>
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
              className="h-6 px-1 text-xs"
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
            className="clear-all-button h-6 text-xs text-muted-foreground"
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
        <p className="filter-count text-xs text-muted-foreground">
          Showing {filteredCount} of {totalCount} backlinks
        </p>
      )}
    </div>
  )
}
