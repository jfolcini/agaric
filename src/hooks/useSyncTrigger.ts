import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { listPeerRefs, startSync } from '../lib/tauri'
import { useSyncStore } from '../stores/sync'

const BASE_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 600_000 // 10 minutes
const SYNC_TIMEOUT_MS = 60_000

/**
 * Manages automatic and manual sync triggering.
 *
 * - Syncs all peers once on mount (sync-on-open, #377).
 * - Re-syncs with exponential backoff on failure (#418).
 * - Exposes `syncAll` for manual trigger (#376).
 */
export function useSyncTrigger() {
  const [syncing, setSyncing] = useState(false)
  const mountedRef = useRef(true)
  const syncInProgressRef = useRef(false)
  const intervalRef = useRef(BASE_INTERVAL_MS)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setState = useSyncStore((s) => s.setState)

  const syncAll = useCallback(async () => {
    // Skip sync when offline — no error, no toast (#429)
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return
    }
    if (syncInProgressRef.current) return
    syncInProgressRef.current = true
    setSyncing(true)
    setState('syncing')

    let hadFailure = false

    try {
      const peers = await listPeerRefs()
      if (peers.length === 0) {
        return
      }
      for (const peer of peers) {
        if (!mountedRef.current) break
        try {
          await Promise.race([
            startSync(peer.peer_id),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Sync timeout')), SYNC_TIMEOUT_MS),
            ),
          ])
        } catch {
          hadFailure = true
          toast.error(`Sync failed for device ${peer.peer_id.slice(0, 12)}...`)
        }
      }
      if (mountedRef.current) {
        if (hadFailure) {
          // Some peers failed — increase backoff
          intervalRef.current = Math.min(intervalRef.current * 2, MAX_INTERVAL_MS)
        } else {
          // All peers succeeded — reset to base
          intervalRef.current = BASE_INTERVAL_MS
          setState('idle')
          toast.success('Sync complete')
        }
      }
    } catch {
      hadFailure = true
      if (mountedRef.current) {
        setState('error', 'Sync failed')
        toast.error('Sync failed')
        intervalRef.current = Math.min(intervalRef.current * 2, MAX_INTERVAL_MS)
      }
    } finally {
      syncInProgressRef.current = false
      if (mountedRef.current) {
        setSyncing(false)
      }
    }
  }, [setState])

  const scheduleNext = useCallback(() => {
    if (!mountedRef.current) return
    timerRef.current = setTimeout(() => {
      syncAll().then(() => {
        if (mountedRef.current) scheduleNext()
      })
    }, intervalRef.current)
  }, [syncAll])

  // Sync on mount + recursive scheduled resync
  useEffect(() => {
    mountedRef.current = true

    // Sync on open (#377) — small delay to let the app finish booting
    const initialTimer = setTimeout(() => {
      syncAll().then(() => {
        if (mountedRef.current) scheduleNext()
      })
    }, 2_000)

    return () => {
      mountedRef.current = false
      clearTimeout(initialTimer)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [syncAll, scheduleNext])

  return { syncing, syncAll }
}
