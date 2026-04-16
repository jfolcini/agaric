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
import { toast } from 'sonner'

/** Minimum response shape for cursor-based pagination. */
export interface PaginatedResponse<T> {
  items: T[]
  next_cursor: string | null
  has_more: boolean
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
        setError(null)
      } catch (err) {
        if (requestIdRef.current !== rid) return
        const msg =
          optionsRef.current?.onError ?? (err instanceof Error ? err.message : 'Request failed')
        setError(msg)
        if (optionsRef.current?.onError) toast.error(optionsRef.current.onError)
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

  return { items, loading, hasMore, capped, error, loadMore, reload, setItems }
}
