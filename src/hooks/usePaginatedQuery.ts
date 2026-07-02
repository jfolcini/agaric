/**
 * usePaginatedQuery — eliminates cursor-based pagination boilerplate.
 *
 * Manages items, loading, hasMore, error, and cursor state internally.
 * Stale responses from superseded requests are silently discarded.
 *
 * The caller must stabilise `queryFn` with `useCallback`. When its reference
 * changes (because deps changed), the hook automatically re-fetches page 1
 * while keeping stale items visible until the new response arrives.
 */

import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'

import { isAppError, isCancellation, type TypedAppError } from '@/lib/app-error'
import { notify } from '@/lib/notify'

/** Minimum response shape for cursor-based pagination. */
export interface PaginatedResponse<T> {
  items: T[]
  next_cursor: string | null
  has_more: boolean
  /**
   * Total number of matching rows in the underlying table, ignoring
   * the page cursor/limit. `undefined` / `null` when the backend
   * helper does not compute it (the default for cursor pagination).
   * Populated by `list_blocks` (PageBrowser "X of Y" progress chip).
   */
  total_count?: number | null
}

/**
 * Runaway guard for {@link UsePaginatedQueryOptions.drain}. Each backend page
 * is capped by `PageRequest::new`'s `MAX_PAGE_SIZE` (200 rows), so the default
 * bounds a drained section at 200 × 1000 = 200 000 rows — far past any list
 * where an eager flat drain is still useful, while keeping a hard stop if the
 * backend ever returns a non-advancing cursor. Consumers that want a tighter
 * bound (e.g. UnfinishedTasks' 25-page cap) pass an explicit `maxPages`.
 */
const DEFAULT_MAX_DRAIN_PAGES = 1000

export interface UsePaginatedQueryOptions {
  /** Toast message shown on error. Omit to suppress toast (error state is still tracked). */
  onError?: string
  /** Skip the initial fetch when false. Defaults to true. */
  enabled?: boolean
  /** Maximum number of accumulated items before capping. Defaults to 5000. */
  maxItems?: number
  /**
   * #2256 — drain-to-completion mode. When `true`, the initial (cursorless)
   * load follows the `next_cursor` chain to the end, accumulating every page
   * into a single `items` list in one commit, instead of stopping at page 1
   * and surfacing `loadMore`. `hasMore` always ends `false` and `loadMore`
   * becomes a no-op, so a drain panel renders the *full* set without a "Load
   * more" affordance. Bounded by {@link maxPages} so a backend returning a
   * non-advancing cursor can't spin forever. Used by UnfinishedTasks, whose
   * "Older" group and count badge must reflect every page (#757).
   */
  drain?: boolean
  /**
   * Runaway guard for {@link drain}: the maximum number of cursor pages the
   * drain will follow before stopping. Defaults to {@link DEFAULT_MAX_DRAIN_PAGES}.
   * Ignored when `drain` is not set.
   */
  maxPages?: number
}

export interface UsePaginatedQueryResult<T> {
  items: T[]
  loading: boolean
  hasMore: boolean
  /** True when accumulated items reached the maxItems cap. Consumers can show "Refine your search". */
  capped: boolean
  /** Error message from the last failed request, or null. Cleared on next success. */
  error: string | null
  /**
   * #2251 — the structured IPC `AppError` behind {@link error}, when the
   * rejection was an AppError-shaped object (real Tauri rejections and the
   * tauri-mock both are); `null` for non-IPC failures. Lets consumers
   * discriminate on `kind` / validation `code` as data (e.g. the SearchPanel
   * inline `InvalidRegex` alert) instead of regexing the message string.
   * Cleared on next success alongside {@link error}.
   */
  errorDetail: TypedAppError | null
  /** Fetch the next page. No-op when already loading or no more pages. */
  loadMore: () => void
  /** Re-fetch from page 1. Does not clear items (stale-while-revalidate). */
  reload: () => void
  /** Direct setter for optimistic updates or manual clearing. */
  setItems: Dispatch<SetStateAction<T[]>>
  /**
   * Total number of matching rows from the latest backend response,
   * or `undefined` when the backend does not surface a count
   * (most cursor-paginated endpoints). Last-write wins across pages
   * — when a query returns the same `total_count` for every cursor
   * step the value is stable; when it doesn't, the most recent
   * response's value is exposed. Consumers can render "X of Y"
   * progress when this is a number.
   */
  totalCount: number | undefined
}

/**
 * Derive the display error + structured detail for a failed request, or `null`
 * when the rejection is a cancellation that must be swallowed silently (a
 * superseded keystroke / filter change — the stale-id guard already discarded
 * its result). Factored out of {@link usePaginatedQuery}'s `load` to keep the
 * callback's cyclomatic complexity within the lint budget.
 *
 * #2251 — real IPC rejections are plain `{ kind, message }` objects (NOT
 * `Error` instances), so the message is read off the AppError shape too rather
 * than collapsing to 'Request failed'.
 */
function deriveErrorState(
  err: unknown,
  onError: string | undefined,
): { error: string; errorDetail: TypedAppError | null } | null {
  if (isCancellation(err)) return null
  const detail = isAppError(err) ? err : null
  const error =
    onError ?? (err instanceof Error ? err.message : (detail?.message ?? 'Request failed'))
  return { error, errorDetail: detail }
}

/**
 * Drain the cursor chain to completion for {@link UsePaginatedQueryOptions.drain}
 * mode. Follows `next_cursor` until the backend reports no more pages (or
 * `maxPages` is reached), accumulating every page's items into one list.
 * `isStale` is re-checked after each page so a superseded request (deps change
 * mid-drain) abandons the chain early. Returns the accumulated items plus the
 * last page's response (for `total_count`), or `null` when abandoned as stale.
 *
 * Factored out of {@link usePaginatedQuery}'s `load` so the drain branch does
 * not push the callback's cyclomatic complexity past the lint budget.
 */
async function drainCursorChain<T>(
  queryFn: (cursor?: string, signal?: AbortSignal) => Promise<PaginatedResponse<T>>,
  signal: AbortSignal,
  maxPages: number,
  isStale: () => boolean,
): Promise<{ items: T[]; lastResp: PaginatedResponse<T> | null } | null> {
  const drained: T[] = []
  let pageCursor: string | undefined
  let lastResp: PaginatedResponse<T> | null = null
  for (let page = 0; page < maxPages; page++) {
    const resp = await queryFn(pageCursor, signal)
    if (isStale()) return null
    drained.push(...resp.items)
    lastResp = resp
    if (!resp.has_more || resp.next_cursor == null) break
    pageCursor = resp.next_cursor
  }
  return { items: drained, lastResp }
}

export function usePaginatedQuery<T>(
  queryFn: (cursor?: string, signal?: AbortSignal) => Promise<PaginatedResponse<T>>,
  options?: UsePaginatedQueryOptions,
): UsePaginatedQueryResult<T> {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<TypedAppError | null>(null)
  const [capped, setCapped] = useState(false)
  const [totalCount, setTotalCount] = useState<number | undefined>(undefined)
  const requestIdRef = useRef(0)
  // Controller for the in-flight request. Each `load()`
  // aborts the previous controller so a superseded search (newer
  // keystroke, filter change, `loadMore` race) stops waiting on its IPC
  // and any AbortSignal-aware `queryFn` can drop the prior request. The
  // request-id guard above already discards stale *values*; this aborts
  // the stale *promise* so it never resolves into the catch as an error.
  const abortRef = useRef<AbortController | null>(null)

  // Store options in a ref so `load` only depends on `queryFn`.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const load = useCallback(
    async (cursor?: string) => {
      const rid = ++requestIdRef.current
      // Abort whatever was in flight, then arm a fresh controller for
      // this request and hand its signal to the query.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      try {
        // #2256 — drain-to-completion. The initial (cursorless) load follows
        // the cursor chain to the end, accumulating every page into one list
        // committed in a single `setItems`, then leaves nothing more to load
        // (`hasMore` false, `nextCursor` null → `loadMore` is a no-op). The
        // request-id guard is re-checked after every page so a deps change
        // mid-drain discards the stale tail instead of grafting it onto the
        // fresh query. Load-more cursors (cursor != null) never take this
        // path — a drain panel never calls `loadMore`.
        if (optionsRef.current?.drain && !cursor) {
          const maxPages = optionsRef.current?.maxPages ?? DEFAULT_MAX_DRAIN_PAGES
          const result = await drainCursorChain(
            queryFn,
            controller.signal,
            maxPages,
            () => requestIdRef.current !== rid,
          )
          if (result === null) return
          setItems(result.items)
          setCapped(false)
          setNextCursor(null)
          setHasMore(false)
          setTotalCount(
            result.lastResp?.total_count == null ? undefined : result.lastResp.total_count,
          )
          setError(null)
          setErrorDetail(null)
          return
        }
        const resp = await queryFn(cursor, controller.signal)
        if (requestIdRef.current !== rid) return
        if (cursor) {
          const maxItems = optionsRef.current?.maxItems ?? 5000
          setItems((prev) => {
            if (prev.length + resp.items.length > maxItems) {
              setCapped(true)
              // Cap reached: kill the pagination state too. Leaving
              // `hasMore` / `nextCursor` live would let "Load more" keep
              // fetching pages we discard forever (consumers gate the
              // button on `hasMore` alone).
              setHasMore(false)
              setNextCursor(null)
              return prev
            }
            setNextCursor(resp.next_cursor)
            setHasMore(resp.has_more)
            return [...prev, ...resp.items]
          })
        } else {
          setItems(resp.items)
          setCapped(false)
          setNextCursor(resp.next_cursor)
          setHasMore(resp.has_more)
        }
        // Last-write wins. The backend's `total_count` should be
        // stable across cursor pages for the same query (it ignores
        // the cursor/limit), but if it ever isn't, the most recent
        // response is the closest to truth. `null` -> `undefined`
        // so consumers can do `typeof totalCount === 'number'` to
        // gate "X of Y" rendering without a separate `!= null` step.
        setTotalCount(resp.total_count == null ? undefined : resp.total_count)
        setError(null)
        setErrorDetail(null)
      } catch (err) {
        if (requestIdRef.current !== rid) return
        // Swallow cancellations silently (a superseded keystroke / filter
        // change); otherwise surface the display error + structured detail.
        const errState = deriveErrorState(err, optionsRef.current?.onError)
        if (errState === null) return
        setErrorDetail(errState.errorDetail)
        setError(errState.error)
        if (optionsRef.current?.onError) notify.error(optionsRef.current.onError)
      } finally {
        if (requestIdRef.current === rid) setLoading(false)
      }
    },
    [queryFn],
  )

  // Auto-load on mount and when queryFn identity changes (deps changed).
  // Always reset cursor/hasMore when deps change (stale pagination state).
  // Only call load() when enabled — this lets callers gate auto-fetch.
  const enabled = options?.enabled ?? true
  useEffect(() => {
    // Invalidate any in-flight request whenever deps change or
    // `enabled` flips. Without this, disabling the query (e.g. the user
    // cleared the input) skips `load()`, so `requestIdRef` is never
    // bumped and the prior request's late response still passes its
    // stale-id guard and repopulates the just-cleared list.
    requestIdRef.current++
    // Alongside the request-id bump, abort the prior
    // in-flight request so its IPC stops being awaited. `load()` (when
    // `enabled`) arms a fresh controller; the `!enabled` early-return
    // below leaves it aborted, which is correct — there is nothing to
    // wait for once the query is disabled.
    abortRef.current?.abort()
    setNextCursor(null)
    setHasMore(false)
    setCapped(false)
    // Reset totalCount when deps change so a stale count from the
    // previous queryFn doesn't briefly drive an "X of Y" chip
    // against a fresh, unrelated result set.
    setTotalCount(undefined)
    if (!enabled) {
      // The discarded in-flight request's `finally` won't clear loading
      // (its rid no longer matches), so clear it here.
      setLoading(false)
      return
    }
    load()
  }, [load, enabled])

  // Abort the in-flight request on unmount. Kept in its
  // own mount-only effect (empty deps) so it does NOT tear down the
  // controller that the deps-change effect above just armed; that effect
  // already aborts the prior request before re-arming.
  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const loadMore = useCallback(() => {
    if (nextCursor && !loading) load(nextCursor)
  }, [nextCursor, loading, load])

  const reload = useCallback(() => {
    setNextCursor(null)
    setHasMore(false)
    load()
  }, [load])

  return {
    items,
    loading,
    hasMore,
    capped,
    error,
    errorDetail,
    loadMore,
    reload,
    setItems,
    totalCount,
  }
}
