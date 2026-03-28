/**
 * TrashView — shows soft-deleted blocks (p15-t23..t25).
 *
 * WHERE deleted_at IS NOT NULL. Paginated via cursor.
 * Supports restore (p15-t24) and permanent purge (p15-t25).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
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
    <div className="trash-view">
      <h2 className="trash-view-title">Trash</h2>

      {loading && blocks.length === 0 && <div className="trash-view-loading">Loading trash...</div>}

      {!loading && blocks.length === 0 && <div className="trash-view-empty">Trash is empty.</div>}

      <div className="trash-view-list">
        {blocks.map((block) => (
          <div key={block.id} className="trash-item">
            <div className="trash-item-content">
              <span className="trash-item-type">{block.block_type}</span>
              <span className="trash-item-text">{block.content ?? '(empty)'}</span>
              <span className="trash-item-date">
                Deleted: {block.deleted_at ? new Date(block.deleted_at).toLocaleDateString() : ''}
              </span>
            </div>
            <div className="trash-item-actions">
              <button
                type="button"
                className="trash-restore-btn"
                onClick={() => handleRestore(block)}
              >
                Restore
              </button>
              {confirmPurgeId === block.id ? (
                <span className="trash-purge-confirm">
                  <span>Delete forever?</span>
                  <button
                    type="button"
                    className="trash-purge-yes"
                    onClick={() => handlePurge(block.id)}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    className="trash-purge-no"
                    onClick={() => setConfirmPurgeId(null)}
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="trash-purge-btn"
                  onClick={() => setConfirmPurgeId(block.id)}
                >
                  Purge
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <button type="button" className="trash-load-more" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  )
}
