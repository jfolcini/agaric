/**
 * usePollingQuery — fixed-interval polling for Tauri IPC queries.
 *
 * Polls `queryFn` at `intervalMs` and optionally refetches on window focus.
 * The caller must stabilise `queryFn` with `useCallback`; when its reference
 * changes the polling restarts with an immediate fetch.
 *
 * Polling pauses while the page is hidden (`document.hidden === true`, e.g.
 * backgrounded tab or minimised window) so Tauri IPC isn't flooded with
 * useless queries (PERF-21). A `visibilitychange` listener triggers a fresh
 * load as soon as the page becomes visible again, so the caller never waits
 * up to a full interval to see fresh data on return.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface UsePollingQueryOptions {
  /** Polling interval in milliseconds. */
  intervalMs: number
  /** Message stored in `error` state on failure. */
  errorMessage?: string
  /** Refetch when the window regains focus. Defaults to false. */
  refetchOnFocus?: boolean
  /** Skip polling when false. Defaults to true. */
  enabled?: boolean
}

interface UsePollingQueryResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  /**
   * Manually re-run the query. Respects `document.hidden` the same way the
   * polling loop does — calls made while the page is hidden are a no-op.
   * Callers that need a force-fetch regardless of visibility should avoid
   * this hook or fire the underlying Tauri command directly.
   */
  refetch: () => Promise<void>
}

export function usePollingQuery<T>(
  queryFn: () => Promise<T>,
  options: UsePollingQueryOptions,
): UsePollingQueryResult<T> {
  const { intervalMs, refetchOnFocus = false, enabled = true } = options
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const optionsRef = useRef(options)
  optionsRef.current = options

  const load = useCallback(async () => {
    // PERF-21: skip work when the page is hidden — we'll catch up via
    // the visibilitychange handler once the user returns. Guarded via
    // `typeof` so the hook still works in non-browser test environments
    // that might not expose `document`.
    if (typeof document !== 'undefined' && document.hidden) return
    setLoading(true)
    try {
      const resp = await queryFn()
      setData(resp)
      setError(null)
    } catch {
      setError(optionsRef.current.errorMessage ?? 'Request failed')
    }
    setLoading(false)
  }, [queryFn])

  useEffect(() => {
    if (!enabled) return
    load()
    const id = setInterval(load, intervalMs)
    if (refetchOnFocus) window.addEventListener('focus', load)
    // PERF-21: reload the moment the page becomes visible again so stale
    // state (conflict counts, badges) freshens without the user waiting
    // up to `intervalMs` for the next tick.
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && !document.hidden) {
        load()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    return () => {
      clearInterval(id)
      if (refetchOnFocus) window.removeEventListener('focus', load)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [load, intervalMs, refetchOnFocus, enabled])

  return { data, loading, error, refetch: load }
}
