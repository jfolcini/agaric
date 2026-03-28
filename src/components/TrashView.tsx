/**
 * TrashView — shows soft-deleted blocks (p15-t23..t25).
 *
 * WHERE deleted_at IS NOT NULL. Paginated via cursor.
 * Supports restore (p15-t24) and permanent purge (p15-t25).
 */

import { AlertTriangle, RotateCcw } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { BlockRow } from '../lib/tauri'
import { listBlocks, purgeBlock, restoreBlock } from '../lib/tauri'

export function TrashView(): React.ReactElement {
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)

  const loadTrash = useCallback(async (cursor?: string) => {
    setLoading(true)
    try {
      const resp = await listBlocks({ showDeleted: true, cursor, limit: 50 })
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
    loadTrash()
  }, [loadTrash])

  const handleRestore = useCallback(async (block: BlockRow) => {
    if (!block.deleted_at) return
    try {
      await restoreBlock(block.id, block.deleted_at)
      setBlocks((prev) => prev.filter((b) => b.id !== block.id))
    } catch {
      // Silently fail
    }
  }, [])

  const handlePurge = useCallback(async (blockId: string) => {
    try {
      await purgeBlock(blockId)
      setBlocks((prev) => prev.filter((b) => b.id !== blockId))
      setConfirmPurgeId(null)
    } catch {
      // Silently fail
    }
  }, [])

  const loadMore = useCallback(() => {
    if (nextCursor) loadTrash(nextCursor)
  }, [nextCursor, loadTrash])

  return (
    <div className="trash-view space-y-4">
      <h2 className="trash-view-title text-lg font-semibold tracking-tight">Trash</h2>

      {loading && blocks.length === 0 && (
        <div className="trash-view-loading text-sm text-muted-foreground">Loading trash...</div>
      )}

      {!loading && blocks.length === 0 && (
        <div className="trash-view-empty rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Trash is empty.
        </div>
      )}

      <div className="trash-view-list space-y-2">
        {blocks.map((block) => (
          <div
            key={block.id}
            className="trash-item flex items-center justify-between rounded-lg border bg-card p-3"
          >
            <div className="trash-item-content flex items-center gap-3">
              <Badge variant="outline" className="trash-item-type shrink-0">
                {block.block_type}
              </Badge>
              <span className="trash-item-text text-sm">{block.content ?? '(empty)'}</span>
              <span className="trash-item-date text-xs text-muted-foreground">
                Deleted: {block.deleted_at ? new Date(block.deleted_at).toLocaleDateString() : ''}
              </span>
            </div>
            <div className="trash-item-actions flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="trash-restore-btn"
                onClick={() => handleRestore(block)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restore
              </Button>
              {confirmPurgeId === block.id ? (
                <span className="trash-purge-confirm flex items-center gap-1.5 text-sm">
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                  <span>Delete forever?</span>
                  <Button
                    variant="destructive"
                    size="xs"
                    className="trash-purge-yes"
                    onClick={() => handlePurge(block.id)}
                  >
                    Yes
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="trash-purge-no"
                    onClick={() => setConfirmPurgeId(null)}
                  >
                    No
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="trash-purge-btn text-destructive hover:text-destructive"
                  onClick={() => setConfirmPurgeId(block.id)}
                >
                  Purge
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
          className="trash-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
