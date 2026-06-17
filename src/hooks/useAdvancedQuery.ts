/**
 * useAdvancedQuery — runs the #1280 advanced-query engine for the dedicated
 * Advanced Query surface (D1).
 *
 * Assembles an `AdvancedQueryRequest` from the active space id (space store) and
 * the working-set chips (flat `FilterPrimitive[]`), wrapping the flat list as a
 * conjunction `FilterExpr` at the IPC boundary:
 *
 *   { type: 'And', children: prims.map((p) => ({ type: 'Leaf', primitive: p })) }
 *
 * v1 uses the engine's default sort and limit (sort/group/aggregate controls and
 * nested And/Or/Not are D2/D3 follow-ups). It owns the keyset cursor, load-more,
 * loading/error state, and resolves parent-page titles for the results — modelled
 * on `useQueryExecution`, including the monotonic request-id guard so a slow
 * in-flight fetch can't clobber a faster newer one when the filters or space
 * change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { logger } from '@/lib/logger'
import type { BlockRow, FilterExpr, FilterPrimitive } from '@/lib/tauri'
import { batchResolve, runAdvancedQuery } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

/** Number of rows per paginated request. */
const PAGE_SIZE = 50

interface UseAdvancedQueryOptions {
  /** The flat conjunction of filter chips to run (the working set). */
  filters: FilterPrimitive[]
}

interface UseAdvancedQueryResult {
  /** The matched block rows accumulated across pages (flat, `BlockRow`-shaped). */
  results: BlockRow[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  /** Total matching rows ignoring cursor/limit; `null` until the first page settles. */
  totalCount: number | null
  /** Map of parent page IDs to their resolved titles. */
  pageTitles: Map<string, string>
  handleLoadMore: () => void
  /** Re-run from the first page (e.g. a retry after an error). */
  fetchResults: () => void
}

/**
 * Wrap a flat list of filter primitives as a conjunction `FilterExpr` — each
 * primitive becomes a `Leaf`. An empty list yields `And { children: [] }`, the
 * engine's TRUE expression ("every block in the space").
 */
export function primitivesToFilterExpr(prims: FilterPrimitive[]): FilterExpr {
  return { type: 'And', children: prims.map((primitive) => ({ type: 'Leaf', primitive })) }
}

/** Resolve parent-page titles for a batch of rows into a fresh Map. */
async function resolvePageTitles(items: BlockRow[]): Promise<Map<string, string>> {
  const parentIds = items.map((b) => b.page_id).filter((id): id is string => id != null)
  if (parentIds.length === 0) return new Map()
  const resolved = await batchResolve([...new Set(parentIds)])
  const titleMap = new Map<string, string>()
  for (const r of resolved) {
    if (r.title) titleMap.set(r.id, r.title)
  }
  return titleMap
}

export function useAdvancedQuery(options: UseAdvancedQueryOptions): UseAdvancedQueryResult {
  const { filters } = options
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [results, setResults] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  // Serialise the chips so the fetch effect re-runs on a structural change
  // (the `filters` array identity churns every render in the parent).
  const filtersKey = JSON.stringify(filters)

  // Monotonic request-id guard (mirrors useQueryExecution): a stale fetch that
  // resolves after a newer one started bails out without touching state.
  const reqIdRef = useRef(0)

  const fetchResults = useCallback(
    async (pageCursor?: string) => {
      const myReqId = ++reqIdRef.current
      const isLoadMore = !!pageCursor
      if (isLoadMore) {
        setLoadingMore(true)
      } else {
        setLoading(true)
        setCursor(null)
        setHasMore(false)
      }
      setError(null)
      try {
        // FEAT-3 Phase 4 parity: the engine requires a space. The `?? ''`
        // fallback is intentional pre-bootstrap behaviour — an empty string
        // forces a no-match SQL filter rather than a runtime null deref.
        const response = await runAdvancedQuery({
          spaceId: currentSpaceId ?? '',
          filter: primitivesToFilterExpr(JSON.parse(filtersKey) as FilterPrimitive[]),
          limit: PAGE_SIZE,
          ...(pageCursor != null ? { cursor: pageCursor } : {}),
        })
        if (myReqId !== reqIdRef.current) return
        // `QueryResultRow` is `{ score } & ActiveBlockRow` — wire-compatible
        // with `BlockRow` (identical 12 columns), so render the rows directly.
        const items = response.rows as unknown as BlockRow[]
        if (isLoadMore) {
          setResults((prev) => [...prev, ...items])
        } else {
          setResults(items)
          // totalCount is only computed on the FIRST page (it doesn't change
          // as the same filter is paged), so only set it on the initial fetch.
          setTotalCount(response.totalCount)
        }
        setCursor(response.nextCursor)
        setHasMore(response.hasMore)
        const titles = await resolvePageTitles(items)
        if (myReqId !== reqIdRef.current) return
        if (titles.size > 0) {
          // Spread fresh data LAST so new titles overwrite stale entries.
          setPageTitles((prev) => (isLoadMore ? new Map([...prev, ...titles]) : titles))
        } else if (!isLoadMore) {
          setPageTitles(new Map())
        }
      } catch (e) {
        if (myReqId !== reqIdRef.current) return
        logger.warn('useAdvancedQuery', 'advanced query failed', { filtersKey }, e)
        // Only surface backend errors on the initial load (a load-more failure
        // shouldn't clobber the page the user is already viewing).
        if (!isLoadMore) setError(e instanceof Error ? e.message : 'Query failed')
      } finally {
        if (myReqId === reqIdRef.current) {
          if (isLoadMore) {
            setLoadingMore(false)
          } else {
            setLoading(false)
          }
        }
      }
    },
    [currentSpaceId, filtersKey],
  )

  useEffect(() => {
    fetchResults()
  }, [fetchResults])

  const handleLoadMore = useCallback(() => {
    if (cursor && !loadingMore) {
      fetchResults(cursor)
    }
  }, [cursor, loadingMore, fetchResults])

  return {
    results,
    loading,
    error,
    hasMore,
    loadingMore,
    totalCount,
    pageTitles,
    handleLoadMore,
    fetchResults,
  }
}
