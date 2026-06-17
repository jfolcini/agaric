/**
 * AdvancedQueryView — the dedicated advanced-query surface (#1280).
 *
 * A builder pane — the #1280 D3 recursive nested-boolean {@link FilterGroup}
 * tree (arbitrary And/Or/Not over filter leaves) — plus the D2 controls bar
 * (full-text / sort / group-by / aggregates), over a results pane that renders
 * the live `run_advanced_query` matches. The builder tree compiles to a wire
 * `FilterExpr` via `builderTreeToFilterExpr`, which the IPC boundary (in
 * `useAdvancedQuery`) sends verbatim alongside the D2 controls.
 *
 * Two render modes:
 *   - FLAT (no group-by): the result list plus a global aggregate summary bar
 *     when aggregates are set.
 *   - GROUPED: group headers (key label + count + per-group aggregate chips)
 *     over each bucket's previewed member rows.
 *
 * Saved views remain an explicit follow-up.
 */

import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { QueryResultList } from '@/components/query/QueryResultList'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAdvancedQuery } from '@/hooks/useAdvancedQuery'
import type { AggregateSpec, FilterPrimitive, GroupSpec, SortKey } from '@/lib/tauri'
import {
  type BuilderPath,
  builderTreeToFilterExpr,
  selectAdvancedQueryBuilderForSpace,
  selectAdvancedQueryControlsForSpace,
  useAdvancedQueryStore,
} from '@/stores/advancedQuery'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

import { AggregateSummary } from './AggregateSummary'
import { FilterGroup } from './FilterGroup'
import { GroupedResults } from './GroupedResults'
import { QueryControlsBar } from './QueryControlsBar'

export interface AdvancedQueryViewProps {
  /** Navigate to a block's parent page (wired through from the app shell). */
  onNavigate?: ((pageId: string) => void) | undefined
}

export function AdvancedQueryView({ onNavigate }: AdvancedQueryViewProps): React.ReactElement {
  const { t } = useTranslation()

  // Per-space working set (not persisted; see the store).
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceKey = currentSpaceId ?? LEGACY_SPACE_KEY
  // The #1280 D3 nested-boolean builder tree (root group) for this space.
  const builder = useAdvancedQueryStore((s) =>
    selectAdvancedQueryBuilderForSpace(s, currentSpaceId),
  )
  const controls = useAdvancedQueryStore((s) =>
    selectAdvancedQueryControlsForSpace(s, currentSpaceId),
  )
  const addLeaf = useAdvancedQueryStore((s) => s.addLeaf)
  const addGroup = useAdvancedQueryStore((s) => s.addGroup)
  const removeNode = useAdvancedQueryStore((s) => s.removeNode)
  const setGroupOp = useAdvancedQueryStore((s) => s.setGroupOp)
  const toggleNegate = useAdvancedQueryStore((s) => s.toggleNegate)
  const clearBuilder = useAdvancedQueryStore((s) => s.clearBuilder)
  const setFulltext = useAdvancedQueryStore((s) => s.setFulltext)
  const setSort = useAdvancedQueryStore((s) => s.setSort)
  const setGroupBy = useAdvancedQueryStore((s) => s.setGroupBy)
  const setAggregates = useAdvancedQueryStore((s) => s.setAggregates)

  // Compile the builder tree to the wire `FilterExpr` sent verbatim by the hook.
  // `builder` identity changes only when the tree changes, so the memo (and the
  // hook's `JSON.stringify` dep-key) recompute exactly when needed.
  const filterExpr = useMemo(() => builderTreeToFilterExpr(builder), [builder])

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
    filters: [],
    filterExpr,
    fulltext: controls.fulltext,
    sort: controls.sort,
    groupBy: controls.groupBy,
    aggregates: controls.aggregates,
  })

  const handleAddLeaf = (path: BuilderPath, filter: FilterPrimitive): void =>
    addLeaf(spaceKey, path, filter)
  const handleAddGroup = (path: BuilderPath): void => addGroup(spaceKey, path)
  const handleRemoveNode = (path: BuilderPath): void => removeNode(spaceKey, path)
  const handleSetGroupOp = (path: BuilderPath, op: 'And' | 'Or'): void =>
    setGroupOp(spaceKey, path, op)
  const handleToggleNegate = (path: BuilderPath): void => toggleNegate(spaceKey, path)
  const handleClearAll = (): void => clearBuilder(spaceKey)
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
      {/* Builder pane — the #1280 D3 recursive nested-boolean tree. */}
      <div className="advanced-query-builder flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <FilterGroup
            node={builder}
            path={[]}
            depth={0}
            onAddLeaf={handleAddLeaf}
            onAddGroup={handleAddGroup}
            onRemoveNode={handleRemoveNode}
            onSetGroupOp={handleSetGroupOp}
            onToggleNegate={handleToggleNegate}
          />
          {builder.children.length > 0 && (
            <div>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleClearAll}
                aria-label={t('advancedQuery.builder.clearAll')}
              >
                {t('advancedQuery.builder.clearAll')}
              </Button>
            </div>
          )}
        </div>
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
