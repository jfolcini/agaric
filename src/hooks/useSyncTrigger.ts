import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { announce } from '../lib/announcer'
import { i18n } from '../lib/i18n'
import { listPeerRefs, startSync } from '../lib/tauri'
import { useSyncStore } from '../stores/sync'

const BASE_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 600_000 // 10 minutes
const SYNC_TIMEOUT_MS = 60_000

/**
 * Returns true when the browser reports the network as offline.
 *
 * Guarded for non-browser contexts (SSR, tests without a `navigator` global).
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine
}

/**
 * Computes the next resync interval following an exponential-backoff policy.
 *
 * - On success (`hadFailure = false`): resets to `BASE_INTERVAL_MS`.
 * - On failure (`hadFailure = true`): doubles `current`, capped at `MAX_INTERVAL_MS`.
 */
export function computeNextSyncDelay(current: number, hadFailure: boolean): number {
  if (!hadFailure) return BASE_INTERVAL_MS
  return Math.min(current * 2, MAX_INTERVAL_MS)
}

/**
 * Races `p` against a timer; rejects with `err` if `ms` elapses first.
 */
export function runWithTimeout<T>(p: Promise<T>, ms: number, err: Error): Promise<T> {
  return Promise.race<T>([p, new Promise<T>((_, reject) => setTimeout(() => reject(err), ms))])
}

/**
 * Syncs a single peer with a timeout guard. Shows a toast on failure.
 * Returns `true` on success, `false` on failure.
 *
 * UX-264: per-peer failures are transient (network, peer-offline, timeout)
 * so the failure toast carries a Retry action that re-runs `startSync`
 * for the same peer. Permanent failures (protocol mismatch, etc.) are
 * surfaced via separate channels and not routed through this helper.
 */
async function syncOnePeerWithToast(peerId: string): Promise<boolean> {
  try {
    await runWithTimeout(startSync(peerId), SYNC_TIMEOUT_MS, new Error('Sync timeout'))
    return true
  } catch {
    toast.error(i18n.t('sync.failedForDevice', { deviceId: peerId.slice(0, 12) }), {
      duration: 5000,
      action: {
        label: i18n.t('sync.retryAction'),
        onClick: () => {
          // Fire-and-forget — a fresh toast surfaces on subsequent failure.
          void syncOnePeerWithToast(peerId)
        },
      },
    })
    return false
  }
}

/**
 * Iterates over `peers` and attempts to sync each one, bailing out when `isMounted()`
 * returns false. Returns `true` if any peer failed.
 */
async function syncAllPeersSequentially(
  peers: ReadonlyArray<{ peer_id: string }>,
  isMounted: () => boolean,
): Promise<boolean> {
  let hadFailure = false
  for (const peer of peers) {
    if (!isMounted()) break
    const ok = await syncOnePeerWithToast(peer.peer_id)
    if (!ok) hadFailure = true
  }
  return hadFailure
}

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
    // Skip sync when offline — set state so UI can reflect it (#429, #667)
    if (isOffline()) {
      setState('offline')
      return
    }
    if (syncInProgressRef.current) return
    syncInProgressRef.current = true
    setSyncing(true)
    setState('syncing')
    announce(i18n.t('announce.syncStarted'))

    let hadFailure = false

    try {
      const peers = await listPeerRefs()
      if (peers.length === 0) {
        setState('idle')
        return
      }
      hadFailure = await syncAllPeersSequentially(peers, () => mountedRef.current)
      if (!mountedRef.current) return
      intervalRef.current = computeNextSyncDelay(intervalRef.current, hadFailure)
      if (!hadFailure) {
        setState('idle')
        toast.success(i18n.t('device.syncComplete'))
        announce(i18n.t('announce.syncCompleted'))
      }
    } catch {
      hadFailure = true
      if (mountedRef.current) {
        setState('error', 'Sync failed')
        toast.error(i18n.t('device.syncFailed'))
        announce(i18n.t('announce.syncFailed'))
        intervalRef.current = computeNextSyncDelay(intervalRef.current, true)
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

  // Trigger immediate sync when coming back online (#667).
  // UX-264: surface a `toast.info` when transitioning offline → online,
  // gated by the prior `offline` sync-store state so we don't fire on
  // benign repeats (some browsers dispatch multiple `online` events).
  useEffect(() => {
    const handleOnline = () => {
      if (useSyncStore.getState().state === 'offline') {
        toast.info(i18n.t('sync.backOnline'))
      }
      syncAll()
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [syncAll])

  return { syncing, syncAll }
}
