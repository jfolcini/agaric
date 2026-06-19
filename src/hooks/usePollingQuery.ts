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
   * Manually re-run the query. By default this respects `document.hidden`
   * the same way the polling loop does — calls made while the page is hidden
   * are a no-op (#1596).
   *
   * Pass `{ force: true }` for an explicit, user-initiated refetch that must
   * run regardless of visibility (e.g. a "Refresh" button). The automatic
   * polling interval never forces, so background tabs stay quiet.
   */
  refetch: (opts?: { force?: boolean }) => Promise<void>
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

  // #755 — stale-response guard (same pattern as usePaginatedQuery's
  // requestIdRef). For fixed-params polling a stale write self-corrects
  // on the next tick, but consumers whose `queryFn` varies with params
  // (reference changes restart polling) could see an older, slower
  // request overwrite the newer response. Each load claims an id; only
  // the latest claim may write state.
  const requestIdRef = useRef(0)

  const load = useCallback(
    async (loadOpts?: { force?: boolean }): Promise<void> => {
      // PERF-21: skip work when the page is hidden — we'll catch up via
      // the visibilitychange handler once the user returns. Guarded via
      // `typeof` so the hook still works in non-browser test environments
      // that might not expose `document`.
      //
      // #1596: an explicit, user-initiated `refetch({ force: true })` bypasses
      // this guard so a "Refresh" action isn't a silent no-op while hidden.
      // The automatic polling/interval path never forces, so background tabs
      // stay quiet as before.
      if (!loadOpts?.force && typeof document !== 'undefined' && document.hidden) return
      const rid = ++requestIdRef.current
      setLoading(true)
      try {
        const resp = await queryFn()
        if (requestIdRef.current !== rid) return
        setData(resp)
        setError(null)
      } catch {
        if (requestIdRef.current !== rid) return
        setError(optionsRef.current.errorMessage ?? 'Request failed')
      } finally {
        // A superseded request must not clear the newer request's spinner.
        if (requestIdRef.current === rid) setLoading(false)
      }
    },
    [queryFn],
  )

  useEffect(() => {
    // Invalidate any in-flight request when deps change or `enabled`
    // flips off — without this, disabling the query skips `load()` (so
    // the id is never bumped) and the prior request's late response
    // would still land in state.
    requestIdRef.current++
    if (!enabled) {
      // The discarded in-flight request's `finally` won't clear loading
      // (its rid no longer matches), so clear it here.
      setLoading(false)
      return
    }
    load()
    // Wrap `load` for the interval/listeners so the auto-polling paths never
    // pass `{ force }` (an Event arg would also be rejected by TS now that
    // `load` takes a typed options param — #1596).
    const tick = (): void => {
      void load()
    }
    const id = setInterval(tick, intervalMs)
    if (refetchOnFocus) window.addEventListener('focus', tick)
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
      if (refetchOnFocus) window.removeEventListener('focus', tick)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [load, intervalMs, refetchOnFocus, enabled])

  return { data, loading, error, refetch: load }
}
