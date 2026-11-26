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
 *   - BOARD (#6542): `QueryBoard`, one column per value of a group key that
 *     has one (`boardColumns`); each column runs its own query, so the view's
 *     own is off.
 *
 * Saved views (#1460): `SavedViews` (mounted below) lists and loads them, and
 * `handleSaveView`'s dialog saves the serialized spec (`serializeQuerySpec`,
 * `src/stores/advancedQuery.ts`) as a view page of the space
 * (`src/lib/saved-views.ts`, #6544).
 *
 * Results first (#7040): above the results sits a one-line summary of the
 * query (`querySummary`) and an *Edit query* button that folds the builder,
 * controls and saved views away under it. The form starts open only for an
 * empty query; loading a saved view folds it.
 */

import { SearchX } from 'lucide-react'
import type React from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AggregateSummary } from '@/components/AdvancedQuery/AggregateSummary'
import { boardColumns } from '@/components/AdvancedQuery/board-columns'
import { FilterGroup } from '@/components/AdvancedQuery/FilterGroup'
import { GroupedResults } from '@/components/AdvancedQuery/GroupedResults'
import {
  builderLeafLabel,
  isEmptyQuery,
  querySummary,
} from '@/components/AdvancedQuery/query-summary'
import { QueryBoard } from '@/components/AdvancedQuery/QueryBoard'
import { QueryControlsBar } from '@/components/AdvancedQuery/QueryControlsBar'
import { SavedViews } from '@/components/AdvancedQuery/SavedViews'
import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { RenameDialog } from '@/components/dialogs/RenameDialog'
import { QueryResultList } from '@/components/query/QueryResultList'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { FeaturePageHeader } from '@/components/ui/feature-page-header'
import { listCardVariants } from '@/components/ui/list-item'
import { useAdvancedQuery } from '@/hooks/useAdvancedQuery'
import { useSpacePropertyDefs } from '@/hooks/useSpacePropertyDefs'
import type { AggregateSpec, FilterPrimitive, GroupSpec, SortKey } from '@/lib/bindings'
import { isDateFormattedPage } from '@/lib/date-utils'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'
import { saveView } from '@/lib/saved-views'
import { cn } from '@/lib/utils'
import {
  type BuilderPath,
  builderTreeToFilterExpr,
  selectAdvancedQueryBuilderForSpace,
  selectAdvancedQueryControlsForSpace,
  type QueryViewMode,
  serializeQuerySpec,
  useAdvancedQueryStore,
} from '@/stores/advancedQuery'
import { useResolveStore } from '@/stores/resolve'
import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

export interface AdvancedQueryViewProps {
  /**
   * Open a block's page (wired through from the app shell), which shows it
   * under the title it is handed.
   */
  onNavigate?: ((pageId: string, title?: string) => void) | undefined
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
  const setView = useAdvancedQueryStore((s) => s.setView)

  // Compile the builder tree to the wire `FilterExpr` sent verbatim by the hook.
  // `builder` identity changes only when the tree changes, so the memo (and the
  // hook's `JSON.stringify` dep-key) recompute exactly when needed.
  const filterExpr = useMemo(() => builderTreeToFilterExpr(builder), [builder])

  const propertyDefs = useSpacePropertyDefs()
  const columns = useMemo(
    () => boardColumns(controls.groupBy, propertyDefs),
    [controls.groupBy, propertyDefs],
  )
  const board = controls.view === 'board' ? columns : null

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
    enabled: board == null,
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
  const handleViewChange = (view: QueryViewMode): void => setView(spaceKey, view)

  // A query that has run opens on its results, its form folded under the summary.
  const [formOpen, setFormOpen] = useState(() => isEmptyQuery(builder, controls))
  const formId = useId()
  const editRef = useRef<HTMLButtonElement>(null)
  const summary = useResolveStore((s) =>
    querySummary(builder, controls, t, (primitive) =>
      builderLeafLabel(primitive, t, s.resolveTitle),
    ),
  )

  // #1460 saved-views: "Save view" prompts for a name and saves the current
  // spec in this space.
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)

  const handleSaveView = (name: string): void => {
    // #5415 — no active space means no space to save the view in.
    if (currentSpaceId == null) {
      notify.error(t('advancedQuery.savedViews.saveError'))
      return
    }
    saveView(currentSpaceId, name, { kind: 'query', spec: serializeQuerySpec(builder, controls) })
      .then((saved) => {
        // The new row shows the save; only a refusal needs saying.
        if (!saved)
          notify.error(
            t(
              isDateFormattedPage(name)
                ? 'advancedQuery.savedViews.nameIsDate'
                : 'advancedQuery.savedViews.nameTaken',
              { name },
            ),
          )
      })
      .catch((err: unknown) => {
        reportIpcError('AdvancedQueryView', 'advancedQuery.savedViews.saveError', err, t, { name })
      })
  }

  const openPage = (pageId: string): void => onNavigate?.(pageId, pageTitles.get(pageId))

  const isGrouped = groups != null
  // Rows in flat mode, groups in grouped mode; empty when there are none.
  const shownCount = isGrouped ? groups.length : results.length
  const isEmpty = shownCount === 0

  return (
    <div
      // A list view is capped and centred; only a board spans the view.
      className={cn(
        'advanced-query-view mx-auto flex w-full flex-col gap-3',
        board == null && 'max-w-list',
      )}
      data-testid="advanced-query-view"
    >
      {/* Builder pane — the #1280 D3 recursive nested-boolean tree. It keeps
          the list column's width beside a board. */}
      <div className="advanced-query-builder mx-auto flex w-full max-w-list flex-col gap-3">
        <FeaturePageHeader title={t('sidebar.query')} />
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm" data-testid="advanced-query-summary">
            {summary}
          </p>
          <Button
            ref={editRef}
            variant="outline"
            size="sm"
            aria-expanded={formOpen}
            aria-controls={formId}
            onClick={() => setFormOpen((open) => !open)}
          >
            <ChevronToggle isExpanded={formOpen} size="md" />
            {t('advancedQuery.form.edit')}
          </Button>
        </div>
        {/* Hidden, not unmounted: the full-text box commits its term on a
            debounce that an unmount would cancel. */}
        <div id={formId} hidden={!formOpen} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t('advancedQuery.description')}</p>
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
            view={board != null ? 'board' : 'list'}
            onViewChange={handleViewChange}
            boardAvailable={columns != null}
          />

          {/* #1460 saved-views: save the current query + browse saved views. */}
          <div className="advanced-query-saved flex flex-col gap-2">
            <div>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setSaveDialogOpen(true)}
                aria-label={t('advancedQuery.savedViews.saveTitle')}
              >
                {t('advancedQuery.savedViews.save')}
              </Button>
            </div>
            <SavedViews
              spaceKey={spaceKey}
              onLoad={() => {
                setFormOpen(false)
                // The Load button folds away with the form; keep focus on the page.
                editRef.current?.focus()
              }}
            />
          </div>
        </div>

        <RenameDialog
          open={saveDialogOpen}
          onOpenChange={setSaveDialogOpen}
          onConfirm={handleSaveView}
          currentName=""
          title={t('advancedQuery.savedViews.save')}
          description={t('advancedQuery.savedViews.namePrompt')}
          ariaLabel={t('advancedQuery.savedViews.namePrompt')}
        />
      </div>

      {board != null && (
        <QueryBoard
          columns={board}
          filter={filterExpr}
          fulltext={controls.fulltext}
          sort={controls.sort}
          aggregates={controls.aggregates}
          onNavigate={onNavigate}
        />
      )}

      {/* Results pane. */}
      {board == null && (
        <div className="advanced-query-results">
          {/* Polite live region — announces that a query is (re)running so
            screen-reader users get more than silence while the list refetches.
            Mirrors SearchStatusRegion. */}
          <output
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="advanced-query-status"
          >
            {loading ? t('advancedQuery.searching') : ''}
          </output>

          {/* Initial load only (no previous results to keep on screen):
            list-shaped skeleton mirroring QueryResultList rows. On a refetch
            the prior results stay mounted (dimmed + aria-busy) below instead
            of being replaced by this skeleton. */}
          {loading && isEmpty && (
            <div className="px-3 py-2">
              <LoadingSkeleton count={5} height="h-10" ariaLabel={t('advancedQuery.searching')} />
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
            <EmptyState icon={SearchX} message={t('advancedQuery.noResults')} compact />
          )}

          {/* Results — kept visible (dimmed + aria-busy) during a refetch rather
            than unmounted and replaced by a spinner, so builder/sort/group edits
            don't blank the pane. */}
          {!error && !isEmpty && (
            <div
              aria-busy={loading}
              className={cn(loading && 'pointer-events-none opacity-60 transition-opacity')}
            >
              <p
                className="px-1 pb-1 text-xs text-muted-foreground"
                data-testid="advanced-query-total"
              >
                {/* Grouped mode pages over groups and a block can sit in several
                  (tag groups), so the group count is the only honest total. */}
                {t(isGrouped ? 'advancedQuery.groupCount' : 'advancedQuery.totalCount', {
                  count: totalCount ?? shownCount,
                })}
              </p>

              {/* Global aggregate summary bar (shown in both flat and grouped mode
                when global aggregates are present). */}
              {aggregateResults != null && aggregateResults.length > 0 && (
                <div className="px-1 pb-2">
                  <AggregateSummary
                    results={aggregateResults}
                    specs={controls.aggregates}
                    label={t('advancedQuery.aggregate.summaryLabel')}
                  />
                </div>
              )}

              {isGrouped ? (
                <GroupedResults
                  groups={groups}
                  groupBy={controls.groupBy}
                  pageTitles={pageTitles}
                  onNavigate={openPage}
                />
              ) : (
                <QueryResultList
                  results={results}
                  pageTitles={pageTitles}
                  onNavigate={openPage}
                  className={listCardVariants()}
                />
              )}

              <LoadMoreButton
                hasMore={hasMore}
                loading={loadingMore}
                onLoadMore={handleLoadMore}
                className="mx-3 my-2"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
