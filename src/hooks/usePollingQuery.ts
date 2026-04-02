/**
 * usePollingQuery — fixed-interval polling for Tauri IPC queries.
 *
 * Polls `queryFn` at `intervalMs` and optionally refetches on window focus.
 * The caller must stabilise `queryFn` with `useCallback`; when its reference
 * changes the polling restarts with an immediate fetch.
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

export interface UsePollingQueryResult<T> {
  data: T | null
  loading: boolean
  error: string | null
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
    return () => {
      clearInterval(id)
      if (refetchOnFocus) window.removeEventListener('focus', load)
    }
  }, [load, intervalMs, refetchOnFocus, enabled])

  return { data, loading, error, refetch: load }
}
