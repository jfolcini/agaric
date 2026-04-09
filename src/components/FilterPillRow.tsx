/**
 * FilterPillRow — renders active backlink filter pills with remove buttons.
 *
 * Each pill shows the filter dimension, operator, value, and a remove button.
 * Extracted from BacklinkFilterBuilder.tsx for testability (#651-R4).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { FilterPill } from '@/components/ui/filter-pill'
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
          <FilterPill
            label={filterSummary(filter, tagResolver)}
            onRemove={() => onRemove(index)}
            removeAriaLabel={`Remove filter ${filterSummary(filter, tagResolver)}`}
            groupAriaLabel={`Filter: ${filterSummary(filter, tagResolver)}`}
          />
        </li>
      ))}
    </ul>
  )
}
