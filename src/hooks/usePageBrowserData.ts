/**
 * usePageBrowserData — data-fetch orchestration for the Pages view.
 *
 * Owns the IPC query lifecycle and everything derived from it:
 *
 *  - `queryFn` (built from the (space, sort, filters) tuple, which is also
 *    the query key) with the v2-cursor recovery wrapper and the
 *    `InvalidFilter` toast path.
 *  - `useInfiniteQuery` wiring (pages / loading / hasMore / loadMore /
 *    reload / setPages / totalCount).
 * The locally-retained `displayTotalCount` (+ D20): adopts
 *    the hook's first-page total, ignores cursor-page `null`s, resets on a
 *    query-basis change, and decrements on an optimistic delete.
 *  - The delete flow via `usePageDelete`, with the count-decrementing
 *    `setPagesForDelete` interceptor.
 *
 * #2634 — migrated off `usePaginatedQuery` onto TanStack `useInfiniteQuery`
 * directly (staged retirement of the generic hook; matching the merged
 * `HistoryPanel` / `DonePanel` / `useUnlinkedReferences` pattern). The query key
 * carries the real fetch inputs (space / sort / wireFilters), so a change to any
 * is a fresh query — reproducing the old request-id guard: a late load-more
 * response for a superseded basis lands in that key's (now observer-less) cache
 * entry instead of being grafted onto the new result set. The client is passed
 * EXPLICITLY as the 2nd arg so no `QueryClientProvider` ancestor is required
 * (bare `renderHook` / `render` tests need no wrapper). `listPagesWithMetadata`
 * takes no AbortSignal, so — as before migration — none is forwarded. There is
 * no `useBlockPropertyEvents` `invalidationKey` in the key, so no monotonic-key
 * growth and no bounded `gcTime` is needed (inherits the client's Infinity).
 */

import { type InfiniteData, keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PAGINATION_LIMIT } from '@/lib/constants'
import { t as i18nT } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'

import { isAppError, isCancellation, type TypedAppError, validationCode } from '../lib/app-error'
import { ValidationCode } from '../lib/search-query/validation-codes'
import type { BlockRow, FilterPrimitive, PageResponse, PageWithMetadataRow } from '../lib/tauri'
import { listPagesWithMetadata } from '../lib/tauri'
import { pageSortWireFor, type SortOption } from './usePageBrowserSort'
import { usePageDelete } from './usePageDelete'

/**
 * Phase 3 — wrap a paginating IPC call so that a v2 cursor
 * rejection (`AppError::Validation` carrying the structured
 * `RequiresRefresh` code, #2251) automatically retries once with no
 * cursor. The cursor format bumped from v1 → v2 alongside the new sort
 * modes, so a session that started before the new build emitted a stale
 * cursor will round-trip safely on the next page load. If the cursorless
 * retry also fails, the original error propagates and
 * `usePaginatedQuery`'s `onError` toast fires (existing behaviour).
 */
async function withCursorRecovery<T>(
  call: (cursor?: string) => Promise<T>,
  cursor: string | undefined,
): Promise<T> {
  try {
    return await call(cursor)
  } catch (err) {
    if (cursor != null && validationCode(err) === ValidationCode.RequiresRefresh) {
      return call(undefined)
    }
    throw err
  }
}

/**
 * E18 — the backend can reject a malformed / disallowed compound filter
 * with an `InvalidFilter`-coded validation error (#2251 — a structured
 * `code` field, formerly an `InvalidFilter:` message prefix). Without
 * explicit recognition this falls through to the generic
 * `t('pageBrowser.loadFailed')` toast, which misleads the user into
 * thinking the list itself failed to load rather than that a filter chip
 * is invalid.
 */
function isInvalidFilterError(err: unknown): err is TypedAppError {
  return isAppError(err) && validationCode(err) === ValidationCode.InvalidFilter
}

interface UsePageBrowserDataParams {
  currentSpaceId: string | null
  spaceIsReady: boolean
  sortOption: SortOption
  /** Wire-shaped filter primitives (the `_addId` React key is dropped). */
  wireFilters: FilterPrimitive[]
  /** Stable serialisation of `wireFilters` — the query-basis reset trigger. */
  wireFiltersKey: string
}

interface UsePageBrowserDataResult {
  // `pages` is typed as the union: the query returns
  // `PageWithMetadataRow`, but the optimistic create path prepends a
  // raw `BlockRow`. The grouping pipeline reads only the shared
  // `BlockRow` fields, so callers can treat the unified shape as
  // `BlockRow`. The metadata fields (when present) flow through
  // unchanged and `<DensityRow>` reads them via a typed cast in
  // `PageBrowserRowRenderer`.
  pages: (BlockRow | PageWithMetadataRow)[]
  loading: boolean
  hasMore: boolean
  loadMore: () => void
  reload: () => void
  setPages: Dispatch<SetStateAction<(BlockRow | PageWithMetadataRow)[]>>
  displayTotalCount: number | undefined
  setDisplayTotalCount: Dispatch<SetStateAction<number | undefined>>
  deleteTarget: ReturnType<typeof usePageDelete>['deleteTarget']
  deletingId: ReturnType<typeof usePageDelete>['deletingId']
  setDeleteTarget: ReturnType<typeof usePageDelete>['setDeleteTarget']
  handleConfirmDelete: ReturnType<typeof usePageDelete>['handleConfirmDelete']
}

export function usePageBrowserData({
  currentSpaceId,
  spaceIsReady,
  sortOption,
  wireFilters,
  wireFiltersKey,
}: UsePageBrowserDataParams): UsePageBrowserDataResult {
  const { t } = useTranslation()

  // The query key IS the (space, sort, filters) tuple the old `queryFn`
  // `useCallback` closed over — the stale-guard. `wireFilters` is `useMemo`'d
  // on `[filters]`, so its identity only changes on a real chip add/remove;
  // TanStack deep-hashes it deterministically. Held in a ref too so the stable
  // `setPages` setter can target this exact cache entry without re-deriving.
  const queryKey = useMemo(
    () => ['pageBrowserData', currentSpaceId, sortOption, wireFilters] as const,
    [currentSpaceId, sortOption, wireFilters],
  )
  const queryKeyRef = useRef(queryKey)
  queryKeyRef.current = queryKey

  const {
    data,
    isFetching,
    isError,
    error,
    errorUpdatedAt,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(
    {
      queryKey,
      queryFn: async ({ pageParam }): Promise<PageResponse<BlockRow | PageWithMetadataRow>> => {
        // Phase 4 — the IPC requires a `spaceId`. The `?? ''` fallback is
        // intentional pre-bootstrap behaviour: the empty string forces a
        // no-match SQL filter (returning an empty page) instead of a runtime
        // null deref. The `enabled: spaceIsReady` gate below normally
        // prevents this branch from firing.
        const spaceId = currentSpaceId ?? ''
        // Phase 3 — metadata-rich payload + server-derived sort. The wire
        // sort enum is a 4-member subset of the frontend's 7
        // (`pageSortWireFor` does the mapping); the frontend-only sorts
        // (`alphabetical`, `recent`, `created`, `default`) all map to wire
        // `default` and re-sort client-side via `sortPages`.
        return withCursorRecovery(
          (c) =>
            listPagesWithMetadata({
              sort: pageSortWireFor(sortOption),
              spaceId,
              ...(wireFilters.length > 0 && { filters: wireFilters }),
              ...(c != null && { cursor: c }),
              limit: PAGINATION_LIMIT,
            }),
          pageParam,
        ).catch((err: unknown) => {
          // E18 — a malformed/disallowed compound filter rejects with an
          // `InvalidFilter`-coded error. Surface a specific toast (the
          // offending filter, not the list, is the problem) and re-throw a
          // cancellation-shaped error so the `onError` effect below swallows
          // it silently instead of also firing the generic `loadFailed`
          // toast (double-toast). The specific toast already told the user
          // what's wrong.
          if (isInvalidFilterError(err)) {
            notify.error(i18nT('pageBrowser.filter.invalidFilter'))
            const suppressed: TypedAppError = { kind: 'cancelled', message: err.message }
            throw suppressed
          }
          throw err
        })
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => (lastPage?.has_more ? lastPage.next_cursor : undefined),
      enabled: spaceIsReady,
      // usePaginatedQuery re-fetched page 1 on every mount; preserve that.
      refetchOnMount: 'always',
      // usePaginatedQuery ALSO re-ran the IPC on every deps change, even when
      // switching back to a previously-fetched basis (e.g. removing a filter
      // chip returns to the earlier `filters: []` query). Under the client's
      // `staleTime: Infinity` TanStack would serve that cached page without
      // re-hitting the backend, so a chip add→remove round-trip would never
      // re-issue the unfiltered IPC. Overriding `staleTime: 0` marks each key
      // immediately stale, so observing an already-cached basis triggers a
      // background refetch (shown stale-while-revalidate via keepPreviousData)
      // — matching the old always-refetch-on-deps-change contract. There is
      // no server to poll and window/reconnect refetch stay off (client
      // defaults), so this adds no time-based churn beyond that.
      staleTime: 0,
      // Stale-while-revalidate parity: usePaginatedQuery reset the cursor on a
      // deps change but NEVER cleared `items` — only a successful response
      // overwrote them, so the list stayed visible during a refetch. With the
      // fetch inputs now in the query key, a change switches to a fresh empty
      // entry; without this the list would blank to a skeleton on every space
      // / sort / chip change. `keepPreviousData` retains the prior key's pages
      // until the new fetch resolves (per-key cache writes unchanged, so the
      // stale-guard still holds).
      placeholderData: keepPreviousData,
    },
    queryClient,
  )

  // Flatten the page list into the single `pages` array the view renders.
  //
  // Malformed-response retention: a `null`/`undefined` page means the IPC
  // resolved to a non-`PageResponse`. The real backend always returns a
  // `PageResponse`, so this is only reachable via a stubbed IPC mock — but when
  // it happens we must NOT blank the list. The pre-migration hook's
  // `setItems(resp.items)` threw on such a response and fell into its caught
  // error path, leaving the prior `items` untouched (stale-while-revalidate).
  // We reproduce that by retaining the last successfully-flattened list; a
  // genuinely empty *valid* response (`{ items: [], … }`) still clears it.
  const lastGoodPagesRef = useRef<(BlockRow | PageWithMetadataRow)[]>([])
  const pages = useMemo<(BlockRow | PageWithMetadataRow)[]>(() => {
    const raw = data?.pages
    if (raw == null) return []
    if (raw.some((p) => p == null)) return lastGoodPagesRef.current
    const flat = raw.flatMap((p) => p.items)
    lastGoodPagesRef.current = flat
    return flat
  }, [data])
  // usePaginatedQuery's `loading` was true during ANY in-flight fetch (initial
  // AND load-more), driving both the skeleton and the LoadMoreButton busy state
  // — `isFetching` reproduces that (`isLoading` would be false during
  // load-more).
  const loading = isFetching
  const hasMore = hasNextPage
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const reload = useCallback(() => {
    void refetch()
  }, [refetch])

  // `totalCount` mirrors usePaginatedQuery's last-write-wins semantics: it set
  // `total_count` (null → undefined) on EVERY page response, so the exposed
  // value was always the most-recently-fetched page's — i.e. the last page in
  // the accumulated list. The first-page-retain lives one level up in the
  // `displayTotalCount` adopt effect (cursor pages return `null`, which stays
  // `undefined` here and is ignored there).
  const lastPageTotal = data?.pages.at(-1)?.total_count
  const totalCount = lastPageTotal == null ? undefined : lastPageTotal

  // Reproduce the old `onError: t('pageBrowser.loadFailed')` toast.
  // usePaginatedQuery called `notify.error` from its catch on EACH non-cancelled
  // failed load. TanStack keeps `isError` latched across consecutive same-key
  // failures, so `errorUpdatedAt` (which advances per failure) is the
  // fire-once-per-load signal. A cancellation-shaped rejection (the suppressed
  // `InvalidFilter` re-throw) must NOT toast — the specific toast already fired.
  // The `!isFetching` gate makes a cached error safe on remount:
  // `refetchOnMount: 'always'` puts the query straight into `isFetching` while it
  // re-validates, so a stale cached failure can't toast before the fresh fetch
  // settles — only a genuinely settled error does (#2639). The first-render ref
  // still de-dupes the same settled error across unrelated re-renders.
  const lastToastedErrorAtRef = useRef(errorUpdatedAt)
  useEffect(() => {
    if (isError && !isFetching && errorUpdatedAt !== lastToastedErrorAtRef.current) {
      lastToastedErrorAtRef.current = errorUpdatedAt
      if (!isCancellation(error)) notify.error(t('pageBrowser.loadFailed'))
    }
  }, [isError, isFetching, errorUpdatedAt, error, t])

  // Direct setter for optimistic list mutations (the old `setItems`). Reshapes
  // the cached `InfiniteData` in place of a flat `useState` array, WITHOUT
  // mutating any cached object. Two shapes:
  //  - a pure removal (the delete path filters one row out) preserves per-page
  //    structure + pagination — map each page, drop the removed rows, mint
  //    fresh page objects;
  //  - a growth/replace (the optimistic create prepends a raw `BlockRow`)
  //    collapses into a single page carrying the last page's pagination
  //    metadata, so `loadMore` still resolves the next cursor.
  // Stable identity (empty deps, key read from a ref) matching the old
  // `useState` setter, so downstream `useCallback`s don't churn.
  const setPages = useCallback<Dispatch<SetStateAction<(BlockRow | PageWithMetadataRow)[]>>>(
    (action) => {
      queryClient.setQueryData<InfiniteData<PageResponse<BlockRow | PageWithMetadataRow>>>(
        queryKeyRef.current,
        (prev) => {
          const prevItems = prev?.pages.flatMap((p) => p?.items ?? []) ?? []
          const nextItems =
            typeof action === 'function'
              ? (
                  action as (
                    p: (BlockRow | PageWithMetadataRow)[],
                  ) => (BlockRow | PageWithMetadataRow)[]
                )(prevItems)
              : action
          // No cache entry yet (or empty): seed a single self-contained page.
          if (!prev || prev.pages.length === 0) {
            return {
              pages: [{ items: nextItems, next_cursor: null, has_more: false, total_count: null }],
              pageParams: [undefined],
            }
          }
          const prevIds = new Set(prevItems.map((i) => i.id))
          const nextIds = new Set(nextItems.map((i) => i.id))
          const isPureRemoval =
            nextItems.length <= prevItems.length && nextItems.every((i) => prevIds.has(i.id))
          if (isPureRemoval) {
            return {
              ...prev,
              pages: prev.pages.map((p) => ({
                ...p,
                items: p.items.filter((i) => nextIds.has(i.id)),
              })),
            }
          }
          const last = prev.pages.at(-1)
          return {
            pages: [
              {
                items: nextItems,
                next_cursor: last?.next_cursor ?? null,
                has_more: last?.has_more ?? false,
                total_count: last?.total_count ?? null,
              },
            ],
            pageParams: [undefined],
          }
        },
      )
    },
    [],
  )

  // + D20 — locally-retained total for the count chip.
  //
  // D6 (FE half): the backend now computes `total_count` only on the
  // first page (`req.after.is_none()`) and returns `null` on cursor
  // pages. `usePaginatedQuery` is last-write-wins, so a cursor page would
  // blank the hook's `totalCount`. We retain the first-page value here
  // and only overwrite it when the hook reports a fresh number, so the
  // chip keeps showing the total across load-more.
  //
  // D20: the chip must also drop by one on an optimistic delete (the
  // delete path mutates `pages` directly, never re-running the COUNT), so
  // this is local mutable state rather than a pure mirror of the hook.
  const [displayTotalCount, setDisplayTotalCount] = useState<number | undefined>(undefined)
  // Adopt the hook's total only when it is a real number, and only once a
  // fetch has SETTLED (`!isFetching`). A cursor page returning `null` (D6)
  // leaves `totalCount` `undefined`; ignoring that keeps the retained
  // first-page value on screen.
  //
  // #2634 — the effect must key on the settle transition, not on `totalCount`
  // alone. `totalCount` is now derived from `data`, and `keepPreviousData`
  // keeps `data` continuously defined across a basis change, so when the new
  // basis carries the SAME total (a sort switch never changes the count) the
  // derived `totalCount` never changes value. Keyed on `[totalCount]` only,
  // the adopt effect would then never re-fire after the reset effect below
  // blanked `displayTotalCount`, permanently hiding the chip. Keying on
  // `[isFetching, totalCount]` and gating on `!isFetching` re-adopts the total
  // every time a fetch resolves — the `undefined→N` transition the old
  // last-write-wins hook produced on every deps change.
  useEffect(() => {
    if (!isFetching && typeof totalCount === 'number') setDisplayTotalCount(totalCount)
  }, [isFetching, totalCount])
  // Reset the retained total when the query basis changes (space / sort /
  // chip set) so a stale count never lingers against a fresh result set
  // before the new first page resolves.
  useEffect(() => {
    setDisplayTotalCount(undefined)
  }, [currentSpaceId, sortOption, wireFiltersKey])

  // `usePageDelete` predates the metadata-rich union type; its
  // updater is typed against `BlockRow[]`. The two row shapes share
  // every field the deletion path reads (`id`), so we narrow at the
  // boundary with a typed cast instead of widening `usePageDelete`.
  //
  // The delete path mutates `pages` directly (optimistic
  // filter-out on a successful `delete_block`) and never re-runs the
  // backend COUNT, so the count chip would over-report by one. We
  // intercept the delete-only setter here: when the hook's updater
  // produces a strictly shorter array (the success path filters one row
  // out), decrement the retained total by the same delta. We only ever
  // *decrease* here — the create path has its own setter / count handling
  // — so a no-op or growth leaves the total untouched. Tying the
  // decrement to the actual array shrink (rather than the confirm click)
  // means a failed delete, which leaves `pages` unchanged, also leaves
  // the count unchanged.
  //
  // E15 — a render-synced snapshot of `pages` so `setPagesForDelete` can
  // compute the array delta WITHOUT reading `prev` from inside a
  // `setPages` updater. Keeping the delta math (and the dependent
  // `setDisplayTotalCount`) outside the updater makes the path idempotent
  // under React StrictMode's double-invoke.
  const setPagesSnapshotRef = useRef(pages)
  setPagesSnapshotRef.current = pages
  const setPagesForDelete = useCallback(
    (updater: (prev: BlockRow[]) => BlockRow[]) => {
      // E15 — the count decrement must NOT live inside the `setPages`
      // updater: React StrictMode (dev) double-invokes a `useState`
      // updater to surface impurity, and a nested `setDisplayTotalCount`
      // is a side effect, so it would fire — and decrement — twice.
      // Compute the delta against the *current* pages snapshot, apply the
      // page mutation idempotently, then fire the count decrement exactly
      // once outside the updater.
      const prevRows = setPagesSnapshotRef.current as BlockRow[]
      const next = updater(prevRows)
      setPages(next as (BlockRow | PageWithMetadataRow)[])
      if (next.length < prevRows.length) {
        const removed = prevRows.length - next.length
        setDisplayTotalCount((cur) => (typeof cur === 'number' ? Math.max(0, cur - removed) : cur))
      }
    },
    [setPages],
  )
  const { deleteTarget, deletingId, setDeleteTarget, handleConfirmDelete } =
    usePageDelete(setPagesForDelete)

  return {
    pages,
    loading,
    hasMore,
    loadMore,
    reload,
    setPages,
    displayTotalCount,
    setDisplayTotalCount,
    deleteTarget,
    deletingId,
    setDeleteTarget,
    handleConfirmDelete,
  }
}
