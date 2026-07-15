/**
 * useUnlinkedReferences — grouped, paginated *unlinked*-reference reads backed
 * by TanStack `useInfiniteQuery` (#2597, surface 2, following the #2596 pilot).
 *
 * Extracts the hand-rolled `fetchGroups` cursor state machine that previously
 * lived in `UnlinkedReferences` (manual `useState` for groups/loading/nextCursor/
 * hasMore/totalCount/truncated plus an append-merge effect). TanStack now owns
 * the page list, cursor, loading and error state; this hook derives the merged
 * group list plus the per-fetch `total_count`/`truncated`.
 *
 * Sibling to `useBacklinkGroups` (LinkedReferences). The differences are
 * deliberate and called out inline:
 *  - NO `invalidationKey` in the query key (the old `fetchGroups` deps were
 *    `[pageId, filters, sort, t, currentSpaceId]` — no `useBlockPropertyEvents`),
 *    so there is no monotonic-key growth and no custom `gcTime` is needed.
 *  - `totalCount`/`truncated` derive from the LAST page, not the first — the old
 *    component set BOTH unconditionally on every fetch (outside the cursor
 *    branch), unlike LinkedReferences' first-page-only rule.
 *
 * READ PATH ONLY — see `query-client.ts`. The client is passed EXPLICITLY as
 * the 2nd argument to `useInfiniteQuery` so no `QueryClientProvider` ancestor is
 * required (bare `renderHook` / `render` tests need no wrapper).
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import type {
  BacklinkFilter,
  BacklinkGroup,
  BacklinkSort,
  GroupedBacklinkResponse,
} from '@/lib/tauri'
import { listUnlinkedReferences, paginationLimit } from '@/lib/tauri'

export interface UseUnlinkedReferencesParams {
  pageId: string
  filters: BacklinkFilter[]
  sort: BacklinkSort | null
  spaceId: string | null
}

export interface UseUnlinkedReferencesResult {
  groups: BacklinkGroup[]
  totalCount: number
  truncated: boolean
  /** Initial load only (`isLoading`); load-more is surfaced via `isFetchingMore`. */
  loading: boolean
  hasMore: boolean
  isFetchingMore: boolean
  loadMore: () => void
  isError: boolean
  /**
   * The exact query key this hook reads from, exported so the component can
   * `queryClient.setQueryData(queryKey, …)` for the optimistic "Link it"
   * removal without re-deriving (and risking drift from) the key.
   */
  queryKey: unknown[]
}

export function useUnlinkedReferences(
  params: UseUnlinkedReferencesParams,
): UseUnlinkedReferencesResult {
  const { pageId, filters, sort, spaceId } = params

  // Exported so the optimistic "Link it" removal can target this exact cache
  // entry. NOTE: unlike `useBacklinkGroups`, there is NO `invalidationKey`
  // here — the old `fetchGroups` never depended on `useBlockPropertyEvents`, so
  // the key is stable across property changes and needs no bounded `gcTime`.
  const queryKey = useMemo(
    () => ['unlinkedReferences', spaceId, pageId, filters, sort],
    [spaceId, pageId, filters, sort],
  )

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, isError } =
    useInfiniteQuery(
      {
        queryKey,
        queryFn: async ({ pageParam }): Promise<GroupedBacklinkResponse> => {
          try {
            return await listUnlinkedReferences({
              pageId,
              filters: filters.length > 0 ? filters : null,
              sort,
              cursor: pageParam ?? null,
              limit: paginationLimit(20),
              spaceId,
            })
          } catch (err) {
            // Preserve the pre-migration component's observability: it logged
            // every fetch failure before surfacing it. Log here, then rethrow
            // so TanStack captures it into `isError`.
            logger.error(
              'useUnlinkedReferences',
              'Failed to load unlinked references',
              { pageId },
              err,
            )
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
  // (#1529). Each page's `groups` is narrowed to an array first: some App-level
  // smoke tests stub a response WITHOUT `groups`, and the old code guarded this
  // with `Array.isArray(resp.groups) ? resp.groups : []`.
  const groups = useMemo<BacklinkGroup[]>(() => {
    const pages = data?.pages
    if (!pages || pages.length === 0) return []
    const byPageId = new Map<string, BacklinkGroup>()
    for (const page of pages) {
      const pageGroups = Array.isArray(page.groups) ? page.groups : []
      for (const group of pageGroups) {
        const existing = byPageId.get(group.page_id)
        byPageId.set(
          group.page_id,
          existing ? { ...existing, blocks: [...existing.blocks, ...group.blocks] } : group,
        )
      }
    }
    return Array.from(byPageId.values())
  }, [data])

  // `totalCount`/`truncated` derive from the LAST page. This deliberately
  // differs from `useBacklinkGroups`' first-page rule: the old `fetchGroups` set
  // BOTH unconditionally on EVERY fetch (`setTotalCount(resp.total_count)` /
  // `setTruncated(resp.truncated)` sit OUTSIDE the cursor branch), so the value
  // shown is always the most-recently-fetched page's — i.e. the last page.
  const totalCount = data?.pages.at(-1)?.total_count ?? 0
  const truncated = data?.pages.at(-1)?.truncated ?? false

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return {
    groups,
    totalCount,
    truncated,
    loading: isLoading,
    hasMore: hasNextPage,
    isFetchingMore: isFetchingNextPage,
    loadMore,
    isError,
    queryKey,
  }
}
