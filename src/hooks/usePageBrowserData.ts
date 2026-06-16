/**
 * usePageBrowserData — data-fetch orchestration for the Pages view.
 *
 * Owns the IPC query lifecycle and everything derived from it:
 *
 *  - `queryFn` (identity-stable per (space, sort, filters) tuple) with
 *    the v2-cursor recovery wrapper and the `InvalidFilter:` toast path.
 *  - `usePaginatedQuery` wiring (pages / loading / hasMore / loadMore /
 *    reload / setPages / totalCount).
 *  - The locally-retained `displayTotalCount` (PEND-58d D6 + D20): adopts
 *    the hook's first-page total, ignores cursor-page `null`s, resets on a
 *    query-basis change, and decrements on an optimistic delete.
 *  - The delete flow via `usePageDelete`, with the count-decrementing
 *    `setPagesForDelete` interceptor.
 *
 * Extracted verbatim from `PageBrowser.tsx` (#1263). Pure move — same
 * effects, same deps, same timing, same toast behaviour.
 */

import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PAGINATION_LIMIT } from '@/lib/constants'
import { t as i18nT } from '@/lib/i18n'
import { notify } from '@/lib/notify'

import { isAppError, type TypedAppError } from '../lib/app-error'
import type { BlockRow, FilterPrimitive, PageWithMetadataRow } from '../lib/tauri'
import { listPagesWithMetadata } from '../lib/tauri'
import { pageSortWireFor, type SortOption } from './usePageBrowserSort'
import { usePageDelete } from './usePageDelete'
import { usePaginatedQuery } from './usePaginatedQuery'

/**
 * PEND-56 Phase 3 — wrap a paginating IPC call so that a v2 cursor
 * rejection (`AppError::Validation` with the `RequiresRefresh:` prefix)
 * automatically retries once with no cursor. The cursor format bumped
 * from v1 → v2 alongside the new sort modes, so a session that started
 * before the new build emitted a stale cursor will round-trip safely
 * on the next page load. If the cursorless retry also fails, the
 * original error propagates and `usePaginatedQuery`'s `onError` toast
 * fires (existing behaviour).
 */
async function withCursorRecovery<T>(
  call: (cursor?: string) => Promise<T>,
  cursor: string | undefined,
): Promise<T> {
  try {
    return await call(cursor)
  } catch (err) {
    if (
      cursor != null &&
      isAppError(err) &&
      err.kind === 'validation' &&
      err.message.startsWith('RequiresRefresh:')
    ) {
      return call(undefined)
    }
    throw err
  }
}

/**
 * E18 — the backend can reject a malformed / disallowed compound filter
 * with `AppError::Validation("InvalidFilter: …")` (mirroring the existing
 * `RequiresRefresh:` / `InvalidDateFilter:` prefixes). Without explicit
 * recognition this falls through to the generic
 * `t('pageBrowser.loadFailed')` toast, which misleads the user into
 * thinking the list itself failed to load rather than that a filter chip
 * is invalid. Detect the prefix here.
 */
const INVALID_FILTER_PREFIX = 'InvalidFilter:'
function isInvalidFilterError(err: unknown): err is TypedAppError {
  return (
    isAppError(err) && err.kind === 'validation' && err.message.startsWith(INVALID_FILTER_PREFIX)
  )
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

  const queryFn = useCallback(
    (cursor?: string) => {
      // FEAT-3 Phase 4 — the IPC requires a `spaceId`. The `?? ''`
      // fallback is intentional pre-bootstrap behaviour: the empty
      // string forces a no-match SQL filter (returning an empty page)
      // instead of a runtime null deref. The `enabled: spaceIsReady`
      // gate below normally prevents this branch from firing.
      const spaceId = currentSpaceId ?? ''
      // PEND-56 Phase 3 — metadata-rich payload + server-derived
      // sort. The wire sort enum is a 4-member subset of the
      // frontend's 7 (`pageSortWireFor` does the mapping); the
      // frontend-only sorts (`alphabetical`, `recent`, `created`,
      // `default`) all map to wire `default` and re-sort client-side
      // via `sortPages`.
      return withCursorRecovery(
        (c) =>
          listPagesWithMetadata({
            sort: pageSortWireFor(sortOption),
            spaceId,
            ...(wireFilters.length > 0 && { filters: wireFilters }),
            ...(c != null && { cursor: c }),
            limit: PAGINATION_LIMIT,
          }),
        cursor,
      ).catch((err: unknown) => {
        // E18 — a malformed/disallowed compound filter rejects with
        // `InvalidFilter:`. Surface a specific toast (the offending
        // filter, not the list, is the problem) and re-throw a
        // cancellation-shaped error so `usePaginatedQuery` swallows it
        // silently instead of also firing the generic `loadFailed`
        // toast (double-toast). The `error` state stays clean — the
        // specific toast already told the user what's wrong.
        if (isInvalidFilterError(err)) {
          notify.error(i18nT('pageBrowser.filter.invalidFilter'))
          const suppressed: TypedAppError = { kind: 'cancelled', message: err.message }
          throw suppressed
        }
        throw err
      })
    },
    // `wireFilters` is `useMemo`'d on `[filters]`, so its identity only
    // changes on a real chip add/remove — safe to depend on directly.
    [currentSpaceId, sortOption, wireFilters],
  )
  const {
    items: pages,
    loading,
    hasMore,
    loadMore,
    reload,
    setItems: setPages,
    totalCount,
  } = usePaginatedQuery<BlockRow | PageWithMetadataRow>(queryFn, {
    onError: t('pageBrowser.loadFailed'),
    enabled: spaceIsReady,
  })

  // PEND-58d D6 + D20 — locally-retained total for the count chip.
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
  // Adopt the hook's total only when it is a real number. A cursor page
  // returning `null` (D6) leaves `totalCount` `undefined`; ignoring that
  // keeps the retained first-page value on screen.
  useEffect(() => {
    if (typeof totalCount === 'number') setDisplayTotalCount(totalCount)
  }, [totalCount])
  // Reset the retained total when the query basis changes (space / sort /
  // chip set) so a stale count never lingers against a fresh result set
  // before the new first page resolves.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the query-basis tuple drives the reset; `wireFiltersKey` is the chip-set trigger
  useEffect(() => {
    setDisplayTotalCount(undefined)
  }, [currentSpaceId, sortOption, wireFiltersKey])

  // `usePageDelete` predates the metadata-rich union type; its
  // updater is typed against `BlockRow[]`. The two row shapes share
  // every field the deletion path reads (`id`), so we narrow at the
  // boundary with a typed cast instead of widening `usePageDelete`.
  //
  // PEND-58d D20 — the delete path mutates `pages` directly (optimistic
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
