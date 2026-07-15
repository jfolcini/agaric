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
 * summary. Backed by TanStack `useInfiniteQuery` (#2597, following the #2596
 * pilot): TanStack owns the keyset cursor, the page list, loading/error state,
 * and the latest-wins race-guard (the `queryKey` embeds every structural input,
 * so a slow older fetch settles into its OWN now-inactive cache entry and can't
 * clobber the newer query). Parent-page titles for the results (flat rows +
 * grouped members) are resolved per page inside the `queryFn` and merged from
 * `data.pages` on render — modelled on `useQueryExecution` / `useBacklinkGroups`.
 * The client is passed EXPLICITLY (2nd arg) so no `QueryClientProvider` ancestor
 * is required (see `query-client.ts`).
 */

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
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
  const resolved = await batchResolve([...new Set(allIds)], 'global')
  const titleMap = new Map<string, string>()
  for (const r of resolved) {
    if (r.title) titleMap.set(r.id, r.title)
  }
  return titleMap
}

/**
 * The live structural inputs the `queryFn` reads (from its render closure) to
 * assemble a wire request. Mirrors `UseAdvancedQueryOptions`' structural fields
 * but with explicit `undefined` for `exactOptionalPropertyTypes`.
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

/** One resolved page of advanced-query results plus its own parent-page titles.
 *  Folding titles INTO each page (rather than a separate merge step) lets
 *  TanStack own the page list — the merged `pageTitles` map, the flat rows /
 *  merged groups, the first-page aggregates and the total count are all derived
 *  from `data.pages` on render. In FLAT mode `groups` is `null` and `rows` holds
 *  the page; in GROUPED mode `rows` is empty and `groups` holds the buckets. */
interface AdvancedQueryPage {
  rows: BlockRow[]
  groups: QueryGroup[] | null
  nextCursor: string | null
  hasMore: boolean
  totalCount: number | null
  aggregates: AggregateResult[] | null
  titles: Map<string, string>
}

export function useAdvancedQuery(options: UseAdvancedQueryOptions): UseAdvancedQueryResult {
  const { filters, filterExpr, fulltext, sort, groupBy, aggregates } = options
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)

  // Serialise every structural input into a value-stable key (the parent churns
  // array/object identity every render). These keys form the `queryKey`, so a
  // change to any of them mints a fresh query — and, because a slow older fetch
  // settles into its own now-inactive cache entry, they ALSO give us the
  // latest-wins race-guard the old `reqIdRef` provided for free.
  const filtersKey = JSON.stringify(filters)
  // #1280 D3 — serialise the optional pre-compiled boolean tree the same way so
  // the query re-runs whenever the builder tree changes. `undefined` (the
  // flat-`filters` callers) yields a stable `'null'` key, so those callers keep
  // the legacy path and never churn on this dep.
  const filterExprKey = JSON.stringify(filterExpr ?? null)
  // Normalise the full-text term once: trim, and treat empty as absent so we
  // omit `fulltext` rather than sending `''` (the engine treats `Some("")` as a
  // full-text query with no terms).
  const trimmedFulltext = (fulltext ?? '').trim()
  const sortKey = JSON.stringify(sort ?? [])
  const groupByKey = JSON.stringify(groupBy ?? null)
  const aggregatesKey = JSON.stringify(aggregates ?? [])

  const {
    data,
    error: queryError,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery(
    {
      // The serialised `*Key` strings are the change-detector: value-stable
      // across the parent's churning identities, so the query re-runs exactly
      // when a structural input changes.
      queryKey: [
        'advancedQuery',
        currentSpaceId,
        filtersKey,
        filterExprKey,
        trimmedFulltext,
        sortKey,
        groupByKey,
        aggregatesKey,
      ],
      queryFn: async ({ pageParam }): Promise<AdvancedQueryPage> => {
        try {
          // Assemble the wire request from the LIVE inputs (captured by this
          // render's closure — the `queryKey` guarantees a fresh closure per
          // input change). `parsedGroupBy` is returned separately because the
          // post-response branching keys off it.
          const { request, groupBy: parsedGroupBy } = buildQueryArgs(
            { filters, filterExpr, sort, groupBy, aggregates },
            currentSpaceId,
            trimmedFulltext,
            pageParam,
          )
          const response = await runAdvancedQuery(request)

          // GROUPED mode: the engine returns `groups` (and leaves `rows`
          // empty), paginating over groups via the same cursor. Resolve the
          // parent-page titles of every previewed member so the member rows
          // render links.
          if (parsedGroupBy != null) {
            const pageGroups = response.groups ?? []
            const memberRows = pageGroups.flatMap((g) => g.members as unknown as BlockRow[])
            // For Tag/Page grouping the bucket key is a raw block id (a tag's /
            // page's block id), not a human label — fold those keys into the
            // same `batchResolve` so the header renders the resolved title
            // (#1447). Other dimensions' keys are already display-ready;
            // `"none"` is the NULL bucket and has no id to resolve.
            const groupKeyType = parsedGroupBy.key.type
            const groupKeyIds =
              groupKeyType === 'Tag' || groupKeyType === 'Page'
                ? pageGroups.map((g) => g.key).filter((k) => k !== 'none')
                : []
            const titles = await resolvePageTitles(memberRows, groupKeyIds)
            return {
              rows: [],
              groups: pageGroups,
              nextCursor: response.nextCursor,
              hasMore: response.hasMore,
              totalCount: response.totalCount,
              aggregates: response.aggregates ?? null,
              titles,
            }
          }

          // FLAT mode. `QueryResultRow` is `{ score } & ActiveBlockRow` —
          // wire-compatible with `BlockRow` (identical 12 columns), so render
          // the rows directly.
          const items = response.rows as unknown as BlockRow[]
          const titles = await resolvePageTitles(items)
          return {
            rows: items,
            groups: null,
            nextCursor: response.nextCursor,
            hasMore: response.hasMore,
            totalCount: response.totalCount,
            aggregates: response.aggregates ?? null,
            titles,
          }
        } catch (e) {
          // Preserve the pre-migration hook's observability: it logged every
          // fetch failure via `logger.warn` before surfacing the error. Log
          // here, then rethrow so TanStack captures it into `error`.
          logger.warn('useAdvancedQuery', 'advanced query failed', { filtersKey }, e)
          throw e
        }
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) =>
        lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
      // The hand-rolled hook kept the PRIOR results/groups mounted (dimmed +
      // aria-busy) while an input-change refetch was in flight — `setResults`
      // only overwrote on success. Reproduce that: `keepPreviousData` serves the
      // previous key's `data` as placeholder until the new key resolves, so the
      // results pane never blanks to a spinner on a builder/sort/group edit.
      placeholderData: keepPreviousData,
      // Behaviour parity (load-bearing): the old fetch effect re-ran on EVERY
      // input change unconditionally — including returning to a filter that was
      // run earlier — always hitting the engine afresh. Override the singleton's
      // `staleTime: Infinity` with `0` so switching the `queryKey` back to a
      // previously-cached filter still refetches (served from cache instantly,
      // then refreshed) rather than silently serving the stale cached page.
      staleTime: 0,
      // The hand-rolled hook re-ran `fetchResults()` in a mount effect on every
      // mount — it never served stale data from a prior mount. Force a fresh
      // fetch whenever the surface mounts. In-flight fetches for the same key
      // are still deduped.
      refetchOnMount: 'always',
    },
    queryClient,
  )

  // FLAT rows accumulated across pages (empty in grouped mode, where each page
  // carries `rows: []`).
  const results = useMemo<BlockRow[]>(() => data?.pages.flatMap((p) => p.rows) ?? [], [data])

  // GROUPED buckets accumulated across pages, or `null` in flat mode. The old
  // code appended groups verbatim (no merge-by-key), so concatenate the pages'
  // group lists in order. `null` when there are no pages yet OR the first page
  // is flat.
  const groups = useMemo<QueryGroup[] | null>(() => {
    const pages = data?.pages
    if (!pages || pages.length === 0 || pages[0]?.groups == null) return null
    return pages.flatMap((p) => p.groups ?? [])
  }, [data])

  // Merge every page's titles into ONE map, spreading later pages LAST so fresh
  // titles overwrite stale entries (append semantics — a fresh fetch resets
  // `data.pages`, so this collapses to the first page's titles). Memoised so
  // identity stays stable when `data` is unchanged.
  const pageTitles = useMemo(() => {
    const merged = new Map<string, string>()
    for (const page of data?.pages ?? []) {
      for (const [id, title] of page.titles) merged.set(id, title)
    }
    return merged
  }, [data])

  // totalCount + global aggregates are computed over the FULL match set on the
  // FIRST page only (invariant across cursor pages; later pages return
  // `totalCount: null`), so derive both from `data.pages[0]` — later pages can
  // never clobber them.
  const totalCount = data?.pages[0]?.totalCount ?? null
  const aggregateResults = data?.pages[0]?.aggregates ?? null

  // Only LOAD-MORE failures are suppressed (they shouldn't clobber the page the
  // user is already viewing); an initial or input-change page-1 failure IS
  // surfaced — mirrors the old `if (!isLoadMore) setError(...)`. With
  // `keepPreviousData` retaining prior pages, "no pages yet" is no longer a
  // reliable initial-load signal, so key off `isFetchNextPageError` instead.
  let error: string | null = null
  if (queryError != null && !isFetchNextPageError) {
    error = queryError instanceof Error ? queryError.message : 'Query failed'
  }

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const fetchResults = useCallback(() => {
    void refetch()
  }, [refetch])

  return {
    results,
    groups,
    aggregates: aggregateResults,
    // `loading` = a PAGE-1 fetch is in flight (initial load, input-change
    // refetch, or explicit retry) — NOT a load-more, which is surfaced via
    // `loadingMore`. Mirrors the old `setLoading(true)` on every non-loadMore
    // fetch. `isLoading` alone is wrong here: with `keepPreviousData` it stays
    // false during an input-change refetch (placeholder data present), so the
    // "keep prior results dimmed + aria-busy while refetching" UX would break.
    loading: isFetching && !isFetchingNextPage,
    error,
    hasMore: hasNextPage,
    loadingMore: isFetchingNextPage,
    totalCount,
    pageTitles,
    handleLoadMore,
    fetchResults,
  }
}
