import { useInfiniteQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { resolveLegacyQueryToFilterExpr } from '@/lib/inline-query-resolve'
import { decodeInlineQueryPayload } from '@/lib/inline-query-spec'
import { parseDate } from '@/lib/parse-date'
import { queryClient } from '@/lib/query-client'
import { type PropertyFilter, parseQueryExpression } from '@/lib/query-utils'
import type { BlockRow, FilterExpr, FilteredBlocksPropertyFilter } from '@/lib/tauri'
import {
  batchResolve,
  filteredBlocksQuery,
  listBlocks,
  listBlocksLimit,
  listTagsByPrefix,
  paginationLimit,
  queryByProperty,
  queryByTags,
  runAdvancedQuery,
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
  // #2248 — `listBlocks` requires an active space; there is no cross-space
  // listing. With no active space, return an empty page rather than invoking
  // (which would throw in `requireActiveScope`).
  if (!spaceId) {
    return { items: [], nextCursor: null, hasMore: false }
  }
  const resp = await listBlocks({
    parentId: params['target'],
    cursor: pageCursor,
    limit: listBlocksLimit(PAGE_SIZE),
    spaceId,
  })
  return { items: resp.items, nextCursor: resp.next_cursor, hasMore: resp.has_more }
}

/** AND-intersect property + tag predicates in SQL.
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
 * Silently dropped — for the full audit.
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
    case 'tag': {
      return await fetchTagQuery(parsed.params, pageCursor, spaceId)
    }
    case 'property': {
      return await fetchPropertyQuery(parsed.params, pageCursor, spaceId)
    }
    case 'filtered': {
      return await fetchFilteredQuery(
        parsed.propertyFilters,
        parsed.tagFilters,
        spaceId,
        pageCursor,
      )
    }
    case 'backlinks': {
      return await fetchBacklinksQuery(parsed.params, pageCursor, spaceId)
    }
    default: {
      throw new QueryValidationError(`Unknown query type: ${parsed.type}`)
    }
  }
}

/**
 * Execute a structured (`v2:`) inline query through the rich `run_advanced_query`
 * engine. The engine's `QueryResultRow` is wire-compatible with `BlockRow`
 * (identical columns plus an optional `score`), so the rows render through the
 * exact same `QueryResultList`/`QueryResultTable` path as the legacy fetch
 * helpers — only the data source differs.
 */
export async function fetchRichInlineQuery(
  filter: FilterExpr,
  pageCursor?: string,
  spaceId?: string | null,
): Promise<QueryFetchResult> {
  const response = await runAdvancedQuery({
    spaceId: spaceId ?? '',
    filter,
    limit: PAGE_SIZE,
    ...(pageCursor != null ? { cursor: pageCursor } : {}),
  })
  return {
    items: response.rows as unknown as BlockRow[],
    nextCursor: response.nextCursor,
    hasMore: response.hasMore,
  }
}

/**
 * Resolve which execution path an inline query uses and run it (#1951 P2):
 * structured `v2:` payloads and faithfully-translatable legacy text queries run
 * through the rich `run_advanced_query` engine; anything the translator refuses
 * keeps the original legacy per-type dispatch. Exported for the legacy↔rich
 * equivalence tests.
 */
export async function resolveInlineQuery(
  expression: string,
  pageCursor?: string,
  spaceId?: string | null,
): Promise<QueryFetchResult> {
  const structured = decodeInlineQueryPayload(expression)
  if (structured) {
    return await fetchRichInlineQuery(structured.filter, pageCursor, spaceId)
  }
  const parsed = parseQueryExpression(expression)
  const resolved = await resolveLegacyQueryToFilterExpr(parsed, {
    resolveTagPrefix: async (prefix) => (await listTagsByPrefix({ prefix })).map((t) => t.tag_id),
  })
  if (resolved.filterExpr != null) {
    return await fetchRichInlineQuery(resolved.filterExpr, pageCursor, spaceId)
  }
  return await dispatchQuery(parsed, pageCursor, spaceId)
}

/** Resolve parent-page titles for a batch of blocks into a fresh Map. */
async function resolvePageTitles(items: BlockRow[]): Promise<Map<string, string>> {
  const parentIds = items.map((b) => b.page_id).filter((id): id is string => id != null)
  if (parentIds.length === 0) return new Map()
  const resolved = await batchResolve([...new Set(parentIds)], 'global')
  const titleMap = new Map<string, string>()
  for (const r of resolved) {
    if (r.title) titleMap.set(r.id, r.title)
  }
  return titleMap
}

/** One resolved page of query results plus its own parent-page titles.
 *  Folding titles INTO each page (rather than a separate merge step) lets
 *  TanStack own the page list — the merged `pageTitles` map is derived from
 *  `data.pages` on render. */
interface QueryPage {
  items: BlockRow[]
  nextCursor: string | null
  hasMore: boolean
  titles: Map<string, string>
}

export function useQueryExecution(options: UseQueryExecutionOptions): UseQueryExecutionResult {
  const { expression } = options
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)

  // #2596 pilot (proof point 2) — the hand-rolled infinite query (manual
  // cursor state + `useRef` monotonic race-guard + `useState`
  // loading/error/hasMore) is now a TanStack `useInfiniteQuery`. TanStack owns
  // loading/error/cursor state and the latest-wins race-guard: because the
  // `queryKey` embeds `expression`/`currentSpaceId`, a slow older fetch settles
  // into its OWN (now inactive) cache entry and can't clobber the newer query's
  // results. The client is passed EXPLICITLY (2nd arg) so no
  // `QueryClientProvider` ancestor is required (see `query-client.ts`).
  const {
    data,
    error: queryError,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery(
    {
      queryKey: ['queryExecution', currentSpaceId, expression],
      // Resolve the execution path (#1951 P2):
      //   1. A structured (`v2:`) payload runs through the rich engine.
      //   2. A legacy text query is translated to a `FilterExpr` and ALSO run
      //      through the rich engine when faithfully expressible.
      //   3. Anything the translator refuses (backlinks, non-eq reserved
      //      filters, key-only, unknown) keeps the original legacy dispatch.
      // Page-title resolution is folded IN so each page carries its own titles.
      queryFn: async ({ pageParam }): Promise<QueryPage> => {
        const result = await resolveInlineQuery(expression, pageParam ?? undefined, currentSpaceId)
        const titles = await resolvePageTitles(result.items)
        return {
          items: result.items,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          titles,
        }
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
      // Preserve the current behaviour: an empty expression never fetches and
      // surfaces its own `error` string (derived below).
      enabled: expression.trim() !== '',
      // The hand-rolled hook re-ran `fetchResults()` in a mount effect on every
      // mount / `expression` change — it never served stale data from a prior
      // mount. Preserve that: keep the client's `staleTime: Infinity` (no
      // time-based refetch) but force a fresh fetch whenever a QueryResult
      // mounts, so a remount reflects the current backend rather than a stale
      // cached page. In-flight fetches for the same key are still deduped.
      refetchOnMount: 'always',
    },
    queryClient,
  )

  const results = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data])

  // Merge every page's titles into ONE map, spreading later pages LAST so
  // fresh titles overwrite stale entries (see AGENTS.md). Memoised so identity
  // stays stable when `data` is unchanged.
  const pageTitles = useMemo(() => {
    const merged = new Map<string, string>()
    for (const page of data?.pages ?? []) {
      for (const [id, title] of page.titles) merged.set(id, title)
    }
    return merged
  }, [data])

  // Error asymmetry (preserved from the hand-rolled `handleFetchError`):
  //   - empty expression → dedicated message, no fetch;
  //   - validation errors → always surfaced;
  //   - backend errors → surfaced only on the INITIAL load (no pages yet);
  //     a failed `fetchNextPage` (load-more) does NOT surface as `error`.
  let error: string | null = null
  if (expression.trim() === '') {
    error = 'Query expression is empty'
  } else if (queryError != null) {
    const isInitialLoadError = (data?.pages.length ?? 0) === 0
    if (isInitialLoadError || queryError instanceof QueryValidationError) {
      error = queryError instanceof Error ? queryError.message : 'Query failed'
    }
  }

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const fetchResults = useCallback(() => {
    void refetch()
  }, [refetch])

  return {
    results,
    loading: isLoading,
    error,
    hasMore: hasNextPage,
    loadingMore: isFetchingNextPage,
    pageTitles,
    handleLoadMore,
    fetchResults,
  }
}
