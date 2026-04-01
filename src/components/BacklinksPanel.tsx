/**
 * BacklinksPanel — shows blocks that link to the given block via [[ULID]] references (p2-t3).
 *
 * Per-block panel: receives a blockId prop and displays paginated backlinks.
 * Uses cursor-based pagination with "Load more" button.
 * Filters: block type, task status (TODO/DOING/DONE), and creation date.
 */

import { Link } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { BlockRow, PropertyRow } from '../lib/tauri'
import { batchResolve, getBacklinks, getProperties } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { renderRichContent } from './StaticBlock'

// -- ULID timestamp decoder ---------------------------------------------------

/** Crockford base32 alphabet used by ULID. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CROCKFORD_MAP = new Map<string, number>()
for (let i = 0; i < CROCKFORD.length; i++) CROCKFORD_MAP.set(CROCKFORD[i], i)

/** Extract the Unix millisecond timestamp from a 26-char ULID. */
function ulidToMs(ulid: string): number {
  let ts = 0
  for (let i = 0; i < 10; i++) {
    ts = ts * 32 + (CROCKFORD_MAP.get(ulid[i]) ?? 0)
  }
  return ts
}

// -- Filter types -------------------------------------------------------------

type TypeFilter = 'all' | 'content' | 'page' | 'tag'
type StatusFilter = 'all' | 'TODO' | 'DOING' | 'DONE' | 'none'
type DateFilter = 'all' | 'today' | 'week' | 'month'
type PriorityFilter = 'all' | 'A' | 'B' | 'C' | 'none'

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

  // Filter state
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all')

  // Task status cache (block ID → todo state or null)
  const [statusMap, setStatusMap] = useState<Map<string, string | null>>(new Map())

  // Priority cache (block ID → priority value or null)
  const [priorityMap, setPriorityMap] = useState<Map<string, string | null>>(new Map())

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
        toast.error('Failed to load backlinks')
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
    setStatusMap(new Map())
    setPriorityMap(new Map())
    resolveCache.current.clear()
    loadBacklinks()
  }, [blockId, loadBacklinks])

  // Fetch task status properties for loaded blocks
  useEffect(() => {
    if (blocks.length === 0) return
    let cancelled = false

    async function fetchStatuses() {
      const newMap = new Map<string, string | null>()
      const newPriorityMap = new Map<string, string | null>()
      await Promise.all(
        blocks.map(async (b) => {
          try {
            const props = await getProperties(b.id)
            const todo = props.find((p: PropertyRow) => p.key === 'todo')
            newMap.set(b.id, todo?.value_text ?? null)
            const priority = props.find((p: PropertyRow) => p.key === 'priority')
            newPriorityMap.set(b.id, priority?.value_text ?? null)
          } catch {
            newMap.set(b.id, null)
            newPriorityMap.set(b.id, null)
          }
        }),
      )
      if (!cancelled) {
        setStatusMap(newMap)
        setPriorityMap(newPriorityMap)
      }
    }
    fetchStatuses()
    return () => {
      cancelled = true
    }
  }, [blocks])

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
        // Batch resolve failed — leave fallbacks
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

  // Apply client-side filters
  const filteredBlocks = useMemo(() => {
    const now = Date.now()
    const dayMs = 86_400_000
    const todayStart = now - (now % dayMs)
    const weekStart = todayStart - new Date().getDay() * dayMs + dayMs // Monday
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()

    return blocks.filter((block) => {
      // Type filter
      if (typeFilter !== 'all' && block.block_type !== typeFilter) return false

      // Status filter (requires statusMap)
      if (statusFilter !== 'all') {
        const status = statusMap.get(block.id)
        if (statusFilter === 'none') {
          if (status != null) return false
        } else if (status !== statusFilter) {
          return false
        }
      }

      // Date filter (ULID timestamp)
      if (dateFilter !== 'all') {
        const createdMs = ulidToMs(block.id)
        if (dateFilter === 'today' && createdMs < todayStart) return false
        if (dateFilter === 'week' && createdMs < weekStart) return false
        if (dateFilter === 'month' && createdMs < monthStart) return false
      }

      // Priority filter
      if (priorityFilter !== 'all') {
        const priority = priorityMap.get(block.id)
        if (priorityFilter === 'none') {
          if (priority != null) return false
        } else if (priority !== priorityFilter) return false
      }

      return true
    })
  }, [blocks, typeFilter, statusFilter, dateFilter, priorityFilter, statusMap, priorityMap])

  const hasFilters =
    typeFilter !== 'all' ||
    statusFilter !== 'all' ||
    dateFilter !== 'all' ||
    priorityFilter !== 'all'

  if (!blockId) {
    return <EmptyState icon={Link} message="Select a block to see backlinks" compact />
  }

  return (
    <div className="backlinks-panel space-y-3">
      {/* Filter bar */}
      <div
        className="backlinks-filters flex flex-wrap items-center gap-1.5"
        role="toolbar"
        aria-label="Backlink filters"
      >
        <select
          className="backlinks-filter-type h-7 rounded-md border bg-background px-2 text-xs"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
          aria-label="Filter by type"
        >
          <option value="all">All types</option>
          <option value="content">Content</option>
          <option value="page">Page</option>
          <option value="tag">Tag</option>
        </select>
        <select
          className="backlinks-filter-status h-7 rounded-md border bg-background px-2 text-xs"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="TODO">TODO</option>
          <option value="DOING">DOING</option>
          <option value="DONE">DONE</option>
          <option value="none">No status</option>
        </select>
        <select
          className="backlinks-filter-date h-7 rounded-md border bg-background px-2 text-xs"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value as DateFilter)}
          aria-label="Filter by date"
        >
          <option value="all">All dates</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
        </select>
        <select
          className="backlinks-filter-priority h-7 rounded-md border bg-background px-2 text-xs"
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
          aria-label="Filter by priority"
        >
          <option value="all">All priorities</option>
          <option value="A">High [A]</option>
          <option value="B">Medium [B]</option>
          <option value="C">Low [C]</option>
          <option value="none">No priority</option>
        </select>
        {hasFilters && (
          <Button
            variant="ghost"
            size="xs"
            className="backlinks-filter-clear text-xs text-muted-foreground"
            onClick={() => {
              setTypeFilter('all')
              setStatusFilter('all')
              setDateFilter('all')
              setPriorityFilter('all')
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {loading && blocks.length === 0 && (
        <div className="backlinks-panel-loading space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {!loading && blocks.length === 0 && <EmptyState icon={Link} message="No backlinks found" />}

      {!loading && blocks.length > 0 && filteredBlocks.length === 0 && hasFilters && (
        <EmptyState icon={Link} message="No backlinks match the current filters" compact />
      )}

      <div className="backlinks-list space-y-2">
        {filteredBlocks.map((block) => {
          const todoStatus = statusMap.get(block.id)
          const blockPriority = priorityMap.get(block.id)
          return (
            <div
              key={block.id}
              className="backlink-item flex items-center gap-3 rounded-lg border bg-card p-3 cursor-default"
            >
              <Badge variant="secondary" className="backlink-item-type shrink-0">
                {block.block_type}
              </Badge>
              {todoStatus && (
                <Badge
                  variant="outline"
                  className={`backlink-item-status shrink-0 text-[10px] ${
                    todoStatus === 'DONE'
                      ? 'border-green-600 text-green-600'
                      : todoStatus === 'DOING'
                        ? 'border-blue-500 text-blue-500'
                        : 'border-muted-foreground'
                  }`}
                >
                  {todoStatus}
                </Badge>
              )}
              {blockPriority && (
                <Badge
                  variant="outline"
                  className={`backlink-item-priority shrink-0 text-[10px] ${
                    blockPriority === 'A'
                      ? 'border-red-600 text-red-600'
                      : blockPriority === 'B'
                        ? 'border-yellow-600 text-yellow-600'
                        : 'border-blue-600 text-blue-600'
                  }`}
                >
                  {blockPriority === 'A' ? 'HIGH' : blockPriority === 'B' ? 'MED' : 'LOW'}
                </Badge>
              )}
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
          )
        })}
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
