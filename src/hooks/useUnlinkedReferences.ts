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
 *    so there is no monotonic-key growth. #3316 item 2: that is NOT a reason to
 *    skip a bounded `gcTime` — `pageId` is in the key, so a session that visits
 *    N pages mints N entries. The hook now sets the same finite `gcTime` as
 *    `useBacklinkGroups`.
 *  - `totalCount`/`truncated` derive from the LAST page, not the first — the old
 *    component set BOTH unconditionally on every fetch (outside the cursor
 *    branch), unlike LinkedReferences' first-page-only rule.
 *
 * READ PATH ONLY — see `query-client.ts`. The client is passed EXPLICITLY as
 * the 2nd argument to `useInfiniteQuery` so no `QueryClientProvider` ancestor is
 * required (bare `renderHook` / `render` tests need no wrapper).
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useRef } from 'react'

import { unwrap } from '@/lib/app-error'
import type {
  BacklinkFilter,
  BacklinkGroup,
  BacklinkSort,
  GroupedBacklinkResponse,
} from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { paginationLimit } from '@/lib/safe-limit'
import { toSpaceScope } from '@/lib/space-scope'

/**
 * Groups requested per page once the panel is open. Unchanged from the value
 * this hook has always sent (`paginationLimit(20)`).
 */
const EXPANDED_GROUP_LIMIT = paginationLimit(20)
/**
 * #3316 item 2 — groups requested while the panel is collapsed. One, not zero:
 * the backend rejects a limit of 0, and the counts the panel needs
 * (`total_count` / `filtered_count`) are computed over the whole match set
 * before pagination, so a single group is enough to keep the header label and
 * the `return null` decision exact.
 */
const COLLAPSED_GROUP_LIMIT = paginationLimit(1)

export interface UseUnlinkedReferencesParams {
  pageId: string
  filters: BacklinkFilter[]
  sort: BacklinkSort | null
  spaceId: string | null
  /**
   * #3316 item 2 — whether the panel is currently collapsed. `UnlinkedReferences`
   * is mounted for EVERY page (PageEditor) and starts collapsed (and re-collapses
   * on every `pageId` change), so the full 20-group page was fetched on every
   * page open for a list nobody had opened. The panel still needs `totalCount`
   * to decide whether to render at all, and the backend computes
   * `total_count` / `filtered_count` over the WHOLE FTS match set *before*
   * pagination (`eval_unlinked_references` steps 5 and 7a in
   * `agaric-store/src/backlink/grouped.rs`), so a collapsed panel can ask for a
   * single group and still receive exact counts. That skips `sort_ids` +
   * `fetch_block_rows_by_ids` for 19 of the 20 groups — each up to
   * `MAX_BLOCKS_PER_GROUP = 200` rows — plus their JSON IPC serialization. The
   * FTS scan and root-page resolve are unavoidable (they produce the count).
   *
   * Part of the query key, so expanding the panel refetches with the full page.
   * Defaults to `false`, leaving any other caller on the full page.
   */
  collapsed?: boolean | undefined
}

export interface UseUnlinkedReferencesResult {
  groups: BacklinkGroup[]
  totalCount: number
  /**
   * #3316 item 1 — the POST-filter block count the backend already returns
   * next to `total_count` (`filtered_count`: the post-filter, post-grouping
   * sum in `eval_unlinked_references`). Previously dropped by this hook, which
   * forced the call site to pass `filteredCount={totalCount}` so the
   * "Showing N of M backlinks" line could never show two different numbers.
   * Derived from the LAST page, for the same reason `totalCount` is.
   */
  filteredCount: number
  truncated: boolean
  /** Initial load only (`isLoading`); load-more is surfaced via `isFetchingMore`. */
  loading: boolean
  hasMore: boolean
  isFetchingMore: boolean
  loadMore: () => void
  isError: boolean
  /** Re-run the current query. Drives the panel's error-state Retry (#3738 note 1). */
  refetch: () => void
  /**
   * The exact query key this hook reads from, exported so the component can
   * `queryClient.setQueryData(queryKey, …)` for the optimistic "Link it"
   * removal without re-deriving (and risking drift from) the key.
   */
  queryKey: unknown[]
  /**
   * `queryKey` MINUS the trailing `groupLimit` — i.e. every cache entry that
   * counts the SAME thing, whichever page size fetched it.
   *
   * #3738 note 8: the optimistic "Link it" removal used to rewrite only the
   * currently-keyed entry, so linking a mention while expanded left the
   * collapsed (limit-1) entry holding the pre-link count. Collapsing the panel
   * then re-keyed onto that entry and the header ticked 39 → 40 until the
   * refetch landed. Passed to `queryClient.setQueriesData`, which prefix-matches,
   * this updates every limit variant at once.
   */
  queryKeyPrefix: unknown[]
}

export function useUnlinkedReferences(
  params: UseUnlinkedReferencesParams,
): UseUnlinkedReferencesResult {
  const { pageId, filters, sort, spaceId, collapsed = false } = params

  // #3316 item 2: a collapsed panel only needs the counts, so ask for a single
  // group instead of the full 20-group page. See `collapsed` on the params type
  // for why the counts survive a smaller limit.
  const groupLimit = collapsed ? COLLAPSED_GROUP_LIMIT : EXPANDED_GROUP_LIMIT

  // Exported so the optimistic "Link it" removal can target this exact cache
  // entry. NOTE: unlike `useBacklinkGroups`, there is NO `invalidationKey`
  // here — the old `fetchGroups` never depended on `useBlockPropertyEvents`, so
  // the key is stable across property changes. `groupLimit` IS part of the key
  // so expanding the panel refetches the full page rather than showing the
  // single group the collapsed fetch returned.
  const queryKeyPrefix = useMemo(
    () => ['unlinkedReferences', spaceId, pageId, filters, sort],
    [spaceId, pageId, filters, sort],
  )
  const queryKey = useMemo(() => [...queryKeyPrefix, groupLimit], [queryKeyPrefix, groupLimit])

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, isError, refetch } =
    useInfiniteQuery(
      {
        queryKey,
        queryFn: async ({ pageParam }): Promise<GroupedBacklinkResponse> => {
          try {
            return unwrap(
              await commands.listUnlinkedReferences(
                pageId,
                filters.length > 0 ? filters : null,
                sort,
                pageParam ?? null,
                groupLimit,
                toSpaceScope(spaceId),
              ),
            )
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
        // #3316 item 2: override the client's `gcTime: Infinity` for THIS hook,
        // matching `useBacklinkGroups.ts` and `useSearchResults.ts`. The module
        // header used to argue no bound was needed because there is no
        // `invalidationKey` in the key — but `pageId` (and now `groupLimit`) are
        // in the key too, so a session that visits N pages mints N entries that
        // an infinite `gcTime` would never collect. `staleTime: Infinity` is
        // still inherited, so this changes nothing about refetch timing: only
        // the eviction of superseded, observer-less entries.
        gcTime: 5 * 60 * 1000,
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
  const lastPage = data?.pages.at(-1)

  // #3733 note 2 — the counts must SURVIVE the `groupLimit` re-key.
  //
  // `groupLimit` is part of the query key (deliberately: expanding must refetch
  // the full page). Expanding therefore switches the observer to a cache entry
  // that has no data yet, `data` is `undefined` for that render, and both counts
  // fell back to 0 — so `UnlinkedReferences` rendered "No Unlinked References"
  // over a panel it had just told the user held 12, then flipped back when the
  // limit-20 fetch resolved. The count was never unknown; only the key change
  // discarded it.
  //
  // The carry is deliberately narrower than `placeholderData: keepPreviousData`,
  // which would also carry data across a `pageId` / `filters` / `sort` change
  // and briefly show ANOTHER page's references. `countIdentity` is the query key
  // MINUS `groupLimit`, so the counts survive an expand/collapse toggle and
  // nothing else: any change to what is being counted drops the carry on the
  // spot. Only the counts are carried — `groups`, `loading` and `hasMore` still
  // report the real state of the new key, so the list itself still shows its
  // loading state rather than a stale single group.
  //
  // #3738 note 2 — `truncated` rides along. It is displayed immediately beside
  // the counts ("showing the first N of each group"), and leaving it out made
  // it flip true → false → true across an expand while the numbers next to it
  // held steady: the same "these two adjacent statements disagree" defect the
  // carry exists to remove.
  //
  // #3738 note 1 — the carry deliberately also survives a FAILED fetch (`data`
  // is `undefined` for an errored key exactly as it is for a pending one). The
  // count is not unknown just because the *next* page size could not be
  // fetched, and dropping it would make the whole panel disappear out from
  // under a user who had just clicked to expand it, leaving only a toast. What
  // the panel must NOT do is present the carried count over an empty-state that
  // claims there is nothing — `UnlinkedReferences` renders an explicit error +
  // Retry for that case instead.
  const countIdentity = useMemo(() => JSON.stringify(queryKeyPrefix), [queryKeyPrefix])
  // #4406 — `carriedRef` is written AND read within this same render (never
  // from an effect), matching the "ref written and read during the same
  // render" exception in docs/architecture/frontend.md § Latest-value
  // mirrors: moving the write into an effect would leave the very render
  // that needs the carried count reading a stale (pre-write) value one
  // commit late, defeating the whole point of the carry (see the #3733/#3738
  // notes above). #4406 promoted react(refs) to `error`; the reads and writes
  // below carry an explicit per-site disable rather than a restructuring,
  // because any restructuring that satisfies the rule here destroys the carry.
  // NOTE the #4469 compiler argument is deliberately NOT invoked here:
  // `vite.config.ts` runs babel over `.tsx`/`.jsx` only, so this `.ts` file is
  // never seen by the React Compiler and its findings carry no memoisation
  // consequence either way (docs/architecture/frontend.md § The hazard says so
  // explicitly). The justification is the carry's semantics, nothing else.
  const carriedRef = useRef<{
    identity: string
    total: number
    filtered: number
    truncated: boolean
  } | null>(null)
  if (lastPage) {
    // oxlint-disable-next-line react/refs -- `carriedRef` is written and read within this same render (docs/architecture/frontend.md § Latest-value mirrors' "different hazard" bucket, not a mirror candidate); an effect write would leave this very render reading a pre-write value one commit late; see #4406
    carriedRef.current = {
      identity: countIdentity,
      total: lastPage.total_count,
      filtered: lastPage.filtered_count,
      truncated: lastPage.truncated,
    }
    // oxlint-disable-next-line react/refs -- `carriedRef` is written and read within this same render (docs/architecture/frontend.md § Latest-value mirrors' "different hazard" bucket, not a mirror candidate); an effect write would leave this very render reading a pre-write value one commit late — this is the `else if` guard, reached only when `lastPage` is absent, so it reads the carry an EARLIER render wrote; see #4406
  } else if (carriedRef.current && carriedRef.current.identity !== countIdentity) {
    // oxlint-disable-next-line react/refs -- `carriedRef` is written and read within this same render (docs/architecture/frontend.md § Latest-value mirrors' "different hazard" bucket, not a mirror candidate); an effect write would leave this very render reading a pre-write value one commit late — clearing a carry whose identity no longer matches; see #4406
    carriedRef.current = null
  }
  // oxlint-disable-next-line react/refs -- `carriedRef` is written and read within this same render (docs/architecture/frontend.md § Latest-value mirrors' "different hazard" bucket, not a mirror candidate); an effect write would leave this very render reading a pre-write value one commit late — the read the whole carry exists for; see #4406
  const carried = carriedRef.current?.identity === countIdentity ? carriedRef.current : null

  const totalCount = lastPage?.total_count ?? carried?.total ?? 0
  // #3316 item 1: `filtered_count` follows the same last-page rule. Unlike the
  // linked-backlink path it is recomputed in full on EVERY page (it is derived
  // from the whole post-filter match set, not the paginated slice), so the last
  // page carries the same value as the first.
  const filteredCount = lastPage?.filtered_count ?? carried?.filtered ?? 0
  const truncated = lastPage?.truncated ?? carried?.truncated ?? false

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const retry = useCallback(() => {
    void refetch()
  }, [refetch])

  // oxlint-disable-next-line react/refs -- the returned counts are derived from the same-render `carriedRef` read above and carry its finding by construction; see #4406
  return {
    groups,
    totalCount,
    filteredCount,
    truncated,
    loading: isLoading,
    hasMore: hasNextPage,
    isFetchingMore: isFetchingNextPage,
    loadMore,
    isError,
    refetch: retry,
    queryKey,
    queryKeyPrefix,
  }
}
