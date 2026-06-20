import { useCallback, useEffect, useRef, useState } from 'react'

import { notify } from '@/lib/notify'

import { announce } from '../lib/announcer'
import { i18n } from '../lib/i18n'
import type { PeerRefRow } from '../lib/tauri'
import { flushAllDrafts, listPeerRefs, startSync } from '../lib/tauri'
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
// `sync_scheduler.rs` end-to-end. See for
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
 * Per-peer failures are transient (network, peer-offline, timeout)
 * so the failure toast carries a Retry action that re-runs `startSync`
 * for the same peer. Permanent failures (protocol mismatch, etc.) are
 * surfaced via separate channels and not routed through this helper.
 *
 * #748: `shouldToast` lets the caller suppress the failure toast for a
 * run that has been invalidated (e.g. an Android WebView suspended the
 * sync in the background; on resume the throttled `runWithTimeout` timer
 * fires late and rejects with "Sync timeout"). A fresh resume-triggered
 * run supersedes the stale one, so surfacing its timeout would be a
 * spurious toast. Defaults to always toasting.
 */
async function syncOnePeerWithToast(
  peerId: string,
  shouldToast: () => boolean = () => true,
): Promise<boolean> {
  try {
    const store = useSyncStore.getState()
    await runWithTimeout(
      startSync(peerId, (update) => {
        // `SyncProgressUpdate` is a tagged enum: the
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
    // #748: a superseded (resume-invalidated) run swallows its toast but
    // still reports failure so the caller's backoff bookkeeping is honest.
    if (!shouldToast()) return false
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
  shouldToast: () => boolean = () => true,
): Promise<boolean> {
  let hadFailure = false
  for (const peer of peers) {
    if (!isMounted()) break
    const ok = await syncOnePeerWithToast(peer.peer_id, shouldToast)
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
  // Run-generation counter (pattern). A monotonic run id, deliberately a
  // `useRef` (mutable, non-reactive) rather than React state.
  //
  // Why a ref, not state:
  //   - A resume (visibilitychange→visible) must invalidate an in-flight run
  //     that was suspended in the background, and it must do so WITHOUT a
  //     re-render: the value is read by an already-captured async closure
  //     (`shouldToast`, below), not rendered. `useState` would be wrong here —
  //     it would schedule a needless re-render, and the in-flight closure has
  //     already captured the old state value anyway.
  //   - Direct mutation (`syncGenerationRef.current++`, on resume) is therefore
  //     intentional and correct.
  //
  // Invariant: a run surfaces user-facing state/toasts ONLY while
  // `syncGenerationRef.current === myGeneration` (snapshotted per-run in
  // `syncAll`). Once a superseding run bumps the counter, it owns the
  // user-facing state and the stale run goes silent.
  //
  // #748 (Android background-suspend recovery): the bump makes a late
  // `runWithTimeout` rejection from the suspended run swallow its spurious toast.
  const syncGenerationRef = useRef(0)
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

    // #748: snapshot this run's generation. If a resume bumps the counter
    // while we're mid-flight (background-suspended), a late timeout from
    // this run must not surface a toast — the resume already kicked a
    // fresh sync that supersedes it.
    const myGeneration = syncGenerationRef.current
    const shouldToast = () => syncGenerationRef.current === myGeneration

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
      hadFailure = await syncAllPeersSequentially(peers, () => mountedRef.current, shouldToast)
      if (!mountedRef.current) return
      intervalRef.current = computeNextSyncDelay(intervalRef.current, hadFailure)
      if (!hadFailure) {
        setState('idle')
        notify.success(i18n.t('device.syncComplete'))
        announce(i18n.t('announce.syncCompleted'))
      }
    } catch {
      if (mountedRef.current) {
        intervalRef.current = computeNextSyncDelay(intervalRef.current, true)
        // #748: a resume-invalidated run stays silent — the superseding
        // run owns the user-facing state/toast.
        if (shouldToast()) {
          setState('error', 'Sync failed')
          notify.error(i18n.t('device.syncFailed'), { id: 'sync-error' })
          announce(i18n.t('announce.syncFailed'))
        }
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
    // #748: cancel any pending timer before arming so there is never more
    // than one live chain. Without this, a resume that re-arms while a
    // prior `scheduleNext` timer is mid-`syncAll()` (fired, not yet
    // re-armed) would leak a second concurrent chain when that run's
    // `.then(scheduleNext)` resolves.
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      syncAll().then(() => {
        if (mountedRef.current) scheduleNext()
      })
    }, intervalRef.current)
  }, [syncAll])

  // Sync on mount + recursive scheduled resync
  useEffect(() => {
    mountedRef.current = true

    // Sync on open (#377) — small delay to let the app finish booting.
    // #748: tracked in `timerRef` (the single "next pending sync timer"
    // handle) so a resume during the boot window cancels it instead of
    // letting it fire and arm a SECOND concurrent chain alongside the
    // resume-armed one.
    timerRef.current = setTimeout(() => {
      syncAll().then(() => {
        if (mountedRef.current) scheduleNext()
      })
    }, 2_000)

    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [syncAll, scheduleNext])

  // Trigger immediate sync when coming back online (#667).
  // Surface a `notify.info` when transitioning offline → online,
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

  // #748: recover sync on resume from a backgrounded/suspended WebView.
  //
  // Android WebViews throttle/suspend background timers, so the
  // self-rescheduling `setTimeout` chain stalls while hidden — on resume
  // the user sees stale data for up to `MAX_INTERVAL_MS`, and a sync that
  // was suspended mid-flight trips the `runWithTimeout` race late,
  // producing a spurious "Sync timeout" toast. The `online` listener does
  // NOT fire on a plain foreground/background transition, so it can't
  // cover this.
  //
  // - visible: invalidate any in-flight (suspended) run via the generation
  //   bump so its late timeout is silent, re-arm the timer chain (clearing
  //   the existing timer first so we never run two concurrent chains), and
  //   kick an immediate `syncAll()`. `syncAll`'s own `syncInProgressRef`
  //   guard prevents overlapping a run that's genuinely still active.
  // - hidden: `flushAllDrafts()` so up to ~2s of unsaved typing survives
  //   the OS killing the backgrounded process (the satellite LOW fix —
  //   previously drafts flushed only at boot + pre-update).
  useEffect(() => {
    if (typeof document === 'undefined') return

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Invalidate any background-suspended run so its late timeout toast
        // is swallowed; the fresh run below supersedes it.
        syncGenerationRef.current++
        // Re-arm cleanly: cancel the (possibly throttled) pending timer so
        // we don't end up with two concurrent self-rescheduling chains.
        if (timerRef.current) clearTimeout(timerRef.current)
        scheduleNext()
        // `syncAll` no-ops if one is already in flight (overlap guard).
        void syncAll()
      } else {
        // hidden — best-effort flush; failures are non-fatal here (boot
        // recovery re-flushes any orphans on next launch).
        void flushAllDrafts().catch(() => {})
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [syncAll, scheduleNext])

  return { syncing, syncAll }
}
