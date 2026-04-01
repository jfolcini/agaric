/**
 * BacklinksPanel -- shows blocks that link to the given block via [[ULID]] references.
 *
 * Per-block panel: receives a blockId prop and displays paginated backlinks.
 * Uses cursor-based pagination with "Load more" button.
 * Filters are server-side via `queryBacklinksFiltered`.
 */

import { Link, Loader2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { BacklinkFilter, BacklinkSort, BlockRow } from '../lib/tauri'
import {
  batchResolve,
  getBlock,
  listPropertyKeys,
  listTagsByPrefix,
  queryBacklinksFiltered,
} from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { BacklinkFilterBuilder } from './BacklinkFilterBuilder'
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
  const [totalCount, setTotalCount] = useState(0)
  const [resolveVersion, setResolveVersion] = useState(0)
  const resolveCache = useRef<Map<string, { title: string; deleted: boolean }>>(new Map())
  const requestIdRef = useRef(0)
  const prevBlockIdRef = useRef(blockId)

  // Filter & sort state
  const [filters, setFilters] = useState<BacklinkFilter[]>([])
  const [sort, setSort] = useState<BacklinkSort | null>(null)
  const [propertyKeys, setPropertyKeys] = useState<string[]>([])
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)

  // Load property keys on mount
  useEffect(() => {
    listPropertyKeys()
      .then(setPropertyKeys)
      .catch((err) => {
        console.error('Failed to load property keys:', err)
        toast.error('Failed to load property keys')
      })
  }, [])

  // Load tags on mount
  useEffect(() => {
    listTagsByPrefix({ prefix: '' })
      .then((result) => setTags((result ?? []).map((t) => ({ id: t.tag_id, name: t.name }))))
      .catch((err) => {
        console.error('Failed to load tags:', err)
        toast.error('Failed to load tags')
      })
  }, [])

  const loadBacklinks = useCallback(
    async (cursor?: string) => {
      if (!blockId) return
      const currentRequestId = ++requestIdRef.current
      setLoading(true)
      try {
        const resp = await queryBacklinksFiltered({
          blockId,
          filters: filters.length > 0 ? filters : undefined,
          sort: sort ?? undefined,
          cursor,
          limit: 50,
        })
        if (requestIdRef.current !== currentRequestId) return // stale response
        if (cursor) {
          setBlocks((prev) => {
            const existingIds = new Set(prev.map((b) => b.id))
            const newItems = resp.items.filter((b) => !existingIds.has(b.id))
            return [...prev, ...newItems]
          })
        } else {
          setBlocks(resp.items)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(resp.total_count)
      } catch {
        if (requestIdRef.current !== currentRequestId) return // stale response
        toast.error('Failed to load backlinks')
      }
      setLoading(false)
    },
    [blockId, filters, sort],
  )

  // Reset and reload when blockId changes
  useEffect(() => {
    // Only clear blocks + filters when navigating to a different block (#341)
    // When filters/sort change (same block), keep stale results visible
    // until the new query response replaces them — avoids flash of empty state.
    // Design choice (#343): re-navigating to the same blockId preserves filters
    // since they're tied to the view, not the navigation event.
    if (prevBlockIdRef.current !== blockId) {
      setBlocks([])
      setFilters([])
      setSort(null)
      resolveCache.current.clear()
      prevBlockIdRef.current = blockId
    }
    // Always reset pagination when re-querying (blockId or filter/sort change)
    setNextCursor(null)
    setHasMore(false)
    // total_count is updated by the response; not cleared here to avoid
    // a stale "0 of 0" flash. Acceptable for a personal app (#342).
    loadBacklinks()
  }, [blockId, loadBacklinks])

  // Reset pagination when filters/sort change (handled via loadBacklinks dep)

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

    // Single batch IPC call instead of N individual getBlock calls
    batchResolve([...idsToResolve])
      .then((resolved) => {
        if (cancelled) return
        // Cap resolve cache at 1000 entries to prevent unbounded growth
        const MAX_CACHE_SIZE = 1000
        if (resolveCache.current.size + idsToResolve.size > MAX_CACHE_SIZE) {
          const overflow = resolveCache.current.size + idsToResolve.size - MAX_CACHE_SIZE
          const keys = resolveCache.current.keys()
          for (let i = 0; i < overflow; i++) {
            const next = keys.next()
            if (next.done) break
            resolveCache.current.delete(next.value)
          }
        }
        for (const r of resolved) {
          resolveCache.current.set(r.id, {
            title:
              r.title?.slice(0, 60) ||
              (r.block_type === 'tag' ? `#${r.id.slice(0, 8)}...` : `[[${r.id.slice(0, 8)}...]]`),
            deleted: r.deleted,
          })
        }
        // Mark unresolved IDs as deleted (not found in DB)
        for (const id of idsToResolve) {
          if (!resolveCache.current.has(id)) {
            resolveCache.current.set(id, { title: `[[${id.slice(0, 8)}...]]`, deleted: true })
          }
        }
        setResolveVersion((v) => v + 1)
      })
      .catch(() => {
        // Batch resolve failed -- leave fallbacks
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

  const handleFiltersChange = useCallback((newFilters: BacklinkFilter[]) => {
    setFilters(newFilters)
  }, [])

  const handleSortChange = useCallback((newSort: BacklinkSort | null) => {
    setSort(newSort)
  }, [])

  const handleNavigate = useCallback(
    async (block: BlockRow) => {
      if (block.block_type === 'page') {
        navigateToPage(block.id, block.content ?? 'Untitled')
        return
      }
      if (block.parent_id) {
        try {
          const parent = await getBlock(block.parent_id)
          navigateToPage(block.parent_id, parent.content ?? 'Untitled', block.id)
        } catch {
          navigateToPage(block.parent_id, 'Untitled', block.id)
        }
      }
    },
    [navigateToPage],
  )

  if (!blockId) {
    return <EmptyState icon={Link} message="Select a block to see backlinks" compact />
  }

  return (
    <div className="backlinks-panel space-y-3">
      {/* Filter builder */}
      <div className="[@media(pointer:coarse)]:max-h-[40vh] [@media(pointer:coarse)]:overflow-y-auto">
        <BacklinkFilterBuilder
          filters={filters}
          sort={sort}
          onFiltersChange={handleFiltersChange}
          onSortChange={handleSortChange}
          totalCount={totalCount}
          filteredCount={totalCount}
          propertyKeys={propertyKeys}
          tags={tags}
          tagResolver={resolveTagName}
        />
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {totalCount > 0 ? `${blocks.length} of ${totalCount} backlinks loaded` : ''}
      </div>

      {loading && blocks.length === 0 && (
        <div className="backlinks-panel-loading space-y-2" aria-busy="true" role="status">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {!loading && blocks.length === 0 && (
        <EmptyState
          icon={Link}
          message={filters.length > 0 ? 'No backlinks match your filters' : 'No backlinks found'}
          action={
            filters.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full text-xs"
                onClick={() => {
                  setFilters([])
                  setSort(null)
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}

      <ul className="backlinks-list space-y-2" aria-label="Backlinks">
        {blocks.map((block) => (
          <li
            key={block.id}
            className="backlink-item flex items-center gap-3 border-b py-2 px-1 last:border-b-0 cursor-pointer hover:bg-muted/50 [@media(pointer:coarse)]:flex-col [@media(pointer:coarse)]:items-start [@media(pointer:coarse)]:gap-1"
            tabIndex={0}
            onClick={() => handleNavigate(block)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleNavigate(block)
              }
            }}
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
            <span className="backlink-item-id text-xs text-muted-foreground font-mono [@media(pointer:coarse)]:self-end">
              {block.id.slice(0, 8)}...
            </span>
          </li>
        ))}
      </ul>

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="backlinks-load-more w-full"
          onClick={loadMore}
          disabled={loading}
          aria-busy={loading}
          aria-label={loading ? 'Loading more backlinks' : `Load more backlinks (${blocks.length} of ${totalCount} loaded)`}
        >
          {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading...</> : 'Load more'}
        </Button>
      )}
    </div>
  )
}
