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

import { toast } from 'sonner'
import { announce } from '@/lib/announcer'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { getConflicts } from '@/lib/tauri'
import { pageBlockRegistry } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useSyncStore } from '@/stores/sync'
import { useTauriEventListener } from './useTauriEventListener'

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
 *
 * MAINT-122: lifecycle (`listen()` → `unlisten()` + unmount race) lives
 * in `useTauriEventListener`; this hook owns the per-event handler
 * bodies and the Tauri-only gate (`enabled`).
 */
export function useSyncEvents(): void {
  // Only listen in Tauri context — browser dev sessions skip
  // registration entirely.
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  useTauriEventListener<SyncProgressPayload>(
    'sync:progress',
    (event) => {
      try {
        const { state, ops_received, ops_sent } = event.payload
        const store = useSyncStore.getState()
        store.setState(mapBackendState(state))
        store.setOpsReceived(ops_received)
        store.setOpsSent(ops_sent)
      } catch (err: unknown) {
        logger.error('useSyncEvents', 'sync:progress handler failed', undefined, err)
      }
    },
    {
      enabled,
      onError: (err) => {
        logger.warn('useSyncEvents', 'Failed to listen to sync:progress', undefined, err)
      },
    },
  )

  useTauriEventListener<SyncCompletePayload>(
    'sync:complete',
    (event) => {
      try {
        const { ops_received, ops_sent } = event.payload
        const store = useSyncStore.getState()
        store.setState('idle')
        store.setOpsReceived(ops_received)
        store.setOpsSent(ops_sent)
        store.updateLastSynced(new Date().toISOString())

        // Show toast notification
        if (ops_received > 0) {
          toast.success(i18n.t('sync.opsReceived', { count: ops_received }))
          announce(i18n.t('announce.syncOpsReceived', { count: ops_received }))
        }

        // Reload blocks if we received ops (data changed).
        // Reload ALL mounted page stores so every visible BlockTree updates.
        if (ops_received > 0) {
          for (const store of pageBlockRegistry.values()) {
            store.getState().load()
          }
          // FEAT-3p7 — preload now takes the active space id so the
          // post-sync re-fetch only re-keys current-space pages into
          // the cache. Foreign-space rows that were synced from the
          // peer never land in the cache here; they will be filtered
          // by the next BlockTree-level batchResolve and rendered as
          // broken-link chips.
          const refreshSpaceId = useSpaceStore.getState().currentSpaceId
          useResolveStore.getState().preload(refreshSpaceId ?? undefined, true)
        }

        // Check for conflicts after sync (#438)
        if (ops_received > 0) {
          getConflicts({ limit: 1 })
            .then((resp) => {
              if (resp.items.length > 0) {
                toast.warning(i18n.t('sync.completedWithConflicts'))
                announce(i18n.t('announce.syncCompletedWithConflicts'))
              }
            })
            .catch((err: unknown) => {
              logger.warn('useSyncEvents', 'Failed to check conflicts after sync', undefined, err)
            })
        }
      } catch (err: unknown) {
        logger.error('useSyncEvents', 'sync:complete handler failed', undefined, err)
      }
    },
    {
      enabled,
      onError: (err) => {
        logger.warn('useSyncEvents', 'Failed to listen to sync:complete', undefined, err)
      },
    },
  )

  useTauriEventListener<SyncErrorPayload>(
    'sync:error',
    (event) => {
      try {
        const { message } = event.payload
        useSyncStore.getState().setState('error', message)
        toast.error(i18n.t('sync.failed', { message }))
        announce(i18n.t('announce.syncFailed'))
      } catch (err: unknown) {
        logger.error('useSyncEvents', 'sync:error handler failed', undefined, err)
      }
    },
    {
      enabled,
      onError: (err) => {
        logger.warn('useSyncEvents', 'Failed to listen to sync:error', undefined, err)
      },
    },
  )
}
