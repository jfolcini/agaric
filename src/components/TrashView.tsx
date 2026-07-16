/**
 * TrashView — shows soft-deleted blocks (p15-t23..t25).
 *
 * WHERE deleted_at IS NOT NULL. Paginated via cursor.
 * Supports restore (p15-t24) and permanent purge (p15-t25).
 * Multi-select with shift-click range selection and batch actions.
 * Original location breadcrumbs via batchResolve.
 *
 * Sub-pieces extracted for testability:
 *  - useTrashFilter (hook); multi-select via shared useListMultiSelect
 *  - TrashRowItem (presentational sibling)
 *  - TrashPurgeDialog / TrashBatchPurgeDialog / TrashBatchRestoreDialog
 *    / TrashEmptyDialog / TrashRestoreAllDialog (sibling dialogs)
 */

import { type InfiniteData, keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { RotateCcw, Search, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BatchActionToolbar } from '@/components/common/BatchActionToolbar'
import { TrashBatchPurgeDialog } from '@/components/TrashView/TrashBatchPurgeDialog'
import { TrashBatchRestoreDialog } from '@/components/TrashView/TrashBatchRestoreDialog'
import { TrashEmptyDialog } from '@/components/TrashView/TrashEmptyDialog'
import { TrashListView } from '@/components/TrashView/TrashListView'
import { TrashPurgeDialog } from '@/components/TrashView/TrashPurgeDialog'
import { TrashRestoreAllDialog } from '@/components/TrashView/TrashRestoreAllDialog'
import { Button } from '@/components/ui/button'
import { FeaturePageHeader } from '@/components/ui/feature-page-header'
import { SearchInput } from '@/components/ui/search-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { useListMultiSelect } from '@/hooks/useListMultiSelect'
import { useRichContentCallbacks, useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { useTrashBreadcrumbs } from '@/hooks/useTrashBreadcrumbs'
import { useTrashDescendantCounts } from '@/hooks/useTrashDescendantCounts'
import { useTrashFilter } from '@/hooks/useTrashFilter'
import { useTrashListShortcuts } from '@/hooks/useTrashListShortcuts'
import { announce } from '@/lib/announcer'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'
import type { BlockRow, PageResponse } from '@/lib/tauri'
import {
  listTrash,
  purgeAllDeletedInSpace,
  purgeBlock,
  purgeBlocksByIds,
  restoreAllDeletedInSpace,
  restoreBlock,
  restoreBlocksByIds,
} from '@/lib/tauri'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

export function TrashView(): React.ReactElement {
  const { t } = useTranslation()
  const callbacks = useRichContentCallbacks()
  const onTagClick = useTagClickHandler()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)

  // #2634 — migrated off `usePaginatedQuery` onto TanStack `useInfiniteQuery`
  // directly (staged retirement of the generic hook; matching the merged
  // `HistoryPanel` / `DonePanel` / `useUnlinkedReferences` pattern). The query key
  // carries the sole real fetch input the old `queryFn` closed over (the active
  // space), so a space switch is a fresh query — reproducing the old request-id
  // guard: a late load-more response for a superseded space lands in that key's
  // (now observer-less) cache entry instead of being grafted onto the new space's
  // list. There is no `invalidationKey` (the old hook subscribed to no property
  // events), so the key is stable within a space and needs no bounded `gcTime` —
  // it inherits the client's `gcTime: Infinity` (see `useUnlinkedReferences`). The
  // client is passed EXPLICITLY as the 2nd arg so no `QueryClientProvider`
  // ancestor is required (bare `render()` tests need no wrapper). `listTrash`
  // takes no AbortSignal, so — as before migration — none is forwarded.
  const queryKey = useMemo(() => ['trash', currentSpaceId], [currentSpaceId])
  const {
    data,
    isFetching,
    isError,
    errorUpdatedAt,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(
    {
      queryKey,
      queryFn: async ({ pageParam }): Promise<PageResponse<BlockRow>> => {
        // Trash is scoped to the active space (each space owns its own deletion
        // set). #2248 — with no active space there is nothing to list, so resolve
        // to an empty page locally instead of passing an empty-string sentinel to
        // the backend (which now rejects a malformed `Active('')` scope rather
        // than treating it as a no-match).
        if (currentSpaceId == null) {
          return { items: [], next_cursor: null, has_more: false, total_count: null }
        }
        return listTrash({
          ...(pageParam != null && { cursor: pageParam }),
          limit: PAGINATION_LIMIT,
          spaceId: currentSpaceId,
        })
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor : undefined),
      // usePaginatedQuery re-fetched page 1 on every mount; preserve that.
      refetchOnMount: 'always',
      // #2639 — space switching is an in-place `setCurrentSpace` (no route
      // remount), so `refetchOnMount` alone doesn't re-hit the backend on an
      // A→B→A switch: TanStack would serve space A's cached, possibly-stale trash
      // (a block deleted from another view / device sync landed in trash while we
      // showed B). `staleTime: 0` marks each key immediately stale, so
      // re-observing a cached space triggers a background refetch — restoring the
      // old always-refetch-on-basis-change freshness. Window/reconnect refetch
      // stay off (client defaults), so this adds no time-based churn.
      staleTime: 0,
      // Stale-while-revalidate parity: usePaginatedQuery's deps-change path reset
      // the cursor but NEVER cleared `items` — only a successful response
      // overwrote them, so the trash list stayed visible during a refetch. With
      // the space now in the key, a space switch would otherwise blank the list to
      // a skeleton until the refetch resolves; `keepPreviousData` retains the
      // prior key's pages until the new fetch resolves (per-key cache writes are
      // unchanged, so the stale-guard still holds).
      placeholderData: keepPreviousData,
    },
    queryClient,
  )

  const blocks = useMemo<BlockRow[]>(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  // usePaginatedQuery's `loading` was true during ANY in-flight fetch (initial
  // AND load-more), driving both the skeleton and the "Load more" busy state —
  // `isFetching` reproduces that (`isLoading` would be false during load-more).
  const loading = isFetching
  const hasMore = hasNextPage
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  // Old `reload` re-fetched page 1 (discarding later pages); `refetch` refetches
  // the loaded pages in place — same observable result for the batch-action
  // callers below (they reload to reflect a just-applied write).
  const reload = useCallback(() => {
    void refetch()
  }, [refetch])

  // `setItems` replacement (optimistic removal after single-item restore/purge).
  // The old setter mutated local state; here the same `(prev) => prev.filter(...)`
  // updater is applied per cached page via `setQueryData`, dropping the block
  // from whichever page holds it (filter-of-concat === concat-of-filtered, so the
  // flat list loses exactly that block). Fresh page objects, no mutation (#1529),
  // and — critically — NO refetch: `restoreBlock`/`purgeBlock` emit no query
  // invalidation, so the removal is purely optimistic, matching the old behaviour.
  const setBlocks = useCallback(
    (updater: (prev: BlockRow[]) => BlockRow[]) => {
      queryClient.setQueryData<InfiniteData<PageResponse<BlockRow>>>(queryKey, (old) => {
        if (!old) return old
        const pages = old.pages.map((page) => ({ ...page, items: updater(page.items) }))
        return { ...old, pages }
      })
    },
    [queryKey],
  )

  // Reproduce the old `onError: t('trash.loadFailed')` toast. usePaginatedQuery
  // called `notify.error` from its catch on EACH failed load. TanStack keeps
  // `isError` latched across consecutive same-key failures, so keying on it alone
  // would toast once; `errorUpdatedAt` advances on every error occurrence, firing
  // once per failed load. The `!isFetching` gate is what makes a cached error
  // (gcTime Infinity) safe on remount: `refetchOnMount:'always'` puts the query
  // straight into `isFetching` while it re-validates, so a stale cached failure
  // can't toast before the fresh fetch settles — only a genuinely settled error
  // does (#2639). The first-render ref still de-dupes the same settled error
  // across unrelated re-renders.
  const lastToastedErrorAtRef = useRef(errorUpdatedAt)
  useEffect(() => {
    if (isError && !isFetching && errorUpdatedAt !== lastToastedErrorAtRef.current) {
      lastToastedErrorAtRef.current = errorUpdatedAt
      notify.error(t('trash.loadFailed'))
    }
  }, [isError, isFetching, errorUpdatedAt, t])

  // ── Filter state (extracted hook) ────────────────────────────────
  const { filterText, setFilterText, debouncedFilter, filteredBlocks, clearFilter } =
    useTrashFilter({ blocks })

  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement>(null)

  // ── Multi-select (extracted hook) ────────────────────────────────
  const { selected, toggleSelection, selectAll, clearSelection, handleRowClick } =
    useListMultiSelect({ items: filteredBlocks, getItemId: (b: BlockRow) => b.id })
  const [confirmBatchPurge, setConfirmBatchPurge] = useState(false)
  const [confirmBatchRestore, setConfirmBatchRestore] = useState(false)
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false)
  const [confirmRestoreAll, setConfirmRestoreAll] = useState(false)

  // Sub-fix 8: prompt before restoring large batches (>5) so the user
  // doesn't unwind a long cascade with a misclick. Mirrors the existing
  // batch-purge confirmation flow.
  const BATCH_RESTORE_CONFIRM_THRESHOLD = 5

  // ── List keyboard navigation ─────────────────────────────────────
  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: filteredBlocks.length,
    homeEnd: true,
    pageUpDown: true,
  })

  // Reset focused index when filter changes
  useEffect(() => {
    setFocusedIndex(0)
  }, [debouncedFilter, setFocusedIndex])

  // ── Original-location breadcrumbs + descendant counts (extracted) ──
  const getPageLabel = useTrashBreadcrumbs(blocks)
  const descendantCounts = useTrashDescendantCounts(blocks)

  // ── Single-item actions ──────────────────────────────────────────

  const handleRestore = useCallback(
    async (block: BlockRow) => {
      if (!block.deleted_at) return
      try {
        await restoreBlock(block.id, block.deleted_at)
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        if (block.block_type === 'page' || block.block_type === 'tag') {
          useResolveStore.getState().set(block.id, block.content ?? t('common.untitled'), false)
        }
        notify.success(t('trash.blockRestored'))
        announce(t('announce.blockRestored'))
      } catch (err) {
        logger.error('TrashView', 'Failed to restore block', { blockId: block.id }, err)
        notify.error(t('trash.restoreFailed'))
        announce(t('announce.restoreFailed'))
      }
    },
    [setBlocks, t],
  )

  const handlePurge = useCallback(
    async (blockId: string) => {
      try {
        await purgeBlock(blockId)
        setBlocks((prev) => prev.filter((b) => b.id !== blockId))
        setConfirmPurgeId(null)
        notify.success(t('trash.blockPurged'))
        announce(t('announce.blockPurged'))
      } catch (err) {
        logger.error('TrashView', 'Failed to purge block', { blockId }, err)
        notify.error(t('trash.purgeFailed'))
        announce(t('announce.purgeFailed'))
      }
    },
    [setBlocks, t],
  )

  // ── Batch actions ────────────────────────────────────────────────

  // Single IPC for the entire batch. The previous
  // implementation looped `restoreBlock` per row (50 IMMEDIATE txs +
  // 50 op_log scopes for a 50-row selection); the backend now handles
  // the whole list in one tx. Resolve-store updates and per-row
  // failure tolerance are folded into the post-IPC pass: the backend
  // silently skips ids that are alive / missing, and we apply the
  // resolve-store hint for every selected page/tag regardless (the
  // store is content-addressable and tolerates over-broad sets).
  const handleBatchRestore = useCallback(async () => {
    const selectedBlocks = blocks.filter((b) => selected.has(b.id) && b.deleted_at)
    if (selectedBlocks.length === 0) return
    setConfirmBatchRestore(false)
    let restored = 0
    try {
      restored = await restoreBlocksByIds(selectedBlocks.map((b) => b.id))
      for (const block of selectedBlocks) {
        if (block.block_type === 'page' || block.block_type === 'tag') {
          useResolveStore.getState().set(block.id, block.content ?? t('common.untitled'), false)
        }
      }
    } catch (err) {
      // Surface the failure (matching the single-item path) and KEEP the
      // selection so the user can retry — clearing it here would silently
      // discard the user's selection on an error they couldn't see.
      logger.error('TrashView', 'Batch restore failed', { count: selectedBlocks.length }, err)
      notify.error(t('trash.batchRestoreFailed'))
      announce(t('announce.batchRestoreFailed'))
      return
    }
    reload()
    clearSelection()
    if (restored > 0) {
      notify.success(t('trash.batchRestored', { count: restored }))
      announce(t('announce.batchRestored', { count: restored }))
    }
  }, [blocks, selected, reload, clearSelection, t])

  // Sub-fix 8: gated entry point for the batch restore action.
  // Restores immediately for small selections; surfaces a confirmation
  // dialog when the batch exceeds {@link BATCH_RESTORE_CONFIRM_THRESHOLD}.
  const requestBatchRestore = useCallback(() => {
    if (selected.size > BATCH_RESTORE_CONFIRM_THRESHOLD) {
      setConfirmBatchRestore(true)
    } else {
      handleBatchRestore()
    }
  }, [selected.size, handleBatchRestore])

  // ── Keyboard shortcuts (extracted hook) ──────────────────────────
  // Hook is invoked *after* requestBatchRestore is declared — its dep
  // array references it and a forward reference would hit the TDZ.
  const requestBatchPurge = useCallback(() => setConfirmBatchPurge(true), [])
  useTrashListShortcuts({
    filteredBlocks,
    focusedIndex,
    selectedSize: selected.size,
    navHandleKeyDown,
    toggleSelection,
    selectAll,
    clearSelection,
    requestBatchRestore,
    requestBatchPurge,
  })

  // Single IPC for the entire batch. Replaces a
  // per-id loop where each iteration ran the full ~13-table cleanup
  // chain in its own IMMEDIATE tx; the backend now sweeps the whole
  // list in one tx, running each cleanup-chain query once. Cascade-
  // deleted ids that would have surfaced as `not_found` in the old
  // loop (and were counted as success) are now silently skipped server-
  // side — the returned count reflects rows actually removed.
  const handleBatchPurge = useCallback(async () => {
    const selectedIds = Array.from(selected)
    if (selectedIds.length === 0) return
    setConfirmBatchPurge(false)
    let purged = 0
    try {
      purged = await purgeBlocksByIds(selectedIds)
    } catch (err) {
      // Surface the failure (matching the single-item path) and KEEP the
      // selection so the user can retry — clearing it here would silently
      // discard the user's selection on an error they couldn't see.
      logger.error('TrashView', 'Batch purge failed', { count: selectedIds.length }, err)
      notify.error(t('trash.batchPurgeFailed'))
      announce(t('announce.batchPurgeFailed'))
      return
    }
    reload()
    clearSelection()
    if (purged > 0) {
      notify.success(t('trash.batchPurged', { count: purged }))
      announce(t('announce.batchPurged', { count: purged }))
    }
  }, [selected, reload, clearSelection, t])

  // #2544 — "Empty trash" must only touch the active space's tombstones:
  // the view, its badge, and this very dialog's item count are all
  // space-scoped, so the destructive action behind them must be too.
  // `currentSpaceId == null` mirrors `queryFn`'s guard above — with no
  // active space there is nothing loaded (and the header button that
  // triggers this is hidden), but guard defensively anyway.
  const handleEmptyTrash = useCallback(async () => {
    if (currentSpaceId == null) return
    try {
      const result = await purgeAllDeletedInSpace(currentSpaceId)
      reload()
      clearSelection()
      setConfirmEmptyTrash(false)
      if (result.affected_count > 0) {
        notify.success(t('trash.allPurged', { count: result.affected_count }))
        announce(t('announce.trashEmptied', { count: result.affected_count }))
      }
    } catch (err) {
      logger.error('TrashView', 'Failed to empty trash', undefined, err)
      notify.error(t('trash.emptyTrashFailed'))
      announce(t('announce.emptyTrashFailed'))
    }
  }, [currentSpaceId, reload, clearSelection, t])

  // #2544 — same space-scoping as handleEmptyTrash: "Restore all" must not
  // resurrect trashed blocks in spaces other than the one this view shows.
  const handleRestoreAll = useCallback(async () => {
    if (currentSpaceId == null) return
    try {
      const result = await restoreAllDeletedInSpace(currentSpaceId)
      reload()
      clearSelection()
      setConfirmRestoreAll(false)
      if (result.affected_count > 0) {
        notify.success(t('trash.allRestored', { count: result.affected_count }))
        announce(t('announce.allRestored', { count: result.affected_count }))
      }
    } catch (err) {
      logger.error('TrashView', 'Failed to restore all blocks', undefined, err)
      notify.error(t('trash.restoreAllFailed'))
      announce(t('announce.restoreAllFailed'))
    }
  }, [currentSpaceId, reload, clearSelection, t])

  // ── Scroll focused item into view ────────────────────────────────
  // #740 — the list is virtualized inside `TrashListView`, which now owns
  // keeping the keyboard-focused row in view via the virtualizer's
  // `scrollToIndex` (a DOM-index `querySelectorAll('[data-trash-item]')`
  // here would index the *windowed* slice, not the absolute list, and
  // miss any row outside the current window after a Home/End/PageDown jump).

  // ── Row click with focus tracking ────────────────────────────────
  const handleRowClickWithFocus = useCallback(
    (blockId: string, e: React.MouseEvent) => {
      handleRowClick(blockId, e)
      const index = filteredBlocks.findIndex((b) => b.id === blockId)
      if (index >= 0) setFocusedIndex(index)
    },
    [handleRowClick, filteredBlocks, setFocusedIndex],
  )

  return (
    <section className="trash-view space-y-4" aria-label={t('trash.regionLabel')}>
      {/* PEND-UX item 5 — `FeaturePageHeader` carries the `<h1>` landmark
          + right-aligned action buttons. Restore-all / Empty-trash are
          surfaced as `actions` only when the trash is non-empty so an
          empty bin doesn't display destructive controls. */}
      <FeaturePageHeader
        title={t('sidebar.trash')}
        className="trash-view-header"
        {...(blocks.length > 0 && {
          actions: (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmRestoreAll(true)}
                data-testid="trash-restore-all-btn"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('trash.restoreAllHeaderButton')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmEmptyTrash(true)}
                data-testid="trash-empty-trash-btn"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('trash.emptyTrashButton')}
              </Button>
            </>
          ),
        })}
      />

      {/* Filter input — SearchInput already provides an inline ✕ clear button
 with proper touch-target + focus-ring + a11y per AGENTS.md. */}
      {blocks.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <SearchInput
            placeholder={t('trash.filterPlaceholder')}
            aria-label={t('trash.filterPlaceholder')}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="pl-9"
            data-testid="trash-filter-input"
            clearAriaLabelKey="trash.searchClear"
          />
        </div>
      )}

      {/* Filtered count */}
      {debouncedFilter && blocks.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="trash-filter-count">
          {t('trash.showingCount', { filtered: filteredBlocks.length, total: blocks.length })}
        </p>
      )}

      {/* Selection toolbar */}
      {selected.size > 0 && (
        <BatchActionToolbar
          selectedCount={selected.size}
          className="trash-selection-toolbar gap-3 p-3"
          suppressRangeSelectHint
        >
          <Button variant="outline" size="sm" onClick={selectAll}>
            {t('trash.selectAllButton')}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            {t('trash.deselectAllButton')}
          </Button>
          {/* surface the BATCH_RESTORE_CONFIRM_THRESHOLD boundary so
              users know a confirmation kicks in for selections > 5. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={requestBatchRestore}
                data-testid="trash-batch-restore-btn"
                aria-keyshortcuts="Shift+R"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('trash.restoreSelectedButton')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>
                {t('trash.restoreThresholdTooltip', {
                  threshold: BATCH_RESTORE_CONFIRM_THRESHOLD,
                })}
              </p>
            </TooltipContent>
          </Tooltip>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmBatchPurge(true)}
            data-testid="trash-batch-purge-btn"
            aria-keyshortcuts="Shift+Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('trash.purgeSelectedButton')}
          </Button>
          {/*  sub-fix 6: surface Shift+Click range-select hint inside the toolbar. */}
          <span
            className="ml-auto hidden text-xs text-muted-foreground sm:inline"
            data-testid="trash-batch-hint"
          >
            {t('trash.batchHint')}
          </span>
        </BatchActionToolbar>
      )}

      <TrashListView
        ref={listRef}
        blocks={blocks}
        filteredBlocks={filteredBlocks}
        loading={loading}
        debouncedFilter={debouncedFilter}
        focusedIndex={focusedIndex}
        selectedIds={selected}
        descendantCounts={descendantCounts}
        callbacks={callbacks}
        onTagClick={onTagClick}
        onClearFilter={clearFilter}
        onRowClick={handleRowClickWithFocus}
        onToggleSelection={toggleSelection}
        onRestore={handleRestore}
        onRequestPurge={setConfirmPurgeId}
        getPageLabel={getPageLabel}
      />

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="trash-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? t('trash.loadingMessage') : t('trash.loadMoreButton')}
        </Button>
      )}

      <TrashPurgeDialog
        blockId={confirmPurgeId}
        onOpenChange={(open) => {
          if (!open) setConfirmPurgeId(null)
        }}
        onConfirm={handlePurge}
      />

      <TrashBatchPurgeDialog
        open={confirmBatchPurge}
        selectedCount={selected.size}
        onOpenChange={setConfirmBatchPurge}
        onConfirm={handleBatchPurge}
      />

      <TrashBatchRestoreDialog
        open={confirmBatchRestore}
        selectedCount={selected.size}
        onOpenChange={setConfirmBatchRestore}
        onConfirm={handleBatchRestore}
      />

      <TrashEmptyDialog
        open={confirmEmptyTrash}
        itemCount={blocks.length}
        hasMore={hasMore}
        onOpenChange={setConfirmEmptyTrash}
        onConfirm={handleEmptyTrash}
      />

      <TrashRestoreAllDialog
        open={confirmRestoreAll}
        onOpenChange={setConfirmRestoreAll}
        onConfirm={handleRestoreAll}
      />
    </section>
  )
}
