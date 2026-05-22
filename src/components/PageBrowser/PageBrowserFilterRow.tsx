/**
 * PageBrowserFilterRow — PEND-58 Phase 3. Renders the active compound-filter
 * chips for the Pages view plus the Add-Filter affordance.
 *
 * Each `FilterPrimitive` renders as a removable `FilterPill` (reused verbatim
 * from the backlink/graph filter surfaces). The human-readable label comes
 * from `pageFilterSummary`. Stable React keys come from an `_addId` stamp the
 * orchestrator assigns at creation time (mirrors `FilterPillRow`'s
 * `FilterWithKey` pattern) so structurally-identical chips keep distinct
 * identities across reorders.
 *
 * Rendered only on the `pageBrowser.densityV1` path — server-side filtering
 * needs `list_pages_with_metadata`, which the legacy `listBlocks` path lacks.
 */

import type { TFunction } from 'i18next'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { FilterPill } from '@/components/ui/filter-pill'
import type { FilterPrimitive } from '@/lib/tauri'
import { AddFilterPopover } from './AddFilterPopover'

/** Soft cap above which the Add-Filter affordance warns about query cost. */
export const MAX_PAGE_FILTERS = 8

/** A filter primitive stamped with a stable per-chip React key. */
export type PageFilterWithKey = FilterPrimitive & { _addId: number }

export interface PageBrowserFilterRowProps {
  filters: PageFilterWithKey[]
  onAddFilter: (filter: FilterPrimitive) => void
  onRemoveFilter: (index: number) => void
  /** Resolves a tag id to a human-readable label for the `tag:` chip. */
  tagResolver?: ((id: string) => string) | undefined
}

/**
 * Human-readable one-line summary for a Pages filter chip. Mirrors
 * `filterSummary` in `FilterPillRow.tsx` but over the `FilterPrimitive`
 * vocabulary. `t` is passed so the labels are i18n-keyed.
 */
/** Extracted so `pageFilterSummary`'s switch stays under the cognitive-complexity cap. */
function lastEditedSummary(
  spec: Extract<FilterPrimitive, { type: 'LastEdited' }>['spec'],
  t: TFunction,
): string {
  if (spec.type === 'OlderThan') {
    // The Pages UI only emits `OlderThan{30}`, for which the canonical bucket
    // label reads best. A deep-linked / saved-view filter could carry any
    // `days`, so fall back to the value-aware rolling label rather than always
    // showing the fixed bucket text (which would mislabel non-30 values).
    return spec.days === 30
      ? t('pageBrowser.filter.lastEdited.older')
      : t('pageBrowser.filter.summaryLastEditedRolling', { days: spec.days })
  }
  if (spec.type === 'Range')
    return t('pageBrowser.filter.summaryLastEditedRange', { start: spec.start, end: spec.end })
  const buckets: Record<number, string> = {
    1: 'pageBrowser.filter.lastEdited.today',
    7: 'pageBrowser.filter.lastEdited.thisWeek',
    30: 'pageBrowser.filter.lastEdited.thisMonth',
  }
  const key = buckets[spec.days]
  return key ? t(key) : t('pageBrowser.filter.summaryLastEditedRolling', { days: spec.days })
}

/** Extracted so `pageFilterSummary`'s switch stays under the cognitive-complexity cap. */
function hasPropertySummary(
  filter: Extract<FilterPrimitive, { type: 'HasProperty' }>,
  t: TFunction,
): string {
  if (filter.op === 'exists') return t('pageBrowser.filter.summaryHasProperty', { key: filter.key })
  // `notExists` is reserved for Search / saved-views — no Pages UI control
  // emits it (the popover only builds `op: 'eq' | 'exists'`). Kept renderable
  // so deep-linked / saved filters still summarise.
  if (filter.op === 'notExists')
    return t('pageBrowser.filter.summaryNotHasProperty', { key: filter.key })
  // The `≠` glyph (op === 'ne') is likewise reserved for Search / saved-views;
  // the Pages popover only emits `op: 'eq'`.
  return t('pageBrowser.filter.summaryProperty', {
    key: filter.key,
    op: filter.op === 'ne' ? '≠' : '=',
    value: filter.value?.type === 'Text' ? filter.value.value : (filter.value?.value ?? ''),
  })
}

export function pageFilterSummary(
  filter: FilterPrimitive,
  t: TFunction,
  tagResolver?: (id: string) => string,
): string {
  switch (filter.type) {
    case 'Tag':
      return t('pageBrowser.filter.summaryTag', {
        tag: tagResolver ? tagResolver(filter.tag) : filter.tag,
      })
    case 'PathGlob':
      // The `exclude: true` ("not path") variant is reserved for Search /
      // saved-views — the Pages popover only emits `exclude: false`. Kept
      // renderable so deep-linked / saved filters still summarise.
      return filter.exclude
        ? t('pageBrowser.filter.summaryPathExclude', { pattern: filter.pattern })
        : t('pageBrowser.filter.summaryPath', { pattern: filter.pattern })
    case 'HasProperty':
      return hasPropertySummary(filter, t)
    case 'LastEdited':
      return lastEditedSummary(filter.spec, t)
    case 'Space':
      return t('pageBrowser.filter.summarySpace')
    case 'Priority':
      return t('pageBrowser.filter.summaryPriority', { priority: filter.priority })
    case 'Orphan':
      return t('pageBrowser.filter.facetOrphan')
    case 'Stub':
      return t('pageBrowser.filter.facetStub')
    case 'HasNoInboundLinks':
      return t('pageBrowser.filter.facetHasNoInboundLinks')
    default:
      // Search-only primitives never reach the Pages surface (allow-list
      // gate), but keep the switch exhaustive for type safety.
      return t('pageBrowser.filter.summaryUnknown')
  }
}

export function PageBrowserFilterRow({
  filters,
  onAddFilter,
  onRemoveFilter,
  tagResolver,
}: PageBrowserFilterRowProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div
      className="page-browser-filter-row flex flex-wrap items-center gap-1.5"
      data-testid="page-browser-filter-row"
    >
      {filters.length > 0 && (
        <ul
          aria-label={t('pageBrowser.filter.appliedFiltersLabel')}
          className="contents list-none m-0 p-0"
        >
          {filters.map((filter, index) => {
            const label = pageFilterSummary(filter, t, tagResolver)
            return (
              <li key={filter._addId} className="contents">
                <FilterPill
                  label={label}
                  onRemove={() => onRemoveFilter(index)}
                  removeAriaLabel={t('pageBrowser.filter.removeFilter', { label })}
                  groupAriaLabel={t('pageBrowser.filter.filterGroup', { label })}
                />
              </li>
            )
          })}
        </ul>
      )}
      <AddFilterPopover
        onAddFilter={onAddFilter}
        warnManyFilters={filters.length >= MAX_PAGE_FILTERS}
      />
    </div>
  )
}
