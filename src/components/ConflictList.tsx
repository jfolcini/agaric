/**
 * ConflictList — shows blocks where is_conflict = 1 (p2-t12, p2-t13).
 *
 * Standalone view similar to TrashView. Paginated list of conflict blocks.
 * Supports "Keep" (edit original + delete conflict) and "Discard" (delete conflict)
 * with two-click confirmation on both Keep and Discard.
 *
 * Enhanced with:
 *  - Conflict type badge (Text / Property / Move)
 *  - Metadata display: conflict source block ID, created timestamp
 *  - Expandable content (#292)
 *  - Navigation to original block (#296)
 *  - ULID timestamp decoding (#285)
 *  - Persistent help text (#304)
 *  - Aria-labels on actions (#298)
 *
 * Type-specific rendering for Text / Property / Move conflicts (#651-C2).
 * Batch resolution via multi-select + batch actions (#651-C8).
 *
 * Sub-components extracted for testability (#651-R3):
 *  - ConflictBatchToolbar
 *  - ConflictListItem
 *  - ConflictTypeRenderer
 */

import { listen } from '@tauri-apps/api/event'
import { GitMerge, RefreshCw } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ulidToDate } from '@/lib/format'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { useListMultiSelect } from '../hooks/useListMultiSelect'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { announce } from '../lib/announcer'
import type { BlockRow, DeleteResponse } from '../lib/tauri'
import {
  deleteBlock,
  editBlock,
  getBlock,
  getBlockHistory,
  getConflicts,
  getDeviceId,
  listPeerRefs,
  restoreBlock,
} from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { ConflictBatchToolbar } from './ConflictBatchToolbar'
import { ConflictListItem, inferConflictType } from './ConflictListItem'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { LoadMoreButton } from './LoadMoreButton'
import { ViewHeader } from './ViewHeader'

/** Available conflict-type filter values, mapped to ConflictListItem's inferred types. */
type TypeFilter = 'all' | 'Text' | 'Property' | 'Move'
/** Available date-range filter values. UX-265 keeps the range coarse to stay in scope. */
type DateFilter = 'all' | 'last7Days'
/** 7 days in milliseconds — used for the "last 7 days" cutoff. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/** Truncate long content for dialog previews. */
function truncatePreview(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function ConflictList(): React.ReactElement {
  const { t } = useTranslation()
  const queryFn = useCallback(
    (cursor?: string) => getConflicts({ ...(cursor != null && { cursor }), limit: 50 }),
    [],
  )
  const {
    items: blocks,
    loading,
    hasMore,
    loadMore,
    reload,
    setItems: setBlocks,
  } = usePaginatedQuery(queryFn, { onError: t('conflict.loadFailed') })

  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null)
  const [confirmKeepBlock, setConfirmKeepBlock] = useState<BlockRow | null>(null)
  const [originals, setOriginals] = useState<Map<string, BlockRow>>(new Map())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const {
    selected: selectedIds,
    toggleSelection: toggleSelected,
    selectAll,
    clearSelection,
  } = useListMultiSelect({
    items: blocks,
    getItemId: (b: BlockRow) => b.id,
  })
  const [batchAction, setBatchAction] = useState<'keep' | 'discard' | null>(null)
  // UX-264: progress counter shown while a batch keep/discard is iterating
  // through selected conflicts. `null` while no batch is running.
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
    null,
  )
  const [deviceNames, setDeviceNames] = useState<Map<string, string>>(new Map())
  const fetchedParentsRef = useRef(new Set<string>())
  const listRef = useRef<HTMLDivElement>(null)

  // UX-265 sub-fix 2 — filter bar state.
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [deviceFilter, setDeviceFilter] = useState<string>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')

  // Unique device names available for the device filter dropdown.
  const uniqueDeviceNames = useMemo(() => {
    const set = new Set<string>()
    for (const name of deviceNames.values()) set.add(name)
    return [...set].sort()
  }, [deviceNames])

  // Apply filters to the conflict list. Falls back to full list when every
  // filter is "all" (the default), so existing behaviour is preserved.
  const filteredBlocks = useMemo(() => {
    if (typeFilter === 'all' && deviceFilter === 'all' && dateFilter === 'all') return blocks
    const cutoff = dateFilter === 'last7Days' ? Date.now() - SEVEN_DAYS_MS : null
    return blocks.filter((block) => {
      if (typeFilter !== 'all' && inferConflictType(block) !== typeFilter) return false
      if (deviceFilter !== 'all') {
        const name = deviceNames.get(block.id)
        if (name !== deviceFilter) return false
      }
      if (cutoff != null) {
        const ts = ulidToDate(block.id)
        // ULIDs that don't decode to a valid date are kept (we cannot prove
        // they are old, and dropping them would silently hide data).
        if (ts && ts.getTime() < cutoff) return false
      }
      return true
    })
  }, [blocks, typeFilter, deviceFilter, dateFilter, deviceNames])

  const navigateToPage = useNavigationStore((s) => s.navigateToPage)

  // Fetch original blocks for comparison when new conflict blocks arrive
  useEffect(() => {
    const parentIds = blocks
      .map((b) => b.parent_id)
      .filter((pid): pid is string => pid != null && !fetchedParentsRef.current.has(pid))
    const uniqueIds = [...new Set(parentIds)]
    if (uniqueIds.length === 0) return

    let cancelled = false
    for (const pid of uniqueIds) fetchedParentsRef.current.add(pid)

    Promise.allSettled(
      uniqueIds.map((pid) => getBlock(pid).then((orig) => [pid, orig] as const)),
    ).then((results) => {
      if (cancelled) return
      setOriginals((prev) => {
        const next = new Map(prev)
        for (const r of results) {
          if (r.status === 'fulfilled') next.set(r.value[0], r.value[1])
        }
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [blocks])

  // Listen for sync:complete events to refresh the conflict list (#651-C5).
  // Falls back gracefully when running outside Tauri (e.g. in tests / browser).
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    listen<unknown>('sync:complete', () => {
      if (!cancelled) reload()
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((err: unknown) => {
        logger.warn(
          'ConflictList',
          'sync:complete listener unavailable (likely no Tauri context)',
          undefined,
          err,
        )
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [reload])

  // Fetch source device info for each conflict block (#651 C-3)
  useEffect(() => {
    if (blocks.length === 0) return
    let stale = false

    async function fetchDeviceInfo() {
      try {
        // Fetch first history entry for each conflict block
        const deviceIdsByBlock = new Map<string, string>()
        await Promise.all(
          blocks.map(async (block) => {
            try {
              const hist = await getBlockHistory({ blockId: block.id, limit: 1 })
              if (hist.items.length > 0) {
                deviceIdsByBlock.set(block.id, hist.items[0]?.device_id as string)
              }
            } catch {
              // Silently skip blocks where history is unavailable
            }
          }),
        )

        // Get device name mapping
        const [peers, localId] = await Promise.all([listPeerRefs(), getDeviceId()])

        const nameMap = new Map<string, string>()
        for (const peer of peers) {
          nameMap.set(peer.peer_id, peer.device_name ?? `${peer.peer_id.slice(0, 8)}...`)
        }
        nameMap.set(localId, t('device.thisDevice'))

        // Build blockId -> deviceName map
        if (!stale) {
          const result = new Map<string, string>()
          for (const [blockId, deviceId] of deviceIdsByBlock) {
            const name = nameMap.get(deviceId)
            if (name) {
              result.set(blockId, name)
            } else {
              // Show truncated device ID if name not found
              result.set(blockId, `${deviceId.slice(0, 8)}...`)
            }
          }
          setDeviceNames(result)
        }
      } catch {
        // Silently handle — device info is non-critical
      }
    }

    fetchDeviceInfo()
    return () => {
      stale = true
    }
  }, [blocks, t])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: filteredBlocks.length,
    onSelect: (idx) => {
      const block = filteredBlocks[idx]
      if (block) toggleExpanded(block.id)
    },
    vim: false,
    homeEnd: true,
  })

  // Programmatically set ARIA attributes on <li> children for listbox pattern
  // without modifying ConflictListItem.
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll<HTMLLIElement>(':scope > .conflict-item')
    items.forEach((item, index) => {
      const block = filteredBlocks[index]
      if (block) {
        item.id = `conflict-${block.id}`
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(index === focusedIndex))
      }
    })
  }, [filteredBlocks, focusedIndex])

  const handleToggleSelectAll = useCallback(() => {
    if (selectedIds.size === blocks.length) {
      clearSelection()
    } else {
      selectAll()
    }
  }, [selectedIds.size, blocks.length, clearSelection, selectAll])

  const handleKeep = useCallback(
    async (block: BlockRow) => {
      try {
        const originalContent = originals.get(block.parent_id ?? '')?.content ?? null
        // Apply conflict content to the original block (parent_id is the original)
        if (block.parent_id && block.content != null) {
          await editBlock(block.parent_id, block.content)
        }
        // Delete the conflict block
        let deleteResp: DeleteResponse | undefined
        try {
          deleteResp = await deleteBlock(block.id)
        } catch (_deleteErr: unknown) {
          // editBlock succeeded but deleteBlock failed — partial success
          toast.success(t('conflict.updateSuccessDeleteFailed'), {
            duration: 5000,
            action: {
              label: t('conflict.retryDeleteButton'),
              onClick: () => {
                deleteBlock(block.id)
                  .then(() => {
                    setBlocks((prev) => prev.filter((b) => b.id !== block.id))
                    toast.success(t('conflict.conflictCopyRemoved'))
                  })
                  .catch((err) => {
                    logger.warn(
                      'ConflictList',
                      'retry remove conflict copy failed',
                      { blockId: block.id },
                      err,
                    )
                    toast.error(t('conflict.retryFailed'))
                  })
              },
            },
          })
          setConfirmKeepBlock(null)
          return
        }
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        setConfirmKeepBlock(null)
        toast.success(t('conflict.keptSelectedVersion'), {
          duration: 6000,
          action: {
            label: t('conflict.undoButton'),
            onClick: () => {
              // Restore deleted conflict block, then revert edit on original
              restoreBlock(deleteResp.block_id, deleteResp.deleted_at)
                .then(() => {
                  // Revert original content if we had it
                  if (block.parent_id && originalContent !== null) {
                    return editBlock(block.parent_id, originalContent)
                  }
                  return undefined
                })
                .then(() => {
                  // Re-add conflict to list
                  setBlocks((prev) => [block, ...prev])
                  toast.success(t('conflict.resolutionUndone'))
                })
                .catch((err) => {
                  logger.warn('ConflictList', 'undo resolution failed', { blockId: block.id }, err)
                  toast.error(t('conflict.undoFailed'))
                })
            },
          },
        })
        announce(t('conflict.resolvedAnnounce'))
      } catch (err: unknown) {
        toast.error(
          t('conflict.resolveError', { error: err instanceof Error ? err.message : String(err) }),
        )
      }
    },
    [setBlocks, originals, t],
  )

  const handleDiscard = useCallback(
    async (block: BlockRow) => {
      try {
        const deleteResp = await deleteBlock(block.id)
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        setConfirmDiscardId(null)
        toast.success(t('conflict.conflictDiscarded'), {
          duration: 6000,
          action: {
            label: t('conflict.undoButton'),
            onClick: () => {
              restoreBlock(deleteResp.block_id, deleteResp.deleted_at)
                .then(() => {
                  setBlocks((prev) => [block, ...prev])
                  toast.success(t('conflict.discardUndone'))
                })
                .catch((err) => {
                  logger.warn('ConflictList', 'undo discard failed', { blockId: block.id }, err)
                  toast.error(t('conflict.undoDiscardFailed'))
                })
            },
          },
        })
        announce(t('conflict.discardedAnnounce'))
      } catch (err: unknown) {
        toast.error(
          t('conflict.discardError', { error: err instanceof Error ? err.message : String(err) }),
        )
      }
    },
    [setBlocks, t],
  )

  const handleBatchConfirm = useCallback(async () => {
    const selectedBlocks = blocks.filter((b) => selectedIds.has(b.id))
    let failCount = 0
    const savedBatchAction = batchAction
    const total = selectedBlocks.length
    // UX-264: surface progress as we iterate so users with 50+ conflicts see
    // "Resolving 3 of 50…" rather than just a spinner.
    setBatchProgress({ current: 0, total })
    for (let i = 0; i < selectedBlocks.length; i++) {
      const block = selectedBlocks[i] as BlockRow
      setBatchProgress({ current: i + 1, total })
      try {
        if (savedBatchAction === 'keep') {
          if (block.parent_id && block.content != null) {
            await editBlock(block.parent_id, block.content)
          }
          await deleteBlock(block.id)
          setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        } else {
          await deleteBlock(block.id)
          setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        }
      } catch {
        failCount++
      }
    }
    setBatchProgress(null)
    clearSelection()
    setBatchAction(null)
    if (failCount > 0) {
      toast.error(t('conflict.batchError', { failCount, count: selectedBlocks.length }), {
        duration: 5000,
        action: {
          label: t('action.retry'),
          onClick: () => setBatchAction(savedBatchAction),
        },
      })
    } else {
      const msg =
        savedBatchAction === 'keep'
          ? t('conflict.batchKeptCount', { count: selectedBlocks.length })
          : t('conflict.batchDiscardedCount', { count: selectedBlocks.length })
      toast.success(msg)
      announce(msg)
    }
  }, [blocks, selectedIds, batchAction, setBlocks, clearSelection, t])

  return (
    <div className="conflict-list space-y-4">
      {loading && blocks.length === 0 && (
        <div aria-busy="true">
          <LoadingSkeleton count={2} height="h-14" className="conflict-list-loading" />
        </div>
      )}

      {!loading && blocks.length === 0 && (
        <EmptyState icon={GitMerge} message={t('conflict.noConflicts')} />
      )}

      {blocks.length > 0 && (
        <ViewHeader>
          <div className="conflict-list-header space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">{t('conflict.helpText')}</p>
              <Button
                variant="ghost"
                size="sm"
                className="conflict-refresh-btn shrink-0 ml-2"
                onClick={reload}
                disabled={loading}
                aria-label={t('conflict.refreshLabel')}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </Button>
            </div>

            {/* UX-265 sub-fix 2 — filter bar (type / device / date) */}
            <div
              className="conflict-filter-bar flex flex-wrap items-center gap-2"
              data-testid="conflict-filter-bar"
            >
              <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
                <SelectTrigger
                  size="sm"
                  className="conflict-filter-type w-[10rem]"
                  aria-label={t('conflict.filterByType')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('conflict.allTypes')}</SelectItem>
                  <SelectItem value="Text">{t('conflict.typeText')}</SelectItem>
                  <SelectItem value="Property">{t('conflict.typeProperty')}</SelectItem>
                  <SelectItem value="Move">{t('conflict.typeMove')}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={deviceFilter} onValueChange={setDeviceFilter}>
                <SelectTrigger
                  size="sm"
                  className="conflict-filter-device w-[10rem]"
                  aria-label={t('conflict.filterByDevice')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('conflict.allDevices')}</SelectItem>
                  {uniqueDeviceNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={dateFilter} onValueChange={(v) => setDateFilter(v as DateFilter)}>
                <SelectTrigger
                  size="sm"
                  className="conflict-filter-date w-[10rem]"
                  aria-label={t('conflict.filterByDate')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('conflict.allTime')}</SelectItem>
                  <SelectItem value="last7Days">{t('conflict.last7Days')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {selectedIds.size > 0 && (
              <ConflictBatchToolbar
                selectedCount={selectedIds.size}
                totalCount={blocks.length}
                onToggleSelectAll={handleToggleSelectAll}
                onKeepAll={() => setBatchAction('keep')}
                onDiscardAll={() => setBatchAction('discard')}
              />
            )}

            {/* UX-264: visible progress while batch keep/discard is iterating */}
            {batchProgress && (
              <p
                className="conflict-batch-progress text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
                data-testid="conflict-batch-progress"
              >
                {t('conflicts.batchProgress', {
                  current: batchProgress.current,
                  total: batchProgress.total,
                })}
              </p>
            )}
          </div>
        </ViewHeader>
      )}

      <div
        ref={listRef}
        className="conflict-items space-y-2 list-none p-0"
        tabIndex={0}
        role="listbox"
        aria-label={t('conflicts.listLabel')}
        aria-activedescendant={
          filteredBlocks[focusedIndex] ? `conflict-${filteredBlocks[focusedIndex].id}` : undefined
        }
        onKeyDown={(e) => {
          if (handleKeyDown(e)) e.preventDefault()
        }}
      >
        {filteredBlocks.map((block) => {
          const original = block.parent_id ? originals.get(block.parent_id) : undefined
          return (
            <ConflictListItem
              key={block.id}
              block={block}
              original={original}
              isExpanded={expandedIds.has(block.id)}
              isSelected={selectedIds.has(block.id)}
              deviceName={deviceNames.get(block.id)}
              onToggleExpanded={toggleExpanded}
              onToggleSelected={toggleSelected}
              onKeep={(b) => setConfirmKeepBlock(b)}
              onDiscard={(id) => setConfirmDiscardId(id)}
              onViewOriginal={navigateToPage}
            />
          )
        })}
      </div>

      {/* UX-265 sub-fix 2 — empty state for filtered-but-no-match. */}
      {blocks.length > 0 && filteredBlocks.length === 0 && (
        <p
          className="conflict-no-match text-sm text-muted-foreground italic"
          data-testid="conflict-no-match"
          role="status"
        >
          {t('conflict.noMatchingFilters')}
        </p>
      )}

      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        className="conflict-load-more"
      />

      {/* Keep confirmation dialog */}
      <ConfirmDialog
        open={!!confirmKeepBlock}
        onOpenChange={(open) => {
          if (!open) setConfirmKeepBlock(null)
        }}
        title={t('conflict.keepIncomingTitle')}
        description={
          <>
            {t('conflict.keepDescription')}
            {confirmKeepBlock && (
              <span className="mt-2 block space-y-1 text-xs">
                <span className="block">
                  <span className="font-medium">{t('conflict.currentLabel')}</span>{' '}
                  <span className="text-muted-foreground">
                    {truncatePreview(
                      confirmKeepBlock.parent_id
                        ? (originals.get(confirmKeepBlock.parent_id)?.content ??
                            t('conflict.originalNotAvailable'))
                        : '(no original)',
                    )}
                  </span>
                </span>
                <span className="block">
                  <span className="font-medium">{t('conflict.incomingLabel')}</span>{' '}
                  <span className="text-muted-foreground">
                    {truncatePreview(confirmKeepBlock.content ?? t('conflict.emptyContent'))}
                  </span>
                </span>
              </span>
            )}
          </>
        }
        cancelLabel={t('dialog.cancel')}
        actionLabel={t('conflict.keepConfirmAction')}
        onAction={() => {
          if (confirmKeepBlock) handleKeep(confirmKeepBlock)
        }}
        actionVariant="destructive"
        className="conflict-keep-confirm"
        contentTestId="conflict-keep-confirm"
        cancelTestId="conflict-keep-no"
        actionTestId="conflict-keep-yes"
      />

      {/* Discard confirmation dialog */}
      <ConfirmDialog
        open={!!confirmDiscardId}
        onOpenChange={(open) => {
          if (!open) setConfirmDiscardId(null)
        }}
        title={t('conflict.discardTitle')}
        description={
          <>
            {t('conflict.discardDescription')}
            {confirmDiscardId &&
              (() => {
                const discardBlock = blocks.find((b) => b.id === confirmDiscardId)
                return discardBlock ? (
                  <span className="mt-2 block text-xs">
                    <span className="font-medium">Content:</span>{' '}
                    <span className="text-muted-foreground">
                      {truncatePreview(discardBlock.content ?? t('conflict.emptyContent'))}
                    </span>
                  </span>
                ) : null
              })()}
          </>
        }
        cancelLabel={t('dialog.no')}
        actionLabel={t('conflict.discardConfirmAction')}
        onAction={() => {
          if (confirmDiscardId) {
            const discardBlock = blocks.find((b) => b.id === confirmDiscardId)
            if (discardBlock) handleDiscard(discardBlock)
          }
        }}
        actionVariant="destructive"
        className="conflict-discard-confirm"
        contentTestId="conflict-discard-confirm"
        cancelTestId="conflict-discard-no"
        actionTestId="conflict-discard-yes"
      />

      {/* Batch action confirmation dialog */}
      <ConfirmDialog
        open={!!batchAction}
        onOpenChange={(open) => {
          if (!open) setBatchAction(null)
        }}
        title={
          batchAction === 'keep'
            ? t('conflict.keepAllSelectedTitle')
            : t('conflict.discardAllSelectedTitle')
        }
        description={
          batchAction === 'keep'
            ? t('conflict.batchKeepDescription', { count: selectedIds.size })
            : t('conflict.batchDiscardDescription', { count: selectedIds.size })
        }
        cancelLabel={t('dialog.cancel')}
        actionLabel={
          batchAction === 'keep' ? t('conflict.batchKeepAction') : t('conflict.batchDiscardAction')
        }
        actionVariant="destructive"
        onAction={handleBatchConfirm}
        className="conflict-batch-confirm"
      />
    </div>
  )
}
