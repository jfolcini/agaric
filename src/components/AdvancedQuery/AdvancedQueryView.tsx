/**
 * AdvancedQueryView — the first dedicated advanced-query surface (#1280 D1).
 *
 * A builder pane (the reused Pages chip-row, restricted to the shared,
 * engine-supported filter vocabulary) over a results pane that renders the live
 * `run_advanced_query` matches. The chips form a flat conjunction; the IPC
 * boundary (in `useAdvancedQuery`) wraps them as a `FilterExpr.And` of `Leaf`
 * primitives.
 *
 * Deliberately minimal for v1 — grouping, sort/aggregate controls, nested
 * And/Or/Not, and saved views are explicit D2/D3 follow-ups, as are the
 * state/block-type/date chip editors (only the shared keys the Pages popover
 * already offers are exposed here).
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
import type { FilterPrimitive } from '@/lib/tauri'
import { selectAdvancedQueryFiltersForSpace, useAdvancedQueryStore } from '@/stores/advancedQuery'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

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
  const addFilter = useAdvancedQueryStore((s) => s.addFilter)
  const removeFilter = useAdvancedQueryStore((s) => s.removeFilter)
  const clearFilters = useAdvancedQueryStore((s) => s.clearFilters)

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
    loading,
    error,
    hasMore,
    loadingMore,
    totalCount,
    pageTitles,
    handleLoadMore,
    fetchResults,
  } = useAdvancedQuery({ filters: queryFilters })

  const handleAddFilter = (filter: FilterPrimitive): void => addFilter(spaceKey, filter)
  const handleRemoveFilter = (index: number): void => removeFilter(spaceKey, index)
  const handleClearAll = (): void => clearFilters(spaceKey)

  return (
    <div className="advanced-query-view flex flex-col gap-3" data-testid="advanced-query-view">
      {/* Builder pane — the reused chip-row, restricted to shared keys. */}
      <div className="advanced-query-builder">
        <PageBrowserFilterRow
          filters={filters}
          onAddFilter={handleAddFilter}
          onRemoveFilter={handleRemoveFilter}
          onClearAll={handleClearAll}
          hidePagesFacets
          showAdvancedFacets
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

        {!loading && !error && results.length === 0 && (
          <EmptyState message={t('advancedQuery.noResults')} compact />
        )}

        {!loading && !error && results.length > 0 && (
          <>
            <p
              className="px-1 pb-1 text-xs text-muted-foreground"
              data-testid="advanced-query-total"
            >
              {t('advancedQuery.totalCount', { count: totalCount ?? results.length })}
            </p>
            <QueryResultList results={results} pageTitles={pageTitles} onNavigate={onNavigate} />
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
