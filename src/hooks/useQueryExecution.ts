import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { parseDate } from '@/lib/parse-date'
import { type PropertyFilter, parseQueryExpression } from '@/lib/query-utils'
import type { BlockRow } from '@/lib/tauri'
import { batchResolve, listBlocks, queryByProperty, queryByTags } from '@/lib/tauri'

/** Number of items per paginated request. */
const PAGE_SIZE = 50

/** Cap on the number of rows returned by an AND-intersected filtered query. */
const FILTERED_QUERY_MAX_ROWS = 50

/** Per-sub-query fetch size for a filtered (AND) query. */
const FILTERED_SUBQUERY_LIMIT = 200

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
): Promise<QueryFetchResult> {
  const tagExpr = params['expr'] ?? ''
  const resp = await queryByTags({
    tagIds: [],
    prefixes: tagExpr ? [tagExpr] : [],
    mode: 'or',
    cursor: pageCursor,
    limit: PAGE_SIZE,
  })
  return { items: resp.items, nextCursor: resp.next_cursor, hasMore: resp.has_more }
}

/** Fetch blocks matching a property key (and optional value/date). */
export async function fetchPropertyQuery(
  params: Record<string, string>,
  pageCursor?: string,
): Promise<QueryFetchResult> {
  if (!params['key']) {
    throw new QueryValidationError('Property query requires key:NAME parameter')
  }
  const resp = await queryByProperty({
    key: params['key'],
    ...(params['value'] != null && { valueText: params['value'] }),
    ...(params['date'] != null && { valueDate: params['date'] }),
    cursor: pageCursor,
    limit: PAGE_SIZE,
  })
  return { items: resp.items, nextCursor: resp.next_cursor, hasMore: resp.has_more }
}

/** Fetch blocks that are descendants of a target (backlinks query). */
export async function fetchBacklinksQuery(
  params: Record<string, string>,
  pageCursor?: string,
): Promise<QueryFetchResult> {
  if (!params['target']) {
    throw new QueryValidationError('Backlinks query requires target:ULID parameter')
  }
  const resp = await listBlocks({
    parentId: params['target'],
    cursor: pageCursor,
    limit: PAGE_SIZE,
  })
  return { items: resp.items, nextCursor: resp.next_cursor, hasMore: resp.has_more }
}

/** Execute each property/tag filter in parallel and AND-intersect the results. */
export async function fetchFilteredQuery(
  propertyFilters: PropertyFilter[],
  tagFilters: string[],
): Promise<QueryFetchResult> {
  const queryPromises: Promise<BlockRow[]>[] = []

  for (const pf of propertyFilters) {
    const resolvedDate = parseDate(pf.value)
    const op = pf.operator ?? 'eq'
    queryPromises.push(
      queryByProperty({
        key: pf.key,
        ...(resolvedDate ? { valueDate: resolvedDate } : { valueText: pf.value }),
        operator: op,
        limit: FILTERED_SUBQUERY_LIMIT,
      }).then((resp) => resp.items),
    )
  }

  for (const tf of tagFilters) {
    queryPromises.push(
      queryByTags({
        tagIds: [],
        prefixes: [tf],
        mode: 'or',
        limit: FILTERED_SUBQUERY_LIMIT,
      }).then((resp) => resp.items),
    )
  }

  const resultSets = await Promise.all(queryPromises)
  const items = intersectResultSets(resultSets)
  return { items, nextCursor: null, hasMore: false }
}

/** AND-intersect an array of result sets: keep only blocks present in ALL sets. */
function intersectResultSets(resultSets: BlockRow[][]): BlockRow[] {
  if (resultSets.length === 0) return []
  if (resultSets.length === 1) return resultSets[0] as BlockRow[]

  const blockMap = new Map<string, BlockRow>()
  for (const rs of resultSets) {
    for (const b of rs) {
      if (!blockMap.has(b.id)) blockMap.set(b.id, b)
    }
  }

  const idSets = resultSets.map((rs) => new Set(rs.map((b) => b.id)))
  const intersectedIds = idSets.reduce((acc, set) => {
    const result = new Set<string>()
    for (const id of acc) {
      if (set.has(id)) result.add(id)
    }
    return result
  })

  return [...intersectedIds]
    .map((id) => blockMap.get(id))
    .filter((b): b is BlockRow => b != null)
    .slice(0, FILTERED_QUERY_MAX_ROWS)
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
): Promise<QueryFetchResult> {
  switch (parsed.type) {
    case 'tag':
      return await fetchTagQuery(parsed.params, pageCursor)
    case 'property':
      return await fetchPropertyQuery(parsed.params, pageCursor)
    case 'filtered':
      return await fetchFilteredQuery(parsed.propertyFilters, parsed.tagFilters)
    case 'backlinks':
      return await fetchBacklinksQuery(parsed.params, pageCursor)
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
  const [results, setResults] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  const fetchResults = useCallback(
    async (pageCursor?: string) => {
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
          setError('Query expression is empty')
          return
        }
        const parsed = parseQueryExpression(expression)
        const result = await dispatchQuery(parsed, pageCursor)
        applyQueryResult(result, isLoadMore, { setResults, setCursor, setHasMore })
        const titles = await resolvePageTitles(result.items)
        mergePageTitles(titles, isLoadMore, setPageTitles)
      } catch (e) {
        logger.warn('useQueryExecution', 'query execution failed', { expression }, e)
        handleFetchError(e, isLoadMore, setError)
      } finally {
        endFetch(isLoadMore, { setLoading, setLoadingMore })
      }
    },
    [expression],
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
