/**
 * useSyncEvents — listens to Tauri sync events and updates the sync store.
 *
 * Handles three event types from the Rust backend:
 * - sync:progress — maps backend state to frontend SyncState, updates op counters
 * - sync:complete — resets to idle, shows toast, reloads blocks if data changed
 * - sync:error — sets error state, shows error toast
 *
 * No-op in browser mode (when Tauri APIs are unavailable).
 * Call once at app root (App.tsx).
 *
 * Resolves REVIEW-LATER #276, #386, #378.
 */

import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { getConflicts } from '@/lib/tauri'
import { pageBlockRegistry } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSyncStore } from '@/stores/sync'

/** Payload shapes from the Rust backend sync_events.rs */
export interface SyncProgressPayload {
  type: 'progress'
  state: string
  remote_device_id: string
  ops_received: number
  ops_sent: number
}

export interface SyncCompletePayload {
  type: 'complete'
  remote_device_id: string
  ops_received: number
  ops_sent: number
}

export interface SyncErrorPayload {
  type: 'error'
  message: string
  remote_device_id: string
}

export type SyncEventPayload = SyncProgressPayload | SyncCompletePayload | SyncErrorPayload

/** Map backend state strings to frontend SyncState enum. */
export function mapBackendState(backendState: string): 'idle' | 'syncing' | 'error' {
  switch (backendState) {
    case 'exchanging_heads':
    case 'streaming_ops':
    case 'applying_ops':
    case 'merging':
      return 'syncing'
    case 'complete':
      return 'idle'
    case 'failed':
    case 'reset_required':
      return 'error'
    default:
      return 'idle'
  }
}

/**
 * Listens to Tauri sync events and updates the sync store.
 * No-op in browser mode (when Tauri APIs are unavailable).
 * Call once at app root (App.tsx).
 */
export function useSyncEvents(): void {
  useEffect(() => {
    // Only listen in Tauri context
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return

    const cleanups: Array<() => void> = []
    let cancelled = false

    // sync:progress
    listen<SyncProgressPayload>('sync:progress', (event) => {
      const { state, ops_received, ops_sent } = event.payload
      const store = useSyncStore.getState()
      store.setState(mapBackendState(state))
      store.setOpsReceived(ops_received)
      store.setOpsSent(ops_sent)
    })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else cleanups.push(unlisten)
      })
      .catch((err: unknown) => {
        logger.warn('useSyncEvents', 'Failed to listen to sync:progress', { error: String(err) })
      })

    // sync:complete
    listen<SyncCompletePayload>('sync:complete', (event) => {
      const { ops_received, ops_sent } = event.payload
      const store = useSyncStore.getState()
      store.setState('idle')
      store.setOpsReceived(ops_received)
      store.setOpsSent(ops_sent)
      store.updateLastSynced(new Date().toISOString())

      // Show toast notification
      if (ops_received > 0) {
        toast.success(`Synced ${ops_received} change${ops_received === 1 ? '' : 's'} from device`)
      }

      // Reload blocks if we received ops (data changed).
      // Reload ALL mounted page stores so every visible BlockTree updates.
      if (ops_received > 0) {
        for (const store of pageBlockRegistry.values()) {
          store.getState().load()
        }
        useResolveStore.getState().preload(true)
      }

      // Check for conflicts after sync (#438)
      if (ops_received > 0) {
        getConflicts({ limit: 1 })
          .then((resp) => {
            if (resp.items.length > 0) {
              toast.warning('Sync completed with conflicts — review in Conflicts view')
            }
          })
          .catch((err: unknown) => {
            logger.warn('useSyncEvents', 'Failed to check conflicts after sync', {
              error: String(err),
            })
          })
      }
    })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else cleanups.push(unlisten)
      })
      .catch((err: unknown) => {
        logger.warn('useSyncEvents', 'Failed to listen to sync:complete', { error: String(err) })
      })

    // sync:error
    listen<SyncErrorPayload>('sync:error', (event) => {
      const { message } = event.payload
      useSyncStore.getState().setState('error', message)
      toast.error(`Sync failed: ${message}`)
    })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else cleanups.push(unlisten)
      })
      .catch((err: unknown) => {
        logger.warn('useSyncEvents', 'Failed to listen to sync:error', { error: String(err) })
      })

    return () => {
      cancelled = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [])
}
