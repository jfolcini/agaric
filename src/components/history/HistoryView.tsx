/**
 * HistoryView --- global operation log with multi-select for batch revert.
 *
 * Top-level orchestrator: owns data loading, filter state, dialog open
 * states, and composes `HistoryFilterBar` + `HistorySelectionToolbar`
 * + `HistoryListView` + the revert / restore dialogs. Selection,
 * keyboard navigation, list rendering, and the dialog IPCs each live
 * In their own hook / sibling component.
 */

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Clock } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { FeatureErrorBoundary } from '@/components/common/FeatureErrorBoundary'
import { HistoryRestoreDialog } from '@/components/dialogs/HistoryRestoreDialog'
import { HistoryRevertDialog } from '@/components/dialogs/HistoryRevertDialog'
import { HistoryFilterBar } from '@/components/history/HistoryFilterBar'
import { HistoryListView } from '@/components/history/HistoryListView'
import { HistorySelectionToolbar } from '@/components/history/HistorySelectionToolbar'
import { ViewHeader } from '@/components/layout/ViewHeader'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { CompactionCard } from '@/components/templates/CompactionCard'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { useHistoryDiffToggle } from '@/hooks/useHistoryDiffToggle'
import { useHistoryKeyboardNav } from '@/hooks/useHistoryKeyboardNav'
import { entryKey, useHistorySelection } from '@/hooks/useHistorySelection'
import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { useRegisterPrimaryFocus } from '@/hooks/usePrimaryFocus'
import { categorizeHistoryError, type HistoryErrorCategory } from '@/lib/categorize-history-error'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'
import type { HistoryEntry, PageResponse } from '@/lib/tauri'
import { listPageHistory } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

export function HistoryView(): React.ReactElement {
  const { t } = useTranslation()
  const [opTypeFilter, setOpTypeFilter] = useState<string | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<HistoryEntry | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  // Phase 8 — current-space scoping. Default `false` ⇒ pass the
  // current space id so only ops on pages in this space are returned.
  // Toggling on drops the filter (cross-space `t('history.allSpacesToggle')` mode).
  //
  // Opt-in localStorage persistence so power users who audit
  // cross-space history don't have to re-flip the toggle every visit.
  // `useLocalStoragePreference` falls back to in-memory state when
  // localStorage is unavailable (private mode / quota exceeded).
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [showAllSpaces, setShowAllSpaces] = useLocalStoragePreference<boolean>(
    'agaric:history:allSpacesToggle',
    false,
  )
  const { expandedKeys, diffCache, loadingDiffs, handleToggleDiff } = useHistoryDiffToggle<string>(
    (entry) => entryKey(entry),
  )

  const listRef = useRef<HTMLDivElement>(null)
  // Register the list container as the primary focus target so switching to
  // History via sidebar lands focus on the entries list (not #main-content),
  // Letting the user immediately arrow-navigate.
  useRegisterPrimaryFocus(listRef)

  // ── Data loading ─────────────────────────────────────────────────
  // Phase 8 — when `t('history.allSpacesToggle')` is off, narrow the IPC to the
  // current space. When on (or when no current space exists yet), pass
  // `undefined` so the backend returns ops from every space.
  const effectiveSpaceId = showAllSpaces ? undefined : (currentSpaceId ?? undefined)

  // #2634 — migrated off `usePaginatedQuery` onto TanStack `useInfiniteQuery`
  // directly (staged retirement of the generic hook; matching the merged
  // `HistoryPanel` / `DonePanel` pattern). The query key carries the real fetch
  // inputs (op-type filter + effective space), so a filter/scope change is a
  // fresh query — reproducing the old request-id guard: a late load-more
  // response for a superseded filter/scope lands in that key's (now
  // observer-less) cache entry instead of being grafted onto the new list
  // (#2256). `listPageHistory` takes no AbortSignal, so — as before migration —
  // none is forwarded. Exported so `reloadAfterMutation` can reset this exact
  // cache entry without re-deriving (and risking drift from) the key.
  const queryKey = useMemo(
    () => ['pageHistory', opTypeFilter, effectiveSpaceId ?? null],
    [opTypeFilter, effectiveSpaceId],
  )
  const {
    data,
    isFetching,
    isError,
    error: queryError,
    errorUpdatedAt,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(
    {
      queryKey,
      queryFn: async ({ pageParam }): Promise<PageResponse<HistoryEntry>> => {
        try {
          const result = await listPageHistory({
            pageId: '__all__',
            ...(opTypeFilter != null && { opTypeFilter }),
            ...(effectiveSpaceId != null && { spaceId: effectiveSpaceId }),
            ...(pageParam != null && { cursor: pageParam }),
            limit: PAGINATION_LIMIT,
          })
          return result
        } catch (err) {
          const category = categorizeHistoryError(err)
          logger.error(
            'HistoryView',
            'Failed to load history page',
            {
              category,
              opTypeFilter: opTypeFilter ?? null,
              spaceId: effectiveSpaceId ?? null,
              cursor: pageParam ?? null,
            },
            err,
          )
          throw err
        }
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor : undefined),
      // usePaginatedQuery re-fetched page 1 on every mount; preserve that.
      refetchOnMount: 'always',
      // #2639 — the op-type filter / space scope switch in place (no remount), so
      // `refetchOnMount` alone doesn't re-hit the backend when returning to a
      // previously-viewed filter/scope, and `reloadAfterMutation` only resets the
      // CURRENT key — a cached other-filter view could show pre-mutation pages.
      // `staleTime: 0` marks each key immediately stale, so re-observing a cached
      // basis triggers a background refetch, restoring the old
      // always-refetch-on-basis-change freshness (window/reconnect refetch stay
      // off, so no time-based churn).
      staleTime: 0,
      // Stale-while-revalidate parity: usePaginatedQuery never cleared `entries`
      // on a deps change (only a successful response overwrote them). With the
      // inputs now in the key, an op-type/scope change would otherwise blank the
      // list to a skeleton until the refetch resolves; `keepPreviousData` keeps
      // the prior entries visible (per-key cache writes unchanged, so the #2256
      // stale-guard still holds).
      placeholderData: keepPreviousData,
      // No `invalidationKey` (monotonic key) sits in this key, so the entry set
      // is bounded and the client's default `gcTime: Infinity` is left in place
      // (mirrors `useUnlinkedReferences`; unlike `DonePanel`, which bounds it).
    },
    queryClient,
  )

  const entries = useMemo<HistoryEntry[]>(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  // usePaginatedQuery's `loading` was true during ANY in-flight fetch (initial
  // AND load-more), driving both the skeleton and the LoadMoreButton busy state —
  // `isFetching` reproduces that (`isLoading` would be false during load-more).
  const loading = isFetching
  const hasMore = hasNextPage
  // usePaginatedQuery exposed `error` as the `onError` string on any failed load
  // (cleared on next success). `isError` latches on the same condition, so the
  // banner shows the same generic title exactly when the last fetch failed.
  const error = isError ? t('history.loadFailed') : null
  // Sub-fix 7: the categorised failure drives the banner's network/server/unknown
  // detail line. #2639 — DERIVED from the query error (not component state set
  // inside the queryFn): the cached error survives across remount, so deriving it
  // keeps the detail line correct immediately on reopen. The old component-state
  // reset to `null` on remount, briefly showing the `unknown` fallback against a
  // cached network/server failure until `refetchOnMount` re-ran the queryFn.
  const errorCategory: HistoryErrorCategory | null =
    isError && queryError != null ? categorizeHistoryError(queryError) : null
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  // usePaginatedQuery's `reload` reset the cursor and re-issued page 1 without
  // clearing items — `refetch()` re-runs the query for the retry button.
  const reload = useCallback(() => {
    void refetch()
  }, [refetch])

  // Reproduce usePaginatedQuery's `onError: t('history.loadFailed')` toast, which
  // fired `notify.error` from its catch on EACH failed load (initial and every
  // load-more). TanStack keeps `isError` latched across consecutive same-key
  // failures, so keying only on `isError` would toast just once; `errorUpdatedAt`
  // advances on every error occurrence, firing the toast once per failed load.
  // The `!isFetching` gate makes a cached error (gcTime Infinity) safe on
  // remount: `refetchOnMount: 'always'` puts the query straight into `isFetching`
  // while it re-validates, so a stale cached failure can't toast before the fresh
  // fetch settles — only a genuinely settled error does (#2639). The first-render
  // ref still de-dupes the same settled error across unrelated re-renders. Mirrors
  // HistoryPanel's shared toast.
  const lastToastedErrorAtRef = useRef(errorUpdatedAt)
  useEffect(() => {
    if (isError && !isFetching && errorUpdatedAt !== lastToastedErrorAtRef.current) {
      lastToastedErrorAtRef.current = errorUpdatedAt
      notify.error(t('history.loadFailed'))
    }
  }, [isError, isFetching, errorUpdatedAt, t])

  // ── Selection (multi-select with shift-range) ────────────────────
  const {
    selectedIds,
    toggleSelectedIndex,
    selectAll,
    clearSelection,
    handleRowClick: selectionHandleRowClick,
    getSelectedEntries,
  } = useHistorySelection(entries)

  // ── Keyboard navigation (Arrow / vim / Home / End / PageUp/Down) ─
  const { focusedIndex, setFocusedIndex } = useHistoryKeyboardNav({
    itemCount: entries.length,
    listRef,
    hasSelection: selectedIds.size > 0,
    onToggleSelection: toggleSelectedIndex,
    onSelectAll: selectAll,
    onConfirmRevert: () => setConfirmRevert(true),
    onClearSelection: clearSelection,
  })

  // Reset selection + focus when filter changes (entries are replaced
  // By the paginated query). Phase 8 — also resets when the
  // space scope flips so a stale selection from the previous scope
  // doesn't leak into the new one.
  useEffect(() => {
    clearSelection()
    setFocusedIndex(0)
  }, [opTypeFilter, effectiveSpaceId, setFocusedIndex, clearSelection])

  // Glue selection+focus row click together for HistoryListView.
  const handleRowClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      selectionHandleRowClick(index, e)
      setFocusedIndex(index)
    },
    [selectionHandleRowClick, setFocusedIndex],
  )

  const handleRestoreToHere = useCallback((entry: HistoryEntry) => {
    setRestoreTarget(entry)
    setConfirmRestore(true)
  }, [])

  // Post-revert / post-restore reload — clears local pagination state
  // and re-issues the initial query. The old hook did `setItems([])` (blank the
  // list) then `reload()` (reset the cursor, refetch page 1). `resetQueries`
  // reproduces both: it restores this entry to its pre-fetch state (entries →
  // []) and refetches from `initialPageParam` (page 1 only) — `refetch()` alone
  // would re-request every loaded page and keep the stale list visible under
  // `keepPreviousData`.
  const reloadAfterMutation = useCallback(() => {
    clearSelection()
    void queryClient.resetQueries({ queryKey })
  }, [clearSelection, queryKey])

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="history-view space-y-4">
      {/* Op log compaction card.
          Wrapped in FeatureErrorBoundary so a status-fetch / compaction crash
          here doesn't take out the rest of HistoryView (UX Tier 3). */}
      <FeatureErrorBoundary name="CompactionCard">
        <CompactionCard />
      </FeatureErrorBoundary>

      <ViewHeader>
        <div className="history-view-header space-y-2">
          {/* Filter bar */}
          <HistoryFilterBar
            opTypeFilter={opTypeFilter}
            onFilterChange={setOpTypeFilter}
            showAllSpaces={showAllSpaces}
            onShowAllSpacesChange={setShowAllSpaces}
          />

          {/* Selection toolbar — only render when items are selected so that
              batch actions (revert, clear) disappear after completion. Keeps
              the "N selected" text out of the DOM when nothing is selected. */}
          {selectedIds.size > 0 && (
            <HistorySelectionToolbar
              selectedCount={selectedIds.size}
              reverting={false}
              onRevertClick={() => setConfirmRevert(true)}
              onClearSelection={clearSelection}
            />
          )}
        </div>
      </ViewHeader>

      {/* Loading skeletons */}
      {loading && entries.length === 0 && (
        <LoadingSkeleton count={3} height="h-16" className="history-view-loading" />
      )}

      {/* Error banner.
           sub-fix 7: keep the existing `history.loadFailed` heading
          (so screen-readers and existing tests still see it) and append a
          category-specific detail line so users get actionable context. */}
      {error && (
        <div
          className="history-error flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
          role="alert"
          data-error-category={errorCategory ?? 'unknown'}
        >
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-destructive">{error}</p>
            <p className="text-xs text-muted-foreground" data-testid="history-error-detail">
              {errorCategory === 'network'
                ? t('history.errorNetwork')
                : errorCategory === 'server'
                  ? t('history.errorServer')
                  : t('history.errorUnknown')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => reload()}>
            {t('history.retryButton')}
          </Button>
        </div>
      )}

      {/* Empty state.
           Phase 8 — when scoped to the current space, surface the
          "Toggle 'All spaces' to see history from other spaces." hint
          so users understand why the list is empty and how to expand
          the scope. The cross-space ("All spaces" on) empty state keeps
          the existing generic copy. */}
      {!loading && !error && entries.length === 0 && (
        <EmptyState
          icon={Clock}
          message={
            !showAllSpaces && currentSpaceId !== null
              ? t('history.emptyCurrentSpace')
              : t('history.noEntriesFound')
          }
        />
      )}

      <HistoryListView
        entries={entries}
        selectedIds={selectedIds}
        focusedIndex={focusedIndex}
        expandedKeys={expandedKeys}
        diffCache={diffCache}
        loadingDiffs={loadingDiffs}
        listRef={listRef}
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        onRowClick={handleRowClick}
        onToggleSelection={toggleSelectedIndex}
        onToggleDiff={handleToggleDiff}
        onRestoreToHere={handleRestoreToHere}
      />

      {/* touch-only ↑/↓ navigation buttons.
          Vim-mode (`j`/`k`) and arrow keys only fire on physical keyboards;
          on touch devices the user has no equivalent. These two buttons map
          to the same `setFocusedIndex` calls a keyboard nav step would make.
          Hidden on pointer:fine (mouse / trackpad) — those users already
          have arrow keys. Hidden when there are no entries. */}
      {entries.length > 0 && (
        <div
          className="hidden [@media(pointer:coarse)]:flex sticky bottom-2 z-10 self-end gap-2 rounded-full border bg-background/95 p-1 shadow-(--shadow-resting) backdrop-blur"
          role="toolbar"
          aria-label={t('history.touchNavLabel')}
          data-testid="history-touch-nav"
        >
          <IconButton
            type="button"
            variant="ghost"
            size="icon-sm"
            ariaLabel={t('history.touchNavPrev')}
            tooltip={t('history.touchNavPrev')}
            disabled={focusedIndex <= 0}
            onClick={() => setFocusedIndex((idx) => (idx > 0 ? idx - 1 : 0))}
          >
            <ChevronUp className="h-4 w-4" />
          </IconButton>
          <IconButton
            type="button"
            variant="ghost"
            size="icon-sm"
            ariaLabel={t('history.touchNavNext')}
            tooltip={t('history.touchNavNext')}
            disabled={focusedIndex >= entries.length - 1}
            onClick={() =>
              setFocusedIndex((idx) => (idx < entries.length - 1 ? idx + 1 : entries.length - 1))
            }
          >
            <ChevronDown className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {/* Revert confirmation dialog */}
      <HistoryRevertDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        selectedEntries={getSelectedEntries()}
        onSuccess={reloadAfterMutation}
      />

      {/* Restore-to-here confirmation dialog */}
      <HistoryRestoreDialog
        open={confirmRestore}
        onOpenChange={(open) => {
          setConfirmRestore(open)
          if (!open) setRestoreTarget(null)
        }}
        restoreTarget={restoreTarget}
        onSuccess={reloadAfterMutation}
      />
    </div>
  )
}
