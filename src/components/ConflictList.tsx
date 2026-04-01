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
 *
 * NOTE: The backend currently does not distinguish conflict types in the DB.
 * "Text conflict" is shown as default. Property and Move conflict types will
 * be supported when the backend exposes them via a conflict_type field.
 */

import { Check, GitMerge, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
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
import type { BlockRow } from '../lib/tauri'
import { deleteBlock, editBlock, getBlock, getConflicts } from '../lib/tauri'
import { EmptyState } from './EmptyState'

/**
 * Infer the conflict type from block data.
 *
 * Currently the backend does not expose a `conflict_type` field, so we default
 * to "Text". When the backend adds conflict type metadata, this function should
 * be updated to use it.
 *
 * Future types:
 *  - "Property" — when block has is_conflict = 1 and properties differ
 *  - "Move" — when block parents differ (requires parent tracking in conflict data)
 */
function inferConflictType(_block: BlockRow, _original?: BlockRow): 'Text' | 'Property' | 'Move' {
  // TODO: When the backend exposes conflict_type, use it here.
  // For now, all conflicts are treated as text conflicts.
  return 'Text'
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

/** Format a timestamp string to a human-readable relative or absolute format. */
function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return 'Unknown'
  try {
    const date = new Date(ts)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'Just now'
    if (diffMin < 60) return `${diffMin} min ago`
    const diffHours = Math.floor(diffMin / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts
  }
}

/** Truncate a block ID for display. */
function truncateId(id: string, len = 12): string {
  if (id.length <= len) return id
  return `${id.slice(0, len)}...`
}

export function ConflictList(): React.ReactElement {
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null)
  const [confirmKeepBlock, setConfirmKeepBlock] = useState<BlockRow | null>(null)
  const [originals, setOriginals] = useState<Map<string, BlockRow>>(new Map())

  const loadConflicts = useCallback(async (cursor?: string) => {
    setLoading(true)
    try {
      const resp = await getConflicts({ cursor, limit: 50 })
      const items = resp?.items ?? []
      if (cursor) {
        setBlocks((prev) => [...prev, ...items])
      } else {
        setBlocks(items)
      }
      setNextCursor(resp?.next_cursor ?? null)
      setHasMore(resp?.has_more ?? false)

      // Fetch original blocks for comparison
      const parentIds = [
        ...new Set(items.map((b) => b.parent_id).filter((pid): pid is string => pid != null)),
      ]
      const fetchedOriginals = new Map<string, BlockRow>()
      await Promise.allSettled(
        parentIds.map((pid) => getBlock(pid).then((orig) => fetchedOriginals.set(pid, orig))),
      )
      setOriginals((prev) => {
        const next = new Map(prev)
        for (const [k, v] of fetchedOriginals) next.set(k, v)
        return next
      })
    } catch {
      toast.error('Failed to load conflicts')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadConflicts()
  }, [loadConflicts])

  const handleKeep = useCallback(async (block: BlockRow) => {
    try {
      // Apply conflict content to the original block (parent_id is the original)
      if (block.parent_id && block.content != null) {
        await editBlock(block.parent_id, block.content)
      }
      // Delete the conflict block
      await deleteBlock(block.id)
      setBlocks((prev) => prev.filter((b) => b.id !== block.id))
      setConfirmKeepBlock(null)
      toast.success('Kept selected version')
    } catch {
      toast.error('Failed to resolve conflict')
    }
  }, [])

  const handleDiscard = useCallback(async (blockId: string) => {
    try {
      await deleteBlock(blockId)
      setBlocks((prev) => prev.filter((b) => b.id !== blockId))
      setConfirmDiscardId(null)
      toast.success('Conflict discarded')
    } catch {
      toast.error('Failed to resolve conflict')
    }
  }, [])

  const loadMore = useCallback(() => {
    if (nextCursor) loadConflicts(nextCursor)
  }, [nextCursor, loadConflicts])

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

      <div className="conflict-items space-y-2">
        {blocks.map((block) => {
          const original = block.parent_id ? originals.get(block.parent_id) : undefined
          const conflictType = inferConflictType(block, original)
          return (
            <div
              key={block.id}
              className="conflict-item flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
            >
              <div className="conflict-item-content flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary" className="conflict-item-type shrink-0">
                    {block.block_type}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={`conflict-type-badge shrink-0 ${conflictTypeBadgeClass(conflictType)}`}
                  >
                    {conflictType}
                  </Badge>
                </div>
                <div className="conflict-metadata flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="conflict-source-id font-mono" title={block.id}>
                    ID: {truncateId(block.id)}
                  </span>
                  <span className="conflict-timestamp">
                    {formatTimestamp(block.deleted_at ?? block.archived_at)}
                  </span>
                </div>
                <div className="conflict-original text-sm text-muted-foreground truncate">
                  <span className="font-medium">Current:</span>{' '}
                  {original ? (original.content ?? '(empty)') : '(original not available)'}
                </div>
                <div className="conflict-incoming text-sm truncate">
                  <span className="font-medium">Incoming:</span>{' '}
                  <span className="conflict-item-text">{block.content ?? '(empty)'}</span>
                </div>
              </div>
              <div className="conflict-item-actions flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="conflict-keep-btn [@media(pointer:coarse)]:min-h-[44px]"
                  onClick={() => setConfirmKeepBlock(block)}
                >
                  <Check className="h-3.5 w-3.5" />
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="conflict-discard-btn [@media(pointer:coarse)]:min-h-[44px]"
                  onClick={() => setConfirmDiscardId(block.id)}
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
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="conflict-discard-no">No</AlertDialogCancel>
            <AlertDialogAction
              className="conflict-discard-yes"
              onClick={() => {
                if (confirmDiscardId) handleDiscard(confirmDiscardId)
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
