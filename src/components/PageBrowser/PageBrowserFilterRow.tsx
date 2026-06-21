/**
 * PageBrowserFilterRow — Phase 3. Renders the active compound-filter
 * chips for the Pages view plus the Add-Filter affordance.
 *
 * Each `FilterPrimitive` renders as a removable `FilterPill` (reused verbatim
 * from the backlink/graph filter surfaces). The human-readable label comes
 * from `pageFilterSummary`. Stable React keys come from an `_addId` stamp the
 * orchestrator assigns at creation time (mirrors `FilterPillRow`'s
 * `FilterWithKey` pattern) so structurally-identical chips keep distinct
 * identities across reorders.
 *
 * Server-side filtering is backed by `list_pages_with_metadata`.
 */

import type { TFunction } from 'i18next'
import { X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { FilterPill } from '@/components/ui/filter-pill'
import type { DatePredicate } from '@/lib/bindings'
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
  /**
   * Clears every active chip in one shot. Supplied by the orchestrator
   * (PageBrowser); when present, a "Clear all" control renders on the chip
   * row whenever at least one filter is active. Mirrors `GraphFilterBar`'s
   * clear-all affordance.
   */
  onClearAll?: (() => void) | undefined
  /** Resolves a tag id to a human-readable label for the `tag:` chip. */
  tagResolver?: ((id: string) => string) | undefined
  /**
   * #1280 D1 — forwarded to `AddFilterPopover` to hide the Pages-only facet
   * group (Orphan / Stub / No inbound links) so non-Pages surfaces (the
   * Advanced Query view) offer only the shared, engine-supported keys.
   */
  hidePagesFacets?: boolean | undefined
  /**
   * #1280 D2 — forwarded to `AddFilterPopover` to offer the advanced-only facet
   * group (State / Block type / Due date / Scheduled / Created). The Advanced
   * Query view passes this; the Pages browser does not, so those facets stay
   * off the Pages surface.
   */
  showAdvancedFacets?: boolean | undefined
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
  const { key, predicate } = filter
  switch (predicate.type) {
    case 'Exists': {
      return t('pageBrowser.filter.summaryHasProperty', { key })
    }
    case 'NotExists': {
      return t('pageBrowser.filter.summaryNotHasProperty', { key })
    }
    default: {
      // Eq / Ne both carry a value; the operand is `predicate.value.value`
      // for either Text or Ref (D26 — no Text/Ref ternary needed). D24 ships
      // the full op selector, so the Pages popover emits both Eq (`=`) and Ne
      // (`≠`) — the `≠` glyph is no longer Search-only.
      return t('pageBrowser.filter.summaryProperty', {
        key,
        op: predicate.type === 'Ne' ? '≠' : '=',
        value: predicate.value.value,
      })
    }
  }
}

/**
 * #1280 D2 — human-readable summary for a `DueDate` / `Scheduled` chip. `prefix`
 * is the localised facet word ("due" / "scheduled"); the operator + date(s) are
 * appended. Extracted so `pageFilterSummary`'s switch stays under the
 * cognitive-complexity cap.
 */
function datePredicateSummary(prefix: string, predicate: DatePredicate, t: TFunction): string {
  switch (predicate.type) {
    case 'IsNull': {
      return t('pageBrowser.filter.summaryDateIsNull', { prefix })
    }
    case 'Before': {
      return t('pageBrowser.filter.summaryDateBefore', { prefix, date: predicate.date })
    }
    case 'After': {
      return t('pageBrowser.filter.summaryDateAfter', { prefix, date: predicate.date })
    }
    case 'OnOrBefore': {
      return t('pageBrowser.filter.summaryDateOnOrBefore', { prefix, date: predicate.date })
    }
    case 'OnOrAfter': {
      return t('pageBrowser.filter.summaryDateOnOrAfter', { prefix, date: predicate.date })
    }
    case 'On': {
      return t('pageBrowser.filter.summaryDateOn', { prefix, date: predicate.date })
    }
    default: {
      // Between
      return t('pageBrowser.filter.summaryDateBetween', {
        prefix,
        from: predicate.from,
        to: predicate.to,
      })
    }
  }
}

/**
 * #1280 D2 — "state: TODO, DOING" / "state not: …" / appends "none" when the
 * is-null toggle is set. Extracted so `pageFilterSummary` stays under the cap.
 */
function stateSummary(filter: Extract<FilterPrimitive, { type: 'State' }>, t: TFunction): string {
  const list = filter.values.join(', ')
  const parts = [list, filter.is_null ? t('pageBrowser.filter.summaryStateNone') : '']
    .filter((p) => p !== '')
    .join(', ')
  return filter.exclude
    ? t('pageBrowser.filter.summaryStateExclude', { values: parts })
    : t('pageBrowser.filter.summaryState', { values: parts })
}

/** #1280 D2 — "type: content, page" / negated "type not: …". */
function blockTypeSummary(
  filter: Extract<FilterPrimitive, { type: 'BlockType' }>,
  t: TFunction,
): string {
  const list = filter.values.join(', ')
  return filter.exclude
    ? t('pageBrowser.filter.summaryBlockTypeExclude', { values: list })
    : t('pageBrowser.filter.summaryBlockType', { values: list })
}

/** #1280 D2 — "created after X", "created before Y", or "created X…Y". */
function createdSummary(
  filter: Extract<FilterPrimitive, { type: 'Created' }>,
  t: TFunction,
): string {
  if (filter.after && filter.before)
    return t('pageBrowser.filter.summaryCreatedBetween', {
      after: filter.after,
      before: filter.before,
    })
  if (filter.after) return t('pageBrowser.filter.summaryCreatedAfter', { date: filter.after })
  if (filter.before) return t('pageBrowser.filter.summaryCreatedBefore', { date: filter.before })
  return t('pageBrowser.filter.summaryUnknown')
}

/**
 * Per-facet long-form description for the boolean Pages facets, surfaced as the
 * chip's `title` tooltip so the (necessarily terse) chip label can be expanded
 * on hover. Mirrors the descriptions shown in the Add-Filter popover. Returns
 * `undefined` for value-bearing facets whose chip label already self-describes.
 */
export function pageFilterChipTitle(filter: FilterPrimitive, t: TFunction): string | undefined {
  switch (filter.type) {
    case 'Orphan': {
      return t('pageBrowser.filter.facetOrphanDesc')
    }
    case 'Stub': {
      return t('pageBrowser.filter.facetStubDesc')
    }
    case 'HasNoInboundLinks': {
      return t('pageBrowser.filter.facetHasNoInboundLinksDesc')
    }
    default: {
      return undefined
    }
  }
}

export function pageFilterSummary(
  filter: FilterPrimitive,
  t: TFunction,
  tagResolver?: (id: string) => string,
  /**
   * #1478 — resolves a page/block ULID to its title for the relational
   * `LinksTo` / `LinkedFrom` chips. SEPARATE from `tagResolver` because the
   * relational ids are page/block ids (resolved via the global resolve store),
   * not tag ids; conflating them would route the `tag:` chip through the wrong
   * resolver. Falls back to the raw id when absent.
   */
  refResolver?: (id: string) => string,
): string {
  switch (filter.type) {
    case 'Tag': {
      return t('pageBrowser.filter.summaryTag', {
        tag: tagResolver ? tagResolver(filter.tag) : filter.tag,
      })
    }
    case 'PathGlob': {
      // D24 ships the path-exclude toggle, so the Pages popover emits both the
      // `exclude: false` ("path") and `exclude: true` ("not path") variants.
      return filter.exclude
        ? t('pageBrowser.filter.summaryPathExclude', { pattern: filter.pattern })
        : t('pageBrowser.filter.summaryPath', { pattern: filter.pattern })
    }
    case 'HasProperty': {
      return hasPropertySummary(filter, t)
    }
    case 'LastEdited': {
      return lastEditedSummary(filter.spec, t)
    }
    case 'Space': {
      return t('pageBrowser.filter.summarySpace')
    }
    case 'Priority': {
      return t('pageBrowser.filter.summaryPriority', { priority: filter.values.join(', ') })
    }
    case 'State': {
      return stateSummary(filter, t)
    }
    case 'BlockType': {
      return blockTypeSummary(filter, t)
    }
    case 'DueDate': {
      return datePredicateSummary(t('pageBrowser.filter.summaryDuePrefix'), filter.predicate, t)
    }
    case 'Scheduled': {
      return datePredicateSummary(
        t('pageBrowser.filter.summaryScheduledPrefix'),
        filter.predicate,
        t,
      )
    }
    case 'Created': {
      return createdSummary(filter, t)
    }
    case 'LinksTo': {
      // #1478 — `target` is a ULID; resolve to the page title (same resolver the
      // grouped-results headers use, #1447), falling back to the raw id.
      return t('pageBrowser.filter.summaryLinksTo', {
        target: refResolver ? refResolver(filter.target) : filter.target,
      })
    }
    case 'LinkedFrom': {
      return t('pageBrowser.filter.summaryLinkedFrom', {
        source: refResolver ? refResolver(filter.source) : filter.source,
      })
    }
    case 'HasParentMatching': {
      // #1478 — the matcher is a nested FilterExpr; the chip is a terse
      // "has parent matching (…)" placeholder (the full sub-expr is built/edited
      // via the nested mini-builder in the popover, not re-rendered in the chip).
      return t('pageBrowser.filter.summaryHasParentMatching')
    }
    case 'Orphan': {
      return t('pageBrowser.filter.facetOrphan')
    }
    case 'Stub': {
      return t('pageBrowser.filter.facetStub')
    }
    case 'HasNoInboundLinks': {
      return t('pageBrowser.filter.facetHasNoInboundLinks')
    }
    default: {
      // Search-only primitives never reach the Pages surface (allow-list
      // gate), but keep the switch exhaustive for type safety.
      return t('pageBrowser.filter.summaryUnknown')
    }
  }
}

export function PageBrowserFilterRow({
  filters,
  onAddFilter,
  onRemoveFilter,
  onClearAll,
  tagResolver,
  hidePagesFacets,
  showAdvancedFacets,
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
            const title = pageFilterChipTitle(filter, t)
            return (
              <li key={filter._addId} className="contents">
                <FilterPill
                  label={label}
                  // `exactOptionalPropertyTypes`: only set `title` when present
                  // so we don't pass `string | undefined` to a `title?: string`.
                  {...(title !== undefined ? { title } : {})}
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
        {...(hidePagesFacets !== undefined ? { hidePagesFacets } : {})}
        {...(showAdvancedFacets !== undefined ? { showAdvancedFacets } : {})}
      />
      {onClearAll && filters.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="h-7 text-xs"
          onClick={onClearAll}
          aria-label={t('pageBrowser.filter.clearAllLabel')}
        >
          <X className="h-3 w-3" aria-hidden="true" />
          {t('pageBrowser.filter.clearAll')}
        </Button>
      )}
    </div>
  )
}
