import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { listPeerRefs, startSync } from '../lib/tauri'
import { useSyncStore } from '../stores/sync'

const RESYNC_INTERVAL_MS = 60_000
const SYNC_TIMEOUT_MS = 60_000

/**
 * Manages automatic and manual sync triggering.
 *
 * - Syncs all peers once on mount (sync-on-open, #377).
 * - Re-syncs every 60 s while mounted (#375).
 * - Exposes `syncAll` for manual trigger (#376).
 */
export function useSyncTrigger() {
  const [syncing, setSyncing] = useState(false)
  const mountedRef = useRef(true)
  const syncInProgressRef = useRef(false)
  const setState = useSyncStore((s) => s.setState)

  const syncAll = useCallback(async () => {
    // Prevent concurrent sync runs
    if (syncInProgressRef.current) return
    syncInProgressRef.current = true
    setSyncing(true)
    setState('syncing')

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
          // Individual peer failure shouldn't stop syncing others.
          toast.error(`Sync failed for device ${peer.peer_id.slice(0, 12)}...`)
        }
      }
      if (mountedRef.current) {
        setState('idle')
        toast.success('Sync complete')
      }
    } catch {
      if (mountedRef.current) {
        setState('error', 'Sync failed')
        toast.error('Sync failed')
      }
    } finally {
      syncInProgressRef.current = false
      if (mountedRef.current) {
        setSyncing(false)
      }
    }
  }, [setState])

  // Sync on mount + periodic resync
  useEffect(() => {
    mountedRef.current = true

    // Sync on open (#377) — small delay to let the app finish booting
    const initialTimer = setTimeout(() => {
      syncAll()
    }, 2_000)

    // Periodic resync (#375)
    const intervalId = setInterval(() => {
      syncAll()
    }, RESYNC_INTERVAL_MS)

    return () => {
      mountedRef.current = false
      clearTimeout(initialTimer)
      clearInterval(intervalId)
    }
  }, [syncAll])

  return { syncing, syncAll }
}
