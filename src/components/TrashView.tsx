/**
 * TrashView — shows soft-deleted blocks (p15-t23..t25).
 *
 * WHERE deleted_at IS NOT NULL. Paginated via cursor.
 * Supports restore (p15-t24) and permanent purge (p15-t25).
 * Multi-select with shift-click range selection and batch actions.
 * Original location breadcrumbs via batchResolve.
 *
 * Sub-pieces extracted for testability (MAINT-128):
 *  - useTrashFilter / useTrashMultiSelect (hooks)
 *  - TrashRowItem (presentational sibling)
 *  - TrashPurgeDialog / TrashBatchPurgeDialog / TrashBatchRestoreDialog
 *    / TrashEmptyDialog / TrashRestoreAllDialog (sibling dialogs)
 */

import { RotateCcw, Search, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BatchActionToolbar } from '@/components/BatchActionToolbar'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRichContentCallbacks, useTagClickHandler } from '../hooks/useRichContentCallbacks'
import { useTrashBreadcrumbs } from '../hooks/useTrashBreadcrumbs'
import { useTrashDescendantCounts } from '../hooks/useTrashDescendantCounts'
import { useTrashFilter } from '../hooks/useTrashFilter'
import { useTrashListShortcuts } from '../hooks/useTrashListShortcuts'
import { useTrashMultiSelect } from '../hooks/useTrashMultiSelect'
import { announce } from '../lib/announcer'
import { logger } from '../lib/logger'
import type { BlockRow } from '../lib/tauri'
import {
  listBlocks,
  purgeAllDeleted,
  purgeBlock,
  restoreAllDeleted,
  restoreBlock,
} from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import { TrashBatchPurgeDialog } from './TrashView/TrashBatchPurgeDialog'
import { TrashBatchRestoreDialog } from './TrashView/TrashBatchRestoreDialog'
import { TrashEmptyDialog } from './TrashView/TrashEmptyDialog'
import { TrashListView } from './TrashView/TrashListView'
import { TrashPurgeDialog } from './TrashView/TrashPurgeDialog'
import { TrashRestoreAllDialog } from './TrashView/TrashRestoreAllDialog'

export function TrashView(): React.ReactElement {
  const { t } = useTranslation()
  const callbacks = useRichContentCallbacks()
  const onTagClick = useTagClickHandler()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const queryFn = useCallback(
    (cursor?: string) =>
      // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. The trash
      // surface is scoped to the active space (each space owns its
      // own deletion set). The `?? ''` fallback is intentional
      // pre-bootstrap behaviour: empty string forces a no-match SQL
      // filter rather than a runtime null deref.
      listBlocks({
        showDeleted: true,
        ...(cursor != null && { cursor }),
        limit: 50,
        spaceId: currentSpaceId ?? '',
      }),
    [currentSpaceId],
  )
  const {
    items: blocks,
    loading,
    hasMore,
    loadMore,
    reload,
    setItems: setBlocks,
  } = usePaginatedQuery(queryFn, { onError: t('trash.loadFailed') })

  // ── Filter state (extracted hook) ────────────────────────────────
  const { filterText, setFilterText, debouncedFilter, filteredBlocks, clearFilter } =
    useTrashFilter({ blocks })

  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement>(null)

  // ── Multi-select (extracted hook) ────────────────────────────────
  const { selected, toggleSelection, selectAll, clearSelection, handleRowClick } =
    useTrashMultiSelect({ items: filteredBlocks })
  const [confirmBatchPurge, setConfirmBatchPurge] = useState(false)
  const [confirmBatchRestore, setConfirmBatchRestore] = useState(false)
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false)
  const [confirmRestoreAll, setConfirmRestoreAll] = useState(false)

  // UX-275 sub-fix 8: prompt before restoring large batches (>5) so the user
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset on filter change
  useEffect(() => {
    setFocusedIndex(0)
  }, [debouncedFilter, setFocusedIndex])

  // ── Original-location breadcrumbs + descendant counts (extracted) ──
  const getParentLabel = useTrashBreadcrumbs(blocks)
  const descendantCounts = useTrashDescendantCounts(blocks)

  // ── Single-item actions ──────────────────────────────────────────

  const handleRestore = useCallback(
    async (block: BlockRow) => {
      if (!block.deleted_at) return
      try {
        await restoreBlock(block.id, block.deleted_at)
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        if (block.block_type === 'page' || block.block_type === 'tag') {
          useResolveStore.getState().set(block.id, block.content ?? 'Untitled', false)
        }
        toast.success(t('trash.blockRestored'))
        announce(t('announce.blockRestored'))
      } catch (err) {
        logger.error('TrashView', 'Failed to restore block', { blockId: block.id }, err)
        toast.error(t('trash.restoreFailed'))
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
        toast.success(t('trash.blockPurged'))
        announce(t('announce.blockPurged'))
      } catch (err) {
        logger.error('TrashView', 'Failed to purge block', { blockId }, err)
        toast.error(t('trash.purgeFailed'))
        announce(t('announce.purgeFailed'))
      }
    },
    [setBlocks, t],
  )

  // ── Batch actions ────────────────────────────────────────────────

  const handleBatchRestore = useCallback(async () => {
    const selectedBlocks = blocks.filter((b) => selected.has(b.id))
    if (selectedBlocks.length === 0) return
    let restored = 0
    for (const block of selectedBlocks) {
      if (!block.deleted_at) continue
      try {
        await restoreBlock(block.id, block.deleted_at)
        if (block.block_type === 'page' || block.block_type === 'tag') {
          useResolveStore.getState().set(block.id, block.content ?? 'Untitled', false)
        }
        restored++
      } catch (err) {
        logger.warn('TrashView', 'Restore failed for block', { blockId: block.id }, err)
      }
    }
    reload()
    clearSelection()
    setConfirmBatchRestore(false)
    if (restored > 0) {
      toast.success(t('trash.batchRestored', { count: restored }))
      announce(t('announce.batchRestored', { count: restored }))
    }
  }, [blocks, selected, reload, clearSelection, t])

  // UX-275 sub-fix 8: gated entry point for the batch restore action.
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

  const handleBatchPurge = useCallback(async () => {
    const selectedIds = Array.from(selected)
    if (selectedIds.length === 0) return
    let purged = 0
    for (const id of selectedIds) {
      try {
        await purgeBlock(id)
        purged++
      } catch (err) {
        logger.warn(
          'TrashView',
          'Purge failed for block, may have been cascade-deleted',
          { blockId: id },
          err,
        )
        if (
          err != null &&
          typeof err === 'object' &&
          'kind' in err &&
          (err as { kind: string }).kind === 'not_found'
        ) {
          purged++
        }
      }
    }
    reload()
    clearSelection()
    setConfirmBatchPurge(false)
    if (purged > 0) {
      toast.success(t('trash.batchPurged', { count: purged }))
      announce(t('announce.batchPurged', { count: purged }))
    }
  }, [selected, reload, clearSelection, t])

  const handleEmptyTrash = useCallback(async () => {
    try {
      const result = await purgeAllDeleted()
      reload()
      clearSelection()
      setConfirmEmptyTrash(false)
      if (result.affected_count > 0) {
        toast.success(t('trash.allPurged', { count: result.affected_count }))
        announce(t('announce.trashEmptied', { count: result.affected_count }))
      }
    } catch (err) {
      logger.error('TrashView', 'Failed to empty trash', undefined, err)
      toast.error(t('trash.emptyTrashFailed'))
      announce(t('announce.emptyTrashFailed'))
    }
  }, [reload, clearSelection, t])

  const handleRestoreAll = useCallback(async () => {
    try {
      const result = await restoreAllDeleted()
      reload()
      clearSelection()
      setConfirmRestoreAll(false)
      if (result.affected_count > 0) {
        toast.success(t('trash.allRestored', { count: result.affected_count }))
        announce(t('announce.allRestored', { count: result.affected_count }))
      }
    } catch (err) {
      logger.error('TrashView', 'Failed to restore all blocks', undefined, err)
      toast.error(t('trash.restoreAllFailed'))
      announce(t('announce.restoreAllFailed'))
    }
  }, [reload, clearSelection, t])

  // ── Scroll focused item into view ────────────────────────────────
  useEffect(() => {
    if (focusedIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll('[data-trash-item]')
    const el = items[focusedIndex] as HTMLElement | undefined
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedIndex])

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
      {/* Filter input — SearchInput already provides an inline ✕ clear button
          (UX-221) with proper touch-target + focus-ring + a11y per AGENTS.md. */}
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

      {/* Header actions — always visible when trash has items */}
      {blocks.length > 0 && (
        <div className="flex items-center gap-2">
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
          {/* UX-275 sub-fix 6: surface Shift+Click range-select hint inside the toolbar. */}
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
        getParentLabel={getParentLabel}
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
