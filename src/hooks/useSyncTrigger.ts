import { useCallback, useEffect, useRef, useState } from 'react'

import { notify } from '@/lib/notify'

import { announce } from '../lib/announcer'
import { i18n } from '../lib/i18n'
import type { PeerRefRow } from '../lib/tauri'
import { listPeerRefs, startSync } from '../lib/tauri'
import type { PeerInfo } from '../stores/sync'
import { useSyncStore } from '../stores/sync'
import { mapBackendState } from './useSyncEvents'

/**
 * Maps a backend `PeerRefRow` to the store-facing `PeerInfo` shape (#1076).
 *
 * Single source of truth for the row → store mapping so `useSyncStore.peers`
 * — consumed by `StatusPanel` (Sync panel) and `AppSidebar` (status dot) —
 * reflects the SAME paired devices the working `PairingDialog` /
 * `DeviceManagement` components read via `listPeerRefs()`.
 *
 * `synced_at` is backend epoch-ms (or null); `PeerInfo.lastSyncedAt` is the
 * ISO-string form the store documents and its tests assert.
 */
export function mapPeerRefToInfo(row: PeerRefRow): PeerInfo {
  return {
    peerId: row.peer_id,
    lastSyncedAt: row.synced_at != null ? new Date(row.synced_at).toISOString() : null,
    resetCount: row.reset_count,
  }
}

// Frontend periodic-sync cadence and exponential-backoff caps.
//
// NOTE on dual schedulers: the backend (`src-tauri/src/sync_scheduler.rs`)
// runs its own per-peer exponential backoff (1s → 60s) and is the
// authoritative scheduler — it owns retries, per-peer mutexes, jitter,
// and silent rejection of redundant invocations. This frontend trigger
// is a coarse "wake the scheduler" hint at a slower cadence
// (60s → 600s on failure). The two schedulers do not coordinate: when
// the backend is mid-backoff, calling `startSync()` from here is a
// no-op on the wire — it just resolves quickly. That is fine; do not
// add cross-scheduler coordination here without first reading
// `sync_scheduler.rs` end-to-end. See MAINT-168 for
// the deferred unification design note.
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
 *
 * The timeout's `setTimeout` is cleared in `.finally()` so a winning `p` does
 * not leak a pending timer for the remainder of `ms`.
 */
export async function runWithTimeout<T>(p: Promise<T>, ms: number, err: Error): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(err), ms)
  })
  try {
    return await Promise.race<T>([p, timeout])
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
  }
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
    const store = useSyncStore.getState()
    await runWithTimeout(
      startSync(peerId, (update) => {
        // PEND-06 Tier 2 — `SyncProgressUpdate` is a tagged enum: the
        // op-sync stream lands as `kind: 'sync'`, the post-sync
        // attachment-transfer stream lands as `kind: 'files'`. Fall
        // through to the file branch on `complete` so the affordance
        // resets without an extra explicit tick.
        if (update.kind === 'sync') {
          store.setState(mapBackendState(update.state))
          store.setOpsReceived(update.ops_received)
          store.setOpsSent(update.ops_sent)
        } else if (update.phase === 'complete') {
          store.resetFileProgress()
        } else if (update.phase === 'sending' || update.phase === 'receiving') {
          store.setFileProgress(
            update.phase,
            Number(update.files_done),
            Number(update.files_total),
            Number(update.bytes_done),
            Number(update.bytes_total),
          )
        }
      }),
      SYNC_TIMEOUT_MS,
      new Error('Sync timeout'),
    )
    return true
  } catch {
    notify.error(i18n.t('sync.failedForDevice', { deviceId: peerId.slice(0, 12) }), {
      // Per-peer dedup: a single failing peer should not stack multiple
      // toasts on retry-loop iterations. Different peers still surface
      // their own toast because the id is scoped by peerId.
      id: `sync-peer-error:${peerId}`,
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
      // #1076: reflect the authoritative backend peer list into the store
      // so `StatusPanel`'s Sync panel and `AppSidebar`'s status dot (both
      // gated on `useSyncStore.peers`) become correct. Runs for the empty
      // case too, clearing any stale peers when the last device unpairs.
      useSyncStore.getState().setPeers(peers.map(mapPeerRefToInfo))
      if (peers.length === 0) {
        setState('idle')
        return
      }
      hadFailure = await syncAllPeersSequentially(peers, () => mountedRef.current)
      if (!mountedRef.current) return
      intervalRef.current = computeNextSyncDelay(intervalRef.current, hadFailure)
      if (!hadFailure) {
        setState('idle')
        notify.success(i18n.t('device.syncComplete'))
        announce(i18n.t('announce.syncCompleted'))
      }
    } catch {
      if (mountedRef.current) {
        setState('error', 'Sync failed')
        notify.error(i18n.t('device.syncFailed'), { id: 'sync-error' })
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
  // UX-264: surface a `notify.info` when transitioning offline → online,
  // gated by the prior `offline` sync-store state so we don't fire on
  // benign repeats (some browsers dispatch multiple `online` events).
  useEffect(() => {
    const handleOnline = () => {
      if (useSyncStore.getState().state === 'offline') {
        notify.info(i18n.t('sync.backOnline'))
      }
      syncAll()
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [syncAll])

  return { syncing, syncAll }
}
