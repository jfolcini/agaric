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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
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
import { ConflictListItem } from './ConflictListItem'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { LoadMoreButton } from './LoadMoreButton'

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchAction, setBatchAction] = useState<'keep' | 'discard' | null>(null)
  const [deviceNames, setDeviceNames] = useState<Map<string, string>>(new Map())
  const fetchedParentsRef = useRef(new Set<string>())
  const listRef = useRef<HTMLDivElement>(null)

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
      .catch(() => {
        // Not in Tauri context — no-op
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [reload])

  // Clean up selectedIds when blocks are removed after resolution
  useEffect(() => {
    setSelectedIds((prev) => {
      const blockIds = new Set(blocks.map((b) => b.id))
      const next = new Set([...prev].filter((id) => blockIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [blocks])

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
        nameMap.set(localId, 'This device')

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
  }, [blocks])

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

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: blocks.length,
    onSelect: (idx) => {
      const block = blocks[idx]
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
      const block = blocks[index]
      if (block) {
        item.id = `conflict-${block.id}`
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(index === focusedIndex))
      }
    })
  }, [blocks, focusedIndex])

  const handleToggleSelectAll = useCallback(() => {
    if (selectedIds.size === blocks.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(blocks.map((b) => b.id)))
    }
  }, [selectedIds.size, blocks])

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
                  .catch(() => {
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
                .catch(() => {
                  toast.error(t('conflict.undoFailed'))
                })
            },
          },
        })
        announce('Conflict resolved — kept incoming version')
      } catch (err: unknown) {
        toast.error(
          `Failed to resolve conflict: ${err instanceof Error ? err.message : String(err)}`,
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
                .catch(() => {
                  toast.error(t('conflict.undoDiscardFailed'))
                })
            },
          },
        })
        announce('Conflict discarded')
      } catch (err: unknown) {
        toast.error(
          `Failed to discard conflict: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    [setBlocks, t],
  )

  const handleBatchConfirm = useCallback(async () => {
    const selectedBlocks = blocks.filter((b) => selectedIds.has(b.id))
    let failCount = 0
    const savedBatchAction = batchAction
    for (const block of selectedBlocks) {
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
    setSelectedIds(new Set())
    setBatchAction(null)
    if (failCount > 0) {
      toast.error(`${failCount} of ${selectedBlocks.length} operations failed`, {
        duration: 5000,
        action: {
          label: 'Retry',
          onClick: () => setBatchAction(savedBatchAction),
        },
      })
    } else {
      const msg =
        savedBatchAction === 'keep'
          ? `Kept ${selectedBlocks.length} conflict(s)`
          : `Discarded ${selectedBlocks.length} conflict(s)`
      toast.success(msg)
      announce(msg)
    }
  }, [blocks, selectedIds, batchAction, setBlocks])

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
        <div className="sticky top-0 z-10 bg-background -mx-4 px-4 md:-mx-6 md:px-6 pb-4 border-b border-border/40 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              <strong>Keep</strong> replaces the current content with the incoming version.{' '}
              <strong>Discard</strong> removes the conflicting version.
            </p>
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

          {selectedIds.size > 0 && (
            <ConflictBatchToolbar
              selectedCount={selectedIds.size}
              totalCount={blocks.length}
              onToggleSelectAll={handleToggleSelectAll}
              onKeepAll={() => setBatchAction('keep')}
              onDiscardAll={() => setBatchAction('discard')}
            />
          )}
        </div>
      )}

      <div
        ref={listRef}
        className="conflict-items space-y-2 list-none p-0"
        tabIndex={0}
        role="listbox"
        aria-label="Conflict list"
        aria-activedescendant={
          blocks[focusedIndex] ? `conflict-${blocks[focusedIndex].id}` : undefined
        }
        onKeyDown={(e) => {
          if (handleKeyDown(e)) e.preventDefault()
        }}
      >
        {blocks.map((block) => {
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
            This will replace the current content with the incoming version.
            {confirmKeepBlock && (
              <span className="mt-2 block space-y-1 text-xs">
                <span className="block">
                  <span className="font-medium">Current:</span>{' '}
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
                  <span className="font-medium">Incoming:</span>{' '}
                  <span className="text-muted-foreground">
                    {truncatePreview(confirmKeepBlock.content ?? t('conflict.emptyContent'))}
                  </span>
                </span>
              </span>
            )}
          </>
        }
        cancelLabel="Cancel"
        actionLabel="Yes, keep"
        onAction={() => {
          if (confirmKeepBlock) handleKeep(confirmKeepBlock)
        }}
        className="conflict-keep-confirm"
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
            This will permanently remove the conflicting version.
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
        cancelLabel="No"
        actionLabel="Yes, discard"
        onAction={() => {
          if (confirmDiscardId) {
            const discardBlock = blocks.find((b) => b.id === confirmDiscardId)
            if (discardBlock) handleDiscard(discardBlock)
          }
        }}
        className="conflict-discard-confirm"
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
            ? `This will replace ${selectedIds.size} block(s) with their incoming versions.`
            : `This will permanently remove ${selectedIds.size} conflicting version(s).`
        }
        cancelLabel="Cancel"
        actionLabel={batchAction === 'keep' ? 'Yes, keep all' : 'Yes, discard all'}
        onAction={handleBatchConfirm}
        className="conflict-batch-confirm"
      />
    </div>
  )
}
