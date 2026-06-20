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
  AdvancedQueryRequest,
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
   * #1280 D3 — a pre-compiled nested boolean `FilterExpr` (from the builder
   * tree). When present it is sent as `filter` VERBATIM, bypassing
   * `primitivesToFilterExpr` and the flat `filters` list entirely. Other callers
   * that pass only `filters` keep the legacy flat-conjunction path.
   */
  filterExpr?: FilterExpr
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

/**
 * Resolve titles for a batch of block ids into a fresh Map. Used for both the
 * member rows' parent `page_id`s and (in GROUPED mode) the Tag/Page group keys,
 * which arrive as raw block ids (a tag's block id / a page's block id). Both go
 * through the same `batchResolve` so the header and the member rows share one
 * resolved-title map. `extraIds` lets the grouped path fold the group keys into
 * the same single IPC.
 */
async function resolvePageTitles(
  items: BlockRow[],
  extraIds: readonly string[] = [],
): Promise<Map<string, string>> {
  const parentIds = items.map((b) => b.page_id).filter((id): id is string => id != null)
  const allIds = [...parentIds, ...extraIds]
  if (allIds.length === 0) return new Map()
  const resolved = await batchResolve([...new Set(allIds)])
  const titleMap = new Map<string, string>()
  for (const r of resolved) {
    if (r.title) titleMap.set(r.id, r.title)
  }
  return titleMap
}

/**
 * The live structural inputs read from `inputsRef` to assemble a wire request.
 * Mirrors `UseAdvancedQueryOptions`' structural fields but with explicit
 * `undefined` (the ref snapshot writes them verbatim) for `exactOptionalPropertyTypes`.
 */
interface QueryInputs {
  filters: FilterPrimitive[]
  filterExpr: FilterExpr | undefined
  sort: SortKey[] | undefined
  groupBy: GroupSpec | null | undefined
  aggregates: AggregateSpec[] | undefined
}

/**
 * Assemble the engine wire request from the live structural inputs (not the
 * serialised change-detection keys — those only gate the fetch). Extracted from
 * `fetchResults` to keep that callback under the complexity cap. Returns the
 * `request` plus `groupBy` separately, since the post-response branching keys
 * off whether grouping was requested.
 */
function buildQueryArgs(
  inputs: QueryInputs,
  currentSpaceId: string | null,
  trimmedFulltext: string,
  pageCursor: string | undefined,
): { request: AdvancedQueryRequest; groupBy: GroupSpec | null } {
  const { filters, filterExpr, sort, groupBy, aggregates } = inputs
  const sortRaw = sort ?? []
  const groupBySpec = groupBy ?? null
  const aggregateSpecs = aggregates ?? []
  // Sanitise the sort: `SortSource::Relevance` is ONLY valid when a full-text
  // term is present (the engine REJECTS it otherwise with an `InvalidSort`
  // validation error). The controls picker only OFFERS Relevance while a term is
  // set, but a stale Relevance key survives the user clearing the term
  // afterwards — drop it here so the wire request is always engine-valid.
  const cleanSort =
    trimmedFulltext !== '' ? sortRaw : sortRaw.filter((k) => k.source.type !== 'Relevance')
  // #1280 D3 — when a pre-compiled boolean `FilterExpr` is supplied (the
  // nested-builder surface) send it VERBATIM, bypassing the flat-`filters`
  // conjunction entirely. Other callers pass only `filters`, so `filterExpr` is
  // absent and we wrap the flat list as an `And` of Leaves.
  const filter = filterExpr != null ? filterExpr : primitivesToFilterExpr(filters)
  // Phase 4 parity: the engine requires a space. The `?? ''` fallback is
  // intentional pre-bootstrap behaviour — an empty string forces a no-match SQL
  // filter rather than a runtime null deref. Optional engine inputs are omitted
  // (not sent as empty) when unset so the request stays the minimal wire shape.
  const request: AdvancedQueryRequest = {
    spaceId: currentSpaceId ?? '',
    filter,
    limit: PAGE_SIZE,
    ...(trimmedFulltext !== '' ? { fulltext: trimmedFulltext } : {}),
    ...(cleanSort.length > 0 ? { sort: cleanSort } : {}),
    ...(groupBySpec != null ? { groupBy: groupBySpec } : {}),
    ...(aggregateSpecs.length > 0 ? { aggregates: aggregateSpecs } : {}),
    ...(pageCursor != null ? { cursor: pageCursor } : {}),
  }
  return { request, groupBy: groupBySpec }
}

export function useAdvancedQuery(options: UseAdvancedQueryOptions): UseAdvancedQueryResult {
  const { filters, filterExpr, fulltext, sort, groupBy, aggregates } = options
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
  // #1280 D3 — serialise the optional pre-compiled boolean tree the same way so
  // the fetch effect re-runs whenever the builder tree changes. `undefined`
  // (the flat-`filters` callers) yields a stable `'null'` key, so those callers
  // keep the legacy path and never churn on this dep.
  const filterExprKey = JSON.stringify(filterExpr ?? null)
  // Normalise the full-text term once: trim, and treat empty as absent so we
  // omit `fulltext` rather than sending `''` (the engine treats `Some("")` as a
  // full-text query with no terms).
  const trimmedFulltext = (fulltext ?? '').trim()
  const sortKey = JSON.stringify(sort ?? [])
  const groupByKey = JSON.stringify(groupBy ?? null)
  const aggregatesKey = JSON.stringify(aggregates ?? [])

  // The `*Key` strings above are the change-DETECTOR (value-stable across the
  // parent's churning array/object identities). To USE the structures inside the
  // fetch we read the live inputs via a render-synced ref instead of round-trip
  // parsing the keys — same values, no per-fetch JSON.parse. The ref is written
  // on every render so the key-gated fetch always reads the current inputs.
  const inputsRef = useRef({ filters, filterExpr, sort, groupBy, aggregates })
  inputsRef.current = { filters, filterExpr, sort, groupBy, aggregates }

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
      const applyTitles = async (
        rows: BlockRow[],
        extraIds: readonly string[] = [],
      ): Promise<boolean> => {
        const titles = await resolvePageTitles(rows, extraIds)
        if (myReqId !== reqIdRef.current) return false
        if (titles.size > 0) {
          setPageTitles((prev) => (isLoadMore ? new Map([...prev, ...titles]) : titles))
        } else if (!isLoadMore) {
          setPageTitles(new Map())
        }
        return true
      }
      try {
        // Assemble the wire request from the LIVE inputs (read via `inputsRef`,
        // not by re-parsing the serialised keys). `parsedGroupBy` is returned
        // separately because the post-response branching keys off it.
        const { request, groupBy: parsedGroupBy } = buildQueryArgs(
          inputsRef.current,
          currentSpaceId,
          trimmedFulltext,
          pageCursor,
        )
        const response = await runAdvancedQuery(request)
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
          // For Tag/Page grouping the bucket key is a raw block id (a tag's /
          // page's block id), not a human label — fold those keys into the same
          // `batchResolve` so the header renders the resolved title (#1447).
          // Other dimensions' keys are already display-ready; `"none"` is the
          // NULL bucket and has no id to resolve.
          const groupKeyType = parsedGroupBy.key.type
          const groupKeyIds =
            groupKeyType === 'Tag' || groupKeyType === 'Page'
              ? pageGroups.map((g) => g.key).filter((k) => k !== 'none')
              : []
          await applyTitles(memberRows, groupKeyIds)
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
    // Value-stable-key change detection: the serialised `*Key` deps are the
    // legit change-detector — the parent churns array/object identity every
    // render, so the serialised keys are what stop this callback re-firing each
    // render. The callback BODY reads the live structures via `inputsRef.current`
    // (no JSON.parse round-trip), so exhaustive-deps sees the keys as unused and
    // flags them as unnecessary deps. They are intentional: removing them would
    // stop the fetch effect from re-running on input changes. (`filtersKey` is
    // also read in the catch logger, so only the others are "unused".)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      currentSpaceId,
      filtersKey,
      filterExprKey,
      trimmedFulltext,
      sortKey,
      groupByKey,
      aggregatesKey,
    ],
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
