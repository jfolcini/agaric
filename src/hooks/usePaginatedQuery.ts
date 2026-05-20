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
import { isCancellation } from '@/lib/app-error'
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

export interface UsePaginatedQueryOptions {
  /** Toast message shown on error. Omit to suppress toast (error state is still tracked). */
  onError?: string
  /** Skip the initial fetch when false. Defaults to true. */
  enabled?: boolean
  /** Maximum number of accumulated items before capping. Defaults to 5000. */
  maxItems?: number
}

export interface UsePaginatedQueryResult<T> {
  items: T[]
  loading: boolean
  hasMore: boolean
  /** True when accumulated items reached the maxItems cap. Consumers can show "Refine your search". */
  capped: boolean
  /** Error message from the last failed request, or null. Cleared on next success. */
  error: string | null
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

export function usePaginatedQuery<T>(
  queryFn: (cursor?: string) => Promise<PaginatedResponse<T>>,
  options?: UsePaginatedQueryOptions,
): UsePaginatedQueryResult<T> {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [capped, setCapped] = useState(false)
  const [totalCount, setTotalCount] = useState<number | undefined>(undefined)
  const requestIdRef = useRef(0)

  // Store options in a ref so `load` only depends on `queryFn`.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const load = useCallback(
    async (cursor?: string) => {
      const rid = ++requestIdRef.current
      setLoading(true)
      try {
        const resp = await queryFn(cursor)
        if (requestIdRef.current !== rid) return
        if (cursor) {
          const maxItems = optionsRef.current?.maxItems ?? 5000
          setItems((prev) => {
            if (prev.length + resp.items.length > maxItems) {
              setCapped(true)
              return prev
            }
            return [...prev, ...resp.items]
          })
        } else {
          setItems(resp.items)
          setCapped(false)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        // Last-write wins. The backend's `total_count` should be
        // stable across cursor pages for the same query (it ignores
        // the cursor/limit), but if it ever isn't, the most recent
        // response is the closest to truth. `null` -> `undefined`
        // so consumers can do `typeof totalCount === 'number'` to
        // gate "X of Y" rendering without a separate `!= null` step.
        setTotalCount(resp.total_count == null ? undefined : resp.total_count)
        setError(null)
      } catch (err) {
        if (requestIdRef.current !== rid) return
        // PEND-73 Phase 2 — swallow PEND-70 cancellations silently.
        // A superseded keystroke or filter change is the expected case
        // and should not flash a toast / set error state. The stale-id
        // guard above already discards the (non-existent) result.
        if (isCancellation(err)) return
        const msg =
          optionsRef.current?.onError ?? (err instanceof Error ? err.message : 'Request failed')
        setError(msg)
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
    setNextCursor(null)
    setHasMore(false)
    setCapped(false)
    // Reset totalCount when deps change so a stale count from the
    // previous queryFn doesn't briefly drive an "X of Y" chip
    // against a fresh, unrelated result set.
    setTotalCount(undefined)
    if (!enabled) return
    load()
  }, [load, enabled])

  const loadMore = useCallback(() => {
    if (nextCursor && !loading) load(nextCursor)
  }, [nextCursor, loading, load])

  const reload = useCallback(() => {
    setNextCursor(null)
    setHasMore(false)
    load()
  }, [load])

  return { items, loading, hasMore, capped, error, loadMore, reload, setItems, totalCount }
}
