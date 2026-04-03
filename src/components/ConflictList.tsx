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
 * NOTE: The backend currently does not distinguish conflict types in the DB.
 * "Text conflict" is shown as default. Property and Move conflict types will
 * be supported when the backend exposes them via a conflict_type field.
 */

import { listen } from '@tauri-apps/api/event'
import { Check, ChevronDown, ExternalLink, GitMerge, RefreshCw, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTimestamp, truncateId, ulidToDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import type { BlockRow } from '../lib/tauri'
import { deleteBlock, editBlock, getBlock, getConflicts, restoreBlock } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { EmptyState } from './EmptyState'
import { renderRichContent } from './StaticBlock'

/**
 * Determine the conflict type from backend metadata.
 *
 * Reads the `conflict_type` field added by migration 0007. Falls back to
 * "Text" for blocks created before the migration (where conflict_type is null).
 */
function inferConflictType(block: BlockRow, _original?: BlockRow): 'Text' | 'Property' | 'Move' {
  if (block.conflict_type === 'Property') return 'Property'
  if (block.conflict_type === 'Move') return 'Move'
  return 'Text'
}

/** Truncate long content for dialog previews. */
function truncatePreview(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Badge color class by conflict type. */
function conflictTypeBadgeClass(type: 'Text' | 'Property' | 'Move'): string {
  switch (type) {
    case 'Text':
      return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
    case 'Property':
      return 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800'
    case 'Move':
      return 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800'
  }
}

export function ConflictList(): React.ReactElement {
  const { t } = useTranslation()
  const queryFn = useCallback((cursor?: string) => getConflicts({ cursor, limit: 50 }), [])
  const {
    items: blocks,
    loading,
    hasMore,
    loadMore,
    reload,
    setItems: setBlocks,
  } = usePaginatedQuery(queryFn, { onError: 'Failed to load conflicts' })

  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null)
  const [confirmKeepBlock, setConfirmKeepBlock] = useState<BlockRow | null>(null)
  const [originals, setOriginals] = useState<Map<string, BlockRow>>(new Map())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const fetchedParentsRef = useRef(new Set<string>())

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

  const handleKeep = useCallback(
    async (block: BlockRow) => {
      try {
        const originalContent = originals.get(block.parent_id!)?.content ?? null
        // Apply conflict content to the original block (parent_id is the original)
        if (block.parent_id && block.content != null) {
          await editBlock(block.parent_id, block.content)
        }
        // Delete the conflict block
        let deleteResp
        try {
          deleteResp = await deleteBlock(block.id)
        } catch (_deleteErr: unknown) {
          // editBlock succeeded but deleteBlock failed — partial success
          toast.success(
            'Updated original but failed to remove conflict copy.',
            {
              duration: 5000,
              action: {
                label: 'Retry delete',
                onClick: () => {
                  deleteBlock(block.id)
                    .then(() => {
                      setBlocks((prev) => prev.filter((b) => b.id !== block.id))
                      toast.success('Conflict copy removed')
                    })
                    .catch(() => {
                      toast.error('Retry failed — please delete the conflict manually.')
                    })
                },
              },
            },
          )
          setConfirmKeepBlock(null)
          return
        }
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        setConfirmKeepBlock(null)
        toast.success('Kept selected version', {
          duration: 6000,
          action: {
            label: 'Undo',
            onClick: () => {
              // Restore deleted conflict block, then revert edit on original
              restoreBlock(deleteResp.block_id, deleteResp.deleted_at)
                .then(() => {
                  // Revert original content if we had it
                  if (block.parent_id && originalContent !== null) {
                    return editBlock(block.parent_id, originalContent)
                  }
                })
                .then(() => {
                  // Re-add conflict to list
                  setBlocks((prev) => [block, ...prev])
                  toast.success('Resolution undone')
                })
                .catch(() => {
                  toast.error('Failed to undo — check the original page.')
                })
            },
          },
        })
      } catch (err: unknown) {
        toast.error(
          `Failed to resolve conflict: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    [setBlocks, originals],
  )

  const handleDiscard = useCallback(
    async (block: BlockRow) => {
      try {
        const deleteResp = await deleteBlock(block.id)
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        setConfirmDiscardId(null)
        toast.success('Conflict discarded', {
          duration: 6000,
          action: {
            label: 'Undo',
            onClick: () => {
              restoreBlock(deleteResp.block_id, deleteResp.deleted_at)
                .then(() => {
                  setBlocks((prev) => [block, ...prev])
                  toast.success('Discard undone')
                })
                .catch(() => {
                  toast.error('Failed to undo discard.')
                })
            },
          },
        })
      } catch (err: unknown) {
        toast.error(
          `Failed to discard conflict: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    [setBlocks],
  )

  /** Resolve the display timestamp for a conflict block from its ULID. */
  function getConflictTimestamp(block: BlockRow): string {
    const ulidDate = ulidToDate(block.id)
    if (ulidDate) return formatTimestamp(ulidDate.toISOString(), 'relative')
    return 'Unknown'
  }

  return (
    <div className="conflict-list space-y-4">
      {loading && blocks.length === 0 && (
        <div className="conflict-list-loading space-y-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      )}

      {!loading && blocks.length === 0 && (
        <EmptyState
          icon={GitMerge}
          message="No conflicts. Conflicts appear when the same block is edited on multiple devices."
        />
      )}

      {blocks.length > 0 && (
        <div className="flex items-center justify-between mb-2">
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
            aria-label="Refresh conflict list"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      )}

      <div className="conflict-items space-y-2">
        {blocks.map((block) => {
          const original = block.parent_id ? originals.get(block.parent_id) : undefined
          const conflictType = inferConflictType(block, original)
          const isExpanded = expandedIds.has(block.id)
          return (
            <div
              key={block.id}
              className="conflict-item flex items-start justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
            >
              <button
                type="button"
                className="conflict-item-content flex min-w-0 flex-col gap-1 text-left flex-1 cursor-pointer bg-transparent border-none p-0"
                onClick={() => toggleExpanded(block.id)}
                aria-expanded={isExpanded}
                aria-label={isExpanded ? t('conflict.collapse') : t('conflict.expand')}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 shrink-0 transition-transform',
                      isExpanded && 'rotate-180',
                    )}
                  />
                  <Badge variant="secondary" className="conflict-item-type shrink-0">
                    {block.block_type}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={`conflict-type-badge shrink-0 ${conflictTypeBadgeClass(conflictType)}`}
                    aria-label={t(`conflict.type${conflictType}`)}
                  >
                    {conflictType}
                  </Badge>
                </div>
                <div className="conflict-metadata flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="conflict-source-id font-mono" title={block.id}>
                    ID: {truncateId(block.id)}
                  </span>
                  <span className="conflict-timestamp">{getConflictTimestamp(block)}</span>
                </div>
                <div
                  className={`conflict-original text-sm${isExpanded ? ' max-h-40 overflow-y-auto' : ' truncate'}`}
                >
                  <span className="font-medium text-muted-foreground">Current:</span>{' '}
                  {original
                    ? (original.content
                      ? <span>{renderRichContent(original.content, { interactive: false })}</span>
                      : '(empty)')
                    : '(original not available)'}
                </div>
                <div className={`conflict-incoming text-sm${isExpanded ? ' max-h-40 overflow-y-auto' : ' truncate'}`}>
                  <span className="font-medium">Incoming:</span>{' '}
                  <span className="conflict-item-text">
                    {block.content
                      ? renderRichContent(block.content, { interactive: false })
                      : '(empty)'}
                  </span>
                </div>
              </button>
              <div className="conflict-item-actions flex items-center gap-2 ml-2 shrink-0">
                {block.parent_id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="conflict-view-original-btn"
                    aria-label={`View original block for ${truncateId(block.id)}`}
                    onClick={() => navigateToPage(block.parent_id as string, block.content ?? 'Untitled')}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View original
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="conflict-keep-btn [@media(pointer:coarse)]:min-h-[44px]"
                  onClick={() => setConfirmKeepBlock(block)}
                  aria-label={`Keep incoming version for block ${truncateId(block.id)}`}
                >
                  <Check className="h-3.5 w-3.5" />
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="conflict-discard-btn [@media(pointer:coarse)]:min-h-[44px]"
                  onClick={() => setConfirmDiscardId(block.id)}
                  aria-label={`Discard conflict for block ${truncateId(block.id)}`}
                >
                  <X className="h-3.5 w-3.5" />
                  Discard
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="conflict-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load more'}
        </Button>
      )}

      {/* Keep confirmation dialog */}
      <AlertDialog
        open={!!confirmKeepBlock}
        onOpenChange={(open) => {
          if (!open) setConfirmKeepBlock(null)
        }}
      >
        <AlertDialogContent className="conflict-keep-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Keep incoming version?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace the current content with the incoming version.
              {confirmKeepBlock && (
                <span className="mt-2 block space-y-1 text-xs">
                  <span className="block">
                    <span className="font-medium">Current:</span>{' '}
                    <span className="text-muted-foreground">
                      {truncatePreview(
                        confirmKeepBlock.parent_id
                          ? (originals.get(confirmKeepBlock.parent_id)?.content
                              ?? '(original not available)')
                          : '(no original)',
                      )}
                    </span>
                  </span>
                  <span className="block">
                    <span className="font-medium">Incoming:</span>{' '}
                    <span className="text-muted-foreground">
                      {truncatePreview(confirmKeepBlock.content ?? '(empty)')}
                    </span>
                  </span>
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="conflict-keep-no">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="conflict-keep-yes"
              onClick={() => {
                if (confirmKeepBlock) handleKeep(confirmKeepBlock)
              }}
            >
              Yes, keep
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discard confirmation dialog */}
      <AlertDialog
        open={!!confirmDiscardId}
        onOpenChange={(open) => {
          if (!open) setConfirmDiscardId(null)
        }}
      >
        <AlertDialogContent className="conflict-discard-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard conflict?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the conflicting version.
              {confirmDiscardId && (() => {
                const discardBlock = blocks.find((b) => b.id === confirmDiscardId)
                return discardBlock ? (
                  <span className="mt-2 block text-xs">
                    <span className="font-medium">Content:</span>{' '}
                    <span className="text-muted-foreground">
                      {truncatePreview(discardBlock.content ?? '(empty)')}
                    </span>
                  </span>
                ) : null
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="conflict-discard-no">No</AlertDialogCancel>
            <AlertDialogAction
              className="conflict-discard-yes"
              onClick={() => {
                if (confirmDiscardId) {
                  const discardBlock = blocks.find((b) => b.id === confirmDiscardId)
                  if (discardBlock) handleDiscard(discardBlock)
                }
              }}
            >
              Yes, discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
