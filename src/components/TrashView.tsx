/**
 * TrashView — shows soft-deleted blocks (p15-t23..t25).
 *
 * WHERE deleted_at IS NOT NULL. Paginated via cursor.
 * Supports restore (p15-t24) and permanent purge (p15-t25).
 * Multi-select with shift-click range selection and batch actions.
 * Original location breadcrumbs via batchResolve.
 */

import { RotateCcw, Search, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BatchActionToolbar } from '@/components/BatchActionToolbar'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'
import { useListMultiSelect } from '../hooks/useListMultiSelect'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import { formatTimestamp } from '../lib/format'
import { logger } from '../lib/logger'
import type { BlockRow, ResolvedBlock } from '../lib/tauri'
import { batchResolve, listBlocks, purgeBlock, restoreBlock } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'
import { EmptyState } from './EmptyState'
import { ListViewState } from './ListViewState'
import { renderRichContent } from './StaticBlock'

export function TrashView(): React.ReactElement {
  const { t } = useTranslation()
  const callbacks = useRichContentCallbacks()
  const queryFn = useCallback(
    (cursor?: string) =>
      listBlocks({ showDeleted: true, ...(cursor != null && { cursor }), limit: 50 }),
    [],
  )
  const {
    items: blocks,
    loading,
    hasMore,
    loadMore,
    reload,
    setItems: setBlocks,
  } = usePaginatedQuery(queryFn, { onError: t('trash.loadFailed') })

  // ── Filter state ─────────────────────────────────────────────────
  const [filterText, setFilterText] = useState('')
  const [debouncedFilter, setDebouncedFilter] = useState('')
  const debounced = useDebouncedCallback((value: string) => {
    setDebouncedFilter(value)
  }, 300)

  const filteredBlocks = useMemo(() => {
    if (!debouncedFilter) return blocks
    const lower = debouncedFilter.toLowerCase()
    return blocks.filter((b) => (b.content ?? '').toLowerCase().includes(lower))
  }, [blocks, debouncedFilter])

  const clearFilter = useCallback(() => {
    setFilterText('')
    setDebouncedFilter('')
    debounced.cancel()
  }, [debounced])

  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)

  // ── Multi-select (shared hook) ────────────────────────────────────
  const { selected, toggleSelection, selectAll, clearSelection, handleRowClick, lastClickedId } =
    useListMultiSelect({
      items: filteredBlocks,
      getItemId: (b: BlockRow) => b.id,
    })
  const [confirmBatchPurge, setConfirmBatchPurge] = useState(false)

  // ── Original location breadcrumbs ────────────────────────────────
  const [parentMap, setParentMap] = useState<Map<string, ResolvedBlock | null>>(new Map())

  const parentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const block of blocks) {
      if (block.parent_id) ids.add(block.parent_id)
    }
    return Array.from(ids)
  }, [blocks])

  useEffect(() => {
    if (parentIds.length === 0) return
    let cancelled = false
    batchResolve(parentIds)
      .then((resolved) => {
        if (cancelled) return
        const map = new Map<string, ResolvedBlock | null>()
        for (const r of resolved) {
          map.set(r.id, r)
        }
        // Mark missing IDs as null (parent page was deleted and purged)
        for (const id of parentIds) {
          if (!map.has(id)) map.set(id, null)
        }
        setParentMap(map)
      })
      .catch((err) => {
        logger.warn('TrashView', 'breadcrumb resolution failed', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [parentIds])

  // ── Keyboard shortcuts ───────────────────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return

      // Space — toggle focused/first item (simplified: toggle last clicked)
      if (e.key === ' ' && lastClickedId != null) {
        e.preventDefault()
        toggleSelection(lastClickedId)
        return
      }

      // Ctrl/Cmd+A — select all visible
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault()
        selectAll()
        return
      }

      // Escape — clear selection
      if (e.key === 'Escape' && selected.size > 0) {
        e.preventDefault()
        clearSelection()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [lastClickedId, toggleSelection, selectAll, selected.size, clearSelection])

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
      } catch {
        toast.error(t('trash.restoreFailed'))
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
      } catch {
        toast.error(t('trash.purgeFailed'))
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
    if (restored > 0) {
      toast.success(t('trash.batchRestored', { count: restored }))
    }
  }, [blocks, selected, reload, clearSelection, t])

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
    }
  }, [selected, reload, clearSelection, t])

  // ── Breadcrumb helper ────────────────────────────────────────────

  const getParentLabel = useCallback(
    (block: BlockRow): string | null => {
      if (!block.parent_id) return null
      const resolved = parentMap.get(block.parent_id)
      if (resolved === undefined) return null // not yet loaded
      if (resolved === null || resolved.deleted) return t('trash.deletedPage')
      return resolved.title ?? t('trash.deletedPage')
    },
    [parentMap, t],
  )

  return (
    <section className="trash-view space-y-4" aria-label={t('trash.regionLabel')}>
      {/* Filter input */}
      {blocks.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('trash.filterPlaceholder')}
            aria-label={t('trash.filterPlaceholder')}
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value)
              debounced.schedule(e.target.value)
            }}
            className="pl-9"
            data-testid="trash-filter-input"
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
        >
          <Button variant="outline" size="sm" onClick={selectAll}>
            {t('trash.selectAllButton')}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            {t('trash.deselectAllButton')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleBatchRestore}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('trash.restoreAllButton')}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setConfirmBatchPurge(true)}>
            {t('trash.purgeAllButton')}
          </Button>
        </BatchActionToolbar>
      )}

      <ListViewState
        loading={loading}
        items={blocks}
        skeleton={<LoadingSkeleton count={2} height="h-14" className="trash-view-loading" />}
        empty={<EmptyState icon={Trash2} message={t('trash.emptyMessage')} />}
      >
        {() =>
          debouncedFilter && filteredBlocks.length === 0 ? (
            <EmptyState
              icon={Search}
              message={t('trash.noMatchMessage')}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={clearFilter}
                  data-testid="trash-clear-filter-btn"
                >
                  {t('trash.clearFilter')}
                </Button>
              }
            />
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn
            <div
              className="trash-view-list space-y-2"
              role="list"
              aria-label={t('trash.listLabel')}
            >
              {filteredBlocks.map((block) => {
                const isSelected = selected.has(block.id)
                const parentLabel = getParentLabel(block)
                return (
                  // biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn
                  <div
                    key={block.id}
                    role="listitem"
                    className={cn(
                      'trash-item flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 rounded-lg border bg-card p-4 transition-colors cursor-pointer',
                      isSelected
                        ? 'bg-accent/50 border-accent'
                        : 'hover:bg-accent/50 active:bg-accent/70',
                    )}
                    data-testid="trash-item"
                    onClick={(e) => handleRowClick(block.id, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleSelection(block.id)
                      }
                    }}
                  >
                    <div className="trash-item-content flex min-w-0 items-center gap-3 flex-wrap">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelection(block.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 shrink-0 rounded border-border [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
                        aria-label={t('trash.selectItemLabel', {
                          content: block.content ?? t('trash.emptyContent'),
                        })}
                        data-testid="trash-item-checkbox"
                      />
                      <Badge variant="secondary" className="trash-item-type shrink-0">
                        {block.block_type}
                      </Badge>
                      <div className="flex flex-col min-w-0">
                        <span className="trash-item-text text-sm truncate">
                          {block.content
                            ? renderRichContent(block.content, {
                                interactive: false,
                                ...callbacks,
                              })
                            : t('trash.emptyContent')}
                        </span>
                        <span className="trash-item-date text-xs text-muted-foreground">
                          Deleted:{' '}
                          {block.deleted_at ? formatTimestamp(block.deleted_at, 'relative') : ''}
                        </span>
                        {parentLabel && (
                          <span
                            className="trash-item-breadcrumb text-xs text-muted-foreground"
                            data-testid="trash-item-breadcrumb"
                          >
                            {t('trash.fromPage', { page: parentLabel })}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation container prevents button clicks from toggling row selection */}
                    <div
                      className="trash-item-actions flex items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="trash-restore-btn [@media(pointer:coarse)]:h-10"
                              data-testid="trash-restore-btn"
                              onClick={() => handleRestore(block)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              {t('trash.restoreButton')}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('trash.restoreTooltip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="trash-purge-btn [@media(pointer:coarse)]:h-10"
                        data-testid="trash-purge-btn"
                        onClick={() => setConfirmPurgeId(block.id)}
                      >
                        {t('trash.purgeButton')}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        }
      </ListViewState>

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

      {/* Single purge confirmation dialog */}
      <ConfirmDialog
        open={!!confirmPurgeId}
        onOpenChange={(open) => {
          if (!open) setConfirmPurgeId(null)
        }}
        title={t('trash.permanentlyDeleteTitle')}
        description={t('trash.permanentlyDeleteDescription')}
        cancelLabel={t('trash.noButton')}
        actionLabel={t('trash.yesDeleteButton')}
        onAction={() => {
          if (confirmPurgeId) handlePurge(confirmPurgeId)
        }}
        className="trash-purge-confirm"
      />

      {/* Batch purge confirmation dialog */}
      <ConfirmDialog
        open={confirmBatchPurge}
        onOpenChange={setConfirmBatchPurge}
        title={t('trash.batchPurgeTitle', { count: selected.size })}
        description={t('trash.batchPurgeDescription', { count: selected.size })}
        cancelLabel={t('trash.noButton')}
        actionLabel={t('trash.yesDeleteButton')}
        actionVariant="destructive"
        onAction={handleBatchPurge}
        className="trash-batch-purge-confirm"
      />
    </section>
  )
}
