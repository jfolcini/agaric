import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import { parseDate } from '@/lib/parse-date'
import { type PropertyFilter, parseQueryExpression } from '@/lib/query-utils'
import type { BlockRow, FilteredBlocksPropertyFilter } from '@/lib/tauri'
import {
  batchResolve,
  filteredBlocksQuery,
  listBlocks,
  listBlocksLimit,
  paginationLimit,
  queryByProperty,
  queryByTags,
} from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

/** Number of items per paginated request. */
const PAGE_SIZE = 50

interface UseQueryExecutionOptions {
  expression: string
}

interface UseQueryExecutionResult {
  results: BlockRow[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  pageTitles: Map<string, string>
  handleLoadMore: () => void
  fetchResults: () => void
}

/** Normalised result shape returned by each per-query-type fetch helper. */
export interface QueryFetchResult {
  items: BlockRow[]
  nextCursor: string | null
  hasMore: boolean
}

/** Thrown by a fetch helper when the parsed expression is missing required
 *  parameters (e.g. `key:` for property queries). The dispatcher also throws
 *  this for unknown query types. Distinct from arbitrary backend rejection so
 *  the hook can still surface validation messages when pageCursor is set. */
export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryValidationError'
  }
}

/** Fetch blocks matching a tag prefix. */
export async function fetchTagQuery(
  params: Record<string, string>,
  pageCursor?: string,
  spaceId?: string | null,
): Promise<QueryFetchResult> {
  const tagExpr = params['expr'] ?? ''
  const resp = await queryByTags({
    tagIds: [],
    prefixes: tagExpr ? [tagExpr] : [],
    mode: 'or',
    cursor: pageCursor,
    limit: paginationLimit(PAGE_SIZE),
    spaceId: spaceId ?? null,
  })
  return { items: resp.items, nextCursor: resp.next_cursor, hasMore: resp.has_more }
}

/** Fetch blocks matching a property key (and optional value/date). */
export async function fetchPropertyQuery(
  params: Record<string, string>,
  pageCursor?: string,
  spaceId?: string | null,
): Promise<QueryFetchResult> {
  if (!params['key']) {
    throw new QueryValidationError('Property query requires key:NAME parameter')
  }
  const resp = await queryByProperty({
    key: params['key'],
    ...(params['value'] != null && { valueText: params['value'] }),
    ...(params['date'] != null && { valueDate: params['date'] }),
    cursor: pageCursor,
    limit: paginationLimit(PAGE_SIZE),
    spaceId: spaceId ?? null,
  })
  return { items: resp.items, nextCursor: resp.next_cursor, hasMore: resp.has_more }
}

/** Fetch blocks that are descendants of a target (backlinks query). */
export async function fetchBacklinksQuery(
  params: Record<string, string>,
  pageCursor?: string,
  spaceId?: string | null,
): Promise<QueryFetchResult> {
  if (!params['target']) {
    throw new QueryValidationError('Backlinks query requires target:ULID parameter')
  }
  // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. The `?? ''`
  // fallback is intentional pre-bootstrap behaviour: empty string
  // forces a no-match SQL filter rather than a runtime null deref.
  const resp = await listBlocks({
    parentId: params['target'],
    cursor: pageCursor,
    limit: listBlocksLimit(PAGE_SIZE),
    spaceId: spaceId ?? '',
  })
  return { items: resp.items, nextCursor: resp.next_cursor, hasMore: resp.has_more }
}

/** PEND-35 Tier 2.10b — AND-intersect property + tag predicates in SQL.
 *
 *  Single IPC into [`filteredBlocksQuery`] which composes one
 *  `EXISTS (SELECT 1 FROM block_properties …)` subquery per property
 *  filter and one `EXISTS (… block_tags … UNION block_tag_refs …)`
 *  per tag filter. The AND between them is the structural conjunction
 *  of the EXISTS clauses — SQLite walks the full universe so the
 *  result row cap (now only the page limit) applies AFTER the
 *  intersection, NOT per-sub-query.
 *
 *  Replaces the legacy fan-out shape that issued one IPC per
 *  sub-filter with `FILTERED_SUBQUERY_LIMIT = 200` and intersected the
 *  result-id sets in JS with `FILTERED_QUERY_MAX_ROWS = 50`. Any
 *  AND-set member outside the top-200 of any one sub-query was
 *  silently dropped — see PEND-35 Tier 2.10b for the full audit.
 */
export async function fetchFilteredQuery(
  propertyFilters: PropertyFilter[],
  tagFilters: string[],
  spaceId?: string | null,
  pageCursor?: string,
): Promise<QueryFetchResult> {
  if (propertyFilters.length === 0 && tagFilters.length === 0) {
    // Pre-Tier-2.10b returned an empty result here without an IPC. The
    // backend would now reject the empty-input case with `Validation`,
    // so preserve the legacy short-circuit so consumers can still ask
    // "are there any active filters?" without paying a round-trip.
    return { items: [], nextCursor: null, hasMore: false }
  }

  const marshalledFilters: FilteredBlocksPropertyFilter[] = propertyFilters.map((pf) => {
    const resolvedDate = parseDate(pf.value)
    return {
      key: pf.key,
      ...(resolvedDate ? { valueDate: resolvedDate } : { valueText: pf.value }),
      operator: pf.operator ?? 'eq',
    }
  })

  const resp = await filteredBlocksQuery({
    propertyFilters: marshalledFilters,
    ...(tagFilters.length > 0 && {
      tagFilters: { tagIds: [], prefixes: tagFilters, mode: 'or' },
    }),
    spaceId: spaceId ?? null,
    cursor: pageCursor,
    limit: paginationLimit(PAGE_SIZE),
  })
  return { items: resp.items, nextCursor: resp.next_cursor, hasMore: resp.has_more }
}

type ParsedQuery = ReturnType<typeof parseQueryExpression>

/** Route a parsed query expression to the appropriate fetch helper.
 *
 *  Uses `return await` so a throw in the default arm is wrapped in a rejected
 *  promise (rather than a synchronous throw), keeping callers' error-handling
 *  symmetric with the `fetch*` helpers which all return promises.
 */
export async function dispatchQuery(
  parsed: ParsedQuery,
  pageCursor?: string,
  spaceId?: string | null,
): Promise<QueryFetchResult> {
  switch (parsed.type) {
    case 'tag':
      return await fetchTagQuery(parsed.params, pageCursor, spaceId)
    case 'property':
      return await fetchPropertyQuery(parsed.params, pageCursor, spaceId)
    case 'filtered':
      return await fetchFilteredQuery(
        parsed.propertyFilters,
        parsed.tagFilters,
        spaceId,
        pageCursor,
      )
    case 'backlinks':
      return await fetchBacklinksQuery(parsed.params, pageCursor, spaceId)
    default:
      throw new QueryValidationError(`Unknown query type: ${parsed.type}`)
  }
}

/** Resolve parent-page titles for a batch of blocks into a fresh Map. */
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

/** Setters required to toggle loading/cursor/error state at the start of a fetch. */
interface BeginFetchSetters {
  setLoading: Dispatch<SetStateAction<boolean>>
  setLoadingMore: Dispatch<SetStateAction<boolean>>
  setCursor: Dispatch<SetStateAction<string | null>>
  setHasMore: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
}

function beginFetch(isLoadMore: boolean, setters: BeginFetchSetters): void {
  if (isLoadMore) {
    setters.setLoadingMore(true)
  } else {
    setters.setLoading(true)
    setters.setCursor(null)
    setters.setHasMore(false)
  }
  setters.setError(null)
}

interface EndFetchSetters {
  setLoading: Dispatch<SetStateAction<boolean>>
  setLoadingMore: Dispatch<SetStateAction<boolean>>
}

function endFetch(isLoadMore: boolean, setters: EndFetchSetters): void {
  if (isLoadMore) {
    setters.setLoadingMore(false)
  } else {
    setters.setLoading(false)
  }
}

interface ApplyResultSetters {
  setResults: Dispatch<SetStateAction<BlockRow[]>>
  setCursor: Dispatch<SetStateAction<string | null>>
  setHasMore: Dispatch<SetStateAction<boolean>>
}

function applyQueryResult(
  result: QueryFetchResult,
  isLoadMore: boolean,
  setters: ApplyResultSetters,
): void {
  if (isLoadMore) {
    setters.setResults((prev) => [...prev, ...result.items])
  } else {
    setters.setResults(result.items)
  }
  setters.setCursor(result.nextCursor)
  setters.setHasMore(result.hasMore)
}

function mergePageTitles(
  newTitles: Map<string, string>,
  isLoadMore: boolean,
  setPageTitles: Dispatch<SetStateAction<Map<string, string>>>,
): void {
  if (newTitles.size === 0) return
  if (isLoadMore) {
    // Spread fresh data LAST so new titles overwrite stale entries (see AGENTS.md).
    setPageTitles((prev) => new Map([...prev, ...newTitles]))
  } else {
    setPageTitles(newTitles)
  }
}

function handleFetchError(
  e: unknown,
  isLoadMore: boolean,
  setError: Dispatch<SetStateAction<string | null>>,
): void {
  // Always surface validation errors; only surface backend errors on initial load.
  if (!isLoadMore || e instanceof QueryValidationError) {
    setError(e instanceof Error ? e.message : 'Query failed')
  }
}

export function useQueryExecution(options: UseQueryExecutionOptions): UseQueryExecutionResult {
  const { expression } = options
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [results, setResults] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  // PEND-22: monotonic request-id counter so a slow in-flight fetch can't
  // clobber the results of a faster newer fetch when `expression` /
  // `currentSpaceId` change (or `handleLoadMore` is called) before the
  // previous IPC settles. Each fetch captures its own `myReqId`; if the
  // counter has advanced before an await resolves, the stale fetch bails
  // out without touching state.
  const reqIdRef = useRef(0)

  const fetchResults = useCallback(
    async (pageCursor?: string) => {
      const myReqId = ++reqIdRef.current
      const isLoadMore = !!pageCursor
      beginFetch(isLoadMore, {
        setLoading,
        setLoadingMore,
        setCursor,
        setHasMore,
        setError,
      })
      try {
        if (!expression.trim()) {
          if (myReqId === reqIdRef.current) setError('Query expression is empty')
          return
        }
        const parsed = parseQueryExpression(expression)
        const result = await dispatchQuery(parsed, pageCursor, currentSpaceId)
        if (myReqId !== reqIdRef.current) return
        applyQueryResult(result, isLoadMore, { setResults, setCursor, setHasMore })
        const titles = await resolvePageTitles(result.items)
        if (myReqId !== reqIdRef.current) return
        mergePageTitles(titles, isLoadMore, setPageTitles)
      } catch (e) {
        if (myReqId !== reqIdRef.current) return
        logger.warn('useQueryExecution', 'query execution failed', { expression }, e)
        handleFetchError(e, isLoadMore, setError)
      } finally {
        if (myReqId === reqIdRef.current) endFetch(isLoadMore, { setLoading, setLoadingMore })
      }
    },
    [expression, currentSpaceId],
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
    pageTitles,
    handleLoadMore,
    fetchResults,
  }
}
