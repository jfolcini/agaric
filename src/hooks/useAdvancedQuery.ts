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
 * D2 wires the full engine surface: an optional `fulltext` term (FTS5 intersect),
 * multi-key `sort`, `groupBy`, and `aggregates`. In GROUPED mode the engine
 * returns `groups` (and leaves `rows` empty), paginating over groups via the
 * same cursor; in FLAT mode it returns `rows` plus an optional global aggregate
 * summary. It owns the keyset cursor, load-more, loading/error state, and
 * resolves parent-page titles for the results (flat rows + grouped members) —
 * modelled on `useQueryExecution`, including the monotonic request-id guard so a
 * slow in-flight fetch can't clobber a faster newer one when the inputs or space
 * change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { logger } from '@/lib/logger'
import type {
  AggregateResult,
  AggregateSpec,
  BlockRow,
  FilterExpr,
  FilterPrimitive,
  GroupSpec,
  QueryGroup,
  SortKey,
} from '@/lib/tauri'
import { batchResolve, runAdvancedQuery } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

/** Number of rows per paginated request. */
const PAGE_SIZE = 50

interface UseAdvancedQueryOptions {
  /** The flat conjunction of filter chips to run (the working set). */
  filters: FilterPrimitive[]
  /**
   * Optional full-text term. Empty/whitespace ⇒ omitted (purely structural).
   * When present, the engine intersects an FTS5 `MATCH` and exposes per-row
   * relevance; `SortSource::Relevance` becomes valid.
   */
  fulltext?: string
  /** Ordered sort keys. Empty ⇒ the engine's default keyset. */
  sort?: SortKey[]
  /** Optional grouping directive. `null`/omitted ⇒ the FLAT path. */
  groupBy?: GroupSpec | null
  /** Optional global (and per-group, when grouped) aggregates. */
  aggregates?: AggregateSpec[]
}

interface UseAdvancedQueryResult {
  /** The matched block rows accumulated across pages (flat mode, `BlockRow`-shaped). */
  results: BlockRow[]
  /**
   * The group buckets accumulated across pages (grouped mode), or `null` in
   * flat mode. In grouped mode `results` is empty and pagination runs over
   * groups via the same cursor.
   */
  groups: QueryGroup[] | null
  /**
   * Global aggregate results (request order), or `null` when no aggregates were
   * requested. Computed over the full match set on the first page only.
   */
  aggregates: AggregateResult[] | null
  loading: boolean
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  /**
   * Total matching rows ignoring cursor/limit (flat mode), or total GROUP count
   * (grouped mode); `null` until the first page settles.
   */
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
  const { filters, fulltext, sort, groupBy, aggregates } = options
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [results, setResults] = useState<BlockRow[]>([])
  const [groups, setGroups] = useState<QueryGroup[] | null>(null)
  const [aggregateResults, setAggregateResults] = useState<AggregateResult[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  // Serialise every structural input so the fetch effect re-runs on any change
  // (the arrays/objects churn identity every render in the parent). A single
  // serialised key keeps the `fetchResults` callback deps minimal.
  const filtersKey = JSON.stringify(filters)
  // Normalise the full-text term once: trim, and treat empty as absent so we
  // omit `fulltext` rather than sending `''` (the engine treats `Some("")` as a
  // full-text query with no terms).
  const trimmedFulltext = (fulltext ?? '').trim()
  const sortKey = JSON.stringify(sort ?? [])
  const groupByKey = JSON.stringify(groupBy ?? null)
  const aggregatesKey = JSON.stringify(aggregates ?? [])

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
      // Resolve the parent-page titles for a batch of member/result rows and
      // merge them into `pageTitles` (append on load-more, replace on a fresh
      // fetch). Returns `false` if a newer request superseded this one.
      const applyTitles = async (rows: BlockRow[]): Promise<boolean> => {
        const titles = await resolvePageTitles(rows)
        if (myReqId !== reqIdRef.current) return false
        if (titles.size > 0) {
          setPageTitles((prev) => (isLoadMore ? new Map([...prev, ...titles]) : titles))
        } else if (!isLoadMore) {
          setPageTitles(new Map())
        }
        return true
      }
      try {
        const parsedSortRaw = JSON.parse(sortKey) as SortKey[]
        const parsedGroupBy = JSON.parse(groupByKey) as GroupSpec | null
        const parsedAggregates = JSON.parse(aggregatesKey) as AggregateSpec[]
        // Sanitise the sort: `SortSource::Relevance` is ONLY valid when a
        // full-text term is present (the engine REJECTS it otherwise with a
        // `InvalidSort` validation error). The controls picker only OFFERS
        // Relevance while a term is set, but a stale Relevance key survives the
        // user clearing the term afterwards — drop it here so the wire request
        // is always engine-valid rather than erroring out.
        const parsedSort =
          trimmedFulltext !== ''
            ? parsedSortRaw
            : parsedSortRaw.filter((k) => k.source.type !== 'Relevance')
        // FEAT-3 Phase 4 parity: the engine requires a space. The `?? ''`
        // fallback is intentional pre-bootstrap behaviour — an empty string
        // forces a no-match SQL filter rather than a runtime null deref.
        // Optional engine inputs are omitted (not sent as empty) when unset so
        // the request stays the minimal wire shape and the engine applies its
        // documented defaults.
        const response = await runAdvancedQuery({
          spaceId: currentSpaceId ?? '',
          filter: primitivesToFilterExpr(JSON.parse(filtersKey) as FilterPrimitive[]),
          limit: PAGE_SIZE,
          ...(trimmedFulltext !== '' ? { fulltext: trimmedFulltext } : {}),
          ...(parsedSort.length > 0 ? { sort: parsedSort } : {}),
          ...(parsedGroupBy != null ? { groupBy: parsedGroupBy } : {}),
          ...(parsedAggregates.length > 0 ? { aggregates: parsedAggregates } : {}),
          ...(pageCursor != null ? { cursor: pageCursor } : {}),
        })
        if (myReqId !== reqIdRef.current) return

        const isGrouped = parsedGroupBy != null

        // GROUPED mode: the engine returns `groups` (and leaves `rows` empty),
        // paginating over groups via the same cursor. Resolve the parent-page
        // titles of every previewed member so the member rows render links.
        if (isGrouped) {
          const pageGroups = response.groups ?? []
          setResults([])
          if (isLoadMore) {
            setGroups((prev) => [...(prev ?? []), ...pageGroups])
          } else {
            setGroups(pageGroups)
            setTotalCount(response.totalCount)
            setAggregateResults(response.aggregates ?? null)
          }
          setCursor(response.nextCursor)
          setHasMore(response.hasMore)
          const memberRows = pageGroups.flatMap((g) => g.members as unknown as BlockRow[])
          await applyTitles(memberRows)
          return
        }

        // FLAT mode.
        setGroups(null)
        // `QueryResultRow` is `{ score } & ActiveBlockRow` — wire-compatible
        // with `BlockRow` (identical 12 columns), so render the rows directly.
        const items = response.rows as unknown as BlockRow[]
        if (isLoadMore) {
          setResults((prev) => [...prev, ...items])
        } else {
          setResults(items)
          // totalCount + global aggregates are only computed on the FIRST page
          // (invariant across cursor pages), so only set them on the initial fetch.
          setTotalCount(response.totalCount)
          setAggregateResults(response.aggregates ?? null)
        }
        setCursor(response.nextCursor)
        setHasMore(response.hasMore)
        await applyTitles(items)
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
    [currentSpaceId, filtersKey, trimmedFulltext, sortKey, groupByKey, aggregatesKey],
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
    groups,
    aggregates: aggregateResults,
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
