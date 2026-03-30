/**
 * BacklinksPanel — shows blocks that link to the given block via [[ULID]] references (p2-t3).
 *
 * Per-block panel: receives a blockId prop and displays paginated backlinks.
 * Uses cursor-based pagination with "Load more" button.
 */

import { Link } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { BlockRow } from '../lib/tauri'
import { getBacklinks, getBlock } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { renderRichContent } from './StaticBlock'

interface BacklinksPanelProps {
  /** The block to show backlinks for. */
  blockId: string | null
}

export function BacklinksPanel({ blockId }: BacklinksPanelProps): React.ReactElement {
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [resolveVersion, setResolveVersion] = useState(0)
  const resolveCache = useRef<Map<string, { title: string; deleted: boolean }>>(new Map())

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
    resolveCache.current.clear()
    loadBacklinks()
  }, [blockId, loadBacklinks])

  // Resolve [[ULID]] and #[ULID] tokens found in backlink content
  useEffect(() => {
    if (blocks.length === 0) return

    const ULID_RE = /\[\[([0-9A-Z]{26})\]\]/g
    const TAG_RE = /#\[([0-9A-Z]{26})\]/g
    const idsToResolve = new Set<string>()

    for (const block of blocks) {
      if (!block.content) continue
      for (const m of block.content.matchAll(ULID_RE)) idsToResolve.add(m[1])
      for (const m of block.content.matchAll(TAG_RE)) idsToResolve.add(m[1])
    }

    // Remove already-cached IDs
    for (const id of idsToResolve) {
      if (resolveCache.current.has(id)) idsToResolve.delete(id)
    }

    if (idsToResolve.size === 0) {
      setResolveVersion((v) => v + 1)
      return
    }

    let cancelled = false

    Promise.all(
      [...idsToResolve].map(async (id) => {
        if (cancelled) return
        try {
          const b = await getBlock(id)
          if (!cancelled) {
            resolveCache.current.set(id, {
              title:
                b.content?.slice(0, 60) ||
                (b.block_type === 'tag' ? `#${id.slice(0, 8)}...` : `[[${id.slice(0, 8)}...]]`),
              deleted: b.deleted_at !== null,
            })
          }
        } catch {
          if (!cancelled) {
            resolveCache.current.set(id, { title: `[[${id.slice(0, 8)}...]]`, deleted: true })
          }
        }
      }),
    ).then(() => {
      if (!cancelled) setResolveVersion((v) => v + 1)
    })

    return () => {
      cancelled = true
    }
  }, [blocks])

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockTitle = useCallback(
    (id: string): string => {
      return resolveCache.current.get(id)?.title ?? `[[${id.slice(0, 8)}...]]`
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      return resolveCache.current.get(id)?.deleted ? 'deleted' : 'active'
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveTagName = useCallback(
    (id: string): string => {
      return resolveCache.current.get(id)?.title ?? `#${id.slice(0, 8)}...`
    },
    [resolveVersion],
  )

  const loadMore = useCallback(() => {
    if (nextCursor) loadBacklinks(nextCursor)
  }, [nextCursor, loadBacklinks])

  if (!blockId) {
    return <EmptyState icon={Link} message="Select a block to see backlinks" compact />
  }

  return (
    <div className="backlinks-panel space-y-4">
      {loading && blocks.length === 0 && (
        <div className="backlinks-panel-loading space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {!loading && blocks.length === 0 && <EmptyState icon={Link} message="No backlinks found" />}

      <div className="backlinks-list space-y-2">
        {blocks.map((block) => (
          <div
            key={block.id}
            className="backlink-item flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50 cursor-default"
          >
            <Badge variant="secondary" className="backlink-item-type shrink-0">
              {block.block_type}
            </Badge>
            <span className="backlink-item-text text-sm flex-1 truncate">
              {block.content
                ? renderRichContent(block.content, {
                    resolveBlockTitle,
                    resolveTagName,
                    resolveBlockStatus,
                  })
                : '(empty)'}
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
