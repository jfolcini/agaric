/**
 * ConflictList — shows blocks where is_conflict = 1 (p2-t12, p2-t13).
 *
 * Standalone view similar to TrashView. Paginated list of conflict blocks.
 * Supports "Keep" (edit original + delete conflict) and "Discard" (delete conflict)
 * with two-click confirmation on Discard.
 */

import { AlertTriangle, Check, GitMerge, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { BlockRow } from '../lib/tauri'
import { deleteBlock, editBlock, getConflicts } from '../lib/tauri'
import { EmptyState } from './EmptyState'

export function ConflictList(): React.ReactElement {
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null)

  // Dismiss discard confirmation on Escape key
  useEffect(() => {
    if (!confirmDiscardId) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmDiscardId(null)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [confirmDiscardId])

  const loadConflicts = useCallback(async (cursor?: string) => {
    setLoading(true)
    try {
      const resp = await getConflicts({ cursor, limit: 50 })
      if (cursor) {
        setBlocks((prev) => [...prev, ...resp.items])
      } else {
        setBlocks(resp.items)
      }
      setNextCursor(resp.next_cursor)
      setHasMore(resp.has_more)
    } catch {
      // Silently fail
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
    } catch {
      // Silently fail
    }
  }, [])

  const handleDiscard = useCallback(async (blockId: string) => {
    try {
      await deleteBlock(blockId)
      setBlocks((prev) => prev.filter((b) => b.id !== blockId))
      setConfirmDiscardId(null)
    } catch {
      // Silently fail
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
        {blocks.map((block) => (
          <div
            key={block.id}
            className="conflict-item flex items-center justify-between rounded-lg border bg-card p-4"
          >
            <div className="conflict-item-content flex min-w-0 items-center gap-3">
              <Badge variant="secondary" className="conflict-item-type shrink-0">
                {block.block_type}
              </Badge>
              <span className="conflict-item-text text-sm truncate">
                {block.content ?? '(empty)'}
              </span>
            </div>
            <div className="conflict-item-actions flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="conflict-keep-btn [@media(pointer:coarse)]:h-10"
                onClick={() => handleKeep(block)}
              >
                <Check className="h-3.5 w-3.5" />
                Keep
              </Button>
              {confirmDiscardId === block.id ? (
                <div className="conflict-discard-confirm flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  <span className="text-sm">Discard forever?</span>
                  <Button
                    variant="destructive"
                    size="xs"
                    className="conflict-discard-yes [@media(pointer:coarse)]:h-9"
                    onClick={() => handleDiscard(block.id)}
                  >
                    Yes
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="conflict-discard-no [@media(pointer:coarse)]:h-9"
                    onClick={() => setConfirmDiscardId(null)}
                  >
                    No
                  </Button>
                </div>
              ) : (
                <Button
                  variant="destructive"
                  size="sm"
                  className="conflict-discard-btn [@media(pointer:coarse)]:h-10"
                  onClick={() => setConfirmDiscardId(block.id)}
                >
                  <X className="h-3.5 w-3.5" />
                  Discard
                </Button>
              )}
            </div>
          </div>
        ))}
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
    </div>
  )
}
