/**
 * FilterPillRow — renders active backlink filter pills with remove buttons.
 *
 * Each pill shows the filter dimension, operator, value, and a remove button.
 * Extracted from BacklinkFilterBuilder.tsx for testability (#651-R4).
 */

import { X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import type { BacklinkFilter, CompareOp } from '../lib/tauri'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FilterPillRowProps {
  filters: BacklinkFilter[]
  onRemove: (index: number) => void
  tagResolver?: ((id: string) => string) | undefined
}

// ---------------------------------------------------------------------------
// Human-readable filter summary
// ---------------------------------------------------------------------------

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

export function filterSummary(
  filter: BacklinkFilter,
  tagResolver?: (id: string) => string,
): string {
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FilterPillRow({
  filters,
  onRemove,
  tagResolver,
}: FilterPillRowProps): React.ReactElement | null {
  const { t } = useTranslation()

  if (filters.length === 0) return null

  return (
    <ul aria-label={t('backlink.appliedFiltersLabel')} className="contents list-none m-0 p-0">
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
              onClick={() => onRemove(index)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault()
                  onRemove(index)
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
  )
}
