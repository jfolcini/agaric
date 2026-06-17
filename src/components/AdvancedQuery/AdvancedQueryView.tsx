/**
 * AdvancedQueryView — the dedicated advanced-query surface (#1280).
 *
 * A builder pane (the reused Pages chip-row, restricted to the shared,
 * engine-supported filter vocabulary) plus the D2 controls bar (full-text /
 * sort / group-by / aggregates), over a results pane that renders the live
 * `run_advanced_query` matches. The chips form a flat conjunction; the IPC
 * boundary (in `useAdvancedQuery`) wraps them as a `FilterExpr.And` of `Leaf`
 * primitives and threads the D2 controls into the request.
 *
 * Two render modes:
 *   - FLAT (no group-by): the result list plus a global aggregate summary bar
 *     when aggregates are set.
 *   - GROUPED: group headers (key label + count + per-group aggregate chips)
 *     over each bucket's previewed member rows.
 *
 * Nested And/Or/Not and saved views remain explicit D3 follow-ups.
 */

import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { PageBrowserFilterRow } from '@/components/PageBrowser/PageBrowserFilterRow'
import { QueryResultList } from '@/components/query/QueryResultList'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAdvancedQuery } from '@/hooks/useAdvancedQuery'
import type { AggregateSpec, FilterPrimitive, GroupSpec, SortKey } from '@/lib/tauri'
import {
  selectAdvancedQueryControlsForSpace,
  selectAdvancedQueryFiltersForSpace,
  useAdvancedQueryStore,
} from '@/stores/advancedQuery'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

import { AggregateSummary } from './AggregateSummary'
import { GroupedResults } from './GroupedResults'
import { QueryControlsBar } from './QueryControlsBar'

export interface AdvancedQueryViewProps {
  /** Navigate to a block's parent page (wired through from the app shell). */
  onNavigate?: ((pageId: string) => void) | undefined
}

export function AdvancedQueryView({ onNavigate }: AdvancedQueryViewProps): React.ReactElement {
  const { t } = useTranslation()

  // Per-space working set of filter chips (not persisted; see the store).
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceKey = currentSpaceId ?? LEGACY_SPACE_KEY
  const filters = useAdvancedQueryStore((s) =>
    selectAdvancedQueryFiltersForSpace(s, currentSpaceId),
  )
  const controls = useAdvancedQueryStore((s) =>
    selectAdvancedQueryControlsForSpace(s, currentSpaceId),
  )
  const addFilter = useAdvancedQueryStore((s) => s.addFilter)
  const removeFilter = useAdvancedQueryStore((s) => s.removeFilter)
  const clearFilters = useAdvancedQueryStore((s) => s.clearFilters)
  const setFulltext = useAdvancedQueryStore((s) => s.setFulltext)
  const setSort = useAdvancedQueryStore((s) => s.setSort)
  const setGroupBy = useAdvancedQueryStore((s) => s.setGroupBy)
  const setAggregates = useAdvancedQueryStore((s) => s.setAggregates)

  // The chips carry a React-key-only `_addId` stamp; strip it before the IPC so
  // the wire `FilterPrimitive` leaves stay clean (the engine rejects unknown
  // fields). `filters` identity changes whenever the chip set changes, so the
  // memo recomputes exactly when needed.
  const queryFilters = useMemo<FilterPrimitive[]>(
    () => filters.map(({ _addId, ...primitive }) => primitive),
    [filters],
  )

  const {
    results,
    groups,
    aggregates: aggregateResults,
    loading,
    error,
    hasMore,
    loadingMore,
    totalCount,
    pageTitles,
    handleLoadMore,
    fetchResults,
  } = useAdvancedQuery({
    filters: queryFilters,
    fulltext: controls.fulltext,
    sort: controls.sort,
    groupBy: controls.groupBy,
    aggregates: controls.aggregates,
  })

  const handleAddFilter = (filter: FilterPrimitive): void => addFilter(spaceKey, filter)
  const handleRemoveFilter = (index: number): void => removeFilter(spaceKey, index)
  const handleClearAll = (): void => clearFilters(spaceKey)
  const handleFulltextChange = (value: string): void => setFulltext(spaceKey, value)
  const handleSortChange = (sort: SortKey[]): void => setSort(spaceKey, sort)
  const handleGroupByChange = (groupBy: GroupSpec | null): void => setGroupBy(spaceKey, groupBy)
  const handleAggregatesChange = (aggregates: AggregateSpec[]): void =>
    setAggregates(spaceKey, aggregates)

  const isGrouped = groups != null
  // Empty when: flat mode with no rows, OR grouped mode with no groups.
  const isEmpty = isGrouped ? groups.length === 0 : results.length === 0

  return (
    <div className="advanced-query-view flex flex-col gap-3" data-testid="advanced-query-view">
      {/* Builder pane — the reused chip-row, restricted to shared keys. */}
      <div className="advanced-query-builder flex flex-col gap-3">
        <PageBrowserFilterRow
          filters={filters}
          onAddFilter={handleAddFilter}
          onRemoveFilter={handleRemoveFilter}
          onClearAll={handleClearAll}
          hidePagesFacets
          showAdvancedFacets
        />
        <QueryControlsBar
          fulltext={controls.fulltext}
          onFulltextChange={handleFulltextChange}
          sort={controls.sort}
          onSortChange={handleSortChange}
          groupBy={controls.groupBy}
          onGroupByChange={handleGroupByChange}
          aggregates={controls.aggregates}
          onAggregatesChange={handleAggregatesChange}
        />
      </div>

      {/* Results pane. */}
      <div className="advanced-query-results">
        {loading && (
          <div className="flex justify-center px-3 py-4">
            <Spinner size="sm" />
          </div>
        )}

        {!loading && error && (
          <div
            className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchResults}
              aria-label={t('action.retry')}
              disabled={loadingMore}
              aria-busy={loadingMore}
            >
              {t('action.retry')}
            </Button>
          </div>
        )}

        {!loading && !error && isEmpty && (
          <EmptyState message={t('advancedQuery.noResults')} compact />
        )}

        {!loading && !error && !isEmpty && (
          <>
            <p
              className="px-1 pb-1 text-xs text-muted-foreground"
              data-testid="advanced-query-total"
            >
              {t('advancedQuery.totalCount', {
                count: totalCount ?? (isGrouped ? groups.length : results.length),
              })}
            </p>

            {/* Global aggregate summary bar (shown in both flat and grouped mode
                when global aggregates are present). */}
            {aggregateResults != null && aggregateResults.length > 0 && (
              <div className="px-1 pb-2">
                <AggregateSummary
                  results={aggregateResults}
                  label={t('advancedQuery.aggregate.summaryLabel')}
                />
              </div>
            )}

            {isGrouped ? (
              <GroupedResults groups={groups} pageTitles={pageTitles} onNavigate={onNavigate} />
            ) : (
              <QueryResultList results={results} pageTitles={pageTitles} onNavigate={onNavigate} />
            )}

            <LoadMoreButton
              hasMore={hasMore}
              loading={loadingMore}
              onLoadMore={handleLoadMore}
              className="mx-3 my-2"
            />
          </>
        )}
      </div>
    </div>
  )
}
