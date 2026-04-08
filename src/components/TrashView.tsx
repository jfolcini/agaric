/**
 * TrashView — shows soft-deleted blocks (p15-t23..t25).
 *
 * WHERE deleted_at IS NOT NULL. Paginated via cursor.
 * Supports restore (p15-t24) and permanent purge (p15-t25).
 * Multi-select with shift-click range selection and batch actions.
 * Original location breadcrumbs via batchResolve.
 */

import { RotateCcw, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BatchActionToolbar } from '@/components/BatchActionToolbar'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { formatTimestamp } from '../lib/format'
import type { BlockRow, ResolvedBlock } from '../lib/tauri'
import { batchResolve, listBlocks, purgeBlock, restoreBlock } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'
import { EmptyState } from './EmptyState'
import { ListViewState } from './ListViewState'

export function TrashView(): React.ReactElement {
  const { t } = useTranslation()
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
    setItems: setBlocks,
  } = usePaginatedQuery(queryFn, { onError: t('trash.loadFailed') })

  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)

  // ── Multi-select state ───────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null)
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
      .catch(() => {
        // Silently fail — breadcrumbs are non-critical
      })
    return () => {
      cancelled = true
    }
  }, [parentIds])

  // ── Selection helpers ────────────────────────────────────────────

  const toggleSelection = useCallback(
    (index: number) => {
      const block = blocks[index]
      if (!block) return
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(block.id)) {
          next.delete(block.id)
        } else {
          next.add(block.id)
        }
        return next
      })
      setLastClickedIndex(index)
    },
    [blocks],
  )

  const rangeSelect = useCallback(
    (toIndex: number) => {
      const fromIndex = lastClickedIndex != null && lastClickedIndex >= 0 ? lastClickedIndex : 0
      const start = Math.min(fromIndex, toIndex)
      const end = Math.max(fromIndex, toIndex)
      setSelected((prev) => {
        const next = new Set(prev)
        for (let i = start; i <= end; i++) {
          const block = blocks[i]
          if (block) next.add(block.id)
        }
        return next
      })
      setLastClickedIndex(toIndex)
    },
    [blocks, lastClickedIndex],
  )

  const selectAll = useCallback(() => {
    const next = new Set<string>()
    for (const block of blocks) {
      next.add(block.id)
    }
    setSelected(next)
  }, [blocks])

  const clearSelection = useCallback(() => {
    setSelected(new Set())
  }, [])

  // ── Row click handler ────────────────────────────────────────────

  const handleRowClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      if (e.shiftKey) {
        rangeSelect(index)
      } else if (e.ctrlKey || e.metaKey) {
        toggleSelection(index)
      } else {
        toggleSelection(index)
      }
    },
    [rangeSelect, toggleSelection],
  )

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
      if (e.key === ' ' && lastClickedIndex != null && lastClickedIndex >= 0) {
        e.preventDefault()
        toggleSelection(lastClickedIndex)
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
  }, [lastClickedIndex, toggleSelection, selectAll, selected.size, clearSelection])

  // ── Single-item actions ──────────────────────────────────────────

  const handleRestore = useCallback(
    async (block: BlockRow) => {
      if (!block.deleted_at) return
      try {
        await restoreBlock(block.id, block.deleted_at)
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(block.id)
          return next
        })
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
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(blockId)
          return next
        })
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
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        if (block.block_type === 'page' || block.block_type === 'tag') {
          useResolveStore.getState().set(block.id, block.content ?? 'Untitled', false)
        }
        restored++
      } catch {
        // continue with next
      }
    }
    setSelected(new Set())
    if (restored > 0) {
      toast.success(t('trash.batchRestored', { count: restored }))
    }
  }, [blocks, selected, setBlocks, t])

  const handleBatchPurge = useCallback(async () => {
    const selectedIds = Array.from(selected)
    if (selectedIds.length === 0) return
    let purged = 0
    for (const id of selectedIds) {
      try {
        await purgeBlock(id)
        setBlocks((prev) => prev.filter((b) => b.id !== id))
        purged++
      } catch {
        // continue with next
      }
    }
    setSelected(new Set())
    setConfirmBatchPurge(false)
    if (purged > 0) {
      toast.success(t('trash.batchPurged', { count: purged }))
    }
  }, [selected, setBlocks, t])

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
        {(items) => (
          // biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn
          <div className="trash-view-list space-y-2" role="list" aria-label={t('trash.listLabel')}>
            {items.map((block, index) => {
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
                  onClick={(e) => handleRowClick(index, e)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleSelection(index)
                    }
                  }}
                >
                  <div className="trash-item-content flex min-w-0 items-center gap-3 flex-wrap">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelection(index)}
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
                        {block.content ?? t('trash.emptyContent')}
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
        )}
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
