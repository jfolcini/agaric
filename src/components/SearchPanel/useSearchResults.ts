/**
 * useSearchResults — the SearchPanel results pipeline.
 *
 * FE-A18 (continues) — extracted from the SearchPanel
 * god-component. Owns the AST→IPC projection, the paginated `searchBlocks`
 * query, the inline regex-error derive, breadcrumb (page-title)
 * resolution, page grouping + collapse state, the roving keyboard-nav
 * model, and result/recent-page navigation. Behaviour-preserving lift:
 * every memo/effect dependency array and the comments that justify them
 * are unchanged from the inline version.
 */
import { type InfiniteData, keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import type React from 'react'
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { isAppError, isCancellation, type TypedAppError, validationCode } from '@/lib/app-error'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { INTERACTIONS, traceInteraction } from '@/lib/observability'
import { queryClient } from '@/lib/query-client'
import { reportIpcError } from '@/lib/report-ipc-error'
import { astToFilterProjection, type SearchQueryAST } from '@/lib/search-query'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import type { BlockRow, PageResponse, SearchBlockRow } from '@/lib/tauri'
import { batchResolve, getBlock, searchBlocks } from '@/lib/tauri'
import {
  type RecentPage,
  selectRecentPagesForSpace,
  toRecentPage,
  useRecentPagesStore,
} from '@/stores/recent-pages'
import { useTabsStore } from '@/stores/tabs'

import { groupResultsByPage, type SearchResultGroup } from '../search/SearchResultGroups'
import type { SearchToggleState } from '../search/SearchToggleRow'
import { astFilterParams } from './searchFilterParams'
import { useTagResolution } from './useTagResolution'

/**
 * The accumulated-results ceiling, matching the retired `usePaginatedQuery`'s
 * default `maxItems`. See the capped derive below for the reproduced semantics.
 */
const MAX_ITEMS = 5000

export interface UseSearchResultsOptions {
  /** The debounced query parsed to an AST (free text + structural filters). */
  debouncedAst: SearchQueryAST
  /** The debounced query string — drives the collapse / focus reset keys. */
  debouncedQuery: string
  currentSpaceId: string | null
  spaceIsReady: boolean
  toggles: SearchToggleState
}

export interface UseSearchResultsValue {
  results: SearchBlockRow[]
  searchLoading: boolean
  hasMore: boolean
  loadMore: () => void
  /** Re-fire the current query from page 1 (error-recovery affordance, #2059). */
  reload: () => void
  error: string | null
  capped: boolean
  setItems: Dispatch<SetStateAction<SearchBlockRow[]>>
  regexError: string | null
  groups: SearchResultGroup[]
  visibleRows: SearchBlockRow[]
  focusedIndex: number
  handleListKeyDown: (e: React.KeyboardEvent | KeyboardEvent) => boolean
  expandedGroups: Record<string, boolean>
  handleToggleGroup: (pageId: string) => void
  handleResultClick: (block: BlockRow | SearchBlockRow) => Promise<void>
  loadingResultId: string | null
  recentPages: RecentPage[]
  handleRecentClick: (page: RecentPage) => void
}

export function useSearchResults({
  debouncedAst,
  debouncedQuery,
  currentSpaceId,
  spaceIsReady,
  toggles,
}: UseSearchResultsOptions): UseSearchResultsValue {
  const { t } = useTranslation()
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  // #1149 — recent pages now come from the reactive zustand store (single
  // source of truth, shared with QuickAccessBar/CommandPalette). The
  // mount-time `getRecentPages()` localStorage seed is gone: the selector
  // re-renders on every `addRecentPage` so the list is always live.
  const addRecentPage = useRecentPagesStore((s) => s.addRecentPage)
  const recentPageRefs = useRecentPagesStore((s) => selectRecentPagesForSpace(s, currentSpaceId))
  const recentPages: RecentPage[] = recentPageRefs.map(toRecentPage)

  const [loadingResultId, setLoadingResultId] = useState<string | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  const debouncedProjection = useMemo(() => astToFilterProjection(debouncedAst), [debouncedAst])
  // Tag name→id resolution (prefix lookup; space-scoped cache
  // invalidation lives in the hook). #717 — `pending` gates the query below
  // so the first debounced search can't fire before resolution settles and
  // flash unfiltered results; a settled-but-unresolved name makes
  // `astFilterParams` project the matches-nothing sentinel.
  const { tagIds, pending: tagResolutionPending } = useTagResolution(
    debouncedProjection.tagNames,
    currentSpaceId,
  )

  // The two search modes are symmetric. In BOTH modes the
  // structural filters are projected and applied as SQL filters server-side;
  // the only difference is the `isRegex` flag and how the backend interprets
  // the free-text remainder.
  const filterParams = useMemo(
    () => astFilterParams(debouncedProjection, tagIds),
    [debouncedProjection, tagIds],
  )
  // #2634 — migrated off `usePaginatedQuery` onto TanStack `useInfiniteQuery`
  // directly (staged retirement of the generic hook; matching the merged
  // `DonePanel` / `TagFilterPanel` / `usePageBrowserData` pattern). The query key
  // carries every input the old `queryFn` `useCallback` closed over (space / free
  // text / the projected `filterParams` bundle / the three toggles), so a real
  // input change is a fresh query — reproducing the old request-id guard: a late
  // load-more response for a superseded query lands in that key's (now
  // observer-less) cache entry instead of being grafted onto the new list.
  //
  // EVENT-DRIVEN LIVE-REFRESH (the deliberate #2634 search decision) — the
  // module-level, debounced `invalidationKey` (bumped on every
  // `block:properties-changed` Tauri event) is folded into the key. This REPLACES
  // `usePaginatedQuery`'s implicit refetch-on-deps-change model with EVENT-DRIVEN
  // invalidation: a block-property mutation mints a new key and re-runs the
  // visible search against the mutated data, so results stay live. In jsdom the
  // hook returns 0, so the key is stable under test. `hashKey` deep-hashes the
  // `filterParams` object deterministically, so a filter edit mints a distinct
  // key just as the old deps-change re-fetch did.
  //
  // Tradeoff (accepted): because a bump mints a NEW key, a refresh restarts from
  // `initialPageParam` (page 1), so a session that had paged deep via "Load more"
  // collapses back to the first page on the next property change anywhere in the
  // workspace (`keepPreviousData` masks the collapse until the page-1 refetch
  // resolves). The alternative — a stable key + an `invalidateQueries` effect that
  // refetches all loaded pages in place — preserves depth but re-runs N backend
  // search scans per bump; for a potentially expensive full-text scan the page-1
  // reset is the cheaper, and freshness (not scroll depth) is the point of the
  // live-refresh. Tracked as a follow-up if deep-scroll preservation is wanted.
  const { invalidationKey } = useBlockPropertyEvents()
  const queryKey = useMemo(
    () =>
      [
        'searchBlocks',
        currentSpaceId,
        debouncedAst.freeText,
        filterParams,
        toggles.caseSensitive,
        toggles.wholeWord,
        toggles.isRegex,
        invalidationKey,
      ] as const,
    [
      currentSpaceId,
      debouncedAst.freeText,
      filterParams,
      toggles.caseSensitive,
      toggles.wholeWord,
      toggles.isRegex,
      invalidationKey,
    ],
  )
  // Held in a ref too so the stable `setItems` setter can target this exact cache
  // entry without re-deriving the key (mirrors usePageBrowserData / TrashView).
  const queryKeyRef = useRef(queryKey)
  queryKeyRef.current = queryKey

  // NEW-3 — fire when there is a free-text pattern OR at least one structural
  // filter (filter-only search). #717 — HOLD while tag name→id resolution is in
  // flight: firing now would send the query without the tag constraint (a
  // transient unfiltered flash, replaced when resolution settles). Doubles as the
  // `hasQuery`-style guard for the disabled-clear derive below.
  const queryEnabled =
    spaceIsReady &&
    currentSpaceId != null &&
    !tagResolutionPending &&
    (debouncedAst.freeText.length > 0 || debouncedAst.filters.length > 0)

  const {
    data,
    isFetching,
    isError,
    error: rawError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(
    {
      queryKey,
      // #2110 (M4) — trace the search interaction. `searchBlocks` is dispatched
      // synchronously inside the callback, so the invoke patch parents the backend
      // command span under this span. Attributes are opaque booleans — never the
      // query text. `is_paged` distinguishes first-page from loadMore.
      queryFn: async ({ pageParam, signal }): Promise<PageResponse<SearchBlockRow>> =>
        traceInteraction(
          INTERACTIONS.SEARCH,
          () =>
            // #2248 c — `searchBlocks` is space-scoped and rejects an empty space
            // (`requireActiveScope` throws). The `enabled` guard holds the query
            // until `currentSpaceId != null`, so the `?? ''` fallback is only a
            // type-level defensive default that can never be reached — a null space
            // means "don't search" (query stays disabled), not "match nothing".
            //
            // FORWARD the AbortSignal (search-cancellation parity): TanStack aborts
            // a superseded fetch's `signal` on a key change, so `searchBlocks` stops
            // waiting on its backend scan instead of running it to completion.
            searchBlocks(
              {
                query: debouncedAst.freeText,
                ...filterParams,
                cursor: pageParam,
                limit: PAGINATION_LIMIT,
                spaceId: currentSpaceId ?? '',
                caseSensitive: toggles.caseSensitive,
                wholeWord: toggles.wholeWord,
                isRegex: toggles.isRegex,
              },
              signal,
            ),
          {
            is_regex: toggles.isRegex,
            case_sensitive: toggles.caseSensitive,
            whole_word: toggles.wholeWord,
            is_paged: pageParam != null,
          },
        ),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) =>
        last.has_more && last.next_cursor != null ? last.next_cursor : undefined,
      enabled: queryEnabled,
      // Stale-while-revalidate parity: usePaginatedQuery never blanked `items` on a
      // deps change (only a successful response overwrote them). With the fetch
      // inputs now in the key — and `invalidationKey` minting a fresh key on every
      // block-property change — a bump would switch to a fresh empty entry and flash
      // a skeleton mid-search; `keepPreviousData` retains the prior key's pages
      // until the new fetch resolves (per-key cache writes unchanged, so the
      // stale-guard still holds). The `!queryEnabled` derive below reproduces the
      // old `setItems([])` clear so a retained placeholder can't survive an emptied
      // query (same guard TagFilterPanel uses).
      placeholderData: keepPreviousData,
      // usePaginatedQuery re-fetched page 1 on every mount; preserve that.
      refetchOnMount: 'always',
      // `invalidationKey` mints a new key on every block-property change; under the
      // client's `gcTime: Infinity` those superseded, observer-less entries would
      // accumulate unbounded over a session. Bound the churn (mirrors DonePanel):
      // the active key keeps an observer while mounted and is never collected; each
      // prior key is evicted 5 min after going inactive.
      gcTime: 5 * 60 * 1000,
    },
    queryClient,
  )

  // Flatten the accumulated pages. The `!queryEnabled` guard reproduces the old
  // explicit `setItems([])` clear: `keepPreviousData` would otherwise retain the
  // last query's pages as a placeholder after the input empties, so derive `[]`
  // directly when the query is inactive (same guard TagFilterPanel uses).
  const results = useMemo<SearchBlockRow[]>(
    () => (queryEnabled ? (data?.pages.flatMap((p) => p.items) ?? []) : []),
    [queryEnabled, data],
  )
  // usePaginatedQuery's `loading` was true during ANY in-flight fetch (initial AND
  // load-more), driving the skeleton and the LoadMoreButton busy state alike —
  // `isFetching` reproduces that (`isLoading` would be false during load-more).
  //
  // #717 — the base signal is `isFetching`, but it is OR'd with
  // `tagResolutionPending` to keep the busy state continuous across the
  // tag-resolution→search handoff. The query is HELD (disabled) until tag name→id
  // resolution settles, so `isFetching` is false during that window; on its own it
  // would let the pipeline report "not loading, zero results" between submit and
  // the search firing, surfacing a transient "No results" frame that then flickers
  // back to "Searching…" the instant the query enables. usePaginatedQuery hid this
  // behind a state-batching quirk (`loading` never committed for the fast fetch);
  // folding the pending flag in reproduces that stable, single-transition busy
  // signal, so the empty state appears exactly once — after the search settles.
  const searchLoading = tagResolutionPending || isFetching

  // CAPPED (maxItems=5000) — usePaginatedQuery stopped accumulating once the set
  // would exceed 5000, set `capped`, and killed pagination (no further `loadMore`).
  // We reproduce that by GATING `loadMore` / `hasMore` on `flat.length < MAX_ITEMS`:
  // once the flattened set reaches the cap with more pages available, no further
  // page is fetched and `capped` latches true.
  //
  // Note the shape differs subtly from the old hook at an uneven page boundary: the
  // old hook REFUSED the overflowing page (held at the pre-overflow count), whereas
  // here the page that crosses 5000 is already appended before the gate closes, so
  // the set can OVERSHOOT the cap by up to one page. In production this is exact —
  // `PAGINATION_LIMIT` (50) divides `MAX_ITEMS` (5000) evenly, so the accumulation
  // lands on 5000 precisely — and either way the observable outcome (stop loading
  // near 5000, show the cap notice) is identical. The arithmetic is pinned by
  // `useSearchResults.capped.test.ts` (the retired `usePaginatedQuery.test.ts`
  // covered the OLD hook's different implementation).
  const hasMore = queryEnabled && hasNextPage && results.length < MAX_ITEMS
  const capped = hasNextPage && results.length >= MAX_ITEMS

  // #2251 — the raw structured IPC `AppError` behind a failure, or null; `regexError`
  // below discriminates its `InvalidRegex` validation code. Mirrors the old hook's
  // `errorDetail`.
  const errorDetail: TypedAppError | null = isError && isAppError(rawError) ? rawError : null
  // Display error string — reproduces the old `deriveErrorState` with `onError`
  // undefined AND swallowing cancellations: a cancelled request surfaces NO error
  // (returns null), otherwise the message is read off the `Error` / `AppError`
  // shape. TanStack already drops a fetch aborted by a key change, but a backend
  // `{ kind: 'cancelled' }` AppError that resolves into `error` must still be
  // filtered here.
  const error: string | null =
    isError && !isCancellation(rawError)
      ? rawError instanceof Error
        ? rawError.message
        : (errorDetail?.message ?? 'Request failed')
      : null

  const loadMore = useCallback(() => {
    // Match the cap: never fetch once the flattened set has reached MAX_ITEMS.
    if (hasNextPage && !isFetchingNextPage && results.length < MAX_ITEMS) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, results.length])

  // #2059 — re-fire the current query from page 1 (the error-recovery affordance).
  const reload = useCallback(() => {
    void refetch()
  }, [refetch])

  // SearchPanel still calls `setItems([])` to clear results when the input is
  // emptied. Reproduce the old direct setter as a `queryClient.setQueryData`
  // wrapper on the CURRENT key (read from a ref for stable identity, mirroring
  // usePageBrowserData / TrashView). Its visible clear is ALSO covered by the
  // `!queryEnabled` derive above, but the export is kept so the SearchPanel call
  // site stays byte-for-byte unchanged. An empty next set collapses to a single
  // empty page with pagination killed (the `[]` clear); a non-empty set carries
  // the last page's pagination so `loadMore` still resolves the next cursor.
  const setItems = useCallback<Dispatch<SetStateAction<SearchBlockRow[]>>>((action) => {
    queryClient.setQueryData<InfiniteData<PageResponse<SearchBlockRow>>>(
      queryKeyRef.current,
      (prev) => {
        const prevItems = prev?.pages.flatMap((p) => p.items) ?? []
        const nextItems =
          typeof action === 'function'
            ? (action as (p: SearchBlockRow[]) => SearchBlockRow[])(prevItems)
            : action
        const last = prev?.pages.at(-1)
        const pagination =
          nextItems.length === 0
            ? { next_cursor: null, has_more: false, total_count: null }
            : {
                next_cursor: last?.next_cursor ?? null,
                has_more: last?.has_more ?? false,
                total_count: last?.total_count ?? null,
              }
        return { pages: [{ items: nextItems, ...pagination }], pageParams: [undefined] }
      },
    )
  }, [])

  // #2251 — discriminate the structured `InvalidRegex` validation code off
  // the raw IPC error (`{ kind: 'validation', code: 'InvalidRegex' }`) and
  // surface its human reason inline. Derived synchronously (not via an
  // effect) so the status region's generic-error suppression is single-commit.
  const regexError = useMemo<string | null>(() => {
    // The inline regex alert is regex-mode-only. In
    // case-sensitive / whole-word mode the backend builds a *literal* match
    // regex internally; an oversized literal makes `build_regex` reject with
    // an `InvalidRegex`-coded error. Surfacing that as "invalid regex" to a
    // user who never enabled regex is misleading — fall through to the generic
    // error state instead by short-circuiting here.
    if (!toggles.isRegex) return null
    if (errorDetail == null) return null
    if (validationCode(errorDetail) !== ValidationCode.InvalidRegex) return null
    // Coded validation errors carry the bare human reason in `message`
    // (no display decoration, no machine prefix — see error.rs #2251).
    return t('search.invalidRegex', { message: errorDetail.message })
  }, [errorDetail, t, toggles.isRegex])

  // Issue #153 — every page_id ever fed into `batchResolve` for
  // breadcrumb resolution, regardless of outcome. The breadcrumb
  // `useEffect` below consults this ref before assembling the next
  // batch, so a permanently-unresolvable id (soft-deleted parent,
  // missing page) costs exactly one IPC for the life of the hook.
  const attemptedBreadcrumbIdsRef = useRef<Set<string>>(new Set<string>())

  // Resolve page titles for breadcrumbs when results change.
  //
  // Issue #153 — unresolvable page_ids (soft-deleted, missing) never
  // land in `pageTitles`, so without `attemptedBreadcrumbIdsRef` the
  // `!pageTitles.has(id)` filter below would re-fire `batchResolve` for
  // them on every `loadMore`.
  useEffect(() => {
    // Only resolve page ids we haven't already resolved or
    // already attempted (#153).
    const parentIds = [
      ...new Set(results.map((b) => b.page_id).filter((id): id is string => id != null)),
    ].filter((id) => !pageTitles.has(id) && !attemptedBreadcrumbIdsRef.current.has(id))
    if (parentIds.length === 0) return
    // Record the attempt up front so a rejected promise (or a resolved
    // result that omits some ids) cannot cause a re-fire on the next
    // `loadMore`.
    for (const id of parentIds) attemptedBreadcrumbIdsRef.current.add(id)
    batchResolve(parentIds, 'global')
      .then((resolved) => {
        if (Array.isArray(resolved)) {
          setPageTitles((prev) => {
            // Phase 4.P2 — stabilise Map identity so the
            // `groupResultsByPage` memo doesn't invalidate on every
            // batchResolve fetch. Only allocate a new Map if a title changed.
            let changed = false
            for (const r of resolved) {
              const nextTitle = r.title ?? t('common.untitled')
              if (prev.get(r.id) !== nextTitle) {
                changed = true
                break
              }
            }
            if (!changed) return prev
            const next = new Map(prev)
            for (const r of resolved) {
              next.set(r.id, r.title ?? t('common.untitled'))
            }
            return next
          })
        } else {
          logger.warn('SearchPanel', 'breadcrumb resolve returned a non-array result', undefined)
        }
      })
      .catch((err) => {
        logger.warn('SearchPanel', 'breadcrumb resolution failed', undefined, err)
      })
    // `pageTitles` participates so the already-resolved filter above sees the
    // latest map; the empty-`parentIds` guard makes the follow-up a no-op.
    // `t` is referentially stable (single-locale app), listed for exhaustive-deps.
  }, [results, pageTitles, t])

  // A monotonic "navigation generation". Each click claims the next
  // generation; only the latest may resolve the spinner / perform the
  // deferred navigation.
  const navGenerationRef = useRef(0)
  const handleResultClick = useCallback(
    async (block: BlockRow | SearchBlockRow) => {
      const gen = ++navGenerationRef.current
      setLoadingResultId(block.id)
      try {
        if (block.block_type === 'page') {
          addRecentPage(block.id, block.content ?? t('common.untitled'))
          navigateToPage(block.id, block.content ?? t('common.untitled'))
          return
        }
        if (block.parent_id) {
          try {
            const parent = await getBlock(block.parent_id)
            // A newer click superseded this one while the parent loaded.
            if (navGenerationRef.current !== gen) return
            addRecentPage(block.parent_id, parent.content ?? t('common.untitled'))
            navigateToPage(block.parent_id, parent.content ?? t('common.untitled'), block.id)
          } catch (err) {
            reportIpcError('SearchPanel', 'search.loadResultsFailed', err, t, {
              blockId: block.id,
              parentId: block.parent_id,
            })
          }
        } else {
          logger.warn('SearchPanel', 'block has no parent page', { blockId: block.id })
          notify.error(t('search.noParentPage'))
        }
      } finally {
        // Only the latest click owns the spinner.
        if (navGenerationRef.current === gen) setLoadingResultId(null)
      }
    },
    [addRecentPage, navigateToPage, t],
  )

  // Phase 1 — page-group results. Groups are derived from the flat
  // list each render; their expand state lives in `expandedGroups` so it
  // persists across re-renders but resets on a new query (effect below).
  const groups = useMemo(() => groupResultsByPage(results, pageTitles), [results, pageTitles])
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const handleToggleGroup = useCallback((pageId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [pageId]: !(prev[pageId] ?? true) }))
  }, [])
  useEffect(() => {
    // Reset collapse state on each new query so the UX always starts
    // fully expanded.
    setExpandedGroups({})
  }, [debouncedQuery])

  // Phase 1 — flatten visible (expanded) rows for the keyboard nav
  // hook. Collapsed groups contribute zero rows.
  const visibleRows = useMemo(() => {
    const out: SearchBlockRow[] = []
    for (const g of groups) {
      const isExpanded = expandedGroups[g.page_id] ?? true
      if (!isExpanded) continue
      for (const block of g.blocks) out.push(block)
    }
    return out
  }, [groups, expandedGroups])

  const { focusedIndex, handleKeyDown: handleListKeyDown } = useListKeyboardNavigation({
    itemCount: visibleRows.length,
    // FE-A8 — `debouncedQuery` is the query-change signal: a new query resets
    // focus to row 0, but a plain `itemCount` change clamps the existing focus.
    resetKey: debouncedQuery,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const block = visibleRows[idx]
      if (block) handleResultClick(block)
    },
  })

  const handleRecentClick = useCallback(
    (page: RecentPage) => {
      addRecentPage(page.id, page.title)
      navigateToPage(page.id, page.title)
    },
    [addRecentPage, navigateToPage],
  )

  return {
    results,
    searchLoading,
    hasMore,
    loadMore,
    reload,
    error,
    capped,
    setItems,
    regexError,
    groups,
    visibleRows,
    focusedIndex,
    handleListKeyDown,
    expandedGroups,
    handleToggleGroup,
    handleResultClick,
    loadingResultId,
    recentPages,
    handleRecentClick,
  }
}
