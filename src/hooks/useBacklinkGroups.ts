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
   * `invalidationKey` sat in `fetchGroups`'s deps to force a refetch.
   */
  invalidationKey: number
}

export interface UseBacklinkGroupsResult {
  groups: BacklinkGroup[]
  totalCount: number
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

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return {
    groups,
    totalCount,
    loading: isLoading,
    hasMore: hasNextPage,
    isFetchingMore: isFetchingNextPage,
    loadMore,
    isError,
  }
}
