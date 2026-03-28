/**
 * BacklinksPanel — shows blocks that link to the given block via [[ULID]] references (p2-t3).
 *
 * Per-block panel: receives a blockId prop and displays paginated backlinks.
 * Uses cursor-based pagination with "Load more" button.
 */

import { Link } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { BlockRow } from '../lib/tauri'
import { getBacklinks } from '../lib/tauri'

interface BacklinksPanelProps {
  /** The block to show backlinks for. */
  blockId: string | null
}

export function BacklinksPanel({ blockId }: BacklinksPanelProps): React.ReactElement {
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)

  const loadBacklinks = useCallback(
    async (cursor?: string) => {
      if (!blockId) return
      setLoading(true)
      try {
        const resp = await getBacklinks({ blockId, cursor, limit: 50 })
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
    },
    [blockId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset and reload when blockId changes
  useEffect(() => {
    setBlocks([])
    setNextCursor(null)
    setHasMore(false)
    loadBacklinks()
  }, [blockId, loadBacklinks])

  const loadMore = useCallback(() => {
    if (nextCursor) loadBacklinks(nextCursor)
  }, [nextCursor, loadBacklinks])

  if (!blockId) {
    return (
      <div className="backlinks-panel rounded-lg border border-dashed p-6 text-center">
        <div className="backlinks-panel-empty text-sm text-muted-foreground">
          Select a block to see backlinks
        </div>
      </div>
    )
  }

  return (
    <div className="backlinks-panel space-y-4">
      {loading && blocks.length === 0 && (
        <div className="backlinks-panel-loading text-sm text-muted-foreground">
          Loading backlinks...
        </div>
      )}

      {!loading && blocks.length === 0 && (
        <div className="backlinks-panel-none rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          <Link className="mx-auto mb-2 h-5 w-5" />
          No backlinks found
        </div>
      )}

      <div className="backlinks-list space-y-2">
        {blocks.map((block) => (
          <div
            key={block.id}
            className="backlink-item flex items-center gap-3 rounded-lg border bg-card p-3"
          >
            <Badge variant="outline" className="backlink-item-type shrink-0">
              {block.block_type}
            </Badge>
            <span className="backlink-item-text text-sm flex-1 truncate">
              {block.content ?? '(empty)'}
            </span>
            <span className="backlink-item-id text-xs text-muted-foreground font-mono">
              {block.id.slice(0, 8)}...
            </span>
          </div>
        ))}
      </div>

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="backlinks-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
