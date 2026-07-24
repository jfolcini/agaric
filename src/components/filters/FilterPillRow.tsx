/**
 * FilterPillRow — renders active backlink filter pills with remove buttons.
 *
 * Each pill shows the filter dimension, operator, value, and a remove button.
 * Extracted from BacklinkFilterBuilder.tsx for testability (#651-R4).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { FilterPill } from '@/components/ui/filter-pill'
import type { BacklinkFilter, CompareOp } from '@/lib/bindings'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Filter object augmented with a frontend-only `_addId` React key
 * (; resolves FE-L-14).
 *
 * `BacklinkFilterBuilder` stamps every newly-added filter with a monotonic
 * `_addId`; we use it as the React `key` on each pill `<li>` to give
 * structurally-identical filters distinct identities. This is the "stable
 * per-filter UUID at creation time" fix called for by FE-L-14, propagated
 * through the type so `FilterPillRow` can rely on it instead of `key={index}`.
 * The field is invisible to the Rust IPC contract (serde silently drops
 * unknown fields).
 */
export type FilterWithKey = BacklinkFilter & { _addId: number }

export interface FilterPillRowProps {
  filters: FilterWithKey[]
  onRemove: (index: number) => void
  tagResolver?: ((id: string) => string) | undefined
}

// ---------------------------------------------------------------------------
// Human-readable filter summary
// ---------------------------------------------------------------------------

function opLabel(op: CompareOp, t?: (key: string) => string): string {
  switch (op) {
    case 'Eq': {
      return '='
    }
    case 'Neq': {
      return '!='
    }
    case 'Lt': {
      return '<'
    }
    case 'Gt': {
      return '>'
    }
    case 'Lte': {
      return '<='
    }
    case 'Gte': {
      return '>='
    }
    case 'Contains': {
      return t ? t('filter.operatorContains') : 'contains'
    }
    case 'StartsWith': {
      return t ? t('filter.operatorStartsWith') : 'starts with'
    }
  }
}

export function filterSummary(
  filter: BacklinkFilter,
  tagResolver?: (id: string) => string,
  t?: (key: string) => string,
): string {
  // #2232 — dimension nouns route through i18n when a `t` is supplied; the
  // literal is the untranslated fallback for `t`-less callers (tests, logs).
  const tr = (key: string, fallback: string): string => (t ? t(key) : fallback)
  switch (filter.type) {
    case 'BlockType': {
      return `${tr('filter.summary.type', 'type')} = ${filter.block_type}`
    }
    case 'PropertyText': {
      if (filter.key === 'todo')
        return `${tr('filter.summary.status', 'status')} ${opLabel(filter.op, t)} ${filter.value}`
      if (filter.key === 'priority')
        return `${tr('filter.summary.priority', 'priority')} ${opLabel(filter.op, t)} ${filter.value}`
      return `${filter.key} ${opLabel(filter.op, t)} ${filter.value}`
    }
    case 'PropertyNum': {
      return `${filter.key} ${opLabel(filter.op, t)} ${filter.value}`
    }
    case 'PropertyDate': {
      return `${filter.key} ${opLabel(filter.op, t)} ${filter.value}`
    }
    case 'PropertyIsSet': {
      return `${filter.key} ${tr('filter.isSet', 'is set')}`
    }
    case 'PropertyIsEmpty': {
      return `${filter.key} ${tr('filter.isEmpty', 'is empty')}`
    }
    case 'Contains': {
      return `${tr('filter.operatorContains', 'contains')} "${filter.query}"`
    }
    case 'CreatedInRange': {
      const parts: string[] = []
      if (filter.after) parts.push(`${tr('filter.summary.after', 'after')} ${filter.after}`)
      if (filter.before) parts.push(`${tr('filter.summary.before', 'before')} ${filter.before}`)
      return `${tr('filter.summary.created', 'created')} ${parts.join(' ')}`
    }
    case 'HasTag': {
      const hasTag = tr('filter.summary.hasTag', 'has tag')
      return tagResolver
        ? `${hasTag} ${tagResolver(filter.tag_id)}`
        : `${hasTag} ${filter.tag_id.slice(0, 8)}...`
    }
    case 'HasTagPrefix': {
      return `${tr('filter.tagPrefix', 'tag prefix')} "${filter.prefix}"`
    }
    default: {
      return tr('filter.default', 'filter')
    }
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
        // `_addId` is a stable per-filter key stamped at creation
        // (FE-L-14) — see `FilterWithKey` above.
        <li key={filter._addId} className="contents">
          <FilterPill
            label={filterSummary(filter, tagResolver, t)}
            onRemove={() => onRemove(index)}
            removeAriaLabel={t('filter.remove', {
              summary: filterSummary(filter, tagResolver, t),
            })}
            groupAriaLabel={t('filter.group', { summary: filterSummary(filter, tagResolver, t) })}
          />
        </li>
      ))}
    </ul>
  )
}
