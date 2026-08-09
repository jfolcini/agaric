/**
 * useBacklinkGroups — grouped, paginated backlink reads backed by TanStack
 * `useInfiniteQuery` (#2597, following the #2596 pilot).
 *
 * Extracts the hand-rolled `fetchGroups` cursor state machine that previously
 * lived in `LinkedReferences` (manual `useState` for groups/loading/nextCursor/
 * hasMore/totalCount plus an append-merge effect). TanStack now owns the page
 * list, cursor, loading and error state; this hook derives the merged group
 * list and the page-invariant total count from `data.pages`.
 *
 * READ PATH ONLY — see `query-client.ts`. The client is passed EXPLICITLY as
 * the 2nd argument to `useInfiniteQuery` so no `QueryClientProvider` ancestor is
 * required (bare `renderHook` / `render` tests need no wrapper).
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import type {
  BacklinkFilter,
  BacklinkGroup,
  BacklinkSort,
  GroupedBacklinkResponse,
} from '@/lib/tauri'
import { listBacklinksGrouped } from '@/lib/tauri'

export interface UseBacklinkGroupsParams {
  pageId: string
  filters: BacklinkFilter[]
  sort: BacklinkSort | null
  sourcePageIncluded: string[]
  sourcePageExcluded: string[]
  spaceId: string | null
  /**
   * Monotonic counter from `useBlockPropertyEvents`. Embedded in the query key
   * so a `block:properties-changed` event (bumping the key) starts a fresh
   * query and refetches — reproducing the old component's F-39 behaviour where
   * `invalidationKey` sat in `fetchGroups`'s deps to force a refetch. Paired
   * with a finite `gcTime` (below) so the per-bump key churn stays bounded.
   */
  invalidationKey: number
}

export interface UseBacklinkGroupsResult {
  groups: BacklinkGroup[]
  totalCount: number
  /**
   * #3316 item 1 — the POST-filter `COUNT(DISTINCT bl.source_id)` the backend
   * already returns next to `total_count`. It equals `totalCount` when no
   * filter is active (the backend reuses the pre-filter count in that case),
   * so "Showing N of M backlinks" only diverges once a filter narrows the set.
   * This was previously dropped, forcing the call site to pass
   * `filteredCount={totalCount}` and making that line self-identical forever.
   *
   * Read from the FIRST page for the same reason `totalCount` is: the backend
   * only computes both counts on the first page and returns `0` for them on
   * every subsequent page (`is_first_page` in
   * `agaric-store/src/backlink/grouped.rs`).
   */
  filteredCount: number
  /** Initial load only (`isLoading`); load-more is surfaced via `isFetchingMore`. */
  loading: boolean
  hasMore: boolean
  isFetchingMore: boolean
  loadMore: () => void
  isError: boolean
}

export function useBacklinkGroups(params: UseBacklinkGroupsParams): UseBacklinkGroupsResult {
  const {
    pageId,
    filters,
    sort,
    sourcePageIncluded,
    sourcePageExcluded,
    spaceId,
    invalidationKey,
  } = params

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, isError } =
    useInfiniteQuery(
      {
        // TanStack hashes query keys deterministically, so passing the
        // arrays/objects directly is fine. `invalidationKey` reproduces the
        // "refetch when block properties change" behaviour (F-39).
        queryKey: [
          'backlinkGroups',
          spaceId,
          pageId,
          invalidationKey,
          filters,
          sort,
          sourcePageIncluded,
          sourcePageExcluded,
        ],
        queryFn: async ({ pageParam }): Promise<GroupedBacklinkResponse> => {
          try {
            // Build combined filters: advanced filters + source page filter.
            const allFilters = [...filters]
            if (sourcePageIncluded.length > 0 || sourcePageExcluded.length > 0) {
              allFilters.push({
                type: 'SourcePage',
                included: sourcePageIncluded,
                excluded: sourcePageExcluded,
              })
            }
            return await listBacklinksGrouped({
              blockId: pageId,
              ...(allFilters.length > 0 && { filters: allFilters }),
              ...(sort != null && { sort }),
              limit: PAGINATION_LIMIT,
              ...(pageParam != null && { cursor: pageParam }),
              spaceId,
            })
          } catch (err) {
            // Preserve the pre-migration component's observability: it logged
            // every fetch failure before surfacing it. Log here, then rethrow
            // so TanStack captures it into `isError`.
            logger.error('useBacklinkGroups', 'Failed to load grouped backlinks', { pageId }, err)
            throw err
          }
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor : undefined),
        // The old component refetched on every mount via its load effect. Keep
        // the client's `staleTime: Infinity` (no time-based refetch) but force a
        // fresh fetch whenever the panel mounts.
        refetchOnMount: 'always',
        // Override the client's `gcTime: Infinity` for THIS hook. Because the
        // monotonic `invalidationKey` is part of the query key, every property
        // change mints a new key; under an infinite gcTime those superseded
        // entries (now observer-less) would never be collected and accumulate
        // unbounded over a long session. A finite gcTime bounds that: the
        // ACTIVE query (current `invalidationKey`) always has an observer while
        // the panel is mounted and is never collected, but each prior key's
        // entry is evicted 5 min after it goes inactive. `staleTime: Infinity`
        // is still inherited, so this changes nothing about refetch timing.
        gcTime: 5 * 60 * 1000,
      },
      queryClient,
    )

  // Merge groups across pages BY `page_id`, preserving first-appearance order
  // and appending `blocks` for a repeated `page_id`. `Map.set` on an existing
  // key does NOT change iteration order, so `Array.from(map.values())` keeps the
  // first-appearance order. A fresh `{ ...existing, blocks: [...] }` object is
  // constructed on merge — the prior page's group object is never mutated
  // (#1529).
  const groups = useMemo<BacklinkGroup[]>(() => {
    const pages = data?.pages
    if (!pages || pages.length === 0) return []
    if (pages.length === 1) return pages[0]?.groups ?? []
    const byPageId = new Map<string, BacklinkGroup>()
    for (const page of pages) {
      for (const group of page.groups) {
        const existing = byPageId.get(group.page_id)
        byPageId.set(
          group.page_id,
          existing ? { ...existing, blocks: [...existing.blocks, ...group.blocks] } : group,
        )
      }
    }
    return Array.from(byPageId.values())
  }, [data])

  // #2201 item 1b: the "N references" header total is page-invariant. The
  // backend returns `total_count: 0` on non-first pages by design, so read it
  // from the FIRST page only.
  const totalCount = data?.pages[0]?.total_count ?? 0
  // #3316 item 1: same first-page rule as `totalCount` above — the backend
  // zeroes BOTH counts on non-first pages.
  const filteredCount = data?.pages[0]?.filtered_count ?? 0

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return {
    groups,
    totalCount,
    filteredCount,
    loading: isLoading,
    hasMore: hasNextPage,
    isFetchingMore: isFetchingNextPage,
    loadMore,
    isError,
  }
}
