/**
 * useSyncWithTimeout — reusable hook for sync operations with timeout.
 *
 * Wraps a sync function with Promise.race against a configurable timeout.
 * On timeout, calls cancelSync() to abort the in-progress sync session.
 * Tracks loading state and re-throws errors for the caller to handle.
 */

import { useCallback, useState } from 'react'
import { cancelSync } from '../lib/tauri'

export function useSyncWithTimeout(timeoutMs = 60_000) {
  const [loading, setLoading] = useState(false)

  const execute = useCallback(
    async (syncFn: () => Promise<void>) => {
      setLoading(true)
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Sync timed out')), timeoutMs)
        })
        // Prevent unhandled-rejection warning when timeout fires after
        // syncFn settles (clearTimeout in finally normally prevents this,
        // but edge cases exist with fake timers).
        timeout.catch(() => {})
        await Promise.race([syncFn(), timeout])
      } catch (err) {
        if (err instanceof Error && err.message === 'Sync timed out') {
          await cancelSync()
        }
        throw err
      } finally {
        clearTimeout(timeoutId)
        setLoading(false)
      }
    },
    [timeoutMs],
  )

  return { execute, loading }
}
